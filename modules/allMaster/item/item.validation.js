const Joi = require('joi');
const { objectId } = require('../../../validations/custom.validation');
const { commonSchemas } = require('../../../validations/common.validation');
const { ITEM_MESSAGES } = require('../../../utils/messages');

const purchasingDataSchema = Joi.object({
  timeBatchNumberMandatory: Joi.object({
    printOnDocument: Joi.boolean().default(false).optional().label('Price on Document (Time Batch)').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    activeInactive: Joi.boolean().default(true).optional().label('Active/Inactive (Time Batch)').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
  })
    .optional()
    .label('Time Batch Number Mandatory')
    .messages({
      'object.base': '{{#label}} must be an object',
    }),
  punchingTimeBatchNumberMandatory: Joi.object({
    printOnDocument: Joi.boolean().default(false).optional().label('Price on Document (Punching Time Batch)').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
    activeInactive: Joi.boolean().default(true).optional().label('Active/Inactive (Punching Time Batch)').messages({
      'boolean.base': '{{#label}} must be true or false',
    }),
  })
    .optional()
    .label('Punching Time Batch Number Mandatory')
    .messages({
      'object.base': '{{#label}} must be an object',
    }),
  vendorSideMFGAndQCDocument: Joi.array()
    .items(Joi.string().trim())
    .optional()
    .label('Vendor Side MFG and QC Document')
    .messages({
      'array.base': '{{#label}} must be an array of document links',
      'string.base': '{{#label}} must be a valid document link',
    }),
}).optional();

const salesDataSchema = Joi.object({
  beforeDispatchFromWarehouse: Joi.boolean().optional().label('Before Dispatch from Warehouse').messages({
    'boolean.base': '{{#label}} must be true or false',
  }),
  customerPortalEnable: Joi.boolean().optional().label('Customer Portal Enable').messages({
    'boolean.base': '{{#label}} must be true or false',
  }),
  fqlStander: Joi.array().items(Joi.string().custom(objectId)).allow(null).optional().label('FQL Standard').messages({
    'array.base': '{{#label}} must be an array of FQL standard IDs',
    'string.base': '{{#label}} must be a valid string ID',
  }),
  specificCustomerEnable: Joi.boolean().optional().label('Specific Customer Enable').messages({
    'boolean.base': '{{#label}} must be true or false',
  }),
  specificCustomers: Joi.array().items(Joi.string().custom(objectId)).optional().label('Specific Customers').messages({
    'array.base': '{{#label}} must be an array of customer IDs',
    'string.base': '{{#label}} must be a valid string ID',
  }),
  vendorSideMFGAndQCDocument: Joi.array()
    .items(Joi.string().trim())
    .optional()
    .label('Vendor Side MFG and QC Document')
    .messages({
      'array.base': '{{#label}} must be an array of document links',
      'string.base': '{{#label}} must be a valid document link',
    }),
}).optional();

const inventoryDataSchema = Joi.object({
  totalOpeningStock: Joi.number().allow(null, '').label('Total Opening Stock').messages({
    'number.base': '{{#label}} must be a number',
  }),
  quantity: Joi.number().default(0).label('Current Total Quantity').messages({
    'number.base': '{{#label}} must be a number',
  }),
  minimumStockLevel: Joi.number().min(0).allow(null, '').optional().default(0).label('Minimum Stock Level').messages({
    'number.base': '{{#label}} must be a number',
    'number.min': '{{#label}} cannot be negative',
  }),
  maximumStockLevel: Joi.number().min(0).allow(null, '').optional().default(0).label('Maximum Stock Level').messages({
    'number.base': '{{#label}} must be a number',
    'number.min': '{{#label}} cannot be negative',
  }),
  inventorySalesMethod: Joi.string()
    .valid('NEAREST_EXPIRY_DATE', 'SALES_TO_OPTION', 'LIFO', 'FIFO')
    .allow(null, '')
    .label('Inventory Sales Method')
    .messages({
      'string.base': '{{#label}} must be a string',
      'any.only': '{{#label}} must be one of the following values: NEAREST_EXPIRY_DATE, SALES_TO_OPTION, LIFO, FIFO',
    }),
  warehouses: Joi.array()
    .items(
      Joi.object({
        warehouseId: Joi.string().custom(objectId).allow(null, '').label('Warehouse ID').messages({
          'string.base': '{{#label}} must be a valid ObjectId',
        }),
        branchId: Joi.string().custom(objectId).allow(null, '').label('Branch ID').messages({
          'string.base': '{{#label}} must be a valid ObjectId',
        }),
        divisionId: Joi.string().custom(objectId).allow(null, '').label('Division ID').messages({
          'string.base': '{{#label}} must be a valid ObjectId',
        }),
        isActive: Joi.boolean().optional().label('Is Active').messages({
          'boolean.base': '{{#label}} must be true or false',
        }),
        openingStock: Joi.number().empty('').allow(null).default(0).label('Opening Stock').messages({
          'number.base': '{{#label}} must be a number',
        }),
        openingStockRate: Joi.when('openingStock', {
          is: Joi.number().greater(0).required(),
          then: Joi.number().greater(0).required().label('Opening Stock Rate').messages({
            'any.required': 'Please enter a positive opening stock rate.',
            'number.base': 'Please enter a positive opening stock rate.',
            'number.greater': 'Please enter a positive opening stock rate.',
          }),
          otherwise: Joi.number().allow(null).empty('').optional(),
        }),
      }),
    )
    .optional()
    .label('Warehouses')
    .messages({
      'array.base': '{{#label}} must be an array of branch objects',
      'object.base': '{{#label}} must be a valid branch object',
    }),
  stockMovements: Joi.array()
    .items(
      Joi.object({
        date: Joi.date().default(Date.now).label('Movement Date').messages({
          'date.base': '{{#label}} must be a valid date',
        }),
        movementType: Joi.string()
          // .valid(
          //   'OPENING',
          //   'PURCHASE',
          //   'SALE',
          //   'TRANSFER_IN',
          //   'TRANSFER_OUT',
          //   'ADJUSTMENT',
          //   'RETURN'
          // )
          // .required()
          .label('Movement Type')
          .messages({
            'string.base': '{{#label}} must be a string',
            'any.only': '{{#label}} must be one of the valid movement types',
            'any.required': '{{#label}} is required',
          }),
        quantity: Joi.number().required().label('Movement Quantity').messages({
          'number.base': '{{#label}} must be a number',
          'any.required': '{{#label}} is required',
        }),
        fromWarehouseId: Joi.string().custom(objectId).allow(null).label('From Warehouse').messages({
          'string.base': '{{#label}} must be a valid ObjectId',
        }),
        toWarehouseId: Joi.string().custom(objectId).allow(null).label('To Warehouse').messages({
          'string.base': '{{#label}} must be a valid ObjectId',
        }),
        referenceId: Joi.string().custom(objectId).allow(null).label('Reference ID').messages({
          'string.base': '{{#label}} must be a valid ObjectId',
        }),
        referenceNumber: Joi.string().allow(null, '').label('Reference Number').messages({
          'string.base': '{{#label}} must be a string',
        }),
        batchNumber: Joi.string().allow(null, '').label('Batch Number').messages({
          'string.base': '{{#label}} must be a string',
        }),
        notes: Joi.string().allow(null, '').label('Notes').messages({
          'string.base': '{{#label}} must be a string',
        }),
        addedBy: Joi.string().custom(objectId).allow(null).label('Added By').messages({
          'string.base': '{{#label}} must be a valid ObjectId',
        }),
      }),
    )
    .default([])
    .label('Stock Movements')
    .messages({
      'array.base': '{{#label}} must be an array',
    }),
})
  .custom((value, helpers) => {
    const min = value.minimumStockLevel ?? 0;
    const max = value.maximumStockLevel ?? 0;
    if (min > 0 && max > 0 && min > max) {
      return helpers.error('any.custom', {
        message: 'Minimum Stock Level cannot be greater than Maximum Stock Level',
      });
    }
    return value;
  })
  .messages({
    'any.custom': '{{#message}}',
  })
  .optional();

const productionDataSchema = Joi.object({
  productionManageMethod: Joi.string()
    .valid('PROCESS_ROUTE', 'BOM_BASED')
    .allow(null, '')
    .label('Production Management Method')
    .messages({
      'string.base': '{{#label}} must be a string',
      'any.only': '{{#label}} must be one of the following values: PROCESS_ROUTE, BOM_BASED',
    }),
  bomBased: Joi.array()
    .items(
      Joi.object({
        item: Joi.string().custom(objectId).required().label('Item').messages({
          'string.base': '{{#label}} must be a valid string (ObjectId)',
          'any.required': '{{#label}} is required',
        }),
        oldItemId: Joi.string().custom(objectId).optional().label('Old Item ID').messages({
          'string.base': '{{#label}} must be a valid string (ObjectId)',
        }),
        itemGroup: Joi.string().custom(objectId).required().label('Item Group').messages({
          'string.base': '{{#label}} must be a valid string (ObjectId)',
          'any.required': '{{#label}} is required',
        }),
        itemUnitId: Joi.string().custom(objectId).allow(null, '').optional().label('Item Unit ID').messages({
          'string.base': '{{#label}} must be a valid string (ObjectId)',
        }),
        qtyPerItem: Joi.number().required().label('Quantity Per Item').messages({
          'number.base': '{{#label}} must be a number',
          'any.required': '{{#label}} is required',
        }),
        reject: Joi.boolean().optional().label('Reject').messages({
          'boolean.base': '{{#label}} must be a boolean',
        }),
        return: Joi.boolean().optional().label('Return').messages({
          'boolean.base': '{{#label}} must be a boolean',
        }),
      }),
    )
    .label('BOM Based Items')
    .messages({
      'array.base': '{{#label}} must be an array of items',
    }),
  selectProcessRecipe: Joi.string().custom(objectId).allow(null, '').label('Process Recipe ID').messages({
    'string.base': '{{#label}} must be a valid string (ObjectId)',
  }),
  processBased: Joi.array()
    .items(
      Joi.object({
        processId: Joi.string().custom(objectId).required().label('Process ID').messages({
          'string.base': '{{#label}} must be a valid string (ObjectId)',
          'any.required': '{{#label}} is required',
        }),
        rawMaterials: Joi.array()
          .items(
            Joi.object({
              item: Joi.string().custom(objectId).required().label('Item').messages({
                'string.base': '{{#label}} must be a valid string (ObjectId)',
                'any.required': '{{#label}} is required',
              }),
              oldItemId: Joi.string().custom(objectId).optional().label('Old Item ID').messages({
                'string.base': '{{#label}} must be a valid string (ObjectId)',
              }),
              itemGroup: Joi.string().custom(objectId).required().label('Item Group').messages({
                'string.base': '{{#label}} must be a valid string (ObjectId)',
                'any.required': '{{#label}} is required',
              }),
              itemUnitId: Joi.string().custom(objectId).allow(null, '').optional().label('Item Unit ID').messages({
                'string.base': '{{#label}} must be a valid string (ObjectId)',
              }),
              qtyPerItem: Joi.number().required().label('Quantity Per Item').messages({
                'number.base': '{{#label}} must be a number',
                'any.required': '{{#label}} is required',
              }),
              reject: Joi.boolean().optional().label('Reject').messages({
                'boolean.base': '{{#label}} must be a boolean',
              }),
              return: Joi.boolean().optional().label('Return').messages({
                'boolean.base': '{{#label}} must be a boolean',
              }),
            }),
          )
          .label('Raw Materials')
          .messages({
            'array.base': '{{#label}} must be an array of items',
          }),
      }),
    )
    .label('Process Based Items')
    .messages({
      'array.base': '{{#label}} must be an array of items',
    }),
  productionScrapOutInventory: Joi.array()
    .items(
      Joi.object({
        scrapItemName: Joi.string().custom(objectId).required().label('Scrap Item Name').messages({
          'string.base': '{{#label}} must be a valid string (ObjectId)',
          'any.required': '{{#label}} is required',
        }),
        itemUnitId: Joi.string().custom(objectId).allow(null, '').optional().label('Item Unit ID').messages({
          'string.base': '{{#label}} must be a valid string (ObjectId)',
        }),
        qtyPerItem: Joi.number().required().label('Quantity Per Scrap Item').messages({
          'number.base': '{{#label}} must be a number',
          'any.required': '{{#label}} is required',
        }),
      }),
    )
    .label('Scrap Out Inventory')
    .messages({
      'array.base': '{{#label}} must be an array of scrap items',
    }),
}).optional();

const createProductionDataSchema = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    productionManageMethod: Joi.string()
      .valid('PROCESS_ROUTE', 'BOM_BASED')
      .required()
      .label('Production Management Method')
      .messages({
        'string.base': '{{#label}} must be a string',
        'any.only': '{{#label}} must be one of the following values: PROCESS_ROUTE, BOM_BASED',
        'any.required': '{{#label}} is required',
      }),
    bomBased: Joi.when('productionManageMethod', {
      is: 'BOM_BASED',
      then: Joi.array()
        .items(
          Joi.object({
            item: Joi.string().custom(objectId).required().label('Item').messages({
              'string.base': '{{#label}} must be a valid string (ObjectId)',
              'any.required': '{{#label}} is required',
            }),
            oldItemId: Joi.string().custom(objectId).optional().label('Old Item ID').messages({
              'string.base': '{{#label}} must be a valid string (ObjectId)',
            }),
            itemGroup: Joi.string().custom(objectId).required().label('Item Group').messages({
              'string.base': '{{#label}} must be a valid string (ObjectId)',
              'any.required': '{{#label}} is required',
            }),
            itemUnitId: Joi.string().custom(objectId).allow(null, '').optional().label('Item Unit ID').messages({
              'string.base': '{{#label}} must be a valid string (ObjectId)',
            }),
            qtyPerItem: Joi.number().required().label('Quantity Per Item').messages({
              'number.base': '{{#label}} must be a number',
              'any.required': '{{#label}} is required',
            }),
            reject: Joi.boolean().optional().label('Reject').messages({
              'boolean.base': '{{#label}} must be a boolean',
            }),
            return: Joi.boolean().optional().label('Return').messages({
              'boolean.base': '{{#label}} must be a boolean',
            }),
          }),
        )
        .min(1)
        .required()
        .label('BOM Based Items')
        .messages({
          'array.base': '{{#label}} must be an array of items',
          'array.min': 'At least one BOM Based Item is required',
          'any.required': 'BOM Based Items is required when Production Management Method is BOM_BASED',
        }),
      otherwise: Joi.array()
        .items(
          Joi.object({
            item: Joi.string().custom(objectId),
            oldItemId: Joi.string().custom(objectId),
            itemGroup: Joi.string().custom(objectId),
            qtyPerItem: Joi.number(),
            reject: Joi.boolean(),
            return: Joi.boolean(),
          }),
        )
        .optional(),
    }),
    processBased: Joi.array()
      .items(
        Joi.object({
          processId: Joi.string().custom(objectId).required().label('Process ID').messages({
            'string.base': '{{#label}} must be a valid string (ObjectId)',
            'any.required': '{{#label}} is required',
          }),
          rawMaterials: Joi.array()
            .items(
              Joi.object({
                item: Joi.string().custom(objectId).required().label('Item').messages({
                  'string.base': '{{#label}} must be a valid string (ObjectId)',
                  'any.required': '{{#label}} is required',
                }),
                oldItemId: Joi.string().custom(objectId).optional().label('Old Item ID').messages({
                  'string.base': '{{#label}} must be a valid string (ObjectId)',
                }),
                itemGroup: Joi.string().custom(objectId).required().label('Item Group').messages({
                  'string.base': '{{#label}} must be a valid string (ObjectId)',
                  'any.required': '{{#label}} is required',
                }),
                itemUnitId: Joi.string().custom(objectId).allow(null, '').optional().label('Item Unit ID').messages({
                  'string.base': '{{#label}} must be a valid string (ObjectId)',
                }),
                qtyPerItem: Joi.number().required().label('Quantity Per Item').messages({
                  'number.base': '{{#label}} must be a number',
                  'any.required': '{{#label}} is required',
                }),
                reject: Joi.boolean().optional().label('Reject').messages({
                  'boolean.base': '{{#label}} must be a boolean',
                }),
                return: Joi.boolean().optional().label('Return').messages({
                  'boolean.base': '{{#label}} must be a boolean',
                }),
              }),
            )
            .label('Raw Materials')
            .messages({
              'array.base': '{{#label}} must be an array of items',
            }),
        }),
      )
      .label('Process Based Items')
      .messages({
        'array.base': '{{#label}} must be an array of items',
      }),
    selectProcessRecipe: Joi.when('productionManageMethod', {
      is: 'PROCESS_ROUTE',
      then: Joi.string().custom(objectId).required().label('Process Recipe ID').messages({
        'string.base': '{{#label}} must be a valid string',
        'any.required': 'Process Recipe is required when Production Management Method is PROCESS_ROUTE',
      }),
      otherwise: Joi.string().custom(objectId).allow(null, '').optional().label('Process Recipe ID').messages({
        'string.base': '{{#label}} must be a valid string',
      }),
    }),
    productionScrapOutInventory: Joi.array()
      .items(
        Joi.object({
          scrapItemName: Joi.string().custom(objectId).required().label('Scrap Item Name').messages({
            'string.base': '{{#label}} must be a valid string',
            'any.required': '{{#label}} is required',
          }),
          itemUnitId: Joi.string().custom(objectId).allow(null, '').optional().label('Item Unit ID').messages({
            'string.base': '{{#label}} must be a valid string (ObjectId)',
          }),
          qtyPerItem: Joi.number().required().label('Quantity Per Scrap Item').messages({
            'number.base': '{{#label}} must be a number',
            'any.required': '{{#label}} is required',
          }),
        }),
      )
      .label('Scrap Out Inventory')
      .messages({
        'array.base': '{{#label}} must be an array of scrap items',
      }),
  }),
};

const salesInformationSchema = Joi.object({
  isSellable: Joi.boolean().optional(),

  sellingPrice: Joi.number()
    .when('isSellable', {
      is: true,
      then: Joi.number().required(),
      otherwise: Joi.number().allow(null),
    })
    .label('Selling Price')
    .messages({
      'number.base': '{{#label}} must be a number',
      'any.required': 'Selling Price is required when Sellable is true',
    }),

  salesAccountId: Joi.string()
    .custom(objectId)
    .allow(null)
    .when('isSellable', {
      is: true,
      then: Joi.required(),
    })
    .label('Sales Account')
    .messages({
      'string.base': '{{#label}} must be a valid string (ObjectId)',
      'any.required': 'Sales Account is required when Sellable is true',
    }),
});

const purchaseInformationSchema = Joi.object({
  isPurchasable: Joi.boolean().optional(),

  costPrice: Joi.number()
    .when('isPurchasable', {
      is: true,
      then: Joi.number().required(),
      otherwise: Joi.number().allow(null),
    })
    .label('Purchase Price')
    .messages({
      'number.base': '{{#label}} must be a number',
      'any.required': 'Cost Price is required when Purchasable is true',
    }),

  purchaseAccountId: Joi.string()
    .custom(objectId)
    .allow(null)
    .when('isPurchasable', {
      is: true,
      then: Joi.required(),
    })
    .label('Purchase Account')
    .messages({
      'string.base': '{{#label}} must be a valid string (ObjectId)',
      'any.required': 'Purchase Account is required when Purchasable is true',
    }),
});

const createItem = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object()
    .keys({
      itemNo: Joi.string().optional(),
      description: Joi.string().optional().allow('').label('Description').messages({
        'string.base': '{{#label}} must be a string',
      }),
      itemName: Joi.string().required().trim().label('Item Name').messages({
        'string.base': '{{#label}} must be a string',
        'any.required': '{{#label}} is required',
      }),
      itemType: Joi.string()
        .required()
        .valid('RM', 'FG', 'SEMI_RM', 'CONSUMABLE', 'TRADE', 'SCRAP', 'SERVICE')
        .optional()
        .label('Item Type')
        .messages({
          'string.base': '{{#label}} must be a string',
          'any.only': '{{#label}} must be one of the following values: RM, FG, SEMI_RM, CONSUMABLE, TRADE, SCRAP, SERVICE',
        }),
      itemModelNo: Joi.string().required().trim().required().label('Item Model Number').messages({
        'string.base': '{{#label}} must be a string',
      }),
      itemGroup: Joi.string().required().custom(objectId).required().label('Item Group ID').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      subItemGroup: Joi.string().custom(objectId).allow(null, '').optional().label('Sub Item Group ID').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      itemStatus: Joi.boolean().optional().default(true).label('Item Status').messages({
        'boolean.base': '{{#label}} must be a boolean',
      }),
      itemCategory: Joi.object({
        isGoods: Joi.boolean().optional(),
        isService: Joi.boolean().optional(),
      }).required(),
      itemUnit: Joi.string().required().label('Item Unit').messages({
        'string.base': '{{#label}} must be a string',
        'any.only': '{{#label}} must be one of the following values',
        'any.required': '{{#label}} is required',
      }),
      itemUnitId: Joi.string().custom(objectId).required().label('Item Unit ID').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
        'any.required': '{{#label}} is required',
      }),
      unitConversions: Joi.array()
        .items(
          Joi.object({
            itemUnitId: Joi.string().custom(objectId).required().label('Conversion Unit').messages({
              'string.base': '{{#label}} must be a valid string (ObjectId)',
              'any.required': '{{#label}} is required',
            }),
            qty: Joi.number().greater(0).default(1).label('Conversion Quantity').messages({
              'number.base': '{{#label}} must be a number',
              'number.greater': '{{#label}} must be greater than 0',
            }),
            baseQty: Joi.number().greater(0).required().label('Base Quantity').messages({
              'number.base': '{{#label}} must be a number',
              'number.greater': '{{#label}} must be greater than 0',
              'any.required': '{{#label}} is required',
            }),
            purchasePrice: Joi.number().min(0).default(0).label('Purchase Price').messages({
              'number.base': '{{#label}} must be a number',
              'number.min': '{{#label}} cannot be negative',
            }),
            salesPrice: Joi.number().min(0).default(0).label('Sales Price').messages({
              'number.base': '{{#label}} must be a number',
              'number.min': '{{#label}} cannot be negative',
            }),
          }),
        )
        .default([])
        .label('Unit Conversions')
        .messages({
          'array.base': '{{#label}} must be an array',
        }),
      stockInUnit: Joi.string().custom(objectId).allow(null).optional().label('Stock In Unit').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      stockOutUnit: Joi.string().custom(objectId).allow(null).optional().label('Stock Out Unit').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      trackInventory: Joi.boolean().required().label('Track Inventory'),
      gst: Joi.string().required().label('GST Tax Applicable'),
      hsnCode: Joi.string().required().label('HSN Code'),
      purchasingData: purchasingDataSchema.allow(null).optional(),
      salesData: salesDataSchema.optional(),
      inventoryData: inventoryDataSchema.optional(),
      productionData: productionDataSchema.optional(),
      salesInformation: salesInformationSchema.optional(),
      purchaseInformation: purchaseInformationSchema.optional(),
      remarks: Joi.string().trim().allow('', null).optional().label('Remarks').messages({
        'string.base': '{{#label}} must be a string',
      }),
      inventoryAccountId: Joi.string().custom(objectId).optional().allow(null).label('Inventory Account').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments').messages({
        'array.base': '{{#label}} must be an array',
      }),
    })
    .custom((value, helpers) => {
      const salesInfo = value.salesInformation || {};
      const purchaseInfo = value.purchaseInformation || {};

      const isSellable = salesInfo.isSellable === true;
      const isPurchasable = purchaseInfo.isPurchasable === true;

      const itemCategory = value.itemCategory || {};

      if (!itemCategory.isGoods && !itemCategory.isService) {
        return helpers.error('any.custom', {
          message: 'Please select either Goods or Service',
        });
      }
      // A service has no stock, so it can never be inventory tracked.
      if (itemCategory.isService && value.trackInventory === true) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.SERVICE_CANNOT_TRACK_INVENTORY });
      }
      // Tracked stock has to be valued somewhere.
      if (value.trackInventory === true && !value.inventoryAccountId) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.INVENTORY_ACCOUNT_REQUIRED });
      }
      if (value.trackInventory !== true && value.inventoryAccountId) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.INVENTORY_ACCOUNT_NOT_ALLOWED });
      }
      if (!isSellable && salesInfo.salesAccountId) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.SALES_ACCOUNT_NOT_ALLOWED });
      }
      if (!isPurchasable && purchaseInfo.purchaseAccountId) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.PURCHASE_ACCOUNT_NOT_ALLOWED });
      }
      // An item that is neither sold, bought nor stocked has no purpose.
      if (!isSellable && !isPurchasable && value.trackInventory !== true) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.NO_ROLE_SELECTED });
      }
      if (isSellable && !(Number(salesInfo.sellingPrice) > 0)) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.SELLING_PRICE_REQUIRED });
      }
      if (isPurchasable && !(Number(purchaseInfo.costPrice) > 0)) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.COST_PRICE_REQUIRED });
      }

      // Only a tracked item keeps stock, so opening stock without tracking has nowhere to sit.
      if (
        value.trackInventory !== true &&
        (value.inventoryData?.warehouses || []).some(warehouse => Number(warehouse.openingStock) > 0)
      ) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.OPENING_STOCK_NEEDS_TRACKING });
      }

      return value;
    })
    .messages({
      'any.custom': '{{#message}}',
    }),
};

const getItems = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    appName: Joi.string().allow('', null).optional(),
    itemNo: Joi.string(),
    itemName: Joi.string(),
    itemType: Joi.string(),
    itemGroup: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean().optional(),
    search: Joi.string(),
    itemStatus: Joi.boolean(),
    status: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    itemDate: Joi.date(),
    category: Joi.string(),
  }),
};

const getItemsExports = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    itemNo: Joi.string(),
    itemName: Joi.string(),
    itemType: Joi.string(),
    itemGroup: Joi.string(),
    subItemGroup: Joi.string(),
    appName: Joi.string().allow('', null).optional(),
    search: Joi.string(),
    itemStatus: Joi.boolean(),
    status: Joi.string(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    itemDate: Joi.date(),
    category: Joi.string(),
  }),
};

const getItemsDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    sortBy: Joi.string(),
    itemType: Joi.string().valid('RM', 'FG', 'SEMI_RM', 'CONSUMABLE', 'TRADE', 'SCRAP', 'SERVICE'),
    itemGroup: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean().optional(),
  }),
};

const getItem = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
  }),
};

const getItemInventoryDetails = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
  }),
};

const getItemInventoryBatches = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    ...commonSchemas.paginationQuery(),
  }),
  params: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
  }),
};

const getItemInventoryBatchById = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
  }),
  params: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
    batchId: Joi.string().custom(objectId).required(),
  }),
};

const getItemInventoryStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    itemId: Joi.string().custom(objectId).optional(),
    warehouseId: Joi.string().optional(),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    itemType: Joi.string().optional(),
    itemGroup: Joi.string().optional(),
    itemIds: Joi.string().optional(),
    stockStatus: Joi.string().optional(),
    includeZeroInventory: Joi.boolean().optional(),
    search: Joi.string(),
    ...commonSchemas.paginationQuery(),
    itemStatus: Joi.boolean(),
  }),
};

const updateItem = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required().label('Item ID').messages({
      'string.base': '{{#label}} must be a valid string (ObjectId)',
      'any.required': '{{#label}} is required',
    }),
  }),

  body: Joi.object()
    .keys({
      description: Joi.string().allow('').optional().label('Description').messages({
        'string.base': '{{#label}} must be a string',
      }),

      itemName: Joi.string().trim().required().label('Item Name').messages({
        'string.base': '{{#label}} must be a string',
      }),

      itemType: Joi.string()
        .valid('RM', 'FG', 'SEMI_RM', 'CONSUMABLE', 'TRADE', 'SCRAP', 'SERVICE')
        .required()
        .label('Item Type')
        .messages({
          'string.base': '{{#label}} must be a string',
          'any.only': '{{#label}} must be one of the following values: RM, FG, SEMI_RM, CONSUMABLE, TRADE, SCRAP, SERVICE',
        }),

      itemModelNo: Joi.string().trim().required().label('Item Model Number').messages({
        'string.base': '{{#label}} must be a string',
      }),

      itemGroup: Joi.string().custom(objectId).required().label('Item Group ID').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      subItemGroup: Joi.string().custom(objectId).allow(null, '').optional().label('Sub Item Group ID').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),

      itemStatus: Joi.boolean().optional().label('Item Status').messages({
        'boolean.base': '{{#label}} must be a boolean',
      }),
      itemCategory: Joi.object({
        isGoods: Joi.boolean().optional().label('Is Goods'),
        isService: Joi.boolean().optional().label('Is Service'),
      }).optional(),

      itemUnit: Joi.string().required().label('Item Unit').messages({
        'string.base': '{{#label}} must be a string',
        'any.only': '{{#label}} must be one of the following values: ',
        'any.required': '{{#label}} is required',
      }),

      itemUnitId: Joi.string().custom(objectId).required().label('Item Unit ID').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
        'any.required': '{{#label}} is required',
      }),
      unitConversions: Joi.array()
        .items(
          Joi.object({
            itemUnitId: Joi.string().custom(objectId).required().label('Conversion Unit').messages({
              'string.base': '{{#label}} must be a valid string (ObjectId)',
              'any.required': '{{#label}} is required',
            }),
            qty: Joi.number().greater(0).default(1).label('Conversion Quantity').messages({
              'number.base': '{{#label}} must be a number',
              'number.greater': '{{#label}} must be greater than 0',
            }),
            baseQty: Joi.number().greater(0).required().label('Base Quantity').messages({
              'number.base': '{{#label}} must be a number',
              'number.greater': '{{#label}} must be greater than 0',
              'any.required': '{{#label}} is required',
            }),
            purchasePrice: Joi.number().min(0).default(0).label('Purchase Price').messages({
              'number.base': '{{#label}} must be a number',
              'number.min': '{{#label}} cannot be negative',
            }),
            salesPrice: Joi.number().min(0).default(0).label('Sales Price').messages({
              'number.base': '{{#label}} must be a number',
              'number.min': '{{#label}} cannot be negative',
            }),
          }),
        )
        .default([])
        .label('Unit Conversions')
        .messages({
          'array.base': '{{#label}} must be an array',
        }),
      stockInUnit: Joi.string().custom(objectId).allow(null).optional().label('Stock In Unit').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      stockOutUnit: Joi.string().custom(objectId).allow(null).optional().label('Stock Out Unit').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      trackInventory: Joi.boolean().optional().label('Track Inventory'),
      gst: Joi.string().required().label('GST Tax Applicable'),
      hsnCode: Joi.string().required().label('HSN Code'),
      purchasingData: purchasingDataSchema.optional(),
      salesData: salesDataSchema.optional(),
      inventoryData: inventoryDataSchema.optional(),
      productionData: productionDataSchema.optional(),
      salesInformation: salesInformationSchema.optional(),
      purchaseInformation: purchaseInformationSchema.optional(),
      remarks: Joi.string().trim().allow('').optional().label('Remarks').messages({
        'string.base': '{{#label}} must be a string',
      }),
      attachments: Joi.array().items(Joi.string().trim()).optional().label('Attachments').messages({
        'array.base': '{{#label}} must be an array',
      }),
      inventoryAccountId: Joi.string().custom(objectId).optional().allow(null).label('Inventory Account').messages({
        'string.base': '{{#label}} must be a valid string (ObjectId)',
      }),
      removeItemUnitId: Joi.array().items(Joi.string().custom(objectId)).optional(),
    })
    .custom((value, helpers) => {
      const salesInfo = value.salesInformation || {};
      const purchaseInfo = value.purchaseInformation || {};

      const isSellable = salesInfo.isSellable === true;
      const isPurchasable = purchaseInfo.isPurchasable === true;

      if (value.itemCategory !== undefined) {
        const itemCategory = value.itemCategory || {};
        if (!itemCategory.isGoods && !itemCategory.isService) {
          return helpers.error('any.custom', {
            message: 'Please select either Goods or Service',
          });
        }
        // A service has no stock, so it can never be inventory tracked.
        if (itemCategory.isService && value.trackInventory === true) {
          return helpers.error('any.custom', { message: ITEM_MESSAGES.SERVICE_CANNOT_TRACK_INVENTORY });
        }
      }
      // Tracked stock has to be valued somewhere.
      if (value.trackInventory === true && !value.inventoryAccountId) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.INVENTORY_ACCOUNT_REQUIRED });
      }
      if ((value.trackInventory === false || value.itemCategory?.isService === true) && value.inventoryAccountId) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.INVENTORY_ACCOUNT_NOT_ALLOWED });
      }
      if (salesInfo.isSellable === false && salesInfo.salesAccountId) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.SALES_ACCOUNT_NOT_ALLOWED });
      }
      if (purchaseInfo.isPurchasable === false && purchaseInfo.purchaseAccountId) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.PURCHASE_ACCOUNT_NOT_ALLOWED });
      }

      // Only validate when salesInformation or purchaseInformation is being updated
      if (value.salesInformation !== undefined || value.purchaseInformation !== undefined) {
        if (!isSellable && !isPurchasable && value.trackInventory !== true) {
          return helpers.error('any.custom', { message: ITEM_MESSAGES.NO_ROLE_SELECTED });
        }

        if (isSellable && !(Number(salesInfo.sellingPrice) > 0)) {
          return helpers.error('any.custom', { message: ITEM_MESSAGES.SELLING_PRICE_REQUIRED });
        }
        if (isPurchasable && !(Number(purchaseInfo.costPrice) > 0)) {
          return helpers.error('any.custom', { message: ITEM_MESSAGES.COST_PRICE_REQUIRED });
        }
      }

      // Only a tracked item keeps stock, so opening stock without tracking has nowhere to sit.
      if (
        value.trackInventory === false &&
        (value.inventoryData?.warehouses || []).some(warehouse => Number(warehouse.openingStock) > 0)
      ) {
        return helpers.error('any.custom', { message: ITEM_MESSAGES.OPENING_STOCK_NEEDS_TRACKING });
      }

      return value;
    })
    .messages({
      'any.custom': '{{#message}}',
    })
    .min(1),
};

const deleteItem = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  params: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
  }),
};

const addItemStock = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: Joi.object().keys({
    itemId: Joi.string().required().custom(objectId).label('Item ID'),
    divisionId: Joi.string().required().custom(objectId).label('Division ID'),
    branchId: Joi.string().required().custom(objectId).label('Branch ID'),
    warehouseId: Joi.string().required().custom(objectId).label('Warehouse ID'),
    quantity: Joi.number().required().min(1).label('Quantity'),
    price: Joi.number().required().label('Price'),
    referenceNumber: Joi.string().trim().allow('').optional().label('Reference Number'),
    notes: Joi.string().trim().allow('').optional().label('Notes'),
  }),
};

const bulkSalesInformationSchema = Joi.object({
  isSellable: Joi.boolean().optional(),
  sellingPrice: Joi.number().allow(null).optional().label('Selling Price').messages({
    'number.base': '{{#label}} must be a number',
  }),
  salesAccountName: Joi.string().trim().allow('', null).optional().label('Sales Account'),
});

const bulkPurchaseInformationSchema = Joi.object({
  isPurchasable: Joi.boolean().optional(),
  costPrice: Joi.number().allow(null).optional().label('Purchase Price').messages({
    'number.base': '{{#label}} must be a number',
  }),
  purchaseAccountName: Joi.string().trim().allow('', null).optional().label('Purchase Account'),
});

const bulkItemsArraySchema = Joi.array()
  .items(
    Joi.object({
      description: Joi.string().trim().allow('', null).optional(),
      itemName: Joi.string().trim().allow('', null).optional(),
      itemType: Joi.string().valid('RM', 'FG', 'SEMI_RM', 'CONSUMABLE', 'TRADE', 'SCRAP', 'SERVICE').allow(null).optional(),
      itemModelNo: Joi.string().trim().allow('', null).optional(),
      itemGroup: Joi.string().allow('', null).optional(),
      subItemGroup: Joi.string().allow('', null).optional(),
      itemStatus: Joi.boolean().default(true),
      itemCategory: Joi.object({
        isGoods: Joi.boolean().optional(),
        isService: Joi.boolean().optional(),
      }).required(),
      trackInventory: Joi.boolean().default(true),
      gst: Joi.string().required(),
      hsnCode: Joi.string().allow('', null).optional(),
      salesInformation: bulkSalesInformationSchema.allow(null).optional(),
      purchaseInformation: bulkPurchaseInformationSchema.allow(null).optional(),
      inventoryAccountName: Joi.string().trim().allow('', null).optional().label('Inventory Account'),
      itemUnit: Joi.string().required().label('Item Unit').messages({
        'string.base': '{{#label}} must be a string',
        'any.only': '{{#label}} must be one of the following values: ',
        'any.required': '{{#label}} is required',
      }),
    }),
  )
  .min(1) // Ensure at least one item is provided
  .required();

const createBulkItems = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    increment: Joi.number().integer().required().label('Bulk Item Count').messages({
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object({
    items: bulkItemsArraySchema,
  }),
};

const verifyBulkItemCreation = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    increment: Joi.number().integer().required().label('Bulk Item Count').messages({
      'number.base': '{{#label}} must be a number',
      'number.integer': '{{#label}} must be an integer',
      'any.required': '{{#label}} is required',
    }),
  }),
  body: Joi.object({
    items: bulkItemsArraySchema,
  }),
};

const getProductionData = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    itemId: Joi.string().custom(objectId),
  }),
};

const bomBasedDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    itemStatus: Joi.boolean(),
  }),
};

const fgBomBasedDropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    itemStatus: Joi.boolean(),
  }),
};

const itemHistory = {
  query: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
    companyId: Joi.string().custom(objectId).required(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    warehouseId: Joi.string().custom(objectId).optional(),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    search: Joi.string(),
    ...commonSchemas.paginationQuery(),
    itemStatus: Joi.boolean(),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
  }),
};

const itemLedger = {
  query: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
    companyId: Joi.string().custom(objectId).required(),
    startDate: Joi.date(),
    endDate: Joi.date(),
    warehouseId: Joi.string().optional(),
    branchId: Joi.string().optional(),
    divisionId: Joi.string().optional(),
    isSplit: Joi.boolean().optional().allow(null),
    splitOnly: Joi.boolean().optional().allow(null),
    ...commonSchemas.paginationQuery(),
  }),
};

const ITEM_TRANSACTION_TYPES = [
  'Quote',
  'SalesOrder',
  'Invoice',
  'DeliveryChallan',
  'CreditNote',
  'PurchaseOrder',
  'GrpoOrder',
  'Bill',
  'DebitNote',
];

const itemTransactions = {
  params: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
  }),
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    type: Joi.string()
      .valid(...ITEM_TRANSACTION_TYPES)
      .required(),
    status: Joi.string().optional().allow('', null),
    // Party filter: customerId for sales docs, vendorId for purchase docs (vendors are Customer records).
    customerId: Joi.string().custom(objectId).optional(),
    vendorId: Joi.string().custom(objectId).optional(),
    page: Joi.number().integer().min(1),
    limit: Joi.number().integer().min(1),
  }),
};

const dropdown = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    warehouseId: Joi.string().custom(objectId),
    customerId: Joi.string().custom(objectId),
    priceListId: Joi.string().custom(objectId),
    search: Joi.string(),
    isService: Joi.boolean().optional(),
    // Which role the item must be able to play on the calling screen.
    trackInventory: Joi.boolean().optional(),
    isSellable: Joi.boolean().optional(),
    isPurchasable: Joi.boolean().optional(),
    itemGroup: Joi.string(),
    itemType: Joi.string(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
    pagination: Joi.boolean(),
    itemStatus: Joi.boolean(),
    includeZeroInventory: Joi.boolean().optional(),
    includeInactive: Joi.boolean().optional(),
  }),
};

const getAvailableStock = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId).label('Company ID'),
    itemId: Joi.string().required().label('Item ID').messages({
      'string.base': '{{#label}} must be a string (can be comma-separated for multiple items)',
      'any.required': '{{#label}} is required',
    }),
    warehouseId: Joi.string().required().custom(objectId).label('Warehouse ID'),
  }),
};

const updateStatus = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
    isActive: Joi.boolean().required(),
  }),
  params: Joi.object().keys({
    itemId: Joi.string().custom(objectId).required(),
  }),
};

const getUsedIn = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    itemId: Joi.string().custom(objectId).required(),
  }),
};

const getPendingPurchaseOrderQty = {
  query: Joi.object().keys({
    companyId: Joi.string().custom(objectId).required(),
    itemId: Joi.string().custom(objectId).required(),
  }),
};

const itemInventoryWarehouseSchema = Joi.object({
  warehouseId: Joi.string().custom(objectId).allow(null, '').optional().label('Warehouse ID').messages({
    'string.base': '{{#label}} must be a valid ObjectId',
  }),
  warehouseName: Joi.string().trim().allow(null, '').optional().label('Warehouse Name').messages({
    'string.base': '{{#label}} must be a string',
  }),
  stock: Joi.number().allow(null, '').optional().label('Stock').messages({
    'number.base': '{{#label}} must be a number',
  }),
  value: Joi.number().allow(null, '').optional().label('Value').messages({
    'number.base': '{{#label}} must be a number',
  }),
}).unknown(true);

const itemInventorySchema = Joi.object({
  itemId: Joi.string().custom(objectId).allow(null, '').optional().label('Item ID').messages({
    'string.base': '{{#label}} must be a valid ObjectId',
  }),
  itemNo: Joi.string().trim().allow(null, '').optional().label('Item No').messages({
    'string.base': '{{#label}} must be a string',
  }),
  warehouses: Joi.array().items(itemInventoryWarehouseSchema).allow(null).optional().label('Warehouses').messages({
    'array.base': '{{#label}} must be an array of warehouse objects',
  }),
}).unknown(true);

const itemInventoryBodySchema = Joi.object().keys({
  itemInventory: Joi.array().items(itemInventorySchema).min(1).required().label('Item Inventory').messages({
    'array.base': '{{#label}} must be an array of item inventory objects',
    'array.min': '{{#label}} must contain at least one item',
    'any.required': '{{#label}} is required',
  }),
});

const createBulkItemInventory = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: itemInventoryBodySchema,
};

const verifyBulkItemInventory = {
  query: Joi.object().keys({
    companyId: Joi.string().required().custom(objectId),
  }),
  body: itemInventoryBodySchema,
};

module.exports = {
  bomBasedDropdown,
  fgBomBasedDropdown,
  createItem,
  getItems,
  getItemsDropdown,
  getItem,
  getItemsExports,
  getItemInventoryStatus,
  getItemInventoryDetails,
  getItemInventoryBatches,
  getItemInventoryBatchById,
  updateItem,
  deleteItem,
  addItemStock,
  createBulkItems,
  verifyBulkItemCreation,
  getProductionData,
  itemHistory,
  itemLedger,
  itemTransactions,
  dropdown,
  getAvailableStock,
  updateStatus,
  getUsedIn,
  createProductionDataSchema,
  getPendingPurchaseOrderQty,
  createBulkItemInventory,
  verifyBulkItemInventory,
};
