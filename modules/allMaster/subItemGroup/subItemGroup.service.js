const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { SUB_ITEM_GROUP_MESSAGES } = require('../../../utils/messages');
const { getBooksCrmModels, getClientConnection } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');

// Per-company auto-increment: next number after the company's current highest subItemGroupId.
const getNextSubItemGroupId = async (SubItemGroup, companyId, session) => {
  const last = await SubItemGroup.findOne({ companyId, subItemGroupId: { $exists: true, $ne: null } })
    .sort({ subItemGroupId: -1 })
    .select('subItemGroupId')
    .session(session)
    .lean();
  return (last?.subItemGroupId || 0) + 1;
};

const MAX_ID_RETRIES = 5;

const createSubItemGroup = async subItemGroupBody => {
  const { SubItemGroup } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  for (let attempt = 1; ; attempt += 1) {
    const session = await connection.startSession();

    try {
      await session.startTransaction();

      const existingSubItemGroup = await SubItemGroup.findOne({
        name: { $regex: new RegExp(`^${subItemGroupBody.name}$`, 'i') },
        companyId: subItemGroupBody.companyId,
      }).session(session);

      if (existingSubItemGroup) {
        throw new ApiError(httpStatus.CONFLICT, 'Sub Item Group with this name already exists');
      }

      const nextId = await getNextSubItemGroupId(SubItemGroup, subItemGroupBody.companyId, session);

      const subItemGroup = await SubItemGroup.create([{ ...subItemGroupBody, subItemGroupId: nextId, appName: APP_NAME.BOOKS }], {
        session,
      });
      await session.commitTransaction();
      return subItemGroup[0];
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      // Two concurrent creates picked the same number and the unique (companyId, subItemGroupId) index rejected one - retry with a fresh number.
      const isIdCollision = error?.code === 11000 && error?.keyPattern?.subItemGroupId;
      if (!isIdCollision || attempt >= MAX_ID_RETRIES) {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }
};

const querySubItemGroups = async (filter, options) => {
  const { SubItemGroup, Item, ItemGroup } = getBooksCrmModels();

  filter.companyId = new mongoose.Types.ObjectId(filter.companyId);

  if (filter?.search) {
    const searchText = filter?.search.trim();
    const searchRegex = createSearchRegex(filter.search.trim());
    const idDigits = searchText.replace(/^sig-?/i, '');
    filter.$or = [{ name: searchRegex }];
    if (/^\d+$/.test(idDigits)) {
      filter.$or.push({
        $expr: { $regexMatch: { input: { $toString: '$subItemGroupId' }, regex: idDigits } },
      });
    }
    delete filter.search;
  }

  const subItemGroups = await SubItemGroup.paginate(filter, options);

  const subItemGroupIds = subItemGroups.results.map(group => group._id);

  const [itemCounts, itemGroupCount] = await Promise.all([
    Item.aggregate([
      { $match: { subItemGroup: { $in: subItemGroupIds } } },
      { $group: { _id: '$subItemGroup', itemCount: { $sum: 1 } } },
    ]),
    ItemGroup.countDocuments({ companyId: filter.companyId }),
  ]);

  const countMap = new Map(itemCounts.map(i => [i._id.toString(), i.itemCount]));

  subItemGroups.results = subItemGroups.results.map(group => ({
    ...group.toObject(),
    itemCount: countMap.get(group._id.toString()) || 0,
  }));

  subItemGroups.itemGroupCount = itemGroupCount;

  return subItemGroups;
};

const subItemGroupDropdown = async filter => {
  const { SubItemGroup } = getBooksCrmModels();
  const subItemGroups = await SubItemGroup.find(filter);
  return subItemGroups;
};

const getSubItemGroupById = async (id, companyId) => {
  const { SubItemGroup, Item } = getBooksCrmModels();
  const subItemGroup = await SubItemGroup.findOne({ _id: id, companyId }).lean();

  if (!subItemGroup) {
    throw new ApiError(httpStatus.NOT_FOUND, SUB_ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const items = await Item.find(
    { subItemGroup: subItemGroup._id, companyId },
    { itemName: 1, itemNo: 1, itemType: 1, itemStatus: 1 },
  ).lean();

  subItemGroup.items = items.map(item => ({
    itemId: item._id,
    itemName: item.itemName,
    itemNo: item.itemNo,
    itemType: item.itemType,
    itemStatus: item.itemStatus,
  }));

  subItemGroup.itemCount = items.length;

  return subItemGroup;
};

const updateSubItemGroupById = async (subItemGroupId, companyId, updateBody) => {
  const { SubItemGroup } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const subItemGroup = await SubItemGroup.findOne({ _id: subItemGroupId, companyId }).session(session);
    if (!subItemGroup) {
      throw new ApiError(httpStatus.NOT_FOUND, SUB_ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const existingSubItemGroup = await SubItemGroup.findOne({
      name: { $regex: new RegExp(`^${updateBody.name}$`, 'i') },
      companyId: subItemGroup.companyId,
      _id: { $ne: subItemGroupId },
    }).session(session);

    if (existingSubItemGroup) {
      throw new ApiError(httpStatus.CONFLICT, 'Sub Item Group with this name already exists');
    }
    Object.assign(subItemGroup, updateBody);
    await subItemGroup.save({ session });
    await session.commitTransaction();
    return subItemGroup;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteSubItemGroupById = async (subItemGroupId, companyId) => {
  const { SubItemGroup, Item } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const itemUsingGroup = await Item.findOne({ subItemGroup: subItemGroupId, companyId });
  if (itemUsingGroup) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete: Sub Item Group is used in one or more items');
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const subItemGroup = await SubItemGroup.findById(subItemGroupId).session(session);
    if (!subItemGroup) {
      throw new ApiError(httpStatus.NOT_FOUND, SUB_ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    await subItemGroup.deleteOne({ session });
    await session.commitTransaction();
    return subItemGroup;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  createSubItemGroup,
  querySubItemGroups,
  getSubItemGroupById,
  updateSubItemGroupById,
  deleteSubItemGroupById,
  subItemGroupDropdown,
};
