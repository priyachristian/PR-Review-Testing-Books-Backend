const Joi = require('joi');
const { ITEM_BATCH_SOURCE_TYPE } = require('../../../utils/enum');
const { commonSchemas } = require('../../../validations/common.validation');

const getItemBatches = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
    divisionId: commonSchemas.objectId({ label: 'Division ID', isOptional: true }),
    branchId: commonSchemas.objectId({ label: 'Branch ID', isOptional: true }),
    warehouseId: commonSchemas.objectId({ label: 'Warehouse ID', isOptional: true }),
    itemId: commonSchemas.objectId({ label: 'Item ID', isOptional: true }),
    sourceType: Joi.string()
      .valid(...Object.values(ITEM_BATCH_SOURCE_TYPE))
      .optional()
      .label('Source Type'),
    search: Joi.string().allow('').optional(),
    ...commonSchemas.paginationQuery(),
  }),
};

const getItemBatch = {
  query: Joi.object().keys({
    companyId: commonSchemas.objectId({ label: 'Company ID', isRequired: true }),
  }),
  params: Joi.object().keys({
    batchId: commonSchemas.objectId({ label: 'Batch ID', isRequired: true }),
  }),
};

module.exports = {
  getItemBatches,
  getItemBatch,
};
