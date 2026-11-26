const httpStatus = require('http-status');
const { getBooksCrmModels, getBooksModels, getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const pick = require('../../../utils/pick');
const { createSearchRegex, escapeRegex } = require('../../../utils/regexUtils');
const { PAYMENT_TERM_MESSAGES } = require('../../../utils/messages');

const isPaymentTermInUse = async (paymentTermId, companyId) => {
  const { SalesOrder } = getBooksCrmModels();
  const { Invoice, Bill, PurchaseOrder, GrpoOrder, RecurringInvoice, RecurringBills } = getBooksModels();

  const counts = await Promise.all(
    [SalesOrder, Invoice, Bill, PurchaseOrder, GrpoOrder, RecurringInvoice, RecurringBills].map(Model =>
      Model.countDocuments({ paymentTermsId: paymentTermId, companyId }),
    ),
  );

  return counts.some(count => count > 0);
};

const isPaymentTermReferenced = async (paymentTermId, companyId) => {
  const { SalesOrder, Customer } = getBooksCrmModels();
  const { Invoice, Bill, PurchaseOrder, GrpoOrder, RecurringInvoice, RecurringBills } = getBooksModels();
  const { CompanySettings } = getCommonModels();

  const counts = await Promise.all([
    ...[SalesOrder, Customer, Invoice, Bill, PurchaseOrder, GrpoOrder, RecurringInvoice, RecurringBills].map(Model =>
      Model.countDocuments({ paymentTermsId: paymentTermId, companyId }),
    ),
    CompanySettings.countDocuments({
      companyId,
      $or: [
        { 'salesCreditLimit.paymentTermsId': paymentTermId },
        { 'salesCreditLimit.branch.paymentTermsId': paymentTermId },
        { 'purchaseCreditLimit.paymentTermsId': paymentTermId },
        { 'purchaseCreditLimit.branch.paymentTermsId': paymentTermId },
      ],
    }),
  ]);

  return counts.some(count => count > 0);
};

const createPaymentTerm = async (body, userId) => {
  const { PaymentTerm } = getBooksCrmModels();

  const existing = await PaymentTerm.findOne({
    companyId: body.companyId,
    name: { $regex: new RegExp(`^${escapeRegex(body.name)}$`, 'i') },
  });
  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, 'A payment term with this name already exists for this company');
  }

  return PaymentTerm.create({
    companyId: body.companyId,
    name: body.name,
    days: body.days,
    isDefault: false,
    isActive: true,
    createdBy: userId,
  });
};

const queryPaymentTerms = async query => {
  const { PaymentTerm } = getBooksCrmModels();
  const filter = pick(query, ['companyId', 'isActive', 'isDefault']);
  const options = pick(query, ['sortBy', 'limit', 'page', 'pagination']);

  if (query.name) {
    filter.name = createSearchRegex(query.name.trim());
  }

  return PaymentTerm.paginate(filter, options);
};

const getPaymentTermsDropdown = async companyId => {
  const { PaymentTerm } = getBooksCrmModels();
  return PaymentTerm.find({ companyId, isActive: true }, { name: 1, days: 1, isDefault: 1 }).sort({ name: 1 });
};

const getPaymentTermById = async (paymentTermId, companyId) => {
  const { PaymentTerm } = getBooksCrmModels();
  const paymentTerm = await PaymentTerm.findOne({ _id: paymentTermId, companyId });
  if (!paymentTerm) {
    throw new ApiError(httpStatus.NOT_FOUND, PAYMENT_TERM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return paymentTerm;
};

const updatePaymentTermById = async (paymentTermId, updateBody, userId) => {
  const { PaymentTerm } = getBooksCrmModels();
  const paymentTerm = await PaymentTerm.findOne({ _id: paymentTermId, companyId: updateBody.companyId });
  if (!paymentTerm) {
    throw new ApiError(httpStatus.NOT_FOUND, PAYMENT_TERM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (paymentTerm.isSystemGenerated) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A system generated payment term cannot be edited');
  }

  if (updateBody.name) {
    const existing = await PaymentTerm.findOne({
      _id: { $ne: paymentTermId },
      companyId: paymentTerm.companyId,
      name: { $regex: new RegExp(`^${escapeRegex(updateBody.name)}$`, 'i') },
    });
    if (existing) {
      throw new ApiError(httpStatus.CONFLICT, 'A payment term with this name already exists for this company');
    }
  }

  if (updateBody.days !== undefined && updateBody.days !== paymentTerm.days) {
    const inUse = await isPaymentTermInUse(paymentTermId, paymentTerm.companyId);
    if (inUse) {
      throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_TERM_MESSAGES.DAYS_UPDATE_RESTRICTED);
    }
    paymentTerm.days = updateBody.days;
  }

  if (updateBody.name !== undefined) paymentTerm.name = updateBody.name;
  paymentTerm.updatedBy = userId;

  await paymentTerm.save();
  return paymentTerm;
};

const updateStatus = async (paymentTermId, isActive, companyId, userId) => {
  const { PaymentTerm } = getBooksCrmModels();
  const paymentTerm = await PaymentTerm.findOne({ _id: paymentTermId, companyId });
  if (!paymentTerm) {
    throw new ApiError(httpStatus.NOT_FOUND, PAYMENT_TERM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (paymentTerm.isDefault) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'The default payment term cannot be deactivated');
  }

  paymentTerm.isActive = isActive;
  paymentTerm.updatedBy = userId;
  await paymentTerm.save();

  return paymentTerm;
};

const setDefaultPaymentTerm = async (paymentTermId, companyId, userId) => {
  const { PaymentTerm } = getBooksCrmModels();

  const paymentTerm = await PaymentTerm.findOne({ _id: paymentTermId, companyId });
  if (!paymentTerm) {
    throw new ApiError(httpStatus.NOT_FOUND, PAYMENT_TERM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (!paymentTerm.isActive) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'An inactive payment term cannot be set as default');
  }

  if (paymentTerm.isDefault) {
    return paymentTerm;
  }

  await PaymentTerm.updateMany(
    { companyId, isDefault: true, _id: { $ne: paymentTermId } },
    { isDefault: false, updatedBy: userId },
  );

  paymentTerm.isDefault = true;
  paymentTerm.updatedBy = userId;
  await paymentTerm.save();

  return paymentTerm;
};

const deletePaymentTermById = async (paymentTermId, companyId) => {
  const { PaymentTerm } = getBooksCrmModels();
  const paymentTerm = await PaymentTerm.findOne({ _id: paymentTermId, companyId });
  if (!paymentTerm) {
    throw new ApiError(httpStatus.NOT_FOUND, PAYMENT_TERM_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (paymentTerm.isDefault) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'The default payment term cannot be deleted');
  }

  if (paymentTerm.isSystemGenerated) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A system generated payment term cannot be deleted');
  }

  const referenced = await isPaymentTermReferenced(paymentTermId, companyId);
  if (referenced) {
    throw new ApiError(httpStatus.BAD_REQUEST, PAYMENT_TERM_MESSAGES.DELETE_RESTRICTED_IN_USE);
  }

  await paymentTerm.deleteOne();
  return paymentTerm;
};

module.exports = {
  createPaymentTerm,
  queryPaymentTerms,
  getPaymentTermsDropdown,
  getPaymentTermById,
  updatePaymentTermById,
  updateStatus,
  setDefaultPaymentTerm,
  deletePaymentTermById,
};
