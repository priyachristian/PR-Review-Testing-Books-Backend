const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { ITEM_GROUP_MESSAGES } = require('../../../utils/messages');
const { getBooksCrmModels, getClientConnection } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { MODULE_NAMES } = require('../../../utils/enum');

/**
 * Create an item group
 * @param {Object} itemGroupBody
 * @returns {Promise<ItemGroup>}
 */
const createItemGroup = async itemGroupBody => {
  const { ItemGroup } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    itemGroupBody.itemGroupId = await generateUniqueId(
      ItemGroup,
      itemGroupBody?.companyId,
      MODULE_NAMES.ITEMGROUP,
      'itemGroupId',
      'IG',
      session,
      itemGroupBody.itemGroupId,
    );
    const existingItemGroup = await ItemGroup.findOne({
      name: { $regex: new RegExp(`^${itemGroupBody.name}$`, 'i') },
      companyId: itemGroupBody.companyId,
    });

    if (existingItemGroup) {
      throw new ApiError(httpStatus.CONFLICT, 'Item Group with this name already exists');
    }
    const itemGroup = await ItemGroup.create([{ ...itemGroupBody, appName: APP_NAME.BOOKS }], { session });
    await session.commitTransaction();
    return itemGroup[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryItemGroups = async (filter, options) => {
  const { ItemGroup, Item, SubItemGroup } = getBooksCrmModels();

  filter.companyId = new mongoose.Types.ObjectId(filter.companyId);

  if (filter?.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    filter.$or = [{ name: searchRegex }, { itemGroupId: searchRegex }];
    delete filter.search;
  }

  const itemGroups = await ItemGroup.paginate(filter, options);

  const itemGroupIds = itemGroups.results.map(group => group._id);

  const [itemCounts, subItemGroupCount] = await Promise.all([
    Item.aggregate([
      {
        $match: {
          itemGroup: {
            $in: itemGroupIds,
          },
        },
      },

      {
        $group: {
          _id: '$itemGroup',

          itemCount: {
            $sum: 1,
          },
        },
      },
    ]),
    SubItemGroup.countDocuments({ companyId: filter.companyId }),
  ]);

  const countMap = new Map(itemCounts.map(i => [i._id.toString(), i.itemCount]));

  itemGroups.results = itemGroups.results.map(group => ({
    ...group.toObject(),
    itemCount: countMap.get(group._id.toString()) || 0,
  }));

  itemGroups.subItemGroupCount = subItemGroupCount;

  return itemGroups;
};

const itemGroupDropdown = async filter => {
  const { ItemGroup } = getBooksCrmModels();

  const itemGroups = await ItemGroup.find(filter);
  return itemGroups;
};

/**
 * Get item group by id
 * @param {ObjectId} id
 * @returns {Promise<ItemGroup>}
 */
const getItemGroupById = async (id, companyId) => {
  const { ItemGroup, Item } = getBooksCrmModels();
  const itemGroup = await ItemGroup.findOne({ _id: id, companyId }).lean();

  if (!itemGroup) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const items = await Item.find(
    {
      itemGroup: itemGroup._id,
      companyId,
    },
    {
      itemName: 1,
      itemNo: 1,
      itemType: 1,
      itemStatus: 1,
    },
  ).lean();

  itemGroup.items = items.map(item => ({
    itemId: item._id,
    itemName: item.itemName,
    itemNo: item.itemNo,
    itemType: item.itemType,
    itemStatus: item.itemStatus,
  }));

  itemGroup.itemCount = items.length;
  //itemGroup.id = itemGroup._id?.toString();

  return itemGroup;
};

/**
 * Update item group by id
 * @param {ObjectId} itemGroupId
 * @param {Object} updateBody
 * @returns {Promise<ItemGroup>}
 */
const updateItemGroupById = async (itemGroupId, companyId, updateBody) => {
  const { ItemGroup } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const itemGroup = await ItemGroup.findOne({ _id: itemGroupId, companyId }).session(session);
    if (!itemGroup) {
      throw new ApiError(httpStatus.NOT_FOUND, ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const existingItemGroup = await ItemGroup.findOne({
      name: { $regex: new RegExp(`^${updateBody.name}$`, 'i') },
      companyId: itemGroup.companyId,
      _id: { $ne: itemGroupId },
    });

    if (existingItemGroup) {
      throw new ApiError(httpStatus.CONFLICT, 'Item Group with this name already exists');
    }
    Object.assign(itemGroup, updateBody);
    await itemGroup.save({ session });
    await session.commitTransaction();
    return itemGroup;
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
 * Delete item group by id
 * @param {ObjectId} itemGroupId
 * @returns {Promise<ItemGroup>}
 */
const deleteItemGroupById = async (itemGroupId, companyId) => {
  const { ItemGroup, Item } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const itemUsingGroup = await Item.findOne({ itemGroup: itemGroupId, companyId });
  if (itemUsingGroup) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete: Item Group is used in one or more items');
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const itemGroup = await ItemGroup.findById(itemGroupId).session(session);
    if (!itemGroup) {
      throw new ApiError(httpStatus.NOT_FOUND, ITEM_GROUP_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    await itemGroup.deleteOne({ session });
    await session.commitTransaction();
    return itemGroup;
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
  createItemGroup: withTransientRetry(createItemGroup),
  queryItemGroups,
  getItemGroupById,
  updateItemGroupById,
  deleteItemGroupById,
  itemGroupDropdown,
};
