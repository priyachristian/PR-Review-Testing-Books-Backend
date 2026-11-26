const httpStatus = require('http-status');
const { getCommonModels, getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { MODULE_NAMES, NIC_DOC_NUMBER_MAX_LENGTH } = require('../../../utils/enum');

/**
 * Create a module settings
 * @param {Object} moduleSettingsBody
 * @returns {Promise<ModuleSettings>}
 */
const createModuleSettings = async moduleSettingsBody => {
  const { Company } = getCommonModels();
  const { ModuleSettings } = getBooksCrmModels();
  const { companyId, moduleName } = moduleSettingsBody;

  // Check if company exists
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, `Company ${companyId} not found`);
  }

  const existingModuleSettings = await ModuleSettings.findOne({
    companyId,
    moduleName,
  });

  if (existingModuleSettings) {
    throw new ApiError(httpStatus.CONFLICT, 'Module settings already exist for this company and module');
  }

  // Create module settings
  return ModuleSettings.create(moduleSettingsBody);
};

/**
 * Query for module settings
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @returns {Promise<QueryResult>}
 */
const queryModuleSettings = async (filter, options) => {
  const { ModuleSettings } = getBooksCrmModels();
  const { Company } = getCommonModels();

  // Get the settings without population
  const settings = await ModuleSettings.find(filter).sort({ createdAt: -1 });

  // Get all unique company IDs from the results
  const companyIds = [...new Set(settings.map(setting => setting.companyId))];

  // Fetch all companies in one query
  const companies = await Company.find({
    _id: { $in: companyIds },
  })
    .select('name')
    .lean();

  // Create a map for quick lookups
  const companyMap = companies.reduce((acc, company) => {
    acc[company._id.toString()] = company;
    return acc;
  }, {});

  // Populate the results with company data
  const populatedResults = settings.map(setting => {
    const settingObj = setting.toObject();
    settingObj.companyId = companyMap[setting.companyId?.toString()] || null;
    settingObj.id = settingObj._id;
    return settingObj;
  });

  return populatedResults;
};

/**
 * Get module settings by company and module
 * @param {ObjectId} companyId
 * @param {string} moduleName
 * @returns {Promise<ModuleSettings>}
 */
const getModuleSettings = async (companyId, moduleName, customerId, userId) => {
  const { Company, CompanySettings, UserCompanySetting } = getCommonModels();
  const { ModuleSettings, Customer } = getBooksCrmModels();

  const userCompanySetting = await UserCompanySetting.findOne({ userId, companyId }).select('defaultConfiguration');

  const settings = await ModuleSettings.findOne({
    companyId,
    moduleName,
  }).lean();
  // .populate('companyId', 'name')
  // .lean();

  if (!settings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Module settings not found');
  }

  // Fetch company to get additionalChargesConfig
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, `Company ${companyId} not found`);
  }

  // Get CompanySettings if it exists
  const companySettings = await CompanySettings.findOne({ companyId });

  // First try to get additionalChargesConfig from CompanySettings
  let additionalChargesConfig = [];
  let discountConfig = {};
  discountConfig = companySettings?.discountConfig || {};
  if (companySettings && companySettings.additionalChargesConfig) {
    additionalChargesConfig = companySettings.additionalChargesConfig
      .filter(charge => charge.modules.includes(moduleName) && charge.isActive)
      .map(charge => ({
        name: charge.name,
        isTaxable: charge.isTaxable,
        isActive: charge.isActive,
        taxRate: charge.taxRate,
        modules: charge.modules,
      }));
  }
  // Fallback to company.additionalChargesConfig if needed
  else if (company.additionalChargesConfig) {
    additionalChargesConfig = company.additionalChargesConfig
      .filter(charge => charge.modules.includes(moduleName) && charge.isActive)
      .map(charge => ({
        name: charge.name,
        isTaxable: charge.isTaxable,
        isActive: charge.isActive,
        taxRate: charge.taxRate,
        modules: charge.modules,
      }));
  }

  settings.additionalChargesConfig = additionalChargesConfig;

  let customer = {};
  if (customerId) {
    const customerData = await Customer.findById(customerId).select('customerDisplayName');
    customer.customerDisplayName = customerData.customerDisplayName;
  }

  return {
    ...settings,
    additionalChargesConfig,
    discountConfig,
    defaultConfiguration: userCompanySetting?.defaultConfiguration || {},
    customer,
  };
};

/**
 * Update module settings
 * @param {ObjectId} companyId
 * @param {string} moduleName
 * @param {Object} updateBody
 * @returns {Promise<ModuleSettings>}
 */
const updateModuleSettings = async (companyId, moduleName, updateBody, userId) => {
  const { Company, CompanySettings, UserCompanySetting } = getCommonModels();
  const { ModuleSettings } = getBooksCrmModels();
  const settings = await ModuleSettings.findOne({ companyId, moduleName });
  if (!settings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Module settings not found');
  }

  const moduleConfig = {
    [MODULE_NAMES.REJECTION_ORDER]: {
      model: getBooksModels().RejectionOrder,
      idField: 'rejectionOrderId',
    },
    [MODULE_NAMES.ITEM]: {
      model: getBooksCrmModels().Item,
      idField: 'itemNo',
    },
    [MODULE_NAMES.QUOTATION]: {
      model: getBooksCrmModels().Quote,
      idField: 'quoteId',
    },
    [MODULE_NAMES.SALES_ORDER]: {
      model: getBooksCrmModels().SalesOrder,
      idField: 'orderId',
    },
    [MODULE_NAMES.DELIVERY_CHALLAN]: {
      model: getBooksModels().DeliveryChallan,
      idField: 'challanId',
    },
    [MODULE_NAMES.INVOICE]: {
      model: getBooksModels().Invoice,
      idField: 'invoiceId',
    },
    [MODULE_NAMES.PAYMENT_RECEIVED]: {
      model: getBooksCrmModels().PaymentReceived,
      idField: 'paymentReceivedId',
    },
    [MODULE_NAMES.RECURRING_INVOICE]: {
      model: getBooksModels().RecurringInvoice,
      idField: 'recurringInvoiceId',
    },
    [MODULE_NAMES.CREDIT_NOTE]: {
      model: getBooksModels().CreditNote,
      idField: 'creditNoteId',
    },
    [MODULE_NAMES.PURCHASE_ORDER]: {
      model: getBooksModels().PurchaseOrder,
      idField: 'purchaseOrderId',
    },
    [MODULE_NAMES.GRPO]: {
      model: getBooksModels().GrpoOrder,
      idField: 'grpoOrderId',
    },
    [MODULE_NAMES.BILL]: {
      model: getBooksModels().Bill,
      idField: 'billId',
    },
    [MODULE_NAMES.PAYMENT_MADE]: {
      model: getBooksModels().PaymentMade,
      idField: 'paymentMadeId',
    },
    [MODULE_NAMES.RECURRING_BILL]: {
      model: getBooksModels().RecurringBills,
      idField: 'recurringBillId',
    },
    [MODULE_NAMES.DEBIT_NOTE]: {
      model: getBooksModels().DebitNote,
      idField: 'debitNoteId',
    },
    [MODULE_NAMES.EXPENSE]: {
      model: getBooksModels().Expenses,
      idField: 'expenseId',
    },
    [MODULE_NAMES.RECURRING_EXPENSE]: {
      model: getBooksModels().RecurringExpense,
      idField: 'recurringExpenseId',
    },
    [MODULE_NAMES.ACCOUNT_PARTNER]: {
      model: getBooksModels().AccountLedger,
      idField: 'businessAccountLedgerMasterId',
    },
    [MODULE_NAMES.MANUAL_JOURNAL]: {
      model: getBooksModels().ManualJournal,
      idField: 'manualJournalId',
    },
    [MODULE_NAMES.INVENTORY_ADJUSTMENT]: {
      model: getBooksModels().InventoryAdjustment,
      idField: 'inventoryAdjustmentNumber',
    },
    [MODULE_NAMES.VENDOR]: {
      model: getBooksCrmModels().Customer,
      idField: 'customerNumber',
    },
    [MODULE_NAMES.CUSTOMER]: {
      model: getBooksCrmModels().Customer,
      idField: 'customerNumber',
    },
    [MODULE_NAMES.QUALITY_MASTER]: {
      model: getBooksModels().QualityMaster,
      idField: 'qcReportID',
    },
    [MODULE_NAMES.PROCESS]: {
      model: getBooksModels().Process,
      idField: 'processId',
    },
    [MODULE_NAMES.RECIPE]: {
      model: getBooksModels().Recipe,
      idField: 'recipeId',
    },
    [MODULE_NAMES.PRICE_LIST]: {
      model: getBooksCrmModels().PriceList,
      idField: 'priceListCode',
    },
    [MODULE_NAMES.MANPOWER]: {
      model: getBooksModels().ManPower,
      idField: 'workerNo',
    },
    [MODULE_NAMES.PRODUCTION_ORDER]: {
      model: getBooksModels().ProductionOrder,
      idField: 'productionOrderCode',
    },
    [MODULE_NAMES.ITEMGROUP]: {
      model: getBooksModels().ItemGroup,
      idField: 'itemGroupId',
    },
    [MODULE_NAMES.MACHINE]: {
      model: getBooksModels().Machine,
      idField: 'machineCode',
    },
    [MODULE_NAMES.SPARE_PART]: {
      model: getBooksModels().SparePart,
      idField: 'code',
    },
    [MODULE_NAMES.MAINTENANCE_REQUEST]: {
      model: getBooksModels().MaintenanceRequest,
      idField: 'mrNo',
    },
    [MODULE_NAMES.SAMPLE_CATALOG]: {
      model: getBooksModels().SampleCatalog,
      idField: 'catalogCode',
    },
  };

  // Only check for existing IDs if using custom prefix
  if (updateBody.nextSequence && updateBody.useCustomPrefix) {
    const config = moduleConfig[moduleName];

    if (!config) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Module ${moduleName} is not configured for sequence validation`);
    }

    const potentialId = `${updateBody.prefix}${updateBody.nextSequence}`;
    const query = {
      companyId,
      [config.idField]: potentialId,
    };
    const existingDocument = await config.model.findOne(query);

    if (existingDocument) {
      throw new ApiError(
        httpStatus.CONFLICT,
        `${moduleName} with ID ${potentialId} already exists. Please use a different sequence number.`,
      );
    }
  }

  if (moduleName === MODULE_NAMES.INVOICE) {
    const effectivePrefix = updateBody.prefix ?? settings.prefix ?? '';
    const effectiveSequence = updateBody.nextSequence ?? settings.nextSequence ?? settings.startingSequence ?? '';
    const generatedLength = `${effectivePrefix}${effectiveSequence}`.length;
    if (generatedLength > NIC_DOC_NUMBER_MAX_LENGTH) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Prefix and number together generate a ${generatedLength}-character invoice number, but the GST portal accepts a maximum of ${NIC_DOC_NUMBER_MAX_LENGTH}. Please shorten the prefix or the number.`,
      );
    }
  }

  Object.assign(settings, updateBody);
  await settings.save();

  //add response same as view
  const userCompanySetting = await UserCompanySetting.findOne({ userId, companyId }).select('defaultConfiguration');

  // Fetch company to get additionalChargesConfig
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, `Company ${companyId} not found`);
  }

  const companySettings = await CompanySettings.findOne({ companyId });
  let additionalChargesConfig = [];
  let discountConfig = {};
  discountConfig = companySettings?.discountConfig || {};
  if (companySettings && companySettings.additionalChargesConfig) {
    additionalChargesConfig = companySettings.additionalChargesConfig
      .filter(charge => charge.modules.includes(moduleName) && charge.isActive)
      .map(charge => ({
        name: charge.name,
        isTaxable: charge.isTaxable,
        isActive: charge.isActive,
        taxRate: charge.taxRate,
        modules: charge.modules,
      }));
  } else if (company.additionalChargesConfig) {
    additionalChargesConfig = company.additionalChargesConfig
      .filter(charge => charge.modules.includes(moduleName) && charge.isActive)
      .map(charge => ({
        name: charge.name,
        isTaxable: charge.isTaxable,
        isActive: charge.isActive,
        taxRate: charge.taxRate,
        modules: charge.modules,
      }));
  }

  const settingObj = settings.toObject();
  return {
    ...settingObj,
    discountConfig,
    additionalChargesConfig,
    defaultConfiguration: userCompanySetting?.defaultConfiguration || {},
  };
};

/**
 * Delete module settings
 * @param {ObjectId} companyId
 * @param {string} moduleName
 * @returns {Promise<ModuleSettings>}
 */
const deleteModuleSettings = async (companyId, moduleName) => {
  const { ModuleSettings } = getBooksCrmModels();
  const settings = await ModuleSettings.findOne({ companyId, moduleName });
  if (!settings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Module settings not found');
  }

  await settings.remove();
  return settings;
};

module.exports = {
  createModuleSettings,
  queryModuleSettings,
  getModuleSettings,
  updateModuleSettings,
  deleteModuleSettings,
};
