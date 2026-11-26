const httpStatus = require('http-status');
const mongoose = require('mongoose');
const moment = require('moment');
const ApiError = require('../../../utils/ApiError');
const { getClientConnection, getBooksModels, getCommonModels } = require('../../../services/model.service');
const { SPARE_STOCK_LEDGER_MESSAGES } = require('../../../utils/messages');
const { SPARE_STOCK_TRANSACTION_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');

const SIGN_BY_TYPE = {
  [SPARE_STOCK_TRANSACTION_TYPE.OPENING]: 1,
  [SPARE_STOCK_TRANSACTION_TYPE.RECEIPT]: 1,
  [SPARE_STOCK_TRANSACTION_TYPE.ISSUE]: -1,
};
// Only stock coming in at a known price moves the average rate; issues and adjustments leave it as it is.
const RATE_TYPES = [SPARE_STOCK_TRANSACTION_TYPE.OPENING, SPARE_STOCK_TRANSACTION_TYPE.RECEIPT];

const roundRate = value => Math.round((value + Number.EPSILON) * 100) / 100;

const runInTransaction = async work => {
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Stock of a spare part according to the ledger: the sum of every quantity (stock in positive, stock out negative).
 * The ledger is the source of truth; SparePart.currentStock is kept in step with it by postEntries.
 */
const getStockBalance = async (companyId, sparePartId, session) => {
  const { SpareStockLedger } = getBooksModels();
  const [row] = await SpareStockLedger.aggregate([
    { $match: { companyId: new mongoose.Types.ObjectId(companyId), sparePartId: new mongoose.Types.ObjectId(sparePartId) } },
    { $group: { _id: null, balance: { $sum: '$qty' } } },
  ]).session(session || null);
  return row ? row.balance : 0;
};

/**
 * Writes ledger rows and updates each spare part's stock and rate, inside the caller's transaction.
 * Callers pass quantities as positive numbers; the sign for OPENING/RECEIPT (in) and ISSUE (out) is applied here.
 * ADJUSTMENT keeps the caller's sign. Entries with a zero quantity are skipped.
 *
 * SparePart.currentStock is increased or decreased by each row's quantity. SparePart.currentRate is the weighted
 * average of the stock on hand and each incoming OPENING/RECEIPT row that carries a rate.
 */
const postEntries = async (entries, session) => {
  const { SpareStockLedger, SparePart } = getBooksModels();
  const rows = entries
    .filter(entry => entry.qty !== 0)
    .map(entry => {
      const sign = entry.transactionType === SPARE_STOCK_TRANSACTION_TYPE.ADJUSTMENT ? 1 : SIGN_BY_TYPE[entry.transactionType];
      if (!sign) {
        throw new Error(`Unsupported stock transaction type: ${entry.transactionType}`);
      }
      return { ...entry, qty: sign * entry.qty, date: entry.date || new Date() };
    });
  if (!rows.length) return;

  // One at a time, so two rows for the same part average against each other correctly
  // and each ledger row records the stock of the part right after it is applied.
  for (const row of rows) {
    const part = await SparePart.findOne({ _id: row.sparePartId, companyId: row.companyId })
      .select('currentStock currentRate')
      .session(session)
      .lean();
    const stock = part?.currentStock || 0;
    const rate = part?.currentRate || 0;

    // Stock never goes below zero, whichever flow takes it out.
    if (stock + row.qty < 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, SPARE_STOCK_LEDGER_MESSAGES.STOCK_CANNOT_BE_NEGATIVE(Math.max(stock, 0)));
    }

    await SpareStockLedger.create([{ ...row, stockAfter: stock + row.qty }], { session });

    const update = { $inc: { currentStock: row.qty } };
    if (RATE_TYPES.includes(row.transactionType) && row.rate != null && row.qty > 0) {
      const onHand = Math.max(stock, 0);
      update.$set = { currentRate: roundRate((onHand * rate + row.qty * row.rate) / (onHand + row.qty)) };
    }
    // For stock out, currentStock stays in the filter so a concurrent issue cannot push it below zero.
    const stockFilter = row.qty < 0 ? { currentStock: { $gte: -row.qty } } : {};
    const updated = await SparePart.updateOne({ _id: row.sparePartId, companyId: row.companyId, ...stockFilter }, update, {
      session,
    });
    if (updated.matchedCount === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, SPARE_STOCK_LEDGER_MESSAGES.STOCK_CANNOT_BE_NEGATIVE(Math.max(stock, 0)));
    }
  }
};

const createAdjustment = async (data, userId) => {
  const { SparePart } = getBooksModels();
  const { companyId, sparePartId, qty, date, remarks } = data;

  await runInTransaction(async session => {
    const sparePart = await SparePart.exists({ _id: sparePartId, companyId, isActive: true }).session(session);
    if (!sparePart) {
      throw new ApiError(httpStatus.BAD_REQUEST, SPARE_STOCK_LEDGER_MESSAGES.SPARE_PART_NOT_FOUND);
    }

    // A negative adjustment cannot take stock below zero.
    if (qty < 0) {
      const balance = await getStockBalance(companyId, sparePartId, session);
      if (balance + qty < 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, SPARE_STOCK_LEDGER_MESSAGES.ADJUSTMENT_EXCEEDS_STOCK(balance));
      }
    }

    await postEntries(
      [
        {
          companyId,
          sparePartId,
          transactionType: SPARE_STOCK_TRANSACTION_TYPE.ADJUSTMENT,
          qty,
          date,
          remarks,
          createdBy: userId,
        },
      ],
      session,
    );
  });
};

const escapeRegex = value => value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getAllSpareStockLedgers = async (query, filter, options) => {
  const { SpareStockLedger, SparePart } = getBooksModels();
  const { search, sparePartId, transactionType, referenceType, referenceId, fromDate, toDate } = query;

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    // Spare part name and code live on the spare part, so matching parts are looked up first.
    const matchingParts = await SparePart.find({
      companyId: filter.companyId,
      $or: [{ name: searchRegex }, { code: searchRegex }],
    })
      .select('_id')
      .lean();
    filter.$or = [{ remarks: searchRegex }, { sparePartId: { $in: matchingParts.map(part => part._id) } }];
  }
  if (sparePartId) filter.sparePartId = sparePartId;
  if (transactionType) filter.transactionType = transactionType;
  if (referenceType) filter.referenceType = referenceType;
  if (referenceId) filter.referenceId = referenceId;

  if (fromDate || toDate) {
    filter.date = {};
    if (fromDate) filter.date.$gte = moment(fromDate).startOf('day').toDate();
    if (toDate) filter.date.$lte = moment(toDate).endOf('day').toDate();
  }

  // aggregate() does not cast like find(), so ID filters are converted before the totals $match.
  const toObjectId = id => new mongoose.Types.ObjectId(id);
  const summaryMatch = { ...filter, companyId: toObjectId(filter.companyId) };
  if (filter.sparePartId) summaryMatch.sparePartId = toObjectId(filter.sparePartId);
  if (filter.referenceId) summaryMatch.referenceId = toObjectId(filter.referenceId);

  const [result, [summary]] = await Promise.all([
    SpareStockLedger.paginate(filter, {
      ...options,
      sortBy: options.sortBy || 'date:desc',
      // referenceId resolves through referenceType, so it comes back as the source MaintenanceRequest, MaintenancePurchase or SparePart.
      populate: 'sparePartId:name|code,referenceId:mrNo|docNo|status|stage|name|code',
    }),
    SpareStockLedger.aggregate([
      { $match: summaryMatch },
      {
        $group: {
          _id: null,
          totalRecords: { $sum: 1 },
          // ISSUE rows are stored as negative quantities, so the total is reported as a positive number.
          totalIssuedStock: {
            $sum: { $cond: [{ $eq: ['$transactionType', SPARE_STOCK_TRANSACTION_TYPE.ISSUE] }, { $abs: '$qty' }, 0] },
          },
          totalReceivedStock: {
            $sum: { $cond: [{ $eq: ['$transactionType', SPARE_STOCK_TRANSACTION_TYPE.RECEIPT] }, '$qty', 0] },
          },
        },
      },
    ]),
  ]);
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, SPARE_STOCK_LEDGER_MESSAGES.NOT_FOUND);
  }

  // Users live in the common database, so they are resolved with one batch lookup instead of populate.
  const { User } = getCommonModels();
  const list = result.results.map(doc => (typeof doc.toJSON === 'function' ? doc.toJSON() : doc));
  const userIds = [...new Set(list.map(item => item.createdBy?.toString()).filter(Boolean))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select('firstName lastName') : [];
  const userMap = new Map(users.map(user => [user._id.toString(), user]));

  return {
    ...result,
    totalRecords: summary?.totalRecords || 0,
    totalIssuedStock: summary?.totalIssuedStock || 0,
    totalReceivedStock: summary?.totalReceivedStock || 0,
    results: list.map(item => {
      const user = item.createdBy ? userMap.get(item.createdBy.toString()) : null;
      return {
        ...item,
        createdBy: user
          ? {
              id: user._id,
              firstName: user.firstName,
              lastName: user.lastName,
              name: [user.firstName, user.lastName].filter(Boolean).join(' '),
            }
          : null,
      };
    }),
  };
};

module.exports = {
  getAllSpareStockLedgers,
  createAdjustment,
  getStockBalance,
  postEntries,
};
