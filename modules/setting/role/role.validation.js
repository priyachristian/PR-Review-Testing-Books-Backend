const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');

const booleanDefault = Joi.boolean();

const viewExportPermission = Joi.object({
  view: booleanDefault,
  export: booleanDefault,
});

const viewEditPermission = Joi.object({
  view: booleanDefault,
  edit: booleanDefault,
});

const crudPermission = Joi.object({
  view: booleanDefault,
  add: booleanDefault,
  update: booleanDefault,
  delete: booleanDefault,
});

const reportsPermissionSchema = Joi.object({
  generalLedger: viewExportPermission,
  itemLedger: viewExportPermission,
  bankLedger: viewExportPermission,
  salesLedger: viewExportPermission,
  purchaseLedger: viewExportPermission,
  creditorsLedger: viewExportPermission,
  debtorsLedger: viewExportPermission,
  grossProfit: viewExportPermission,
  customerAgingReport: viewExportPermission,
  vendorAgingReport: viewExportPermission,
  receivablesPayables: viewExportPermission,
});

const analyticsPermissionSchema = Joi.object({
  itemAnalytics: viewExportPermission,
  groupItemAnalytics: viewExportPermission,
  salesOrdersAnalytics: viewExportPermission,
  itemWiseSalesOrdersAnalytics: viewExportPermission,
  customerWiseSalesOrdersAnalytics: viewExportPermission,
  newVsOldCustomerReport: viewExportPermission,
  topSalesOrders: viewExportPermission,
  topCustomersOfSales: viewExportPermission,
  topItemsOfSales: viewExportPermission,
  topVendorsByAmountPurchase: viewExportPermission,
  vendorsByPurchase: viewExportPermission,
  topItemOfPurchase: viewExportPermission,
  rmAnalytics: viewExportPermission,
  itemWiseRmAnalytics: viewExportPermission,
  soWiseRmAnalytics: viewExportPermission,
  topCustomerByAmountCollection: viewExportPermission,
  upcomingReceivablesInvoice: viewExportPermission,
  recentlyReceivedPayments: viewExportPermission,
  overdueInvoices: viewExportPermission,
  topVendorsByAmountPayments: viewExportPermission,
  upcomingPayablesBills: viewExportPermission,
  recentlyPaymentsMade: viewExportPermission,
  overdueBills: viewExportPermission,
  customeroneinvoice: viewExportPermission,
  generalSalesAnalytics: viewExportPermission,
  rejectionAnalytics: viewExportPermission,
  rejectionAnalyticsByItem: viewExportPermission,
  itemProcessAnalytics: viewExportPermission,
  monthlyProductionReport: viewExportPermission,
  stockSummary: viewExportPermission,
  partyWiseBusinessPerformance: viewExportPermission,
});

const otherSettingsPermissionSchema = Joi.object({
  additionalChargesConfig: crudPermission,
  defaultOrganizationConfig: viewEditPermission,
  discountConfig: viewEditPermission,
  incentive: crudPermission,
  paymentTerms: crudPermission,
  itemUnit: crudPermission,
  productionDepartmentWarehouseConfig: crudPermission,
  directTaxes: crudPermission,
});

const createRole = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    role: Joi.string().required().label('Role').messages({
      'any.required': '{{#label}} is required',
      'string.empty': '{{#label}} cannot be empty',
    }),
    description: Joi.string().required().label('Description').messages({
      'any.required': '{{#label}} is required',
      'string.empty': '{{#label}} cannot be empty',
    }),
    isAccountant: Joi.boolean(),
    permissions: Joi.array()
      .items(
        Joi.object().keys({
          module: Joi.string().required().custom(objectId),
          view: Joi.boolean(),
          create: Joi.boolean(),
          edit: Joi.boolean(),
          delete: Joi.boolean(),
        }),
      )
      .required()
      .label('Permissions')
      .messages({
        'array.base': '{{#label}} must be an array',
        'any.required': '{{#label}} is required',
      }),
    reportsPermissions: reportsPermissionSchema,
    analyticsPermissions: analyticsPermissionSchema,
    inventoryConfig: viewEditPermission,
    otherSettings: otherSettingsPermissionSchema,
    splitConfig: viewEditPermission,
  }),
};
const getRoles = {
  query: Joi.object().keys({
    role: Joi.string(),
    companyId: Joi.string().custom(objectId),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};
const getRole = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    roleId: Joi.string().custom(objectId),
  }),
};

const updateRole = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    roleId: Joi.required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      role: Joi.string().label('Role'),
      description: Joi.string().label('Description'),
      isAccountant: Joi.boolean(),
      permissions: Joi.array().items(
        Joi.object().keys({
          module: Joi.string().custom(objectId),
          view: Joi.boolean(),
          create: Joi.boolean(),
          edit: Joi.boolean(),
          delete: Joi.boolean(),
        }),
      ),
      reportsPermissions: reportsPermissionSchema,
      analyticsPermissions: analyticsPermissionSchema,
      inventoryConfig: viewEditPermission,
      otherSettings: otherSettingsPermissionSchema,
      splitConfig: viewEditPermission,
    })
    .min(1)
    .label('Request Body')
    .messages({
      'object.min': '{{#label}} must contain at least one field to update',
    }),
};

const deleteRole = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    roleId: Joi.string().custom(objectId),
  }),
};

const getRolesDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
};
module.exports = {
  createRole,
  getRoles,
  getRole,
  updateRole,
  deleteRole,
  getRolesDropdown,
};
