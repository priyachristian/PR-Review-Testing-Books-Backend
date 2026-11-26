const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const {
  distributeRemainingAcrossLines,
  loadUnitItemMap,
  sumConvertedToMainUnit,
} = require('../../../services/conversionStatus.service');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const { PO_STATUSES, MODULE_NAMES, BILL_STATUSES, GRPO_STATUSES } = require('../../../utils/enum');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { getPurchaseAddressCondition, getPurchaseAddressResolver } = require('../../../utils/addressLocationFilter');
const ApiError = require('../../../utils/ApiError');
const { assertLineUnitsValid } = require('../../../services/documentItemEnricher.service');
const httpStatus = require('http-status');
const {
  getInventoryConfig,
  PURCHASE_ORDER_STATUS_CONFIG,
  validateStatusTransition,
  validateEditPermissions,
  assertRevertAllowed,
} = require('../../../utils/inventoryConfig');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const { mongoose } = require('mongoose');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { validateVendorForModule } = require('../../../services/customerValidation.service');
const { preparePurchaseDocumentSave } = require('../../../services/purchaseDocumentGuard.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { PURCHASE_ORDER_MESSAGES } = require('../../../utils/messages');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const {
  sendModuleCustomerNotifications,
  notifyModuleDocumentIfNonDraft,
  isFirstStatusChange,
} = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');
const { getUniqueIds, getNameMap } = require('../../../utils/helper');
const PO_CONVERSION_ALLOWED_STATUSES = [PO_STATUSES.ACCEPTED, PO_STATUSES.PARTIALLY_RECORDED];

const createPurchaseOrder = async (purchaseBody, userId, uploadedFiles = []) => {
  const { Customer, Branch } = getBooksCrmModels();
  const { PurchaseOrder } = getBooksModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { companyId, warehouseId } = purchaseBody;

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    await assertLineUnitsValid(purchaseBody.items, { companyId, session });

    const { activateVendorBranch, activateItemWarehouse } = purchaseBody;
    delete purchaseBody.activateVendorBranch;
    delete purchaseBody.activateItemWarehouse;
    await preparePurchaseDocumentSave({
      vendorId: purchaseBody.vendor,
      branchId: purchaseBody.branchId,
      warehouseId,
      items: purchaseBody.items,
      companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'purchase order',
    });

    await validateVendorForModule({
      vendorId: purchaseBody.vendor,
      branchId: purchaseBody.branchId,
      companyId,
      totalAmount: purchaseBody.total,
      moduleName: MODULE_NAMES.PURCHASE_ORDER,
      session,
      customerId: purchaseBody.customer,
      addressId: purchaseBody.addressId,
      models: { Customer, Branch },
    });

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: companyId,
    });

    //add default warehouse entry
    if (purchaseBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: purchaseBody.items,
          warehouseId: warehouseId,
          branchId: purchaseBody.branchId,
          divisionId: purchaseBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.PURCHASE_ORDER, session);

    purchaseBody.purchaseOrderId = await generateUniqueId(
      PurchaseOrder,
      companyId,
      MODULE_NAMES.PURCHASE_ORDER,
      'purchaseOrderId',
      'PO',
      session,
      purchaseBody.purchaseOrderId,
    );

    const { currency, decimalPlaces } = await resolveTransactionCurrency({
      companyId,
      vendorId: purchaseBody.vendor,
    });
    const currencyDoc = await getCurrency(companyId, currency);

    // Add comment history for creation
    const commentHistory = [
      {
        message: `Purchase Order created for ${currencyDoc?.symbol || '₹'}${purchaseBody.total || 0}`,
        addedBy: userId,
        createdAt: new Date(),
        referenceType: 'PurchaseOrder',
        referenceId: null,
      },
    ];

    const purchaseOrderData = {
      ...purchaseBody,
      currency,
      exchangeRate: purchaseBody.exchangeRate ?? 1,
      decimalPlaces,
      attachments: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      addedBy: userId,
      updatedBy: userId,
      inventoryConfig,
      commentHistory,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };

    const [purchaseOrder] = await PurchaseOrder.create([purchaseOrderData], { session });
    await session.commitTransaction();

    notifyModuleDocumentIfNonDraft({
      companyId,
      moduleName: MODULE_NAMES.PURCHASE_ORDER,
      document: purchaseOrder,
      initialStatus: PO_STATUSES.DRAFT,
    });

    return enrichDocumentCurrency(companyId, purchaseOrder.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getAllPurchaseOrders = async (filter, options) => {
  const { Customer, Item, Branch, Division, Warehouse, PaymentTerm, ItemUnit } = getBooksCrmModels();
  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();
  const { User, Company } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const conditions = { companyId };

  // Status filter
  if (filter?.status?.split(',').length > 0) {
    conditions.status = { $in: filter.status.split(',') };
  }

  if (filter.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) conditions.addedBy = { $in: addedByIds };
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'date' });
  if (branchDivisionCond) {
    Object.assign(conditions, branchDivisionCond);
  }

  // Search filter - find matching vendors and then filter by purchaseOrderId or vendor
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());

    const vendors = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    ).lean();

    const vendorIds = vendors.map(v => v._id);

    conditions.$or = [{ purchaseOrderId: searchRegex }, { vendor: { $in: vendorIds } }];
  }

  if (filter?.customerId) {
    const customerIds = String(filter.customerId)
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));

    if (customerIds.length > 0) {
      conditions.vendor = { $in: customerIds };
    }
  }

  // addressType + Country/State/City filters: billTo -> vendor billing address; else addressId of the drop-ship customer's shipping addresses (when `customer` is set) or the company's addresses
  const addressCondition = await getPurchaseAddressCondition(Customer, Company, companyId, filter, 'vendor');
  if (addressCondition) {
    (conditions.$and ||= []).push(addressCondition);
  }

  if (options?.countOnly) {
    return { results: [], totalResults: await PurchaseOrder.countDocuments(conditions) };
  }

  // Use paginateWithTotal to get paginated results + totalAmount + totalRecords
  const result = await PurchaseOrder.paginateWithTotal(conditions, options);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await PurchaseOrder.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  const purchaseOrderIds = result.results.map(po => po._id);
  const [grposForOrders, billsForOrders] = await Promise.all([
    GrpoOrder.find({
      'purchaseOrders.purchaseOrderId': { $in: purchaseOrderIds },
      status: { $ne: GRPO_STATUSES.CANCELLED },
    }).select('purchaseOrders grpoOrderId status'),
    Bill.find({
      'purchaseOrders.purchaseOrderId': { $in: purchaseOrderIds },
      status: { $ne: BILL_STATUSES.CANCELLED },
    }).select('purchaseOrders billId status'),
  ]);

  const grpoByPurchaseOrder = grposForOrders.reduce((acc, grpo) => {
    (grpo.purchaseOrders || []).forEach(po => {
      const key = po.purchaseOrderId?.toString();
      if (key) (acc[key] ||= []).push(grpo);
    });
    return acc;
  }, {});
  const billByPurchaseOrder = billsForOrders.reduce((acc, bill) => {
    (bill.purchaseOrders || []).forEach(po => {
      const key = po.purchaseOrderId?.toString();
      if (key) (acc[key] ||= []).push(bill);
    });
    return acc;
  }, {});

  // Get unique vendor and item IDs from results
  const vendorIds = [...new Set(result.results.map(po => po.vendor?.toString()).filter(Boolean))];
  const itemIds = [
    ...new Set(result.results.flatMap(po => po.items?.map(item => item.itemId?.toString()).filter(Boolean) || [])),
  ];
  const branchIds = [...new Set(result.results.map(i => i.branchId))];
  const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
  const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  const paymentTermIds = [...new Set(result.results.map(po => po.paymentTermsId?.toString()).filter(Boolean))];
  // Fetch vendors and items in bulk
  const [vendors, items, branch, warehouse, division, paymentTerms] = await Promise.all([
    Customer.find({ _id: { $in: vendorIds } })
      .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails isVendorDirectTax')
      .lean(),
    Item.find({ _id: { $in: itemIds } })
      .select('itemName')
      .lean(),
    await Branch.find({
      _id: { $in: branchIds },
    })
      .select('name _id')
      .lean(),
    await Warehouse.find({
      _id: { $in: warehouseIds },
    })
      .select('name _id')
      .lean(),
    await Division.find({
      _id: { $in: divisionIds },
    })
      .select('name _id')
      .lean(),
    PaymentTerm.find({ _id: { $in: paymentTermIds } }).lean(),
  ]);
  const users = await User.find({ _id: { $in: userIds } })
    .select('firstName lastName')
    .lean();

  // Create lookup maps
  const vendorMap = vendors.reduce((acc, v) => {
    acc[v._id.toString()] = v;
    return acc;
  }, {});

  const itemMap = items.reduce((acc, i) => {
    acc[i._id.toString()] = i;
    return acc;
  }, {});

  const branchMap = branch.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const divisionMap = division.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const warehouseMap = warehouse.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  const paymentTermMap = paymentTerms.reduce((acc, term) => {
    acc[term._id.toString()] = term;
    return acc;
  }, {});

  // Resolve addressId: drop-ship customer's addresses when `customer` has a value, else company address / additionalShippingAddresses
  const resolveAddress = await getPurchaseAddressResolver(Customer, Company, companyId, result.results);

  // Populate vendor and items on results
  const populatedResults = await Promise.all(
    result.results.map(async po => {
      const poObj = po.toObject();
      poObj.addressIn = resolveAddress(poObj);

      const poId = new mongoose.Types.ObjectId(po._id);
      const itemIds = po.items.map(item => item.itemId);
      poObj.branchId = branchMap[poObj.branchId?.toString()] || null;
      poObj.divisionId = divisionMap[poObj.divisionId?.toString()] || null;
      poObj.warehouseId = warehouseMap[poObj.warehouseId?.toString()] || null;
      poObj.grpos = grpoByPurchaseOrder[poId.toString()] || [];
      poObj.bills = billByPurchaseOrder[poId.toString()] || [];

      if (poObj.status == PO_STATUSES.PARTIALLY_RECORDED) {
        const bill = await Bill.aggregate([
          {
            $match: {
              'purchaseOrders.purchaseOrderId': poId,
              'items.referenceId': poId,
              status: { $ne: BILL_STATUSES.CANCELLED },
            },
          },
          { $unwind: '$items' },
          {
            $match: {
              'items.referenceId': poId,
              'items.itemId': { $in: itemIds },
            },
          },
          {
            $group: {
              _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' },
              totalBilledQty: { $sum: '$items.quantity' },
            },
          },
        ]);

        const grpo = await GrpoOrder.aggregate([
          {
            $match: {
              'purchaseOrders.purchaseOrderId': poId,
              'items.referenceId': poId,
              status: { $ne: GRPO_STATUSES.CANCELLED },
            },
          },
          { $unwind: '$items' },
          {
            $match: {
              'items.referenceId': poId,
              'items.itemId': { $in: itemIds },
            },
          },
          {
            $group: {
              _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' },
              totalBilledQty: { $sum: '$items.quantity' },
            },
          },
        ]);
        // Converted quantities are compared with the ordered line in the item's main unit.
        const unitItemMap = await loadUnitItemMap(itemIds);
        const billMap = sumConvertedToMainUnit(bill, unitItemMap, 'totalBilledQty');
        const grpoMap = sumConvertedToMainUnit(grpo, unitItemMap, 'totalBilledQty');
        const convertedByItem = new Map();
        for (const map of [billMap, grpoMap]) {
          for (const [key, qty] of map) convertedByItem.set(key, (convertedByItem.get(key) || 0) + qty);
        }

        poObj.items =
          distributeRemainingAcrossLines(poObj.items, convertedByItem, unitItemMap).map(item => {
            const itemIdStr = item.itemId?._id?.toString?.() || item.itemId?.toString?.();
            return {
              ...item,
              itemId: itemMap[itemIdStr] || null,
            };
          }) || [];
      } else {
        poObj.items =
          poObj.items?.map(item => ({
            ...item,
            itemId: itemMap[item.itemId?.toString()] || null,
          })) || [];
      }
      poObj.vendor = vendorMap[po.vendor?.toString()] || null;
      poObj.paymentTermsId = paymentTermMap[po.paymentTermsId?.toString()] || null;
      poObj.id = poObj._id;

      poObj.addedBy = userMap[po.addedBy?.toString()] || null;
      const updatedById = toUpdatedByUserIdString(poObj.updatedBy);
      poObj.updatedBy = updatedById ? (userMap[updatedById] ?? null) : null;

      return poObj;
    }),
  );
  // Enrich convertedTo with related documents (GRPO, BILL)
  const updatedResults = [];

  for (let i of populatedResults) {
    const tempData = i; // convert mongoose doc to plain object
    const grpoarray = [],
      billarray = [];

    //add remaining quantity of purchaseOrder
    if (tempData.convertedTo?.length > 0) {
      for (const converted of tempData.convertedTo) {
        if (converted.type === 'GRPO') {
          const grpoData = await GrpoOrder.findById(converted.documentId).select('total date dueDate status').lean();

          grpoarray.push({ ...converted, ...grpoData });
        } else if (converted.type === 'BILL') {
          const billData = await Bill.findById(converted.documentId)
            .select('total billDate dueDate status paidAmount balanceAmount')
            .lean();

          billarray.push({ ...converted, ...billData });
        }
      }
    }

    tempData.convertedTo = [...billarray, ...grpoarray];
    updatedResults.push(tempData);
  }

  const resultsWithCurrency = await enrichDocumentCurrency(String(filter.companyId), await attachItemSummaries(updatedResults));

  return {
    ...result,
    results: resultsWithCurrency,
  };
};

const updatePurchaseOrder = async (purchaseOrderId, updateBody, userId, uploadedFiles = []) => {
  const { Item, Customer, Branch } = getBooksCrmModels();
  const { PurchaseOrder } = getBooksModels();
  const { Company } = getCommonModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const originalPO = await PurchaseOrder.findById(purchaseOrderId).session(session);
    if (!originalPO) throw new ApiError(httpStatus.NOT_FOUND, PURCHASE_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: originalPO.attachments ? originalPO.attachments : [],
      userId,
      companyId: originalPO.companyId,
    });

    const company = await Company.findById(originalPO.companyId).populate('baseCurrency').session(session);

    const oldStatus = originalPO.status;
    const { companyId, warehouseId } = updateBody;

    // Get new inventory configuration
    const newInventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.PURCHASE_ORDER, session);

    //  Validate edit permissions
    validateEditPermissions(PURCHASE_ORDER_STATUS_CONFIG.EDIT_RESTRICTED_STATUSES, oldStatus);

    const { vendor } = updateBody;
    if (vendor && String(vendor) !== String(originalPO.vendor)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: originalPO.companyId,
        vendorId: vendor,
      });
      updateBody.currency = currency;
      updateBody.decimalPlaces = decimalPlaces;
    }
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(originalPO.companyId, updateBody.currency || originalPO.currency);

    const oldTotal = originalPO.total || 0;
    const newTotal = updateBody.total || 0;
    let updateMsg = 'Purchase Order updated.';
    if (oldTotal !== newTotal) {
      updateMsg = `Purchase Order updated. Amount changed from ${currencyDoc?.symbol || '₹'}${oldTotal} to ${currencyDoc?.symbol || '₹'}${newTotal}`;
    }

    const { activateVendorBranch, activateItemWarehouse } = updateBody;
    delete updateBody.activateVendorBranch;
    delete updateBody.activateItemWarehouse;
    await preparePurchaseDocumentSave({
      vendorId: updateBody.vendor,
      branchId: updateBody.branchId,
      warehouseId,
      items: updateBody.items,
      carriedItemIds: (originalPO.items || []).map(item => item.itemId),
      companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'purchase order',
    });

    await validateVendorForModule({
      vendorId: updateBody.vendor,
      customerId: updateBody.customer,
      addressId: updateBody.addressId,
      branchId: updateBody.branchId,
      companyId,
      totalAmount: updateBody.total,
      previousTotal: oldTotal,
      moduleName: MODULE_NAMES.PURCHASE_ORDER,
      session,
      skipOverdueCheck: true,
      models: { Customer, Branch },
    });

    //add default warehouse entry
    if (updateBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: updateBody.items,
          warehouseId: warehouseId,
          branchId: updateBody.branchId,
          divisionId: updateBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    // Update PO with new config
    const updatedData = {
      ...updateBody,
      inventoryConfig: newInventoryConfig,
      $set: { updatedBy: userId },
      $push: {
        commentHistory: {
          message: updateMsg,
          addedBy: userId,
          createdAt: new Date(),
        },
      },
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };

    const updatedPurchaseOrder = await PurchaseOrder.findByIdAndUpdate(
      purchaseOrderId,
      { ...updatedData, attachments: allAttachments, authorizedSignature: company?.authorizedSignature },
      { new: true, session },
    );
    await session.commitTransaction();
    return enrichDocumentCurrency(originalPO.companyId, updatedPurchaseOrder.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deletePurchaseOrder = async (purchaseOrderId, companyId) => {
  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    //purchase order can be converted into grpo and bill

    //1.check wheather grpo is created from purchaseOrder
    const grpoOrder = await GrpoOrder.find({
      purchaseOrders: {
        $elemMatch: {
          purchaseOrderId: purchaseOrderId,
        },
      },
      companyId: companyId,
    }).session(session);

    if (grpoOrder.length > 0) {
      const orderIds = grpoOrder.map(inv => inv.grpoOrderId).join(', ');

      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete PurchaseOrder because a GrpoOrder has been created from it:${orderIds}`,
      );
    }

    //2.check wheather bill is created from purchaseOrder
    const bill = await Bill.find({
      purchaseOrders: {
        $elemMatch: {
          purchaseOrderId: purchaseOrderId,
        },
      },
    }).session(session);

    if (bill.length > 0) {
      const orderIds = bill.map(inv => inv.billId).join(', ');

      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete PurchaseOrder because a Bill has been created from it:${orderIds}`,
      );
    }

    await PurchaseOrder.findByIdAndDelete(purchaseOrderId).session(session);
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updatePurchaseOrderStatus = async (purchaseOrderId, companyId, newStatus, userId) => {
  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const purchaseOrder = await PurchaseOrder.findOne({ _id: purchaseOrderId, companyId }).session(session);
    if (!purchaseOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, PURCHASE_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const oldStatus = purchaseOrder.status;

    // Validate status transition (the cancel action is handled specially below)
    if (newStatus !== PO_STATUSES.CANCELLED) {
      validateStatusTransition(PURCHASE_ORDER_STATUS_CONFIG.STATUS_TRANSITIONS, oldStatus, newStatus);
    }

    const isUncancel = oldStatus === PO_STATUSES.CANCELLED && newStatus !== PO_STATUSES.CANCELLED;
    if (isUncancel) {
      assertRevertAllowed({ isUncancel, hasEffect: false });
    }

    //1.check wheather grpo is created from purchaseOrder
    if (newStatus == PO_STATUSES.CANCELLED && purchaseOrder?.status !== PO_STATUSES.CANCELLED) {
      const grpoOrder = await GrpoOrder.find({
        purchaseOrders: {
          $elemMatch: {
            purchaseOrderId: purchaseOrderId,
          },
        },
        status: { $ne: GRPO_STATUSES.CANCELLED },
      }).session(session);

      if (grpoOrder.length > 0) {
        const orderIds = grpoOrder.map(inv => inv.grpoOrderId).join(', ');

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel PurchaseOrder because a GrpoOrder has been created from it:${orderIds}`,
        );
      }

      //2.check wheather bill is created from purchaseOrder
      const bill = await Bill.find({
        purchaseOrders: {
          $elemMatch: {
            purchaseOrderId: purchaseOrderId,
          },
        },
        status: { $ne: BILL_STATUSES.CANCELLED },
      }).session(session);

      if (bill.length > 0) {
        const orderIds = bill.map(inv => inv.billId).join(', ');

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel PurchaseOrder because a Bill has been created from it:${orderIds}`,
        );
      }
    }

    // Update purchase order status
    purchaseOrder.status = newStatus;
    purchaseOrder.updatedBy = userId;
    purchaseOrder.commentHistory.push({
      message: `Purchase Order status changed from ${oldStatus} to ${newStatus}`,
      addedBy: userId,
      createdAt: new Date(),
    });
    await purchaseOrder.save({ session });

    await session.commitTransaction();

    if (isFirstStatusChange(oldStatus, newStatus, PO_STATUSES.DRAFT)) {
      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.PURCHASE_ORDER,
        document: purchaseOrder,
      }).catch(err =>
        logger.error(`Failed to send purchase order customer notifications for ${purchaseOrder.purchaseOrderId}: ${err.message}`),
      );
    }

    return purchaseOrder;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getPurchaseOrder = async (purchaseOrderId, companyId) => {
  const { PurchaseOrder, Bill, GrpoOrder } = getBooksModels();
  const { Customer, Item, Branch, Division, Warehouse, ItemInventory, PaymentTerm, ItemUnit } = getBooksCrmModels();
  const { User, Company } = getCommonModels();

  // ItemUnit lives in booksCrm, so pass the model explicitly
  const data = await PurchaseOrder.findOne({ _id: purchaseOrderId, companyId }).populate({
    path: 'items.itemUnitId',
    select: 'name',
    model: ItemUnit,
  });
  if (!data) {
    throw new ApiError(httpStatus.NOT_FOUND, PURCHASE_ORDER_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  if (data?.vendor) {
    const vendordata = await Customer.findById(data.vendor).select(
      'customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails branch isVendorDirectTax',
    );
    data.vendor = vendordata;
  }

  const itemIds = data.items.map(item => item.itemId);

  const [items] = await Promise.all([
    Item.find({ _id: { $in: itemIds } })
      .select('itemName')
      .lean(),
  ]);

  const itemMap = items.reduce((acc, i) => {
    acc[i._id.toString()] = i;
    return acc;
  }, {});
  const poId = new mongoose.Types.ObjectId(data._id);

  const grpoarray = [];
  if (data?.convertedTo?.length > 0) {
    for (let j of data.convertedTo) {
      if (j.type == 'GRPO') {
        const grpoData = await GrpoOrder.findById(j.documentId).select('total date dueDate status').lean();

        grpoarray.push({ ...(j.toObject?.() ?? j), ...grpoData });
      }

      if (j.type == 'BILL') {
        const billData = await Bill.findById(j.documentId)
          .select('total billDate dueDate status paidAmount balanceAmount')
          .lean();

        grpoarray.push({ ...(j.toObject?.() ?? j), ...billData });
      }
    }
  }
  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (data.commentHistory?.length) {
    const userIds = data.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = data.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  const company = await Company.findById(data.companyId);

  let shippingAddress = null;
  let customer = null;
  if (!data.customer) {
    if (data.addressId) {
      if (data?.addressId?.toString() === company?.address?._id?.toString()) {
        shippingAddress = company.address;
      }
      if (!shippingAddress) {
        shippingAddress = company?.additionalShippingAddresses?.find(addr => addr._id.toString() === data.addressId.toString());
      }
    }
  } else {
    customer = await Customer.findById(data.customer);
    if (customer?.address?.shipping?._id.toString() === data?.addressId?.toString()) {
      shippingAddress = customer?.address?.shipping;
    } else if (
      customer?.address?.additionalShippingAddresses?.some(address => address._id.toString() === data?.addressId?.toString())
    ) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        address => address._id.toString() === data?.addressId?.toString(),
      );
    }
  }

  const addedBy = await User.findById(data.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(data.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findById(data.branchId).select('name');
  const division = await Division.findById(data.divisionId).select('name');
  const warehouse = await Warehouse.findById(data.warehouseId).select('name');
  const paymentTerm = data.paymentTermsId ? await PaymentTerm.findById(data.paymentTermsId).lean() : null;

  const poObj = data.toObject();
  poObj.addedBy = addedBy;
  poObj.updatedBy = updatedBy;
  poObj.paymentTermsId = paymentTerm || null;

  const bill = await Bill.aggregate([
    {
      $match: {
        'purchaseOrders.purchaseOrderId': poId,
        'items.referenceId': poId,
        status: { $ne: BILL_STATUSES.CANCELLED },
      },
    },
    { $unwind: '$items' },
    {
      $match: {
        'items.referenceId': poId,
        'items.itemId': { $in: itemIds },
      },
    },
    {
      $group: {
        _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' },
        totalBilledQty: { $sum: '$items.quantity' },
      },
    },
  ]);

  const grpo = await GrpoOrder.aggregate([
    {
      $match: {
        'purchaseOrders.purchaseOrderId': poId,
        'items.referenceId': poId,
        status: { $ne: GRPO_STATUSES.CANCELLED },
      },
    },
    { $unwind: '$items' },
    {
      $match: {
        'items.referenceId': poId,
        'items.itemId': { $in: itemIds },
      },
    },
    {
      $group: {
        _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' },
        totalBilledQty: { $sum: '$items.quantity' },
      },
    },
  ]);
  // Converted quantities are compared with the ordered line in the item's main unit.
  const unitItemMap = await loadUnitItemMap(itemIds);
  const billMap = sumConvertedToMainUnit(bill, unitItemMap, 'totalBilledQty');
  const grpoMap = sumConvertedToMainUnit(grpo, unitItemMap, 'totalBilledQty');
  const convertedByItem = new Map();
  for (const map of [billMap, grpoMap]) {
    for (const [key, qty] of map) convertedByItem.set(key, (convertedByItem.get(key) || 0) + qty);
  }
  poObj.items = poObj.items
    ? await Promise.all(
        distributeRemainingAcrossLines(poObj.items, convertedByItem, unitItemMap).map(async item => {
          const itemIdStr = item.itemId?._id?.toString?.() || item.itemId?.toString?.();

          // Fetch item inventory details
          const itemInventory = await ItemInventory.findOne({ itemId: itemIdStr, companyId: companyId });
          const matchWarehouse = itemInventory?.warehouses?.find(
            warehouse => warehouse?.warehouseId?.toString() === poObj?.warehouseId?.toString(),
          );

          return {
            ...item,
            itemId: itemMap[itemIdStr] || null,
            stocketDetails: matchWarehouse || {
              availableStock: 0,
              reservedStock: 0,
              lockedStock: 0,
            },
          };
        }),
      )
    : [];

  poObj.commentHistory = commentHistoryWithUser;
  poObj.branchName = branch?.name || null;
  if (customer) {
    poObj.customerDisplayName = customer?.customerDisplayName;
  }
  poObj.divisionName = division?.name || null;
  poObj.warehouseName = warehouse?.name || null;
  poObj.shippingAddress = shippingAddress || {};

  poObj.convertedTo = grpoarray;
  poObj.moduleTree = await buildModuleTree(purchaseOrderId);
  return enrichDocumentCurrency(companyId, poObj);
};

const getPurchaseOrderConvertDropdown = async (filter, options) => {
  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();
  const { Division, Branch, Warehouse, PaymentTerm } = getBooksCrmModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const vendor = new mongoose.Types.ObjectId(filter.vendor);

  const conditions = { companyId, vendor };

  // Status filter
  if (filter?.status?.split(',').length > 0) {
    const statusArray = filter.status.split(',').filter(Boolean);

    if (statusArray.length > 0) {
      conditions.status = { $in: statusArray };
    }
  }
  const purchaseOrder = await PurchaseOrder.find(conditions);

  const idArray = purchaseOrder.map(po => new mongoose.Types.ObjectId(po.id));

  const itemIds = purchaseOrder.flatMap(order => order.items.map(item => item.itemId));

  const divisionIds = getUniqueIds(purchaseOrder, 'divisionId');
  const branchIds = getUniqueIds(purchaseOrder, 'branchId');
  const warehouseIds = getUniqueIds(purchaseOrder, 'warehouseId');
  const paymentTermsIds = getUniqueIds(purchaseOrder, 'paymentTermsId');
  const [divisionMap, branchMap, warehouseMap, paymentTerms] = await Promise.all([
    getNameMap(Division, divisionIds),
    getNameMap(Branch, branchIds),
    getNameMap(Warehouse, warehouseIds),
    paymentTermsIds.length ? PaymentTerm.find({ _id: { $in: paymentTermsIds } }).lean() : [],
  ]);
  const paymentTermsMap = new Map(paymentTerms.map(paymentTerm => [paymentTerm._id.toString(), paymentTerm]));

  purchaseOrder.forEach(order => {
    order.divisionName = divisionMap.get(order.divisionId?.toString()) || null;
    order.branchName = branchMap.get(order.branchId?.toString()) || null;
    order.warehouseName = warehouseMap.get(order.warehouseId?.toString()) || null;
    order.paymentTermsData = paymentTermsMap.get(order.paymentTermsId?.toString()) || null;
  });

  const grpoOrder = await GrpoOrder.aggregate([
    {
      $match: {
        'purchaseOrders.purchaseOrderId': { $in: idArray },
        'items.referenceId': { $in: idArray },
        status: { $ne: GRPO_STATUSES.CANCELLED },
      },
    },
    {
      $project: {
        grpoOrderId: 1,
        purchaseOrders: {
          $filter: {
            input: '$purchaseOrders',
            as: 'order',
            cond: { $in: ['$$order.purchaseOrderId', idArray] },
          },
        },
        items: {
          $filter: {
            input: '$items',
            as: 'item',
            cond: {
              $and: [{ $in: ['$$item.referenceId', idArray] }, { $in: ['$$item.itemId', itemIds] }],
            },
          },
        },
      },
    },
  ]);

  const bill = await Bill.aggregate([
    {
      $match: {
        'purchaseOrders.purchaseOrderId': { $in: idArray },
        'items.referenceId': { $in: idArray },
        status: { $ne: BILL_STATUSES.CANCELLED },
      },
    },
    {
      $project: {
        billId: 1,
        purchaseOrders: {
          $filter: {
            input: '$purchaseOrders',
            as: 'order',
            cond: { $in: ['$$order.purchaseOrderId', idArray] },
          },
        },
        items: {
          $filter: {
            input: '$items',
            as: 'item',
            cond: {
              $and: [{ $in: ['$$item.referenceId', idArray] }, { $in: ['$$item.itemId', itemIds] }],
            },
          },
        },
      },
    },
  ]);

  const itemQuantityMap = {};

  for (const grpo of grpoOrder) {
    for (const item of grpo.items) {
      const key = `${item.referenceId}_${item.itemId}`;

      if (!itemQuantityMap[key]) {
        itemQuantityMap[key] = {
          itemId: item.itemId,
          itemName: item.itemName,
          referenceId: item.referenceId,
          totalQuantity: 0,
        };
      }

      itemQuantityMap[key].totalQuantity += item.quantity;
    }
  }

  for (const i of bill) {
    for (const item of i.items) {
      const key = `${item.referenceId}_${item.itemId}`;

      if (!itemQuantityMap[key]) {
        itemQuantityMap[key] = {
          itemId: item.itemId,
          itemName: item.itemName,
          referenceId: item.referenceId,
          totalQuantity: 0,
        };
      }

      itemQuantityMap[key].totalQuantity += item.quantity;
    }
  }

  const partiallyPendingItems = [];
  const seenOrderIds = new Set();

  for (const order of purchaseOrder) {
    let isPartiallyPending = false;
    for (const item of order.items) {
      const key = `${order._id}_${item.itemId}`;
      const delivered = itemQuantityMap[key]?.totalQuantity || 0;
      const remaining = item.quantity - delivered;

      if (remaining > 0) {
        isPartiallyPending = true;
        break; // No need to check other items if one is pending
      }
    }
    if (isPartiallyPending && !seenOrderIds.has(order._id.toString())) {
      seenOrderIds.add(order._id.toString());
      partiallyPendingItems.push({
        id: order._id,
        purchaseOrderId: order.purchaseOrderId,
        divisionId: order.divisionId,
        branchId: order.branchId,
        warehouseId: order.warehouseId,
        divisionName: order.divisionName,
        branchName: order.branchName,
        warehouseName: order.warehouseName,
        vendor: order.vendor,
        paymentTermsId: order.paymentTermsData,
        customerNotes: order.customerNotes,
        termsAndConditions: order.termsAndConditions,
        reference: order.reference,
        purchaseFile: order.purchaseFile,
        appliesTo: order?.appliesTo || '',
      });
    }
  }

  return partiallyPendingItems;
};

const partiallyConvertedItemList = async (ids, companyId) => {
  const idArray = ids
    .split(',')
    .filter(Boolean)
    .map(id => new mongoose.Types.ObjectId(id));

  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();

  const purchaseOrder = await PurchaseOrder.find({ _id: { $in: idArray }, companyId });

  const itemIds = purchaseOrder.flatMap(order => order.items.map(item => item.itemId));

  const grpoOrder = await GrpoOrder.aggregate([
    {
      $match: {
        'purchaseOrders.purchaseOrderId': { $in: idArray },
        'items.referenceId': { $in: idArray },
        status: { $ne: GRPO_STATUSES.CANCELLED },
      },
    },
    {
      $project: {
        grpoOrderId: 1,
        purchaseOrders: {
          $filter: {
            input: '$purchaseOrders',
            as: 'order',
            cond: { $in: ['$$order.purchaseOrderId', idArray] },
          },
        },
        items: {
          $filter: {
            input: '$items',
            as: 'item',
            cond: {
              $and: [{ $in: ['$$item.referenceId', idArray] }, { $in: ['$$item.itemId', itemIds] }],
            },
          },
        },
      },
    },
  ]);

  const bill = await Bill.aggregate([
    {
      $match: {
        'purchaseOrders.purchaseOrderId': { $in: idArray },
        'items.referenceId': { $in: idArray },
        status: { $ne: BILL_STATUSES.CANCELLED },
      },
    },
    {
      $project: {
        billId: 1,
        purchaseOrders: {
          $filter: {
            input: '$purchaseOrders',
            as: 'order',
            cond: { $in: ['$$order.purchaseOrderId', idArray] },
          },
        },
        items: {
          $filter: {
            input: '$items',
            as: 'item',
            cond: {
              $and: [{ $in: ['$$item.referenceId', idArray] }, { $in: ['$$item.itemId', itemIds] }],
            },
          },
        },
      },
    },
  ]);

  const itemQuantityMap = {};

  for (const i of grpoOrder) {
    for (const item of i.items) {
      const key = `${item.referenceId}_${item.itemId}`;

      if (!itemQuantityMap[key]) {
        itemQuantityMap[key] = {
          itemId: item.itemId,
          itemName: item.itemName,
          referenceId: item.referenceId,
          totalQuantity: 0,
        };
      }

      itemQuantityMap[key].totalQuantity += item.quantity;
    }
  }

  for (const i of bill) {
    for (const item of i.items) {
      const key = `${item.referenceId}_${item.itemId}`; // Unique key per Sales Order + Item

      if (!itemQuantityMap[key]) {
        itemQuantityMap[key] = {
          itemId: item.itemId,
          itemName: item.itemName,
          referenceId: item.referenceId,
          totalQuantity: 0,
        };
      }

      itemQuantityMap[key].totalQuantity += item.quantity;
    }
  }
  // Prepare result for all partially pending items
  const poItemTotalQty = {};
  const partiallyPendingItems = [];

  // ✅ First pass: Calculate total ordered qty per (PO + Item)
  for (const order of purchaseOrder) {
    for (const item of order.items) {
      const key = `${order._id}_${item.itemId}`;
      if (!poItemTotalQty[key]) poItemTotalQty[key] = 0;
      poItemTotalQty[key] += item.quantity;
    }
  }

  // ✅ Second pass: push one entry per item per PO
  for (const order of purchaseOrder) {
    const pushedKeys = new Set(); // Track items already added

    for (const item of order.items) {
      const key = `${order._id}_${item.itemId}`;

      // skip duplicates in same PO
      if (pushedKeys.has(key)) continue;

      const totalOrdered = poItemTotalQty[key];
      const delivered = itemQuantityMap[key]?.totalQuantity || 0;
      const remaining = Math.max(0, totalOrdered - delivered);

      if (remaining > 0) {
        partiallyPendingItems.push({
          ...item.toObject(),
          quantity: totalOrdered, // total qty for this item in PO
          deliveredQuantity: delivered,
          remainingQuantity: remaining,
          referenceId: order._id,
          referenceNo: order.purchaseOrderId,
        });
      }

      pushedKeys.add(key);
    }
  }

  return partiallyPendingItems;
};

const buildModuleTree = async purchaseOrderId => {
  const { GrpoOrder, Bill, PaymentMade, PurchaseOrder } = getBooksModels();

  const moduleTree = {};

  /* -------------------------------------------------- */
  /* PURCHASE ORDER (ROOT) */
  /* -------------------------------------------------- */

  const purchaseOrder = await PurchaseOrder.findById(purchaseOrderId).select('_id purchaseOrderId date status total');

  if (!purchaseOrder?._id) return moduleTree;

  moduleTree.purchaseOrder = {
    id: purchaseOrder._id,
    purchaseOrderId: purchaseOrder.purchaseOrderId,
    date: purchaseOrder.date,
    status: purchaseOrder.status,
    total: purchaseOrder.total,
  };

  /* -------------------------------------------------- */
  /* PURCHASE ORDER → GRPO */
  /* -------------------------------------------------- */

  const grpos = await GrpoOrder.find({
    'purchaseOrders.purchaseOrderId': purchaseOrder._id,
  }).select('_id grpoOrderId date status total');

  if (grpos?.length) {
    moduleTree.purchaseOrder.grpo = {
      grpos,
    };

    const grpoIds = grpos.map(g => g._id);

    /* ------------------------------------- */
    /* GRPO → BILL */
    /* ------------------------------------- */

    const grpoBills = await Bill.find({
      'grpoIds.grpoId': { $in: grpoIds },
      isSplit: { $ne: true },
    }).select('_id billId billDate status total');

    if (grpoBills?.length) {
      moduleTree.purchaseOrder.grpo.bill = {
        bills: grpoBills,
      };

      const billIds = grpoBills.map(b => b._id);

      const payments = await PaymentMade.find({
        'bills.billId': { $in: billIds },
      }).select('_id paymentMadeId paymentDate status paymentMade');

      if (payments?.length) {
        moduleTree.purchaseOrder.grpo.bill.paymentMade = {
          paymentMades: payments,
        };
      }
    }
  }

  /* -------------------------------------------------- */
  /* PURCHASE ORDER → DIRECT BILL */
  /* -------------------------------------------------- */

  const directBills = await Bill.find({
    'purchaseOrders.purchaseOrderId': purchaseOrder._id,
    isSplit: { $ne: true },
  }).select('_id billId billDate status total');

  if (directBills?.length) {
    moduleTree.purchaseOrder.bill = {
      bills: directBills,
    };

    const billIds = directBills.map(b => b._id);

    const payments = await PaymentMade.find({
      'bills.billId': { $in: billIds },
    }).select('_id paymentMadeId paymentDate status paymentMade');

    if (payments?.length) {
      moduleTree.purchaseOrder.bill.paymentMade = {
        paymentMades: payments,
      };
    }
  }

  return moduleTree;
};

const queryPurchaseOrdersExports = async (filter, options) => {
  const result = await getAllPurchaseOrders(filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

module.exports = {
  createPurchaseOrder: withTransientRetry(createPurchaseOrder),
  getAllPurchaseOrders,
  queryPurchaseOrdersExports,
  updatePurchaseOrder,
  deletePurchaseOrder,
  updatePurchaseOrderStatus,
  PO_CONVERSION_ALLOWED_STATUSES,
  getPurchaseOrder,
  getPurchaseOrderConvertDropdown,
  partiallyConvertedItemList,
};
