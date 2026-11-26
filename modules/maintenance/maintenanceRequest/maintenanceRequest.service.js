const httpStatus = require('http-status');
const moment = require('moment');
const ApiError = require('../../../utils/ApiError');
const { getClientConnection, getBooksModels, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const { generateNextCode } = require('../../../utils/autoIncrementCode');
const { MAINTENANCE_REQUEST_MESSAGES } = require('../../../utils/messages');
const {
  MAINTENANCE_REQUEST_STATUS,
  MAINTENANCE_REQUEST_PRIORITY,
  PART_REQUEST_STATUS,
} = require('@smit9313/abss-models-core/src/utils/enum');

const MR_CODE_PREFIX = 'MR-';
const MS_PER_HOUR = 60 * 60 * 1000;
const OPEN_STATUSES = [
  MAINTENANCE_REQUEST_STATUS.RAISED,
  MAINTENANCE_REQUEST_STATUS.APPROVED,
  MAINTENANCE_REQUEST_STATUS.ASSIGNED,
  MAINTENANCE_REQUEST_STATUS.IN_PROGRESS,
];

const escapeRegex = value => value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findMachineIdsBySearch = async (companyId, searchRegex) => {
  const { Machine } = getBooksModels();
  const machines = await Machine.find({
    companyId,
    $or: [{ machineCode: searchRegex }, { machineName: searchRegex }],
  })
    .select('_id')
    .lean();
  return machines.map(machine => machine._id);
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

const TOP_LEVEL_USER_FIELDS = ['raisedBy', 'addedBy', 'updatedBy'];
const NESTED_USER_FIELDS = {
  approval: ['approvedBy'],
  assignment: ['assigneeId', 'assignedBy'],
  work: ['startedBy', 'completedBy'],
  closure: ['completedBy', 'verifiedBy'],
};

const getStatusFlags = item => ({
  isApproved: Boolean(item.approval?.approvedAt && !item.approval?.rejectReason),
  isAssigned: Boolean(item.assignment?.assignedAt),
  isInProgress: Boolean(item.work?.startedAt),
  isCompleted: Boolean(item.work?.completedAt),
});

const enrichRequests = async docs => {
  const { User } = getCommonModels();
  const list = docs.map(toPlain);

  const userIds = new Set();
  list.forEach(item => {
    TOP_LEVEL_USER_FIELDS.forEach(field => item[field] && userIds.add(item[field].toString()));
    Object.entries(NESTED_USER_FIELDS).forEach(([group, fields]) =>
      fields.forEach(field => item[group]?.[field] && userIds.add(item[group][field].toString())),
    );
  });
  const users = userIds.size ? await User.find({ _id: { $in: [...userIds] } }).select('firstName lastName') : [];
  const userMap = new Map(users.map(user => [user._id.toString(), user]));
  const resolve = id => (id ? toUserRef(userMap.get(id.toString())) : null);

  const { Branch } = getBooksCrmModels();
  const branchIds = [...new Set(list.map(item => item.branchId?.toString()).filter(Boolean))];
  const branches = branchIds.length
    ? await Branch.find({ _id: { $in: branchIds } })
        .select('name')
        .lean()
    : [];
  const branchMap = new Map(branches.map(branch => [branch._id.toString(), branch]));

  return list.map(item => {
    const branch = item.branchId ? branchMap.get(item.branchId.toString()) : null;
    const result = { ...item, branchId: branch ? { id: branch._id, name: branch.name } : item.branchId || null };
    TOP_LEVEL_USER_FIELDS.forEach(field => {
      result[field] = resolve(item[field]);
    });
    Object.entries(NESTED_USER_FIELDS).forEach(([group, fields]) => {
      if (!item[group]) return;
      result[group] = { ...item[group] };
      fields.forEach(field => {
        if (item[group][field]) result[group][field] = resolve(item[group][field]);
      });
    });
    return result;
  });
};

const createMaintenanceRequest = async (data, userId) => {
  const { MaintenanceRequest, Machine } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const machine = await Machine.findOne({ _id: data.machineId, companyId: data.companyId }).session(session);
    if (!machine) {
      throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.MACHINE_NOT_FOUND);
    }
    if (machine.isActive === false) {
      throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.MACHINE_INACTIVE);
    }

    const mrNo = await generateNextCode(MaintenanceRequest, data.companyId, 'mrNo', MR_CODE_PREFIX, session);
    const raisedAt = new Date();

    const [created] = await MaintenanceRequest.create(
      [
        {
          ...data,
          mrNo,
          status: MAINTENANCE_REQUEST_STATUS.RAISED,
          raisedBy: userId,
          raisedAt,
          ...(data.isMachineStopped && { downtimeStartAt: raisedAt }),
          ...(data.slaHours !== undefined && { slaDueAt: new Date(raisedAt.getTime() + data.slaHours * MS_PER_HOUR) }),
          addedBy: userId,
          updatedBy: userId,
        },
      ],
      { session },
    );
    await session.commitTransaction();
    return created._id;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getAllMaintenanceRequests = async (query, filter, options) => {
  const { MaintenanceRequest } = getBooksModels();
  const { search, status, type, priority, machineId, branchId, raisedBy, isMachineStopped, fromDate, toDate } = query;

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    const machineIds = await findMachineIdsBySearch(filter.companyId, searchRegex);
    filter.$or = [{ mrNo: searchRegex }, { machineId: { $in: machineIds } }, { problemDescription: searchRegex }];
  }
  if (status) filter.status = status;
  if (type) filter.type = type;
  if (priority) filter.priority = priority;
  if (machineId) filter.machineId = machineId;
  if (branchId) filter.branchId = branchId;
  if (raisedBy) filter.raisedBy = raisedBy;
  if (isMachineStopped !== undefined) filter.isMachineStopped = isMachineStopped;

  if (fromDate || toDate) {
    filter.raisedAt = {};
    if (fromDate) filter.raisedAt.$gte = moment(fromDate).startOf('day').toDate();
    if (toDate) filter.raisedAt.$lte = moment(toDate).endOf('day').toDate();
  }

  const result = await MaintenanceRequest.paginate(filter, {
    sortBy: 'raisedAt:desc',
    ...options,
    populate: 'machineId:machineCode|machineName',
  });
  if (!result) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.NOT_FOUND);
  }

  const openFilter = { companyId: filter.companyId, status: { $in: OPEN_STATUSES } };
  const [openRequestCount, criticalOpenCount, machineStoppedCount, results] = await Promise.all([
    MaintenanceRequest.countDocuments(openFilter),
    MaintenanceRequest.countDocuments({ ...openFilter, priority: MAINTENANCE_REQUEST_PRIORITY.CRITICAL }),
    MaintenanceRequest.countDocuments({ companyId: filter.companyId, isMachineStopped: true }),
    enrichRequests(result.results),
  ]);

  return { ...result, results, openRequestCount, criticalOpenCount, machineStoppedCount };
};

const getMaintenanceRequestById = async (id, companyId) => {
  const { MaintenanceRequest } = getBooksModels();
  const maintenanceRequest = await MaintenanceRequest.findOne({ _id: id, companyId })
    .populate({ path: 'machineId', select: 'machineCode machineName' })
    .populate({
      path: 'parts',
      select: 'partRequestNo sparePartId partCode partName uom requestedQty approvedQty issuedQty status requestedAt',
      populate: { path: 'sparePartId', select: 'name code category' },
    });
  if (!maintenanceRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.NOT_FOUND);
  }
  const [result] = await enrichRequests([maintenanceRequest]);
  return { ...result, ...getStatusFlags(result) };
};

const approveMaintenanceRequest = async (id, companyId, remark, userId) => {
  const { MaintenanceRequest } = getBooksModels();

  const maintenanceRequest = await MaintenanceRequest.findOne({ _id: id, companyId }).select('status');
  if (!maintenanceRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.NOT_FOUND);
  }
  if (maintenanceRequest.status !== MAINTENANCE_REQUEST_STATUS.RAISED) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.APPROVE_NOT_ALLOWED);
  }

  const approved = await MaintenanceRequest.updateOne(
    { _id: id, companyId, status: MAINTENANCE_REQUEST_STATUS.RAISED },
    {
      $set: {
        status: MAINTENANCE_REQUEST_STATUS.APPROVED,
        approval: { approvedBy: userId, approvedAt: new Date(), remark },
        updatedBy: userId,
      },
    },
  );
  if (approved.matchedCount === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.APPROVE_NOT_ALLOWED);
  }
};

const rejectMaintenanceRequest = async (id, companyId, rejectReason, userId) => {
  const { MaintenanceRequest } = getBooksModels();

  const maintenanceRequest = await MaintenanceRequest.findOne({ _id: id, companyId }).select('status');
  if (!maintenanceRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.NOT_FOUND);
  }
  if (maintenanceRequest.status !== MAINTENANCE_REQUEST_STATUS.RAISED) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.REJECT_NOT_ALLOWED);
  }

  const rejected = await MaintenanceRequest.updateOne(
    { _id: id, companyId, status: MAINTENANCE_REQUEST_STATUS.RAISED },
    {
      $set: {
        status: MAINTENANCE_REQUEST_STATUS.REJECTED,
        approval: { approvedBy: userId, approvedAt: new Date(), rejectReason },
        updatedBy: userId,
      },
    },
  );
  if (rejected.matchedCount === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.REJECT_NOT_ALLOWED);
  }
};

const assignMaintenanceRequest = async (id, companyId, data, userId) => {
  const { MaintenanceRequest } = getBooksModels();

  const maintenanceRequest = await MaintenanceRequest.findOne({ _id: id, companyId }).select('status');
  if (!maintenanceRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.NOT_FOUND);
  }
  if (maintenanceRequest.status !== MAINTENANCE_REQUEST_STATUS.APPROVED) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.ASSIGN_NOT_ALLOWED);
  }

  const { User } = getCommonModels();
  const assigneeExists = await User.exists({ _id: data.assigneeId });
  if (!assigneeExists) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.ASSIGNEE_NOT_FOUND);
  }

  const assigned = await MaintenanceRequest.updateOne(
    { _id: id, companyId, status: MAINTENANCE_REQUEST_STATUS.APPROVED },
    {
      $set: {
        status: MAINTENANCE_REQUEST_STATUS.ASSIGNED,
        assignment: { ...data, assignedBy: userId, assignedAt: new Date() },
        updatedBy: userId,
      },
    },
  );
  if (assigned.matchedCount === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.ASSIGN_NOT_ALLOWED);
  }
};

const startWorkMaintenanceRequest = async (id, companyId, userId) => {
  const { MaintenanceRequest } = getBooksModels();

  const maintenanceRequest = await MaintenanceRequest.findOne({ _id: id, companyId }).select('status');
  if (!maintenanceRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.NOT_FOUND);
  }
  if (maintenanceRequest.status !== MAINTENANCE_REQUEST_STATUS.ASSIGNED) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.START_WORK_NOT_ALLOWED);
  }

  const started = await MaintenanceRequest.updateOne(
    { _id: id, companyId, status: MAINTENANCE_REQUEST_STATUS.ASSIGNED },
    {
      $set: {
        status: MAINTENANCE_REQUEST_STATUS.IN_PROGRESS,
        'work.startedAt': new Date(),
        'work.startedBy': userId,
        updatedBy: userId,
      },
    },
  );
  if (started.matchedCount === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.START_WORK_NOT_ALLOWED);
  }
};

const completeMaintenanceRequest = async (id, companyId, data, userId) => {
  const { MaintenanceRequest, PartRequest } = getBooksModels();

  const maintenanceRequest = await MaintenanceRequest.findOne({ _id: id, companyId }).select('status');
  if (!maintenanceRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.NOT_FOUND);
  }
  if (maintenanceRequest.status !== MAINTENANCE_REQUEST_STATUS.IN_PROGRESS) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.COMPLETE_NOT_ALLOWED);
  }

  const pendingPart = await PartRequest.exists({ companyId, mrId: id, status: { $ne: PART_REQUEST_STATUS.ISSUED } });
  if (pendingPart) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.COMPLETE_PARTS_NOT_ISSUED);
  }

  const workFields = Object.fromEntries(Object.entries(data).map(([key, value]) => [`work.${key}`, value]));
  const completed = await MaintenanceRequest.updateOne(
    { _id: id, companyId, status: MAINTENANCE_REQUEST_STATUS.IN_PROGRESS },
    {
      $set: {
        status: MAINTENANCE_REQUEST_STATUS.COMPLETED,
        ...workFields,
        'work.completedAt': new Date(),
        'work.completedBy': userId,
        updatedBy: userId,
      },
    },
  );
  if (completed.matchedCount === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.COMPLETE_NOT_ALLOWED);
  }
};

const closeMaintenanceRequest = async (id, companyId, data, userId) => {
  const { MaintenanceRequest } = getBooksModels();

  const maintenanceRequest = await MaintenanceRequest.findOne({ _id: id, companyId }).select('status');
  if (!maintenanceRequest) {
    throw new ApiError(httpStatus.NOT_FOUND, MAINTENANCE_REQUEST_MESSAGES.NOT_FOUND);
  }
  if (maintenanceRequest.status === MAINTENANCE_REQUEST_STATUS.REJECTED) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.CLOSE_NOT_ALLOWED);
  }

  const closureFields = Object.fromEntries(Object.entries(data).map(([key, value]) => [`closure.${key}`, value]));
  const closed = await MaintenanceRequest.updateOne(
    { _id: id, companyId, status: { $ne: MAINTENANCE_REQUEST_STATUS.REJECTED } },
    {
      $set: {
        status: MAINTENANCE_REQUEST_STATUS.CLOSED,
        ...closureFields,
        'closure.verifiedBy': userId,
        'closure.verifiedAt': new Date(),
        updatedBy: userId,
      },
    },
  );
  if (closed.matchedCount === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, MAINTENANCE_REQUEST_MESSAGES.CLOSE_NOT_ALLOWED);
  }
};

const getMaintenanceRequestDropdown = async filter => {
  const { MaintenanceRequest } = getBooksModels();
  const { companyId, search, status, type, priority, machineId } = filter;
  const query = { companyId };
  if (status) query.status = status;
  if (type) query.type = type;
  if (priority) query.priority = priority;
  if (machineId) query.machineId = machineId;
  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    const machineIds = await findMachineIdsBySearch(companyId, searchRegex);
    query.$or = [{ mrNo: searchRegex }, { machineId: { $in: machineIds } }];
  }

  return MaintenanceRequest.find(query)
    .select('_id mrNo machineId type priority status')
    .populate({ path: 'machineId', select: 'machineCode machineName' })
    .sort({ raisedAt: -1 });
};

module.exports = {
  getMaintenanceRequestDropdown,
  createMaintenanceRequest,
  getAllMaintenanceRequests,
  getMaintenanceRequestById,
  approveMaintenanceRequest,
  rejectMaintenanceRequest,
  assignMaintenanceRequest,
  startWorkMaintenanceRequest,
  completeMaintenanceRequest,
  closeMaintenanceRequest,
};
