const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { createQueue } = require('../../../config/queueConfig');
const redis = require('../../../config/redis-client');
const exportConfig = require('../../../config/documentPdfExport.config');
const logger = require('../../../config/logger');
const { getCommonModels } = require('../../../services/model.service');
const { DOCUMENT_EXPORT_STATUS, DOCUMENT_EXPORT_FORMAT, DOCUMENT_EXPORT_PDF_VARIANT } = require('../../../utils/enum');
const { getModuleExportConfig } = require('./documentExport.registry');
const { buildMergedPdfFromIds } = require('./documentExportPdf.service');
const {
  writeExportPdfTempFile,
  deleteTempFile,
  tempFileExists,
  cleanupExpiredTempFiles,
} = require('./documentExportTemp.service');
const {
  createDownloadToken,
  peekDownloadToken,
  consumeDownloadToken,
  revokeJobDownloadToken,
} = require('./documentExportToken.service');

const DOWNLOAD_CANCELLED_MESSAGE = 'PDF download was cancelled.';
const ACTIVE_KEY_PREFIX = 'document-export:active:';
const CANCEL_KEY_PREFIX = 'document-export:cancel:';

const getQueue = () => createQueue(exportConfig.QUEUE_NAME);

const lockTtlSeconds = () => Math.max(60, (exportConfig.STALE_PROCESSING_MINUTES || 180) * 60);

const jobRetentionSeconds = () => Math.max(60, (exportConfig.EXPORT_TTL_HOURS || 24) * 3600);

const activeKey = (companyId, userId) => `${ACTIVE_KEY_PREFIX}${companyId}:${userId}`;

const cancelKey = jobId => `${CANCEL_KEY_PREFIX}${jobId}`;

const loadCompanyProfile = async companyId => {
  const { Company } = getCommonModels();
  return Company.findById(companyId).populate('baseCurrency').lean();
};

const countMatchingDocuments = async (moduleType, filter) => {
  const config = getModuleExportConfig(moduleType);
  if (!config) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Unsupported moduleType: ${moduleType}`);
  }
  const { queryExports } = config.getAdapters();
  const result = await queryExports({ ...filter }, { sortBy: filter.sortBy, countOnly: true });
  return { total: result?.totalResults ?? 0 };
};

const loadMatchingDocumentIds = async (moduleType, filter) => {
  const config = getModuleExportConfig(moduleType);
  const { queryExports } = config.getAdapters();
  const result = await queryExports({ ...filter }, { sortBy: filter.sortBy });
  return (result?.results || [])
    .map(doc => doc?._id || doc?.id)
    .filter(Boolean)
    .map(id => id.toString());
};

const isExportCancelled = async jobId => Boolean(await redis.get(cancelKey(jobId)));

const releaseActiveExport = async ({ companyId, userId, jobId }) => {
  if (!companyId || !userId) return;
  const key = activeKey(companyId, userId);
  const current = await redis.get(key);
  if (!jobId || current === String(jobId)) {
    await redis.del(key);
  }
};

const claimActiveExport = async ({ companyId, userId, jobId }) => {
  const result = await redis.set(activeKey(companyId, userId), String(jobId), 'EX', lockTtlSeconds(), 'NX');
  return result === 'OK';
};

const publicStatus = (state, returnvalue) => {
  if (state === 'completed') return returnvalue?.status || DOCUMENT_EXPORT_STATUS.COMPLETED;
  if (state === 'failed') return DOCUMENT_EXPORT_STATUS.FAILED;
  if (state === 'active') return DOCUMENT_EXPORT_STATUS.PROCESSING;
  return DOCUMENT_EXPORT_STATUS.PENDING;
};

const loadQueueJob = async jobId => {
  if (!jobId) return null;
  return getQueue().getJob(String(jobId));
};

const findActiveJobForUser = async ({ companyId, userId }) => {
  const jobId = await redis.get(activeKey(companyId, userId));
  if (!jobId) return null;

  const job = await loadQueueJob(jobId);
  if (!job) {
    await redis.del(activeKey(companyId, userId));
    return null;
  }

  const state = await job.getState();
  if (state !== 'waiting' && state !== 'active' && state !== 'delayed' && state !== 'paused') {
    await redis.del(activeKey(companyId, userId));
    return null;
  }

  return {
    jobId: String(job.id),
    status: publicStatus(state),
    moduleType: job.data?.moduleType,
    pdfVariant: job.data?.pdfVariant,
  };
};

const assertExportCancelled = async jobId => {
  if (await isExportCancelled(jobId)) {
    throw new Error(DOWNLOAD_CANCELLED_MESSAGE);
  }
};

const resolvePdfVariant = (moduleType, pdfVariant) => {
  const variant = pdfVariant || DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT;
  if (variant === DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT) return variant;

  const moduleConfig = getModuleExportConfig(moduleType);
  const allowed = moduleConfig?.pdfVariants || [];
  if (!allowed.includes(variant)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This export option is not available for the selected module.');
  }
  return variant;
};

const applyPdfVariantFilter = (filter, pdfVariant) => {
  if (pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE) {
    return { ...filter, eInvoiceGenerated: true };
  }
  if (pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL) {
    return { ...filter, eWayBillGenerated: true };
  }
  if (pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE_AND_E_WAY_BILL) {
    return { ...filter, eInvoiceGenerated: true, eWayBillGenerated: true };
  }
  return filter;
};

const emptyExportMessage = pdfVariant => {
  if (pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE) {
    return 'No documents with an active e-invoice match the selected filters.';
  }
  if (pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL) {
    return 'No documents with an active e-way bill match the selected filters.';
  }
  if (pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE_AND_E_WAY_BILL) {
    return 'No documents with both an active e-invoice and an active e-way bill match the selected filters.';
  }
  return 'No documents match the selected filters.';
};

const assertExportWithinLimit = async ({ companyId, moduleType, pdfVariant, filters = {} }) => {
  const moduleConfig = getModuleExportConfig(moduleType);
  if (!moduleConfig) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Unsupported moduleType: ${moduleType}`);
  }

  const resolvedPdfVariant = resolvePdfVariant(moduleType, pdfVariant);
  const filter = applyPdfVariantFilter({ ...filters, companyId }, resolvedPdfVariant);
  const { total } = await countMatchingDocuments(moduleType, filter);

  if (total === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, emptyExportMessage(resolvedPdfVariant));
  }

  if (total > exportConfig.ASYNC_HARD_MAX) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Export exceeds the maximum of ${exportConfig.ASYNC_HARD_MAX} documents (found ${total}). Narrow your filters.`,
      exportConfig.ERROR_CODES.EXPORT_LIMIT_EXCEEDED,
      { total, max: exportConfig.ASYNC_HARD_MAX },
    );
  }

  return { pdfVariant: resolvedPdfVariant, filter, total };
};

const conflictError = active =>
  new ApiError(
    httpStatus.CONFLICT,
    'An export job is already in progress for your account. Please wait for it to finish or cancel it.',
    exportConfig.ERROR_CODES.EXPORT_JOB_IN_PROGRESS,
    active ? { jobId: active.jobId, status: active.status } : undefined,
  );

const createExportJob = async ({ companyId, userId, moduleType, format = DOCUMENT_EXPORT_FORMAT.PDF, fileName, match }) => {
  if (!match?.filter || !match.pdfVariant || !match.total) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Export filters were not validated.');
  }

  const { pdfVariant: resolvedPdfVariant, filter, total } = match;
  const ids = await loadMatchingDocumentIds(moduleType, filter);
  const jobId = crypto.randomBytes(16).toString('hex');
  const safeBaseName = (fileName || `${moduleType}_Export`).replace(/\.pdf$/i, '');
  const claimed = await claimActiveExport({ companyId, userId, jobId });
  if (!claimed) {
    throw conflictError(await findActiveJobForUser({ companyId, userId }));
  }

  try {
    await getQueue().add(
      'generate-pdf',
      {
        companyId: String(companyId),
        userId: String(userId),
        moduleType,
        format,
        pdfVariant: resolvedPdfVariant,
        filters: filter,
        documentIds: ids,
        fileName: safeBaseName,
        total,
      },
      {
        jobId,
        removeOnComplete: { age: jobRetentionSeconds() },
        removeOnFail: { age: jobRetentionSeconds() },
        attempts: 1,
      },
    );
  } catch (err) {
    await releaseActiveExport({ companyId, userId, jobId });
    logger.error(`[DocumentPdfExport] enqueue failed job=${jobId}: ${err.message}`);
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to enqueue export job. Please try again.');
  }

  const downloadToken = await createDownloadToken({
    jobId,
    companyId,
    fileName: `${safeBaseName.replace(/[^\w.-]+/g, '_')}.pdf`,
  });

  return {
    jobId,
    totalCount: total,
    status: DOCUMENT_EXPORT_STATUS.PENDING,
    downloadToken,
  };
};

const getExportJobForCompany = async (jobId, companyId) => {
  const job = await loadQueueJob(jobId);
  if (!job || String(job.data?.companyId) !== String(companyId)) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Export job not found');
  }
  const state = await job.getState();
  return {
    jobId: String(job.id),
    moduleType: job.data.moduleType,
    pdfVariant: job.data.pdfVariant || DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT,
    fileName: job.data.fileName,
    status: publicStatus(state, job.returnvalue),
    state,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
    companyId: job.data.companyId,
    userId: job.data.userId,
  };
};

const processExportJob = async bullJob => {
  const data = bullJob.data || {};
  const jobId = String(bullJob.id);
  let localFilePath = null;

  try {
    await redis.expire(activeKey(data.companyId, data.userId), lockTtlSeconds());
    await assertExportCancelled(jobId);

    const moduleConfig = getModuleExportConfig(data.moduleType);
    if (!moduleConfig) {
      throw new Error(`Unsupported moduleType: ${data.moduleType}`);
    }

    const ids = Array.isArray(data.documentIds) ? data.documentIds.map(String) : [];
    if (!ids.length) {
      throw new Error('No documents matched the filters at processing time.');
    }

    const profile = await loadCompanyProfile(data.companyId);
    if (!profile) {
      throw new Error('Company profile not found');
    }

    const result = await buildMergedPdfFromIds({
      ids,
      companyId: data.companyId,
      moduleConfig,
      profile,
      getById: moduleConfig.getAdapters().getById,
      pdfVariant: data.pdfVariant || DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT,
      jobId,
      onProgress: async progress => {
        await assertExportCancelled(jobId);
        await bullJob.updateProgress(progress);
      },
    });

    await assertExportCancelled(jobId);

    const safeName = `${(data.fileName || 'Documents_Export').replace(/[^\w.-]+/g, '_')}.pdf`;
    localFilePath = await writeExportPdfTempFile({
      jobId,
      fileName: safeName,
      buffer: result.buffer,
    });

    logger.info(`[DocumentPdfExport] job ${jobId} done status=${DOCUMENT_EXPORT_STATUS.COMPLETED} total=${result.total}`);

    return {
      localFilePath,
      processed: result.processed,
      total: result.total,
      status: DOCUMENT_EXPORT_STATUS.COMPLETED,
      error: null,
    };
  } catch (err) {
    await deleteTempFile(localFilePath);
    if (err?.message !== DOWNLOAD_CANCELLED_MESSAGE) {
      logger.error(`[DocumentPdfExport] job ${jobId} failed:`, err);
    }
    throw err;
  } finally {
    await releaseActiveExport({ companyId: data.companyId, userId: data.userId, jobId });
  }
};

const cancelActiveExportJob = async (jobId, reason = DOWNLOAD_CANCELLED_MESSAGE) => {
  if (!jobId) return null;
  await redis.set(cancelKey(jobId), reason, 'EX', lockTtlSeconds());

  const job = await loadQueueJob(jobId);
  if (job) {
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'paused') {
      try {
        await job.remove();
      } catch (err) {
        logger.warn(`[DocumentPdfExport] could not remove waiting job ${jobId}: ${err.message}`);
      }
    }
    await releaseActiveExport({ companyId: job.data?.companyId, userId: job.data?.userId, jobId });
  }

  await revokeJobDownloadToken(String(jobId));
  logger.info(`[DocumentPdfExport] job ${jobId} closed because the PDF download was cancelled`);
  return job;
};

const handleExportJobFailed = async (bullJob, errorMessage) => {
  if (!bullJob) return;
  const jobId = String(bullJob.id);
  await releaseActiveExport({ companyId: bullJob.data?.companyId, userId: bullJob.data?.userId, jobId });
  if (errorMessage !== DOWNLOAD_CANCELLED_MESSAGE) {
    await revokeJobDownloadToken(jobId);
  }
  logger.warn(`[DocumentPdfExport] job ${jobId} failed: ${errorMessage || 'worker failure'}`);
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const sanitizeDownloadFileName = name => String(name || 'Documents_Export.pdf').replace(/"/g, '');

const isClientGone = req => Boolean(req?.aborted || req?.destroyed);

const waitForExportFile = async ({ jobId, companyId, req }) => {
  const waitMs = exportConfig.DOWNLOAD_WAIT_MS || 2 * 60 * 60 * 1000;
  const startedAt = Date.now();
  let snapshot;

  while (Date.now() - startedAt < waitMs) {
    if (isClientGone(req)) {
      return { aborted: true, job: snapshot };
    }

    snapshot = await getExportJobForCompany(jobId, companyId);
    if (snapshot.status === DOCUMENT_EXPORT_STATUS.FAILED || (await isExportCancelled(jobId))) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        snapshot.failedReason || 'PDF export failed. Please try again.',
        exportConfig.ERROR_CODES.EXPORT_DOWNLOAD_INVALID,
      );
    }

    if (snapshot.state === 'completed' && tempFileExists(snapshot.returnvalue?.localFilePath)) {
      return { aborted: false, job: snapshot };
    }

    await sleep(2000);
  }

  snapshot = snapshot || (await getExportJobForCompany(jobId, companyId));
  if (snapshot.state !== 'completed' || !tempFileExists(snapshot.returnvalue?.localFilePath)) {
    throw new ApiError(
      httpStatus.GATEWAY_TIMEOUT,
      'PDF is still being prepared. Please try downloading again in a moment.',
      exportConfig.ERROR_CODES.EXPORT_DOWNLOAD_INVALID,
    );
  }

  return { aborted: false, job: snapshot };
};

const streamExportDownload = async ({ jobId, companyId, token, req, res }) => {
  if (req?.setTimeout) req.setTimeout(0);
  if (res?.setTimeout) res.setTimeout(0);

  const payload = await peekDownloadToken(token);
  if (!payload || payload.jobId !== String(jobId) || payload.companyId !== String(companyId)) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'Invalid or expired download link. Please export again.',
      exportConfig.ERROR_CODES.EXPORT_DOWNLOAD_INVALID,
    );
  }

  let job = await getExportJobForCompany(jobId, companyId);
  if (job.status === DOCUMENT_EXPORT_STATUS.FAILED) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      job.failedReason || 'PDF export failed. Please try again.',
      exportConfig.ERROR_CODES.EXPORT_DOWNLOAD_INVALID,
    );
  }

  const fileName = sanitizeDownloadFileName(payload.fileName || `${job.fileName || 'Documents_Export'}.pdf`);
  const alreadyReady = job.state === 'completed' && tempFileExists(job.returnvalue?.localFilePath);
  let headersSentEarly = false;

  if (!alreadyReady) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    headersSentEarly = true;

    try {
      const waitResult = await waitForExportFile({ jobId, companyId, req });
      if (waitResult.aborted) {
        await cancelActiveExportJob(jobId);
        if (!res.writableEnded) res.destroy();
        return;
      }
      job = waitResult.job;
    } catch (err) {
      logger.error(`[DocumentPdfExport] download wait failed job=${jobId}: ${err.message}`);
      if (!res.writableEnded) res.destroy();
      return;
    }
  }

  if (isClientGone(req)) {
    await cancelActiveExportJob(jobId);
    if (headersSentEarly && !res.writableEnded) res.destroy();
    return;
  }

  const consumed = await consumeDownloadToken(token);
  if (!consumed || consumed.jobId !== String(jobId)) {
    if (headersSentEarly) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'Download link was already used or expired. Please export again.',
      exportConfig.ERROR_CODES.EXPORT_DOWNLOAD_INVALID,
    );
  }

  const filePath = job.returnvalue?.localFilePath;
  if (!tempFileExists(filePath)) {
    if (headersSentEarly) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    throw new ApiError(
      httpStatus.GONE,
      'Export file is no longer available. Please export again.',
      exportConfig.ERROR_CODES.EXPORT_DOWNLOAD_INVALID,
    );
  }

  const stat = fs.statSync(filePath);
  const resolvedName = sanitizeDownloadFileName(consumed.fileName || fileName);

  if (!headersSentEarly) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${resolvedName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  const readStream = fs.createReadStream(filePath);
  try {
    await pipeline(readStream, res);
  } catch (err) {
    if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || isClientGone(req)) {
      await cancelActiveExportJob(jobId);
      logger.info(`[DocumentPdfExport] download aborted by client job=${jobId}`);
      return;
    }
    logger.error(`[DocumentPdfExport] download stream failed job=${jobId}: ${err.message}`);
    if (!res.headersSent) {
      throw err;
    }
    if (!res.writableEnded) {
      res.destroy(err);
    }
    return;
  }

  await deleteTempFile(filePath);
};

const cleanupExpiredExports = async () => cleanupExpiredTempFiles();

module.exports = {
  createExportJob,
  assertExportWithinLimit,
  findActiveJobForUser,
  getExportJobForCompany,
  processExportJob,
  streamExportDownload,
  cleanupExpiredExports,
  handleExportJobFailed,
};
