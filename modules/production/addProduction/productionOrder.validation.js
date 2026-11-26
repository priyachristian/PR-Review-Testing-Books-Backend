const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');
const { PRODUCTION_ORDER_STATUS, PRODUCTION_ORDER_STATUS_ACTION } = require('../../../utils/enum');

const processSchema = Joi.object({
  processNo: Joi.string().required(),
  processName: Joi.string().required(),
  startDatetime: Joi.date(),
  endDatetime: Joi.date(),
  totalUsedUnit: Joi.number(),
  processRawMaterialInput: Joi.array().items(
    Joi.object({
      item: Joi.string().custom(objectId),
      itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
      value: Joi.number(),
    }),
  ),
  manPower: Joi.array().items(
    Joi.object({
      workerId: Joi.string().custom(objectId),
      salaryPerHour: Joi.number(),
    }),
  ),
  scrapOutProcess: Joi.array().items(
    Joi.object({
      item: Joi.string().custom(objectId),
      itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
      value: Joi.number(),
    }),
  ),
  remarks: Joi.string(),
  processIN: Joi.number().default(0),
  processOUT: Joi.number().default(0),
  processRejection: Joi.number().default(0),
});

const processBasedSchema = Joi.object({
  recipeId: Joi.string().custom(objectId).required(),
  recipeName: Joi.string().required(),
  processes: Joi.array().items(processSchema),
});

const createProductionOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    productionOrderCode: Joi.string().required().label('Production Order Code').messages({
      'string.empty': '{{#label}} cannot be empty',
      'any.required': '{{#label}} is required',
    }),
    isSalesOrderBased: Joi.boolean().required(),

    salesOrderId: Joi.alternatives().conditional('isSalesOrderBased', {
      is: true,
      then: Joi.string().required().custom(objectId),
      otherwise: Joi.string().allow(null).optional(),
    }),
    itemId: Joi.string().custom(objectId).required(),
    itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
    productionDepartmentWarehouseConfigId: Joi.string().custom(objectId).allow(null, '').optional(),
    quantity: Joi.number().min(0).required(),
    productionManageMethod: Joi.string().valid('PROCESS_ROUTE', 'BOM_BASED').required(),
    inStockWarehouseId: Joi.string().custom(objectId).required(),
    productionWarehouseId: Joi.string().custom(objectId).required(),
    inventoryInwarehouseId: Joi.string().custom(objectId).required(),
    rawMaterials: Joi.when('productionManageMethod', {
      is: 'BOM_BASED',
      then: Joi.array()
        .items(
          Joi.object({
            rawMaterialId: Joi.string().custom(objectId).required(),
            itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
            perItemRequiredUnit: Joi.number().required(),
            productionOrderRequiredUnit: Joi.number().required(),
          }),
        )
        .required(),
      otherwise: Joi.forbidden(),
    }),
    productionOwner: Joi.array().items(Joi.string().custom(objectId)),
    processBased: Joi.when('productionManageMethod', {
      is: 'PROCESS_ROUTE',
      then: processBasedSchema.required(),
      otherwise: Joi.forbidden(),
    }),
  }),
};

const getProductionOrders = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    branchId: Joi.string(),
    warehouseId: Joi.string().custom(objectId),
    divisionId: Joi.string().custom(objectId),
    status: Joi.string(),
    productionManageMethod: Joi.string().valid('PROCESS_ROUTE', 'BOM_BASED'),
    itemGroupId: Joi.string(),
    subItemGroupId: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    ...commonSchemas.dateRangeQuery(),
    date: commonSchemas.date({ label: 'Date' }),
    page: Joi.number().integer(),
    search: Joi.string(),
    productionDate: commonSchemas.date({ label: 'Production Date' }),
  }),
};

const additionalCostItem = Joi.object({
  notes: Joi.string().allow(null, ''),
  amount: Joi.number().min(0).allow(null, ''),
});

// Multiple cost rows supported per submission
const additionalCostList = Joi.array().items(additionalCostItem);

// Shared by submitProductionOrder (create a submission) and editSubmission (replace one in place)
const submissionBodySchema = Joi.object()
  .keys({
    fgSubmittedQty: Joi.number().min(0).required(),
    fgRejectedQty: Joi.number().min(0).required(),
    manpowerCost: Joi.array().items(
      Joi.object({
        manpowerId: Joi.string().custom(objectId).allow(null, ''),
        workerHours: Joi.number().min(0).allow(null, ''),
        workerCost: Joi.number().min(0).allow(null, ''),
      }),
    ),
    additionalCost: additionalCostList,
    rawMaterials: Joi.array().items(
      Joi.object({
        rawMaterialId: Joi.string().custom(objectId).required(),
        itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
        productionOrderSubmittedUnit: Joi.number().min(0).required(),
        perItemRequiredUnit: Joi.number().min(0).required(),
        productionOrderRequiredUnit: Joi.number().min(0).required(),
        bomRRQty: Joi.number().min(0).required(),
        rejectQty: Joi.number().min(0).required(),
        returnQty: Joi.number().min(0).required(),
      }),
    ),
    // Multiple scrap-out items recovered in this submission, added back to production stock
    scrapOut: Joi.array().items(
      Joi.object({
        item: Joi.string().custom(objectId).allow(null, ''),
        itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
        value: Joi.number().min(0).allow(null),
      }).and('item', 'value'),
    ),
  })
  .min(1);

const submitProductionOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
  body: submissionBodySchema,
};

const editSubmission = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
    submissionId: Joi.string().required().custom(objectId),
  }),
  body: submissionBodySchema,
};

const deleteSubmission = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
    submissionId: Joi.string().required().custom(objectId),
  }),
};

const startProcess = {
  query: Joi.object().keys({
    productionOrderId: Joi.string().required().custom(objectId).label('ProductionOrderId ID'),
    processId: Joi.string().required().custom(objectId).label('Process ID'),
    companyId: Joi.string().custom(objectId),
  }),
};

const endProcess = {
  query: Joi.object().keys({
    productionOrderId: Joi.string().required().custom(objectId).label('ProductionOrderId ID'),
    processId: Joi.string().required().custom(objectId).label('Process ID'),
    companyId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    remarks: Joi.string().allow('', null),
  }),
};

const submitProcess = {
  query: Joi.object().keys({
    productionOrderId: Joi.string().required().custom(objectId).label('productionOrderId ID'),
    processId: Joi.string().required().custom(objectId).label('Process ID'),
    companyId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    totalUsedUnit: Joi.number().allow(null, '').label('Total Used Unit'),
    manPower: Joi.array().items(
      Joi.object({
        workerId: Joi.string().custom(objectId).allow(null, ''),
        salaryPerHour: Joi.number().allow(null, ''),
        workerHours: Joi.number().allow(null, ''),
        workerCost: Joi.number().allow(null, ''),
      }).and('workerId', 'salaryPerHour'), // both required together if one exists
    ),

    scrapOutProcess: Joi.array().items(
      Joi.object({
        item: Joi.string().custom(objectId).allow(null, ''),
        itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
        value: Joi.number().min(0).allow(null),
      }).and('item', 'value'),
    ),

    processRawMaterialInput: Joi.array().items(
      Joi.object({
        item: Joi.string().custom(objectId).allow(null, ''),
        itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
        value: Joi.number().min(0).allow(null),
      }).and('item', 'value'),
    ),
    remarks: Joi.string().allow('', null),
    // processIN is derived server-side (order quantity for the first process, previous
    // process's output for every later one) and never taken from the client.
    processIN: Joi.number().label('Process IN'),
    processOUT: Joi.number().min(0).default(0).label('Process OUT'),
    processRejection: Joi.number().min(0).default(0).label('Process Rejection'),
    additionalCost: additionalCostList,
  }),
};

const deleteProcessSubmission = {
  query: Joi.object().keys({
    productionOrderId: Joi.string().required().custom(objectId).label('productionOrderId ID'),
    processId: Joi.string().required().custom(objectId).label('Process ID'),
    submissionId: Joi.string().required().custom(objectId).label('Submission ID'),
    companyId: Joi.string().custom(objectId),
  }),
};

const editProcessSubmission = {
  query: Joi.object().keys({
    productionOrderId: Joi.string().required().custom(objectId).label('productionOrderId ID'),
    processId: Joi.string().required().custom(objectId).label('Process ID'),
    submissionId: Joi.string().required().custom(objectId).label('Submission ID'),
    companyId: Joi.string().custom(objectId),
  }),
  body: Joi.object().keys({
    totalUsedUnit: Joi.number().allow(null, '').label('Total Used Unit'),
    manPower: Joi.array().items(
      Joi.object({
        workerId: Joi.string().custom(objectId).allow(null, ''),
        salaryPerHour: Joi.number().allow(null, ''),
        workerHours: Joi.number().allow(null, ''),
        workerCost: Joi.number().allow(null, ''),
      }).and('workerId', 'salaryPerHour'), // both required together if one exists
    ),

    scrapOutProcess: Joi.array().items(
      Joi.object({
        item: Joi.string().custom(objectId).allow(null, ''),
        itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
        value: Joi.number().min(0).allow(null),
      }).and('item', 'value'),
    ),

    processRawMaterialInput: Joi.array().items(
      Joi.object({
        item: Joi.string().custom(objectId).allow(null, ''),
        itemUnitId: Joi.string().custom(objectId).allow(null, '').label('Item Unit ID'),
        value: Joi.number().min(0).allow(null),
      }).and('item', 'value'),
    ),
    remarks: Joi.string().allow('', null),
    processOUT: Joi.number().min(0).label('Process OUT'),
    processRejection: Joi.number().min(0).label('Process Rejection'),
    additionalCost: additionalCostList,
  }),
};

const getProductionOrdersById = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const getBomBasedProductionOrderById = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const getProcessBasedProductionOrderById = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const getMaterialConsumption = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const getScrapAndRejection = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const getSalesOrderDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId),
  }),
};

const getItemProductionData = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    itemId: Joi.string().required().custom(objectId),
    warehouseId: Joi.string().required().custom(objectId),
    processId: Joi.string().optional().custom(objectId),
  }),
};

const updateProductionOrderStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    status: Joi.string()
      .valid(...Object.values(PRODUCTION_ORDER_STATUS), ...Object.values(PRODUCTION_ORDER_STATUS_ACTION))
      .label('Status')
      .required()
      .messages({
        'any.only': '{{#label}} must be one of {{#valids}}',
      }),
    isManuallyCompleted: Joi.boolean().default(false).label('Is Manually Completed'),
  }),
};

const reRaiseTransferRequest = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const deleteProductionOrder = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
};

const reorderProcesses = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    id: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    processes: Joi.array().items(Joi.string().custom(objectId)).min(1).required().label('Processes').messages({
      'array.min': '{{#label}} must contain at least one process',
    }),
    isLocked: Joi.boolean().default(false).label('Is Locked'),
  }),
};

module.exports = {
  createProductionOrder,
  getProductionOrders,
  submitProductionOrder,
  startProcess,
  endProcess,
  submitProcess,
  deleteProcessSubmission,
  editProcessSubmission,
  getProductionOrdersById,
  getBomBasedProductionOrderById,
  getProcessBasedProductionOrderById,
  getMaterialConsumption,
  getScrapAndRejection,
  getSalesOrderDropdown,
  getItemProductionData,
  updateProductionOrderStatus,
  reRaiseTransferRequest,
  deleteProductionOrder,
  reorderProcesses,
  editSubmission,
  deleteSubmission,
};
