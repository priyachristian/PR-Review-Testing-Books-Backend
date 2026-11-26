const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const ApiError = require('../../../utils/ApiError');
const { assertLineUnitsValid } = require('../../../services/documentItemEnricher.service');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { getPurchaseAddressCondition, getPurchaseAddressResolver } = require('../../../utils/addressLocationFilter');
const { pairLinesWithExisting } = require('../../../utils/documentLineMatching');
const { GRPO_STATUSES, PO_STATUSES, MODULE_NAMES, BILL_STATUSES, LEDGER_SOURCE_MODULES } = require('../../../utils/enum');
const {
  getInventoryConfig,
  GRPO_STATUS_CONFIG,
  validateStatusTransition,
  validateEditPermissions,
  hasStockEffect,
  assertRevertAllowed,
} = require('../../../utils/inventoryConfig');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { recomputePurchaseOrderStatus } = require('../../../services/conversionStatus.service');
const mongoose = require('mongoose');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
  adjustStockByBatchId,
  deleteStockByBatchId,
} = require('../../../services/warehouseBatch.service');
const { validateVendorForModule } = require('../../../services/customerValidation.service');
const { preparePurchaseDocumentSave, getSourceItemIds } = require('../../../services/purchaseDocumentGuard.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { GRPO_ORDER_MESSAGES } = require('../../../utils/messages');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const { sendModuleCustomerNotifications, isFirstStatusChange } = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');
const { getUniqueIds, getNameMap } = require('../../../utils/helper');
// Status where conversion is allowed
const GRPO_CONVERSION_ALLOWED_STATUSES = [GRPO_STATUSES.RECORDED];

// Replace the GRPO journal when crossing draft/cancelled ↔ posted; skip when only status moves within posted.
const syncGrpoJournal = async (companyId, grpoOrder, userId, session, oldStatus = null) => {
  const POSTED_GRPO_STATUSES = [GRPO_STATUSES.DRAFT, GRPO_STATUSES.RECORDED, GRPO_STATUSES.CONVERTED];
  const isPosted = POSTED_GRPO_STATUSES.includes(grpoOrder.status);

  // Recorded → converted keeps the same GRPO journal; the bill later settles GRNI, not this entry.
  // Any other posted → posted change (edit or cancel leaving empty batches) must re-sync; otherwise, Inventory/GRNI remain at the old receipt.
  if (oldStatus === GRPO_STATUSES.RECORDED && grpoOrder.status === GRPO_STATUSES.CONVERTED) {
    return;
  }

  // Clear any existing GRPO journal, then post again only if goods are in a posted status.
  await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.GRPO, sourceId: grpoOrder._id }, session);
  if (isPosted) {
    await ledgerService.postGrpoJournal({ companyId, grpo: grpoOrder, addedBy: userId }, session);
  }
};

const createGrpoOrder = async (grpoBody, userId, uploadedFiles = []) => {
  const { Customer, Branch } = getBooksCrmModels();
  const { GrpoOrder, PurchaseOrder } = getBooksModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const { activateVendorBranch, activateItemWarehouse } = grpoBody;
    delete grpoBody.activateVendorBranch;
    delete grpoBody.activateItemWarehouse;
    const { warehouseId, purchaseOrderId, companyId, purchaseOrders, ...otherOrderData } = grpoBody;

    let orderItems = grpoBody.items || [];
    let commentHistory = [];

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    await assertLineUnitsValid(orderItems, { companyId, session });

    // Source PO lines are carried, so a later Item Master deactivation does not block them.
    await preparePurchaseDocumentSave({
      vendorId: grpoBody.vendor,
      branchId: grpoBody.branchId,
      warehouseId,
      items: orderItems,
      carriedItemIds: await getSourceItemIds({ purchaseOrders, companyId, session }),
      companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'GRPO',
    });

    await validateVendorForModule({
      vendorId: grpoBody.vendor,
      branchId: grpoBody.branchId,
      companyId,
      totalAmount: grpoBody.total,
      moduleName: MODULE_NAMES.GRPO,
      session,
      customerId: grpoBody.customer,
      addressId: grpoBody.addressId,
      models: { Customer, Branch },
    });

    // If purchaseOrderId is provided, use items from the PO and fetch latest config
    //validate item qty of po to convert in grpo
    let purchaseOrdersData;
    if (purchaseOrders) {
      //get po item details exist in payload
      const purchaseOrderIds = purchaseOrders.map(order => new mongoose.Types.ObjectId(order.purchaseOrderId));
      const itemIds = orderItems.map(item => new mongoose.Types.ObjectId(item.itemId));

      purchaseOrdersData = await PurchaseOrder.aggregate([
        {
          $match: {
            _id: { $in: purchaseOrderIds },
            'items.itemId': { $in: itemIds },
          },
        },
        {
          $project: {
            purchaseOrderId: 1,
            vendor: 1,
            date: 1,
            // Add any other top-level fields you need
            items: {
              $filter: {
                input: '$items',
                as: 'items',
                cond: { $in: ['$$items.itemId', itemIds] },
              },
            },
          },
        },
      ]).session(session);

      //call status update function
      await isFullyConverted(grpoBody.items || [], session);
    }
    // After fetching purchaseOrdersData and before creating the GRPO
    if (purchaseOrdersData && purchaseOrdersData.length > 0) {
      for (const po of purchaseOrdersData) {
        commentHistory.push({
          message: `GRPO is created from Purchase Order(s): ${po.purchaseOrderId || po._id}`,
          addedBy: userId,
          referenceType: 'PurchaseOrder',
          referenceId: po._id,
          createdAt: new Date(),
        });
      }
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: companyId,
    });

    //add default warehouse entry
    if (grpoBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: grpoBody.items,
          warehouseId: warehouseId,
          branchId: grpoBody.branchId,
          divisionId: grpoBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    // Fetch latest inventory config for GRPO module
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.GRPO, session);
    // For a customer GRPO the stock effect comes only from isInventoryEnabled, not from the module config.
    if (grpoBody.customer) {
      inventoryConfig.stockAddEnabled = Boolean(grpoBody.isInventoryEnabled);
    }

    grpoBody.grpoOrderId = await generateUniqueId(
      GrpoOrder,
      companyId,
      MODULE_NAMES.GRPO,
      'grpoOrderId',
      'GRPO',
      session,
      grpoBody.grpoOrderId,
    );

    if (orderItems.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No items provided for GRPO');
    }
    // Create GRPO

    let currency;
    let exchangeRate;
    let decimalPlaces;

    if (purchaseOrders?.length) {
      const sourcePo = await PurchaseOrder.findById(purchaseOrders[0].purchaseOrderId)
        .select('currency exchangeRate decimalPlaces')
        .session(session);
      if (sourcePo?.currency) {
        currency = sourcePo.currency;
        exchangeRate = sourcePo.exchangeRate ?? 1;
        decimalPlaces = sourcePo.decimalPlaces ?? null;
      }
    }

    if (!currency) {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
        companyId,
        vendorId: grpoBody.vendor,
      }));
    }
    const currencyDoc = await getCurrency(companyId, currency);

    if (commentHistory.length === 0) {
      commentHistory.push({
        message: `GRPO created for ${currencyDoc?.symbol || '₹'}${grpoBody.total || 0}`,
        addedBy: userId,
        createdAt: new Date(),
      });
    }

    const orderData = {
      ...otherOrderData,
      grpoOrderId: grpoBody.grpoOrderId,
      currency,
      exchangeRate: otherOrderData.exchangeRate ?? 1,
      decimalPlaces,
      attachments: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      items: orderItems,
      warehouseId,
      companyId,
      purchaseOrders,
      status: GRPO_STATUSES.DRAFT,
      addedBy: userId,
      updatedBy: userId,
      inventoryConfig, // Store the latest config
      commentHistory,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };

    const orders = await GrpoOrder.create([orderData], { session });
    const order = orders[0];

    // Update PO status to CONVERTED and save config changes if converted
    if (purchaseOrders) {
      // purchaseOrder.status = PO_STATUSES.CONVERTED;
      for (let i of purchaseOrders) {
        const purchaseOrderDoc = await PurchaseOrder.findById(i.purchaseOrderId)
          .select('updatedBy convertedTo commentHistory')
          .session(session);

        purchaseOrderDoc.updatedBy = userId;
        let convertedTo = purchaseOrderDoc.convertedTo || [];
        convertedTo.push({
          type: 'GRPO',
          documentId: order._id, // Placeholder until we create the GRPO
          documentNo: grpoBody.grpoOrderId || 'New GRPO',
          convertedAt: new Date(),
        });
        purchaseOrderDoc.commentHistory = purchaseOrderDoc.commentHistory || [];
        purchaseOrderDoc.commentHistory.push({
          message: `Purchase Order converted to GRPO ${order.grpoOrderId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'GRPO',
          referenceId: order._id,
        });
        await purchaseOrderDoc.save({ session });
      }
    }

    // Add batch creation logic for GRPO items just before commit
    if (inventoryConfig.stockAddEnabled) {
      // Initialize batches array for each item
      for (let i of order.items) {
        i.batches = [];
      }

      for (let i of order.items) {
        // Calculate the final purchase price after discount
        let finalPurchasePrice = i.rate;
        if (i.discountConfig) {
          let discountAmount = 0;
          if (i.discountConfig.discountType === 'PERCENTAGE' && i.discountConfig.discountValue > 0) {
            discountAmount = (i.rate * i.discountConfig.discountValue) / 100;
          } else if (i.discountConfig.discountType === 'AMOUNT' && i.discountConfig.discountValue > 0) {
            // For AMOUNT type, divide by quantity to get per-unit discount
            discountAmount = i.discountConfig.discountValue / i.quantity;
          }
          finalPurchasePrice = i.rate - discountAmount;
        }

        // Store batch cost in base at document exchangeRate so sale COGS matches inventory and cost stays fixed at receipt.
        finalPurchasePrice = Math.round(finalPurchasePrice * (Number(order?.exchangeRate) || 1) * 100) / 100;

        // add warehouseItem Batch
        const warehouseStockObj = {
          action: 'addStock',
          stockData: {
            itemId: i.itemId,
            companyId: order.companyId,
            divisionId: order?.divisionId,
            branchId: order.branchId,
            warehouseId,
            quantity: i.quantity,
            itemUnitId: i.itemUnitId,
            purchasePrice: finalPurchasePrice,
            vendorBatchNo: i?.vendorBatchNo,
            vendorBatchExpiry: i?.vendorBatchExpiry,
            sourceType: MODULE_NAMES.GRPO,
            sourceId: order._id,
          },
          session,
        };

        const batchSummary = await handleWarehouseStock(warehouseStockObj);

        if (batchSummary && !batchSummary?.skipped) {
          i.batches.push({
            batchNo: batchSummary.batchNo,
            quantity: batchSummary.quantity,
            purchasePrice: batchSummary.purchasePrice,
            warehouseId: order.warehouseId,
            itemBatchId: batchSummary?._id,
          });
        }
      }

      await checkCompanyStockLevels({
        itemIds: order.items.map(i => i.itemId),
        companyId: order.companyId,
        docType: MODULE_NAMES.GRPO,
        docId: order._id,
        docNo: order.grpoOrderId,
        userId,
        session,
      });

      // Update the GRPO with the batches
      await GrpoOrder.updateOne({ _id: order._id }, { $set: { items: order.items } }, { session });
    }

    await syncGrpoJournal(companyId, order, userId, session);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, order.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getAllGrpoOrders = async (filter, options) => {
  const { Customer, Item, Branch, Division, Warehouse, PaymentTerm, ItemUnit } = getBooksCrmModels();
  const { GrpoOrder, Bill } = getBooksModels();
  const { User, Company } = getCommonModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const conditions = { companyId };

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'date' });
  if (branchDivisionCond) {
    Object.assign(conditions, branchDivisionCond);
  }

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

  // Search filter
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());

    // Find vendors matching search
    const vendors = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );

    const vendorIds = vendors.map(v => v._id);

    conditions.$or = [{ grpoOrderId: searchRegex }, { vendor: { $in: vendorIds } }, { reference: searchRegex }];
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
    return { results: [], totalResults: await GrpoOrder.countDocuments(conditions) };
  }

  // Call paginateWithTotal on GrpoOrder model
  const result = await GrpoOrder.paginateWithTotal(conditions, options);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await GrpoOrder.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  const grpoIds = result.results.map(grpo => grpo._id);

  const billQuery = {
    'grpoIds.grpoId': { $in: grpoIds },
    status: { $ne: BILL_STATUSES.CANCELLED },
    companyId,
  };

  if (filter?.isSplit === undefined) {
    billQuery.isSplit = false;
  }
  const billsForGrpos = await Bill.find(billQuery).select('grpoIds billId status');

  const billByGrpo = billsForGrpos.reduce((acc, bill) => {
    (bill.grpoIds || []).forEach(g => {
      const key = g.grpoId?.toString();
      if (key) (acc[key] ||= []).push(bill);
    });
    return acc;
  }, {});

  // Extract unique vendor IDs & item IDs from paginated results
  const vendorIds = [...new Set(result.results.map(r => r.vendor?.toString()).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(i => i.branchId))];
  const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
  const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
  const itemIds = [
    ...new Set(
      result.results.flatMap(r => (Array.isArray(r.items) ? r.items.map(i => i.itemId?.toString()) : [])).filter(Boolean),
    ),
  ];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  const paymentTermIds = [...new Set(result.results.map(r => r.paymentTermsId?.toString()).filter(Boolean))];
  // Fetch vendors and items in parallel
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

  // Create maps for quick lookup
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

  // Populate vendor & item data into results
  const populatedResults = result.results.map(grpo => {
    const grpoObj = grpo.toObject ? grpo.toObject() : grpo;
    grpoObj.addressIn = resolveAddress(grpoObj);
    grpoObj.paymentTermsId = paymentTermMap[grpoObj.paymentTermsId?.toString()] || null;
    grpoObj.vendor = vendorMap[grpoObj.vendor?.toString()] || null;
    grpoObj.branchId = branchMap[grpoObj.branchId?.toString()] || null;
    grpoObj.divisionId = divisionMap[grpoObj.divisionId?.toString()] || null;
    grpoObj.warehouseId = warehouseMap[grpoObj.warehouseId?.toString()] || null;
    if (Array.isArray(grpoObj.items)) {
      grpoObj.items = grpoObj.items.map(item => ({
        ...item,
        itemId: itemMap[item.itemId?.toString()] || null,
      }));
    }

    grpoObj.id = grpoObj._id;

    grpoObj.addedBy = userMap[grpoObj.addedBy?.toString()] || null;
    const updatedById = toUpdatedByUserIdString(grpoObj.updatedBy);
    grpoObj.updatedBy = updatedById ? (userMap[updatedById] ?? null) : null;
    grpoObj.bills = billByGrpo[grpoObj._id?.toString()] || [];

    return grpoObj;
  });

  // Enrich convertedTo with Bill data (serially or parallel if preferred)
  const updatedResults = [];
  for (const grpo of populatedResults) {
    const tempData = { ...grpo };
    const billArray = [];

    if (Array.isArray(tempData.convertedTo) && tempData.convertedTo.length > 0) {
      for (const converted of tempData.convertedTo) {
        if (converted.type === 'BILL') {
          const billData = await Bill.findById(converted.documentId)
            .select('total billDate dueDate status paidAmount balanceAmount')
            .lean();

          billArray.push({ ...converted, ...billData });
        }
      }
    }

    tempData.convertedTo = billArray;
    updatedResults.push(tempData);
  }

  const resultsWithCurrency = await enrichDocumentCurrency(String(filter.companyId), await attachItemSummaries(updatedResults));

  return {
    ...result,
    results: resultsWithCurrency,
  };
};

const queryGrpoOrdersExports = async (filter, options) => {
  const result = await getAllGrpoOrders(filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const updateGrpoOrder = async (grpoOrderId, updateBody, userId, uploadedFiles = []) => {
  const { Customer, Branch } = getBooksCrmModels();
  const { GrpoOrder } = getBooksModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const grpoOrder = await GrpoOrder.findById(grpoOrderId).session(session);
    if (!grpoOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, 'GRPO Order not found');
    }
    const oldStatus = grpoOrder.status;

    const company = await Company.findById(grpoOrder.companyId).populate('baseCurrency').session(session);

    // Validate edit permissions
    validateEditPermissions(GRPO_STATUS_CONFIG.EDIT_RESTRICTED_STATUSES, grpoOrder.status);

    // Runs before stock moves so a rejected line never touches inventory.
    const { activateVendorBranch, activateItemWarehouse } = updateBody;
    delete updateBody.activateVendorBranch;
    delete updateBody.activateItemWarehouse;
    await preparePurchaseDocumentSave({
      vendorId: updateBody.vendor,
      branchId: updateBody.branchId,
      warehouseId: updateBody.warehouseId,
      items: updateBody.items,
      carriedItemIds: (grpoOrder.items || []).map(item => item.itemId),
      companyId: grpoOrder.companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'GRPO',
    });

    const { vendor } = updateBody;
    if (vendor && String(vendor) !== String(grpoOrder.vendor)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: grpoOrder.companyId,
        vendorId: vendor,
      });
      updateBody.currency = currency;
      updateBody.decimalPlaces = decimalPlaces;
    }
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(grpoOrder.companyId, updateBody.currency || grpoOrder.currency);

    const { items: newItems, warehouseId, companyId, ...otherUpdateBody } = updateBody;

    // Fetch latest inventory config for GRPO module
    // A customer GRPO keeps the stock effect chosen at creation (isInventoryEnabled is not editable).
    const latestInventoryConfig = grpoOrder.customer
      ? grpoOrder.inventoryConfig
      : await getInventoryConfig(companyId, MODULE_NAMES.GRPO, session);

    // Handle item changes if provided
    if (newItems && newItems.length > 0) {
      if (latestInventoryConfig?.stockAddEnabled) {
        const getFinalPurchasePrice = item => {
          let finalPurchasePrice = item.rate;
          if (item.discountConfig) {
            let discountAmount = 0;
            if (item.discountConfig.discountType === 'PERCENTAGE' && item.discountConfig.discountValue > 0) {
              discountAmount = (item.rate * item.discountConfig.discountValue) / 100;
            } else if (item.discountConfig.discountType === 'AMOUNT' && item.discountConfig.discountValue > 0) {
              // For AMOUNT type, divide by quantity to get per-unit discount
              discountAmount = item.discountConfig.discountValue / item.quantity;
            }
            finalPurchasePrice = item.rate - discountAmount;
          }
          // Store batch cost in base at document exchangeRate so sale COGS matches inventory and cost stays fixed at receipt.
          return Math.round(finalPurchasePrice * (Number(updateBody?.exchangeRate) || 1) * 100) / 100;
        };

        // The same item can appear on several lines (different qty/price/unit), each owning its own batch.
        // Pair every submitted line with the existing line of the same item + unit + price (then same item + unit),
        // so each line adjusts its own batch regardless of order and a removed line releases only its own batch.
        const { matches, unmatchedOldLines } = pairLinesWithExisting(newItems, grpoOrder.items);
        const releasedBatches = unmatchedOldLines.map(line => ({ itemId: line.itemId, batches: line.batches || [] }));

        const finalItems = [];
        for (const [index, newItem] of newItems.entries()) {
          const [oldBatch, ...extraBatches] = matches[index]?.batches || [];
          if (extraBatches.length) releasedBatches.push({ itemId: newItem.itemId, batches: extraBatches });
          const finalPurchasePrice = getFinalPurchasePrice(newItem);
          let batches = [];

          if (oldBatch?.itemBatchId) {
            const adjusted = await adjustStockByBatchId({
              stockData: {
                itemId: newItem.itemId,
                companyId: grpoOrder.companyId,
                warehouseId: grpoOrder.warehouseId,
                itemBatchId: oldBatch.itemBatchId,
                newQuantity: newItem.quantity,
                itemUnitId: newItem.itemUnitId,
                newPurchasePrice: finalPurchasePrice,
                vendorBatchNo: newItem?.vendorBatchNo,
                vendorBatchExpiry: newItem?.vendorBatchExpiry,
              },
              session,
            });
            batches = [
              {
                batchNo: adjusted.batchNo,
                quantity: adjusted.quantity,
                purchasePrice: adjusted.purchasePrice,
                warehouseId: grpoOrder.warehouseId,
                itemBatchId: adjusted.itemBatchId,
              },
            ];
          } else {
            const batchSummary = await handleWarehouseStock({
              action: 'addStock',
              stockData: {
                itemId: newItem.itemId,
                companyId: grpoOrder.companyId,
                divisionId: grpoOrder?.divisionId,
                branchId: grpoOrder.branchId,
                warehouseId: grpoOrder?.warehouseId,
                quantity: newItem.quantity,
                itemUnitId: newItem.itemUnitId,
                purchasePrice: finalPurchasePrice,
                vendorBatchNo: newItem?.vendorBatchNo,
                vendorBatchExpiry: newItem?.vendorBatchExpiry,
                sourceType: MODULE_NAMES.GRPO,
                sourceId: grpoOrderId,
              },
              session,
            });
            if (batchSummary && !batchSummary?.skipped) {
              batches = [
                {
                  batchNo: batchSummary.batchNo,
                  quantity: batchSummary.quantity,
                  purchasePrice: batchSummary.purchasePrice,
                  warehouseId: grpoOrder.warehouseId,
                  itemBatchId: batchSummary._id,
                },
              ];
            }
          }

          finalItems.push({ ...newItem, batches });
        }

        // Batches left in the pool belong to lines that were removed - release their stock.
        const touchedItemIds = new Set(newItems.map(i => i.itemId.toString()));
        for (const { itemId: releasedItemId, batches: releasedList } of releasedBatches) {
          for (const leftover of releasedList) {
            if (!leftover.itemBatchId) continue;
            touchedItemIds.add(releasedItemId.toString());
            await deleteStockByBatchId({
              stockData: {
                itemId: releasedItemId,
                companyId: grpoOrder.companyId,
                warehouseId: grpoOrder.warehouseId,
                itemBatchId: leftover.itemBatchId,
              },
              session,
            });
          }
        }

        await checkCompanyStockLevels({
          itemIds: [...touchedItemIds],
          companyId: grpoOrder.companyId,
          docType: MODULE_NAMES.GRPO,
          docId: grpoOrderId,
          docNo: grpoOrder.grpoOrderId,
          userId,
          session,
        });

        grpoOrder.items = finalItems;
        grpoOrder.markModified('items');
      } else {
        // If stock is not enabled, just replace with newItems
        grpoOrder.items = newItems;
      }
    }
    const oldTotal = grpoOrder.total;
    // Update other fields

    await validateVendorForModule({
      vendorId: updateBody.vendor,
      branchId: updateBody.branchId,
      companyId,
      totalAmount: updateBody.total,
      previousTotal: oldTotal,
      moduleName: MODULE_NAMES.GRPO,
      session,
      skipOverdueCheck: true,
      customerId: updateBody.customer,
      addressId: updateBody.addressId,
      models: { Customer, Branch },
    });

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: grpoOrder.attachments ? grpoOrder.attachments : [],
      userId,
      companyId: grpoOrder.companyId,
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
    grpoOrder.markModified('items');
    Object.assign(grpoOrder, {
      ...otherUpdateBody,
      attachments: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      inventoryConfig: latestInventoryConfig,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    if (warehouseId) {
      grpoOrder.warehouseId = warehouseId;
    }

    // Update modification details
    grpoOrder.updatedBy = userId;
    let updateMsg = 'GRPO updated.';
    if (updateBody.total !== undefined && oldTotal !== updateBody.total) {
      updateMsg = `GRPO updated. Amount changed from ${currencyDoc?.symbol || '₹'}${oldTotal} to ${currencyDoc?.symbol || '₹'}${updateBody.total}`;
    }
    grpoOrder.commentHistory = grpoOrder.commentHistory || [];
    grpoOrder.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
    });

    await grpoOrder.save({ session });

    await syncGrpoJournal(grpoOrder.companyId, grpoOrder, userId, session, oldStatus);

    await flushCompanyStockLevels(session);

    if (grpoOrder?.purchaseOrders?.length > 0) {
      const purchaseOrderIds = [...new Set(grpoOrder.purchaseOrders.map(po => po.purchaseOrderId?.toString()).filter(Boolean))];
      for (const purchaseOrderId of purchaseOrderIds) {
        await recomputePurchaseOrderStatus(purchaseOrderId, session);
      }
    }

    await session.commitTransaction();
    return enrichDocumentCurrency(grpoOrder.companyId, grpoOrder.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteGrpoOrder = async (grpoOrderId, companyId, userId) => {
  const { PurchaseOrder, GrpoOrder, Bill } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const grpoOrder = await GrpoOrder.findOne({ _id: grpoOrderId, companyId }).session(session);
    if (!grpoOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, 'GRPO Order not found');
    }
    const grpoNo = grpoOrder?.grpoOrderId;
    const bills = await Bill.find({
      $or: [{ grpoId: grpoOrderId }, { 'grpoIds.grpoId': grpoOrderId }],
    }).session(session);

    if (bills.length > 0) {
      const orderIds = bills.map(b => b.billId).join(', ');
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `This GRPO can't be deleted because a Bill has already been created from it (Bill: ${orderIds}).`,
      );
    }

    if (grpoOrder.inventoryConfig?.stockAddEnabled && grpoOrder?.status !== GRPO_STATUSES.CANCELLED) {
      for (let i of grpoOrder?.items) {
        const warehouseStockObj = {
          action: 'deleteStock',
          stockData: {
            itemId: i.itemId,
            companyId: grpoOrder.companyId,
            branchId: grpoOrder.branchId,
            warehouseId: grpoOrder.warehouseId,
            deductedSourceType: MODULE_NAMES.GRPO,
            deductedSourceId: grpoOrder._id,
          },
          session,
        };
        await handleWarehouseStock(warehouseStockObj);
      }

      await checkCompanyStockLevels({
        itemIds: grpoOrder.items.map(i => i.itemId),
        companyId: grpoOrder.companyId,
        docType: MODULE_NAMES.GRPO,
        docId: grpoOrder._id,
        docNo: grpoOrder.grpoOrderId,
        userId,
        session,
      });
    }

    if (grpoOrder?.purchaseOrders?.length > 0) {
      const purchaseOrderIds = [...new Set(grpoOrder.purchaseOrders.map(po => po.purchaseOrderId?.toString()).filter(Boolean))];

      for (const purchaseOrderId of purchaseOrderIds) {
        const existingComment = await PurchaseOrder.findOne({
          _id: new mongoose.Types.ObjectId(purchaseOrderId),
          'commentHistory.referenceId': grpoOrderId,
        }).session(session);

        const baseUpdate = {
          $pull: {
            convertedTo: {
              documentId: new mongoose.Types.ObjectId(grpoOrderId),
            },
          },
          $set: {
            updatedBy: userId,
          },
        };

        if (existingComment) {
          await PurchaseOrder.updateOne(
            { _id: new mongoose.Types.ObjectId(purchaseOrderId) },
            {
              ...baseUpdate,
              $set: {
                ...baseUpdate.$set,
                'commentHistory.$[target].isDeleted': true,
              },
            },
            {
              arrayFilters: [{ 'target.referenceId': grpoOrderId }],
              session,
            },
          );
        } else {
          await PurchaseOrder.updateOne({ _id: new mongoose.Types.ObjectId(purchaseOrderId) }, baseUpdate, { session });
        }

        await PurchaseOrder.updateOne(
          { _id: new mongoose.Types.ObjectId(purchaseOrderId) },
          {
            $push: {
              commentHistory: {
                message: `GRPO No ${grpoNo} deleted successfully`,
                addedBy: userId,
                createdAt: new Date(),
              },
            },
          },
          { session },
        );
      }
    }

    await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.GRPO, sourceId: grpoOrder._id }, session);

    await GrpoOrder.findByIdAndDelete(grpoOrderId, { session });

    if (grpoOrder?.purchaseOrders?.length > 0) {
      const purchaseOrderIds = [...new Set(grpoOrder.purchaseOrders.map(po => po.purchaseOrderId?.toString()).filter(Boolean))];
      for (const purchaseOrderId of purchaseOrderIds) {
        await recomputePurchaseOrderStatus(purchaseOrderId, session);
      }
    }

    await flushCompanyStockLevels(session);

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

const updateGrpoOrderStatus = async (grpoOrderId, companyId, newStatus, userId) => {
  const { GrpoOrder, Bill } = getBooksModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const grpoOrder = await GrpoOrder.findOne({ _id: grpoOrderId, companyId }).session(session);
    if (!grpoOrder) {
      throw new ApiError(httpStatus.NOT_FOUND, 'GRPO order not found');
    }

    const oldStatus = grpoOrder.status;

    // Validate status transition (the cancel action is handled specially below)
    if (newStatus !== GRPO_STATUSES.CANCELLED) {
      validateStatusTransition(GRPO_STATUS_CONFIG.STATUS_TRANSITIONS, oldStatus, newStatus);
    }

    const isUncancel = oldStatus === GRPO_STATUSES.CANCELLED && newStatus !== GRPO_STATUSES.CANCELLED;
    if (isUncancel) {
      assertRevertAllowed({ isUncancel, hasEffect: hasStockEffect(grpoOrder?.inventoryConfig) });
    }

    if (newStatus == GRPO_STATUSES.CANCELLED && grpoOrder?.status !== GRPO_STATUSES.CANCELLED) {
      const bills = await Bill.find({
        $or: [{ grpoId: grpoOrderId }, { 'grpoIds.grpoId': grpoOrderId }],
        status: { $ne: BILL_STATUSES.CANCELLED },
      }).session(session);

      if (bills.length > 0) {
        const orderIds = bills.map(b => b.billId).join(', ');
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `This GRPO can't be cancelled because a Bill has already been created from it (Bill: ${orderIds}).`,
        );
      }

      if (grpoOrder.inventoryConfig?.stockAddEnabled) {
        for (let i of grpoOrder?.items) {
          const warehouseStockObj = {
            action: 'deleteStock',
            stockData: {
              itemId: i.itemId,
              companyId: grpoOrder.companyId,
              branchId: grpoOrder.branchId,
              warehouseId: grpoOrder.warehouseId,
              deductedSourceType: MODULE_NAMES.GRPO,
              deductedSourceId: grpoOrder._id,
            },
            session,
          };
          await handleWarehouseStock(warehouseStockObj);

          grpoOrder.items.forEach(item => {
            item.batches = [];
          });

          grpoOrder.markModified('items');
        }

        await checkCompanyStockLevels({
          itemIds: grpoOrder.items.map(i => i.itemId),
          companyId: grpoOrder.companyId,
          docType: MODULE_NAMES.GRPO,
          docId: grpoOrder._id,
          docNo: grpoOrder.grpoOrderId,
          userId,
          session,
        });
      }

      if (grpoOrder?.purchaseOrders?.length > 0) {
        await calculateRemainingQty(grpoOrder?.items, grpoOrderId, grpoOrder?.grpoOrderId, userId, session);
      }
    }
    // Update GRPO status
    grpoOrder.status = newStatus;
    grpoOrder.updatedBy = userId;
    grpoOrder.commentHistory = grpoOrder.commentHistory || [];
    grpoOrder.commentHistory.push({
      message: `GRPO status changed from ${oldStatus} to ${newStatus}`,
      addedBy: userId,
      createdAt: new Date(),
    });
    await grpoOrder.save({ session });

    if (grpoOrder?.purchaseOrders?.length > 0) {
      for (const po of grpoOrder.purchaseOrders) {
        await recomputePurchaseOrderStatus(po.purchaseOrderId, session);
      }
    }

    await syncGrpoJournal(companyId, grpoOrder, userId, session, oldStatus);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    if (isFirstStatusChange(oldStatus, newStatus, GRPO_STATUSES.DRAFT)) {
      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.GRPO,
        document: grpoOrder,
      }).catch(err => logger.error(`Failed to send GRPO customer notifications for ${grpoOrder.grpoOrderId}: ${err.message}`));
    }

    return grpoOrder;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getGrpoOrder = async (grpoOrderId, companyId) => {
  const { Customer, Branch, Division, Warehouse, PaymentTerm, ItemUnit } = getBooksCrmModels();
  const { GrpoOrder, Bill, PurchaseOrder } = getBooksModels();
  const { User, Company } = getCommonModels();

  // ItemUnit lives in booksCrm, so pass the model explicitly
  const data = await GrpoOrder.findOne({ _id: grpoOrderId, companyId }).populate({
    path: 'items.itemUnitId',
    select: 'name',
    model: ItemUnit,
  });
  if (!data) {
    throw new ApiError(httpStatus.NOT_FOUND, GRPO_ORDER_MESSAGES.FETCH_NOT_FOUND);
  }

  let vendor = {};
  if (data?.vendor) {
    vendor = await Customer.findById(data.vendor)
      .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails branch isVendorDirectTax')
      .lean();
  }

  const billarray = [];
  if (data?.convertedTo?.length > 0) {
    for (let j of data.convertedTo) {
      if (j.type == 'BILL') {
        const billData = await Bill.findById(j.documentId)
          .select('total billDate dueDate status paidAmount balanceAmount')
          .lean();

        billarray.push({ ...(j.toObject?.() ?? j), ...billData });
      }
    }
  }

  let po = [];
  if (data?.purchaseOrders?.length > 0) {
    for (let i of data.purchaseOrders) {
      const data = await PurchaseOrder.findById(i.purchaseOrderId).select('status total date purchaseOrderId').lean();
      po.push({ ...data, purchaseOrderId: i.purchaseOrderId, purchaseOrderNo: i.purchaseOrderNo });
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

  const branch = await Branch.findById(data.branchId).select('name');
  const division = await Division.findById(data.divisionId).select('name');
  const warehouse = await Warehouse.findById(data.warehouseId).select('name');
  const paymentTerm = data.paymentTermsId ? await PaymentTerm.findById(data.paymentTermsId).lean() : null;

  const addedBy = await User.findById(data.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(data.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;

  const dataObj = data.toObject();
  dataObj.addedBy = addedBy;
  dataObj.updatedBy = updatedBy;
  dataObj.branchName = branch?.name || null;
  dataObj.divisionName = division?.name || null;
  dataObj.warehouseName = warehouse?.name || null;
  dataObj.paymentTermsId = paymentTerm || null;

  if (customer) {
    dataObj.customerDisplayName = customer?.customerDisplayName;
  }
  dataObj.commentHistory = commentHistoryWithUser;
  dataObj.vendor = vendor;
  dataObj.convertedTo = billarray;
  dataObj.purchaseOrders = po;
  dataObj.shippingAddress = shippingAddress || {};
  dataObj.moduleTree = await buildModuleTree(grpoOrderId);

  return enrichDocumentCurrency(companyId, dataObj);
};

const isFullyConverted = async (items, session) => {
  const { GrpoOrder, PurchaseOrder, Bill } = getBooksModels();

  const purchaseOrders = [
    ...new Map(
      items
        .filter(item => item.referenceId && item.referenceType)
        .map(item => [
          `${item.referenceType}:${item.referenceId}`,
          { referenceType: item.referenceType, purchaseOrderId: item.referenceId },
        ]),
    ).values(),
  ];
  if (purchaseOrders.length > 0) {
    //get all item of purchase order with qty
    for (const po of purchaseOrders) {
      const purchaseOrderDoc = await PurchaseOrder.findOne({
        _id: po.purchaseOrderId,
      }).lean();

      if (!purchaseOrderDoc) continue;

      const allItems = purchaseOrderDoc.items.map(item => ({
        purchaseOrderId: po.purchaseOrderId,
        itemId: item.itemId,
        quantity: item.quantity,
      }));

      //now get all items from grpo to check it is converted partially or fully in previous conversion
      const grpoItems = await GrpoOrder.aggregate([
        {
          $match: {
            'purchaseOrders.purchaseOrderId': new mongoose.Types.ObjectId(po.purchaseOrderId),
            'items.referenceId': new mongoose.Types.ObjectId(po.purchaseOrderId),
            status: { $ne: GRPO_STATUSES.CANCELLED },
          },
        },
        {
          $project: {
            matchingItems: {
              $filter: {
                input: '$items',
                as: 'item',
                cond: {
                  $eq: ['$$item.referenceId', new mongoose.Types.ObjectId(po.purchaseOrderId)],
                },
              },
            },
          },
        },
        { $unwind: '$matchingItems' },
        {
          $project: {
            itemId: '$matchingItems.itemId',
            quantity: '$matchingItems.quantity',
            referenceId: '$matchingItems.referenceId',
          },
        },
        {
          $group: {
            _id: {
              itemId: '$itemId',
              referenceId: '$referenceId',
            },
            quantity: { $sum: '$quantity' },
          },
        },
        {
          $project: {
            itemId: '$_id.itemId',
            referenceId: '$_id.referenceId',
            quantity: 1,
            _id: 0,
          },
        },
      ]);

      const billItems = await Bill.aggregate([
        {
          $match: {
            'purchaseOrders.purchaseOrderId': new mongoose.Types.ObjectId(po.purchaseOrderId),
            'items.referenceId': new mongoose.Types.ObjectId(po.purchaseOrderId),
            status: { $ne: BILL_STATUSES.CANCELLED },
          },
        },
        {
          $project: {
            matchingItems: {
              $filter: {
                input: '$items',
                as: 'item',
                cond: {
                  $eq: ['$$item.referenceId', new mongoose.Types.ObjectId(po.purchaseOrderId)],
                },
              },
            },
          },
        },
        { $unwind: '$matchingItems' },
        {
          $project: {
            itemId: '$matchingItems.itemId',
            quantity: '$matchingItems.quantity',
            referenceId: '$matchingItems.referenceId',
          },
        },
        {
          $group: {
            _id: {
              itemId: '$itemId',
              referenceId: '$referenceId',
            },
            quantity: { $sum: '$quantity' },
          },
        },
        {
          $project: {
            itemId: '$_id.itemId',
            referenceId: '$_id.referenceId',
            quantity: 1,
            _id: 0,
          },
        },
      ]);

      const result = allItems.map(item => {
        const matchedGrpo = grpoItems.find(
          g => g.itemId.toString() === item.itemId.toString() && g.referenceId.toString() === item.purchaseOrderId.toString(),
        );

        const matchedBill = billItems.find(
          b => b.itemId.toString() === item.itemId.toString() && b.referenceId.toString() === item.purchaseOrderId.toString(),
        );

        const deliveredQty = (matchedGrpo?.quantity || 0) + (matchedBill?.quantity || 0);

        return {
          ...item,
          deliveredQuantity: deliveredQty,
          remainingQuantity: item.quantity - deliveredQty,
        };
      });

      const finalResult = result.map(grpoItem => {
        const matchedItem = items.find(
          item =>
            item.itemId.toString() === grpoItem.itemId.toString() &&
            item.referenceId.toString() === grpoItem.purchaseOrderId.toString(),
        );

        const consumedQty = matchedItem ? matchedItem.quantity : 0;

        return {
          ...grpoItem,
          remainingQuantity: grpoItem.remainingQuantity - consumedQty,
        };
      });

      const allRemainingZero = finalResult.every(item => item.remainingQuantity <= 0);

      const statusToUpdate = allRemainingZero ? PO_STATUSES.CONVERTED : PO_STATUSES.PARTIALLY_RECORDED;

      await PurchaseOrder.updateOne(
        { _id: new mongoose.Types.ObjectId(po.purchaseOrderId) },
        { $set: { status: statusToUpdate } },
      ).session(session);
    }
  }
};

const calculateRemainingQty = async (items, grpoId, grpoNo, userId, session) => {
  const { PurchaseOrder } = getBooksModels();

  const purchaseOrders = [
    ...new Map(
      items
        .filter(item => item.referenceId && item.referenceType)
        .map(item => [
          `${item.referenceType}:${item.referenceId}`,
          { referenceType: item.referenceType, purchaseOrderId: item.referenceId },
        ]),
    ).values(),
  ];
  if (purchaseOrders.length > 0) {
    for (const po of purchaseOrders) {
      await PurchaseOrder.updateOne(
        { _id: new mongoose.Types.ObjectId(po.purchaseOrderId) },
        {
          $push: {
            commentHistory: {
              message: `Grpo No ${grpoNo} cancelled successfully`,
              addedBy: userId,
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
    }
  }
};

const grpofromPurchaseOrder = async query => {
  const { GrpoOrder, PurchaseOrder } = getBooksModels();
  const { Division, Branch, Warehouse, PaymentTerm } = getBooksCrmModels();
  const { vendor, companyId } = query;
  const purchaseOrders = await PurchaseOrder.find({
    vendor: vendor,
    companyId: companyId,
    status: { $in: [PO_STATUSES.CONVERTED] },
  }).lean();

  const completedPOIds = purchaseOrders.map(so => so._id);

  const grpoOrder = await GrpoOrder.find({
    vendor: vendor,
    companyId,
    purchaseOrders: {
      $elemMatch: {
        purchaseOrderId: { $in: completedPOIds },
      },
    },
    status: GRPO_STATUSES.RECORDED,
  }).lean();

  const divisionIds = getUniqueIds(grpoOrder, 'divisionId');
  const branchIds = getUniqueIds(grpoOrder, 'branchId');
  const warehouseIds = getUniqueIds(grpoOrder, 'warehouseId');
  const paymentTermsIds = getUniqueIds(grpoOrder, 'paymentTermsId');
  const [divisionMap, branchMap, warehouseMap, paymentTerms] = await Promise.all([
    getNameMap(Division, divisionIds),
    getNameMap(Branch, branchIds),
    getNameMap(Warehouse, warehouseIds),
    paymentTermsIds.length ? PaymentTerm.find({ _id: { $in: paymentTermsIds } }).lean() : [],
  ]);
  const paymentTermsMap = new Map(paymentTerms.map(paymentTerm => [paymentTerm._id.toString(), paymentTerm]));

  grpoOrder.forEach(grpo => {
    grpo.divisionName = divisionMap.get(grpo.divisionId?.toString()) || null;
    grpo.branchName = branchMap.get(grpo.branchId?.toString()) || null;
    grpo.warehouseName = warehouseMap.get(grpo.warehouseId?.toString()) || null;
    grpo.paymentTermsId = paymentTermsMap.get(grpo.paymentTermsId?.toString()) || null;
  });
  return grpoOrder;
};

const grpoItems = async (grpoIds, companyId) => {
  const { GrpoOrder } = getBooksModels();

  const idArray = grpoIds
    .split(',')
    .filter(Boolean)
    .map(id => new mongoose.Types.ObjectId(id));

  const grpoItems = await GrpoOrder.aggregate([
    {
      $match: {
        _id: { $in: idArray },
        companyId: new mongoose.Types.ObjectId(companyId),
      },
    },
    { $unwind: '$items' },
    {
      $project: {
        grpoId: '$_id',
        itemId: '$items.itemId',
        itemNo: '$items.itemNo',
        description: '$items.description',
        itemName: '$items.itemName',
        itemUnit: '$items.itemUnit',
        itemUnitId: '$items.itemUnitId',
        quantity: '$items.quantity',
        rate: '$items.rate',
        gst: '$items.gst',
        hsnCode: '$items.hsnCode',
        taxAmount: '$items.taxAmount',
        amount: '$items.amount',
        splitAmount: '$items.splitAmount',
        discountConfig: '$items.discountConfig',
        batches: '$items.batches',
        referenceId: '$items.referenceId',
        referenceType: '$items.referenceType',
        referenceId: '$items.referenceId',
        referenceType: '$items.referenceType',
        referenceNo: '$grpoOrderId',
      },
    },
  ]);

  return grpoItems;
};

const buildModuleTree = async grpoId => {
  const { GrpoOrder, Bill, PaymentMade, PurchaseOrder } = getBooksModels();

  const moduleTree = { purchaseOrders: [] };

  const grpo = await GrpoOrder.findById(grpoId).select('_id grpoOrderId date status total purchaseOrders');

  if (!grpo) return moduleTree;

  /* ================= GET PURCHASE ORDERS ================= */

  const poIds = grpo.purchaseOrders?.map(p => p.purchaseOrderId) || [];

  const purchaseOrders = await PurchaseOrder.find({
    _id: { $in: poIds },
  }).select('_id purchaseOrderId date status total');

  /* ================= GET BILLS ================= */

  const bills = await Bill.find({
    'grpoIds.grpoId': grpo._id,
    isSplit: { $ne: true },
  }).select('_id billId billDate status total');

  for (const po of purchaseOrders) {
    const poNode = {
      id: po._id,
      purchaseOrderId: po.purchaseOrderId,
      date: po.date,
      status: po.status,
      total: po.total,
      grpos: [],
    };

    const grpoNode = {
      id: grpo._id,
      grpoId: grpo.grpoOrderId,
      date: grpo.date,
      status: grpo.status,
      total: grpo.total,
      bills: [],
    };

    for (const bill of bills) {
      const billNode = {
        id: bill._id,
        billId: bill.billId,
        billDate: bill.billDate,
        status: bill.status,
        total: bill.total,
        payments: [],
      };

      const payments = await PaymentMade.find({
        'bills.billId': bill._id,
      }).select('_id paymentMadeId paymentDate status paymentMade');

      for (const payment of payments) {
        billNode.payments.push({
          id: payment._id,
          paymentMadeId: payment.paymentMadeId,
          paymentDate: payment.paymentDate,
          status: payment.status,
        });
      }

      grpoNode.bills.push(billNode);
    }

    poNode.grpos.push(grpoNode);

    moduleTree.purchaseOrders.push(poNode);
  }

  return moduleTree;
};

module.exports = {
  createGrpoOrder: withTransientRetry(createGrpoOrder),
  getAllGrpoOrders,
  queryGrpoOrdersExports,
  updateGrpoOrder,
  deleteGrpoOrder,
  updateGrpoOrderStatus,
  GRPO_CONVERSION_ALLOWED_STATUSES,
  getGrpoOrder,
  grpofromPurchaseOrder,
  grpoItems,
};
