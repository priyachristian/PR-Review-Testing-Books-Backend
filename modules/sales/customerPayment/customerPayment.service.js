const httpStatus = require('http-status');
const mongoose = require('mongoose');
const moment = require('moment');
const { getBooksModels, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { CUSTOMER_PAYMENT_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');
const ApiError = require('../../../utils/ApiError');
const { enrichDocumentCurrency, getCurrency } = require('../../../services/currencyResolver.service');

const hydrateCustomer = (obj, customerMap) => {
  obj.customerId = customerMap[obj.customerId?.toString()] || obj.customerId;
  return obj;
};

const queryCustomerPayments = async (filter, options) => {
  const { CustomerPayment } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  const toList = value =>
    String(value || '')
      .split(',')
      .filter(Boolean);

  const filterCustomerIds = toList(filter.customerId).map(id => new mongoose.Types.ObjectId(id));
  if (filterCustomerIds.length > 0) {
    query.customerId = { $in: filterCustomerIds };
  }
  const statusArray = toList(filter.status);
  if (statusArray.length > 0) {
    query.status = { $in: statusArray };
  }
  const paymentModes = toList(filter.paymentMode);
  if (paymentModes.length > 0) {
    query.paymentMode = { $in: paymentModes };
  }
  // Same whole-day semantics as Payment Received (buildBranchDivisionOrCondition).
  if (filter.startDate && filter.endDate) {
    query.paymentDate = {
      $gte: moment(filter.startDate).startOf('day').toDate(),
      $lte: moment(filter.endDate).endOf('day').toDate(),
    };
  } else if (filter.paymentDate) {
    query.paymentDate = {
      $gte: moment(filter.paymentDate).startOf('day').toDate(),
      $lte: moment(filter.paymentDate).endOf('day').toDate(),
    };
  }
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    const matchedCustomers = await Customer.find(
      { companyId, $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }] },
      { _id: 1 },
    );
    query.$or = [
      { customerPaymentId: searchRegex },
      { reference: searchRegex },
      { customerId: { $in: matchedCustomers.map(c => c._id) } },
    ];
  }

  const [paginatedResults, totalSum, company] = await Promise.all([
    CustomerPayment.paginate(query, options),
    CustomerPayment.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: { $multiply: [{ $ifNull: ['$amount', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
        },
      },
    ]),
    Company.findById(companyId).select('baseCurrency').lean(),
  ]);
  const baseCurrency = await getCurrency(companyId, company?.baseCurrency);

  const customerIds = [...new Set(paginatedResults.results.map(p => p.customerId?.toString()).filter(Boolean))];
  const customers = await Customer.find({ _id: { $in: customerIds } })
    .select('customerDisplayName companyName')
    .lean();
  const customerMap = customers.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const populated = paginatedResults.results.map(p => hydrateCustomer(p.toObject ? p.toObject() : p, customerMap));
  const enriched = await enrichDocumentCurrency(companyId, populated);

  return {
    ...paginatedResults,
    results: enriched,
    totalAmount: totalSum[0]?.totalAmount || 0,
    currency: baseCurrency,
  };
};

const getCustomerPaymentById = async (id, companyId) => {
  const { CustomerPayment, Account, Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { User } = getCommonModels();

  const payment = await CustomerPayment.findOne({ _id: id, companyId: new mongoose.Types.ObjectId(companyId) }).lean();
  if (!payment) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Customer payment not found');
  }

  // Same name resolution as CustomerOrder: creator is the customer, later actors are users.
  const lastUpdatedByEntry =
    Array.isArray(payment.updatedBy) && payment.updatedBy.length ? payment.updatedBy[payment.updatedBy.length - 1] : null;
  const userIdSet = new Set();
  if (payment.addedByType === 'User' && payment.addedBy) userIdSet.add(payment.addedBy.toString());
  if (lastUpdatedByEntry?.updatedByType === 'User' && lastUpdatedByEntry.updatedBy)
    userIdSet.add(lastUpdatedByEntry.updatedBy.toString());
  (payment.commentHistory || [])
    .filter(h => h.addedByType === 'User' && h.addedBy)
    .forEach(h => userIdSet.add(h.addedBy.toString()));

  const invoiceIds = (payment.invoices || []).map(inv => inv.invoiceId).filter(Boolean);

  const [customer, depositToAccount, users, invoices] = await Promise.all([
    Customer.findById(payment.customerId).select('customerDisplayName companyName bpEmail customerPhoneNumber').lean(),
    // The company bank account the customer paid into.
    payment.depositToAccountId
      ? Account.findOne({ _id: payment.depositToAccountId, companyId: payment.companyId })
          .select('accountName bankDetails')
          .lean()
      : null,
    userIdSet.size ? User.find({ _id: { $in: [...userIdSet] } }, 'firstName lastName').lean() : [],
    invoiceIds.length
      ? Invoice.find({ _id: { $in: invoiceIds }, companyId: payment.companyId })
          .select('invoiceId invoiceDate dueDate total balanceAmount')
          .lean()
      : [],
  ]);

  const userMap = new Map(users.map(u => [u._id.toString(), u]));
  const invoiceMap = new Map(invoices.map(inv => [inv._id.toString(), inv]));
  const customerAsActor = customer ? { firstName: customer.customerDisplayName || '', lastName: '' } : null;
  const resolveActor = (type, actorId) => (type === 'Customer' ? customerAsActor : userMap.get(actorId?.toString()) || null);

  payment.customerId = customer || payment.customerId;
  payment.depositToAccountId = depositToAccount || payment.depositToAccountId;
  payment.addedBy = resolveActor(payment.addedByType, payment.addedBy);
  payment.updatedBy = lastUpdatedByEntry ? resolveActor(lastUpdatedByEntry.updatedByType, lastUpdatedByEntry.updatedBy) : null;
  payment.commentHistory = (payment.commentHistory || []).map(h => ({
    ...h,
    createdAt: h.timestamp,
    addedBy: resolveActor(h.addedByType, h.addedBy) || h.addedBy,
  }));
  // Populate invoice refs (same shape as PaymentReceived.invoices) for the detail table.
  payment.invoices = (payment.invoices || []).map(inv => ({
    ...inv,
    invoiceId: invoiceMap.get(inv.invoiceId?.toString()) || inv.invoiceId,
  }));

  const [enriched] = await enrichDocumentCurrency(new mongoose.Types.ObjectId(companyId), [payment]);
  return enriched;
};

const rejectCustomerPayment = async (id, companyId, rejectionReason, userId) => {
  const { CustomerPayment } = getBooksModels();
  const payment = await CustomerPayment.findOne({ _id: id, companyId: new mongoose.Types.ObjectId(companyId) });
  if (!payment) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Customer payment not found');
  }
  if (payment.status !== CUSTOMER_PAYMENT_STATUS.SUBMITTED) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Cannot reject a ${payment.status.toLowerCase()} payment.`);
  }

  payment.status = CUSTOMER_PAYMENT_STATUS.REJECTED;
  payment.rejectionReason = rejectionReason || undefined;
  payment.commentHistory.push({
    message: rejectionReason ? `Rejected: ${rejectionReason}` : 'Rejected',
    addedByType: 'User',
    addedBy: userId,
  });
  payment.updatedBy.push({ updatedByType: 'User', updatedBy: userId });
  await payment.save();
  return payment.toObject();
};

// Called after the supplier creates a real PaymentReceived from this submission. Links the two and
// marks the submission APPROVED. The PaymentReceived (and its journal) is created by its own flow.
const recordCustomerPayment = async (id, companyId, { paymentReceivedId, paymentReceivedNo }, userId) => {
  const { CustomerPayment } = getBooksModels();
  const payment = await CustomerPayment.findOne({ _id: id, companyId: new mongoose.Types.ObjectId(companyId) });
  if (!payment) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Customer payment not found');
  }
  if (payment.status === CUSTOMER_PAYMENT_STATUS.APPROVED) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This payment has already been recorded.');
  }
  if (payment.status !== CUSTOMER_PAYMENT_STATUS.SUBMITTED) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Cannot record a ${payment.status.toLowerCase()} payment.`);
  }

  payment.convertedTo.push({
    type: 'PaymentReceived',
    documentId: paymentReceivedId,
    documentNo: paymentReceivedNo,
    convertedAt: new Date(),
  });
  payment.status = CUSTOMER_PAYMENT_STATUS.APPROVED;
  payment.commentHistory.push({
    message: `Recorded as payment ${paymentReceivedNo}`,
    addedByType: 'User',
    addedBy: userId,
  });
  payment.updatedBy.push({ updatedByType: 'User', updatedBy: userId });
  await payment.save();
  return payment.toObject();
};

module.exports = {
  queryCustomerPayments,
  getCustomerPaymentById,
  rejectCustomerPayment,
  recordCustomerPayment,
};
