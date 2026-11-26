const httpStatus = require('http-status');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const ApiError = require('../utils/ApiError');
const { checkRoleRight } = require('./checkRoleRight');
const { checkSubscription } = require('./checkSubscription');
const { checkEWayBillSubscription } = require('./checkEWayBillSubscription');
const { RIGHTS, DOCUMENT_EXPORT_PDF_VARIANT } = require('../utils/enum');
const exportConfig = require('../config/documentPdfExport.config');
const { getModuleExportConfig } = require('../modules/commonModule/documentExport/documentExport.registry');
const documentExportService = require('../modules/commonModule/documentExport/documentExport.service');

const subscriptionForPdfVariant = pdfVariant => {
  if (
    pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE ||
    pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_INVOICE_AND_E_WAY_BILL
  ) {
    return checkSubscription(PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL);
  }
  if (pdfVariant === DOCUMENT_EXPORT_PDF_VARIANT.E_WAY_BILL) {
    return checkEWayBillSubscription();
  }
  return null;
};

const checkDocumentExportViewRight = async (req, res, next) => {
  try {
    let moduleType = req.body?.moduleType;
    let pdfVariant = req.body?.pdfVariant || DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT;

    if (!moduleType && req.params?.jobId) {
      const job = await documentExportService.getExportJobForCompany(req.params.jobId, req.query.companyId);
      moduleType = job.moduleType;
      pdfVariant = job.pdfVariant || DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT;
    }

    const config = getModuleExportConfig(moduleType);
    if (!config) {
      return next(new ApiError(httpStatus.BAD_REQUEST, `Unsupported moduleType: ${moduleType || 'missing'}`));
    }

    const subscription = subscriptionForPdfVariant(pdfVariant);
    return checkRoleRight(config.right, RIGHTS.VIEW)(req, res, err => {
      if (err) return next(err);
      if (!subscription) return next();
      return subscription(req, res, next);
    });
  } catch (err) {
    return next(
      err instanceof ApiError ? err : new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message || 'Permission check failed'),
    );
  }
};

const checkDocumentExportLimit = async (req, res, next) => {
  try {
    const companyId = req.query.companyId;
    const userId = req.user?._id;
    const active = await documentExportService.findActiveJobForUser({ companyId, userId });
    if (active) {
      return next(
        new ApiError(
          httpStatus.CONFLICT,
          'An export job is already in progress for your account. Please wait for it to finish or cancel it.',
          exportConfig.ERROR_CODES.EXPORT_JOB_IN_PROGRESS,
          { jobId: active.jobId, status: active.status },
        ),
      );
    }

    req.documentExportMatch = await documentExportService.assertExportWithinLimit({
      companyId,
      moduleType: req.body?.moduleType,
      pdfVariant: req.body?.pdfVariant,
      filters: req.body?.filters || {},
    });
    return next();
  } catch (err) {
    return next(
      err instanceof ApiError ? err : new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err.message || 'Export limit check failed'),
    );
  }
};

module.exports = {
  checkDocumentExportViewRight,
  checkDocumentExportLimit,
};
