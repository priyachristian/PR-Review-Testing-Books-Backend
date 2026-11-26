const { getBooksCrmModels, getClientConnection, getBooksModels, getCommonModels } = require('../../../services/model.service');
const { getAddressFilterCondition, getCustomerAddressMap } = require('../../../utils/addressLocationFilter');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const ApiError = require('../../../utils/ApiError');
const { createSearchRegex } = require('../../../utils/regexUtils');
const {
  QUOTE_STATUS,
  SALES_ORDER_STATUS,
  MODULE_NAMES,
  INVOICE_STATUS,
  DELIVERY_CHALLAN_STATUS,
  PAYMENT_STATUS,
  PRODUCTION_ORDER_STATUS,
  PRODUCTION_MANAGE_METHOD,
  RAW_MATERIAL_STATUS,
  SALES_ORDER_MATERIAL_STATUS,
} = require('../../../utils/enum');
const { QUOTE_CONVERSION_ALLOWED_STATUSES } = require('../quote/quote.service');
const {
  REJECTION_ORDER_STATUS_CONFIG,
  assertLinkedRejectionDeletable,
  revertLinkedRejectionSettlement,
} = require('../../rejection/rejectionOrder/rejectionOrder.service');
const { CUSTOMER_ORDER_STATUS, NOTIFICATION_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');
const {
  SALES_ORDER_STATUS_CONFIG,
  getInventoryConfig,
  validateStatusTransition,
  validateEditPermissions,
  validateStockAvailability,
  assertRevertAllowed,
} = require('../../../utils/inventoryConfig');
const httpStatus = require('http-status');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const mongoose = require('mongoose');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const { getPrimaryBank, getPrimaryBankDetails } = require('../../banking/bank/bank.service');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { uploadFileToS3, handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { validateCustomerForModule, activateCustomerInBranch } = require('../../../services/customerValidation.service');
const {
  distributeRemainingAcrossLines,
  getPendingProductionByLine,
  loadUnitItemMap,
  getUnitFactor,
  sumConvertedToMainUnit,
  computeSalesOrderConversionStatus,
} = require('../../../services/conversionStatus.service');
const { getGstRateForCalculation } = require('../../../utils/gstRate');
const { isProductionDataComplete } = require('../../../utils/production');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { sendTransactionNotification } = require('../../../utils/transactionNotification');
const {
  sendModuleCustomerNotifications,
  notifyModuleDocumentIfNonDraft,
  isFirstStatusChange,
} = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');
const { SALES_ORDER_MESSAGES, PRODUCTION_ORDER_MESSAGES, CUSTOMER_ORDER_MESSAGES } = require('../../../utils/messages');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const {
  enrichDocumentItemLines,
  assertSelectableForNewLines,
  assertResolvable,
  activateItemsInWarehouse,
  assertLineUnitsValid,
  SNAPSHOT_MODE,
} = require('../../../services/documentItemEnricher.service');
const { getUntrackedProductionItems, roundQty } = require('../../../services/warehouseBatch.service');
const { processIncentiveEarn, cancelIncentiveLog } = require('../../setting/incentiveScheme/incentiveScheme.service');
const { getUniqueIds, getNameMap } = require('../../../utils/helper');
const { resolveCustomerPaymentTermsId, applyCompanyPaymentTermsFallback } = require('../../../utils/customerPaymentTerms');
const { assertSampleQuantitiesInRange } = require('../customerOrder/customerOrder.service');

// Statuses where conversions are allowed
const SALES_ORDER_CONVERSION_ALLOWED_STATUSES = [SALES_ORDER_STATUS.OPEN];

const createSalesOrder = async (orderBody, userId, uploadedFiles = []) => {
  const { SalesOrder, Quote, Item, Customer, Branch } = getBooksCrmModels();
  const { Invoice, CustomerOrder, RejectionOrder } = getBooksModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  session.startTransaction();

  try {
    const { warehouseId, quoteId, customerOrderId, companyId, activateCustomerBranch, activateItemWarehouse, ...otherOrderData } =
      orderBody;
    let items = orderBody.items || [];
    const isPortalConversion = Boolean(customerOrderId);

    if (quoteId && customerOrderId) {
      throw new ApiError(httpStatus.BAD_REQUEST, SALES_ORDER_MESSAGES.MULTIPLE_SOURCES);
    }

    const company = await Company.findById(orderBody.companyId).populate('baseCurrency').session(session);

    // Validated before any activation: only an accepted order of the same customer converts.
    let customerOrder = null;
    if (customerOrderId) {
      customerOrder = await CustomerOrder.findOne({ _id: customerOrderId, companyId }).session(session);
      if (!customerOrder) {
        throw new ApiError(httpStatus.NOT_FOUND, CUSTOMER_ORDER_MESSAGES.FETCH_NOT_FOUND);
      }
      if (customerOrder.status !== CUSTOMER_ORDER_STATUS.ACCEPTED) {
        throw new ApiError(httpStatus.BAD_REQUEST, CUSTOMER_ORDER_MESSAGES.CONVERSION_NOT_ALLOWED);
      }
      if (String(customerOrder.customerId) !== String(orderBody.customerId)) {
        throw new ApiError(httpStatus.BAD_REQUEST, CUSTOMER_ORDER_MESSAGES.CUSTOMER_MISMATCH);
      }
      if (customerOrder.sampleCatalogId) {
        await assertSampleQuantitiesInRange({ customerOrderId, companyId, items, session });
      }
    }

    // Portal customers may not be linked to the branch chosen at conversion; link them once the user confirms.
    if (isPortalConversion && activateCustomerBranch) {
      await activateCustomerInBranch({
        customerId: orderBody.customerId,
        branchId: orderBody.branchId,
        companyId,
        session,
        models: { Customer, Branch },
      });
    }

    await validateCustomerForModule({
      customerId: orderBody.customerId,
      branchId: orderBody.branchId,
      companyId,
      totalAmount: orderBody.total,
      addressId: orderBody.addressId,
      moduleName: MODULE_NAMES.SALES_ORDER,
      session,
      models: { Customer, Branch, Invoice },
    });

    // If quoteId is provided, use items from the quote and fetch latest config
    let quote = null;
    if (quoteId) {
      quote = await Quote.findById(quoteId).session(session);
      if (!quote) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Quote not found');
      }

      // Validate quote status for conversion
      if (!QUOTE_CONVERSION_ALLOWED_STATUSES.includes(quote.status)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Quote cannot be converted to sales order in ${
            quote.status
          } status. Allowed statuses: ${QUOTE_CONVERSION_ALLOWED_STATUSES.join(', ')}`,
        );
      }
    }

    // Upload files to S3 if any files were provided
    let attachmentUrls = [];
    if (uploadedFiles && uploadedFiles.length > 0) {
      const uploadPromises = uploadedFiles.map(file => uploadFileToS3(file, userId, orderBody.companyId));
      attachmentUrls = await Promise.all(uploadPromises);
    }

    // Merge uploaded file URLs with existing attachments (if any from JSONString)
    const allAttachments = [...attachmentUrls];

    //add default warehouse entry
    if (orderBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: orderBody.items,
          warehouseId: warehouseId,
          branchId: orderBody.branchId,
          divisionId: orderBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    // Fetch latest inventory config for SALES_ORDER module
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.SALES_ORDER, session);

    // Portal orders have no warehouse; on user confirm, activate their items in the chosen one.
    if (isPortalConversion && activateItemWarehouse) {
      await activateItemsInWarehouse({
        itemIds: items.map(item => item?.itemId),
        warehouseId,
        companyId,
        userId,
        session,
      });
    }

    // Quote lines are carried (later deactivation tolerated); customer order and standalone lines must be selectable.
    const itemSelectabilityCheck = await enrichDocumentItemLines(items, {
      companyId,
      warehouseId,
      session,
      snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
    });
    if (quoteId) {
      assertResolvable(itemSelectabilityCheck);
    } else {
      assertSelectableForNewLines(itemSelectabilityCheck, 'sales order');
    }
    await assertLineUnitsValid(itemSelectabilityCheck, { companyId, session });

    // Validate stock availability
    if (inventoryConfig?.stockCheckEnabled || inventoryConfig?.stockDeductEnabled) {
      await validateStockAvailability({ items, companyId, warehouseId: warehouseId }, session);
    }

    orderBody.orderId = await generateUniqueId(
      SalesOrder,
      companyId,
      MODULE_NAMES.SALES_ORDER,
      'orderId',
      'SO',
      session,
      orderBody.orderId,
    );

    // Update quote status to COMPLETED and save config changes if converted
    if (quote) {
      quote.status = QUOTE_STATUS.COMPLETED;
      quote.updatedBy = userId;
      quote.convertedTo = quote.convertedTo || [];
      quote.convertedTo.push({
        type: 'SalesOrder',
        documentId: new mongoose.Types.ObjectId(),
        documentNo: orderBody.orderId || 'New SalesOrder',
        convertedAt: new Date(),
      });

      await quote.save({ session });
    }

    const bank = await getPrimaryBank(orderBody.companyId, session);

    let currency;
    let exchangeRate;
    let decimalPlaces;

    if (quote?.currency) {
      currency = quote.currency;
      exchangeRate = quote.exchangeRate ?? 1;
      decimalPlaces = quote.decimalPlaces ?? null;
    } else {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
        companyId,
        customerId: orderBody.customerId,
      }));
    }
    const currencyDoc = await getCurrency(companyId, currency);

    // Build comment history entry depending on the source of conversion
    let commentHistory;
    if (quoteId) {
      commentHistory = [
        {
          message: `Sales Order created from Quote ${quote.quoteId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'Quote',
          referenceId: quote._id,
        },
      ];
    } else if (customerOrderId) {
      commentHistory = [
        {
          message: `Sales Order created from Customer Order ${orderBody.customerOrderNo || customerOrderId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'CustomerOrder',
          referenceId: customerOrderId,
        },
      ];
    } else {
      commentHistory = [
        {
          message: `Sales Order created for ${currencyDoc?.symbol || '₹'}${orderBody.total || 0}`,
          addedBy: userId,
          createdAt: new Date(),
        },
      ];
    }

    // Create Sales Order
    const orderData = {
      ...otherOrderData,
      orderId: orderBody.orderId,
      currency,
      exchangeRate: orderBody.exchangeRate ?? 1,
      decimalPlaces,
      authorizedSignature: company?.authorizedSignature,
      items,
      warehouseId,
      bankAccountId: bank?.accountId,
      companyId,
      quoteId: quoteId || undefined,
      customerOrderId: customerOrderId || undefined,
      attachments: allAttachments, // Include uploaded file URL and existing attachments
      addedBy: userId,
      updatedBy: userId,
      inventoryConfig, // Store the latest config
      appName: APP_NAME.BOOKS,
      commentHistory,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };

    const order = await SalesOrder.create([orderData], { session });

    // Update the document ID in the PO's convertedTo array if needed
    if (quote) {
      const conversionIndex = quote.convertedTo.findIndex(
        c => c.type === 'SalesOrder' && c.documentNo === (orderBody.orderId || 'New SalesOrder'),
      );
      if (conversionIndex >= 0) {
        quote.convertedTo[conversionIndex].documentId = order[0]._id;
        quote.commentHistory.push({
          message: `Quote converted to salesOrder ${orderBody.orderId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'SalesOrder',
          referenceId: order[0]._id,
        });
        await quote.save({ session });
      }
    }

    if (customerOrder) {
      customerOrder.status = CUSTOMER_ORDER_STATUS.COMPLETED;
      customerOrder.updatedBy.push({ updatedByType: 'User', updatedBy: userId, updatedAt: new Date() });
      customerOrder.commentHistory.push({
        message: `Customer Order converted to Sales Order ${order[0].orderId}`,
        addedByType: 'User',
        addedBy: userId,
        timestamp: new Date(),
        referenceType: 'SalesOrder',
        referenceId: order[0]._id,
      });
      await customerOrder.save({ session });
    }

    // A sales order raised to settle a rejection PC-to-PC moves that rejection to SETTLED.
    const rejectionRef = orderBody.rejectionOrderDetails?.rejectionOrderRef;
    if (rejectionRef) {
      const rejectionOrder = await RejectionOrder.findOne({ _id: rejectionRef, companyId })
        .select('status')
        .session(session)
        .lean();
      if (!rejectionOrder) throw new ApiError(httpStatus.NOT_FOUND, 'Rejection order not found');
      validateStatusTransition(REJECTION_ORDER_STATUS_CONFIG.STATUS_TRANSITIONS, rejectionOrder.status, 'SETTLED');
      await RejectionOrder.updateOne(
        { _id: rejectionRef, companyId },
        { $set: { convertType: 'PC2PC', status: 'SETTLED', 'items.$[].convertType': 'PC2PC' } },
        { session },
      );
    }

    await session.commitTransaction();

    if (customerOrder) {
      sendTransactionNotification({
        customerId: customerOrder.customerId,
        companyId: customerOrder.companyId,
        notificationType: NOTIFICATION_TYPE.CUSTOMER_ORDER_COMPLETED,
        entityId: customerOrder._id,
        entityDisplayId: customerOrder.customerOrderId,
        triggeredByUserId: userId,
      });
    }

    sendTransactionNotification({
      customerId: order[0].customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.SALES_ORDER_CREATED,
      entityId: order[0]._id,
      entityDisplayId: order[0].orderId,
      triggeredByUserId: userId,
    });

    notifyModuleDocumentIfNonDraft({
      companyId,
      moduleName: MODULE_NAMES.SALES_ORDER,
      document: order[0],
      initialStatus: SALES_ORDER_STATUS.DRAFT,
    });

    processIncentiveEarn(companyId, userId, 'SALES_ORDER', order[0]._id, order[0].total, order[0].items);
    return enrichDocumentCurrency(companyId, order[0].toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    session.endSession();
  }
};

const querySalesOrders = async (filter, options) => {
  const { SalesOrder, SalesOrderTag, Customer, Item, PaymentTerm } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();
  const { User, CompanySettings } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const query = { companyId };

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'orderDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  if (filter.tagId) {
    const tagArray = filter.tagId.split(',').filter(Boolean);
    if (tagArray.length > 0) {
      query.tagId = { $in: tagArray.map(id => new mongoose.Types.ObjectId(id)) };
    }
  }

  if (filter.appName) {
    query.appName = filter.appName;
  }
  // Status filter
  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  if (filter.productionOrderStatus) {
    const productionOrderStatusArray = filter.productionOrderStatus.split(',').filter(Boolean);
    if (productionOrderStatusArray.length > 0) {
      query.productionOrderStatus = { $in: productionOrderStatusArray };
    }
  }

  if (filter.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) query.addedBy = { $in: addedByIds };
  }

  // Search filter
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());

    const customers = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );

    const customerIds = customers.map(c => c._id); // Keep ObjectId

    query.$or = [
      { reference: searchRegex },
      { orderId: searchRegex },
      { customerId: { $in: customerIds } },
      { deliveryMethod: searchRegex },
      { reference: searchRegex },
      { customerNotes: searchRegex },
    ];
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
  // Country/State/City filters resolve through the address selected on the sales order (addressId)
  const addressCondition = await getAddressFilterCondition(Customer, companyId, filter);
  if (addressCondition) {
    (query.$and ||= []).push(addressCondition);
  }

  // Only the list page with production access asks for the badges; the export and other callers skip the work.
  const materialStatusOrderIds =
    filter.withMaterialStatus || filter.materialStatus ? await getMaterialStatusOrderIds(query, companyId) : null;
  if (filter.materialStatus) {
    query._id = { $in: materialStatusOrderIds[filter.materialStatus] };
  }

  if (options?.countOnly) {
    return { results: [], totalResults: await SalesOrder.countDocuments(query) };
  }

  // Remove population since we will manually enrich
  // delete options.populate;
  options.populate = `divisionId:name,branchId:name,warehouseId:name,paymentTermsId`;

  // Get paginated orders
  const orders = await SalesOrder.paginateWithTotal(query, options);
  const { results } = orders;

  // Populate customer, including root-level and per-branch payment terms
  await SalesOrder.populate(results, {
    path: 'customerId',
    select: 'customerDisplayName useBranchPaymentTerms paymentTermsId branch isCustomerDirectTax',
    populate: [{ path: 'paymentTermsId' }, { path: 'branch.paymentTermsId' }],
  });

  // Populate the line unit (itemUnitId -> ItemUnit name)
  await SalesOrder.populate(results, { path: 'items.itemUnitId', select: 'name' });

  // Fall back to CompanySettings.salesCreditLimit's root/branch payment terms when the customer has none
  const companySettings = await CompanySettings.findOne({ companyId })
    .select('salesCreditLimit')
    .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
    .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
    .lean();
  const salesCreditLimit = companySettings?.salesCreditLimit;

  // const customerIds = [...new Set(results.map(o => o.customerId))];

  // Fetch customer data
  // const customers = await Customer.find({ _id: { $in: customerIds } })
  //   .select('customerNumber customerDisplayName code customerPhoneNumber companyName address otherDetails')
  //   .lean();

  // const customerMap = customers.reduce((acc, c) => {
  //   acc[c._id.toString()] = c;
  //   return acc;
  // }, {});

  // Collect all item IDs across all orders in a single query to avoid N+1
  const allItemIds = [...new Set(results.flatMap(o => (o.items || []).map(i => i.itemId?.toString())).filter(Boolean))];
  const allItems = await Item.find({ _id: { $in: allItemIds } }).lean();
  const globalItemMap = new Map(allItems.map(i => [i._id.toString(), i]));

  const orderIds = results.map(o => o._id);
  const [deliveryChallansForOrders, invoicesForOrders] = await Promise.all([
    DeliveryChallan.find({
      'salesOrders.salesOrderId': { $in: orderIds },
      status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
    }).select('salesOrders challanId status'),
    Invoice.find({
      'salesOrders.salesOrderId': { $in: orderIds },
      status: { $ne: INVOICE_STATUS.CANCELLED },
    }).select('salesOrders invoiceId status'),
  ]);

  const deliveryChallanBySalesOrder = deliveryChallansForOrders.reduce((acc, challan) => {
    (challan.salesOrders || []).forEach(so => {
      const key = so.salesOrderId?.toString();
      if (key) (acc[key] ||= []).push(challan);
    });
    return acc;
  }, {});
  const invoiceBySalesOrder = invoicesForOrders.reduce((acc, invoice) => {
    (invoice.salesOrders || []).forEach(so => {
      const key = so.salesOrderId?.toString();
      if (key) (acc[key] ||= []).push(invoice);
    });
    return acc;
  }, {});

  // Resolve each order's root-level addressId from the customer's billing/shipping/additional shipping addresses
  const addressMap = await getCustomerAddressMap(
    Customer,
    results.map(order => order.customerId?._id),
  );

  const pendingProductionBySalesOrder = await getPendingProductionByLine(results);
  const updatedResults = await Promise.all(
    results.map(async order => {
      const orderObj = order.toObject();
      orderObj.id = orderObj._id;
      orderObj.addressIn = addressMap[orderObj.addressId?.toString()] || null;
      applyCompanyPaymentTermsFallback(orderObj.customerId, salesCreditLimit, orderObj.branchId?._id || orderObj.branchId);
      const soId = new mongoose.Types.ObjectId(orderObj.id);
      const itemIds = order.items.map(item => item.itemId);
      const pendingProductionLines = pendingProductionBySalesOrder.get(soId.toString());
      orderObj.deliveryChallans = deliveryChallanBySalesOrder[soId.toString()] || [];
      orderObj.invoices = invoiceBySalesOrder[soId.toString()] || [];
      if (orderObj.status == SALES_ORDER_STATUS.PARTIALLY_RECORDED) {
        const [deliveryChallan, invoice] = await Promise.all([
          DeliveryChallan.aggregate([
            {
              $match: {
                'salesOrders.salesOrderId': soId,
                'items.referenceId': soId,
                status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
              },
            },
            { $unwind: '$items' },
            { $match: { 'items.referenceId': soId, 'items.itemId': { $in: itemIds } } },
            {
              $group: {
                _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' },
                totalBilledQty: { $sum: '$items.quantity' },
              },
            },
          ]),
          Invoice.aggregate([
            {
              $match: { 'salesOrders.salesOrderId': soId, 'items.referenceId': soId, status: { $ne: INVOICE_STATUS.CANCELLED } },
            },
            { $unwind: '$items' },
            { $match: { 'items.referenceId': soId, 'items.itemId': { $in: itemIds } } },
            {
              $group: {
                _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' },
                totalBilledQty: { $sum: '$items.quantity' },
              },
            },
          ]),
        ]);

        // Converted quantities are compared with the ordered line in the item's main unit.
        const deliveryChallanMap = sumConvertedToMainUnit(deliveryChallan, globalItemMap, 'totalBilledQty');
        const invoiceMap = sumConvertedToMainUnit(invoice, globalItemMap, 'totalBilledQty');
        const convertedByItem = new Map();
        for (const map of [deliveryChallanMap, invoiceMap]) {
          for (const [key, qty] of map) convertedByItem.set(key, (convertedByItem.get(key) || 0) + qty);
        }

        orderObj.items = distributeRemainingAcrossLines(orderObj.items || [], convertedByItem, globalItemMap).map(
          (item, index) => {
            const itemIdStr = item.itemId?._id?.toString?.() || item.itemId?.toString?.();
            const itemDoc = globalItemMap.get(itemIdStr);
            return {
              ...item,
              hasProductionData: isProductionDataComplete(itemDoc?.productionData),
              pendingProductionQty: pendingProductionLines[index],
            };
          },
        );
      } else {
        orderObj.items = (orderObj.items || []).map((item, index) => {
          const itemIdStr = item.itemId?._id?.toString?.() || item.itemId?.toString?.();
          const itemDoc = globalItemMap.get(itemIdStr);
          return {
            ...item,
            hasProductionData: isProductionDataComplete(itemDoc?.productionData),
            pendingProductionQty: pendingProductionLines[index],
          };
        });
      }
      orderObj.hasPendingProduction = orderObj.items.some(item => item.hasProductionData && item.pendingProductionQty > 0);

      // orderObj.customerId = customerMap[orderObj.customerId?.toString()] || null;

      // const convertedDocs = await Promise.all(
      //   (orderObj.convertedTo || []).map(async converted => {
      //     const convertedObj = converted.toObject?.() ?? converted;

      //     if (converted.type === 'DeliveryChallan') {
      //       const challanData = await DeliveryChallan.findById(converted.documentId).select('total challanDate status').lean();
      //       return { ...convertedObj, ...challanData };
      //     }

      //     if (converted.type === 'Invoice') {
      //       const invoiceData = await Invoice.findById(converted.documentId)
      //         .select('total invoiceDate status paidAmount balanceAmount dueDate')
      //         .lean();
      //       return { ...convertedObj, ...invoiceData };
      //     }

      //     return convertedObj;
      //   }),
      // );

      // orderObj.convertedTo = convertedDocs;

      return orderObj;
    }),
  );

  orders.results = updatedResults;
  const userIds = [],
    tagIds = [];
  orders.results.forEach(order => {
    const addedBy = order.addedBy;
    const updatedBy = toUpdatedByUserIdString(order.updatedBy);
    userIds.push(addedBy, updatedBy);
    tagIds.push(order.tagId);
  });

  const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName');
  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  const tags = await SalesOrderTag.find({ _id: { $in: tagIds } }).select('name color');
  const tagMap = (tags || []).reduce((acc, tag) => {
    acc[tag._id.toString()] = tag;
    return acc;
  }, {});

  const populatedOrders = orders.results.map(async order => {
    const orderObj = order.toObject?.() ?? order;
    const remainingAmount = await getRemainingAmountForSalesOrder(orderObj._id);

    const addedBy = userMap[orderObj.addedBy?.toString()];
    const tag = tagMap[orderObj.tagId?.toString()];
    const updatedById = toUpdatedByUserIdString(orderObj.updatedBy);
    orderObj.addedBy = addedBy ? addedBy.toObject() : null;
    orderObj.tagName = tag ? tag.name : '';
    orderObj.tagColor = tag ? tag.color : '';
    orderObj.updatedBy = updatedById && userMap[updatedById] ? userMap[updatedById].toObject() : null;
    orderObj.remainingAmount = remainingAmount || 0;
    return orderObj;
  });

  const finalOrders = await Promise.all(populatedOrders);

  const resultsWithCurrency = await enrichDocumentCurrency(companyId, await attachItemSummaries(finalOrders));

  return {
    ...orders,
    results: resultsWithCurrency,
    materialStatusCounts: materialStatusOrderIds && {
      available: materialStatusOrderIds[SALES_ORDER_MATERIAL_STATUS.AVAILABLE].length,
      partiallyReady: materialStatusOrderIds[SALES_ORDER_MATERIAL_STATUS.PARTIALLY_READY].length,
      issues: materialStatusOrderIds[SALES_ORDER_MATERIAL_STATUS.ISSUES].length,
    },
  };
};

const querySalesOrdersExports = async (filter, options) => {
  const result = await querySalesOrders(filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

// Raw materials still needed for the quantity not yet put into production, per sales order.
// pendingByOrder is getPendingProductionByLine's result: sales order id -> pending qty per line.
const getRawMaterialRequirements = async (salesOrders, pendingByOrder, companyId) => {
  const { Item, ItemInventory } = getBooksCrmModels();
  const { CompanySettings } = getCommonModels();

  const fgIds = new Set();
  for (const order of salesOrders) {
    const pendingLines = pendingByOrder.get(order._id.toString()) || [];
    order.items.forEach((line, index) => {
      if (pendingLines[index] > 0) fgIds.add(line.itemId?._id?.toString() || line.itemId.toString());
    });
  }
  if (!fgIds.size) return new Map();

  const finishedGoods = await Item.find({ companyId, _id: { $in: [...fgIds] } })
    .select('itemName itemUnitId unitConversions productionData')
    .lean();
  const finishedGoodById = new Map(
    finishedGoods.filter(item => isProductionDataComplete(item.productionData)).map(item => [item._id.toString(), item]),
  );

  // BOM rows, or every process's raw materials for a process route.
  const rawMaterialRowsOf = item =>
    item.productionData.productionManageMethod === PRODUCTION_MANAGE_METHOD.BOM_BASED
      ? item.productionData.bomBased || []
      : (item.productionData.processBased || []).flatMap(process => process.rawMaterials || []);

  const rawMaterialIds = [
    ...new Set([...finishedGoodById.values()].flatMap(item => rawMaterialRowsOf(item).map(row => row.item.toString()))),
  ];
  const [rawMaterials, inventories, companySettings] = await Promise.all([
    Item.find({ companyId, _id: { $in: rawMaterialIds } })
      .select('itemNo itemName itemUnit itemUnitId unitConversions')
      .lean(),
    ItemInventory.find({ companyId, itemId: { $in: rawMaterialIds } })
      .select('itemId warehouses.warehouseId warehouses.availableStock')
      .lean(),
    CompanySettings.findOne({ companyId }).select('rejectionWarehouseConfig').lean(),
  ]);
  const rawMaterialById = new Map(rawMaterials.map(item => [item._id.toString(), item]));

  // Stock across every warehouse except the rejection scrap and return warehouses, whose stock is not usable.
  const rejectionConfig = companySettings?.rejectionWarehouseConfig;
  const unusableWarehouseIds = new Set(
    [rejectionConfig?.scrapWarehouseId, rejectionConfig?.returnWarehouseId].filter(Boolean).map(String),
  );
  const stockByItem = new Map();
  for (const inventory of inventories) {
    const stock = (inventory.warehouses || [])
      .filter(warehouse => !unusableWarehouseIds.has(String(warehouse.warehouseId)))
      .reduce((sum, warehouse) => sum + (warehouse.availableStock || 0), 0);
    stockByItem.set(inventory.itemId.toString(), stock);
  }

  const requirementsByOrder = new Map();
  for (const order of salesOrders) {
    const pendingLines = pendingByOrder.get(order._id.toString()) || [];
    const requiredByRow = new Map();
    const productionItems = new Set();

    order.items.forEach((line, index) => {
      const fgId = line.itemId?._id?.toString() || line.itemId.toString();
      const finishedGood = finishedGoodById.get(fgId);
      if (!finishedGood || !(pendingLines[index] > 0)) return;
      // An item with no raw materials in its production data can't be checked, so it stays out of the badges.
      if (!rawMaterialRowsOf(finishedGood).length) return;
      productionItems.add(fgId);

      // BOM quantities are per finished good in its main unit.
      const pendingInMainUnit = pendingLines[index] * getUnitFactor(finishedGoodById, fgId, line.itemUnitId);
      for (const row of rawMaterialRowsOf(finishedGood)) {
        const rawMaterialId = row.item.toString();
        const requiredInStockUnit =
          pendingInMainUnit * (row.qtyPerItem || 0) * getUnitFactor(rawMaterialById, rawMaterialId, row.itemUnitId);
        const key = `${fgId}|${rawMaterialId}`;
        const existing = requiredByRow.get(key) || { fgId, rawMaterialId, requiredQty: 0 };
        existing.requiredQty += requiredInStockUnit;
        requiredByRow.set(key, existing);
      }
    });

    // Items on one order that use the same raw material share its stock, in line order.
    const stockLeft = new Map();
    const rows = [...requiredByRow.values()].map(({ fgId, rawMaterialId, requiredQty }) => {
      const rawMaterial = rawMaterialById.get(rawMaterialId);
      const required = roundQty(requiredQty);
      const inStock = roundQty(stockByItem.get(rawMaterialId) || 0);
      const share = Math.min(required, stockLeft.has(rawMaterialId) ? stockLeft.get(rawMaterialId) : inStock);
      stockLeft.set(rawMaterialId, roundQty((stockLeft.has(rawMaterialId) ? stockLeft.get(rawMaterialId) : inStock) - share));
      const shortBy = roundQty(required - share);
      let status = RAW_MATERIAL_STATUS.AVAILABLE;
      if (shortBy > 0) status = share > 0 ? RAW_MATERIAL_STATUS.PARTIALLY_AVAILABLE : RAW_MATERIAL_STATUS.UNAVAILABLE;
      return {
        itemId: rawMaterialId,
        itemNo: rawMaterial?.itemNo,
        itemName: rawMaterial?.itemName,
        usedInItemId: fgId,
        usedIn: finishedGoodById.get(fgId).itemName,
        unitName: rawMaterial?.itemUnit,
        requiredQty: required,
        inStock,
        shortBy,
        status,
      };
    });
    requirementsByOrder.set(order._id.toString(), { productionItems: [...productionItems], rows });
  }
  return requirementsByOrder;
};

// One order's material status for the list tiles and the detail badge; null when nothing can be checked.
const getOrderMaterialStatus = requirement => {
  if (!requirement?.productionItems.length) return null;

  // An item with any raw material out of stock can make nothing; every other item can make at least part.
  const blockedItems = new Set(
    requirement.rows.filter(row => row.status === RAW_MATERIAL_STATUS.UNAVAILABLE).map(row => row.usedInItemId),
  );
  if (requirement.rows.every(row => row.status === RAW_MATERIAL_STATUS.AVAILABLE)) return SALES_ORDER_MATERIAL_STATUS.AVAILABLE;
  if (requirement.productionItems.every(fgId => blockedItems.has(fgId))) return SALES_ORDER_MATERIAL_STATUS.ISSUES;
  return SALES_ORDER_MATERIAL_STATUS.PARTIALLY_READY;
};

// Orders under the list's filters with quantity still to put into production, and of those, whether every raw material is in stock.
const getMaterialStatusOrderIds = async (query, companyId) => {
  const { SalesOrder } = getBooksCrmModels();
  const orders = await SalesOrder.find({
    ...query,
    $and: [...(query.$and || []), { status: { $in: [SALES_ORDER_STATUS.OPEN, SALES_ORDER_STATUS.PARTIALLY_RECORDED] } }],
  })
    .select('items.itemId items.itemUnitId items.quantity')
    .lean();

  const pendingByOrder = await getPendingProductionByLine(orders);
  const requirementsByOrder = await getRawMaterialRequirements(orders, pendingByOrder, companyId);

  const orderIds = {
    [SALES_ORDER_MATERIAL_STATUS.AVAILABLE]: [],
    [SALES_ORDER_MATERIAL_STATUS.PARTIALLY_READY]: [],
    [SALES_ORDER_MATERIAL_STATUS.ISSUES]: [],
  };
  for (const order of orders) {
    const orderStatus = getOrderMaterialStatus(requirementsByOrder.get(order._id.toString()));
    if (orderStatus) orderIds[orderStatus].push(order._id);
  }
  return orderIds;
};

const getSalesOrderById = async (id, companyId) => {
  const { SalesOrder, Branch, Division, Warehouse, Customer, ItemInventory, Item, PaymentTerm } = getBooksCrmModels();
  const { DeliveryChallan, Invoice, CustomerOrder, RejectionOrder } = getBooksModels();
  const { User, CompanySettings } = getCommonModels();

  const data = await SalesOrder.findOne({ _id: id, companyId }).populate([
    {
      path: 'customerId',
      select: 'customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails _id isCustomerDirectTax',
    },
    { path: 'quoteId', select: 'total quoteId status quoteDate' },
    { path: 'tagId', select: 'name color' },
    { path: 'paymentTermsId' },
    { path: 'items.itemUnitId', select: 'name' },
  ]);

  if (!data) {
    throw new ApiError(httpStatus.NOT_FOUND, SALES_ORDER_MESSAGES.SALES_ORDER_NOT_FOUND);
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

  const soId = new mongoose.Types.ObjectId(data._id);
  const itemIds = data.items.map(item => new mongoose.Types.ObjectId(item.itemId));

  // Map each item to whether its master has complete production data (same flag the list uses).
  const itemMasters = await Item.find({ _id: { $in: itemIds } })
    .select('productionData.productionManageMethod productionData.bomBased.item productionData.selectProcessRecipe')
    .lean();
  const productionDataMap = new Map(itemMasters.map(i => [i._id.toString(), isProductionDataComplete(i?.productionData)]));

  const deliveryChallanarray = [];
  if (data.convertedTo && data.convertedTo.length > 0) {
    for (let j of data.convertedTo) {
      if (j.type === 'DeliveryChallan') {
        const deliveryChallanData = await DeliveryChallan.findById(j.documentId).select('total challanDate status').lean();

        const jObject = j.toObject?.() ?? j;
        const merged = { ...jObject, ...deliveryChallanData };
        deliveryChallanarray.push(merged);
      }
      if (j.type === 'Invoice') {
        const invoiceData = await Invoice.findById(j.documentId)
          .select('total invoiceDate status paidAmount balanceAmount dueDate')
          .lean();

        const jObject = j.toObject?.() ?? j;
        const merged = { ...jObject, ...invoiceData };
        deliveryChallanarray.push(merged);
      }
    }
  }

  const addedBy = await User.findById(data.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(data.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findById(data?.branchId).select('name');
  const division = await Division.findById(data?.divisionId).select('name');
  const warehouse = await Warehouse.findById(data?.warehouseId).select('name');

  const primaryBankDetails = await getPrimaryBankDetails(data?.bankAccountId);
  const salesObj = data.toObject();
  salesObj.addedBy = addedBy;
  salesObj.updatedBy = updatedBy;
  const [deliveryChallan, invoice] = await Promise.all([
    DeliveryChallan.aggregate([
      {
        $match: {
          'salesOrders.salesOrderId': soId,
          'items.referenceId': soId,
          status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.referenceId': soId, 'items.itemId': { $in: itemIds } } },
      {
        $group: {
          _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' },
          totalBilledQty: { $sum: '$items.quantity' },
        },
      },
    ]),
    Invoice.aggregate([
      { $match: { 'salesOrders.salesOrderId': soId, 'items.referenceId': soId, status: { $ne: INVOICE_STATUS.CANCELLED } } },
      { $unwind: '$items' },
      { $match: { 'items.referenceId': soId, 'items.itemId': { $in: itemIds } } },
      {
        $group: {
          _id: { itemId: '$items.itemId', itemUnitId: '$items.itemUnitId' },
          totalBilledQty: { $sum: '$items.quantity' },
        },
      },
    ]),
  ]);

  // Converted quantities are compared with the ordered line in the item's main unit.
  const unitItemMap = await loadUnitItemMap(itemIds);
  const deliveryChallanMap = sumConvertedToMainUnit(deliveryChallan, unitItemMap, 'totalBilledQty');
  const invoiceMap = sumConvertedToMainUnit(invoice, unitItemMap, 'totalBilledQty');
  const convertedByItem = new Map();
  for (const map of [deliveryChallanMap, invoiceMap]) {
    for (const [key, qty] of map) convertedByItem.set(key, (convertedByItem.get(key) || 0) + qty);
  }
  const pendingProductionLines = (await getPendingProductionByLine([data])).get(data._id.toString());
  salesObj.items = await Promise.all(
    distributeRemainingAcrossLines(salesObj.items || [], convertedByItem, unitItemMap).map(async (item, index) => {
      const itemIdStr = item.itemId?._id?.toString?.() || item.itemId?.toString?.();
      const itemInventoryData = await ItemInventory.findOne({
        itemId: itemIdStr,
        companyId,
      });

      const matchWarehouse = itemInventoryData?.warehouses?.find(
        b => b.warehouseId?.toString() === data?.warehouseId?.toString(),
      );

      return {
        ...item,
        hasProductionData: productionDataMap.get(itemIdStr) || false,
        pendingProductionQty: pendingProductionLines[index],
        stocketDetails: (matchWarehouse && {
          ...matchWarehouse.toObject(),
          availableStock: roundQty(matchWarehouse.availableStock / getUnitFactor(unitItemMap, itemIdStr, item.itemUnitId)),
        }) || {
          availableStock: 0,
          reservedStock: 0,
          lockedStock: 0,
        },
      };
    }),
  );

  let customer = await Customer.findById(data.customerId._id || data.customerId)
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  // Fall back to CompanySettings.salesCreditLimit's root/branch payment terms when the customer has none
  const companySettings = await CompanySettings.findOne({ companyId })
    .select('salesCreditLimit')
    .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
    .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
    .lean();
  applyCompanyPaymentTermsFallback(customer, companySettings?.salesCreditLimit, data?.branchId);

  let shippingAddress = null;
  if (data.addressId) {
    if (data?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
      shippingAddress = customer.address.shipping;
    }

    if (!shippingAddress) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        addr => addr._id.toString() === data.addressId.toString(),
      );
    }
  }

  if (!salesObj.paymentTermsId) {
    salesObj.paymentTermsId = resolveCustomerPaymentTermsId(customer, data?.branchId);
  }

  salesObj.branchName = branch?.name || null;
  salesObj.divisionName = division?.name || null;
  salesObj.warehouseName = warehouse?.name || null;
  salesObj.bankAccountId = primaryBankDetails || {};
  salesObj.shippingAddress = shippingAddress || {};

  if (data.customerOrderId) {
    const customerOrderDoc = await CustomerOrder.findById(data.customerOrderId)
      .select('total customerOrderId status createdAt sampleCatalogId catalogCode catalogName')
      .lean();
    salesObj.customerOrderId = customerOrderDoc;
  }

  if (data.rejectionOrderDetails?.rejectionOrderRef) {
    const rejectionOrderDoc = await RejectionOrder.findOne({ _id: data.rejectionOrderDetails.rejectionOrderRef, companyId })
      .select('rejectionOrderId status address createdAt')
      .lean();
    if (rejectionOrderDoc) {
      salesObj.rejectionOrderDetails = { ...salesObj.rejectionOrderDetails, rejectionOrderRef: rejectionOrderDoc };
    }
  }

  salesObj.commentHistory = commentHistoryWithUser;
  salesObj.convertedTo = deliveryChallanarray;
  salesObj.moduleTree = await buildModuleTree(id);

  salesObj.hasPendingProduction = salesObj.items.some(item => item.hasProductionData && item.pendingProductionQty > 0);
  const rawMaterialsByOrder = await getRawMaterialRequirements(
    [salesObj],
    new Map([[soId.toString(), pendingProductionLines]]),
    companyId,
  );
  salesObj.rawMaterials = rawMaterialsByOrder.get(soId.toString())?.rows || [];
  salesObj.rawMaterialStatus = getOrderMaterialStatus(rawMaterialsByOrder.get(soId.toString()));
  // Repair any blank snapshot from the Item master and attach a per-line itemIssue for the UI warning.
  salesObj.items = await enrichDocumentItemLines(salesObj.items, {
    companyId,
    warehouseId: salesObj.warehouseId,
    snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
  });
  return enrichDocumentCurrency(companyId, salesObj);
};

const updateSalesOrderById = async (orderId, updateBody, userId, uploadedFiles = []) => {
  const { SalesOrder, Quote, Customer, Branch } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  session.startTransaction();

  try {
    const { items: newItems, warehouseId, companyId, ...otherUpdateBody } = updateBody;

    const order = await SalesOrder.findOne({ _id: orderId, companyId }).session(session);
    if (!order) {
      throw new ApiError(httpStatus.NOT_FOUND, SALES_ORDER_MESSAGES.SALES_ORDER_NOT_FOUND);
    }

    // Update the quote
    const oldTotal = order.total || 0;
    const newTotal = updateBody.total || 0;

    // // Upload files to S3 if any files were provided
    const company = await Company.findById(order.companyId).populate('baseCurrency').session(session);

    // Validate edit permissions
    validateEditPermissions(SALES_ORDER_STATUS_CONFIG.EDIT_RESTRICTED_STATUSES, order.status);
    let items = newItems || order.items;
    // No-op unless the source customer order is a sample order.
    if (order.customerOrderId && newItems) {
      await assertSampleQuantitiesInRange({ customerOrderId: order.customerOrderId, companyId, items: newItems, session });
    }

    await validateCustomerForModule({
      customerId: updateBody?.customerId,
      branchId: updateBody?.branchId,
      companyId,
      totalAmount: updateBody?.total,
      previousTotal: oldTotal,
      addressId: updateBody?.addressId,
      moduleName: MODULE_NAMES.SALES_ORDER,
      session,
      models: { Customer, Branch },
      isUpdate: true,
      skipOverdueCheck: true,
    });
    // Fetch latest inventory config for SALES_ORDER module
    const latestInventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.SALES_ORDER, session);

    const uploadedUrls = await handleFileUpdate({
      newFiles: uploadedFiles,
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: order.attachments ? order.attachments : [],
      userId,
      companyId: order.companyId,
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

    // Update inventory config if it has changed

    // Continue with normal update if not a status change to CANCELLED
    const oldItemsMap = new Map(order.items.map(item => [item.itemId.toString(), item.quantity]));
    const newItemsMap = new Map(items.map(item => [item.itemId.toString(), item.quantity]));

    // Check if this order is derived from a quote
    let quote = null;
    if (order.quoteId) {
      quote = await Quote.findById(order.quoteId).session(session);
      if (!quote) {
        console.warn(`Associated quote ${order.quoteId} not found for sales order ${orderId}`);
      }
    }

    // Validate stock for new and modified items if stock check is enabled
    if (latestInventoryConfig?.stockCheckEnabled || latestInventoryConfig?.stockDeductEnabled) {
      // The validator compares per-item totals in the main unit, so only increases can fail.
      await validateStockAvailability(
        { items, oldItems: order.items, oldItemsMap, companyId, warehouseId: warehouseId },
        session,
      );
    }

    let updateMsg = 'SalesOrder updated.';
    if (updateBody.customerId && String(updateBody.customerId) !== String(order.customerId)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: order.companyId,
        customerId: updateBody.customerId,
      });
      updateBody.currency = currency;
      updateBody.decimalPlaces = decimalPlaces;
    }
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(order.companyId, updateBody.currency || order.currency);
    const currencySymbol = currencyDoc?.symbol || company?.baseCurrency?.symbol || '₹';

    if (oldTotal !== newTotal) {
      updateMsg = `SalesOrder updated. Amount changed from ${currencySymbol}${oldTotal} to ${currencySymbol}${newTotal}`;
    }

    // Update the sales order
    order.items = items;

    Object.assign(order, {
      ...otherUpdateBody,
      authorizedSignature: company?.authorizedSignature,
      attachments: uploadedUrls,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    if (warehouseId) {
      order.warehouseId = warehouseId;
    }
    order.updatedBy = userId;

    order.commentHistory.push({
      // message: `Sales Order updated${updateBody.total ? `, new total: ${company?.baseCurrency?.symbol || '₹'}${updateBody.total}` : ''}`,
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
    });
    await order.save({ session });

    // If this order is derived from a quote, update the quote status if needed
    if (quote) {
      quote.updatedBy = userId;
      await quote.save({ session });
    }

    await session.commitTransaction();

    processIncentiveEarn(companyId, userId, 'SALES_ORDER', order._id, order.total, order.items);

    sendTransactionNotification({
      customerId: order.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.SALES_ORDER_UPDATED,
      entityId: order._id,
      entityDisplayId: order.orderId,
      triggeredByUserId: userId,
    });

    return enrichDocumentCurrency(order.companyId, order.toJSON());
  } catch (error) {
    await session.abortTransaction();
    console.error('Error updating sales order:', error);
    throw error;
  } finally {
    session.endSession();
  }
};

const updateSalesOrderStatus = async (orderId, companyId, newStatus, userId) => {
  const { SalesOrder, Quote } = getBooksCrmModels();
  const { Invoice, DeliveryChallan, ProductionOrder, CustomerOrder } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  session.startTransaction();

  try {
    const order = await SalesOrder.findOne({ _id: orderId, companyId }).session(session);
    if (!order) {
      throw new ApiError(httpStatus.NOT_FOUND, SALES_ORDER_MESSAGES.SALES_ORDER_NOT_FOUND);
    }

    // Validate status transition (the cancel action is handled specially below)
    if (newStatus !== SALES_ORDER_STATUS.CANCELLED) {
      validateStatusTransition(SALES_ORDER_STATUS_CONFIG.STATUS_TRANSITIONS, order.status, newStatus);
    }

    const isUncancel = order.status === SALES_ORDER_STATUS.CANCELLED && newStatus !== SALES_ORDER_STATUS.CANCELLED;
    if (isUncancel) {
      assertRevertAllowed({ isUncancel, hasEffect: false });
    }

    if (newStatus === SALES_ORDER_STATUS.CANCELLED && order.status !== SALES_ORDER_STATUS.CANCELLED) {
      let quote = null;
      if (order?.quoteId) {
        quote = await Quote.findById(order.quoteId).session(session);
      }

      const deliveryChallan = await DeliveryChallan.find({
        salesOrders: {
          $elemMatch: {
            salesOrderId: orderId,
          },
        },
        status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
      }).session(session);

      if (deliveryChallan.length > 0) {
        const orderIds = deliveryChallan.map(inv => inv.challanId).join(', ');

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel SalesOrder because a deliveryChallan has been created from it:${orderIds}`,
        );
      }

      const invoice = await Invoice.find({
        salesOrders: {
          $elemMatch: {
            salesOrderId: orderId,
          },
        },
        status: { $ne: INVOICE_STATUS.CANCELLED },
      }).session(session);

      if (invoice.length > 0) {
        const orderIds = invoice.map(inv => inv.invoiceId).join(', ');

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel SalesOrder because an Invoice has been created from it:${orderIds}`,
        );
      }

      if (quote) {
        await Quote.updateOne(
          { _id: quote._id },
          {
            $set: {
              status: QUOTE_STATUS.ACCEPTED,
              'commentHistory.$[target].isCancelled': true,
              updatedBy: userId,
            },
          },
          {
            arrayFilters: [{ 'target.referenceId': orderId }],
            session,
          },
        );

        await Quote.updateOne(
          { _id: quote._id },
          {
            $push: {
              commentHistory: {
                message: `Sales Order No ${order.orderId} cancelled successfully`,
                addedBy: userId,
                createdAt: new Date(),
              },
            },
          },
          { session },
        );
      }

      if (order.customerOrderId) {
        await CustomerOrder.updateOne(
          { _id: order.customerOrderId },
          {
            $set: { status: CUSTOMER_ORDER_STATUS.ACCEPTED },
            $push: {
              updatedBy: { updatedByType: 'User', updatedBy: userId, updatedAt: new Date() },
              commentHistory: {
                message: `Sales Order No ${order.orderId} cancelled successfully`,
                addedByType: 'User',
                addedBy: userId,
                timestamp: new Date(),
              },
            },
          },
          { session },
        );
      }
    }

    // Update status
    const oldStatus = order.status;
    order.status = newStatus;
    order.updatedBy = userId;
    order.commentHistory.push({
      message: `Sales Order status changed from ${oldStatus} to ${newStatus}`,
      addedBy: userId,
      createdAt: new Date(),
    });
    await order.save({ session });

    await session.commitTransaction();

    if (newStatus === SALES_ORDER_STATUS.CANCELLED) {
      cancelIncentiveLog(order._id);
    }

    sendTransactionNotification({
      customerId: order.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.SALES_ORDER_STATUS_CHANGED,
      entityId: order._id,
      entityDisplayId: order.orderId,
      triggeredByUserId: userId,
      newStatus,
    });

    if (isFirstStatusChange(oldStatus, newStatus, SALES_ORDER_STATUS.DRAFT)) {
      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.SALES_ORDER,
        document: order,
      }).catch(err => logger.error(`Failed to send sales order customer notifications for ${order.orderId}: ${err.message}`));
    }

    return order;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// Revert a Sales Order the user mistakenly CLOSED back to its conversion-derived status. CLOSED is a
// manual stop, so the automatic recompute leaves it alone; this re-derives OPEN / PARTIALLY_RECORDED
// / COMPLETED from the current non-cancelled Delivery Challan + Invoice quantities and persists it.
const revertSalesOrderClose = async (orderId, companyId, userId) => {
  const { SalesOrder } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  session.startTransaction();

  try {
    const order = await SalesOrder.findOne({ _id: orderId, companyId }).session(session);
    if (!order) {
      throw new ApiError(httpStatus.NOT_FOUND, SALES_ORDER_MESSAGES.SALES_ORDER_NOT_FOUND);
    }

    if (order.status !== SALES_ORDER_STATUS.CLOSED) {
      throw new ApiError(httpStatus.BAD_REQUEST, SALES_ORDER_MESSAGES.REVERT_CLOSE_NOT_CLOSED);
    }

    const newStatus = await computeSalesOrderConversionStatus(order, session);
    const oldStatus = order.status;
    order.status = newStatus;
    order.updatedBy = userId;
    order.commentHistory.push({
      message: `Sales Order status reverted from ${oldStatus} to ${newStatus}`,
      addedBy: userId,
      createdAt: new Date(),
    });
    await order.save({ session });

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: order.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.SALES_ORDER_STATUS_CHANGED,
      entityId: order._id,
      entityDisplayId: order.orderId,
      triggeredByUserId: userId,
      newStatus,
    });

    return order;
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const deleteSalesOrderById = async (orderId, companyId, userId) => {
  const { SalesOrder, Quote } = getBooksCrmModels();
  const { Invoice, DeliveryChallan, ProductionOrder, CustomerOrder } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  session.startTransaction();

  try {
    const order = await SalesOrder.findOne({ _id: orderId, companyId }).session(session);

    if (!order) {
      throw new ApiError(httpStatus.NOT_FOUND, SALES_ORDER_MESSAGES.SALES_ORDER_NOT_FOUND);
    }

    const linkedRejectionOrder = await assertLinkedRejectionDeletable(
      order.rejectionOrderDetails?.rejectionOrderRef,
      companyId,
      session,
      SALES_ORDER_MESSAGES.DELETE_RESTRICTED_REJECTION_ORDER,
    );

    let quote = null;
    if (order?.quoteId) {
      quote = await Quote.findById(order.quoteId).session(session);
    }

    const deliveryChallan = await DeliveryChallan.find({
      salesOrders: {
        $elemMatch: {
          salesOrderId: orderId,
        },
      },
    }).session(session);

    if (deliveryChallan.length > 0) {
      const orderIds = deliveryChallan.map(inv => inv.challanId).join(', ');

      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete SalesOrder because a deliveryChallan has been created from it:${orderIds}`,
      );
    }

    const invoice = await Invoice.find({
      salesOrders: {
        $elemMatch: {
          salesOrderId: orderId,
        },
      },
    }).session(session);

    if (invoice.length > 0) {
      const orderIds = invoice.map(inv => inv.invoiceId).join(', ');

      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete SalesOrder because an Invoice has been created from it:${orderIds}`,
      );
    }

    const productionOrder = await ProductionOrder.find({
      salesOrderId: orderId,
    }).session(session);

    if (productionOrder.length > 0) {
      const productionCodes = productionOrder
        .map(po => po.productionOrderCode)
        .filter(Boolean)
        .join(', ');

      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete SalesOrder because a ProductionOrder has been created from it:${productionCodes}`,
      );
    }

    if (quote) {
      const existingComment = await Quote.findOne({
        _id: quote._id,
        'commentHistory.referenceId': orderId,
      }).session(session);

      const baseUpdate = {
        $set: {
          status: QUOTE_STATUS.ACCEPTED,
          updatedBy: userId,
        },
        $pull: {
          convertedTo: {
            type: 'SalesOrder',
            documentId: orderId,
          },
        },
      };

      if (existingComment) {
        await Quote.updateOne(
          { _id: quote._id },
          {
            ...baseUpdate,
            $set: {
              ...baseUpdate.$set,
              'commentHistory.$[target].isDeleted': true,
            },
          },
          {
            arrayFilters: [{ 'target.referenceId': orderId }],
            session,
          },
        );
      } else {
        await Quote.updateOne({ _id: quote._id }, baseUpdate, { session });
      }

      await Quote.updateOne(
        { _id: quote._id },
        {
          $push: {
            commentHistory: {
              message: `Sales Order No ${order.orderId} deleted successfully`,
              addedBy: userId,
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
    }

    if (order.customerOrderId) {
      await CustomerOrder.updateOne(
        { _id: order.customerOrderId },
        {
          $set: { status: CUSTOMER_ORDER_STATUS.ACCEPTED },
          $push: {
            updatedBy: { updatedByType: 'User', updatedBy: userId, updatedAt: new Date() },
            commentHistory: {
              message: `Sales Order No ${order.orderId} deleted successfully`,
              addedByType: 'User',
              addedBy: userId,
              timestamp: new Date(),
            },
          },
        },
        { session },
      );
    }

    await revertLinkedRejectionSettlement(linkedRejectionOrder, companyId, session);

    await SalesOrder.findByIdAndDelete(orderId, { session });

    await session.commitTransaction();

    cancelIncentiveLog(orderId);

    sendTransactionNotification({
      customerId: order.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.SALES_ORDER_DELETED,
      entityId: order._id,
      entityDisplayId: order.orderId,
      triggeredByUserId: userId,
    });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Get sales orders for dropdown (only orderId and customerName)
 * @param {Object} filter - MongoDB filter
 * @returns {Promise<Array>}
 */
const getSalesOrdersForDropdown = async filter => {
  const { SalesOrder } = getBooksCrmModels();
  const salesOrders = await SalesOrder.find(filter)
    .select('orderId customerId items')
    .populate([
      {
        path: 'customerId',
        select: 'customerDisplayName',
      },
      {
        path: 'items.itemId',
        select: 'itemName itemNo',
      },
    ])
    .lean();

  return salesOrders.map(order => ({
    _id: order._id,
    orderId: order.orderId,
    customerName: order.customerId?.customerDisplayName || '',
    items: (order.items || []).map(item => ({
      itemId: item.itemId?._id || item.itemId,
      itemName: item.itemId?.itemName || '',
      quantity: item.quantity || 0,
    })),
  }));
};

const openSalesOrders = async filter => {
  const { SalesOrder, Division, Branch, Warehouse } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();
  const query = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    customerId: new mongoose.Types.ObjectId(filter.customerId),
  };
  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  const salesOrder = await SalesOrder.find(query).populate('paymentTermsId');
  const idArray = salesOrder.map(so => new mongoose.Types.ObjectId(so.id));

  const itemIds = salesOrder.flatMap(order => order.items.map(item => item.itemId));
  const divisionIds = getUniqueIds(salesOrder, 'divisionId');
  const branchIds = getUniqueIds(salesOrder, 'branchId');
  const warehouseIds = getUniqueIds(salesOrder, 'warehouseId');
  const [divisionMap, branchMap, warehouseMap] = await Promise.all([
    getNameMap(Division, divisionIds),
    getNameMap(Branch, branchIds),
    getNameMap(Warehouse, warehouseIds),
  ]);

  salesOrder.forEach(order => {
    order.divisionName = divisionMap.get(order.divisionId?.toString()) || null;
    order.branchName = branchMap.get(order.branchId?.toString()) || null;
    order.warehouseName = warehouseMap.get(order.warehouseId?.toString()) || null;
  });

  // DeliveryChallan aggregation to fetch relevant challans for all sales orders
  const deliveryChallan = await DeliveryChallan.aggregate([
    {
      $match: {
        'salesOrders.salesOrderId': { $in: idArray },
        'items.referenceId': { $in: idArray },
        status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
      },
    },
    {
      $project: {
        challanId: 1,
        salesOrders: {
          $filter: {
            input: '$salesOrders',
            as: 'order',
            cond: { $in: ['$$order.salesOrderId', idArray] },
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

  const invoice = await Invoice.aggregate([
    {
      $match: {
        'salesOrders.salesOrderId': { $in: idArray },
        'items.referenceId': { $in: idArray },
        status: { $ne: INVOICE_STATUS.CANCELLED },
      },
    },
    {
      $project: {
        invoiceId: 1,
        salesOrders: {
          $filter: {
            input: '$salesOrders',
            as: 'order',
            cond: { $in: ['$$order.salesOrderId', idArray] },
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
  // Map to hold total delivered quantities by salesOrderId + itemId
  const itemQuantityMap = {};

  for (const challan of deliveryChallan) {
    for (const item of challan.items) {
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

  for (const i of invoice) {
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
  // Prepare result for all partially pending items
  const partiallyPendingItems = [];
  const seenOrderIds = new Set();
  for (const order of salesOrder) {
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
        orderId: order.orderId,
        divisionId: order.divisionId,
        branchId: order.branchId,
        warehouseId: order.warehouseId,
        divisionName: order.divisionName,
        branchName: order.branchName,
        warehouseName: order.warehouseName,
        customerId: order.customerId,
        paymentTermsId: order.paymentTermsId,
        customerNotes: order.customerNotes,
        termsAndConditions: order.termsAndConditions,
        reference: order.reference,
        additionalCharges: order.additionalCharges,
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

  const { SalesOrder } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  // Fetch multiple sales orders
  const salesOrders = await SalesOrder.find({ _id: { $in: idArray }, companyId });

  // Flatten all itemIds from the fetched orders
  const itemIds = salesOrders.flatMap(order => order.items.map(item => item.itemId));

  // DeliveryChallan aggregation to fetch relevant challans for all sales orders
  const deliveryChallan = await DeliveryChallan.aggregate([
    {
      $match: {
        'salesOrders.salesOrderId': { $in: idArray },
        'items.referenceId': { $in: idArray },
        status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
      },
    },
    {
      $project: {
        challanId: 1,
        salesOrders: {
          $filter: {
            input: '$salesOrders',
            as: 'order',
            cond: { $in: ['$$order.salesOrderId', idArray] },
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

  const invoice = await Invoice.aggregate([
    {
      $match: {
        'salesOrders.salesOrderId': { $in: idArray },
        'items.referenceId': { $in: idArray },
        status: { $ne: INVOICE_STATUS.CANCELLED },
      },
    },
    {
      $project: {
        challanId: 1,
        salesOrders: {
          $filter: {
            input: '$salesOrders',
            as: 'order',
            cond: { $in: ['$$order.salesOrderId', idArray] },
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
  // Map to hold total delivered quantities by salesOrderId + itemId
  const itemQuantityMap = {};

  for (const challan of deliveryChallan) {
    for (const item of challan.items) {
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

  for (const i of invoice) {
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
  const soItemTotalQty = {};
  const partiallyPendingItems = [];

  for (const order of salesOrders) {
    for (const item of order.items) {
      const key = `${order._id}_${item.itemId}`;
      if (!soItemTotalQty[key]) soItemTotalQty[key] = 0;
      soItemTotalQty[key] += item.quantity;
    }
  }

  for (const order of salesOrders) {
    const pushedKeys = new Set();

    for (const item of order.items) {
      const key = `${order._id}_${item.itemId}`;

      if (pushedKeys.has(key)) continue;

      const totalOrdered = soItemTotalQty[key];
      const delivered = itemQuantityMap[key]?.totalQuantity || 0;
      const remaining = Math.max(0, totalOrdered - delivered);

      if (remaining > 0) {
        partiallyPendingItems.push({
          ...item.toObject(),
          quantity: totalOrdered,
          deliveredQuantity: delivered,
          remainingQuantity: remaining,
          referenceId: order._id,
          referenceNo: order.orderId,
        });
      }

      pushedKeys.add(key);
    }
  }

  return partiallyPendingItems;
};

// Helper function to determine stock status for an item
const getStockStatusForItem = (remainingQty, availableStock) => {
  if (remainingQty <= 0) return 'FULFILLED';
  if (availableStock <= 0) return 'OUT_OF_STOCK';
  if (availableStock < remainingQty) return 'INSUFFICIENT_STOCK';
  return 'SUFFICIENT_STOCK';
};

// Fulfilment quantities in the order-wise analysis are in each item's main unit: documents converted from an order
// may use a different unit than the order line, and totals add up across items.
const sumQtyForOrder = (orderId, docs, unitItemMap = null) => {
  const orderIdStr = orderId.toString();
  const byItem = {};
  docs.forEach(doc => {
    (doc.items || []).forEach(it => {
      if (it.referenceId?.toString() !== orderIdStr) return;
      const id = it.itemId.toString();
      byItem[id] = (byItem[id] || 0) + (it.quantity || 0) * getUnitFactor(unitItemMap, id, it.itemUnitId);
    });
  });
  return byItem;
};

const buildDisplayInvoiceAttribution = (orderId, invoicesForOrder, unitItemMap = null) => {
  const orderIdStr = orderId.toString();
  const displayInvoicedByItem = {};
  const relevantInvoices = [];

  invoicesForOrder.forEach(invoice => {
    let matchedThisInvoice = false;
    (invoice.items || []).forEach(it => {
      if (it.referenceId?.toString() !== orderIdStr) return;
      matchedThisInvoice = true;
      const id = it.itemId.toString();
      if (!displayInvoicedByItem[id]) {
        displayInvoicedByItem[id] = { qty: 0, amount: 0, invoices: new Map() };
      }
      displayInvoicedByItem[id].qty += (it.quantity || 0) * getUnitFactor(unitItemMap, id, it.itemUnitId);
      displayInvoicedByItem[id].amount += (it.amount || 0) + (it.taxAmount || 0);
      displayInvoicedByItem[id].invoices.set(invoice._id.toString(), { _id: invoice._id, invoiceNo: invoice.invoiceId });
    });
    if (matchedThisInvoice) relevantInvoices.push(invoice);
  });

  return { displayInvoicedByItem, relevantInvoices };
};

const buildOrderFulfillmentMaps = (orderId, orderChallans, orderInvoices, orderDisplayInvoices, unitItemMap = null) => {
  const deliveredByItem = sumQtyForOrder(orderId, orderChallans, unitItemMap);
  const invoicedByItem = sumQtyForOrder(orderId, orderInvoices, unitItemMap);
  const { displayInvoicedByItem, relevantInvoices } = buildDisplayInvoiceAttribution(orderId, orderDisplayInvoices, unitItemMap);

  return { deliveredByItem, invoicedByItem, displayInvoicedByItem, relevantInvoices };
};

const getSalesOrderWiseItemAnalysis = async (filter, options) => {
  const { SalesOrder, ItemInventory, ItemGroup, Item } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  // Build salesOrder filter
  const salesOrderFilter = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
  };

  if (filter.startDate && filter.endDate) {
    salesOrderFilter.orderDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      salesOrderFilter.branchId = {
        $in: branchArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      salesOrderFilter.divisionId = {
        $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.customerId) {
    const customerArray = filter.customerId.split(',').filter(Boolean);
    if (customerArray.length > 0) {
      salesOrderFilter.customerId = {
        $in: customerArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.itemId) {
    const itemArray = filter.itemId.split(',').filter(Boolean);
    if (itemArray.length > 0) {
      salesOrderFilter['items.itemId'] = {
        $in: itemArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.status) {
    salesOrderFilter.status = { $in: filter.status.split(',') };
  } else {
    salesOrderFilter.status = {
      $in: [SALES_ORDER_STATUS.OPEN, SALES_ORDER_STATUS.PARTIALLY_RECORDED, SALES_ORDER_STATUS.DRAFT],
    };
  }

  const invoiceIsSplitFilter = {};
  if (!filter?.isSplit) {
    invoiceIsSplitFilter.isSplit = false;
  }

  const salesOrderPipeline = [{ $match: salesOrderFilter }, { $sort: { orderDate: -1, _id: -1 } }];

  if (options.pagination) {
    const page = parseInt(options.page, 10) || 1;
    const limit = parseInt(options.limit, 10) || 10;
    const skip = (page - 1) * limit;

    salesOrderPipeline.push({ $skip: skip }, { $limit: limit });
  }

  salesOrderPipeline.push(
    {
      $lookup: {
        from: 'customers',
        localField: 'customerId',
        foreignField: '_id',
        as: 'customer',
      },
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'items',
        localField: 'items.itemId',
        foreignField: '_id',
        as: 'itemDoc',
      },
    },
  );

  const [salesOrdersRaw, allSalesOrdersForTotals] = await Promise.all([
    SalesOrder.aggregate(salesOrderPipeline),
    SalesOrder.find(salesOrderFilter).lean(),
  ]);
  const salesOrderCounts = allSalesOrdersForTotals.length;

  // Attach itemDoc at item level
  const salesOrders = salesOrdersRaw.map(order => {
    const itemDocsById = {};
    (order.itemDoc || []).forEach(doc => {
      itemDocsById[doc._id.toString()] = doc;
    });

    const itemsWithDoc = (order.items || []).map(it => ({
      ...it,
      itemDoc: it.itemId ? itemDocsById[it.itemId.toString()] : null,
    }));

    return {
      ...order,
      items: itemsWithDoc,
    };
  });

  // Get partial sales orders for challans/invoices
  const partialSalesOrdersIds = salesOrders
    .filter(order => order.status === SALES_ORDER_STATUS.PARTIALLY_RECORDED)
    .map(order => order._id);

  const allItemIds = [
    ...new Set(salesOrders.flatMap(order => (order.items || []).map(item => item.itemId?.toString()).filter(Boolean))),
  ].map(id => new mongoose.Types.ObjectId(id));

  // Every quantity in this analysis is reported in the item's main unit (see sumQtyForOrder).
  const unitItemMap = await loadUnitItemMap([
    ...allItemIds,
    ...allSalesOrdersForTotals.flatMap(order => (order.items || []).map(item => item.itemId)),
  ]);

  const challans = await DeliveryChallan.find({
    'salesOrders.salesOrderId': { $in: partialSalesOrdersIds },
    ...(filter.companyId ? { companyId: filter.companyId } : {}),
  }).lean();

  const challanIds = challans.map(c => c._id);

  const [invoices, itemInventories, itemGroups] = await Promise.all([
    Invoice.find({
      $or: [
        { 'salesOrders.salesOrderId': { $in: partialSalesOrdersIds } },
        { 'deliveryChallanIds.deliveryChallanId': { $in: challanIds } },
      ],
      ...(filter.companyId ? { companyId: filter.companyId } : {}),
      ...invoiceIsSplitFilter,
    }).lean(),
    ItemInventory.find({
      companyId: new mongoose.Types.ObjectId(filter.companyId),
      itemId: { $in: allItemIds },
    }).lean(),
    filter.customerId
      ? ItemGroup.find({ companyId: new mongoose.Types.ObjectId(filter.companyId) })
          .select('name groupCode itemGroupId')
          .lean()
      : Promise.resolve([]),
  ]);

  const challansByOrder = challans.reduce((acc, c) => {
    (c.salesOrders || []).forEach(so => {
      const id = so.salesOrderId.toString();
      acc[id] = acc[id] || [];
      acc[id].push(c);
    });
    return acc;
  }, {});

  const invoicesByOrder = invoices.reduce((acc, inv) => {
    (inv.salesOrders || []).forEach(so => {
      const id = so.salesOrderId.toString();
      acc[id] = acc[id] || [];
      acc[id].push(inv);
    });
    return acc;
  }, {});

  const challanToSalesOrderIds = challans.reduce((acc, c) => {
    acc[c._id.toString()] = (c.salesOrders || []).map(so => so.salesOrderId.toString());
    return acc;
  }, {});

  const displayInvoicesByOrder = invoices.reduce((acc, inv) => {
    const orderIds = new Set((inv.salesOrders || []).map(so => so.salesOrderId.toString()));
    (inv.deliveryChallanIds || []).forEach(dc => {
      (challanToSalesOrderIds[dc.deliveryChallanId?.toString()] || []).forEach(id => orderIds.add(id));
    });
    orderIds.forEach(id => {
      acc[id] = acc[id] || [];
      acc[id].push(inv);
    });
    return acc;
  }, {});

  const itemStockMap = itemInventories.reduce((acc, inv) => {
    acc[inv.itemId.toString()] = {
      availableStock: inv.totalAvailableStock || 0,
    };
    return acc;
  }, {});

  const itemGroupMap = itemGroups.reduce((acc, group) => {
    acc[group._id.toString()] = {
      _id: group._id,
      name: group.name,
      groupCode: group.groupCode,
      itemGroupId: group.itemGroupId,
    };
    return acc;
  }, {});

  // Build final result
  const result = [];
  const filteredItemId = filter.itemId ? new mongoose.Types.ObjectId(filter.itemId).toString() : null;

  for (const order of salesOrders) {
    const customerDisplayName = order.customer?.customerDisplayName || 'Unknown Customer';

    let orderedQty = 0;
    let requiredQty = 0;
    let invoicedQtyTotal = 0;
    let invoicedAmountTotal = 0;
    let totalAvailableStock = 0;
    const itemCodes = [];

    const orderChallans = challansByOrder[order._id.toString()] || [];
    const orderInvoices = invoicesByOrder[order._id.toString()] || [];
    const orderDisplayInvoices = displayInvoicesByOrder[order._id.toString()] || [];

    const {
      deliveredByItem,
      invoicedByItem,
      displayInvoicedByItem,
      relevantInvoices: orderRelevantInvoices,
    } = buildOrderFulfillmentMaps(order._id, orderChallans, orderInvoices, orderDisplayInvoices, unitItemMap);

    // Filter items if itemId filter is provided
    const itemsToProcess = filteredItemId
      ? (order.items || []).filter(item => item.itemId?.toString() === filteredItemId)
      : order.items || [];

    itemsToProcess.forEach(orderItem => {
      const itemId = orderItem.itemId?.toString();
      const itemOrderedQty = roundQty((orderItem.quantity || 0) * getUnitFactor(unitItemMap, itemId, orderItem.itemUnitId));

      const deliveredQty = deliveredByItem[itemId] || 0;
      const invoicedQty = invoicedByItem[itemId] || 0;
      const displayInvoiced = displayInvoicedByItem[itemId];
      const displayInvoicedQty = displayInvoiced?.qty || 0;
      const displayInvoicedAmount = displayInvoiced?.amount || 0;
      const itemInvoices = displayInvoiced ? Array.from(displayInvoiced.invoices.values()) : [];
      const remainingQty = itemOrderedQty - (deliveredQty + invoicedQty);

      // Add to total ordered quantity for this sales order
      orderedQty += itemOrderedQty;
      invoicedQtyTotal += displayInvoicedQty;
      invoicedAmountTotal += displayInvoicedAmount;

      // Add remaining quantity to required quantity (not ordered quantity)
      if (remainingQty > 0) {
        requiredQty += remainingQty;
      }

      const itemDoc = orderItem.itemDoc;
      const itemStock = itemStockMap[itemId] || { availableStock: 0 };

      if (remainingQty > 0) {
        totalAvailableStock += itemStock.availableStock;
      }

      if (itemDoc) {
        // Calculate item-level amount breakdown
        const itemBaseAmount = orderItem.amount || 0;
        const itemTaxAmount = orderItem.taxAmount || 0;
        const itemTotalAmount = itemBaseAmount + itemTaxAmount;
        const itemTaxRate = itemBaseAmount > 0 ? (itemTaxAmount / itemBaseAmount) * 100 : 0;

        itemCodes.push({
          _id: itemDoc._id,
          itemName: itemDoc.itemName,
          itemId: itemDoc.itemNo,
          itemNo: itemDoc.itemNo,
          orderedQty: itemOrderedQty,
          deliveredQty,
          invoicedQty: displayInvoicedQty,
          invoicedAmount: Number(displayInvoicedAmount.toFixed(2)),
          invoices: itemInvoices,
          remainingQty: Math.max(0, remainingQty),
          availableStock: itemStock.availableStock,
          stockStatus: getStockStatusForItem(remainingQty, itemStock.availableStock),
          rate: orderItem.rate || 0,
          amount: {
            baseAmount: itemBaseAmount,
            taxRate: itemTaxRate,
            taxAmount: itemTaxAmount,
            totalAmount: itemTotalAmount,
          },
          valuation: itemStock.availableStock * (orderItem.rate || 0),
        });
      }
    });
    itemCodes.sort((a, b) => b.remainingQty - a.remainingQty);

    const itemCount = itemsToProcess.length;

    // Calculate total amount and tax from filtered items only
    const baseAmount = itemsToProcess.reduce((acc, it) => acc + (it.amount || 0), 0);
    const taxAmount = itemsToProcess.reduce((acc, it) => acc + (it.taxAmount || 0), 0);
    const taxRate = baseAmount > 0 ? (taxAmount / baseAmount) * 100 : 0;

    // Only add sales order if it has items with remaining quantities
    if (itemCodes.length > 0 && requiredQty > 0) {
      result.push({
        salesOrderDetail: {
          salesOrderNo: order.orderId,
          salesOrderId: order._id,
        },
        customerDisplayName,
        itemCount: itemCount,
        orderedQty,
        requiredQty,
        invoicedQty: invoicedQtyTotal,
        invoicedAmount: Number(invoicedAmountTotal.toFixed(2)),
        availableStocks: totalAvailableStock,
        items: itemCodes,
        invoices: orderRelevantInvoices.map(invoice => ({
          _id: invoice._id,
          invoiceNo: invoice.invoiceId,
        })),
        amount: {
          baseAmount,
          taxRate,
          taxAmount,
          totalAmount: order.total,
        },
      });
    }
  }

  const allPartialSalesOrdersIds = allSalesOrdersForTotals
    .filter(order => order.status === SALES_ORDER_STATUS.PARTIALLY_RECORDED)
    .map(order => order._id);

  const totalsItemIds = filter.customerId
    ? [
        ...new Set(
          allSalesOrdersForTotals.flatMap(order => (order.items || []).map(item => item.itemId?.toString()).filter(Boolean)),
        ),
      ].map(id => new mongoose.Types.ObjectId(id))
    : [];

  const [allChallans, totalsItemDocs] = await Promise.all([
    DeliveryChallan.find({
      'salesOrders.salesOrderId': { $in: allPartialSalesOrdersIds },
      ...(filter.companyId ? { companyId: filter.companyId } : {}),
    }).lean(),
    filter.customerId
      ? Item.find({ _id: { $in: totalsItemIds } })
          .select('itemGroup')
          .lean()
      : Promise.resolve([]),
  ]);

  const allChallanIds = allChallans.map(c => c._id);

  const allInvoices = await Invoice.find({
    $or: [
      { 'salesOrders.salesOrderId': { $in: allPartialSalesOrdersIds } },
      { 'deliveryChallanIds.deliveryChallanId': { $in: allChallanIds } },
    ],
    ...(filter.companyId ? { companyId: filter.companyId } : {}),
    ...invoiceIsSplitFilter,
  }).lean();

  const itemIdToGroupId = totalsItemDocs.reduce((acc, doc) => {
    acc[doc._id.toString()] = doc.itemGroup?.toString();
    return acc;
  }, {});

  // Group challans by salesOrderId
  const allChallansByOrder = allChallans.reduce((acc, c) => {
    (c.salesOrders || []).forEach(so => {
      const id = so.salesOrderId.toString();
      acc[id] = acc[id] || [];
      acc[id].push(c);
    });
    return acc;
  }, {});

  const allInvoicesByOrder = allInvoices.reduce((acc, inv) => {
    (inv.salesOrders || []).forEach(so => {
      const id = so.salesOrderId.toString();
      acc[id] = acc[id] || [];
      acc[id].push(inv);
    });
    return acc;
  }, {});

  const allChallanToSalesOrderIds = allChallans.reduce((acc, c) => {
    acc[c._id.toString()] = (c.salesOrders || []).map(so => so.salesOrderId.toString());
    return acc;
  }, {});

  const allDisplayInvoicesByOrder = allInvoices.reduce((acc, inv) => {
    const orderIds = new Set((inv.salesOrders || []).map(so => so.salesOrderId.toString()));
    (inv.deliveryChallanIds || []).forEach(dc => {
      (allChallanToSalesOrderIds[dc.deliveryChallanId?.toString()] || []).forEach(id => orderIds.add(id));
    });
    orderIds.forEach(id => {
      acc[id] = acc[id] || [];
      acc[id].push(inv);
    });
    return acc;
  }, {});

  // Calculate totals from all matching sales orders
  const uniqueSalesOrderIds = new Set();
  const uniqueItemIds = new Set();
  let totalOrderedQty = 0;
  let totalInvoicedQty = 0;
  let totalAmount = 0;

  // Item-group wise breakup (built from ALL matching sales orders, not paginated)
  const itemGroupSummaryMap = {};

  for (const order of allSalesOrdersForTotals) {
    const orderChallans = allChallansByOrder[order._id.toString()] || [];
    const orderInvoices = allInvoicesByOrder[order._id.toString()] || [];
    const orderDisplayInvoices = allDisplayInvoicesByOrder[order._id.toString()] || [];

    const { deliveredByItem, invoicedByItem, displayInvoicedByItem } = buildOrderFulfillmentMaps(
      order._id,
      orderChallans,
      orderInvoices,
      orderDisplayInvoices,
      unitItemMap,
    );

    // Filter items if itemId filter is provided
    const itemsToProcess = filteredItemId
      ? (order.items || []).filter(item => item.itemId?.toString() === filteredItemId)
      : order.items || [];

    let hasRemainingQty = false;
    let orderOrderedQty = 0;
    let orderInvoicedQty = 0;

    itemsToProcess.forEach(orderItem => {
      const itemId = orderItem.itemId?.toString();
      const itemOrderedQty = roundQty((orderItem.quantity || 0) * getUnitFactor(unitItemMap, itemId, orderItem.itemUnitId));
      const deliveredQty = deliveredByItem[itemId] || 0;
      const invoicedQty = invoicedByItem[itemId] || 0;
      const displayInvoicedQty = displayInvoicedByItem[itemId]?.qty || 0;
      const remainingQty = itemOrderedQty - (deliveredQty + invoicedQty);

      orderOrderedQty += itemOrderedQty;
      orderInvoicedQty += displayInvoicedQty;

      if (remainingQty > 0) {
        hasRemainingQty = true;
        // Count unique items
        if (itemId) {
          uniqueItemIds.add(itemId);
        }

        // Group by item group (only needed for the customer-scoped summary)
        const itemGroupId = filter.customerId && itemId ? itemIdToGroupId[itemId] : null;
        if (itemGroupId) {
          if (!itemGroupSummaryMap[itemGroupId]) {
            const groupInfo = itemGroupMap[itemGroupId];
            itemGroupSummaryMap[itemGroupId] = {
              itemGroupId,
              itemGroupName: groupInfo?.name || 'Unknown Item Group',
              groupCode: groupInfo?.groupCode,
              totalQty: 0,
              totalAmount: 0,
              salesOrderIds: new Set(),
            };
          }
          itemGroupSummaryMap[itemGroupId].totalQty += itemOrderedQty;
          itemGroupSummaryMap[itemGroupId].totalAmount +=
            ((orderItem.amount || 0) + (orderItem.taxAmount || 0)) * (order.exchangeRate ?? 1);
          itemGroupSummaryMap[itemGroupId].salesOrderIds.add(order._id.toString());
        }
      }
    });

    // Only count sales orders that have items with remaining quantities
    if (hasRemainingQty && itemsToProcess.length > 0) {
      uniqueSalesOrderIds.add(order._id.toString());
      totalOrderedQty += orderOrderedQty;
      totalInvoicedQty += orderInvoicedQty;
      // Use sales order total amount, not item amounts
      totalAmount += (order.total || 0) * (order.exchangeRate ?? 1);
    }
  }

  // Item-group wise summary is only populated when the report is scoped to specific customer(s)
  const itemGroupWiseAnalysis = filter.customerId
    ? Object.values(itemGroupSummaryMap).map(group => ({
        itemGroupId: group.itemGroupId,
        itemGroupName: group.itemGroupName,
        groupCode: group.groupCode,
        totalQty: group.totalQty,
        totalAmount: Number((group.totalAmount || 0).toFixed(2)),
        totalSalesOrderCount: group.salesOrderIds.size,
      }))
    : [];

  const pagination = {
    page: options.page,
    limit: options.limit,
    totalResults: salesOrderCounts,
    totalPages: Math.ceil(salesOrderCounts / (options.limit || 10)),
    totalSalesOrders: uniqueSalesOrderIds.size,
    totalUniqueItems: uniqueItemIds.size,
    totalOrderedQty,
    totalInvoicedQty,
    totalAmount,
    itemGroupWiseAnalysis,
  };

  return { result, pagination };
};

const getItemWiseSalesOrderAnalysis = async (filter, options) => {
  const { SalesOrder, ItemInventory } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  // Build salesOrder filter
  const salesOrderFilter = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
  };

  if (filter.startDate && filter.endDate) {
    salesOrderFilter.orderDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      salesOrderFilter.branchId = {
        $in: branchArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.warehouseId) {
    const warehouseArray = filter.warehouseId.split(',').filter(Boolean);
    if (warehouseArray.length > 0) {
      salesOrderFilter.warehouseId = {
        $in: warehouseArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.customerId) {
    const customerArray = filter.customerId.split(',').filter(Boolean);
    if (customerArray.length > 0) {
      salesOrderFilter.customerId = {
        $in: customerArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.itemId) {
    const itemArray = filter.itemId.split(',').filter(Boolean);
    if (itemArray.length > 0) {
      salesOrderFilter['items.itemId'] = {
        $in: itemArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.status) {
    salesOrderFilter.status = { $in: filter.status.split(',') };
  } else {
    salesOrderFilter.status = {
      $in: [SALES_ORDER_STATUS.OPEN, SALES_ORDER_STATUS.PARTIALLY_RECORDED, SALES_ORDER_STATUS.DRAFT],
    };
  }

  const invoiceIsSplitFilter = {};
  if (!filter?.isSplit) {
    invoiceIsSplitFilter.isSplit = false;
  }

  // Aggregation pipeline to get sales orders with items
  const salesOrderPipeline = [
    { $match: salesOrderFilter },
    { $sort: { orderDate: -1 } },
    {
      $lookup: {
        from: 'customers',
        localField: 'customerId',
        foreignField: '_id',
        as: 'customer',
      },
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'items',
        let: { itemIds: '$items.itemId' },
        pipeline: [
          {
            $match: {
              $expr: { $in: ['$_id', '$$itemIds'] },
              ...(filter.itemGroupId
                ? { itemGroup: { $in: filter.itemGroupId.split(',').map(id => new mongoose.Types.ObjectId(id)) } }
                : {}),
              ...(filter.itemType ? { itemType: { $in: filter.itemType.split(',') } } : {}),
            },
          },
        ],
        as: 'itemDoc',
      },
    },
  ];

  const salesOrdersRaw = await SalesOrder.aggregate(salesOrderPipeline);

  // Attach itemDoc at item level
  const salesOrders = salesOrdersRaw.map(order => {
    const itemDocsById = {};
    (order.itemDoc || []).forEach(doc => {
      itemDocsById[doc._id.toString()] = doc;
    });

    const itemsWithDoc = (order.items || []).map(it => ({
      ...it,
      itemDoc: it.itemId ? itemDocsById[it.itemId.toString()] : null,
    }));

    return {
      ...order,
      items: itemsWithDoc,
    };
  });

  // Get partial sales orders for challans/invoices
  const partialSalesOrdersIds = salesOrders
    .filter(order => order.status === SALES_ORDER_STATUS.PARTIALLY_RECORDED)
    .map(order => order._id);

  const challans = await DeliveryChallan.find({
    'salesOrders.salesOrderId': { $in: partialSalesOrdersIds },
    ...(filter.companyId ? { companyId: filter.companyId } : {}),
  }).lean();

  const invoices = await Invoice.find({
    'salesOrders.salesOrderId': { $in: partialSalesOrdersIds },
    ...(filter.companyId ? { companyId: filter.companyId } : {}),
    ...invoiceIsSplitFilter,
  }).lean();

  // Group challans and invoices by salesOrderId
  const challansByOrder = challans.reduce((acc, c) => {
    (c.salesOrders || []).forEach(so => {
      const id = so.salesOrderId.toString();
      acc[id] = acc[id] || [];
      acc[id].push(c);
    });
    return acc;
  }, {});

  const invoicesByOrder = invoices.reduce((acc, inv) => {
    (inv.salesOrders || []).forEach(so => {
      const id = so.salesOrderId.toString();
      acc[id] = acc[id] || [];
      acc[id].push(inv);
    });
    return acc;
  }, {});

  // Quantities here are summed per item across orders, so they are all reported in the item's main unit.
  let unitItemMap = await loadUnitItemMap(salesOrders.flatMap(order => (order.items || []).map(item => item.itemId)));

  // Group data by items instead of sales orders
  const itemsMap = new Map();
  const filteredItemId = filter.itemId ? new mongoose.Types.ObjectId(filter.itemId).toString() : null;

  for (const order of salesOrders) {
    const customerDisplayName = order.customer?.customerDisplayName || 'Unknown Customer';

    const orderChallans = challansByOrder[order._id.toString()] || [];
    const orderInvoices = invoicesByOrder[order._id.toString()] || [];

    const deliveredByItem = {};
    orderChallans.forEach(challan => {
      (challan.items || []).forEach(it => {
        const id = it.itemId.toString();
        deliveredByItem[id] = (deliveredByItem[id] || 0) + (it.quantity || 0) * getUnitFactor(unitItemMap, id, it.itemUnitId);
      });
    });

    const invoicedByItem = {};
    orderInvoices.forEach(invoice => {
      (invoice.items || []).forEach(it => {
        const id = it.itemId.toString();
        invoicedByItem[id] = (invoicedByItem[id] || 0) + (it.quantity || 0) * getUnitFactor(unitItemMap, id, it.itemUnitId);
      });
    });

    // Filter items if itemId filter is provided
    const itemsToProcess = filteredItemId
      ? (order.items || []).filter(item => item.itemId?.toString() === filteredItemId)
      : order.items || [];

    itemsToProcess.forEach(orderItem => {
      const itemId = orderItem.itemId?.toString();
      const itemDoc = orderItem.itemDoc;

      if (!itemDoc || !itemId) return;

      const orderedQty = roundQty((orderItem.quantity || 0) * getUnitFactor(unitItemMap, itemId, orderItem.itemUnitId));
      const deliveredQty = deliveredByItem[itemId] || 0;
      const invoicedQty = invoicedByItem[itemId] || 0;
      const remainingQty = orderedQty - (deliveredQty + invoicedQty);

      // Only include items that have remaining quantity
      if (remainingQty <= 0) return;

      // Calculate item-level amount breakdown
      const itemBaseAmount = orderItem.amount || 0;
      const itemTaxAmount = orderItem.taxAmount || 0;
      const itemTotalAmount = itemBaseAmount + itemTaxAmount;
      const itemTaxRate = itemBaseAmount > 0 ? (itemTaxAmount / itemBaseAmount) * 100 : 0;

      if (!itemsMap.has(itemId)) {
        itemsMap.set(itemId, {
          itemDetail: {
            itemId: itemDoc._id,
            itemName: itemDoc.itemName,
            itemNo: itemDoc.itemNo,
          },
          totalRequiredQty: 0,
          availableStock: 0, // Will be calculated later
          salesOrderCount: 0,
          salesOrders: [],
          amount: {
            baseAmount: 0,
            taxAmount: 0,
            totalAmount: 0,
          },
          totalOrderedQty: 0,
        });
      }

      const itemData = itemsMap.get(itemId);

      // Add sales order to this item
      itemData.salesOrders.push({
        salesOrderDetail: {
          salesOrderNo: order.orderId,
          salesOrderId: order._id,
        },
        customerDisplayName,
        orderedQty,
        deliveredQty,
        invoicedQty,
        remainingQty: Math.max(0, remainingQty),
        rate: orderItem.rate || 0,
        amount: {
          baseAmount: itemBaseAmount,
          taxRate: itemTaxRate,
          taxAmount: itemTaxAmount,
          totalAmount: itemTotalAmount,
        },
        stockStatus: 'PENDING', // Will be updated after stock calculation
      });

      // Update totals (only add remaining quantity, not ordered quantity)
      itemData.totalRequiredQty += Math.max(0, remainingQty);
      itemData.totalOrderedQty += orderedQty;
      itemData.salesOrderCount = itemData.salesOrders.length;

      // Only add amounts for remaining quantities
      const remainingRatio = remainingQty > 0 ? remainingQty / orderedQty : 0;
      itemData.amount.baseAmount += itemBaseAmount * remainingRatio;
      itemData.amount.taxAmount += itemTaxAmount * remainingRatio;
      itemData.amount.totalAmount += itemTotalAmount * remainingRatio;
    });
  }

  // Get all unique item IDs for stock calculation
  const allItemIds = Array.from(itemsMap.keys()).map(id => new mongoose.Types.ObjectId(id));

  // Fetch stock directly from ItemInventory
  const itemInventories = await ItemInventory.find({
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    itemId: { $in: allItemIds },
  }).lean();

  const itemStockMap = itemInventories.reduce((acc, inv) => {
    acc[inv.itemId.toString()] = {
      availableStock: inv.totalAvailableStock || 0,
    };
    return acc;
  }, {});

  // Update stock information and status for each item
  const result = [];
  for (const [itemId, itemData] of itemsMap) {
    // Skip items that don't match the itemId filter (if provided)
    if (filteredItemId && itemId !== filteredItemId) {
      continue;
    }

    const itemStock = itemStockMap[itemId] || { availableStock: 0 };
    itemData.availableStock = itemStock.availableStock;

    // Update stock status for each sales order
    itemData.salesOrders.forEach(salesOrder => {
      salesOrder.stockStatus = getStockStatusForItem(salesOrder.remainingQty, itemStock.availableStock);
    });

    // Add overall stock status for the item
    itemData.stockStatus = getStockStatusForItem(itemData.totalRequiredQty, itemStock.availableStock);
    itemData.valuation = itemStock.availableStock * (itemData.salesOrders[0]?.rate || 0);

    result.push(itemData);
  }

  // Sort by item name
  result.sort((a, b) => a.itemDetail.itemName.localeCompare(b.itemDetail.itemName));

  // Calculate totals from ALL matching sales orders (not paginated)
  // Get all sales orders matching the filter for totals calculation
  const totalsPipeline = [
    { $match: salesOrderFilter },
    {
      $lookup: {
        from: 'items',
        let: { itemIds: '$items.itemId' },
        pipeline: [
          {
            $match: {
              $expr: { $in: ['$_id', '$$itemIds'] },
              ...(filter.itemGroupId
                ? { itemGroup: { $in: filter.itemGroupId.split(',').map(id => new mongoose.Types.ObjectId(id)) } }
                : {}),
              ...(filter.itemType ? { itemType: { $in: filter.itemType.split(',') } } : {}),
            },
          },
        ],
        as: 'itemDoc',
      },
    },
  ];

  const allSalesOrdersForTotals = await SalesOrder.aggregate(totalsPipeline);
  unitItemMap = await loadUnitItemMap(allSalesOrdersForTotals.flatMap(order => (order.items || []).map(item => item.itemId)));

  // Get partial sales orders for challans/invoices (for all matching orders)
  const allPartialSalesOrdersIds = allSalesOrdersForTotals
    .filter(order => order.status === SALES_ORDER_STATUS.PARTIALLY_RECORDED)
    .map(order => order._id);

  const allChallans = await DeliveryChallan.find({
    'salesOrders.salesOrderId': { $in: allPartialSalesOrdersIds },
    ...(filter.companyId ? { companyId: filter.companyId } : {}),
  }).lean();

  const allInvoices = await Invoice.find({
    'salesOrders.salesOrderId': { $in: allPartialSalesOrdersIds },
    ...(filter.companyId ? { companyId: filter.companyId } : {}),
    ...invoiceIsSplitFilter,
  }).lean();

  // Group challans and invoices by salesOrderId
  const allChallansByOrder = allChallans.reduce((acc, c) => {
    (c.salesOrders || []).forEach(so => {
      const id = so.salesOrderId.toString();
      acc[id] = acc[id] || [];
      acc[id].push(c);
    });
    return acc;
  }, {});

  const allInvoicesByOrder = allInvoices.reduce((acc, inv) => {
    (inv.salesOrders || []).forEach(so => {
      const id = so.salesOrderId.toString();
      acc[id] = acc[id] || [];
      acc[id].push(inv);
    });
    return acc;
  }, {});

  // Calculate totals from all matching sales orders
  const uniqueSalesOrderIds = new Set();
  const uniqueItemIds = new Set();
  let totalOrderedQty = 0;
  let totalRequiredQty = 0;
  let totalAmount = 0;

  for (const order of allSalesOrdersForTotals) {
    const orderChallans = allChallansByOrder[order._id.toString()] || [];
    const orderInvoices = allInvoicesByOrder[order._id.toString()] || [];

    const deliveredByItem = {};
    orderChallans.forEach(challan => {
      (challan.items || []).forEach(it => {
        const id = it.itemId.toString();
        deliveredByItem[id] = (deliveredByItem[id] || 0) + (it.quantity || 0) * getUnitFactor(unitItemMap, id, it.itemUnitId);
      });
    });

    const invoicedByItem = {};
    orderInvoices.forEach(invoice => {
      (invoice.items || []).forEach(it => {
        const id = it.itemId.toString();
        invoicedByItem[id] = (invoicedByItem[id] || 0) + (it.quantity || 0) * getUnitFactor(unitItemMap, id, it.itemUnitId);
      });
    });

    // Filter items if itemId filter is provided
    const itemsToProcess = filteredItemId
      ? (order.items || []).filter(item => item.itemId?.toString() === filteredItemId)
      : order.items || [];

    // Also filter by itemGroupId and itemType if provided
    let filteredItems = itemsToProcess;
    if (filter.itemGroupId || filter.itemType) {
      const itemDocsById = {};
      (order.itemDoc || []).forEach(doc => {
        itemDocsById[doc._id.toString()] = doc;
      });

      filteredItems = itemsToProcess.filter(item => {
        const itemDoc = itemDocsById[item.itemId?.toString()];
        if (!itemDoc) return false;

        if (filter.itemGroupId) {
          const itemGroupArray = filter.itemGroupId.split(',').map(id => id.toString());
          if (!itemGroupArray.includes(itemDoc.itemGroup?.toString())) return false;
        }

        if (filter.itemType) {
          const itemTypeArray = filter.itemType.split(',');
          if (!itemTypeArray.includes(itemDoc.itemType)) return false;
        }

        return true;
      });
    }

    let hasRemainingQty = false;
    let orderOrderedQty = 0;

    filteredItems.forEach(orderItem => {
      const itemId = orderItem.itemId?.toString();
      const itemOrderedQty = roundQty((orderItem.quantity || 0) * getUnitFactor(unitItemMap, itemId, orderItem.itemUnitId));
      const deliveredQty = deliveredByItem[itemId] || 0;
      const invoicedQty = invoicedByItem[itemId] || 0;
      const remainingQty = itemOrderedQty - (deliveredQty + invoicedQty);

      orderOrderedQty += itemOrderedQty;

      if (remainingQty > 0) {
        hasRemainingQty = true;
        totalRequiredQty += remainingQty;
        // Count unique items
        if (itemId) {
          uniqueItemIds.add(itemId);
        }
      }
    });

    // Only count sales orders that have items with remaining quantities
    if (hasRemainingQty && filteredItems.length > 0) {
      uniqueSalesOrderIds.add(order._id.toString());
      totalOrderedQty += orderOrderedQty;
      // Use sales order total amount, not item amounts
      totalAmount += (order.total || 0) * (order.exchangeRate ?? 1);
    }
  }

  // Apply pagination
  const page = parseInt(options.page, 10) || 1;
  const limit = parseInt(options.limit, 10) || 10;
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;

  const paginatedResult = result.slice(startIndex, endIndex);

  const pagination = {
    page,
    limit,
    totalResults: result.length,
    totalPages: Math.ceil(result.length / limit),
    totalSalesOrders: uniqueSalesOrderIds.size,
    totalUniqueItems: uniqueItemIds.size,
    totalOrderedQty,
    totalRequiredQty,
    totalAmount,
  };

  return { result: paginatedResult, pagination };
};

const PENDING_SALES_ORDER_STATUSES = [SALES_ORDER_STATUS.OPEN, SALES_ORDER_STATUS.PARTIALLY_RECORDED, SALES_ORDER_STATUS.DRAFT];

const toObjectIdArray = value => {
  if (!value) return [];
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(id => new mongoose.Types.ObjectId(id));
};

const buildSalesOrderMatch = filter => {
  const salesOrderMatch = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    status: { $in: PENDING_SALES_ORDER_STATUSES },
  };

  if (filter.startDate && filter.endDate) {
    salesOrderMatch.orderDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  const branchIds = toObjectIdArray(filter.branchId);
  if (branchIds.length) {
    salesOrderMatch.branchId = { $in: branchIds };
  }

  const divisionIds = toObjectIdArray(filter.divisionId);
  if (divisionIds.length) {
    salesOrderMatch.divisionId = { $in: divisionIds };
  }

  const customerIds = toObjectIdArray(filter.customerId);
  if (customerIds.length) {
    salesOrderMatch.customerId = { $in: customerIds };
  }

  return salesOrderMatch;
};

const getCustomerWiseSalesOrderAnalysis = async (filter, options) => {
  const { SalesOrder } = getBooksCrmModels();

  const page = Math.max(parseInt(options.page, 10) || 1, 1);
  const limit = Math.max(parseInt(options.limit, 10) || 10, 1);
  const skip = (page - 1) * limit;

  const salesOrderMatch = buildSalesOrderMatch(filter);
  const itemIds = toObjectIdArray(filter.itemId);
  const hasItemIdFilter = itemIds.length > 0;

  const sortFieldMap = {
    customerName: 'customerName',
    oldestOrderDate: 'oldestOrderDate',
    totalPendingValue: 'totalPendingValue',
    totalQuantity: 'totalQuantity',
    pendingSalesOrder: 'pendingSalesOrder',
  };

  let sortStage = [{ $sort: { oldestOrderDate: 1, customerName: 1 } }];

  if (options.sortBy) {
    const [sortFieldRaw, sortOrderRaw] = options.sortBy.split(':');
    const mappedSortField = sortFieldMap[sortFieldRaw];

    if (mappedSortField) {
      sortStage = [
        {
          $sort: {
            [mappedSortField]: sortOrderRaw === 'desc' ? -1 : 1,
            customerName: 1,
          },
        },
      ];
    }
  }

  const summaryPipeline = [
    { $match: salesOrderMatch },
    { $unwind: '$items' },
    ...(hasItemIdFilter
      ? [
          {
            $match: {
              'items.itemId': { $in: itemIds },
            },
          },
        ]
      : []),
    {
      $project: {
        customerId: 1,
        orderDate: 1,
        salesOrderId: '$_id',
        quantity: { $ifNull: ['$items.quantity', 0] },
        itemTotalAmount: {
          $add: [{ $ifNull: ['$items.amount', 0] }, { $ifNull: ['$items.taxAmount', 0] }],
        },
      },
    },
    {
      $group: {
        _id: '$customerId',
        pendingSalesOrderIds: { $addToSet: '$salesOrderId' },
        oldestOrderDate: { $min: '$orderDate' },
        totalPendingValue: { $sum: '$itemTotalAmount' },
        totalQuantity: { $sum: '$quantity' },
      },
    },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customer',
      },
    },
    {
      $unwind: {
        path: '$customer',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        _id: 0,
        customerId: '$_id',
        customerName: '$customer.customerDisplayName',
        pendingSalesOrder: { $size: '$pendingSalesOrderIds' },
        oldestOrderDate: 1,
        totalPendingValue: { $round: ['$totalPendingValue', 2] },
        totalQuantity: { $round: ['$totalQuantity', 2] },
      },
    },
    {
      $addFields: {
        customerName: { $ifNull: ['$customerName', 'Unknown Customer'] },
      },
    },
    ...sortStage,
    {
      $facet: {
        rows: [{ $skip: skip }, { $limit: limit }],
        totalCount: [{ $count: 'count' }],
        grandTotals: [
          {
            $group: {
              _id: null,
              totalQuantity: { $sum: '$totalQuantity' },
              totalPendingOrders: { $sum: '$pendingSalesOrder' },
              totalPendingValue: { $sum: '$totalPendingValue' },
            },
          },
        ],
      },
    },
  ];

  const [summaryResult = {}] = await SalesOrder.aggregate(summaryPipeline);

  const customerRows = summaryResult.rows || [];
  const totalCount = summaryResult.totalCount?.[0]?.count || 0;
  const grandTotals = summaryResult.grandTotals?.[0] || {
    totalQuantity: 0,
    totalPendingOrders: 0,
    totalPendingValue: 0,
  };

  if (!customerRows.length) {
    return {
      result: [],
      pagination: {
        page,
        limit,
        totalResults: 0,
        totalPages: 0,
        totalQuantity: 0,
        totalPendingOrders: 0,
        totalPendingValue: 0,
      },
    };
  }

  const paginatedCustomerIds = customerRows.map(row => row.customerId).filter(Boolean);

  const itemDetailPipeline = [
    {
      $match: {
        ...salesOrderMatch,
        customerId: { $in: paginatedCustomerIds },
      },
    },
    { $unwind: '$items' },
    ...(hasItemIdFilter
      ? [
          {
            $match: {
              'items.itemId': { $in: itemIds },
            },
          },
        ]
      : []),
    {
      $lookup: {
        from: 'items',
        localField: 'items.itemId',
        foreignField: '_id',
        as: 'itemDoc',
      },
    },
    {
      $unwind: {
        path: '$itemDoc',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        customerId: 1,
        orderDate: 1,
        salesOrderId: '$_id',
        salesOrderNo: '$orderId',
        itemId: '$items.itemId',
        itemName: '$itemDoc.itemName',
        itemNo: '$itemDoc.itemNo',
        quantity: { $ifNull: ['$items.quantity', 0] },
        itemTotalAmount: {
          $add: [{ $ifNull: ['$items.amount', 0] }, { $ifNull: ['$items.taxAmount', 0] }],
        },
      },
    },
    {
      $group: {
        _id: {
          customerId: '$customerId',
          itemId: '$itemId',
        },
        customerId: { $first: '$customerId' },
        itemId: { $first: '$itemId' },
        itemName: { $first: '$itemName' },
        itemNo: { $first: '$itemNo' },
        quantity: { $sum: '$quantity' },
        pendingOrderIds: { $addToSet: '$salesOrderId' },
        oldestOrderDate: { $min: '$orderDate' },
        totalPendingValue: { $sum: '$itemTotalAmount' },
        salesOrders: { $addToSet: { salesOrderId: '$salesOrderId', salesOrderNo: '$salesOrderNo' } },
      },
    },
    {
      $project: {
        _id: 0,
        customerId: 1,
        itemId: 1,
        itemName: { $ifNull: ['$itemName', 'Unknown Item'] },
        itemNo: { $ifNull: ['$itemNo', '-'] },
        quantity: { $round: ['$quantity', 2] },
        noOfPendingOrders: { $size: '$pendingOrderIds' },
        oldestOrderDate: 1,
        totalPendingValue: { $round: ['$totalPendingValue', 2] },
        salesOrders: 1,
      },
    },
    { $sort: { itemName: 1 } },
  ];

  const itemRows = await SalesOrder.aggregate(itemDetailPipeline);

  const itemsByCustomerId = itemRows.reduce((acc, item) => {
    const customerId = item.customerId?.toString();
    if (!customerId) return acc;
    if (!acc[customerId]) acc[customerId] = [];
    acc[customerId].push({
      itemId: item.itemId,
      itemName: item.itemName,
      itemNo: item.itemNo,
      quantity: item.quantity,
      noOfPendingOrders: item.noOfPendingOrders,
      oldestOrderDate: item.oldestOrderDate,
      totalPendingValue: item.totalPendingValue,
      salesOrders: item.salesOrders || [],
    });
    return acc;
  }, {});

  const result = customerRows.map(customer => ({
    customerId: customer.customerId,
    customerName: customer.customerName || 'Unknown Customer',
    pendingSalesOrder: customer.pendingSalesOrder,
    oldestOrderDate: customer.oldestOrderDate,
    totalPendingValue: customer.totalPendingValue,
    totalQuantity: customer.totalQuantity,
    items: itemsByCustomerId[customer.customerId?.toString()] || [],
  }));

  return {
    result,
    pagination: {
      page,
      limit,
      totalResults: totalCount,
      totalPages: Math.ceil(totalCount / limit),
      totalQuantity: Number((grandTotals.totalQuantity || 0).toFixed(2)),
      totalPendingOrders: grandTotals.totalPendingOrders || 0,
      totalPendingValue: Number((grandTotals.totalPendingValue || 0).toFixed(2)),
    },
  };
};

const getNewVsOldCustomerReport = async (filter, options = {}) => {
  const { SalesOrder, PaymentReceived } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  const salesOrderFilter = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    customerId: { $exists: true, $ne: null },
  };

  if (filter.startDate && filter.endDate) {
    salesOrderFilter.orderDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      salesOrderFilter.branchId = {
        $in: branchArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      salesOrderFilter.divisionId = {
        $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.customerId) {
    const customerArray = filter.customerId.split(',').filter(Boolean);
    if (customerArray.length > 0) {
      salesOrderFilter.customerId = {
        $in: customerArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.itemId) {
    const itemArray = filter.itemId.split(',').filter(Boolean);
    if (itemArray.length > 0) {
      salesOrderFilter['items.itemId'] = {
        $in: itemArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.status) {
    salesOrderFilter.status = { $in: filter.status.split(',') };
  } else {
    salesOrderFilter.status = {
      $in: [
        SALES_ORDER_STATUS.OPEN,
        SALES_ORDER_STATUS.PARTIALLY_RECORDED,
        SALES_ORDER_STATUS.DRAFT,
        SALES_ORDER_STATUS.COMPLETED,
      ],
    };
  }

  // Optimized: aggregate by customer (no full document load) to avoid timeout on large datasets
  const { orderDate, customerId, ...salesOrderMatchRest } = salesOrderFilter;

  const salesOrderPipeline = [
    { $match: salesOrderFilter },
    {
      $group: {
        _id: '$customerId',
        totalOrders: { $sum: 1 },
        totalAmount: { $sum: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
        firstOrderDate: { $min: '$orderDate' },
        lastOrderDate: { $max: '$orderDate' },
      },
    },
    ...(filter.startDate && filter.endDate
      ? [
          {
            $lookup: {
              from: SalesOrder.collection.name,
              let: { cid: '$_id' },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ['$customerId', '$$cid'] },
                    ...salesOrderMatchRest,
                    orderDate: { $lt: new Date(filter.startDate) },
                  },
                },
                { $limit: 1 },
              ],
              as: '_priorOrder',
            },
          },
          {
            $addFields: {
              hasPriorOrders: { $gt: [{ $size: '$_priorOrder' }, 0] },
            },
          },
          { $project: { _priorOrder: 0 } },
        ]
      : []),
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customer',
      },
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: false } },
    {
      $project: {
        customerId: { $toString: '$_id' },
        customerName: { $ifNull: ['$customer.customerDisplayName', 'Unknown Customer'] },
        totalOrders: 1,
        totalAmount: 1,
        firstOrderDate: 1,
        lastOrderDate: 1,
        hasPriorOrders: { $ifNull: ['$hasPriorOrders', false] },
      },
    },
  ];

  const customersFromOrders = await SalesOrder.aggregate(salesOrderPipeline);

  if (customersFromOrders.length === 0) {
    const oldPage = parseInt(options.oldPage ?? options.page ?? 1);
    const oldLimit = parseInt(options.oldLimit ?? options.limit ?? 10);
    const newPage = parseInt(options.newPage ?? options.page ?? 1);
    const newLimit = parseInt(options.newLimit ?? options.limit ?? 10);
    const pagination = options.pagination
      ? {
          oldCustomerPagination: { page: oldPage, limit: oldLimit, totalResults: 0, totalPages: 0 },
          newCustomerPagination: { page: newPage, limit: newLimit, totalResults: 0, totalPages: 0 },
        }
      : null;
    const emptyStats = {
      totalCustomers: 0,
      totalOrders: 0,
      ordersTotalAmount: 0,
      deliveryChallansTotalAmount: 0,
      invoicesTotalAmount: 0,
      paymentsTotalAmount: 0,
    };
    return {
      result: {
        oldCustomers: [],
        newCustomers: [],
        oldCustomersStats: { ...emptyStats },
        newCustomersStats: { ...emptyStats },
      },
      pagination,
    };
  }

  const customerObjectIds = customersFromOrders.map(c => new mongoose.Types.ObjectId(c.customerId));

  const challanFilter = {
    customerId: { $in: customerObjectIds },
    status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
    ...(filter.companyId ? { companyId: new mongoose.Types.ObjectId(filter.companyId) } : {}),
  };
  if (filter.startDate && filter.endDate) {
    challanFilter.challanDate = { $gte: new Date(filter.startDate), $lte: new Date(filter.endDate) };
  }

  const invoiceFilter = {
    customerId: { $in: customerObjectIds },
    status: { $ne: INVOICE_STATUS.CANCELLED },
    isSplit: { $ne: true },
    ...(filter.companyId ? { companyId: new mongoose.Types.ObjectId(filter.companyId) } : {}),
  };
  if (filter.startDate && filter.endDate) {
    invoiceFilter.invoiceDate = { $gte: new Date(filter.startDate), $lte: new Date(filter.endDate) };
  }

  const paymentFilter = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    customerId: { $in: customerObjectIds },
    status: { $ne: PAYMENT_STATUS.CANCELLED },
    isSplit: { $ne: true },
  };
  if (filter.startDate && filter.endDate) {
    paymentFilter.paymentDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  // Optimized: count and sum amounts by customer via aggregation
  const [challanAgg, invoiceAgg, paymentAgg] = await Promise.all([
    DeliveryChallan.aggregate([
      { $match: challanFilter },
      {
        $group: {
          _id: '$customerId',
          totalDeliveryChallans: { $sum: 1 },
          deliveryChallansTotalAmount: { $sum: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
        },
      },
    ]),
    Invoice.aggregate([
      { $match: invoiceFilter },
      {
        $group: {
          _id: '$customerId',
          totalInvoices: { $sum: 1 },
          invoicesTotalAmount: { $sum: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
        },
      },
    ]),
    PaymentReceived.aggregate([
      { $match: paymentFilter },
      {
        $group: {
          _id: '$customerId',
          totalPayments: { $sum: 1 },
          paymentsTotalAmount: { $sum: { $multiply: [{ $ifNull: ['$amountReceived', 0] }, { $ifNull: ['$exchangeRate', 1] }] } },
        },
      },
    ]),
  ]);

  const challanByCustomer = new Map(
    challanAgg.map(c => [c._id.toString(), { count: c.totalDeliveryChallans, amount: c.deliveryChallansTotalAmount }]),
  );
  const invoiceByCustomer = new Map(
    invoiceAgg.map(c => [c._id.toString(), { count: c.totalInvoices, amount: c.invoicesTotalAmount }]),
  );
  const paymentByCustomer = new Map(
    paymentAgg.map(c => [c._id.toString(), { count: c.totalPayments, amount: c.paymentsTotalAmount }]),
  );

  const allCustomers = customersFromOrders.map(c => {
    const challan = challanByCustomer.get(c.customerId);
    const inv = invoiceByCustomer.get(c.customerId);
    const pay = paymentByCustomer.get(c.customerId);
    return {
      customerId: c.customerId,
      customerName: c.customerName,
      totalOrders: c.totalOrders,
      ordersTotalAmount: c.totalAmount,
      totalDeliveryChallans: challan?.count ?? 0,
      deliveryChallansTotalAmount: challan?.amount ?? 0,
      totalInvoices: inv?.count ?? 0,
      invoicesTotalAmount: inv?.amount ?? 0,
      totalPayments: pay?.count ?? 0,
      paymentsTotalAmount: pay?.amount ?? 0,
      firstOrderDate: c.firstOrderDate,
      lastOrderDate: c.lastOrderDate,
      hasPriorOrders: c.hasPriorOrders,
    };
  });

  // Separate old and new customers:
  // Without date filter: new = exactly 1 sales order; old = more than 1.
  // With date filter: new = exactly 1 order in range and no qualifying orders before the range; old = otherwise.
  const oldCustomers = [];
  const newCustomers = [];

  allCustomers.forEach(customer => {
    if (customer.totalOrders === 1 && !customer.hasPriorOrders) {
      newCustomers.push(customer);
    } else {
      oldCustomers.push(customer);
    }
  });

  // Sort customers by orders total amount (highest first)
  oldCustomers.sort((a, b) => b.ordersTotalAmount - a.ordersTotalAmount);
  newCustomers.sort((a, b) => b.ordersTotalAmount - a.ordersTotalAmount);

  // Calculate summary statistics
  const oldCustomersStats = {
    totalCustomers: oldCustomers.length,
    totalOrders: oldCustomers.reduce((sum, c) => sum + c.totalOrders, 0),
    totalRevenue: oldCustomers.reduce((sum, c) => sum + c.ordersTotalAmount, 0),
    totalDeliveryChallans: oldCustomers.reduce((sum, c) => sum + c.totalDeliveryChallans, 0),
    totalInvoices: oldCustomers.reduce((sum, c) => sum + c.totalInvoices, 0),
    totalPayments: oldCustomers.reduce((sum, c) => sum + c.totalPayments, 0),
  };

  const newCustomersStats = {
    totalCustomers: newCustomers.length,
    totalOrders: newCustomers.reduce((sum, c) => sum + c.totalOrders, 0),
    totalRevenue: newCustomers.reduce((sum, c) => sum + c.ordersTotalAmount, 0),
    deliveryChallansTotalAmount: newCustomers.reduce((sum, c) => sum + c.totalDeliveryChallans, 0),
    totalDeliveryChallans: newCustomers.reduce((sum, c) => sum + c.totalDeliveryChallans, 0),
    totalInvoices: newCustomers.reduce((sum, c) => sum + c.totalInvoices, 0),
    totalPayments: newCustomers.reduce((sum, c) => sum + c.totalPayments, 0),
  };

  // per-type page/limit with fallbacks to options.page/options.limit then defaults
  const oldPage = parseInt(options.oldPage ?? options.page ?? 1);
  const oldLimit = parseInt(options.oldLimit ?? options.limit ?? 10);
  const newPage = parseInt(options.newPage ?? options.page ?? 1);
  const newLimit = parseInt(options.newLimit ?? options.limit ?? 10);

  const paginate = (arr, page, limit) => {
    const start = (page - 1) * limit;
    const end = start + limit;
    return arr.slice(start, end);
  };

  let paginatedOldCustomers = [];
  let paginatedNewCustomers = [];

  if (filter.customerType === 'old') {
    paginatedOldCustomers = paginate(oldCustomers, oldPage, oldLimit);
    paginatedNewCustomers = [];
  } else if (filter.customerType === 'new') {
    paginatedOldCustomers = [];
    paginatedNewCustomers = paginate(newCustomers, newPage, newLimit);
  } else {
    // Always paginate both independently and return both arrays
    paginatedOldCustomers = paginate(oldCustomers, oldPage, oldLimit);
    paginatedNewCustomers = paginate(newCustomers, newPage, newLimit);
  }

  const pagination = options.pagination
    ? {
        oldCustomerPagination: {
          page: oldPage,
          limit: oldLimit,
          totalResults: oldCustomers.length,
          totalPages: Math.ceil(oldCustomers.length / oldLimit),
        },
        newCustomerPagination: {
          page: newPage,
          limit: newLimit,
          totalResults: newCustomers.length,
          totalPages: Math.ceil(newCustomers.length / newLimit),
        },
      }
    : null;

  return {
    result: {
      oldCustomers: paginatedOldCustomers,
      newCustomers: paginatedNewCustomers,
      oldCustomersStats,
      newCustomersStats,
    },
    pagination,
  };
};
const VALID_MODULE_NAMES = ['salesOrders', 'deliveryChallans', 'invoices', 'payments'];

const getNewVsOldCustomerReportModuleData = async filter => {
  const { SalesOrder, PaymentReceived, Customer } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();

  const { companyId, customerId, moduleName, page = 1, limit = 10 } = filter;

  if (!companyId || !customerId || !moduleName) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'companyId, customerId and moduleName are required');
  }
  if (!VALID_MODULE_NAMES.includes(moduleName)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `moduleName must be one of: ${VALID_MODULE_NAMES.join(', ')}`);
  }

  const customerObjectId = new mongoose.Types.ObjectId(customerId);
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const customer = await Customer.findById(customerObjectId).select('customerNumber customerDisplayName').lean();

  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Customer not found');
  }

  const customerNumber = customer.customerNumber;
  const customerName = customer.customerDisplayName;

  const skip = (Number(page) - 1) * Number(limit);
  const limitNum = Number(limit);

  let matchQuery = {
    companyId: companyObjectId,
    customerId: customerObjectId,
  };

  let pipeline = [];
  let sortField = 'date';

  if (moduleName === 'salesOrders') {
    matchQuery.status = {
      $in: [
        SALES_ORDER_STATUS.OPEN,
        SALES_ORDER_STATUS.PARTIALLY_RECORDED,
        SALES_ORDER_STATUS.DRAFT,
        SALES_ORDER_STATUS.COMPLETED,
      ],
    };
    pipeline = [
      { $match: matchQuery },
      {
        $project: {
          _id: 1,
          orderId: 1,
          date: '$orderDate',
          amount: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          status: 1,
          itemCount: { $size: { $ifNull: ['$items', []] } },
        },
      },
    ];
  } else if (moduleName === 'deliveryChallans') {
    matchQuery.status = { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED };
    pipeline = [
      { $match: matchQuery },
      {
        $project: {
          _id: 1,
          deliveryChallanId: '$challanId',
          date: '$challanDate',
          amount: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          status: 1,
          itemCount: { $size: { $ifNull: ['$items', []] } },
        },
      },
    ];
  } else if (moduleName === 'invoices') {
    matchQuery.status = { $ne: INVOICE_STATUS.CANCELLED };
    matchQuery.isSplit = { $ne: true };
    pipeline = [
      { $match: matchQuery },
      {
        $project: {
          _id: 1,
          invoiceId: 1,
          date: '$invoiceDate',
          amount: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          status: 1,
          itemCount: { $size: { $ifNull: ['$items', []] } },
        },
      },
    ];
  } else if (moduleName === 'payments') {
    matchQuery.status = { $ne: PAYMENT_STATUS.CANCELLED };
    matchQuery.isSplit = { $ne: true };
    pipeline = [
      { $match: matchQuery },
      {
        $project: {
          _id: 1,
          paymentReceivedId: 1,
          date: '$paymentDate',
          amount: { $multiply: [{ $ifNull: ['$amountReceived', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          status: 1,
        },
      },
    ];
  }

  const aggregatePipeline = [
    ...pipeline,
    {
      $facet: {
        metadata: [
          {
            $group: {
              _id: null,
              totalRecord: { $sum: 1 },
              totalAmount: { $sum: '$amount' },
            },
          },
        ],
        data: [
          { $sort: { [sortField]: -1 } },
          { $skip: skip },
          { $limit: limitNum },
          {
            $addFields: {
              customerId: customerObjectId,
              customerNumber,
              customerName,
            },
          },
        ],
      },
    },
    {
      $project: {
        metadata: { $arrayElemAt: ['$metadata', 0] },
        data: 1,
      },
    },
  ];

  let Model;
  if (moduleName === 'salesOrders') Model = SalesOrder;
  if (moduleName === 'deliveryChallans') Model = DeliveryChallan;
  if (moduleName === 'invoices') Model = Invoice;
  if (moduleName === 'payments') Model = PaymentReceived;

  const result = await Model.aggregate(aggregatePipeline);
  const finalResult = result[0] || { metadata: { totalRecord: 0, totalAmount: 0 }, data: [] };

  const totalRecord = finalResult.metadata?.totalRecord || 0;
  const totalAmount = finalResult.metadata?.totalAmount || 0;
  const totalPages = Math.ceil(totalRecord / limitNum) || 1;

  return {
    customerId: customerObjectId,
    customerNumber,
    customerName,
    totalRecord,
    totalAmount,
    data: finalResult.data,
    pagination: {
      page: Number(page),
      limit: Number(limit),
      totalResults: totalRecord,
      totalPages,
    },
  };
};

async function getRemainingAmountForSalesOrder(salesOrderId) {
  const { DeliveryChallan, Invoice } = getBooksModels();
  const { SalesOrder } = getBooksCrmModels();

  const order = await SalesOrder.findById(salesOrderId).lean();
  if (!order) return 0;
  const includeStatus = [SALES_ORDER_STATUS.DRAFT, SALES_ORDER_STATUS.OPEN, SALES_ORDER_STATUS.PARTIALLY_RECORDED];

  if (!includeStatus.includes(order.status)) {
    return 0;
  }

  if (order.status === SALES_ORDER_STATUS.OPEN || order.status === SALES_ORDER_STATUS.DRAFT) {
    return order.total || 0;
  }

  let remainingAmount = 0;
  const deliveredByItem = {};
  const invoicedByItem = {};

  const challans = await DeliveryChallan.find({
    'salesOrders.salesOrderId': salesOrderId,
  }).lean();

  const invoices = await Invoice.find({
    'salesOrders.salesOrderId': salesOrderId,
  }).lean();

  challans.forEach(challan => {
    (challan.items || []).forEach(item => {
      const itemId = item.itemId?.toString();
      if (itemId) {
        deliveredByItem[itemId] = (deliveredByItem[itemId] || 0) + (item.quantity || 0);
      }
    });
  });

  // Build invoiced quantities
  invoices.forEach(invoice => {
    (invoice.items || []).forEach(item => {
      const itemId = item.itemId?.toString();
      if (itemId) {
        invoicedByItem[itemId] = (invoicedByItem[itemId] || 0) + (item.quantity || 0);
      }
    });
  });

  (order.items || []).forEach(orderItem => {
    const itemId = orderItem.itemId?.toString();
    const orderedQty = orderItem.quantity || 0;

    const deliveredQty = deliveredByItem[itemId] || 0;
    const invoicedQty = invoicedByItem[itemId] || 0;

    const remainingQty = orderedQty - (deliveredQty + invoicedQty);

    if (remainingQty > 0) {
      const gstPercentage = getGstRateForCalculation(orderItem.gst);
      const gstAmount = (remainingQty * (orderItem.rate || 0) * gstPercentage) / 100;
      remainingAmount += remainingQty * (orderItem.rate || 0) + gstAmount;
    }
  });

  return remainingAmount;
}

const salesOrderAnalysis = async filter => {
  const { SalesOrder, Item, ItemInventory } = getBooksCrmModels();
  const { Invoice, DeliveryChallan } = getBooksModels();
  const salesOrderFilter = { companyId: new mongoose.Types.ObjectId(filter?.companyId) };
  if (filter?.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      salesOrderFilter.status = {
        $in: statusArray,
      };
    }
  }

  if (filter?.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      salesOrderFilter.branchId = {
        $in: branchArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter?.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      salesOrderFilter.divisionId = {
        $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter?.customerId) {
    const customerArray = filter.customerId.split(',').filter(Boolean);
    if (customerArray.length > 0) {
      salesOrderFilter.customerId = {
        $in: customerArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter?.itemId) {
    const itemArray = filter.itemId.split(',').filter(Boolean);
    if (itemArray.length > 0) {
      salesOrderFilter['items.itemId'] = {
        $in: itemArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  const itemIds =
    filter?.itemId
      ?.split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id)) || [];

  const salesOrder = await SalesOrder.aggregate([
    { $match: salesOrderFilter },

    {
      $addFields: {
        items: itemIds.length
          ? {
              $filter: {
                input: '$items',
                as: 'item',
                cond: {
                  $cond: {
                    if: { $isArray: '$$item.itemId' },
                    then: {
                      $gt: [
                        {
                          $size: {
                            $setIntersection: ['$$item.itemId', itemIds],
                          },
                        },
                        0,
                      ],
                    },
                    else: { $in: ['$$item.itemId', itemIds] },
                  },
                },
              },
            }
          : '$items',
      },
    },

    {
      $addFields: {
        items: {
          $map: {
            input: '$items',
            as: 'item',
            in: {
              $mergeObjects: [
                '$$item',
                {
                  itemIdArr: {
                    $cond: {
                      if: { $isArray: '$$item.itemId' },
                      then: '$$item.itemId',
                      else: ['$$item.itemId'],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },

    {
      $lookup: {
        from: 'items',
        let: {
          allItemIds: {
            $reduce: {
              input: '$items.itemIdArr',
              initialValue: [],
              in: { $setUnion: ['$$value', '$$this'] },
            },
          },
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $in: ['$_id', '$$allItemIds'] },
                  {
                    $gt: [
                      {
                        $size: {
                          $ifNull: ['$productionData.bomBased', []],
                        },
                      },
                      0,
                    ],
                  },
                ],
              },
            },
          },
          { $project: { _id: 1 } },
        ],
        as: 'validBomItems',
      },
    },

    {
      $addFields: {
        items: {
          $filter: {
            input: '$items',
            as: 'item',
            cond: {
              $gt: [
                {
                  $size: {
                    $setIntersection: ['$$item.itemIdArr', '$validBomItems._id'],
                  },
                },
                0,
              ],
            },
          },
        },
      },
    },

    {
      $match: {
        'items.0': { $exists: true },
      },
    },

    {
      $lookup: {
        from: 'customers',
        localField: 'customerId',
        foreignField: '_id',
        as: 'customer',
      },
    },
    { $unwind: { path: '$customer', preserveNullAndEmptyArrays: true } },

    {
      $lookup: {
        from: 'branches',
        localField: 'branchId',
        foreignField: '_id',
        as: 'branch',
      },
    },
    { $unwind: { path: '$branch', preserveNullAndEmptyArrays: true } },

    {
      $lookup: {
        from: 'divisions',
        localField: 'divisionId',
        foreignField: '_id',
        as: 'division',
      },
    },
    { $unwind: { path: '$division', preserveNullAndEmptyArrays: true } },

    {
      $project: {
        items: 1,
        orderId: 1,
        orderDate: 1,
        deliveryMethod: 1,
        total: 1,
        status: 1,
        createdAt: 1,

        customerId: '$customer._id',
        customerName: '$customer.customerDisplayName',

        branchId: '$branch._id',
        branchName: '$branch.name',

        divisionId: '$division._id',
        divisionName: '$division.name',

        warehouseId: 1,
      },
    },
  ]);

  const result = [];
  const allItemIds = new Set();

  for (let order of salesOrder) {
    order.items.forEach(i => allItemIds.add(i.itemId.toString()));
  }

  const items = await Item.find({ _id: { $in: [...allItemIds] } }, { itemName: 1 }).lean();

  const itemMap = new Map(items.map(i => [i._id.toString(), i.itemName]));
  for (let order of salesOrder) {
    const soId = new mongoose.Types.ObjectId(order._id);
    const itemIds = order.items.map(i => i.itemId);

    let updatedItems = order.items;

    const [deliveryChallan, invoice] = await Promise.all([
      DeliveryChallan.aggregate([
        {
          $match: {
            'salesOrders.salesOrderId': soId,
            'items.referenceId': soId,
            status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
          },
        },
        { $unwind: '$items' },
        { $match: { 'items.referenceId': soId, 'items.itemId': { $in: itemIds } } },
        { $group: { _id: '$items.itemId', totalQty: { $sum: '$items.quantity' } } },
      ]),
      Invoice.aggregate([
        {
          $match: {
            'salesOrders.salesOrderId': soId,
            'items.referenceId': soId,
            status: { $ne: INVOICE_STATUS.CANCELLED },
          },
        },
        { $unwind: '$items' },
        { $match: { 'items.referenceId': soId, 'items.itemId': { $in: itemIds } } },
        { $group: { _id: '$items.itemId', totalQty: { $sum: '$items.quantity' } } },
      ]),
    ]);

    const dcMap = new Map(deliveryChallan.map(d => [d._id.toString(), d.totalQty]));
    const invMap = new Map(invoice.map(i => [i._id.toString(), i.totalQty]));

    updatedItems = order.items.map(item => {
      const id = item.itemId.toString();

      const billedQty = (dcMap.get(id) || 0) + (invMap.get(id) || 0);

      return {
        ...item,
        itemName: itemMap.get(id),
        remainingQty: Math.max(item.quantity - billedQty, 0),
      };
    });

    result.push({
      ...order,
      items: updatedItems,
    });
  }

  for (let order of result) {
    for (let i of order?.items) {
      const item = await Item.findById(i.itemId);
      const rmItems = [];
      if (item?.productionData?.bomBased?.length > 0) {
        const itemRemainingQty = i?.remainingQty;
        for (let i of item?.productionData?.bomBased) {
          const rm = await Item.findById(i?.item).select('itemName itemNo');
          const itemInventoryData = await ItemInventory.findOne({ itemId: i?.item });
          const matchWarehouse = itemInventoryData?.branches?.find(
            b => b.warehouseId?.toString() === order?.warehouseId?.toString(),
          );

          rmItems.push({
            itemId: i?.item,
            itemName: rm?.itemName,
            itemNo: rm?.itemNo,
            requiredQty: parseFloat(itemRemainingQty * i?.qtyPerItem).toFixed(2),
            availableStock: matchWarehouse?.availableStock || 0,
            shortage: Math.min(matchWarehouse?.availableStock || 0 - parseFloat(itemRemainingQty * i?.qtyPerItem).toFixed(2), 0),
          });
        }
      }
      i.bomBasedItems = rmItems;
    }
  }

  return result;
};

const salesItemAnalysis = async filter => {
  const { SalesOrder, Item, ItemInventory } = getBooksCrmModels();
  const { Invoice, DeliveryChallan } = getBooksModels();
  const salesOrderFilter = { companyId: new mongoose.Types.ObjectId(filter?.companyId) };
  if (filter?.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      salesOrderFilter.status = {
        $in: statusArray,
      };
    }
  }

  let commonFilter = { companyId: new mongoose.Types.ObjectId(filter?.companyId) };

  if (filter?.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      commonFilter.branchId = {
        $in: branchArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter?.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      commonFilter.divisionId = {
        $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter?.customerId) {
    const customerArray = filter.customerId.split(',').filter(Boolean);
    if (customerArray.length > 0) {
      commonFilter.customerId = {
        $in: customerArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  const filterItemIds =
    filter?.itemId
      ?.split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id)) || [];

  const items = await SalesOrder.aggregate([
    {
      $match: { ...salesOrderFilter, ...commonFilter },
    },

    {
      $unwind: '$items',
    },

    {
      $addFields: {
        'items.itemIdArr': {
          $cond: {
            if: { $isArray: '$items.itemId' },
            then: '$items.itemId',
            else: ['$items.itemId'],
          },
        },
      },
    },

    {
      $match: {
        ...(filterItemIds.length && {
          $expr: {
            $gt: [
              {
                $size: {
                  $setIntersection: ['$items.itemIdArr', itemIds],
                },
              },
              0,
            ],
          },
        }),
      },
    },

    {
      $lookup: {
        from: 'items',
        let: {
          itemIds: '$items.itemIdArr',
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $in: ['$_id', '$$itemIds'] },
                  {
                    $gt: [
                      {
                        $size: {
                          $ifNull: ['$productionData.bomBased', []],
                        },
                      },
                      0,
                    ],
                  },
                ],
              },
            },
          },
          { $project: { _id: 1, itemName: 1 } },
        ],
        as: 'item',
      },
    },

    {
      $unwind: {
        path: '$item',
        preserveNullAndEmptyArrays: false,
      },
    },

    {
      $group: {
        _id: '$item._id',
        itemName: { $first: '$item.itemName' },
        totalQuantity: { $sum: '$items.quantity' },
      },
    },

    {
      $project: {
        _id: 0,
        itemId: '$_id',
        itemName: 1,
        totalQuantity: 1,
      },
    },
  ]);

  const itemIds = items.map(i => new mongoose.Types.ObjectId(i.itemId));
  const [dcAgg, invAgg] = await Promise.all([
    DeliveryChallan.aggregate([
      {
        $match: {
          'items.itemId': { $in: itemIds },
          ...commonFilter,
          status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
          $expr: {
            $gt: [{ $size: { $ifNull: ['$salesOrders', []] } }, 0],
          },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.itemId': { $in: itemIds } } },
      { $group: { _id: '$items.itemId', totalQty: { $sum: '$items.quantity' } } },
    ]),
    Invoice.aggregate([
      {
        $match: {
          ...commonFilter,
          'items.itemId': { $in: itemIds },
          status: { $ne: INVOICE_STATUS.CANCELLED },
          $expr: {
            $gt: [{ $size: { $ifNull: ['$salesOrders', []] } }, 0],
          },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.itemId': { $in: itemIds } } },
      { $group: { _id: '$items.itemId', totalQty: { $sum: '$items.quantity' } } },
    ]),
  ]);

  const dcMap = new Map(dcAgg.map(d => [d._id.toString(), d.totalQty]));
  const invMap = new Map(invAgg.map(i => [i._id.toString(), i.totalQty]));

  const itemDocs = await Item.find({ _id: { $in: itemIds } })
    .select('itemName itemNo  productionData')
    .lean();

  const itemMap = new Map(itemDocs.map(i => [i._id.toString(), i]));

  const result = await Promise.all(
    items.map(async i => {
      const itemId = i.itemId.toString();
      const itemDoc = itemMap.get(itemId);
      const billedQty = (dcMap.get(itemId) || 0) + (invMap.get(itemId) || 0);
      const rmItems = [];
      const remainingQty = Math.max(i.totalQuantity - billedQty, 0);

      if (itemDoc?.productionData?.bomBased?.length > 0) {
        for (let i of itemDoc?.productionData?.bomBased) {
          const rm = await Item.findById(i?.item).select('itemName itemNo inventoryData');
          const inventoryData = await ItemInventory.findOne({ itemId: i?.item });
          const totalStock =
            inventoryData?.warehouses?.reduce((total, warehouse) => {
              return total + (warehouse?.availableStock || 0);
            }, 0) || 0;

          rmItems.push({
            itemId: i?.item,
            itemName: rm?.itemName,
            itemNo: rm?.itemNo,
            requiredQty: parseFloat(remainingQty * i?.qtyPerItem).toFixed(2),
            availableStock: totalStock,
            shortage: Math.min(totalStock - parseFloat(remainingQty * i?.qtyPerItem).toFixed(2), 0),
          });
        }
      }

      return {
        ...i,
        itemName: itemDoc?.itemName,
        itemNo: itemDoc?.itemNo,
        billedQty,
        remainingQty: Math.max(i.totalQuantity - billedQty, 0),
        bomBasedItems: rmItems,
      };
    }),
  );

  return result;
};

const salesOrderRMAnalysis = async filter => {
  const { SalesOrder, Item, ItemInventory } = getBooksCrmModels();
  const { Invoice, DeliveryChallan } = getBooksModels();
  const salesOrderFilter = { companyId: new mongoose.Types.ObjectId(filter?.companyId) };
  if (filter?.status) {
    const statusArray = filter.status.split(',').filter(Boolean);
    if (statusArray.length > 0) {
      salesOrderFilter.status = {
        $in: statusArray,
      };
    }
  }

  const commonFilter = { companyId: new mongoose.Types.ObjectId(filter?.companyId) };

  if (filter?.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length) {
      commonFilter.branchId = {
        $in: branchArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter?.customerId) {
    const customerArray = filter.customerId.split(',').filter(Boolean);
    if (customerArray.length) {
      commonFilter.customerId = {
        $in: customerArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter?.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    if (divisionArray.length) {
      commonFilter.divisionId = {
        $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  const items = await SalesOrder.aggregate([
    {
      $match: { ...salesOrderFilter, ...commonFilter },
    },
    {
      $sort: {
        _id: 1,
      },
    },
    {
      $unwind: '$items',
    },
    {
      $group: {
        _id: '$items.itemId',
        totalQuantity: { $sum: '$items.quantity' },
      },
    },
    {
      $lookup: {
        from: 'items',
        localField: '_id',
        foreignField: '_id',
        as: 'item',
      },
    },
    {
      $unwind: {
        path: '$item',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        _id: 0,
        itemId: '$_id',
        itemName: '$item.itemName',
        totalQuantity: 1,
      },
    },
  ]);

  const itemIds = items.map(i => new mongoose.Types.ObjectId(i.itemId));
  const [dcAgg, invAgg] = await Promise.all([
    DeliveryChallan.aggregate([
      {
        $match: {
          ...commonFilter,
          'items.itemId': { $in: itemIds },
          status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
          $expr: {
            $gt: [{ $size: { $ifNull: ['$salesOrders', []] } }, 0],
          },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.itemId': { $in: itemIds } } },
      { $group: { _id: '$items.itemId', totalQty: { $sum: '$items.quantity' } } },
    ]),
    Invoice.aggregate([
      {
        $match: {
          ...commonFilter,
          'items.itemId': { $in: itemIds },
          status: { $ne: INVOICE_STATUS.CANCELLED },
          $expr: {
            $gt: [{ $size: { $ifNull: ['$salesOrders', []] } }, 0],
          },
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.itemId': { $in: itemIds } } },
      { $group: { _id: '$items.itemId', totalQty: { $sum: '$items.quantity' } } },
    ]),
  ]);

  const dcMap = new Map(dcAgg.map(d => [d._id.toString(), d.totalQty]));
  const invMap = new Map(invAgg.map(i => [i._id.toString(), i.totalQty]));

  const itemDocs = await Item.find(
    { _id: { $in: itemIds }, companyId: filter.companyId },
    { itemName: 1, itemNo: 1, productionData: 1 },
  ).lean();

  const itemMap = new Map(itemDocs.map(i => [i._id.toString(), i]));

  const rmIdsSet = new Set();

  for (const item of itemDocs) {
    for (const b of item?.productionData?.bomBased || []) {
      rmIdsSet.add(b.item.toString());
    }
  }

  const rmIds = [...rmIdsSet];

  const rmDocs = await Item.find({ _id: { $in: rmIds } }, { itemName: 1, itemNo: 1 }).lean();

  const rmItemMap = new Map(rmDocs.map(rm => [rm._id.toString(), rm]));

  const rmInventories = await ItemInventory.find({ itemId: { $in: rmIds } }, { itemId: 1, warehouses: 1 }).lean();

  const rmInventoryMap = new Map(
    rmInventories.map(inv => [inv.itemId.toString(), inv.warehouses?.reduce((sum, w) => sum + (w.availableStock || 0), 0) || 0]),
  );

  const rmMap = new Map();

  for (const soItem of items) {
    const itemId = soItem.itemId.toString();
    const itemDoc = itemMap.get(itemId);

    if (!itemDoc?.productionData?.bomBased?.length) continue;

    const billedQty = (dcMap.get(itemId) || 0) + (invMap.get(itemId) || 0);

    const remainingQty = Math.max(soItem.totalQuantity - billedQty, 0);

    if (!remainingQty) continue;

    for (const poItem of itemDoc.productionData.bomBased) {
      const rmId = poItem.item.toString();

      const rm = rmItemMap.get(rmId);
      const totalStock = rmInventoryMap.get(rmId) || 0;
      const requiredQty = remainingQty * poItem.qtyPerItem;

      const existing = rmMap.get(rmId) || {
        itemId: poItem.item,
        itemName: rm?.itemName,
        itemNo: rm?.itemNo,
        requiredQty: 0,
        availableStock: totalStock,
      };

      existing.requiredQty += requiredQty;
      existing.shortage = Math.max(parseFloat(existing.requiredQty) - totalStock).toFixed(2);

      rmMap.set(rmId, existing);
    }
  }

  const rmSummary = [...rmMap.values()].map(rm => ({
    itemId: rm.itemId,
    itemName: rm.itemName,
    itemNo: rm.itemNo,
    requiredQty: parseFloat(rm.requiredQty).toFixed(2),
    availableStock: rm.availableStock,
    shortage: rm.shortage,
  }));

  return rmSummary;
};

const buildModuleTree = async salesOrderId => {
  const { SalesOrder, PaymentReceived, Quote } = getBooksCrmModels();
  const { DeliveryChallan, Invoice, ProductionOrder } = getBooksModels();

  const moduleTree = {};

  /* -------------------------------------------------- */
  /* SALES ORDER */
  /* -------------------------------------------------- */

  const salesOrder = await SalesOrder.findById(salesOrderId).select('_id orderId orderDate status total quoteId');

  if (!salesOrder) return moduleTree;

  let rootPointer = null;

  /* -------------------------------------------------- */
  /* IF SALES ORDER HAS QUOTE (GO UP) */
  /* -------------------------------------------------- */

  if (salesOrder.quoteId) {
    const quote = await Quote.findOne({ _id: salesOrder.quoteId }).select('_id quoteId quoteDate status total');

    if (quote) {
      moduleTree.quote = {
        id: quote._id,
        quoteId: quote.quoteId,
        quoteDate: quote.quoteDate,
        status: quote.status,
        total: quote.total,
        salesOrder: {
          id: salesOrder._id,
          orderId: salesOrder.orderId,
          orderDate: salesOrder.orderDate,
          status: salesOrder.status,
          total: salesOrder.total,
        },
      };

      rootPointer = moduleTree.quote.salesOrder;
    }
  }

  /* -------------------------------------------------- */
  /* IF NO QUOTE → SALES ORDER IS ROOT */
  /* -------------------------------------------------- */

  if (!rootPointer) {
    moduleTree.salesOrder = {
      id: salesOrder._id,
      orderId: salesOrder.orderId,
      orderDate: salesOrder.orderDate,
      status: salesOrder.status,
      total: salesOrder.total,
    };

    rootPointer = moduleTree.salesOrder;
  }

  /* -------------------------------------------------- */
  /* SALES ORDER → PRODUCTION ORDER */
  /* -------------------------------------------------- */

  const productionOrders = await ProductionOrder.find({ salesOrderId: salesOrder._id })
    .select('_id productionOrderCode productionDate status quantity itemId')
    .populate({
      path: 'itemId',
      model: getBooksCrmModels().Item,
      select: 'itemNo',
    });

  if (productionOrders?.length) {
    rootPointer.productionOrders = productionOrders;
  }

  /* -------------------------------------------------- */
  /* SALES ORDER → DELIVERY CHALLAN */
  /* -------------------------------------------------- */

  const deliveryChallans = await DeliveryChallan.find({ 'salesOrders.salesOrderId': salesOrder._id }).select(
    '_id challanId challanDate status total',
  );

  if (deliveryChallans?.length) {
    const dcIds = deliveryChallans.map(dc => dc._id);

    // Pull every invoice for these DCs and their payments once...
    const dcInvoices = await Invoice.find({
      'deliveryChallanIds.deliveryChallanId': { $in: dcIds },
      isSplit: { $ne: true },
    })
      .select('_id invoiceId invoiceDate status total deliveryChallanIds')
      .lean();

    const invoiceIds = dcInvoices.map(inv => inv._id);
    const dcPayments = invoiceIds.length
      ? await PaymentReceived.find({ 'invoices.invoiceId': { $in: invoiceIds } })
          .select('_id paymentReceivedId paymentDate status amountReceived invoices')
          .lean()
      : [];

    // ...then nest each invoice (with its own payments) ONLY under the DC it was created from,
    // so one DC never shows another DC's invoices.
    rootPointer.deliveryChallan = {
      deliveryChallans: deliveryChallans.map(dc => {
        const dcObj = dc.toObject ? dc.toObject() : dc;
        const invoices = dcInvoices
          .filter(inv => (inv.deliveryChallanIds || []).some(d => String(d.deliveryChallanId) === String(dc._id)))
          .map(({ deliveryChallanIds, ...inv }) => ({
            ...inv,
            payments: dcPayments
              .filter(p => (p.invoices || []).some(pi => String(pi.invoiceId) === String(inv._id)))
              .map(({ invoices: _ignored, ...pay }) => pay),
          }));
        return { ...dcObj, invoices };
      }),
    };
  }

  /* -------------------------------------------------- */
  /* SALES ORDER → DIRECT INVOICE */
  /* -------------------------------------------------- */

  const soInvoices = await Invoice.find({ 'salesOrders.salesOrderId': salesOrder._id, isSplit: { $ne: true } }).select(
    '_id invoiceId invoiceDate status total',
  );

  if (soInvoices?.length) {
    rootPointer.invoice = {
      invoices: soInvoices,
    };

    const invoiceIds = soInvoices.map(inv => inv._id);

    const payments = await PaymentReceived.find({ 'invoices.invoiceId': { $in: invoiceIds } }).select(
      '_id paymentReceivedId paymentDate status amountReceived',
    );

    if (payments?.length) {
      rootPointer.invoice.paymentReceive = {
        paymentReceives: payments,
      };
    }
  }

  return moduleTree;
};

const createProductionOrder = async (orderBody, userId) => {
  const { SalesOrder, Item } = getBooksCrmModels();
  const { ProductionOrder, InventoryTransferRequest, Process, Recipe } = getBooksModels();
  const session = await getClientConnection().startSession();

  try {
    await session.startTransaction();

    const { salesOrderId, inStockWarehouseId, productionWarehouseId, items = [], ...baseOrderBody } = orderBody;
    const createdProductionOrders = [];

    const latestInventoryTransfer = await InventoryTransferRequest.findOne(
      { companyId: orderBody.companyId },
      { transferId: 1 },
      { sort: { createdAt: -1 } },
    ).session(session);

    let nextTransferNumber = 1;

    if (latestInventoryTransfer?.transferId) {
      const match = latestInventoryTransfer.transferId.match(/TRF(\d+)/);
      if (match) {
        nextTransferNumber = parseInt(match[1], 10) + 1;
      }
    }

    const validItems = items.filter(item => Number(item?.quantity || 0) > 0);
    if (!validItems.length) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'At least one item with quantity greater than 0 is required');
    }

    const untrackedItems = await getUntrackedProductionItems({
      itemIds: validItems.map(item => item.itemId),
      companyId: orderBody.companyId,
      session,
    });

    if (untrackedItems.length) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `${PRODUCTION_ORDER_MESSAGES.FINISHED_GOOD_MUST_BE_STOCK}: ${[...new Set(untrackedItems.map(i => i.itemName))].join(', ')}`,
      );
    }

    for (let item of validItems) {
      const itemQty = Number(item?.quantity);

      const itemDetails = await Item.findById(item.itemId)
        .select(
          'itemName itemCategory.isService productionData.productionManageMethod productionData.selectProcessRecipe productionData.bomBased',
        )
        .session(session)
        .lean();

      // Service items don't go through production — skip silently
      if (itemDetails?.itemCategory?.isService) {
        continue;
      }

      const productionManageMethod = itemDetails?.productionData?.productionManageMethod;

      if (!productionManageMethod) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Production manage method not defined for item ${itemDetails?.itemName || item?.itemId}`,
        );
      }

      const rawMaterials = [];

      if (itemDetails?.productionData?.bomBased?.length > 0) {
        for (const j of itemDetails?.productionData?.bomBased) {
          rawMaterials.push({
            rawMaterialId: j?.item,
            perItemRequiredUnit: j?.qtyPerItem,
            productionOrderRequiredUnit: j?.qtyPerItem * itemQty,
          });
        }
      }

      const productionOrderNumber = await generateUniqueId(
        ProductionOrder,
        orderBody?.companyId,
        MODULE_NAMES.PRODUCTION_ORDER,
        'productionOrderCode',
        'PRO',
        session,
      );

      const newOrder = {
        ...baseOrderBody,
        productionOrderCode: productionOrderNumber,
        createdBy: userId,
        salesOrderId,
        itemId: item.itemId,
        quantity: itemQty,
        inStockWarehouseId,
        productionWarehouseId,
        inventoryInwarehouseId: orderBody.inventoryInwarehouseId,
        productionManageMethod,
        isSalesOrderBased: true,
        rawMaterials,
        updatedBy: userId,
      };

      if (productionManageMethod === 'PROCESS_ROUTE') {
        if (item?.processBased?.recipeId && item?.processBased?.recipeName) {
          newOrder.processBased = item.processBased;
        } else {
          const recipeId = itemDetails?.productionData?.selectProcessRecipe;
          if (!recipeId) {
            throw new ApiError(
              httpStatus.BAD_REQUEST,
              `Recipe not configured for process route item ${itemDetails?.itemName || item?.itemId}`,
            );
          }

          const recipe = await Recipe.findById(recipeId).session(session).lean();
          if (!recipe) {
            throw new ApiError(
              httpStatus.BAD_REQUEST,
              `Recipe not found for process route item ${itemDetails?.itemName || item?.itemId}`,
            );
          }

          const processes =
            (await Promise.all(
              recipe.processes.map(async processId => {
                const process = await Process.findById(processId).select('name processId').session(session).lean();
                if (!process) return null;
                return {
                  processId: process._id,
                  processNo: process.processId,
                  processName: process.name,
                };
              }),
            )) || [];

          newOrder.processBased = {
            recipeId: recipe._id,
            recipeName: recipe.name,
            processes: processes.filter(Boolean),
          };
        }
      }

      // Check for required warehouses if BOM_BASED
      if (newOrder.productionManageMethod === 'BOM_BASED') {
        if (!newOrder.inStockWarehouseId || !newOrder.productionWarehouseId) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'inStockWarehouseId and productionWarehouseId are required for BOM_BASED production orders',
          );
        }
        // Set status to waiting for inventory approval for BOM_BASED orders
        newOrder.status = PRODUCTION_ORDER_STATUS.WAITING_FOR_INVENTORY_APPROVAL;

        // Initialize tracking fields for partial submissions
        newOrder.totalFgSubmittedQty = 0;
        newOrder.totalFgRejectedQty = 0;
        newOrder.submissionHistory = [];
      }

      const productionOrder = await ProductionOrder.create([newOrder], { session });
      createdProductionOrders.push(productionOrder[0]);

      // Create InventoryTransferRequest if BOM_BASED
      if (newOrder.productionManageMethod === 'BOM_BASED') {
        await InventoryTransferRequest.create(
          [
            {
              transferId: `TRF${nextTransferNumber++}`,
              companyId: newOrder.companyId,
              itemId: item.itemId,
              fromWarehouseId: inStockWarehouseId,
              toWarehouseId: productionWarehouseId,
              quantity: newOrder.quantity,
              rawMaterials: newOrder.rawMaterials,
              isProductionOrderReq: true,
              productionOrderId: productionOrder[0]._id,
              referenceNumber: productionOrder[0].productionOrderCode,
              addedBy: userId,
              updatedBy: userId,
              date: new Date(),
            },
          ],
          { session },
        );
      }
    }

    if (salesOrderId) {
      await SalesOrder.findByIdAndUpdate(
        salesOrderId,
        {
          productionOrderStatus: 'PARTIAL',
        },
        { new: true, session },
      );
    }

    await session.commitTransaction();
    return createdProductionOrders;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    session.endSession();
  }
};

module.exports = {
  createSalesOrder: withTransientRetry(createSalesOrder),
  querySalesOrders,
  querySalesOrdersExports,
  getSalesOrderById,
  updateSalesOrderById,
  updateSalesOrderStatus,
  revertSalesOrderClose,
  deleteSalesOrderById,
  getSalesOrdersForDropdown,
  SALES_ORDER_CONVERSION_ALLOWED_STATUSES,
  openSalesOrders,
  partiallyConvertedItemList,
  getSalesOrderWiseItemAnalysis,
  getItemWiseSalesOrderAnalysis,
  getCustomerWiseSalesOrderAnalysis,
  getNewVsOldCustomerReport,
  getNewVsOldCustomerReportModuleData,
  salesOrderAnalysis,
  salesItemAnalysis,
  salesOrderRMAnalysis,
  createProductionOrder: withTransientRetry(createProductionOrder),
};
