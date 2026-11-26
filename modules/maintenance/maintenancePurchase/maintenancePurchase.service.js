const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const moment = require('moment');
const { getClientConnection, getBooksModels, getCommonModels } = require('../../../services/model.service');
const { generateNextCode } = require('../../../utils/autoIncrementCode');
const { MAINTENANCE_PURCHASE_MESSAGES } = require('../../../utils/messages');
const { postEntries } = require('../spareStockLedger/spareStockLedger.service');
const {
  MAINTENANCE_PURCHASE_STAGE,
  PART_REQUEST_STATUS,
  SPARE_STOCK_TRANSACTION_TYPE,
  SPARE_STOCK_REFERENCE_TYPE,
} = require('@smit9313/abss-models-core/src/utils/enum');

const MP_CODE_PREFIX = 'MP-';
const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;

const escapeRegex = value => value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toUserRef = user =>
  user
    ? {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        name: [user.firstName, user.lastName].filter(Boolean).join(' '),
      }
    : null;

// Users live in the common database, so they are resolved with one batch lookup instead of populate.
const enrichPurchases = async docs => {
  const { User } = getCommonModels();
  const list = docs.map(doc => (typeof doc.toJSON === 'function' ? doc.toJSON() : doc));
  const userFields = ['raisedBy', 'approvedBy', 'addedBy', 'updatedBy'];

  const userIds = new Set();
  list.forEach(item => userFields.forEach(field => item[field] && userIds.add(item[field].toString())));
  const users = userIds.size ? await User.find({ _id: { $in: [...userIds] } }).select('firstName lastName') : [];
  const userMap = new Map(users.map(user => [user._id.toString(), user]));

  return list.map(item => {
    const result = { ...item };
    userFields.forEach(field => {
      result[field] = item[field] ? toUserRef(userMap.get(item[field].toString())) : null;
    });
    return result;
  });
};

const createMaintenancePurchase = async (data, userId) => {
  const { MaintenancePurchase, MaintenanceRequest, SparePart } = getBooksModels();
  const { companyId, items, linkedMrId, partRequestId, ...rest } = data;

  const sparePartIds = items.map(item => item.sparePartId.toString());
  if (new Set(sparePartIds).size !== sparePartIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.DUPLICATE_SPARE_PART);
  }

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    if (linkedMrId) {
      const mr = await MaintenanceRequest.exists({ _id: linkedMrId, companyId }).session(session);
      if (!mr) {
        throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.MR_NOT_FOUND);
      }
    }

    // A part request can be raised as a purchase only once.
    if (partRequestId) {
      const existing = await MaintenancePurchase.exists({ companyId, partRequestId }).session(session);
      if (existing) {
        throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.PART_REQUEST_ALREADY_PURCHASED);
      }
    }

    const foundParts = await SparePart.countDocuments({ _id: { $in: sparePartIds }, companyId, isActive: true }).session(session);
    if (foundParts !== sparePartIds.length) {
      throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.SPARE_PART_NOT_FOUND);
    }

    const purchaseItems = items.map(item => ({
      sparePartId: item.sparePartId,
      requestedQty: item.requestedQty,
      receivedQty: 0,
      rate: item.rate,
      amount: roundMoney(item.requestedQty * item.rate),
    }));
    const totalAmount = roundMoney(purchaseItems.reduce((sum, item) => sum + item.amount, 0));

    const docNo = await generateNextCode(MaintenancePurchase, companyId, 'docNo', MP_CODE_PREFIX, session);

    await MaintenancePurchase.create(
      [
        {
          ...rest,
          companyId,
          docNo,
          stage: MAINTENANCE_PURCHASE_STAGE.PR,
          items: purchaseItems,
          totalAmount,
          ...(linkedMrId && { linkedMrId }),
          ...(partRequestId && { partRequestId }),
          prDate: new Date(),
          raisedBy: userId,
          addedBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    // The unique index on partRequestId rejects a second purchase saved at the same moment.
    if (error?.code === 11000 && error?.keyPattern?.partRequestId) {
      throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.PART_REQUEST_ALREADY_PURCHASED);
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const approveMaintenancePurchase = async (data, userId) => {
  const { MaintenancePurchase } = getBooksModels();
  const { companyId, id, items } = data;

  const purchase = await MaintenancePurchase.findOne({ _id: id, companyId });
  if (!purchase) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_PURCHASE_MESSAGES.NOT_FOUND);
  }
  if (purchase.stage !== MAINTENANCE_PURCHASE_STAGE.PR) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.APPROVE_NOT_ALLOWED);
  }

  const approvedBySparePart = new Map(items.map(item => [item.sparePartId.toString(), item.approvedQty]));
  const isExactMatch =
    approvedBySparePart.size === items.length &&
    approvedBySparePart.size === purchase.items.length &&
    purchase.items.every(item => approvedBySparePart.has(item.sparePartId.toString()));
  if (!isExactMatch) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.APPROVE_ITEMS_MISMATCH);
  }

  const approvedItems = purchase.items.map(item => {
    const approvedQty = approvedBySparePart.get(item.sparePartId.toString());
    if (approvedQty > item.requestedQty) {
      throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.APPROVED_QTY_EXCEEDS);
    }
    return { ...item.toObject(), approvedQty };
  });
  if (!approvedItems.some(item => item.approvedQty > 0)) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.APPROVE_NOTHING);
  }

  // The stage filter makes the transition atomic, so two concurrent approvals cannot both succeed.
  const result = await MaintenancePurchase.updateOne(
    { _id: id, companyId, stage: MAINTENANCE_PURCHASE_STAGE.PR },
    {
      $set: {
        items: approvedItems,
        stage: MAINTENANCE_PURCHASE_STAGE.APPROVED,
        approvedDate: new Date(),
        approvedBy: userId,
        updatedBy: userId,
      },
    },
  );
  if (!result.modifiedCount) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.APPROVE_NOT_ALLOWED);
  }
};

const raisePurchaseOrder = async (data, userId) => {
  const { MaintenancePurchase } = getBooksModels();
  const { companyId, id, vendor, expectedDelivery } = data;

  const purchase = await MaintenancePurchase.findOne({ _id: id, companyId });
  if (!purchase) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_PURCHASE_MESSAGES.NOT_FOUND);
  }
  if (purchase.stage !== MAINTENANCE_PURCHASE_STAGE.APPROVED) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.RAISE_PO_NOT_ALLOWED);
  }

  // Ordered quantity is whatever was approved. The stage filter keeps the transition atomic.
  const result = await MaintenancePurchase.updateOne(
    { _id: id, companyId, stage: MAINTENANCE_PURCHASE_STAGE.APPROVED },
    {
      $set: {
        items: purchase.items.map(item => ({ ...item.toObject(), orderedQty: item.approvedQty })),
        stage: MAINTENANCE_PURCHASE_STAGE.PO,
        vendor,
        expectedDelivery,
        poDate: new Date(),
        updatedBy: userId,
      },
    },
  );
  if (!result.modifiedCount) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.RAISE_PO_NOT_ALLOWED);
  }
};

const RECEIVABLE_STAGES = [MAINTENANCE_PURCHASE_STAGE.PO, MAINTENANCE_PURCHASE_STAGE.PARTIAL];

// A purchase raised from a SHORT part request issues the received quantity straight to that part request:
// one ISSUE ledger entry (which lowers stock) and the part request moves to ISSUED.
const issueReceivedToPartRequest = async ({ purchase, receipts, companyId, userId, now, session }) => {
  const { PartRequest, SparePart } = getBooksModels();

  const partRequest = await PartRequest.findOne({
    _id: purchase.partRequestId,
    companyId,
    status: PART_REQUEST_STATUS.SHORT,
  }).session(session);
  if (!partRequest) return;

  const receipt = receipts.find(item => item.sparePartId.toString() === partRequest.sparePartId.toString());
  if (!receipt) return;

  const neededQty = partRequest.approvedQty ?? partRequest.requestedQty;
  const issuedQty = Math.min(neededQty, receipt.qty);
  if (issuedQty <= 0) return;

  const sparePart = await SparePart.findOne({ _id: partRequest.sparePartId, companyId })
    .select('currentRate')
    .session(session)
    .lean();
  await postEntries(
    [
      {
        companyId,
        sparePartId: partRequest.sparePartId,
        transactionType: SPARE_STOCK_TRANSACTION_TYPE.ISSUE,
        qty: issuedQty,
        rate: sparePart?.currentRate || 0,
        date: now,
        referenceId: partRequest.mrId,
        referenceType: SPARE_STOCK_REFERENCE_TYPE.MAINTENANCE_REQUEST,
        remarks: `Issued ${issuedQty} against maintenance request ${partRequest.mrNo} on receipt of purchase ${purchase.docNo}`,
        createdBy: userId,
      },
    ],
    session,
  );

  // Status stays in the filter so a concurrent change to the part request is not overwritten.
  const issued = await PartRequest.updateOne(
    { _id: partRequest._id, companyId, status: PART_REQUEST_STATUS.SHORT },
    { $set: { status: PART_REQUEST_STATUS.ISSUED, issuedQty, issuedBy: userId, issuedAt: now, updatedBy: userId } },
    { session },
  );
  if (issued.matchedCount === 0) {
    throw new ApiError(httpStatus.CONFLICT, 'The linked part request was just updated. Please refresh and try again.');
  }
};

const receiveMaintenancePurchase = async (data, userId) => {
  const { MaintenancePurchase, SparePart, SpareStockLedger } = getBooksModels();
  const { companyId, id, items } = data;

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const purchase = await MaintenancePurchase.findOne({ _id: id, companyId }).session(session);
    if (!purchase) {
      throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_PURCHASE_MESSAGES.NOT_FOUND);
    }
    if (!RECEIVABLE_STAGES.includes(purchase.stage)) {
      throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.RECEIVE_NOT_ALLOWED);
    }

    // Quantities are what arrived in this receipt; they are added to what was already received.
    const receivedNow = new Map(items.map(item => [item.sparePartId.toString(), item.receivedQty]));
    const knownParts = new Set(purchase.items.map(item => item.sparePartId.toString()));
    if (receivedNow.size !== items.length || [...receivedNow.keys()].some(key => !knownParts.has(key))) {
      throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.RECEIVE_ITEMS_INVALID);
    }
    if (![...receivedNow.values()].some(qty => qty > 0)) {
      throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.RECEIVE_NOTHING);
    }

    const receipts = [];
    const updatedItems = purchase.items.map(item => {
      const qty = receivedNow.get(item.sparePartId.toString()) || 0;
      const receivedQty = (item.receivedQty || 0) + qty;
      if (receivedQty > (item.orderedQty || 0)) {
        throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.RECEIVE_QTY_EXCEEDS);
      }
      if (qty > 0) receipts.push({ sparePartId: item.sparePartId, qty, rate: item.rate || 0 });
      return { ...item.toObject(), receivedQty };
    });
    const isComplete = updatedItems.every(item => item.receivedQty >= (item.orderedQty || 0));

    // Matching on updatedAt rejects the write if another receipt landed after we read, so quantities cannot overshoot.
    const result = await MaintenancePurchase.updateOne(
      { _id: id, companyId, stage: { $in: RECEIVABLE_STAGES }, updatedAt: purchase.updatedAt },
      {
        $set: {
          items: updatedItems,
          stage: isComplete ? MAINTENANCE_PURCHASE_STAGE.RECEIVED : MAINTENANCE_PURCHASE_STAGE.PARTIAL,
          updatedBy: userId,
        },
      },
      { session },
    );
    if (!result.modifiedCount) {
      throw new ApiError(httpStatus.CONFLICT, 'This purchase order was just updated. Please refresh and try again.');
    }

    // Stock in: one ledger entry per received spare part, and currentStock / weighted-average currentRate are updated.
    const now = new Date();
    for (const { sparePartId, qty, rate } of receipts) {
      const sparePart = await SparePart.findOne({ _id: sparePartId, companyId }).session(session);
      if (!sparePart) {
        throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_PURCHASE_MESSAGES.SPARE_PART_NOT_FOUND);
      }
      const oldStock = sparePart.currentStock || 0;
      const newStock = oldStock + qty;
      const newRate = roundMoney((oldStock * (sparePart.currentRate || 0) + qty * rate) / newStock);

      await SparePart.updateOne(
        { _id: sparePartId, companyId },
        { $set: { currentStock: newStock, currentRate: newRate, updatedBy: userId } },
        { session },
      );
      await SpareStockLedger.create(
        [
          {
            companyId,
            sparePartId,
            date: now,
            transactionType: SPARE_STOCK_TRANSACTION_TYPE.RECEIPT,
            qty,
            rate,
            stockAfter: newStock,
            referenceId: purchase._id,
            referenceType: SPARE_STOCK_REFERENCE_TYPE.MAINTENANCE_PURCHASE,
            remarks: `Received ${qty} against purchase ${purchase.docNo}${purchase.vendor ? ` from ${purchase.vendor}` : ''}`,
            createdBy: userId,
          },
        ],
        { session },
      );
    }

    // Purchase raised from a part request: issue the received part to it.
    if (purchase.partRequestId) {
      await issueReceivedToPartRequest({ purchase, receipts, companyId, userId, now, session });
    }

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getAllMaintenancePurchases = async (query, filter, options) => {
  const { MaintenancePurchase } = getBooksModels();
  const { search, stage, linkedMrId, raisedBy, fromDate, toDate } = query;

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ docNo: searchRegex }, { vendor: searchRegex }];
  }
  if (stage) filter.stage = stage;
  if (linkedMrId) filter.linkedMrId = linkedMrId;
  if (raisedBy) filter.raisedBy = raisedBy;
  if (fromDate || toDate) {
    filter.prDate = {};
    if (fromDate) filter.prDate.$gte = moment(fromDate).startOf('day').toDate();
    if (toDate) filter.prDate.$lte = moment(toDate).endOf('day').toDate();
  }

  // Summary counts cover the whole company, independent of the list filters and pagination.
  const { companyId } = filter;
  const [result, pendingApprovalCount, openOrderCount, receivedCount] = await Promise.all([
    MaintenancePurchase.paginate(filter, {
      ...options,
      sortBy: options.sortBy || 'createdAt:desc',
      populate: 'linkedMrId:mrNo|status,partRequestId:partRequestNo,items.sparePartId:name|code',
    }),
    MaintenancePurchase.countDocuments({ companyId, stage: MAINTENANCE_PURCHASE_STAGE.PR }),
    MaintenancePurchase.countDocuments({
      companyId,
      stage: { $in: [MAINTENANCE_PURCHASE_STAGE.PR, MAINTENANCE_PURCHASE_STAGE.APPROVED] },
    }),
    MaintenancePurchase.countDocuments({ companyId, stage: MAINTENANCE_PURCHASE_STAGE.RECEIVED }),
  ]);
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_PURCHASE_MESSAGES.NOT_FOUND);
  }

  return { ...result, results: await enrichPurchases(result.results), pendingApprovalCount, openOrderCount, receivedCount };
};

const getMaintenancePurchaseDropdown = async filter => {
  const { MaintenancePurchase } = getBooksModels();
  const { companyId, search, stage, linkedMrId } = filter;
  const query = { companyId };
  if (stage) query.stage = stage;
  if (linkedMrId) query.linkedMrId = linkedMrId;
  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    query.$or = [{ docNo: searchRegex }, { vendor: searchRegex }];
  }

  return MaintenancePurchase.find(query).select('_id docNo vendor stage prDate linkedMrId').sort({ createdAt: -1 });
};

const getMaintenancePurchaseById = async (id, companyId) => {
  const { MaintenancePurchase } = getBooksModels();
  const purchase = await MaintenancePurchase.findOne({ _id: id, companyId }).populate([
    { path: 'linkedMrId', select: 'mrNo status' },
    { path: 'partRequestId', select: 'partRequestNo' },
    { path: 'items.sparePartId', select: 'name code' },
  ]);
  if (!purchase) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_PURCHASE_MESSAGES.NOT_FOUND);
  }
  const [result] = await enrichPurchases([purchase]);
  return result;
};

module.exports = {
  getMaintenancePurchaseDropdown,
  getAllMaintenancePurchases,
  getMaintenancePurchaseById,
  createMaintenancePurchase,
  receiveMaintenancePurchase,
  raisePurchaseOrder,
  approveMaintenancePurchase,
};
