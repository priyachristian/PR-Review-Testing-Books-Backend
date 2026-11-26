const { getBooksCrmModels, getBooksModels } = require('./model.service');
const { MODULE_NAMES, STOCK_MOVEMENT_DOCUMENT_TYPE: DOC_TYPE, ITEM_BATCH_SOURCE_TYPE } = require('../utils/enum');

const { DELIVERY_CHALLAN_STOCK_TRANSFER } = ITEM_BATCH_SOURCE_TYPE;

const DOCUMENT_STOCK_CONFIG = {
  [DOC_TYPE.INVOICE]: { deduct: [MODULE_NAMES.INVOICE, MODULE_NAMES.SPLIT_INVOICE] },
  // A stock transfer challan takes stock out of its From warehouse and adds it to its To warehouse.
  [DOC_TYPE.DELIVERY_CHALLAN]: {
    deduct: [MODULE_NAMES.DELIVERY_CHALLAN, DELIVERY_CHALLAN_STOCK_TRANSFER],
    add: [DELIVERY_CHALLAN_STOCK_TRANSFER],
  },
  [DOC_TYPE.GRPO]: { add: [MODULE_NAMES.GRPO] },
  [DOC_TYPE.BILL]: { add: [MODULE_NAMES.BILL, MODULE_NAMES.SPLIT_BILL] },
  [DOC_TYPE.CREDIT_NOTE]: { add: [MODULE_NAMES.CREDIT_NOTE, MODULE_NAMES.SPLIT_CREDIT_NOTE] },
  [DOC_TYPE.DEBIT_NOTE]: { deduct: [MODULE_NAMES.DEBIT_NOTE, MODULE_NAMES.SPLIT_DEBIT_NOTE] },
  [DOC_TYPE.PRODUCTION_ORDER]: { deduct: ['PRODUCTION_ORDER'], add: ['PRODUCTION_ORDER'] },
  [DOC_TYPE.INVENTORY_ADJUSTMENT]: { deduct: [MODULE_NAMES.INVENTORY_ADJUSTMENT], add: [MODULE_NAMES.INVENTORY_ADJUSTMENT] },
  // Production-order transfer requests move stock under their own source type (approveInventoryTransfer).
  [DOC_TYPE.INVENTORY_TRANSFER]: {
    deduct: ['MANUAL_STOCK_TRANSFER', 'PRODUCTIONORDER_STOCK_TRANSFER'],
    add: ['MANUAL_STOCK_TRANSFER', 'PRODUCTIONORDER_STOCK_TRANSFER'],
  },
  [DOC_TYPE.REJECTION_ORDER]: { add: ['REJECTION_RECOVERY'] },
};

const MARGIN_DEDUCT_TYPES = [DOC_TYPE.INVOICE, DOC_TYPE.DELIVERY_CHALLAN, DOC_TYPE.DEBIT_NOTE];

// The batch sourceType -> the document that ORIGINALLY added the batch (all in the books DB).
const BATCH_SOURCE_DOC = {
  GRPO: { modelKey: 'GrpoOrder', noField: 'grpoOrderId', label: 'GRPO' },
  BILL: { modelKey: 'Bill', noField: 'billId', label: 'Bill' },
  SPLIT_BILL: { modelKey: 'Bill', noField: 'billId', label: 'Bill' },
  CREDIT_NOTE: { modelKey: 'CreditNote', noField: 'creditNoteId', label: 'Credit Note' },
  SPLIT_CREDIT_NOTE: { modelKey: 'CreditNote', noField: 'creditNoteId', label: 'Credit Note' },
  PRODUCTION_ORDER: { modelKey: 'ProductionOrder', noField: 'productionOrderCode', label: 'Production Order' },
  MANUAL_STOCK_TRANSFER: { modelKey: 'InventoryTransferRequest', noField: 'transferId', label: 'Transfer' },
  PRODUCTIONORDER_STOCK_TRANSFER: { modelKey: 'InventoryTransferRequest', noField: 'transferId', label: 'Transfer' },
  [DELIVERY_CHALLAN_STOCK_TRANSFER]: { modelKey: 'DeliveryChallan', noField: 'challanId', label: 'Delivery Challan Transfer' },
  INVENTORY_ADJUSTMENT: { modelKey: 'InventoryAdjustment', noField: 'inventoryAdjustmentNumber', label: 'Adjustment' },
  REJECTION_RECOVERY: { modelKey: 'RejectionOrder', noField: 'rejectionOrderId', label: 'Rejection' },
  OPENING_STOCK: { label: 'Opening Stock' },
};

const DEDUCTED_SOURCE_DOC = {
  INVOICE: { modelKey: 'Invoice', noField: 'invoiceId', label: 'Invoice' },
  SPLIT_INVOICE: { modelKey: 'Invoice', noField: 'invoiceId', label: 'Invoice' },
  DELIVERY_CHALLAN: { modelKey: 'DeliveryChallan', noField: 'challanId', label: 'Delivery Challan' },
  DEBIT_NOTE: { modelKey: 'DebitNote', noField: 'debitNoteId', label: 'Debit Note' },
  SPLIT_DEBIT_NOTE: { modelKey: 'DebitNote', noField: 'debitNoteId', label: 'Debit Note' },
  PRODUCTION_ORDER: { modelKey: 'ProductionOrder', noField: 'productionOrderCode', label: 'Production Order' },
  MANUAL_STOCK_TRANSFER: { modelKey: 'InventoryTransferRequest', noField: 'transferId', label: 'Transfer' },
  PRODUCTIONORDER_STOCK_TRANSFER: { modelKey: 'InventoryTransferRequest', noField: 'transferId', label: 'Transfer' },
  [DELIVERY_CHALLAN_STOCK_TRANSFER]: { modelKey: 'DeliveryChallan', noField: 'challanId', label: 'Delivery Challan Transfer' },
  INVENTORY_ADJUSTMENT: { modelKey: 'InventoryAdjustment', noField: 'inventoryAdjustmentNumber', label: 'Adjustment' },
};

// Batches created by these transfers carry the source batches they were created from.
const REFERENCE_BATCH_SOURCE_TYPES = ['PRODUCTIONORDER_STOCK_TRANSFER', 'MANUAL_STOCK_TRANSFER'];

const round3 = value => Math.round((Number(value) || 0) * 1000) / 1000;

const resolveBatchSourceDocs = async batches => {
  const booksModels = getBooksModels();
  const idsByModel = {};
  for (const batch of batches) {
    const config = BATCH_SOURCE_DOC[batch.sourceType];
    if (!config?.modelKey || !batch.sourceId) continue;
    (idsByModel[config.modelKey] = idsByModel[config.modelKey] || { noField: config.noField, ids: new Set() }).ids.add(
      String(batch.sourceId),
    );
  }

  const noByModelId = new Map();
  await Promise.all(
    Object.entries(idsByModel).map(async ([modelKey, { noField, ids }]) => {
      const Model = booksModels[modelKey];
      if (!Model) return;
      const docs = await Model.find({ _id: { $in: [...ids] } })
        .select(noField)
        .lean();
      for (const doc of docs) noByModelId.set(`${modelKey}:${String(doc._id)}`, doc[noField] || null);
    }),
  );

  const byBatch = new Map();
  for (const batch of batches) {
    const config = BATCH_SOURCE_DOC[batch.sourceType];
    if (!config) continue;
    const no = config.modelKey ? noByModelId.get(`${config.modelKey}:${String(batch.sourceId)}`) || null : null;
    byBatch.set(String(batch._id), {
      sourceDocType: config.label || batch.sourceType,
      sourceDocNo: no,
      sourceType: batch.sourceType || null,
      sourceDocId: batch.sourceId ? String(batch.sourceId) : null,
    });
  }
  return byBatch;
};

const groupByItem = (batches, extractEntries, metaByBatch) => {
  const byItem = new Map();
  for (const batch of batches) {
    const meta = metaByBatch?.get(String(batch._id)) || {};
    for (const entry of extractEntries(batch)) {
      const item = batch.itemId || {};
      const key = String(item._id || batch.itemId);
      if (!byItem.has(key)) {
        byItem.set(key, { itemId: key, itemName: item.itemName || null, itemNo: item.itemNo || null, totalQty: 0, batches: [] });
      }
      const grouped = byItem.get(key);
      grouped.totalQty = round3(grouped.totalQty + (Number(entry.qty) || 0));
      grouped.batches.push({
        itemBatchId: batch._id,
        batchNo: batch.batchNo || null,
        warehouseId: batch.warehouseId?._id || batch.warehouseId || null,
        warehouse: batch.warehouseId?.name || null,
        qty: Number(entry.qty) || 0,
        rate: Number(entry.rate) || 0,
        cost: Number(entry.cost) || 0,
        unitId: entry.unit?._id || entry.unit || null,
        unit: entry.unit?.name || null,
        date: entry.date || null,
        ...entry.details,
        ...meta,
        ...(REFERENCE_BATCH_SOURCE_TYPES.includes(batch.sourceType) && { referenceBatches: batch.referenceBatches || [] }),
      });
    }
  }
  return [...byItem.values()];
};

const resolveDeductedDocs = async batches => {
  const booksModels = getBooksModels();
  const idsByModel = {};
  for (const batch of batches) {
    for (const deduction of batch.deductions || []) {
      const config = DEDUCTED_SOURCE_DOC[deduction.deductedSourceType];
      if (!config?.modelKey || !deduction.deductedSourceId) continue;
      (idsByModel[config.modelKey] = idsByModel[config.modelKey] || { noField: config.noField, ids: new Set() }).ids.add(
        String(deduction.deductedSourceId),
      );
    }
  }

  const noByModelId = new Map();
  await Promise.all(
    Object.entries(idsByModel).map(async ([modelKey, { noField, ids }]) => {
      const Model = booksModels[modelKey];
      if (!Model) return;
      const docs = await Model.find({ _id: { $in: [...ids] } })
        .select(noField)
        .lean();
      for (const doc of docs) noByModelId.set(`${modelKey}:${String(doc._id)}`, doc[noField] || null);
    }),
  );
  return noByModelId;
};

const buildBatchUsage = (batch, noByModelId) => {
  const cost = Number(batch.purchasePrice) || 0;
  const grouped = new Map();
  for (const deduction of batch.deductions || []) {
    const qty = Number(deduction.quantityDeducted) || 0;
    if (qty <= 0) continue;
    const config = DEDUCTED_SOURCE_DOC[deduction.deductedSourceType] || {};
    const docId = deduction.deductedSourceId ? String(deduction.deductedSourceId) : null;
    const key = `${deduction.deductedSourceType}:${docId || 'none'}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        docType: config.label || deduction.deductedSourceType || null,
        sourceType: deduction.deductedSourceType || null,
        docId,
        docNo: config.modelKey && docId ? noByModelId.get(`${config.modelKey}:${docId}`) || null : null,
        qty: 0,
        revenue: 0,
        documentUnitRate: 0,
        date: deduction.deductedAt || null,
      });
    }
    const usage = grouped.get(key);
    usage.qty = round3(usage.qty + qty);
    usage.documentUnitRate = deduction.documentUnitRate ?? usage.documentUnitRate;
    // sellingPrice is per selling unit, so revenue is price x the quantity in that unit (qty above is the main unit).
    const sellingQty = deduction.sellingQuantity ?? qty / (Number(deduction.conversionFactor) || 1);
    usage.revenue = round3(usage.revenue + (Number(deduction.sellingPrice) || 0) * sellingQty);
    if (deduction.deductedAt && (!usage.date || new Date(deduction.deductedAt) > new Date(usage.date)))
      usage.date = deduction.deductedAt;
  }
  return [...grouped.values()].map(usage => ({
    docType: usage.docType,
    sourceType: usage.sourceType,
    docId: usage.docId,
    docNo: usage.docNo,
    qty: usage.qty,
    soldAt: usage.qty > 0 ? round3(usage.revenue / usage.qty) : 0,
    documentUnitRate: usage.documentUnitRate,
    cost,
    profit: round3(usage.revenue - cost * usage.qty),
    date: usage.date,
  }));
};

const queryAddMovements = async (ItemBatch, companyId, sourceId, sourceTypes) => {
  const batches = await ItemBatch.find({ companyId, sourceType: { $in: sourceTypes }, sourceId })
    .populate('itemId', 'itemName itemNo')
    .populate('warehouseId', 'name')
    .populate('itemUnitId', 'name')
    .populate('purchaseUnitId', 'name')
    .lean();
  const noByModelId = await resolveDeductedDocs(batches);
  const metaByBatch = new Map();
  for (const batch of batches) {
    metaByBatch.set(String(batch._id), {
      remainingQty: Number(batch.remainingQty) || 0,
      usage: buildBatchUsage(batch, noByModelId),
    });
  }
  return groupByItem(
    batches,
    batch => {
      const conversionFactor = Number(batch.conversionFactor) || 1;
      // qty / unit are the stock in the item's main unit; purchaseQty / purchaseUnit are the same stock as it was bought.
      return [
        {
          qty: batch.quantity,
          rate: batch.purchasePrice,
          unit: batch.itemUnitId,
          date: batch.createdAt,
          details: {
            purchaseQty: Number(batch.purchaseQuantity) > 0 ? batch.purchaseQuantity : round3(batch.quantity / conversionFactor),
            purchaseUnitId: batch.purchaseUnitId?._id || batch.purchaseUnitId || batch.itemUnitId?._id || null,
            purchaseUnit: batch.purchaseUnitId?.name || batch.itemUnitId?.name || null,
            conversionFactor,
            documentUnitRate: batch.documentUnitRate ?? 0,
          },
        },
      ];
    },
    metaByBatch,
  );
};

const queryDeductMovements = async (ItemBatch, companyId, sourceId, sourceTypes) => {
  const batches = await ItemBatch.find({
    companyId,
    'deductions.deductedSourceType': { $in: sourceTypes },
    'deductions.deductedSourceId': sourceId,
  })
    .populate('itemId', 'itemName itemNo')
    .populate('warehouseId', 'name')
    .populate('itemUnitId', 'name')
    .populate('deductions.sellingUnitId', 'name')
    .lean();
  const sourceDocByBatch = await resolveBatchSourceDocs(batches);
  return groupByItem(
    batches,
    batch =>
      (batch.deductions || [])
        .filter(
          deduction =>
            String(deduction.deductedSourceId) === String(sourceId) && sourceTypes.includes(deduction.deductedSourceType),
        )
        .map(deduction => {
          const conversionFactor = Number(deduction.conversionFactor) || 1;
          // qty / unit are the stock taken in the item's main unit; sellingQty / sellingUnit are the same stock in the
          // unit the line was sold in, and rate is the selling price per sellingUnit.
          return {
            qty: deduction.quantityDeducted,
            rate: deduction.sellingPrice,
            cost: batch.purchasePrice,
            unit: batch.itemUnitId,
            date: deduction.deductedAt,
            details: {
              sellingQty: deduction.sellingQuantity ?? round3(deduction.quantityDeducted / conversionFactor),
              sellingUnitId: deduction.sellingUnitId?._id || deduction.sellingUnitId || batch.itemUnitId?._id || null,
              sellingUnit: deduction.sellingUnitId?.name || batch.itemUnitId?.name || null,
              conversionFactor,
              documentUnitRate: deduction.documentUnitRate ?? 0,
            },
          };
        }),
    sourceDocByBatch,
  );
};

const getDocumentStockMovements = async ({ companyId, sourceId, documentType }) => {
  const config = DOCUMENT_STOCK_CONFIG[documentType];
  if (!config || !companyId || !sourceId) return { sections: [] };

  const { ItemBatch } = getBooksCrmModels();
  const sections = [];

  if (config.deduct) {
    sections.push({
      direction: 'deduct',
      showMargin: MARGIN_DEDUCT_TYPES.includes(documentType),
      movements: await queryDeductMovements(ItemBatch, companyId, sourceId, config.deduct),
    });
  }
  if (config.add) {
    sections.push({ direction: 'add', movements: await queryAddMovements(ItemBatch, companyId, sourceId, config.add) });
  }

  return { sections };
};

module.exports = { getDocumentStockMovements, DOCUMENT_STOCK_CONFIG, STOCK_MOVEMENT_DOCUMENT_TYPE: DOC_TYPE };
