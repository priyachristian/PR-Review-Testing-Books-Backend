const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const moment = require('moment');
const ApiError = require('../../../utils/ApiError');
const { INVOICE_MESSAGES, DELIVERY_CHALLAN_MESSAGES } = require('../../../utils/messages');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { createLineClaimer } = require('../../../utils/documentLineMatching');
const { processIncentiveEarn, cancelIncentiveLog } = require('../../setting/incentiveScheme/incentiveScheme.service');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { getAddressFilterCondition, findAddressById } = require('../../../utils/addressLocationFilter');
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');
const {
  SALES_ORDER_INVOICE_STATUS,
  MODULE_NAMES,
  QUOTE_STATUS,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  INVOICE_STATUS,
  PAYMENT_STATUS,
  CREDIT_NOTE_STATUS,
  E_INVOICE_STATUS,
  E_WAY_BILL_STATUS,
  TRANSACTION_TYPE,
  OB_PAYMENT_ENTRY_SOURCE,
  CONTACT_TYPE,
  LEDGER_SOURCE_MODULES,
  LEDGER_PARTY_TYPES,
} = require('../../../utils/enum');
const { resolveProviderKey } = require('./providers/providerConfig.service');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { QUOTE_CONVERSION_ALLOWED_STATUSES } = require('../quote/quote.service');
const { DELIVERY_CHALLAN_CONVERSION_ALLOWED_STATUSES } = require('../deliveryChallan/deliveryChallan.service');
const EWAY_API_ERROR_CODES = require('../../../utils/nicErrorMap');
const {
  INVOICE_STATUS_CONFIG,
  getInventoryConfig,
  validateStatusTransition,
  validateEditPermissions,
  validateStockAvailability,
} = require('../../../utils/inventoryConfig');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const mongoose = require('mongoose');
const { defaultBranchEntry, multipleDefaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const { moveAdvanceApplyBranchBalances } = require('../../../utils/paymentBranchBalance');
const { getPrimaryBank, getPrimaryBankDetails } = require('../../banking/bank/bank.service');
const { generateFynamicsEInvoice } = require('./fynamicsEInvoice.service');
const providerOrchestrator = require('./providers/providerOrchestrator.service');
const {
  attachItemServiceFlags,
  buildEInvoiceOptionSnapshot,
  buildEWayBillOptionSnapshot,
  buildGstDocumentOptions,
} = require('../gstDocument/gstDocument.service');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
} = require('../../../services/warehouseBatch.service');
const { validateCustomerForModule, updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const { enrichObLines, obLinesFromPaymentsReceived } = require('../../../utils/openingBalancePaymentHistoryHelper');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { attachBranchNames } = require('../../../utils/helper');
const { NOTIFICATION_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');
const { sendTransactionNotification } = require('../../../utils/transactionNotification');
const {
  sendModuleCustomerNotifications,
  notifyModuleDocumentIfNonDraft,
  isFirstStatusChange,
} = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');
const { getCompanyProfile } = require('../../../services/onboard.service');
const { recomputeSalesOrderStatus, loadUnitItemMap, getUnitFactor } = require('../../../services/conversionStatus.service');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const {
  enrichDocumentItemLines,
  assertSelectableForNewLines,
  assertResolvable,
  assertLineUnitsValid,
  SNAPSHOT_MODE,
} = require('../../../services/documentItemEnricher.service');

// Replace the invoice journal when crossing draft/cancelled ↔ posted; skip when only payment status changes.
const syncInvoiceJournal = async (companyId, invoice, userId, session, oldStatus = null) => {
  const POSTED_INVOICE_STATUSES = [
    INVOICE_STATUS.DRAFT,
    INVOICE_STATUS.SENT,
    INVOICE_STATUS.PARTIALLY_PAID,
    INVOICE_STATUS.PAID,
    INVOICE_STATUS.OVERDUE,
  ];
  const isPostedInvoiceStatus = status => POSTED_INVOICE_STATUSES.includes(status);
  const wasPosted = oldStatus != null && isPostedInvoiceStatus(oldStatus);
  const isPosted = isPostedInvoiceStatus(invoice.status);

  // Sent → partly paid → paid keeps the same invoice journal; no reverse/re-post needed.
  if (oldStatus != null && wasPosted && isPosted) {
    return;
  }

  // Clear any existing invoice journal, then post again only if the invoice is in a posted status.
  await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.INVOICE, sourceId: invoice._id }, session);
  if (isPosted) {
    await ledgerService.postInvoiceJournal({ companyId, invoice, addedBy: userId }, session);
  }
};

const updateInvoicePaymentStatus = async (invoiceId, amount, userId = null, session = null) => {
  try {
    const { Invoice } = getBooksModels();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      return false;
    }

    const newPaidAmount = invoice.paidAmount + amount;
    const newBalanceAmount = invoice.total - newPaidAmount;

    const todayDate = new Date();
    todayDate.setUTCHours(0, 0, 0, 0);

    if (newPaidAmount < invoice.total && invoice.dueDate && invoice.dueDate < todayDate) {
      const update = {
        paidAmount: newPaidAmount,
        balanceAmount: newBalanceAmount,
        status: SALES_ORDER_INVOICE_STATUS.OVERDUE,
      };
      if (invoice.status !== SALES_ORDER_INVOICE_STATUS.OVERDUE) {
        update.$push = {
          commentHistory: {
            message: `Invoice status updated from ${invoice.status} to ${SALES_ORDER_INVOICE_STATUS.OVERDUE}`,
            addedBy: userId,
            createdAt: new Date(),
            referenceType: 'Invoice',
            referenceId: invoiceId,
          },
        };
      }

      await Invoice.updateOne({ _id: invoiceId }, update, { session });

      return true;
    }

    let status = invoice.status;
    if (newPaidAmount >= invoice.total) {
      status = SALES_ORDER_INVOICE_STATUS.PAID;
    } else if (newPaidAmount > 0) {
      status = SALES_ORDER_INVOICE_STATUS.PARTIALLY_PAID;
    } else {
      status = SALES_ORDER_INVOICE_STATUS.SENT;
    }

    const update = {
      paidAmount: newPaidAmount,
      balanceAmount: newBalanceAmount,
      status,
    };
    if (invoice.status !== status) {
      update.$push = {
        commentHistory: {
          message: `Invoice status updated from ${invoice.status} to ${status}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'Invoice',
          referenceId: invoiceId,
        },
      };
    }

    await Invoice.updateOne({ _id: invoiceId }, update, { session });

    return true;
  } catch (error) {
    console.error('Error updating invoice payment status:', error);
    throw error;
  }
};

const cancelInvoicePayment = async (invoiceId, amount, userId = null, session = null) => {
  return updateInvoicePaymentStatus(invoiceId, -amount, userId, session);
};

const createInvoice = async (invoiceBody, userId, uploadedFile = []) => {
  const { Quote, SalesOrder, Customer, Branch } = getBooksCrmModels();
  const { DeliveryChallan, Invoice } = getBooksModels();
  const { CompanySettings, Company } = getCommonModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const {
      items,
      warehouseId,
      branchId,
      total,
      customerId,
      deliveryChallanId,
      quoteId,
      companyId,
      salesOrders,
      isSplit,
      appliesTo,
      deliveryChallanIds,
      isInventoryEnabled,
    } = invoiceBody;

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    // Enforce item selectability. An invoice converted from a delivery challan / sales order / quote
    // carries its lines (deactivation afterwards is tolerated); a standalone invoice requires active
    // items. (Display snapshot is repaired on read.)
    const isInvoiceConversion = Boolean(deliveryChallanId || quoteId || salesOrders?.length || deliveryChallanIds?.length);
    const itemSelectabilityCheck = await enrichDocumentItemLines(items, {
      companyId,
      warehouseId,
      session,
      snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
    });
    if (isInvoiceConversion) {
      assertResolvable(itemSelectabilityCheck);
    } else {
      assertSelectableForNewLines(itemSelectabilityCheck, 'invoice');
    }
    await assertLineUnitsValid(itemSelectabilityCheck, { companyId, session });

    if (isSplit) {
      let branchArray = [invoiceBody.branchId];
      const getBranchConfig = await CompanySettings.findOne({ companyId }).select('branchConfig');
      const branchConfig = getBranchConfig?.branchConfig || {};

      // Use branchConfig only if splitConfig is true, otherwise use body values
      let splitBranchId = branchConfig?.splitConfig === true ? branchConfig?.branchId : invoiceBody.branchId;

      if (splitBranchId) {
        branchArray.push(splitBranchId.toString());
      }

      const customer = await Customer.findOne(
        { _id: new mongoose.Types.ObjectId(customerId) },
        { branch: 1 }, // only get the branches field
      )
        .lean()
        .session(session);

      // Extract branchIds from existing customer branches
      const existingBranchIds = (customer?.branch || []).map(b => b.branchId.toString());

      // Identify which branchIds are missing
      const missingBranchIds = branchArray.filter(id => !existingBranchIds.includes(id.toString()));

      // If any branchId is missing, call defaultBranchEntry
      if (missingBranchIds.length > 0) {
        await multipleDefaultBranchEntry(customerId, missingBranchIds, session);
      }
    } else {
      //give msg if brach do not exist in mention customerid
      const customer = await Customer.findOne({
        _id: new mongoose.Types.ObjectId(customerId),
        'branch.branchId': branchId,
      }).session(session);

      if (customer == null || customer == undefined) {
        await defaultBranchEntry(customerId, branchId, session);
      }
    }

    let shippingAddressId = null,
      splitBranchId = '',
      splitTotal = 0;

    if ((isSplit && deliveryChallanId) || (isSplit && deliveryChallanIds)) {
      splitTotal = invoiceBody?.split.total;
      const getBranchConfig = await CompanySettings.findOne({ companyId }).select('branchConfig');
      const branchConfig = getBranchConfig?.branchConfig || {};

      // Branch selection
      if (branchConfig?.splitConfig === true) {
        splitBranchId = branchConfig?.branchId || null;
      } else {
        splitBranchId = invoiceBody.branchId || null;
      }

      let splitWarehouseId, splitDivisionId;
      if (branchConfig?.splitConfig === true) {
        splitWarehouseId = branchConfig?.warehouseId || null;
        splitDivisionId = branchConfig?.divisionId || null;
      } else {
        splitWarehouseId = invoiceBody.warehouseId || null;
        splitDivisionId = invoiceBody.divisionId || null;
      }

      const branches = [invoiceBody.branchId, splitBranchId?.toString()];
      const totals = [total, splitTotal];

      for (let i = 0; i < branches.length; i++) {
        const branchId = branches[i];
        const amount = totals[i];

        shippingAddressId = await validateCustomerForModule({
          customerId,
          branchId,
          companyId,
          totalAmount: amount,
          addressId: invoiceBody.addressId,
          moduleName: MODULE_NAMES.INVOICE,
          session,
          models: { Customer, Branch, Invoice },
        });
      }
    } else {
      shippingAddressId = await validateCustomerForModule({
        customerId,
        branchId,
        companyId,
        totalAmount: total,
        addressId: invoiceBody.addressId,
        moduleName: MODULE_NAMES.INVOICE,
        session,
        models: { Customer, Branch, Invoice },
      });
    }

    // Determine the source of the invoice
    let sourceType = null;
    let sourceId = null;
    let sourceItems = items;
    let commentHistory = [];
    let currency;
    let exchangeRate;
    let decimalPlaces;
    let isFromStockTransferChallan = false;

    if (quoteId) {
      sourceType = 'QUOTE';
      sourceId = quoteId;
      const quote = await Quote.findById(quoteId)
        .select('currency exchangeRate decimalPlaces items status quoteId')
        .session(session);

      if (!quote) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Quote not found');
      }

      // Validate quote status for conversion
      if (!QUOTE_CONVERSION_ALLOWED_STATUSES.includes(quote.status)) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Quote cannot be converted to invoice in ${
            quote.status
          } status. Allowed statuses: ${QUOTE_CONVERSION_ALLOWED_STATUSES.join(', ')}`,
        );
      }

      // If this is a conversion from quote to invoice, use the items from the quote
      sourceItems = quote.items;
      if (quote.currency) {
        currency = quote.currency;
        exchangeRate = quote.exchangeRate ?? 1;
        decimalPlaces = quote.decimalPlaces ?? null;
      }
      commentHistory.push({
        message: `Invoice created from Quote ${quote.quoteId}`,
        addedBy: userId,
        createdAt: new Date(),
        referenceType: 'Quote',
        referenceId: quote._id,
      });
    } else if (deliveryChallanIds && deliveryChallanIds.length) {
      sourceType = 'DELIVERY_CHALLAN';
      sourceId = deliveryChallanIds;

      const challanObjectIds = deliveryChallanIds.map(dc => new mongoose.Types.ObjectId(dc.deliveryChallanId));

      const deliveryChallans = await DeliveryChallan.find({
        _id: { $in: challanObjectIds },
        companyId,
      })
        .select('currency exchangeRate decimalPlaces challanId status isStockTransfer stockTransfer')
        .session(session);

      if (deliveryChallans.length !== challanObjectIds.length) {
        throw new ApiError(httpStatus.NOT_FOUND, 'One or more Delivery Challans not found');
      }

      // Stock transfer challans already moved their stock, so the invoice bills from their From location and never touches stock.
      const transferChallans = deliveryChallans.filter(dc => dc.isStockTransfer);
      if (transferChallans.length && transferChallans.length !== deliveryChallans.length) {
        throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.INVOICE_MIXED_CHALLANS);
      }
      if (transferChallans.length) {
        const { fromDivisionId, fromBranchId, fromWarehouseId } = transferChallans[0].stockTransfer || {};
        if (transferChallans.some(dc => String(dc.stockTransfer?.fromWarehouseId) !== String(fromWarehouseId))) {
          throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.INVOICE_TRANSFER_LOCATIONS_DIFFER);
        }
        isFromStockTransferChallan = true;
        Object.assign(invoiceBody, { divisionId: fromDivisionId, branchId: fromBranchId, warehouseId: fromWarehouseId });
      }

      if (deliveryChallans[0]?.currency) {
        currency = deliveryChallans[0].currency;
        exchangeRate = deliveryChallans[0].exchangeRate ?? 1;
        decimalPlaces = deliveryChallans[0].decimalPlaces ?? null;
      }

      const invalidChallans = deliveryChallans.filter(dc => !DELIVERY_CHALLAN_CONVERSION_ALLOWED_STATUSES.includes(dc.status));

      if (invalidChallans.length) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Some Delivery Challans cannot be converted to invoice. Challans: ${invalidChallans
            .map(dc => dc.challanId)
            .join(', ')}`,
        );
      }

      // ✅ History entries
      deliveryChallans.forEach(dc => {
        commentHistory.push({
          message: `Invoice created from Delivery Challan ${dc.challanId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'DeliveryChallan',
          referenceId: dc._id,
        });
      });
    } else if (salesOrders) {
      const ids = salesOrders.map(order => new mongoose.Types.ObjectId(order.salesOrderId));
      sourceType = 'SALES_ORDER';
      sourceItems = [];
      const salesOrdersData = await SalesOrder.find({
        _id: { $in: ids },
      })
        .select('currency exchangeRate decimalPlaces orderId orderDate')
        .session(session);
      if (!salesOrdersData) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Sales Order not found');
      }

      if (salesOrdersData.length !== ids.length) {
        throw new ApiError(httpStatus.NOT_FOUND, 'One or more Sales Orders not found');
      }

      if (salesOrdersData[0]?.currency) {
        currency = salesOrdersData[0].currency;
        exchangeRate = salesOrdersData[0].exchangeRate ?? 1;
        decimalPlaces = salesOrdersData[0].decimalPlaces ?? null;
      }

      salesOrdersData.forEach(order => {
        commentHistory.push({
          message: `Invoice created from Sales Order ${order.orderId || order._id}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'SalesOrder',
          referenceId: order._id,
        });
      });

      // If this is a conversion from sales order to invoice, use the items from the sales order
      sourceItems.push(...items);
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFile ? uploadedFile : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: invoiceBody.companyId,
    });

    let finalItems = invoiceBody?.items || [];

    if (isSplit) {
      if (invoiceBody?.split?.splitWiseType == 'Split By Qty') {
        const rootItems = items;
        const splitItems = invoiceBody.split?.items || [];

        const mergedMap = new Map();

        for (const item of rootItems) {
          const key = item.itemId.toString();
          if (mergedMap.has(key)) {
            const existingItem = mergedMap.get(key);

            mergedMap.set(key, {
              ...existingItem,
              quantity: (existingItem.quantity || 0) + (item.quantity || 0),
            });
          } else {
            mergedMap.set(key, { ...item });
          }
        }

        for (const splitItem of splitItems) {
          if (mergedMap.has(splitItem.itemId)) {
            const merged = mergedMap.get(splitItem.itemId);
            merged.quantity += splitItem.quantity;

            merged.amount = (parseFloat(merged.amount) + parseFloat(splitItem.amount)).toFixed(2);

            mergedMap.set(splitItem.itemId, merged);
          } else {
            mergedMap.set(splitItem.itemId, { ...splitItem });
          }
        }

        finalItems = Array.from(mergedMap.values());
      }
      if (invoiceBody?.split?.splitWiseType == 'Split By Price') {
        const rootItems = items;
        const splitItems = invoiceBody.split?.items || [];
        const mergedMap = new Map();
        for (const item of rootItems) {
          const key = item.itemId.toString();
          if (mergedMap.has(key)) {
            const existingItem = mergedMap.get(key);

            mergedMap.set(key, {
              ...existingItem,
              rate: (existingItem.rate || 0) + (item.rate || 0),
            });
          } else {
            mergedMap.set(key, { ...item });
          }
        }

        for (const splitItem of splitItems) {
          const key = splitItem.itemId.toString();

          if (mergedMap.has(key)) {
            const merged = mergedMap.get(key);

            merged.rate = parseFloat(merged.rate || 0) + parseFloat(splitItem.rate || 0);

            merged.amount = (parseFloat(merged.amount || 0) + parseFloat(splitItem.amount || 0)).toFixed(2);

            mergedMap.set(key, merged);
          } else {
            mergedMap.set(key, { ...splitItem });
          }
        }

        finalItems = Array.from(mergedMap.values());
      }
    } else {
      finalItems = items;
    }

    if (salesOrders) {
      const salesOrderIds = salesOrders.map(order => new mongoose.Types.ObjectId(order.salesOrderId));

      const existingDC = await DeliveryChallan.findOne({
        salesOrders: {
          $elemMatch: {
            salesOrderId: { $in: salesOrderIds },
          },
        },
        status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
      })
        .select('_id challanId salesOrders')
        .session(session);

      if (existingDC) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'Invoice cannot be created directly from Sales Order because Delivery Challan already exists for one or more selected Sales Orders',
        );
      }

      await isFullyConverted(invoiceBody.items || [], session);
    }

    //add default warehouse entry
    if (invoiceBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: invoiceBody.items,
          warehouseId: warehouseId,
          branchId: invoiceBody.branchId,
          divisionId: invoiceBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }
    // Get inventory configuration
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.INVOICE, session);
    if (isInventoryEnabled) {
      inventoryConfig.stockDeductEnabled = true;
    }
    if (isFromStockTransferChallan) {
      inventoryConfig.stockCheckEnabled = false;
      inventoryConfig.stockDeductEnabled = false;
    }

    // Fetch stock details for all requested items

    const itemIds = finalItems.map(item => item.itemId);

    if (inventoryConfig?.stockCheckEnabled || inventoryConfig?.stockDeductEnabled) {
      await validateStockAvailability({ items: finalItems, companyId: invoiceBody.companyId, warehouseId: warehouseId }, session);
    }

    let ids = '';
    if (isSplit) {
      if (items.length > 0) {
        ids = await generateMultipleUniqueIdsForModules(
          Invoice,
          companyId,
          [
            {
              moduleName: MODULE_NAMES.INVOICE,
              idField: 'invoiceId',
              defaultPrefix: 'INV',
              count: 1,
              resultKey: 'mainInvoiceId',
              providedId: invoiceBody.invoiceId,
            },
            {
              moduleName: MODULE_NAMES.SPLIT_INVOICE,
              idField: 'invoiceId',
              defaultPrefix: 'SINV',
              count: 1,
              resultKey: 'splitInvoiceId',
              providedId: null,
            },
          ],
          session,
        );
      }
      if (items.length == 0) {
        ids = await generateMultipleUniqueIdsForModules(
          Invoice,
          companyId,
          [
            {
              moduleName: MODULE_NAMES.SPLIT_INVOICE,
              idField: 'invoiceId',
              defaultPrefix: 'SINV',
              count: 1,
              resultKey: 'splitInvoiceId',
            },
          ],
          session,
        );
      }
    } else {
      invoiceBody.invoiceId = await generateUniqueId(
        Invoice,
        companyId,
        MODULE_NAMES.INVOICE,
        'invoiceId',
        'INV',
        session,
        invoiceBody.invoiceId,
      );
    }

    let invoice = null;

    if (!currency) {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
        companyId,
        customerId,
      }));
    }
    const currencyDoc = await getCurrency(companyId, currency);

    if (commentHistory.length === 0) {
      commentHistory.push({
        message: `Invoice created for ${currencyDoc?.symbol || '₹'}${invoiceBody.total || 0}`,
        addedBy: userId,
        referenceType: 'Invoice',
        createdAt: new Date(),
      });
    }

    const bank = await getPrimaryBank(invoiceBody.companyId, session);

    if (invoiceBody.items.length > 0) {
      // Create Invoice
      const invoiceData = {
        ...invoiceBody,
        currency,
        exchangeRate: invoiceBody.exchangeRate ?? 1,
        decimalPlaces,
        authorizedSignature: company?.authorizedSignature,
        bankAccountId: bank?.accountId,
        items: sourceItems, // Use the items from the source document (or provided items if direct invoice)
        balanceAmount: invoiceBody.total,
        addedBy: userId,
        updatedBy: userId,
        inventoryConfig, // Store the latest config
        isFromStockTransferChallan,
        isSplit: false,
        commentHistory,
        attachments: allAttachments,
        companyGstin: company?.gstNumber,
        companyLogo: company?.companyLogo,
      };

      if (isSplit == true) {
        invoiceData.invoiceId = ids.mainInvoiceId;
      }

      //for direct so
      const today = new Date();
      //invoice days count
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');

      const formattedDate = `${yyyy}-${mm}-${dd}`;
      let diffDays = null;
      if (invoiceBody?.salesOrders?.length == 1) {
        const salesOrder = await SalesOrder.findById(invoiceBody?.salesOrders[0].salesOrderId).select('orderDate');
        const orderDate = new Date(salesOrder?.orderDate);
        const startDate = new Date(orderDate.toISOString().split('T')[0]);
        const endDate = new Date(formattedDate);
        let diffTime = endDate - startDate;
        diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        diffDays = diffDays === 0 ? 1 : diffDays;
      }

      if (
        invoiceBody?.deliveryChallanIds &&
        Array.isArray(invoiceBody.deliveryChallanIds) &&
        invoiceBody.deliveryChallanIds.length
      ) {
        const challanObjectIds = invoiceBody.deliveryChallanIds.map(dc => new mongoose.Types.ObjectId(dc.deliveryChallanId));

        const deliveryChallans = await DeliveryChallan.find({
          _id: { $in: challanObjectIds },
        }).select('salesOrders');

        const salesOrderIds = [
          ...new Set(deliveryChallans.flatMap(dc => dc.salesOrders || []).map(so => so.salesOrderId.toString())),
        ];

        if (salesOrderIds.length) {
          const salesOrders = await SalesOrder.find({
            _id: { $in: salesOrderIds.map(id => new mongoose.Types.ObjectId(id)) },
          }).select('orderDate');

          const earliestOrderDate = salesOrders.reduce(
            (earliest, so) => (!earliest || new Date(so.orderDate) < earliest ? new Date(so.orderDate) : earliest),
            null,
          );

          if (earliestOrderDate) {
            const startDate = new Date(earliestOrderDate.toISOString().split('T')[0]);
            const endDate = new Date(formattedDate);

            let diffTime = endDate - startDate;
            diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            diffDays = diffDays <= 0 ? 1 : diffDays;
          }
        }
      }

      invoiceData.orderToInvoiceDays = Math.max(0, diffDays ?? 0);
      invoice = await Invoice.create([invoiceData], { session });
    }

    // Update status of source documents
    if (quoteId) {
      // Update Quote status to COMPLETED when converted to invoice
      await Quote.updateOne(
        { _id: quoteId },
        {
          $set: { status: QUOTE_STATUS.COMPLETED, updatedBy: userId },
          $push: {
            commentHistory: {
              message: `Quote converted to Invoice ${invoiceBody.invoiceId}`,
              addedBy: userId,
              createdAt: new Date(),
              referenceType: 'Invoice',
              referenceId: invoice[0]._id,
            },
            convertedTo: {
              type: 'Invoice',
              documentId: invoice[0]._id,
              documentNo: invoiceBody.invoiceId || 'New Invoice',
              convertedAt: new Date(),
            },
          },
        },
        { session },
      );
    } else if (salesOrders) {
      // Update SalesOrder status to INVOICED (when converting directly to invoice)
      for (so of salesOrders) {
        const salesOrderDoc = await SalesOrder.findById(so.salesOrderId).session(session);
        salesOrderDoc.convertedTo = salesOrderDoc.convertedTo || [];
        salesOrderDoc.convertedTo.push({
          type: 'Invoice',
          documentId: invoice?.[0]?._id,
          documentNo: invoice?.[0]?.invoiceId || 'New Invoice',
          convertedAt: new Date(),
        });

        salesOrderDoc.updatedBy = userId;
        salesOrderDoc.commentHistory = salesOrderDoc.commentHistory || [];
        salesOrderDoc.commentHistory.push({
          message: `Sales Order converted to Invoice ${invoice[0].invoiceId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'Invoice',
          referenceId: invoice[0]._id,
        });

        await salesOrderDoc.save({ session });
      }
    } else if (deliveryChallanIds && deliveryChallanIds.length) {
      const challanObjectIds = deliveryChallanIds.map(id => new mongoose.Types.ObjectId(id.deliveryChallanId));

      const deliveryChallans = await DeliveryChallan.find({
        _id: { $in: challanObjectIds },
      }).session(session);

      if (deliveryChallans.length !== challanObjectIds.length) {
        throw new ApiError(httpStatus.NOT_FOUND, 'One or more Delivery Challans not found');
      }

      const updateFields = {
        status: DELIVERY_CHALLAN_STATUS.DELIVERED,
        $set: { updatedBy: userId },
        $push: {},
      };

      if (invoice?.length) {
        updateFields.$push.commentHistory = {
          message: `Delivery Challan converted to Invoice ${invoice[0]?.invoiceId}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'Invoice',
          referenceId: invoice[0]?._id,
        };

        if (itemIds?.length) {
          updateFields.$push.convertedTo = {
            type: 'Invoice',
            documentId: invoice[0]?._id,
            documentNo: invoice[0]?.invoiceId || 'New Invoice',
            convertedAt: new Date(),
          };
        }
      }

      await DeliveryChallan.updateMany({ _id: { $in: challanObjectIds } }, updateFields, { session });
    }

    //create split invoice
    let splitInvoice = null;

    if (isSplit && invoiceBody?.deliveryChallanIds?.length) {
      const {
        split,
        additionalCharges,
        referenceNumber,
        invoiceDate,
        dueDate,
        paymentTermsId,
        subject,
        customerNotes,
        termsAndConditions,
        attachments,
        isSplit,
        deliveryChallanIds,
      } = invoiceBody;

      const getBranchConfig = await CompanySettings.findOne({ companyId }).select('branchConfig');
      const branchConfig = getBranchConfig?.branchConfig || {};

      // Branch selection
      if (branchConfig?.splitConfig === true) {
        splitBranchId = branchConfig?.branchId || null;
      } else {
        splitBranchId = invoiceBody.branchId || null;
      }

      let splitWarehouseId, splitDivisionId;
      if (branchConfig?.splitConfig === true) {
        splitWarehouseId = branchConfig?.warehouseId || null;
        splitDivisionId = branchConfig?.divisionId || null;
      } else {
        splitWarehouseId = invoiceBody.warehouseId || null;
        splitDivisionId = invoiceBody.divisionId || null;
      }

      const bank = await getPrimaryBank(invoiceBody.companyId, session);

      const challanObjectIds = deliveryChallanIds.map(dc => new mongoose.Types.ObjectId(dc.deliveryChallanId));

      const deliveryChallans = await DeliveryChallan.find({
        _id: { $in: challanObjectIds },
      }).session(session);

      if (deliveryChallans.length !== challanObjectIds.length) {
        throw new ApiError(httpStatus.NOT_FOUND, 'One or more Delivery Challans not found');
      }

      let diffDays = 0;
      const today = new Date();
      const formattedDate = today.toISOString().split('T')[0];

      const salesOrderIds = [
        ...new Set(deliveryChallans.flatMap(dc => dc.salesOrders || []).map(so => so.salesOrderId.toString())),
      ];

      if (salesOrderIds.length) {
        const salesOrders = await SalesOrder.find({
          _id: { $in: salesOrderIds.map(id => new mongoose.Types.ObjectId(id)) },
        }).select('orderDate');

        const earliestOrderDate = salesOrders.reduce(
          (earliest, so) => (so?.orderDate && (!earliest || so.orderDate < earliest) ? so.orderDate : earliest),
          null,
        );

        if (earliestOrderDate) {
          const startDate = new Date(new Date(earliestOrderDate).toISOString().split('T')[0]);
          const endDate = new Date(formattedDate);

          diffDays = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));

          diffDays = diffDays === 0 ? 1 : diffDays;
        }
      }

      let splitInvoiceObj = {};
      splitInvoiceObj.authorizedSignature = company?.authorizedSignature;
      splitInvoiceObj.companyGstin = company?.gstNumber;
      splitInvoiceObj.companyLogo = company?.companyLogo;
      splitInvoiceObj.currency = currency;
      splitInvoiceObj.exchangeRate = exchangeRate;
      splitInvoiceObj.decimalPlaces = decimalPlaces;
      splitInvoiceObj.items = split.items;
      splitInvoiceObj.subTotal = split.total;
      splitInvoiceObj.sgst = 0;
      splitInvoiceObj.cgst = 0;
      splitInvoiceObj.igst = 0;
      splitInvoiceObj.totalTax = 0;
      splitInvoiceObj.total = split.total;
      splitInvoiceObj.branchId = splitBranchId;
      splitInvoiceObj.bankAccountId = bank?.accountId;
      splitInvoiceObj.divisionId = splitDivisionId;
      splitInvoiceObj.warehouseId = splitWarehouseId;

      splitInvoiceObj.additionalCharges = [];
      splitInvoiceObj.companyId = companyId;
      splitInvoiceObj.customerId = customerId;
      splitInvoiceObj.referenceNumber = referenceNumber;
      splitInvoiceObj.invoiceDate = invoiceDate;
      splitInvoiceObj.dueDate = dueDate;
      splitInvoiceObj.paymentTermsId = paymentTermsId;
      splitInvoiceObj.subject = subject;
      splitInvoiceObj.customerNotes = customerNotes;
      splitInvoiceObj.termsAndConditions = termsAndConditions;
      splitInvoiceObj.attachments = attachments;

      splitInvoiceObj.isSplit = true;
      splitInvoiceObj.splitWiseType = split.splitWiseType;
      splitInvoiceObj.status = SALES_ORDER_INVOICE_STATUS.DRAFT;

      splitInvoiceObj.balanceAmount = split.total;
      splitInvoiceObj.addedBy = userId;
      splitInvoiceObj.updatedBy = userId;
      splitInvoiceObj.inventoryConfig = inventoryConfig;
      splitInvoiceObj.isFromStockTransferChallan = isFromStockTransferChallan;
      splitInvoiceObj.invoiceId = ids.splitInvoiceId;

      splitInvoiceObj.deliveryChallanIds = deliveryChallanIds;

      splitInvoiceObj.orderToInvoiceDays = Math.max(0, diffDays ?? 0);
      splitInvoiceObj.splitWarehouseId = invoiceBody?.warehouseId;
      splitInvoiceObj.splitInvoiceId = invoice?.[0]?._id || null;
      splitInvoiceObj.addressId = invoiceBody?.addressId;
      splitInvoiceObj.roundOffAmount = split?.roundOffAmount;
      splitInvoiceObj.isRoundOff = split?.isRoundOff;

      splitInvoice = await Invoice.create([splitInvoiceObj], { session });
      if (invoice?.[0]) {
        await Invoice.updateOne(
          { _id: invoice[0]._id },
          {
            $set: {
              splitInvoiceId: splitInvoice[0]._id,
              splitWarehouseId: warehouseId,
            },
          },
          { session },
        );
      }
    }

    if (inventoryConfig?.stockDeductEnabled) {
      if (isSplit == false || !isSplit) {
        if (invoice && !invoice?.splitInvoiceId) {
          if (finalItems.length > 0) {
            for (let i of finalItems) {
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
                  companyId: invoiceBody?.companyId,
                  branchId: invoiceBody?.branchId,
                  warehouseId: invoiceBody?.warehouseId,
                  quantity: i.quantity,
                  itemUnitId: i.itemUnitId,
                  deductedSourceType: MODULE_NAMES.INVOICE,
                  deductedSourceId: invoice[0]._id,
                  sellingPrice: finalSellingPrice,
                },
                session,
              };

              const deductionSummary = await handleWarehouseStock(warehouseStockObj);

              // Add batch information to invoice item
              if (!i.batches) i.batches = [];
              i.batches.push(...deductionSummary);
            }

            await checkCompanyStockLevels({
              itemIds: finalItems.map(i => i.itemId),
              companyId: invoiceBody?.companyId,
              docType: MODULE_NAMES.INVOICE,
              docId: invoice[0]._id,
              docNo: invoice[0].invoiceId,
              userId,
              session,
            });
          }
        }

        // Update the invoice with the batches
        if (invoice && invoice[0]) {
          // Find the corresponding items in the invoice and update them with batches
          const claimInvoiceLine = createLineClaimer(invoice[0].items);
          for (let i of finalItems) {
            const invoiceItem = claimInvoiceLine(i);
            if (invoiceItem && i.batches) {
              invoiceItem.batches = i.batches;
            }
          }

          // Update the invoice in the database
          await Invoice.updateOne({ _id: invoice[0]._id }, { $set: { items: invoice[0].items } }, { session });
        }
      }

      if (isSplit == true) {
        if (invoiceBody?.split?.splitWiseType == 'Split By Qty') {
          if (invoice?.length > 0) {
            if (finalItems?.length > 0) {
              for (let i of finalItems) {
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
                    companyId: invoice[0]?.companyId,
                    branchId: invoice[0]?.branchId,
                    warehouseId: invoice[0]?.warehouseId,
                    quantity: i.quantity,
                    itemUnitId: i.itemUnitId,
                    deductedSourceType: MODULE_NAMES.INVOICE,
                    deductedSourceId: invoice[0]._id,
                    sellingPrice: finalSellingPrice,
                  },
                  session,
                };

                const deductionSummary = await handleWarehouseStock(warehouseStockObj);

                // Add batch information to invoice item
                if (!i.batches) i.batches = [];
                i.batches.push(...deductionSummary);
              }

              await checkCompanyStockLevels({
                itemIds: finalItems.map(i => i.itemId),
                companyId: invoice[0]?.companyId,
                docType: MODULE_NAMES.INVOICE,
                docId: invoice[0]._id,
                docNo: invoice[0].invoiceId,
                userId,
                session,
              });
            }

            // Update the invoice with the batches
            if (invoice && invoice[0]) {
              // Find the corresponding items in the invoice and update them with batches
              const claimInvoiceLine = createLineClaimer(invoice[0].items);
              for (let i of finalItems) {
                const invoiceItem = claimInvoiceLine(i);
                if (invoiceItem && i.batches) {
                  invoiceItem.batches = i.batches;
                }
              }

              // Update the invoice in the database
              await Invoice.updateOne({ _id: invoice[0]._id }, { $set: { items: invoice[0].items } }, { session });
            }
          }

          const isSplitInvoicePresent = Array.isArray(splitInvoice) && splitInvoice.length > 0;

          const isItemEmpty = !invoiceBody?.items || invoiceBody.items.length === 0;

          const isInvoiceNotCreated = !invoice;

          const condition = isSplitInvoicePresent && isItemEmpty && isInvoiceNotCreated;

          if (condition) {
            if (splitInvoice[0]?.items?.length > 0) {
              for (let item of splitInvoice[0].items) {
                let finalSellingPrice = item.rate;

                if (item.discountConfig) {
                  let discountAmount = 0;

                  if (item.discountConfig.discountType === 'PERCENTAGE' && item.discountConfig.discountValue > 0) {
                    discountAmount = (item.rate * item.discountConfig.discountValue) / 100;
                  } else if (item.discountConfig.discountType === 'AMOUNT' && item.discountConfig.discountValue > 0) {
                    discountAmount = item.discountConfig.discountValue / item.quantity;
                  }

                  finalSellingPrice = item.rate - discountAmount;
                }

                const warehouseStockObj = {
                  action: 'deductStock',
                  stockData: {
                    itemId: item.itemId,
                    companyId: splitInvoice[0].companyId,
                    branchId: splitInvoice[0].branchId,
                    warehouseId: splitInvoice[0].warehouseId,
                    quantity: item.quantity,
                    itemUnitId: item.itemUnitId,
                    deductedSourceType: MODULE_NAMES.SPLIT_INVOICE,
                    deductedSourceId: splitInvoice[0]._id,
                    sellingPrice: finalSellingPrice,
                  },
                  session,
                };

                const deductionSummary = await handleWarehouseStock(warehouseStockObj);

                item.batches = deductionSummary; // overwrite instead of push
              }

              await checkCompanyStockLevels({
                itemIds: splitInvoice[0].items.map(item => item.itemId),
                companyId: splitInvoice[0].companyId,
                docType: MODULE_NAMES.SPLIT_INVOICE,
                docId: splitInvoice[0]._id,
                docNo: splitInvoice[0].invoiceId,
                userId,
                session,
              });
            }

            await Invoice.updateOne({ _id: splitInvoice[0]._id }, { $set: { items: splitInvoice[0].items } }, { session });
          }
        }

        if (invoiceBody?.split?.splitWiseType == 'Split By Price') {
          if (finalItems.length > 0) {
            for (let i of finalItems) {
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
                  companyId: invoiceBody?.companyId,
                  branchId: invoiceBody?.branchId,
                  warehouseId: invoiceBody?.warehouseId,
                  quantity: i.quantity,
                  itemUnitId: i.itemUnitId,
                  deductedSourceType: MODULE_NAMES.INVOICE,
                  deductedSourceId: invoice[0]._id,
                  sellingPrice: finalSellingPrice,
                },
                session,
              };

              const deductionSummary = await handleWarehouseStock(warehouseStockObj);

              // Add batch information to invoice item
              if (!i.batches) i.batches = [];
              i.batches.push(...deductionSummary);
            }

            await checkCompanyStockLevels({
              itemIds: finalItems.map(i => i.itemId),
              companyId: invoiceBody?.companyId,
              docType: MODULE_NAMES.INVOICE,
              docId: invoice[0]._id,
              docNo: invoice[0].invoiceId,
              userId,
              session,
            });
          }

          // Update the invoice with the batches
          if (invoice && invoice[0]) {
            // Find the corresponding items in the invoice and update them with batches
            const claimInvoiceLine = createLineClaimer(invoice[0].items);
            for (let i of finalItems) {
              const invoiceItem = claimInvoiceLine(i);
              if (invoiceItem && i.batches) {
                invoiceItem.batches = i.batches;
              }
            }

            // Update the invoice in the database
            await Invoice.updateOne({ _id: invoice[0]._id }, { $set: { items: invoice[0].items } }, { session });
          }
        }
      }
    }

    if ((isSplit && deliveryChallanId) || (isSplit && deliveryChallanIds)) {
      const branches = [invoiceBody.branchId, splitBranchId.toString()];
      const totals = [total, splitTotal];
      for (let i = 0; i < branches.length; i++) {
        const branchId = branches[i];
        const amount = totals[i];

        await updateBranchCurrentBalance({
          customerId: customerId,
          branchId,
          amount: amount,
          session,
        });
      }
    } else {
      await updateBranchCurrentBalance({
        customerId: customerId,
        branchId,
        amount: total,
        session,
      });
    }

    if (invoice?.[0]) {
      await syncInvoiceJournal(companyId, invoice[0], userId, session);
    }
    if (splitInvoice?.[0]) {
      await syncInvoiceJournal(companyId, splitInvoice[0], userId, session);
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    const createdInvoice = items.length > 0 ? invoice[0] : splitInvoice[0];

    sendTransactionNotification({
      customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.INVOICE_CREATED,
      entityId: createdInvoice._id,
      entityDisplayId: createdInvoice.invoiceId,
      triggeredByUserId: userId,
    });

    // Save & Sent creates the main invoice already as SENT — notify with PDF.
    // Split-only invoices stay DRAFT and are skipped inside the helper.
    if (invoice?.[0]) {
      notifyModuleDocumentIfNonDraft({
        companyId,
        moduleName: MODULE_NAMES.INVOICE,
        document: invoice[0],
        initialStatus: INVOICE_STATUS.DRAFT,
      });
    }

    if (invoice?.[0]) {
      processIncentiveEarn(companyId, userId, 'INVOICE', invoice[0]._id, invoice[0].total, invoice[0].items);
    }
    if (splitInvoice?.[0]) {
      processIncentiveEarn(companyId, userId, 'INVOICE', splitInvoice[0]._id, splitInvoice[0].total, splitInvoice[0].items);
    }

    const { tryAutoPayForInvoice } = require('../../../services/companyAutoPay.service');
    const createdCandidates = [invoice?.[0], splitInvoice?.[0]].filter(Boolean);
    for (const created of createdCandidates) {
      if (created.status === INVOICE_STATUS.SENT) {
        await tryAutoPayForInvoice({ invoiceId: created._id, companyId, userId });
      }
    }

    return enrichDocumentCurrency(companyId, createdInvoice.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const buildInvoiceQuery = async filter => {
  const { Customer } = getBooksCrmModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const query = { companyId };

  if (filter?.isSplit == undefined) {
    query.isSplit = false;
  }

  if (filter?.isSplit) {
    query.isSplit = true;
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'invoiceDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
  }

  if (filter.status) {
    const statusArray = filter.status.split(',').filter(Boolean);

    if (statusArray.length > 0) {
      query.status = { $in: statusArray };
    }
  }

  if (filter.addedBy) {
    const addedByIds = filter.addedBy
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));
    if (addedByIds.length > 0) query.addedBy = { $in: addedByIds };
  }

  if (filter.eInvoicePending === 'true' || filter.eInvoicePending === true) {
    const b2bCustomers = await Customer.find({ companyId, 'otherDetails.gstinUin': { $nin: [null, ''] } }, { _id: 1 }).lean();
    query.$and = [
      ...(query.$and || []),
      { 'eInvoice.status': { $ne: E_INVOICE_STATUS.ACT.value } },
      { customerId: { $in: b2bCustomers.map(c => c._id) } },
    ];
  }

  if (filter.eWayBillPending === 'true' || filter.eWayBillPending === true) {
    query['eWayBill.eWayBillNo'] = { $exists: false };
  }

  if (filter.eInvoiceGenerated === true || filter.eInvoiceGenerated === 'true') {
    query['eInvoice.status'] = E_INVOICE_STATUS.ACT.value;
  }

  if (filter.eWayBillGenerated === true || filter.eWayBillGenerated === 'true') {
    query['eWayBill.status'] = E_WAY_BILL_STATUS.ACT.value;
  }

  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());

    const customers = await Customer.find(
      {
        companyId,
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );

    const customerIds = customers.map(c => c._id); // keep ObjectId

    query.$or = [
      { subject: searchRegex },
      { invoiceId: searchRegex },
      { referenceNumber: searchRegex },
      { customerId: { $in: customerIds } },
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

  // Country/State/City filters resolve through the address selected on the invoice (addressId)
  const addressCondition = await getAddressFilterCondition(Customer, companyId, filter);
  if (addressCondition) {
    (query.$and ||= []).push(addressCondition);
  }

  return query;
};

const queryInvoices = async (filter, options) => {
  const { Customer, Item, Branch, Division, Warehouse, PaymentReceived, PaymentTerm, ItemUnit } = getBooksCrmModels();
  const { Invoice } = getBooksModels();
  const { User } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const query = await buildInvoiceQuery(filter);

  if (options?.countOnly) {
    return { results: [], totalResults: await Invoice.countDocuments(query) };
  }

  // Clear populate
  delete options.populate;

  // Get paginated result
  const result = await Invoice.paginateWithTotal(query, options);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await Invoice.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  const invoiceIds = result.results.map(i => i._id);
  const paymentQuery = {
    'invoices.invoiceId': { $in: invoiceIds },
    status: { $ne: PAYMENT_STATUS.CANCELLED },
    companyId,
  };

  if (filter?.isSplit === undefined) {
    paymentQuery.isSplit = false;
  }
  const paymentsForInvoices = await PaymentReceived.find(paymentQuery).select(
    'invoices paymentReceivedId paymentDate status amountReceived',
  );

  const paymentsByInvoice = paymentsForInvoices.reduce((acc, payment) => {
    (payment.invoices || []).forEach(inv => {
      const key = inv.invoiceId?.toString();
      if (key) (acc[key] ||= []).push(payment);
    });
    return acc;
  }, {});

  // Collect all customerIds from results
  const customerIds = [...new Set(result.results.map(i => i.customerId))];
  const branchIds = [...new Set(result.results.map(i => i.branchId))];
  const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
  const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  // Collect all itemIds from results
  const itemIds = [...new Set(result.results.flatMap(invoice => invoice.items.map(item => item.itemId)))];
  const paymentTermIds = [...new Set(result.results.map(i => i.paymentTermsId?.toString()).filter(Boolean))];

  // Get customer data
  const customers = await Customer.find({
    _id: { $in: customerIds },
  })
    .select(
      'customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails branch useBranchPaymentTerms paymentTermsId',
    )
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

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

  // Get item data
  const items = await Item.find({
    _id: { $in: itemIds },
  })
    .select('itemName')
    .lean();

  const users = await User.find({ _id: { $in: userIds } })
    .select('firstName lastName')
    .lean();

  const paymentTerms = await PaymentTerm.find({ _id: { $in: paymentTermIds } }).lean();

  // Create maps
  const customerMap = customers.reduce((acc, c) => {
    acc[c._id.toString()] = c;
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

  const itemMap = items.reduce((acc, i) => {
    acc[i._id.toString()] = i;
    return acc;
  }, {});

  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  // Populate result
  const populatedResults = await Promise.all(
    result.results.map(async invoice => {
      const invoiceObj = invoice.toObject();

      invoiceObj.id = invoiceObj._id;
      invoiceObj.customerId = customerMap[invoice.customerId?.toString()] || null;
      invoiceObj.addressIn = findAddressById(invoiceObj.customerId?.address, invoiceObj.addressId);
      invoiceObj.branchId = branchMap[invoice.branchId?.toString()] || null;
      invoiceObj.divisionId = divisionMap[invoice.divisionId?.toString()] || null;
      invoiceObj.warehouseId = warehouseMap[invoice.warehouseId?.toString()] || null;
      invoiceObj.paymentTermsId = paymentTermMap[invoice.paymentTermsId?.toString()] || null;
      invoiceObj.addedBy = userMap[invoice.addedBy?.toString()] || null;
      const updatedById = toUpdatedByUserIdString(invoiceObj.updatedBy);
      const updatedBy = updatedById ? userMap[updatedById] : null;
      invoiceObj.orderToPaymentDays = invoiceObj?.orderToPaymentDays ?? null;
      invoiceObj.updatedBy = updatedBy || null;
      invoiceObj.items = invoiceObj.items.map(item => ({
        ...item,
        itemId: itemMap[item.itemId?.toString()] || null,
      }));

      if (invoiceObj?.splitInvoiceId) {
        const invoiceData = await Invoice.findById(invoiceObj.splitInvoiceId).select('invoiceId');
        invoiceObj.splitInvoiceNo = invoiceData?.invoiceId || '';
      }

      invoiceObj.payments = paymentsByInvoice[invoiceObj._id?.toString()] || [];

      return invoiceObj;
    }),
  );

  const populatedResultsWithCurrency = await enrichDocumentCurrency(
    String(filter.companyId),
    await attachItemSummaries(populatedResults),
  );

  const complianceCounts = {};
  if (filter.includeComplianceCount === 'true' || filter.includeComplianceCount === true) {
    const baseFilter = { ...filter, eInvoicePending: undefined, eWayBillPending: undefined };
    const [eInvoiceQuery, eWayBillQuery] = await Promise.all([
      buildInvoiceQuery({ ...baseFilter, eInvoicePending: true }),
      buildInvoiceQuery({ ...baseFilter, eWayBillPending: true }),
    ]);
    [complianceCounts.eInvoicePendingCount, complianceCounts.eWayBillPendingCount] = await Promise.all([
      Invoice.countDocuments(eInvoiceQuery),
      Invoice.countDocuments(eWayBillQuery),
    ]);
  }

  return {
    ...result,
    ...complianceCounts,
    results: populatedResultsWithCurrency,
  };
};

const queryInvoicesExports = async (filter, options) => {
  const result = await queryInvoices(filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const queryCustomerWisePendingInvoices = async (filter, options) => {
  const { Invoice } = getBooksModels();
  const { OpeningBalanceTransaction, Branch } = getBooksCrmModels();
  const isCreditMapping = filter?.forCreditMapping;
  delete filter.forCreditMapping;
  const allowCrossBranchMapping = !!filter?.allowCrossBranchMapping;
  delete filter.allowCrossBranchMapping;

  if (filter.branchId) {
    filter.branchId = new mongoose.Types.ObjectId(filter.branchId);
  }
  if (filter.divisionId) {
    filter.divisionId = new mongoose.Types.ObjectId(filter.divisionId);
  }
  if (filter.warehouseId) {
    filter.warehouseId = new mongoose.Types.ObjectId(filter.warehouseId);
  }

  filter.status = [
    SALES_ORDER_INVOICE_STATUS.SENT,
    SALES_ORDER_INVOICE_STATUS.PARTIALLY_PAID,
    SALES_ORDER_INVOICE_STATUS.PAID,
    SALES_ORDER_INVOICE_STATUS.OVERDUE,
  ];

  if (filter?.isSplit == undefined) {
    filter.isSplit = false;
  }

  filter.status = filter.isAdd ? filter.status : filter.status.filter(status => status !== SALES_ORDER_INVOICE_STATUS.PAID);

  const paymentBranchId = filter.branchId;
  if (allowCrossBranchMapping) {
    delete filter.branchId;
  }

  options.select = 'invoiceId invoiceDate total status balanceAmount branchId warehouseId divisionId isSplit dueDate tax';

  if (!options.sortBy) {
    options.sortBy = 'dueDate:asc';
  }

  const invoices = await Invoice.paginate(filter, options);
  invoices.results = await attachBranchNames(Branch, invoices.results || []);

  const customerId = filter.customerId ? new mongoose.Types.ObjectId(filter.customerId) : null;
  let openingBalanceTransactions = [];
  if (customerId && (!filter.isAdd || filter.balanceAmount)) {
    const obTypes = isCreditMapping
      ? [TRANSACTION_TYPE.CUSTOMER_CREDIT, TRANSACTION_TYPE.OPENING_RECEIVABLE]
      : [TRANSACTION_TYPE.OPENING_RECEIVABLE];
    const obBranchId = allowCrossBranchMapping ? null : paymentBranchId || filter.branchId;
    const obFilter = {
      contactId: customerId,
      contactType: 'customer',
      type: { $in: obTypes },
      remainingAmount: { $gt: 0 },
      ...(filter.companyId && { companyId: new mongoose.Types.ObjectId(filter.companyId) }),
      ...(obBranchId && { branchId: new mongoose.Types.ObjectId(obBranchId) }),
    };
    const openingBalanceList = await OpeningBalanceTransaction.find(obFilter)
      .select('transactionNo date amount remainingAmount branchId type')
      .sort({ date: 1 })
      .lean();
    openingBalanceTransactions = await attachBranchNames(Branch, openingBalanceList || []);
  }

  return {
    ...invoices,
    openingBalanceTransactions,
  };
};

const getInvoiceById = async (id, companyId) => {
  const { Customer, SalesOrder, Quote, Branch, Division, Warehouse, PaymentTerm, OpeningBalanceTransaction, ItemUnit } =
    getBooksCrmModels();
  const { Invoice, DeliveryChallan, InvoiceDispatch } = getBooksModels();
  const { User } = getCommonModels();
  // Get the invoice (only the line unit is populated; ItemUnit lives in booksCrm, so pass the model explicitly)
  const invoice = await Invoice.findOne({ _id: id, companyId }).populate({
    path: 'items.itemUnitId',
    select: 'name',
    model: ItemUnit,
  });

  if (!invoice) {
    throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  // Read before the challan references below are replaced with their details.
  const linkedChallanEWayBill = await findChallanWithActiveEWayBill(invoice);

  let so = [];
  if (invoice?.salesOrders?.length > 0) {
    for (let i of invoice.salesOrders) {
      const data = await SalesOrder.findById(i.salesOrderId).select(' status total orderDate orderId').lean();
      so.push({ ...data, salesOrderId: i.salesOrderId, salesOrderNo: i.salesOrderNo });
    }
  }
  // Get customer data
  const customer = await Customer.findById(invoice.customerId)
    .select(
      'customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails branch useBranchPaymentTerms paymentTermsId isCustomerDirectTax',
    )
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  if (invoice?.quoteId) {
    invoice.quoteId = await Quote.findById(invoice.quoteId).select('total quoteId status quoteDate');
  }

  if (invoice?.deliveryChallanId) {
    invoice.deliveryChallanId = await DeliveryChallan.findById(invoice.deliveryChallanId)
      .select('total challanId status challanDate')
      .lean();
  }

  let deliveryChallanIds = [];
  if (invoice?.deliveryChallanIds?.length) {
    for (let i of invoice.deliveryChallanIds) {
      const deliveryChallans = await DeliveryChallan.findById(i.deliveryChallanId)
        .select('total challanId status challanDate')
        .lean();
      deliveryChallanIds.push({ ...deliveryChallans, deliveryChallanId: i.deliveryChallanId, challanId: i.challanId });
    }
  }

  let invoiceDispatch = null;
  if (invoice?.invoiceDispatchId) {
    invoiceDispatch = await InvoiceDispatch.findById(invoice.invoiceDispatchId)
      .populate('transportCourier.transportId', 'name trackingLink bookingOfficeAddress gstNo')
      .lean();
  }

  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (invoice.commentHistory?.length) {
    const userIds = invoice.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = invoice.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  let shippingAddress = null;
  if (invoice.addressId) {
    if (invoice?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
      shippingAddress = customer.address.shipping;
    }

    if (!shippingAddress) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        addr => addr._id.toString() === invoice.addressId.toString(),
      );
    }
  }

  const addedBy = await User.findById(invoice.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(invoice.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findById(invoice.branchId).select('name');
  const division = await Division.findById(invoice.divisionId).select('name');
  const warehouse = await Warehouse.findById(invoice.warehouseId).select('name');
  const paymentTerm = invoice.paymentTermsId ? await PaymentTerm.findById(invoice.paymentTermsId).lean() : null;
  const primaryBankDetails = await getPrimaryBankDetails(invoice?.bankAccountId);
  // Convert invoice to object and populate the data
  const invoiceObj = invoice.toObject();
  invoiceObj.paymentTermsId = paymentTerm || null;

  invoiceObj.deliveryChallanIds = deliveryChallanIds;
  // The goods already travel on this challan's e-way bill, so the invoice cannot generate its own.
  invoiceObj.linkedChallanEWayBill = linkedChallanEWayBill
    ? { challanId: linkedChallanEWayBill.challanId, eWayBillNo: linkedChallanEWayBill.eWayBill.eWayBillNo }
    : null;

  if (invoiceObj?.splitInvoiceId) {
    const invoice = await Invoice.findById(invoiceObj.splitInvoiceId).select('invoiceId');
    invoiceObj.splitInvoiceNo = invoice?.invoiceId || '';
  }
  // Populate customer data
  invoiceObj.addedBy = addedBy;
  invoiceObj.updatedBy = updatedBy;
  invoiceObj.commentHistory = commentHistoryWithUser;
  invoiceObj.branchName = branch?.name || null;
  invoiceObj.divisionName = division?.name || null;
  invoiceObj.warehouseName = warehouse?.name || null;
  invoiceObj.bankAccountId = primaryBankDetails || {};
  invoiceObj.customerId = customer || null;
  invoiceObj.salesOrders = so;
  invoiceObj.shippingAddress = shippingAddress || null;
  invoiceObj.dispatchDetails = invoiceDispatch || null;

  // Not branch-pinned: cross-branch credit application is supported, so the affordance should appear
  // whenever the customer has an applicable credit in any branch (matching the cross-branch apply modal).
  invoiceObj.hasAvailableCredits = !!(await OpeningBalanceTransaction.exists({
    companyId: new mongoose.Types.ObjectId(companyId),
    contactId: invoice.customerId,
    contactType: CONTACT_TYPE.CUSTOMER,
    type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
    remainingAmount: { $gt: 0 },
  }));

  invoiceObj.moduleTree = await buildModuleTree(id);

  // Repair any blank snapshot from the Item master and attach a per-line itemIssue for the UI warning.
  invoiceObj.items = await enrichDocumentItemLines(invoiceObj.items, {
    companyId,
    warehouseId: invoiceObj.warehouseId,
    snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
  });

  return enrichDocumentCurrency(companyId, invoiceObj);
};

const updateInvoiceById = async (invoiceId, updateBody, userId, uploadedFile = null) => {
  const { Customer, Branch } = getBooksCrmModels();
  const { Invoice } = getBooksModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const {
      items: newItems,
      warehouseId,
      branchId,
      customerId,
      total,
      companyId,
      isInventoryEnabled,
      ...otherUpdateBody
    } = updateBody;

    const invoice = await Invoice.findOne({ _id: invoiceId, companyId }).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    // Enforce item selectability on update: newly added items must be active; items already on the
    // invoice are tolerated even if deactivated afterwards. (Display snapshot is repaired on read.)
    if (Array.isArray(newItems) && newItems.length) {
      const existingItemIds = new Set((invoice.items || []).map(line => line.itemId?.toString()));
      const enrichedUpdateItems = await enrichDocumentItemLines(newItems, {
        companyId,
        warehouseId,
        session,
        snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
      });
      assertResolvable(enrichedUpdateItems);
      assertSelectableForNewLines(
        enrichedUpdateItems.filter(line => line.itemId && !existingItemIds.has(String(line.itemId))),
        'invoice',
      );
    }

    const oldtotal = invoice.total;
    const company = await Company.findById(invoice.companyId).populate('baseCurrency').session(session);

    // Validate edit permissions
    validateEditPermissions(INVOICE_STATUS_CONFIG.EDIT_RESTRICTED_STATUSES, invoice.status);

    await validateCustomerForModule({
      customerId: updateBody?.customerId,
      branchId: updateBody?.branchId,
      companyId,
      totalAmount: updateBody?.total,
      previousTotal: oldtotal,
      addressId: updateBody?.addressId,
      moduleName: MODULE_NAMES.INVOICE,
      session,
      models: { Customer, Branch },
      isUpdate: true,
      skipOverdueCheck: true,
    });

    const uploadedUrls = await handleFileUpdate({
      newFiles: uploadedFile ? uploadedFile : [],
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: invoice.attachments ? invoice.attachments : [],
      userId,
      companyId: companyId,
    });

    //add default warehouse entry
    if (updateBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: updateBody.items,
          warehouseId: warehouseId,
          branchId: branchId,
          divisionId: updateBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    if (invoice?.inventoryConfig?.stockDeductEnabled && !isInventoryEnabled) {
      for (const item of invoice?.items) {
        await handleWarehouseStock({
          action: 'reverseDeduction',
          stockData: {
            itemId: item.itemId,
            companyId: invoice?.companyId,
            branchId: invoice?.branchId,
            warehouseId: invoice?.warehouseId,
            deductedSourceType: MODULE_NAMES.INVOICE,
            deductedSourceId: invoiceId,
          },
          session,
        });

        item.batches = [];
      }

      await checkCompanyStockLevels({
        itemIds: invoice.items.map(item => item.itemId),
        companyId: invoice?.companyId,
        docType: MODULE_NAMES.INVOICE,
        docId: invoiceId,
        docNo: invoice.invoiceId,
        userId,
        session,
      });
    }
    // Fetch latest inventory config for INVOICE module
    const latestInventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.INVOICE, session);
    if (isInventoryEnabled) {
      latestInventoryConfig.stockDeductEnabled = true;
    }
    // Its stock was moved by the stock transfer challans it came from.
    if (invoice.isFromStockTransferChallan) {
      latestInventoryConfig.stockCheckEnabled = false;
      latestInventoryConfig.stockDeductEnabled = false;
    }

    // Handle item changes if provided
    if (newItems && newItems.length > 0) {
      // Create maps for easy lookup
      const oldItemsMap = new Map(invoice.items.map(item => [item.itemId.toString(), item.quantity]));

      // Validate stock for new and modified items if stock check is enabled
      if (latestInventoryConfig.stockCheckEnabled || latestInventoryConfig.stockDeductEnabled) {
        // The validator compares per-item totals in the main unit, so only increases can fail.
        await validateStockAvailability(
          { items: newItems, oldItems: invoice.items, oldItemsMap, companyId: companyId, warehouseId: warehouseId },
          session,
        );
      }

      // Create old rate map and discount map BEFORE any modifications
      const oldRateMap = new Map();
      const oldDiscountMap = new Map();
      invoice.items.forEach(item => {
        oldRateMap.set(item.itemId.toString(), item.rate);
        oldDiscountMap.set(item.itemId.toString(), {
          type: item.discountConfig?.discountType,
          value: item.discountConfig?.discountValue,
        });
      });

      // Process inventory updates if stock reservation is enabled
      if (latestInventoryConfig.stockDeductEnabled) {
        for (const item of invoice?.items) {
          await handleWarehouseStock({
            action: 'reverseDeduction',
            stockData: {
              itemId: item.itemId,
              companyId: invoice?.companyId,
              branchId: invoice?.branchId,
              warehouseId: invoice?.warehouseId,
              deductedSourceType: MODULE_NAMES.INVOICE,
              deductedSourceId: invoiceId,
            },
            session,
          });

          item.batches = [];
        }

        await checkCompanyStockLevels({
          itemIds: invoice.items.map(item => item.itemId),
          companyId: invoice?.companyId,
          docType: MODULE_NAMES.INVOICE,
          docId: invoiceId,
          docNo: invoice.invoiceId,
          userId,
          session,
        });

        invoice.items = newItems;

        for (const item of newItems) {
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
              companyId: updateBody.companyId,
              branchId: updateBody.branchId,
              warehouseId: updateBody.warehouseId,
              quantity: item.quantity,
              itemUnitId: item.itemUnitId,
              deductedSourceType: MODULE_NAMES.INVOICE,
              deductedSourceId: invoiceId,
              sellingPrice: finalSellingPrice,
            },
            session,
          });

          if (!item?.batches) {
            item.batches = [];
          }

          item.batches.push(...deductionSummary);
        }

        await checkCompanyStockLevels({
          itemIds: newItems.map(item => item.itemId),
          companyId: updateBody.companyId,
          docType: MODULE_NAMES.INVOICE,
          docId: invoiceId,
          docNo: invoice.invoiceId,
          userId,
          session,
        });

        invoice.items = newItems;
      }
    }

    ((otherUpdateBody.total = total), (otherUpdateBody.customerId = customerId));
    otherUpdateBody.branchId = branchId;
    otherUpdateBody.balanceAmount = total;

    if (customerId && String(customerId) !== String(invoice.customerId)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: invoice.companyId,
        customerId,
      });
      otherUpdateBody.currency = currency;
      otherUpdateBody.decimalPlaces = decimalPlaces;
    }
    otherUpdateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(invoice.companyId, otherUpdateBody.currency || invoice.currency);
    const currencySymbol = currencyDoc?.symbol || company?.baseCurrency?.symbol || '₹';

    let updateMsg = 'Invoice updated.';
    if (oldtotal !== total) {
      updateMsg = `Invoice  updated. Amount changed from ${currencySymbol}${oldtotal} to ${currencySymbol}${total}`;
    }

    // Update the invoice with other fields
    Object.assign(invoice, {
      ...otherUpdateBody,
      items: newItems,
      authorizedSignature: company?.authorizedSignature,
      attachments: uploadedUrls,
      inventoryConfig: latestInventoryConfig,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    if (warehouseId) {
      invoice.warehouseId = warehouseId;
    }

    // Update modification details
    invoice.updatedBy = userId;
    invoice.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
    });
    await invoice.save({ session });

    if (invoice?.salesOrders?.length > 0) {
      const salesOrderIds = [...new Set(invoice.salesOrders.map(so => so.salesOrderId?.toString()).filter(Boolean))];
      for (const salesOrderId of salesOrderIds) {
        await recomputeSalesOrderStatus(salesOrderId, session);
      }
    }

    // Amounts may have changed — bring the ledger back in step with the saved invoice.
    await syncInvoiceJournal(companyId, invoice, userId, session);

    //update customer currentBalance
    let newCurrentBalance = total;

    if (newCurrentBalance == oldtotal) {
      newCurrentBalance = 0;
    }
    if (newCurrentBalance != oldtotal) {
      newCurrentBalance = total - oldtotal;
    }

    await updateBranchCurrentBalance({
      customerId: customerId,
      branchId,
      amount: newCurrentBalance,
      session,
    });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    processIncentiveEarn(companyId, userId, 'INVOICE', invoice._id, invoice.total, invoice.items);

    sendTransactionNotification({
      customerId: invoice.customerId,
      companyId: invoice.companyId,
      notificationType: NOTIFICATION_TYPE.INVOICE_UPDATED,
      entityId: invoice._id,
      entityDisplayId: invoice.invoiceId,
      triggeredByUserId: userId,
    });

    return enrichDocumentCurrency(invoice.companyId, invoice.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteInvoiceById = async (invoiceId, companyId, userId) => {
  const { Invoice, CreditNote, InvoiceDispatch, DeliveryChallan, RecurringInvoice, RecurringInvoiceHistory } = getBooksModels();
  const { PaymentReceived, SalesOrder, Quote } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const invoice = await Invoice.findOne({ _id: invoiceId, companyId }).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    const invoiceNo = invoice?.invoiceId;
    const relatedInvoiceIds = [invoice._id];
    if (invoice.splitInvoiceId) {
      relatedInvoiceIds.push(new mongoose.Types.ObjectId(invoice.splitInvoiceId));
    }

    const invoicesForCreditCheck = await Invoice.find({ _id: { $in: relatedInvoiceIds } })
      .select('openingBalanceApplications')
      .session(session)
      .lean();
    if (invoicesForCreditCheck.some(inv => (inv.openingBalanceApplications || []).length > 0)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Cannot delete Invoice because customer credit has been applied to it. Remove the credit applications first.',
      );
    }

    const paymentReceived = await PaymentReceived.find({
      invoices: {
        $elemMatch: {
          invoiceId: { $in: relatedInvoiceIds },
        },
      },
    }).session(session);

    if (paymentReceived.length > 0) {
      const orderIds = paymentReceived.map(inv => inv.paymentReceivedId).join(', ');
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete Invoice because a PaymentReceived has been created from it:${orderIds}`,
      );
    }

    const creditNote = await CreditNote.find({
      $or: [
        { invoiceId: { $in: relatedInvoiceIds } },
        {
          invoicesApplied: {
            $elemMatch: {
              invoiceId: { $in: relatedInvoiceIds },
            },
          },
        },
      ],
    }).session(session);

    if (creditNote.length > 0) {
      const orderIds = creditNote.map(inv => inv.creditNoteId).join(', ');

      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `Cannot delete Invoice because a CreditNote has been created from it:${orderIds}`,
      );
    }

    const invoiceDispatch = await InvoiceDispatch.find({
      invoiceId: { $in: relatedInvoiceIds },
    }).session(session);

    if (invoiceDispatch.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete Invoice because an InvoiceDispatch has been created from it.');
    }

    if (invoice?.inventoryConfig?.stockDeductEnabled && invoice.status !== INVOICE_STATUS.CANCELLED) {
      if (invoice?.splitInvoiceId) {
        let splitInvoice, mainInvoice;

        if (invoice?.isSplit) {
          splitInvoice = invoice;
          mainInvoice = await Invoice.findById(invoice?.splitInvoiceId).session(session);
        } else {
          mainInvoice = invoice;
          splitInvoice = await Invoice.findById(invoice?.splitInvoiceId).session(session);
        }

        if (splitInvoice?.splitWiseType == 'Split By Price') {
          for (const i of mainInvoice?.items) {
            const warehouseStockObj = {
              action: 'reverseDeduction',
              stockData: {
                itemId: i.itemId,
                companyId: mainInvoice.companyId,
                branchId: mainInvoice.branchId,
                warehouseId: mainInvoice.warehouseId,
                deductedSourceType: MODULE_NAMES.INVOICE,
                deductedSourceId: mainInvoice._id,
              },
              session,
            };
            await handleWarehouseStock(warehouseStockObj);
          }

          await checkCompanyStockLevels({
            itemIds: mainInvoice.items.map(i => i.itemId),
            companyId: mainInvoice.companyId,
            docType: MODULE_NAMES.INVOICE,
            docId: mainInvoice._id,
            docNo: mainInvoice.invoiceId,
            userId,
            session,
          });
        }

        if (splitInvoice?.splitWiseType == 'Split By Qty') {
          for (const i of mainInvoice?.items) {
            const warehouseStockObj = {
              action: 'reverseDeduction',
              stockData: {
                itemId: i.itemId,
                companyId: mainInvoice.companyId,
                branchId: mainInvoice.branchId,
                warehouseId: mainInvoice.warehouseId,
                deductedSourceType: MODULE_NAMES.INVOICE,
                deductedSourceId: mainInvoice._id,
              },
              session,
            };
            await handleWarehouseStock(warehouseStockObj);
          }

          await checkCompanyStockLevels({
            itemIds: mainInvoice.items.map(i => i.itemId),
            companyId: mainInvoice.companyId,
            docType: MODULE_NAMES.INVOICE,
            docId: mainInvoice._id,
            docNo: mainInvoice.invoiceId,
            userId,
            session,
          });
        }
      } else if (invoice?.isSplit && !invoice?.splitInvoiceId) {
        for (const i of invoice?.items) {
          const warehouseStockObj = {
            action: 'reverseDeduction',
            stockData: {
              itemId: i.itemId,
              companyId: invoice.companyId,
              branchId: invoice.branchId,
              warehouseId: invoice.warehouseId,
              deductedSourceType: MODULE_NAMES.SPLIT_INVOICE,
              deductedSourceId: invoice._id,
            },
            session,
          };
          await handleWarehouseStock(warehouseStockObj);
        }

        await checkCompanyStockLevels({
          itemIds: invoice.items.map(i => i.itemId),
          companyId: invoice.companyId,
          docType: MODULE_NAMES.SPLIT_INVOICE,
          docId: invoice._id,
          docNo: invoice.invoiceId,
          userId,
          session,
        });
      } else {
        for (const i of invoice?.items) {
          const warehouseStockObj = {
            action: 'reverseDeduction',
            stockData: {
              itemId: i.itemId,
              companyId: invoice.companyId,
              branchId: invoice.branchId,
              warehouseId: invoice.warehouseId,
              deductedSourceType: MODULE_NAMES.INVOICE,
              deductedSourceId: invoice._id,
            },
            session,
          };
          await handleWarehouseStock(warehouseStockObj);
        }

        await checkCompanyStockLevels({
          itemIds: invoice.items.map(i => i.itemId),
          companyId: invoice.companyId,
          docType: MODULE_NAMES.INVOICE,
          docId: invoice._id,
          docNo: invoice.invoiceId,
          userId,
          session,
        });
      }
    }

    let balanceInvoices = [];

    if (!invoice.isSplit) {
      balanceInvoices = [invoice];
    } else if (invoice?.isSplit && !invoice?.splitWiseType) {
      balanceInvoices = [invoice];
    } else {
      const relatedInvoice = invoice.splitInvoiceId ? await Invoice.findById(invoice.splitInvoiceId).session(session) : null;
      if (relatedInvoice) {
        balanceInvoices = [invoice, relatedInvoice];
      } else {
        balanceInvoices = [invoice];
      }
    }

    for (const inv of balanceInvoices) {
      if (inv.status === INVOICE_STATUS.CANCELLED) continue;

      await updateBranchCurrentBalance({
        customerId: inv.customerId,
        branchId: inv.branchId,
        amount: -Number(inv.total),
        session,
      });
    }

    let soEffectInvoice = invoice;

    if (invoice.isSplit === true) {
      const originalInvoice = await Invoice.findById(invoice.splitInvoiceId).session(session);

      if (originalInvoice) {
        soEffectInvoice = originalInvoice;
      }

      // if (!soEffectInvoice) {
      //   throw new ApiError(httpStatus.BAD_REQUEST, 'Main invoice not found for split invoice');
      // }
    }

    if (soEffectInvoice?.salesOrders?.length > 0) {
      const salesOrderIds = [...new Set(soEffectInvoice.salesOrders.map(so => so.salesOrderId?.toString()).filter(Boolean))];

      for (const salesOrderId of salesOrderIds) {
        const existingComment = await SalesOrder.findOne({
          _id: new mongoose.Types.ObjectId(salesOrderId),
          'commentHistory.referenceId': soEffectInvoice._id,
        }).session(session);

        const baseUpdate = {
          $pull: {
            convertedTo: {
              documentId: new mongoose.Types.ObjectId(soEffectInvoice._id),
            },
          },
          $set: { updatedBy: userId },
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
              arrayFilters: [{ 'target.referenceId': soEffectInvoice._id }],
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
                message: `Invoice No ${invoiceNo} deleted successfully`,
                addedBy: userId,
                createdAt: new Date(),
              },
            },
          },
          { session },
        );
      }
    }

    if (soEffectInvoice?.deliveryChallanIds?.length) {
      const challanObjectIds = soEffectInvoice.deliveryChallanIds.map(dc => new mongoose.Types.ObjectId(dc.deliveryChallanId));

      const challansWithComment = await DeliveryChallan.find({
        _id: { $in: challanObjectIds },
        'commentHistory.referenceId': soEffectInvoice._id,
      })
        .select('_id')
        .session(session);

      const challansWithCommentSet = new Set(challansWithComment.map(dc => dc._id.toString()));

      const baseUpdate = {
        $set: {
          status: DELIVERY_CHALLAN_STATUS.SENT,
          updatedBy: userId,
        },
        $pull: {
          convertedTo: {
            documentId: new mongoose.Types.ObjectId(soEffectInvoice._id),
          },
        },
      };

      if (challansWithCommentSet.size) {
        await DeliveryChallan.updateMany(
          {
            _id: { $in: [...challansWithCommentSet].map(id => new mongoose.Types.ObjectId(id)) },
          },
          {
            ...baseUpdate,
            $set: {
              ...baseUpdate.$set,
              'commentHistory.$[target].isDeleted': true,
            },
          },
          {
            arrayFilters: [{ 'target.referenceId': soEffectInvoice._id }],
            session,
          },
        );
      }

      const challansWithoutCommentIds = challanObjectIds.filter(id => !challansWithCommentSet.has(id.toString()));

      if (challansWithoutCommentIds.length) {
        await DeliveryChallan.updateMany({ _id: { $in: challansWithoutCommentIds } }, baseUpdate, { session });
      }

      if (!invoice.isSplit) {
        await DeliveryChallan.updateMany(
          { _id: { $in: challanObjectIds } },
          {
            $push: {
              commentHistory: {
                message: `Invoice No ${soEffectInvoice?.invoiceId} deleted successfully`,
                addedBy: userId,
                createdAt: new Date(),
              },
            },
          },
          { session },
        );
      }
    }

    if (soEffectInvoice?.quoteId) {
      const existingComment = await Quote.findOne({
        _id: invoice?.quoteId,
        'commentHistory.referenceId': soEffectInvoice._id,
      }).session(session);

      const baseUpdate = {
        $set: {
          status: QUOTE_STATUS.ACCEPTED,
          updatedBy: userId,
        },
        $pull: {
          convertedTo: {
            documentId: new mongoose.Types.ObjectId(soEffectInvoice._id),
          },
        },
      };

      if (existingComment) {
        await Quote.updateOne(
          { _id: soEffectInvoice?.quoteId },
          {
            ...baseUpdate,
            $set: {
              ...baseUpdate.$set,
              'commentHistory.$[target].isDeleted': true,
            },
          },
          {
            arrayFilters: [{ 'target.referenceId': soEffectInvoice._id }],
            session,
          },
        );
      } else {
        await Quote.updateOne({ _id: soEffectInvoice?.quoteId }, baseUpdate, { session });
      }

      await Quote.updateOne(
        { _id: soEffectInvoice?.quoteId },
        {
          $push: {
            commentHistory: {
              message: `Invoice No ${soEffectInvoice?.invoiceId} deleted successfully`,
              addedBy: userId,
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
    }

    const recurringInvoiceWithComment = await RecurringInvoice.findOne({
      'commentHistory.referenceId': invoice._id,
    }).session(session);

    if (recurringInvoiceWithComment) {
      await RecurringInvoice.updateOne(
        { _id: recurringInvoiceWithComment._id },
        {
          $set: {
            'commentHistory.$[target].isDeleted': true,
          },
        },
        {
          arrayFilters: [{ 'target.referenceId': invoice._id }],
          session,
        },
      );
    }

    // Reverse any issued journals before the documents disappear.
    for (const relatedInvoiceId of relatedInvoiceIds) {
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.INVOICE, sourceId: relatedInvoiceId },
        session,
      );
    }

    // Flag the recurring execution log's generated invoice as deleted (keep the
    // id/number for the audit trail) so its "Generated Invoice" link doesn't
    // point at a deleted document.
    await RecurringInvoiceHistory.updateMany(
      { companyId, generatedInvoiceId: { $in: relatedInvoiceIds } },
      { $set: { isGeneratedDeleted: true, generatedDeletedAt: new Date() } },
      { session },
    );

    await Invoice.deleteMany({ _id: { $in: relatedInvoiceIds } }, { session });

    if (soEffectInvoice?.salesOrders?.length > 0) {
      const salesOrderIds = [...new Set(soEffectInvoice.salesOrders.map(so => so.salesOrderId?.toString()).filter(Boolean))];
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

    cancelIncentiveLog(relatedInvoiceIds);

    sendTransactionNotification({
      customerId: invoice.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.INVOICE_DELETED,
      entityId: invoice._id,
      entityDisplayId: invoice.invoiceId,
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

const queryPendingInvoices = async (filter, options) => {
  const { Invoice, Expenses } = getBooksModels();
  const { OpeningBalanceTransaction, Branch } = getBooksCrmModels();
  const isCreditMapping = filter?.forCreditMapping;
  delete filter.forCreditMapping;
  const allowCrossBranchMapping = !!filter?.allowCrossBranchMapping;
  delete filter.allowCrossBranchMapping;
  const creditBranchId = filter.creditBranchId ? new mongoose.Types.ObjectId(filter.creditBranchId) : null;
  delete filter.creditBranchId;
  if (filter.branchId) {
    filter.branchId = new mongoose.Types.ObjectId(filter.branchId);
  }
  const paymentBranchId = filter.branchId;
  if (allowCrossBranchMapping) {
    delete filter.branchId;
  }
  filter.balanceAmount = { $gt: 0 };
  filter.status = { $in: [INVOICE_STATUS.SENT, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE] };

  if (filter?.isSplit == undefined) {
    filter.isSplit = false;
  }

  const pendingInvoices = await Invoice.find(filter)
    .select('invoiceId invoiceDate dueDate total status paidAmount balanceAmount isSplit branchId')
    .sort({ dueDate: 1 })
    .lean();

  let openingBalanceTransactions = [];
  if (filter.customerId) {
    const obTypes = isCreditMapping
      ? [TRANSACTION_TYPE.CUSTOMER_CREDIT, TRANSACTION_TYPE.OPENING_RECEIVABLE]
      : [TRANSACTION_TYPE.OPENING_RECEIVABLE];
    const obBranchId = allowCrossBranchMapping ? null : creditBranchId || paymentBranchId;
    const obFilter = {
      contactId: new mongoose.Types.ObjectId(filter.customerId),
      contactType: 'customer',
      type: { $in: obTypes },
      remainingAmount: { $gt: 0 },
      ...(filter.companyId && { companyId: new mongoose.Types.ObjectId(filter.companyId) }),
      ...(obBranchId && { branchId: obBranchId }),
    };
    const openingBalanceList = await OpeningBalanceTransaction.find(obFilter)
      .select('transactionNo date amount remainingAmount branchId type')
      .sort({ date: 1 })
      .lean();
    openingBalanceTransactions = await attachBranchNames(Branch, openingBalanceList || []);
  }

  let pendingExpenses = [];
  if (filter.customerId && !isCreditMapping && !filter.isSplit) {
    const expenseList = await Expenses.find({
      companyId: new mongoose.Types.ObjectId(filter.companyId),
      party: new mongoose.Types.ObjectId(filter.customerId),
      partyType: LEDGER_PARTY_TYPES.CUSTOMER,
      isBillable: true,
      balanceAmount: { $gt: 0 },
      ...(filter.branchId && { branchId: filter.branchId }),
    })
      .select('expenseId date total paidAmount balanceAmount billableStatus branchId')
      .sort({ date: 1 })
      .lean();
    pendingExpenses = await attachBranchNames(Branch, expenseList);
  }

  return {
    results: await attachBranchNames(Branch, pendingInvoices || []),
    openingBalanceTransactions,
    pendingExpenses,
  };
};

const getInvoicesForDropdown = async (filters, options = {}) => {
  const { Invoice } = getBooksModels();
  const { search, ...restFilters } = filters;

  const query = {
    ...restFilters,
    status: { $nin: [INVOICE_STATUS.DRAFT, INVOICE_STATUS.CANCELLED] },
    isSplit: { $ne: true },
  };

  const searchRegex = createSearchRegex(search);
  if (searchRegex) {
    query.invoiceId = searchRegex;
  }

  const result = await Invoice.paginate(query, {
    ...options,
    select: 'invoiceId',
    sortBy: options.sortBy || 'invoiceDate:desc',
  });

  const results = result.results.map(invoice => ({
    _id: invoice._id,
    invoiceId: invoice.invoiceId,
  }));

  return { ...result, results };
};

const updateInvoiceStatus = async (invoiceId, companyId, newStatus, userId) => {
  const { Invoice, CreditNote, DeliveryChallan, InvoiceDispatch, RecurringInvoice } = getBooksModels();
  const { PaymentReceived, SalesOrder, Quote } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const invoice = await Invoice.findOne({ _id: invoiceId, companyId }).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const oldStatus = invoice.status;
    const relatedInvoiceIds = [invoice._id];

    if (invoice.splitInvoiceId) {
      relatedInvoiceIds.push(new mongoose.Types.ObjectId(invoice.splitInvoiceId));
    }
    // Validate status transition (the cancel action is handled specially below)
    if (newStatus !== INVOICE_STATUS.CANCELLED) {
      validateStatusTransition(INVOICE_STATUS_CONFIG.STATUS_TRANSITIONS, oldStatus, newStatus);
    }

    let cancelSalesOrderIds = [];

    if (newStatus == INVOICE_STATUS.CANCELLED && invoice.status !== INVOICE_STATUS.CANCELLED) {
      const paymentReceived = await PaymentReceived.find({
        invoices: {
          $elemMatch: {
            invoiceId: { $in: relatedInvoiceIds },
          },
        },
        status: { $ne: PAYMENT_STATUS.CANCELLED },
      }).session(session);

      if (paymentReceived.length > 0) {
        const orderIds = paymentReceived.map(inv => inv.paymentReceivedId).join(', ');
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel Invoice because a PaymentReceived has been created from it:${orderIds}`,
        );
      }

      const creditNote = await CreditNote.find({
        status: { $ne: CREDIT_NOTE_STATUS.CANCELLED },
        $or: [
          { invoiceId: { $in: relatedInvoiceIds } },
          {
            invoicesApplied: {
              $elemMatch: {
                invoiceId: { $in: relatedInvoiceIds },
              },
            },
          },
        ],
      }).session(session);

      if (creditNote.length > 0) {
        const orderIds = creditNote.map(inv => inv.creditNoteId).join(', ');

        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot cancel Invoice because a CreditNote has been created from it:${orderIds}`,
        );
      }

      const invoiceDispatch = await InvoiceDispatch.find({
        invoiceId: { $in: relatedInvoiceIds },
      }).session(session);

      if (invoiceDispatch.length > 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot cancel Invoice because an InvoiceDispatch has been created from it.');
      }

      const invoiceWithOpeningBalanceCredit = await Invoice.findOne({
        _id: { $in: relatedInvoiceIds },
        companyId,
        openingBalanceApplications: {
          $elemMatch: { type: TRANSACTION_TYPE.CUSTOMER_CREDIT },
        },
      })
        .session(session)
        .select('_id')
        .lean();

      if (invoiceWithOpeningBalanceCredit) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          'This invoice cannot be canceled because it is linked to opening balance credit entries.',
        );
      }

      //deduct warehouseBatch stock
      let stockInvoices = [];
      let deductedInvoice = null;
      if (!invoice.isSplit) {
        // Case 1: normal invoice
        stockInvoices = [invoice];
        deductedInvoice = invoice;
      } else if (invoice.splitWiseType === 'Split By Qty') {
        // Case 2: split by quantity → combine both
        const relatedInvoice = await Invoice.findById(invoice.splitInvoiceId).session(session);
        deductedInvoice = relatedInvoice;
        if (relatedInvoice) {
          stockInvoices = [invoice, relatedInvoice];
        }
      } else {
        // Case 3: split but NOT by qty → only main invoice
        const mainInvoice = await Invoice.findById(invoice.splitInvoiceId).session(session);
        deductedInvoice = mainInvoice;
        if (mainInvoice && !mainInvoice.isSplit) {
          stockInvoices = [mainInvoice];
        }
      }

      const combinedItemsMap = new Map();

      for (const inv of stockInvoices) {
        for (const item of inv.items) {
          const key = item.itemId.toString();

          if (!combinedItemsMap.has(key)) {
            combinedItemsMap.set(key, {
              ...item.toObject(),
              quantity: Number(item.quantity),
            });
          } else {
            combinedItemsMap.get(key).quantity += Number(item.quantity);
          }
        }
      }

      const combinedItems = Array.from(combinedItemsMap.values());

      if (invoice?.inventoryConfig?.stockDeductEnabled && invoice.status !== INVOICE_STATUS.CANCELLED) {
        if (invoice?.splitInvoiceId) {
          let splitInvoice, mainInvoice;

          if (invoice?.isSplit) {
            splitInvoice = invoice;
            mainInvoice = await Invoice.findById(invoice?.splitInvoiceId).session(session);
          } else {
            mainInvoice = invoice;
            splitInvoice = await Invoice.findById(invoice?.splitInvoiceId).session(session);
          }

          if (splitInvoice?.splitWiseType == 'Split By Price') {
            for (const i of mainInvoice?.items) {
              const warehouseStockObj = {
                action: 'reverseDeduction',
                stockData: {
                  itemId: i.itemId,
                  companyId: mainInvoice.companyId,
                  branchId: mainInvoice.branchId,
                  warehouseId: mainInvoice.warehouseId,
                  deductedSourceType: MODULE_NAMES.INVOICE,
                  deductedSourceId: mainInvoice._id,
                },
                session,
              };
              await handleWarehouseStock(warehouseStockObj);
            }

            await checkCompanyStockLevels({
              itemIds: mainInvoice.items.map(i => i.itemId),
              companyId: mainInvoice.companyId,
              docType: MODULE_NAMES.INVOICE,
              docId: mainInvoice._id,
              docNo: mainInvoice.invoiceId,
              userId,
              session,
            });
          }

          if (splitInvoice?.splitWiseType == 'Split By Qty') {
            if (mainInvoice) {
              for (const i of mainInvoice?.items) {
                const warehouseStockObj = {
                  action: 'reverseDeduction',
                  stockData: {
                    itemId: i.itemId,
                    companyId: mainInvoice.companyId,
                    branchId: mainInvoice.branchId,
                    warehouseId: mainInvoice.warehouseId,
                    deductedSourceType: MODULE_NAMES.INVOICE,
                    deductedSourceId: mainInvoice._id,
                  },
                  session,
                };

                await handleWarehouseStock(warehouseStockObj);
              }

              await checkCompanyStockLevels({
                itemIds: mainInvoice.items.map(i => i.itemId),
                companyId: mainInvoice.companyId,
                docType: MODULE_NAMES.INVOICE,
                docId: mainInvoice._id,
                docNo: mainInvoice.invoiceId,
                userId,
                session,
              });
            }

            if (splitInvoice && !mainInvoice) {
              for (const i of splitInvoice?.items) {
                const warehouseStockObj = {
                  action: 'reverseDeduction',
                  stockData: {
                    itemId: i.itemId,
                    companyId: splitInvoice.companyId,
                    branchId: splitInvoice.branchId,
                    warehouseId: splitInvoice.warehouseId,
                    deductedSourceType: MODULE_NAMES.SPLIT_INVOICE,
                    deductedSourceId: splitInvoice._id,
                  },
                  session,
                };

                await handleWarehouseStock(warehouseStockObj);
              }

              await checkCompanyStockLevels({
                itemIds: splitInvoice.items.map(i => i.itemId),
                companyId: splitInvoice.companyId,
                docType: MODULE_NAMES.SPLIT_INVOICE,
                docId: splitInvoice._id,
                docNo: splitInvoice.invoiceId,
                userId,
                session,
              });

              await Invoice.updateOne(
                {
                  _id: splitInvoice._id,
                },
                {
                  $set: {
                    'items.$[].batches': [],
                  },
                },
                { session },
              );
            }
          }

          await Invoice.updateOne(
            {
              _id: mainInvoice._id,
            },
            {
              $set: {
                'items.$[].batches': [],
              },
            },
            { session },
          );
        } else if (invoice?.isSplit && !invoice?.splitInvoiceId) {
          for (const i of invoice?.items) {
            const warehouseStockObj = {
              action: 'reverseDeduction',
              stockData: {
                itemId: i.itemId,
                companyId: invoice.companyId,
                branchId: invoice.branchId,
                warehouseId: invoice.warehouseId,
                deductedSourceType: MODULE_NAMES.SPLIT_INVOICE,
                deductedSourceId: invoice._id,
              },
              session,
            };
            await handleWarehouseStock(warehouseStockObj);
          }

          await checkCompanyStockLevels({
            itemIds: invoice.items.map(i => i.itemId),
            companyId: invoice.companyId,
            docType: MODULE_NAMES.SPLIT_INVOICE,
            docId: invoice._id,
            docNo: invoice.invoiceId,
            userId,
            session,
          });

          await Invoice.updateOne(
            {
              _id: invoice._id,
            },
            {
              $set: {
                'items.$[].batches': [],
              },
            },
            { session },
          );
        } else {
          for (const i of invoice?.items) {
            const warehouseStockObj = {
              action: 'reverseDeduction',
              stockData: {
                itemId: i.itemId,
                companyId: invoice.companyId,
                branchId: invoice.branchId,
                warehouseId: invoice.warehouseId,
                deductedSourceType: MODULE_NAMES.INVOICE,
                deductedSourceId: invoice._id,
              },
              session,
            };
            await handleWarehouseStock(warehouseStockObj);
          }

          await checkCompanyStockLevels({
            itemIds: invoice.items.map(i => i.itemId),
            companyId: invoice.companyId,
            docType: MODULE_NAMES.INVOICE,
            docId: invoice._id,
            docNo: invoice.invoiceId,
            userId,
            session,
          });

          await Invoice.updateOne(
            {
              _id: invoice._id,
            },
            {
              $set: {
                'items.$[].batches': [],
              },
            },
            { session },
          );
        }
      }

      //customer balance effect
      let balanceInvoices = [];
      if (!invoice.isSplit) {
        balanceInvoices = [invoice];
      } else if (invoice?.isSplit && !invoice?.splitWiseType) {
        balanceInvoices = [invoice];
      } else {
        const relatedInvoice = invoice.splitInvoiceId ? await Invoice.findById(invoice.splitInvoiceId).session(session) : null;
        if (relatedInvoice) {
          balanceInvoices = [invoice, relatedInvoice];
        } else {
          balanceInvoices = [invoice];
        }
      }

      for (const inv of balanceInvoices) {
        if (inv.status === INVOICE_STATUS.CANCELLED) continue;

        await updateBranchCurrentBalance({
          customerId: inv.customerId,
          branchId: inv.branchId,
          amount: -Number(inv.total),
          session,
        });
      }

      //parent document updates
      let soEffectInvoice = invoice;

      if (invoice.isSplit === true) {
        const originalInvoice = await Invoice.findById(invoice.splitInvoiceId).session(session);

        if (originalInvoice) {
          soEffectInvoice = originalInvoice;
        }
        // if (!soEffectInvoice) {
        //   throw new ApiError(httpStatus.BAD_REQUEST, 'Main invoice not found for split invoice');
        // }
      }

      if (soEffectInvoice?.salesOrders?.length > 0) {
        cancelSalesOrderIds = [...new Set(soEffectInvoice.salesOrders.map(so => so.salesOrderId?.toString()).filter(Boolean))];
        await calculateRemainingQty(soEffectInvoice?.items, soEffectInvoice._id, soEffectInvoice.invoiceId, userId, session);
      }

      if (soEffectInvoice?.deliveryChallanIds?.length) {
        const challanObjectIds = soEffectInvoice.deliveryChallanIds.map(dc => new mongoose.Types.ObjectId(dc.deliveryChallanId));

        await DeliveryChallan.updateMany(
          { _id: { $in: challanObjectIds } },
          {
            $set: {
              status: DELIVERY_CHALLAN_STATUS.SENT,
              'commentHistory.$[target].isCancelled': true,
              updatedBy: userId,
            },
          },
          {
            arrayFilters: [{ 'target.referenceId': soEffectInvoice._id }],
            session,
          },
        );

        await DeliveryChallan.updateMany(
          { _id: { $in: challanObjectIds } },
          {
            $push: {
              commentHistory: {
                message: `Invoice No ${soEffectInvoice?.invoiceId} ${newStatus} successfully`,
                addedBy: userId,
                createdAt: new Date(),
              },
            },
          },
          { session },
        );
      }

      if (soEffectInvoice?.quoteId) {
        const existingComment = await Quote.findOne({
          _id: invoice?.quoteId,
          'commentHistory.referenceId': soEffectInvoice._id,
        }).session(session);

        const baseUpdate = {
          $set: {
            status: QUOTE_STATUS.ACCEPTED,
            updatedBy: userId,
          },
          $pull: {
            convertedTo: {
              documentId: new mongoose.Types.ObjectId(soEffectInvoice._id),
            },
          },
        };

        await Quote.updateOne({ _id: soEffectInvoice?.quoteId }, baseUpdate, { session });

        await Quote.updateOne(
          { _id: soEffectInvoice?.quoteId },
          {
            $push: {
              commentHistory: {
                message: `Invoice No ${soEffectInvoice?.invoiceId} ${newStatus} successfully`,
                addedBy: userId,
                createdAt: new Date(),
              },
            },
          },
          { session },
        );
      }

      const recurringInvoiceWithComment = await RecurringInvoice.findOne({
        'commentHistory.referenceId': invoice._id,
      }).session(session);

      if (recurringInvoiceWithComment) {
        await RecurringInvoice.updateOne(
          { _id: recurringInvoiceWithComment._id },
          {
            $set: {
              'commentHistory.$[target].isCancelled': true,
            },
          },
          {
            arrayFilters: [{ 'target.referenceId': invoice._id }],
            session,
          },
        );
      }
    }
    // Update invoice status
    const relatedBeforeUpdate = await Invoice.find({ _id: { $in: relatedInvoiceIds } }).session(session);
    const oldStatusById = new Map(relatedBeforeUpdate.map(doc => [doc._id.toString(), doc.status]));

    await Invoice.updateMany(
      { _id: { $in: relatedInvoiceIds } },
      {
        $set: { status: newStatus, updatedBy: userId },
        $push: {
          commentHistory: {
            message: `Invoice ${newStatus} successfully`,
            addedBy: userId,
            createdAt: new Date(),
          },
        },
      },
      { session },
    );

    for (const salesOrderId of cancelSalesOrderIds) {
      const soNewStatus = await recomputeSalesOrderStatus(salesOrderId, session);
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
          newStatus: soNewStatus,
        });
      }
    }

    // Ledger follows the persisted status for the invoice and its split counterpart.
    const relatedInvoices = await Invoice.find({ _id: { $in: relatedInvoiceIds } }).session(session);
    for (const relatedInvoice of relatedInvoices) {
      await syncInvoiceJournal(companyId, relatedInvoice, userId, session, oldStatusById.get(relatedInvoice._id.toString()));
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    if (newStatus === INVOICE_STATUS.CANCELLED) {
      cancelIncentiveLog(relatedInvoiceIds);
    }

    sendTransactionNotification({
      customerId: invoice.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.INVOICE_STATUS_CHANGED,
      entityId: invoice._id,
      entityDisplayId: invoice.invoiceId,
      triggeredByUserId: userId,
      newStatus,
    });

    // Split invoices are partial documents generated internally — the customer-facing
    // notification (email/WhatsApp) only makes sense for the original, unsplit invoice.
    if (isFirstStatusChange(oldStatus, newStatus, INVOICE_STATUS.DRAFT) && !invoice.isSplit) {
      const invoiceForNotification = { ...(invoice.toObject?.() || invoice), status: newStatus };

      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.INVOICE,
        document: invoiceForNotification,
      }).catch(err => logger.error(`Failed to send invoice customer notifications for ${invoice.invoiceId}: ${err.message}`));
    }

    if (oldStatus === INVOICE_STATUS.DRAFT && newStatus === INVOICE_STATUS.SENT) {
      const { tryAutoPayForInvoice } = require('../../../services/companyAutoPay.service');
      for (const relatedInvoiceId of relatedInvoiceIds) {
        await tryAutoPayForInvoice({ invoiceId: relatedInvoiceId, companyId, userId });
      }
    }

    return invoice;
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
    //get all item of sales order with qty
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

      //now get all items from deliveryChallan to check it is converted partially or fully in previous conversion
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

const calculateRemainingQty = async (items, id, invoiceId, userId, session) => {
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
              message: `Invoice No ${invoiceId} cancelled successfully`,
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

const joinProviderErrors = errors => {
  if (typeof errors === 'string') return errors;
  if (!Array.isArray(errors)) return '';
  return errors
    .flatMap(err => {
      if (err?.errorMsg) return [err.errorMsg];
      const codes = String(err?.errorCodes ?? '')
        .split(',')
        .map(code => code.trim())
        .filter(Boolean);
      return codes.map(code => EWAY_API_ERROR_CODES[code] || `Error code ${code}`);
    })
    .filter(Boolean)
    .join(', ');
};

const logNicFailureToInvoiceComment = async ({ invoiceId, operationLabel, reason, userId, companyId, since }) => {
  try {
    const { Invoice, UserThirdPartyApiLogs } = getBooksModels();

    const [usage] = await UserThirdPartyApiLogs.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          referenceId: new mongoose.Types.ObjectId(invoiceId),
          chargeAmount: { $ne: null },
          createdAt: { $gte: since },
        },
      },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]);

    if (!usage?.count) return;

    const invoice = await Invoice.findById(invoiceId, { invoiceId: 1, commentHistory: 1 });
    if (!invoice) return;

    const cleanReason = String(reason || 'Unknown error').trim();
    const reasonSentence = cleanReason.endsWith('.') ? cleanReason : `${cleanReason}.`;

    invoice.commentHistory.push({
      message: `${operationLabel} for Invoice No: ${invoice.invoiceId} failed. Reason: ${reasonSentence} Please retry — repeated attempts may be limited.`,
      addedBy: userId,
      createdAt: new Date(),
    });
    await invoice.save();
  } catch (err) {
    console.error('logNicFailureToInvoiceComment failed:', err?.message);
  }
};

const validateEInvoiceEligibility = (invoice, ewbDtls) => {
  if (invoice.eInvoice && invoice.eInvoice.status === E_INVOICE_STATUS.ACT.value) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'E Invoice already generated');
  }

  if (invoice.eInvoice && invoice.eInvoice.status === E_INVOICE_STATUS.CNL.value) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'An e-invoice (IRN) was already generated and cancelled for this invoice. As per GST rules, a new IRN cannot be generated for the same invoice number. Please raise a new invoice.',
    );
  }

  if (invoice.status === INVOICE_STATUS.CANCELLED) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'E-Invoice cannot be generated for a cancelled invoice.');
  }

  const hasActiveEWayBill = invoice.eWayBill && invoice.eWayBill.status === E_WAY_BILL_STATUS.ACT.value;
  return hasActiveEWayBill ? null : ewbDtls;
};

/** The linked delivery challan carrying an active e-way bill for the same goods, or null. */
const findChallanWithActiveEWayBill = async (invoice, session = null) => {
  const challanIds = [invoice?.deliveryChallanId, ...(invoice?.deliveryChallanIds || []).map(dc => dc.deliveryChallanId)].filter(
    Boolean,
  );
  if (!challanIds.length) return null;
  const { DeliveryChallan } = getBooksModels();
  return DeliveryChallan.findOne({
    _id: { $in: challanIds },
    companyId: invoice.companyId,
    'eWayBill.status': E_WAY_BILL_STATUS.ACT.value,
  })
    .select('challanId eWayBill.eWayBillNo')
    .session(session)
    .lean();
};

const assertNoChallanEWayBill = async (invoice, session = null) => {
  const challan = await findChallanWithActiveEWayBill(invoice, session);
  if (challan) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      DELIVERY_CHALLAN_MESSAGES.INVOICE_EWAY_BILL_ON_CHALLAN(challan.challanId, challan.eWayBill.eWayBillNo),
    );
  }
};

// Records the options the user chose on the generated e-invoice / e-way bill; `generatedFilter` keeps it off documents with none.
const saveGstDocumentOptionSnapshot = async ({ invoiceId, companyId, generatedFilter, snapshot, session }) => {
  if (!Object.keys(snapshot).length) return;
  const { Invoice } = getBooksModels();
  await Invoice.updateOne({ _id: invoiceId, companyId, ...generatedFilter }, { $set: snapshot }, { session });
};

const getInvoiceGstDocumentOptions = async (invoiceId, companyId) => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();

  const invoice = await Invoice.findOne({ _id: invoiceId, companyId }).select('customerId addressId additionalCharges').lean();
  if (!invoice) {
    throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const [customer, company] = await Promise.all([
    Customer.findOne({ _id: invoice.customerId, companyId })
      .select('companyName customerDisplayName address otherDetails.gstinUin')
      .lean(),
    Company.findById(companyId).select('name address additionalShippingAddresses').lean(),
  ]);

  return buildGstDocumentOptions({ document: invoice, company, customer });
};

const generateEInvoiceFromInvoice = async (
  invoiceId,
  ewbDtls,
  companyId,
  userId,
  items = [],
  updateItemMaster = false,
  eInvoiceOptions = null,
) => {
  const { Invoice } = getBooksModels();
  const { Customer, Item, ItemUnit } = getBooksCrmModels();
  const attemptStartedAt = new Date();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    if (items?.length > 0) {
      const hsnInvoice = await Invoice.findById(invoiceId);
      if (!hsnInvoice) {
        throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
      }
      const alreadyGenerated = hsnInvoice.eInvoice && hsnInvoice.eInvoice.status === E_INVOICE_STATUS.ACT.value;
      if (!alreadyGenerated) {
        let hsnChanged = false;
        const itemMasterUpdates = [];
        for (const item of items) {
          if (!item?.hsn || !item?.itemId) continue;
          const invoiceItem = hsnInvoice.items.find(
            invItem => invItem.itemId?.toString() === item.itemId.toString() && invItem.hsnCode !== item.hsn,
          );
          if (invoiceItem && invoiceItem.hsnCode !== item.hsn) {
            invoiceItem.hsnCode = item.hsn;
            hsnChanged = true;
            if (updateItemMaster) {
              itemMasterUpdates.push({
                updateOne: { filter: { _id: item.itemId, companyId }, update: { $set: { hsnCode: item.hsn } } },
              });
            }
          }
        }
        if (hsnChanged) {
          hsnInvoice.updatedBy = userId;
          await hsnInvoice.save();
        }
        if (itemMasterUpdates.length > 0) {
          await Item.bulkWrite(itemMasterUpdates);
        }
      }
    }

    await session.startTransaction();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const itemUnitIds = [];
    invoice.items.forEach(item => {
      if (item?.itemId && item?.itemUnitId) {
        itemUnitIds.push(item.itemUnitId.toString());
      }
    });

    const itemUnits = await ItemUnit.find({ _id: { $in: itemUnitIds }, companyId })
      .session(session)
      .lean();

    let effectiveEwbDtls = validateEInvoiceEligibility(invoice, ewbDtls);
    // The goods already travel on the linked challan's e-way bill; the e-invoice is still generated.
    if (effectiveEwbDtls && (await findChallanWithActiveEWayBill(invoice, session))) {
      effectiveEwbDtls = null;
    }

    const customer = await Customer.findById(invoice.customerId);
    if (!customer) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Customer not found');
    }
    const invoiceObj = invoice.toObject();
    invoiceObj.customer = customer.toObject();
    invoiceObj.items = invoiceObj.items.map(item => {
      const itemUnit = itemUnits.find(unit => unit._id.toString() === item.itemUnitId?.toString());
      return {
        ...item,
        itemUnitObj: itemUnit || null,
      };
    });
    invoiceObj.eInvoiceOptions = eInvoiceOptions;
    await attachItemServiceFlags({ document: invoiceObj, companyId });

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).session(session);

    const response = await providerOrchestrator.execute(
      'generateEInvoice',
      { invoiceData: invoiceObj, ewbDtlsValues: effectiveEwbDtls, company, items, session },
      { companyId, userId, referenceId: invoiceObj._id },
    );

    if (response.success) {
      await saveGstDocumentOptionSnapshot({
        invoiceId,
        companyId,
        generatedFilter: { 'eInvoice.irn': { $exists: true } },
        snapshot: buildEInvoiceOptionSnapshot({ options: eInvoiceOptions }),
        session,
      });
      await flushCompanyStockLevels(session);
      await session.commitTransaction();
      return response;
    }

    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to generate E Invoice');
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    await logNicFailureToInvoiceComment({
      invoiceId,
      operationLabel: 'E-Invoice generation',
      reason: error?.message,
      userId,
      companyId,
      since: attemptStartedAt,
    });
    throw error;
  } finally {
    await session.endSession();
  }
};

const generateFynamicsEInvoiceFromInvoice = async (invoiceId, ewbDtls, companyId, userId, items = []) => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const attemptStartedAt = new Date();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    if (items?.length > 0) {
      const hsnInvoice = await Invoice.findById(invoiceId);
      if (!hsnInvoice) {
        throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
      }
      const alreadyGenerated = hsnInvoice.eInvoice && hsnInvoice.eInvoice.status === E_INVOICE_STATUS.ACT.value;
      if (!alreadyGenerated) {
        let hsnChanged = false;
        for (const item of items) {
          if (!item?.hsn || !item?.itemId) continue;
          const invoiceItem = hsnInvoice.items.find(
            invItem => invItem.itemId?.toString() === item.itemId.toString() && invItem.hsnCode !== item.hsn,
          );
          if (invoiceItem && invoiceItem.hsnCode !== item.hsn) {
            invoiceItem.hsnCode = item.hsn;
            hsnChanged = true;
          }
        }
        if (hsnChanged) {
          hsnInvoice.updatedBy = userId;
          await hsnInvoice.save();
        }
      }
    }

    await session.startTransaction();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    let effectiveEwbDtls = validateEInvoiceEligibility(invoice, ewbDtls);
    if (effectiveEwbDtls && (await findChallanWithActiveEWayBill(invoice, session))) {
      effectiveEwbDtls = null;
    }

    const customer = await Customer.findById(invoice.customerId);
    if (!customer) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Customer not found');
    }
    const invoiceObj = invoice.toObject();
    invoiceObj.customer = customer.toObject();
    await attachItemServiceFlags({ document: invoiceObj, companyId });
    const response = await generateFynamicsEInvoice(invoiceObj, effectiveEwbDtls, companyId, userId, items, session);

    if (response.status == 1) {
      await flushCompanyStockLevels(session);
      await session.commitTransaction();
      return response;
    } else {
      const errorMessage = joinProviderErrors(response?.error);
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, errorMessage || 'Failed to generate E Invoice');
    }
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    await logNicFailureToInvoiceComment({
      invoiceId,
      operationLabel: 'E-Invoice generation',
      reason: error?.message,
      userId,
      companyId,
      since: attemptStartedAt,
    });
    throw error;
  } finally {
    await session.endSession();
  }
};

const refetchEInvoiceFromInvoice = async (invoiceId, companyId, userId) => {
  const { Invoice } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).session(session);
    const response = await providerOrchestrator.execute(
      'refetchEInvoice',
      { invoice, company, session },
      {
        companyId,
        userId,
        referenceId: invoice._id,
        preferredProvider: resolveProviderKey(invoice.eInvoice?.provider, company?.eInvoiceProvider),
      },
    );

    if (response.success) {
      await flushCompanyStockLevels(session);
      await session.commitTransaction();
      return response;
    }
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to fetch E-Invoice details');
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const generateEWayBillFromInvoice = async (invoiceId, ewbDtls, companyId, userId) => {
  const { Invoice } = getBooksModels();
  const attemptStartedAt = new Date();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (invoice.eWayBill && invoice.eWayBill.status === E_WAY_BILL_STATUS.ACT.value) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'E Way Bill already generated');
    }
    await assertNoChallanEWayBill(invoice, session);

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).session(session);

    const response = await providerOrchestrator.execute(
      'generateEWayBill',
      { invoiceData: invoice, ewbDtlsValues: ewbDtls, company, onlyEWayBill: false, session },
      { companyId, userId, referenceId: invoice._id },
    );

    if (response.success) {
      // const eWayBillPayload = {
      //   eWayBillNo: Number(response?.data?.EwbNo || 0),
      //   eWayBillDate: response?.data?.EwbDt ? new Date(response?.data?.EwbDt).toISOString() : null,
      //   eWayBillExpiryDate: response?.data?.EwbValidTill ? new Date(response?.data?.EwbValidTill).toISOString() : null,
      // };

      // if (ewbDtls?.TransId) {
      //   eWayBillPayload.transporterId = ewbDtls?.TransId;
      // }
      // eWayBillPayload.transDocNo = invoice.invoiceId;

      // if (ewbDtls?.TransName) {
      //   eWayBillPayload.transporterName = ewbDtls?.TransName;
      // }
      // if (ewbDtls?.TransMode) {
      //   eWayBillPayload.transportMode = ewbDtls?.TransMode;
      // }

      // if (ewbDtls?.TransMode === '1') {
      //   eWayBillPayload.vehicleNumber = ewbDtls?.VehNo;
      //   eWayBillPayload.vehicleType = ewbDtls?.VehType;
      // } else if (ewbDtls?.TransMode === '2') {
      //   eWayBillPayload.railwayReceiptNumber = ewbDtls?.RRNo;
      //   eWayBillPayload.railwayReceiptDate = ewbDtls?.RRDate;
      // } else if (ewbDtls?.TransMode === '3') {
      //   eWayBillPayload.airwayBillNumber = ewbDtls?.AWBNo;
      //   eWayBillPayload.airwayBillDate = ewbDtls?.AWBDate;
      // } else if (ewbDtls?.TransMode === '4') {
      //   eWayBillPayload.seawayBillNumber = ewbDtls?.BLNo;
      //   eWayBillPayload.seawayBillDate = ewbDtls?.BLDate;
      // }

      // const ewbInfo = response?.info?.find(infoItem => infoItem?.InfCd === 'EWBPPD');
      // if (ewbInfo && typeof ewbInfo?.Desc === 'string') {
      //   const match = ewbInfo.Desc.match(/(\d+)\s*KM/i);
      //   if (match && match[1]) {
      //     eWayBillPayload.distance = Number(match[1]);
      //   }
      // }

      // if ((!invoice?.eWayBill?.distance || invoice?.eWayBill?.status === E_WAY_BILL_STATUS.CNL.value) && ewbDtls?.Distance > 0) {
      //   eWayBillPayload.distance = ewbDtls?.Distance;
      // }
      // invoice.eWayBill = eWayBillPayload;
      // invoice.commentHistory.push({
      //   message: `E-Way Bill (No: ${invoice?.eWayBill?.eWayBillNo}) generated successfully for Invoice No: ${invoice?.invoiceId}.`,
      //   addedBy: userId,
      //   createdAt: new Date(),
      // });
      // invoice.updatedBy = userId;
      // await invoice.save({ session });
      await flushCompanyStockLevels(session);
      await session.commitTransaction();
      return response;
    }
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to generate E Way Bill');
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    await logNicFailureToInvoiceComment({
      invoiceId,
      operationLabel: 'E-Way Bill generation',
      reason: error?.message,
      userId,
      companyId,
      since: attemptStartedAt,
    });
    throw error;
  } finally {
    await session.endSession();
  }
};

const cancelEInvoiceFromInvoice = async (cancellationDetails, invoiceId, companyId, userId) => {
  const { Invoice } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (!invoice.eInvoice || !invoice.eInvoice.irn) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No e-invoice has been generated for this invoice.');
    }

    if (invoice.eInvoice.status !== E_INVOICE_STATUS.ACT.value) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'This e-invoice IRN is already cancelled.');
    }

    const hasLinkedActiveEWayBill =
      invoice.eWayBill &&
      invoice.eWayBill.status === E_WAY_BILL_STATUS.ACT.value &&
      invoice.eWayBill.linkedIrn &&
      invoice.eWayBill.linkedIrn === invoice.eInvoice.irn;
    if (hasLinkedActiveEWayBill) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'This IRN cannot be cancelled because an e-way bill generated from it is still active. Cancel that e-way bill first, then try cancelling the IRN.',
      );
    }

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).session(session);

    const response = await providerOrchestrator.execute(
      'cancelEInvoice',
      { cancellationDetails: { ...cancellationDetails, irn: invoice.eInvoice.irn }, company },
      { companyId, userId, referenceId: invoice._id, preferredProvider: resolveProviderKey(invoice.eInvoice.provider) },
    );

    invoice.eInvoice.status = E_INVOICE_STATUS.CNL.value;
    invoice.commentHistory.push({
      message: `E-Invoice (IRN: ${invoice?.eInvoice?.irn}) cancelled successfully for Invoice No: ${invoice?.invoiceId}.`,
      addedBy: userId,
      createdAt: new Date(),
    });
    invoice.updatedBy = userId;
    await invoice.save({ session });
    await flushCompanyStockLevels(session);
    await session.commitTransaction();
    return response;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const cancelEWayBillFromInvoice = async (cancellationDetails, invoiceId, companyId, userId) => {
  const { Invoice } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (!invoice.eWayBill || !invoice.eWayBill.eWayBillNo) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'E-Way Bill not found for this invoice');
    }

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).session(session);

    const response = await providerOrchestrator.execute(
      'cancelEWayBill',
      {
        cancellationDetails: { ...cancellationDetails, eWayBillNo: invoice.eWayBill.eWayBillNo },
        company,
      },
      { companyId, userId, referenceId: invoice._id, preferredProvider: resolveProviderKey(invoice.eWayBill.provider) },
    );

    invoice.eWayBill.status = E_WAY_BILL_STATUS.CNL.value;
    invoice.commentHistory.push({
      message: `E-Way Bill (No: ${invoice?.eWayBill?.eWayBillNo}) cancelled successfully for Invoice No: ${invoice?.invoiceId}.`,
      addedBy: userId,
      createdAt: new Date(),
    });
    invoice.updatedBy = userId;
    await invoice.save({ session });
    await flushCompanyStockLevels(session);
    await session.commitTransaction();

    return response;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const IRN_EWB_DETAIL_KEYS = ['Distance', 'VehNo', 'VehType', 'RRNo', 'RRDate', 'AWBNo', 'AWBDate', 'BLNo', 'BLDate'];

const toIrnEWayBillDetails = (ewbDtls = {}) => {
  const mapped = {};
  IRN_EWB_DETAIL_KEYS.forEach(key => {
    if (ewbDtls[key] !== undefined) mapped[key] = ewbDtls[key];
  });
  mapped.TransMode = ewbDtls.TransMode ?? ewbDtls.transportMode;
  mapped.TransId = ewbDtls.TransId ?? ewbDtls.transporterId;
  mapped.TransName = ewbDtls.TransName ?? ewbDtls.transporterName;
  Object.keys(mapped).forEach(k => {
    if (mapped[k] === undefined || mapped[k] === null || mapped[k] === '') delete mapped[k];
  });
  return mapped;
};

const generateEWayBillForInvoice = async (invoiceId, ewbDtls, companyId, userId, items = [], updateItemMaster = false) => {
  const { Company } = getCommonModels();
  const { Invoice } = getBooksModels();

  const company = await Company.findOne({ _id: companyId }, { applicableFeature: 1 }).lean();
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }
  if (!company.applicableFeature) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'E-invoice / e-way bill feature is not configured for this company');
  }

  const invoice = await Invoice.findById(invoiceId, { eInvoice: 1 }).lean();
  if (!invoice) {
    throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const hasActiveIrn = Boolean(invoice.eInvoice?.irn) && invoice.eInvoice?.status === E_INVOICE_STATUS.ACT.value;
  const canUseIrnFlow = company.applicableFeature === PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL;

  if (canUseIrnFlow && hasActiveIrn) {
    return generateEWayBillFromInvoice(invoiceId, toIrnEWayBillDetails(ewbDtls), companyId, userId);
  }

  return generateOnlyEWayBillFromInvoice(invoiceId, ewbDtls, companyId, userId, items, updateItemMaster);
};

const generateOnlyEWayBillFromInvoice = async (invoiceId, ewbDtls, companyId, userId, items = [], updateItemMaster = false) => {
  const { Invoice } = getBooksModels();
  const { Customer, Item, ItemUnit } = getBooksCrmModels();
  const attemptStartedAt = new Date();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    if (items?.length > 0) {
      const hsnInvoice = await Invoice.findById(invoiceId);
      if (!hsnInvoice) {
        throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
      }
      let hsnChanged = false;
      const itemMasterUpdates = [];
      for (const item of items) {
        if (!item?.hsn || !item?.itemId) continue;
        const invoiceItem = hsnInvoice.items.find(
          invItem => invItem.itemId?.toString() === item.itemId.toString() && invItem.hsnCode !== item.hsn,
        );
        if (invoiceItem && invoiceItem.hsnCode !== item.hsn) {
          invoiceItem.hsnCode = item.hsn;
          hsnChanged = true;
          if (updateItemMaster) {
            itemMasterUpdates.push({
              updateOne: { filter: { _id: item.itemId, companyId }, update: { $set: { hsnCode: item.hsn } } },
            });
          }
        }
      }
      if (hsnChanged) {
        hsnInvoice.updatedBy = userId;
        await hsnInvoice.save();
      }
      if (itemMasterUpdates.length > 0) {
        await Item.bulkWrite(itemMasterUpdates);
      }
    }

    await session.startTransaction();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const itemUnitIds = [];
    invoice.items.forEach(item => {
      if (item?.itemId && item?.itemUnitId) {
        itemUnitIds.push(item.itemUnitId.toString());
      }
    });

    const itemUnits = await ItemUnit.find({ _id: { $in: itemUnitIds }, companyId })
      .session(session)
      .lean();

    await assertNoChallanEWayBill(invoice, session);
    const customer = await Customer.findById(invoice.customerId);
    if (!customer) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Customer not found');
    }
    const invoiceObj = invoice.toObject();
    invoiceObj.customer = customer.toObject();
    invoiceObj.items = invoiceObj.items.map(item => {
      const itemUnit = itemUnits.find(unit => unit._id.toString() === item.itemUnitId?.toString());
      return {
        ...item,
        itemUnitObj: itemUnit || null,
      };
    });

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).session(session);

    const response = await providerOrchestrator.execute(
      'generateEWayBill',
      { invoiceData: invoiceObj, ewbDtlsValues: ewbDtls, company, onlyEWayBill: true, session },
      { companyId, userId, referenceId: invoiceObj._id },
    );

    if (!response.success) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Failed to generate E Way Bill');
    }
    await saveGstDocumentOptionSnapshot({
      invoiceId,
      companyId,
      generatedFilter: { 'eWayBill.eWayBillNo': { $exists: true } },
      snapshot: buildEWayBillOptionSnapshot({ options: ewbDtls, document: invoiceObj }),
      session,
    });
    await flushCompanyStockLevels(session);
    await session.commitTransaction();
    return response;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    await logNicFailureToInvoiceComment({
      invoiceId,
      operationLabel: 'E-Way Bill generation',
      reason: error?.message,
      userId,
      companyId,
      since: attemptStartedAt,
    });
    throw error;
  } finally {
    await session.endSession();
  }
};

const cancelOnlyEWayBillFromInvoice = async (cancellationDetails, invoiceId, companyId, userId) => {
  const { Invoice } = getBooksModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const invoice = await Invoice.findById(invoiceId).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    if (!invoice.eWayBill || !invoice.eWayBill.eWayBillNo) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'E-Way Bill not found for this invoice');
    }

    const { Company } = getCommonModels();
    const company = await Company.findById(companyId).session(session);

    const response = await providerOrchestrator.execute(
      'cancelEWayBill',
      {
        cancellationDetails: { ...cancellationDetails, eWayBillNo: invoice.eWayBill.eWayBillNo },
        company,
      },
      { companyId, userId, referenceId: invoice._id, preferredProvider: resolveProviderKey(invoice.eWayBill.provider) },
    );

    invoice.eWayBill.status = E_WAY_BILL_STATUS.CNL.value;
    invoice.commentHistory.push({
      message: `E-Way Bill (No: ${invoice?.eWayBill?.eWayBillNo}) cancelled successfully for Invoice No: ${invoice?.invoiceId}.`,
      addedBy: userId,
      createdAt: new Date(),
    });
    invoice.updatedBy = userId;
    await invoice.save({ session });
    await flushCompanyStockLevels(session);
    await session.commitTransaction();

    return response;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const paymentHistoryForInvoice = async (invoiceId, companyId) => {
  const { PaymentReceived } = getBooksCrmModels();
  const { CreditNote, Invoice } = getBooksModels();
  const payments = await PaymentReceived.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        'invoices.invoiceId': new mongoose.Types.ObjectId(invoiceId),
      },
    },
    {
      $project: {
        _id: 1,
        paymentReceivedId: 1,
        unusedAmount: 1,
        paymentDate: 1,
        paymentMode: 1,
        amountReceived: 1,
        status: 1,
        invoices: {
          $filter: {
            input: '$invoices',
            as: 'inv',
            cond: { $eq: ['$$inv.invoiceId', new mongoose.Types.ObjectId(invoiceId)] },
          },
        },
        openingBalanceTransactions: { $ifNull: ['$openingBalanceTransactions', []] },
      },
    },
  ]);

  const creditNotes = await CreditNote.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        'invoicesApplied.invoiceId': new mongoose.Types.ObjectId(invoiceId),
      },
    },
    {
      $project: {
        _id: 1,
        creditNoteId: 1,
        creditNoteDate: 1,
        availableBalance: 1,
        total: 1,
        status: 1,
        invoicesApplied: {
          $filter: {
            input: '$invoicesApplied',
            as: 'inv',
            cond: { $eq: ['$$inv.invoiceId', new mongoose.Types.ObjectId(invoiceId)] },
          },
        },
      },
    },
  ]);

  const invoiceObjectId = new mongoose.Types.ObjectId(invoiceId);
  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const invoice = await Invoice.findOne({ _id: invoiceObjectId, companyId: companyObjectId })
    .select('openingBalanceApplications invoiceId customerId')
    .lean();

  if (!invoice) {
    return { payments, creditNotes, openingBalanceApplications: [] };
  }

  const docApps = (invoice.openingBalanceApplications || []).map(a => ({
    ...a,
    applicationScope: 'invoice',
    invoiceNo: invoice.invoiceId,
  }));

  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const creditIdSet = new Set(docApps.map(a => a.openingBalanceTransactionId?.toString()).filter(Boolean));
  const creditsLinkedByInvoiceEntry = await OpeningBalanceTransaction.find({
    companyId: companyObjectId,
    contactId: invoice.customerId,
    contactType: CONTACT_TYPE.CUSTOMER,
    type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
    $or: [
      { 'paymentReceivedEntries.invoiceId': invoiceObjectId },
      ...(invoice.invoiceId ? [{ 'paymentReceivedEntries.invoiceNo': invoice.invoiceId }] : []),
    ],
  })
    .select('_id')
    .lean();
  for (const c of creditsLinkedByInvoiceEntry) {
    creditIdSet.add(String(c._id));
  }

  let obToObApps = [];
  if (creditIdSet.size) {
    const credits = await OpeningBalanceTransaction.find({
      _id: { $in: [...creditIdSet].map(id => new mongoose.Types.ObjectId(id)) },
      companyId: companyObjectId,
    })
      .select('transactionNo paymentReceivedEntries')
      .lean();

    for (const credit of credits) {
      for (const e of credit.paymentReceivedEntries || []) {
        if (e.invoiceId || !e.paymentDocumentNo) continue;
        if (e.entrySource && e.entrySource !== OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT) continue;
        // Only OB→OB apps applied from this invoice's Apply Credit context
        if (!invoice.invoiceId || e.invoiceNo !== invoice.invoiceId) continue;
        obToObApps.push({
          _id: e._id,
          openingBalanceTransactionId: credit._id,
          creditTxnId: credit._id,
          transactionNo: credit.transactionNo || `OB-${credit._id}`,
          targetTransactionNo: e.paymentDocumentNo,
          amountApplied: e.amountApplied,
          appliedDate: e.appliedDate,
          type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
          applicationScope: 'opening_balance',
        });
      }
    }
  }

  const fromPayments = obLinesFromPaymentsReceived(payments);
  const merged = [...docApps, ...obToObApps, ...fromPayments].sort(
    (a, b) => new Date(b.appliedDate || 0) - new Date(a.appliedDate || 0),
  );
  const openingBalanceApplications = await enrichObLines(merged, getBooksCrmModels);

  return {
    payments,
    creditNotes,
    openingBalanceApplications,
  };
};

const buildModuleTree = async invoiceId => {
  const { SalesOrder, PaymentReceived, Quote } = getBooksCrmModels();
  const { DeliveryChallan, Invoice, ProductionOrder } = getBooksModels();

  const moduleTree = { quotes: [] };

  /* ================= INVOICE ================= */

  const invoice = await Invoice.findById(invoiceId).select(
    '_id invoiceId invoiceDate status total deliveryChallanIds salesOrderIds quoteId',
  );

  if (!invoice) return moduleTree;

  const invoiceNode = {
    id: invoice._id,
    invoiceId: invoice.invoiceId,
    invoiceDate: invoice.invoiceDate,
    status: invoice.status,
    total: invoice.total,
    payments: [],
  };

  /* ================= PAYMENTS ================= */

  const payments = await PaymentReceived.find({
    'invoices.invoiceId': invoice._id,
  }).select('_id paymentReceivedId paymentDate status amountReceived');

  invoiceNode.payments = payments;

  /* ================= TRACE PARENTS ================= */

  const quoteMap = new Map();
  const rootSalesOrders = [];

  /* ============ CASE 1: FROM DELIVERY CHALLANS ============ */

  if (invoice.deliveryChallanIds?.length) {
    const dcIds = invoice.deliveryChallanIds.map(d => d.deliveryChallanId);

    const dcs = await DeliveryChallan.find({
      _id: { $in: dcIds },
    }).select('_id challanId challanDate status total salesOrders');

    for (const dc of dcs) {
      const dcNode = {
        id: dc._id,
        challanId: dc.challanId,
        challanDate: dc.challanDate,
        status: dc.status,
        total: dc.total,
        invoices: [invoiceNode],
      };

      const soIds = dc.salesOrders?.map(s => s.salesOrderId) || [];

      const salesOrders = await SalesOrder.find({
        _id: { $in: soIds },
      }).select('_id orderId orderDate status total quoteId');

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
          rootSalesOrders.push(soNode);
        }
      }
    }
  }

  /* ============ CASE 2: DIRECT FROM SALES ORDER ============ */

  if (invoice.salesOrderIds?.length) {
    const soIds = invoice.salesOrderIds.map(s => s.salesOrderId);

    const salesOrders = await SalesOrder.find({
      _id: { $in: soIds },
    }).select('_id orderId orderDate status total quoteId');

    for (const so of salesOrders) {
      const soNode = {
        id: so._id,
        orderId: so.orderId,
        orderDate: so.orderDate,
        status: so.status,
        total: so.total,
        invoices: [invoiceNode],
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
        rootSalesOrders.push(soNode);
      }
    }
  }

  /* ============ CASE 3: DIRECT FROM QUOTE ============ */

  if (invoice.quoteId) {
    const quote = await Quote.findById(invoice.quoteId).select('_id quoteId quoteDate status total');

    if (quote) {
      quoteMap.set(quote._id.toString(), {
        id: quote._id,
        quoteId: quote.quoteId,
        quoteDate: quote.quoteDate,
        status: quote.status,
        total: quote.total,
        invoices: [invoiceNode],
      });
    }
  }

  /* ================= BUILD ROOT ================= */

  moduleTree.quotes = Array.from(quoteMap.values());

  if (rootSalesOrders.length) {
    moduleTree.salesOrders = rootSalesOrders;
  }

  if (!moduleTree.quotes.length && !rootSalesOrders.length) {
    moduleTree.invoice = invoiceNode; // direct invoice
  }

  return moduleTree;
};

const createSplitInvoice = async (invoiceBody, userId, uploadedFile = []) => {
  const { Customer, Branch } = getBooksCrmModels();
  const { Invoice } = getBooksModels();
  const { Company } = getCommonModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFile ? uploadedFile : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: invoiceBody.companyId,
    });

    const { items, warehouseId, branchId, total, customerId, companyId, isSplit, isInventoryEnabled } = invoiceBody;

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    //give msg if brach do not exist in mention customerid
    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(customerId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(customerId, branchId, session);
    }

    invoiceBody.invoiceId = await generateUniqueId(
      Invoice,
      companyId,
      MODULE_NAMES.SPLIT_INVOICE,
      'invoiceId',
      'INV',
      session,
      invoiceBody.invoiceId,
    );

    // Get inventory configuration
    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.INVOICE, session);
    if (isInventoryEnabled) {
      inventoryConfig.stockDeductEnabled = true;
    }

    //add default warehouse entry
    if (invoiceBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: invoiceBody.items,
          warehouseId: warehouseId,
          branchId: invoiceBody.branchId,
          divisionId: invoiceBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    let commentHistory = [];

    // Fetch stock details for all requested items

    if (inventoryConfig?.stockCheckEnabled || inventoryConfig?.stockDeductEnabled) {
      await validateStockAvailability({ items, companyId: invoiceBody.companyId, warehouseId: warehouseId }, session);
    }

    let invoice = null;
    const { currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
      companyId,
      customerId,
    });
    const currencyDoc = await getCurrency(companyId, currency);

    if (commentHistory.length === 0) {
      commentHistory.push({
        message: `Invoice created for ${currencyDoc?.symbol || '₹'}${invoiceBody.total || 0}`,
        addedBy: userId,
        referenceType: 'Invoice',
        createdAt: new Date(),
      });
    }

    const bank = await getPrimaryBank(invoiceBody.companyId, session);

    await validateCustomerForModule({
      customerId: invoiceBody.customerId,
      branchId: invoiceBody.branchId,
      companyId,
      totalAmount: invoiceBody.total,
      addressId: invoiceBody.addressId,
      moduleName: MODULE_NAMES.SPLIT_INVOICE,
      session,
      models: { Customer, Branch, Invoice },
    });
    // Create Invoice
    const invoiceData = {
      ...invoiceBody,
      currency,
      exchangeRate,
      decimalPlaces,
      authorizedSignature: company?.authorizedSignature,
      bankAccountId: bank?.accountId,
      balanceAmount: invoiceBody.total,
      addedBy: userId,
      updatedBy: userId,
      inventoryConfig, // Store the latest config
      isSplit: true,
      commentHistory,
      attachments: allAttachments,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };

    invoice = await Invoice.create([invoiceData], { session });

    await updateBranchCurrentBalance({
      customerId: customerId,
      branchId,
      amount: total,
      session,
    });

    if (inventoryConfig?.stockDeductEnabled) {
      if (isSplit == true) {
        if (items.length > 0) {
          for (let i of items) {
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
                companyId: invoiceBody?.companyId,
                branchId: invoiceBody?.branchId,
                warehouseId: invoiceBody?.warehouseId,
                quantity: i.quantity,
                itemUnitId: i.itemUnitId,
                deductedSourceType: MODULE_NAMES.SPLIT_INVOICE,
                deductedSourceId: invoice[0]._id,
                sellingPrice: finalSellingPrice,
              },
              session,
            };

            const deductionSummary = await handleWarehouseStock(warehouseStockObj);

            // Add batch information to invoice item
            if (!i.batches) i.batches = [];
            i.batches.push(...deductionSummary);
          }

          await checkCompanyStockLevels({
            itemIds: items.map(i => i.itemId),
            companyId: invoiceBody?.companyId,
            docType: MODULE_NAMES.SPLIT_INVOICE,
            docId: invoice[0]._id,
            docNo: invoice[0].invoiceId,
            userId,
            session,
          });
        }

        // Update the invoice with the batches
        if (invoice && invoice[0]) {
          // Find the corresponding items in the invoice and update them with batches
          const claimInvoiceLine = createLineClaimer(invoice[0].items);
          for (let i of items) {
            const invoiceItem = claimInvoiceLine(i);
            if (invoiceItem && i.batches) {
              invoiceItem.batches = i.batches;
            }
          }

          // Update the invoice in the database
          await Invoice.updateOne({ _id: invoice[0]._id }, { $set: { items: invoice[0].items } }, { session });
        }
      }
    }

    if (invoice?.[0]) {
      await syncInvoiceJournal(companyId, invoice[0], userId, session);
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, invoice[0].toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const applyCustomerCreditToInvoice = async (
  customerId,
  companyId,
  branchId,
  applications = [],
  userId = null,
  contextInvoiceId = null,
) => {
  const { Invoice } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const customerObjectId = new mongoose.Types.ObjectId(customerId);

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const companyProfile = await getCompanyProfile(companyId, session);

    let contextInvoiceNo = null;
    if (contextInvoiceId) {
      const contextInvoice = await Invoice.findOne({
        _id: contextInvoiceId,
        companyId: companyObjectId,
        customerId: customerObjectId,
      })
        .select('invoiceId')
        .session(session)
        .lean();
      contextInvoiceNo = contextInvoice?.invoiceId || null;
    }

    for (const { openingBalanceTransactionId, invoiceId, targetOpeningBalanceTransactionId, amountApplied } of applications) {
      if (!openingBalanceTransactionId || !amountApplied || amountApplied <= 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Each application must include credit and a positive amount');
      }
      if (!invoiceId && !targetOpeningBalanceTransactionId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Each application must include an invoice or opening balance target');
      }
      if (invoiceId && targetOpeningBalanceTransactionId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Provide either invoice or opening balance target, not both');
      }

      const creditTxn = await OpeningBalanceTransaction.findOne({
        _id: openingBalanceTransactionId,
        companyId: companyObjectId,
        contactId: customerObjectId,
        contactType: CONTACT_TYPE.CUSTOMER,
        type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
      }).session(session);

      if (!creditTxn) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance credit not found');
      }

      if (creditTxn.remainingAmount < amountApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Applied amount exceeds remaining credit');
      }

      if (targetOpeningBalanceTransactionId) {
        const receivableTxn = await OpeningBalanceTransaction.findOne({
          _id: targetOpeningBalanceTransactionId,
          companyId: companyObjectId,
          contactId: customerObjectId,
          contactType: CONTACT_TYPE.CUSTOMER,
          type: TRANSACTION_TYPE.OPENING_RECEIVABLE,
        }).session(session);
        if (!receivableTxn) {
          throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance receivable not found');
        }
        if (creditTxn.currency && receivableTxn.currency && String(creditTxn.currency) !== String(receivableTxn.currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency credit application is not supported.');
        }
        if (receivableTxn.remainingAmount < amountApplied) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Applied amount exceeds opening balance remaining');
        }
        if (String(creditTxn._id) === String(receivableTxn._id)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot apply credit to itself');
        }

        const okCredit = await creditTxn.updateRemainingAmount(amountApplied, session);
        if (!okCredit) {
          throw new ApiError(httpStatus.CONFLICT, 'Could not apply credit; please retry');
        }
        const okReceivable = await receivableTxn.updateRemainingAmount(amountApplied, session);
        if (!okReceivable) {
          throw new ApiError(httpStatus.CONFLICT, 'Could not update opening balance; please retry');
        }
        await moveAdvanceApplyBranchBalances({
          customerId: customerObjectId,
          paymentBranchId: creditTxn.branchId,
          documentBranchId: receivableTxn.branchId,
          amount: amountApplied,
          session,
        });

        const obApplicationId = new mongoose.Types.ObjectId();
        const appliedDate = new Date();
        const creditPush = await OpeningBalanceTransaction.findOneAndUpdate(
          { _id: creditTxn._id, companyId: companyObjectId },
          {
            $push: {
              paymentReceivedEntries: {
                _id: obApplicationId,
                entrySource: OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT,
                paymentDocumentNo: receivableTxn.transactionNo || `OB-${receivableTxn._id}`,
                ...(contextInvoiceNo ? { invoiceNo: contextInvoiceNo } : {}),
                amountApplied,
                appliedDate,
              },
            },
          },
          { session, new: true },
        );
        if (!creditPush) {
          throw new ApiError(httpStatus.CONFLICT, 'Could not record opening balance entry; please retry');
        }
        await ledgerService.postCrossBranchCreditApplyJournal(
          {
            companyId: companyObjectId,
            partyId: customerObjectId,
            partyType: LEDGER_PARTY_TYPES.CUSTOMER,
            creditBranchId: creditTxn.branchId,
            documentBranchId: receivableTxn.branchId,
            creditDivisionId: creditTxn.divisionId,
            documentDivisionId: receivableTxn.divisionId,
            amount: amountApplied,
            postingDate: appliedDate,
            sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
            sourceId: obApplicationId,
            narration: `Customer credit applied to opening balance ${receivableTxn.transactionNo || receivableTxn._id}`,
            addedBy: userId,
            currencyId: creditTxn.currency || receivableTxn.currency,
            exchangeRate: creditTxn.exchangeRate || receivableTxn.exchangeRate,
          },
          session,
        );
        continue;
      }

      const invoice = await Invoice.findOne({
        _id: invoiceId,
        companyId: companyObjectId,
        customerId: customerObjectId,
      }).session(session);
      if (!invoice) {
        throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
      }

      if (creditTxn.currency && invoice.currency && String(creditTxn.currency) !== String(invoice.currency)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency credit application is not supported.');
      }

      if (invoice.balanceAmount < amountApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Applied amount exceeds invoice balance');
      }

      const ok = await creditTxn.updateRemainingAmount(amountApplied, session);
      if (!ok) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not apply credit; please retry');
      }
      await moveAdvanceApplyBranchBalances({
        customerId: customerObjectId,
        paymentBranchId: creditTxn.branchId,
        documentBranchId: invoice.branchId,
        amount: amountApplied,
        session,
      });
      await updateInvoicePaymentStatus(invoice._id, amountApplied, userId, session);
      const invoiceApplicationId = new mongoose.Types.ObjectId();
      const appliedDate = new Date();

      await invoice.updateOne(
        {
          $push: {
            openingBalanceApplications: {
              _id: invoiceApplicationId,
              openingBalanceTransactionId: creditTxn._id,
              transactionNo: creditTxn.transactionNo || `OB-${creditTxn._id}`,
              amountApplied,
              appliedDate,
              type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
            },
            commentHistory: {
              message: `Customer credit applied for ${companyProfile?.baseCurrency?.symbol || '₹'}${amountApplied}`,
              addedBy: userId,
              createdAt: new Date(),
            },
          },
        },
        { session },
      );
      const obPushResult = await OpeningBalanceTransaction.findOneAndUpdate(
        {
          _id: creditTxn._id,
          companyId: companyObjectId,
          contactId: customerObjectId,
          contactType: CONTACT_TYPE.CUSTOMER,
          type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
        },
        {
          $push: {
            paymentReceivedEntries: {
              _id: invoiceApplicationId,
              entrySource: OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT,
              invoiceId: invoice._id,
              invoiceNo: invoice.invoiceId,
              invoiceApplicationId,
              paymentDocumentNo: invoice.invoiceId,
              amountApplied,
              appliedDate,
            },
          },
        },
        { session, new: true },
      );
      if (!obPushResult) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not record opening balance entry; please retry');
      }
      await ledgerService.postCrossBranchCreditApplyJournal(
        {
          companyId: companyObjectId,
          partyId: customerObjectId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          creditBranchId: creditTxn.branchId,
          documentBranchId: invoice.branchId,
          creditDivisionId: creditTxn.divisionId,
          documentDivisionId: invoice.divisionId,
          amount: amountApplied,
          postingDate: appliedDate,
          sourceModule: LEDGER_SOURCE_MODULES.INVOICE,
          sourceId: invoiceApplicationId,
          narration: `Customer credit applied to invoice ${invoice.invoiceId}`,
          addedBy: userId,
          currencyId: invoice.currency || creditTxn.currency,
          exchangeRate: invoice.exchangeRate || creditTxn.exchangeRate,
        },
        session,
      );
    }

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return { success: true };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const autoMapOpeningBalanceToInvoices = async (filter = {}) => {
  const { companyId, customerId, branchId, isSplit } = filter;
  const { Invoice } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const creditMatch = {
    companyId: companyObjectId,
    contactType: CONTACT_TYPE.CUSTOMER,
    type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
    remainingAmount: { $gt: 0 },
    ...(customerId ? { contactId: new mongoose.Types.ObjectId(customerId) } : {}),
    ...(branchId ? { branchId: new mongoose.Types.ObjectId(branchId) } : {}),
  };

  const creditGroups = await OpeningBalanceTransaction.aggregate([
    { $match: creditMatch },
    { $sort: { contactId: 1, branchId: 1, date: 1, createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: { customerId: '$contactId', branchId: '$branchId' },
        creditIds: { $push: '$_id' },
      },
    },
  ]);

  if (!creditGroups.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No opening balance credits available for auto mapping');
  }

  let groupsProcessed = 0;
  let mappedCredits = 0;
  let mappedInvoices = 0;
  let totalMappedAmount = 0;
  let attemptedMappings = 0;
  let successfulMappings = 0;
  let failedMappings = 0;
  const failures = [];
  let hasPendingInvoices = false;

  for (const group of creditGroups) {
    const { customerId, branchId } = group._id;

    const pendingInvoices = await Invoice.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          customerId,
          branchId,
          balanceAmount: { $gt: 0 },
          status: {
            $in: [INVOICE_STATUS.SENT, INVOICE_STATUS.PARTIALLY_PAID, INVOICE_STATUS.OVERDUE],
          },
          ...(isSplit !== undefined ? { isSplit: !!isSplit } : {}),
        },
      },
      { $project: { _id: 1, invoiceId: 1, dueDate: 1, createdAt: 1, balanceAmount: 1 } },
      { $sort: { dueDate: 1, createdAt: 1, _id: 1 } },
    ]);

    if (!pendingInvoices.length) continue;
    hasPendingInvoices = true;

    const creditIdsInOrder = group.creditIds || [];
    const creditFound = await OpeningBalanceTransaction.find({ _id: { $in: creditIdsInOrder } })
      .select('_id remainingAmount transactionNo')
      .lean();
    const creditMap = new Map(creditFound.map(c => [c._id.toString(), c]));
    const orderedCredits = creditIdsInOrder.map(id => creditMap.get(id.toString())).filter(Boolean);

    const invoiceIdsInOrder = pendingInvoices.map(inv => inv._id);
    const invoiceFound = await Invoice.find({ _id: { $in: invoiceIdsInOrder } })
      .select('_id invoiceId balanceAmount')
      .lean();
    const invoiceMap = new Map(invoiceFound.map(inv => [inv._id.toString(), inv]));
    const orderedInvoices = invoiceIdsInOrder.map(id => invoiceMap.get(id.toString())).filter(Boolean);

    const creditRemainingMap = new Map(orderedCredits.map(c => [c._id.toString(), Number(c.remainingAmount) || 0]));
    const invoiceRemainingMap = new Map(orderedInvoices.map(inv => [inv._id.toString(), Number(inv.balanceAmount) || 0]));
    const touchedCreditIds = new Set();

    let creditIndex = 0;
    let invoiceIndex = 0;

    while (creditIndex < orderedCredits.length && invoiceIndex < orderedInvoices.length) {
      const credit = orderedCredits[creditIndex];
      const invoice = orderedInvoices[invoiceIndex];

      const creditRemaining = creditRemainingMap.get(credit._id.toString()) || 0;
      if (creditRemaining <= 0) {
        creditIndex += 1;
        continue;
      }

      const invoiceRemaining = invoiceRemainingMap.get(invoice._id.toString()) || 0;
      if (invoiceRemaining <= 0) {
        invoiceIndex += 1;
        continue;
      }

      const amountApplied = Math.min(creditRemaining, invoiceRemaining);
      if (amountApplied <= 0) break;

      attemptedMappings += 1;
      try {
        await applyCustomerCreditToInvoice(customerId, companyId, branchId, [
          {
            openingBalanceTransactionId: credit._id,
            invoiceId: invoice._id,
            amountApplied,
          },
        ]);
      } catch (error) {
        failedMappings += 1;
        if (failures.length < 100) {
          failures.push({
            openingBalanceTransactionId: credit._id,
            transactionNo: credit.transactionNo || `OB-${credit._id}`,
            invoiceId: invoice._id,
            invoiceNo: invoice.invoiceId,
            amountApplied,
            message: error?.message || 'Failed to auto map opening balance to invoice',
          });
        }
        invoiceIndex += 1;
        continue;
      }

      touchedCreditIds.add(credit._id.toString());
      creditRemainingMap.set(credit._id.toString(), creditRemaining - amountApplied);
      invoiceRemainingMap.set(invoice._id.toString(), invoiceRemaining - amountApplied);
      totalMappedAmount += amountApplied;
      mappedInvoices += 1;
      successfulMappings += 1;

      if ((creditRemainingMap.get(credit._id.toString()) || 0) <= 0) creditIndex += 1;
      if ((invoiceRemainingMap.get(invoice._id.toString()) || 0) <= 0) invoiceIndex += 1;
    }

    if (touchedCreditIds.size > 0) {
      groupsProcessed += 1;
      mappedCredits += touchedCreditIds.size;

      await OpeningBalanceTransaction.updateMany(
        { _id: { $in: [...touchedCreditIds].map(id => new mongoose.Types.ObjectId(id)) } },
        {
          $set: { updatedAt: new Date() },
        },
      );
    }
  }

  if (!hasPendingInvoices) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No pending invoices found for auto mapping');
  }

  return {
    groupsProcessed,
    mappedCredits,
    mappedInvoices,
    totalMappedAmount,
    attemptedMappings,
    successfulMappings,
    failedMappings,
    failures,
    success: hasPendingInvoices && failedMappings === 0,
  };
};

const removeOpeningBalanceApplicationFromInvoice = async (invoiceId, companyId, applicationId, userId = null) => {
  const { Invoice } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const applicationObjectId = new mongoose.Types.ObjectId(applicationId);

  const invoiceForLookup = await Invoice.findOne({ _id: invoiceId, companyId: companyObjectId }).select(
    'customerId openingBalanceApplications',
  );
  if (!invoiceForLookup) {
    throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
  }
  const onInvoice = invoiceForLookup.openingBalanceApplications?.id?.(applicationId);
  if (!onInvoice) {
    const credit = await OpeningBalanceTransaction.findOne({
      companyId: companyObjectId,
      contactId: invoiceForLookup.customerId,
      contactType: CONTACT_TYPE.CUSTOMER,
      type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
      $or: [
        { 'paymentReceivedEntries._id': applicationObjectId },
        { 'paymentReceivedEntries.invoiceApplicationId': applicationObjectId },
      ],
    });
    const entry = (credit?.paymentReceivedEntries || []).find(
      e =>
        !e.invoiceId &&
        e.paymentDocumentNo &&
        (String(e._id) === String(applicationObjectId) || String(e.invoiceApplicationId) === String(applicationObjectId)),
    );
    if (entry && credit) {
      return removeOpeningBalanceApplicationFromOb(String(credit._id), companyId, applicationId);
    }
    throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance application not found');
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const invoice = await Invoice.findOne({ _id: invoiceId, companyId: companyObjectId }).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, INVOICE_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const companyProfile = await getCompanyProfile(companyId, session);

    const sub = invoice.openingBalanceApplications.id(applicationId);
    if (!sub) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance application not found');
    }

    const amountToRestore = Number(sub.amountApplied);
    if (!Number.isFinite(amountToRestore) || amountToRestore <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid amount on opening balance application');
    }

    if (!sub._id) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid opening balance application');
    }

    const obUpdated = await OpeningBalanceTransaction.findOneAndUpdate(
      {
        _id: sub.openingBalanceTransactionId,
        companyId: companyObjectId,
        contactId: invoice.customerId,
        contactType: CONTACT_TYPE.CUSTOMER,
        type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
      },
      {
        $inc: { remainingAmount: amountToRestore },
        $pull: {
          paymentReceivedEntries: {
            $or: [{ invoiceApplicationId: sub._id }, { _id: sub._id }],
          },
        },
      },
      { session, new: true },
    );

    if (!obUpdated) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'This opening balance application cannot be removed');
    }

    await moveAdvanceApplyBranchBalances({
      customerId: invoice.customerId,
      paymentBranchId: obUpdated.branchId,
      documentBranchId: invoice.branchId,
      amount: amountToRestore,
      session,
      reverse: true,
    });

    await ledgerService.deleteJournal(
      { companyId: companyObjectId, sourceModule: LEDGER_SOURCE_MODULES.INVOICE, sourceId: sub._id },
      session,
    );

    const ok = await updateInvoicePaymentStatus(invoice._id, -amountToRestore, userId, session);
    if (!ok) {
      throw new ApiError(httpStatus.CONFLICT, 'Could not update invoice; please retry');
    }

    await Invoice.updateOne(
      { _id: invoice._id, companyId: companyObjectId },
      {
        $pull: { openingBalanceApplications: { _id: sub._id } },
        $push: {
          commentHistory: {
            message: `Customer credit removed for ${companyProfile?.baseCurrency?.symbol || '₹'}${amountToRestore}`,
            addedBy: userId,
            createdAt: new Date(),
          },
        },
      },

      { session },
    );

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return { success: true };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const removeOpeningBalanceApplicationFromOb = async (creditTxnId, companyId, applicationId) => {
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const applicationObjectId = new mongoose.Types.ObjectId(applicationId);

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const creditTxn = await OpeningBalanceTransaction.findOne({
      _id: creditTxnId,
      companyId: companyObjectId,
      contactType: CONTACT_TYPE.CUSTOMER,
      type: TRANSACTION_TYPE.CUSTOMER_CREDIT,
    }).session(session);

    if (!creditTxn) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance credit not found');
    }

    const entry = (creditTxn.paymentReceivedEntries || []).find(e => {
      if (e.invoiceId || !e.paymentDocumentNo) return false;
      return String(e._id) === String(applicationObjectId) || String(e.invoiceApplicationId) === String(applicationObjectId);
    });
    if (!entry) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance application not found');
    }

    const amountToRestore = Number(entry.amountApplied);
    if (!Number.isFinite(amountToRestore) || amountToRestore <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid amount on opening balance application');
    }

    const receivableDocNo = String(entry.paymentDocumentNo);
    let receivableTxn = await OpeningBalanceTransaction.findOne({
      companyId: companyObjectId,
      contactId: creditTxn.contactId,
      contactType: CONTACT_TYPE.CUSTOMER,
      type: TRANSACTION_TYPE.OPENING_RECEIVABLE,
      transactionNo: receivableDocNo,
    }).session(session);

    if (!receivableTxn && receivableDocNo.startsWith('OB-')) {
      const maybeId = receivableDocNo.slice(3);
      if (mongoose.Types.ObjectId.isValid(maybeId)) {
        receivableTxn = await OpeningBalanceTransaction.findOne({
          _id: maybeId,
          companyId: companyObjectId,
          contactId: creditTxn.contactId,
          type: TRANSACTION_TYPE.OPENING_RECEIVABLE,
        }).session(session);
      }
    }

    if (!receivableTxn) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance receivable not found');
    }

    if (!entry._id) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid opening balance application');
    }

    const creditUpdated = await OpeningBalanceTransaction.findOneAndUpdate(
      { _id: creditTxn._id, companyId: companyObjectId },
      {
        $inc: { remainingAmount: amountToRestore },
        $pull: { paymentReceivedEntries: { _id: entry._id } },
      },
      { session, new: true },
    );
    if (!creditUpdated) {
      throw new ApiError(httpStatus.CONFLICT, 'Could not remove credit application; please retry');
    }
    const stillThere = (creditUpdated.paymentReceivedEntries || []).some(e => String(e._id) === String(entry._id));
    if (stillThere) {
      throw new ApiError(httpStatus.CONFLICT, 'Could not remove credit application; please retry');
    }

    const receivableUpdated = await OpeningBalanceTransaction.findOneAndUpdate(
      { _id: receivableTxn._id, companyId: companyObjectId },
      { $inc: { remainingAmount: amountToRestore } },
      { session, new: true },
    );
    if (!receivableUpdated) {
      throw new ApiError(httpStatus.CONFLICT, 'Could not restore opening balance receivable; please retry');
    }

    await moveAdvanceApplyBranchBalances({
      customerId: creditTxn.contactId,
      paymentBranchId: creditTxn.branchId,
      documentBranchId: receivableTxn.branchId,
      amount: amountToRestore,
      session,
      reverse: true,
    });

    await ledgerService.deleteJournal(
      { companyId: companyObjectId, sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, sourceId: entry._id },
      session,
    );

    await flushCompanyStockLevels(session);
    await session.commitTransaction();
    return { success: true };
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  createInvoice: withTransientRetry(createInvoice),
  queryInvoices,
  queryInvoicesExports,
  queryCustomerWisePendingInvoices,
  getInvoiceById,
  updateInvoiceById,
  deleteInvoiceById,
  queryPendingInvoices,
  getInvoicesForDropdown,
  updateInvoiceStatus,
  generateEInvoiceFromInvoice,
  getInvoiceGstDocumentOptions,
  generateFynamicsEInvoiceFromInvoice,
  refetchEInvoiceFromInvoice,
  generateEWayBillFromInvoice,
  cancelEInvoiceFromInvoice,
  cancelEWayBillFromInvoice,
  paymentHistoryForInvoice,
  generateOnlyEWayBillFromInvoice,
  generateEWayBillForInvoice,
  cancelOnlyEWayBillFromInvoice,
  createSplitInvoice: withTransientRetry(createSplitInvoice),
  applyCustomerCreditToInvoice,
  autoMapOpeningBalanceToInvoices,
  removeOpeningBalanceApplicationFromInvoice,
  removeOpeningBalanceApplicationFromOb,
  updateInvoicePaymentStatus,
  cancelInvoicePayment,
};
