const { getBooksCrmModels } = require('../services/model.service');

// New rows are inactive unless the caller explicitly asks for isActive: true; stock never moves on an inactive row.
const defaultWarehouseEntry = async (
  { itemArray = [], warehouseId = null, branchId = null, divisionId = null, companyId = null, isActive = false },
  session = null,
) => {
  if (!itemArray?.length || !warehouseId) return;

  const { ItemInventory, Item } = getBooksCrmModels();

  // Get unique item IDs (items can have itemId or _id)
  const candidateItemIds = [...new Set(itemArray.map(i => i?.itemId || i?._id).filter(Boolean))];
  if (candidateItemIds.length === 0) return;

  // Service items should never affect inventory warehouse entries.
  const nonServiceItems = await Item.find({
    _id: { $in: candidateItemIds },
    companyId,
    'itemCategory.isService': { $ne: true },
  })
    .select('_id')
    .session(session)
    .lean();
  const itemIds = (nonServiceItems ?? [])?.map(item => item?._id);
  if (itemIds.length === 0) return;

  // Single query: find all item inventories that already have this warehouse
  const existingInventories = await ItemInventory.find({
    itemId: { $in: itemIds },
    companyId,
    'warehouses.warehouseId': warehouseId,
  })
    .select('itemId')
    .session(session)
    .lean();

  const itemIdsWithWarehouse = new Set((existingInventories ?? []).map(inv => inv?.itemId?.toString()).filter(Boolean));

  // Filter to items that need the warehouse added
  const itemsToUpdate = itemIds.filter(id => id != null && !itemIdsWithWarehouse.has(id?.toString()));
  if (itemsToUpdate.length === 0) return;

  const newWarehouse = {
    divisionId,
    branchId,
    warehouseId,
    isActive,
    openingStock: 0,
    availableStock: 0,
  };

  // Bulk update in a single round-trip
  await ItemInventory.bulkWrite(
    itemsToUpdate
      .filter(itemId => itemId != null)
      .map(itemId => ({
        updateOne: {
          filter: { itemId, companyId },
          update: { $push: { warehouses: newWarehouse } },
        },
      })),
    { session },
  );
};

module.exports = {
  defaultWarehouseEntry,
};
