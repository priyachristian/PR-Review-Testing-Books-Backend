const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const { E_WAY_BILL_DOCUMENT_TYPES } = require('../../../utils/enum');

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const HSN_PATTERN = /^(?:\d{4}|\d{6}|\d{8})$/;

const gstin = label =>
  Joi.string().pattern(GSTIN_PATTERN).label(label).messages({
    'string.pattern.base': 'Invalid GSTIN format. Please enter a valid 15-character GSTIN (e.g., 27AABCM8432E1ZL).',
  });

// HSN/SAC chosen for an invoice additional charge, keyed by the charge's position on the document.
const additionalChargeHsn = Joi.array()
  .items(
    Joi.object({
      index: Joi.number().integer().min(0).required().label('Additional Charge'),
      hsn: Joi.string().pattern(HSN_PATTERN).required().label('Additional Charge HSN').messages({
        'string.pattern.base': '{{#label}} must be 4, 6 or 8 digits',
      }),
    }),
  )
  .optional();

// Addresses are not chosen here: the e-invoice and e-way bill follow the address on the document, which
// decided the place of supply and the tax.
const partyOptionKeys = {
  additionalChargeHsn,
};

const eInvoiceOptions = Joi.object({
  ...partyOptionKeys,
  ecommerceGstin: gstin('E-Commerce Operator GSTIN').optional().allow(null, ''),
  sellerTradeName: Joi.string().trim().min(3).max(100).optional().allow(null, '').label('Seller Trade Name'),
  poNumber: Joi.string().trim().max(16).optional().allow(null, '').label('PO Number'),
  poDate: commonSchemas.date({ label: 'PO Date' }).allow(null, ''),
  remarks: Joi.string().trim().min(3).max(100).optional().allow(null, '').label('Remarks'),
})
  .optional()
  .label('E-Invoice Options');

// Extra keys accepted inside the standalone e-way bill details.
const eWayBillOptionKeys = {
  ...partyOptionKeys,
  documentType: Joi.string()
    .valid(...Object.keys(E_WAY_BILL_DOCUMENT_TYPES))
    .optional()
    .label('Document Type'),
  transDocNo: Joi.string().trim().max(15).optional().allow(null, '').label('Transport Document Number'),
  transDocDate: commonSchemas.date({ label: 'Transport Document Date' }).allow(null, ''),
};

const getGstDocumentOptions = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  params: Joi.object().keys({
    invoiceId: commonSchemas.objectId({ label: 'Invoice ID', isRequired: true }),
  }),
};

module.exports = { eInvoiceOptions, eWayBillOptionKeys, getGstDocumentOptions };
