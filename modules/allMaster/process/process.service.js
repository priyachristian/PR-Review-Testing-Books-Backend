const httpStatus = require('http-status');
const { getBooksModels, getClientConnection } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { PROCESS_MESSAGES } = require('../../../utils/messages');
const { MODULE_NAMES } = require('../../../utils/enum');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');

/**
 * Create a process
 * @param {Object} processBody
 * @returns {Promise<Process>}
 */
const createProcess = async (processBody, userId) => {
  const { Process } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const existingProcess = await Process.findOne({
      name: { $regex: new RegExp(`^${processBody.name}$`, 'i') },
      companyId: processBody.companyId,
    });

    if (existingProcess) {
      throw new ApiError(httpStatus.CONFLICT, 'Process with this name already exists');
    }

    processBody.processId = await generateUniqueId(
      Process,
      processBody?.companyId,
      MODULE_NAMES.PROCESS,
      'processId',
      'PROC',
      session,
      processBody.processId,
    );

    const processData = {
      ...processBody,
      addedBy: userId,
      updatedBy: userId,
    };
    const process = await Process.create([processData], { session });
    await session.commitTransaction();
    return process[0];
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
 * Query for processes
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryProcesses = async (query, filter, options) => {
  const { Process } = getBooksModels();
  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    filter.$or = [{ processId: searchRegex }, { name: searchRegex }];
  }
  const processes = await Process.paginate(filter, options);
  return processes;
};

/**
 * Get process by id
 * @param {ObjectId} id
 * @returns {Promise<Process>}
 */
const getProcessById = async (id, companyId) => {
  const { Process } = getBooksModels();
  const process = await Process.findOne({ _id: id, companyId });
  if (!process) {
    throw new ApiError(httpStatus.NOT_FOUND, PROCESS_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return process;
};

/**
 * Update process by id
 * @param {ObjectId} processId
 * @param {Object} updateBody
 * @returns {Promise<Process>}
 */
const updateProcessById = async (processId, updateBody, userId) => {
  const { Process } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const process = await Process.findById(processId).session(session);
    if (!process) {
      throw new ApiError(httpStatus.NOT_FOUND, PROCESS_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const existingProcess = await Process.findOne({
      name: { $regex: new RegExp(`^${updateBody.name}$`, 'i') },
      companyId: process.companyId,
      _id: { $ne: processId },
    });

    if (existingProcess) {
      throw new ApiError(httpStatus.CONFLICT, 'Process with this name already exists');
    }

    Object.assign(process, updateBody);
    process.updatedBy = userId;
    await process.save({ session });
    await session.commitTransaction();
    return process;
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
 * Delete process by id
 * @param {ObjectId} processId
 * @returns {Promise<Process>}
 */
const deleteProcessById = async (processId, companyId) => {
  const { Process, Recipe } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const recipeUsingProcess = await Recipe.findOne({ processes: processId, companyId });
  if (recipeUsingProcess) {
    throw new ApiError(httpStatus.BAD_REQUEST, PROCESS_MESSAGES.DELETE_IN_USE);
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const process = await Process.findOne({ _id: processId, companyId }).session(session);
    if (!process) {
      throw new ApiError(httpStatus.NOT_FOUND, PROCESS_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    await Process.deleteOne({ _id: processId, companyId }, { session });
    await session.commitTransaction();
    return process;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const processDropdown = async filter => {
  const { Process } = getBooksModels();

  const processes = await Process.find(filter);
  return processes;
};

module.exports = {
  createProcess: withTransientRetry(createProcess),
  queryProcesses,
  getProcessById,
  updateProcessById,
  deleteProcessById,
  processDropdown,
};
