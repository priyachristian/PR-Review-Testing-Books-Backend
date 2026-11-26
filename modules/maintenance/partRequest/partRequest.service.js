const httpStatus = require('http-status');
const moment = require('moment');
const ApiError = require('../../../utils/ApiError');
const { getClientConnection, getBooksModels, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const { PART_REQUEST_MESSAGES } = require('../../../utils/messages');
const { generateNextCode } = require('../../../utils/autoIncrementCode');
const { getStockBalance, postEntries } = require('../spareStockLedger/spareStockLedger.service');
const {
  PART_REQUEST_STATUS,
  MAINTENANCE_REQUEST_STATUS,
  SPARE_STOCK_TRANSACTION_TYPE,
  SPARE_STOCK_REFERENCE_TYPE,
} = require('@smit9313/abss-models-core/src/utils/enum');
const PART_REQUEST_NO_PREFIX = 'PR-';
const CLOSED_MR_STATUSES = [MAINTENANCE_REQUEST_STATUS.CLOSED, MAINTENANCE_REQUEST_STATUS.REJECTED];

const escapeRegex = value => value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const startSession = async () => {
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  return connection.startSession();
};

const toPlain = doc => (typeof doc.toJSON === 'function' ? doc.toJSON() : doc);

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
const enrichRequests = async docs => {
  const { User } = getCommonModels();
  const list = docs.map(toPlain);
  const userFields = ['requestedBy', 'approvedBy', 'issuedBy', 'addedBy', 'updatedBy'];

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

const POPULATE = [
  { path: 'mrId', select: 'mrNo type status priority' },
  { path: 'machineId', select: 'machineCode machineName' },
  { path: 'sparePartId', select: 'name code category' },
];

const resolveUomName = async (uom, companyId) => {
  if (!uom) return undefined;
  const { ItemUnit } = getBooksCrmModels();
  const unit = await ItemUnit.findOne({ _id: uom, companyId }).select('name').lean();
  return unit?.name;
};

const createPartRequest = async (data, userId) => {
  const { PartRequest, MaintenanceRequest, SparePart } = getBooksModels();
  const session = await startSession();

  try {
    await session.startTransaction();
    const { companyId } = data;

    const mr = await MaintenanceRequest.findOne({ _id: data.mrId, companyId }).session(session);
    if (!mr) {
      throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.MR_NOT_FOUND);
    }
    if (CLOSED_MR_STATUSES.includes(mr.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.MR_CLOSED);
    }

    const sparePart = await SparePart.findOne({ _id: data.sparePartId, companyId, isActive: true }).session(session);
    if (!sparePart) {
      throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.SPARE_PART_NOT_FOUND);
    }

    const partRequestNo = await generateNextCode(PartRequest, companyId, 'partRequestNo', PART_REQUEST_NO_PREFIX, session);

    // Code, name and unit are copied onto the request so it keeps reading correctly if the spare part is edited later.
    const [partRequest] = await PartRequest.create(
      [
        {
          companyId,
          partRequestNo,
          mrId: mr._id,
          mrNo: mr.mrNo,
          machineId: mr.machineId,
          sparePartId: sparePart._id,
          partCode: sparePart.code,
          partName: sparePart.name,
          uom: await resolveUomName(sparePart.uom, companyId),
          requestedQty: data.requestedQty,
          status: PART_REQUEST_STATUS.PENDING,
          requestedBy: userId,
          requestedAt: new Date(),
          addedBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );

    await MaintenanceRequest.updateOne({ _id: mr._id }, { $push: { parts: partRequest._id } }, { session });
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

const PART_REQUEST_STATUSES = Object.values(PART_REQUEST_STATUS);

const getAllPartRequests = async (query, filter, options) => {
  const { PartRequest } = getBooksModels();
  const { search, status, mrId, machineId, sparePartId, requestedBy, fromDate, toDate } = query;

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ partRequestNo: searchRegex }, { mrNo: searchRegex }, { partCode: searchRegex }, { partName: searchRegex }];
  }
  if (status) filter.status = status;
  if (mrId) filter.mrId = mrId;
  if (machineId) filter.machineId = machineId;
  if (sparePartId) filter.sparePartId = sparePartId;
  if (requestedBy) filter.requestedBy = requestedBy;

  if (fromDate || toDate) {
    filter.requestedAt = {};
    if (fromDate) filter.requestedAt.$gte = moment(fromDate).startOf('day').toDate();
    if (toDate) filter.requestedAt.$lte = moment(toDate).endOf('day').toDate();
  }

  const result = await PartRequest.paginate(filter, {
    ...options,
    populate: 'mrId:mrNo|type|status,machineId:machineCode|machineName,sparePartId:name|code',
  });
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, PART_REQUEST_MESSAGES.NOT_FOUND);
  }

  // Per-status counts for the summary cards and tabs; company-wide, independent of list filters and pagination.
  const [results, ...counts] = await Promise.all([
    enrichRequests(result.results),
    ...PART_REQUEST_STATUSES.map(s => PartRequest.countDocuments({ companyId: filter.companyId, status: s })),
  ]);
  const statusCounts = PART_REQUEST_STATUSES.reduce((acc, s, i) => ({ ...acc, [s]: counts[i] }), {});
  statusCounts.ALL = counts.reduce((sum, n) => sum + n, 0);

  return { ...result, results, statusCounts };
};

const getPartRequestById = async (id, companyId) => {
  const { PartRequest } = getBooksModels();
  const partRequest = await PartRequest.findOne({ _id: id, companyId }).populate(POPULATE);
  if (!partRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, PART_REQUEST_MESSAGES.NOT_FOUND);
  }
  const [result] = await enrichRequests([partRequest]);
  return result;
};

const approvePartRequest = async (id, companyId, data, userId) => {
  const { PartRequest } = getBooksModels();

  const partRequest = await PartRequest.findOne({ _id: id, companyId }).select('status requestedQty');
  if (!partRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, PART_REQUEST_MESSAGES.NOT_FOUND);
  }
  if (partRequest.status !== PART_REQUEST_STATUS.PENDING) {
    throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.APPROVE_NOT_ALLOWED);
  }
  const approvedQty = data.approvedQty ?? partRequest.requestedQty;
  if (approvedQty > partRequest.requestedQty) {
    throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.APPROVED_QTY_EXCEEDS);
  }

  // Status stays in the filter so a concurrent status change between the check and the update is not overwritten.
  const approved = await PartRequest.updateOne(
    { _id: id, companyId, status: PART_REQUEST_STATUS.PENDING },
    {
      $set: {
        status: PART_REQUEST_STATUS.APPROVED,
        approvedQty,
        approvedBy: userId,
        approvedAt: new Date(),
        ...(data.approvalRemark !== undefined && { approvalRemark: data.approvalRemark }),
        updatedBy: userId,
      },
    },
  );
  if (approved.matchedCount === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.APPROVE_NOT_ALLOWED);
  }
};

// Issues an approved part request: takes the issued quantity out of stock through an ISSUE ledger entry.
const issuePartRequest = async (id, companyId, data, userId) => {
  const { PartRequest, SparePart } = getBooksModels();
  const session = await startSession();

  try {
    await session.startTransaction();
    const partRequest = await PartRequest.findOne({ _id: id, companyId }).session(session);
    if (!partRequest) {
      throw new ApiError(httpStatus.NOT_FOUND, PART_REQUEST_MESSAGES.NOT_FOUND);
    }
    if (partRequest.status !== PART_REQUEST_STATUS.APPROVED) {
      throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.ISSUE_NOT_ALLOWED);
    }

    const approvedQty = partRequest.approvedQty ?? partRequest.requestedQty;
    const issuedQty = data.issuedQty ?? approvedQty;
    if (issuedQty > approvedQty) {
      throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.ISSUED_QTY_EXCEEDS);
    }

    const sparePart = await SparePart.findOne({ _id: partRequest.sparePartId, companyId })
      .select('currentRate')
      .session(session)
      .lean();
    if (!sparePart) {
      throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.SPARE_PART_NOT_FOUND);
    }
    const balance = await getStockBalance(companyId, partRequest.sparePartId, session);
    if (balance < issuedQty) {
      throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.INSUFFICIENT_STOCK(balance));
    }

    const now = new Date();
    await postEntries(
      [
        {
          companyId,
          sparePartId: partRequest.sparePartId,
          transactionType: SPARE_STOCK_TRANSACTION_TYPE.ISSUE,
          qty: issuedQty,
          rate: sparePart.currentRate || 0,
          date: now,
          referenceId: partRequest.mrId,
          referenceType: SPARE_STOCK_REFERENCE_TYPE.MAINTENANCE_REQUEST,
          remarks: `Issued ${issuedQty} against maintenance request ${partRequest.mrNo}`,
          createdBy: userId,
        },
      ],
      session,
    );

    // Status stays in the filter so a concurrent status change between the check and the update is not overwritten.
    const issued = await PartRequest.updateOne(
      { _id: id, companyId, status: PART_REQUEST_STATUS.APPROVED },
      { $set: { status: PART_REQUEST_STATUS.ISSUED, issuedQty, issuedBy: userId, issuedAt: now, updatedBy: userId } },
      { session },
    );
    if (issued.matchedCount === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.ISSUE_NOT_ALLOWED);
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

// Marks an approved part request as short: the part could not be issued because stock is not available.
const shortPartRequest = async (id, companyId, userId) => {
  const { PartRequest } = getBooksModels();

  const partRequest = await PartRequest.findOne({ _id: id, companyId }).select('status');
  if (!partRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, PART_REQUEST_MESSAGES.NOT_FOUND);
  }
  if (partRequest.status !== PART_REQUEST_STATUS.APPROVED) {
    throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.SHORT_NOT_ALLOWED);
  }

  const marked = await PartRequest.updateOne(
    { _id: id, companyId, status: PART_REQUEST_STATUS.APPROVED },
    { $set: { status: PART_REQUEST_STATUS.SHORT, issuedBy: userId, issuedAt: new Date(), updatedBy: userId } },
  );
  if (marked.matchedCount === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, PART_REQUEST_MESSAGES.SHORT_NOT_ALLOWED);
  }
};

module.exports = {
  createPartRequest,
  getAllPartRequests,
  getPartRequestById,
  approvePartRequest,
  issuePartRequest,
  shortPartRequest,
};
