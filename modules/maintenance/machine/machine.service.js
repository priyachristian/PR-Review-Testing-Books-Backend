const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { getClientConnection, getBooksModels } = require('../../../services/model.service');
const { generateNextCode, withCodeRetry } = require('../../../utils/autoIncrementCode');
const { MACHINE_MESSAGES } = require('../../../utils/messages');
const { MACHINE_CRITICALITY } = require('@smit9313/abss-models-core/src/utils/enum');

const WEAR_PART_POPULATE = { path: 'wearParts.sparePartId', select: 'name code' };
const MACHINE_MAINTENANCE_REQUEST_FIELDS =
  'mrNo type priority status problemDescription isMachineStopped raisedAt slaDueAt downtimeStartAt downtimeEndAt';

const escapeRegex = value => value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MACHINE_CODE_PREFIX = 'MCH-';

const createMachineOnce = async (data, userId) => {
  const { Machine } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const existingMachineName = await Machine.findOne({
      companyId: data.companyId,
      machineName: { $regex: new RegExp(`^${escapeRegex(data.machineName)}$`, 'i') },
    }).session(session);
    if (existingMachineName) {
      throw new ApiError(httpStatus.CONFLICT, 'A machine with this name already exists');
    }

    const machineCode = await generateNextCode(Machine, data.companyId, 'machineCode', MACHINE_CODE_PREFIX, session);

    await Machine.create(
      [
        {
          ...data,
          machineCode,
          isActive: true,
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
    throw error;
  } finally {
    await session.endSession();
  }
};

const createMachine = (data, userId) => withCodeRetry(() => createMachineOnce(data, userId), 'machineCode');

const getAllMachines = async (query, filter, options) => {
  const { Machine } = getBooksModels();
  const { search, criticality, hasAMC } = query;

  if (search) {
    const searchRegex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { machineCode: searchRegex },
      { machineName: searchRegex },
      { process: searchRegex },
      { location: searchRegex },
    ];
  }
  if (criticality) {
    filter.criticality = criticality;
  }
  if (hasAMC !== undefined) {
    filter.hasAMC = hasAMC;
  }

  // The summary counts cover every machine of the company, so they stay the same whatever filter, search or page is used.
  const [machines, [summary]] = await Promise.all([
    Machine.paginate(filter, { ...options, populate: 'wearParts.sparePartId:name|code' }),
    Machine.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(filter.companyId) } },
      {
        $group: {
          _id: null,
          totalCriticalityA: { $sum: { $cond: [{ $eq: ['$criticality', MACHINE_CRITICALITY.A] }, 1, 0] } },
          totalActiveMachines: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
          totalUnderAMC: { $sum: { $cond: [{ $eq: ['$hasAMC', true] }, 1, 0] } },
        },
      },
    ]),
  ]);
  if (!machines) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Machines not found');
  }

  return {
    ...machines,
    totalCriticalityA: summary?.totalCriticalityA || 0,
    totalActiveMachines: summary?.totalActiveMachines || 0,
    totalUnderAMC: summary?.totalUnderAMC || 0,
  };
};

const getMachineById = async (id, companyId) => {
  const { Machine, MaintenanceRequest } = getBooksModels();
  const [machine, maintenanceRequests] = await Promise.all([
    Machine.findOne({ _id: id, companyId }).populate(WEAR_PART_POPULATE),
    MaintenanceRequest.find({ companyId, machineId: id })
      .select(MACHINE_MAINTENANCE_REQUEST_FIELDS)
      .sort({ raisedAt: -1 })
      .lean(),
  ]);
  if (!machine) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Machine not found');
  }

  return {
    ...machine.toJSON(),
    maintenanceRequestCount: maintenanceRequests.length,
    // lean() skips the toJSON plugin, so _id is mapped to id to match the rest of the response.
    maintenanceRequests: maintenanceRequests.map(({ _id, ...request }) => ({ id: _id, ...request })),
  };
};

const updateMachineById = async (id, data, companyId, userId) => {
  const { Machine } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const machine = await Machine.findOne({ _id: id, companyId }).session(session);
    if (!machine) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Machine not found');
    }

    if (data.machineName && data.machineName.trim().toLowerCase() !== machine.machineName.trim().toLowerCase()) {
      const existingMachineName = await Machine.findOne({
        _id: { $ne: id },
        companyId,
        machineName: { $regex: new RegExp(`^${escapeRegex(data.machineName)}$`, 'i') },
      }).session(session);
      if (existingMachineName) {
        throw new ApiError(httpStatus.CONFLICT, 'A machine with this name already exists');
      }
    }

    Object.assign(machine, data);
    machine.updatedBy = userId;
    await machine.save({ session });
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

const updateActiveStatus = async (id, isActive, companyId, userId) => {
  const { Machine } = getBooksModels();
  const { matchedCount } = await Machine.updateOne({ _id: id, companyId }, { isActive, updatedBy: userId });
  if (!matchedCount) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Machine not found');
  }
};

const deleteMachineById = async (id, companyId) => {
  const { Machine, MaintenanceRequest, PartRequest, SparePart } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const machine = await Machine.findOne({ _id: id, companyId }).session(session);
    if (!machine) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Machine not found');
    }

    const usages = await Promise.all([
      MaintenanceRequest.exists({ companyId, machineId: id }).session(session),
      PartRequest.exists({ companyId, machineId: id }).session(session),
      SparePart.exists({ companyId, fitsOnMachines: id }).session(session),
    ]);
    if (usages.some(Boolean)) {
      throw new ApiError(httpStatus.BAD_REQUEST, MACHINE_MESSAGES.DELETE_IN_USE);
    }

    await Machine.deleteOne({ _id: id, companyId }, { session });
    await session.commitTransaction();
    return machine;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getMachineDropdown = async filter => {
  const { Machine } = getBooksModels();
  const { companyId, location, process, criticality } = filter;
  const query = { companyId, isActive: true };
  if (location) {
    query.location = location;
  }
  if (process) {
    query.process = process;
  }
  if (criticality) {
    query.criticality = criticality;
  }

  const machines = await Machine.find(query)
    .select('_id machineCode machineName process location criticality')
    .sort({ machineName: 1 });
  return machines;
};

module.exports = {
  createMachine,
  getAllMachines,
  getMachineById,
  updateMachineById,
  updateActiveStatus,
  deleteMachineById,
  getMachineDropdown,
};
