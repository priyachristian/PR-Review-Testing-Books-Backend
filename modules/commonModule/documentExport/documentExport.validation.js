const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const { DOCUMENT_EXPORT_FORMAT, DOCUMENT_EXPORT_PDF_VARIANT } = require('../../../utils/enum');
const { SUPPORTED_MODULE_TYPES } = require('./documentExport.registry');

const filtersSchema = Joi.object().unknown(true);

const createDocumentExport = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  body: Joi.object().keys({
    moduleType: Joi.string()
      .valid(...SUPPORTED_MODULE_TYPES)
      .required()
      .label('Module Type'),
    format: Joi.string()
      .valid(...Object.values(DOCUMENT_EXPORT_FORMAT))
      .default(DOCUMENT_EXPORT_FORMAT.PDF)
      .label('Format'),
    pdfVariant: Joi.string()
      .valid(...Object.values(DOCUMENT_EXPORT_PDF_VARIANT))
      .default(DOCUMENT_EXPORT_PDF_VARIANT.DOCUMENT)
      .label('PDF Variant'),
    filters: filtersSchema.default({}),
    fileName: Joi.string().trim().max(200).optional().allow('').label('File Name'),
  }),
};

const downloadDocumentExport = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    token: Joi.string().trim().min(16).required().label('Download Token'),
  }),
  params: Joi.object().keys({
    jobId: Joi.string().trim().hex().length(32).required().label('Job ID'),
  }),
};

module.exports = {
  createDocumentExport,
  downloadDocumentExport,
};
