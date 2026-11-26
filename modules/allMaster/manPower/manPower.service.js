const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getClientConnection, getBooksModels } = require('../../../services/model.service');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { MODULE_NAMES } = require('../../../utils/enum');

const createManPower = async data => {
  const { ManPower } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    data.workerNo = await generateUniqueId(
      ManPower,
      data?.companyId,
      MODULE_NAMES.MANPOWER,
      'workerNo',
      'MP',
      session,
      data.workerNo,
    );
    const manPower = await ManPower.create([data], { session });
    await session.commitTransaction();
    return manPower[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getNextWorkerNumber = async companyId => {
  const { ManPower } = getBooksModels();
  try {
    const latestWorkerNo = await ManPower.findOne({ companyId }, { workerNo: 1 }, { sort: { createdAt: -1 } });

    let nextNumber = 1;
    if (latestWorkerNo && latestWorkerNo.workerNo) {
      const match = latestWorkerNo.workerNo.match(/MP-(\d+)/);
      if (match) {
        nextNumber = parseInt(match[1], 10) + 1;
      }
    }

    return `MP-${nextNumber}`;
  } catch (error) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We couldn't generate a new Worker number. Please try again.");
  }
};

const getAllManPower = async (query, filter, options) => {
  const { ManPower } = getBooksModels();
  if (query.search) {
    const searchRegex = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ workerNo: searchRegex }, { workerName: searchRegex }, { departmentName: searchRegex }];
  }
  const manPowers = await ManPower.paginate(filter, options);
  if (!manPowers) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Manpower not found');
  }
  const nextWorkerNo = await getNextWorkerNumber(filter.companyId);
  return { ...manPowers, nextWorkerNo };
};

const getManPowerById = async (id, companyId) => {
  const { ManPower } = getBooksModels();
  const manPower = await ManPower.findOne({ _id: id, companyId });
  if (!manPower) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Manpower not found');
  }
  return manPower;
};

const updateManPowerById = async (id, data, companyId) => {
  const { ManPower } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const manPower = await ManPower.findOne({ _id: id, companyId }).session(session);
    if (!manPower) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Manpower not found');
    }

    Object.assign(manPower, data);
    await manPower.save({ session });
    await session.commitTransaction();
    return manPower;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteManPowerById = async (id, companyId) => {
  const { ManPower, ProductionOrder } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const productionOrderUsingManPower = await ProductionOrder.findOne({
    companyId,
    $or: [
      { productionOwner: id },
      { manPower_inventoryTransfer: id },
      { 'submissionHistory.manpowerCost.manpowerId': id },
      { 'processBased.processes.manPower.workerId': id },
    ],
  });
  if (productionOrderUsingManPower) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete: Manpower is used in one or more production orders');
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const manPower = await ManPower.findOne({ _id: id, companyId }).session(session);
    if (!manPower) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Manpower not found');
    }

    await ManPower.deleteOne({ _id: id, companyId }, { session });
    await session.commitTransaction();
    return manPower;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getManPowerDropdown = async filter => {
  const { ManPower } = getBooksModels();
  const { companyId, departmentName, ...rest } = filter;
  const query = { companyId, ...rest };
  if (departmentName) {
    if (departmentName === '__UNASSIGNED__') {
      query.$or = [{ departmentName: { $exists: false } }, { departmentName: null }, { departmentName: '' }];
    } else {
      query.departmentName = departmentName;
    }
  }
  const manPowers = await ManPower.find(query)
    .select('_id workerNo workerName perHourSalary departmentName')
    .sort({ workerName: 1 });
  return manPowers;
};

module.exports = {
  createManPower: withTransientRetry(createManPower),
  getAllManPower,
  getManPowerById,
  updateManPowerById,
  deleteManPowerById,
  getManPowerDropdown,
};
