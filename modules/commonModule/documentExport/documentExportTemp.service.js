const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const exportConfig = require('../../../config/documentPdfExport.config');
const logger = require('../../../config/logger');

const getTempRoot = () => {
  const configured = exportConfig.TEMP_DIR || process.env.DOCUMENT_EXPORT_TEMP_DIR;
  return configured || path.join(os.tmpdir(), 'abss-document-exports');
};

const ensureTempRoot = async () => {
  const root = getTempRoot();
  await fsp.mkdir(root, { recursive: true });
  return root;
};

const writeExportPdfTempFile = async ({ jobId, fileName, buffer }) => {
  const root = await ensureTempRoot();
  const safeJob = String(jobId).replace(/[^\w-]/g, '');
  const safeName = `${(fileName || 'export').replace(/[^\w.-]+/g, '_')}.pdf`;
  const filePath = path.join(root, `${safeJob}_${Date.now()}_${safeName}`);
  await fsp.writeFile(filePath, buffer);
  return filePath;
};

const deleteTempFile = async filePath => {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      logger.warn(`[DocumentPdfExport] failed to delete temp file ${filePath}: ${err.message}`);
    }
  }
};

const tempFileExists = filePath => Boolean(filePath) && fs.existsSync(filePath);

const cleanupExpiredTempFiles = async () => {
  const root = getTempRoot();
  const maxAgeMs = (exportConfig.EXPORT_TTL_HOURS || 24) * 60 * 60 * 1000;
  let names;
  try {
    names = await fsp.readdir(root);
  } catch (err) {
    if (err?.code === 'ENOENT') return { cleaned: 0 };
    throw err;
  }

  const now = Date.now();
  let cleaned = 0;
  for (const name of names) {
    const filePath = path.join(root, name);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    if (now - stat.mtimeMs < maxAgeMs) continue;
    await deleteTempFile(filePath);
    cleaned += 1;
  }

  if (cleaned) {
    logger.info(`[DocumentPdfExport] cleanup removed ${cleaned} temp file(s)`);
  }
  return { cleaned };
};

module.exports = {
  writeExportPdfTempFile,
  deleteTempFile,
  tempFileExists,
  cleanupExpiredTempFiles,
};
