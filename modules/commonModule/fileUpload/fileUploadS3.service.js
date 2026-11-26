const AWS = require('aws-sdk');
// const fs = require('fs');
const { s3bucket } = require('../../../config/config');
const logger = require('../../../config/logger');
const { getUploadContext } = require('../../../utils/uploadContext');
const { buildFileKey, getUploadedUrl, saveUploadedUrl } = require('../../../utils/uploadLedger');

AWS.config.update({
  accessKeyId: s3bucket.AWS_ACCESS_KEY_ID,
  secretAccessKey: s3bucket.AWS_SECRET_ACCESS_KEY,
  region: s3bucket.AWS_REGION,
});

const s3 = new AWS.S3();

const uploadFileToS3 = async (file, userId, companyId) => {
  // Inside a withTransientRetry call, a retried attempt reuses the url uploaded by the first attempt
  const uploadContext = getUploadContext();
  const fileKey = uploadContext ? buildFileKey(file, userId, companyId) : null;
  if (uploadContext) {
    const cachedUrl = await getUploadedUrl(uploadContext.id, fileKey);
    if (cachedUrl) {
      uploadContext.uploaded.add(cachedUrl);
      return cachedUrl;
    }
  }

  try {
    // const fileStream = fs.createReadStream(file.path);
    const params = {
      Bucket: s3bucket.S3_BUCKET_NAME,
      Key: `${companyId}/${userId}/${Date.now()}_${file.originalname}`,
      Body: file.buffer,
      ContentType: file.mimetype,
    };
    const data = await s3.upload(params).promise();
    // fs.unlinkSync(file.path);

    if (uploadContext) {
      uploadContext.uploaded.add(data.Location);
      await saveUploadedUrl(uploadContext.id, fileKey, data.Location);
    }

    return data.Location;
  } catch (err) {
    console.error('Error uploading to S3', err);
    throw err;
  }
};

const deleteFilesFromS3 = async s3Urls => {
  if (!s3Urls || s3Urls.length === 0) return;

  const fileKeys = s3Urls
    .filter(url => url) // Filter out null/undefined URLs
    .map(s3Url => {
      const url = new URL(s3Url);
      const bucket = url.hostname.split('.')[0];
      const key = decodeURIComponent(url.pathname.slice(1));

      return { bucket, key };
    });
  for (const { bucket, key } of fileKeys) {
    const params = {
      Bucket: bucket,
      Key: key,
    };
    try {
      await s3.deleteObject(params).promise();
      logger.info(`File deleted successfully. ${key}`);
    } catch (error) {
      logger.error('Error deleting from S3', error);
    }
  }
};

/**
 * Upload new files to S3 and optionally delete old files
 * @param {Object} options - Upload options
 * @param {Array} options.newFiles - Array of new files to upload
 * @param {Array} options.oldFileUrls - Array of old file URLs to delete (optional)
 * @param {string} options.userId - User ID for S3 path
 * @param {string} options.companyId - Company ID for S3 path
 * @param {boolean} options.replaceAll - If true, delete all old files; if false, keep old files (default: false)
 * @returns {Promise<Array>} - Array of new uploaded file URLs
 */
const uploadAndReplaceFiles = async ({ newFiles = [], oldFileUrls = [], userId, companyId, replaceAll = false }) => {
  let uploadedUrls = [];

  // Upload new files if any
  if (newFiles && newFiles.length > 0) {
    const uploadPromises = newFiles.map(file => uploadFileToS3(file, userId, companyId));
    uploadedUrls = await Promise.all(uploadPromises);
  }

  // Delete old files if replaceAll is true and there are old files
  if (replaceAll && oldFileUrls && oldFileUrls.length > 0) {
    await deleteFilesFromS3(oldFileUrls);
  }

  return uploadedUrls;
};

/**
 * Handle file updates - uploads new files and deletes removed files
 * @param {Object} options - Update options
 * @param {Array} options.newFiles - Array of new files to upload
 * @param {Array} options.currentUrls - Current file URLs in the document (from request body)
 * @param {Array} options.existingUrls - Existing file URLs in the database
 * @param {string} options.userId - User ID for S3 path
 * @param {string} options.companyId - Company ID for S3 path
 * @returns {Promise<Array>} - Final array of file URLs (existing kept + newly uploaded)
 */
const handleFileUpdate = async ({
  newFiles = [],
  currentUrls = [],
  existingUrls = [],
  userId,
  companyId,
  skipS3Deletion = false,
}) => {
  // Find URLs that were removed (exist in DB but not in current request)
  const urlsToDelete = existingUrls.filter(url => url && !currentUrls.includes(url));

  // Delete removed files from S3
  if (!skipS3Deletion && urlsToDelete.length > 0) {
    await deleteFilesFromS3(urlsToDelete);
  }

  // Upload new files
  let uploadedUrls = [];
  if (newFiles && newFiles.length > 0) {
    const uploadPromises = newFiles.map(file => uploadFileToS3(file, userId, companyId));
    uploadedUrls = await Promise.all(uploadPromises);
  }

  // Return combined URLs: kept existing + newly uploaded
  return [...currentUrls, ...uploadedUrls];
};

module.exports = { uploadFileToS3, deleteFilesFromS3, uploadAndReplaceFiles, handleFileUpdate };
