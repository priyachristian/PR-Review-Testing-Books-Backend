const httpStatus = require('http-status');
const { getBooksModels, getBooksCrmModels, getClientConnection } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { QC_MASTER_MESSAGES } = require('../../../utils/messages');
const { MODULE_NAMES } = require('../../../utils/enum');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');

/**
 * Create a new QC Master
 * @param {Object} qcBody
 * @param {ObjectId} userId
 * @returns {Promise<QualityMaster>}
 */
const createNewQCMaster = async (qcBody, userId) => {
  const { QualityMaster } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const qcData = {
      ...qcBody,
      addedBy: userId,
      updatedBy: userId,
    };

    qcData.qcReportID = await generateUniqueId(
      QualityMaster,
      qcBody?.companyId,
      MODULE_NAMES.QUALITY_MASTER,
      'qcReportID',
      'QC',
      session,
      qcBody.qcReportID,
    );

    const newQCMaster = await QualityMaster.create([qcData], { session });
    await session.commitTransaction();
    return newQCMaster[0];
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
 * Get all QC Masters for a company
 * @param {ObjectId} companyId
 * @returns {Promise<Array<QualityMaster>>}
 */
const getAllQCMasters = async (query, filter, options) => {
  const { QualityMaster } = getBooksModels();
  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    filter.$or = [
      { qcReportID: searchRegex },
      { qcReportName: searchRegex },
      { productName: searchRegex },
      { qcReportResponsible: searchRegex },
      { qcType: searchRegex },
    ];
  }

  const qcMasters = await QualityMaster.paginate(filter, options);
  return qcMasters;
};

const updateQCMaster = async (qcMasterId, updateBody, userId) => {
  const { QualityMaster } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const qcMaster = await QualityMaster.findById(qcMasterId).session(session);
    if (!qcMaster) {
      throw new ApiError(httpStatus.NOT_FOUND, QC_MASTER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    Object.assign(qcMaster, updateBody);
    qcMaster.updatedBy = userId;

    await qcMaster.save({ session });
    await session.commitTransaction();
    return qcMaster;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteQCMaster = async (qcMasterId, companyId) => {
  const { QualityMaster } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const itemUsingQCMaster = await Item.findOne({
    companyId,
    'salesData.fqlStander': qcMasterId,
  });
  if (itemUsingQCMaster) {
    throw new ApiError(httpStatus.BAD_REQUEST, QC_MASTER_MESSAGES.DELETE_IN_USE);
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const qcMaster = await QualityMaster.findOne({ _id: qcMasterId, companyId }).session(session);
    if (!qcMaster) {
      throw new ApiError(httpStatus.NOT_FOUND, QC_MASTER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    await QualityMaster.deleteOne({ _id: qcMasterId, companyId }, { session });
    await session.commitTransaction();
    return qcMaster;
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
 * Get Recipe for dropdown (only qcReportName, id and qcReportID)
 * @param {Object} filter - Mongo filter
 * @returns {Promise<Array>}
 */
const getQCDropdown = async filter => {
  const { QualityMaster } = getBooksModels();
  const QCMaster = await QualityMaster.find(filter).select('qcReportName qcReportID id').lean();
  return QCMaster;
};

const getQCById = async (qcMasterId, companyId) => {
  const { QualityMaster } = getBooksModels();

  const qc = await QualityMaster.findOne({ _id: qcMasterId, companyId });
  if (!qc) {
    throw new ApiError(httpStatus.NOT_FOUND, QC_MASTER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  return qc;
};

module.exports = {
  createNewQCMaster: withTransientRetry(createNewQCMaster),
  getAllQCMasters,
  updateQCMaster,
  deleteQCMaster,
  getQCDropdown,
  getQCById,
};
