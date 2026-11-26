const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const moment = require('moment');
const { getBooksCrmModels, getClientConnection, getBooksModels, getCommonModels } = require('../../../services/model.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { getAddressFilterCondition, getCustomerAddressMap } = require('../../../utils/addressLocationFilter');
const { QUOTE_STATUS, MODULE_NAMES, INVOICE_STATUS, SALES_ORDER_STATUS } = require('../../../utils/enum');
const { NOTIFICATION_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');
const { sendTransactionNotification } = require('../../../utils/transactionNotification');
const {
  sendModuleCustomerNotifications,
  notifyModuleDocumentIfNonDraft,
  isFirstStatusChange,
} = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');
const { processIncentiveEarn, cancelIncentiveLog } = require('../../setting/incentiveScheme/incentiveScheme.service');
const ApiError = require('../../../utils/ApiError');
const {
  getInventoryConfig,
  QUOTE_STATUS_CONFIG,
  validateStatusTransition,
  validateStockAvailability,
  validateEditPermissions,
  assertRevertAllowed,
} = require('../../../utils/inventoryConfig');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { defaultWarehouseEntry } = require('../../../utils/defaultWarehouseEntry');
const { applyCompanyPaymentTermsFallback } = require('../../../utils/customerPaymentTerms');
const mongoose = require('mongoose');
const { getPrimaryBank, getPrimaryBankDetails } = require('../../banking/bank/bank.service');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { uploadFileToS3, handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { validateCustomerForModule } = require('../../../services/customerValidation.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { QUOTE_MESSAGES } = require('../../../utils/messages');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const {
  enrichDocumentItemLines,
  assertSelectableForNewLines,
  assertResolvable,
  assertLineUnitsValid,
  SNAPSHOT_MODE,
} = require('../../../services/documentItemEnricher.service');
// Statuses where conversion is allowed
const QUOTE_CONVERSION_ALLOWED_STATUSES = [QUOTE_STATUS.ACCEPTED];

const createQuote = async (quoteBody, userId, uploadedFiles = []) => {
  const { Quote, Customer, Branch } = getBooksCrmModels();
  const { Invoice } = getBooksModels();
  const { Company } = getCommonModels();
  const { UserRole } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { items, warehouseId, companyId } = quoteBody;

    // Enforce item selectability: a newly added item must be active. (Display snapshot is repaired
    // on read.) A quote is never created from a source document, so every line is treated as new.
    const itemSelectabilityCheck = await enrichDocumentItemLines(items, {
      companyId,
      warehouseId,
      session,
      snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
    });
    assertSelectableForNewLines(itemSelectabilityCheck, 'quotation');
    await assertLineUnitsValid(itemSelectabilityCheck, { companyId: quoteBody.companyId, session });
    const company = await Company.findById(quoteBody.companyId).populate('baseCurrency').session(session);

    // Get and store inventory configuration
    await validateCustomerForModule({
      customerId: quoteBody.customerId,
      branchId: quoteBody.branchId,
      companyId,
      totalAmount: quoteBody.total,
      addressId: quoteBody.addressId,
      moduleName: MODULE_NAMES.QUOTATION,
      session,
      models: { Customer, Branch, Invoice },
    });
    // Upload files to S3 if any files were provided
    let attachmentUrls = [];
    if (uploadedFiles && uploadedFiles.length > 0) {
      const company = await UserRole.findOne({ userId }).session(session);
      if (!company) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
      }

      const uploadPromises = uploadedFiles.map(file => uploadFileToS3(file, userId, company.companyId));
      attachmentUrls = await Promise.all(uploadPromises);
    }

    // Merge uploaded file URLs with existing attachments (if any from JSONString)
    const allAttachments = [...attachmentUrls];
    // add default warehouse entry
    if (quoteBody?.items?.length > 0) {
      await defaultWarehouseEntry(
        {
          itemArray: quoteBody.items,
          warehouseId: warehouseId,
          branchId: quoteBody.branchId,
          divisionId: quoteBody.divisionId,
          companyId: companyId,
        },
        session,
      );
    }

    const inventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.QUOTATION, session);

    // Validate stock if enabled
    if (inventoryConfig.stockCheckEnabled) {
      await validateStockAvailability({ items, companyId, warehouseId }, session);
    }

    const bank = await getPrimaryBank(quoteBody.companyId, session);
    quoteBody.quoteId = await generateUniqueId(
      Quote,
      companyId,
      MODULE_NAMES.QUOTATION,
      'quoteId',
      'QUO',
      session,
      quoteBody.quoteId,
    );

    const { currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
      companyId,
      customerId: quoteBody.customerId,
    });
    const currencyDoc = await getCurrency(companyId, currency);

    // Create Quote
    const quoteData = {
      ...quoteBody,
      currency,
      exchangeRate: quoteBody.exchangeRate ?? 1,
      decimalPlaces,
      attachments: allAttachments, // Include all attachment URLs
      authorizedSignature: company?.authorizedSignature,
      bankAccountId: bank?.accountId,
      addedBy: userId,
      updatedBy: userId,
      inventoryConfig,
      appName: APP_NAME.BOOKS,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
      commentHistory: [
        {
          message: `Quote created for ${currencyDoc?.symbol || '₹'}${quoteBody.total || 0}`,
          addedBy: userId,
        },
      ],
    };
    const quote = await Quote.create([quoteData], { session });
    await session.commitTransaction();

    sendTransactionNotification({
      customerId: quote[0].customerId,
      companyId: quote[0].companyId,
      notificationType: NOTIFICATION_TYPE.QUOTE_CREATED,
      entityId: quote[0]._id,
      entityDisplayId: quote[0].quoteId,
      triggeredByUserId: userId,
    });

    notifyModuleDocumentIfNonDraft({
      companyId: quote[0].companyId,
      moduleName: MODULE_NAMES.QUOTATION,
      document: quote[0],
      initialStatus: QUOTE_STATUS.DRAFT,
    });

    processIncentiveEarn(companyId, userId, 'QUOTATION', quote[0]._id, quote[0].total, quote[0].items);
    const quoteObj = await enrichDocumentCurrency(companyId, quote[0].toJSON());
    return quoteObj;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryQuotes = async (filter, options) => {
  const { Customer, Quote, SalesOrder, PaymentTerm } = getBooksCrmModels();
  const { User, CompanySettings } = getCommonModels();
  const { Invoice } = getBooksModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  // Build a fresh query instead of mutating filter directly
  const query = { companyId };

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'quoteDate' });
  if (branchDivisionCond) {
    Object.assign(query, branchDivisionCond);
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

    const customerIds = customers.map(c => c._id); // keep as ObjectId

    query.$or = [
      { subject: searchRegex },
      { reference: searchRegex },
      { quoteId: searchRegex },
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

  // Country/State/City filters resolve through the address selected on the quote (addressId)
  const addressCondition = await getAddressFilterCondition(Customer, companyId, filter);
  if (addressCondition) {
    (query.$and ||= []).push(addressCondition);
  }

  if (options?.countOnly) {
    return { results: [], totalResults: await Quote.countDocuments(query) };
  }

  // Add populate string for division/branch/warehouse/payment terms fields
  options.populate = `divisionId:name,branchId:name,warehouseId:name,paymentTermsId`;

  // Fetch paginated quotes
  const quotes = await Quote.paginateWithPotential(query, options);

  // Populate customer, including root-level and per-branch payment terms
  await Quote.populate(quotes.results, {
    path: 'customerId',
    select:
      'customerDisplayName useBranchPaymentTerms paymentTermsId branch otherDetails.gstinUin address.billing.state address.shipping.state',
    populate: [{ path: 'paymentTermsId' }, { path: 'branch.paymentTermsId' }],
  });

  // Populate the line unit (itemUnitId -> ItemUnit name)
  await Quote.populate(quotes.results, { path: 'items.itemUnitId', select: 'name' });

  // Fall back to CompanySettings.salesCreditLimit's root/branch payment terms when the customer has none
  const companySettings = await CompanySettings.findOne({ companyId })
    .select('salesCreditLimit')
    .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
    .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
    .lean();
  const salesCreditLimit = companySettings?.salesCreditLimit;

  const userIds = [];
  quotes.results.forEach(quote => {
    const addedBy = quote.addedBy;
    const updatedBy = toUpdatedByUserIdString(quote.updatedBy);
    userIds.push(addedBy, updatedBy);
  });
  const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName');
  const userMap = users.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  const quoteIds = quotes.results.map(quote => quote._id);
  const [invoices, salesOrders] = await Promise.all([
    Invoice.find({ quoteId: { $in: quoteIds }, status: { $ne: SALES_ORDER_STATUS.CANCELLED } }).select(
      'quoteId invoiceId status',
    ),
    SalesOrder.find({ quoteId: { $in: quoteIds }, status: { $ne: SALES_ORDER_STATUS.CANCELLED } }).select(
      'quoteId orderId status',
    ),
  ]);

  const invoiceMap = invoices.reduce((acc, invoice) => {
    const key = invoice.quoteId.toString();
    (acc[key] ||= []).push(invoice);
    return acc;
  }, {});
  const salesOrderMap = salesOrders.reduce((acc, salesOrder) => {
    const key = salesOrder.quoteId.toString();
    (acc[key] ||= []).push(salesOrder);
    return acc;
  }, {});

  // Resolve each quote's root-level addressId from the customer's billing/shipping/additional shipping addresses
  const addressMap = await getCustomerAddressMap(
    Customer,
    quotes.results.map(quote => quote.customerId?._id),
  );

  const populatedQuotes = quotes.results.map(quote => {
    const quoteObj = quote.toObject();
    quoteObj.addressIn = addressMap[quoteObj.addressId?.toString()] || null;
    applyCompanyPaymentTermsFallback(quoteObj.customerId, salesCreditLimit, quoteObj.branchId?._id || quoteObj.branchId);
    const addedBy = userMap[quoteObj.addedBy?.toString()];
    const updatedById = toUpdatedByUserIdString(quoteObj.updatedBy);
    const updatedBy = updatedById ? userMap[updatedById] : null;
    quoteObj.addedBy = addedBy ? addedBy.toObject() : null;
    quoteObj.updatedBy = updatedBy ? updatedBy.toObject() : null;
    quoteObj.invoices = invoiceMap[quoteObj._id.toString()] || [];
    quoteObj.salesOrders = salesOrderMap[quoteObj._id.toString()] || [];
    return quoteObj;
  });

  const resultsWithCurrency = await enrichDocumentCurrency(companyId, await attachItemSummaries(populatedQuotes));

  return {
    ...quotes,
    results: resultsWithCurrency,
  };
};

const queryQuotesExports = async (filter, options) => {
  const result = await queryQuotes(filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const getQuoteById = async (id, companyId) => {
  const { Quote, SalesOrder, Branch, Division, Warehouse, Customer, Item, PaymentTerm } = getBooksCrmModels();
  const { Invoice } = getBooksModels();
  const { User, CompanySettings } = getCommonModels();

  const quoteData = await Quote.findOne({ _id: id, companyId }).populate([
    {
      path: 'customerId',
      select: 'customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails _id isCustomerDirectTax',
    },
    { path: 'items.itemUnitId', select: 'name' },
  ]);

  if (!quoteData) {
    throw new ApiError(httpStatus.NOT_FOUND, QUOTE_MESSAGES.FETCH_NOT_FOUND);
  }

  const salesorderarray = [];

  if (quoteData.convertedTo && quoteData.convertedTo.length > 0) {
    for (let j of quoteData.convertedTo) {
      if (j.type === 'SalesOrder') {
        const salesorderData = await SalesOrder.findById(j.documentId)
          .select('total orderDate expectedShipmentDate status')
          .lean();

        // Make sure both j and salesorderData are plain objects
        const jObject = j.toObject?.() ?? j;
        const merged = { ...jObject, ...salesorderData };
        salesorderarray.push(merged);
      }

      if (j.type === 'Invoice') {
        const invoiceData = await Invoice.findById(j.documentId)
          .select('total invoiceDate dueDate status balanceAmount paidAmount')
          .lean();

        // Make sure both j and salesorderData are plain objects
        const jObject = j.toObject?.() ?? j;
        const merged = { ...jObject, ...invoiceData };
        salesorderarray.push(merged);
      }
    }
  }
  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (quoteData.commentHistory?.length) {
    const userIds = quoteData.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = quoteData.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy, // replaces addedBy with user details if found
      };
    });
  }

  let customer = await Customer.findById(quoteData.customerId._id || quoteData.customerId)
    .select('paymentTermsId useBranchPaymentTerms branch address')
    .populate('branch.paymentTermsId')
    .populate('paymentTermsId')
    .lean();

  // Fall back to CompanySettings.salesCreditLimit's root/branch payment terms when the customer has none
  const companySettings = await CompanySettings.findOne({ companyId })
    .select('salesCreditLimit')
    .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
    .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
    .lean();
  applyCompanyPaymentTermsFallback(customer, companySettings?.salesCreditLimit, quoteData?.branchId);

  let shippingAddress = null;
  if (quoteData.addressId) {
    if (quoteData?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
      shippingAddress = customer.address.shipping;
    }
    if (!shippingAddress) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        addr => addr._id.toString() === quoteData.addressId.toString(),
      );
    }
  }

  const branch = await Branch.findById(quoteData?.branchId).select('name');
  const division = await Division.findById(quoteData?.divisionId).select('name');
  const warehouse = await Warehouse.findById(quoteData?.warehouseId).select('name');
  const addedBy = await User.findById(quoteData.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(quoteData.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const primaryBankDetails = await getPrimaryBankDetails(quoteData?.bankAccountId);
  const dataObj = quoteData.toObject();
  dataObj.branchName = branch?.name || null;
  dataObj.divisionName = division?.name || null;
  dataObj.warehouseName = warehouse?.name || null;
  dataObj.addedBy = addedBy;
  dataObj.updatedBy = updatedBy;
  dataObj.shippingAddress = shippingAddress || {};
  dataObj.commentHistory = commentHistoryWithUser; // <-- Use the mapped array here
  dataObj.convertedTo = salesorderarray;
  dataObj.bankAccountId = primaryBankDetails || {};
  dataObj.moduleTree = await buildModuleTree(id);
  const paymentTerm = quoteData.paymentTermsId ? await PaymentTerm.findById(quoteData.paymentTermsId).lean() : null;
  dataObj.paymentTermsId = paymentTerm || null;

  // Backfill itemName/itemNo/hsnCode/itemUnit from the live Item master whenever the stored
  // line is missing them (e.g. saved before the item-dropdown finished loading). Rate/quantity/
  // amount stay untouched — those must stay frozen to the quote as originally priced.
  const missingItemIds = [
    ...new Set(
      (dataObj.items || [])
        .filter(item => item.itemId && (!item.itemName || !item.itemNo || !item.hsnCode || !item.itemUnit))
        .map(item => item.itemId.toString()),
    ),
  ];
  if (missingItemIds.length) {
    const masterItems = await Item.find({ _id: { $in: missingItemIds }, companyId })
      .select('itemName itemNo itemCode hsnCode itemUnit')
      .lean();
    const masterMap = masterItems.reduce((acc, mi) => ({ ...acc, [mi._id.toString()]: mi }), {});
    dataObj.items = (dataObj.items || []).map(item => {
      const master = item.itemId && masterMap[item.itemId.toString()];
      if (!master) return item;
      return {
        ...item,
        itemName: item.itemName || master.itemName || '',
        itemNo: item.itemNo || master.itemNo || master.itemCode || '',
        hsnCode: item.hsnCode || master.hsnCode || '',
        itemUnit: item.itemUnit || master.itemUnit || '',
      };
    });
  }

  // Repair any blank snapshot from the Item master and attach a per-line itemIssue for the UI warning.
  dataObj.items = await enrichDocumentItemLines(dataObj.items, {
    companyId,
    warehouseId: dataObj.warehouseId,
    snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
  });

  return enrichDocumentCurrency(companyId, dataObj);
};

const updateQuoteById = async (quoteId, updateBody, userId, uploadedFiles = []) => {
  const { Quote, Customer, Branch } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const { UserRole } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { items: newItems, warehouseId, companyId, addressId } = updateBody;

    const quote = await Quote.findOne({ _id: quoteId, companyId }).session(session);
    if (!quote) {
      throw new ApiError(httpStatus.NOT_FOUND, QUOTE_MESSAGES.FETCH_NOT_FOUND);
    }

    // Enforce item selectability on update: newly added items must be active; items already on the
    // quote are tolerated even if deactivated afterwards. (Display snapshot is repaired on read.)
    if (Array.isArray(newItems) && newItems.length) {
      const existingItemIds = new Set((quote.items || []).map(line => line.itemId?.toString()));
      const enrichedUpdateItems = await enrichDocumentItemLines(newItems, {
        companyId,
        warehouseId,
        session,
        snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
      });
      assertResolvable(enrichedUpdateItems);
      assertSelectableForNewLines(
        enrichedUpdateItems.filter(line => line.itemId && !existingItemIds.has(String(line.itemId))),
        'quotation',
      );
    }

    const company = await Company.findById(quote.companyId).populate('baseCurrency').session(session);

    // Upload files to S3 if any files were provided
    await validateCustomerForModule({
      customerId: updateBody.customerId,
      branchId: updateBody.branchId,
      companyId,
      totalAmount: updateBody.total,
      previousTotal: quote.total,
      addressId: updateBody.addressId,
      moduleName: MODULE_NAMES.QUOTATION,
      session,
      models: { Customer, Branch },
      isUpdate: true,
      skipOverdueCheck: true,
    });

    const uploadedUrls = await handleFileUpdate({
      newFiles: uploadedFiles,
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: quote.attachments ? quote.attachments : [],
      userId,
      companyId: quote.companyId,
    });
    updateBody.attachments = uploadedUrls;

    // Validate edit permissions
    validateEditPermissions(QUOTE_STATUS_CONFIG.EDIT_RESTRICTED_STATUSES, quote.status);
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
    const oldItemsMap = new Map(quote.items.map(item => [item.itemId.toString(), item.quantity]));

    // Get new inventory configuration
    const newInventoryConfig = await getInventoryConfig(companyId, MODULE_NAMES.QUOTATION, session);

    // Validate stock if enabled
    if (newInventoryConfig.stockCheckEnabled) {
      await validateStockAvailability({ items: newItems, oldItems: quote.items, oldItemsMap, companyId, warehouseId }, session);
    }

    // Update the quote
    const oldTotal = quote.total || 0;
    const newTotal = updateBody.total || 0;

    if (updateBody.customerId && String(updateBody.customerId) !== String(quote.customerId)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: quote.companyId,
        customerId: updateBody.customerId,
      });
      updateBody.currency = currency;
      updateBody.decimalPlaces = decimalPlaces;
    }
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(quote.companyId, updateBody.currency || quote.currency);
    const currencySymbol = currencyDoc?.symbol || company?.baseCurrency?.symbol || '₹';

    let updateMsg = 'Quote updated.';
    if (oldTotal !== newTotal) {
      updateMsg = `Quote updated. Amount changed from ${currencySymbol}${oldTotal} to ${currencySymbol}${newTotal}`;
    }

    // Update the quote
    Object.assign(quote, {
      ...updateBody,
      authorizedSignature: company?.authorizedSignature,
      inventoryConfig: newInventoryConfig,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    quote.updatedBy = userId;
    quote.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
    });
    await quote.save({ session });

    await session.commitTransaction();

    processIncentiveEarn(companyId, userId, 'QUOTATION', quote._id, quote.total, quote.items);

    sendTransactionNotification({
      customerId: quote.customerId,
      companyId: quote.companyId,
      notificationType: NOTIFICATION_TYPE.QUOTE_UPDATED,
      entityId: quote._id,
      entityDisplayId: quote.quoteId,
      triggeredByUserId: userId,
    });

    return enrichDocumentCurrency(quote.companyId, quote.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const sendQuote = async (quoteId, companyId, userId) => {
  const { Quote } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const quote = await Quote.findOne({ _id: quoteId, companyId }).session(session);
    if (!quote) {
      throw new ApiError(httpStatus.NOT_FOUND, QUOTE_MESSAGES.FETCH_NOT_FOUND);
    }

    // Validate status transition to SENT
    validateStatusTransition(QUOTE_STATUS_CONFIG.STATUS_TRANSITIONS, quote.status, QUOTE_STATUS.SENT);

    // Update status to SENT
    quote.status = QUOTE_STATUS.SENT;
    quote.updatedBy = userId;
    quote.commentHistory.push({
      message: `Quote status changed from ${quote?.status} to ${QUOTE_STATUS.SENT}`,
      addedBy: userId,
    });

    await quote.save({ session });

    // TODO: Implement actual sending logic (e.g., email or portal integration)
    // For now, assume the quote is marked as sent

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: quote.customerId,
      companyId: quote.companyId,
      notificationType: NOTIFICATION_TYPE.QUOTE_SENT,
      entityId: quote._id,
      entityDisplayId: quote.quoteId,
      triggeredByUserId: userId,
    });

    return quote;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updateQuoteStatus = async (quoteId, companyId, newStatus, userId, rejectionReason) => {
  const { Quote, SalesOrder } = getBooksCrmModels();
  const { Invoice } = getBooksModels();
  const { CompanySettings } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const quote = await Quote.findOne({ _id: quoteId, companyId }).session(session);
    if (!quote) {
      throw new ApiError(httpStatus.NOT_FOUND, QUOTE_MESSAGES.FETCH_NOT_FOUND);
    }

    // Validate status transition (the cancel action is handled specially below)
    if (newStatus != QUOTE_STATUS.CANCELLED) {
      validateStatusTransition(QUOTE_STATUS_CONFIG.STATUS_TRANSITIONS, quote.status, newStatus);
    }

    const isUncancel = quote.status === QUOTE_STATUS.CANCELLED && newStatus !== QUOTE_STATUS.CANCELLED;
    if (isUncancel) {
      assertRevertAllowed({ isUncancel, hasEffect: false });
    }

    const newInventoryConfig = await getInventoryConfig(quote.companyId, MODULE_NAMES.QUOTATION, session);

    if (newStatus == QUOTE_STATUS.CANCELLED && quote.status != QUOTE_STATUS.CANCELLED) {
      const salesOrder = await SalesOrder.find({ quoteId: quote._id, status: { $ne: SALES_ORDER_STATUS.CANCELLED } })
        .select('orderId')
        .session(session);

      if (salesOrder.length > 0) {
        const orderIds = salesOrder.map(so => so.orderId).join(', ');
        throw new ApiError(httpStatus.CONFLICT, `Cannot cancel quote because a Sales Order has been created from it:${orderIds}`);
      }

      const invoice = await Invoice.find({ quoteId: quote._id, status: { $ne: INVOICE_STATUS.CANCELLED } })
        .select('invoiceId')
        .session(session);

      if (invoice.length > 0) {
        const orderIds = invoice.map(inv => inv.invoiceId).join(', ');

        throw new ApiError(httpStatus.CONFLICT, `Cannot cancel quote because an Invoice has been created from it:${orderIds}`);
      }
    }

    if (newStatus === QUOTE_STATUS.REJECTED && rejectionReason) {
      quote.rejectionReason = rejectionReason;
      await CompanySettings.findOneAndUpdate(
        { companyId },
        { $addToSet: { 'quotationConfig.quoteCloseReasons': rejectionReason } },
        { session },
      );
    }

    // Update status
    const oldStatus = quote.status;
    quote.status = newStatus;
    quote.updatedBy = userId;
    quote.commentHistory.push({
      message: `Quote status changed from ${oldStatus} to ${newStatus}`,
      addedBy: userId,
    });
    quote.inventoryConfig = newInventoryConfig;
    await quote.save({ session });

    await session.commitTransaction();

    if (newStatus === QUOTE_STATUS.CANCELLED) {
      cancelIncentiveLog(quote._id);
    }

    sendTransactionNotification({
      customerId: quote.customerId,
      companyId: quote.companyId,
      notificationType: NOTIFICATION_TYPE.QUOTE_STATUS_CHANGED,
      entityId: quote._id,
      entityDisplayId: quote.quoteId,
      triggeredByUserId: userId,
      newStatus,
    });

    if (isFirstStatusChange(oldStatus, newStatus, QUOTE_STATUS.DRAFT)) {
      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.QUOTATION,
        document: quote,
      }).catch(err => logger.error(`Failed to send quote customer notifications for ${quote.quoteId}: ${err.message}`));
    }

    return quote;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteQuoteById = async (quoteId, companyId) => {
  const { Quote, SalesOrder } = getBooksCrmModels();
  const { Invoice } = getBooksModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const quote = await Quote.findOne({ _id: quoteId, companyId }).session(session);

    if (!quote) {
      throw new ApiError(httpStatus.NOT_FOUND, QUOTE_MESSAGES.FETCH_NOT_FOUND);
    }

    const salesOrder = await SalesOrder.find({ quoteId: quote._id }).select('orderId').session(session);
    if (salesOrder.length > 0) {
      const orderIds = salesOrder.map(so => so.orderId).join(', ');
      throw new ApiError(httpStatus.CONFLICT, `Cannot delete quote because a Sales Order has been created from it:${orderIds}`);
    }

    const invoice = await Invoice.find({ quoteId: quote._id }).select('invoiceId').session(session);
    if (invoice.length > 0) {
      const orderIds = invoice.map(inv => inv.invoiceId).join(', ');

      throw new ApiError(httpStatus.CONFLICT, `Cannot delete quote because an Invoice has been created from it:${orderIds}`);
    }

    const { customerId, companyId: quoteCompanyId, quoteId: quoteDisplayId } = quote;

    await Quote.findByIdAndDelete(quoteId, { session });

    await session.commitTransaction();

    cancelIncentiveLog(quoteId);

    sendTransactionNotification({
      customerId,
      companyId: quoteCompanyId,
      notificationType: NOTIFICATION_TYPE.QUOTE_DELETED,
      entityId: quoteId,
      entityDisplayId: quoteDisplayId,
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

const buildModuleTree = async quoteId => {
  const { SalesOrder, PaymentReceived } = getBooksCrmModels();
  const { DeliveryChallan, Invoice, ProductionOrder } = getBooksModels();
  const { Quote } = getBooksCrmModels();

  const moduleTree = {};

  /* -------------------------------------------------- */
  /* QUOTE (ROOT) */
  /* -------------------------------------------------- */

  const quote = await Quote.findById(quoteId).select('_id quoteId quoteDate status total');

  if (!quote?._id) return moduleTree;

  moduleTree.quote = {
    id: quote._id,
    quoteId: quote.quoteId,
    quoteDate: quote.quoteDate,
    status: quote.status,
    total: quote.total,
  };

  /* -------------------------------------------------- */
  /* QUOTE → SALES ORDER */
  /* -------------------------------------------------- */

  const salesOrder = await SalesOrder.findOne({ quoteId: quote._id }).select('_id orderId orderDate status total');

  if (salesOrder?._id) {
    moduleTree.quote.salesOrder = {
      id: salesOrder._id,
      orderId: salesOrder.orderId,
      orderDate: salesOrder.orderDate,
      status: salesOrder.status,
      total: salesOrder.total,
    };

    /* ------------------------------- */
    /* SALES ORDER → PRODUCTION ORDER */
    /* ------------------------------- */

    const productionOrders = await ProductionOrder.find({ salesOrderId: salesOrder._id })
      .select('_id productionOrderCode productionDate status quantity itemId')
      .populate({
        path: 'itemId',
        model: getBooksCrmModels().Item,
        select: 'itemNo',
      });

    if (productionOrders?.length) {
      moduleTree.quote.salesOrder.productionOrders = productionOrders;
    }

    /* ------------------------------- */
    /* SALES ORDER → DELIVERY CHALLAN */
    /* ------------------------------- */

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
      moduleTree.quote.salesOrder.deliveryChallan = {
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

    /* ------------------------------- */
    /* SALES ORDER → DIRECT INVOICE */
    /* ------------------------------- */

    const soInvoices = await Invoice.find({ 'salesOrders.salesOrderId': salesOrder._id, isSplit: { $ne: true } }).select(
      '_id invoiceId invoiceDate status total',
    );

    if (soInvoices?.length) {
      moduleTree.quote.salesOrder.invoice = {
        invoices: soInvoices,
      };

      const invoiceIds = soInvoices.map(inv => inv._id);

      const payments = await PaymentReceived.find({ 'invoices.invoiceId': { $in: invoiceIds } }).select(
        '_id paymentReceivedId paymentDate status amountReceived',
      );

      if (payments?.length) {
        moduleTree.quote.salesOrder.invoice.paymentReceive = {
          paymentReceives: payments,
        };
      }
    }
  }

  /* -------------------------------------------------- */
  /* QUOTE → DIRECT INVOICE */
  /* -------------------------------------------------- */

  const quoteInvoices = await Invoice.find({ quoteId: quote._id, isSplit: { $ne: true } }).select(
    '_id invoiceId invoiceDate status total',
  );

  if (quoteInvoices?.length) {
    moduleTree.quote.invoice = {
      invoices: quoteInvoices,
    };

    const invoiceIds = quoteInvoices.map(inv => inv._id);

    const payments = await PaymentReceived.find({ 'invoices.invoiceId': { $in: invoiceIds } }).select(
      '_id paymentReceivedId paymentDate status amountReceived',
    );

    if (payments?.length) {
      moduleTree.quote.invoice.paymentReceive = {
        paymentReceives: payments,
      };
    }
  }

  return moduleTree;
};

module.exports = {
  createQuote: withTransientRetry(createQuote),
  queryQuotes,
  queryQuotesExports,
  getQuoteById,
  updateQuoteById,
  sendQuote,
  updateQuoteStatus,
  deleteQuoteById,
  QUOTE_CONVERSION_ALLOWED_STATUSES,
};
