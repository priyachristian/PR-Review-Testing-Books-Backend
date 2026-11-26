const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const { getBooksModels, getClientConnection, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { assertLineUnitsValid } = require('../../../services/documentItemEnricher.service');
const { preparePurchaseDocumentSave } = require('../../../services/purchaseDocumentGuard.service');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { getPurchaseAddressCondition, getPurchaseAddressResolver } = require('../../../utils/addressLocationFilter');
const { pairLinesWithExisting } = require('../../../utils/documentLineMatching');
const {
  DEBIT_NOTE_STATUS,
  E_WAY_BILL_STATUS,
  MODULE_NAMES,
  CREDIT_NOTE_TYPE,
  LEDGER_SOURCE_MODULES,
  LEDGER_PARTY_TYPES,
  PAYMENT_ACCOUNT_CATEGORIES,
  TRANSACTION_TYPE,
  OB_PAYMENT_ENTRY_SOURCE,
} = require('../../../utils/enum');
const ledgerService = require('../../accountant/ledger/ledger.service');
const { updateBillPaymentStatus } = require('../bill/bill.service');
const { generateUniqueId, generateMultipleUniqueIdsForModules } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { mongoose } = require('mongoose');
const { defaultBranchEntry } = require('../../../utils/defaultCustomerBranchEntry');
const { CREDIT_STATUS_CONFIG, validateStatusTransition, assertRevertAllowed } = require('../../../utils/inventoryConfig');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { updateBranchCurrentBalance } = require('../../../services/customerValidation.service');
const { moveAdvanceApplyBranchBalances } = require('../../../utils/paymentBranchBalance');
const {
  handleWarehouseStock,
  checkCompanyStockLevels,
  flushCompanyStockLevels,
} = require('../../../services/warehouseBatch.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const { DEBIT_NOTE_MESSAGES } = require('../../../utils/messages');
const { resolveTransactionCurrency, getCurrency, enrichDocumentCurrency } = require('../../../services/currencyResolver.service');
const { attachItemSummaries } = require('../../../services/documentItemSummary.service');
const { sendModuleCustomerNotifications, isFirstStatusChange } = require('../../../services/moduleEmailNotification.service');
const logger = require('../../../config/logger');

// A debit note only belongs in the ledger once it is issued; a draft or a cancelled note does
// not. Moving between two issued statuses (open -> partly used -> used/closed) changes nothing
// in the journal, so it is left alone rather than reversed and written again.
const syncDebitNoteJournal = async (companyId, debitNote, userId, session, oldStatus = null) => {
  const POSTED_DEBIT_NOTE_STATUSES = [
    DEBIT_NOTE_STATUS.DRAFT,
    DEBIT_NOTE_STATUS.OPEN,
    DEBIT_NOTE_STATUS.PARTIALLY_USED,
    DEBIT_NOTE_STATUS.USED,
    DEBIT_NOTE_STATUS.CLOSED,
  ];
  const isPostedStatus = status => POSTED_DEBIT_NOTE_STATUSES.includes(status);
  const wasPosted = oldStatus != null && isPostedStatus(oldStatus);
  const isPosted = isPostedStatus(debitNote.status);

  if (oldStatus != null && wasPosted && isPosted) {
    return;
  }

  await ledgerService.deleteJournal(
    { companyId, sourceModule: LEDGER_SOURCE_MODULES.DEBIT_NOTE, sourceId: debitNote._id },
    session,
  );
  if (isPosted) {
    await ledgerService.postDebitNoteJournal({ companyId, debitNote, addedBy: userId }, session);
  }
};

const createDebitNote = async (debitNoteBody, userId, uploadedFiles = []) => {
  const { DebitNote, Bill } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const { billId, branchId, vendorId, companyId, activateVendorBranch, activateItemWarehouse } = debitNoteBody;
    delete debitNoteBody.activateVendorBranch;
    delete debitNoteBody.activateItemWarehouse;

    // Lines returned against a bill are carried, so an item since made inactive in Item Master is still allowed.
    const sourceBill = billId
      ? await Bill.findOne({ _id: billId, companyId }).select('items.itemId').session(session).lean()
      : null;
    await preparePurchaseDocumentSave({
      vendorId,
      branchId,
      warehouseId: debitNoteBody.warehouseId,
      items: debitNoteBody.items,
      carriedItemIds: (sourceBill?.items || []).map(item => item.itemId),
      companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'debit note',
    });

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: companyId,
    });

    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(vendorId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(vendorId, branchId, session);
    }

    const company = await Company.findById(companyId).populate('baseCurrency').session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    await assertLineUnitsValid(debitNoteBody.items, { companyId, session });

    let shippingAddressId = null;
    if (!debitNoteBody?.customer) {
      if (debitNoteBody?.addressId === company?.address?._id?.toString()) {
        shippingAddressId = company?.address?._id;
      } else if (company?.additionalShippingAddresses?.some(address => address?._id?.toString() === debitNoteBody?.addressId)) {
        shippingAddressId = company?.additionalShippingAddresses?.find(
          address => address?._id?.toString() === debitNoteBody?.addressId,
        )?._id;
      }
    } else {
      const customerForAddress = await Customer.findById(debitNoteBody.customer);

      if (!customerForAddress) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Customer not found');
      }

      if (customerForAddress?.address?.shipping?._id?.toString() === debitNoteBody?.addressId?.toString()) {
        shippingAddressId = customerForAddress?.address?.shipping?._id;
      } else if (
        customerForAddress?.address?.additionalShippingAddresses?.some(
          address => address?._id?.toString() === debitNoteBody?.addressId?.toString(),
        )
      ) {
        shippingAddressId = customerForAddress?.address?.additionalShippingAddresses?.find(
          address => address?._id?.toString() === debitNoteBody?.addressId?.toString(),
        )?._id;
      }
    }

    if (!shippingAddressId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Shipping address not found');
    }

    let ids = '';
    let currency;
    let exchangeRate;
    let decimalPlaces;

    if (debitNoteBody?.isSplit) {
      ids = await generateMultipleUniqueIdsForModules(
        DebitNote,
        debitNoteBody.companyId,
        [
          {
            moduleName: MODULE_NAMES.SPLIT_DEBIT_NOTE,
            idField: 'debitNoteId',
            defaultPrefix: 'SDN',
            count: 1,
            resultKey: 'splitDebitNoteId',
            providedId: null,
          },
        ],
        session,
      );
    } else {
      debitNoteBody.debitNoteId = await generateUniqueId(
        DebitNote,
        debitNoteBody.companyId,
        MODULE_NAMES.DEBIT_NOTE,
        'debitNoteId',
        'VN',
        session,
        debitNoteBody.debitNoteId,
      );
    }

    if (billId) {
      const bill = await Bill.findById(billId).select('currency exchangeRate decimalPlaces').session(session);
      if (!bill) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
      }
      if (bill.currency) {
        currency = bill.currency;
        exchangeRate = bill.exchangeRate ?? 1;
        decimalPlaces = bill.decimalPlaces ?? null;
      }
    }

    if (!currency) {
      ({ currency, exchangeRate, decimalPlaces } = await resolveTransactionCurrency({
        companyId,
        vendorId,
      }));
    }
    const currencyDoc = await getCurrency(companyId, currency);

    const VCbody = {
      ...debitNoteBody,
      currency,
      exchangeRate: debitNoteBody.exchangeRate ?? 1,
      decimalPlaces,
      attachments: allAttachments,
      authorizedSignature: company?.authorizedSignature,
      shippingAddressId,
      availableBalance: debitNoteBody.total,
      addedBy: userId,
      isSplit: false,
      updatedBy: userId,
      commentHistory: [
        {
          message: `Debit Note created for ${currencyDoc?.symbol || '₹'}${debitNoteBody.total || 0}`,
          addedBy: userId,
          createdAt: new Date(),
          referenceType: 'DebitNote',
        },
      ],
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    };
    if (debitNoteBody?.isSplit) {
      VCbody.debitNoteId = ids.splitDebitNoteId;
      VCbody.isSplit = true;
    }
    const [debitnote] = await DebitNote.create([VCbody], { session });

    if (debitNoteBody?.type == CREDIT_NOTE_TYPE.GOODS_RETURN) {
      for (let i of debitNoteBody?.items) {
        const deductionSummary = await handleWarehouseStock({
          action: 'deductStock',
          stockData: {
            itemId: i.itemId,
            companyId,
            branchId: debitNoteBody.branchId,
            warehouseId: debitNoteBody.warehouseId,
            quantity: i.quantity,
            itemUnitId: i.itemUnitId,
            sellingPrice: i.rate,
            deductedSourceType: MODULE_NAMES.DEBIT_NOTE,
            deductedSourceId: debitnote._id,
          },
          session,
        });

        i.batches = deductionSummary?.map(d => ({
          batchNo: d.batchNo,
          quantity: d.quantity,
          purchasePrice: d.purchasePrice,
          warehouseId: d.warehouseId,
          itemBatchId: d.itemBatchId,
        }));
      }

      await checkCompanyStockLevels({
        itemIds: debitNoteBody.items.map(i => i.itemId),
        companyId,
        docType: MODULE_NAMES.DEBIT_NOTE,
        docId: debitnote._id,
        docNo: debitnote.debitNoteId,
        userId,
        session,
      });

      await DebitNote.updateOne({ _id: debitnote._id }, { $set: { items: debitNoteBody.items } }, { session });
      // The journal below reads the returned stock from these batches.
      debitnote.items = debitNoteBody.items;
    }

    await updateBranchCurrentBalance({
      customerId: vendorId,
      branchId,
      amount: -debitNoteBody.total,
      session,
    });

    await syncDebitNoteJournal(companyId, debitnote, userId, session);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, debitnote.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const queryDebitNotes = async (query, filter, options) => {
  try {
    const { Customer, Item, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();
    const { DebitNote } = getBooksModels();
    const { User, Company } = getCommonModels();
    const companyId = new mongoose.Types.ObjectId(filter.companyId);

    const conditions = { companyId };

    if (filter?.isSplit) {
      conditions.isSplit = true;
    } else {
      conditions.isSplit = { $ne: true };
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

    const branchDivisionCond = buildBranchDivisionOrCondition(filter, { dateField: 'debitNoteDate' });
    if (branchDivisionCond) {
      Object.assign(conditions, branchDivisionCond);
    }

    // Search filter
    if (query.search) {
      const searchRegex = createSearchRegex(query.search.trim());

      const vendors = await Customer.find(
        {
          companyId,
          $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
        },
        { _id: 1 },
      );

      const vendorIds = vendors.map(v => v._id);

      const orConditions = [{ reference: searchRegex }, { debitNoteId: searchRegex }];

      if (vendorIds.length) {
        orConditions.push({ vendorId: { $in: vendorIds } });
      }

      if (orConditions.length) {
        conditions.$or = orConditions;
      }
    }

    if (filter?.customerId) {
      const customerIds = filter.customerId
        .split(',')
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id));

      if (customerIds.length > 0) {
        conditions.vendorId = { $in: customerIds };
      }
    }

    if (filter.eWayBillGenerated === true || filter.eWayBillGenerated === 'true') {
      conditions['eWayBill.status'] = E_WAY_BILL_STATUS.ACT.value;
    }

    // addressType + Country/State/City filters: billTo -> vendor billing address; else addressId of the drop-ship customer's shipping addresses (when `customer` is set) or the company's addresses
    const addressCondition = await getPurchaseAddressCondition(Customer, Company, companyId, filter, 'vendorId');
    if (addressCondition) {
      (conditions.$and ||= []).push(addressCondition);
    }

    if (options?.countOnly) {
      return { results: [], totalResults: await DebitNote.countDocuments(conditions) };
    }

    // Step 1: Paginate with total
    const result = await DebitNote.paginateWithTotal(conditions, options);

    // Populate the line unit (itemUnitId -> ItemUnit name); ItemUnit lives in booksCrm, so pass the model explicitly
    await DebitNote.populate(result.results, { path: 'items.itemUnitId', select: 'name', model: ItemUnit });

    // Step 2: Extract unique vendor and item IDs
    const vendorIds = [...new Set(result.results.map(credit => credit.vendorId?.toString()).filter(Boolean))];
    const itemIds = [
      ...new Set(result.results.flatMap(credit => credit.items?.map(item => item.itemId?.toString()).filter(Boolean) || [])),
    ];
    const branchIds = [...new Set(result.results.map(i => i.branchId))];
    const warehouseIds = [...new Set(result.results.map(i => i.warehouseId))];
    const divisionIds = [...new Set(result.results.map(i => i.divisionId))];
    const addedByIds = [...new Set(result.results.map(i => i.addedBy))];
    const updatedByIds = [...new Set(result.results.map(i => toUpdatedByUserIdString(i.updatedBy)).filter(Boolean))];
    const userIds = [...new Set([...addedByIds, ...updatedByIds])];
    // Step 3: Bulk fetch vendors and items
    const [vendors, items, branch, warehouse, division, users] = await Promise.all([
      Customer.find({ _id: { $in: vendorIds } })
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
      await User.find({ _id: { $in: userIds } })
        .select('firstName lastName')
        .lean(),
    ]);

    // Step 4: Create lookup maps
    const vendorMap = vendors.reduce((acc, vendor) => {
      acc[vendor._id.toString()] = vendor;
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

    // Resolve addressId: drop-ship customer's addresses when `customer` has a value, else company address / additionalShippingAddresses
    const resolveAddress = await getPurchaseAddressResolver(Customer, Company, companyId, result.results);

    // Step 5: Populate results
    const populatedResults = result.results.map(credit => {
      const creditObj = credit.toObject();
      creditObj.addressIn = resolveAddress(creditObj);
      creditObj.vendorId = vendorMap[creditObj.vendorId?.toString()] || null;
      creditObj.branchId = branchMap[creditObj.branchId?.toString()] || null;
      creditObj.divisionId = divisionMap[creditObj.divisionId?.toString()] || null;
      creditObj.warehouseId = warehouseMap[creditObj.warehouseId?.toString()] || null;
      creditObj.items =
        creditObj.items?.map(item => ({
          ...item,
          itemId: itemMap[item.itemId?.toString()] || null,
        })) || [];
      creditObj.id = creditObj._id;
      creditObj.addedBy = userMap[creditObj.addedBy?.toString()] || null;
      const updatedById = toUpdatedByUserIdString(creditObj.updatedBy);
      creditObj.updatedBy = updatedById ? (userMap[updatedById] ?? null) : null;

      return creditObj;
    });

    // Return paginated + populated results along with totals
    return {
      ...result,
      results: await enrichDocumentCurrency(String(filter.companyId), await attachItemSummaries(populatedResults)),
    };
  } catch (error) {
    console.error('Error in queryDebitNotes:', error);
    throw error;
  }
};

const queryDebitNotesExports = async (query, filter, options) => {
  const result = await queryDebitNotes(query, filter, { ...options, pagination: false });
  return {
    results: result.results,
    totalResults: result.totalResults,
  };
};

const getDebitNoteById = async (id, companyId) => {
  const { DebitNote } = getBooksModels();
  const { Customer, Branch, Division, Warehouse, ItemUnit } = getBooksCrmModels();
  const { User, Company } = getCommonModels();
  // ItemUnit lives in booksCrm, so pass the model explicitly
  const data = await DebitNote.findOne({ _id: id, companyId }).populate({
    path: 'items.itemUnitId',
    select: 'name',
    model: ItemUnit,
  });
  if (!data) {
    throw new ApiError(httpStatus.NOT_FOUND, DEBIT_NOTE_MESSAGES.NOT_FOUND);
  }

  const vendor = await Customer.findById(data.vendorId)
    .select('customerNumber customerDisplayName customerPhoneNumber companyName address otherDetails isVendorDirectTax')
    .lean();

  const addedBy = await User.findById(data.addedBy).select('firstName lastName email phone');
  const updatedByUserId = getUpdatedByUserId(data.updatedBy);
  const updatedBy = updatedByUserId ? await User.findById(updatedByUserId).select('firstName lastName email phone') : null;
  const branch = await Branch.findOne(data.branchId).select('name');
  const division = await Division.findOne(data.divisionId).select('name');
  const warehouse = await Warehouse.findOne(data.warehouseId).select('name');

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
        addedBy: addedByUser || comment.addedBy,
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

  const vendorObj = data.toObject();
  vendorObj.commentHistory = commentHistoryWithUser;
  vendorObj.addedBy = addedBy;
  vendorObj.updatedBy = updatedBy;
  vendorObj.branchName = branch.name;
  vendorObj.divisionName = division.name;
  vendorObj.warehouseName = warehouse.name;

  if (customer) {
    vendorObj.customerDisplayName = customer?.customerDisplayName;
  }

  vendorObj.shippingAddress = shippingAddress || {};

  // Initialize refunds array if it doesn't exist
  if (!Array.isArray(vendorObj.refunds)) {
    vendorObj.refunds = [];
  }

  // Populate account names in refunds array
  if (vendorObj.refunds.length > 0) {
    const { Account } = getBooksModels();
    const refundAccountIds = [...new Set(vendorObj.refunds.map(refund => refund.toAccountId?.toString()).filter(Boolean))];

    if (refundAccountIds.length > 0) {
      const accounts = await Account.find({ _id: { $in: refundAccountIds } })
        .select('accountName')
        .lean();
      const accountMap = new Map(accounts.map(account => [account._id.toString(), account]));

      for (const refund of vendorObj.refunds) {
        refund.toAccountName = accountMap.get(refund.toAccountId?.toString())?.accountName || null;
      }
    }
  }

  vendorObj.vendorId = vendor || null;

  return enrichDocumentCurrency(companyId, vendorObj);
};

const updateDebitNote = async (id, updateBody, userId, uploadedFiles = []) => {
  const { DebitNote } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const debitNote = await DebitNote.findById(id).session(session);
    if (!debitNote) {
      throw new ApiError(httpStatus.NOT_FOUND, DEBIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: updateBody.attachments ? updateBody.attachments : [],
      existingUrls: debitNote.attachments ? debitNote.attachments : [],
      userId,
      companyId: debitNote.companyId,
    });

    if (debitNote?.status !== DEBIT_NOTE_STATUS.DRAFT) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Only draft debit note can be edited');
    }
    const oldtotal = debitNote.total;
    const originalItems = (debitNote.items || []).map(i => (i.toObject ? i.toObject() : { ...i }));
    const {
      vendorId,
      branchId,
      total,
      companyId,
      items: newItems = [],
      activateVendorBranch,
      activateItemWarehouse,
    } = updateBody;
    delete updateBody.activateVendorBranch;
    delete updateBody.activateItemWarehouse;

    // Lines already on the note are carried; only newly added lines must be active in Item Master.
    await preparePurchaseDocumentSave({
      vendorId: vendorId || debitNote.vendorId,
      branchId: branchId || debitNote.branchId,
      warehouseId: updateBody.warehouseId || debitNote.warehouseId,
      items: newItems,
      carriedItemIds: originalItems.map(item => item.itemId),
      companyId: debitNote.companyId,
      userId,
      session,
      activateVendorBranch,
      activateItemWarehouse,
      documentLabel: 'debit note',
    });

    const customer = await Customer.findOne({
      _id: new mongoose.Types.ObjectId(vendorId),
      'branch.branchId': branchId,
    }).session(session);

    if (customer == null || customer == undefined) {
      await defaultBranchEntry(vendorId, branchId, session);
    }

    const company = await Company.findById(companyId || debitNote.companyId)
      .populate('baseCurrency')
      .session(session);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    if (vendorId && String(vendorId) !== String(debitNote.vendorId)) {
      const { currency, decimalPlaces } = await resolveTransactionCurrency({
        companyId: debitNote.companyId,
        vendorId,
      });
      updateBody.currency = currency;
      updateBody.decimalPlaces = decimalPlaces;
    }
    updateBody.exchangeRate = updateBody.exchangeRate ?? 1;

    const currencyDoc = await getCurrency(debitNote.companyId, updateBody.currency || debitNote.currency);

    let shippingAddressId = null;
    if (!updateBody?.customer) {
      if (updateBody?.addressId === company?.address?._id?.toString()) {
        shippingAddressId = company?.address?._id;
      } else if (company?.additionalShippingAddresses?.some(address => address?._id?.toString() === updateBody?.addressId)) {
        shippingAddressId = company?.additionalShippingAddresses?.find(
          address => address?._id?.toString() === updateBody?.addressId,
        )?._id;
      }
      updateBody.customer = null;
    } else {
      const customerForAddress = await Customer.findById(updateBody.customer);

      if (!customerForAddress) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Customer not found');
      }

      if (customerForAddress?.address?.shipping?._id?.toString() === updateBody?.addressId?.toString()) {
        shippingAddressId = customerForAddress?.address?.shipping?._id;
      } else if (
        customerForAddress?.address?.additionalShippingAddresses?.some(
          address => address?._id?.toString() === updateBody?.addressId?.toString(),
        )
      ) {
        shippingAddressId = customerForAddress?.address?.additionalShippingAddresses?.find(
          address => address?._id?.toString() === updateBody?.addressId?.toString(),
        )?._id;
      }
    }

    if (!shippingAddressId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Shipping address not found');
    }

    // If total changes, ensure new total doesn't below already applied amount
    if (updateBody.total !== undefined) {
      const totalApplied = debitNote.billsApplied.reduce((sum, app) => sum + app.amountApplied, 0);

      if (updateBody.total < totalApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'New total cannot be less than the amount already applied to bills');
      }
      debitNote.availableBalance = updateBody.total - totalApplied;
      updateBody.availableBalance = updateBody.total - totalApplied;
    }

    debitNote.items = newItems.map(i => ({ ...i, batches: [] }));

    if (debitNote?.type != CREDIT_NOTE_TYPE.GOODS_RETURN && updateBody?.type == CREDIT_NOTE_TYPE.GOODS_RETURN) {
      for (const i of debitNote.items) {
        const deductionSummary = await handleWarehouseStock({
          action: 'deductStock',
          stockData: {
            itemId: i.itemId,
            companyId: debitNote.companyId,
            divisionId: debitNote.divisionId,
            branchId: updateBody.branchId,
            warehouseId: updateBody.warehouseId,
            quantity: i.quantity,
            itemUnitId: i.itemUnitId,
            sellingPrice: i.rate,
            deductedSourceType: MODULE_NAMES.DEBIT_NOTE,
            deductedSourceId: id,
          },
          session,
        });
        i.batches = deductionSummary?.map(d => ({
          batchNo: d.batchNo,
          quantity: d.quantity,
          purchasePrice: d.purchasePrice,
          warehouseId: d.warehouseId,
          itemBatchId: d.itemBatchId,
        }));
      }

      await checkCompanyStockLevels({
        itemIds: debitNote.items.map(i => i.itemId),
        companyId: debitNote.companyId,
        docType: MODULE_NAMES.DEBIT_NOTE,
        docId: id,
        docNo: debitNote.debitNoteId,
        userId,
        session,
      });
    }

    if (debitNote?.type == CREDIT_NOTE_TYPE.GOODS_RETURN && updateBody?.type != CREDIT_NOTE_TYPE.GOODS_RETURN) {
      for (const i of originalItems) {
        await handleWarehouseStock({
          action: 'reverseDeduction',
          stockData: {
            itemId: i.itemId,
            companyId: debitNote.companyId,
            divisionId: debitNote.divisionId,
            branchId: debitNote.branchId,
            warehouseId: debitNote.warehouseId,
            deductedSourceType: MODULE_NAMES.DEBIT_NOTE,
            deductedSourceId: id,
          },
          session,
        });
      }

      await checkCompanyStockLevels({
        itemIds: originalItems.map(i => i.itemId),
        companyId: debitNote.companyId,
        docType: MODULE_NAMES.DEBIT_NOTE,
        docId: id,
        docNo: debitNote.debitNoteId,
        userId,
        session,
      });

      debitNote.items = (newItems || []).map(i => ({ ...i, batches: [] }));
    }

    if (debitNote.type === CREDIT_NOTE_TYPE.GOODS_RETURN && updateBody.type === CREDIT_NOTE_TYPE.GOODS_RETURN) {
      // Lines are identified by item + unit + price: the same item can sit on several lines of the note.
      // Deductions are recorded per item for the whole note, so an item is handled as a group - left as it is
      // when all its lines are unchanged, otherwise reversed once and every line of it deducted again.
      const { matches } = pairLinesWithExisting(newItems, originalItems);
      const finalItems = new Array(newItems.length);
      const itemKeys = new Set([...originalItems, ...newItems].map(i => i.itemId.toString()));
      const touchedItemIds = [];

      for (const itemKey of itemKeys) {
        const oldLines = originalItems.filter(i => i.itemId.toString() === itemKey);
        const newIndexes = newItems.flatMap((item, index) => (item.itemId.toString() === itemKey ? [index] : []));

        const unchanged =
          oldLines.length === newIndexes.length &&
          newIndexes.every(index => {
            const oldItem = matches[index];
            return (
              oldItem &&
              Number(newItems[index].quantity) === Number(oldItem.quantity) &&
              Number(newItems[index].rate) === Number(oldItem.rate)
            );
          });

        if (unchanged) {
          newIndexes.forEach(index => {
            finalItems[index] = { ...newItems[index], batches: matches[index].batches || [] };
          });
          continue;
        }

        touchedItemIds.push(itemKey);

        if (oldLines.length) {
          await handleWarehouseStock({
            action: 'reverseDeduction',
            stockData: {
              itemId: oldLines[0].itemId,
              companyId: debitNote.companyId,
              divisionId: debitNote.divisionId,
              branchId: debitNote.branchId,
              warehouseId: debitNote.warehouseId,
              deductedSourceType: MODULE_NAMES.DEBIT_NOTE,
              deductedSourceId: id,
            },
            session,
          });
        }

        for (const index of newIndexes) {
          const newItem = newItems[index];
          const deductionSummary = await handleWarehouseStock({
            action: 'deductStock',
            stockData: {
              itemId: newItem.itemId,
              companyId: debitNote.companyId,
              divisionId: debitNote.divisionId,
              branchId: updateBody.branchId,
              warehouseId: updateBody.warehouseId,
              quantity: newItem.quantity,
              itemUnitId: newItem.itemUnitId,
              sellingPrice: newItem.rate,
              deductedSourceType: MODULE_NAMES.DEBIT_NOTE,
              deductedSourceId: id,
            },
            session,
          });

          finalItems[index] = {
            ...newItem,
            batches: deductionSummary?.map(d => ({
              batchNo: d.batchNo,
              quantity: d.quantity,
              purchasePrice: d.purchasePrice,
              warehouseId: d.warehouseId,
              itemBatchId: d.itemBatchId,
            })),
          };
        }
      }

      await checkCompanyStockLevels({
        itemIds: touchedItemIds,
        companyId: debitNote.companyId,
        docType: MODULE_NAMES.DEBIT_NOTE,
        docId: id,
        docNo: debitNote.debitNoteId,
        userId,
        session,
      });

      debitNote.items = finalItems;
    }

    //update customer current balance
    let newCurrentBalance = total;
    if (newCurrentBalance == oldtotal) {
      newCurrentBalance = 0;
    }
    if (newCurrentBalance !== oldtotal) {
      newCurrentBalance = total - oldtotal;
    }

    if (debitNote?.branchId.toString() !== updateBody?.branchId) {
      //reverse old effect

      await updateBranchCurrentBalance({
        customerId: vendorId,
        branchId: debitNote?.branchId,
        amount: debitNote?.total,
        session,
      });

      //add new branch effect

      await updateBranchCurrentBalance({
        customerId: vendorId,
        branchId,
        amount: -updateBody?.total,
        session,
      });
    } else {
      await updateBranchCurrentBalance({
        customerId: vendorId,
        branchId,
        amount: -newCurrentBalance,
        session,
      });
    }

    Object.assign(debitNote, {
      ...updateBody,
      items: debitNote.items,
      attachments: allAttachments,
      shippingAddressId,
      authorizedSignature: company?.authorizedSignature,
      companyGstin: company?.gstNumber,
      companyLogo: company?.companyLogo,
    });
    debitNote.updatedBy = userId;
    let updateMsg = 'Debit Note updated.';
    if (updateBody.total !== undefined && updateBody.total !== oldtotal) {
      updateMsg = `Debit Note updated. Amount changed from ${currencyDoc?.symbol || '₹'}${oldtotal} to ${currencyDoc?.symbol || '₹'}${updateBody.total}`;
    }
    debitNote.commentHistory.push({
      message: updateMsg,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'DebitNote',
    });
    await debitNote.save({ session });

    await syncDebitNoteJournal(debitNote.companyId, debitNote, userId, session);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return enrichDocumentCurrency(debitNote.companyId, debitNote.toJSON());
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteDebitNote = async (id, companyId) => {
  const { DebitNote, Bill } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const debitNote = await DebitNote.findOne({ _id: id, ...(companyId ? { companyId } : {}) }).session(session);
    if (!debitNote) {
      throw new ApiError(httpStatus.NOT_FOUND, DEBIT_NOTE_MESSAGES.NOT_FOUND);
    }
    const companyIdToUse = companyId || debitNote.companyId;
    const actorUserId = debitNote.addedBy;

    if ([DEBIT_NOTE_STATUS.USED, DEBIT_NOTE_STATUS.CLOSED, DEBIT_NOTE_STATUS.PARTIALLY_USED].includes(debitNote?.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `This debit note cannot be deleted in ${debitNote?.status} status`);
    }

    if (debitNote.refunds?.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, DEBIT_NOTE_MESSAGES.HAS_REFUNDS);
    }

    if (debitNote?.status != DEBIT_NOTE_STATUS.CANCELLED) {
      for (const appLine of debitNote?.billsApplied || []) {
        const { billId, amountApplied } = appLine;
        const bill = await Bill.findById(billId).session(session);
        bill.creditsApplied = bill.creditsApplied?.filter(credit => credit.debitNoteId.toString() !== debitNote._id.toString());

        await updateBillPaymentStatus(bill._id, -amountApplied, actorUserId, session);
        await moveAdvanceApplyBranchBalances({
          customerId: debitNote.vendorId,
          paymentBranchId: debitNote.branchId,
          documentBranchId: bill.branchId,
          amount: Math.abs(amountApplied),
          session,
          reverse: true,
        });
        if (appLine?._id) {
          await ledgerService.deleteJournal(
            { companyId: companyIdToUse, sourceModule: LEDGER_SOURCE_MODULES.BILL, sourceId: appLine._id },
            session,
          );
        }

        await bill.save({ session });
      }

      const { OpeningBalanceTransaction } = getBooksCrmModels();
      for (const appLine of debitNote?.openingBalanceTransactions || []) {
        const { openingBalanceTransactionId, amountApplied } = appLine;
        const txn = await OpeningBalanceTransaction.findById(openingBalanceTransactionId).session(session);
        if (!txn) continue;
        await moveAdvanceApplyBranchBalances({
          customerId: debitNote.vendorId,
          paymentBranchId: debitNote.branchId,
          documentBranchId: txn.branchId,
          amount: Math.abs(amountApplied),
          session,
          reverse: true,
        });
        if (appLine?._id) {
          await ledgerService.deleteJournal(
            { companyId: companyIdToUse, sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY, sourceId: appLine._id },
            session,
          );
        }
        await txn.updateRemainingAmount(-Math.abs(amountApplied), session);
        await OpeningBalanceTransaction.updateOne(
          { _id: txn._id, companyId: companyIdToUse },
          {
            $pull: {
              paymentMadeEntries: {
                paymentDocumentNo: debitNote.debitNoteId,
                amountApplied: Math.abs(amountApplied),
              },
            },
          },
          { session },
        );
      }

      await updateBranchCurrentBalance({
        customerId: debitNote.vendorId,
        branchId: debitNote.branchId,
        amount: debitNote.total,
        session,
      });

      if (debitNote?.type === CREDIT_NOTE_TYPE.GOODS_RETURN) {
        for (const i of debitNote?.items || []) {
          await handleWarehouseStock({
            action: 'reverseDeduction',
            stockData: {
              itemId: i.itemId,
              companyId: debitNote.companyId,
              branchId: debitNote.branchId,
              warehouseId: debitNote.warehouseId,
              deductedSourceType: MODULE_NAMES.DEBIT_NOTE,
              deductedSourceId: id,
            },
            session,
          });
        }

        await checkCompanyStockLevels({
          itemIds: (debitNote?.items || []).map(i => i.itemId),
          companyId: debitNote.companyId,
          docType: MODULE_NAMES.DEBIT_NOTE,
          docId: id,
          docNo: debitNote.debitNoteId,
          userId: debitNote.addedBy,
          session,
        });
      }
    }

    await ledgerService.deleteJournal(
      { companyId: debitNote.companyId, sourceModule: LEDGER_SOURCE_MODULES.DEBIT_NOTE, sourceId: debitNote._id },
      session,
    );

    await DebitNote.findByIdAndDelete(id, { session });

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

const applyDebitNote = async (debitNoteId, companyId, applications, userId) => {
  const { DebitNote, Bill } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const debitNote = await DebitNote.findOne({ _id: debitNoteId, companyId }).session(session);
    if (!debitNote) {
      throw new ApiError(httpStatus.NOT_FOUND, DEBIT_NOTE_MESSAGES.NOT_FOUND);
    }

    if ([DEBIT_NOTE_STATUS.DRAFT, DEBIT_NOTE_STATUS.USED, DEBIT_NOTE_STATUS.CLOSED].includes(debitNote?.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'You cannot apply a debit note in draft status');
    }
    if (debitNote.availableBalance <= 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No available balance on this debit note');
    }

    let totalApplied = 0;
    const billUpdates = [];
    const obUpdates = [];

    // Each target (bill / opening balance) may appear only once per request. The validate loop below
    // caches the fetched document, so two lines for the same target would each pass the stale per-line
    // guard and over-apply (driving balanceAmount negative and over-consuming the credit).
    const seenApplicationTargets = new Set();
    for (const app of applications) {
      const targetId = app.billId || app.openingBalanceTransactionId;
      if (targetId) {
        const targetKey = String(targetId);
        if (seenApplicationTargets.has(targetKey)) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            'The same bill or opening balance is listed more than once. Please remove the duplicate before applying the debit note.',
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
        if (String(txn.contactId) !== String(debitNote.vendorId)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Opening balance does not belong to this vendor');
        }
        if (txn.type !== TRANSACTION_TYPE.OPENING_PAYABLE) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Only opening payable can be applied with a debit note');
        }
        if (debitNote.currency && txn.currency && String(debitNote.currency) !== String(txn.currency)) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency debit application is not supported.');
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

      const bill = await Bill.findOne({ _id: app.billId, companyId }).session(session);
      if (!bill) {
        throw new ApiError(httpStatus.NOT_FOUND, `Bill ${app.billId} not found`);
      }
      if (debitNote.currency && bill.currency && String(debitNote.currency) !== String(bill.currency)) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Cross-currency debit application is not supported.');
      }
      if (bill.balanceAmount < amountApplied) {
        throw new ApiError(httpStatus.BAD_REQUEST, `Amount exceeds balance for bill ${bill?.billId}`);
      }

      totalApplied += amountApplied;
      billUpdates.push({ bill, amountApplied, billNo: app.billNo || bill.billId });
    }

    if (totalApplied > debitNote.availableBalance) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Total applied amount exceeds available balance');
    }

    const currencyDoc = await getCurrency(companyId, debitNote.currency);

    for (const { bill, amountApplied, billNo } of billUpdates) {
      const appliedDate = new Date();
      const applicationId = new mongoose.Types.ObjectId();
      bill.creditsApplied.push({
        debitNoteId: debitNote._id,
        debitNoteNo: debitNote.debitNoteId,
        amountApplied,
        appliedDate,
      });
      bill.commentHistory.push({
        message: `Debit Note ${debitNote.debitNoteId} applied for ${currencyDoc?.symbol || '₹'}${amountApplied}`,
        addedBy: userId,
        createdAt: new Date(),
        referenceType: 'DebitNote',
        referenceId: debitNote._id,
      });
      await moveAdvanceApplyBranchBalances({
        customerId: debitNote.vendorId,
        paymentBranchId: debitNote.branchId,
        documentBranchId: bill.branchId,
        amount: amountApplied,
        session,
      });
      await updateBillPaymentStatus(bill._id, amountApplied, userId, session);
      await bill.save({ session });
      debitNote.billsApplied.push({
        _id: applicationId,
        billId: bill._id,
        billNo,
        amountApplied,
        appliedDate,
      });
      await ledgerService.postCrossBranchCreditApplyJournal(
        {
          companyId,
          partyId: debitNote.vendorId,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          creditBranchId: debitNote.branchId,
          documentBranchId: bill.branchId,
          creditDivisionId: debitNote.divisionId,
          documentDivisionId: bill.divisionId,
          amount: amountApplied,
          postingDate: appliedDate,
          sourceModule: LEDGER_SOURCE_MODULES.BILL,
          sourceId: applicationId,
          narration: `Debit note ${debitNote.debitNoteId} applied to bill ${billNo}`,
          addedBy: userId,
          currencyId: debitNote.currency || bill.currency,
          exchangeRate: debitNote.exchangeRate || bill.exchangeRate,
        },
        session,
      );
    }

    debitNote.openingBalanceTransactions = debitNote.openingBalanceTransactions || [];
    for (const { txn, amountApplied, transactionNo } of obUpdates) {
      const appliedDate = new Date();
      const applicationId = new mongoose.Types.ObjectId();
      await moveAdvanceApplyBranchBalances({
        customerId: debitNote.vendorId,
        paymentBranchId: debitNote.branchId,
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
            paymentMadeEntries: {
              entrySource: OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT,
              paymentDocumentNo: debitNote.debitNoteId,
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
      debitNote.openingBalanceTransactions.push({
        _id: applicationId,
        openingBalanceTransactionId: txn._id,
        transactionNo,
        amountApplied,
        appliedDate,
      });
      await ledgerService.postCrossBranchCreditApplyJournal(
        {
          companyId,
          partyId: debitNote.vendorId,
          partyType: LEDGER_PARTY_TYPES.VENDOR,
          creditBranchId: debitNote.branchId,
          documentBranchId: txn.branchId,
          creditDivisionId: debitNote.divisionId,
          documentDivisionId: txn.divisionId,
          amount: amountApplied,
          postingDate: appliedDate,
          sourceModule: LEDGER_SOURCE_MODULES.OPENING_BALANCE_PARTY,
          sourceId: applicationId,
          narration: `Debit note ${debitNote.debitNoteId} applied to opening balance ${transactionNo || txn._id}`,
          addedBy: userId,
          currencyId: debitNote.currency || txn.currency,
          exchangeRate: debitNote.exchangeRate || txn.exchangeRate,
        },
        session,
      );
    }

    debitNote.availableBalance -= totalApplied;

    if (debitNote.availableBalance === 0) {
      debitNote.status = DEBIT_NOTE_STATUS.USED;
    }

    if (debitNote.availableBalance > 0) {
      debitNote.status = DEBIT_NOTE_STATUS.PARTIALLY_USED;
    }

    debitNote.commentHistory.push({
      message: `Debit Note applied for ${currencyDoc?.symbol || '₹'}${totalApplied}`,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'DebitNote',
    });

    await debitNote.save({ session });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    session.endSession();
    return enrichDocumentCurrency(companyId, debitNote.toJSON());
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const deleteDebitNoteBill = async (debitNoteId, companyId, body, userId) => {
  const { DebitNote, Bill } = getBooksModels();
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const { documentId, billId, openingBalanceTransactionId } = body;
    const debitNote = await DebitNote.findOne({ _id: debitNoteId, companyId }).session(session);
    if (!debitNote) {
      throw new ApiError(httpStatus.NOT_FOUND, DEBIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const currencyDoc = await getCurrency(companyId, debitNote.currency);
    let amountApplied = 0;
    let unremovedBills = debitNote?.billsApplied || [];
    let unremovedOb = debitNote?.openingBalanceTransactions || [];
    let removeMessage = '';

    if (openingBalanceTransactionId) {
      const obApplication = debitNote?.openingBalanceTransactions?.find(
        line =>
          String(line.openingBalanceTransactionId) === String(openingBalanceTransactionId) &&
          String(line._id) === String(documentId),
      );
      if (!obApplication) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Opening balance not found in debit note applications');
      }
      amountApplied = obApplication.amountApplied || 0;
      unremovedOb = (debitNote?.openingBalanceTransactions || []).filter(
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
        customerId: debitNote.vendorId,
        paymentBranchId: debitNote.branchId,
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
            paymentMadeEntries: {
              paymentDocumentNo: debitNote.debitNoteId,
              amountApplied,
            },
          },
        },
        { session },
      );
      removeMessage = `Opening balance application of ${currencyDoc?.symbol || '₹'}${amountApplied} removed from Debit Note`;
    } else {
      const bill = await Bill.findById(billId).session(session);
      if (!bill) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found');
      }

      const billApplication = debitNote?.billsApplied?.find(
        line => String(line.billId) === String(billId) && String(line._id) === String(documentId),
      );
      if (!billApplication) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Bill not found in debit note applications');
      }

      amountApplied = billApplication.amountApplied || 0;
      const appliedDate = billApplication.appliedDate;
      unremovedBills = debitNote?.billsApplied?.filter(
        line => !(String(line.billId) === String(billId) && String(line._id) === String(documentId)),
      );

      const matchingCredits =
        bill.creditsApplied?.filter(
          credit =>
            credit.debitNoteId.toString() === debitNote._id.toString() &&
            credit.amountApplied === amountApplied &&
            Math.abs(new Date(credit.appliedDate) - new Date(appliedDate)) < 1000,
        ) || [];

      if (matchingCredits.length > 1) {
        const firstMatchIndex = bill.creditsApplied.findIndex(
          credit =>
            credit.debitNoteId.toString() === debitNote._id.toString() &&
            credit.amountApplied === amountApplied &&
            Math.abs(new Date(credit.appliedDate) - new Date(appliedDate)) < 1000,
        );
        if (firstMatchIndex !== -1) {
          bill.creditsApplied.splice(firstMatchIndex, 1);
        }
      } else {
        bill.creditsApplied =
          bill.creditsApplied?.filter(
            credit =>
              !(
                credit.debitNoteId.toString() === debitNote._id.toString() &&
                credit.amountApplied === amountApplied &&
                Math.abs(new Date(credit.appliedDate) - new Date(appliedDate)) < 1000
              ),
          ) || [];
      }

      bill.commentHistory.push({
        message: `Debit Note ${debitNote.debitNoteId} application of ${currencyDoc?.symbol || '₹'}${amountApplied} removed`,
        addedBy: userId,
        createdAt: new Date(),
        referenceType: 'DebitNote',
        referenceId: debitNote._id,
      });

      await updateBillPaymentStatus(bill._id, -amountApplied, userId, session);
      await moveAdvanceApplyBranchBalances({
        customerId: debitNote.vendorId,
        paymentBranchId: debitNote.branchId,
        documentBranchId: bill.branchId,
        amount: amountApplied,
        session,
        reverse: true,
      });
      await ledgerService.deleteJournal({ companyId, sourceModule: LEDGER_SOURCE_MODULES.BILL, sourceId: documentId }, session);
      await bill.save({ session });
      removeMessage = `Bill application of ${currencyDoc?.symbol || '₹'}${amountApplied} removed from Debit Note`;
    }

    const totalAmountPaid =
      unremovedBills.reduce((sum, line) => sum + (line.amountApplied || 0), 0) +
      unremovedOb.reduce((sum, line) => sum + (line.amountApplied || 0), 0);
    const availableBalance = debitNote.total - totalAmountPaid;

    let status = '';
    if (availableBalance === 0) {
      status = DEBIT_NOTE_STATUS.USED;
    } else if (availableBalance === debitNote?.total) {
      status = DEBIT_NOTE_STATUS.OPEN;
    } else if (availableBalance > 0) {
      status = DEBIT_NOTE_STATUS.PARTIALLY_USED;
    }

    await DebitNote.updateOne(
      { _id: debitNoteId },
      {
        $set: {
          billsApplied: unremovedBills,
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
            referenceType: 'DebitNote',
          },
        },
      },
      { session },
    );

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

const updateDebitNoteNoteStatus = async (debitNoteId, companyId, newStatus, userId) => {
  const { DebitNote, Bill } = getBooksModels();

  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const debitNote = await DebitNote.findOne({ _id: debitNoteId, companyId }).session(session);

    if (!debitNote) {
      throw new ApiError(httpStatus.NOT_FOUND, DEBIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const oldStatus = debitNote.status;
    validateStatusTransition(CREDIT_STATUS_CONFIG.STATUS_TRANSITIONS, debitNote?.status, newStatus);

    const isUncancel = debitNote?.status === DEBIT_NOTE_STATUS.CANCELLED && newStatus !== DEBIT_NOTE_STATUS.CANCELLED;
    if (isUncancel) {
      assertRevertAllowed({ isUncancel, hasEffect: debitNote?.type === CREDIT_NOTE_TYPE.GOODS_RETURN });

      await updateBranchCurrentBalance({
        customerId: debitNote.vendorId,
        branchId: debitNote.branchId,
        amount: -debitNote.total,
        session,
      });
      debitNote.availableBalance = debitNote.total;
    }

    const isRevertFromClosed =
      debitNote?.status === DEBIT_NOTE_STATUS.CLOSED &&
      (newStatus === DEBIT_NOTE_STATUS.OPEN || newStatus === DEBIT_NOTE_STATUS.DRAFT);
    if (
      isRevertFromClosed &&
      (debitNote?.billsApplied?.length > 0 || debitNote?.openingBalanceTransactions?.length > 0 || debitNote?.refunds?.length > 0)
    ) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'Cannot revert this Debit Note because it has been applied to bills or has refunds recorded against it.',
      );
    }

    if (newStatus === DEBIT_NOTE_STATUS.CANCELLED && debitNote.refunds?.length > 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, DEBIT_NOTE_MESSAGES.HAS_REFUNDS);
    }

    if (debitNote?.status !== DEBIT_NOTE_STATUS.CANCELLED && newStatus == DEBIT_NOTE_STATUS.CANCELLED) {
      for (const appLine of debitNote?.billsApplied || []) {
        const { billId, amountApplied } = appLine;
        const bill = await Bill.findById(billId).session(session);
        bill.creditsApplied = bill.creditsApplied?.filter(credit => credit.debitNoteId.toString() !== debitNote._id.toString());

        await updateBillPaymentStatus(bill._id, -amountApplied, userId, session);
        await moveAdvanceApplyBranchBalances({
          customerId: debitNote.vendorId,
          paymentBranchId: debitNote.branchId,
          documentBranchId: bill.branchId,
          amount: Math.abs(amountApplied),
          session,
          reverse: true,
        });
        if (appLine?._id) {
          await ledgerService.deleteJournal(
            { companyId, sourceModule: LEDGER_SOURCE_MODULES.BILL, sourceId: appLine._id },
            session,
          );
        }

        await bill.save({ session });
      }

      const { OpeningBalanceTransaction } = getBooksCrmModels();
      for (const appLine of debitNote?.openingBalanceTransactions || []) {
        const { openingBalanceTransactionId, amountApplied } = appLine;
        const txn = await OpeningBalanceTransaction.findById(openingBalanceTransactionId).session(session);
        if (!txn) continue;
        await moveAdvanceApplyBranchBalances({
          customerId: debitNote.vendorId,
          paymentBranchId: debitNote.branchId,
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
              paymentMadeEntries: {
                paymentDocumentNo: debitNote.debitNoteId,
                amountApplied: Math.abs(amountApplied),
              },
            },
          },
          { session },
        );
      }
      debitNote.openingBalanceTransactions = [];
      debitNote.billsApplied = [];

      await updateBranchCurrentBalance({
        customerId: debitNote.vendorId,
        branchId: debitNote.branchId,
        amount: debitNote.total,
        session,
      });

      if (debitNote?.type === CREDIT_NOTE_TYPE.GOODS_RETURN) {
        for (const i of debitNote?.items || []) {
          await handleWarehouseStock({
            action: 'reverseDeduction',
            stockData: {
              itemId: i.itemId,
              companyId: debitNote.companyId,
              branchId: debitNote.branchId,
              warehouseId: debitNote.warehouseId,
              deductedSourceType: MODULE_NAMES.DEBIT_NOTE,
              deductedSourceId: debitNoteId,
            },
            session,
          });
        }

        await checkCompanyStockLevels({
          itemIds: (debitNote?.items || []).map(i => i.itemId),
          companyId: debitNote.companyId,
          docType: MODULE_NAMES.DEBIT_NOTE,
          docId: debitNoteId,
          docNo: debitNote.debitNoteId,
          userId,
          session,
        });
      }
    }
    debitNote.status = newStatus;
    if (newStatus === DEBIT_NOTE_STATUS.CANCELLED) {
      debitNote.availableBalance = 0;
    }
    debitNote.updatedBy = userId;
    debitNote.commentHistory.push({
      message: `Debit Note ${newStatus} successfully`,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'DebitNote',
    });
    await debitNote.save({ session });

    await syncDebitNoteJournal(companyId, debitNote, userId, session, oldStatus);

    await flushCompanyStockLevels(session);

    await session.commitTransaction();

    // Split debit notes are internal partial docs — only notify for the original document.
    if (isFirstStatusChange(oldStatus, newStatus, DEBIT_NOTE_STATUS.DRAFT) && !debitNote.isSplit) {
      const debitNoteForNotification = { ...(debitNote.toObject?.() || debitNote), status: newStatus };

      sendModuleCustomerNotifications({
        companyId,
        moduleName: MODULE_NAMES.DEBIT_NOTE,
        document: debitNoteForNotification,
      }).catch(err =>
        logger.error(`Failed to send debit note customer notifications for ${debitNote.debitNoteId}: ${err.message}`),
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

const createDebitNoteRefund = async (debitNoteId, companyId, refundBody, userId) => {
  const { DebitNote, Account } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { refundAmount, refundDate, toAccountId, reference, notes } = refundBody;

    const debitNote = await DebitNote.findOne({
      _id: debitNoteId,
      companyId,
    }).session(session);

    if (!debitNote) {
      throw new ApiError(httpStatus.NOT_FOUND, DEBIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const currencyDoc = await getCurrency(companyId, debitNote.currency);

    if (![DEBIT_NOTE_STATUS.OPEN, DEBIT_NOTE_STATUS.PARTIALLY_USED].includes(debitNote.status)) {
      throw new ApiError(httpStatus.BAD_REQUEST, DEBIT_NOTE_MESSAGES.REFUND_INVALID_STATUS);
    }

    if (refundAmount > debitNote.availableBalance) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Refund amount cannot exceed available balance');
    }

    const toAccount = await Account.findOne({
      _id: toAccountId,
      companyId,
      isActive: true,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
    }).session(session);
    if (!toAccount) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'To account not found or not a valid payment account');
    }

    debitNote.refunds.push({
      refundAmount,
      refundDate: new Date(refundDate),
      toAccountId,
      reference,
      notes,
      refundedBy: userId,
      refundedAt: new Date(),
    });

    // Update available balance
    debitNote.availableBalance -= refundAmount;

    // Update status if balance becomes 0
    if (debitNote.availableBalance === 0) {
      debitNote.status = DEBIT_NOTE_STATUS.USED;
    } else if (debitNote.availableBalance > 0 && debitNote.availableBalance < debitNote.total) {
      debitNote.status = DEBIT_NOTE_STATUS.PARTIALLY_USED;
    }

    // Update updatedBy
    debitNote.updatedBy = userId;
    debitNote.commentHistory.push({
      message: `Refund of ${currencyDoc?.symbol || '₹'}${refundAmount} recorded`,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'DebitNote',
    });

    await debitNote.save({ session });
    // The vendor returned the money, so the debit note no longer reduces what we owe.
    await updateBranchCurrentBalance({
      customerId: debitNote.vendorId,
      branchId: debitNote.branchId,
      amount: refundAmount,
      session,
    });

    // Post the refund: Dr to account / Cr Accounts Payable (vendor).
    const refund = debitNote.refunds[debitNote.refunds.length - 1];
    await ledgerService.postDebitNoteRefundJournal(
      {
        companyId,
        toAccountId: refund.toAccountId,
        amount: refund.refundAmount,
        partyId: debitNote.vendorId,
        postingDate: refund.refundDate,
        sourceId: refund._id,
        narration: `Refund against ${debitNote.debitNoteId}`,
        addedBy: userId,
      },
      session,
    );

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return debitNote;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteDebitNoteRefund = async (debitNoteId, companyId, refundBody, userId) => {
  const { DebitNote } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();

  try {
    await session.startTransaction();

    const { refundId } = refundBody;

    const debitNote = await DebitNote.findOne({
      _id: debitNoteId,
      companyId,
    }).session(session);

    if (!debitNote) {
      throw new ApiError(httpStatus.NOT_FOUND, DEBIT_NOTE_MESSAGES.NOT_FOUND);
    }

    const currencyDoc = await getCurrency(companyId, debitNote.currency);
    // Find the refund to delete
    const refundIndex = debitNote.refunds.findIndex(refund => refund._id.toString() === refundId.toString());

    if (refundIndex === -1) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Refund not found');
    }

    const refund = debitNote.refunds[refundIndex];
    const refundAmount = refund.refundAmount;

    // Money leaves the to account again and the refund journal is reversed.
    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.DEBIT_NOTE, sourceId: refund._id },
      session,
    );

    // Remove refund from array
    debitNote.refunds.splice(refundIndex, 1);

    // Reverse the available balance (add back the refund amount)
    debitNote.availableBalance += refundAmount;

    // Update status
    if (debitNote.availableBalance === debitNote.total) {
      debitNote.status = DEBIT_NOTE_STATUS.OPEN;
    } else if (debitNote.availableBalance > 0 && debitNote.availableBalance < debitNote.total) {
      debitNote.status = DEBIT_NOTE_STATUS.PARTIALLY_USED;
    }

    // Update updatedBy
    debitNote.updatedBy = userId;
    debitNote.commentHistory.push({
      message: `Refund of ${currencyDoc?.symbol || '₹'}${refundAmount} removed`,
      addedBy: userId,
      createdAt: new Date(),
      referenceType: 'DebitNote',
    });

    await debitNote.save({ session });
    await updateBranchCurrentBalance({
      customerId: debitNote.vendorId,
      branchId: debitNote.branchId,
      amount: -refundAmount,
      session,
    });

    await flushCompanyStockLevels(session);

    await session.commitTransaction();
    return enrichDocumentCurrency(companyId, debitNote.toJSON());
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
  createDebitNote: withTransientRetry(createDebitNote),
  queryDebitNotes,
  queryDebitNotesExports,
  getDebitNoteById,
  updateDebitNote,
  deleteDebitNote,
  applyDebitNote,
  deleteDebitNoteBill,
  updateDebitNoteNoteStatus,
  createDebitNoteRefund,
  deleteDebitNoteRefund,
};
