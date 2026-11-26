const httpStatus = require('http-status');
const mongoose = require('mongoose');
const { getCommonModels, getBooksCrmModels, getBooksModels, getAbssAdminModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { COMPANY_MESSAGES } = require('../../../utils/messages');
const { generateRandomCompanyCode } = require('../../../utils/uniqueIdGenerator');

const COMPANY_CODE_MAX_RETRIES = 5;
const {
  MODULE_NAMES,
  DELIVERY_CHALLAN_STATUS,
  INVOICE_STATUS,
  BILL_STATUSES,
  QUOTE_STATUS,
  THIRD_PARTY_API_USAGE_FEATURE_NAME,
  PAYMENT_ACCOUNT_CATEGORIES,
  GST_USAGE_ROW_NAMES,
  ONE_DAY_MS,
  USAGE_WARNING_PERCENT,
  USAGE_STATUS,
  USAGE_HIGHLIGHT_FEATURES,
  PLAN_FEATURE_SECTIONS,
  PLAN_FEATURE_META,
  HARD_HIDDEN_PLAN_FEATURES,
  DEFAULT_PLAN_FEATURE_SECTION,
} = require('../../../utils/enum');
const { APP_NAME, PLAN_FEATURES, SUBSCRIPTION_STATUS, PLAN_DURATION } = require('@smit9313/abss-models-core/src/utils/enum');
const { FEATURE_MODEL_MAP } = require('../../../utils/featureModelMap');
const { getSiblingFeatureLimit, getSiblingFeatureLimitForDisplay } = require('../../../services/checkSubscription.service');
const {
  countGeneratedGstDocuments,
  countGstPlanFeatureUsage,
  isGstPlanFeature,
} = require('../../../services/gstDocumentUsage.service');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { getSummaryStatus } = require('../../whatsApp');
const { getTimeZoneLabelFromAddress } = require('@smit9313/abss-models-core');
const { encryptBlobRaw, looksEncrypted } = require('../../../utils/cryptography');
const { sendEmailViaSmtp } = require('../../../utils/email');

/**
 * Update Company by id
 * @param {ObjectId} companyId
 * @param {Object} updateBody
 * @returns {Promise<Company>}
 */
const updateCompanyById = async (companyId, updateBody, userId, companyLogo, authorizedSignature) => {
  const { Company } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (companyLogo && companyLogo.length > 0) {
    const uploadedCompanyLogoUrls = await handleFileUpdate({
      newFiles: companyLogo,
      currentUrls: updateBody.companyLogo ? [updateBody.companyLogo] : [],
      existingUrls: company.companyLogo ? [company.companyLogo] : [],
      userId,
      companyId: companyId,
      skipS3Deletion: true,
    });
    updateBody.companyLogo = uploadedCompanyLogoUrls.length > 0 ? uploadedCompanyLogoUrls[0] : null;
  }

  if (authorizedSignature && authorizedSignature.length > 0) {
    const uploadedAuthorizedSignatureUrls = await handleFileUpdate({
      newFiles: authorizedSignature,
      currentUrls: updateBody.authorizedSignature ? [updateBody.authorizedSignature] : [],
      existingUrls: company.authorizedSignature ? [company.authorizedSignature] : [],
      userId,
      companyId: companyId,
      skipS3Deletion: true,
    });
    updateBody.authorizedSignature = uploadedAuthorizedSignatureUrls.length > 0 ? uploadedAuthorizedSignatureUrls[0] : null;
  }

  if (updateBody.address) {
    updateBody.timeZone = getTimeZoneLabelFromAddress({
      ...company.address,
      ...updateBody.address,
    });
  }

  const updatedData = {
    ...updateBody,
    $push: {
      updatedBy: {
        userId: userId,
        updatedAt: new Date(),
      },
    },
  };

  return Company.findByIdAndUpdate(companyId, updatedData, { new: true }).populate('baseCurrency');
};

/**
 * Get company by id
 * @param {ObjectId} id
 * @returns {Promise<Company>}
 */
const getCompanyByCompanyId = async id => {
  const { Company } = getCommonModels();
  const company = await Company.findById(id).populate('baseCurrency');
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return company;
};

/**
 * Get the current company's customer-facing company code, if any.
 * @param {ObjectId} companyId
 * @returns {Promise<string|null>}
 */
const getCompanyCode = async companyId => {
  const { Company } = getCommonModels();
  const company = await Company.findById(companyId).select('code').lean();
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return company.code || null;
};

/**
 * Generate the company's one-time customer-facing code. A company gets exactly one code: once set
 * it is never regenerated, so links customers already made with it keep working.
 * The update only matches a company without a code, so concurrent calls cannot overwrite it.
 * @param {ObjectId} companyId
 * @param {ObjectId} userId
 * @returns {Promise<string>}
 */
const generateCompanyCode = async (companyId, userId) => {
  const { Company } = getCommonModels();

  for (let attempt = 0; attempt < COMPANY_CODE_MAX_RETRIES; attempt++) {
    const code = generateRandomCompanyCode();
    try {
      // { code: null } matches both a missing field and an explicit null.
      const company = await Company.findOneAndUpdate(
        { _id: companyId, code: null },
        { code, $push: { updatedBy: { userId, updatedAt: new Date() } } },
        { new: true, runValidators: true },
      );
      if (!company) {
        const exists = await Company.exists({ _id: companyId });
        if (!exists) {
          throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
        }
        throw new ApiError(httpStatus.CONFLICT, COMPANY_MESSAGES.COMPANY_CODE_ALREADY_EXISTS);
      }
      return company.code;
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  throw new ApiError(httpStatus.CONFLICT, 'Could not generate a unique company code. Please try again.');
};

/**
 * Add an additional charge to company settings
 * @param {ObjectId} companyId
 * @param {Object} chargeBody
 * @param {ObjectId} userId
 * @returns {Promise<CompanySettings>}
 */
const addAdditionalCharge = async (companyId, chargeBody, userId) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  // Get or create CompanySettings
  let settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      additionalChargesConfig: [],
    });
  }

  // Check for duplicate charge name
  const existingCharge = settings.additionalChargesConfig.find(
    charge => charge.name.toLowerCase() === chargeBody.name.toLowerCase(),
  );
  if (existingCharge) {
    throw new ApiError(httpStatus.CONFLICT, `Additional charge with name ${chargeBody.name} already exists`);
  }

  // Add the charge
  settings.additionalChargesConfig.push(chargeBody);
  await settings.save();

  // Update company updatedBy field
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return settings;
};

/**
 * Update an additional charge by name
 * @param {ObjectId} companyId
 * @param {String} chargeName
 * @param {Object} updateBody
 * @param {ObjectId} userId
 * @returns {Promise<CompanySettings>}
 */
const updateAdditionalCharge = async (companyId, chargeName, updateBody, userId) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  // Get or create CompanySettings
  let settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company settings not found');
  }

  // Find the charge to update
  const chargeIndex = settings.additionalChargesConfig.findIndex(
    charge => charge.name.toLowerCase() === chargeName.toLowerCase(),
  );
  if (chargeIndex === -1) {
    throw new ApiError(httpStatus.NOT_FOUND, `Additional charge with name ${chargeName} not found`);
  }

  // Prevent changing the charge name to an existing one
  if (updateBody.name && updateBody.name.toLowerCase() !== chargeName.toLowerCase()) {
    const existingCharge = settings.additionalChargesConfig.find(
      charge => charge.name.toLowerCase() === updateBody.name.toLowerCase(),
    );
    if (existingCharge) {
      throw new ApiError(httpStatus.CONFLICT, `Additional charge with name ${updateBody.name} already exists`);
    }
  }

  // Update the charge
  settings.additionalChargesConfig[chargeIndex] = {
    ...settings.additionalChargesConfig[chargeIndex].toObject(),
    ...updateBody,
  };
  await settings.save();

  // Update company updatedBy field
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return settings;
};

/**
 * Delete an additional charge by name
 * @param {ObjectId} companyId
 * @param {String} chargeName
 * @param {ObjectId} userId
 * @returns {Promise<CompanySettings>}
 */
const deleteAdditionalCharge = async (companyId, chargeName, userId) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  // Get CompanySettings
  const settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company settings not found');
  }

  // Find the charge to delete
  const chargeIndex = settings.additionalChargesConfig.findIndex(
    charge => charge.name.toLowerCase() === chargeName.toLowerCase(),
  );
  if (chargeIndex === -1) {
    throw new ApiError(httpStatus.NOT_FOUND, `Additional charge with name ${chargeName} not found`);
  }

  // Delete the charge
  settings.additionalChargesConfig.splice(chargeIndex, 1);
  await settings.save();

  // Update company updatedBy field
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return settings;
};

/**
 * Update inventory configuration
 * @param {ObjectId} companyId
 * @param {Object} configBody
 * @param {ObjectId} userId
 * @returns {Promise<CompanySettings>}
 */
const updateInventoryConfig = async (companyId, configBody, userId) => {
  const { Company, CompanySettings } = getCommonModels();
  const { GrpoOrder, Bill, DeliveryChallan, Invoice } = getBooksModels();

  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  // Get or create CompanySettings
  let settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      inventoryConfig: configBody,
    });
  } else {
    // Only check if salesFlowStockDeductSource or purchaseFlowStockAddSource changed (salesFlowStockCheckSource is excluded)
    const isSame =
      settings.inventoryConfig?.salesFlowStockDeductSource === configBody.salesFlowStockDeductSource &&
      settings.inventoryConfig?.purchaseFlowStockAddSource === configBody.purchaseFlowStockAddSource;

    if (!isSame) {
      if (configBody.salesFlowStockDeductSource == MODULE_NAMES.DELIVERY_CHALLAN) {
        const deliveryChallan = await DeliveryChallan.find({ companyId, status: DELIVERY_CHALLAN_STATUS.DRAFT });

        if (deliveryChallan.length > 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'DeliveryChallan exists in editable mode with current configuration, so you cannot change the configuration.',
          );
        }
      }
      if (configBody.salesFlowStockDeductSource == MODULE_NAMES.INVOICE) {
        const invoice = await Invoice.find({ companyId, status: INVOICE_STATUS.DRAFT });

        if (invoice.length > 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'Invoice exists in editable mode with current configuration, so you cannot change the configuration.',
          );
        }
      }
      if (configBody.purchaseFlowStockAddSource == MODULE_NAMES.GRPO) {
        const grpoOrder = await GrpoOrder.find({ companyId, status: INVOICE_STATUS.DRAFT });

        if (grpoOrder.length > 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'GrpoOrder exists in editable mode with current configuration, so you cannot change the configuration.',
          );
        }
      }
      if (configBody.purchaseFlowStockAddSource == MODULE_NAMES.BILL) {
        const bill = await Bill.find({
          companyId,
          status: { $in: [BILL_STATUSES.DRAFT] },
        });

        if (bill.length > 0) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'Bill exists in editable mode with current configuration, so you cannot change the configuration.',
          );
        }
      }
    }
    settings.inventoryConfig = configBody;
    await settings.save();
  }

  // Update company updatedBy field
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return settings;
};

/**
 * Get or create CompanySettings for a company
 * @param {ObjectId} companyId
 * @returns {Promise<CompanySettings>}
 */
const getOrCreateCompanySettings = async (companyId, userId) => {
  const { Company, CompanySettings, UserCompanySetting } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  const userCompanySetting = await UserCompanySetting.findOne({ userId, companyId }).select('defaultConfiguration');

  let settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      additionalChargesConfig: [],
      inventoryConfig: {
        salesFlowStockCheckSource: [MODULE_NAMES.QUOTATION, MODULE_NAMES.SALES_ORDER],
        salesFlowStockDeductSource: MODULE_NAMES.DELIVERY_CHALLAN,
        purchaseFlowStockAddSource: MODULE_NAMES.GRPO,
      },
      quotationConfig: {
        terms: [],
        quoteCloseReasons: [],
        pdfTemplate: 1,
      },
      branchConfig: {
        splitConfig: false,
      },
      discountConfig: {
        isEnabled: false,
      },
      autoPayConfig: {
        invoice: {
          isEnabled: false,
          scope: 'ALL_BRANCHES',
        },
        bill: {
          isEnabled: false,
          scope: 'ALL_BRANCHES',
        },
      },
    });
  }
  const settingObj = settings.toObject();
  settingObj.defaultConfiguration = userCompanySetting?.defaultConfiguration || {};
  settingObj.pinNo = company?.pinNo || '';

  return settingObj;
};

/**
 * Update quotation configuration
 * @param {ObjectId} companyId
 * @param {Object} configBody
 * @param {ObjectId} userId
 * @returns {Promise<CompanySettings>}
 */
const updateQuotationConfig = async (companyId, configBody, userId) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  // Get or create settings
  let settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      additionalChargesConfig: [],
      inventoryConfig: {
        salesFlowStockCheckSource: [MODULE_NAMES.QUOTATION, MODULE_NAMES.SALES_ORDER],
        salesFlowStockDeductSource: MODULE_NAMES.DELIVERY_CHALLAN,
        purchaseFlowStockAddSource: MODULE_NAMES.GRPO,
      },
      quotationConfig: configBody,
    });
  } else {
    // Update quotation config
    settings.quotationConfig = {
      ...settings.quotationConfig,
      ...configBody,
    };
    await settings.save();
  }

  // Update company updatedBy field
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return settings;
};

const updateBranchConfig = async (companyId, body, userId) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  // Get or create CompanySettings
  let settings = await CompanySettings.findOne({ companyId });

  // Ensure splitConfig has a default value of false if not provided
  const branchConfigData = {
    ...body,
    splitConfig: body.splitConfig !== undefined ? body.splitConfig : false,
  };

  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      branchConfig: branchConfigData,
    });
  } else {
    settings.branchConfig = branchConfigData;
    await settings.save();
  }

  // Update company updatedBy field
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return settings;
};

const setPinNo = async (companyId, pinNo) => {
  const { Company } = getCommonModels();

  const company = await Company.findById(companyId);

  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  company.pinNo = pinNo;
  await company.save();
};

const verifyPinNo = async (pinNo, companyId) => {
  const { Company } = getCommonModels();

  const company = await Company.findById(companyId);

  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (company.pinNo == pinNo) {
    await company.save();
    return true;
  } else {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Please enter a valid PIN.');
  }
  return false;
};

const discountConfig = async (companyId, body, userId) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  // Get or create discountSetting
  let settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      discountConfig: body,
    });
  } else {
    settings.discountConfig = body;
    await settings.save();
  }

  // Update company updatedBy field
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return settings;
};

const addAdditionalAddress = async (companyId, body, userId) => {
  const { Company } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  company.additionalShippingAddresses = company.additionalShippingAddresses || [];
  company.additionalShippingAddresses.push(body);

  // Update company updatedBy field
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return company;
};

const updateAdditionalAddress = async (addressId, companyId, body, userId) => {
  const { Company } = getCommonModels();
  const company = await Company.findOne({
    _id: companyId,
    $or: [{ 'additionalShippingAddresses._id': addressId }, { 'address._id': addressId }],
  });
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }
  if (company.address._id.toString() === addressId) {
    company.address.set(body);
  } else {
    company.additionalShippingAddresses.id(addressId).set(body);
  }
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return company.additionalShippingAddresses;
};

const updateCompanyAddressStatus = async (addressId, companyId, userId) => {
  const { Company } = getCommonModels();

  const company = await Company.findOne({
    $or: [{ 'additionalShippingAddresses._id': addressId }, { 'address._id': addressId }],
    _id: companyId,
  });

  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  const address = company.additionalShippingAddresses.id(addressId);
  address.isActive = !address.isActive;
  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();
  return address;
};

const getCompanyShippingAddresses = async companyId => {
  const { Company } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No company found');
  }

  let addresses = company.additionalShippingAddresses.map(address => ({ ...address.toObject(), isDefault: false }));
  addresses.filter(address => address.isActive);
  if (Object.keys(company?.address || {}).length) {
    addresses.unshift({ ...company.address.toObject(), isDefault: true } || {});
  }
  return addresses;
};

const getPeriodEnd = (periodStart, interval) => {
  const periodEnd = new Date(periodStart);
  if (interval === PLAN_DURATION.MONTHLY) periodEnd.setMonth(periodEnd.getMonth() + 1);
  else if (interval === PLAN_DURATION.YEARLY) periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  return periodEnd;
};

const getFeatureLabel = (featureName, planLimit) =>
  planLimit?.label ||
  PLAN_FEATURE_META[featureName]?.label ||
  featureName
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

const getUsageStatus = (used, limit, isUnlimited) => {
  if (isUnlimited) return USAGE_STATUS.UNLIMITED;
  if (used >= limit) return USAGE_STATUS.EXCEEDED;
  return (used / limit) * 100 >= USAGE_WARNING_PERCENT ? USAGE_STATUS.WARNING : USAGE_STATUS.OK;
};

const buildPlanSummary = (subscription, plan) => {
  const price = plan.prices?.find(p => p._id.toString() === subscription.priceId?.toString());
  const autoRenew = Boolean(subscription.isRecurring);
  const currentEnd = subscription.currentEnd ? new Date(subscription.currentEnd) : null;

  return {
    name: plan.name || null,
    isFree: plan.isFree ?? false,
    trialPeriodDays: plan.trialPeriodDays ?? 0,
    status: subscription.status || null,
    billingInterval: price?.billingInterval || null,
    price: price?.price ?? null,
    currency: price?.currency || null,
    startAt: subscription.startAt || null,
    currentStart: subscription.currentStart || null,
    currentEnd,
    autoRenew,
    nextRenewalDate: autoRenew ? currentEnd : null,
    daysRemaining: currentEnd ? Math.max(Math.ceil((currentEnd.getTime() - Date.now()) / ONE_DAY_MS), 0) : null,
    subscriptionId: subscription._id,
    autopayStatus: subscription.autopayStatus || null,
  };
};

const buildUsageRow = (row, planLimit, periodStart) => {
  const limit = row.isUnlimited ? null : row.totalLimit;

  return {
    key: row.featureName,
    label: getFeatureLabel(row.featureName, planLimit),
    description: planLimit?.limitDescription || planLimit?.description || null,
    used: row.used,
    limit,
    planLimit: row.planLimit,
    addonBoost: row.addonBoost,
    isUnlimited: row.isUnlimited,
    percentUsed: limit ? Math.round((row.used / limit) * 10000) / 100 : null,
    status: getUsageStatus(row.used, limit, row.isUnlimited),
    interval: row.interval || null,
    resetsOn: row.interval ? getPeriodEnd(periodStart, row.interval) : null,
    isShared: Boolean(row.isSharedFeature),
    sharedBreakdown: row.sharedBreakdown || null,
  };
};

// Unavailable features stay in the list (enabled: false) so the UI can show them as locked
const buildFeatureGroups = (limits, resultByFeature, hasEInvoiceAndEWayBill) => {
  const sectionOrder = Object.keys(PLAN_FEATURE_SECTIONS);
  const groups = new Map();

  limits.forEach(planLimit => {
    const { featureName, limit, isUnlimited, isVisible } = planLimit;
    if (!isVisible) return;
    if (featureName === PLAN_FEATURES.ONLY_E_WAY_BILL && hasEInvoiceAndEWayBill) return;

    // Shared features can be granted by the CRM plan, so prefer the computed usage limit
    const result = resultByFeature.get(featureName);
    const enabled = result ? result.isUnlimited || result.totalLimit > 0 : isUnlimited || limit > 0;
    if (!enabled && HARD_HIDDEN_PLAN_FEATURES.includes(featureName)) return;

    const section = planLimit.section || PLAN_FEATURE_META[featureName]?.section || DEFAULT_PLAN_FEATURE_SECTION;
    if (!groups.has(section)) {
      groups.set(section, { section, label: PLAN_FEATURE_SECTIONS[section] || section, items: [] });
    }
    groups.get(section).items.push({
      key: featureName,
      label: getFeatureLabel(featureName, planLimit),
      description: planLimit.description || null,
      enabled,
    });
  });

  const rank = section => (sectionOrder.includes(section) ? sectionOrder.indexOf(section) : sectionOrder.length);
  return [...groups.values()].sort((a, b) => rank(a.section) - rank(b.section));
};

const viewSubscription = async companyId => {
  const { CompanySubscription, BillingCycle } = getCommonModels();
  const { Plan, AddOns } = getAbssAdminModels();

  const featureModelMap = FEATURE_MODEL_MAP;

  const allplan = await Plan.find({ appName: APP_NAME.BOOKS }).select('_id').lean();
  const planIds = allplan.map(sub => sub._id);
  let subscription = await CompanySubscription.findOne({
    companyId,
    planId: { $in: planIds },
    appName: 'BOOKS',
    isActive: true,
  })
    .sort({ createdAt: -1 })
    .lean();

  if (!subscription) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No subscription details found for the company');
  }

  const currentBillingCycle = await BillingCycle.findById(subscription.currentBillingCycleId).lean();

  subscription.addons = currentBillingCycle?.addons || [];

  const addonsIds = subscription.addons?.map(a => a.addonId);
  const addons = await AddOns.find({
    _id: { $in: addonsIds },
  }).lean();

  const addonsMap = new Map();
  addons.forEach(addon => {
    addonsMap.set(addon._id.toString(), addon);
  });

  const plan = await Plan.findById(subscription?.planId).lean();
  const periodStart = new Date(subscription.currentStart);
  const periodFilter = interval => {
    if (!interval) return {};
    return { createdAt: { $gte: periodStart, $lt: getPeriodEnd(periodStart, interval) } };
  };

  const hasEInvoiceAndEWayBill = plan.limits.some(
    f => f.featureName === PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL && (f.isUnlimited || (f.limit > 0 && f.isFixed)) && f.isVisible,
  );

  subscription.addons = subscription.addons.map(addon => {
    const addonWithName = addonsMap.get(addon.addonId.toString());
    return {
      ...addon,
      name: addonWithName ? addonWithName.featureName : null,
    };
  });

  // Each feature returns { rows, gstHeroLimits }; features are counted in parallel
  const buildFeatureUsage = async feature => {
    const { featureName, limit: planLimit, isUnlimited, interval, isVisible } = feature;
    if (!isVisible) return null;
    if (featureName === PLAN_FEATURES.ONLY_E_WAY_BILL && hasEInvoiceAndEWayBill) return null;
    const featureConfig = featureModelMap[featureName];
    if (!featureConfig) return null;
    const { getModels, modelName } = featureConfig;

    const models = getModels(); // execute function
    const Model = models[modelName];

    const addon = subscription.addons?.find(a => a.name === featureName);
    const addonFromDb = addonsMap.get(addon?.addonId?.toString());
    const addonBoost = addon?.quantity * (addonFromDb?.unitsIncluded || 1) || 0;

    const siblingLimit = featureConfig.isCommon
      ? await getSiblingFeatureLimit(companyId, APP_NAME.CRM, featureName, null)
      : { planLimit: 0, addonQty: 0, isUnlimited: false };
    const isFeatureUnlimited = isUnlimited || siblingLimit.isUnlimited;
    const totalLimit = isFeatureUnlimited
      ? Infinity
      : Math.max(planLimit, siblingLimit.planLimit) + addonBoost + siblingLimit.addonQty;
    let displayCombinedLimit = totalLimit;
    let siblingIsPaymentIncomplete = false;
    let siblingStatus = null;

    let siblingSubscriptionExists = siblingLimit.isUnlimited;

    let breakdownSiblingPlanLimit = siblingLimit.planLimit;
    let breakdownSiblingAddonQty = siblingLimit.addonQty;
    if (featureConfig.isCommon && !isFeatureUnlimited) {
      const displaySiblingLimit = await getSiblingFeatureLimitForDisplay(companyId, APP_NAME.CRM, featureName, null);
      siblingSubscriptionExists = displaySiblingLimit.siblingStatus !== null;
      if (displaySiblingLimit.isPaymentIncomplete && !displaySiblingLimit.isUnlimited) {
        displayCombinedLimit = Math.max(planLimit, displaySiblingLimit.planLimit) + addonBoost + displaySiblingLimit.addonQty;
        siblingIsPaymentIncomplete = true;
        siblingStatus = displaySiblingLimit.siblingStatus;
        breakdownSiblingPlanLimit = displaySiblingLimit.planLimit;
        breakdownSiblingAddonQty = displaySiblingLimit.addonQty;
      }
    }

    const gstHeroLimits =
      featureName === PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL || featureName === PLAN_FEATURES.ONLY_E_WAY_BILL
        ? { planLimit, addonBoost, totalLimit, isUnlimited, interval }
        : null;

    let extraFilter = {};

    if (featureName === PLAN_FEATURES.CUSTOMER) {
      extraFilter = { 'Role.isCustomer': true };
    }

    if (featureName === PLAN_FEATURES.VENDOR) {
      extraFilter = { 'Role.isVendor': true };
    }

    // isCommon features are pooled across BOOKS + CRM, so usage below counts every doc for
    // the company regardless of which app created it (paired with the max() limit above).

    if (featureName === PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL) {
      const baseQuery = { companyId, ...periodFilter(interval) };
      const [eInvoiceUsed, eWayBillUsed] = await Promise.all([
        countGeneratedGstDocuments({ baseQuery, kinds: ['eInvoice'] }),
        countGeneratedGstDocuments({ baseQuery, kinds: ['eWayBill'] }),
      ]);

      const rows = [
        {
          featureName: GST_USAGE_ROW_NAMES.E_INVOICE,
          planLimit,
          addonBoost,
          totalLimit,
          used: eInvoiceUsed,
          isUnlimited,
          interval,
          remaining: Math.max(totalLimit - eInvoiceUsed, 0),
        },
        {
          featureName: GST_USAGE_ROW_NAMES.E_WAY_BILL,
          planLimit,
          addonBoost,
          totalLimit,
          used: eWayBillUsed,
          isUnlimited,
          interval,
          remaining: Math.max(totalLimit - eWayBillUsed, 0),
        },
      ];

      return { rows, gstHeroLimits };
    }

    const used = isGstPlanFeature(featureName)
      ? await countGstPlanFeatureUsage({ featureKey: featureName, baseQuery: { companyId, ...periodFilter(interval) } })
      : await Model.countDocuments({
          companyId,
          ...extraFilter,
          ...periodFilter(interval),
        });

    const row = {
      featureName: featureName === PLAN_FEATURES.ONLY_E_WAY_BILL ? GST_USAGE_ROW_NAMES.E_WAY_BILL : featureName,
      planLimit,
      addonBoost: addonBoost,
      totalLimit,
      displayCombinedLimit,
      used,
      isUnlimited: isFeatureUnlimited,
      interval,
      remaining: Math.max(totalLimit - used, 0),
      isSharedFeature: Boolean(featureConfig.isCommon),
      sharedWithApp: featureConfig.isCommon ? APP_NAME.CRM : null,
      sharedBreakdown: featureConfig.isCommon
        ? {
            ownApp: APP_NAME.BOOKS,
            ownPlanLimit: planLimit,
            ownAddonQty: addonBoost,
            ownIsUnlimited: isUnlimited,
            siblingApp: APP_NAME.CRM,
            siblingPlanLimit: breakdownSiblingPlanLimit,
            siblingAddonQty: breakdownSiblingAddonQty,
            siblingIsUnlimited: siblingLimit.isUnlimited,
            siblingIsPaymentIncomplete,
            siblingStatus,
            siblingSubscriptionExists,
          }
        : null,
    };

    return { rows: [row], gstHeroLimits };
  };

  const featureUsages = (await Promise.all(plan.limits.map(buildFeatureUsage))).filter(Boolean);
  const results = featureUsages.flatMap(usage => usage.rows);
  // Last GST feature in plan order wins, same as the previous sequential loop
  const gstHeroLimits = featureUsages.reduce((last, usage) => usage.gstHeroLimits || last, null);

  if (gstHeroLimits) {
    const { UserThirdPartyApiLogs } = getBooksModels();
    const [apiUsage] = await UserThirdPartyApiLogs.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          chargeAmount: { $ne: null },
          ...periodFilter(gstHeroLimits.interval),
        },
      },
      { $group: { _id: null, used: { $sum: 1 } } },
    ]);

    const used = apiUsage?.used || 0;

    results.push({
      featureName: THIRD_PARTY_API_USAGE_FEATURE_NAME,
      planLimit: gstHeroLimits.planLimit,
      addonBoost: gstHeroLimits.addonBoost,
      totalLimit: gstHeroLimits.totalLimit,
      used,
      isUnlimited: gstHeroLimits.isUnlimited,
      interval: gstHeroLimits.interval,
      remaining: gstHeroLimits.isUnlimited ? null : Math.max(gstHeroLimits.totalLimit - used, 0),
    });
  }

  const planLimitByFeature = new Map(plan.limits.map(planLimit => [planLimit.featureName, planLimit]));
  const resultByFeature = new Map(results.map(row => [row.featureName, row]));
  const highlightOrder = new Map(USAGE_HIGHLIGHT_FEATURES.map((key, index) => [key, index]));

  // Features with a zero limit are not available, they show as locked in features instead
  const usageRows = results
    .filter(row => row.isUnlimited || row.totalLimit > 0)
    .map(row => buildUsageRow(row, planLimitByFeature.get(row.featureName), periodStart));

  return {
    plan: buildPlanSummary(subscription, plan),
    usage: {
      highlights: usageRows
        .filter(row => highlightOrder.has(row.key))
        .sort((a, b) => highlightOrder.get(a.key) - highlightOrder.get(b.key)),
      // Unlimited modules have nothing to track, they are listed under features instead
      others: usageRows.filter(row => !highlightOrder.has(row.key) && !row.isUnlimited),
    },
    features: buildFeatureGroups(plan.limits, resultByFeature, hasEInvoiceAndEWayBill),
  };
};

const activeFeatureList = async companyId => {
  const { CompanySubscription } = getCommonModels();
  const { Plan } = getAbssAdminModels();
  const allplan = await Plan.find({ appName: APP_NAME.BOOKS });
  const planIds = allplan.map(sub => sub._id);
  const subscription = await CompanySubscription.findOne({
    companyId,
    planId: { $in: planIds },
    appName: 'BOOKS',
  });

  if (!subscription) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No subscription details found for the company');
  }
  const plan = await Plan.findById(subscription?.planId);

  let features = {};

  for (let i of plan?.limits || []) {
    if (i?.limit == 0 && !i?.isUnlimited) {
      features[i.featureName] = false;
    }

    if (i?.limit > 0 || i?.isUnlimited) {
      features[i.featureName] = true;
    }
  }

  return features;
};

const getBranchConfig = async companyId => {
  const { CompanySettings } = getCommonModels();

  const settings = await CompanySettings.findOne({ companyId })
    .populate({
      path: 'companyId',
      select: 'pinNo',
    })
    .lean();

  if (!settings) {
    return null;
  }

  return { ...settings.branchConfig, pinNo: settings.companyId?.pinNo || '' };
};

const getInventoryConfig = async companyId => {
  const { CompanySettings } = getCommonModels();

  const settings = await CompanySettings.findOne({ companyId })
    .populate({
      path: 'companyId',
      select: 'pinNo',
    })
    .lean();

  if (!settings) {
    return null;
  }

  return { ...settings.inventoryConfig, pinNo: settings.companyId?.pinNo || '' };
};

const DEFAULT_AUTO_PAY_CONFIG = {
  invoice: {
    isEnabled: false,
    scope: 'ALL_BRANCHES',
  },
  bill: {
    isEnabled: false,
    scope: 'ALL_BRANCHES',
  },
};

const getAutoPayConfig = async companyId => {
  const { CompanySettings } = getCommonModels();

  const settings = await CompanySettings.findOne({ companyId }).select('autoPayConfig').lean();
  if (!settings) {
    return { ...DEFAULT_AUTO_PAY_CONFIG };
  }

  return {
    invoice: {
      isEnabled: Boolean(settings.autoPayConfig?.invoice?.isEnabled),
      scope: settings.autoPayConfig?.invoice?.scope === 'BRANCH_WISE' ? 'BRANCH_WISE' : 'ALL_BRANCHES',
    },
    bill: {
      isEnabled: Boolean(settings.autoPayConfig?.bill?.isEnabled),
      scope: settings.autoPayConfig?.bill?.scope === 'BRANCH_WISE' ? 'BRANCH_WISE' : 'ALL_BRANCHES',
    },
  };
};

const updateAutoPayConfig = async (companyId, configBody, userId) => {
  const { Company, CompanySettings } = getCommonModels();

  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  let settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      autoPayConfig: configBody,
    });
  } else {
    settings.autoPayConfig = configBody;
    settings.updatedBy = settings.updatedBy || [];
    settings.updatedBy.push({ userId, updatedAt: new Date() });
    await settings.save();
  }

  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return getAutoPayConfig(companyId);
};

const getCompanyCreditLimitConfig = async companyId => {
  const { CompanySettings } = getCommonModels();
  const settings = await CompanySettings.findOne({ companyId }).lean();
  if (!settings) {
    return null;
  }
  return {
    salesCreditLimit: settings.salesCreditLimit,
    purchaseCreditLimit: settings.purchaseCreditLimit,
  };
};

const updateCreditLimitConfig = async (companyId, body, userId) => {
  const { CompanySettings } = getCommonModels();
  const settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company settings not found');
  }
  settings.salesCreditLimit = body.salesCreditLimit;
  settings.purchaseCreditLimit = body.purchaseCreditLimit;
  settings.updatedBy = settings.updatedBy || [];
  settings.updatedBy.push({ userId, updatedAt: new Date() });
  await settings.save();
  return {
    salesCreditLimit: settings.salesCreditLimit,
    purchaseCreditLimit: settings.purchaseCreditLimit,
  };
};

const getQuotationConfigByCompanyId = async companyId => {
  const { CompanySettings } = getCommonModels();
  const companySettings = await CompanySettings.findOne({ companyId }).select('quotationConfig');
  if (!companySettings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company settings not found');
  }
  return companySettings;
};

const updateQuotationConfigByCompanyId = async (companyId, updateBody) => {
  const { CompanySettings } = getCommonModels();
  const { Quote } = getBooksCrmModels();

  const existingConfig = await CompanySettings.findOne({ companyId });

  const oldReasons = existingConfig?.quotationConfig?.quoteCloseReasons || [];

  const newReasons = updateBody.quoteCloseReasons.map(r => r.trim());

  const removedReasons = oldReasons.filter(old => !newReasons.includes(old));

  if (removedReasons.length > 0) {
    const existingUsage = await Quote.find({
      companyId,
      status: QUOTE_STATUS.REJECTED,
      rejectionReason: { $in: removedReasons },
    });

    if (existingUsage.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot remove some reasons as they are already used in quotes');
    }
  }

  const companySettings = await CompanySettings.findOneAndUpdate(
    { companyId },
    { $set: { quotationConfig: updateBody } },
    { new: true },
  );

  if (!companySettings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company settings not found');
  }

  return companySettings;
};

const updateRejectionWarehouseConfig = async (companyId, body) => {
  const { CompanySettings } = getCommonModels();

  let settings = await CompanySettings.findOne({ companyId });
  if (!settings) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company Settings not found');
  }

  const mergedConfig = {
    ...(settings.rejectionWarehouseConfig?.toObject?.() || settings.rejectionWarehouseConfig || {}),
    ...body,
  };

  const warehouseIds = [mergedConfig.reuseWarehouseId, mergedConfig.returnWarehouseId, mergedConfig.scrapWarehouseId].filter(
    id => id && id.toString(),
  );
  const uniqueIds = new Set(warehouseIds.map(id => id.toString()));
  if (uniqueIds.size !== warehouseIds.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Each rejection role (reuse, return, scrap) must be assigned a different warehouse',
    );
  }

  settings.rejectionWarehouseConfig = mergedConfig;

  await settings.save();

  return settings.rejectionWarehouseConfig;
};

const getRejectionWarehouseConfig = async companyId => {
  const { CompanySettings } = getCommonModels();
  const settings = await CompanySettings.findOne({ companyId }).lean();
  return settings?.rejectionWarehouseConfig || {};
};

const updateEmailConfig = async (companyId, body, userId) => {
  const { Company, CompanySettings } = getCommonModels();

  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  let settings = await CompanySettings.findOne({ companyId });

  let emailConfiguration;

  if (body.emailConfiguration) {
    const existing = settings?.emailConfiguration?.toObject?.() || settings?.emailConfiguration || {};
    emailConfiguration = {
      ...existing,
      ...body.emailConfiguration,
    };

    // The client never receives the stored password, so an empty/missing password on
    // update means "keep the existing one" — never overwrite it with a blank value.
    if (!body.emailConfiguration.password) {
      emailConfiguration.password = existing.password;
    } else if (!looksEncrypted(emailConfiguration.password)) {
      // Encrypt a newly provided plain-text password.
      emailConfiguration.password = JSON.stringify(encryptBlobRaw(emailConfiguration.password));
    }
  }

  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      isEmailEnabled: body.isEmailEnabled,
      emailConfiguration,
      moduleEmailConfig: [],
    });
  } else {
    settings.isEmailEnabled = body.isEmailEnabled;

    if (emailConfiguration) {
      settings.emailConfiguration = emailConfiguration;
    }

    await settings.save();
  }

  company.updatedBy.push({
    userId,
    updatedAt: new Date(),
  });

  await company.save();

  const savedConfig = settings.emailConfiguration?.toObject?.() || settings.emailConfiguration || null;

  return {
    isEmailEnabled: settings.isEmailEnabled,
    emailConfiguration: sanitizeEmailConfiguration(savedConfig),
  };
};

// Never expose the SMTP password to the client — return only whether one is set.
const sanitizeEmailConfiguration = config => {
  if (!config) {
    return null;
  }
  const { password, ...rest } = config;
  return { ...rest, hasPassword: Boolean(password) };
};

const getEmailConfig = async companyId => {
  const { CompanySettings } = getCommonModels();

  const settings = await CompanySettings.findOne({ companyId }).select('isEmailEnabled emailConfiguration').lean();

  return {
    isEmailEnabled: settings?.isEmailEnabled || false,
    emailConfiguration: sanitizeEmailConfiguration(settings?.emailConfiguration || null),
  };
};

const getModuleEmailConfig = async companyId => {
  const { CompanySettings } = getCommonModels();
  const settings = await CompanySettings.findOne({ companyId }).select('moduleEmailConfig').lean();

  const configs = (settings?.moduleEmailConfig || []).map(config => ({
    moduleName: config.moduleName,
    isEnabled: Boolean(config.isEnabled),
    isWhatsAppEnabled: Boolean(config.isWhatsAppEnabled),
  }));

  const hasDispatch = configs.some(config => config.moduleName === MODULE_NAMES.DISPATCH);
  if (!hasDispatch) {
    configs.push({
      moduleName: MODULE_NAMES.DISPATCH,
      isEnabled: false,
      isWhatsAppEnabled: false,
    });
  }

  return configs;
};

const testEmailConfig = async smtpConfig => {
  await sendEmailViaSmtp({
    smtpConfig,
    to: smtpConfig.username,
    subject: 'SMTP Connection Test',
    text: 'Congratulations! Your SMTP configuration is working correctly.',
    html: `
      <p>Hello,</p>
      <p><strong>Congratulations!</strong> Your SMTP configuration is working correctly.</p>
      <p>You can now use this email configuration to send emails from ABSS Books.</p>
      <p>Thank you.</p>
    `,
  });

  return {
    success: true,
    message: 'SMTP connection verified successfully.',
  };
};

const updateModuleEmailConfig = async (companyId, body, userId) => {
  const { Company, CompanySettings } = getCommonModels();
  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  let settings = await CompanySettings.findOne({ companyId });
  const smtp = settings?.emailConfiguration;
  if (
    body.moduleEmailConfig.some(config => config.isEnabled) &&
    (!settings?.isEmailEnabled || !smtp?.smtpHost || !smtp?.smtpPort || !smtp?.username || !smtp?.password)
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, COMPANY_MESSAGES.EMAIL_CONFIG_REQUIRED);
  }
  if (!settings) {
    settings = await CompanySettings.create({
      companyId,
      isEmailEnabled: false,
      moduleEmailConfig: body.moduleEmailConfig,
    });
  } else {
    settings.moduleEmailConfig = body.moduleEmailConfig;
    await settings.save();
  }

  company.updatedBy.push({ userId, updatedAt: new Date() });
  await company.save();

  return (settings.moduleEmailConfig || []).map(config => ({
    moduleName: config.moduleName,
    isEnabled: Boolean(config.isEnabled),
    isWhatsAppEnabled: Boolean(config.isWhatsAppEnabled),
  }));
};
const getDefaultAdminPhone = async companyId => {
  const { Company, User } = getCommonModels();
  const company = await Company.findById(companyId).select('addedBy contactPhone').lean();
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (company.addedBy) {
    const admin = await User.findById(company.addedBy).select('phone').lean();
    if (admin?.phone) return admin.phone;
  }

  return company.contactPhone || '';
};

const getWhatsappRecipientsLimit = async companyId => {
  const { CompanySubscription, BillingCycle } = getCommonModels();
  const { Plan, AddOns } = getAbssAdminModels();

  const subscription = await CompanySubscription.findOne({
    companyId,
    appName: APP_NAME.BOOKS,
    status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.DUE] },
  }).lean();

  if (!subscription) {
    return { isUnlimited: false, limit: 0 };
  }

  const plan = await Plan.findById(subscription.planId).lean();
  const feature = plan?.limits?.find(f => f.featureName === PLAN_FEATURES.WHATSAPP_CONFIG);

  if (!feature) {
    return { isUnlimited: false, limit: 0 };
  }

  if (feature.isUnlimited) {
    return { isUnlimited: true, limit: null };
  }

  const currentBillingCycle = await BillingCycle.findById(subscription.currentBillingCycleId).lean();
  const activeAddons = (currentBillingCycle?.addons || []).filter(a => a.addonStatus === SUBSCRIPTION_STATUS.ACTIVE);
  const addonIds = activeAddons.map(a => a.addonId);
  const addonDocs = addonIds.length ? await AddOns.find({ _id: { $in: addonIds } }).lean() : [];
  const matchedAddon = addonDocs.find(a => a.featureName === PLAN_FEATURES.WHATSAPP_CONFIG);

  let addonQty = 0;
  if (matchedAddon) {
    const subAddon = activeAddons.find(a => a.addonId.toString() === matchedAddon._id.toString());
    addonQty = matchedAddon.unitsIncluded * (subAddon?.quantity || 0);
  }

  return { isUnlimited: false, limit: (feature.limit || 0) + addonQty };
};

const buildDefaultAdminSummarySetting = () => ({
  whatsapp: {
    templates: [],
  },
});

const toWhatsappApiShape = (whatsapp, fallbackPhone = '') => ({
  templates: (whatsapp?.templates || []).map(template => ({
    ...template,
    adminPhoneNumber: template.adminPhoneNumber?.length ? template.adminPhoneNumber : [fallbackPhone].filter(Boolean),
  })),
});

const normalizeScheduleIncremental = (schedule, legacyIncremental = false) => {
  if (!schedule || typeof schedule !== 'object') return schedule;
  return {
    ...schedule,
    incremental: schedule.incremental !== undefined ? !!schedule.incremental : !!legacyIncremental,
  };
};

const buildStorageWhatsapp = body => ({
  templates: Array.isArray(body.templates)
    ? body.templates.map(template => {
        const legacyIncremental = !!template.incremental;
        return {
          key: template.key,
          enabled: !!template.enabled,
          adminPhoneNumber: Array.isArray(template.adminPhoneNumber) ? template.adminPhoneNumber.filter(Boolean) : [],
          daily: normalizeScheduleIncremental(template.daily, legacyIncremental),
          weekly: normalizeScheduleIncremental(template.weekly, legacyIncremental),
          monthly: template.monthly,
        };
      })
    : [],
});

const getAdminSummarySetting = async companyId => {
  const { AdminSummarySetting } = getBooksModels();
  const { Company } = getCommonModels();

  const company = await Company.findById(companyId).select('_id').lean();
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const [settings, defaultAdminPhone, lastSummary, whatsappRecipientsLimit] = await Promise.all([
    AdminSummarySetting.findOne({ companyId }).lean(),
    getDefaultAdminPhone(companyId),
    getSummaryStatus(companyId),
    getWhatsappRecipientsLimit(companyId),
  ]);

  if (!settings) {
    return {
      companyId,
      ...buildDefaultAdminSummarySetting(),
      lastSummary: lastSummary || null,
      whatsappRecipientsLimit,
    };
  }

  settings.whatsapp = toWhatsappApiShape(settings.whatsapp, defaultAdminPhone);
  settings.lastSummary = lastSummary || null;
  settings.whatsappRecipientsLimit = whatsappRecipientsLimit;

  return settings;
};

const updateAdminSummarySetting = async (companyId, body) => {
  const { AdminSummarySetting } = getBooksModels();
  const { Company } = getCommonModels();

  const company = await Company.findById(companyId).select('_id').lean();
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, COMPANY_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const whatsapp = buildStorageWhatsapp(body.whatsapp);
  const whatsappRecipientsLimit = await getWhatsappRecipientsLimit(companyId);

  if (!whatsappRecipientsLimit.isUnlimited) {
    const overLimitTemplate = whatsapp.templates.find(t => t.adminPhoneNumber.length > whatsappRecipientsLimit.limit);
    if (overLimitTemplate) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        whatsappRecipientsLimit.limit > 0
          ? `Your plan allows up to ${whatsappRecipientsLimit.limit} WhatsApp summary recipient(s) per template. Upgrade your plan or purchase add-ons to add more.`
          : 'WhatsApp summary notifications are not included in your current plan. Upgrade your plan to enable this feature.',
      );
    }
  }

  const settings = await AdminSummarySetting.findOneAndUpdate(
    { companyId },
    {
      $set: {
        companyId,
        whatsapp,
      },
    },
    { new: true, upsert: true, runValidators: true },
  ).lean();

  return {
    ...settings,
    whatsapp: toWhatsappApiShape(settings.whatsapp),
    whatsappRecipientsLimit,
  };
};

module.exports = {
  updateCompanyById,
  getCompanyByCompanyId,
  getCompanyCode,
  generateCompanyCode,
  addAdditionalCharge,
  updateAdditionalCharge,
  deleteAdditionalCharge,
  updateInventoryConfig,
  getOrCreateCompanySettings,
  updateQuotationConfig,
  updateBranchConfig,
  setPinNo,
  verifyPinNo,
  discountConfig,
  addAdditionalAddress,
  updateAdditionalAddress,
  updateCompanyAddressStatus,
  getCompanyShippingAddresses,
  viewSubscription,
  activeFeatureList,
  getBranchConfig,
  getInventoryConfig,
  getAutoPayConfig,
  updateAutoPayConfig,
  getCompanyCreditLimitConfig,
  updateCreditLimitConfig,
  getQuotationConfigByCompanyId,
  updateQuotationConfigByCompanyId,
  updateRejectionWarehouseConfig,
  getRejectionWarehouseConfig,
  updateEmailConfig,
  getEmailConfig,
  getModuleEmailConfig,
  updateModuleEmailConfig,
  testEmailConfig,
  getAdminSummarySetting,
  updateAdminSummarySetting,
};
