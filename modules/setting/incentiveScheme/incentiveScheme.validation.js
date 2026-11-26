const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const companyQuery = Joi.object().keys({ companyId: Joi.string().required().custom(objectId) });
const schemeIdParam = Joi.object().keys({ schemeId: Joi.string().required().custom(objectId) });

const docTypeConfigSchema = Joi.object({
  docType: Joi.string().valid('INVOICE', 'SALES_ORDER', 'QUOTATION', 'DELIVERY_CHALLAN', 'PAYMENT_RECEIVED').required(),
  calcMethod: Joi.string().valid('PER_DOC_AMOUNT', 'PER_ITEM', 'PER_ITEM_GROUP').default('PER_DOC_AMOUNT'),
  incentiveType: Joi.string().valid('PERCENTAGE', 'FIXED').default('PERCENTAGE'),
  incentiveValue: Joi.number().min(0).default(0),
  allocatedBudget: Joi.number().min(0).default(0),
  itemGroups: Joi.array().items(Joi.string().custom(objectId)).default([]),
  items: Joi.array().items(Joi.string().custom(objectId)).default([]),
}).custom((value, helpers) => {
  if (value.docType === 'PAYMENT_RECEIVED' && value.calcMethod !== 'PER_DOC_AMOUNT') {
    return helpers.message('PAYMENT_RECEIVED supports only PER_DOC_AMOUNT calculation.');
  }

  if (value.calcMethod === 'PER_ITEM_GROUP' && (!value.itemGroups || value.itemGroups.length === 0)) {
    return helpers.message('Please select at least one Item Group when Calculation Method is PER_ITEM_GROUP.');
  }

  if (value.calcMethod !== 'PER_ITEM_GROUP' && value.itemGroups?.length) {
    return helpers.message('Item Groups can only be selected when Calculation Method is PER_ITEM_GROUP.');
  }

  if (value.calcMethod === 'PER_ITEM' && (!value.items || value.items.length === 0)) {
    return helpers.message('Please select at least one Item when Calculation Method is PER_ITEM.');
  }

  if (value.calcMethod !== 'PER_ITEM' && value.items?.length) {
    return helpers.message('Items can only be selected when Calculation Method is PER_ITEM.');
  }

  return value;
});

const createIncentiveScheme = {
  query: companyQuery,
  body: Joi.object()
    .keys({
      name: Joi.string().required().label('Scheme Name'),
      totalBudget: Joi.number().min(0).required().label('Total Budget'),
      startDate: Joi.date().required().label('Start Date'),
      endDate: Joi.date().min(Joi.ref('startDate')).required().label('End Date'),
      status: Joi.string().valid('DRAFT', 'ACTIVE').default('DRAFT'),
      docTypes: Joi.array().items(docTypeConfigSchema).min(1).required(),
      assignedUsers: Joi.array().items(Joi.string().custom(objectId)).default([]),
      perUserBudgetCap: Joi.number().min(0).allow(null).optional(),
      alertThreshold: Joi.number().min(1).max(100).default(80),
    })
    .custom((value, helpers) => {
      // Sum of allocated budgets
      const totalAllocatedBudget = value.docTypes.reduce((sum, doc) => sum + (doc.allocatedBudget || 0), 0);

      if (totalAllocatedBudget > value.totalBudget) {
        return helpers.message(
          `Total allocated budget (${totalAllocatedBudget}) cannot exceed total budget (${value.totalBudget}).`,
        );
      }

      // Per-user budget cap cannot exceed total budget
      if (value.perUserBudgetCap != null && value.perUserBudgetCap > value.totalBudget) {
        return helpers.message(
          `Per user budget cap (${value.perUserBudgetCap}) cannot exceed total budget (${value.totalBudget}).`,
        );
      }

      return value;
    }),
};

const getIncentiveSchemes = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    status: Joi.string().valid('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'),
    userId: Joi.string().custom(objectId),
    search: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const getIncentiveScheme = {
  query: companyQuery,
  params: schemeIdParam,
};

const updateIncentiveScheme = {
  query: companyQuery,
  params: schemeIdParam,
  body: Joi.object({
    name: Joi.string().optional(),
    totalBudget: Joi.number().min(0).optional(),
    startDate: Joi.date().optional(),
    endDate: Joi.date().optional(),
    docTypes: Joi.array().items(docTypeConfigSchema).optional(),
    assignedUsers: Joi.array().items(Joi.string().custom(objectId)).optional(),
    perUserBudgetCap: Joi.number().min(0).allow(null).optional(),
    alertThreshold: Joi.number().min(1).max(100).optional(),
  })
    .min(1)
    .custom((value, helpers) => {
      // Validate allocated budget only if both totalBudget and docTypes are sent
      if (value.totalBudget != null && value.docTypes) {
        const totalAllocatedBudget = value.docTypes.reduce((sum, doc) => sum + (doc.allocatedBudget || 0), 0);

        if (totalAllocatedBudget > value.totalBudget) {
          return helpers.message(
            `Total allocated budget (${totalAllocatedBudget}) cannot exceed total budget (${value.totalBudget}).`,
          );
        }
      }

      // Validate per-user budget cap only if totalBudget is sent
      if (value.totalBudget != null && value.perUserBudgetCap != null && value.perUserBudgetCap > value.totalBudget) {
        return helpers.message(
          `Per user budget cap (${value.perUserBudgetCap}) cannot exceed total budget (${value.totalBudget}).`,
        );
      }

      return value;
    }),
};

const updateIncentiveSchemeStatus = {
  query: companyQuery,
  params: schemeIdParam,
  body: Joi.object().keys({
    status: Joi.string().valid('ACTIVE', 'PAUSED', 'ENDED').required(),
  }),
};

const deleteIncentiveScheme = {
  query: companyQuery,
  params: schemeIdParam,
};

const getSchemeConsumption = {
  query: companyQuery,
  params: schemeIdParam,
};

const getSchemeSummary = {
  query: companyQuery,
};

const getIncentiveLogs = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    schemeId: Joi.string().custom(objectId),
    userId: Joi.string().custom(objectId),
    docType: Joi.string().valid('INVOICE', 'SALES_ORDER', 'QUOTATION', 'DELIVERY_CHALLAN', 'PAYMENT_RECEIVED'),
    status: Joi.string().valid('PENDING', 'SETTLED', 'CANCELLED'),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
  }),
};

const updateLogStatus = {
  query: companyQuery,
  params: Joi.object().keys({ logId: Joi.string().required().custom(objectId) }),
  body: Joi.object().keys({
    status: Joi.string().valid('SETTLED', 'CANCELLED').required(),
  }),
};

const deleteIncentiveLog = {
  query: companyQuery,
  params: Joi.object().keys({ logId: Joi.string().required().custom(objectId) }),
};

const bulkSettleLogs = {
  query: companyQuery,
  body: Joi.object().keys({
    schemeId: Joi.string().required().custom(objectId),
    userId: Joi.string().custom(objectId).optional(),
  }),
};

const getUserIncentiveSchemes = {
  query: companyQuery,
  params: Joi.object().keys({
    userId: Joi.string().custom(objectId).required(),
  }),
};

const getTeamStats = {
  query: companyQuery,
};

const getUserStats = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
};

module.exports = {
  createIncentiveScheme,
  getIncentiveSchemes,
  getIncentiveScheme,
  updateIncentiveScheme,
  updateIncentiveSchemeStatus,
  deleteIncentiveScheme,
  getSchemeConsumption,
  getSchemeSummary,
  getIncentiveLogs,
  updateLogStatus,
  deleteIncentiveLog,
  bulkSettleLogs,
  getUserIncentiveSchemes,
  getTeamStats,
  getUserStats,
};
