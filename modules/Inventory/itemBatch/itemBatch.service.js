const mongoose = require('mongoose');
const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksCrmModels } = require('../../../services/model.service');
const { ITEM_BATCH_DETAILS_POPULATE, buildItemBatchDetails } = require('../../allMaster/item/item.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { ITEM_BATCH_MESSAGES } = require('../../../utils/messages');

const queryItemBatches = async (filter, options) => {
  const { ItemBatch, Item, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();

  filter.companyId = new mongoose.Types.ObjectId(filter.companyId);

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'createdAt' });
  delete filter.divisionId;
  delete filter.branchId;
  delete filter.startDate;
  delete filter.endDate;
  if (branchDivisionCond) {
    Object.assign(filter, branchDivisionCond);
  }

  if (filter.warehouseId) {
    filter.warehouseId = new mongoose.Types.ObjectId(filter.warehouseId);
  }

  if (filter.itemId) {
    filter.itemId = new mongoose.Types.ObjectId(filter.itemId);
  }

  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    const matchingItems = await Item.find({ itemName: searchRegex }).select('_id');
    const matchingBranches = await Branch.find({ name: searchRegex }).select('_id');
    const matchingDivisions = await Division.find({ name: searchRegex }).select('_id');
    const matchingWarehouses = await Warehouse.find({ name: searchRegex }).select('_id');

    filter.$or = [
      { vendorBatchNo: searchRegex },
      { userBatchNo: searchRegex },
      { itemId: { $in: matchingItems.map(i => i._id) } },
      { branchId: { $in: matchingBranches.map(b => b._id) } },
      { divisionId: { $in: matchingDivisions.map(d => d._id) } },
      { warehouseId: { $in: matchingWarehouses.map(w => w._id) } },
    ];
    delete filter.search;
  }

  const result = await ItemBatch.paginate(filter, options);

  const itemIds = [...new Set(result.results.map(b => b.itemId).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(b => b.branchId).filter(Boolean))];
  const divisionIds = [...new Set(result.results.map(b => b.divisionId).filter(Boolean))];
  const warehouseIds = [...new Set(result.results.map(b => b.warehouseId).filter(Boolean))];
  const itemUnitIds = [...new Set(result.results.map(b => b.itemUnitId).filter(Boolean))];

  const [items, branches, divisions, warehouses, itemUnits] = await Promise.all([
    Item.find({ _id: { $in: itemIds } })
      .select('itemName itemNo')
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
    ItemUnit.find({ _id: { $in: itemUnitIds } })
      .select('name')
      .lean(),
  ]);

  const itemMap = items.reduce((acc, i) => {
    acc[i._id.toString()] = i;
    return acc;
  }, {});
  const branchMap = branches.reduce((acc, b) => {
    acc[b._id.toString()] = b;
    return acc;
  }, {});
  const divisionMap = divisions.reduce((acc, d) => {
    acc[d._id.toString()] = d;
    return acc;
  }, {});
  const warehouseMap = warehouses.reduce((acc, w) => {
    acc[w._id.toString()] = w;
    return acc;
  }, {});
  const itemUnitMap = itemUnits.reduce((acc, u) => {
    acc[u._id.toString()] = u;
    return acc;
  }, {});

  const populatedResults = result.results.map(batch => {
    const obj = batch.toObject();
    const unit = itemUnitMap[batch.itemUnitId?.toString()];
    obj.itemName = itemMap[batch.itemId?.toString()]?.itemName || '';
    obj.itemNo = itemMap[batch.itemId?.toString()]?.itemNo || '';
    obj.branchName = branchMap[batch.branchId?.toString()]?.name || '';
    obj.divisionName = divisionMap[batch.divisionId?.toString()]?.name || '';
    obj.warehouseName = warehouseMap[batch.warehouseId?.toString()]?.name || '';
    obj.itemUnitName = unit?.name || obj.itemUnit || '';
    if (unit) {
      obj.itemUnitId = { _id: unit._id, name: unit.name };
    }
    return obj;
  });

  return { ...result, results: populatedResults };
};

const getItemBatchById = async (id, companyId) => {
  const { ItemBatch } = getBooksCrmModels();

  const rawBatch = await ItemBatch.findOne({ _id: id, companyId }).populate(ITEM_BATCH_DETAILS_POPULATE).lean();
  if (!rawBatch) {
    throw new ApiError(httpStatus.NOT_FOUND, ITEM_BATCH_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  return buildItemBatchDetails(rawBatch, companyId, { includeAddedBy: true });
};

module.exports = {
  queryItemBatches,
  getItemBatchById,
};
