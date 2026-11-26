const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const { handleWarehouseStock } = require('../../../services/warehouseBatch.service');
const { transferStock } = require('../../Inventory/inventoryTransfer/inventoryTransfer.service');
const {
  DELIVERY_CHALLAN_STATUS,
  INVOICE_STATUS,
  E_WAY_BILL_STATUS,
  ITEM_BATCH_SOURCE_TYPE,
  SYSTEM_ACCOUNT_KEYS,
} = require('../../../utils/enum');
const { DELIVERY_CHALLAN_MESSAGES } = require('../../../utils/messages');

/**
 * Internal stock transfer delivery challan: the stock moves from `stockTransfer.from*` into the challan's own
 * division, branch and warehouse when the challan is sent, batch by batch, and moves back when it leaves Sent.
 * The invoice converted from it never touches stock.
 */

const { DELIVERY_CHALLAN_STOCK_TRANSFER } = ITEM_BATCH_SOURCE_TYPE;

const sameId = (left, right) => Boolean(left && right) && left.toString() === right.toString();

const ADDRESS_REQUIRED_FIELDS = ['street1', 'city', 'state', 'pinCode'];

const hasFullAddress = address => ADDRESS_REQUIRED_FIELDS.every(field => String(address?.[field] || '').trim());

const getTransferAddresses = async ({ companyId, fromWarehouseId, toWarehouseId, session = null }) => {
  const { Warehouse } = getBooksCrmModels();
  const [from, to] = await Promise.all(
    [fromWarehouseId, toWarehouseId].map(id =>
      Warehouse.findOne({ _id: id, companyId }).select('name address').session(session).lean(),
    ),
  );

  if (!from)
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_LOCATION_NOT_FOUND('From Warehouse'));
  if (!to)
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_LOCATION_NOT_FOUND('To Warehouse'));
  if (!hasFullAddress(from.address)) {
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_ADDRESS_REQUIRED('From', from.name));
  }
  if (!hasFullAddress(to.address)) {
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_ADDRESS_REQUIRED('To', to.name));
  }
  if (String(from.address.pinCode).trim() === String(to.address.pinCode).trim()) {
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_SAME_PINCODE(from.address.pinCode));
  }

  return { from: from.address, to: to.address };
};

const assertBranchDivisionsCustomer = async ({ companyId, customerId, session = null }) => {
  const { Customer } = getBooksCrmModels();
  const { Account } = getBooksModels();
  const customer = await Customer.findOne({ _id: customerId, companyId }).select('accountId').session(session).lean();
  const account = customer?.accountId
    ? await Account.findOne({ _id: customer.accountId, companyId }).select('systemAccountKey').session(session).lean()
    : null;
  if (account?.systemAccountKey !== SYSTEM_ACCOUNT_KEYS.BRANCH_DIVISIONS) {
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_CUSTOMER_ACCOUNT);
  }
};

/**
 * Checks the From division, branch and warehouse belong to the company and to each other, that both warehouses have
 * distinct full addresses, and that the customer is a Branch / Divisions party.
 */
const validateStockTransferSource = async ({ companyId, stockTransfer, warehouseId, customerId, session = null }) => {
  const { fromDivisionId, fromBranchId, fromWarehouseId } = stockTransfer || {};
  const { Division, Branch, Warehouse } = getBooksCrmModels();

  if (sameId(fromWarehouseId, warehouseId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'From Warehouse and To Warehouse must be different');
  }

  const [division, branch, warehouse] = await Promise.all([
    Division.findOne({ _id: fromDivisionId, companyId }).select('_id').session(session).lean(),
    Branch.findOne({ _id: fromBranchId, companyId }).select('divisionId').session(session).lean(),
    Warehouse.findOne({ _id: fromWarehouseId, companyId }).select('divisionId branchId').session(session).lean(),
  ]);

  if (!division)
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_LOCATION_NOT_FOUND('From Division'));
  if (!branch)
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_LOCATION_NOT_FOUND('From Branch'));
  if (!warehouse)
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_LOCATION_NOT_FOUND('From Warehouse'));
  if (!sameId(branch.divisionId, fromDivisionId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_LOCATION_INVALID('From Branch'));
  }
  if (!sameId(warehouse.branchId, fromBranchId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_LOCATION_INVALID('From Warehouse'));
  }

  await getTransferAddresses({ companyId, fromWarehouseId, toWarehouseId: warehouseId, session });
  await assertBranchDivisionsCustomer({ companyId, customerId, session });

  return { fromDivisionId, fromBranchId, fromWarehouseId, transferredAt: stockTransfer?.transferredAt || null };
};

/** Lines whose item holds stock; services and items without inventory tracking do not move. */
const getStockLines = async ({ challan, session }) => {
  const { Item } = getBooksCrmModels();
  const itemIds = [...new Set((challan.items || []).map(item => item.itemId?.toString()).filter(Boolean))];
  if (!itemIds.length) return [];

  const stockItems = await Item.find({
    _id: { $in: itemIds },
    companyId: challan.companyId,
    'itemCategory.isService': { $ne: true },
    trackInventory: { $ne: false },
  })
    .select('_id')
    .session(session)
    .lean();
  const stockItemIds = new Set(stockItems.map(item => item._id.toString()));
  return challan.items.filter(item => stockItemIds.has(item.itemId?.toString()) && Number(item.quantity) > 0);
};

const applyStockTransfer = async ({ challan, userId, session }) => {
  await getTransferAddresses({
    companyId: challan.companyId,
    fromWarehouseId: challan.stockTransfer.fromWarehouseId,
    toWarehouseId: challan.warehouseId,
    session,
  });
  const lines = await getStockLines({ challan, session });

  // Sequential: each line consumes the From warehouse's oldest batches before the next one reads them.
  for (const line of lines) {
    await transferStock(
      {
        companyId: challan.companyId,
        itemId: line.itemId,
        itemUnitId: line.itemUnitId,
        fromWarehouseId: challan.stockTransfer.fromWarehouseId,
        toWarehouseId: challan.warehouseId,
        quantity: Number(line.quantity),
        addedBy: userId,
        sourceType: DELIVERY_CHALLAN_STOCK_TRANSFER,
        requestId: challan._id,
      },
      session,
    );
  }

  challan.stockTransfer.transferredAt = new Date();
  challan.markModified('stockTransfer');
};

/** A transfer can be reversed only while nothing depends on it: no invoice, no active e-way bill, moved stock unused. */
const assertStockTransferReversible = async ({ challan, session }) => {
  const { Invoice } = getBooksModels();
  const { ItemBatch, Warehouse } = getBooksCrmModels();

  const invoices = await Invoice.find({
    companyId: challan.companyId,
    $or: [{ deliveryChallanId: challan._id }, { 'deliveryChallanIds.deliveryChallanId': challan._id }],
    status: { $ne: INVOICE_STATUS.CANCELLED },
  })
    .select('invoiceId')
    .session(session)
    .lean();
  if (invoices.length) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_HAS_INVOICE(invoices.map(invoice => invoice.invoiceId).join(', ')),
    );
  }

  if (challan.eWayBill?.status === E_WAY_BILL_STATUS.ACT.value) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_HAS_EWAY_BILL(challan.eWayBill.eWayBillNo),
    );
  }

  const usedBatch = await ItemBatch.exists({
    companyId: challan.companyId,
    sourceType: DELIVERY_CHALLAN_STOCK_TRANSFER,
    sourceId: challan._id,
    'deductions.0': { $exists: true },
  }).session(session);
  if (usedBatch) {
    const warehouse = await Warehouse.findOne({ _id: challan.warehouseId, companyId: challan.companyId })
      .select('name')
      .session(session)
      .lean();
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_STOCK_USED(challan.challanId, warehouse?.name),
    );
  }
};

const reverseStockTransfer = async ({ challan, session }) => {
  await assertStockTransferReversible({ challan, session });

  const itemIds = [...new Set((challan.items || []).map(item => item.itemId?.toString()).filter(Boolean))];
  for (const itemId of itemIds) {
    const stockData = {
      itemId,
      companyId: challan.companyId,
      deductedSourceType: DELIVERY_CHALLAN_STOCK_TRANSFER,
      deductedSourceId: challan._id,
    };
    // Remove the batches added to the To warehouse, then give the From warehouse batches their stock back.
    await handleWarehouseStock({ action: 'deleteStock', stockData: { ...stockData, warehouseId: challan.warehouseId }, session });
    await handleWarehouseStock({
      action: 'reverseDeduction',
      stockData: { ...stockData, warehouseId: challan.stockTransfer.fromWarehouseId },
      session,
    });
  }

  challan.stockTransfer.transferredAt = null;
  challan.markModified('stockTransfer');
};

/**
 * Moves the stock when a transfer challan becomes Sent and moves it back when it returns to Draft or is cancelled.
 * Call it before saving the challan, inside the status change transaction; it updates `stockTransfer.transferredAt`.
 */
const syncStockTransfer = async ({ challan, newStatus, userId, session }) => {
  if (!challan?.isStockTransfer || !challan.stockTransfer) return;

  const isMoved = Boolean(challan.stockTransfer.transferredAt);
  if (newStatus === DELIVERY_CHALLAN_STATUS.SENT && !isMoved) {
    await applyStockTransfer({ challan, userId, session });
  } else if ([DELIVERY_CHALLAN_STATUS.DRAFT, DELIVERY_CHALLAN_STATUS.CANCELLED].includes(newStatus) && isMoved) {
    await reverseStockTransfer({ challan, session });
  }
};

module.exports = {
  validateStockTransferSource,
  getTransferAddresses,
  syncStockTransfer,
  reverseStockTransfer,
};
