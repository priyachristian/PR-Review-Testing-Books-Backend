const mongoose = require('mongoose');
const { getBooksModels, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { createSearchRegex } = require('../../../utils/regexUtils');
const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
/**
 * Get all inventory logs with filters and options
 * @param {Object} query
 * @param {Object} filter
 * @param {Object} options
 * @returns {Promise<Array<InventoryLogs>>}
 */
const getAllInventoryLogs = async (query, filter, options) => {
  const { InventoryLogs } = getBooksModels();
  const { Item, Branch, Division, Warehouse } = getBooksCrmModels();
  const { User } = getCommonModels();
  filter.companyId = new mongoose.Types.ObjectId(filter.companyId);

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'createdAt' });
  if (branchDivisionCond) {
    Object.assign(filter, branchDivisionCond);
  }

  if (filter.warehouseId) {
    filter.warehouseId = new mongoose.Types.ObjectId(filter.warehouseId);
  }

  if (filter.itemId) {
    filter.itemId = new mongoose.Types.ObjectId(filter.itemId);
  }

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    const matchingBranch = await Branch.find({ name: searchRegex }).select('_id');
    const matchingDivision = await Division.find({ name: searchRegex }).select('_id');
    const matchingWarehouse = await Warehouse.find({ name: searchRegex }).select('_id');
    const matchingItem = await Item.find({ itemName: searchRegex }).select('_id');
    const matchingUser = await User.find({
      $or: [{ firstName: searchRegex }, { lastName: searchRegex }],
    }).select('_id');

    const branchIds = matchingBranch.map(branch => branch._id);
    const divisionIds = matchingDivision.map(div => div._id);
    const warehouseIds = matchingWarehouse.map(warehouse => warehouse._id);
    const itemIds = matchingItem.map(item => item._id);
    const userIds = matchingUser.map(user => user._id);

    filter.$or = [
      { referenceNumber: searchRegex },
      { notes: searchRegex },
      { branchId: { $in: branchIds } },
      { divisionId: { $in: divisionIds } },
      { warehouseId: { $in: warehouseIds } },
      { itemId: { $in: itemIds } },
      { createdBy: { $in: userIds } },
    ];
  }

  // Get the paginated results
  const result = await InventoryLogs.paginateWithTotal(filter, options);

  // Get all unique IDs from the results for population
  const itemIds = [...new Set(result.results.map(log => log.itemId))];
  const branchIds = [...new Set(result.results.map(log => log.branchId))];
  const divisionIds = [...new Set(result.results.map(log => log.divisionId))];
  const warehouseIds = [...new Set(result.results.map(log => log.warehouseId))];
  const userIds = [...new Set(result.results.map(log => log.createdBy))];

  // Fetch all related data in parallel
  const [items, branches, divisions, warehouses, users] = await Promise.all([
    Item.find({ _id: { $in: itemIds } })
      .select('itemName itemCode')
      .lean(),
    Branch.find({ _id: { $in: branchIds } })
      .select('name')
      .lean(),
    Division.find({ _id: { $in: divisionIds } })
      .select('name')
      .lean(),
    Warehouse.find({ _id: { $in: warehouseIds } })
      .select('name')
      .lean(),
    User.find({ _id: { $in: userIds } })
      .select('firstName lastName email')
      .lean(),
  ]);

  // Create maps for quick lookups
  const itemMap = items.reduce((acc, item) => {
    acc[item._id.toString()] = item;
    return acc;
  }, {});

  const branchMap = branches.reduce((acc, branch) => {
    acc[branch._id.toString()] = branch;
    return acc;
  }, {});

  const divisionMap = divisions.reduce((acc, division) => {
    acc[division._id.toString()] = division;
    return acc;
  }, {});

  const warehouseMap = warehouses.reduce((acc, warehouse) => {
    acc[warehouse._id.toString()] = warehouse;
    return acc;
  }, {});

  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  // Populate the results with related data
  const populatedResults = result.results.map(log => {
    const logObj = log.toObject();
    logObj.item = itemMap[log.itemId?.toString()] || null;
    logObj.branch = branchMap[log.branchId?.toString()] || null;
    logObj.division = divisionMap[log.divisionId?.toString()] || null;
    logObj.warehouse = warehouseMap[log.warehouseId?.toString()] || null;
    logObj.createdByUser = userMap[log.createdBy?.toString()] || null;

    logObj.itemName = logObj.item?.itemName || '';
    logObj.branchName = logObj.branch?.name || '';
    logObj.divisionName = logObj.division?.name || '';
    logObj.warehouseName = logObj.warehouse?.name || '';
    logObj.createdByUserFullName = logObj.createdByUser?.firstName + ' ' + logObj.createdByUser?.lastName || '';
    logObj.createdByUserEmail = logObj.createdByUser?.email || '';

    logObj.id = logObj._id;

    delete logObj.item;
    delete logObj.branch;
    delete logObj.division;
    delete logObj.warehouse;
    delete logObj.createdByUser;
    delete logObj._id;
    delete logObj.__v;
    return logObj;
  });

  return {
    ...result,
    results: populatedResults,
  };
};

/**
 * Get inventory log by ID
 * @param {ObjectId} id
 * @param {ObjectId} companyId
 * @returns {Promise<InventoryLogs>}
 */
const getInventoryLogById = async (id, companyId) => {
  const { InventoryLogs } = getBooksModels();
  const { Item, Branch, Division, Warehouse } = getBooksCrmModels();
  const { User } = getCommonModels();

  const data = await InventoryLogs.findOne({ _id: id, companyId });
  if (!data) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Inventory Log not found');
  }

  const [item, branch, division, warehouse, createdByUser] = await Promise.all([
    Item.findById(data.itemId).select('itemName itemCode').lean(),
    Branch.findById(data.branchId).select('name').lean(),
    Division.findById(data.divisionId).select('name').lean(),
    Warehouse.findById(data.warehouseId).select('name').lean(),
    User.findById(data.createdBy).select('firstName lastName email').lean(),
  ]);

  const logObj = data.toObject();
  logObj.item = item;
  logObj.branch = branch;
  logObj.division = division;
  logObj.warehouse = warehouse;
  logObj.createdByUser = createdByUser;

  logObj.itemName = logObj.item?.itemName || '';
  logObj.branchName = logObj.branch?.name || '';
  logObj.divisionName = logObj.division?.name || '';
  logObj.warehouseName = logObj.warehouse?.name || '';
  logObj.createdByUserFullName = logObj.createdByUser?.firstName + ' ' + logObj.createdByUser?.lastName || '';
  logObj.createdByUserEmail = logObj.createdByUser?.email || '';

  delete logObj.item;
  delete logObj.branch;
  delete logObj.division;
  delete logObj.warehouse;
  delete logObj.createdByUser;
  delete logObj._id;
  delete logObj.__v;
  return logObj;
};

module.exports = {
  getAllInventoryLogs,
  getInventoryLogById,
};
