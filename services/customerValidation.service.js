const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { INVOICE_STATUS, BILL_STATUSES, MODULE_NAMES } = require('../utils/enum');
const { getBooksCrmModels, getCommonModels, getBooksModels } = require('./model.service');
const { getCompanyProfile } = require('./onboard.service');
const { toIncrement } = require('../utils/money');
const { BRANCH_MESSAGES, CUSTOMER_MESSAGES } = require('../utils/messages');

const formatModuleNameForMessage = moduleName => {
  if (moduleName == null || moduleName === '') return '';
  if (typeof moduleName !== 'string') return String(moduleName);
  const parts = moduleName.split('_').filter(Boolean);
  if (parts.length === 0) return '';
  return parts.map((word, i) => (i === 0 ? word.charAt(0) + word.slice(1).toLowerCase() : word.toLowerCase())).join(' ');
};

const validateCustomerForModule = async ({
  customerId,
  branchId,
  companyId,
  totalAmount,
  previousTotal = 0,
  addressId,
  moduleName,
  session,
  models,
  skipOverdueCheck = false,
  skipAddressCheck = false,
}) => {
  const { Customer, Branch, Invoice } = models;
  const { CompanySettings } = getCommonModels();

  /* ---------------- Fetch Customer ---------------- */
  const customerData = await Customer.findOne(
    { _id: customerId, 'branch.branchId': branchId },
    {
      branch: 1,
      useBranchCreditLimit: 1,
      creditLimit: 1,
      restrictedModule: 1,
      useBranchPaymentTerms: 1,
      restrictedPaymentTermsModule: 1,
      address: 1,
      configSource: 1,
    },
  )
    .lean()
    .session(session);

  if (!customerData) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.NOT_ACTIVE_IN_BRANCH);
  }

  /* ---------------- Fetch Company ---------------- */
  const companyData = await CompanySettings.findOne({ companyId })
    .select('salesCreditLimit purchaseCreditLimit')
    .lean()
    .session(session);

  /* ---------------- Match Branch ---------------- */
  const matchedBranch = (customerData.branch || []).find(b => b.branchId?.toString() === branchId.toString());

  /* ---------------- Shipping Address Validation ---------------- */
  const shippingAddressId = skipAddressCheck
    ? null
    : await validateShippingAddress({
        companyId,
        customerId,
        addressId,
        session,
      });

  /* ============================================================
     CURRENT BALANCE → ALWAYS FROM CUSTOMER
  ============================================================ */
  let currentBalance = 0;

  if (customerData.useBranchCreditLimit) {
    currentBalance = matchedBranch?.currentBalance || 0;
  } else {
    currentBalance = (customerData.branch || []).reduce((sum, b) => sum + (b.currentBalance || 0), 0);
  }

  /* ============================================================
     RESOLVE CREDIT CONFIG (INSIDE FUNCTION)
  ============================================================ */

  let creditLimit = 0;
  let restrictedModule = [];
  let restrictedPaymentTermsModule = [];

  const isSalesModule = [
    MODULE_NAMES.QUOTATION,
    MODULE_NAMES.SALES_ORDER,
    MODULE_NAMES.DELIVERY_CHALLAN,
    MODULE_NAMES.INVOICE,
    MODULE_NAMES.EXPENSE,
  ].includes(moduleName);

  const useCustomerConfig = customerData?.configSource === true;

  /* ---------------- IF CUSTOMER CONFIG ---------------- */
  if (useCustomerConfig) {
    if (customerData.useBranchCreditLimit) {
      creditLimit = matchedBranch?.creditLimit || 0;
      restrictedModule = matchedBranch?.restrictedModule || [];
    } else {
      creditLimit = customerData.creditLimit || 0;
      restrictedModule = customerData.restrictedModule || [];
    }

    if (customerData.useBranchPaymentTerms) {
      restrictedPaymentTermsModule = matchedBranch?.restrictedPaymentTermsModule || [];
    } else {
      restrictedPaymentTermsModule = customerData.restrictedPaymentTermsModule || [];
    }
  } else {
    /* ---------------- IF COMPANY CONFIG ---------------- */
    const companyConfig = isSalesModule ? companyData?.salesCreditLimit : companyData?.purchaseCreditLimit;

    if (!companyConfig) {
      creditLimit = 0;
      restrictedModule = [];
      restrictedPaymentTermsModule = [];
    } /* ---------------- IF COMPANY CONFIG ---------------- */ else {
      const companyConfig = isSalesModule ? companyData?.salesCreditLimit : companyData?.purchaseCreditLimit;

      if (!companyConfig) {
        creditLimit = 0;
        restrictedModule = [];
        restrictedPaymentTermsModule = [];
      } else {
        const branchConfig = (companyConfig.branch || []).find(b => b.branchId?.toString() === branchId.toString());

        /* ---------- CREDIT LIMIT ---------- */
        if (companyConfig.useBranchCreditLimit) {
          creditLimit = branchConfig?.creditLimit || 0;
        } else {
          creditLimit = companyConfig.creditLimit || 0;
        }

        /* ---------- RESTRICTED MODULE ---------- */
        if (companyConfig.useBranchCreditLimit) {
          restrictedModule = branchConfig?.restrictedModule || [];
        } else {
          restrictedModule = companyConfig.restrictedModule || [];
        }

        /* ---------- PAYMENT TERM RESTRICTION ---------- */
        if (companyConfig.useBranchPaymentTerms) {
          restrictedPaymentTermsModule = branchConfig?.restrictedPaymentTermsModule || [];
        } else {
          restrictedPaymentTermsModule = companyConfig.restrictedPaymentTermsModule || [];
        }
      }
    }
  }

  /* ============================================================
     DELTA / EXPOSURE CALCULATION
  ============================================================ */
  const isBalanceUpdating = [MODULE_NAMES.INVOICE, MODULE_NAMES.EXPENSE].includes(moduleName);
  const checkAmount = isBalanceUpdating ? Math.max(totalAmount - previousTotal, 0) : totalAmount;

  /* ============================================================
     CREDIT LIMIT CHECK
  ============================================================ */
  if (creditLimit > 0 && restrictedModule.includes(moduleName) && currentBalance + checkAmount > creditLimit) {
    const remainingLimit = creditLimit - currentBalance;
    const usagePercent = Math.min(100, ((currentBalance / creditLimit) * 100).toFixed(2));

    const [branch, companyProfile] = await Promise.all([
      Branch.findById(branchId).select('name').session(session),
      getCompanyProfile(companyId, session),
    ]);

    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Credit limit exceeded. You can only proceed up to ${companyProfile?.baseCurrency?.symbol || '₹'}${remainingLimit}. Your total credit limit is ${companyProfile?.baseCurrency?.symbol || '₹'}${creditLimit}.`,
      0,
      {
        totalCreditLimit: creditLimit,
        currentUsage: currentBalance,
        remainingLimit: Math.abs(remainingLimit),
        usagePercent,
        isCreditLimitError: true,
        branchId,
        branchName: branch?.name,
      },
    );
  }

  /* ============================================================
     OVERDUE CHECK
  ============================================================ */
  if (!skipOverdueCheck && restrictedPaymentTermsModule.includes(moduleName)) {
    const overdueInvoice = await Invoice.findOne({
      customerId,
      companyId,
      status: INVOICE_STATUS.OVERDUE,
      isSplit: { $ne: true },
    }).session(session);

    if (overdueInvoice) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `There is an overdue invoice (${overdueInvoice.invoiceId}). Please settle it before creating a new ${formatModuleNameForMessage(moduleName)}.`,
      );
    }
  }

  return shippingAddressId;
};

const validateShippingAddress = async ({ companyId, customerId = null, addressId, session }) => {
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();

  let shippingAddressId = null;

  if (!customerId) {
    const company = await Company.findById(companyId).session(session);
    if (!company) throw new ApiError(httpStatus.BAD_REQUEST, 'Company not found');

    if (company?.address?._id?.toString() === addressId?.toString()) {
      shippingAddressId = company.address._id;
    } else if (company?.additionalShippingAddresses?.some(a => a?._id?.toString() === addressId?.toString())) {
      shippingAddressId = company.additionalShippingAddresses.find(a => a?._id?.toString() === addressId?.toString())?._id;
    }
  } else {
    const customer = await Customer.findById(customerId).session(session);
    if (!customer) throw new ApiError(httpStatus.BAD_REQUEST, 'Customer not found');

    if (customer?.address?.shipping?._id?.toString() === addressId?.toString()) {
      shippingAddressId = customer.address.shipping._id;
    } else if (customer?.address?.additionalShippingAddresses?.some(a => a?._id?.toString() === addressId?.toString())) {
      shippingAddressId = customer.address.additionalShippingAddresses.find(
        a => a?._id?.toString() === addressId?.toString(),
      )?._id;
    }
  }

  if (!shippingAddressId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Shipping address not found');
  }

  return shippingAddressId;
};

const validateVendorForModule = async ({
  vendorId,
  branchId,
  companyId,
  totalAmount,
  previousTotal = 0,
  addressId,
  moduleName,
  session,
  skipOverdueCheck = false,
  customerId,
  models,
}) => {
  const { Customer, Branch } = models;
  const { Bill } = getBooksModels();
  const { CompanySettings } = getCommonModels();

  /* ---------------- Vendor Exists & Branch Validation ---------------- */
  const vendorData = await Customer.findOne(
    { _id: vendorId, 'branch.branchId': branchId },
    {
      branch: 1,
      useBranchCreditLimit: 1,
      creditLimit: 1,
      restrictedModule: 1,
      useBranchPaymentTerms: 1,
      restrictedPaymentTermsModule: 1,
      configSource: 1,
      address: 1,
    },
  )
    .lean()
    .session(session);

  if (!vendorData) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.VENDOR_NOT_ACTIVE_IN_BRANCH);
  }

  /* ---------------- Shipping Address Validation ---------------- */
  const shippingAddressId = await validateShippingAddress({
    companyId,
    customerId,
    addressId,
    session,
  });

  /* ---------------- Match Branch ---------------- */
  const matchedBranch = (vendorData.branch || []).find(b => b.branchId?.toString() === branchId.toString());

  /* ---------------- Current Balance ---------------- */
  let currentBalance = 0;
  if (vendorData.useBranchCreditLimit) {
    currentBalance = matchedBranch?.currentBalance || 0;
  } else {
    currentBalance = (vendorData.branch || []).reduce((sum, b) => sum + (b.currentBalance || 0), 0);
  }

  /* ---------------- Fetch Company Purchase Config ---------------- */
  const companyData = await CompanySettings.findOne({ companyId }).select('purchaseCreditLimit').lean().session(session);

  /* ---------------- Resolve Credit Config ---------------- */
  let creditLimit = 0;
  let restrictedModule = [];
  let restrictedPaymentTermsModule = [];

  const useVendorConfig = vendorData?.configSource === true;

  if (useVendorConfig) {
    if (vendorData.useBranchCreditLimit) {
      creditLimit = matchedBranch?.creditLimit || 0;
      restrictedModule = matchedBranch?.restrictedModule || [];
    } else {
      creditLimit = vendorData.creditLimit || 0;
      restrictedModule = vendorData.restrictedModule || [];
    }

    if (vendorData.useBranchPaymentTerms) {
      restrictedPaymentTermsModule = matchedBranch?.restrictedPaymentTermsModule || [];
    } else {
      restrictedPaymentTermsModule = vendorData.restrictedPaymentTermsModule || [];
    }
  } else if (companyData?.purchaseCreditLimit) {
    const companyConfig = companyData.purchaseCreditLimit;
    const branchConfig = (companyConfig.branch || []).find(b => b.branchId?.toString() === branchId.toString());

    if (companyConfig.useBranchCreditLimit) {
      creditLimit = branchConfig?.creditLimit || 0;
      restrictedModule = branchConfig?.restrictedModule || [];
      restrictedPaymentTermsModule = branchConfig?.restrictedPaymentTermsModule || [];
    } else {
      creditLimit = companyConfig.creditLimit || 0;
      restrictedModule = companyConfig.restrictedModule || [];
      restrictedPaymentTermsModule = companyConfig.restrictedPaymentTermsModule || [];
    }
  }

  /* ---------------- Delta / Exposure Amount ---------------- */
  const isBalanceUpdating = [MODULE_NAMES.BILL].includes(moduleName);
  const checkAmount = isBalanceUpdating ? Math.max(totalAmount - previousTotal, 0) : totalAmount;

  /* ---------------- Credit Limit Check ---------------- */
  if (creditLimit > 0 && restrictedModule.includes(moduleName) && currentBalance + checkAmount > creditLimit) {
    const remainingLimit = creditLimit - currentBalance;
    const usagePercent = Math.min(100, ((currentBalance / creditLimit) * 100).toFixed(2));

    const [branch, companyProfile] = await Promise.all([
      Branch.findById(branchId).select('name').session(session),
      getCompanyProfile(companyId, session),
    ]);

    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Credit limit exceeded. You can only proceed up to ${companyProfile?.baseCurrency?.symbol || '₹'}${remainingLimit}. Your total credit limit is ${companyProfile?.baseCurrency?.symbol || '₹'}${creditLimit}.`,
      0,
      {
        totalCreditLimit: creditLimit,
        currentUsage: currentBalance,
        remainingLimit: Math.abs(remainingLimit),
        usagePercent,
        isCreditLimitError: true,
        branchId,
        branchName: branch?.name,
      },
    );
  }

  /* ---------------- Overdue Bill Check ---------------- */
  if (!skipOverdueCheck && restrictedPaymentTermsModule.includes(moduleName)) {
    const overdueBill = await Bill.findOne({
      vendor: vendorId,
      companyId,
      status: BILL_STATUSES.OVERDUE,
      isSplit: { $ne: true },
    }).session(session);

    if (overdueBill) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `There is an overdue bill (${overdueBill.billId}). Please settle it before creating a new ${formatModuleNameForMessage(moduleName)}.`,
      );
    }
  }

  return shippingAddressId;
};

// Links or re-activates the customer in the branch; runs in the caller's transaction so a failed save rolls it back.
const activateCustomerInBranch = async ({ customerId, branchId, companyId, session, models }) => {
  const { Customer, Branch } = models;

  const branch = await Branch.findOne({ _id: branchId, companyId }).select('branchCode divisionId').lean().session(session);
  if (!branch) {
    throw new ApiError(httpStatus.NOT_FOUND, BRANCH_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const reactivated = await Customer.updateOne(
    { _id: customerId, companyId, 'branch.branchId': branchId },
    { $set: { 'branch.$.isActive': true } },
    { session },
  );
  if (reactivated.matchedCount > 0) return;

  const linked = await Customer.updateOne(
    { _id: customerId, companyId, 'branch.branchId': { $ne: branchId } },
    {
      $push: {
        branch: {
          branchId: branch._id,
          branchCode: branch.branchCode,
          divisionId: branch.divisionId,
          openingBalance: 0,
          currentBalance: 0,
          isActive: true,
        },
      },
    },
    { session },
  );
  if (linked.matchedCount === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
};

const updateBranchCurrentBalance = async ({
  customerId,
  branchId,
  amount, // 🔑 can be + or -
  session,
}) => {
  const { Customer } = getBooksCrmModels();

  if (!amount || amount === 0) return;

  await Customer.updateOne(
    { _id: customerId, 'branch.branchId': branchId },
    {
      $inc: { 'branch.$[elem].currentBalance': toIncrement(amount) },
    },
    {
      arrayFilters: [{ 'elem.branchId': branchId }],
      session,
    },
  );
};

// Gets branch current balance for applying opening balance (negative = credit, positive = due).
const getBranchCurrentBalance = async ({ customerId, branchId, session }) => {
  const { Customer } = getBooksCrmModels();
  let q = Customer.findOne({ _id: customerId, 'branch.branchId': branchId }, { branch: 1 });
  if (session) {
    q = q.session(session);
  }
  const doc = await q.lean();
  if (!doc) {
    return 0;
  }
  const row = (doc.branch || []).find(b => String(b.branchId) === String(branchId));
  return row?.currentBalance ?? 0;
};

module.exports = {
  validateCustomerForModule,
  validateShippingAddress,
  validateVendorForModule,
  activateCustomerInBranch,
  updateBranchCurrentBalance,
  getBranchCurrentBalance,
};
