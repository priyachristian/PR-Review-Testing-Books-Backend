const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const ApiError = require('../../../utils/ApiError');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { getAddressFilterCondition, findAddressById } = require('../../../utils/addressLocationFilter');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { pairLinesWithExisting } = require('../../../utils/documentLineMatching');
const { processIncentiveEarn, cancelIncentiveLog } = require('../../setting/incentiveScheme/incentiveScheme.service');
const {
  DELIVERY_CHALLAN_STATUS,
  MODULE_NAMES,
  SALES_ORDER_STATUS,
  INVOICE_STATUS,
  LEDGER_SOURCE_MODULES,
  E_WAY_BILL_STATUS,
} = require('../../../utils/enum');
const { NOTIFICATION_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');
const {
  DELIVERY_CHALLAN_STATUS_CONFIG,
  getInventoryConfig,
  validateStatusTransition,
  validateEditPermissions,
  validateStockAvailability,
  hasStockEffect,
  assertRevertAllowed,
} = require('../../../utils/inventoryConfig');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const mongoose = require('mongoose');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const { applyCompanyPaymentTermsFallback } = require('../../../utils/customerPaymentTerms');
const { getPrimaryBank, getPrimaryBankDetails } = require('../../banking/bank/bank.service');
const { uploadFileToS3, handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
} = require('../../../services/warehouseBatch.service');
const { validateCustomerForModule } = require('../../../services/customerValidation.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { DELIVERY_CHALLAN_MESSAGES } = require('../../../utils/messages');
const { sendTransactionNotification } = require('../../../utils/transactionNotification');
const {
  sendModuleCustomerNotifications,
  notifyModuleDocumentIfNonDraft,
  isFirstStatusChange,
} = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const {
  enrichDocumentItemLines,
  assertSelectableForNewLines,
  assertResolvable,
  assertLineUnitsValid,
  SNAPSHOT_MODE,
} = require('../../../services/documentItemEnricher.service');
const { getUniqueIds, getNameMap } = require('../../../utils/helper');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { recomputeSalesOrderStatus, loadUnitItemMap, getUnitFactor } = require('../../../services/conversionStatus.service');
const {
  validateStockTransferSource,
  syncStockTransfer,
  reverseStockTransfer,
} = require('./deliveryChallanStockTransfer.service');
// Statuses where conversion is allowed
const DELIVERY_CHALLAN_CONVERSION_ALLOWED_STATUSES = [DELIVERY_CHALLAN_STATUS.SENT];

const assertNoActiveEWayBill = (challan, action) => {
  if (challan?.eWayBill?.status === E_WAY_BILL_STATUS.ACT.value) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      DELIVERY_CHALLAN_MESSAGES.HAS_ACTIVE_EWAY_BILL(challan.eWayBill.eWayBillNo, action),
    );
  }
};

// Replace the challan journal when crossing cancelled ↔ posted; skip when only status moves within posted.
const syncDeliveryChallanJournal = async (companyId, challan, userId, session, oldStatus = null) => {
  const isPostedChallanStatus = status => status !== DELIVERY_CHALLAN_STATUS.CANCELLED;
  const wasPosted = oldStatus != null && isPostedChallanStatus(oldStatus);
  const isPosted = isPostedChallanStatus(challan.status);

  // Draft → sent → delivered keeps the same journal; the goods left once and the cost has not changed.
  if (oldStatus != null && wasPosted && isPosted) {
    return;
  }

  // Clear any existing challan journal, then post again only if the goods are still issued.
  await ledgerService.deleteJournal(
    { companyId, sourceModule: LEDGER_SOURCE_MODULES.DELIVERY_CHALLAN, sourceId: challan._id },
    session,
  );
  if (isPosted) {
    await ledgerService.postDeliveryChallanJournal({ companyId, deliveryChallan: challan, addedBy: userId }, session);
  }
};

const createDeliveryChallan = async (challanBody, userId, uploadedFiles = []) => {
  const { SalesOrder, Customer, Branch } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();
  const { Company } = getCommonModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  // Start sessions for both connections
  const session = await connection.startSession();

  try {
    // Start transactions on both sessions
    await session.startTransaction();
    const { items, warehouseId, companyId, salesOrders } = challanBody;

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);

    await validateCustomerForModule({
      customerId: challanBody.customerId,
      branchId: challanBody.branchId,
      companyId,
      totalAmount: challanBody.total,
      addressId: challanBody.addressId,
      moduleName: MODULE_NAMES.DELIVERY_CHALLAN,
      session,
      models: { Customer, Branch, Invoice },
    });

    let commentHistory = [];
    //validate item qty of so to convert in dc
    if (salesOrders) {
      //get so item details exist in payload
      const salesOrderIds = salesOrders.map(order => new mongoose.Types.ObjectId(order.salesOrderId));
      const itemIds = items.map(item => new mongoose.Types.ObjectId(item.itemId));
      const salesOrdersData = await SalesOrder.aggregate([
        {
          $match: {
            _id: { $in: salesOrderIds },
            'items.itemId': { $in: itemIds },
          },
        },
        {
          $project: {
            orderId: 1,
            customerId: 1,
            orderDate: 1,
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

      if (salesOrdersData && salesOrdersData.length > 0) {
        for (const so of salesOrdersData) {
          commentHistory.push({
            message: `Delivery Challan created from Sales Order ${so.orderId || so._id}`,
            addedBy: userId,
            createdAt: new Date(),
            referenceType: 'SalesOrder',
            referenceId: so._id,
          });
        }
      }
      await isFullyConverted(challanBody.items || [], session);
    }

    // Handle file uploads
    let attachmentUrls = [];
    if (uploadedFiles && uploadedFiles.length > 0) {
      const uploadPromises = uploadedFiles.map(file => uploadFileToS3(file, userId, companyId));
      attachmentUrls = await Promise.all(uploadPromises);
    }

    // Merge uploaded file URLs with existing attachments (if any from JSONString)
    const allAttachments = [...attachmentUrls];

    //add default warehouse entry
    if (challanBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: challanBody.items,
          warehouseId: warehouseId,
          branchId: challanBody.branchId,
          divisionId: challanBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    // Get inventory configuration
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.DELIVERY_CHALLAN);

    // A stock transfer challan only moves stock (when sent), so it never deducts or checks stock like a regular one.
    if (challanBody.isStockTransfer) {
      challanBody.stockTransfer = await validateStockTransferSource({
        companyId,
        stockTransfer: challanBody.stockTransfer,
        warehouseId,
        customerId: challanBody.customerId,
        session,
      });
      inventoryConfig.stockCheckEnabled = false;
      inventoryConfig.stockDeductEnabled = false;
    } else {
      challanBody.isStockTransfer = false;
      challanBody.stockTransfer = null;
    }

    // Use provided items or sales order items
    let challanItems = items;

    if (challanItems.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No items provided for delivery challan');
    }

    // Source the item display snapshot from the Item master (never trust the client) and enforce
    // selectability. A conversion carries lines from a source document, so an item deactivated after
    // that document was created is tolerated; a standalone challan must reference active items.
    // The enriched lines flow through the rest of create (stock, batches, persistence).
    challanItems = await enrichDocumentItemLines(challanItems, {
      companyId,
      warehouseId,
      session,
      snapshotMode: SNAPSHOT_MODE.OVERWRITE,
    });
    if (salesOrders?.length > 0) {
      assertResolvable(challanItems);
    } else {
      assertSelectableForNewLines(challanItems, 'delivery challan');
    }
    await assertLineUnitsValid(challanItems, { companyId, session });
    // itemIssue is a transient classification used only for the assertions above — never persisted.
    challanItems.forEach(line => delete line.itemIssue);

    // Validate stock availability if stock check is enabled
    if (inventoryConfig?.stockCheckEnabled || inventoryConfig?.stockDeductEnabled) {
      await validateStockAvailability(
        { items: challanItems, companyId: challanBody.companyId, warehouseId: warehouseId },
        session,
      );
    }
    //check if delivery challan already created with salesOrderId
    //------------------------------------------------------------------------------------------
    // Generate unique ID using booksCrm session since it's a common operation
    challanBody.challanId = await generateUniqueId(
      DeliveryChallan,
      companyId,
      MODULE_NAMES.DELIVERY_CHALLAN,
      'challanId',
      'DC',
      session,
      challanBody.challanId,
    );

    let currency;
    let exchangeRate;
    let decimalPlaces;

    if (salesOrders?.length > 0) {
      const sourceSalesOrder = await SalesOrder.findById(salesOrders[0].salesOrderId)
        .select('currency exchangeRate decimalPlaces')
        .session(session);

      if (sourceSalesOrder?.currency) {
        currency = sourceSalesOrder.currency;
        exchangeRate = sourceSalesOrder.exchangeRate ?? 1;
        decimalPlaces = sourceSalesOrder.decimalPlaces ?? null;
      }
    }

    if (!currency) {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
        companyId,
        customerId: challanBody.customerId,
      }));
    }
    const currencyDoc = await getCurrency(companyId, currency);

    if (!salesOrders) {
      commentHistory.push({
        message: `Delivery Challan created for ${currencyDoc?.symbol || '₹'}${challanBody.total || 0}`,
        addedBy: userId,
        createdAt: new Date(),
        referenceType: 'DeliveryChallan',
        referenceId: null,
      });
    }

    challanBody.commentHistory = commentHistory;

    const bank = await getPrimaryBank(challanBody.companyId, session);

    // Create Delivery Challan
    const challanData = {
      ...challanBody,
      currency,
      exchangeRate: challanBody.exchangeRate ?? 1,
      decimalPlaces,
      attachments: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      bankAccountId: bank?.accountId,
      items: challanItems,
      addedBy: userId,
      updatedBy: userId,
      inventoryConfig,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };

    const challan = await DeliveryChallan.create([challanData], { session });

    if (salesOrders) {
      // Update SalesOrder
      for (let i of salesOrders) {
        // Find the SalesOrder document with session
        const salesOrderDoc = await SalesOrder.findById(i.salesOrderId).session(session);

        // Push new conversion info
        salesOrderDoc.convertedTo = salesOrderDoc.convertedTo || [];
        salesOrderDoc.convertedTo.push({
          type: 'DeliveryChallan',
          documentId: challan[0]._id,
          documentNo: challanBody.challanId || 'New DeliveryChallan',
          convertedAt: new Date(),
        });

        salesOrderDoc.commentHistory = salesOrderDoc.commentHistory || [];
        salesOrderDoc.commentHistory.push({
          message: `Sales Order converted to Delivery Challan ${challan[0].challanId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'DeliveryChallan',
          referenceId: challan[0]._id,
        });

        await salesOrderDoc.save({ session });
      }
    }

    if (inventoryConfig?.stockDeductEnabled) {
      if (challanItems.length > 0) {
        // Initialize batches array for each item
        for (let i of challanItems) {
          i.batches = [];
        }

        for (let i of challanItems) {
          // Calculate the final selling price after discount
          let finalSellingPrice = i.rate;
          if (i.discountConfig) {
            let discountAmount = 0;
            if (i.discountConfig.discountType === 'PERCENTAGE' && i.discountConfig.discountValue > 0) {
              discountAmount = (i.rate * i.discountConfig.discountValue) / 100;
            } else if (i.discountConfig.discountType === 'AMOUNT' && i.discountConfig.discountValue > 0) {
              // For AMOUNT type, divide by quantity to get per-unit discount
              discountAmount = i.discountConfig.discountValue / i.quantity;
            }
            finalSellingPrice = i.rate - discountAmount;
          }

          const warehouseStockObj = {
            action: 'deductStock',
            stockData: {
              itemId: i.itemId,
              companyId: challanBody?.companyId,
              branchId: challanBody?.branchId,
              warehouseId,
              quantity: i.quantity,
              itemUnitId: i.itemUnitId,
              deductedSourceType: MODULE_NAMES.DELIVERY_CHALLAN,
              deductedSourceId: challan[0]._id,
              sellingPrice: finalSellingPrice,
            },
            session,
          };

          const deductionSummary = await handleWarehouseStock(warehouseStockObj);

          // Add batch information to challan item
          i.batches.push(...deductionSummary);
        }

        await checkCompanyStockLevels({
          itemIds: challanItems.map(i => i.itemId),
          companyId: challanBody?.companyId,
          docType: MODULE_NAMES.DELIVERY_CHALLAN,
          docId: challan[0]._id,
          docNo: challan[0].challanId,
          userId,
          session,
        });

        // Update the challan with the batches
        challan[0].items = challanItems;
        await DeliveryChallan.updateOne({ _id: challan[0]._id }, { $set: { items: challanItems } }, { session });
      }
    }

    // A transfer challan created directly as Sent moves its stock now.
    if (challan[0].isStockTransfer && challan[0].status === DELIVERY_CHALLAN_STATUS.SENT) {
      await syncStockTransfer({ challan: challan[0], newStatus: challan[0].status, userId, session });
      await challan[0].save({ session });
    }

    await syncDeliveryChallanJournal(companyId, challan[0], userId, session);

    await flushCompanyStockLevels(session);
    await session.commitTransaction();

    sendTransactionNotification({
      customerId: challan[0].customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.DELIVERY_CHALLAN_CREATED,
      entityId: challan[0]._id,
      entityDisplayId: challan[0].challanId,
      triggeredByUserId: userId,
    });

    notifyModuleDocumentIfNonDraft({
      companyId,
      moduleName: MODULE_NAMES.DELIVERY_CHALLAN,
      document: challan[0],
      initialStatus: DELIVERY_CHALLAN_STATUS.DRAFT,
    });

    processIncentiveEarn(companyId, userId, 'DELIVERY_CHALLAN', challan[0]._id, challan[0].total, challan[0].items);
    return enrichDocumentCurrency(companyId, challan[0].toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryDeliveryChallans = async (filter, options) => {
  const { Customer, Branch, Division, Warehouse, PaymentTerm, ItemUnit } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();
  const { User, CompanySettings } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  // Remove the populate option since we'll handle it manually
  delete options.populate;

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'challanDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  // isActive filter - always include
  query.$and = [{ $or: [{ isActive: true }, { isActive: { $exists: false } }] }];

  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    const customers = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );
    const customerIds = customers.map(customer => customer._id);

    query.$or = [
      { reference: searchRegex },
      { challanId: searchRegex },
      { customerId: { $in: customerIds } },
      { challanType: searchRegex },
    ];
  }

  if (filter?.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  if (filter?.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) query.addedBy = { $in: addedByIds };
  }

  if (filter?.customerId) {
    const customerIds = filter.customerId
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));

    if (customerIds.length > 0) {
      query.customerId = { $in: customerIds };
    }
  }

  if (filter.eWayBillGenerated === true || filter.eWayBillGenerated === 'true') {
    query['eWayBill.status'] = E_WAY_BILL_STATUS.ACT.value;
  }

  // Country/State/City filters resolve through the address selected on the challan (addressId)
  const addressCondition = await getAddressFilterCondition(Customer, companyId, filter);
  if (addressCondition) {
    (query.$and ||= []).push(addressCondition);
  }

  if (options?.countOnly) {
    return { results: [], totalResults: await DeliveryChallan.countDocuments(query) };
  }

  // Get the paginated results without population
  const result = await DeliveryChallan.paginateWithTotal(query, options);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await DeliveryChallan.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  const challanIds = result.results.map(challan => challan._id);
  const invoiceQuery = {
    'deliveryChallanIds.deliveryChallanId': { $in: challanIds },
    status: { $ne: INVOICE_STATUS.CANCELLED },
    companyId: companyId,
  };

  if (filter?.isSplit === undefined) {
    invoiceQuery.isSplit = false;
  }

  const invoicesForChallans = await Invoice.find(invoiceQuery).select('deliveryChallanIds invoiceId status');

  const invoiceByChallan = invoicesForChallans.reduce((acc, invoice) => {
    (invoice.deliveryChallanIds || []).forEach(dc => {
      const key = dc.deliveryChallanId?.toString();
      if (key) (acc[key] ||= []).push(invoice);
    });
    return acc;
  }, {});

  // Get all unique customer IDs from the results
  const customerIds = [...new Set(result.results.map(challan => challan.customerId))];
  const branchIds = [...new Set(result.results.map(i => i.branchId))];
  const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
  const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  const paymentTermIds = [...new Set(result.results.map(i => i.paymentTermsId?.toString()).filter(Boolean))];

  // Fetch all customers in one query
  const customers = await Customer.find({
    _id: { $in: customerIds },
  })
    .select(
      'customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails useBranchPaymentTerms paymentTermsId branch isCustomerDirectTax',
    )
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  // Fall back to CompanySettings.salesCreditLimit's root/branch payment terms when the customer has none
  const companySettings = await CompanySettings.findOne({ companyId })
    .select('salesCreditLimit')
    .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
    .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
    .lean();
  const salesCreditLimit = companySettings?.salesCreditLimit;

  const branch = await Branch.find({
    _id: { $in: branchIds },
  })
    .select('name _id')
    .lean();

  const division = await Division.find({
    _id: { $in: divisionIds },
  })
    .select('name _id')
    .lean();

  const warehouse = await Warehouse.find({
    _id: { $in: warehouseIds },
  })
    .select('name _id')
    .lean();

  const users = await User.find({ _id: { $in: userIds } })
    .select('firstName lastName')
    .lean();

  const paymentTerms = await PaymentTerm.find({ _id: { $in: paymentTermIds } }).lean();

  // Create a map for quick customer lookup
  const customerMap = customers.reduce((acc, customer) => {
    acc[customer._id.toString()] = customer;
    return acc;
  }, {});

  const paymentTermMap = paymentTerms.reduce((acc, term) => {
    acc[term._id.toString()] = term;
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

  // Populate the results with customer data
  const populatedResults = result.results.map(challan => {
    const challanObj = challan.toObject();
    const baseCustomer = customerMap[challan.customerId?.toString()] || null;
    // Clone per challan since the same customer can be shared across challans with different branchIds
    const customerForChallan = baseCustomer
      ? { ...baseCustomer, branch: (baseCustomer.branch || []).map(b => ({ ...b })) }
      : null;
    applyCompanyPaymentTermsFallback(customerForChallan, salesCreditLimit, challanObj.branchId);
    challanObj.customerId = customerForChallan;
    challanObj.addressIn = findAddressById(customerForChallan?.address, challanObj.addressId);
    challanObj.id = challanObj._id;
    challanObj.paymentTermsId = paymentTermMap[challan.paymentTermsId?.toString()] || null;
    challanObj.branchId = branchMap[challanObj.branchId?.toString()] || null;
    challanObj.divisionId = divisionMap[challanObj.divisionId?.toString()] || null;
    challanObj.warehouseId = warehouseMap[challanObj.warehouseId?.toString()] || null;
    challanObj.addedBy = userMap[challanObj.addedBy?.toString()] || null;
    const updatedById = toUpdatedByUserIdString(challanObj.updatedBy);
    challanObj.updatedBy = updatedById ? (userMap[updatedById] ?? null) : null;
    challanObj.invoices = invoiceByChallan[challanObj._id?.toString()] || [];
    return challanObj;
  });

  const populatedResultsWithCurrency = await enrichDocumentCurrency(companyId, await attachItemSummaries(populatedResults));

  //add data of convertedTo
  const updatedResults = [];

  for (let i of populatedResultsWithCurrency) {
    const tempData = i; // convert mongoose doc to plain object
    const arr = [];

    if (i?.convertedTo && i?.convertedTo?.length > 0) {
      for (let j of i.convertedTo) {
        if (j.type == 'Invoice') {
          const invoiceData = await Invoice.findById(j.documentId)
            .select('total invoiceDate dueDate status balanceAmount')
            .lean();

          arr.push({ ...(j.toObject?.() ?? j), ...invoiceData });
        }
      }
    }

    // Replace or add convertedTo with enriched array
    tempData.convertedTo = [...arr];

    updatedResults.push(tempData);
  }

  return {
    ...result,
    results: updatedResults,
  };
};

const queryDeliveryChallansExports = async (filter, options) => {
  const result = await queryDeliveryChallans(filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const getDeliveryChallanById = async (id, companyId) => {
  const { Customer, SalesOrder, Branch, Division, Warehouse, PaymentTerm, ItemUnit } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();
  const { User, CompanySettings } = getCommonModels();
  // Get the delivery challan (only the line unit is populated; ItemUnit lives in booksCrm, so pass the model explicitly)
  const challan = await DeliveryChallan.findOne({ _id: id, companyId }).populate({
    path: 'items.itemUnitId',
    select: 'name',
    model: ItemUnit,
  });
  if (!challan) {
    throw new ApiError(httpStatus.NOT_FOUND, DELIVERY_CHALLAN_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  let so = [];
  if (challan?.salesOrders?.length > 0) {
    for (let i of challan.salesOrders) {
      const data = await SalesOrder.findById(i.salesOrderId).select('status total orderDate orderId').lean();
      so.push({ ...data, salesOrderId: i.salesOrderId, salesOrderNo: i.salesOrderNo });
    }
  }

  // Get customer data
  const customer = await Customer.findById(challan.customerId)
    .select(
      'customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails useBranchPaymentTerms paymentTermsId branch isCustomerDirectTax',
    )
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  // Fall back to CompanySettings.salesCreditLimit's root/branch payment terms when the customer has none
  const companySettings = await CompanySettings.findOne({ companyId })
    .select('salesCreditLimit')
    .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
    .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
    .lean();
  applyCompanyPaymentTermsFallback(customer, companySettings?.salesCreditLimit, challan.branchId);

  const invoicearray = [];
  if (challan.convertedTo && challan.convertedTo.length > 0) {
    for (let j of challan.convertedTo)
      if (j.type === 'Invoice') {
        const invoiceData = await Invoice.findById(j.documentId)
          .select('total invoiceDate status paidAmount balanceAmount dueDate')
          .lean();

        const jObject = j.toObject?.() ?? j;
        const merged = { ...jObject, ...invoiceData };
        invoicearray.push(merged);
      }
  }
  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (challan.commentHistory?.length) {
    const userIds = challan.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = challan.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  let shippingAddress = null;
  if (challan.addressId) {
    if (challan?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
      shippingAddress = customer.address.shipping;
    }

    if (!shippingAddress) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        addr => addr._id.toString() === challan.addressId.toString(),
      );
    }
  }

  const addedBy = await User.findById(challan.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(challan.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findById(challan.branchId).select('name');
  const division = await Division.findById(challan.divisionId).select('name');
  const warehouse = await Warehouse.findById(challan.warehouseId).select('name');
  const primaryBankDetails = await getPrimaryBankDetails(challan?.bankAccountId);

  // Convert challan to object and populate the data
  const challanObj = challan.toObject();
  challanObj.addedBy = addedBy;
  challanObj.updatedBy = updatedBy;

  // Populate customer data
  challanObj.customerId = customer || null;
  challanObj.salesOrders = so;
  challanObj.branchName = branch?.name || null;
  challanObj.divisionName = division?.name || null;
  challanObj.warehouseName = warehouse?.name || null;
  if (challan.isStockTransfer && challan.stockTransfer) {
    const { fromDivisionId, fromBranchId, fromWarehouseId } = challan.stockTransfer;
    const [fromDivision, fromBranch, fromWarehouse] = await Promise.all([
      Division.findOne({ _id: fromDivisionId, companyId }).select('name').lean(),
      Branch.findOne({ _id: fromBranchId, companyId }).select('name').lean(),
      Warehouse.findOne({ _id: fromWarehouseId, companyId }).select('name').lean(),
    ]);
    challanObj.stockTransfer = {
      ...challanObj.stockTransfer,
      fromDivisionName: fromDivision?.name || null,
      fromBranchName: fromBranch?.name || null,
      fromWarehouseName: fromWarehouse?.name || null,
    };
  }
  challanObj.bankAccountId = primaryBankDetails || {};
  challanObj.shippingAddress = shippingAddress || {};
  challanObj.commentHistory = commentHistoryWithUser;
  challanObj.convertedTo = invoicearray || [];
  challanObj.moduleTree = await buildModuleTree(id);
  const paymentTerm = challan.paymentTermsId ? await PaymentTerm.findById(challan.paymentTermsId).lean() : null;
  challanObj.paymentTermsId = paymentTerm || null;

  // Repair any blank snapshot from the Item master (never overwrite a stored value) and attach a
  // fresh per-line `itemIssue` (inactive / not-in-warehouse / missing) for the UI to warn on.
  challanObj.items = await enrichDocumentItemLines(challanObj.items, {
    companyId,
    warehouseId: challanObj.warehouseId,
    snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
  });

  return enrichDocumentCurrency(companyId, challanObj);
};

const updateDeliveryChallanById = async (challanId, updateBody, userId, uploadedFiles = []) => {
  const { SalesOrder, Customer, Branch } = getBooksCrmModels();
  const { DeliveryChallan } = getBooksModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const { items: newItems, warehouseId, salesOrders, companyId, ...otherUpdateBody } = updateBody;

    const challan = await DeliveryChallan.findOne({ _id: challanId, companyId }).session(session);
    if (!challan) {
      throw new ApiError(httpStatus.NOT_FOUND, DELIVERY_CHALLAN_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    // Validate edit permissions
    validateEditPermissions(DELIVERY_CHALLAN_STATUS_CONFIG.EDIT_RESTRICTED_STATUSES, challan.status);

    // Merge uploaded file URLs with existing attachments

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);

    // Handle file uploads
    const oldTotal = challan.total || 0;
    const newTotal = updateBody.total || 0;

    await validateCustomerForModule({
      customerId: updateBody?.customerId,
      branchId: updateBody?.branchId,
      companyId,
      totalAmount: updateBody?.total,
      previousTotal: oldTotal,
      addressId: updateBody?.addressId,
      moduleName: MODULE_NAMES.DELIVERY_CHALLAN,
      session,
      models: { Customer, Branch },
      isUpdate: true,
      skipOverdueCheck: true,
    });

    const uploadedUrls = await handleFileUpdate({
      newFiles: uploadedFiles,
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: challan.attachments ? challan.attachments : [],
      userId,
      companyId: companyId,
    });

    otherUpdateBody.attachments = uploadedUrls;

    // Get latest inventory configuration

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

    const latestInventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.DELIVERY_CHALLAN);

    // Switching would leave a regular challan's deducted stock or a transfer's source half applied, so it is fixed at creation.
    if (
      otherUpdateBody.isStockTransfer !== undefined &&
      Boolean(otherUpdateBody.isStockTransfer) !== Boolean(challan.isStockTransfer)
    ) {
      throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.STOCK_TRANSFER_TOGGLE_LOCKED);
    }
    if (challan.isStockTransfer) {
      const stockTransfer = await validateStockTransferSource({
        companyId,
        stockTransfer: otherUpdateBody.stockTransfer || challan.stockTransfer,
        warehouseId: challan.warehouseId,
        customerId: otherUpdateBody.customerId || challan.customerId,
        session,
      });
      if (otherUpdateBody.stockTransfer) otherUpdateBody.stockTransfer = stockTransfer;
      latestInventoryConfig.stockCheckEnabled = false;
      latestInventoryConfig.stockDeductEnabled = false;
    } else {
      delete otherUpdateBody.stockTransfer;
    }

    // If items are being updated
    if (newItems && newItems.length > 0) {
      // Enrich lines from the Item master before merging. Lines already on the challan keep their
      // stored snapshot (blanks filled only); newly added lines get an authoritative snapshot and
      // must reference a currently-active item. An item deactivated after the challan existed is
      // tolerated on a carried line — it just cannot be added fresh. Sequential (not Promise.all)
      // so the two reads don't run concurrently on the same transaction session.
      const existingItemIds = new Set(challan.items.map(item => item.itemId?.toString()));
      const carriedLines = newItems.filter(item => item.itemId && existingItemIds.has(item.itemId.toString()));
      const freshLines = newItems.filter(item => !item.itemId || !existingItemIds.has(item.itemId.toString()));
      const enrichedCarried = await enrichDocumentItemLines(carriedLines, {
        companyId,
        warehouseId,
        session,
        snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
      });
      const enrichedFresh = await enrichDocumentItemLines(freshLines, {
        companyId,
        warehouseId,
        session,
        snapshotMode: SNAPSHOT_MODE.OVERWRITE,
      });
      assertResolvable([...enrichedCarried, ...enrichedFresh]);
      assertSelectableForNewLines(enrichedFresh, 'delivery challan');
      // Put the enriched lines back at their submitted position — the same item can sit on several lines
      // (different price/unit), so they cannot be keyed by itemId.
      const enrichedQueue = { carried: [...enrichedCarried], fresh: [...enrichedFresh] };
      const enrichedNewItems = newItems.map(line => {
        const isCarried = line.itemId && existingItemIds.has(line.itemId.toString());
        const enriched = (isCarried ? enrichedQueue.carried : enrichedQueue.fresh).shift();
        delete enriched.itemIssue; // transient — never persisted
        return enriched;
      });

      // Create maps for easy lookup
      const oldItemsMap = new Map(challan.items.map(item => [item.itemId.toString(), item.quantity]));

      // Validate stock for new and modified items if stock check is enabled
      if (latestInventoryConfig?.stockCheckEnabled || latestInventoryConfig?.stockDeductEnabled) {
        // The validator compares per-item totals in the main unit, so only increases can fail.
        await validateStockAvailability(
          { items: newItems, oldItems: challan.items, oldItemsMap, companyId: companyId, warehouseId: warehouseId },
          session,
        );
      }

      if (latestInventoryConfig?.stockDeductEnabled) {
        //warehouse stock deduct for all items
        for (const item of challan.items) {
          await handleWarehouseStock({
            action: 'reverseDeduction',
            stockData: {
              itemId: item.itemId,
              companyId: challan.companyId,
              branchId: challan.branchId,
              warehouseId: challan.warehouseId,
              deductedSourceType: MODULE_NAMES.DELIVERY_CHALLAN,
              deductedSourceId: challanId,
            },
            session,
          });

          item.batches = [];
        }

        await checkCompanyStockLevels({
          itemIds: challan.items.map(item => item.itemId),
          companyId: challan.companyId,
          docType: MODULE_NAMES.DELIVERY_CHALLAN,
          docId: challanId,
          docNo: challan.challanId,
          userId,
          session,
        });
      }

      // Pair each line with the existing line of the same item + unit + price, so lines of one item stay separate.
      const { matches: lineMatches } = pairLinesWithExisting(enrichedNewItems, challan.items);
      const updatedItems = [];
      for (const [index, newItem] of enrichedNewItems.entries()) {
        const existingItem = lineMatches[index];

        if (existingItem) {
          Object.assign(existingItem, {
            ...newItem,
            batches: existingItem.batches || [],
          });

          updatedItems.push(existingItem);
        } else {
          // ADD new item
          updatedItems.push({
            ...newItem,
            batches: [],
          });
        }
      }

      challan.items = updatedItems;
      // Process inventory updates if stock reservation is enabled
      if (latestInventoryConfig?.stockDeductEnabled) {
        for (const item of challan.items) {
          let finalSellingPrice = item.rate;

          if (item.discountConfig) {
            let discountAmount = 0;

            if (item.discountConfig.discountType === 'PERCENTAGE') {
              discountAmount = (item.rate * item.discountConfig.discountValue) / 100;
            } else if (item.discountConfig.discountType === 'AMOUNT') {
              discountAmount = item.discountConfig.discountValue / item.quantity;
            }

            finalSellingPrice = item.rate - discountAmount;
          }

          const deductionSummary = await handleWarehouseStock({
            action: 'deductStock',
            stockData: {
              itemId: item.itemId,
              companyId: challan.companyId,
              branchId: challan.branchId,
              warehouseId: challan.warehouseId,
              quantity: item.quantity,
              itemUnitId: item.itemUnitId,
              deductedSourceType: MODULE_NAMES.DELIVERY_CHALLAN,
              deductedSourceId: challanId,
              sellingPrice: finalSellingPrice,
            },
            session,
          });

          item.batches = deductionSummary;
        }

        await checkCompanyStockLevels({
          itemIds: challan.items.map(item => item.itemId),
          companyId: challan.companyId,
          docType: MODULE_NAMES.DELIVERY_CHALLAN,
          docId: challanId,
          docNo: challan.challanId,
          userId,
          session,
        });

        challan.markModified('items');
      }
    }

    if (updateBody.customerId && String(updateBody.customerId) !== String(challan.customerId)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: challan.companyId,
        customerId: updateBody.customerId,
      });
      updateBody.currency = currency;
      updateBody.decimalPlaces = decimalPlaces;
    }
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;
    const currencyDoc = await getCurrency(challan.companyId, updateBody.currency || challan.currency);
    const currencySymbol = currencyDoc?.symbol || company?.baseCurrency?.symbol || '₹';

    let updateMsg = 'DeliveryChallan updated.';
    if (oldTotal !== newTotal) {
      updateMsg = `DeliveryChallan updated. Amount changed from ${currencySymbol}${oldTotal} to ${currencySymbol}${newTotal}`;
    }

    challan.markModified('items');

    // Update the delivery challan
    Object.assign(challan, {
      ...otherUpdateBody,
      currency: updateBody.currency ?? challan.currency,
      exchangeRate: updateBody.exchangeRate ?? 1,
      decimalPlaces: updateBody.decimalPlaces ?? challan.decimalPlaces,
      authorizedSignature: company?.authorizedSignature,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    // Note: challan.items is already updated with batch information in the batch processing logic above
    // Do not overwrite it here as it would lose the batch updates
    challan.updatedBy = userId;

    challan.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
    });

    await challan.save({ session });

    await syncDeliveryChallanJournal(companyId, challan, userId, session);

    if (challan?.salesOrders?.length > 0) {
      const salesOrderIds = [...new Set(challan.salesOrders.map(so => so.salesOrderId?.toString()).filter(Boolean))];
      for (const salesOrderId of salesOrderIds) {
        await recomputeSalesOrderStatus(salesOrderId, session);
      }
    }

    await flushCompanyStockLevels(session);
    await session.commitTransaction();

    processIncentiveEarn(companyId, userId, 'DELIVERY_CHALLAN', challan._id, challan.total, challan.items);

    sendTransactionNotification({
      customerId: challan.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.DELIVERY_CHALLAN_UPDATED,
      entityId: challan._id,
      entityDisplayId: challan.challanId,
      triggeredByUserId: userId,
    });

    return enrichDocumentCurrency(challan.companyId, challan.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updateDeliveryChallanStatus = async (challanId, companyId, newStatus, userId) => {
  const { SalesOrder } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const challan = await DeliveryChallan.findOne({ _id: challanId, companyId }).session(session);

    if (!challan) {
      throw new ApiError(httpStatus.NOT_FOUND, DELIVERY_CHALLAN_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    const oldStatus = challan.status;
    const challanNo = challan?.challanId;

    // Validate status transition (the cancel action is handled specially below)
    if (newStatus !== DELIVERY_CHALLAN_STATUS.CANCELLED) {
      validateStatusTransition(DELIVERY_CHALLAN_STATUS_CONFIG.STATUS_TRANSITIONS, challan.status, newStatus);
    }

    if (newStatus === DELIVERY_CHALLAN_STATUS.CANCELLED) assertNoActiveEWayBill(challan, 'cancelling');
    if (newStatus === DELIVERY_CHALLAN_STATUS.DRAFT) assertNoActiveEWayBill(challan, 'moving back to Draft');

    const isUncancel = oldStatus === DELIVERY_CHALLAN_STATUS.CANCELLED && newStatus !== DELIVERY_CHALLAN_STATUS.CANCELLED;
    if (isUncancel) {
      assertRevertAllowed({ isUncancel, hasEffect: hasStockEffect(challan?.inventoryConfig) });
    }

    // Fetch latest inventory config if needed

    if (newStatus == DELIVERY_CHALLAN_STATUS.CANCELLED && challan.status != DELIVERY_CHALLAN_STATUS.CANCELLED) {
      const invoices = await Invoice.find({
        $or: [{ deliveryChallanId: challanId }, { 'deliveryChallanIds.deliveryChallanId': challanId }],
        status: { $ne: INVOICE_STATUS.CANCELLED },
      }).session(session);

      if (invoices.length > 0) {
        const orderIds = invoices.map(inv => inv.invoiceId).join(', ');

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel DeliveryChallan because an Invoice has been created from it:${orderIds}`,
        );
      }

      if (challan?.inventoryConfig?.stockDeductEnabled) {
        //deduct warehouseBatch stock
        for (const i of challan?.items) {
          const warehouseStockObj = {
            action: 'reverseDeduction',
            stockData: {
              itemId: i.itemId,
              companyId: challan.companyId,
              branchId: challan.branchId,
              warehouseId: challan.warehouseId,
              deductedSourceType: MODULE_NAMES.DELIVERY_CHALLAN,
              deductedSourceId: challan._id,
            },
            session,
          };
          await handleWarehouseStock(warehouseStockObj);
        }

        await checkCompanyStockLevels({
          itemIds: challan.items.map(i => i.itemId),
          companyId: challan.companyId,
          docType: MODULE_NAMES.DELIVERY_CHALLAN,
          docId: challan._id,
          docNo: challan.challanId,
          userId,
          session,
        });

        challan.items.forEach(item => {
          item.batches = [];
        });

        challan.markModified('items');
      }

      if (challan?.salesOrders?.length > 0) {
        await calculateRemainingQty(challan?.items, challanId, challan.challanNo, userId, session);
      }
    }

    await syncStockTransfer({ challan, newStatus, userId, session });

    // Update status
    challan.status = newStatus;
    challan.updatedBy = userId;
    challan.commentHistory.push({
      message: ` Delivery Challan status changed from ${oldStatus} to ${newStatus}`,
      addedBy: userId,
      createdAt: new Date(),
    });

    await challan.save({ session });

    if (challan?.salesOrders?.length > 0) {
      const salesOrderIds = [...new Set(challan.salesOrders.map(so => so.salesOrderId?.toString()).filter(Boolean))];
      for (const salesOrderId of salesOrderIds) {
        const soNewStatus = await recomputeSalesOrderStatus(salesOrderId, session);
        if (newStatus === DELIVERY_CHALLAN_STATUS.CANCELLED) {
          const soForNotif = await SalesOrder.findOne(
            { _id: new mongoose.Types.ObjectId(salesOrderId) },
            { _id: 1, customerId: 1, companyId: 1, orderId: 1 },
          )
            .lean()
            .session(session);
          if (soForNotif?.customerId) {
            sendTransactionNotification({
              customerId: soForNotif.customerId,
              companyId: soForNotif.companyId,
              notificationType: NOTIFICATION_TYPE.SALES_ORDER_STATUS_CHANGED,
              entityId: soForNotif._id,
              entityDisplayId: soForNotif.orderId,
              triggeredByUserId: userId,
              newStatus: soNewStatus,
            });
          }
        }
      }
    }

    await syncDeliveryChallanJournal(companyId, challan, userId, session, oldStatus);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    if (newStatus === DELIVERY_CHALLAN_STATUS.CANCELLED) {
      cancelIncentiveLog(challan._id);
    }

    sendTransactionNotification({
      customerId: challan.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.DELIVERY_CHALLAN_STATUS_CHANGED,
      entityId: challan._id,
      entityDisplayId: challan.challanId,
      triggeredByUserId: userId,
      newStatus,
    });

    if (isFirstStatusChange(oldStatus, newStatus, DELIVERY_CHALLAN_STATUS.DRAFT)) {
      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.DELIVERY_CHALLAN,
        document: challan,
      }).catch(err =>
        logger.error(`Failed to send delivery challan customer notifications for ${challan.challanId}: ${err.message}`),
      );
    }

    return challan;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteDeliveryChallanById = async (challanId, companyId, userId) => {
  const { SalesOrder } = getBooksCrmModels();
  const { Invoice, DeliveryChallan } = getBooksModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const deliveryChallan = await DeliveryChallan.findOne({ _id: challanId, companyId }).session(session);
    const challanNo = deliveryChallan?.challanId;

    if (!deliveryChallan) {
      throw new ApiError(httpStatus.NOT_FOUND, DELIVERY_CHALLAN_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    assertNoActiveEWayBill(deliveryChallan, 'deleting');

    const invoices = await Invoice.find({
      $or: [{ deliveryChallanId: challanId }, { 'deliveryChallanIds.deliveryChallanId': challanId }],
    })
      .select('invoiceId')
      .session(session);
    if (invoices.length > 0) {
      const orderIds = invoices.map(inv => inv.invoiceId).join(', ');

      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete DeliveryChallan because an Invoice has been created from it:${orderIds}`,
      );
    }

    if (deliveryChallan.isStockTransfer && deliveryChallan.stockTransfer?.transferredAt) {
      await reverseStockTransfer({ challan: deliveryChallan, session });
    }

    if (deliveryChallan?.inventoryConfig?.stockDeductEnabled && deliveryChallan.status != DELIVERY_CHALLAN_STATUS.CANCELLED) {
      //deduct warehouseBatch stock
      for (const i of deliveryChallan?.items) {
        const warehouseStockObj = {
          action: 'reverseDeduction',
          stockData: {
            itemId: i.itemId,
            companyId: deliveryChallan.companyId,
            branchId: deliveryChallan.branchId,
            warehouseId: deliveryChallan.warehouseId,
            deductedSourceType: MODULE_NAMES.DELIVERY_CHALLAN,
            deductedSourceId: deliveryChallan._id,
          },
          session,
        };

        await handleWarehouseStock(warehouseStockObj);
      }

      await checkCompanyStockLevels({
        itemIds: deliveryChallan.items.map(i => i.itemId),
        companyId: deliveryChallan.companyId,
        docType: MODULE_NAMES.DELIVERY_CHALLAN,
        docId: deliveryChallan._id,
        docNo: deliveryChallan.challanId,
        userId,
        session,
      });
    }

    if (deliveryChallan?.salesOrders?.length > 0) {
      const salesOrderIds = [...new Set(deliveryChallan.salesOrders.map(so => so.salesOrderId?.toString()).filter(Boolean))];

      for (const salesOrderId of salesOrderIds) {
        const existingComment = await SalesOrder.findOne({
          _id: new mongoose.Types.ObjectId(salesOrderId),
          'commentHistory.referenceId': new mongoose.Types.ObjectId(challanId),
        }).session(session);

        const baseUpdate = {
          $pull: {
            convertedTo: {
              documentId: new mongoose.Types.ObjectId(challanId),
            },
          },
          $set: {
            updatedBy: userId,
          },
        };

        if (existingComment) {
          await SalesOrder.updateOne(
            { _id: new mongoose.Types.ObjectId(salesOrderId) },
            {
              ...baseUpdate,
              $set: {
                ...baseUpdate.$set,
                'commentHistory.$[target].isDeleted': true,
              },
            },
            {
              arrayFilters: [{ 'target.referenceId': challanId }],
              session,
            },
          );
        } else {
          await SalesOrder.updateOne({ _id: new mongoose.Types.ObjectId(salesOrderId) }, baseUpdate, { session });
        }

        await SalesOrder.updateOne(
          { _id: new mongoose.Types.ObjectId(salesOrderId) },
          {
            $push: {
              commentHistory: {
                message: `DeliveryChallan No ${challanNo} deleted successfully`,
                addedBy: userId,
                createdAt: new Date(),
              },
            },
          },
          { session },
        );
      }
    }

    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.DELIVERY_CHALLAN, sourceId: deliveryChallan._id },
      session,
    );

    await DeliveryChallan.findByIdAndDelete(challanId, { session });

    if (deliveryChallan?.salesOrders?.length > 0) {
      const salesOrderIds = [...new Set(deliveryChallan.salesOrders.map(so => so.salesOrderId?.toString()).filter(Boolean))];
      for (const salesOrderId of salesOrderIds) {
        const newStatus = await recomputeSalesOrderStatus(salesOrderId, session);
        const soForNotif = await SalesOrder.findOne(
          { _id: new mongoose.Types.ObjectId(salesOrderId) },
          { _id: 1, customerId: 1, companyId: 1, orderId: 1 },
        )
          .lean()
          .session(session);
        if (soForNotif) {
          sendTransactionNotification({
            customerId: soForNotif.customerId,
            companyId: soForNotif.companyId,
            notificationType: NOTIFICATION_TYPE.SALES_ORDER_STATUS_CHANGED,
            entityId: soForNotif._id,
            entityDisplayId: soForNotif.orderId,
            triggeredByUserId: userId,
            newStatus,
          });
        }
      }
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    cancelIncentiveLog(deliveryChallan._id);

    sendTransactionNotification({
      customerId: deliveryChallan.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.DELIVERY_CHALLAN_DELETED,
      entityId: deliveryChallan._id,
      entityDisplayId: deliveryChallan.challanId,
      triggeredByUserId: userId,
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const isFullyConverted = async (items, session) => {
  const { SalesOrder } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  const salesOrders = [
    ...new Map(
      items
        .filter(item => item.referenceId && item.referenceType)
        .map(item => [
          `${item.referenceType}:${item.referenceId}`,
          { referenceType: item.referenceType, salesOrderId: item.referenceId },
        ]),
    ).values(),
  ];

  if (salesOrders.length > 0) {
    for (const po of salesOrders) {
      const salesOrderDoc = await SalesOrder.findOne({
        _id: po.salesOrderId,
      }).lean();

      if (!salesOrderDoc) continue;

      // Every quantity below is compared in the item's main unit: the order line and the documents converted
      // from it can each be in a different unit.
      const unitItemMap = await loadUnitItemMap(
        [...salesOrderDoc.items.map(item => item.itemId), ...items.map(item => item.itemId)],
        session,
      );
      const toMainUnit = (itemId, itemUnitId, quantity) => (quantity || 0) * getUnitFactor(unitItemMap, itemId, itemUnitId);

      const allItems = salesOrderDoc.items.map(item => ({
        salesOrderId: po.salesOrderId,
        itemId: item.itemId,
        quantity: toMainUnit(item.itemId, item.itemUnitId, item.quantity),
      }));

      const deliveryChallanItems = await DeliveryChallan.aggregate([
        {
          $match: {
            'salesOrders.salesOrderId': new mongoose.Types.ObjectId(po.salesOrderId),
            'items.referenceId': new mongoose.Types.ObjectId(po.salesOrderId),
            status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
          },
        },
        {
          $project: {
            matchingItems: {
              $filter: {
                input: '$items',
                as: 'item',
                cond: {
                  $eq: ['$$item.referenceId', new mongoose.Types.ObjectId(po.salesOrderId)],
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
            itemUnitId: '$matchingItems.itemUnitId',
          },
        },
        {
          $group: {
            _id: {
              itemId: '$itemId',
              referenceId: '$referenceId',
              itemUnitId: '$itemUnitId',
            },
            quantity: { $sum: '$quantity' },
          },
        },
        {
          $project: {
            itemId: '$_id.itemId',
            referenceId: '$_id.referenceId',
            itemUnitId: '$_id.itemUnitId',
            quantity: 1,
            _id: 0,
          },
        },
      ]);

      const invoiceItems = await Invoice.aggregate([
        {
          $match: {
            'salesOrders.salesOrderId': new mongoose.Types.ObjectId(po.salesOrderId),
            'items.referenceId': new mongoose.Types.ObjectId(po.salesOrderId),
            status: { $ne: INVOICE_STATUS.CANCELLED },
          },
        },
        {
          $project: {
            matchingItems: {
              $filter: {
                input: '$items',
                as: 'item',
                cond: {
                  $eq: ['$$item.referenceId', new mongoose.Types.ObjectId(po.salesOrderId)],
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
            itemUnitId: '$matchingItems.itemUnitId',
          },
        },
        {
          $group: {
            _id: {
              itemId: '$itemId',
              referenceId: '$referenceId',
              itemUnitId: '$itemUnitId',
            },
            quantity: { $sum: '$quantity' },
          },
        },
        {
          $project: {
            itemId: '$_id.itemId',
            referenceId: '$_id.referenceId',
            itemUnitId: '$_id.itemUnitId',
            quantity: 1,
            _id: 0,
          },
        },
      ]);

      const result = allItems.map(item => {
        // One aggregated row per unit the item was converted in; add them up in the main unit.
        const sumConverted = rows =>
          rows
            .filter(
              g => g.itemId.toString() === item.itemId.toString() && g.referenceId.toString() === item.salesOrderId.toString(),
            )
            .reduce((sum, g) => sum + toMainUnit(g.itemId, g.itemUnitId, g.quantity), 0);

        const deliveredQty = sumConverted(deliveryChallanItems) + sumConverted(invoiceItems);

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
            item.referenceId.toString() === grpoItem.salesOrderId.toString(),
        );

        const consumedQty = matchedItem ? toMainUnit(matchedItem.itemId, matchedItem.itemUnitId, matchedItem.quantity) : 0;

        return {
          ...grpoItem,
          remainingQuantity: grpoItem.remainingQuantity - consumedQty,
        };
      });

      const allRemainingZero = finalResult.every(item => item.remainingQuantity <= 0);

      const statusToUpdate = allRemainingZero ? SALES_ORDER_STATUS.COMPLETED : SALES_ORDER_STATUS.PARTIALLY_RECORDED;

      await SalesOrder.updateOne(
        { _id: new mongoose.Types.ObjectId(po.salesOrderId) },
        { $set: { status: statusToUpdate } },
      ).session(session);

      if (salesOrderDoc.customerId) {
        sendTransactionNotification({
          customerId: salesOrderDoc.customerId,
          companyId: salesOrderDoc.companyId,
          notificationType: NOTIFICATION_TYPE.SALES_ORDER_STATUS_CHANGED,
          entityId: salesOrderDoc._id,
          entityDisplayId: salesOrderDoc.orderId,
          newStatus: statusToUpdate,
        });
      }
    }
  }
};

const calculateRemainingQty = async (items, challanId, challanNo, userId, session) => {
  const { SalesOrder } = getBooksCrmModels();

  const salesOrders = [
    ...new Map(
      items
        .filter(item => item.referenceId && item.referenceType)
        .map(item => [
          `${item.referenceType}:${item.referenceId}`,
          { referenceType: item.referenceType, salesOrderId: item.referenceId },
        ]),
    ).values(),
  ];

  if (salesOrders.length > 0) {
    for (const po of salesOrders) {
      await SalesOrder.updateOne(
        { _id: new mongoose.Types.ObjectId(po.salesOrderId) },
        {
          $push: {
            commentHistory: {
              message: `DeliveryChallan No ${challanNo} cancelled successfully`,
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

const deliveryChallanfromSalesOrder = async query => {
  const { DeliveryChallan } = getBooksModels();
  const { SalesOrder, Division, Branch, Warehouse } = getBooksCrmModels();
  const { customerId, companyId } = query;
  const salesOrders = await SalesOrder.find({
    customerId: customerId,
    companyId: companyId,
    status: { $in: [SALES_ORDER_STATUS.COMPLETED] },
    invoiceStatus: { $nin: [INVOICE_STATUS.SENT, INVOICE_STATUS.PAID] },
  }).lean();

  const completedSOIds = salesOrders.map(so => so._id);

  const challans = await DeliveryChallan.find({
    customerId,
    companyId,
    salesOrders: {
      $elemMatch: {
        salesOrderId: { $in: completedSOIds },
      },
    },
    status: DELIVERY_CHALLAN_STATUS.SENT,
  }).lean();

  const divisionIds = getUniqueIds(challans, 'divisionId');
  const branchIds = getUniqueIds(challans, 'branchId');
  const warehouseIds = getUniqueIds(challans, 'warehouseId');
  const [divisionMap, branchMap, warehouseMap] = await Promise.all([
    getNameMap(Division, divisionIds),
    getNameMap(Branch, branchIds),
    getNameMap(Warehouse, warehouseIds),
  ]);

  challans.forEach(challan => {
    challan.divisionName = divisionMap.get(challan.divisionId?.toString()) || null;
    challan.branchName = branchMap.get(challan.branchId?.toString()) || null;
    challan.warehouseName = warehouseMap.get(challan.warehouseId?.toString()) || null;
  });
  return challans;
};

const deliveryChallanItems = async (challanIds, companyId) => {
  const { DeliveryChallan } = getBooksModels();

  const idArray = challanIds
    .split(',')
    .filter(Boolean)
    .map(id => new mongoose.Types.ObjectId(id));

  const challanItems = await DeliveryChallan.aggregate([
    {
      $match: {
        _id: { $in: idArray },
        companyId: new mongoose.Types.ObjectId(companyId),
      },
    },
    { $unwind: '$items' },
    {
      $project: {
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
        challanId: '$_id',
        referenceId: '$items.referenceId',
        referenceType: '$items.referenceType',
        referenceNo: '$challanId',
      },
    },
  ]);

  return challanItems;
};

const buildModuleTree = async deliveryChallanId => {
  const { SalesOrder, PaymentReceived, Quote } = getBooksCrmModels();
  const { DeliveryChallan, Invoice, ProductionOrder } = getBooksModels();

  const moduleTree = { quotes: [] };

  /* ================= DC ================= */

  const dc = await DeliveryChallan.findById(deliveryChallanId).select('_id challanId challanDate status total salesOrders');

  if (!dc) return moduleTree;

  const dcNode = {
    id: dc._id,
    challanId: dc.challanId,
    challanDate: dc.challanDate,
    status: dc.status,
    total: dc.total,
    invoices: [],
  };

  /* ================= INVOICE ================= */

  const invoices = await Invoice.find({
    'deliveryChallanIds.deliveryChallanId': dc._id,
    isSplit: { $ne: true },
  }).select('_id invoiceId invoiceDate status total');

  for (const inv of invoices) {
    const payments = await PaymentReceived.find({
      'invoices.invoiceId': inv._id,
    }).select('_id paymentReceivedId paymentDate status amountReceived');

    dcNode.invoices.push({
      id: inv._id,
      invoiceId: inv.invoiceId,
      invoiceDate: inv.invoiceDate,
      status: inv.status,
      total: inv.total,
      payments,
    });
  }

  /* ================= SALES ORDERS ================= */

  const soIds = dc.salesOrders?.map(s => s.salesOrderId) || [];

  const salesOrders = await SalesOrder.find({
    _id: { $in: soIds },
  }).select('_id orderId orderDate status total quoteId');

  const quoteMap = new Map();

  for (const so of salesOrders) {
    const soNode = {
      id: so._id,
      orderId: so.orderId,
      orderDate: so.orderDate,
      status: so.status,
      total: so.total,
      deliveryChallans: [dcNode],
    };

    const soProductionOrders = await ProductionOrder.find({ salesOrderId: so._id })
      .select('_id productionOrderCode productionDate status quantity itemId')
      .populate({
        path: 'itemId',
        model: getBooksCrmModels().Item,
        select: 'itemNo',
      });

    if (soProductionOrders?.length) {
      soNode.productionOrders = soProductionOrders;
    }

    /* ============ IF SO FROM QUOTE ============ */

    if (so.quoteId) {
      const quote = await Quote.findById(so.quoteId).select('_id quoteId quoteDate status total');

      if (quote) {
        if (!quoteMap.has(quote._id.toString())) {
          quoteMap.set(quote._id.toString(), {
            id: quote._id,
            quoteId: quote.quoteId,
            quoteDate: quote.quoteDate,
            status: quote.status,
            total: quote.total,
            salesOrders: [],
          });
        }

        quoteMap.get(quote._id.toString()).salesOrders.push(soNode);
      }
    } else {
      /* SO created direct */
      if (!moduleTree.salesOrders) moduleTree.salesOrders = [];
      moduleTree.salesOrders.push(soNode);
    }
  }

  moduleTree.quotes = Array.from(quoteMap.values());

  /* ============ IF DC CREATED DIRECT ============ */

  if (!salesOrders.length) {
    moduleTree.deliveryChallan = dcNode;
  }

  return moduleTree;
};

module.exports = {
  createDeliveryChallan: withTransientRetry(createDeliveryChallan),
  queryDeliveryChallans,
  queryDeliveryChallansExports,
  getDeliveryChallanById,
  updateDeliveryChallanById,
  updateDeliveryChallanStatus,
  deleteDeliveryChallanById,
  DELIVERY_CHALLAN_CONVERSION_ALLOWED_STATUSES,
  deliveryChallanfromSalesOrder,
  deliveryChallanItems,
};
