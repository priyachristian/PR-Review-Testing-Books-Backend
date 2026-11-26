const multer = require('multer');
const path = require('path');
const { MAX_FILE_SIZE, IMAGE_UPLOAD_FIELDS, ATTACHMENT_UPLOAD_FIELDS } = require('../utils/enum');

// Set up Multer storage configuration
const storage = multer.memoryStorage();

// Set up file filter to allow only certain file types (optional)
const fileFilter = (req, file, cb) => {
  const imageTypes = /jpeg|jpg|png|webp/;
  const attachmentTypes = /jpeg|jpg|png|webp|pdf/;

  const extname = path.extname(file.originalname).toLowerCase();

  // Image-only fields
  if (IMAGE_UPLOAD_FIELDS.includes(file.fieldname)) {
    const isValid = imageTypes.test(extname) && imageTypes.test(file.mimetype);

    return isValid ? cb(null, true) : cb(new Error('Only JPG, JPEG, PNG and WEBP images are allowed.'));
  }

  // Attachment fields (images + PDFs)
  if (ATTACHMENT_UPLOAD_FIELDS.includes(file.fieldname) || file.fieldname.endsWith('.attachment')) {
    const isValid = attachmentTypes.test(extname) && (imageTypes.test(file.mimetype) || file.mimetype === 'application/pdf');

    return isValid ? cb(null, true) : cb(new Error('Only JPG, JPEG, PNG, WEBP and PDF files are allowed.'));
  }

  return cb(new Error(`Unexpected field: ${file.fieldname}`));
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

module.exports = upload;
