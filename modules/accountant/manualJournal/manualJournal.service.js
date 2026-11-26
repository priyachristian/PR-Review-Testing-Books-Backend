const httpStatus = require('http-status');
const { getUpdatedByUserId, toUpdatedByUserIdString } = require('../../../utils/updatedBy.js');
const ApiError = require('../../../utils/ApiError');
const logger = require('../../../config/logger');
const { getClientConnection, getBooksModels, getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const mongoose = require('mongoose');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { MODULE_NAMES, ACCOUNT_CATEGORIES, LEDGER_PARTY_TYPES, LEDGER_SOURCE_MODULES } = require('../../../utils/enum');
const { handleFileUpdate, deleteFilesFromS3 } = require('../../commonModule/fileUpload/fileUploadS3.service');
const { buildBranchDivisionOrCondition } = require('../../../utils/queryBuilder');
const ledgerService = require('../ledger/ledger.service');
const { updateBranchCurrentBalance } = require('../../../services/customerValidation.service');

const syncManualJournalLedger = async (manualJournal, userId, session) => {
  await ledgerService.deleteJournal(
    { companyId: manualJournal.companyId, sourceModule: LEDGER_SOURCE_MODULES.MANUAL_JOURNAL, sourceId: manualJournal._id },
    session,
  );

  const { Account } = getBooksModels();
  const accountIds = [...new Set(manualJournal.journalEntries.map(entry => entry.accountId?.toString()).filter(Boolean))];
  const accounts = await Account.find({ _id: { $in: accountIds } })
    .select('category')
    .session(session)
    .lean();
  const accountById = new Map(accounts.map(account => [account._id.toString(), account]));

  const lines = manualJournal.journalEntries.map(entry => {
    const account = accountById.get(entry.accountId?.toString());
    const partyType = ACCOUNT_CATEGORIES[account?.category]?.partyType;
    const party = partyType && entry.businessAccountLedgerMasterId;
    return {
      accountId: entry.accountId,
      ...(entry.debits ? { debit: entry.debits } : { credit: entry.credits }),
      partyId: party ? entry.businessAccountLedgerMasterId : null,
      partyType: party ? partyType : null,
    };
  });

  await ledgerService.postJournal(
    {
      companyId: manualJournal.companyId,
      postingDate: manualJournal.date,
      sourceModule: LEDGER_SOURCE_MODULES.MANUAL_JOURNAL,
      sourceId: manualJournal._id,
      narration: `Manual Journal ${manualJournal.manualJournalId}`,
      lines,
      addedBy: userId,
    },
    session,
  );
};

/**
 * Apply (or reverse) the balance change for a single journal entry on an AR/AP account.
 *
 * Sign convention:
 *   AR (Receivables): DR increases customer balance, CR decreases it  →  debits − credits
 *   AP (Payables):    CR increases vendor  balance, DR decreases it   →  credits − debits
 *
 * When `reverse` is true the sign is flipped — used for UPDATE (undo old) and DELETE.
 * When `skipBalanceCheck` is true no overdraft guard is applied — used when undoing an old effect.
 *
 * The entity (`businessAccountLedgerMasterId`) may be a Customer record or an AccountLedger record;
 * only a Customer keeps a running balance here - an Account Ledger party's balance comes from the ledger.
 */
const applyEntryBalanceChange = async ({
  account,
  entry,
  branchId,
  companyId,
  session,
  Customer,
  reverse = false,
  skipBalanceCheck = false,
}) => {
  const { debits = 0, credits = 0, businessAccountLedgerMasterId } = entry;
  if (!businessAccountLedgerMasterId) return;

  const customer = await Customer.findById(businessAccountLedgerMasterId).session(session);

  if (customer) {
    const branch = customer.branch.find(b => b.branchId.toString() === branchId.toString());
    if (!branch) throw new ApiError(httpStatus.NOT_FOUND, 'Branch not found for this customer');
    if (!skipBalanceCheck && balanceChange < 0 && branch.currentBalance < Math.abs(balanceChange)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${customer.customerDisplayName} does not have enough balance`);
    }
    await updateBranchCurrentBalance({
      customerId: businessAccountLedgerMasterId,
      branchId,
      amount: balanceChange,
      session,
    });
  }
};

const createManualJournal = async (data, userId, uploadedFiles = []) => {
  const { ManualJournal, Account } = getBooksModels();
  const { Company } = getCommonModels();
  const { Division, Branch, Warehouse, Customer } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const { companyId, divisionId, branchId, warehouseId, journalEntries } = data;

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: [],
      existingUrls: [],
      userId,
      companyId: companyId,
    });

    data.manualJournalId = await generateUniqueId(
      ManualJournal,
      companyId,
      MODULE_NAMES.MANUAL_JOURNAL,
      'manualJournalId',
      'MJ',
      session,
      data.manualJournalId,
    );
    const company = await Company.findById(companyId).session(session);
    if (!company) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
    }
    const division = await Division.findOne({ _id: divisionId, companyId }).session(session);
    if (!division) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Division not found');
    }
    const branch = await Branch.findOne({ _id: branchId, divisionId }).session(session);
    if (!branch) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Branch not found');
    }
    if (warehouseId) {
      const warehouse = await Warehouse.findOne({ _id: warehouseId, branchId }).session(session);
      if (!warehouse) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Warehouse not found');
      }
    }

    let totalDebits = 0;
    let totalCredits = 0;

    for (const journalEntry of journalEntries) {
      const { accountId, businessAccountLedgerMasterId, debits = 0, credits = 0 } = journalEntry;
      const account = await Account.findOne({ _id: accountId }).session(session);
      if (!account) {
        throw new ApiError(httpStatus.NOT_FOUND, 'Account not found');
      }
      if (!account.isDefault && account?.companyId?.toString() !== companyId) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Account not found');
      }

      if (ACCOUNT_CATEGORIES[account?.category]?.partyType && !businessAccountLedgerMasterId) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          account.category === ACCOUNT_CATEGORIES.ACCOUNTS_PAYABLE.code
            ? 'Vendor must be chosen for an Accounts Payable account.'
            : 'Customer must be chosen for an Accounts Receivable account.',
        );
      }

      if (Boolean(account?.isSystemAccount && ACCOUNT_CATEGORIES[account?.category]?.partyType)) {
        await applyEntryBalanceChange({
          account,
          entry: journalEntry,
          branchId,
          companyId,
          session,
          Customer,
          skipBalanceCheck: true,
        });
      }

      if (debits) totalDebits += debits;
      if (credits) totalCredits += credits;
    }

    if (totalDebits !== totalCredits) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Total debits and total credits must be equal');
    }

    const latestManualJournalNo = await ManualJournal.findOne({ companyId }, { vchNo: 1 }).sort({ vchNo: -1 }).lean();

    const manualJournalData = {
      ...data,
      attachments: allAttachments,
      addedBy: userId,
      totalDebits,
      totalCredits,
      vchNo: (latestManualJournalNo?.vchNo ? parseInt(latestManualJournalNo?.vchNo) : 0) + 1,
    };
    const manualJournal = await ManualJournal.create([manualJournalData], { session });

    await syncManualJournalLedger(manualJournal[0], userId, session);

    await session.commitTransaction();
    return manualJournal[0];
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getManualJournals = async data => {
  const { ManualJournal } = getBooksModels();
  const { Division, Branch, Warehouse } = getBooksCrmModels();
  const { User } = getCommonModels();

  const { companyId, warehouseId } = data;

  const baseQuery = {
    companyId: new mongoose.Types.ObjectId(companyId),
  };
  const branchDivisionCond = buildBranchDivisionOrCondition(data, { dateField: 'date' });
  if (branchDivisionCond) {
    Object.assign(baseQuery, branchDivisionCond);
  }

  if (warehouseId) {
    baseQuery.warehouseId = new mongoose.Types.ObjectId(warehouseId);
  }

  const options = {
    select:
      'manualJournalId date totalDebits totalCredits reportingMethod currency notes journalEntries vchNo branchId divisionId warehouseId addedBy updatedBy',
    page: data.page,
    limit: data.limit,
  };

  const manualJournals = await ManualJournal.paginate(baseQuery, options);

  const branchIds = [...new Set(manualJournals.results.map(i => i.branchId))];
  const divisionIds = [...new Set(manualJournals.results.map(i => i.divisionId))];
  const warehouseIds = [...new Set(manualJournals.results.map(i => i.warehouseId))];
  const userIds = [...new Set(manualJournals.results.flatMap(i => [i.addedBy, i.updatedBy]).filter(Boolean))];

  const [division, branch, warehouse, userList] = await Promise.all([
    Division.find({ _id: divisionIds }).select('name _id').lean(),
    Branch.find({ _id: branchIds }).select('name _id').lean(),
    Warehouse.find({ _id: warehouseIds }).select('name _id').lean(),
    User.find({ _id: userIds }).select('firstName lastName _id').lean(),
  ]);

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
  const userMap = userList.reduce((acc, user) => {
    acc[user._id.toString()] = user;
    return acc;
  }, {});

  const populatedResults = manualJournals.results.map(manualJournal => {
    const obj = manualJournal.toObject();
    obj.branchId = branchMap[obj.branchId?.toString()] || null;
    obj.divisionId = divisionMap[obj.divisionId?.toString()] || null;
    obj.warehouseId = warehouseMap[obj.warehouseId?.toString()] || null;
    obj.addedBy = userMap[obj.addedBy?.toString()] || null;
    obj.updatedBy = userMap[toUpdatedByUserIdString(obj.updatedBy)] || null;
    obj.addedBy = obj.addedBy ? `${obj.addedBy.firstName} ${obj.addedBy.lastName}` : null;
    obj.updatedBy = obj.updatedBy ? `${obj.updatedBy.firstName} ${obj.updatedBy.lastName}` : null;
    return obj;
  });

  return {
    ...manualJournals,
    results: populatedResults,
  };
};

const getManualJournal = async (manualJournalId, data) => {
  const { ManualJournal, Account, AccountLedger } = getBooksModels();
  const { Division, Branch, Warehouse, Customer } = getBooksCrmModels();
  const { User } = getCommonModels();
  const manualJournal = await ManualJournal.findOne({ _id: manualJournalId, companyId: data.companyId });
  if (!manualJournal) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Manual Journal not found');
  }
  const branch = await Branch.findById(manualJournal.branchId);
  if (!branch) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Branch not found');
  }
  const division = await Division.findById(manualJournal.divisionId);
  if (!division) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Division not found');
  }
  const warehouse = manualJournal.warehouseId ? await Warehouse.findById(manualJournal.warehouseId) : null;
  const addedBy = manualJournal.addedBy ? await User.findById(manualJournal.addedBy) : null;

  const accountIds = [...new Set(manualJournal.journalEntries.map(i => i.accountId))];
  const account = await Account.find({ _id: { $in: accountIds } });
  const accountMap = account.reduce((acc, c) => {
    acc[c._id.toString()] = c;
    return acc;
  }, {});

  const partyIds = [
    ...new Set(manualJournal.journalEntries.map(i => i.businessAccountLedgerMasterId?.toString()).filter(Boolean)),
  ];

  const [customers, accountLedgers] = await Promise.all([
    Customer.find({ _id: { $in: partyIds }, companyId: data.companyId }).lean(),
    AccountLedger.find({ _id: { $in: partyIds }, companyId: data.companyId })
      .select('personName businessAccountLedgerMasterId')
      .lean(),
  ]);

  const partyMap = {};
  accountLedgers.forEach(entry => {
    partyMap[entry._id.toString()] = { ...entry, customerDisplayName: entry.personName };
  });
  customers.forEach(entry => {
    partyMap[entry._id.toString()] = entry;
  });

  const populatedJournalEntries = manualJournal.journalEntries.map(journalEntry => {
    const obj = journalEntry.toObject();
    const accountDoc = accountMap[obj.accountId?.toString()];

    const linkedEntity = partyMap[obj.businessAccountLedgerMasterId?.toString()] || null;

    obj.businessAccountLedgerMaster = linkedEntity;
    obj.account = accountDoc || null;
    obj.accountId = obj.account?._id?.toString() || null;
    obj.businessAccountLedgerMasterId = obj.businessAccountLedgerMaster?._id?.toString() || null;

    return obj;
  });

  const populatedManualJournal = manualJournal.toObject();
  populatedManualJournal.branchId = branch;
  populatedManualJournal.divisionId = division;
  populatedManualJournal.warehouseId = warehouse;
  populatedManualJournal.addedBy = addedBy;
  populatedManualJournal.journalEntries = populatedJournalEntries;
  return populatedManualJournal;
};

const updateManualJournal = async (manualJournalId, data, userId, uploadedFiles = []) => {
  const { ManualJournal, Account } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const manualJournal = await ManualJournal.findOne({ _id: manualJournalId, companyId: data.companyId }).session(session);

    if (!manualJournal) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Manual Journal not found');
    }

    const allAttachments = await handleFileUpdate({
      newFiles: uploadedFiles ? uploadedFiles : [],
      currentUrls: data.attachments ? data.attachments : [],
      existingUrls: manualJournal.attachments ? manualJournal.attachments : [],
      userId,
      companyId: manualJournal.companyId,
    });

    // Balances move when the lines change, and also when the branch changes: the party
    // balance lives per branch, so the old branch gives the effect back and the new one
    // takes it. A metadata-only update (notes, date) touches neither.
    const entriesProvided = data.journalEntries && data.journalEntries.length > 0;
    const branchChanged = data.branchId && data.branchId.toString() !== manualJournal.branchId.toString();
    const journalEntries = entriesProvided ? data.journalEntries : branchChanged ? manualJournal.journalEntries : null;
    let totalDebits = manualJournal.totalDebits;
    let totalCredits = manualJournal.totalCredits;

    if (journalEntries && journalEntries.length > 0) {
      // Step 1: Reverse ALL old balance effects (handles removed entries, account type
      // changes, and duplicate-entity entries correctly — each old entry is undone in full).
      const oldAccountIds = [...new Set(manualJournal.journalEntries.map(e => e.accountId?.toString()).filter(Boolean))];
      const oldAccountDocs = await Account.find({ _id: { $in: oldAccountIds } }).session(session);
      const oldAccountMap = new Map(oldAccountDocs.map(a => [a._id.toString(), a]));

      for (const oldEntry of manualJournal.journalEntries) {
        const account = oldAccountMap.get(oldEntry.accountId?.toString());
        if (Boolean(account?.isSystemAccount && ACCOUNT_CATEGORIES[account?.category]?.partyType)) {
          await applyEntryBalanceChange({
            account,
            entry: oldEntry,
            branchId: manualJournal.branchId,
            companyId: manualJournal.companyId,
            session,
            Customer,
            reverse: true,
            skipBalanceCheck: true,
          });
        }
      }

      // Step 2: Apply ALL new balance effects with balance validation.
      let newTotalDebits = 0;
      let newTotalCredits = 0;

      for (const journalEntry of journalEntries) {
        const { accountId, businessAccountLedgerMasterId, debits = 0, credits = 0 } = journalEntry;
        const account = await Account.findOne({ _id: accountId }).session(session);
        if (!account) {
          throw new ApiError(httpStatus.NOT_FOUND, 'Account not found');
        }
        if (!account.isDefault && account?.companyId?.toString() !== manualJournal?.companyId?.toString()) {
          throw new ApiError(httpStatus.BAD_REQUEST, 'Account not found');
        }

        if (ACCOUNT_CATEGORIES[account?.category]?.partyType && !businessAccountLedgerMasterId) {
          throw new ApiError(
            httpStatus.BAD_REQUEST,
            account.category === ACCOUNT_CATEGORIES.ACCOUNTS_PAYABLE.code
              ? 'Vendor must be chosen for an Accounts Payable account.'
              : 'Customer must be chosen for an Accounts Receivable account.',
          );
        }

        if (Boolean(account?.isSystemAccount && ACCOUNT_CATEGORIES[account?.category]?.partyType)) {
          await applyEntryBalanceChange({
            account,
            entry: journalEntry,
            branchId: data.branchId || manualJournal.branchId,
            companyId: manualJournal.companyId,
            session,
            Customer,
            skipBalanceCheck: true,
          });
        }

        if (debits) newTotalDebits += debits;
        if (credits) newTotalCredits += credits;
      }

      if (newTotalDebits !== newTotalCredits) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Total debits and total credits must be equal');
      }

      totalDebits = newTotalDebits;
      totalCredits = newTotalCredits;
    }

    // removing the companyId and manualJournalId from the data to prevent updating for journal
    delete data.companyId;
    delete data.manualJournalId;

    Object.assign(manualJournal, {
      ...data,
      attachments: allAttachments,
    });
    manualJournal.totalDebits = totalDebits;
    manualJournal.totalCredits = totalCredits;
    manualJournal.updatedBy = userId;
    await manualJournal.save({ session });

    await syncManualJournalLedger(manualJournal, userId, session);

    await session.commitTransaction();
    return manualJournal;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteManualJournal = async (manualJournalId, companyId) => {
  const { ManualJournal, Account } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();

    const manualJournal = await ManualJournal.findOne({ _id: manualJournalId, companyId }).session(session);
    if (!manualJournal) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Manual Journal not found');
    }

    // Reverse all balance effects before deleting the document.
    const accountIds = [...new Set(manualJournal.journalEntries.map(e => e.accountId?.toString()).filter(Boolean))];
    const accountDocs = await Account.find({ _id: { $in: accountIds } }).session(session);
    const accountMap = new Map(accountDocs.map(a => [a._id.toString(), a]));

    for (const entry of manualJournal.journalEntries) {
      const account = accountMap.get(entry.accountId?.toString());
      if (Boolean(account?.isSystemAccount && ACCOUNT_CATEGORIES[account?.category]?.partyType)) {
        await applyEntryBalanceChange({
          account,
          entry,
          branchId: manualJournal.branchId,
          companyId,
          session,
          Customer,
          reverse: true,
          skipBalanceCheck: true,
        });
      }
    }

    await ledgerService.deleteJournal(
      { companyId, sourceModule: LEDGER_SOURCE_MODULES.MANUAL_JOURNAL, sourceId: manualJournal._id },
      session,
    );

    await ManualJournal.findByIdAndDelete(manualJournalId, { session });
    await session.commitTransaction();

    if (manualJournal.attachments?.length) {
      try {
        await deleteFilesFromS3(manualJournal.attachments);
      } catch (error) {
        logger.error(`Failed to delete attachments for manual journal ${manualJournal._id}`, error);
      }
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

const getContactDropdown = async filter => {
  const { Customer } = getBooksCrmModels();
  const { AccountLedger } = getBooksModels();
  const companyId = new mongoose.Types.ObjectId(filter.companyId);

  const contactQuery = {
    companyId,
    $or: [{ 'Role.isCustomer': true }, { 'Role.isVendor': true }],
  };
  if (filter.branchId) {
    contactQuery['branch.branchId'] = new mongoose.Types.ObjectId(filter.branchId);
  }

  const [contacts, ledgers] = await Promise.all([
    Customer.find(contactQuery).select('customerDisplayName customerNumber personName Role').lean(),
    AccountLedger.find({ companyId, isActive: { $ne: false } })
      .select('personName businessAccountLedgerMasterId')
      .lean(),
  ]);

  const contactResults = contacts.map(contact => ({
    ...contact,
    id: contact._id,
    isLedger: false,
  }));

  const ledgerResults = ledgers.map(ledger => ({
    id: ledger._id,
    personName: ledger.personName,
    customerDisplayName: ledger.personName,
    customerNumber: ledger.businessAccountLedgerMasterId,
    isLedger: true,
  }));

  return { results: [...contactResults, ...ledgerResults] };
};

module.exports = {
  createManualJournal: withTransientRetry(createManualJournal),
  getManualJournals,
  getManualJournal,
  updateManualJournal,
  deleteManualJournal,
  getContactDropdown,
};
