const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const { ACCOUNT_CATEGORIES } = require('../../../utils/enum');

const VALID_INVENTORY_SALES_METHODS = ['NEAREST_EXPIRY_DATE', 'SALES_TO_OPTION', 'LIFO', 'FIFO'];

const DATA_SETUP_KEYS = {
  CUSTOMER_ACCOUNT: 'customerAccount',
  CUSTOMER_BRANCH: 'customerBranch',
  ITEM_INVENTORY: 'itemInventory',
  ITEM_WAREHOUSE: 'itemWarehouse',
  QUOTE_SO_LOCATION: 'quoteSoLocation',
};

const DATA_SETUP_DEFS = [
  {
    key: DATA_SETUP_KEYS.CUSTOMER_ACCOUNT,
    label: 'Connect customer to correct accounting ledger',
    description: 'Ensure every customer and vendor is linked to the correct accounting ledger.',
    needsParams: false,
  },
  {
    key: DATA_SETUP_KEYS.CUSTOMER_BRANCH,
    label: 'Set up customer branch access',
    description: 'Give customers access to all company branches where no branch assignments exist.',
    needsParams: false,
  },
  {
    key: DATA_SETUP_KEYS.ITEM_INVENTORY,
    label: 'Enable inventory tracking',
    description: 'Create inventory records for items that are not yet inventory-enabled.',
    needsParams: false,
  },
  {
    key: DATA_SETUP_KEYS.ITEM_WAREHOUSE,
    label: 'Enable items in all warehouses',
    description: 'Give every inventory item an active entry in all company warehouses.',
    needsParams: false,
  },
  {
    key: DATA_SETUP_KEYS.QUOTE_SO_LOCATION,
    label: 'Apply default locations',
    description: 'Automatically fill missing branch, division, and warehouse information on quotes and sales orders.',
    needsParams: true,
  },
];

const DATA_SETUP_KEY_SET = new Set(DATA_SETUP_DEFS.map(d => d.key));
const toObjectId = id => new mongoose.Types.ObjectId(id);

const MISSING_LOCATION = { $or: [{ branchId: null }, { divisionId: null }, { warehouseId: null }] };
const MISSING_ACCOUNT = { $or: [{ accountId: null }, { accountId: { $exists: false } }] };
const MISSING_BRANCH = { $or: [{ branch: { $exists: false } }, { branch: { $size: 0 } }] };

const SINGLE_ROLE = {
  $or: [
    { 'Role.isCustomer': true, 'Role.isVendor': { $ne: true } },
    { 'Role.isVendor': true, 'Role.isCustomer': { $ne: true } },
  ],
};
const ACCOUNT_BACKFILL_MATCH = { $and: [MISSING_ACCOUNT, SINGLE_ROLE] };

const GOODS_ONLY = { 'itemCategory.isGoods': true, 'itemCategory.isService': { $ne: true } };

/* ----------------------------- remaining counts ----------------------------- */

const countCustomerAccount = async cid => {
  const { Customer } = getBooksCrmModels();
  return Customer.countDocuments({ companyId: cid, ...ACCOUNT_BACKFILL_MATCH });
};

const countCustomerBranch = async cid => {
  const { Customer } = getBooksCrmModels();
  return Customer.countDocuments({ companyId: cid, ...MISSING_BRANCH });
};

const countItemInventory = async cid => {
  const { Item, ItemInventory } = getBooksCrmModels();
  const withInventory = await ItemInventory.distinct('itemId', { companyId: cid });
  return Item.countDocuments({ companyId: cid, _id: { $nin: withInventory }, ...GOODS_ONLY });
};

const itemWarehouseNeedsFix = (inv, allWarehouseIds) => {
  const activeCompanyWarehouses = new Set(
    (inv.warehouses || [])
      .filter(w => w.isActive === true && allWarehouseIds.has(String(w.warehouseId)))
      .map(w => String(w.warehouseId)),
  );
  return activeCompanyWarehouses.size < allWarehouseIds.size;
};

const countItemWarehouse = async cid => {
  const { ItemInventory, Warehouse } = getBooksCrmModels();
  const warehouses = await Warehouse.find({ companyId: cid }).select('_id').lean();
  if (!warehouses.length) return 0;
  const allWarehouseIds = new Set(warehouses.map(w => String(w._id)));
  const inventories = await ItemInventory.find({ companyId: cid }).select('warehouses.warehouseId warehouses.isActive').lean();
  return inventories.filter(inv => itemWarehouseNeedsFix(inv, allWarehouseIds)).length;
};

const countQuoteSoLocation = async cid => {
  const { Quote, SalesOrder } = getBooksCrmModels();
  const [q, s] = await Promise.all([
    Quote.countDocuments({ companyId: cid, ...MISSING_LOCATION }),
    SalesOrder.countDocuments({ companyId: cid, ...MISSING_LOCATION }),
  ]);
  return q + s;
};

const REMAINING_FNS = {
  [DATA_SETUP_KEYS.CUSTOMER_ACCOUNT]: countCustomerAccount,
  [DATA_SETUP_KEYS.CUSTOMER_BRANCH]: countCustomerBranch,
  [DATA_SETUP_KEYS.ITEM_INVENTORY]: countItemInventory,
  [DATA_SETUP_KEYS.ITEM_WAREHOUSE]: countItemWarehouse,
  [DATA_SETUP_KEYS.QUOTE_SO_LOCATION]: countQuoteSoLocation,
};

/* --------------------------------- backfills -------------------------------- */

const runCustomerAccount = async cid => {
  const { Customer } = getBooksCrmModels();
  const { Account } = getBooksModels();

  const [debtor, creditor] = await Promise.all([
    Account.findOne({ companyId: cid, category: ACCOUNT_CATEGORIES.ACCOUNTS_RECEIVABLE.code, isSystemAccount: true }).select(
      '_id',
    ),
    Account.findOne({ companyId: cid, category: ACCOUNT_CATEGORIES.ACCOUNTS_PAYABLE.code, isSystemAccount: true }).select('_id'),
  ]);

  if (!debtor || !creditor) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Default Debtor / Creditor accounts are not set up for this company. Cannot backfill.',
    );
  }

  const customerRes = await Customer.updateMany(
    { companyId: cid, 'Role.isCustomer': true, 'Role.isVendor': { $ne: true }, ...MISSING_ACCOUNT },
    { $set: { accountId: debtor._id } },
  );
  const vendorRes = await Customer.updateMany(
    { companyId: cid, 'Role.isVendor': true, 'Role.isCustomer': { $ne: true }, ...MISSING_ACCOUNT },
    { $set: { accountId: creditor._id } },
  );

  return (customerRes.modifiedCount || 0) + (vendorRes.modifiedCount || 0);
};

const runCustomerBranch = async cid => {
  const { Customer, Branch } = getBooksCrmModels();
  const branches = await Branch.find({ companyId: cid }).lean();

  if (!branches.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No branches found for this company. Create branches before backfilling.');
  }

  const branchEntries = branches.map(b => ({
    branchId: b._id,
    divisionId: b.divisionId || null,
    branchCode: b.branchCode || '',
    openingBalance: 0,
    currentBalance: 0,
    creditLimit: 0,
    isActive: b.isActive !== false,
    restrictedModule: [],
  }));

  const res = await Customer.updateMany({ companyId: cid, ...MISSING_BRANCH }, { $set: { branch: branchEntries } });
  return res.modifiedCount || 0;
};

const runItemInventory = async cid => {
  const { Item, ItemInventory, Warehouse } = getBooksCrmModels();

  const withInventory = await ItemInventory.distinct('itemId', { companyId: cid });
  const items = await Item.find({ companyId: cid, _id: { $nin: withInventory }, ...GOODS_ONLY }).lean();
  if (!items.length) return 0;

  const warehouses = await Warehouse.find({ companyId: cid }).lean();
  const warehouseMap = new Map(warehouses.map(w => [String(w._id), w]));

  const docs = items.map(item => {
    const inv = item.inventoryData || {};
    let totalAvailableStock = 0;

    const warehouseRows = (inv.branches || []).map(branch => {
      const wh = warehouseMap.get(String(branch.warehouseId));
      totalAvailableStock += Number(branch.availableStock || 0);
      return {
        divisionId: wh?.divisionId || null,
        branchId: wh?.branchId || null,
        warehouseId: branch.warehouseId || null,
        isActive: branch.isActive ?? true,
        openingStock: Number(branch.openingStock || 0),
        availableStock: Number(branch.availableStock || 0),
        inventoryValue: 0,
      };
    });

    const salesMethod = inv.inventorySalesMethod;

    return {
      itemId: item._id,
      companyId: cid,
      totalOpeningStock: Number(inv.totalOpeningStock || 0),
      totalAvailableStock,
      inventorySalesMethod: VALID_INVENTORY_SALES_METHODS.includes(salesMethod) ? salesMethod : null,
      warehouses: warehouseRows,
      addedBy: item.addedBy || null,
    };
  });

  try {
    const inserted = await ItemInventory.insertMany(docs, { ordered: false });
    return inserted.length;
  } catch (err) {
    if (err && Array.isArray(err.insertedDocs)) return err.insertedDocs.length;
    throw err;
  }
};

const runItemWarehouse = async cid => {
  const { ItemInventory, Warehouse } = getBooksCrmModels();
  const warehouses = await Warehouse.find({ companyId: cid }).lean();
  if (!warehouses.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No warehouses found for this company. Create warehouses before backfilling.');
  }

  const allWarehouseIds = new Set(warehouses.map(w => String(w._id)));
  const inventories = await ItemInventory.find({ companyId: cid }).lean();

  const ops = [];
  inventories.forEach(inv => {
    if (!itemWarehouseNeedsFix(inv, allWarehouseIds)) return;

    const existingByWarehouse = new Map((inv.warehouses || []).map(w => [String(w.warehouseId), w]));

    const merged = warehouses.map(wh => {
      const prev = existingByWarehouse.get(String(wh._id));
      if (prev) {
        return {
          ...prev,
          isActive: true,
          branchId: prev.branchId || wh.branchId || null,
          divisionId: prev.divisionId || wh.divisionId || null,
        };
      }
      return {
        divisionId: wh.divisionId || null,
        branchId: wh.branchId || null,
        warehouseId: wh._id,
        isActive: true,
        openingStock: 0,
        openingStockRate: 0,
        availableStock: 0,
        inventoryValue: 0,
      };
    });

    (inv.warehouses || []).forEach(w => {
      if (!allWarehouseIds.has(String(w.warehouseId))) {
        merged.push({ ...w, isActive: true });
      }
    });

    ops.push({ updateOne: { filter: { _id: inv._id }, update: { $set: { warehouses: merged } } } });
  });

  if (!ops.length) return 0;
  const res = await ItemInventory.bulkWrite(ops, { ordered: false });
  return res.modifiedCount || 0;
};

const runQuoteSoLocation = async (cid, params = {}) => {
  const { divisionId, branchId, warehouseId, quoteIds, soIds } = params;
  if (!divisionId || !branchId || !warehouseId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Division, branch and warehouse are required for this backfill.');
  }

  const { Quote, SalesOrder } = getBooksCrmModels();
  const setVal = {
    divisionId: toObjectId(divisionId),
    branchId: toObjectId(branchId),
    warehouseId: toObjectId(warehouseId),
  };

  if (!Array.isArray(quoteIds) || !Array.isArray(soIds)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'quoteIds and soIds are required.');
  }
  if (!quoteIds.length && !soIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No records selected. Select at least one quote or sales order.');
  }

  const baseFilter = { companyId: cid, ...MISSING_LOCATION };

  const [q, s] = await Promise.all([
    quoteIds.length
      ? Quote.updateMany({ ...baseFilter, _id: { $in: quoteIds.map(toObjectId) } }, { $set: setVal })
      : Promise.resolve({ modifiedCount: 0 }),
    soIds.length
      ? SalesOrder.updateMany({ ...baseFilter, _id: { $in: soIds.map(toObjectId) } }, { $set: setVal })
      : Promise.resolve({ modifiedCount: 0 }),
  ]);

  return (q.modifiedCount || 0) + (s.modifiedCount || 0);
};

const RUN_FNS = {
  [DATA_SETUP_KEYS.CUSTOMER_ACCOUNT]: runCustomerAccount,
  [DATA_SETUP_KEYS.CUSTOMER_BRANCH]: runCustomerBranch,
  [DATA_SETUP_KEYS.ITEM_INVENTORY]: runItemInventory,
  [DATA_SETUP_KEYS.ITEM_WAREHOUSE]: runItemWarehouse,
  [DATA_SETUP_KEYS.QUOTE_SO_LOCATION]: runQuoteSoLocation,
};

/* --------------------------------- preview ---------------------------------- */

const customerRoleType = customer => (customer?.Role?.isCustomer ? 'Customer' : 'Vendor');

const previewCustomers = async (cid, missing) => {
  const { Customer } = getBooksCrmModels();
  const docs = await Customer.find({ companyId: cid, ...missing })
    .select('customerNumber customerDisplayName Role')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return docs.map(c => ({
    id: c._id,
    code: c.customerNumber || '-',
    name: c.customerDisplayName || '-',
    type: customerRoleType(c),
  }));
};

const previewItemInventory = async cid => {
  const { Item, ItemInventory } = getBooksCrmModels();
  const withInventory = await ItemInventory.distinct('itemId', { companyId: cid });
  const docs = await Item.find({ companyId: cid, _id: { $nin: withInventory }, ...GOODS_ONLY })
    .select('itemNo itemName hsnCode')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return docs.map(i => ({ id: i._id, itemNo: i.itemNo || '-', name: i.itemName || '-', code: i.hsnCode || '-' }));
};

const previewItemWarehouse = async cid => {
  const { Item, ItemInventory, Warehouse } = getBooksCrmModels();
  const warehouses = await Warehouse.find({ companyId: cid }).select('_id').lean();
  if (!warehouses.length) return [];
  const allWarehouseIds = new Set(warehouses.map(w => String(w._id)));
  const inventories = await ItemInventory.find({ companyId: cid })
    .select('itemId warehouses.warehouseId warehouses.isActive')
    .lean();
  const needingItemIds = inventories
    .filter(inv => itemWarehouseNeedsFix(inv, allWarehouseIds))
    .map(inv => inv.itemId)
    .filter(Boolean);
  if (!needingItemIds.length) return [];

  const docs = await Item.find({ companyId: cid, _id: { $in: needingItemIds } })
    .select('itemNo itemName hsnCode')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return docs.map(i => ({ id: i._id, itemNo: i.itemNo || '-', name: i.itemName || '-', code: i.hsnCode || '-' }));
};

const previewQuoteSoLocation = async cid => {
  const { Quote, SalesOrder } = getBooksCrmModels();
  const docs = await Quote.aggregate([
    { $match: { companyId: cid, ...MISSING_LOCATION } },
    { $project: { _id: 1, type: { $literal: 'Quote' }, code: '$quoteId', date: '$quoteDate' } },
    {
      $unionWith: {
        coll: SalesOrder.collection.name,
        pipeline: [
          { $match: { companyId: cid, ...MISSING_LOCATION } },
          { $project: { _id: 1, type: { $literal: 'Sales Order' }, code: '$orderId', date: '$orderDate' } },
        ],
      },
    },
    { $sort: { date: -1 } },
    { $limit: 100 },
  ]);

  return docs.map(d => ({ id: d._id, type: d.type, code: d.code || '-', date: d.date || null }));
};

const getDataSetupPreview = async ({ companyId, key }) => {
  if (!DATA_SETUP_KEY_SET.has(key)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Unknown data-setup step: ${key}`);
  }

  const cid = toObjectId(companyId);

  let rows;
  if (key === DATA_SETUP_KEYS.CUSTOMER_ACCOUNT) rows = await previewCustomers(cid, ACCOUNT_BACKFILL_MATCH);
  else if (key === DATA_SETUP_KEYS.CUSTOMER_BRANCH) rows = await previewCustomers(cid, MISSING_BRANCH);
  else if (key === DATA_SETUP_KEYS.ITEM_INVENTORY) rows = await previewItemInventory(cid);
  else if (key === DATA_SETUP_KEYS.ITEM_WAREHOUSE) rows = await previewItemWarehouse(cid);
  else rows = await previewQuoteSoLocation(cid);

  return { key, rows, total: rows.length };
};

const getDataSetupStatus = async ({ companyId }) => {
  const cid = toObjectId(companyId);

  const rows = await Promise.all(
    DATA_SETUP_DEFS.map(async def => {
      const remaining = await REMAINING_FNS[def.key](cid);
      return {
        key: def.key,
        label: def.label,
        description: def.description,
        needsParams: def.needsParams,
        remaining,
      };
    }),
  );

  return { rows, hasIssues: rows.some(r => r.remaining > 0) };
};

const runDataSetup = async ({ companyId, key, params }) => {
  if (!DATA_SETUP_KEY_SET.has(key)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Unknown data-setup step: ${key}`);
  }

  const cid = toObjectId(companyId);

  try {
    const processed = await RUN_FNS[key](cid, params);
    const result = await getDataSetupStatus({ companyId });
    return { ...result, processed };
  } catch (err) {
    throw err instanceof ApiError ? err : new ApiError(httpStatus.INTERNAL_SERVER_ERROR, err?.message || 'Backfill failed');
  }
};

module.exports = {
  DATA_SETUP_KEYS,
  getDataSetupStatus,
  getDataSetupPreview,
  runDataSetup,
};
