const express = require('express');
const validate = require('../../../middlewares/validate');
const documentExportValidation = require('./documentExport.validation');
const documentExportController = require('./documentExport.controller');
const { checkDocumentExportViewRight, checkDocumentExportLimit } = require('../../../middlewares/checkDocumentExport');

const router = express.Router();

router
  .route('/')
  .post(
    validate(documentExportValidation.createDocumentExport),
    checkDocumentExportViewRight,
    checkDocumentExportLimit,
    documentExportController.createDocumentExport,
  );

router
  .route('/:jobId/download')
  .get(
    validate(documentExportValidation.downloadDocumentExport),
    checkDocumentExportViewRight,
    documentExportController.downloadDocumentExport,
  );

module.exports = router;
