const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const ApiError = require('../../../utils/ApiError');
const { CREDIT_NOTE_MESSAGES } = require('../../../utils/messages');
const { createSearchRegex } = require('../../../utils/regexUtils');
const {
  CREDIT_NOTE_STATUS,
  CREDIT_NOTE_TYPE,
  E_INVOICE_STATUS,
  E_WAY_BILL_STATUS,
  LEDGER_SOURCE_MODULES,
  LEDGER_PARTY_TYPES,
  PAYMENT_ACCOUNT_CATEGORIES,
  TRANSACTION_TYPE,
  OB_PAYMENT_ENTRY_SOURCE,
  MODULE_NAMES,
} = require('../../../utils/enum');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { updateInvoicePaymentStatus } = require('../invoice/invoice.service');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const { getAddressFilterCondition, findAddressById } = require('../../../utils/addressLocationFilter');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const mongoose = require('mongoose');
const { NOTIFICATION_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');
const { sendTransactionNotification } = require('../../../utils/transactionNotification');
const { defaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const { getPrimaryBank, getPrimaryBankDetails } = require('../../banking/bank/bank.service');
const { CREDIT_STATUS_CONFIG, validateStatusTransition, assertRevertAllowed } = require('../../../utils/inventoryConfig');
const {
  REJECTION_ORDER_STATUS_CONFIG,
  assertLinkedRejectionDeletable,
  revertLinkedRejectionSettlement,
} = require('../../rejection/rejectionOrder/rejectionOrder.service');
const { pairLinesWithExisting } = require('../../../utils/documentLineMatching');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const {
  handleWarehouseStock,
  adjustStockByBatchId,
  deleteStockByBatchId,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
} = require('../../../services/warehouseBatch.service');
const { updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const { moveAdvanceApplyBranchBalances } = require('../../../utils/paymentBranchBalance');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const {
  enrichDocumentItemLines,
  assertSelectableForNewLines,
  assertResolvable,
  assertLineUnitsValid,
  SNAPSHOT_MODE,
} = require('../../../services/documentItemEnricher.service');

// A credit note only belongs in the ledger once it is issued; a draft or a cancelled note does
// not. Moving between two issued statuses (open -> partly used -> used/closed) changes nothing
// in the journal, so it is left alone rather than reversed and written again.
const syncCreditNoteJournal = async (companyId, creditNote, userId, session, oldStatus = null) => {
  const POSTED_CREDIT_NOTE_STATUSES = [
    CREDIT_NOTE_STATUS.DRAFT,
    CREDIT_NOTE_STATUS.OPEN,
    CREDIT_NOTE_STATUS.PARTIALLY_USED,
    CREDIT_NOTE_STATUS.USED,
    CREDIT_NOTE_STATUS.CLOSED,
  ];
  const isPostedStatus = status => POSTED_CREDIT_NOTE_STATUSES.includes(status);
  const wasPosted = oldStatus != null && isPostedStatus(oldStatus);
  const isPosted = isPostedStatus(creditNote.status);

  if (oldStatus != null && wasPosted && isPosted) {
    return;
  }

  await ledgerService.deleteJournal(
    { companyId, sourceModule: LEDGER_SOURCE_MODULES.CREDIT_NOTE, sourceId: creditNote._id },
    session,
  );
  if (isPosted) {
    await ledgerService.postCreditNoteJournal({ companyId, creditNote, addedBy: userId }, session);
  }
};

// Goods coming back re-enter stock at the cost they left at, never at what the customer paid:
// returning a sale must not create inventory value out of the margin. The invoice line holds
// the batches the sale consumed, so its weighted cost is the truth; where the goods left on a
// delivery challan the invoice holds no batches and the challan carries that cost instead; a note
// raised without either falls back to the item's own cost price.
const buildReturnCostMap = async (companyId, invoiceId, items, session) => {
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const costByItemId = new Map();

  const invoice = invoiceId ? await Invoice.findById(invoiceId).select('items deliveryChallanIds').session(session).lean() : null;
  for (const line of invoice?.items || []) {
    const quantity = (line.batches || []).reduce((sum, batch) => sum + (Number(batch.quantity) || 0), 0);
    const value = (line.batches || []).reduce(
      (sum, batch) => sum + (Number(batch.quantity) || 0) * (Number(batch.purchasePrice) || 0),
      0,
    );
    if (quantity > 0 && value > 0) costByItemId.set(line.itemId?.toString(), Math.round((value / quantity) * 100) / 100);
  }

  // Get item cost from linked delivery challans when invoice lines lack batch details.
  const challanIds = (invoice?.deliveryChallanIds || []).map(challan => challan.deliveryChallanId).filter(Boolean);

  if (challanIds.length) {
    const challans = await DeliveryChallan.find({
      _id: { $in: challanIds },
      companyId,
    })
      .select('items')
      .session(session)
      .lean();

    const itemTotals = {};

    for (const challan of challans) {
      for (const line of challan.items || []) {
        const itemId = line.itemId?.toString();

        // Skip invalid items and items whose cost is already available.
        if (!itemId || costByItemId.has(itemId)) continue;

        if (!itemTotals[itemId]) {
          itemTotals[itemId] = {
            quantity: 0,
            value: 0,
          };
        }

        for (const batch of line.batches || []) {
          const quantity = Number(batch.quantity) || 0;
          const purchasePrice = Number(batch.purchasePrice) || 0;

          itemTotals[itemId].quantity += quantity;
          itemTotals[itemId].value += quantity * purchasePrice;
        }
      }
    }

    // Calculate the weighted average cost for each item.
    for (const [itemId, totals] of Object.entries(itemTotals)) {
      if (totals.quantity > 0 && totals.value > 0) {
        const averageCost = totals.value / totals.quantity;
        costByItemId.set(itemId, Math.round(averageCost * 100) / 100);
      }
    }
  }

  // Anything neither document priced falls back to the item master, loaded in one go.
  const missingIds = (items || []).map(item => item.itemId).filter(id => id && !costByItemId.has(id.toString()));
  if (missingIds.length) {
    const masters = await Item.find({ _id: { $in: missingIds }, companyId })
      .select('purchaseInformation.costPrice')
      .session(session)
      .lean();
    for (const master of masters) {
      costByItemId.set(master._id.toString(), Number(master.purchaseInformation?.costPrice) || 0);
    }
  }

  return costByItemId;
};

const { sendModuleCustomerNotifications, isFirstStatusChange } = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');

const createCreditNote = async (creditNoteBody, userId, uploadedFiles = []) => {
  const { CreditNote, Invoice, RejectionOrder } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: creditNoteBody.companyId,
    });

    const { invoiceId, items, companyId, total } = creditNoteBody;

    // Enforce item selectability. A credit note against an invoice carries that invoice's lines
    // (deactivation afterwards is tolerated); a standalone credit note requires active items.
    // (Display snapshot is repaired on read.)
    const itemSelectabilityCheck = await enrichDocumentItemLines(items, {
      companyId,
      warehouseId: creditNoteBody.warehouseId,
      session,
      snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
    });
    if (invoiceId) {
      assertResolvable(itemSelectabilityCheck);
    } else {
      assertSelectableForNewLines(itemSelectabilityCheck, 'credit note');
    }
    await assertLineUnitsValid(itemSelectabilityCheck, { companyId, session });
    const company = await Company.findById(companyId).populate('baseCurrency').session(session);

    let ids = '';
    if (creditNoteBody?.isSplit) {
      ids = await generateMultipleUniqueIdsForModules(
        CreditNote,
        companyId,
        [
          {
            moduleName: MODULE_NAMES.SPLIT_CREDIT_NOTE,
            idField: 'creditNoteId',
            defaultPrefix: 'SCN',
            count: 1,
            resultKey: 'splitCreditNoteId',
            providedId: null,
          },
        ],
        session,
      );
    } else {
      creditNoteBody.creditNoteId = await generateUniqueId(
        CreditNote,
        companyId,
        MODULE_NAMES.CREDIT_NOTE,
        'creditNoteId',
        'CN',
        session,
        creditNoteBody.creditNoteId,
      );
    }
    let shippingAddressId = null;
    let currency;
    let exchangeRate;
    let decimalPlaces;

    if (invoiceId) {
      const invoice = await Invoice.findById(invoiceId)
        .select('currency exchangeRate decimalPlaces branchId customerId')
        .session(session);
      if (!invoice) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Invoice not found');
      }

      if (invoice.currency) {
        currency = invoice.currency;
        exchangeRate = invoice.exchangeRate ?? 1;
        decimalPlaces = invoice.decimalPlaces ?? null;
      }

      const { branchId, customerId } = invoice;
      const customer = await Customer.findOne({
        _id: new mongoose.Types.ObjectId(customerId),
        'branch.branchId': branchId,
      }).session(session);

      if (customer == null || customer == undefined) {
        await defaultBranchEntry(customerId, branchId, session);
      }

      if (creditNoteBody?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
        shippingAddressId = customer?.address?.shipping?._id;
      } else if (
        customer?.address?.additionalShippingAddresses?.some(
          address => address?._id?.toString() === creditNoteBody?.addressId?.toString(),
        )
      ) {
        shippingAddressId = customer?.address?.additionalShippingAddresses?.find(
          address => address?._id?.toString() === creditNoteBody?.addressId?.toString(),
        )?._id;
      }

      if (!shippingAddressId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Customer Shipping address not found');
      }

      //update customer current balance

      await updateBranchCurrentBalance({
        customerId: customerId,
        branchId,
        amount: -total,
        session,
      });
    } else {
      const { branchId, customerId } = creditNoteBody;
      const customer = await Customer.findOne({
        _id: new mongoose.Types.ObjectId(customerId),
        'branch.branchId': branchId,
      }).session(session);

      if (customer == null || customer == undefined) {
        await defaultBranchEntry(customerId, branchId, session);
      }

      if (creditNoteBody?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
        shippingAddressId = customer?.address?.shipping?._id;
      } else if (
        customer?.address?.additionalShippingAddresses?.some(
          address => address?._id?.toString() === creditNoteBody?.addressId?.toString(),
        )
      ) {
        shippingAddressId = customer?.address?.additionalShippingAddresses?.find(
          address => address?._id?.toString() === creditNoteBody?.addressId?.toString(),
        )?._id;
      }

      if (!shippingAddressId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Customer Shipping address not found');
      }

      //update customer current balance

      await updateBranchCurrentBalance({
        customerId: customerId,
        branchId,
        amount: -total,
        session,
      });
    }

    if (!currency) {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
        companyId,
        customerId: creditNoteBody.customerId,
      }));
    }
    const currencyDoc = await getCurrency(companyId, currency);

    const bank = await getPrimaryBank(creditNoteBody.companyId, session);

    const creditNoteData = {
      ...creditNoteBody,
      currency,
      exchangeRate: creditNoteBody.exchangeRate ?? 1,
      decimalPlaces,
      attachments: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      bankAccountId: bank?.accountId,
      availableBalance: creditNoteBody.total,
      addedBy: userId,
      isSplit: false,
      updatedBy: userId,
      commentHistory: [
        {
          message: `Credit Note created for ${currencyDoc?.symbol || '₹'}${creditNoteBody.total || 0}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'CreditNote',
        },
      ],
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };
    if (creditNoteBody?.isSplit) {
      creditNoteData.creditNoteId = ids.splitCreditNoteId;
      creditNoteData.isSplit = true;
    }

    const [creditNote] = await CreditNote.create([creditNoteData], { session });

    //add stock if type is goods return
    if (creditNoteBody?.type == CREDIT_NOTE_TYPE.GOODS_RETURN) {
      const returnCostByItemId = await buildReturnCostMap(companyId, invoiceId, creditNoteBody?.items, session);
      for (let i of creditNoteBody?.items) {
        // Create batch for returned items

        const warehouseStockObj = {
          action: 'addStock',
          stockData: {
            itemId: i.itemId,
            companyId: companyId,
            divisionId: creditNoteBody?.divisionId,
            branchId: creditNoteBody.branchId,
            warehouseId: creditNoteBody.warehouseId,
            quantity: i.quantity,
            itemUnitId: i.itemUnitId,
            purchasePrice: returnCostByItemId.get(i.itemId?.toString()) || 0,
            rateIsBase: true,
            sourceType: 'CREDIT_NOTE',
            sourceId: creditNote._id,
          },
          session,
        };
        const batchSummary = await handleWarehouseStock(warehouseStockObj);
        // Add batch information to credit note item
        if (!i.batches) {
          i.batches = [];
        }

        if (batchSummary && !batchSummary?.skipped) {
          i.batches.push({
            batchNo: batchSummary.batchNo,
            quantity: batchSummary.quantity,
            purchasePrice: batchSummary.purchasePrice,
            warehouseId: creditNoteBody.warehouseId,
            itemBatchId: batchSummary?._id,
          });
        }
      }

      await checkCompanyStockLevels({
        itemIds: creditNoteBody.items.map(i => i.itemId),
        companyId,
        docType: MODULE_NAMES.CREDIT_NOTE,
        docId: creditNote._id,
        docNo: creditNote.creditNoteId,
        userId,
        session,
      });

      // Update the credit note with batch information
      await CreditNote.updateOne({ _id: creditNote._id }, { $set: { items: creditNoteBody.items } }, { session });
      // The journal below reads the returned stock from these batches.
      creditNote.items = creditNoteBody.items;
    }

    const rejectionRef = creditNoteBody.rejectionOrderDetails?.rejectionOrderRef;
    if (rejectionRef) {
      const rejectionOrder = await RejectionOrder.findOne({ _id: rejectionRef, companyId })
        .select('status')
        .session(session)
        .lean();
      if (!rejectionOrder) throw new ApiError(httpStatus.NOT_FOUND, 'Rejection order not found');
      validateStatusTransition(REJECTION_ORDER_STATUS_CONFIG.STATUS_TRANSITIONS, rejectionOrder.status, 'SETTLED');
      await RejectionOrder.updateOne(
        { _id: rejectionRef, companyId },
        { $set: { convertType: 'Credit Note', status: 'SETTLED', 'items.$[].convertType': 'Credit Note' } },
        { session },
      );
    }

    await syncCreditNoteJournal(companyId, creditNote, userId, session);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: creditNote.customerId,
      companyId: creditNote.companyId,
      notificationType: NOTIFICATION_TYPE.CREDIT_NOTE_CREATED,
      entityId: creditNote._id,
      entityDisplayId: creditNote.creditNoteId,
      triggeredByUserId: userId,
    });

    return enrichDocumentCurrency(companyId, creditNote.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryCreditNotes = async (query, filter, options) => {
  const { Customer, Item, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();
  const { CreditNote } = getBooksModels();
  const { User } = getCommonModels();

  const companyId = new mongoose.Types.ObjectId(filter.companyId);
  const conditions = { companyId };

  if (filter?.isSplit) {
    conditions.isSplit = true;
  } else {
    conditions.isSplit = { $ne: true };
  }

  const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'creditNoteDate' });
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
  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());

    const customers = await Customer.find({
      companyId,
      $or: [{ customerDisplayName: searchRegex }],
    }).select('_id');

    const customerIds = customers.map(c => c._id);
    conditions.$or = [{ referenceNumber: searchRegex }, { creditNoteId: searchRegex }, { customerId: { $in: customerIds } }];
  }

  if (filter?.customerId) {
    const customerIds = filter.customerId
      .split(',')
      .filter(Boolean)
      .map(id => new mongoose.Types.ObjectId(id));

    if (customerIds.length > 0) {
      conditions.customerId = { $in: customerIds };
    }
  }

  if (filter.eInvoiceGenerated === true || filter.eInvoiceGenerated === 'true') {
    conditions['eInvoice.status'] = E_INVOICE_STATUS.ACT.value;
  }

  if (filter.eWayBillGenerated === true || filter.eWayBillGenerated === 'true') {
    conditions['eWayBill.status'] = E_WAY_BILL_STATUS.ACT.value;
  }

  // Country/State/City filters resolve through the address selected on the credit note (addressId)
  const addressCondition = await getAddressFilterCondition(Customer, companyId, filter);
  if (addressCondition) {
    (conditions.$and ||= []).push(addressCondition);
  }

  if (options?.countOnly) {
    return { results: [], totalResults: await CreditNote.countDocuments(conditions) };
  }

  // Paginate without population
  const result = await CreditNote.paginateWithTotal(conditions, options);

  // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
  await CreditNote.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

  // Unique customer and item IDs
  const customerIds = [...new Set(result.results.map(r => r.customerId?.toString()).filter(Boolean))];
  const branchIds = [...new Set(result.results.map(i => i.branchId))];
  const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
  const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
  const itemIds = [...new Set(result.results.flatMap(r => r.items?.map(i => i.itemId?.toString())).filter(Boolean))];
  const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
  const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
  const userIds = [...new Set([...addedByIds, ...updatedByIds])];
  // Fetch in bulk
  const [customers, items, branch, warehouse, division, users] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } })
      .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails')
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
    User.find({ _id: { $in: userIds } })
      .select('firstName lastName')
      .lean(),
  ]);

  const customerMap = customers.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const itemMap = items.reduce((acc, item) => {
    acc[item._id.toString()] = item;
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

  // Populate final result
  const populatedResults = result.results.map(creditNote => {
    const obj = creditNote.toObject();
    obj.id = obj._id;
    obj.branchId = branchMap[obj.branchId?.toString()] || null;
    obj.divisionId = divisionMap[obj.divisionId?.toString()] || null;
    obj.warehouseId = warehouseMap[obj.warehouseId?.toString()] || null;
    obj.customerId = customerMap[obj.customerId?.toString()] || null;
    obj.addressIn = findAddressById(obj.customerId?.address, obj.addressId);

    if (Array.isArray(obj.items)) {
      obj.items = obj.items.map(i => ({
        ...i,
        itemId: itemMap[i.itemId?.toString()] || null,
      }));
    }

    obj.addedBy = userMap[obj.addedBy?.toString()] || null;
    const updatedById = toUpdatedByUserIdString(obj.updatedBy);
    const updatedBy = updatedById ? userMap[updatedById] : null;
    obj.updatedBy = updatedBy || null;
    return obj;
  });

  const populatedResultsWithCurrency = await enrichDocumentCurrency(
    String(filter.companyId),
    await attachItemSummaries(populatedResults),
  );

  return {
    ...result,
    results: populatedResultsWithCurrency,
  };
};

const queryCreditNotesExports = async (query, filter, options) => {
  const result = await queryCreditNotes(query, filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const getCreditNoteById = async (id, companyId) => {
  const { Customer, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();
  const { CreditNote } = getBooksModels();
  const { User } = getCommonModels();

  // Get the credit note (ItemUnit lives in booksCrm, so pass the model explicitly)
  const creditNote = await CreditNote.findOne({ _id: id, companyId }).populate([
    { path: 'rejectionOrderDetails.rejectionOrderRef' },
    { path: 'items.itemUnitId', select: 'name', model: ItemUnit },
  ]);
  if (!creditNote) {
    throw new ApiError(httpStatus.NOT_FOUND, CREDIT_NOTE_MESSAGES.NOT_FOUND);
  }

  // Get customer data
  const customer = await Customer.findById(creditNote.customerId)
    .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails isCustomerDirectTax')
    .lean();

  let shippingAddress = null;

  if (creditNote.addressId) {
    if (creditNote?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
      shippingAddress = customer.address.shipping;
    }

    if (!shippingAddress) {
      shippingAddress = customer?.address?.additionalShippingAddresses?.find(
        addr => addr._id.toString() === creditNote.addressId.toString(),
      );
    }
  }

  const addedBy = await User.findById(creditNote.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(creditNote.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findOne(creditNote.branchId).select('name');
  const division = await Division.findOne(creditNote.divisionId).select('name');
  const warehouse = await Warehouse.findOne(creditNote.warehouseId).select('name');
  const primaryBankDetails = await getPrimaryBankDetails(creditNote?.bankAccountId);

  // --- Populate commentHistory.addedBy ---
  let commentHistoryWithUser = [];
  if (creditNote.commentHistory?.length) {
    const userIds = creditNote.commentHistory.map(c => c.addedBy).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, 'firstName lastName email').lean();
    const userMap = new Map(users.map(user => [user._id.toString(), user]));
    commentHistoryWithUser = creditNote.commentHistory.map(comment => {
      const addedByUser = userMap.get(comment.addedBy?.toString());
      return {
        ...(comment.toObject?.() ?? comment),
        addedBy: addedByUser || comment.addedBy,
      };
    });
  }

  // Convert credit note to object and populate the data
  const creditNoteObj = creditNote.toObject();
  creditNoteObj.commentHistory = commentHistoryWithUser;
  creditNoteObj.addedBy = addedBy;
  creditNoteObj.updatedBy = updatedBy;
  creditNoteObj.branchName = branch.name;
  creditNoteObj.divisionName = division.name;
  creditNoteObj.warehouseName = warehouse.name;
  creditNoteObj.bankAccountId = primaryBankDetails || {};
  // Populate customer data
  creditNoteObj.customerId = customer || null;
  creditNoteObj.shippingAddress = shippingAddress || {};

  // Initialize refunds array if it doesn't exist
  if (!Array.isArray(creditNoteObj.refunds)) {
    creditNoteObj.refunds = [];
  }

  // Populate account names in refunds array
  if (creditNoteObj.refunds.length > 0) {
    const { Account } = getBooksModels();
    const refundAccountIds = [...new Set(creditNoteObj.refunds.map(refund => refund.fromAccountId?.toString()).filter(Boolean))];

    if (refundAccountIds.length > 0) {
      const accounts = await Account.find({ _id: { $in: refundAccountIds } })
        .select('accountName')
        .lean();
      const accountMap = new Map(accounts.map(account => [account._id.toString(), account]));

      for (const refund of creditNoteObj.refunds) {
        refund.fromAccountName = accountMap.get(refund.fromAccountId?.toString())?.accountName || null;
      }
    }
  }

  // Repair any blank snapshot from the Item master and attach a per-line itemIssue for the UI warning.
  creditNoteObj.items = await enrichDocumentItemLines(creditNoteObj.items, {
    companyId,
    warehouseId: creditNoteObj.warehouseId,
    snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
  });

  return enrichDocumentCurrency(companyId, creditNoteObj);
};

const updateCreditNoteById = async (creditNoteId, updateBody, userId, uploadedFiles = []) => {
  const { CreditNote } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const { invoiceId, total, branchId, customerId, items: newItems, companyId } = updateBody;
    const creditNote = await CreditNote.findOne({ _id: creditNoteId, companyId }).session(session);
    if (!creditNote) {
      throw new ApiError(httpStatus.NOT_FOUND, CREDIT_NOTE_MESSAGES.NOT_FOUND);
    }

    // Enforce item selectability on update: newly added items must be active; items already on the
    // credit note are tolerated even if deactivated afterwards. (Display snapshot is repaired on read.)
    if (Array.isArray(newItems) && newItems.length) {
      const existingItemIds = new Set((creditNote.items || []).map(line => line.itemId?.toString()));
      const enrichedUpdateItems = await enrichDocumentItemLines(newItems, {
        companyId,
        warehouseId: updateBody.warehouseId,
        session,
        snapshotMode: SNAPSHOT_MODE.FILL_MISSING,
      });
      assertResolvable(enrichedUpdateItems);
      assertSelectableForNewLines(
        enrichedUpdateItems.filter(line => line.itemId && !existingItemIds.has(String(line.itemId))),
        'credit note',
      );
    }

    const company = await Company.findById(creditNote.companyId).populate('baseCurrency').session(session);

    const originalItems = creditNote.items.map(i => ({
      ...i.toObject(),
    }));
    if (creditNote?.status !== CREDIT_NOTE_STATUS.DRAFT) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only draft credit notes can be edited');
    }
    const oldtotal = creditNote.total;

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: creditNote.attachments ? creditNote.attachments : [],
      userId,
      companyId: creditNote.companyId,
    });

    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(customerId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(customerId, branchId, session);
    }

    let shippingAddressId = null;
    if (updateBody?.addressId?.toString() === customer?.address?.shipping?._id?.toString()) {
      shippingAddressId = customer?.address?.shipping?._id;
    } else if (
      customer?.address?.additionalShippingAddresses?.some(
        address => address?._id?.toString() === updateBody?.addressId?.toString(),
      )
    ) {
      shippingAddressId = customer?.address?.additionalShippingAddresses?.find(
        address => address?._id?.toString() === updateBody?.addressId?.toString(),
      )?._id;
    }

    if (!shippingAddressId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Customer Shipping address not found');
    }

    // If total changes, ensure new total doesn't drop below already applied amount
    if (updateBody.total !== undefined) {
      const totalApplied =
        (creditNote.invoicesApplied || []).reduce((sum, app) => sum + (app.amountApplied || 0), 0) +
        (creditNote.openingBalanceTransactions || []).reduce((sum, app) => sum + (app.amountApplied || 0), 0);

      if (updateBody.total < totalApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'New total cannot be less than the amount already applied to invoices');
      }
      creditNote.availableBalance = updateBody.total - totalApplied;
      updateBody.availableBalance = updateBody.total - totalApplied;
    }

    //warehouse batches
    creditNote.items = updateBody.items.map(i => ({
      ...i,
      batches: [],
    }));
    if (creditNote?.type != CREDIT_NOTE_TYPE.GOODS_RETURN && updateBody?.type == CREDIT_NOTE_TYPE.GOODS_RETURN) {
      const returnCostByItemId = await buildReturnCostMap(
        updateBody?.companyId || creditNote.companyId,
        invoiceId || creditNote.invoiceId,
        creditNote.items,
        session,
      );
      for (let i of creditNote.items) {
        const warehouseStockObj = {
          action: 'addStock',
          stockData: {
            itemId: i.itemId,
            companyId: updateBody?.companyId,
            divisionId: updateBody?.divisionId,
            branchId: updateBody?.branchId,
            warehouseId: updateBody?.warehouseId,
            quantity: i.quantity,
            itemUnitId: i.itemUnitId,
            purchasePrice: returnCostByItemId.get(i.itemId?.toString()) || 0,
            rateIsBase: true,
            vendorBatchNo: i?.vendorBatchNo,
            vendorBatchExpiry: i?.vendorBatchExpiry,
            sourceType: MODULE_NAMES.CREDIT_NOTE,
            sourceId: creditNoteId,
            addedBy: userId,
          },
          session,
        };

        const batchSummary = await handleWarehouseStock(warehouseStockObj);

        if (batchSummary && !batchSummary?.skipped) {
          i.batches = [
            {
              batchNo: batchSummary.batchNo,
              quantity: batchSummary.quantity,
              purchasePrice: batchSummary.purchasePrice,
              warehouseId: creditNote.warehouseId,
              itemBatchId: batchSummary._id,
            },
          ];
        }
      }

      await checkCompanyStockLevels({
        itemIds: creditNote.items.map(i => i.itemId),
        companyId: updateBody?.companyId,
        docType: MODULE_NAMES.CREDIT_NOTE,
        docId: creditNoteId,
        docNo: creditNote.creditNoteId,
        userId,
        session,
      });
    }

    if (creditNote?.type == CREDIT_NOTE_TYPE.GOODS_RETURN && updateBody?.type != CREDIT_NOTE_TYPE.GOODS_RETURN) {
      //delete stock

      for (let i of creditNote?.items) {
        const warehouseStockObj = {
          action: 'deleteStock',
          stockData: {
            itemId: i.itemId,
            companyId: creditNote.companyId,
            warehouseId: creditNote.warehouseId,
            deductedSourceType: MODULE_NAMES.CREDIT_NOTE,
            deductedSourceId: creditNoteId,
          },
          session,
        };
        await handleWarehouseStock(warehouseStockObj);

        i.batches = [];
      }

      await checkCompanyStockLevels({
        itemIds: creditNote.items.map(i => i.itemId),
        companyId: creditNote.companyId,
        docType: MODULE_NAMES.CREDIT_NOTE,
        docId: creditNoteId,
        docNo: creditNote.creditNoteId,
        userId,
        session,
      });
    }

    if (creditNote.type === CREDIT_NOTE_TYPE.GOODS_RETURN && updateBody.type === CREDIT_NOTE_TYPE.GOODS_RETURN) {
      // Lines are identified by item + unit + price: the same item can sit on several lines of the note,
      // each owning its own batch, so every line is matched and adjusted individually.
      const { matches, unmatchedOldLines } = pairLinesWithExisting(newItems, originalItems);
      const touchedItemIds = new Set(newItems.map(i => i.itemId.toString()));

      const releaseBatch = async (itemId, batch) => {
        if (!batch?.itemBatchId) return;
        touchedItemIds.add(itemId.toString());
        await deleteStockByBatchId({
          stockData: {
            itemId,
            companyId: creditNote.companyId,
            warehouseId: creditNote.warehouseId,
            itemBatchId: batch.itemBatchId,
          },
          session,
        });
      };

      const toBatchEntry = batch => ({
        batchNo: batch.batchNo,
        quantity: Number(batch.quantity),
        purchasePrice: Number(batch.purchasePrice),
        warehouseId: creditNote.warehouseId,
        itemBatchId: batch.itemBatchId || batch._id,
      });

      /* ================= REMOVE DELETED LINES ================= */
      for (const oldLine of unmatchedOldLines) {
        for (const oldBatch of oldLine.batches || []) {
          await releaseBatch(oldLine.itemId, oldBatch);
        }
      }

      /* ================= ADD / UPDATE LINES ================= */
      const finalItems = [];
      const returnCostByItemId = await buildReturnCostMap(
        creditNote.companyId,
        invoiceId || creditNote.invoiceId,
        newItems,
        session,
      );

      for (const [index, newItem] of newItems.entries()) {
        const oldItem = matches[index];
        const [oldBatch, ...extraBatches] = oldItem?.batches || [];
        for (const extraBatch of extraBatches) {
          await releaseBatch(newItem.itemId, extraBatch);
        }

        /* -------- UPDATE EXISTING LINE -------- */
        if (oldItem) {
          const changed = Number(newItem.quantity) !== Number(oldItem.quantity) || Number(newItem.rate) !== Number(oldItem.rate);

          /* -------- NO CHANGE -------- */
          if (!changed) {
            finalItems.push({ ...newItem, batches: oldBatch ? [oldBatch] : [] });
            continue;
          }

          if (oldBatch?.itemBatchId) {
            const adjusted = await adjustStockByBatchId({
              stockData: {
                itemId: newItem.itemId,
                companyId: creditNote.companyId,
                warehouseId: creditNote.warehouseId,
                itemBatchId: oldBatch.itemBatchId,
                newQuantity: newItem.quantity,
                itemUnitId: newItem.itemUnitId,
                vendorBatchNo: newItem?.vendorBatchNo,
                vendorBatchExpiry: newItem?.vendorBatchExpiry,
              },
              session,
            });
            finalItems.push({ ...newItem, batches: [toBatchEntry(adjusted)] });
            continue;
          }
        }

        /* -------- NEW LINE -------- */
        const batch = await handleWarehouseStock({
          action: 'addStock',
          stockData: {
            itemId: newItem.itemId,
            companyId: creditNote.companyId,
            divisionId: creditNote.divisionId,
            branchId: creditNote.branchId,
            warehouseId: creditNote.warehouseId,
            quantity: newItem.quantity,
            itemUnitId: newItem.itemUnitId,
            purchasePrice: returnCostByItemId.get(newItem.itemId?.toString()) || 0,
            rateIsBase: true,
            vendorBatchNo: newItem?.vendorBatchNo,
            vendorBatchExpiry: newItem?.vendorBatchExpiry,
            sourceType: MODULE_NAMES.CREDIT_NOTE,
            sourceId: creditNoteId,
            addedBy: userId,
          },
          session,
        });

        finalItems.push({ ...newItem, batches: batch && !batch.skipped ? [toBatchEntry(batch)] : [] });
      }

      await checkCompanyStockLevels({
        itemIds: [...touchedItemIds],
        companyId: creditNote.companyId,
        docType: MODULE_NAMES.CREDIT_NOTE,
        docId: creditNoteId,
        docNo: creditNote.creditNoteId,
        userId,
        session,
      });

      /* ================= FINAL ASSIGN ================= */
      creditNote.items = finalItems;
    }

    //update customer current balance
    let newCurrentBalance = total;
    if (newCurrentBalance == oldtotal) {
      newCurrentBalance = 0;
    }
    if (newCurrentBalance !== oldtotal) {
      newCurrentBalance = total - oldtotal;
    }

    if (creditNote?.branchId.toString() !== updateBody?.branchId) {
      //reverse old effect

      await updateBranchCurrentBalance({
        customerId: customerId,
        branchId: creditNote?.branchId,
        amount: creditNote?.total,
        session,
      });

      //add new branch effect

      await updateBranchCurrentBalance({
        customerId: customerId,
        branchId: branchId,
        amount: -updateBody?.total,
        session,
      });
    } else {
      await updateBranchCurrentBalance({
        customerId: customerId,
        branchId: branchId,
        amount: -newCurrentBalance,
        session,
      });
    }

    if (customerId && String(customerId) !== String(creditNote.customerId)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: creditNote.companyId,
        customerId,
      });
      updateBody.currency = currency;
      updateBody.decimalPlaces = decimalPlaces;
    }
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(creditNote.companyId, updateBody.currency || creditNote.currency);
    const currencySymbol = currencyDoc?.symbol || company?.baseCurrency?.symbol || '₹';

    let updateMsg = 'Credit Note updated.';
    if (updateBody.total !== undefined && updateBody.total !== oldtotal) {
      updateMsg = `Credit Note updated. Amount changed from ${currencySymbol}${oldtotal} to ${currencySymbol}${updateBody.total}`;
    }

    Object.assign(creditNote, {
      ...updateBody,
      items: creditNote.items,
      attachments: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    creditNote.updatedBy = userId;
    creditNote.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'CreditNote',
    });
    await creditNote.save({ session });

    await syncCreditNoteJournal(creditNote.companyId, creditNote, userId, session);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: creditNote.customerId,
      companyId: creditNote.companyId,
      notificationType: NOTIFICATION_TYPE.CREDIT_NOTE_UPDATED,
      entityId: creditNote._id,
      entityDisplayId: creditNote.creditNoteId,
      triggeredByUserId: userId,
    });

    return enrichDocumentCurrency(creditNote.companyId, creditNote.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteCreditNoteById = async (creditNoteId, companyId, userId) => {
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { Invoice, CreditNote } = getBooksModels();

    const creditNote = await CreditNote.findOne({ _id: creditNoteId, companyId }).session(session);

    if (!creditNote) {
      throw new ApiError(httpStatus.NOT_FOUND, CREDIT_NOTE_MESSAGES.NOT_FOUND);
    }

    if ([CREDIT_NOTE_STATUS.USED, CREDIT_NOTE_STATUS.CLOSED, CREDIT_NOTE_STATUS.PARTIALLY_USED].includes(creditNote?.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `This credit note cannot be deleted in ${creditNote?.status} status`);
    }

    const linkedRejectionOrder = await assertLinkedRejectionDeletable(
      creditNote.rejectionOrderDetails?.rejectionOrderRef,
      companyId,
      session,
      CREDIT_NOTE_MESSAGES.DELETE_RESTRICTED_REJECTION_ORDER,
    );

    if (creditNote.refunds?.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, CREDIT_NOTE_MESSAGES.HAS_REFUNDS);
    }

    if (creditNote?.status != CREDIT_NOTE_STATUS.CANCELLED) {
      if (creditNote?.invoicesApplied) {
        for (const appLine of creditNote?.invoicesApplied) {
          const { invoiceId, amountApplied } = appLine;
          const invoice = await Invoice.findById(invoiceId).session(session);
          invoice.creditsApplied = invoice.creditsApplied.filter(
            credit => credit.creditNoteId.toString() !== creditNote._id.toString(),
          );
          await updateInvoicePaymentStatus(invoice._id, -Math.abs(amountApplied), userId, session);
          await moveAdvanceApplyBranchBalances({
            customerId: creditNote.customerId,
            paymentBranchId: creditNote.branchId,
            documentBranchId: invoice.branchId,
            amount: Math.abs(amountApplied),
            session,
            reverse: true,
          });
          if (appLine?._id) {
            await ledgerService.deleteJournal(
              { companyId, sourceModule: LEDGER_SOURCE_MODULES.INVOICE, sourceId: appLine._id },
              session,
            );
          }
          await invoice.save({ session });
        }
      }

      const { OpeningBalanceTransaction } = getBooksCrmModels();
      for (const appLine of creditNote?.openingBalanceTransactions || []) {
        const { openingBalanceTransactionId, amountApplied } = appLine;
        const txn = await OpeningBalanceTransaction.findById(openingBalanceTransactionId).session(session);
        if (!txn) continue;
        await moveAdvanceApplyBranchBalances({
          customerId: creditNote.customerId,
          paymentBranchId: creditNote.branchId,
          documentBranchId: txn.branchId,
          amount: Math.abs(amountApplied),
          session,
          reverse: true,
        });
        if (appLine?._id) {
          await ledgerService.deleteJournal(
            { companyId, sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, sourceId: appLine._id },
            session,
          );
        }
        await txn.updateRemainingAmount(-Math.abs(amountApplied), session);
        await OpeningBalanceTransaction.updateOne(
          { _id: txn._id, companyId },
          {
            $pull: {
              paymentReceivedEntries: {
                paymentDocumentNo: creditNote.creditNoteId,
                amountApplied: Math.abs(amountApplied),
              },
            },
          },
          { session },
        );
      }

      await updateBranchCurrentBalance({
        customerId: creditNote.customerId,
        branchId: creditNote.branchId,
        amount: creditNote.total,
        session,
      });

      if (creditNote?.type == CREDIT_NOTE_TYPE.GOODS_RETURN) {
        for (let i of creditNote?.items) {
          const warehouseStockObj = {
            action: 'deleteStock',
            stockData: {
              itemId: i.itemId,
              companyId: creditNote.companyId,
              branchId: creditNote.branchId,
              warehouseId: creditNote.warehouseId,
              deductedSourceType: MODULE_NAMES.CREDIT_NOTE,
              deductedSourceId: creditNoteId,
            },
            session,
          };

          await handleWarehouseStock(warehouseStockObj);
        }

        await checkCompanyStockLevels({
          itemIds: (creditNote?.items || []).map(i => i.itemId),
          companyId: creditNote.companyId,
          docType: MODULE_NAMES.CREDIT_NOTE,
          docId: creditNoteId,
          docNo: creditNote.creditNoteId,
          userId: creditNote.addedBy,
          session,
        });
      }
    }

    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.CREDIT_NOTE, sourceId: creditNote._id },
      session,
    );

    await revertLinkedRejectionSettlement(linkedRejectionOrder, companyId, session);

    await CreditNote.findByIdAndDelete(creditNoteId, { session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: creditNote.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.CREDIT_NOTE_DELETED,
      entityId: creditNote._id,
      entityDisplayId: creditNote.creditNoteId,
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

const applyCreditNote = async (creditNoteId, companyId, applications, userId) => {
  const { CreditNote, Invoice } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();
    const creditNote = await CreditNote.findOne({ _id: creditNoteId, companyId }).session(session);
    if (!creditNote) {
      throw new ApiError(httpStatus.NOT_FOUND, CREDIT_NOTE_MESSAGES.NOT_FOUND);
    }

    if ([CREDIT_NOTE_STATUS.DRAFT, CREDIT_NOTE_STATUS.USED, CREDIT_NOTE_STATUS.CLOSED].includes(creditNote?.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'You cannot apply a credit note in draft status');
    }

    if (creditNote.availableBalance <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No available balance to apply');
    }
    let totalApplied = 0;
    const invoiceUpdates = [];
    const obUpdates = [];

    // Each target (invoice / opening balance) may appear only once per request. The validate loop below
    // caches the fetched document, so two lines for the same target would each pass the stale per-line
    // guard and over-apply (driving balanceAmount negative and over-consuming the credit).
    const seenApplicationTargets = new Set();
    for (const app of applications) {
      const targetId = app.invoiceId || app.openingBalanceTransactionId;
      if (targetId) {
        const targetKey = String(targetId);
        if (seenApplicationTargets.has(targetKey)) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'The same invoice or opening balance is listed more than once. Please remove the duplicate before applying the credit note.',
          );
        }
        seenApplicationTargets.add(targetKey);
      }
    }

    for (const app of applications) {
      const amountApplied = Number(app.amountApplied) || 0;
      if (amountApplied <= 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Amount applied must be greater than zero');
      }

      if (app.openingBalanceTransactionId) {
        const txn = await OpeningBalanceTransaction.findById(app.openingBalanceTransactionId).session(session);
        if (!txn) {
          throw new ApiError(httpStatus.NOT_FOUND, `Opening balance ${app.openingBalanceTransactionId} not found`);
        }
        if (String(txn.companyId) !== String(companyId)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance does not belong to this company');
        }
        if (String(txn.contactId) !== String(creditNote.customerId)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance does not belong to this customer');
        }
        if (txn.type !== TRANSACTION_TYPE.OPENING_RECEIVABLE) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Only opening receivable can be applied with a credit note');
        }
        if (creditNote.currency && txn.currency && String(creditNote.currency) !== String(txn.currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency credit application is not supported.');
        }
        if (txn.remainingAmount < amountApplied) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            `Amount exceeds remaining balance for opening balance ${txn.transactionNo || txn._id}`,
          );
        }
        totalApplied += amountApplied;
        obUpdates.push({ txn, amountApplied, transactionNo: app.transactionNo || txn.transactionNo });
        continue;
      }

      const invoice = await Invoice.findById(app.invoiceId).session(session);
      if (!invoice) {
        throw new ApiError(httpStatus.NOT_FOUND, `Invoice ${app.invoiceId} not found`);
      }
      if (creditNote.currency && invoice.currency && String(creditNote.currency) !== String(invoice.currency)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency credit application is not supported.');
      }
      if (invoice.balanceAmount < amountApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Amount exceeds balance for invoice ${app.invoiceId}`);
      }

      totalApplied += amountApplied;
      invoiceUpdates.push({ invoice, amountApplied, invoiceNo: app.invoiceNo || invoice.invoiceId });
    }

    if (totalApplied > creditNote.availableBalance) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Total applied amount exceeds available balance');
    }

    const currencyDoc = await getCurrency(companyId, creditNote.currency);

    for (const { invoice, amountApplied, invoiceNo } of invoiceUpdates) {
      const appliedDate = new Date();
      const applicationId = new mongoose.Types.ObjectId();
      invoice.creditsApplied.push({
        creditNoteId: creditNote._id,
        creditNoteNo: creditNote.creditNoteId,
        amountApplied,
        appliedDate,
      });
      invoice.commentHistory.push({
        message: `Credit Note ${creditNote.creditNoteId} applied for ${currencyDoc?.symbol || '₹'}${amountApplied}`,
        addedBy: userId,
        createdAt: new Date(),
        referenceType: 'CreditNote',
        referenceId: creditNote._id,
      });
      await moveAdvanceApplyBranchBalances({
        customerId: creditNote.customerId,
        paymentBranchId: creditNote.branchId,
        documentBranchId: invoice.branchId,
        amount: amountApplied,
        session,
      });
      await updateInvoicePaymentStatus(invoice._id, amountApplied, userId, session);
      await invoice.save({ session });
      creditNote.invoicesApplied.push({
        _id: applicationId,
        invoiceId: invoice._id,
        invoiceNo,
        amountApplied,
        appliedDate,
      });
      await ledgerService.postCrossBranchCreditApplyJournal(
        {
          companyId,
          partyId: creditNote.customerId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          creditBranchId: creditNote.branchId,
          documentBranchId: invoice.branchId,
          creditDivisionId: creditNote.divisionId,
          documentDivisionId: invoice.divisionId,
          amount: amountApplied,
          postingDate: appliedDate,
          sourceModule: LEDGER_SOURCE_MODULES.INVOICE,
          sourceId: applicationId,
          narration: `Credit note ${creditNote.creditNoteId} applied to invoice ${invoiceNo}`,
          addedBy: userId,
          currencyId: creditNote.currency || invoice.currency,
          exchangeRate: creditNote.exchangeRate || invoice.exchangeRate,
        },
        session,
      );
    }

    creditNote.openingBalanceTransactions = creditNote.openingBalanceTransactions || [];
    for (const { txn, amountApplied, transactionNo } of obUpdates) {
      const appliedDate = new Date();
      const applicationId = new mongoose.Types.ObjectId();
      await moveAdvanceApplyBranchBalances({
        customerId: creditNote.customerId,
        paymentBranchId: creditNote.branchId,
        documentBranchId: txn.branchId,
        amount: amountApplied,
        session,
      });
      const ok = await txn.updateRemainingAmount(amountApplied, session);
      if (!ok) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not update opening balance; please retry');
      }
      const obPushed = await OpeningBalanceTransaction.findOneAndUpdate(
        { _id: txn._id, companyId },
        {
          $push: {
            paymentReceivedEntries: {
              entrySource: OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT,
              paymentDocumentNo: creditNote.creditNoteId,
              amountApplied,
              appliedDate,
            },
          },
        },
        { session, new: true },
      );
      if (!obPushed) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not record opening balance entry; please retry');
      }
      creditNote.openingBalanceTransactions.push({
        _id: applicationId,
        openingBalanceTransactionId: txn._id,
        transactionNo,
        amountApplied,
        appliedDate,
      });
      await ledgerService.postCrossBranchCreditApplyJournal(
        {
          companyId,
          partyId: creditNote.customerId,
          partyType: LEDGER_PARTY_TYPES.CUSTOMER,
          creditBranchId: creditNote.branchId,
          documentBranchId: txn.branchId,
          creditDivisionId: creditNote.divisionId,
          documentDivisionId: txn.divisionId,
          amount: amountApplied,
          postingDate: appliedDate,
          sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
          sourceId: applicationId,
          narration: `Credit note ${creditNote.creditNoteId} applied to opening balance ${transactionNo || txn._id}`,
          addedBy: userId,
          currencyId: creditNote.currency || txn.currency,
          exchangeRate: creditNote.exchangeRate || txn.exchangeRate,
        },
        session,
      );
    }

    creditNote.availableBalance -= totalApplied;

    if (creditNote.availableBalance === 0) {
      creditNote.status = CREDIT_NOTE_STATUS.USED;
    }

    if (creditNote.availableBalance > 0) {
      creditNote.status = CREDIT_NOTE_STATUS.PARTIALLY_USED;
    }

    creditNote.commentHistory.push({
      message: `Credit Note applied for ${currencyDoc?.symbol || '₹'}${totalApplied}`,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'CreditNote',
    });

    await creditNote.save({ session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: creditNote.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.CREDIT_NOTE_STATUS_CHANGED,
      entityId: creditNote._id,
      entityDisplayId: creditNote.creditNoteId,
      triggeredByUserId: userId,
      newStatus: creditNote.status,
    });

    return enrichDocumentCurrency(companyId, creditNote.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteCreditNoteInvoice = async (creditNoteId, companyId, body, userId) => {
  const { CreditNote, Invoice } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const { documentId, invoiceId, openingBalanceTransactionId } = body;
    const creditNote = await CreditNote.findOne({ _id: creditNoteId, companyId }).session(session);
    if (!creditNote) {
      throw new ApiError(httpStatus.NOT_FOUND, CREDIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const currencyDoc = await getCurrency(companyId, creditNote.currency);
    let amountApplied = 0;
    let unremovedInvoices = creditNote?.invoicesApplied || [];
    let unremovedOb = creditNote?.openingBalanceTransactions || [];
    let removeMessage = '';

    if (openingBalanceTransactionId) {
      const obApplication = creditNote?.openingBalanceTransactions?.find(
        line =>
          String(line.openingBalanceTransactionId) === String(openingBalanceTransactionId) &&
          String(line._id) === String(documentId),
      );
      if (!obApplication) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance not found in credit note applications');
      }
      amountApplied = obApplication.amountApplied || 0;
      unremovedOb = (creditNote?.openingBalanceTransactions || []).filter(
        line =>
          !(
            String(line.openingBalanceTransactionId) === String(openingBalanceTransactionId) &&
            String(line._id) === String(documentId)
          ),
      );

      const txn = await OpeningBalanceTransaction.findById(openingBalanceTransactionId).session(session);
      if (!txn) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance not found');
      }
      await moveAdvanceApplyBranchBalances({
        customerId: creditNote.customerId,
        paymentBranchId: creditNote.branchId,
        documentBranchId: txn.branchId,
        amount: amountApplied,
        session,
        reverse: true,
      });
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, sourceId: documentId },
        session,
      );
      const ok = await txn.updateRemainingAmount(-amountApplied, session);
      if (!ok) {
        throw new ApiError(httpStatus.CONFLICT, 'Could not revert opening balance; please retry');
      }
      await OpeningBalanceTransaction.updateOne(
        { _id: txn._id, companyId },
        {
          $pull: {
            paymentReceivedEntries: {
              paymentDocumentNo: creditNote.creditNoteId,
              amountApplied,
            },
          },
        },
        { session },
      );
      removeMessage = `Opening balance application of ${currencyDoc?.symbol || '₹'}${amountApplied} removed from Credit Note`;
    } else {
      const invoice = await Invoice.findById(invoiceId).session(session);
      if (!invoice) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Invoice not found');
      }

      const invoiceApplication = creditNote?.invoicesApplied?.find(
        line => String(line.invoiceId) === String(invoiceId) && String(line._id) === String(documentId),
      );
      if (!invoiceApplication) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Invoice not found in credit note applications');
      }

      amountApplied = invoiceApplication.amountApplied || 0;
      const appliedDate = invoiceApplication.appliedDate;
      unremovedInvoices = creditNote?.invoicesApplied?.filter(
        line => !(String(line.invoiceId) === String(invoiceId) && String(line._id) === String(documentId)),
      );

      const matchingCredits =
        invoice.creditsApplied?.filter(
          credit =>
            credit.creditNoteId.toString() === creditNote._id.toString() &&
            credit.amountApplied === amountApplied &&
            Math.abs(new Date(credit.appliedDate) - new Date(appliedDate)) < 1000,
        ) || [];

      if (matchingCredits.length > 1) {
        const firstMatchIndex = invoice.creditsApplied.findIndex(
          credit =>
            credit.creditNoteId.toString() === creditNote._id.toString() &&
            credit.amountApplied === amountApplied &&
            Math.abs(new Date(credit.appliedDate) - new Date(appliedDate)) < 1000,
        );
        if (firstMatchIndex !== -1) {
          invoice.creditsApplied.splice(firstMatchIndex, 1);
        }
      } else {
        invoice.creditsApplied =
          invoice.creditsApplied?.filter(
            credit =>
              !(
                credit.creditNoteId.toString() === creditNote._id.toString() &&
                credit.amountApplied === amountApplied &&
                Math.abs(new Date(credit.appliedDate) - new Date(appliedDate)) < 1000
              ),
          ) || [];
      }

      invoice.commentHistory.push({
        message: `Credit Note ${creditNote.creditNoteId} application of ${currencyDoc?.symbol || '₹'}${amountApplied} removed`,
        addedBy: userId,
        createdAt: new Date(),
        referenceType: 'CreditNote',
        referenceId: creditNote._id,
      });

      await updateInvoicePaymentStatus(invoice._id, -amountApplied, userId, session);
      await moveAdvanceApplyBranchBalances({
        customerId: creditNote.customerId,
        paymentBranchId: creditNote.branchId,
        documentBranchId: invoice.branchId,
        amount: amountApplied,
        session,
        reverse: true,
      });
      await ledgerService.deleteJournal(
        { companyId, sourceModule: LEDGER_SOURCE_MODULES.INVOICE, sourceId: documentId },
        session,
      );
      await invoice.save({ session });
      removeMessage = `Invoice application of ${currencyDoc?.symbol || '₹'}${amountApplied} removed from Credit Note`;
    }

    const totalAmountPaid =
      unremovedInvoices.reduce((sum, line) => sum + (line.amountApplied || 0), 0) +
      unremovedOb.reduce((sum, line) => sum + (line.amountApplied || 0), 0);

    const availableBalance = creditNote.total - totalAmountPaid;

    let status = '';
    if (availableBalance === 0) {
      status = CREDIT_NOTE_STATUS.USED;
    } else if (availableBalance === creditNote?.total) {
      status = CREDIT_NOTE_STATUS.OPEN;
    } else if (availableBalance > 0) {
      status = CREDIT_NOTE_STATUS.PARTIALLY_USED;
    }

    await CreditNote.updateOne(
      { _id: creditNoteId },
      {
        $set: {
          invoicesApplied: unremovedInvoices,
          openingBalanceTransactions: unremovedOb,
          availableBalance: availableBalance,
          status,
          updatedBy: userId,
        },
        $push: {
          commentHistory: {
            message: removeMessage,
            addedBy: userId,
            createdAt: new Date(),
            referenceType: 'CreditNote',
          },
        },
      },
      { session },
    );

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: creditNote.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.CREDIT_NOTE_STATUS_CHANGED,
      entityId: creditNote._id,
      entityDisplayId: creditNote.creditNoteId,
      triggeredByUserId: userId,
      newStatus: status,
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

const updateCreditNoteStatus = async (creditNoteId, companyId, newStatus, userId) => {
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { Invoice, CreditNote } = getBooksModels();

    const creditNote = await CreditNote.findOne({ _id: creditNoteId, companyId }).session(session);

    if (!creditNote) {
      throw new ApiError(httpStatus.NOT_FOUND, CREDIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const oldStatus = creditNote.status;
    validateStatusTransition(CREDIT_STATUS_CONFIG.STATUS_TRANSITIONS, creditNote?.status, newStatus);

    const isUncancel = creditNote?.status === CREDIT_NOTE_STATUS.CANCELLED && newStatus !== CREDIT_NOTE_STATUS.CANCELLED;
    if (isUncancel) {
      assertRevertAllowed({ isUncancel, hasEffect: creditNote?.type === CREDIT_NOTE_TYPE.GOODS_RETURN });

      await updateBranchCurrentBalance({
        customerId: creditNote.customerId,
        branchId: creditNote.branchId,
        amount: -creditNote.total,
        session,
      });
      creditNote.availableBalance = creditNote.total;
    }

    const isRevertFromClosed =
      creditNote?.status === CREDIT_NOTE_STATUS.CLOSED &&
      (newStatus === CREDIT_NOTE_STATUS.OPEN || newStatus === CREDIT_NOTE_STATUS.DRAFT);
    if (
      isRevertFromClosed &&
      (creditNote?.invoicesApplied?.length > 0 ||
        creditNote?.openingBalanceTransactions?.length > 0 ||
        creditNote?.refunds?.length > 0)
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Cannot revert this Credit Note because it has been applied to invoices or has refunds recorded against it.',
      );
    }

    if (newStatus === CREDIT_NOTE_STATUS.CANCELLED && creditNote.refunds?.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, CREDIT_NOTE_MESSAGES.HAS_REFUNDS);
    }

    if (creditNote?.status != CREDIT_NOTE_STATUS.CANCELLED && newStatus == CREDIT_NOTE_STATUS.CANCELLED) {
      if (creditNote?.invoicesApplied) {
        for (const appLine of creditNote?.invoicesApplied) {
          const { invoiceId, amountApplied } = appLine;
          const invoice = await Invoice.findById(invoiceId).session(session);
          invoice.creditsApplied = invoice.creditsApplied.filter(
            credit => credit.creditNoteId.toString() !== creditNote._id.toString(),
          );
          await updateInvoicePaymentStatus(invoice._id, -Math.abs(amountApplied), userId, session);
          await moveAdvanceApplyBranchBalances({
            customerId: creditNote.customerId,
            paymentBranchId: creditNote.branchId,
            documentBranchId: invoice.branchId,
            amount: Math.abs(amountApplied),
            session,
            reverse: true,
          });
          if (appLine?._id) {
            await ledgerService.deleteJournal(
              { companyId, sourceModule: LEDGER_SOURCE_MODULES.INVOICE, sourceId: appLine._id },
              session,
            );
          }
          await invoice.save({ session });
        }
      }

      const { OpeningBalanceTransaction } = getBooksCrmModels();
      for (const appLine of creditNote?.openingBalanceTransactions || []) {
        const { openingBalanceTransactionId, amountApplied } = appLine;
        const txn = await OpeningBalanceTransaction.findById(openingBalanceTransactionId).session(session);
        if (!txn) continue;
        await moveAdvanceApplyBranchBalances({
          customerId: creditNote.customerId,
          paymentBranchId: creditNote.branchId,
          documentBranchId: txn.branchId,
          amount: Math.abs(amountApplied),
          session,
          reverse: true,
        });
        if (appLine?._id) {
          await ledgerService.deleteJournal(
            { companyId, sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, sourceId: appLine._id },
            session,
          );
        }
        await txn.updateRemainingAmount(-Math.abs(amountApplied), session);
        await OpeningBalanceTransaction.updateOne(
          { _id: txn._id, companyId },
          {
            $pull: {
              paymentReceivedEntries: {
                paymentDocumentNo: creditNote.creditNoteId,
                amountApplied: Math.abs(amountApplied),
              },
            },
          },
          { session },
        );
      }
      creditNote.openingBalanceTransactions = [];
      creditNote.invoicesApplied = [];

      await updateBranchCurrentBalance({
        customerId: creditNote.customerId,
        branchId: creditNote.branchId,
        amount: creditNote.total,
        session,
      });

      if (creditNote?.type == CREDIT_NOTE_TYPE.GOODS_RETURN) {
        for (let i of creditNote?.items) {
          const warehouseStockObj = {
            action: 'deleteStock',
            stockData: {
              itemId: i.itemId,
              companyId: companyId,
              warehouseId: creditNote.warehouseId,
              deductedSourceType: MODULE_NAMES.CREDIT_NOTE,
              deductedSourceId: creditNoteId,
            },
            session,
          };

          await handleWarehouseStock(warehouseStockObj);

          i.batches = [];
        }

        await checkCompanyStockLevels({
          itemIds: (creditNote?.items || []).map(i => i.itemId),
          companyId: companyId,
          docType: MODULE_NAMES.CREDIT_NOTE,
          docId: creditNoteId,
          docNo: creditNote.creditNoteId,
          userId,
          session,
        });
      }
    }

    creditNote.status = newStatus;
    if (newStatus === CREDIT_NOTE_STATUS.CANCELLED) {
      creditNote.availableBalance = 0;
    }
    creditNote.updatedBy = userId;
    creditNote.commentHistory.push({
      message: `Credit Note ${newStatus} successfully`,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'CreditNote',
    });
    await creditNote.save({ session });

    await syncCreditNoteJournal(companyId, creditNote, userId, session, oldStatus);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: creditNote.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.CREDIT_NOTE_STATUS_CHANGED,
      entityId: creditNote._id,
      entityDisplayId: creditNote.creditNoteId,
      triggeredByUserId: userId,
      newStatus,
    });

    // Split credit notes are internal partial docs — only notify for the original document.
    if (isFirstStatusChange(oldStatus, newStatus, CREDIT_NOTE_STATUS.DRAFT) && !creditNote.isSplit) {
      const creditNoteForNotification = { ...(creditNote.toObject?.() || creditNote), status: newStatus };

      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.CREDIT_NOTE,
        document: creditNoteForNotification,
      }).catch(err =>
        logger.error(`Failed to send credit note customer notifications for ${creditNote.creditNoteId}: ${err.message}`),
      );
    }
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const createCreditNoteRefund = async (creditNoteId, companyId, refundBody, userId) => {
  const { CreditNote, Account } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { refundAmount, refundDate, fromAccountId, reference, notes } = refundBody;

    const creditNote = await CreditNote.findOne({
      _id: creditNoteId,
      companyId,
    }).session(session);

    if (!creditNote) {
      throw new ApiError(httpStatus.NOT_FOUND, CREDIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const currencyDoc = await getCurrency(companyId, creditNote.currency);

    if (![CREDIT_NOTE_STATUS.OPEN, CREDIT_NOTE_STATUS.PARTIALLY_USED].includes(creditNote.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, CREDIT_NOTE_MESSAGES.REFUND_INVALID_STATUS);
    }

    if (refundAmount > creditNote.availableBalance) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Refund amount cannot exceed available balance');
    }

    const fromAccount = await Account.findOne({
      _id: fromAccountId,
      companyId,
      isActive: true,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).session(session);
    if (!fromAccount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'From account not found or not a valid payment account');
    }

    creditNote.refunds.push({
      refundAmount,
      refundDate: new Date(refundDate),
      fromAccountId,
      reference,
      notes,
      refundedBy: userId,
      refundedAt: new Date(),
    });

    // Update available balance
    creditNote.availableBalance -= refundAmount;

    // Update status if balance becomes 0
    if (creditNote.availableBalance === 0) {
      creditNote.status = CREDIT_NOTE_STATUS.USED;
    } else if (creditNote.availableBalance > 0 && creditNote.availableBalance < creditNote.total) {
      creditNote.status = CREDIT_NOTE_STATUS.PARTIALLY_USED;
    }

    // Update updatedBy
    creditNote.updatedBy = userId;
    creditNote.commentHistory.push({
      message: `Refund of ${currencyDoc?.symbol || '₹'}${refundAmount} recorded`,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'CreditNote',
    });

    await creditNote.save({ session });
    // Refunded credit no longer reduces what the customer owes.
    await updateBranchCurrentBalance({
      customerId: creditNote.customerId,
      branchId: creditNote.branchId,
      amount: refundAmount,
      session,
    });

    // Post the refund: Dr Accounts Receivable (customer) / Cr from account.
    const refund = creditNote.refunds[creditNote.refunds.length - 1];
    await ledgerService.postCreditNoteRefundJournal(
      {
        companyId,
        fromAccountId: refund.fromAccountId,
        amount: refund.refundAmount,
        partyId: creditNote.customerId,
        postingDate: refund.refundDate,
        sourceId: refund._id,
        narration: `Refund against ${creditNote.creditNoteId}`,
        addedBy: userId,
      },
      session,
    );

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: creditNote.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.CREDIT_NOTE_STATUS_CHANGED,
      entityId: creditNote._id,
      entityDisplayId: creditNote.creditNoteId,
      triggeredByUserId: userId,
      newStatus: creditNote.status,
    });

    return creditNote;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteCreditNoteRefund = async (creditNoteId, companyId, refundBody, userId) => {
  const { CreditNote } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { refundId } = refundBody;

    const creditNote = await CreditNote.findOne({
      _id: creditNoteId,
      companyId,
    }).session(session);

    if (!creditNote) {
      throw new ApiError(httpStatus.NOT_FOUND, CREDIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const currencyDoc = await getCurrency(companyId, creditNote.currency);
    // Find the refund to delete
    const refundIndex = creditNote.refunds.findIndex(refund => refund._id.toString() === refundId.toString());

    if (refundIndex === -1) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund not found');
    }

    const refund = creditNote.refunds[refundIndex];
    const refundAmount = refund.refundAmount;

    // Money returns to the from account and the refund journal is reversed.
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.CREDIT_NOTE, sourceId: refund._id },
      session,
    );

    // Remove refund from array
    creditNote.refunds.splice(refundIndex, 1);

    // Reverse the available balance (add back the refund amount)
    creditNote.availableBalance += refundAmount;

    // Update status
    if (creditNote.availableBalance === creditNote.total) {
      creditNote.status = CREDIT_NOTE_STATUS.OPEN;
    } else if (creditNote.availableBalance > 0 && creditNote.availableBalance < creditNote.total) {
      creditNote.status = CREDIT_NOTE_STATUS.PARTIALLY_USED;
    }

    // Update updatedBy
    creditNote.updatedBy = userId;
    creditNote.commentHistory.push({
      message: `Refund of ${currencyDoc?.symbol || '₹'}${refundAmount} removed`,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'CreditNote',
    });

    await creditNote.save({ session });
    await updateBranchCurrentBalance({
      customerId: creditNote.customerId,
      branchId: creditNote.branchId,
      amount: -refundAmount,
      session,
    });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    sendTransactionNotification({
      customerId: creditNote.customerId,
      companyId,
      notificationType: NOTIFICATION_TYPE.CREDIT_NOTE_STATUS_CHANGED,
      entityId: creditNote._id,
      entityDisplayId: creditNote.creditNoteId,
      triggeredByUserId: userId,
      newStatus: creditNote.status,
    });

    return enrichDocumentCurrency(companyId, creditNote.toJSON());
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
  createCreditNote: withTransientRetry(createCreditNote),
  queryCreditNotes,
  queryCreditNotesExports,
  getCreditNoteById,
  updateCreditNoteById,
  deleteCreditNoteById,
  applyCreditNote,
  deleteCreditNoteInvoice,
  updateCreditNoteStatus,
  createCreditNoteRefund,
  deleteCreditNoteRefund,
};
