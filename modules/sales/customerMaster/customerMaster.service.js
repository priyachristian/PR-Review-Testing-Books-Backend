// services/customerMaster.service.js
const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const Joi = require('joi');
const {
  getBooksCrmModels,
  getBooksModels,
  getCommonModels,
  getClientConnection,
  getCrmModels,
  getAbssAdminModels,
} = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const { activeFeatureList } = require('../../setting/companyProfile/companyProfile.service');
const { applyCompanyPaymentTermsFallback } = require('../../../utils/customerPaymentTerms');
const mongoose = require('mongoose');
const { CUSTOMER_MESSAGES } = require('../../../utils/messages');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { sendPortalInvite, enablePortalAccess, disablePortalAccess } = require('./portalInvite.service');
const logger = require('../../../config/logger');
const { uploadFileToS3, handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { escapeRegex, createSearchRegex } = require('../../../utils/regexUtils');
const { resolveFinancialYearRange } = require('../../../utils/queryBuilder');
const {
  MODULE_NAMES,
  ADDRESS_TYPE,
  ADDRESS_VALIDATION_ERRORS,
  OB_TYPE_BALANCE,
  SYSTEM_ACCOUNT_KEYS,
  VERIFICATION_LINK_STATUS,
  PARTY_ACCOUNT_TYPES,
  PARTY_ACCOUNT_TYPES_BY_ROLE,
} = require('../../../utils/enum');
const {
  QUOTE_STATUS,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  INVOICE_STATUS,
  PO_STATUSES,
  GRPO_STATUSES,
  BILL_STATUSES,
  CREDIT_NOTE_STATUS,
  DEBIT_NOTE_STATUS,
  TRANSACTION_TYPE,
  PAYMENT_STATUS,
  SALES_ORDER_INVOICE_STATUS,
  CONTACT_TYPE,
  LEDGER_SOURCE_MODULES,
  LEDGER_PARTY_TYPES,
} = require('../../../utils/enum');
const { resolveTransactionCurrency, getCurrency } = require('../../../services/currencyResolver.service');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { getOpeningBalanceTransactionHistory } = require('../openingBalanceTransaction/openingBalanceTransaction.service');

const resolvePartyAccountId = async ({ companyId, isCustomer, accountType, session }) => {
  const allowed = PARTY_ACCOUNT_TYPES_BY_ROLE[isCustomer ? 'CUSTOMER' : 'VENDOR'];
  const type = accountType || allowed[0];
  if (!allowed.includes(type)) {
    throw new ApiError(httpStatus.BAD_REQUEST, CUSTOMER_MESSAGES.ACCOUNT_TYPE_NOT_ALLOWED);
  }
  return (await ledgerService.resolveSystemAccount(companyId, PARTY_ACCOUNT_TYPES[type], session))._id;
};

const PHONE_NUMBER_REGEX = /^\d+$/;
const bpEmailSchema = Joi.string().trim().email();
const BULK_BUSINESS_PARTNER_TYPES = ['Business', 'Individual'];
const BULK_TAX_PREFERENCES = ['Taxable', 'Tax Exempt'];
const GST_TREATMENT_REGISTERED_BUSINESS = 'Registered Business Regular';

const resolveConfigSource = data => {
  const creditConfig = data.useBranchCreditLimit
    ? data.branch?.some(branch => branch.creditLimit > 0 || branch.restrictedModule?.length > 0)
    : data.creditLimit > 0 || data.restrictedModule?.length > 0;
  if (creditConfig) return true;

  const paymentConfig = data.useBranchPaymentTerms
    ? data.branch?.some(branch => !!branch.paymentTerms || branch.restrictedPaymentTermsModule?.length > 0)
    : !!data.paymentTerms || data.restrictedPaymentTermsModule?.length > 0;
  return Boolean(paymentConfig);
};

/** Field-level "required"/format checks for a single bulk customer row, shared by
 * verifyBulkCustomerCreation and createBulkCustomers so both report the same errors
 * per-row instead of relying on Joi to reject the whole sheet. */
const validateBulkCustomerFields = customer => {
  const errors = [];

  if (!customer.companyName?.trim()) {
    errors.push({ name: 'COMPANY_NAME_REQUIRED', message: 'Company Name is required.' });
  }

  if (!customer.bpPrimaryContactName?.firstName?.trim()) {
    errors.push({ name: 'PRIMARY_CONTACT_FIRST_NAME_REQUIRED', message: 'Primary Contact First Name is required.' });
  }

  if (!customer.businessPartnerType) {
    errors.push({ name: 'BUSINESS_PARTNER_TYPE_REQUIRED', message: 'Business Partner Type is required.' });
  } else if (!BULK_BUSINESS_PARTNER_TYPES.includes(customer.businessPartnerType)) {
    errors.push({
      name: 'INVALID_BUSINESS_PARTNER_TYPE',
      message: `Business Partner Type must be either Business or Individual: ${customer.businessPartnerType}`,
    });
  }

  if (customer.bpEmail && bpEmailSchema.validate(customer.bpEmail).error) {
    errors.push({ name: 'INVALID_EMAIL_FORMAT', message: `Email must be a valid email address: ${customer.bpEmail}` });
  }

  const gstTreatment = customer.otherDetails?.gstTreatment;
  if (!gstTreatment) {
    errors.push({ name: 'GST_TREATMENT_REQUIRED', message: 'GST Treatment is required.' });
  }

  if (gstTreatment === GST_TREATMENT_REGISTERED_BUSINESS && !customer.otherDetails?.gstinUin) {
    errors.push({
      name: 'GSTIN_REQUIRED_FOR_REGISTERED_BUSINESS',
      message: 'GSTIN/UIN is required when GST Treatment is Registered Business Regular.',
    });
  }

  const taxPreference = customer.otherDetails?.taxPreference;
  if (taxPreference && !BULK_TAX_PREFERENCES.includes(taxPreference)) {
    errors.push({
      name: 'INVALID_TAX_PREFERENCE',
      message: `Tax Preference must be either Taxable or Tax Exempt: ${taxPreference}`,
    });
  }

  // Exactly one role must be marked. A blank/ambiguous role otherwise passes
  // the verify step but is silently created as a Vendor at the create step
  // (verify reads isCustomer/isVendor independently, create collapses the role
  // to "not customer -> vendor"). Flagging it here keeps both steps consistent.
  const isCustomerRole = customer.Role?.isCustomer === true;
  const isVendorRole = customer.Role?.isVendor === true;
  if (isCustomerRole === isVendorRole) {
    errors.push({
      name: 'ROLE_REQUIRED',
      message: 'Each row must be marked as exactly one of Customer or Vendor.',
    });
  }

  return errors;
};

/**
 * Create a new Customer
 * @param {Object} customerBody
 * @param {ObjectId} userId
 * @param {Array} uploadedFiles - Array of file objects from multer (optional)
 * @param {Array} uploadedLogo - Array of logo file objects from multer (optional)
 * @returns {Promise<Customer>}
 */

const createOpeningBalanceTransactions = async (customer, session, userId) => {
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const branches = customer.branch || [];
  const isCustomer = customer.Role?.isCustomer;
  const contactType = isCustomer ? CONTACT_TYPE.CUSTOMER : CONTACT_TYPE.VENDOR;

  const { currency, exchangeRate } = await resolveTransactionCurrency({
    companyId: customer.companyId,
    currencyId: customer.otherDetails?.currency,
  });

  const toCreate = [];
  for (const b of branches) {
    const ob = parseFloat(b.openingBalance) || 0;
    if (!ob) continue;

    const branchId = b.branchId;
    if (!branchId) continue;

    const suffix = `${customer._id.toString().slice(-6)}-${(branchId || '').toString().slice(-4)}`;
    const isCredit = ob < 0;
    const type = isCustomer
      ? isCredit
        ? TRANSACTION_TYPE.CUSTOMER_CREDIT
        : TRANSACTION_TYPE.OPENING_RECEIVABLE
      : isCredit
        ? TRANSACTION_TYPE.VENDOR_CREDIT
        : TRANSACTION_TYPE.OPENING_PAYABLE;
    const amount = Math.abs(ob);

    toCreate.push({
      contactId: customer._id,
      contactType,
      type,
      amount,
      currency,
      exchangeRate,
      remainingAmount: amount,
      date: new Date(),
      branchId,
      companyId: customer.companyId,
      transactionNo: `OB-${suffix}`,
      isSplit: b.isSplitBalance === true,
    });
  }
  if (toCreate.length > 0) {
    const created = await OpeningBalanceTransaction.insertMany(toCreate, { session });
    if (!customer.accountId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No receivable/payable account is assigned on this customer or vendor');
    }

    for (const obTxn of created) {
      const balanceType = OB_TYPE_BALANCE[obTxn.type];
      if (!balanceType) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Unsupported opening balance type: ${obTxn.type}`);
      }
      await ledgerService.postOpeningBalanceJournal(
        {
          companyId: obTxn.companyId,
          accountId: customer.accountId,
          amount: obTxn.amount,
          balanceType,
          postingDate: obTxn.date,
          sourceId: obTxn._id,
          sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
          partyId: obTxn.contactId,
          partyType: obTxn.contactType === CONTACT_TYPE.CUSTOMER ? LEDGER_PARTY_TYPES.CUSTOMER : LEDGER_PARTY_TYPES.VENDOR,
          narration: obTxn.contactType === CONTACT_TYPE.CUSTOMER ? 'Customer opening balance' : 'Vendor opening balance',
          addedBy: userId,
          currencyId: obTxn.currency,
          exchangeRate: obTxn.exchangeRate,
          isSplit: obTxn.isSplit === true,
        },
        session,
      );
    }
  }
};

/**
 * Validates that address.state belongs to address.country and address.city belongs to address.state,
 * using the maps built by buildLocationValidationMaps. Returns an array of { name, message } errors.
 */
const validateAddressLocation = (address, label, locationMaps) => {
  const errors = [];
  if (!address) return errors;

  const { countryByName, stateByCountryAndName, stateByNameOnly, cityByStateAndName, cityByNameOnly } = locationMaps;
  const prefix = label.toUpperCase();

  const countryName = address.country?.trim();
  const stateName = address.state?.trim();
  const cityName = address.city?.trim();

  // City and state are required together, and a state requires a country.
  if (cityName && !stateName) {
    errors.push({
      name: ADDRESS_VALIDATION_ERRORS[`${prefix}_STATE_REQUIRED`],
      message: `${label} State is required when City is provided.`,
    });
  }

  if (stateName && !cityName) {
    errors.push({
      name: ADDRESS_VALIDATION_ERRORS[`${prefix}_CITY_REQUIRED`],
      message: `${label} City is required when State is provided.`,
    });
  }

  if (stateName && !countryName) {
    errors.push({
      name: ADDRESS_VALIDATION_ERRORS[`${prefix}_COUNTRY_REQUIRED`],
      message: `${label} Country is required when State is provided.`,
    });
  }

  let countryDoc = null;
  if (countryName) {
    countryDoc = countryByName.get(countryName.toLowerCase());
    if (!countryDoc) {
      errors.push({
        name: ADDRESS_VALIDATION_ERRORS[`${prefix}_COUNTRY_NOT_FOUND`],
        message: `${label} Country does not exist: ${countryName}`,
      });
    }
  }

  let stateDoc = null;
  if (stateName) {
    if (countryDoc) {
      stateDoc = stateByCountryAndName.get(`${countryDoc._id}::${stateName.toLowerCase()}`);
      if (!stateDoc) {
        errors.push({
          name: ADDRESS_VALIDATION_ERRORS[`${prefix}_STATE_NOT_FOUND`],
          message: `${label} State does not exist for ${countryName}: ${stateName}`,
        });
      }
    } else {
      const candidates = stateByNameOnly.get(stateName.toLowerCase());
      if (!candidates?.length) {
        errors.push({
          name: ADDRESS_VALIDATION_ERRORS[`${prefix}_STATE_NOT_FOUND`],
          message: `${label} State does not exist: ${stateName}`,
        });
      } else if (candidates.length === 1) {
        [stateDoc] = candidates;
      }
    }
  }

  if (cityName) {
    if (stateDoc) {
      const cityDoc = cityByStateAndName.get(`${stateDoc._id}::${cityName.toLowerCase()}`);
      if (!cityDoc) {
        errors.push({
          name: ADDRESS_VALIDATION_ERRORS[`${prefix}_CITY_NOT_FOUND`],
          message: `${label} City does not exist for ${stateName}: ${cityName}`,
        });
      }
    } else {
      const candidates = cityByNameOnly.get(cityName.toLowerCase());
      if (!candidates?.length) {
        errors.push({
          name: ADDRESS_VALIDATION_ERRORS[`${prefix}_CITY_NOT_FOUND`],
          message: `${label} City does not exist: ${cityName}`,
        });
      }
    }
  }

  return errors;
};

/**
 * Builds lookup maps for validating that a given state belongs to a given country,
 * and a given city belongs to a given state, based on the Country/State/City master data.
 * Country/state/city names are matched case-insensitively.
 */
const buildLocationValidationMaps = async customersBody => {
  const { Country, State, City } = getAbssAdminModels();

  const countryNames = new Set();
  const stateNames = new Set();
  const cityNames = new Set();

  customersBody.forEach(customer => {
    ['billing', 'shipping'].forEach(type => {
      const address = customer.address?.[type];
      if (address?.country?.trim()) countryNames.add(address.country.trim());
      if (address?.state?.trim()) stateNames.add(address.state.trim());
      if (address?.city?.trim()) cityNames.add(address.city.trim());
    });
  });

  const countryByName = new Map();
  const stateByCountryAndName = new Map();
  const stateByNameOnly = new Map();
  const cityByStateAndName = new Map();
  const cityByNameOnly = new Map();

  if (countryNames.size > 0) {
    const countries = await Country.find({
      name: { $in: [...countryNames].map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
    })
      .select('_id name')
      .lean();
    countries.forEach(country => {
      if (country.name) countryByName.set(country.name.trim().toLowerCase(), country);
    });
  }

  if (stateNames.size > 0) {
    const states = await State.find({
      name: { $in: [...stateNames].map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
    })
      .select('_id name countryId')
      .lean();
    states.forEach(state => {
      if (!state.name) return;
      const key = state.name.trim().toLowerCase();
      stateByCountryAndName.set(`${state.countryId}::${key}`, state);
      const candidates = stateByNameOnly.get(key) || [];
      candidates.push(state);
      stateByNameOnly.set(key, candidates);
    });
  }

  if (cityNames.size > 0) {
    const cities = await City.find({
      name: { $in: [...cityNames].map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
    })
      .select('_id name stateId')
      .lean();
    cities.forEach(city => {
      if (!city.name) return;
      const key = city.name.trim().toLowerCase();
      cityByStateAndName.set(`${city.stateId}::${key}`, city);
      const candidates = cityByNameOnly.get(key) || [];
      candidates.push(city);
      cityByNameOnly.set(key, candidates);
    });
  }

  return { countryByName, stateByCountryAndName, stateByNameOnly, cityByStateAndName, cityByNameOnly };
};

const createCustomer = async (customerBody, userId, uploadedFiles = [], uploadedLogo = []) => {
  const { Customer } = getBooksCrmModels();
  const { Currency } = getCommonModels();
  const connection = getClientConnection();
  const session = await connection.startSession();
  const role = customerBody?.Role?.isCustomer;
  let customer;

  try {
    await session.withTransaction(async () => {
      if (role) {
        customerBody.customerNumber = await generateUniqueId(
          Customer,
          customerBody?.companyId,
          MODULE_NAMES.CUSTOMER,
          'customerNumber',
          'Cust',
          session,
          customerBody.customerNumber,
          { 'Role.isCustomer': true },
        );
      } else {
        customerBody.customerNumber = await generateUniqueId(
          Customer,
          customerBody?.companyId,
          MODULE_NAMES.VENDOR,
          'customerNumber',
          'Cust',
          session,
          customerBody.customerNumber,
          { 'Role.isVendor': true },
        );
      }

      if (role) {
        const findCustomerByName = await Customer.findOne({
          customerDisplayName: { $regex: new RegExp(`^${customerBody.customerDisplayName}$`, 'i') },
          companyId: customerBody.companyId,
          'Role.isCustomer': true,
        });

        if (findCustomerByName) {
          throw new ApiError(httpStatus.CONFLICT, 'Customer with this name already exists.');
        }
      } else {
        const findCustomerByName = await Customer.findOne({
          customerDisplayName: { $regex: new RegExp(`^${customerBody.customerDisplayName}$`, 'i') },
          companyId: customerBody.companyId,
          'Role.isVendor': true,
        });

        if (findCustomerByName) {
          throw new ApiError(httpStatus.CONFLICT, 'Vendor with this name already exists.');
        }
      }

      // Upload files to S3
      let companyLogo = customerBody.companyLogo || null;
      let documentUrls = [];

      if (uploadedFiles && uploadedFiles.length > 0) {
        const uploadPromises = uploadedFiles.map(file => uploadFileToS3(file, userId, customerBody.companyId));
        const uploadedUrls = await Promise.all(uploadPromises);
        documentUrls = uploadedUrls;
      }

      const logoUploadPromises = uploadedLogo.map(file => uploadFileToS3(file, userId, customerBody.companyId));
      const uploadedLogoUrls = await Promise.all(logoUploadPromises);
      if (uploadedLogoUrls && uploadedLogoUrls.length > 0) {
        companyLogo = uploadedLogoUrls[0];
      }

      // Merge document URLs with existing documents from body
      const allDocuments = [...documentUrls];

      const customerData = {
        ...customerBody,
        companyLogo,
        otherDetails: {
          ...customerBody.otherDetails,
          document: allDocuments,
        },
        address: {
          ...customerBody.address,
          additionalShippingAddresses: [],
        },
        addedBy: userId,
        updatedBy: userId,
        commentHistory: [
          {
            message: `Customer created`,
            addedBy: userId,
            createdAt: new Date(),
          },
        ],
      };

      const currencyId = customerBody.otherDetails?.currency;
      const currencyExists = await Currency.exists({
        _id: currencyId,
        companyId: customerBody.companyId,
      });

      if (!currencyExists) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid currency for this company');
      }

      if (customerBody?.Role?.isCustomer) {
        customerData.appName = APP_NAME.BOOKS;
      }

      let linkedPartner = null;
      if (customerData.vendorId && customerData.isLinkedToVendor) {
        const linkedVendor = await Customer.findById(customerData.vendorId).session(session);
        if (linkedVendor?.customerId) {
          throw new ApiError(httpStatus.CONFLICT, 'Vendor is already linked to another customer. Please unlink first.');
        }
        linkedPartner = linkedVendor;
      }
      if (customerData.customerId && customerData.isLinkedToVendor) {
        const linkedCustomer = await Customer.findById(customerData.customerId).session(session);
        if (linkedCustomer?.vendorId) {
          throw new ApiError(httpStatus.CONFLICT, 'Customer is already linked to another vendor. Please unlink first.');
        }
        linkedPartner = linkedCustomer;
      }

      if (customerData.isLinkedToVendor && linkedPartner) {
        customerData.commentHistory.push({
          message: `Created and linked to ${role ? 'vendor' : 'customer'} ${linkedPartner.customerDisplayName}`,
          addedBy: userId,
          createdAt: new Date(),
        });
      }

      customerData.configSource = resolveConfigSource(customerData);

      customerData.accountId = await resolvePartyAccountId({
        companyId: customerData.companyId,
        isCustomer: Boolean(role),
        accountType: customerData.accountType,
        session,
      });
      delete customerData.accountType;

      const createdCustomers = await Customer.create([customerData], { session });
      customer = createdCustomers[0];

      await createOpeningBalanceTransactions(customer, session, userId);

      if (customerData.isLinkedToVendor) {
        const linkNote = {
          message: `Linked to ${role ? 'customer' : 'vendor'} ${customer.customerDisplayName}`,
          addedBy: userId,
          createdAt: new Date(),
        };
        if (role && customerData.vendorId) {
          await Customer.findByIdAndUpdate(
            customerData.vendorId,
            { $set: { customerId: customer._id, isLinkedToVendor: true }, $push: { commentHistory: linkNote } },
            { session },
          );
        } else if (!role && customerData.customerId) {
          await Customer.findByIdAndUpdate(
            customerData.customerId,
            { $set: { vendorId: customer._id, isLinkedToVendor: true }, $push: { commentHistory: linkNote } },
            { session },
          );
        }
      }
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to create customer: ${error.message}`);
  } finally {
    await session.endSession();
  }

  // Send portal invite if enablePortal is true and email is provided
  if (
    customer?._id &&
    customer?.companyId &&
    customer?.otherDetails?.enablePortal === true &&
    customer?.bpEmail &&
    typeof customer.bpEmail === 'string' &&
    customer.bpEmail.trim().length > 0
  ) {
    const createPortalFeatures = await activeFeatureList(customer.companyId);
    if (!createPortalFeatures?.[PLAN_FEATURES.CUSTOMER_ORDER]) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Please upgrade your plan to enable customer portal access');
    }
    try {
      await sendPortalInvite(
        customer._id,
        customer.companyId,
        customer.bpEmail.trim(),
        customer.customerDisplayName || customer.companyName || 'Valued Customer',
      );
      logger.info(`Portal invite sent to ${customer.bpEmail} for customer ${customer._id}`);
    } catch (error) {
      // Log error but don't fail customer creation
      logger.error(`Failed to send portal invite for customer ${customer._id}:`, error);
    }
  }

  const customerObj = await Customer.findById(customer._id).lean();
  const currencyDoc = customerObj?.otherDetails?.currency
    ? await getCurrency(customerObj.companyId, customerObj.otherDetails.currency)
    : null;
  return {
    ...customerObj,
    otherDetails: { ...customerObj.otherDetails, currency: currencyDoc },
  };
};

const createBulkCustomers = async (customersBody, userId, companyId) => {
  const { Customer, ModuleSettings, Branch, PaymentTerm } = getBooksCrmModels();
  const { Currency } = getCommonModels();
  const connection = await getClientConnection();
  const session = await connection.startSession();

  session.startTransaction();

  try {
    if (!Array.isArray(customersBody) || customersBody.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Customers array is empty or invalid.');
    }

    // ================= COLLECT ALL VALIDATION ERRORS PER CUSTOMER =================
    customersBody.forEach(customer => {
      if (typeof customer.customerDisplayName === 'string') {
        customer.customerDisplayName = customer.customerDisplayName.trim();
      }
    });

    const customerErrorsByIndex = customersBody.map(() => []);

    // ---- Customer Display Name is required ----
    customersBody.forEach((customer, index) => {
      if (!customer.customerDisplayName) {
        customerErrorsByIndex[index].push({
          name: 'CUSTOMER_DISPLAY_NAME_REQUIRED',
          message: 'Customer Display Name is required.',
        });
      }
    });

    // ---- Duplicate name within the sheet ----
    const nameCountInSheet = customersBody.reduce((acc, customer) => {
      const name = customer.customerDisplayName?.toLowerCase();
      if (name) acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});

    customersBody.forEach((customer, index) => {
      const name = customer.customerDisplayName?.toLowerCase();
      if (name && nameCountInSheet[name] > 1) {
        customerErrorsByIndex[index].push({
          name: 'DUPLICATE_CUSTOMER_NAME_IN_SHEET',
          message: `Duplicate customer name in sheet: ${customer.customerDisplayName}`,
        });
      }
    });

    // ---- Existing customer/vendor check ----
    const customerOnlyNames = [
      ...new Set(
        customersBody
          .filter(c => c?.Role?.isCustomer)
          .map(c => c.customerDisplayName?.toLowerCase())
          .filter(Boolean),
      ),
    ];

    const vendorOnlyNames = [
      ...new Set(
        customersBody
          .filter(c => !c?.Role?.isCustomer)
          .map(c => c.customerDisplayName?.toLowerCase())
          .filter(Boolean),
      ),
    ];

    const existingCustomers = customerOnlyNames.length
      ? await Customer.find({
          companyId,
          'Role.isCustomer': true,
          customerDisplayName: { $in: customerOnlyNames.map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
        })
          .select('customerDisplayName')
          .lean()
          .session(session)
      : [];

    const existingVendors = vendorOnlyNames.length
      ? await Customer.find({
          companyId,
          'Role.isVendor': true,
          customerDisplayName: { $in: vendorOnlyNames.map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
        })
          .select('customerDisplayName')
          .lean()
          .session(session)
      : [];

    const existingCustomerNameSet = new Set(existingCustomers.map(c => c.customerDisplayName?.toLowerCase()));
    const existingVendorNameSet = new Set(existingVendors.map(c => c.customerDisplayName?.toLowerCase()));

    customersBody.forEach((customer, index) => {
      const name = customer.customerDisplayName?.toLowerCase();
      if (!name) return;
      const role = customer?.Role?.isCustomer;
      if (role && existingCustomerNameSet.has(name)) {
        customerErrorsByIndex[index].push({
          name: 'CUSTOMER_ALREADY_EXISTS',
          message: `Customer already exists: ${customer.customerDisplayName}`,
        });
      }
      if (!role && existingVendorNameSet.has(name)) {
        customerErrorsByIndex[index].push({
          name: 'VENDOR_ALREADY_EXISTS',
          message: `Vendor already exists: ${customer.customerDisplayName}`,
        });
      }
    });

    // ---- Currency must exist ----
    const currencyRows = await Currency.find({ companyId }).select('_id code').lean().session(session);
    const currencyByCode = new Map(currencyRows.map(row => [row.code?.trim().toUpperCase(), row._id]));

    // ---- Payment terms must exist for this company ----
    const paymentTermRows = await PaymentTerm.find({ companyId }).select('_id name').lean().session(session);
    const paymentTermIdByName = new Map(paymentTermRows.map(row => [row.name?.trim().toLowerCase(), row._id]));

    customersBody.forEach((customer, index) => {
      const code = customer.otherDetails?.currency?.trim().toUpperCase();
      if (!code || !currencyByCode.has(code)) {
        customerErrorsByIndex[index].push({
          name: 'CURRENCY_NOT_AVAILABLE',
          message: `Currency ${code || ''} is not available for ${customer.customerDisplayName || 'this row'}`,
        });
      }
    });

    // ---- State must belong to country, city must belong to state ----
    const locationMaps = await buildLocationValidationMaps(customersBody);
    customersBody.forEach((customer, index) => {
      customerErrorsByIndex[index].push(
        ...validateAddressLocation(customer.address?.billing, 'Billing', locationMaps),
        ...validateAddressLocation(customer.address?.shipping, 'Shipping', locationMaps),
      );
    });

    // ---- Payment terms must exist for this company ----
    customersBody.forEach((customer, index) => {
      if (customer.paymentTerms && !paymentTermIdByName.has(customer.paymentTerms.trim().toLowerCase())) {
        customerErrorsByIndex[index].push({
          name: 'INVALID_PAYMENT_TERMS',
          message: `Invalid payment terms: ${customer.paymentTerms}`,
        });
      }
    });

    // ---- Phone number must contain only digits ----
    customersBody.forEach((customer, index) => {
      if (customer.customerPhoneNumber && !PHONE_NUMBER_REGEX.test(customer.customerPhoneNumber.trim())) {
        customerErrorsByIndex[index].push({
          name: 'INVALID_PHONE_NUMBER',
          message: `Customer Phone Number must contain only digits: ${customer.customerPhoneNumber}`,
        });
      }
    });

    // ---- Remaining required/format checks (company name, primary contact, business partner
    // type, email, GST treatment/GSTIN, tax preference) ----
    customersBody.forEach((customer, index) => {
      customerErrorsByIndex[index].push(...validateBulkCustomerFields(customer));
    });

    // ---- Bail out before creating anything if any customer has errors ----
    const erroredCustomers = customersBody.reduce((acc, customer, index) => {
      if (customerErrorsByIndex[index].length) {
        acc.push({
          row: index + 1,
          customerDisplayName: customer.customerDisplayName || null,
          errors: customerErrorsByIndex[index],
        });
      }
      return acc;
    }, []);

    if (erroredCustomers.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Bulk customer validation failed.', 0, { errors: erroredCustomers });
    }

    // ================= PREPARE DATA =================
    const customerModuleSettings = await ModuleSettings.findOne({
      companyId: companyId,
      moduleName: MODULE_NAMES.CUSTOMER,
    }).session(session);

    const vendorModuleSettings = await ModuleSettings.findOne({
      companyId: companyId,
      moduleName: MODULE_NAMES.VENDOR,
    }).session(session);

    if (!customerModuleSettings || !vendorModuleSettings) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Module settings not found');
    }

    const hasCustomers = customersBody.some(c => c?.Role?.isCustomer);
    const hasVendors = customersBody.some(c => !c?.Role?.isCustomer);

    // Resolved once for the whole sheet; every row gets one of the two by its role. Sequential
    // (not Promise.all): both resolve on the shared transaction session, and the MongoDB driver
    // forbids concurrent operations on one session.
    const receivableAccountId = hasCustomers
      ? (await ledgerService.resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.ACCOUNTS_RECEIVABLE, session))._id
      : null;
    const payableAccountId = hasVendors
      ? (await ledgerService.resolveSystemAccount(companyId, SYSTEM_ACCOUNT_KEYS.ACCOUNTS_PAYABLE, session))._id
      : null;

    if (hasCustomers && !receivableAccountId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Accounts Receivable account is not set up for this company.');
    }
    if (hasVendors && !payableAccountId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Accounts Payable account is not set up for this company.');
    }

    const customerPrefix = customerModuleSettings.useCustomPrefix ? customerModuleSettings.prefix : 'Cust-';

    const vendorPrefix = vendorModuleSettings.useCustomPrefix ? vendorModuleSettings.prefix : 'Vend-';

    let nextCustomerSeq = customerModuleSettings.nextSequence || customerModuleSettings.startingSequence;

    let nextVendorSeq = vendorModuleSettings.nextSequence || vendorModuleSettings.startingSequence;

    const customerSeqLength = String(customerModuleSettings.nextSequence).length;
    const vendorSeqLength = String(vendorModuleSettings.nextSequence).length;

    const baseDate = new Date();

    // Every bulk-created customer/vendor starts linked to all active branches of the company, with 0 opening balance.
    const activeBranches = await Branch.find({ companyId, isActive: true })
      .select('_id branchCode divisionId')
      .session(session)
      .lean();
    const branchEntries = activeBranches.map(branch => ({
      branchId: branch._id,
      branchCode: branch?.branchCode,
      divisionId: branch?.divisionId,
      openingBalance: 0,
      currentBalance: 0,
      isActive: true,
    }));

    const customersData = [];

    for (let index = 0; index < customersBody.length; index++) {
      const customer = customersBody[index];

      const currentDate = new Date(baseDate.getTime() + index * 1000);

      const role = customer?.Role?.isCustomer;
      const code = customer.otherDetails?.currency?.trim().toUpperCase();
      const currencyId = currencyByCode.get(code);
      const paymentTermsId = customer.paymentTerms ? paymentTermIdByName.get(customer.paymentTerms.trim().toLowerCase()) : null;
      customer.accountId = role ? receivableAccountId : payableAccountId;

      // ================= CUSTOMER/VENDOR NUMBER =================
      const customerNumber = role
        ? `${customerPrefix}${String(nextCustomerSeq++).padStart(customerSeqLength, '0')}`
        : `${vendorPrefix}${String(nextVendorSeq++).padStart(vendorSeqLength, '0')}`;

      const { paymentTerms, ...customerRest } = customer;

      customersData.push({
        ...customerRest,
        companyId,
        customerNumber,
        configSource: resolveConfigSource(customer),
        paymentTermsId,
        otherDetails: { ...(customer.otherDetails || {}), currency: currencyId },
        address: {
          ...customer.address,
          additionalShippingAddresses: [],
        },
        branch: branchEntries.map(branch => ({ ...branch })),
        addedBy: userId,
        createdAt: currentDate,
        updatedAt: currentDate,
        appName: role ? APP_NAME.BOOKS : null,
        updatedBy: userId,
        commentHistory: [
          {
            message: `Customer created via bulk import`,
            addedBy: userId,
            createdAt: currentDate,
          },
        ],
      });
    }

    const customers = await Customer.insertMany(customersData, { session, timestamps: false });

    // ================= UPDATE MODULE SEQUENCE =================
    if (hasCustomers) {
      await ModuleSettings.updateOne(
        { _id: customerModuleSettings._id },
        { $set: { nextSequence: nextCustomerSeq } },
        { session },
      );
    }
    if (hasVendors) {
      await ModuleSettings.updateOne({ _id: vendorModuleSettings._id }, { $set: { nextSequence: nextVendorSeq } }, { session });
    }

    await session.commitTransaction();

    return customers;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const verifyBulkCustomerCreation = async (customersBody, companyId) => {
  const { Customer, PaymentTerm } = getBooksCrmModels();
  const { Currency } = getCommonModels();

  if (!Array.isArray(customersBody) || customersBody.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Customers array is empty or invalid.');
  }

  customersBody.forEach(customer => {
    if (typeof customer.customerDisplayName === 'string') {
      customer.customerDisplayName = customer.customerDisplayName.trim();
    }
  });

  // ================= DUPLICATE NAME CHECK (within sheet) =================
  const nameCounts = {};
  customersBody.forEach(customer => {
    const name = customer.customerDisplayName?.toLowerCase();
    if (!name) return;
    nameCounts[name] = (nameCounts[name] || 0) + 1;
  });

  const customerOnlyNames = [
    ...new Set(
      customersBody
        .filter(c => c?.Role?.isCustomer)
        .map(c => c.customerDisplayName?.toLowerCase())
        .filter(Boolean),
    ),
  ];
  const vendorOnlyNames = [
    ...new Set(
      customersBody
        .filter(c => c?.Role?.isVendor)
        .map(c => c.customerDisplayName?.toLowerCase())
        .filter(Boolean),
    ),
  ];

  const currencyCodesInSheet = [
    ...new Set(customersBody.map(c => c.otherDetails?.currency?.trim().toUpperCase()).filter(Boolean)),
  ];

  const [existingCustomers, existingVendors, currencyRows, paymentTermRows] = await Promise.all([
    customerOnlyNames.length
      ? Customer.find({
          companyId,
          'Role.isCustomer': true,
          customerDisplayName: { $in: customerOnlyNames.map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
        })
          .select('customerDisplayName')
          .lean()
      : [],
    vendorOnlyNames.length
      ? Customer.find({
          companyId,
          'Role.isVendor': true,
          customerDisplayName: { $in: vendorOnlyNames.map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
        })
          .select('customerDisplayName')
          .lean()
      : [],
    currencyCodesInSheet.length
      ? // Load all company currencies (not filtered by the uppercased sheet codes)
        // so the availability check is case-insensitive and matches the create
        // step, which compares uppercased codes on both sides.
        Currency.find({ companyId }).select('_id code').lean()
      : [],
    PaymentTerm.find({ companyId }).select('_id name').lean(),
  ]);

  const existingCustomerNameSet = new Set(existingCustomers.map(c => c.customerDisplayName?.toLowerCase()));
  const existingVendorNameSet = new Set(existingVendors.map(c => c.customerDisplayName?.toLowerCase()));
  const currencyCodeSet = new Set(currencyRows.map(row => row.code?.trim().toUpperCase()));
  const paymentTermNameSet = new Set(paymentTermRows.map(row => row.name?.trim().toLowerCase()));
  const locationMaps = await buildLocationValidationMaps(customersBody);

  const invalidRecords = [];
  const validRecords = [];

  customersBody.forEach((customer, index) => {
    const errors = [];
    const name = customer.customerDisplayName;
    const nameLower = name?.toLowerCase();
    const isCustomer = customer?.Role?.isCustomer;
    const isVendor = customer?.Role?.isVendor;

    if (!name) {
      errors.push({ name: 'CUSTOMER_DISPLAY_NAME_REQUIRED', message: 'Customer Display Name is required.' });
    } else {
      if (nameCounts[nameLower] > 1) {
        errors.push({
          name: 'DUPLICATE_CUSTOMER_NAME_IN_SHEET',
          message: `Duplicate customer name in sheet: ${name}`,
        });
      }
      if (isCustomer && existingCustomerNameSet.has(nameLower)) {
        errors.push({ name: 'CUSTOMER_ALREADY_EXISTS', message: `Customer already exists: ${name}` });
      }
      if (isVendor && existingVendorNameSet.has(nameLower)) {
        errors.push({ name: 'VENDOR_ALREADY_EXISTS', message: `Vendor already exists: ${name}` });
      }
    }

    const currencyCode = customer.otherDetails?.currency?.trim().toUpperCase();
    if (!currencyCode) {
      errors.push({ name: 'CURRENCY_CODE_REQUIRED', message: 'Currency Code is required.' });
    } else if (!currencyCodeSet.has(currencyCode)) {
      errors.push({
        name: 'CURRENCY_NOT_AVAILABLE',
        message: `Currency ${currencyCode} is not available for this company.`,
      });
    }

    errors.push(
      ...validateAddressLocation(customer.address?.billing, 'Billing', locationMaps),
      ...validateAddressLocation(customer.address?.shipping, 'Shipping', locationMaps),
    );

    if (customer.paymentTerms && !paymentTermNameSet.has(customer.paymentTerms.trim().toLowerCase())) {
      errors.push({
        name: 'INVALID_PAYMENT_TERMS',
        message: `Invalid payment terms: ${customer.paymentTerms}`,
      });
    }

    if (customer.customerPhoneNumber && !PHONE_NUMBER_REGEX.test(customer.customerPhoneNumber.trim())) {
      errors.push({
        name: 'INVALID_PHONE_NUMBER',
        message: `Customer Phone Number must contain only digits: ${customer.customerPhoneNumber}`,
      });
    }

    errors.push(...validateBulkCustomerFields(customer));

    const record = {
      rowNumber: index + 1,
      customerDisplayName: name || null,
      currencyCode: customer.otherDetails?.currency || null,
    };

    if (errors.length > 0) {
      invalidRecords.push({ ...customer, errors });
    } else {
      validRecords.push(customer);
    }
  });

  return {
    totalRecords: customersBody.length,
    validCount: validRecords.length,
    invalidCount: invalidRecords.length,
    invalidRecords,
    validRecords,
  };
};

const getAllCustomers = async (query, filter, options) => {
  const { Customer } = getBooksCrmModels();
  const { User } = getCommonModels();
  const { CustomerPortalUser } = getBooksModels();
  const searchConditions = [];
  const roleConditions = [];
  const andConditions = [];
  if (filter?.status === 'ACTIVE') filter.isActive = true;
  else if (filter?.status === 'INACTIVE') filter.isActive = false;
  delete filter.status;

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    searchConditions.push(
      { customerDisplayName: searchRegex },
      { companyName: searchRegex },
      { bpEmail: searchRegex },
      { customerPhoneNumber: searchRegex },
      { type: searchRegex },
      { 'address.shipping.state': searchRegex },
      { 'address.shipping.country': searchRegex },
      { 'address.shipping.city': searchRegex },
      { 'address.billing.state': searchRegex },
      { 'address.billing.country': searchRegex },
      { 'address.billing.city': searchRegex },
    );

    andConditions.push({ $or: searchConditions });
  }

  if (query.isCustomer || query.isVendor) {
    if (query.isCustomer) roleConditions.push({ 'Role.isCustomer': true });
    if (query.isVendor) roleConditions.push({ 'Role.isVendor': true });

    andConditions.push({ $or: roleConditions });
  }

  if (filter.startDate && filter.endDate) {
    const endDate = new Date(filter.endDate);
    endDate.setHours(23, 59, 59, 999);
    andConditions.push({
      createdAt: {
        $gte: new Date(filter.startDate),
        $lte: endDate,
      },
    });
    delete filter.startDate;
    delete filter.endDate;
  }

  if (filter.country) {
    andConditions.push({
      $or: [{ 'address.billing.country': query.country }, { 'address.shipping.country': query.country }],
    });

    delete filter.country;
  }

  if (filter.state) {
    andConditions.push({
      $or: [{ 'address.billing.state': query.state }, { 'address.shipping.state': query.state }],
    });

    delete filter.state;
  }

  if (filter.city) {
    andConditions.push({
      $or: [{ 'address.billing.city': query.city }, { 'address.shipping.city': query.city }],
    });

    delete filter.city;
  }

  if (filter.customerDate) {
    andConditions.push({ createdAt: { $gte: new Date(filter.customerDate) } });
    delete filter.customerDate;
  }

  if (filter.verificationStatus) {
    const portalUsersForFilter = await CustomerPortalUser.find({
      'links.companyId': filter.companyId,
      'links.status': filter.verificationStatus,
    })
      .select('links')
      .lean();

    const matchingCustomerIds = [];
    portalUsersForFilter.forEach(portalUser => {
      portalUser.links.forEach(link => {
        if (link.requestId && String(link.companyId) === String(filter.companyId) && link.status === filter.verificationStatus) {
          matchingCustomerIds.push(link.customerId);
        }
      });
    });

    andConditions.push({ _id: { $in: matchingCustomerIds } });
    delete filter.verificationStatus;
  }

  if (andConditions.length > 0) {
    filter.$and = [...(filter.$and || []), ...andConditions];
  }

  const { results, ...otherFields } = await Customer.paginate(filter, options);

  const customerIdsForVerification = results.map(c => c._id);
  const portalUsersForStatus = customerIdsForVerification.length
    ? await CustomerPortalUser.find({
        'links.companyId': filter.companyId,
        'links.customerId': { $in: customerIdsForVerification },
      })
        .select('links')
        .lean()
    : [];

  const verificationStatusMap = new Map();
  portalUsersForStatus.forEach(portalUser => {
    portalUser.links.forEach(link => {
      if (link.requestId && String(link.companyId) === String(filter.companyId)) {
        verificationStatusMap.set(String(link.customerId), link.status);
      }
    });
  });
  const currencies = await getCurrency(
    filter.companyId,
    results.map(c => c.otherDetails?.currency),
  );
  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));

  const userIds = new Set();

  results.forEach(c => {
    if (c.addedBy) userIds.add(c.addedBy.toString());
    const updatedById = toUpdatedByUserIdString(c.updatedBy);
    if (updatedById) userIds.add(updatedById);
  });

  const users = await User.find({ _id: { $in: [...userIds] } })
    .select('firstName lastName email')
    .lean();

  const userMap = new Map(users.map(u => [u._id.toString(), u]));
  const populatedCustomers = [];

  for (let customer of results) {
    const addedByUser = userMap.get(customer.addedBy?.toString()) || null;
    const updatedByUserId = getUpdatedByUserId(customer.updatedBy);
    const updatedByUser = updatedByUserId
      ? userMap.get(updatedByUserId.toString()) ||
        (await User.findById(updatedByUserId).select('firstName lastName email').lean())
      : null;

    let creditLimit = 0;
    if (customer?.useBranchCreditLimit && customer?.branch && customer?.branch?.length > 0) {
      creditLimit = customer?.branch?.reduce((sum, branch) => sum + (branch?.creditLimit || 0), 0);
    } else {
      creditLimit = customer?.creditLimit || 0;
    }

    const currencyDoc = currencyMap.get(String(customer.otherDetails?.currency)) || null;

    populatedCustomers.push({
      ...customer.toObject(),
      id: customer._id,
      addedBy: addedByUser,
      updatedBy: updatedByUser,
      customerCreditLimit: creditLimit,
      otherDetails: {
        ...customer.toObject().otherDetails,
        currency: currencyDoc,
      },
    });
  }

  const enrichedCustomers = populatedCustomers.map(c => ({
    ...c,
    portalEnabled: c.otherDetails?.enablePortal || false,
    portalAccepted: c.otherDetails?.isCustomerPortalActivated || false,
    verificationStatus: verificationStatusMap.get(String(c._id)) || null,
  }));

  // Company-wide portal summary. A portal link carries a requestId only when the customer
  // self-registered through the app with the company code; invites created from Books don't
  // set one. So: link with requestId → joined via code, link without → invited. One link per
  // customer-company, deduped by customerId for safety.
  const portalSummaryAgg = await CustomerPortalUser.aggregate([
    { $unwind: '$links' },
    { $match: { 'links.companyId': new mongoose.Types.ObjectId(filter.companyId) } },
    {
      $group: {
        _id: '$links.customerId',
        joinedViaCode: { $max: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$links.requestId', ''] } }, 0] }, 1, 0] } },
      },
    },
    {
      $group: {
        _id: null,
        joinedViaCode: { $sum: '$joinedViaCode' },
        invited: { $sum: { $subtract: [1, '$joinedViaCode'] } },
      },
    },
  ]);
  const portalSummary = {
    invited: portalSummaryAgg[0]?.invited || 0,
    joinedViaCode: portalSummaryAgg[0]?.joinedViaCode || 0,
  };

  return { results: enrichedCustomers, ...otherFields, portalSummary };
};

const updateCustomer = async (customerId, updateBody, userId, uploadedFiles = [], uploadedLogo = []) => {
  const { Customer } = getBooksCrmModels();
  const { Currency } = getCommonModels();
  const connection = getClientConnection();
  const session = await connection.startSession();
  let customer = null;
  let updatedCustomer = null;
  try {
    await session.withTransaction(async () => {
      customer = await Customer.findById(customerId).session(session);
      if (!customer) {
        throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
      }

      const role = updateBody?.Role?.isCustomer;

      // Name validation
      if (role) {
        const findCustomerByName = await Customer.findOne({
          customerDisplayName: { $regex: new RegExp(`^${updateBody.customerDisplayName}$`, 'i') },
          companyId: customer.companyId,
          _id: { $ne: customerId },
          'Role.isCustomer': true,
        }).session(session);

        if (findCustomerByName) {
          throw new ApiError(httpStatus.CONFLICT, 'Customer with this name already exists.');
        }
      } else {
        const findCustomerByName = await Customer.findOne({
          customerDisplayName: { $regex: new RegExp(`^${updateBody.customerDisplayName}$`, 'i') },
          companyId: customer.companyId,
          _id: { $ne: customerId },
          'Role.isVendor': true,
        }).session(session);

        if (findCustomerByName) {
          throw new ApiError(httpStatus.CONFLICT, 'Vendor with this name already exists.');
        }
      }

      if (updateBody.isLinkedToVendor) {
        if (role && updateBody.vendorId) {
          const linkedVendor = await Customer.findById(updateBody.vendorId).session(session);
          if (linkedVendor?.customerId && linkedVendor.customerId.toString() !== customerId.toString()) {
            throw new ApiError(httpStatus.CONFLICT, 'Vendor is already linked to another customer. Please unlink first.');
          }
        }
        if (!role && updateBody.customerId) {
          const linkedCustomer = await Customer.findById(updateBody.customerId).session(session);
          if (linkedCustomer?.vendorId && linkedCustomer.vendorId.toString() !== customerId.toString()) {
            throw new ApiError(httpStatus.CONFLICT, 'Customer is already linked to another vendor. Please unlink first.');
          }
        }
      }

      const uploadedLogoUrls = await handleFileUpdate({
        newFiles: uploadedLogo,
        currentUrls: updateBody.companyLogo ? [updateBody.companyLogo] : [],
        existingUrls: customer.companyLogo ? [customer.companyLogo] : [],
        userId,
        companyId: customer.companyId,
      });
      updateBody.companyLogo = uploadedLogoUrls.length > 0 ? uploadedLogoUrls[0] : null;

      const uploadedDocumentUrls = await handleFileUpdate({
        newFiles: uploadedFiles,
        currentUrls: updateBody?.otherDetails?.document ? updateBody?.otherDetails?.document : [],
        existingUrls: customer.otherDetails?.document ? customer.otherDetails?.document : [],
        userId,
        companyId: customer.companyId,
      });
      updateBody.otherDetails.document = uploadedDocumentUrls;

      let finalBranchArray = [];

      if (updateBody?.branch && Array.isArray(updateBody.branch)) {
        const updatedBranches = updateBody.branch;

        const existingBranchMap = new Map((customer.branch || []).map(branch => [branch.branchId.toString(), branch]));

        for (let updated of updatedBranches) {
          const branchId = updated.branchId?.toString();
          const existing = existingBranchMap.get(branchId);

          if (existing) {
            const oldOpening = existing.openingBalance || 0;
            const oldCurrent = existing.currentBalance || 0;
            const newOpening = updated.openingBalance ?? oldOpening;

            const diff = newOpening - oldOpening;
            const newCurrent = Math.round((oldCurrent + diff) * 100) / 100;

            finalBranchArray.push({
              branchId: existing.branchId,
              branchCode: existing.branchCode,
              ...existing._doc, // preserve any other fields
              openingBalance: newOpening,
              currentBalance: newCurrent,
              isActive: updated.isActive,
              isSplitBalance:
                updated?.isSplitBalance !== undefined ? updated.isSplitBalance === true : existing.isSplitBalance === true,
              creditLimit: updated?.creditLimit || 0,
              restrictedModule: updated.restrictedModule,
              divisionId: updated.divisionId,
              paymentTermsId: updated?.paymentTermsId,
              restrictedPaymentTermsModule: updated?.restrictedPaymentTermsModule,
            });
          } else {
            // New branch (not in old list) — push with given values
            finalBranchArray.push({
              branchId: updated.branchId,
              branchCode: updated.branchCode,
              openingBalance: updated.openingBalance || 0,
              currentBalance: updated.openingBalance || 0,
              isActive: updated.isActive,
              isSplitBalance: updated?.isSplitBalance === true,
              creditLimit: updated?.creditLimit || 0,
              restrictedModule: updated.restrictedModule,
              divisionId: updated.divisionId,
              paymentTermsId: updated?.paymentTermsId,
              restrictedPaymentTermsModule: updated?.restrictedPaymentTermsModule,
            });
          }
        }
      }

      updateBody.configSource = resolveConfigSource(updateBody);

      if (updateBody.otherDetails?.currency) {
        const currencyExists = await Currency.exists({
          _id: updateBody.otherDetails.currency,
          companyId: customer.companyId,
        });

        if (!currencyExists) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid currency for this company');
        }
      }

      const cleanedBranchArray = finalBranchArray.map(branch => (branch._doc ? { ...branch._doc } : branch));
      customer.commentHistory = customer.commentHistory || [];
      customer.commentHistory.push({
        message: `Customer updated`,
        addedBy: userId,
        createdAt: new Date(),
      });

      if (updateBody.accountType !== undefined) {
        const accountId = await resolvePartyAccountId({
          companyId: customer.companyId,
          isCustomer: Boolean(customer.Role?.isCustomer),
          accountType: updateBody.accountType,
          session,
        });
        if (String(accountId) !== String(customer.accountId)) {
          const { LedgerEntry } = getBooksModels();
          const hasPostings = await LedgerEntry.exists({ companyId: customer.companyId, partyId: customer._id }).session(session);
          if (hasPostings) {
            throw new ApiError(httpStatus.BAD_REQUEST, CUSTOMER_MESSAGES.ACCOUNT_TYPE_LOCKED);
          }
          updateBody.accountId = accountId;
        }
        delete updateBody.accountType;
      }

      // Build selective $set to only update fields present in payload
      const setDoc = {};

      // Copy top-level scalar fields present in payload (excluding nested we handle specially)
      for (const [key, value] of Object.entries(updateBody)) {
        if (key !== 'address' && key !== 'branch') {
          setDoc[key] = value;
        }
      }

      // Merge branch only if provided
      if (Array.isArray(cleanedBranchArray) && cleanedBranchArray.length > 0) {
        setDoc.branch = cleanedBranchArray;
      }

      // Merge address only if provided
      if (updateBody?.address) {
        const existingAddress = customer.address?.toObject?.() ?? customer.address ?? {};
        const mergedAddress = { ...existingAddress };

        if (updateBody.address.shipping) {
          const prev = existingAddress.shipping?.toObject?.() ?? existingAddress.shipping ?? {};
          mergedAddress.shipping = {
            ...prev,
            ...updateBody.address.shipping,
            _id: prev?._id || new mongoose.Types.ObjectId(),
          };
        }

        if (updateBody.address.billing) {
          const prev = existingAddress.billing?.toObject?.() ?? existingAddress.billing ?? {};
          mergedAddress.billing = {
            ...prev,
            ...updateBody.address.billing,
          };
          if (!mergedAddress.billing._id) {
            mergedAddress.billing._id = new mongoose.Types.ObjectId();
          }
        }

        if (Array.isArray(updateBody.address.additionalShippingAddresses)) {
          const prevList = (existingAddress.additionalShippingAddresses || []).map(a => a.toObject?.() ?? a);
          const prevById = new Map(prevList.map(a => [a._id?.toString?.(), a]));
          const merged = [];
          for (const addr of updateBody.address.additionalShippingAddresses) {
            const idStr = addr._id ? addr._id.toString() : undefined;
            if (idStr && prevById.has(idStr)) {
              const prev = prevById.get(idStr);
              merged.push({ ...prev, ...addr, _id: prev._id });
              prevById.delete(idStr);
            } else {
              merged.push({ ...addr, _id: addr._id || new mongoose.Types.ObjectId(), isActive: addr.isActive ?? true });
            }
          }
          // Keep existing addresses not mentioned out-of-payload unchanged
          merged.push(...prevById.values());
          mergedAddress.additionalShippingAddresses = merged;
        }

        setDoc.address = mergedAddress;
      }

      const updateDoc = {
        $set: { ...setDoc, updatedBy: userId },
        $push: {
          commentHistory: {
            message: `Customer updated`,
            addedBy: userId,
            createdAt: new Date(),
          },
        },
      };

      // Update customer
      updatedCustomer = await Customer.findByIdAndUpdate(customerId, updateDoc, { new: true, session });

      if (!updatedCustomer) {
        throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
      }

      // Create OpeningBalanceTransaction for branches that have opening balance but no existing OB transaction
      const { OpeningBalanceTransaction, Branch } = getBooksCrmModels();
      const existingOB = await OpeningBalanceTransaction.find(
        { contactId: customerId, companyId: customer.companyId },
        { branchId: 1, amount: 1, remainingAmount: 1, createdAt: 1, type: 1 },
      )
        .sort({ createdAt: -1 })
        .session(session)
        .lean();
      const existingOBByBranch = new Map();
      for (const row of existingOB) {
        if (!row?.branchId) continue;
        const key = row.branchId.toString();
        if (!existingOBByBranch.has(key)) {
          existingOBByBranch.set(key, row);
        }
      }
      const previousObByBranch = new Map(
        (customer.branch || []).map(br => [(br.branchId || '').toString(), parseFloat(br.openingBalance) || 0]),
      );

      const obCurrencyFields = await resolveTransactionCurrency({
        companyId: updatedCustomer.companyId,
        currencyId: updatedCustomer.otherDetails?.currency,
      });

      const partyControlAccountId = updatedCustomer.accountId;
      if (!partyControlAccountId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'No receivable/payable account is assigned on this customer or vendor');
      }

      for (const b of cleanedBranchArray) {
        const ob = parseFloat(b.openingBalance) || 0;
        const branchIdStr = (b.branchId || '').toString();
        const existingTxn = existingOBByBranch.get(branchIdStr);

        if (!ob) {
          if (!existingTxn) continue;
          const clearedApplied = Math.max(Number(existingTxn.amount || 0) - Number(existingTxn.remainingAmount || 0), 0);
          if (!clearedApplied) {
            await ledgerService.deleteJournal(
              {
                companyId: updatedCustomer.companyId,
                sourceModule: { $in: [LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, LEDGER_SOURCE_MODULES.OPENING_BALANCE] },
                sourceId: existingTxn._id,
              },
              session,
            );
            await OpeningBalanceTransaction.deleteOne({ _id: existingTxn._id }, { session });
            continue;
          }

          const clearBranchDoc = await Branch.findById(b.branchId).select('name').lean();
          const clearBranchName = clearBranchDoc?.name || b.branchCode || 'this branch';
          const clearAmtStr = clearedApplied.toLocaleString('en-IN', { maximumFractionDigits: 2 });
          const clearPrefix = `Opening balance for branch "${clearBranchName}" cannot be cleared while ${clearAmtStr} is applied against it.`;
          const clearMsg =
            existingTxn.type === TRANSACTION_TYPE.CUSTOMER_CREDIT
              ? `${clearPrefix} Applied invoices are using this balance. Remove the applied invoices first.`
              : existingTxn.type === TRANSACTION_TYPE.VENDOR_CREDIT
                ? `${clearPrefix} Applied bills are using this balance. Remove the applied bills first.`
                : `${clearPrefix} Applied payments are using this balance. Remove the applied payments first.`;
          throw new ApiError(httpStatus.BAD_REQUEST, clearMsg);
        }

        const previousOb = previousObByBranch.get(branchIdStr) ?? 0;
        const isObChanged = Math.abs(ob - previousOb) > 0.001;

        const isCustomer = updatedCustomer.Role?.isCustomer;
        const isCredit = ob < 0;
        const type = isCustomer
          ? isCredit
            ? TRANSACTION_TYPE.CUSTOMER_CREDIT
            : TRANSACTION_TYPE.OPENING_RECEIVABLE
          : isCredit
            ? TRANSACTION_TYPE.VENDOR_CREDIT
            : TRANSACTION_TYPE.OPENING_PAYABLE;
        const amount = Math.abs(ob);

        if (existingTxn) {
          const previousAmount = Number(existingTxn.amount || 0);
          const previousRemaining = Number(existingTxn.remainingAmount || 0);
          const alreadyApplied = Math.max(previousAmount - previousRemaining, 0);
          const existingType = existingTxn.type;

          let isSignFlip = false;
          if (isObChanged && existingType) {
            const isReceivableSide = isCustomer
              ? existingType === TRANSACTION_TYPE.OPENING_RECEIVABLE
              : existingType === TRANSACTION_TYPE.OPENING_PAYABLE;
            const isCreditSide = isCustomer
              ? existingType === TRANSACTION_TYPE.CUSTOMER_CREDIT
              : existingType === TRANSACTION_TYPE.VENDOR_CREDIT;
            if (isReceivableSide || isCreditSide) {
              const newIsCredit = ob < 0;
              isSignFlip = newIsCredit !== !!isCreditSide;
            }
          }

          if (isObChanged && isSignFlip && alreadyApplied > 0) {
            const branchDoc = await Branch.findById(b.branchId).select('name').lean();
            const branchName = branchDoc?.name || b.branchCode || 'this branch';
            const signMsg = isCustomer
              ? `Cannot change the opening balance for branch "${branchName}" from receivable to credit. Remove the applied payments first.`
              : `Cannot change the opening balance for branch "${branchName}" from payable to credit. Remove the applied payments first.`;
            throw new ApiError(httpStatus.BAD_REQUEST, signMsg);
          }

          if (isObChanged && amount < alreadyApplied) {
            const branchDoc = await Branch.findById(b.branchId).select('name').lean();
            const branchName = branchDoc?.name || b.branchCode || 'this branch';

            const amtStr = Number.isFinite(alreadyApplied)
              ? alreadyApplied.toLocaleString('en-IN', {
                  maximumFractionDigits: 2,
                })
              : String(alreadyApplied);

            const prefix = `Opening balance for branch "${branchName}" cannot be less than ${amtStr}.`;

            let reductionMsg;

            if (isCustomer) {
              if (existingType === TRANSACTION_TYPE.OPENING_RECEIVABLE) {
                reductionMsg = `${prefix} Applied payments are using this balance. Remove the applied payments first.`;
              } else if (existingType === TRANSACTION_TYPE.CUSTOMER_CREDIT) {
                reductionMsg = `${prefix} Applied invoices are using this balance. Remove the applied invoices first.`;
              } else {
                reductionMsg = `${prefix} Remove the applied entries first.`;
              }
            } else {
              if (existingType === TRANSACTION_TYPE.OPENING_PAYABLE) {
                reductionMsg = `${prefix} Applied payments are using this balance. Remove the applied payments first.`;
              } else if (existingType === TRANSACTION_TYPE.VENDOR_CREDIT) {
                reductionMsg = `${prefix} Applied bills are using this balance. Remove the applied bills first.`;
              } else {
                reductionMsg = `${prefix} Remove the applied entries first.`;
              }
            }

            throw new ApiError(httpStatus.BAD_REQUEST, reductionMsg);
          }

          const nextRemainingAmount = Math.max(amount - alreadyApplied, 0);
          const updatedTxn = await OpeningBalanceTransaction.findByIdAndUpdate(
            existingTxn._id,
            {
              $set: {
                type,
                amount,
                remainingAmount: nextRemainingAmount,
                date: new Date(),
                isSplit: b.isSplitBalance === true,
              },
            },
            { session, new: true },
          );

          // Editing an opening balance = delete the old journal, then post the new one.
          await ledgerService.deleteJournal(
            {
              companyId: updatedCustomer.companyId,
              sourceModule: { $in: [LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, LEDGER_SOURCE_MODULES.OPENING_BALANCE] },
              sourceId: existingTxn._id,
            },
            session,
          );
          const updatedBalanceType = OB_TYPE_BALANCE[updatedTxn.type];
          if (!updatedBalanceType) {
            throw new ApiError(httpStatus.BAD_REQUEST, `Unsupported opening balance type: ${updatedTxn.type}`);
          }
          await ledgerService.postOpeningBalanceJournal(
            {
              companyId: updatedTxn.companyId,
              accountId: partyControlAccountId,
              amount: updatedTxn.amount,
              balanceType: updatedBalanceType,
              postingDate: updatedTxn.date,
              sourceId: updatedTxn._id,
              sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
              partyId: updatedTxn.contactId,
              partyType:
                updatedTxn.contactType === CONTACT_TYPE.CUSTOMER ? LEDGER_PARTY_TYPES.CUSTOMER : LEDGER_PARTY_TYPES.VENDOR,
              narration: updatedTxn.contactType === CONTACT_TYPE.CUSTOMER ? 'Customer opening balance' : 'Vendor opening balance',
              addedBy: userId,
              currencyId: updatedTxn.currency,
              exchangeRate: updatedTxn.exchangeRate,
              isSplit: updatedTxn.isSplit === true,
            },
            session,
          );
          continue;
        }

        const [createdTxn] = await OpeningBalanceTransaction.create(
          [
            {
              contactId: customerId,
              contactType: isCustomer ? CONTACT_TYPE.CUSTOMER : CONTACT_TYPE.VENDOR,
              type,
              amount,
              currency: obCurrencyFields.currency,
              exchangeRate: obCurrencyFields.exchangeRate,
              remainingAmount: amount,
              date: new Date(),
              branchId: b.branchId,
              companyId: updatedCustomer.companyId,
              transactionNo: `OB-${customerId.toString().slice(-6)}-${branchIdStr.slice(-4)}`,
              isSplit: b.isSplitBalance === true,
            },
          ],
          { session },
        );
        const createdBalanceType = OB_TYPE_BALANCE[createdTxn.type];
        if (!createdBalanceType) {
          throw new ApiError(httpStatus.BAD_REQUEST, `Unsupported opening balance type: ${createdTxn.type}`);
        }
        await ledgerService.postOpeningBalanceJournal(
          {
            companyId: createdTxn.companyId,
            accountId: partyControlAccountId,
            amount: createdTxn.amount,
            balanceType: createdBalanceType,
            postingDate: createdTxn.date,
            sourceId: createdTxn._id,
            sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
            partyId: createdTxn.contactId,
            partyType: createdTxn.contactType === CONTACT_TYPE.CUSTOMER ? LEDGER_PARTY_TYPES.CUSTOMER : LEDGER_PARTY_TYPES.VENDOR,
            narration: createdTxn.contactType === CONTACT_TYPE.CUSTOMER ? 'Customer opening balance' : 'Vendor opening balance',
            addedBy: userId,
            currencyId: createdTxn.currency,
            exchangeRate: createdTxn.exchangeRate,
            isSplit: createdTxn.isSplit === true,
          },
          session,
        );
      }

      // Bidirectional linking: Sync both sides when linking/unlinking
      const isLinkedToVendor = updateBody.isLinkedToVendor;

      if (role) {
        // Customer side: Handle vendorId changes
        const oldVendorId = customer?.vendorId ? customer.vendorId.toString() : null;
        const newVendorId = updatedCustomer?.vendorId ? updatedCustomer.vendorId.toString() : null;

        // Linking: Update vendor to link back to this customer
        if (isLinkedToVendor && newVendorId) {
          await Customer.findByIdAndUpdate(
            newVendorId,
            { $set: { customerId: customerId, isLinkedToVendor: true } },
            { session },
          );
        }

        // Handle unlinking scenarios
        if (oldVendorId) {
          if (!isLinkedToVendor || oldVendorId !== newVendorId) {
            await Customer.findByIdAndUpdate(oldVendorId, { $unset: { customerId: '', isLinkedToVendor: false } }, { session });
          }
        }
      } else {
        // Vendor side: Handle customerId changes
        const oldCustomerId = customer?.customerId ? customer.customerId.toString() : null;
        const newCustomerId = updatedCustomer?.customerId ? updatedCustomer.customerId.toString() : null;

        if (isLinkedToVendor && newCustomerId) {
          // Linking: Update customer to link back to this vendor
          await Customer.findByIdAndUpdate(
            newCustomerId,
            { $set: { vendorId: customerId, isLinkedToVendor: true } },
            { session },
          );
        }

        // Handle unlinking scenarios
        if (oldCustomerId) {
          if (!isLinkedToVendor || oldCustomerId !== newCustomerId) {
            await Customer.findByIdAndUpdate(oldCustomerId, { $unset: { vendorId: '', isLinkedToVendor: false } }, { session });
          }
        }
      }
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to update customer: ${error.message}`);
  } finally {
    await session.endSession();
  }

  // Check if portal invite should be sent or disabled
  // Safely check if portal-related fields exist
  const enablePortalChanged = updateBody?.otherDetails?.enablePortal !== undefined;
  const enablePortalEnabled = updateBody?.otherDetails?.enablePortal === true;
  const wasPortalEnabled = customer?.otherDetails?.enablePortal === true;
  const wasPortalDisabled = !customer?.otherDetails?.enablePortal;
  const emailChanged = updateBody?.bpEmail !== undefined;
  const hasEmail =
    updatedCustomer?.bpEmail && typeof updatedCustomer.bpEmail === 'string' && updatedCustomer.bpEmail.trim().length > 0;
  const hasValidIds = updatedCustomer?._id && updatedCustomer?.companyId;

  // Disable portal access if enablePortal is being changed from true to false
  if (enablePortalChanged && wasPortalEnabled && !enablePortalEnabled && hasEmail && hasValidIds) {
    try {
      await disablePortalAccess(updatedCustomer._id, updatedCustomer.companyId, updatedCustomer.bpEmail.trim());
      logger.info(`Portal access disabled for ${updatedCustomer.bpEmail} for customer ${updatedCustomer._id}`);
    } catch (error) {
      // Log error but don't fail customer update
      logger.error(`Failed to disable portal access for customer ${updatedCustomer._id}:`, error);
    }
  }

  // Enable portal access if enablePortal is being changed from false to true
  if (enablePortalChanged && wasPortalDisabled && enablePortalEnabled && hasEmail && hasValidIds) {
    const updatePortalFeatures = await activeFeatureList(updatedCustomer.companyId);
    if (!updatePortalFeatures?.[PLAN_FEATURES.CUSTOMER_ORDER]) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Please upgrade your plan to enable customer portal access');
    }
    try {
      // Check if link already exists - if yes, just enable it; if no, send invite
      const linkExists = await enablePortalAccess(updatedCustomer._id, updatedCustomer.companyId, updatedCustomer.bpEmail.trim());

      if (linkExists) {
        logger.info(`Portal access enabled for existing link ${updatedCustomer.bpEmail} for customer ${updatedCustomer._id}`);
      } else {
        // No link exists, send invite to create new portal user
        await sendPortalInvite(
          updatedCustomer._id,
          updatedCustomer.companyId,
          updatedCustomer.bpEmail.trim(),
          updatedCustomer.customerDisplayName || updatedCustomer.companyName || 'Valued Customer',
        );
        logger.info(`Portal invite sent to ${updatedCustomer.bpEmail} for customer ${updatedCustomer._id}`);
      }
    } catch (error) {
      // Log error but don't fail customer update
      logger.error(`Failed to enable portal access for customer ${updatedCustomer._id}:`, error);
    }
  }

  // Send portal invite if:
  // 1. enablePortal is already true and email is being set/updated (and no link exists yet)
  if (
    hasEmail &&
    hasValidIds &&
    updatedCustomer?.otherDetails?.enablePortal === true &&
    !enablePortalChanged &&
    customer?.otherDetails?.enablePortal === true &&
    emailChanged
  ) {
    try {
      // Check if link already exists - if yes, just enable it; if no, send invite
      const linkExists = await enablePortalAccess(updatedCustomer._id, updatedCustomer.companyId, updatedCustomer.bpEmail.trim());

      if (linkExists) {
        logger.info(`Portal access enabled for existing link ${updatedCustomer.bpEmail} for customer ${updatedCustomer._id}`);
      } else {
        // No link exists, send invite to create new portal user
        await sendPortalInvite(
          updatedCustomer._id,
          updatedCustomer.companyId,
          updatedCustomer.bpEmail.trim(),
          updatedCustomer.customerDisplayName || updatedCustomer.companyName || 'Valued Customer',
        );
        logger.info(`Portal invite sent to ${updatedCustomer.bpEmail} for customer ${updatedCustomer._id}`);
      }
    } catch (error) {
      // Log error but don't fail customer update
      logger.error(`Failed to send portal invite for customer ${updatedCustomer._id}:`, error);
    }
  }

  const customerObj = await Customer.findById(updatedCustomer._id).lean();
  const currencyDoc = customerObj?.otherDetails?.currency
    ? await getCurrency(customerObj.companyId, customerObj.otherDetails.currency)
    : null;
  return {
    ...customerObj,
    otherDetails: { ...customerObj.otherDetails, currency: currencyDoc },
  };
};

const deleteCustomer = async (customerId, companyId) => {
  const { Customer, Quote, SalesOrder, PaymentReceived, OpeningBalanceTransaction, Item } = getBooksCrmModels();
  const {
    Invoice,
    DeliveryChallan,
    CreditNote,
    RecurringInvoice,
    CustomerOrder,
    RejectionOrder,
    Expenses,
    Bill,
    PurchaseOrder,
    GrpoOrder,
    DebitNote,
    PaymentMade,
    RecurringBills,
    RecurringExpense,
    CustomerPortalUser,
    PortalInviteToken,
  } = getBooksModels();
  const { Call } = getCrmModels();

  const customer = await Customer.findOne({ _id: customerId, companyId });

  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  // Opening balance transactions have no delete UI of their own, so they aren't a blocking
  // reference here — deleting the customer instead reverses their effect below (OB rows +
  // their ledger journals). Anything applied against an OB txn (a payment/invoice/bill) still
  // blocks deletion via its own check.
  const referenceChecks = [
    Quote.exists({ customerId, companyId }),
    SalesOrder.exists({ customerId, companyId }),
    PaymentReceived.exists({ customerId, companyId }),
    Invoice.exists({ customerId, companyId }),
    DeliveryChallan.exists({ customerId, companyId }),
    CreditNote.exists({ customerId, companyId }),
    RecurringInvoice.exists({ customerId, companyId }),
    CustomerOrder.exists({ customerId, companyId }),
    RejectionOrder.exists({ customerId, companyId }),
    Expenses.exists({ party: customerId, companyId }),
    Bill.exists({ $or: [{ vendor: customerId }, { customer: customerId }], companyId }),
    PurchaseOrder.exists({ $or: [{ vendor: customerId }, { customer: customerId }], companyId }),
    GrpoOrder.exists({ $or: [{ vendor: customerId }, { customer: customerId }], companyId }),
    DebitNote.exists({ $or: [{ vendorId: customerId }, { customer: customerId }], companyId }),
    PaymentMade.exists({ vendorId: customerId, companyId }),
    RecurringBills.exists({ $or: [{ vendorId: customerId }, { customerId }], companyId }),
    RecurringExpense.exists({ customer: customerId, companyId }),
    CustomerPortalUser.exists({ 'links.customerId': customerId }),
    PortalInviteToken.exists({ customerId, companyId }),
    Customer.exists({ _id: { $ne: customerId }, companyId, $or: [{ vendorId: customerId }, { customerId }] }),
    Item.exists({
      companyId,
      'salesData.specificCustomers': customerId,
    }),
    Call.exists({ customerId, companyId }),
  ];

  const references = await Promise.all(referenceChecks);
  if (references.some(Boolean)) {
    const message = customer.Role?.isCustomer ? CUSTOMER_MESSAGES.DELETE_IN_USE_CUSTOMER : CUSTOMER_MESSAGES.DELETE_IN_USE_VENDOR;
    throw new ApiError(httpStatus.BAD_REQUEST, message);
  }

  const connection = getClientConnection();
  const session = await connection.startSession();

  try {
    await session.withTransaction(async () => {
      const openingBalanceTxns = await OpeningBalanceTransaction.find({ contactId: customerId, companyId })
        .select('_id')
        .session(session)
        .lean();

      for (const obTxn of openingBalanceTxns) {
        await ledgerService.deleteJournal(
          {
            companyId,
            sourceModule: { $in: [LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, LEDGER_SOURCE_MODULES.OPENING_BALANCE] },
            sourceId: obTxn._id,
          },
          session,
        );
      }

      if (openingBalanceTxns.length > 0) {
        await OpeningBalanceTransaction.deleteMany({ contactId: customerId, companyId }, { session });
      }

      await Customer.deleteOne({ _id: customerId, companyId }, { session });
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to delete customer: ${error.message}`);
  } finally {
    await session.endSession();
  }

  return customer;
};

const getVendors = async (filter, options) => {
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const { DebitNote } = getBooksModels();

  const query = {
    'Role.isVendor': true,
    companyId: filter.companyId,
    isActive: true,
  };

  if (filter.branchId) {
    query.branch = {
      $elemMatch: {
        branchId: new mongoose.Types.ObjectId(filter.branchId),
        isActive: true,
      },
    };
  }

  const vendors = await Customer.find(query)
    .select(
      `customerDisplayName customerNumber address companyName customerPhoneNumber
     otherDetails.gstinUin otherDetails.currency type companyId branch vendorId customerId isVendorDirectTax`,
    )
    .populate('vendorId', 'customerDisplayName companyName _id customerNumber')
    .populate('customerId', 'customerDisplayName companyName _id customerNumber');

  const currencies = await getCurrency(
    filter.companyId,
    vendors.map(v => v.otherDetails?.currency),
  );
  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));

  const arr = [];
  for (let i of vendors) {
    const company = await Company.findById(i.companyId).select('email contactPhone');

    const creditNote = await DebitNote.aggregate([
      {
        $match: { vendorId: i._id },
      },
      {
        $group: {
          _id: null,
          availableBalanceSum: { $sum: '$availableBalance' },
        },
      },
    ]);

    const availableBalance = creditNote[0]?.availableBalanceSum || 0;
    const currencyDoc = currencyMap.get(String(i.otherDetails?.currency)) ?? null;

    arr.push({ ...i.toObject(), ...company.toObject(), _id: i._id, unusedCredit: availableBalance, currency: currencyDoc });
  }

  return arr;
};

const getCustomers = async (filter, options) => {
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const { CreditNote } = getBooksModels();

  const query = {
    'Role.isCustomer': true,
    companyId: filter.companyId,
    isActive: true,
  };

  if (filter.branchId) {
    query.branch = {
      $elemMatch: {
        branchId: new mongoose.Types.ObjectId(filter.branchId),
        isActive: true,
      },
    };
  }

  const customers = await Customer.find(query)
    .select(
      'customerDisplayName customerNumber address companyName customerPhoneNumber otherDetails.priceList otherDetails.currency otherDetails.gstinUin companyLogo companyId branch vendorId customerId isCustomerDirectTax',
    )
    .populate('otherDetails.priceList')
    .populate('vendorId', 'customerDisplayName companyName _id')
    .populate('customerId', 'customerDisplayName companyName _id')
    .lean();

  if (customers.length === 0) {
    return [];
  }

  const currencies = await getCurrency(
    filter.companyId,
    customers.map(c => c.otherDetails?.currency),
  );
  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));

  const customerIds = customers.map(c => c._id);
  const companyIds = [...new Set(customers.map(c => c.companyId?.toString()).filter(Boolean))];

  const [companies, creditNoteSums] = await Promise.all([
    Company.find({ _id: { $in: companyIds } })
      .select('email contactPhone')
      .lean(),
    CreditNote.aggregate([
      { $match: { customerId: { $in: customerIds } } },
      { $group: { _id: '$customerId', availableBalanceSum: { $sum: '$availableBalance' } } },
    ]),
  ]);

  const companyMap = new Map(companies.map(c => [c._id.toString(), c]));
  const creditMap = new Map(creditNoteSums.map(c => [c._id.toString(), c.availableBalanceSum || 0]));

  return customers.map(c => {
    const company = companyMap.get(c.companyId?.toString()) || {};
    const unusedCredit = creditMap.get(c._id.toString()) ?? 0;
    const currencyDoc = currencyMap.get(String(c.otherDetails?.currency)) ?? null;

    const { currency, ...otherDetails } = c.otherDetails || {};

    return {
      ...c,
      id: c._id,
      otherDetails,
      currency: currencyDoc,
      ...company,
      unusedCredit,
    };
  });
};

function omitOpeningBalanceOnlyPaymentReceived(rows) {
  return (rows || []).filter(doc => {
    const hasInvoices = Array.isArray(doc.invoices) && doc.invoices.length > 0;
    const hasOb = Array.isArray(doc.openingBalanceTransactions) && doc.openingBalanceTransactions.length > 0;
    return !(hasOb && !hasInvoices);
  });
}

function omitOpeningBalanceOnlyPaymentMade(rows) {
  return (rows || []).filter(doc => {
    const hasBills = Array.isArray(doc.bills) && doc.bills.length > 0;
    const hasOb = Array.isArray(doc.openingBalanceTransactions) && doc.openingBalanceTransactions.length > 0;
    return !(hasOb && !hasBills);
  });
}

const countPaymentReceivedExcludingObOnly = async (PaymentReceived, filter) => {
  const rows = await PaymentReceived.find(filter).select('invoices openingBalanceTransactions').lean();
  return omitOpeningBalanceOnlyPaymentReceived(rows).length;
};

const countPaymentMadeExcludingObOnly = async (PaymentMade, filter) => {
  const rows = await PaymentMade.find(filter).select('bills openingBalanceTransactions').lean();
  return omitOpeningBalanceOnlyPaymentMade(rows).length;
};

const getCustomerById = async (customerId, companyId, isSplit) => {
  const { Customer, SalesOrder, Quote, PaymentReceived, OpeningBalanceTransaction } = getBooksCrmModels();
  const { CompanySettings, User } = getCommonModels();

  const {
    Invoice,
    DeliveryChallan,
    CreditNote,
    PurchaseOrder,
    GrpoOrder,
    Bill,
    PaymentMade,
    DebitNote,
    CustomerPortalUser,
    Expenses,
  } = getBooksModels();

  const customer = await Customer.findOne({ _id: customerId, companyId })
    .populate('branch.branchId', 'name')
    .populate('branch.divisionId', 'name')
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .populate('otherDetails.priceList', 'priceListName')
    .populate('vendorId', 'customerDisplayName companyName customerNumber')
    .populate('customerId', 'customerDisplayName companyName customerNumber');

  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const currencyDoc = customer.otherDetails?.currency ? await getCurrency(companyId, customer.otherDetails.currency) : null;

  let branch = customer?.branch || [];
  const getBranchConfig = await CompanySettings.findOne({ companyId: customer.companyId }).select('branchConfig');
  const { branchId } = getBranchConfig?.branchConfig || {};

  if (branchId && customer?.branch?.length) {
    const branchIdStr = branchId.toString();

    branch = customer.branch.map(b => {
      const currentBranchId = b?.branchId?._id?.toString();
      const branchdata = b.toObject();
      if (currentBranchId === branchIdStr) {
        return {
          ...branchdata,
          isDefaultBranch: true,
        };
      }
      return b;
    });
  }
  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (customer.commentHistory?.length) {
    const userIds = customer.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = customer.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  const buildFilter = (baseFilter, isSplit) => {
    if (isSplit === 'false' || isSplit == undefined) {
      return { ...baseFilter, isSplit: false };
    }
    return baseFilter;
  };

  const splitFilter = isSplit === 'true';
  const customerObj = customer.toObject();
  customerObj.otherDetails = { ...customerObj.otherDetails, currency: currencyDoc };

  if (customerObj.accountId) {
    const { Account } = getBooksModels();
    const controlAccount = await Account.findOne({ _id: customerObj.accountId, companyId }).select('systemAccountKey').lean();
    const accountType = controlAccount?.systemAccountKey;
    customerObj.accountType = Object.values(PARTY_ACCOUNT_TYPES).includes(accountType) ? accountType : null;
  }

  if (customerObj.vendorId && typeof customerObj.vendorId === 'object') {
    customerObj.linkedVendorName = customerObj.vendorId.customerDisplayName || customerObj.vendorId.companyName || '';
    customerObj.linkedVendorNumber = customerObj.vendorId.customerNumber || '';
    customerObj.vendorId = customerObj.vendorId._id;
  }

  if (customerObj.customerId && typeof customerObj.customerId === 'object') {
    customerObj.linkedCustomerName = customerObj.customerId.customerDisplayName || customerObj.customerId.companyName || '';
    customerObj.linkedCustomerNumber = customerObj.customerId.customerNumber || '';
    customerObj.customerId = customerObj.customerId._id;
  }

  if (customer?.Role?.isCustomer) {
    const [invoice, deliveryChallan, salesOrder, quote, paymentReceived, creditNote, expense, openingBalanceHistory] =
      await Promise.all([
        Invoice.countDocuments(buildFilter({ customerId }, isSplit)),
        DeliveryChallan.countDocuments({ customerId }),
        SalesOrder.countDocuments({ customerId }),
        Quote.countDocuments({ customerId }),
        countPaymentReceivedExcludingObOnly(PaymentReceived, buildFilter({ customerId }, isSplit)),
        CreditNote.countDocuments({ customerId }),
        Expenses.countDocuments({ companyId, party: customerId }),
        getOpeningBalanceTransactionHistory(customerId, companyId, CONTACT_TYPE.CUSTOMER),
      ]);

    customerObj.invoice = invoice;
    customerObj.deliveryChallan = deliveryChallan;
    customerObj.salesOrder = salesOrder;
    customerObj.quote = quote;
    customerObj.paymentReceived = paymentReceived;
    customerObj.creditNote = creditNote;
    customerObj.expense = expense;
    customerObj.openingBalancePaymentHistory = openingBalanceHistory?.flatHistory || [];

    if (customer?.vendorId) {
      const linkedVendorId = customer.vendorId._id || customer.vendorId;
      const [purchaseOrder, grpoOrder, bill, paymentMade, debitNote, expense, linkedOpeningBalanceHistory] = await Promise.all([
        PurchaseOrder.countDocuments({ vendor: linkedVendorId }),
        GrpoOrder.countDocuments({ vendor: linkedVendorId }),
        Bill.countDocuments(buildFilter({ vendor: linkedVendorId }, isSplit)),
        countPaymentMadeExcludingObOnly(PaymentMade, { vendorId: linkedVendorId, isSplit: splitFilter }),
        DebitNote.countDocuments({ vendorId: linkedVendorId }),
        Expenses.countDocuments({ companyId, party: linkedVendorId }),
        getOpeningBalanceTransactionHistory(linkedVendorId, companyId, CONTACT_TYPE.VENDOR),
      ]);

      customerObj.linkedVendorData = {
        purchaseOrder,
        grpoOrder,
        bill,
        paymentMade,
        debitNote,
        expense,
        openingBalancePaymentHistory: linkedOpeningBalanceHistory?.flatHistory || [],
      };
    }
  }

  if (customer?.Role?.isVendor) {
    const [purchaseOrder, grpoOrder, bill, paymentMade, debitNote, expense, openingBalanceHistory] = await Promise.all([
      PurchaseOrder.countDocuments({ vendor: customerId }),
      GrpoOrder.countDocuments({ vendor: customerId }),
      Bill.countDocuments(buildFilter({ vendor: customerId }, isSplit)),
      countPaymentMadeExcludingObOnly(PaymentMade, { vendorId: customerId, isSplit: splitFilter }),
      DebitNote.countDocuments({ vendorId: customerId }),
      Expenses.countDocuments({ companyId, party: customerId }),
      getOpeningBalanceTransactionHistory(customerId, companyId, CONTACT_TYPE.VENDOR),
    ]);

    customerObj.purchaseOrder = purchaseOrder;
    customerObj.grpoOrder = grpoOrder;
    customerObj.bill = bill;
    customerObj.paymentMade = paymentMade;
    customerObj.debitNote = debitNote;
    customerObj.expense = expense;
    customerObj.openingBalancePaymentHistory = openingBalanceHistory?.flatHistory || [];

    //attach linked customerData
    if (customer?.customerId) {
      const linkedCustomerId = customer.customerId._id || customer.customerId;
      const [invoice, deliveryChallan, salesOrder, quote, paymentReceived, creditNote, expense, linkedOpeningBalanceHistory] =
        await Promise.all([
          Invoice.countDocuments(buildFilter({ customerId: linkedCustomerId }, isSplit)),
          DeliveryChallan.countDocuments({ customerId: linkedCustomerId }),
          SalesOrder.countDocuments({ customerId: linkedCustomerId }),
          Quote.countDocuments({ customerId: linkedCustomerId }),
          countPaymentReceivedExcludingObOnly(PaymentReceived, buildFilter({ customerId: linkedCustomerId }, isSplit)),
          CreditNote.countDocuments({ customerId: linkedCustomerId }),
          Expenses.countDocuments({ companyId, party: linkedCustomerId }),
          getOpeningBalanceTransactionHistory(linkedCustomerId, companyId, CONTACT_TYPE.CUSTOMER),
        ]);

      customerObj.linkedCustomerData = {
        invoice,
        deliveryChallan,
        salesOrder,
        quote,
        paymentReceived,
        creditNote,
        expense,
        openingBalancePaymentHistory: linkedOpeningBalanceHistory?.flatHistory || [],
      };
    }
  }

  customerObj.branch = branch || [];
  customerObj.commentHistory = commentHistoryWithUser;
  customerObj.portalEnabled = customerObj.otherDetails?.enablePortal || false;
  customerObj.portalAccepted = customerObj.otherDetails?.isCustomerPortalActivated || false;

  const portalUserForVerification = await CustomerPortalUser.findOne({
    'links.companyId': companyId,
    'links.customerId': customerId,
  })
    .select('links')
    .lean();
  const verificationLink = portalUserForVerification?.links?.find(
    link => link.requestId && String(link.companyId) === String(companyId) && String(link.customerId) === String(customerId),
  );
  customerObj.verificationStatus = verificationLink?.status || null;
  customerObj.verificationRequestId = verificationLink?.requestId || null;
  customerObj.verificationSubmittedAt = verificationLink?.submittedAt || null;
  customerObj.verificationAcceptedAt = verificationLink?.acceptedAt || null;

  const isCustomerContact = !!customer?.Role?.isCustomer;
  customerObj.hasAvailableCredits = !!(await OpeningBalanceTransaction.exists({
    companyId: new mongoose.Types.ObjectId(companyId),
    contactId: new mongoose.Types.ObjectId(customerId),
    contactType: isCustomerContact ? CONTACT_TYPE.CUSTOMER : CONTACT_TYPE.VENDOR,
    type: isCustomerContact ? TRANSACTION_TYPE.CUSTOMER_CREDIT : TRANSACTION_TYPE.VENDOR_CREDIT,
    remainingAmount: { $gt: 0 },
  }));

  return customerObj;
};

const getVendorList = async (filter, options) => {
  const { Customer, PaymentTerm } = getBooksCrmModels();
  const { CompanySettings } = getCommonModels();

  const query = {
    'Role.isVendor': true,
    companyId: filter.companyId,
  };

  if (filter.branchId) {
    query.branch = {
      $elemMatch: {
        branchId: new mongoose.Types.ObjectId(filter.branchId),
        isActive: true,
      },
    };
  }

  const linkedVendorList = await Customer.find({ vendorId: { $exists: true, $ne: null } }).select(
    '_id customerDisplayName vendorId',
  );

  const vendorIds = linkedVendorList?.map(vendor => vendor.vendorId?.toString());

  if (filter.isActive !== undefined) {
    query.isActive = filter.isActive;
  }
  const vendors = await Customer.find(query)
    .select(
      'customerDisplayName companyName otherDetails.priceList otherDetails.currency address.billing otherDetails.gstinUin branch paymentTermsId restrictedPaymentTermsModule useBranchPaymentTerms customerNumber branch isVendorDirectTax',
    )
    .populate('otherDetails.priceList')
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  const currencies = await getCurrency(
    filter.companyId,
    vendors.map(v => v.otherDetails?.currency),
  );
  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));

  const companySettings = await CompanySettings.findOne({ companyId: filter.companyId })
    .select('purchaseCreditLimit')
    .populate({ path: 'purchaseCreditLimit.paymentTermsId', model: PaymentTerm })
    .populate({ path: 'purchaseCreditLimit.branch.paymentTermsId', model: PaymentTerm })
    .lean();
  const purchaseCreditLimit = companySettings?.purchaseCreditLimit;

  for (let i of vendors) {
    if (vendorIds.includes(i._id.toString())) {
      i.isLinked = true;
    } else {
      i.isLinked = false;
    }

    if (filter?.branchId) {
      const branchData = i.branch?.find(b => b.branchId?.toString() === filter.branchId.toString());
      i.branchCurrentBalance = Number(branchData?.currentBalance) || 0;
    }

    applyCompanyPaymentTermsFallback(i, purchaseCreditLimit, filter.branchId);

    if (i.otherDetails?.currency) {
      i.otherDetails.currency = currencyMap.get(String(i.otherDetails.currency)) ?? null;
    }
  }

  return vendors;
};

const getCustomerList = async (filter, options) => {
  const { Customer, PaymentTerm } = getBooksCrmModels();
  const { CompanySettings } = getCommonModels();

  const query = {
    'Role.isCustomer': true,
    companyId: filter.companyId,
    isActive: true,
  };

  if (filter.branchId) {
    query.branch = {
      $elemMatch: {
        branchId: new mongoose.Types.ObjectId(filter.branchId),
        isActive: true,
      },
    };
  }

  const linkedCustomerList = await Customer.find({ customerId: { $exists: true, $ne: null } }).select('_id customerId');
  const customerIds = linkedCustomerList.map(customer => customer.customerId?.toString());

  if (filter.isActive !== undefined) {
    query.isActive = filter.isActive;
  }

  const customers = await Customer.find(query)
    .select(
      'appName customerDisplayName companyName otherDetails.includePriceListItemOnly otherDetails.priceList otherDetails.currency address otherDetails.gstinUin branch paymentTermsId restrictedPaymentTermsModule useBranchPaymentTerms customerNumber branch isCustomerDirectTax',
    )
    .populate('otherDetails.priceList')
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  const currencies = await getCurrency(
    filter.companyId,
    customers.map(c => c.otherDetails?.currency),
  );
  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));

  const companySettings = await CompanySettings.findOne({ companyId: filter.companyId })
    .select('salesCreditLimit')
    .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
    .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
    .lean();
  const salesCreditLimit = companySettings?.salesCreditLimit;

  for (const customer of customers) {
    customer.isLinked = customerIds.includes(customer._id.toString());

    if (filter.branchId) {
      const branchData = customer.branch?.find(b => b.branchId?.toString() === filter.branchId.toString());

      customer.branchCurrentBalance = Number(branchData?.currentBalance) || 0;
    }

    applyCompanyPaymentTermsFallback(customer, salesCreditLimit, filter.branchId);

    if (customer.otherDetails?.currency) {
      customer.otherDetails.currency = currencyMap.get(String(customer.otherDetails.currency)) ?? null;
    }
  }

  return customers;
};

const getAllCustomerList = async (filter, options) => {
  const { Customer, PriceList, PaymentTerm } = getBooksCrmModels();
  const { CompanySettings } = getCommonModels();
  const query = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    isActive: true,
  };

  if (filter.isVendor === true || filter.isVendor === 'true') {
    query['Role.isVendor'] = true;
  } else if (filter.isCustomer === true || filter.isCustomer === 'true') {
    query['Role.isCustomer'] = true;
  }

  if (filter.branchId) {
    query.branch = {
      $elemMatch: {
        branchId: new mongoose.Types.ObjectId(filter.branchId),
        isActive: true,
      },
    };
  }

  const customers = await Customer.find(query)
    .select({
      customerDisplayName: 1,
      companyName: 1,
      appName: 1,
      'otherDetails.priceList': 1,
      'otherDetails.gstinUin': 1,
      'otherDetails.gstTreatment': 1,
      isVendorDirectTax: 1,
      'otherDetails.currency': 1,
      'address.billing': 1,
      'branch.branchId': 1,
      'branch.currentBalance': 1,
      'branch.paymentTermsId': 1,
      paymentTermsId: 1,
      restrictedPaymentTermsModule: 1,
      useBranchPaymentTerms: 1,
      vendorId: 1,
      customerId: 1,
      isLinkedToVendor: 1,
      isActive: 1,
      Role: 1,
      customerNumber: 1,
    })
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  if (!customers.length) return customers;

  const priceListIds = [...new Set(customers.map(c => c.otherDetails?.priceList?.toString()).filter(Boolean))];

  let priceListMap = new Map();
  if (priceListIds.length) {
    const priceLists = await PriceList.find({ _id: { $in: priceListIds } }).lean();
    priceListMap = new Map(priceLists.map(p => [p._id.toString(), p]));
  }

  const currencies = await getCurrency(
    filter.companyId,
    customers.map(c => c.otherDetails?.currency),
  );
  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));

  let salesCreditLimit = null;
  if (customers.some(c => c.Role?.isCustomer)) {
    const companySettings = await CompanySettings.findOne({ companyId: filter.companyId })
      .select('salesCreditLimit')
      .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
      .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
      .lean();
    salesCreditLimit = companySettings?.salesCreditLimit;
  }

  return customers.map(c => {
    if (c.Role?.isCustomer) {
      applyCompanyPaymentTermsFallback(c, salesCreditLimit, filter.branchId);
    }

    return {
      ...c,
      id: c._id,
      otherDetails: c.otherDetails
        ? {
            ...c.otherDetails,
            priceList: c.otherDetails.priceList
              ? (priceListMap.get(c.otherDetails.priceList.toString()) ?? c.otherDetails.priceList)
              : null,
            currency: c.otherDetails.currency ? (currencyMap.get(String(c.otherDetails.currency)) ?? null) : null,
          }
        : c.otherDetails,
    };
  });
};

const viewCustomer = async (customerId, companyId) => {
  const { Customer, Branch, Division } = getBooksCrmModels();
  const { CreditNote, Invoice } = getBooksModels();
  let customerObj = {};
  const customer = await Customer.findOne({ _id: customerId, companyId })
    .select(
      'customerDisplayName address companyName customerPhoneNumber bpEmail otherDetails.priceList otherDetails.currency otherDetails.gstinUin companyLogo companyId branch useBranchCreditLimit creditLimit restrictedModule paymentTermsId restrictedPaymentTermsModule useBranchPaymentTerms',
    )
    .populate('otherDetails.priceList')
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId');

  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const currencyDoc = customer.otherDetails?.currency ? await getCurrency(companyId, customer.otherDetails.currency) : null;

  const invoiceStats = await Invoice.aggregate([
    {
      $match: {
        customerId: new mongoose.Types.ObjectId(customerId),
        status: INVOICE_STATUS.PAID,
        orderToPaymentDays: { $exists: true, $gte: 0 },
      },
    },
    {
      $group: {
        _id: null,
        totalInvoices: { $sum: 1 },
        totalDays: { $sum: '$orderToPaymentDays' },
        totalWeightedDays: { $sum: { $multiply: ['$orderToPaymentDays', '$total'] } },
        totalAmount: { $sum: '$total' },
      },
    },
    {
      $addFields: {
        simpleAvg: {
          $cond: [{ $gt: ['$totalInvoices', 0] }, { $round: [{ $divide: ['$totalDays', '$totalInvoices'] }, 0] }, 0],
        },
        weightedAvg: {
          $cond: [{ $gt: ['$totalAmount', 0] }, { $round: [{ $divide: ['$totalWeightedDays', '$totalAmount'] }, 0] }, 0],
        },
      },
    },
  ]);

  const creditNote = await CreditNote.aggregate([
    {
      $match: { customerId: customer._id },
    },
    {
      $group: {
        _id: null,
        availableBalanceSum: { $sum: '$availableBalance' },
      },
    },
  ]);

  const availableBalance = creditNote[0]?.availableBalanceSum || 0;

  const branchArray = [];
  for (let i of customer?.branch) {
    const branch = await Branch.findById(i.branchId).select('name');
    const division = await Division.findById(i.divisionId).select('name');
    i.branchId = branch || {};
    i.divisionId = division || {};
    branchArray.push({ ...i.toObject() });
  }

  customerObj = { ...customer.toObject(), id: customer._id, unusedCredit: availableBalance };
  customerObj = { ...customerObj, currency: currencyDoc };
  customerObj.branch = branchArray;
  customerObj.averageDaysToPayment = invoiceStats[0]?.simpleAvg || 0;
  customerObj.weightedAvgDaysToPayment = invoiceStats[0]?.weightedAvg || 0;
  return customerObj;
};

const hasBillingAddress = customer => {
  const billing = customer?.address?.billing;
  return Boolean(billing && Object.keys(billing.toObject?.() || billing).length);
};

const getCustomerAddress = async (customerId, companyId, addressType) => {
  const { Customer } = getBooksCrmModels();
  const customer = await Customer.findById(customerId).select('address');
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (addressType === ADDRESS_TYPE.SHIPPING) {
    let addresses =
      customer?.address?.additionalShippingAddresses?.map(address => ({ ...address?.toObject(), isDefault: false })) || [];

    addresses = addresses.filter(address => address.isActive);
    if (Object.keys(customer?.address?.shipping || {}).length) {
      addresses.unshift({ ...customer?.address?.shipping?.toObject(), isDefault: true } || {});
    }
    return addresses;
  } else if (addressType === ADDRESS_TYPE.BILLING) {
    return hasBillingAddress(customer) ? [customer.address.billing.toObject?.() || customer.address.billing] : [];
  }
};

const addCustomerShippingAddress = async (customerId, companyId, address, addressType = ADDRESS_TYPE.SHIPPING) => {
  const { Customer } = getBooksCrmModels();
  const customer = await Customer.findOne({
    _id: customerId,
    companyId,
  });
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  if (addressType === ADDRESS_TYPE.BILLING) {
    // A customer has exactly one billing address; further changes go through edit.
    if (hasBillingAddress(customer)) {
      throw new ApiError(httpStatus.CONFLICT, CUSTOMER_MESSAGES.BILLING_ADDRESS_EXISTS);
    }
    customer.address.billing = address;
  } else if (!Object.keys(customer?.address?.shipping || {}).length) {
    customer.address.shipping = address;
  } else {
    customer.address.additionalShippingAddresses.push(address);
  }
  await customer.save();
  return customer;
};

const updateCustomerAddress = async (addressId, address, companyId, addressType) => {
  const { Customer } = getBooksCrmModels();
  let customer = null;
  const { isDefault, ...updatedAddress } = address;
  if (isDefault) {
    customer = await Customer.findOne({
      ...(addressType === ADDRESS_TYPE.SHIPPING && { 'address.shipping._id': addressId }),
      ...(addressType === ADDRESS_TYPE.BILLING && { 'address.billing._id': addressId }),
      companyId,
    });
  } else {
    customer = await Customer.findOne({
      ...(addressType === ADDRESS_TYPE.SHIPPING && { 'address.additionalShippingAddresses._id': addressId }),
      ...(addressType === ADDRESS_TYPE.BILLING && { 'address.billing._id': addressId }),
      companyId,
    });
  }
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (addressType === ADDRESS_TYPE.SHIPPING) {
    if (!isDefault) {
      customer.address.additionalShippingAddresses.id(addressId).set(updatedAddress);
    } else {
      customer.address.shipping.set(updatedAddress);
    }
  } else if (addressType === ADDRESS_TYPE.BILLING) {
    customer.address.billing.set(updatedAddress);
  }
  await customer.save();
  return customer;
};

const updateCustomerAddressStatus = async (addressId, companyId) => {
  const { Customer } = getBooksCrmModels();
  const customer = await Customer.findOne({
    'address.additionalShippingAddresses._id': addressId,
    companyId,
  });
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.ADDRESS_NOT_FOUND);
  }
  const address = customer.address.additionalShippingAddresses.id(addressId);
  address.isActive = !address.isActive;
  await customer.save();
  return address;
};

const getBusinessPartnerTeam = async (customerId, companyId) => {
  const { Customer } = getBooksCrmModels();
  const customer = await Customer.findOne({ _id: customerId, companyId }).select('businessPartnerTeam');
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return customer.businessPartnerTeam || [];
};

const createBusinessPartnerTeam = async (customerId, companyId, body) => {
  const { Customer } = getBooksCrmModels();
  const customer = await Customer.findOne({ _id: customerId, companyId });
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  customer.businessPartnerTeam.push(body);
  await customer.save();
  return customer.businessPartnerTeam[customer.businessPartnerTeam.length - 1];
};

const updateBusinessPartnerTeam = async (customerId, companyId, businessPartnerTeamId, body) => {
  const { Customer } = getBooksCrmModels();
  const customer = await Customer.findOne({ _id: customerId, companyId });
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  const member = customer.businessPartnerTeam.id(businessPartnerTeamId);
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.BUSINESS_PARTNER_TEAM_NOT_FOUND);
  }
  member.set(body);
  await customer.save();
  return member;
};

const deleteBusinessPartnerTeam = async (customerId, companyId, businessPartnerTeamId) => {
  const { Customer } = getBooksCrmModels();
  const customer = await Customer.findOne({ _id: customerId, companyId });
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  const member = customer.businessPartnerTeam.id(businessPartnerTeamId);
  if (!member) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.BUSINESS_PARTNER_TEAM_NOT_FOUND);
  }
  member.deleteOne();
  await customer.save();
};

const updateStatus = async (customerId, isActive, companyId) => {
  const { Customer, Quote, SalesOrder, Item } = getBooksCrmModels();
  const {
    DeliveryChallan,
    Invoice,
    PurchaseOrder,
    GrpoOrder,
    Bill,
    RecurringInvoice,
    RecurringBills,
    RecurringExpense,
    DebitNote,
    CreditNote,
  } = getBooksModels();

  const quote_restictedStatus = [QUOTE_STATUS.COMPLETED, QUOTE_STATUS.CANCELLED];

  const salesOrder_restictedStatus = [SALES_ORDER_STATUS.CANCELLED, SALES_ORDER_STATUS.COMPLETED];

  const deliveryChallan_restictedStatus = [DELIVERY_CHALLAN_STATUS.CANCELLED, DELIVERY_CHALLAN_STATUS.DELIVERED];

  const invoice_restictedStatus = [INVOICE_STATUS.PAID, INVOICE_STATUS.CANCELLED];

  const purchaseOrder_restictedStatus = [PO_STATUSES.CONVERTED, PO_STATUSES.CANCELLED];

  const grpoOrder__restictedStatus = [GRPO_STATUSES.CONVERTED, GRPO_STATUSES.CANCELLED];

  const bill_restictedStatus = [BILL_STATUSES.PAID, BILL_STATUSES.CANCELLED];

  const creditNote_restictedStatus = [CREDIT_NOTE_STATUS.USED, CREDIT_NOTE_STATUS.CANCELLED, CREDIT_NOTE_STATUS.CLOSED];

  const debitNote_restictedStatus = [DEBIT_NOTE_STATUS.USED, DEBIT_NOTE_STATUS.CANCELLED, DEBIT_NOTE_STATUS.CLOSED];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const customerRole = await Customer.findById(customerId);

  if (customerRole?.Role?.isCustomer) {
    const [quote, salesOrder, deliveryChallan, invoice, recurringInvoice, recurringExpense, creditNote] = await Promise.all([
      Quote.countDocuments({ status: { $nin: quote_restictedStatus }, companyId, customerId }),
      SalesOrder.countDocuments({ status: { $nin: salesOrder_restictedStatus }, companyId, customerId }),
      DeliveryChallan.countDocuments({ status: { $nin: deliveryChallan_restictedStatus }, companyId, customerId }),
      Invoice.countDocuments({ status: { $nin: invoice_restictedStatus }, companyId, customerId }),
      RecurringInvoice.countDocuments({
        customerId,
        status: 'ACTIVE',
        companyId,
        $or: [
          { endDate: { $gte: today } },
          { endDate: { $exists: false }, neverExpires: true },
          { endDate: null, neverExpires: true },
        ],
      }),
      RecurringExpense.countDocuments({
        customer: customerId,
        companyId,
        status: 'ACTIVE',
        $or: [
          { endDate: { $gte: today } },
          { endDate: { $exists: false }, neverExpires: true },
          { endDate: null, neverExpires: true },
        ],
      }),
      CreditNote.countDocuments({ status: { $nin: creditNote_restictedStatus }, companyId, customerId }),
    ]);

    if (!isActive && (quote || salesOrder || deliveryChallan || invoice || recurringInvoice || recurringExpense || creditNote)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Customer cannot be deactivated because it is used in active documents');
    }
  }

  if (customerRole?.Role?.isVendor) {
    const [purchaseOrder, grpoOrder, bill, recurringExpense, recurringBill, debitNote] = await Promise.all([
      PurchaseOrder.countDocuments({ status: { $nin: purchaseOrder_restictedStatus }, companyId, vendor: customerId }),
      GrpoOrder.countDocuments({ status: { $nin: grpoOrder__restictedStatus }, companyId, vendor: customerId }),
      Bill.countDocuments({ status: { $nin: bill_restictedStatus }, companyId, vendor: customerId }),
      RecurringExpense.countDocuments({
        customer: customerId,
        companyId,
        status: 'ACTIVE',
        $or: [
          { endDate: { $gte: today } },
          { endDate: { $exists: false }, neverExpires: true },
          { endDate: null, neverExpires: true },
        ],
      }),
      RecurringBills.countDocuments({
        vendorId: customerId,
        status: 'ACTIVE',
        companyId,
        $or: [
          { endDate: { $gte: today } },
          { endDate: { $exists: false }, neverExpires: true },
          { endDate: null, neverExpires: true },
        ],
      }),
      DebitNote.countDocuments({ status: { $nin: debitNote_restictedStatus }, companyId, vendorId: customerId }),
    ]);

    if (!isActive && (purchaseOrder || grpoOrder || bill || recurringExpense || recurringBill || debitNote)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Customer cannot be deactivated because it is used in active documents');
    }
  }

  const customer = await Customer.findOneAndUpdate({ _id: customerId, companyId }, { isActive });

  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return customer;
};

const resendPortalInvite = async (customerId, companyId) => {
  const { Customer } = getBooksCrmModels();

  const customer = await Customer.findOne({ _id: customerId, companyId }).lean();
  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (!customer.otherDetails?.enablePortal) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Customer portal is not enabled for this customer');
  }

  const email = customer.bpEmail?.trim();
  if (!email) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Customer does not have a valid email address');
  }

  const customerName = customer.customerDisplayName || customer.companyName || 'Customer';
  await sendPortalInvite(customerId, companyId, email, customerName);

  return { customerId, email };
};

const updateVerificationStatus = async (customerId, companyId, status) => {
  const { CustomerPortalUser } = getBooksModels();

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const customerObjectId = new mongoose.Types.ObjectId(customerId);
  const acceptedAt = new Date();

  // Atomic conditional update: only a PENDING link is flipped, so two concurrent
  // accept/reject calls can't both process the same request (no read-modify-save race).
  const result = await CustomerPortalUser.updateOne(
    {
      links: {
        $elemMatch: {
          companyId: companyObjectId,
          customerId: customerObjectId,
          requestId: { $nin: [null, ''] },
          status: VERIFICATION_LINK_STATUS.PENDING,
        },
      },
    },
    {
      $set: {
        'links.$[elem].status': status,
        ...(status === VERIFICATION_LINK_STATUS.APPROVED ? { isActive: true } : { isActive: false }),
        'links.$[elem].acceptedAt': acceptedAt,
      },
    },
    {
      // arrayFilters values are NOT cast by Mongoose — pass ObjectIds explicitly.
      arrayFilters: [
        {
          'elem.companyId': companyObjectId,
          'elem.customerId': customerObjectId,
          'elem.requestId': { $nin: [null, ''] },
          'elem.status': VERIFICATION_LINK_STATUS.PENDING,
        },
      ],
    },
  );

  if (result.modifiedCount === 0) {
    // Nothing flipped — distinguish "no such request" from "already processed" (failure path only, no race).
    const existing = await CustomerPortalUser.findOne({
      links: { $elemMatch: { companyId: companyObjectId, customerId: customerObjectId, requestId: { $nin: [null, ''] } } },
    }).select('links');
    const link = existing?.links?.find(
      l => l.requestId && String(l.companyId) === String(companyId) && String(l.customerId) === String(customerId),
    );
    if (!link) {
      throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.VERIFICATION_NOT_FOUND);
    }
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `${CUSTOMER_MESSAGES.VERIFICATION_ALREADY_PROCESSED} (already ${String(link.status || '').toLowerCase()})`,
    );
  }

  if (status === VERIFICATION_LINK_STATUS.APPROVED) {
    const { Customer } = getBooksCrmModels();
    await Customer.updateOne(
      { _id: customerObjectId, companyId: companyObjectId },
      { $set: { 'otherDetails.isCustomerPortalActivated': true, isActive: true } },
    );
  }

  return {
    customerId,
    companyId,
    verificationStatus: status,
    verificationAcceptedAt: acceptedAt,
  };
};

const getPortalCustomers = async filter => {
  const { Customer } = getBooksCrmModels();

  const query = {
    'Role.isCustomer': true,
    companyId: filter.companyId,
    isActive: true,
    'otherDetails.enablePortal': true,
  };

  const customers = await Customer.find(query).select('customerDisplayName companyId customerId customerNumber').lean();

  if (customers.length === 0) {
    return [];
  }

  return customers.map(c => {
    return { ...c, id: c._id };
  });
};

const getCustomer360Analysis = async filter => {
  const { Customer, PaymentReceived, Item, ItemGroup } = getBooksCrmModels();
  const { Invoice } = getBooksModels();

  const { customerId, companyId, isSplit } = filter;

  const customerObjectId = new mongoose.Types.ObjectId(customerId);
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const customer = await Customer.findOne({
    _id: customerObjectId,
    companyId: companyObjectId,
    'Role.isCustomer': true,
  })
    .select('customerDisplayName companyName otherDetails.gstinUin branch customerNumber')
    .lean();

  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const { fy, startDate, endDate } = resolveFinancialYearRange({ fy: filter.fy });

  const invoiceMatch = {
    companyId: companyObjectId,
    customerId: customerObjectId,
    status: { $nin: [INVOICE_STATUS.CANCELLED] },
    invoiceDate: { $gte: startDate, $lte: endDate },
  };

  if (!isSplit) {
    invoiceMatch.isSplit = { $ne: true };
  }

  const paymentMatch = {
    companyId: companyObjectId,
    customerId: customerObjectId,
    status: PAYMENT_STATUS.APPROVED,
    paymentDate: { $gte: startDate, $lte: endDate },
  };

  if (!isSplit) {
    paymentMatch.isSplit = { $ne: true };
  }

  // Single $facet aggregation replaces 5 separate Invoice round-trips (same match, same collection)
  const [invoiceFacetResult, paymentAgg, invoices] = await Promise.all([
    Invoice.aggregate([
      { $match: invoiceMatch },
      {
        $facet: {
          // Summary metrics — no unwind needed
          summary: [
            {
              $group: {
                _id: null,
                totalSales: { $sum: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
                invoiceCount: { $sum: 1 },
                totalTax: { $sum: { $multiply: [{ $ifNull: ['$totalTax', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
                // Extra charges = total − subTotal − totalTax (additionalCharges + adjustment + roundOff)
                totalExtraCharges: {
                  $sum: {
                    $multiply: [
                      {
                        $subtract: [
                          { $subtract: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$subTotal', 0] }] },
                          { $ifNull: ['$totalTax', 0] },
                        ],
                      },
                      { $ifNull: ['$exchangeRate', 1] },
                    ],
                  },
                },
              },
            },
          ],
          // Qty requires unwind of items array
          qty: [
            {
              $match: {
                $or: [
                  { isSplit: false },
                  { isSplit: { $exists: false } },
                  {
                    isSplit: true,
                    splitWiseType: { $ne: 'Split By Price' },
                  },
                ],
              },
            },
            {
              $unwind: {
                path: '$items',
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $group: {
                _id: null,
                totalQty: {
                  $sum: { $ifNull: ['$items.quantity', 0] },
                },
              },
            },
          ],
          // Discount: two-stage group avoids multiplying invoice.discount by item count
          discount: [
            { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
            {
              $group: {
                _id: '$_id',
                transactionDiscount: { $first: { $ifNull: ['$discount', 0] } },
                itemDiscount: {
                  $sum: {
                    $subtract: [
                      { $multiply: [{ $ifNull: ['$items.rate', 0] }, { $ifNull: ['$items.quantity', 0] }] },
                      { $ifNull: ['$items.amount', 0] },
                    ],
                  },
                },
              },
            },
            {
              $group: {
                _id: null,
                totalDiscount: { $sum: { $add: ['$transactionDiscount', '$itemDiscount'] } },
              },
            },
          ],
        },
      },
    ]),

    PaymentReceived.aggregate([
      { $match: paymentMatch },
      {
        $group: {
          _id: null,
          totalCollection: { $sum: { $multiply: [{ $ifNull: ['$amountReceived', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
        },
      },
    ]),

    // Select only the fields needed for in-memory monthly/insights processing
    Invoice.find(invoiceMatch)
      .select(
        'invoiceDate exchangeRate items.itemId items.itemName items.amount items.taxAmount items.quantity isSplit splitWiseType splitInvoiceId',
      )
      .lean(),
  ]);

  const invoiceFacet = invoiceFacetResult[0] || {};
  const summaryAgg = invoiceFacet.summary || [];
  const qtyAgg = invoiceFacet.qty || [];
  const discountAgg = invoiceFacet.discount || [];

  // Collect unique itemIds — deduplicating avoids passing thousands of repeated IDs to Item.find
  const itemIdSet = new Set();
  for (const invoice of invoices) {
    for (const item of invoice.items || []) {
      if (item.itemId) {
        itemIdSet.add(item.itemId.toString());
      }
    }
  }
  const itemIds = Array.from(itemIdSet).map(id => new mongoose.Types.ObjectId(id));

  // Fetch items
  const items = await Item.find({
    _id: { $in: itemIds },
  })
    .select('itemGroup')
    .lean();

  // Item map
  const itemMap = new Map();

  items.forEach(item => {
    itemMap.set(item._id.toString(), item);
  });

  // Deduplicate itemGroupIds before querying — many items can share the same group
  const itemGroupIds = [...new Set(items.map(item => item.itemGroup?.toString()).filter(Boolean))].map(
    id => new mongoose.Types.ObjectId(id),
  );

  // Fetch item groups
  const itemGroups = await ItemGroup.find({
    _id: { $in: itemGroupIds },
  })
    .select('name')
    .lean();

  // Item group map
  const itemGroupMap = new Map();

  itemGroups.forEach(group => {
    itemGroupMap.set(group._id.toString(), group.name);
  });

  // Monthly aggregation + top-5 item / group accumulators
  const monthlyMap = new Map();
  const itemSalesMap = new Map(); // itemKey → { name, sales, qty }
  const groupSalesMap = new Map(); // groupName → { sales, qty }
  const splitInvoiceMap = new Map();
  for (const invoice of invoices) {
    if (invoice.isSplit) {
      splitInvoiceMap.set(invoice._id.toString(), invoice);
    }
  }

  for (const invoice of invoices) {
    const invoiceDate = new Date(invoice.invoiceDate);
    const fxRate = invoice.exchangeRate ?? 1;

    const year = invoiceDate.getFullYear();
    const month = invoiceDate.getMonth() + 1;

    for (const invItem of invoice.items || []) {
      const sales = ((invItem.amount || 0) + (invItem.taxAmount || 0)) * fxRate;
      const qty = invItem.quantity || 0;

      // --- Top-5 items (all items, regardless of group) ---
      const itemKey = invItem.itemId?.toString() || `name:${invItem.itemName}`;
      const itemName = invItem.itemName || 'Unknown Item';
      if (!itemSalesMap.has(itemKey)) {
        itemSalesMap.set(itemKey, { name: itemName, sales: 0, qty: 0 });
      }
      const itemRow = itemSalesMap.get(itemKey);
      itemRow.sales += sales;

      const splitInvoice = invoice.splitInvoiceId ? splitInvoiceMap.get(invoice.splitInvoiceId.toString()) : null;

      const skipQty = !invoice.isSplit && splitInvoice?.splitWiseType === 'Split By Price';

      if (!skipQty) {
        itemRow.qty += qty;
      }

      // --- Monthly breakdown + group totals (require a resolvable itemGroup) ---
      const itemDoc = itemMap.get(invItem.itemId?.toString());

      if (!itemDoc?.itemGroup) continue;

      const groupName = itemGroupMap.get(itemDoc.itemGroup.toString());

      if (!groupName) continue;

      // Group totals
      if (!groupSalesMap.has(groupName)) {
        groupSalesMap.set(groupName, { sales: 0, qty: 0 });
      }
      const groupRow = groupSalesMap.get(groupName);
      groupRow.sales += sales;
      if (!skipQty) {
        groupRow.qty += qty;
      }

      // Monthly map
      const key = `${year}-${String(month).padStart(2, '0')}-${groupName}`;

      if (!monthlyMap.has(key)) {
        monthlyMap.set(key, {
          _id: {
            year,
            month,
            series: groupName,
          },
          sales: 0,
          qty: 0,
        });
      }

      const row = monthlyMap.get(key);

      row.sales += sales;
      if (!skipQty) {
        row.qty += qty;
      }
    }
  }

  // Build top-5 items
  const totalItemSales = Array.from(itemSalesMap.values()).reduce((s, v) => s + v.sales, 0);
  const top5Items = Array.from(itemSalesMap.values())
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 5)
    .map(item => ({
      name: item.name,
      sales: item.sales,
      qty: item.qty,
      contribution: totalItemSales > 0 ? +((item.sales / totalItemSales) * 100).toFixed(1) : 0,
    }));

  // Build top-5 item groups
  const totalGroupSales = Array.from(groupSalesMap.values()).reduce((s, v) => s + v.sales, 0);
  const top5ItemGroups = Array.from(groupSalesMap.entries())
    .sort((a, b) => b[1].sales - a[1].sales)
    .slice(0, 5)
    .map(([name, val]) => ({
      name,
      sales: val.sales,
      qty: val.qty,
      contribution: totalGroupSales > 0 ? +((val.sales / totalGroupSales) * 100).toFixed(1) : 0,
    }));

  const seriesMonthlyAgg = Array.from(monthlyMap.values());

  // Generate monthly buckets
  const monthlyBuckets = [];

  const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  while (cursor <= endDate) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;

    monthlyBuckets.push({
      key: `${year}-${String(month).padStart(2, '0')}`,
      year,
      month,
      monthLabel: cursor.toLocaleString('en-US', {
        month: 'short',
      }),
      displayLabel: `${cursor.toLocaleString('en-US', {
        month: 'short',
      })} '${String(year).slice(-2)}`,
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  // Build matrix
  const seriesSet = new Set();
  const seriesByMonth = new Map();

  for (const row of seriesMonthlyAgg) {
    const seriesName = row?._id?.series;

    if (!seriesName) continue;

    const monthKey = `${row._id.year}-${String(row._id.month).padStart(2, '0')}`;

    seriesSet.add(seriesName);

    if (!seriesByMonth.has(monthKey)) {
      seriesByMonth.set(monthKey, {});
    }

    seriesByMonth.get(monthKey)[seriesName] = {
      sales: row.sales || 0,
      qty: row.qty || 0,
    };
  }

  const seriesList = Array.from(seriesSet).sort((a, b) => a.localeCompare(b));

  const monthlySeries = monthlyBuckets.map(bucket => {
    const row = seriesByMonth.get(bucket.key) || {};

    const seriesValues = {};

    let grandSales = 0;
    let grandQty = 0;

    for (const seriesName of seriesList) {
      const values = row[seriesName] || {
        sales: 0,
        qty: 0,
      };

      seriesValues[seriesName] = values;

      grandSales += values.sales;
      grandQty += values.qty;
    }

    return {
      month: bucket.monthLabel,
      year: bucket.year,
      label: bucket.displayLabel,
      series: seriesValues,
      grandTotal: {
        sales: grandSales,
        qty: grandQty,
      },
    };
  });

  const outstandingBalance = (customer.branch || []).reduce((sum, branch) => sum + (branch?.currentBalance || 0), 0);

  return {
    customer: {
      id: customer._id,
      name: customer.customerDisplayName || '',
      companyName: customer.companyName || '',
      gstin: customer?.otherDetails?.gstinUin || '',
      customerNumber: customer?.customerNumber || '',
    },

    period: {
      fy,
      from: startDate,
      to: endDate,
    },

    snapshot: {
      totalInvoiceSales: summaryAgg[0]?.totalSales || 0,
      totalCollection: paymentAgg[0]?.totalCollection || 0,
      totalInvoiceItemsQty: qtyAgg[0]?.totalQty || 0,
      totalExtraCharges: summaryAgg[0]?.totalExtraCharges || 0,
      totalTax: summaryAgg[0]?.totalTax || 0,
      totalDiscount: discountAgg[0]?.totalDiscount || 0,
      outstandingBalance,
      invoiceCount: summaryAgg[0]?.invoiceCount || 0,
    },

    monthlySales: {
      itemGroups: seriesList,

      months: monthlySeries.map(monthRow => ({
        month: monthRow.month,
        year: monthRow.year,
        label: monthRow.label,
        itemGroups: monthRow.series,
        grandTotal: monthRow.grandTotal,
      })),
    },

    insights: {
      top5Items,
      top5ItemGroups,
    },
  };
};

/**
 * Suggested indexes: Invoice { companyId, customerId, status }, { companyId, customerId, dueDate, balanceAmount };
 * PaymentReceived { companyId, customerId, status, paymentDate }.
 * Monthly totals: current financial year (Apr–Mar) only; response always includes all 12 FY months (zero if no payments).
 * Approved collections use PaymentReceived.amountReceived (actual received amount, not per-invoice applied split).
 * isSplit query: true → all invoices/payments; false/omitted → isSplit { $ne: true } on invoices and payments.
 */
const buildCreditDashboardInvoiceMatch = (companyObjectId, customerObjectId, isSplit) => {
  const match = {
    companyId: companyObjectId,
    customerId: customerObjectId,
    status: { $nin: [INVOICE_STATUS.CANCELLED] },
  };
  if (!isSplit) {
    match.isSplit = { $ne: true };
  }
  return match;
};

const resolveCreditDashboardTotalCredit = customer => {
  if (!customer) {
    return 0;
  }
  const branches = customer.branch || [];
  if (customer.useBranchCreditLimit && branches.length > 0) {
    return branches.reduce((sum, b) => sum + (Number(b?.creditLimit) || 0), 0);
  }
  return Number(customer.creditLimit) || 0;
};

const getCustomerCreditDashboard = async filter => {
  const { Customer, PaymentReceived } = getBooksCrmModels();
  const { Invoice } = getBooksModels();

  const { customerId, companyId, isSplit } = filter;

  const customerObjectId = new mongoose.Types.ObjectId(customerId);
  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const now = new Date();
  const {
    startDate: fyStartDate,
    endDate: fyEndDate,
    fy: financialYearLabel,
  } = resolveFinancialYearRange({
    fy: filter.fy,
  });

  const invoiceBaseMatch = buildCreditDashboardInvoiceMatch(companyObjectId, customerObjectId, isSplit);

  const customerPromise = Customer.findOne({
    _id: customerObjectId,
    companyId: companyObjectId,
    'Role.isCustomer': true,
  })
    .select('creditLimit useBranchCreditLimit branch')
    .lean();

  const creditMetricsPromise = Invoice.aggregate([
    { $match: invoiceBaseMatch },
    {
      $facet: {
        utilized: [
          { $match: { balanceAmount: { $gt: 0 } } },
          {
            $group: {
              _id: null,
              total: { $sum: { $multiply: [{ $ifNull: ['$balanceAmount', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
            },
          },
        ],
        overdue: [
          {
            $match: {
              $expr: {
                $and: [{ $gt: ['$balanceAmount', 0] }, { $lt: ['$dueDate', { $literal: now }] }],
              },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $multiply: [{ $ifNull: ['$balanceAmount', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
            },
          },
        ],
        overdue45Days: [
          {
            $match: {
              $expr: {
                $and: [
                  { $gt: ['$balanceAmount', 0] },
                  {
                    $gt: [
                      {
                        $dateDiff: {
                          startDate: '$dueDate',
                          endDate: { $literal: now },
                          unit: 'day',
                        },
                      },
                      45,
                    ],
                  },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $multiply: [{ $ifNull: ['$balanceAmount', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
            },
          },
        ],
      },
    },
  ]);

  const paymentMatch = {
    companyId: companyObjectId,
    customerId: customerObjectId,
    status: PAYMENT_STATUS.APPROVED,
    paymentDate: { $gte: fyStartDate, $lte: fyEndDate },
  };

  if (!isSplit) {
    paymentMatch.isSplit = { $ne: true };
  }

  const monthlyPaymentsPromise = PaymentReceived.aggregate([
    { $match: paymentMatch },
    {
      $group: {
        _id: {
          y: { $year: '$paymentDate' },
          m: { $month: '$paymentDate' },
        },
        amount: { $sum: { $multiply: [{ $ifNull: ['$amountReceived', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
      },
    },
    { $sort: { '_id.y': 1, '_id.m': 1 } },
    {
      $project: {
        _id: 0,
        year: '$_id.y',
        monthNum: '$_id.m',
        amount: 1,
      },
    },
  ]);

  const [customer, creditMetrics, monthlyRows] = await Promise.all([
    customerPromise,
    creditMetricsPromise,
    monthlyPaymentsPromise,
  ]);

  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const facets = creditMetrics[0] || { utilized: [], overdue: [], overdue45Days: [] };
  const utilizedCredit = facets.utilized[0]?.total || 0;
  const overdueCredit = facets.overdue[0]?.total || 0;
  const overdue45Days = facets.overdue45Days[0]?.total || 0;

  const totalCredit = resolveCreditDashboardTotalCredit(customer);
  const availableCredit = totalCredit - utilizedCredit;

  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const amountByYearMonth = new Map();
  monthlyRows.forEach(row => {
    if (row.year != null && row.monthNum != null) {
      amountByYearMonth.set(`${row.year}-${row.monthNum}`, row.amount || 0);
    }
  });

  const fyMonthBuckets = [];
  const bucketStartYear = fyStartDate.getFullYear();
  const bucketStartMonth = fyStartDate.getMonth();
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(bucketStartYear, bucketStartMonth + i, 1);
    fyMonthBuckets.push({
      year: d.getFullYear(),
      monthNum: d.getMonth() + 1,
    });
  }

  const monthlyPayments = fyMonthBuckets.map(({ year, monthNum }) => ({
    month: `${monthLabels[monthNum - 1]} ${year}`,
    amount: amountByYearMonth.get(`${year}-${monthNum}`) ?? 0,
  }));

  const payload = {
    financialYear: financialYearLabel,
    monthlyPayments,
    creditSummary: {
      totalCredit,
      utilizedCredit,
      availableCredit,
      overdueCredit,
      overdue45Days,
    },
  };
  return payload;
};

const buildMatchStage = ({ companyId, isCustomer, isVendor }) => {
  const matchStage = {
    companyId: new mongoose.Types.ObjectId(companyId),
    isActive: { $ne: false },
  };

  if (isCustomer) {
    matchStage['Role.isCustomer'] = true;
  } else if (isVendor) {
    matchStage['Role.isVendor'] = true;
  }

  return matchStage;
};

const getPagination = options => {
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;

  return {
    limit,
    page,
    skip: (page - 1) * limit,
  };
};

const ACTIVE_BRANCHES_EXPR = {
  $filter: { input: '$branch', as: 'b', cond: { $ne: ['$$b.isActive', false] } },
};

const getCreditLimitExpression = () => ({
  $cond: [
    '$useBranchCreditLimit',
    {
      $sum: {
        $map: {
          input: ACTIVE_BRANCHES_EXPR,
          as: 'b',
          in: { $ifNull: ['$$b.creditLimit', 0] },
        },
      },
    },
    { $ifNull: ['$creditLimit', 0] },
  ],
});

const getUtilizedExpression = () => ({
  $sum: {
    $map: {
      input: ACTIVE_BRANCHES_EXPR,
      as: 'b',
      in: { $ifNull: ['$$b.currentBalance', 0] },
    },
  },
});

const parseSortStage = (sortBy, sortMapping, defaultSort = {}) => {
  if (!sortBy) {
    return defaultSort;
  }
  if (sortBy.includes(',')) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Multiple sorting is not supported');
  }

  const [field, order = 'asc'] = sortBy.split(':');
  const mappedField = sortMapping[field] || field;

  return {
    [mappedField]: order === 'desc' ? -1 : 1,
  };
};

/** Resolve a dot-notation path on an object: 'latestInvoice.dueDate' → obj.latestInvoice?.dueDate */
const getNestedValue = (obj, path) => path.split('.').reduce((curr, key) => curr?.[key], obj);

const sortResults = (results, sortStage) => {
  return results.sort((a, b) => {
    for (const [field, direction] of Object.entries(sortStage)) {
      const aVal = getNestedValue(a, field);
      const bVal = getNestedValue(b, field);
      if (aVal < bVal) return -1 * direction;
      if (aVal > bVal) return 1 * direction;
    }
    return 0;
  });
};

// ─────────────────────────────────────────────────────────────────────────────

const getCreditOverview = async filter => {
  const { Customer } = getBooksCrmModels();

  const matchStage = buildMatchStage(filter);

  const result = await Customer.aggregate([
    {
      $match: matchStage,
    },
    {
      $addFields: {
        totalCredit: getCreditLimitExpression(),
        totalUtilized: getUtilizedExpression(),
      },
    },
    {
      $addFields: {
        isOverLimit: {
          $cond: [
            {
              $and: [{ $gt: ['$totalCredit', 0] }, { $gt: ['$totalUtilized', '$totalCredit'] }],
            },
            1,
            0,
          ],
        },
      },
    },
    {
      $group: {
        _id: null,
        totalCredit: { $sum: '$totalCredit' },
        totalUtilized: {
          $sum: {
            $cond: [{ $gt: ['$totalCredit', 0] }, '$totalUtilized', 0],
          },
        },
        overLimitCount: { $sum: '$isOverLimit' },
        totalCount: { $sum: 1 },
        noCreditLimitCount: {
          $sum: { $cond: [{ $eq: ['$totalCredit', 0] }, 1, 0] },
        },
      },
    },
    {
      $project: {
        _id: 0,
        totalCredit: 1,
        totalUtilized: 1,
        totalRemaining: { $subtract: ['$totalCredit', '$totalUtilized'] },
        overLimitCount: 1,
        totalCount: 1,
        noCreditLimitCount: 1,
        utilizationRate: {
          $cond: [{ $gt: ['$totalCredit', 0] }, { $multiply: [{ $divide: ['$totalUtilized', '$totalCredit'] }, 100] }, 0],
        },
      },
    },
  ]);

  return {
    creditOverview: result[0] || {
      totalCredit: 0,
      totalUtilized: 0,
      totalRemaining: 0,
      overLimitCount: 0,
      totalCount: 0,
      noCreditLimitCount: 0,
      utilizationRate: 0,
    },
  };
};

const getCreditUtilization = async (filter, options = {}) => {
  const { Customer } = getBooksCrmModels();
  const { PaymentMade } = getBooksModels();

  const { companyId, isVendor } = filter;

  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const { limit, page, skip } = getPagination(options);

  const matchStage = buildMatchStage(filter);

  const sortMapping = {
    customer: 'customer',
    customerNumber: 'customerNumber',
    creditLimit: 'creditLimit',
    utilized: 'utilized',
    available: 'available',
    utilizationPercent: 'utilizationPercent',
    lastPayment: 'lastPayment',
  };

  const sortStage = parseSortStage(options.sortBy, sortMapping, { customer: 1 });

  // Vendors sorted by lastPayment require a cross-DB JS merge before we can
  // paginate, so we must fetch all rows for that one case.
  const isVendorLastPaymentSort = isVendor && options.sortBy?.startsWith('lastPayment');

  const pipeline = [
    { $match: matchStage },
    {
      $addFields: {
        creditLimit: getCreditLimitExpression(),
        utilized: getUtilizedExpression(),
      },
    },
    {
      $addFields: {
        available: { $subtract: ['$creditLimit', '$utilized'] },
        utilizationPercent: {
          $cond: [
            { $gt: ['$creditLimit', 0] },
            { $round: [{ $multiply: [{ $divide: ['$utilized', '$creditLimit'] }, 100] }, 2] },
            0,
          ],
        },
        customerNumber: '$customerNumber',
        customer: '$customerDisplayName',
      },
    },
    // Exclude customers/vendors with no credit limit — nothing to track
    { $match: { creditLimit: { $gt: 0 } } },
  ];

  if (!isVendor) {
    // PaymentReceived lives in the same DB — use a $lookup (single round-trip)
    pipeline.push(
      {
        $lookup: {
          from: 'paymentreceiveds',
          let: { customerId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$customerId', '$$customerId'] },
                    { $eq: ['$companyId', companyObjectId] },
                    { $in: ['$status', [PAYMENT_STATUS.APPROVED, PAYMENT_STATUS.COMPLETED]] },
                    { $ne: ['$isSplit', true] },
                  ],
                },
              },
            },
            { $sort: { paymentDate: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, paymentDate: 1 } },
          ],
          as: 'lastPayment',
        },
      },
      { $addFields: { lastPayment: { $arrayElemAt: ['$lastPayment.paymentDate', 0] } } },
    );
  }

  pipeline.push({
    $project: {
      _id: 1,
      customer: 1,
      creditLimit: 1,
      customerNumber: 1,
      utilized: 1,
      available: 1,
      utilizationPercent: 1,
      lastPayment: 1,
    },
  });

  // Sort + paginate in the DB for every case except vendor-sorted-by-lastPayment
  // (that case requires the cross-DB PaymentMade merge to happen first)
  if (!isVendorLastPaymentSort) {
    pipeline.push({ $sort: sortStage }, { $skip: skip }, { $limit: limit });
  }

  // Count only customers that actually have a credit limit set (mirrors the pipeline $match)
  const countPipeline = [
    { $match: matchStage },
    { $addFields: { creditLimit: getCreditLimitExpression() } },
    { $match: { creditLimit: { $gt: 0 } } },
    { $count: 'total' },
  ];

  // Run the main query and the total count in parallel — saves one serial round-trip
  const [customers, countResult] = await Promise.all([Customer.aggregate(pipeline), Customer.aggregate(countPipeline)]);
  const totalResults = countResult[0]?.total ?? 0;

  // PaymentMade lives in a different DB, so $lookup is not possible.
  // We query only the vendor IDs that are already in memory (page-size for normal
  // sorts, full set only for lastPayment sort).
  if (isVendor && customers.length) {
    const vendorIds = customers.map(c => c._id);

    const paymentMadeData = await PaymentMade.aggregate([
      {
        $match: {
          vendorId: { $in: vendorIds },
          companyId: companyObjectId,
          status: { $in: [PAYMENT_STATUS.APPROVED, PAYMENT_STATUS.COMPLETED] },
          isSplit: { $ne: true },
        },
      },
      { $sort: { paymentDate: -1 } },
      { $group: { _id: '$vendorId', lastPayment: { $first: '$paymentDate' } } },
    ]);

    const paymentMap = new Map(paymentMadeData.filter(item => item._id).map(item => [item._id.toString(), item.lastPayment]));

    customers.forEach(c => {
      c.lastPayment = paymentMap.get(c._id.toString()) || null;
    });
  }

  let results = customers.map(customer => ({
    customerId: customer._id,
    customer: customer.customer,
    creditLimit: customer.creditLimit,
    customerNumber: customer.customerNumber,
    utilized: customer.utilized,
    available: customer.available,
    utilizationPercent: customer.utilizationPercent,
    lastPayment: customer.lastPayment ?? null,
  }));

  // Only the vendor+lastPayment-sort path still needs JS sort + paginate
  if (isVendorLastPaymentSort) {
    results = sortResults(results, sortStage);
    results = results.slice(skip, skip + limit);
  }

  return {
    results,
    page,
    limit,
    totalPages: Math.ceil(totalResults / limit),
    totalResults,
  };
};

const OVER_LIMIT_EXCLUDED_INVOICE_STATUSES = [INVOICE_STATUS.PAID, INVOICE_STATUS.CANCELLED];
const OVER_LIMIT_EXCLUDED_BILL_STATUSES = [BILL_STATUSES.PAID, BILL_STATUSES.CANCELLED];

const getOverLimitCustomers = async (filter, options = {}) => {
  const { Customer } = getBooksCrmModels();
  const { Invoice, Bill } = getBooksModels();

  const { companyId, isVendor } = filter;
  const matchStage = buildMatchStage(filter);

  const sortMapping = {
    customerName: 'customerName',
    customerNumber: 'customerNumber',
    crossedAmount: 'crossedAmount',
    crossedSinceDays: 'crossedSinceDays',
    utilizationPercentage: 'utilizationPercentage',
    dueDate: 'latestInvoice.dueDate',
    invoiceDate: 'latestInvoice.invoiceDate',
  };

  const sortStage = parseSortStage(options.sortBy, sortMapping, { customerName: 1 });
  const { limit, page, skip } = getPagination(options);

  // Fields that can be sorted inside the DB aggregate (no invoice/bill join required)
  const DB_SORTABLE_FIELDS = new Set(['customerName', 'customerNumber', 'crossedAmount', 'utilizationPercentage']);
  const sortFieldKey = options.sortBy ? options.sortBy.split(':')[0] : null;
  const isDbSortable = !sortFieldKey || DB_SORTABLE_FIELDS.has(sortFieldKey);

  // Map logical sort key → actual DB field name used inside the aggregate $project
  const dbSortField =
    sortFieldKey === 'customerNumber'
      ? 'customerNumber'
      : sortFieldKey === 'crossedAmount'
        ? 'crossedAmount'
        : sortFieldKey === 'utilizationPercentage'
          ? 'utilizationPercentage'
          : 'customerDisplayName'; // customerName or default
  const sortDir = options.sortBy?.endsWith(':desc') ? -1 : 1;

  const basePipeline = [
    { $match: matchStage },
    {
      $addFields: {
        creditLimit: getCreditLimitExpression(),
        utilized: getUtilizedExpression(),
      },
    },
    {
      $addFields: {
        crossedAmount: { $subtract: ['$utilized', '$creditLimit'] },
        utilizationPercentage: {
          $cond: [
            { $gt: ['$creditLimit', 0] },
            { $round: [{ $multiply: [{ $divide: ['$utilized', '$creditLimit'] }, 100] }, 2] },
            0,
          ],
        },
      },
    },
    // Push the over-limit filter into MongoDB — avoids loading all customers into memory
    { $match: { creditLimit: { $gt: 0 }, crossedAmount: { $gt: 0 } } },
  ];

  const dataPipeline = [...basePipeline];
  if (isDbSortable) {
    dataPipeline.push({ $sort: { [dbSortField]: sortDir } });
    if (options.pagination !== false) {
      dataPipeline.push({ $skip: skip }, { $limit: limit });
    }
  }
  dataPipeline.push({
    $project: {
      _id: 1,
      customerDisplayName: 1,
      customerNumber: 1,
      creditLimit: 1,
      crossedAmount: 1,
      utilizationPercentage: 1,
    },
  });

  const [overLimitCustomers, countResult] = await Promise.all([
    Customer.aggregate(dataPipeline),
    Customer.aggregate([...basePipeline, { $count: 'total' }]),
  ]);

  const totalResults = countResult[0]?.total ?? 0;

  if (!overLimitCustomers.length) {
    return {
      results: [],
      totalResults,
      ...(options.pagination !== false && { page, limit, totalPages: Math.ceil(totalResults / limit) }),
    };
  }

  const customerIds = overLimitCustomers.map(c => c._id);

  const documentQuery = {
    companyId,
    isSplit: { $ne: true },
    ...(isVendor
      ? { vendor: { $in: customerIds }, status: { $nin: OVER_LIMIT_EXCLUDED_BILL_STATUSES } }
      : { customerId: { $in: customerIds }, status: { $nin: OVER_LIMIT_EXCLUDED_INVOICE_STATUSES } }),
  };

  const Model = isVendor ? Bill : Invoice;
  const dateField = isVendor ? 'billDate' : 'invoiceDate';

  const documents = await Model.find(documentQuery)
    .select(`${isVendor ? 'vendor billId billDate' : 'customerId invoiceId invoiceDate'} dueDate total balanceAmount status`)
    .sort({ [dateField]: 1 })
    .lean();

  const documentMap = documents.reduce((acc, doc) => {
    const key = (isVendor ? doc.vendor : doc.customerId).toString();
    if (!acc[key]) acc[key] = [];
    acc[key].push(doc);
    return acc;
  }, {});

  const overdueStatus = isVendor ? BILL_STATUSES.OVERDUE : SALES_ORDER_INVOICE_STATUS.OVERDUE;

  let results = overLimitCustomers.map(customer => {
    const docs = documentMap[customer._id.toString()] || [];

    let runningTotal = 0;
    let crossedDate = null;
    for (const doc of docs) {
      runningTotal += Number(doc.total || 0) * (doc.exchangeRate ?? 1);
      if (runningTotal > customer.creditLimit) {
        crossedDate = isVendor ? doc.billDate : doc.invoiceDate;
        break;
      }
    }

    const latestInvoice = [...docs].reverse().find(d => Number(d.balanceAmount) > 0) || null;

    const overdueDocs = docs.filter(d => d.status === overdueStatus);
    const overdueAmount = Number(
      overdueDocs.reduce((s, d) => s + Number(d.balanceAmount || 0) * (d.exchangeRate ?? 1), 0).toFixed(2),
    );

    return {
      customerId: customer._id,
      customerName: customer.customerDisplayName || '',
      customerNumber: customer.customerNumber || '',
      crossedAmount: Number(customer.crossedAmount.toFixed(2)),
      utilizationPercentage: customer.utilizationPercentage,
      crossedSinceDays: crossedDate ? Math.floor((Date.now() - new Date(crossedDate).getTime()) / (1000 * 60 * 60 * 24)) : null,
      overdueAmount,
      overdueCount: overdueDocs.length,
      latestInvoice,
    };
  });

  // For invoice-dependent sorts (crossedSinceDays, dueDate, invoiceDate) sort + paginate in JS
  if (!isDbSortable) {
    results = sortResults(results, sortStage);
    if (options.pagination !== false) {
      results = results.slice(skip, skip + limit);
    }
  }

  return {
    results,
    totalResults,
    ...(options.pagination !== false && {
      page,
      limit,
      totalPages: Math.ceil(totalResults / limit),
    }),
  };
};

const exportCustomers = async (query, filter) => {
  const { Customer } = getBooksCrmModels();
  const { User } = getCommonModels();

  const searchConditions = [];
  const roleConditions = [];
  const andConditions = [];

  if (filter?.status === 'ACTIVE') filter.isActive = true;
  else if (filter?.status === 'INACTIVE') filter.isActive = false;
  delete filter.status;

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());

    searchConditions.push(
      { customerNumber: searchRegex },
      { customerDisplayName: searchRegex },
      { companyName: searchRegex },
      { bpEmail: searchRegex },
      { appName: searchRegex },
      { customerPhoneNumber: searchRegex },
      { type: searchRegex },
      { 'address.shipping.state': searchRegex },
      { 'address.shipping.country': searchRegex },
      { 'address.shipping.city': searchRegex },
      { 'address.billing.state': searchRegex },
      { 'address.billing.country': searchRegex },
      { 'address.billing.city': searchRegex },
    );

    andConditions.push({ $or: searchConditions });
  }

  if (filter.appName) {
    andConditions.push({ appName: filter.appName });
  }

  if (query.isCustomer || query.isVendor) {
    if (query.isCustomer) {
      roleConditions.push({ 'Role.isCustomer': true });
    }

    if (query.isVendor) {
      roleConditions.push({ 'Role.isVendor': true });
    }

    andConditions.push({ $or: roleConditions });
  }

  if (filter.startDate && filter.endDate) {
    const endDate = new Date(filter.endDate);
    endDate.setHours(23, 59, 59, 999);
    andConditions.push({
      createdAt: {
        $gte: new Date(filter.startDate),
        $lte: endDate,
      },
    });

    delete filter.startDate;
    delete filter.endDate;
  }
  if (filter.customerDate) {
    andConditions.push({ createdAt: { $gte: new Date(filter.customerDate) } });
    delete filter.customerDate;
  }

  if (filter.country) {
    andConditions.push({
      $or: [{ 'address.billing.country': query.country }, { 'address.shipping.country': query.country }],
    });

    delete filter.country;
  }

  if (filter.state) {
    andConditions.push({
      $or: [{ 'address.billing.state': query.state }, { 'address.shipping.state': query.state }],
    });

    delete filter.state;
  }

  if (filter.city) {
    andConditions.push({
      $or: [{ 'address.billing.city': query.city }, { 'address.shipping.city': query.city }],
    });

    delete filter.city;
  }

  if (filter.verificationStatus) {
    const { CustomerPortalUser } = getBooksModels();
    const portalUsersForFilter = await CustomerPortalUser.find({
      'links.companyId': filter.companyId,
      'links.status': filter.verificationStatus,
    })
      .select('links')
      .lean();

    const matchingCustomerIds = [];
    portalUsersForFilter.forEach(portalUser => {
      portalUser.links.forEach(link => {
        if (link.requestId && String(link.companyId) === String(filter.companyId) && link.status === filter.verificationStatus) {
          matchingCustomerIds.push(link.customerId);
        }
      });
    });

    andConditions.push({ _id: { $in: matchingCustomerIds } });
    delete filter.verificationStatus;
  }

  if (andConditions.length > 0) {
    filter.$and = [...(filter.$and || []), ...andConditions];
  }

  // ================= FIND INSTEAD OF PAGINATE =================
  const results = await Customer.find(filter).sort({ createdAt: -1 }).lean();

  const currencies = await getCurrency(
    filter.companyId,
    results.map(c => c.otherDetails?.currency),
  );
  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));

  const userIds = new Set();

  results.forEach(c => {
    if (c.addedBy) {
      userIds.add(c.addedBy.toString());
    }

    const updatedById = toUpdatedByUserIdString(c.updatedBy);
    if (updatedById) userIds.add(updatedById);
  });

  const users = await User.find({
    _id: { $in: [...userIds] },
  })
    .select('firstName lastName email')
    .lean();

  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  const enrichedCustomers = results.map(customer => {
    const addedByUser = userMap.get(customer.addedBy?.toString()) || null;

    const updatedById = toUpdatedByUserIdString(customer.updatedBy);
    const updatedByUser = updatedById ? userMap.get(updatedById) || null : null;

    let creditLimit = 0;

    if (customer?.useBranchCreditLimit && customer?.branch && customer?.branch?.length > 0) {
      creditLimit = customer.branch.reduce((sum, branch) => sum + (branch?.creditLimit || 0), 0);
    } else {
      creditLimit = customer?.creditLimit || 0;
    }

    const currencyDoc = currencyMap.get(String(customer.otherDetails?.currency)) || null;

    return {
      ...customer,
      id: customer._id,
      addedBy: addedByUser,
      updatedBy: updatedByUser,
      customerNumber: customer.customerNumber || '',
      customerCreditLimit: creditLimit,
      portalEnabled: customer.otherDetails?.enablePortal || false,
      portalAccepted: customer.otherDetails?.isCustomerPortalActivated || false,
      otherDetails: { ...customer.otherDetails, currency: currencyDoc },
      address: customer?.address,
    };
  });

  return enrichedCustomers;
};

/**
 * Resolve customerNumber/branchName references, check required fields and duplicate
 * customer+branch pairs within the sheet, and split rows into valid vs invalid.
 * Shared by bulkAddCustomerOpeningBalance (create) and verifyBulkCustomerOpeningBalance (dry-run).
 * @param {Array} customerOpeningBalance - [{ customerNumber, branch: [{ branchName, openingBalance }] }]
 * @param {ObjectId} companyId
 */
const validateBulkCustomerOpeningBalance = async (customerOpeningBalance, companyId) => {
  const { Customer, Branch } = getBooksCrmModels();

  customerOpeningBalance.forEach(entry => {
    if (typeof entry.customerNumber === 'string') {
      entry.customerNumber = entry.customerNumber.trim();
    }
    (entry.branch || []).forEach(branch => {
      if (typeof branch.branchName === 'string') {
        branch.branchName = branch.branchName.trim();
      }
    });
  });

  const customerNumbers = [...new Set(customerOpeningBalance.map(entry => entry.customerNumber).filter(Boolean))];
  const branchNames = [
    ...new Set(customerOpeningBalance.flatMap(entry => (entry.branch || []).map(b => b.branchName)).filter(Boolean)),
  ];

  const [existingCustomers, existingBranches] = await Promise.all([
    customerNumbers.length ? Customer.find({ companyId, customerNumber: { $in: customerNumbers } }).lean() : [],
    branchNames.length
      ? Branch.find({
          companyId,
          name: { $in: branchNames.map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
        }).lean()
      : [],
  ]);

  const customerByNumber = new Map(existingCustomers.map(customer => [customer.customerNumber, customer]));
  const branchByName = new Map(existingBranches.map(branch => [branch.name?.toLowerCase(), branch]));

  // ---- Duplicate customer + branch pair within the sheet ----
  const pairCountInSheet = {};
  customerOpeningBalance.forEach(entry => {
    (entry.branch || []).forEach(branch => {
      if (!entry.customerNumber || !branch.branchName) return;
      const key = `${entry.customerNumber}__${branch.branchName.toLowerCase()}`;
      pairCountInSheet[key] = (pairCountInSheet[key] || 0) + 1;
    });
  });

  const invalidRecords = [];
  const validRecords = [];
  const rows = [];

  customerOpeningBalance.forEach((entry, index) => {
    const errors = [];
    const { customerNumber } = entry;
    const customer = customerByNumber.get(customerNumber);

    if (!customerNumber) {
      errors.push({ name: 'CUSTOMER_NUMBER_REQUIRED', message: 'Customer Number is required.' });
    } else if (!customer) {
      errors.push({ name: 'CUSTOMER_NOT_FOUND', message: `Customer does not exist: ${customerNumber}` });
    } else if (!customer.accountId && (entry.branch || []).some(b => (Number(b.openingBalance) || 0) !== 0)) {
      // Surface the receivable/payable-account prerequisite at the Check step
      // instead of only at Apply (where it aborts the whole batch). Only rows
      // that actually post a non-zero balance need the account.
      errors.push({
        name: 'CUSTOMER_ACCOUNT_MISSING',
        message: `Customer ${customerNumber} has no receivable/payable account assigned. Assign one before importing opening balances.`,
      });
    }

    if (!Array.isArray(entry.branch) || entry.branch.length === 0) {
      errors.push({ name: 'BRANCHES_REQUIRED', message: 'At least one branch is required.' });
    } else {
      entry.branch.forEach((branch, branchIndex) => {
        const label = `Branch ${branchIndex + 1}`;
        const branchDoc = branchByName.get(branch.branchName?.toLowerCase());
        // A 0/omitted opening balance is a no-op for this branch, so it's exempt from the
        // "already has a balance" conflict checks below — nothing is going to be written for it.
        const openingBalanceValue = Number(branch.openingBalance) || 0;

        if (!branch.branchName) {
          errors.push({ name: 'BRANCH_NAME_REQUIRED', message: `${label}: Branch Name is required.` });
        } else if (!branchDoc) {
          errors.push({ name: 'BRANCH_NOT_FOUND', message: `${label}: Branch does not exist: ${branch.branchName}` });
        } else if (customer && openingBalanceValue !== 0) {
          const existingCustomerBranch = customer.branch?.find(b => b.branchId?.toString() === branchDoc._id.toString());
          if (existingCustomerBranch?.openingBalance) {
            errors.push({
              name: 'BRANCH_OPENING_BALANCE_ALREADY_EXISTS',
              message: `${label}: Opening balance already exists for branch: ${branch.branchName}. Cannot add a new opening balance.`,
            });
          }
          if (existingCustomerBranch?.currentBalance) {
            errors.push({
              name: 'BRANCH_CURRENT_BALANCE_NOT_ZERO',
              message: `${label}: Branch ${branch.branchName} already has a current balance. Cannot add a new opening balance.`,
            });
          }
        }

        if (
          branch.openingBalance !== undefined &&
          branch.openingBalance !== null &&
          Number.isNaN(Number(branch.openingBalance))
        ) {
          errors.push({ name: 'OPENING_BALANCE_INVALID', message: `${label}: Opening Balance must be a number.` });
        } else if (
          branch.openingBalance !== undefined &&
          branch.openingBalance !== null &&
          !/^-?\d+(\.\d{1,2})?$/.test(String(branch.openingBalance).trim())
        ) {
          errors.push({
            name: 'OPENING_BALANCE_DECIMAL_INVALID',
            message: `${label}: Opening Balance must not have more than 2 decimal places.`,
          });
        }

        if (customerNumber && branch.branchName) {
          const pairKey = `${customerNumber}__${branch.branchName.toLowerCase()}`;
          if (pairCountInSheet[pairKey] > 1) {
            errors.push({
              name: 'DUPLICATE_CUSTOMER_BRANCH_IN_SHEET',
              message: `${label}: Duplicate customer + branch in sheet: ${customerNumber} / ${branch.branchName}`,
            });
          }
        }
      });
    }

    if (errors.length > 0) {
      invalidRecords.push({ rowNumber: index + 1, customerNumber: customerNumber || null, branch: entry.branch || null, errors });
    } else {
      validRecords.push(entry);
      entry.branch.forEach(branch => {
        const openingBalanceValue = Number(branch.openingBalance) || 0;
        if (!openingBalanceValue) return; // opening balance is 0 — leave this branch untouched

        rows.push({
          customer,
          branch: branchByName.get(branch.branchName.toLowerCase()),
          openingBalance: openingBalanceValue,
        });
      });
    }
  });

  return {
    totalRecords: customerOpeningBalance.length,
    validCount: validRecords.length,
    invalidCount: invalidRecords.length,
    invalidRecords,
    validRecords,
    rows,
  };
};

const bulkAddCustomerOpeningBalance = async (payload, companyId, userId) => {
  const { Customer, OpeningBalanceTransaction } = getBooksCrmModels();
  const { customerOpeningBalance = [] } = payload;

  if (!Array.isArray(customerOpeningBalance) || customerOpeningBalance.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Customer opening balance array is empty or invalid.');
  }

  const validation = await validateBulkCustomerOpeningBalance(customerOpeningBalance, companyId);

  if (validation.invalidRecords.length > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Bulk customer opening balance validation failed.', 0, {
      errors: validation.invalidRecords,
    });
  }

  const rowsByCustomerId = new Map();
  validation.rows.forEach(row => {
    const customerId = row.customer._id.toString();
    if (!rowsByCustomerId.has(customerId)) rowsByCustomerId.set(customerId, []);
    rowsByCustomerId.get(customerId).push(row);
  });

  const connection = getClientConnection();
  const session = await connection.startSession();

  try {
    await session.withTransaction(async () => {
      for (const [customerId, rows] of rowsByCustomerId) {
        const customer = await Customer.findById(customerId).session(session);
        if (!customer) continue;

        const isCustomerRole = customer.Role?.isCustomer;
        const { currency, exchangeRate } = await resolveTransactionCurrency({
          companyId: customer.companyId,
          currencyId: customer.otherDetails?.currency,
        });

        for (const { branch, openingBalance } of rows) {
          const existingBranch = customer.branch.find(b => b.branchId?.toString() === branch._id.toString());

          if (!existingBranch) {
            customer.branch.push({
              branchId: branch._id,
              branchCode: branch.branchCode,
              openingBalance,
              currentBalance: openingBalance,
              divisionId: branch.divisionId,
              isActive: true,
            });
          } else {
            // Validation guarantees a matched existing branch has a 0 opening balance and 0 current balance,
            // and rows here always carry a nonzero openingBalance (zero-balance branches are filtered out upstream)
            existingBranch.openingBalance = openingBalance;
            existingBranch.currentBalance = openingBalance;
            // A branch with a balance is in use — make sure it isn't left inactive.
            existingBranch.isActive = true;
          }

          if (!customer.accountId) {
            throw new ApiError(
              httpStatus.BAD_REQUEST,
              `No receivable/payable account is assigned on customer: ${customer.customerNumber}`,
            );
          }

          const isCredit = openingBalance < 0;
          const type = isCustomerRole
            ? isCredit
              ? TRANSACTION_TYPE.CUSTOMER_CREDIT
              : TRANSACTION_TYPE.OPENING_RECEIVABLE
            : isCredit
              ? TRANSACTION_TYPE.VENDOR_CREDIT
              : TRANSACTION_TYPE.OPENING_PAYABLE;
          const amount = Math.abs(openingBalance);
          const suffix = `${customer._id.toString().slice(-6)}-${branch._id.toString().slice(-4)}`;

          const [obTxn] = await OpeningBalanceTransaction.create(
            [
              {
                contactId: customer._id,
                contactType: isCustomerRole ? CONTACT_TYPE.CUSTOMER : CONTACT_TYPE.VENDOR,
                type,
                amount,
                currency,
                exchangeRate,
                remainingAmount: amount,
                date: new Date(),
                branchId: branch._id,
                companyId: customer.companyId,
                transactionNo: `OB-${suffix}`,
                isSplit: existingBranch?.isSplitBalance === true,
              },
            ],
            { session },
          );

          const balanceType = OB_TYPE_BALANCE[obTxn.type];
          if (!balanceType) {
            throw new ApiError(httpStatus.BAD_REQUEST, `Unsupported opening balance type: ${obTxn.type}`);
          }

          await ledgerService.postOpeningBalanceJournal(
            {
              companyId: obTxn.companyId,
              accountId: customer.accountId,
              amount: obTxn.amount,
              balanceType,
              postingDate: obTxn.date,
              sourceId: obTxn._id,
              sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
              partyId: obTxn.contactId,
              partyType: isCustomerRole ? LEDGER_PARTY_TYPES.CUSTOMER : LEDGER_PARTY_TYPES.VENDOR,
              narration: isCustomerRole ? 'Customer opening balance' : 'Vendor opening balance',
              addedBy: userId,
              currencyId: obTxn.currency,
              exchangeRate: obTxn.exchangeRate,
              isSplit: obTxn.isSplit === true,
            },
            session,
          );
        }

        await customer.save({ session });
      }
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to add customer branch opening balance: ${error.message}`);
  } finally {
    await session.endSession();
  }

  return { totalRecords: validation.totalRecords, updatedCount: rowsByCustomerId.size };
};

const verifyBulkCustomerOpeningBalance = async (customerOpeningBalance, companyId) => {
  if (!Array.isArray(customerOpeningBalance) || customerOpeningBalance.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Customer opening balance array is empty or invalid.');
  }

  const { rows, ...result } = await validateBulkCustomerOpeningBalance(customerOpeningBalance, companyId);
  return result;
};

module.exports = {
  createCustomer,
  getAllCustomers,
  updateCustomer,
  deleteCustomer,
  getVendors,
  getCustomers,
  createBulkCustomers,
  verifyBulkCustomerCreation,
  bulkAddCustomerOpeningBalance,
  verifyBulkCustomerOpeningBalance,
  getCustomerById,
  getVendorList,
  getCustomerList,
  getAllCustomerList,
  viewCustomer,
  getCustomerAddress,
  addCustomerShippingAddress,
  updateCustomerAddress,
  updateCustomerAddressStatus,
  getBusinessPartnerTeam,
  createBusinessPartnerTeam,
  updateBusinessPartnerTeam,
  deleteBusinessPartnerTeam,
  updateStatus,
  getPortalCustomers,
  getCustomer360Analysis,
  getCustomerCreditDashboard,
  getCreditOverview,
  getCreditUtilization,
  getOverLimitCustomers,
  resendPortalInvite,
  updateVerificationStatus,
  exportCustomers,
};
