const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { createSearchRegex } = require('../../../utils/regexUtils');
const {
  getBooksCrmModels,
  getBooksModels,
  getClientConnection,
  getCommonModels,
  getAbssAdminModels,
} = require('../../../services/model.service');
const { MODULE_NAMES, REJECTION_ORDER_STATUS, ITEM_BATCH_SOURCE_LABELS, INVOICE_STATUS } = require('../../../utils/enum');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { validateStatusTransition, validateEditPermissions } = require('../../../utils/inventoryConfig');
const { REJECTION_ORDER_MESSAGES } = require('../../../utils/messages');
const { handleFileUpdate, deleteFilesFromS3 } = require('../../commonModule/fileUpload/fileUploadS3.service');
const logger = require('../../../config/logger');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
} = require('../../../services/warehouseBatch.service');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');

// Recovery buckets → which configured warehouse each one stocks into.
const REJECTION_RECOVERY_BUCKETS = [
  { field: 'reuse', configKey: 'reuseWarehouseId' },
  { field: 'vendorReturn', configKey: 'returnWarehouseId' },
  { field: 'scrap', configKey: 'scrapWarehouseId' },
];

// On DEVOLVED, add each component's reuse/vendorReturn/scrap qty into the company-configured
// reuse/return/scrap warehouse. Runs inside the status-transition transaction; the transition
// guard (SORTED → DEVOLVED, terminal) makes this naturally run-once.
const settleRecoveryStock = async (order, companyId, userId, session) => {
  const { Warehouse, Item, ItemInventory } = getBooksCrmModels();
  const { CompanySettings } = getCommonModels();

  const settings = await CompanySettings.findOne({ companyId }).select('rejectionWarehouseConfig').session(session).lean();
  const cfg = settings?.rejectionWarehouseConfig || {};

  const warehouseIds = REJECTION_RECOVERY_BUCKETS.map(b => cfg[b.configKey]).filter(Boolean);
  if (warehouseIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, REJECTION_ORDER_MESSAGES.WAREHOUSE_NOT_CONFIGURED);
  }

  // division/branch are required on the inventory/batch entry; derive them from the warehouse doc.
  const warehouses = await Warehouse.find({ _id: { $in: warehouseIds }, companyId })
    .select('divisionId branchId')
    .session(session)
    .lean();

  const whMap = warehouses.reduce((acc, w) => ({ ...acc, [w._id.toString()]: w }), {});

  // Value recovered stock at the component's cost price — the correct inventory-valuation
  // basis. Load all component costs once.
  const componentIds = [
    ...new Set(
      (order.items || []).flatMap(i => (i.componentRecoveries || []).map(r => r.componentItemId?.toString())).filter(Boolean),
    ),
  ];
  const componentItems = componentIds.length
    ? await Item.find({ _id: { $in: componentIds }, companyId })
        .select('purchaseInformation.costPrice')
        .session(session)
        .lean()
    : [];
  const costMap = componentItems.reduce(
    (acc, it) => ({ ...acc, [it._id.toString()]: it?.purchaseInformation?.costPrice ?? 0 }),
    {},
  );

  // Ensure a base ItemInventory doc exists for every component before adding stock.
  // addStock → updateWarehouseInventory self-heals a missing warehouses[] entry, but throws
  // 'Item inventory not found' if the item has no inventory doc at all (e.g. legacy/imported items).
  if (componentIds.length) {
    await ItemInventory.bulkWrite(
      componentIds.map(itemId => ({
        updateOne: {
          filter: { itemId, companyId },
          update: { $setOnInsert: { itemId, companyId, addedBy: userId, warehouses: [] } },
          upsert: true,
        },
      })),
      { session },
    );
  }

  // Ensure each bucket's warehouse sub-entry exists in ItemInventory before adding stock.
  for (const bucket of REJECTION_RECOVERY_BUCKETS) {
    const warehouseId = cfg[bucket.configKey];
    const wh = warehouseId && whMap[warehouseId.toString()];
    if (!wh) continue;
    await defaultWarehouseEntry(
      {
        itemArray: componentIds.map(id => ({ itemId: id })),
        warehouseId,
        branchId: wh.branchId,
        divisionId: wh.divisionId,
        companyId,
        isActive: true,
      },
      session,
    );
  }

  for (const item of order.items || []) {
    for (const rec of item.componentRecoveries || []) {
      if (!rec.componentItemId) continue;
      const costPrice = costMap[rec.componentItemId.toString()] || 0;
      for (const bucket of REJECTION_RECOVERY_BUCKETS) {
        const qty = Number(rec[bucket.field]) || 0;
        if (qty <= 0) continue;

        const warehouseId = cfg[bucket.configKey];
        const wh = warehouseId && whMap[warehouseId.toString()];
        if (!wh) continue; // bucket has qty but no/invalid configured warehouse → skip

        await handleWarehouseStock({
          action: 'addStock',
          stockData: {
            itemId: rec.componentItemId,
            companyId,
            divisionId: wh.divisionId,
            branchId: wh.branchId,
            warehouseId,
            quantity: qty,
            purchasePrice: costPrice,
            sourceType: 'REJECTION_RECOVERY',
            sourceId: order._id,
            addedBy: userId,
          },
          session,
        });
      }
    }
  }

  await checkCompanyStockLevels({
    itemIds: componentIds,
    companyId,
    docType: 'REJECTION_RECOVERY',
    docId: order._id,
    docNo: order.rejectionOrderId,
    userId,
    session,
  });
};

const REJECTION_ORDER_STATUS_CONFIG = {
  STATUS_TRANSITIONS: {
    [REJECTION_ORDER_STATUS.PENDING]: [REJECTION_ORDER_STATUS.RECEIVED],
    [REJECTION_ORDER_STATUS.RECEIVED]: [REJECTION_ORDER_STATUS.REJECTION_COUNTED],
    [REJECTION_ORDER_STATUS.REJECTION_COUNTED]: [REJECTION_ORDER_STATUS.SETTLED],
    [REJECTION_ORDER_STATUS.SETTLED]: [REJECTION_ORDER_STATUS.SORTED],
    [REJECTION_ORDER_STATUS.SORTED]: [REJECTION_ORDER_STATUS.DEVOLVED],
    [REJECTION_ORDER_STATUS.DEVOLVED]: [],
  },
  EDIT_RESTRICTED_STATUSES: [REJECTION_ORDER_STATUS.DEVOLVED],
  DELETE_RESTRICTED_STATUSES: [REJECTION_ORDER_STATUS.SETTLED, REJECTION_ORDER_STATUS.SORTED, REJECTION_ORDER_STATUS.DEVOLVED],
  LINKED_DOCUMENT_DELETE_RESTRICTED_STATUSES: [REJECTION_ORDER_STATUS.SORTED, REJECTION_ORDER_STATUS.DEVOLVED],
};

const assertLinkedRejectionDeletable = async (rejectionOrderRef, companyId, session, restrictedMessage) => {
  if (!rejectionOrderRef) return null;
  const { RejectionOrder } = getBooksModels();
  const linkedRejectionOrder = await RejectionOrder.findOne({ _id: rejectionOrderRef, companyId })
    .select('status')
    .session(session);
  if (
    linkedRejectionOrder &&
    REJECTION_ORDER_STATUS_CONFIG.LINKED_DOCUMENT_DELETE_RESTRICTED_STATUSES.includes(linkedRejectionOrder.status)
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, restrictedMessage);
  }
  return linkedRejectionOrder;
};

const revertLinkedRejectionSettlement = async (linkedRejectionOrder, companyId, session) => {
  if (linkedRejectionOrder?.status !== REJECTION_ORDER_STATUS.SETTLED) return;
  const { RejectionOrder } = getBooksModels();
  await RejectionOrder.updateOne(
    { _id: linkedRejectionOrder._id, companyId, status: REJECTION_ORDER_STATUS.SETTLED },
    { $set: { status: REJECTION_ORDER_STATUS.REJECTION_COUNTED, convertType: null, 'items.$[].convertType': null } },
    { session },
  );
};

const toTime = date => (date ? new Date(date).getTime() : null);

// Workflow PATCH may change workflow fields only; the booked item set and booking fields stay as created.
const assertBookedItemsUnchanged = (existingItems = [], incomingItems = []) => {
  const existingMap = new Map(existingItems.map(item => [item._id.toString(), item]));
  const incomingIds = new Set(incomingItems.map(item => item._id?.toString()).filter(Boolean));
  const isChanged =
    incomingItems.length !== existingItems.length ||
    incomingIds.size !== incomingItems.length ||
    incomingItems.some(item => {
      const existing = item._id && existingMap.get(item._id.toString());
      return (
        !existing ||
        String(existing.itemId || '') !== String(item.itemId || '') ||
        Number(existing.bookedQty) !== Number(item.bookedQty) ||
        (existing.wattage || '') !== (item.wattage || '') ||
        toTime(existing.manufacturingDate) !== toTime(item.manufacturingDate)
      );
    });
  if (isChanged) {
    throw new ApiError(httpStatus.BAD_REQUEST, REJECTION_ORDER_MESSAGES.BOOKED_ITEMS_LOCKED);
  }
};

const createRejectionOrder = async (orderBody, userId, uploadedFiles = []) => {
  const { Customer, Branch, Division, Warehouse } = getBooksCrmModels();
  const { RejectionOrder } = getBooksModels();

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const { companyId, customerId, divisionId, branchId, warehouseId } = orderBody;

    const customer = await Customer.findOne({ _id: customerId, companyId }).session(session);
    const division = await Division.findOne({ _id: divisionId, companyId }).session(session);
    const branch = await Branch.findOne({ _id: branchId, companyId }).session(session);
    const warehouse = await Warehouse.findOne({ _id: warehouseId, companyId }).session(session);

    if (!customer) throw new ApiError(httpStatus.BAD_REQUEST, 'Customer not found');
    if (!division) throw new ApiError(httpStatus.BAD_REQUEST, 'Division not found');
    if (!branch) throw new ApiError(httpStatus.BAD_REQUEST, 'Branch not found');
    if (!warehouse) throw new ApiError(httpStatus.BAD_REQUEST, 'Warehouse not found');

    if (orderBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: orderBody.items,
          warehouseId,
          branchId,
          divisionId,
          companyId,
        },
        session,
      );
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: companyId,
    });

    orderBody.rejectionOrderId = await generateUniqueId(
      RejectionOrder,
      companyId,
      MODULE_NAMES.REJECTION_ORDER,
      'rejectionOrderId',
      'RJ',
      session,
      orderBody.rejectionOrderId,
    );

    const orderData = {
      ...orderBody,
      attachments: allAttachments,
      status: REJECTION_ORDER_STATUS.PENDING,
      addedBy: userId,
      updatedBy: userId,
    };

    const order = await RejectionOrder.create([orderData], { session });
    await flushCompanyStockLevels(session);
    await session.commitTransaction();
    return order[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryRejectionOrders = async (filter, options) => {
  const { Customer, Branch, Division, Warehouse } = getBooksCrmModels();
  const { RejectionOrder } = getBooksModels();
  const { User } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  if (filter.customerId) query.customerId = filter.customerId;
  if (filter.branchId) query.branchId = filter.branchId;
  if (filter.divisionId) query.divisionId = filter.divisionId;
  if (filter.rejectionOrderId) query.rejectionOrderId = new RegExp(filter.rejectionOrderId.trim(), 'i');

  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) query.status = { $in: statusArray };
  }

  if (filter.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) query.addedBy = { $in: addedByIds };
  }

  if (filter.startDate || filter.endDate) {
    query.arrivalDate = {};
    if (filter.startDate) query.arrivalDate.$gte = new Date(filter.startDate);
    if (filter.endDate) query.arrivalDate.$lte = new Date(filter.endDate);
  }

  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    const customers = await Customer.find(
      { companyId, $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }] },
      { _id: 1 },
    );
    const customerIds = customers.map(c => c._id);
    query.$or = [{ rejectionOrderId: searchRegex }, { customerId: { $in: customerIds } }];
  }

  const result = await RejectionOrder.paginateWithTotal(query, options);

  const customerIds = [...new Set(result.results.map(o => o.customerId?.toString()).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(o => o.branchId?.toString()).filter(Boolean))];
  const divisionIds = [...new Set(result.results.map(o => o.divisionId?.toString()).filter(Boolean))];
  const warehouseIds = [...new Set(result.results.map(o => o.warehouseId?.toString()).filter(Boolean))];
  const addedByIds = [...new Set(result.results.map(o => o.addedBy?.toString()).filter(Boolean))];

  const [customers, branches, divisions, warehouses, users] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } })
      .select('customerDisplayName companyName')
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
    User.find({ _id: { $in: addedByIds } })
      .select('firstName lastName')
      .lean(),
  ]);

  const mapById = arr => arr.reduce((acc, doc) => ({ ...acc, [doc._id.toString()]: doc }), {});
  const customerMap = mapById(customers);
  const branchMap = mapById(branches);
  const divisionMap = mapById(divisions);
  const warehouseMap = mapById(warehouses);
  const userMap = mapById(users);

  const populatedResults = result.results.map(order => {
    const obj = order.toObject ? order.toObject() : order;
    obj.customerId = customerMap[obj.customerId?.toString()] || null;
    obj.branchId = branchMap[obj.branchId?.toString()] || null;
    obj.divisionId = divisionMap[obj.divisionId?.toString()] || null;
    obj.warehouseId = warehouseMap[obj.warehouseId?.toString()] || null;
    obj.addedBy = userMap[obj.addedBy?.toString()] || null;
    return obj;
  });

  const { status: _status, ...statusMatchQuery } = query;

  let statusWiseRejectionOrderCount = await RejectionOrder.aggregate([
    { $match: statusMatchQuery },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ]);

  const defaultStatusCounts = Object.values(REJECTION_ORDER_STATUS).reduce((accumulator, status) => {
    accumulator[status] = 0;
    return accumulator;
  }, {});

  statusWiseRejectionOrderCount = statusWiseRejectionOrderCount.reduce((accumulator, { _id: statusValue, count }) => {
    accumulator[statusValue] = count;
    return accumulator;
  }, defaultStatusCounts);

  return { ...result, results: populatedResults, statusWiseRejectionOrderCount };
};

const getRejectionOrderById = async (id, companyId) => {
  const { Customer, Branch, Division, Warehouse, Item, SalesOrder } = getBooksCrmModels();
  const { RejectionOrder, RejectionReason, CreditNote, Invoice } = getBooksModels();
  const { User } = getCommonModels();

  const order = await RejectionOrder.findOne({ _id: id, companyId }).lean();
  if (!order) {
    throw new ApiError(httpStatus.NOT_FOUND, REJECTION_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const [customer, branch, division, warehouse, addedBy, linkedSalesOrder, linkedCreditNote, referenceInvoice] =
    await Promise.all([
      Customer.findById(order.customerId).select('customerDisplayName companyName address').lean(),
      Branch.findById(order.branchId).select('name').lean(),
      Division.findById(order.divisionId).select('name').lean(),
      Warehouse.findById(order.warehouseId).select('name').lean(),
      User.findById(order.addedBy).select('firstName lastName email').lean(),
      // Reverse link: the sales order (PC-to-PC) / credit note created from this rejection stores
      // rejectionOrderDetails.rejectionOrderRef.
      SalesOrder.findOne({ 'rejectionOrderDetails.rejectionOrderRef': order._id, companyId }).select('orderId').lean(),
      CreditNote.findOne({ 'rejectionOrderDetails.rejectionOrderRef': order._id, companyId }).select('creditNoteId').lean(),
      order.referenceInvoiceId ? Invoice.findOne({ _id: order.referenceInvoiceId, companyId }).select('invoiceId').lean() : null,
    ]);

  let convertReference = null;
  if (linkedSalesOrder) {
    convertReference = { type: 'SALES_ORDER', _id: linkedSalesOrder._id, no: linkedSalesOrder.orderId };
  } else if (linkedCreditNote) {
    convertReference = { type: 'CREDIT_NOTE', _id: linkedCreditNote._id, no: linkedCreditNote.creditNoteId };
  }

  const reasonIds = [
    ...new Set(order.items.flatMap(item => (item.reasonAssignments || []).map(r => r.reason?.toString())).filter(Boolean)),
  ];
  const reasons = await RejectionReason.find({ _id: { $in: reasonIds } })
    .select('name parentReasonId')
    .lean();
  const reasonMap = reasons.reduce((acc, r) => ({ ...acc, [r._id.toString()]: r }), {});

  const itemIds = order.items.map(item => item.itemId).filter(Boolean);
  const items = await Item.find({ _id: { $in: itemIds } })
    .select('itemName itemNo itemCode itemUnit salesInformation')
    .lean();
  const itemMap = items.reduce((acc, i) => ({ ...acc, [i._id.toString()]: i }), {});

  return {
    ...order,
    customerId: customer || null,
    branchId: branch || null,
    divisionId: division || null,
    warehouseId: warehouse || null,
    addedBy: addedBy || null,
    referenceInvoiceNo: referenceInvoice?.invoiceId || null,
    convertReference,
    items: order.items.map(item => ({
      ...item,
      itemId: item.itemId
        ? {
            _id: item.itemId,
            id: item.itemId,
            name: itemMap[item.itemId?.toString()]?.itemName || '',
            itemName: itemMap[item.itemId?.toString()]?.itemName || '',
            itemNo: itemMap[item.itemId?.toString()]?.itemNo || itemMap[item.itemId?.toString()]?.itemCode || '',
            itemUnit: itemMap[item.itemId?.toString()]?.itemUnit || '',
            salesInformation: itemMap[item.itemId?.toString()]?.salesInformation || null,
          }
        : null,
      reasonAssignments: (item.reasonAssignments || []).map(r => ({
        ...r,
        reason: reasonMap[r.reason?.toString()] || r.reason,
      })),
    })),
  };
};

const saveRejectionWorkflowById = async (id, updateBody, userId) => {
  const { RejectionOrder } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const { companyId } = updateBody;
    const order = await RejectionOrder.findOne({ _id: id, companyId }).session(session);
    if (!order) {
      throw new ApiError(httpStatus.NOT_FOUND, REJECTION_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    validateEditPermissions(REJECTION_ORDER_STATUS_CONFIG.EDIT_RESTRICTED_STATUSES, order.status);

    // companyId is the tenant scope from the query, not an updatable field.
    const { status: newStatus, companyId: _companyId, ...restBody } = updateBody;

    if (restBody.items) {
      assertBookedItemsUnchanged(order.items, restBody.items);
    }

    Object.assign(order, restBody);
    order.markModified('items');

    const exceedsCount = order.items.some(
      item => (item.warrantyExpiredQty || 0) > (item.receivedQty ?? item.bookedQty ?? 0) - (item.returnedQty || 0),
    );
    if (exceedsCount) {
      throw new ApiError(httpStatus.BAD_REQUEST, REJECTION_ORDER_MESSAGES.WARRANTY_EXPIRED_QTY_EXCEEDED);
    }

    if (order.items?.length > 0 && order.warehouseId) {
      await defaultWarehouseEntry(
        {
          itemArray: order.items,
          warehouseId: order.warehouseId,
          branchId: order.branchId,
          divisionId: order.divisionId,
          companyId,
        },
        session,
      );
    }

    if (newStatus) {
      validateStatusTransition(REJECTION_ORDER_STATUS_CONFIG.STATUS_TRANSITIONS, order.status, newStatus);
      if (newStatus === REJECTION_ORDER_STATUS.DEVOLVED) {
        await settleRecoveryStock(order, companyId, userId, session);
      }
      order.status = newStatus;
    }

    order.updatedBy = userId;

    await order.save({ session });
    await flushCompanyStockLevels(session);
    await session.commitTransaction();
    return order;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

// Booking edit, allowed only while PENDING. Division, branch, warehouse, customer and booking number stay fixed.
const updateRejectionBookingById = async (id, companyId, bookingBody, userId, uploadedFiles = []) => {
  const { RejectionOrder, Invoice } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const order = await RejectionOrder.findOne({ _id: id, companyId }).session(session);
    if (!order) {
      throw new ApiError(httpStatus.NOT_FOUND, REJECTION_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    if (order.status !== REJECTION_ORDER_STATUS.PENDING) {
      throw new ApiError(httpStatus.BAD_REQUEST, REJECTION_ORDER_MESSAGES.EDIT_ONLY_PENDING);
    }

    const referenceInvoiceId = bookingBody.referenceInvoiceId || null;
    if (referenceInvoiceId) {
      const invoiceExists = await Invoice.exists({
        _id: referenceInvoiceId,
        companyId,
        customerId: order.customerId,
        status: { $nin: [INVOICE_STATUS.DRAFT, INVOICE_STATUS.CANCELLED] },
        isSplit: { $ne: true },
      }).session(session);
      if (!invoiceExists) {
        throw new ApiError(httpStatus.BAD_REQUEST, REJECTION_ORDER_MESSAGES.INVALID_REFERENCE_INVOICE);
      }
    }

    // Keep subdocument ids for rows that already exist; anything else becomes a new row.
    const existingIds = new Set(order.items.map(item => item._id.toString()));
    const items = bookingBody.items.map(({ _id, itemId, wattage, bookedQty, manufacturingDate }) => ({
      ...(_id && existingIds.has(_id.toString()) ? { _id } : {}),
      itemId: itemId || null,
      wattage: wattage || '',
      bookedQty,
      manufacturingDate: manufacturingDate || null,
    }));

    await defaultWarehouseEntry(
      {
        itemArray: items.filter(item => item.itemId),
        warehouseId: order.warehouseId,
        branchId: order.branchId,
        divisionId: order.divisionId,
        companyId,
      },
      session,
    );

    const attachments = await handleFileUpdate({
      newFiles: uploadedFiles || [],
      currentUrls: bookingBody.attachments !== undefined ? bookingBody.attachments : order.attachments || [],
      existingUrls: order.attachments || [],
      userId,
      companyId,
    });

    const editableFields = ['address', 'transport', 'transportName', 'transportationDate', 'arrivalDate', 'note'];
    editableFields.forEach(field => {
      if (bookingBody[field] !== undefined) order[field] = bookingBody[field];
    });
    order.referenceInvoiceId = referenceInvoiceId;
    order.items = items;
    order.attachments = attachments;
    order.updatedBy = userId;

    await order.save({ session });
    await session.commitTransaction();
    return order;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updateRejectionOrderStatus = async (id, companyId, newStatus, userId) => {
  const { RejectionOrder } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const order = await RejectionOrder.findOne({ _id: id, companyId }).session(session);
    if (!order) {
      throw new ApiError(httpStatus.NOT_FOUND, REJECTION_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    validateStatusTransition(REJECTION_ORDER_STATUS_CONFIG.STATUS_TRANSITIONS, order.status, newStatus);

    // Move recovered components into the configured reuse/return/scrap warehouses on devolve.
    if (newStatus === REJECTION_ORDER_STATUS.DEVOLVED) {
      await settleRecoveryStock(order, companyId, userId, session);
    }

    order.status = newStatus;
    order.updatedBy = userId;

    await order.save({ session });
    await flushCompanyStockLevels(session);
    await session.commitTransaction();
    return order;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteRejectionOrderById = async (id, companyId) => {
  const { RejectionOrder } = getBooksModels();
  const order = await RejectionOrder.findOne({ _id: id, companyId });
  if (!order) {
    throw new ApiError(httpStatus.NOT_FOUND, REJECTION_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  if (REJECTION_ORDER_STATUS_CONFIG.DELETE_RESTRICTED_STATUSES.includes(order.status)) {
    throw new ApiError(httpStatus.BAD_REQUEST, REJECTION_ORDER_MESSAGES.DELETE_RESTRICTED);
  }

  const attachments = Array.isArray(order.attachments) ? order.attachments.filter(Boolean) : [];

  await order.deleteOne();

  if (attachments.length) {
    try {
      await deleteFilesFromS3(attachments);
    } catch (error) {
      logger.error(`Failed to delete attachments for rejection order ${order._id}`, error);
    }
  }

  return order;
};

// Bulk BOM/price resolver for the Step-5 recovery screen.
// One call returns, per distinct item in the order, the tree of rows to settle (reuse/return/scrap):
//  - BOM_BASED item  -> its components, each expanded again when the component is itself BOM_BASED
//  - otherwise        -> the finished item itself
const unitPriceOf = it => it?.salesInformation?.sellingPrice ?? 0;

const isBomBasedItem = it =>
  it?.productionData?.productionManageMethod === 'BOM_BASED' && (it?.productionData?.bomBased || []).length > 0;

const RECOVERY_ITEM_SELECT = 'itemName salesInformation productionData.productionManageMethod productionData.bomBased';

const getRecoveryBom = async (rejectionOrderId, companyId) => {
  const { Item } = getBooksCrmModels();
  const { RejectionOrder } = getBooksModels();

  const order = await RejectionOrder.findOne({ _id: rejectionOrderId, companyId }).select('items.itemId').lean();
  if (!order) {
    throw new ApiError(httpStatus.NOT_FOUND, REJECTION_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  // Distinct finished items referenced by the order.
  const itemIds = [...new Set((order.items || []).map(i => i.itemId?.toString()).filter(Boolean))];
  if (itemIds.length === 0) return [];

  const itemMap = {};
  let idsToLoad = itemIds;
  while (idsToLoad.length) {
    // eslint-disable-next-line no-await-in-loop
    const loaded = await Item.find({ _id: { $in: idsToLoad }, companyId })
      .select(RECOVERY_ITEM_SELECT)
      .lean();
    loaded.forEach(it => {
      itemMap[it._id.toString()] = it;
    });

    const nextIds = new Set();
    loaded.forEach(it => {
      if (!isBomBasedItem(it)) return;
      it.productionData.bomBased.forEach(b => {
        const childId = b.item?.toString();
        if (childId && !itemMap[childId]) nextIds.add(childId);
      });
    });
    idsToLoad = [...nextIds];
  }

  // `path` identifies a row uniquely across the whole tree: the same raw material appearing under
  // two different sub-assemblies must stay two independently settleable rows.
  // `qtyPerUnit` is always per finished piece, so totalAvailable stays qtyPerUnit * rejected qty
  // at every level.
  // Nests as deep as the data goes. The ancestor set below is what bounds it: an item can never
  // repeat on a single path, so a path is at most as long as the number of distinct items.
  const buildChildren = (item, parentPath, parentQtyPerUnit, ancestorIds) => {
    if (!isBomBasedItem(item)) return [];

    const seenAtThisLevel = {};

    return item.productionData.bomBased
      .filter(b => b.item)
      .map(b => {
        const childId = b.item.toString();
        const child = itemMap[childId];
        seenAtThisLevel[childId] = (seenAtThisLevel[childId] || 0) + 1;
        const occurrence = seenAtThisLevel[childId];
        const segment = occurrence > 1 ? `${childId}#${occurrence}` : childId;
        const path = parentPath ? `${parentPath}/${segment}` : segment;
        const qtyPerUnit = parentQtyPerUnit * (b.qtyPerItem || 1);
        // A BOM that references one of its own ancestors would otherwise recurse forever.
        const isCyclic = ancestorIds.has(childId);

        return {
          path,
          itemId: childId,
          name: child?.itemName || 'Component',
          qtyPerUnit,
          unitPrice: unitPriceOf(child),
          children: isCyclic ? [] : buildChildren(child, path, qtyPerUnit, new Set([...ancestorIds, childId])),
        };
      });
  };

  return itemIds.map(itemId => {
    const item = itemMap[itemId];

    if (!isBomBasedItem(item)) {
      return {
        itemId,
        isBomBased: false,
        components: [
          {
            path: itemId,
            itemId,
            name: item?.itemName || 'Item',
            qtyPerUnit: 1,
            unitPrice: unitPriceOf(item),
            children: [],
          },
        ],
      };
    }

    return {
      itemId,
      isBomBased: true,
      components: buildChildren(item, '', 1, new Set([itemId])),
    };
  });
};

const getInvoiceDropdown = async (filters, options) => {
  const { Invoice } = getBooksModels();

  const { search, ...restFilters } = filters;

  const query = { ...restFilters, status: { $nin: [INVOICE_STATUS.DRAFT, INVOICE_STATUS.CANCELLED] }, isSplit: { $ne: true } };

  if (search && search.trim()) {
    query.invoiceId = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const result = await Invoice.paginate(query, {
    ...options,
    select: 'invoiceId items.itemId items.itemName items.itemNo items.quantity',
  });

  const results = result.results.map(invoice => ({
    _id: invoice._id,
    invoiceId: invoice.invoiceId,
    items: (invoice.items || []).map(invoiceItem => ({
      itemId: invoiceItem.itemId,
      itemName: invoiceItem.itemName || '',
      itemNo: invoiceItem.itemNo || '',
      quantity: invoiceItem.quantity || 0,
    })),
  }));

  return { ...result, results };
};

const getInventorySummary = async companyId => {
  const { RejectionOrder } = getBooksModels();
  const { Customer, Item } = getBooksCrmModels();

  const orders = await RejectionOrder.find({ companyId }).lean();

  const allItemIds = [...new Set(orders.flatMap(order => order.items.map(item => item.itemId?.toString())).filter(Boolean))];
  const allCustomerIds = [...new Set(orders.map(order => order.customerId?.toString()).filter(Boolean))];
  const allComponentIds = [
    ...new Set(
      orders
        .flatMap(order =>
          order.items.flatMap(item => (item.componentRecoveries || []).map(recovery => recovery.componentItemId?.toString())),
        )
        .filter(Boolean),
    ),
  ];

  const [items, customers, componentItems] = await Promise.all([
    Item.find({ _id: { $in: allItemIds } })
      .select('itemName salesInformation.sellingPrice')
      .lean(),
    Customer.find({ _id: { $in: allCustomerIds } })
      .select('customerDisplayName companyName')
      .lean(),
    allComponentIds.length
      ? Item.find({ _id: { $in: allComponentIds } })
          .select('salesInformation.sellingPrice')
          .lean()
      : Promise.resolve([]),
  ]);

  const itemMap = items.reduce(
    (accumulator, itemDoc) => ({
      ...accumulator,
      [itemDoc._id.toString()]: {
        name: itemDoc.itemName,
        price: itemDoc?.salesInformation?.sellingPrice ?? 0,
      },
    }),
    {},
  );
  const customerMap = customers.reduce((accumulator, customer) => ({ ...accumulator, [customer._id.toString()]: customer }), {});
  const componentPriceMap = componentItems.reduce(
    (accumulator, componentItem) => ({
      ...accumulator,
      [componentItem._id.toString()]: componentItem?.salesInformation?.sellingPrice ?? 0,
    }),
    {},
  );

  let vendorReturnedPcs = 0;
  let vendorReturnedValue = 0;
  let scrappedPcs = 0;
  let scrappedKg = 0;
  let scrappedValue = 0;

  for (const order of orders) {
    for (const item of order.items || []) {
      for (const recovery of item.componentRecoveries || []) {
        const componentPrice = componentPriceMap[recovery.componentItemId?.toString()] || 0;
        vendorReturnedPcs += recovery.vendorReturn || 0;
        vendorReturnedValue += componentPrice * (recovery.vendorReturn || 0);
        scrappedPcs += recovery.scrap || 0;
        scrappedKg += recovery.scrapWeightKg || 0;
        scrappedValue += componentPrice * (recovery.scrap || 0);
      }
    }
  }

  return {
    orders: orders.map(order => ({
      _id: order._id,
      rejectionOrderId: order.rejectionOrderId,
      status: order.status,
      customerId: customerMap[order.customerId?.toString()] || null,
      address: order.address || {},
      items: order.items.map(item => ({
        _id: item._id,
        bookedQty: item.bookedQty || 0,
        receivedQty: item.receivedQty || 0,
        returnedQty: item.returnedQty || 0,
        warrantyExpiredQty: item.warrantyExpiredQty || 0,
        wattage: item.wattage || null,
        itemId: itemMap[item.itemId?.toString()]
          ? { _id: item.itemId, name: itemMap[item.itemId?.toString()].name, price: itemMap[item.itemId?.toString()].price }
          : { _id: item.itemId, name: 'Unknown', price: 0 },
      })),
    })),
    extras: {
      vendorReturnedPcs,
      vendorReturnedValue: Math.round(vendorReturnedValue),
      scrappedPcs,
      scrappedKg: Math.round(scrappedKg * 10) / 10,
      scrappedValue: Math.round(scrappedValue),
    },
  };
};

const getAnalysisSummary = async (companyId, itemId = null) => {
  const { RejectionOrder, RejectionReason, Invoice, GrpoOrder, Bill } = getBooksModels();
  const { Customer, Item, ItemBatch } = getBooksCrmModels();
  const { City } = getAbssAdminModels();

  const ordersFilter = { companyId };
  if (itemId) ordersFilter['items.itemId'] = new mongoose.Types.ObjectId(itemId);
  const orders = await RejectionOrder.find(ordersFilter).lean();

  const allItemIds = [...new Set(orders.flatMap(order => order.items.map(item => item.itemId?.toString())).filter(Boolean))];
  const allCustomerIds = [...new Set(orders.map(order => order.customerId?.toString()).filter(Boolean))];
  const allReasonIds = [
    ...new Set(
      orders
        .flatMap(order =>
          order.items.flatMap(item =>
            (item.reasonAssignments || []).map(reasonAssignment => reasonAssignment.reason?.toString()),
          ),
        )
        .filter(Boolean),
    ),
  ];
  const allCityNames = [...new Set(orders.map(order => order.address?.city?.trim()).filter(Boolean))];
  const allComponentIds = [
    ...new Set(
      orders
        .flatMap(order =>
          order.items.flatMap(item => (item.componentRecoveries || []).map(recovery => recovery.componentItemId?.toString())),
        )
        .filter(Boolean),
    ),
  ];
  const allRefInvoiceIds = [
    ...new Set(orders.filter(order => order.referenceInvoiceId).map(order => order.referenceInvoiceId.toString())),
  ];

  // Bound the sales-vs-rejection trend to the last 12 months (start of the month 11 months ago).
  const trendStart = new Date();
  trendStart.setHours(0, 0, 0, 0);
  trendStart.setDate(1);
  trendStart.setMonth(trendStart.getMonth() - 11);

  const salesInvoiceFilter = {
    companyId,
    status: { $nin: [INVOICE_STATUS.DRAFT, INVOICE_STATUS.CANCELLED] },
    invoiceDate: { $gte: trendStart },
  };
  if (itemId) salesInvoiceFilter['items.itemId'] = new mongoose.Types.ObjectId(itemId);

  const [items, customers, reasons, cities, componentItems, invoices, refInvoiceDocs] = await Promise.all([
    Item.find({ _id: { $in: allItemIds } })
      .select('itemName salesInformation.sellingPrice')
      .lean(),
    Customer.find({ _id: { $in: allCustomerIds } })
      .select('customerDisplayName companyName')
      .lean(),
    RejectionReason.find({ _id: { $in: allReasonIds } })
      .select('name')
      .lean(),
    City.find({ name: { $in: allCityNames } })
      .select('name coordinates')
      .lean(),
    Item.find({ _id: { $in: allComponentIds } })
      .select('salesInformation.sellingPrice')
      .lean(),
    Invoice.find(salesInvoiceFilter).select('invoiceDate items.itemId items.amount').lean(),
    allRefInvoiceIds.length
      ? Invoice.find({ companyId, _id: { $in: allRefInvoiceIds } })
          .select('invoiceId items.itemId items.batches')
          .lean()
      : Promise.resolve([]),
  ]);

  const itemMap = items.reduce((accumulator, itemDoc) => ({ ...accumulator, [itemDoc._id.toString()]: itemDoc }), {});
  const componentPriceMap = componentItems.reduce(
    (accumulator, componentItem) => ({
      ...accumulator,
      [componentItem._id.toString()]: componentItem.salesInformation?.sellingPrice ?? 0,
    }),
    {},
  );
  const customerMap = customers.reduce((accumulator, customer) => ({ ...accumulator, [customer._id.toString()]: customer }), {});
  const reasonMap = reasons.reduce((accumulator, reason) => ({ ...accumulator, [reason._id.toString()]: reason }), {});
  const cityCoordsMap = cities.reduce((accumulator, cityDoc) => {
    if (cityDoc.name && cityDoc.coordinates) {
      accumulator[cityDoc.name.toLowerCase().trim()] = cityDoc.coordinates;
    }
    return accumulator;
  }, {});

  const refInvoiceMap = refInvoiceDocs.reduce((accumulator, invoice) => {
    accumulator[invoice._id.toString()] = {
      displayId: invoice.invoiceId,
      itemsMap: (invoice.items || []).reduce((itemBatchesByItemId, invoiceItem) => {
        if (invoiceItem.itemId && invoiceItem.batches?.length) {
          itemBatchesByItemId[invoiceItem.itemId.toString()] = invoiceItem.batches;
        }
        return itemBatchesByItemId;
      }, {}),
    };
    return accumulator;
  }, {});

  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const toMonthKey = date => {
    const dateValue = new Date(date);
    return `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, '0')}`;
  };
  const toMonthLabel = monthKey => {
    const [year, month] = monthKey.split('-');
    return `${MONTH_LABELS[parseInt(month) - 1]} ${year.slice(2)}`;
  };

  const byItem = {};
  const byCustomer = {};
  const byState = {};
  const byCity = {};
  const byReason = {};
  const bySubReason = {};
  const byComponent = {};
  const byItemRecovery = {};
  const rejectionCostByMonth = {};
  let totalRejectedQty = 0;
  let totalReturnedQty = 0;
  let totalRejectionCost = 0;
  let totalReuseValue = 0;
  let totalVendorReturnValue = 0;
  let totalScrapValue = 0;

  // subReason is stored as a free string that may hold either a RejectionReason id (newer saves) or a plain name (older saves).
  const resolveSubReason = subReasonValue => {
    if (!subReasonValue) return null;
    return reasonMap[subReasonValue.toString()]?.name || subReasonValue;
  };

  orders.forEach(order => {
    const customerName =
      customerMap[order.customerId?.toString()]?.customerDisplayName ||
      customerMap[order.customerId?.toString()]?.companyName ||
      'Unknown';
    const state = order.address?.state || 'Unknown';
    const city = order.address?.city || 'Unknown';

    order.items.forEach(item => {
      if (itemId && item.itemId?.toString() !== itemId) return;
      totalReturnedQty += item.returnedQty || 0;

      const netRejectedQty = (item.receivedQty ?? item.bookedQty ?? 0) - (item.returnedQty ?? 0) - (item.warrantyExpiredQty ?? 0);
      if (netRejectedQty <= 0) return;
      totalRejectedQty += netRejectedQty;

      const itemEntry = itemMap[item.itemId?.toString()];
      const itemName = itemEntry?.itemName || 'Unknown';
      const itemPrice = itemEntry?.salesInformation?.sellingPrice ?? 0;
      const rejectionCost = netRejectedQty * itemPrice;
      totalRejectionCost += rejectionCost;
      const monthKey = order.createdAt ? toMonthKey(order.createdAt) : null;
      if (monthKey) rejectionCostByMonth[monthKey] = (rejectionCostByMonth[monthKey] || 0) + rejectionCost;
      if (!byItemRecovery[itemName]) byItemRecovery[itemName] = { rejectionCost: 0, recoveredValue: 0 };
      byItemRecovery[itemName].rejectionCost += rejectionCost;
      byItem[itemName] = (byItem[itemName] || 0) + netRejectedQty;
      byCustomer[customerName] = (byCustomer[customerName] || 0) + netRejectedQty;
      byState[state] = (byState[state] || 0) + netRejectedQty;
      byCity[city] = (byCity[city] || 0) + netRejectedQty;

      const reasonAssignments = item.reasonAssignments || [];
      if (reasonAssignments.length) {
        reasonAssignments.forEach(reasonAssignment => {
          const reasonName = reasonMap[reasonAssignment.reason?.toString()]?.name || 'Unassigned';
          byReason[reasonName] = (byReason[reasonName] || 0) + (reasonAssignment.qty || netRejectedQty);

          const subReasonName = resolveSubReason(reasonAssignment.subReason);
          if (subReasonName)
            bySubReason[subReasonName] = (bySubReason[subReasonName] || 0) + (reasonAssignment.qty || netRejectedQty);
        });
      } else {
        byReason['Unassigned'] = (byReason['Unassigned'] || 0) + netRejectedQty;
      }

      // Failing components (BOM raw materials / sub-parts) recovered from this rejection.
      (item.componentRecoveries || []).forEach(recovery => {
        const componentRecoveredQty = (recovery.reuse || 0) + (recovery.vendorReturn || 0) + (recovery.scrap || 0);
        if (recovery.componentName && componentRecoveredQty > 0) {
          byComponent[recovery.componentName] = (byComponent[recovery.componentName] || 0) + componentRecoveredQty;
        }
        const componentPrice = componentPriceMap[recovery.componentItemId?.toString()] || 0;
        const reuseValue = (recovery.reuse || 0) * componentPrice;
        const vendorReturnValue = (recovery.vendorReturn || 0) * componentPrice;
        const scrapValue = (recovery.scrap || 0) * componentPrice;
        totalReuseValue += reuseValue;
        totalVendorReturnValue += vendorReturnValue;
        totalScrapValue += scrapValue;
        byItemRecovery[itemName].recoveredValue += reuseValue + vendorReturnValue + scrapValue;
      });
    });
  });

  const toSortedArray = countsByName =>
    Object.entries(countsByName)
      .map(([name, value]) => ({ name, value }))
      .sort((first, second) => second.value - first.value);

  const toSortedCityArray = countsByName =>
    Object.entries(countsByName)
      .map(([name, value]) => {
        const coordinates = cityCoordsMap[name.toLowerCase().trim()];
        return {
          name,
          value,
          coords: coordinates && coordinates.lng && coordinates.lat ? [coordinates.lng, coordinates.lat] : null,
        };
      })
      .sort((first, second) => second.value - first.value);

  const totalRecovered = totalReuseValue + totalVendorReturnValue + totalScrapValue;
  const byItemRecoveryArr = Object.entries(byItemRecovery)
    .map(([name, recoveryEntry]) => ({
      name,
      rejectionCost: Math.round(recoveryEntry.rejectionCost),
      recoveredValue: Math.round(recoveryEntry.recoveredValue),
      netLoss: Math.round(recoveryEntry.rejectionCost - recoveryEntry.recoveredValue),
      recoveryRate:
        recoveryEntry.rejectionCost > 0
          ? Math.round((recoveryEntry.recoveredValue / recoveryEntry.rejectionCost) * 1000) / 10
          : 0,
    }))
    .sort((first, second) => second.rejectionCost - first.rejectionCost);

  // ── Vendor-wise attribution: Invoice batches → ItemBatch → GRPO/Bill → vendor ─
  const allInvoiceBatchIds = [
    ...new Set(
      refInvoiceDocs.flatMap(invoice =>
        (invoice.items || []).flatMap(invoiceItem =>
          (invoiceItem.batches || []).map(batch => batch.itemBatchId?.toString()).filter(Boolean),
        ),
      ),
    ),
  ];

  const itemBatchDocs = allInvoiceBatchIds.length
    ? await ItemBatch.find({ companyId, _id: { $in: allInvoiceBatchIds } })
        .select('sourceType sourceId')
        .lean()
    : [];

  const itemBatchMap = itemBatchDocs.reduce((accumulator, itemBatch) => {
    accumulator[itemBatch._id.toString()] = { sourceType: itemBatch.sourceType, sourceId: itemBatch.sourceId?.toString() };
    return accumulator;
  }, {});

  const grpoIds = [
    ...new Set(
      itemBatchDocs
        .filter(itemBatch => itemBatch.sourceType === MODULE_NAMES.GRPO)
        .map(itemBatch => itemBatch.sourceId?.toString())
        .filter(Boolean),
    ),
  ];
  const billIds = [
    ...new Set(
      itemBatchDocs
        .filter(itemBatch => itemBatch.sourceType === MODULE_NAMES.BILL)
        .map(itemBatch => itemBatch.sourceId?.toString())
        .filter(Boolean),
    ),
  ];

  const [grpos, bills] = await Promise.all([
    grpoIds.length
      ? GrpoOrder.find({ companyId, _id: { $in: grpoIds } })
          .select('vendor')
          .lean()
      : Promise.resolve([]),
    billIds.length
      ? Bill.find({ companyId, _id: { $in: billIds } })
          .select('vendor')
          .lean()
      : Promise.resolve([]),
  ]);

  const grpoVendorMap = grpos.reduce(
    (accumulator, grpo) => ({ ...accumulator, [grpo._id.toString()]: grpo.vendor?.toString() }),
    {},
  );
  const billVendorMap = bills.reduce(
    (accumulator, bill) => ({ ...accumulator, [bill._id.toString()]: bill.vendor?.toString() }),
    {},
  );

  const allVendorIds = [
    ...new Set([...grpos.map(grpo => grpo.vendor?.toString()), ...bills.map(bill => bill.vendor?.toString())].filter(Boolean)),
  ];
  const vendorDocs = allVendorIds.length
    ? await Customer.find({ companyId, _id: { $in: allVendorIds } })
        .select('customerDisplayName companyName')
        .lean()
    : [];
  const vendorNameMap = vendorDocs.reduce(
    (accumulator, vendor) => ({ ...accumulator, [vendor._id.toString()]: vendor.customerDisplayName || vendor.companyName }),
    {},
  );

  const resolveVendorLabel = (sourceType, sourceId) => {
    if (sourceType === MODULE_NAMES.GRPO) {
      const vendorId = grpoVendorMap[sourceId];
      return vendorId ? vendorNameMap[vendorId] || 'Unknown Vendor' : 'Unknown Vendor';
    }
    if (sourceType === MODULE_NAMES.BILL) {
      const vendorId = billVendorMap[sourceId];
      return vendorId ? vendorNameMap[vendorId] || 'Unknown Vendor' : 'Unknown Vendor';
    }
    return ITEM_BATCH_SOURCE_LABELS[sourceType] || sourceType || 'Unknown';
  };

  const rejectedQtyByVendor = {};
  const invoicesByVendor = {};

  for (const order of orders) {
    if (!order.referenceInvoiceId) continue;
    const refInvoiceData = refInvoiceMap[order.referenceInvoiceId.toString()];
    if (!refInvoiceData) continue;

    for (const orderItem of order.items) {
      if (itemId && orderItem.itemId?.toString() !== itemId) continue;
      const orderItemId = orderItem.itemId?.toString();
      if (!orderItemId) continue;

      const invoiceBatches = refInvoiceData.itemsMap[orderItemId];
      if (!invoiceBatches?.length) continue;

      let remainingQty = orderItem.bookedQty || 0;
      for (const invoiceBatch of invoiceBatches) {
        if (remainingQty <= 0) break;
        const allocatedQty = Math.min(remainingQty, invoiceBatch.quantity || 0);
        remainingQty -= allocatedQty;

        const itemBatch = itemBatchMap[invoiceBatch.itemBatchId?.toString()];
        if (!itemBatch) continue;

        const vendorLabel = resolveVendorLabel(itemBatch.sourceType, itemBatch.sourceId);
        rejectedQtyByVendor[vendorLabel] = (rejectedQtyByVendor[vendorLabel] || 0) + allocatedQty;
        if (!invoicesByVendor[vendorLabel]) invoicesByVendor[vendorLabel] = new Set();
        invoicesByVendor[vendorLabel].add(refInvoiceData.displayId);
      }
    }
  }

  const byVendor = Object.entries(rejectedQtyByVendor)
    .map(([name, value]) => ({
      name,
      value: Math.round(value),
      invoices: [...invoicesByVendor[name]],
    }))
    .sort((first, second) => second.value - first.value);

  // ── Sales vs Rejection — monthly trend ──────────────────────────────────────
  const salesValueByMonth = {};
  for (const invoice of invoices) {
    if (!invoice.invoiceDate) continue;
    const monthKey = toMonthKey(invoice.invoiceDate);
    for (const invoiceItem of invoice.items || []) {
      if (itemId && invoiceItem.itemId?.toString() !== itemId) continue;
      salesValueByMonth[monthKey] = (salesValueByMonth[monthKey] || 0) + (invoiceItem.amount || 0);
    }
  }
  const trendStartKey = toMonthKey(trendStart);
  const allMonthKeys = [...new Set([...Object.keys(salesValueByMonth), ...Object.keys(rejectionCostByMonth)])]
    .filter(monthKey => monthKey >= trendStartKey)
    .sort();
  const salesVsRejection = allMonthKeys.map(monthKey => {
    const salesValue = Math.round(salesValueByMonth[monthKey] || 0);
    const rejectionValue = Math.round(rejectionCostByMonth[monthKey] || 0);
    const rejectionPct = salesValue > 0 ? Math.round((rejectionValue / salesValue) * 10000) / 100 : 0;
    return { month: toMonthLabel(monthKey), salesValue, rejectionValue, rejectionPct };
  });

  return {
    totalRejectedQty,
    totalReturnedQty,
    orderCount: orders.length,
    byItem: toSortedArray(byItem),
    byCustomer: toSortedArray(byCustomer),
    byState: toSortedArray(byState),
    byCity: toSortedCityArray(byCity),
    byReason: toSortedArray(byReason),
    bySubReason: toSortedArray(bySubReason),
    byComponent: toSortedArray(byComponent),
    byVendor,
    salesVsRejection,
    recovery: {
      totalRejectionCost: Math.round(totalRejectionCost),
      totalRecovered: Math.round(totalRecovered),
      netLoss: Math.round(totalRejectionCost - totalRecovered),
      recoveryRate: totalRejectionCost > 0 ? Math.round((totalRecovered / totalRejectionCost) * 1000) / 10 : 0,
      reuseValue: Math.round(totalReuseValue),
      vendorReturnValue: Math.round(totalVendorReturnValue),
      scrapValue: Math.round(totalScrapValue),
      byItem: byItemRecoveryArr,
    },
  };
};

module.exports = {
  createRejectionOrder: withTransientRetry(createRejectionOrder),
  queryRejectionOrders,
  getRejectionOrderById,
  saveRejectionWorkflowById,
  updateRejectionBookingById: withTransientRetry(updateRejectionBookingById),
  updateRejectionOrderStatus,
  deleteRejectionOrderById,
  REJECTION_ORDER_STATUS_CONFIG,
  assertLinkedRejectionDeletable,
  revertLinkedRejectionSettlement,
  getInventorySummary,
  getAnalysisSummary,
  getRecoveryBom,
  getInvoiceDropdown,
};
