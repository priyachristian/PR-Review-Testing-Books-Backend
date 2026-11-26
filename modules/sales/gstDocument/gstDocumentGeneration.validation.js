const Joi = require('joi');
const { commonSchemas } = require('../../../validations/common.validation');
const invoiceValidation = require('../invoice/invoice.validation');
const { eInvoiceOptions } = require('./gstDocument.validation');

const query = Joi.object().keys({
  companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
});

const params = Joi.object().keys({
  documentId: commonSchemas.objectId({ label: 'Document ID', isRequired: true }),
});

// HSN corrections made in the generate modal, same shape as the invoice endpoints.
const hsnUpdateKeys = {
  updateItemMaster: Joi.boolean().optional().label('Update HSN in Item Master'),
  items: Joi.array()
    .items(
      Joi.object({
        hsn: Joi.string().required(),
        itemId: commonSchemas.objectId({ label: 'Item ID', isRequired: true }),
      }),
    )
    .optional(),
};

const cancellationKeys = {
  cancellationReasonCode: Joi.number().required().label('Cancellation Reason Code'),
  cancellationReasonRemarks: Joi.string().optional().allow(null, '').label('Cancellation Reason'),
};

const generateEInvoice = {
  query,
  params,
  body: Joi.object().keys({ ...hsnUpdateKeys, EInvDtls: eInvoiceOptions }),
};

const generateEWayBill = {
  query,
  params,
  body: Joi.object().keys({
    ...hsnUpdateKeys,
    // The standalone e-way bill details are identical for every document type.
    EwbDtls: invoiceValidation.generateOnlyEWayBill.body.extract('EwbDtls').required(),
  }),
};

const cancel = {
  query,
  params,
  body: Joi.object().keys(cancellationKeys),
};

const getOptions = { query, params };

module.exports = { generateEInvoice, generateEWayBill, cancel, getOptions };
