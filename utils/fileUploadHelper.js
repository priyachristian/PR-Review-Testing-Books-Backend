/**
 * Shared helper utilities for handling file uploads in controllers and services
 * Provides consistent file extraction and processing across modules
 */

/**
 * Extracts uploaded files from multer request
 * Handles both single file (req.file) and multiple files (req.files) patterns
 * @param {Object} req - Express request object
 * @param {string} fieldName - Field name used for upload (default: 'attachment')
 * @returns {Array} Array of uploaded files (empty array if no files)
 */
const getUploadedFiles = (req, fieldName = 'attachment') => {
  // Handle multiple files pattern (req.files)
  if (req.files && req.files[fieldName]) {
    return Array.isArray(req.files[fieldName]) ? req.files[fieldName] : [req.files[fieldName]];
  }

  // Handle single file pattern (req.file)
  if (req.file) {
    return [req.file];
  }

  return [];
};

/**
 * Extracts request body (already parsed by parseFormData middleware if FormData)
 * @param {Object} req - Express request object
 * @returns {Object} Parsed request body
 */
const getRequestBody = req => {
  // Body is already parsed by parseFormData middleware if it was FormData
  // Otherwise it's already JSON from the regular request
  return req.body;
};

module.exports = {
  getUploadedFiles,
  getRequestBody,
};
