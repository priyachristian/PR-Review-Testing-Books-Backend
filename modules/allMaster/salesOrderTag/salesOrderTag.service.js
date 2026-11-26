const httpStatus = require('http-status');
const { getBooksCrmModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { MODULE_NAMES } = require('../../../utils/enum');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');

const createTag = async (tagBody, userId) => {
  const { SalesOrderTag } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const existing = await SalesOrderTag.findOne(
      {
        name: { $regex: new RegExp(`^${tagBody.name}$`, 'i') },
        companyId: tagBody.companyId,
      },
      null,
      { session },
    );

    if (existing) {
      throw new ApiError(httpStatus.CONFLICT, 'A tag with this name already exists in the same company');
    }

    tagBody.tagId = await generateUniqueId(
      SalesOrderTag,
      tagBody.companyId,
      MODULE_NAMES.SALES_ORDER_TAG,
      'tagId',
      'TAG',
      session,
      tagBody.tagId,
    );

    tagBody.createdBy = userId;
    tagBody.updatedBy = userId;
    tagBody.appName = APP_NAME.BOOKS;

    const tag = await SalesOrderTag.create([tagBody], { session });

    await session.commitTransaction();
    session.endSession();

    return tag[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    throw error;
  }
};

const getTagsByCompanyId = async (filter, options) => {
  const { SalesOrderTag } = getBooksCrmModels();
  const { User } = getCommonModels();

  if (filter.search) {
    const regex = createSearchRegex(filter.search);
    filter.$or = [{ name: regex }, { color: regex }];
    delete filter.search;
  }

  const tags = await SalesOrderTag.paginate(filter, options);
  if (!tags) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Tags not found');
  }

  const { results, ...otherFields } = tags;
  const createdBy = results.map(tag => tag.createdBy).filter(Boolean);
  const updatedBy = results.map(tag => tag.updatedBy).filter(Boolean);
  const userIds = [...new Set([...createdBy, ...updatedBy].map(id => id.toString()))];

  const users = await User.find({ _id: { $in: userIds } }, { _id: 1, firstName: 1, lastName: 1 });
  const userMap = users.reduce((acc, user) => {
    acc[user._id] = `${user.firstName} ${user.lastName}`;
    return acc;
  }, {});

  const tagsWithUserNames = results.map(tag => ({
    ...tag.toObject(),
    createdByName: userMap[tag.createdBy] || null,
    updatedByName: userMap[tag.updatedBy] || null,
  }));

  return { results: tagsWithUserNames, ...otherFields };
};

const updateTagById = async (tagId, updateBody, userId) => {
  const { SalesOrderTag } = getBooksCrmModels();

  const tag = await SalesOrderTag.findOne({ _id: tagId, companyId: updateBody?.companyId });
  if (!tag) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Tag not found');
  }

  if (updateBody.name) {
    const existing = await SalesOrderTag.findOne({
      _id: { $ne: tagId },
      name: { $regex: new RegExp(`^${updateBody.name}$`, 'i') },
      companyId: tag.companyId,
    });
    if (existing) {
      throw new ApiError(httpStatus.CONFLICT, 'A tag with this name already exists in the same company');
    }
  }

  Object.assign(tag, { ...updateBody, updatedBy: userId });
  await tag.save();
  return tag;
};

const deleteTagById = async (tagId, companyId) => {
  const { SalesOrderTag, SalesOrder } = getBooksCrmModels();

  const tag = await SalesOrderTag.findOne({ _id: tagId, companyId });
  if (!tag) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Tag not found');
  }

  const usedCount = await SalesOrder.countDocuments({ companyId, tagId: tagId });
  if (usedCount) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Tag cannot be deleted because it is used in one or more sales orders');
  }

  await SalesOrderTag.deleteOne({ _id: tagId });
};

const getTagDropdown = async companyId => {
  const { SalesOrderTag } = getBooksCrmModels();
  return SalesOrderTag.find({ companyId }, { _id: 1, name: 1, color: 1, tagId: 1 });
};

const getTagById = async (tagId, companyId) => {
  const { SalesOrderTag } = getBooksCrmModels();
  const { User } = getCommonModels();

  const salesOrderTag = await SalesOrderTag.findOne({ _id: tagId, companyId });

  const createdByUser = salesOrderTag?.createdBy ? await User.findById(salesOrderTag.createdBy) : null;
  const updatedByUser = salesOrderTag?.updatedBy ? await User.findById(salesOrderTag.updatedBy) : null;

  return {
    ...salesOrderTag?.toObject(),
    createdByName: createdByUser ? `${createdByUser.firstName} ${createdByUser.lastName}` : null,
    updatedByName: updatedByUser ? `${updatedByUser.firstName} ${updatedByUser.lastName}` : null,
  };
};

module.exports = {
  createTag: withTransientRetry(createTag),
  getTagsByCompanyId,
  updateTagById,
  deleteTagById,
  getTagDropdown,
  getTagById,
};
