/**
 * Middleware to parse FormData JSONString into req.body
 * This allows validation middleware to work with both regular JSON and FormData requests
 */
const parseFormData = (req, res, next) => {
  // Check if this is a FormData request (has JSONString field)
  if (req.body && req.body.JSONString && typeof req.body.JSONString === 'string') {
    try {
      // Parse JSONString and merge with existing body (files will be in req.files)
      const parsedData = JSON.parse(req.body.JSONString);
      // Fields that should be excluded from req.body (handled by Multer)
      const fileFields = ['attachment', 'photo', 'JSONString'];
      // Merge parsed data into req.body, excluding file-related fields
      req.body = {
        ...parsedData,
        // Preserve any non-JSONString, non-file fields that might exist
        ...Object.keys(req.body).reduce((acc, key) => {
          if (!fileFields.includes(key)) {
            acc[key] = req.body[key];
          }
          return acc;
        }, {}),
      };
    } catch (parseError) {
      return res.status(400).json({
        code: 0,
        message: 'Invalid JSONString format',
        data: null,
      });
    }
  }
  next();
};

module.exports = parseFormData;
