/**
 * Resolve the payment terms that apply to a document for a given party (customer/vendor) + branch.
 *
 * If the customer opts into branch-specific terms, use the terms configured on the matching
 * branch entry (customer.branch[].paymentTermsId); otherwise fall back to the customer-level terms.
 *
 * @param {Object} customer - Customer doc (must include useBranchPaymentTerms, paymentTermsId, branch)
 * @param {ObjectId|string} branchId - The document's branchId (raw id; populated objects should pass their _id)
 * @returns {*} the resolved paymentTermsId, or null when none apply
 */
const resolveCustomerPaymentTermsId = (customer, branchId) => {
  if (!customer) return null;

  if (customer.useBranchPaymentTerms) {
    const branchIdStr = branchId?.toString();
    const matchedBranch = (customer.branch || []).find(b => b.branchId?.toString() === branchIdStr);
    return matchedBranch?.paymentTermsId || null;
  }

  return customer.paymentTermsId || null;
};

// Resolves CompanySettings.salesCreditLimit/purchaseCreditLimit root vs branch payment terms
const resolveCompanyPaymentTermsFallback = (creditLimitConfig, branchId) => {
  if (!creditLimitConfig) return null;

  if (creditLimitConfig.useBranchPaymentTerms && branchId) {
    const branchConfig = creditLimitConfig.branch?.find(b => b.branchId?.toString() === branchId.toString());
    return branchConfig?.paymentTermsId || null;
  }

  return creditLimitConfig.paymentTermsId || null;
};

// Fills customer's root/branch paymentTermsId from the company fallback only when both are empty
const applyCompanyPaymentTermsFallback = (customer, creditLimitConfig, branchId) => {
  if (!customer) return;

  const branchData = branchId ? customer.branch?.find(b => b.branchId?.toString() === branchId.toString()) : undefined;

  if (!customer.paymentTermsId && !branchData?.paymentTermsId) {
    const fallbackPaymentTermsId = resolveCompanyPaymentTermsFallback(creditLimitConfig, branchId);
    customer.paymentTermsId = fallbackPaymentTermsId;
    if (branchData) {
      branchData.paymentTermsId = fallbackPaymentTermsId;
    }
  }
};

module.exports = { resolveCustomerPaymentTermsId, resolveCompanyPaymentTermsFallback, applyCompanyPaymentTermsFallback };
