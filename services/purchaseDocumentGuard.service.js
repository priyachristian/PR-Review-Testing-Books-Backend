const mongoose = require('mongoose');
const { getBooksCrmModels, getBooksModels } = require('./model.service');
const { activateCustomerInBranch } = require('./customerValidation.service');
const { activateItemsInWarehouse, assertPurchaseLinesSelectable } = require('./documentItemEnricher.service');

// Applies user-confirmed vendor/item activations, then the item guard. Run inside the save transaction.
const preparePurchaseDocumentSave = async ({
  vendorId,
  branchId,
  warehouseId,
  items = [],
  carriedItemIds = [],
  companyId,
  userId,
  session,
  activateVendorBranch = false,
  activateItemWarehouse = false,
  documentLabel,
}) => {
  const { Customer, Branch } = getBooksCrmModels();

  if (activateVendorBranch && vendorId && branchId) {
    await activateCustomerInBranch({ customerId: vendorId, branchId, companyId, session, models: { Customer, Branch } });
  }
  if (activateItemWarehouse && warehouseId) {
    await activateItemsInWarehouse({ itemIds: items.map(item => item?.itemId), warehouseId, companyId, userId, session });
  }

  await assertPurchaseLinesSelectable(items, { carriedItemIds, warehouseId, companyId, session, documentLabel });
};

// Item ids on the source PO/GRPO lines; only these count as carried on a conversion.
const getSourceItemIds = async ({ purchaseOrders = [], grpoIds = [], companyId, session }) => {
  const { PurchaseOrder, GrpoOrder } = getBooksModels();
  const toIds = (refs, key) =>
    (refs || [])
      .map(ref => ref?.[key])
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
  const poIds = toIds(purchaseOrders, 'purchaseOrderId');
  const grpoObjectIds = toIds(grpoIds, 'grpoId');

  // Sequential: a transaction session does not allow concurrent operations.
  const pos = poIds.length
    ? await PurchaseOrder.find({ _id: { $in: poIds }, companyId })
        .select('items.itemId')
        .session(session)
        .lean()
    : [];
  const grpos = grpoObjectIds.length
    ? await GrpoOrder.find({ _id: { $in: grpoObjectIds }, companyId })
        .select('items.itemId')
        .session(session)
        .lean()
    : [];
  return [...pos, ...grpos].flatMap(doc => (doc.items || []).map(item => item.itemId));
};

module.exports = {
  preparePurchaseDocumentSave,
  getSourceItemIds,
};
