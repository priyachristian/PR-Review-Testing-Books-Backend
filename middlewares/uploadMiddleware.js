/**
 * Shared upload middleware utilities for file uploads with JSONString pattern
 * Provides consistent file upload handling across quote, customer, and salesOrder modules
 */

const httpStatus = require('http-status');
const upload = require('./upload');
const multer = require('multer');
const { errorResponse } = require('../services/response.service');
const { ATTACHMENT_MAX_COUNT } = require('../utils/enum');

/**
 * Creates multer middleware for single file upload
 * @param {string} fieldName - Field name for the file (default: 'attachment')
 * @returns {Function} Multer middleware
 */
const singleAttachmentUpload = (fieldName = 'attachment') => {
  return upload.single(fieldName);
};

/**
 * Creates multer middleware for multiple file uploads
 * @param {string} fieldName - Field name for the files (default: 'attachment')
 * @param {number} maxCount - Maximum number of files (default: ATTACHMENT_MAX_COUNT)
 * @returns {Function} Multer middleware
 */
const multipleAttachmentUpload = (fieldName = 'attachment', maxCount = ATTACHMENT_MAX_COUNT) => {
  return upload.fields([{ name: fieldName, maxCount }]);
};

const multipleAttachmentUploadFields = (fields = []) => {
  return upload.fields(fields);
};

const multerErrorHandler = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Multer-specific errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return errorResponse(
        { req, error: err, service: 'multipleAttachmentUploadFields', controller: 'multipleAttachmentUploadFields' },
        res,
        'File size exceeds 5MB limit',
        httpStatus.BAD_REQUEST,
      );
    }

    if (err.code === 'LIMIT_FILE_COUNT') {
      return errorResponse(
        { req, error: err, service: 'multipleAttachmentUploadFields', controller: 'multipleAttachmentUploadFields' },
        res,
        'Too many files uploaded',
        httpStatus.BAD_REQUEST,
      );
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return errorResponse(
        { req, error: err, service: 'multipleAttachmentUploadFields', controller: 'multipleAttachmentUploadFields' },
        res,
        `Unexpected file field: ${err.field}`,
        httpStatus.BAD_REQUEST,
      );
    }

    return errorResponse(
      { req, error: err, service: 'multipleAttachmentUploadFields', controller: 'multipleAttachmentUploadFields' },
      res,
      err.message,
      httpStatus.BAD_REQUEST,
    );
  }

  // Your custom fileFilter error
  if (err) {
    return errorResponse(
      { req, error: err, service: 'multipleAttachmentUploadFields', controller: 'multipleAttachmentUploadFields' },
      res,
      err.message,
      httpStatus.BAD_REQUEST,
    );
  }

  next();
};

module.exports = {
  singleAttachmentUpload,
  multipleAttachmentUpload,
  multipleAttachmentUploadFields,
  multerErrorHandler,
};
