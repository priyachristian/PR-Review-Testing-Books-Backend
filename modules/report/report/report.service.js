const httpStatus = require('http-status');
const { getBooksCrmModels, getBooksModels, getClientConnection, getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const {
  BILL_STATUSES,
  PAYMENT_STATUS,
  SALES_ORDER_INVOICE_STATUS,
  DEBIT_NOTE_STATUS,
  CREDIT_NOTE_STATUS,
  CREDIT_NOTE_TYPE,
  INVOICE_STATUS,
  MODULE_NAMES,
  QUOTE_STATUS,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  PO_STATUSES,
  GRPO_STATUSES,
  PRODUCTION_ORDER_STATUS,
  INVENTORY_TRANSFER_REQUEST,
  PAYMENT_ACCOUNT_CATEGORIES,
  LEDGER_PARTY_TYPES,
} = require('../../../utils/enum');
const { getInventoryConfig } = require('../../../utils/inventoryConfig');
const { getAccountsByCompany } = require('../../accountant/chartOfAccount/account.service');
const { resolveFinancialYearRange } = require('../../../utils/queryBuilder');
const mongoose = require('mongoose');
const {
  ACCOUNT_BILL_STATUSES,
  BALANCE_TYPES,
  REPORT_SECTIONS,
  sectionOfCategory,
  REPORT_CATEGORIES_BY_SECTION,
  BALANCE_SHEET_SECTIONS,
  BALANCE_SHEET_SECTION_NATURE,
} = require('@smit9313/abss-models-core/src/utils/enum');
const { getCompanyProfile } = require('../../../services/onboard.service');
const ledgerService = require('../../accountant/ledger/ledger.service');
const bankService = require('../../banking/bank/bank.service');

// Function to determine balance type (CR, DR, or Zero)
const getBalanceType = (credits, debits) => {
  const balance = credits - debits;
  if (balance === 0) return 'Zero';
  return balance > 0 ? 'CR' : 'DR';
};

const getLedgerReport = async query => {
  const { PaymentReceived, Customer } = getBooksCrmModels();
  const { Bill, PaymentMade, Invoice, DebitNote, CreditNote, ManualJournal, Account, Expenses } = getBooksModels();
  const { CompanySettings, Company, Currency } = getCommonModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const {
      customerId: mainCustomerId,
      startDate,
      endDate,
      companyId,
      branchId,
      warehouseId,
      divisionId,
      includeLinkedData,
      splitOnly,
    } = query;
    const isSplitSession = query?.isSplit === true || query?.isSplit === 'true';
    const isSplitOnly = splitOnly === true || splitOnly === 'true';
    const applyLedgerSplitFilter = targetQuery => {
      if (isSplitOnly) {
        targetQuery.isSplit = true;
      } else if (!isSplitSession) {
        targetQuery.isSplit = false;
      }
      return targetQuery;
    };
    const shouldIncludeBranchOb = b => {
      if (isSplitOnly) return b.isSplitBalance === true;
      if (isSplitSession) return true;
      return !b.isSplitBalance;
    };
    const mainCustomer = await Customer.findById(mainCustomerId)
      .select(
        'Role vendorId customerId branch companyId customerDisplayName companyName address paymentTermsId useBranchCreditLimit creditLimit useBranchPaymentTerms',
      )
      .populate('branch.branchId', 'name paymentTermsId')
      .populate('branch.paymentTermsId')
      .populate('paymentTermsId')
      .session(session)
      .lean();
    if (!mainCustomer) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Customer/Vendor not found');
    }

    let isCustomer = mainCustomer.Role.isCustomer;
    let isVendor = mainCustomer.Role.isVendor;
    let customerId = mainCustomerId;
    let vendorId = mainCustomerId;

    if (!isCustomer && !isVendor) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Entity is neither a customer nor a vendor');
    }

    const includeLinked = includeLinkedData === 'true' || includeLinkedData === true;

    // Handle linked entities
    if (isCustomer && includeLinked && mainCustomer.vendorId) {
      isVendor = true;
      vendorId = mainCustomer.vendorId;
    }
    if (isVendor && includeLinked && mainCustomer.customerId) {
      isCustomer = true;
      customerId = mainCustomer.customerId;
    }

    const allIds = [mainCustomerId, customerId, vendorId].filter(Boolean);
    const entityIds = [...new Set(allIds.map(id => id.toString()))].map(id => new mongoose.Types.ObjectId(id));
    const allEntities = await Customer.find({ _id: { $in: entityIds } })
      .select('branch otherDetails.currency')
      .session(session);

    const [obCompany, obCurrencies] = await Promise.all([
      Company.findById(companyId).select('baseCurrency').lean(),
      Currency.find({ companyId }).select('exchangeRate').lean(),
    ]);
    const obRateMap = new Map(
      obCurrencies.map(cur => [
        String(cur._id),
        String(cur._id) === String(obCompany?.baseCurrency) ? 1 : (cur.exchangeRate ?? 1),
      ]),
    );

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    let totalPreCredits = 0;
    let totalPreDebits = 0;

    const buildOptionalQuery = baseQuery => {
      const query = { ...baseQuery };

      if (branchId !== null && branchId !== undefined) {
        const branchArray = branchId.split(',').filter(Boolean);
        if (branchArray.length > 0) {
          query.branchId = { $in: branchArray };
        }
      }

      if (divisionId !== null && divisionId !== undefined) {
        const divisionArray = divisionId.split(',').filter(Boolean);
        if (divisionArray.length > 0) {
          query.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)) };
        }
      }
      return query;
    };

    let branchOpeningBalance = 0,
      customerOpeningBalance = 0;

    let branchSet = branchId
      ? new Set(
          branchId
            .split(',')
            .filter(Boolean)
            .map(id => {
              try {
                return new mongoose.Types.ObjectId(id.trim()).toString();
              } catch {
                return id.trim();
              }
            }),
        )
      : null;

    if (isSplitOnly) {
      const companySettings = await CompanySettings.findOne({
        companyId,
      })
        .select('branchConfig')
        .session(session)
        .lean();
      if (companySettings?.branchConfig?.branchId) {
        branchSet = new Set([companySettings.branchConfig.branchId.toString()]);
      }
    }
    const calcBranchBal = (branches, obRate) => {
      if (!branches?.length) return 0;
      let sum = 0;
      if (!branchSet) {
        for (let i = 0; i < branches.length; i++) {
          const b = branches[i];
          if (shouldIncludeBranchOb(b)) {
            sum += (b.openingBalance || 0) * obRate;
          }
        }
      } else {
        for (let i = 0; i < branches.length; i++) {
          const b = branches[i];
          if (b.branchId && branchSet.has(b.branchId.toString())) {
            if (shouldIncludeBranchOb(b)) {
              sum += (b.openingBalance || 0) * obRate;
            }
          }
        }
      }
      return sum;
    };
    if (isCustomer && isVendor) {
      let vendorOpeningBalance = 0;

      const mainIdStr = mainCustomerId.toString();
      const linkedCustIdStr = customerId?.toString();
      const linkedVendIdStr = vendorId?.toString();
      const isMainCustomer = mainCustomer.Role.isCustomer;
      const isMainVendor = mainCustomer.Role.isVendor;

      const custIds = new Set();
      if (isMainCustomer) custIds.add(mainIdStr);
      if (linkedCustIdStr && linkedCustIdStr !== mainIdStr) custIds.add(linkedCustIdStr);

      const vendIds = new Set();
      if (isMainVendor) vendIds.add(mainIdStr);
      if (linkedVendIdStr && linkedVendIdStr !== mainIdStr) vendIds.add(linkedVendIdStr);

      for (const e of allEntities) {
        if (!e.branch?.length) continue;
        const id = e._id.toString();
        const isInCustSet = custIds.has(id);
        const isInVendSet = vendIds.has(id);
        if (!isInCustSet && !isInVendSet) continue;

        const obRate = obRateMap.get(String(e.otherDetails?.currency)) ?? 1;
        const bal = calcBranchBal(e.branch, obRate);
        if (bal === 0) continue;

        if (isInCustSet) customerOpeningBalance += bal;
        if (isInVendSet) vendorOpeningBalance += bal;
      }
      branchOpeningBalance = customerOpeningBalance - vendorOpeningBalance;
    } else {
      for (const e of allEntities) {
        if (e.branch?.length) {
          const obRate = obRateMap.get(String(e.otherDetails?.currency)) ?? 1;
          branchOpeningBalance += calcBranchBal(e.branch, obRate);
        }
      }
    }

    if (startDate) {
      const beforeDateFilter = { $lt: new Date(startDate) };

      if (isVendor) {
        const baseBillQuery = {
          vendor: vendorId,
          status: { $nin: [BILL_STATUSES.CANCELLED] },
          billDate: beforeDateFilter,
          companyId: companyId,
        };

        applyLedgerSplitFilter(baseBillQuery);
        const billsBeforeQuery = buildOptionalQuery(baseBillQuery);
        const billsBefore = await Bill.find(billsBeforeQuery).session(session);

        // Fetch payments made before startDate
        const basePaymentsMadeQuery = {
          vendorId: vendorId,
          status: PAYMENT_STATUS.APPROVED,
          paymentDate: beforeDateFilter,
          companyId: companyId,
        };

        applyLedgerSplitFilter(basePaymentsMadeQuery);

        const paymentsMadeBeforeQuery = buildOptionalQuery(basePaymentsMadeQuery);
        const paymentsMadeBefore = await PaymentMade.find(paymentsMadeBeforeQuery).session(session);

        // Fetch debit notes before startDate
        const baseDebitNotesQuery = {
          vendorId: vendorId,
          status: {
            $nin: [DEBIT_NOTE_STATUS.CANCELLED],
          },
          debitNoteDate: beforeDateFilter,
          companyId: companyId,
        };
        applyLedgerSplitFilter(baseDebitNotesQuery);
        const debitNotesBeforeQuery = buildOptionalQuery(baseDebitNotesQuery);
        const debitNotesBefore = await DebitNote.find(debitNotesBeforeQuery).session(session);

        // Billable expenses are never split documents.
        const expensesBefore = splitOnly
          ? []
          : await Expenses.find(
              buildOptionalQuery({
                companyId,
                party: vendorId,
                partyType: LEDGER_PARTY_TYPES.VENDOR,
                isBillable: true,
                date: beforeDateFilter,
              }),
            ).session(session);

        // Calculate vendor-side credits and debits
        totalPreCredits += billsBefore.reduce((sum, bill) => sum + bill.total * (bill.exchangeRate ?? 1), 0);
        totalPreDebits += paymentsMadeBefore.reduce(
          (sum, payment) => sum + (payment.paymentMade || 0) * (payment.exchangeRate ?? 1),
          0,
        );
        totalPreDebits += debitNotesBefore.reduce((sum, credit) => sum + credit.total * (credit.exchangeRate ?? 1), 0);
        totalPreCredits += expensesBefore.reduce((sum, expense) => sum + expense.total * (expense.exchangeRate ?? 1), 0);
      }

      if (isCustomer) {
        // Fetch invoices before startDate
        const baseInvoicesQuery = {
          customerId: customerId,
          status: {
            $nin: [SALES_ORDER_INVOICE_STATUS.CANCELLED],
          },
          invoiceDate: beforeDateFilter,
          companyId: companyId,
        };

        applyLedgerSplitFilter(baseInvoicesQuery);
        const invoicesBeforeQuery = buildOptionalQuery(baseInvoicesQuery);
        const invoicesBefore = await Invoice.find(invoicesBeforeQuery).session(session);

        // Fetch payments received before startDate
        const basePaymentsReceivedQuery = {
          customerId: customerId,
          status: PAYMENT_STATUS.APPROVED,
          paymentDate: beforeDateFilter,
          companyId: companyId,
        };

        applyLedgerSplitFilter(basePaymentsReceivedQuery);

        const paymentsReceivedBeforeQuery = buildOptionalQuery(basePaymentsReceivedQuery);
        const paymentsReceivedBefore = await PaymentReceived.find(paymentsReceivedBeforeQuery).session(session);

        // Fetch credit notes before startDate
        const baseCreditNotesQuery = {
          customerId: customerId,
          status: {
            $nin: [CREDIT_NOTE_STATUS.CANCELLED],
          },
          creditNoteDate: beforeDateFilter,
          companyId: companyId,
        };
        applyLedgerSplitFilter(baseCreditNotesQuery);
        const creditNotesBeforeQuery = buildOptionalQuery(baseCreditNotesQuery);
        const creditNotesBefore = await CreditNote.find(creditNotesBeforeQuery).session(session);

        const expensesBefore = splitOnly
          ? []
          : await Expenses.find(
              buildOptionalQuery({
                companyId,
                party: customerId,
                partyType: LEDGER_PARTY_TYPES.CUSTOMER,
                isBillable: true,
                date: beforeDateFilter,
              }),
            ).session(session);

        // Calculate customer-side credits and debits
        totalPreDebits += invoicesBefore.reduce(
          (sum, invoice) => sum + (Number(invoice.total) || 0) * (invoice.exchangeRate ?? 1),
          0,
        );
        totalPreCredits += paymentsReceivedBefore.reduce((sum, payment) => {
          return sum + (Number(payment.amountReceived) || 0) * (payment.exchangeRate ?? 1);
        }, 0);
        totalPreCredits += creditNotesBefore.reduce(
          (sum, credit) => sum + (Number(credit.total) || 0) * (credit.exchangeRate ?? 1),
          0,
        );
        totalPreDebits += expensesBefore.reduce((sum, expense) => sum + expense.total * (expense.exchangeRate ?? 1), 0);
      }

      if (!isSplitOnly) {
        const manualJournalBeforeQuery = buildOptionalQuery({
          companyId,
          'journalEntries.businessAccountLedgerMasterId':
            entityIds.length > 1 ? { $in: entityIds } : entityIds.length === 1 ? entityIds[0] : mainCustomerId,
          date: beforeDateFilter,
        });
        const manualJournalsBefore = await ManualJournal.find(manualJournalBeforeQuery).session(session);

        manualJournalsBefore.forEach(journal => {
          const rate = journal.exchangeRate ?? 1;
          journal.journalEntries.forEach(entry => {
            if (!entityIds.some(id => entry.businessAccountLedgerMasterId?.toString() === id.toString())) return;
            totalPreDebits += (entry.debits || 0) * rate;
            totalPreCredits += (entry.credits || 0) * rate;
          });
        });
      }
    }

    let normalizedOpeningBalance;
    if (isCustomer) {
      normalizedOpeningBalance = totalPreDebits - totalPreCredits + branchOpeningBalance;
    } else {
      normalizedOpeningBalance = totalPreCredits - totalPreDebits + branchOpeningBalance;
    }

    const openingBalance = Math.abs(normalizedOpeningBalance);
    const openingBalanceType = isCustomer
      ? normalizedOpeningBalance >= 0
        ? 'DR'
        : 'CR'
      : normalizedOpeningBalance >= 0
        ? 'CR'
        : 'DR';

    const transactions = [];
    let totalDebits = 0;
    let totalCredits = 0;

    // Add opening balance to totals
    if (openingBalanceType === 'DR') {
      totalDebits += openingBalance;
    } else if (openingBalanceType === 'CR') {
      totalCredits += openingBalance;
    }

    if (isVendor) {
      try {
        // Fetch bills
        const baseBillsQuery = {
          vendor: vendorId,
          status: { $nin: [BILL_STATUSES.CANCELLED] },
          ...(Object.keys(dateFilter).length > 0 ? { billDate: dateFilter } : {}),
          companyId: companyId,
        };

        applyLedgerSplitFilter(baseBillsQuery);
        const billsQuery = buildOptionalQuery(baseBillsQuery);
        const bills = await Bill.find(billsQuery).sort({ billDate: 1 }).session(session);

        // Fetch payments made
        const basePaymentsMadeQuery = {
          vendorId: vendorId,
          status: PAYMENT_STATUS.APPROVED,
          ...(Object.keys(dateFilter).length > 0 ? { paymentDate: dateFilter } : {}),
          companyId: companyId,
        };

        applyLedgerSplitFilter(basePaymentsMadeQuery);
        const paymentsMadeQuery = buildOptionalQuery(basePaymentsMadeQuery);
        const paymentsMade = await PaymentMade.find(paymentsMadeQuery).sort({ paymentDate: 1 }).session(session);

        // Fetch account information for payments made
        const accountIdsFromPaymentsMade = [...new Set(paymentsMade.map(p => p.paidThroughAccountId).filter(Boolean))];
        const accountsForPaymentsMade = await Account.find({ _id: { $in: accountIdsFromPaymentsMade } })
          .select('accountName')
          .lean();
        const accountMapForPaymentsMade = accountsForPaymentsMade.reduce((acc, account) => {
          acc[account._id.toString()] = account.accountName;
          return acc;
        }, {});

        // Fetch debit notes
        const baseDebitNotesQuery = {
          vendorId: vendorId,
          status: {
            $nin: [DEBIT_NOTE_STATUS.CANCELLED],
          },
          ...(Object.keys(dateFilter).length > 0 ? { debitNoteDate: dateFilter } : {}),
          companyId: companyId,
        };
        applyLedgerSplitFilter(baseDebitNotesQuery);
        const debitNotesQuery = buildOptionalQuery(baseDebitNotesQuery);
        const debitNotes = await DebitNote.find(debitNotesQuery).sort({ debitNoteDate: 1 }).session(session);

        const expenses = splitOnly
          ? []
          : await Expenses.find(
              buildOptionalQuery({
                companyId,
                party: vendorId,
                partyType: LEDGER_PARTY_TYPES.VENDOR,
                isBillable: true,
                ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
              }),
            )
              .sort({ date: 1 })
              .session(session);

        // Calculate vendor-side credits and debits
        totalCredits += bills.reduce((sum, bill) => sum + bill.total * (bill.exchangeRate ?? 1), 0);
        totalDebits += paymentsMade.reduce((sum, payment) => sum + (payment.paymentMade || 0) * (payment.exchangeRate ?? 1), 0);
        totalDebits += debitNotes.reduce((sum, credit) => sum + credit.total * (credit.exchangeRate ?? 1), 0);
        totalCredits += expenses.reduce((sum, expense) => sum + expense.total * (expense.exchangeRate ?? 1), 0);

        // Add bills (increase liability)
        bills.forEach(bill => {
          transactions.push({
            date: bill.billDate,
            description: `Bill (${bill.status})`,
            debit: 0,
            credit: bill.total * (bill.exchangeRate ?? 1),
            type: 'bill',
            vchType: 'Purchase',
            vchNo: bill.billId,
            billId: bill._id,
            status: bill.status,
            role: 'vendor',
          });
        });

        // Add payments made (reduce liability)
        paymentsMade.forEach(payment => {
          transactions.push({
            date: payment.paymentDate,
            description: accountMapForPaymentsMade[payment.paidThroughAccountId?.toString()] || '',
            debit: (payment.paymentMade || 0) * (payment.exchangeRate ?? 1),
            credit: 0,
            type: 'payment_made',
            vchType: 'Payment',
            vchNo: payment.paymentMadeId,
            paymentId: payment._id,
            status: payment.status,
            role: 'vendor',
          });
        });

        // Add debit notes (reduce liability)
        debitNotes.forEach(credit => {
          transactions.push({
            date: credit.debitNoteDate,
            description: `Debit Note (${credit.status})`,
            debit: credit.total * (credit.exchangeRate ?? 1),
            credit: 0,
            type: 'debit_note',
            vchType: 'Purchase',
            vchNo: credit.debitNoteId,
            debitNoteId: credit._id,
            status: credit.status,
            role: 'vendor',
          });
        });

        // Add billable expenses (we owe the vendor who paid them)
        expenses.forEach(expense => {
          transactions.push({
            date: expense.date,
            description: `Expense (${expense.billableStatus})`,
            debit: 0,
            credit: expense.total * (expense.exchangeRate ?? 1),
            type: 'expense',
            vchType: 'Expense',
            vchNo: expense.expenseId,
            expenseId: expense._id,
            status: expense.billableStatus,
            role: 'vendor',
          });
        });
      } catch (error) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to fetch vendor transactions: ${error.message}`);
      }
    }

    if (isCustomer) {
      try {
        const baseInvoicesQuery = {
          customerId: customerId,
          status: { $nin: [SALES_ORDER_INVOICE_STATUS.CANCELLED] },
          ...(Object.keys(dateFilter).length > 0 ? { invoiceDate: dateFilter } : {}),
          companyId: companyId,
        };

        applyLedgerSplitFilter(baseInvoicesQuery);

        const invoicesQuery = buildOptionalQuery(baseInvoicesQuery);
        const invoices = await Invoice.find(invoicesQuery).sort({ invoiceDate: 1 }).session(session);

        const basePaymentsReceivedQuery = {
          customerId: customerId,
          status: PAYMENT_STATUS.APPROVED,
          ...(Object.keys(dateFilter).length > 0 ? { paymentDate: dateFilter } : {}),
          companyId: companyId,
        };

        applyLedgerSplitFilter(basePaymentsReceivedQuery);
        const paymentsReceivedQuery = buildOptionalQuery(basePaymentsReceivedQuery);
        const paymentsReceived = await PaymentReceived.find(paymentsReceivedQuery).sort({ paymentDate: 1 }).session(session);

        // Fetch account information for payments received
        const accountIdsFromPaymentsReceived = [...new Set(paymentsReceived.map(p => p.depositToAccountId).filter(Boolean))];
        const accountsForPaymentsReceived = await Account.find({ _id: { $in: accountIdsFromPaymentsReceived } })
          .select('accountName')
          .lean();
        const accountMapForPaymentsReceived = accountsForPaymentsReceived.reduce((acc, account) => {
          acc[account._id.toString()] = account.accountName;
          return acc;
        }, {});

        const baseCreditNotesQuery = {
          customerId: customerId,
          status: {
            $nin: [CREDIT_NOTE_STATUS.CANCELLED],
          },
          ...(Object.keys(dateFilter).length > 0 ? { creditNoteDate: dateFilter } : {}),
          companyId: companyId,
        };
        applyLedgerSplitFilter(baseCreditNotesQuery);
        const creditNotesQuery = buildOptionalQuery(baseCreditNotesQuery);
        const creditNotes = await CreditNote.find(creditNotesQuery).sort({ creditNoteDate: 1 }).session(session);

        const expenses = splitOnly
          ? []
          : await Expenses.find(
              buildOptionalQuery({
                companyId,
                party: customerId,
                partyType: LEDGER_PARTY_TYPES.CUSTOMER,
                isBillable: true,
                ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
              }),
            )
              .sort({ date: 1 })
              .session(session);

        // Calculate customer-side credits and debits
        totalDebits += invoices.reduce((sum, invoice) => sum + invoice.total * (invoice.exchangeRate ?? 1), 0);
        totalCredits += paymentsReceived.reduce((sum, payment) => {
          return sum + payment.amountReceived * (payment.exchangeRate ?? 1);
        }, 0);
        totalCredits += creditNotes.reduce((sum, credit) => sum + credit.total * (credit.exchangeRate ?? 1), 0);
        totalDebits += expenses.reduce((sum, expense) => sum + expense.total * (expense.exchangeRate ?? 1), 0);

        invoices.forEach(invoice => {
          transactions.push({
            date: invoice.invoiceDate,
            description: `Invoice (${invoice.status})`,
            debit: invoice.total * (invoice.exchangeRate ?? 1),
            credit: 0,
            type: 'invoice',
            vchType: 'Sales',
            vchNo: invoice.invoiceId,
            invoiceId: invoice._id,
            status: invoice.status,
            role: 'customer',
          });
        });

        paymentsReceived.forEach(payment => {
          transactions.push({
            date: payment.paymentDate,
            description: accountMapForPaymentsReceived[payment.depositToAccountId?.toString()] || '',
            debit: 0,
            credit: payment.amountReceived * (payment.exchangeRate ?? 1),
            type: 'payment_received',
            vchType: 'Receipt',
            vchNo: payment.paymentReceivedId,
            paymentId: payment._id,
            status: payment.status,
            role: 'customer',
          });
        });

        creditNotes.forEach(credit => {
          transactions.push({
            date: credit.creditNoteDate,
            description: `Credit Note  (${credit.status})`,
            debit: 0,
            credit: credit.total * (credit.exchangeRate ?? 1),
            type: 'credit_note',
            vchType: 'Sales',
            vchNo: credit.creditNoteId,
            creditNoteId: credit._id,
            status: credit.status,
            role: 'customer',
          });
        });

        // Add billable expenses (the customer owes what we paid for them)
        expenses.forEach(expense => {
          transactions.push({
            date: expense.date,
            description: `Expense (${expense.billableStatus})`,
            debit: expense.total * (expense.exchangeRate ?? 1),
            credit: 0,
            type: 'expense',
            vchType: 'Expense',
            vchNo: expense.expenseId,
            expenseId: expense._id,
            status: expense.billableStatus,
            role: 'customer',
          });
        });
      } catch (error) {
        throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Failed to fetch customer transactions: ${error.message}`);
      }
    }

    let manualJournals = [];
    if (!isSplitOnly) {
      const manualJournalQuery = buildOptionalQuery({
        companyId,
        'journalEntries.businessAccountLedgerMasterId':
          entityIds.length > 1 ? { $in: entityIds } : entityIds.length === 1 ? entityIds[0] : mainCustomerId,
        ...(Object.keys(dateFilter).length > 0 ? { date: dateFilter } : {}),
      });
      manualJournals = await ManualJournal.find(manualJournalQuery).populate('journalEntries.accountId').session(session);
    }

    // Add manual journal transactions
    manualJournals.forEach(journal => {
      const rate = journal.exchangeRate ?? 1;
      journal.journalEntries.forEach(entry => {
        if (!entityIds.some(id => entry.businessAccountLedgerMasterId?.toString() === id.toString())) return;
        totalDebits += (entry.debits || 0) * rate;
        totalCredits += (entry.credits || 0) * rate;

        // A journal line that moved money is labelled with the account it moved through; every
        // other line reads as a plain journal entry. Only cash, bank, card and clearing accounts
        // hold money, so the category decides this rather than the account's name.
        const accountName = entry.accountId?.accountName || '';
        const vchType = PAYMENT_ACCOUNT_CATEGORIES.includes(entry.accountId?.category) ? accountName : 'Journal Entry';

        transactions.push({
          date: journal.date,
          description: `${accountName}`,
          ...(entry.debits ? { debit: entry.debits * rate } : { debit: 0 }),
          ...(entry.credits ? { credit: entry.credits * rate } : { credit: 0 }),
          type: 'manual_journal',
          vchType: vchType,
          vchNo: journal.vchNo,
          manualJournalId: journal._id,
          status: '',
          role: '',
        });
      });
    });

    // Sort transactions by date
    transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Calculate running balance starting from opening balance
    let runningBalance;

    if (isVendor && !isCustomer) {
      runningBalance = openingBalanceType === 'DR' ? -openingBalance : openingBalance;
    } else {
      runningBalance = openingBalanceType === 'DR' ? openingBalance : -openingBalance;
    }

    const getRunningBalanceType = balance => {
      if (balance === 0) return 'Zero';
      if (isVendor && !isCustomer) return balance > 0 ? 'CR' : 'DR';
      return balance > 0 ? 'DR' : 'CR';
    };

    const ledgerEntries = transactions.map(tx => {
      if (isCustomer) {
        // For customer: debit increases balance, credit decreases balance
        runningBalance = runningBalance + tx.debit - tx.credit;
      } else {
        // For vendor: credit increases balance, debit decreases balance
        runningBalance = runningBalance + tx.credit - tx.debit;
      }

      return {
        ...tx,
        balance: Math.abs(runningBalance),
        balanceType: getRunningBalanceType(runningBalance),
      };
    });

    // Derive closing balance from the final running balance so it always matches the last ledger entry
    const closingBalance = Math.abs(runningBalance);
    const closingBalanceType = getRunningBalanceType(runningBalance);

    // Commit the transaction
    await session.commitTransaction();

    return {
      customerId: mainCustomerId,
      customerDisplayName: mainCustomer?.customerDisplayName,
      companyName: mainCustomer?.companyName,
      address: mainCustomer?.address,
      role: { isCustomer, isVendor },
      openingBalance,
      openingBalanceType,
      ledger: ledgerEntries,
      closingBalance,
      closingBalanceType,
      totalCredit: totalCredits,
      totalDebit: totalDebits,
      ...(!mainCustomer.useBranchPaymentTerms ? { paymentTermsId: mainCustomer.paymentTermsId } : {}),
      ...(mainCustomer.useBranchCreditLimit
        ? {
            branch:
              mainCustomer.branch?.map(branch => ({
                ...branch.toObject?.(),
                branchName: branch.branchId?.name || '',
                paymentTermsId: branch.paymentTermsId || '',
              })) || [],
          }
        : {
            creditLimit: mainCustomer.creditLimit || 0,
          }),
    };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

const invoiceBarGraph = async filter => {
  const { Invoice } = getBooksModels();
  const { startDate, endDate } = resolveFinancialYearRange({ fy: filter.FY });
  const fyStartYear = startDate.getFullYear();
  const matchStage = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    invoiceDate: {
      $gte: startDate,
      $lte: endDate,
    },
    status: { $nin: [INVOICE_STATUS.CANCELLED] },
  };

  if (filter.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    matchStage.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
    matchStage.branchId = { $in: branchArray };
  }

  const aggregateInvoices = async (matchOverride = {}) => {
    const baseStage = { ...matchStage, ...matchOverride };

    return Invoice.aggregate([
      { $match: baseStage },
      {
        $group: {
          _id: '$_id',
          invoiceDate: { $first: '$invoiceDate' },
          subTotal: { $first: '$subTotal' },
          total: { $first: '$total' },
          exchangeRate: { $first: '$exchangeRate' },
        },
      },
      {
        $addFields: {
          year: { $year: '$invoiceDate' },
          month: { $month: '$invoiceDate' },
          baseTotal: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] },
          baseSubTotal: { $multiply: ['$subTotal', { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
      {
        $group: {
          _id: { year: '$year', month: '$month' },
          totalOrders: { $sum: 1 },
          totalSubTotal: { $sum: '$baseSubTotal' },
          totalFinal: { $sum: '$baseTotal' },
        },
      },
      {
        $project: {
          _id: 0,
          year: '$_id.year',
          month: '$_id.month',
          totalOrders: 1,
          totalSubTotal: 1,
          totalFinal: 1,
        },
      },
      { $sort: { year: 1, month: 1 } },
    ]);
  };

  const allInvoices = await aggregateInvoices({ isSplit: false });
  const allInvoicesMap = allInvoices.reduce((acc, inv) => {
    const key = `${inv.year}-${inv.month}`;
    acc[key] = inv;
    return acc;
  }, {});

  const fyMonths = Array.from({ length: 12 }, (_, index) => {
    const month = ((3 + index) % 12) + 1; // Apr -> Mar
    const year = month >= 4 ? fyStartYear : fyStartYear + 1;
    const key = `${year}-${month}`;
    const invoice = allInvoicesMap[key];

    return {
      year,
      month,
      totalOrders: invoice?.totalOrders || 0,
      totalSubTotal: invoice?.totalSubTotal || 0,
      totalFinal: invoice?.totalFinal || 0,
    };
  });

  if (filter?.isSplit === true) {
    const splitInvoices = await aggregateInvoices({ isSplit: true });

    const splitInvoicesMap = splitInvoices.reduce((acc, inv) => {
      const key = `${inv.year}-${inv.month}`;
      acc[key] = inv.totalFinal;
      return acc;
    }, {});

    return fyMonths.map(inv => {
      const key = `${inv.year}-${inv.month}`;
      return {
        ...inv,
        splitSalesTotal: splitInvoicesMap[key] || 0,
      };
    });
  }

  return fyMonths;
};

const invoiceBarGraphDetail = async (filter, options) => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const { sortField = 'invoiceDate', sortOrder = 'asc' } = filter;

  filter.companyId = new mongoose.Types.ObjectId(filter.companyId);

  if (filter.startDate && filter.endDate) {
    filter.invoiceDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  if (filter.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    filter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
    filter.branchId = { $in: branchArray };
  }

  if (filter?.isSplit == undefined) {
    filter.$or = [{ isSplit: false }, { isSplit: { $exists: false } }];
    delete filter.isSplit;
  }

  if (filter?.isSplit === false) {
    delete filter.isSplit;
  }

  delete filter.startDate;
  delete filter.endDate;
  delete filter.sortField;
  delete filter.sortOrder;

  filter.status = { $nin: [INVOICE_STATUS.CANCELLED] };

  options.sortBy = `${sortField}:${sortOrder}`;
  options.pagination = ![false, 'false'].includes(options.pagination);
  options.select =
    'invoiceDate invoiceId status paidAmount balanceAmount dueDate total exchangeRate customerId items additionalCharges isSplit';

  const pageLimit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const currentPage = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (currentPage - 1) * pageLimit;

  const baseAmt = { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] };

  const [result, totalAggResult, bfAggResult] = await Promise.all([
    Invoice.paginate(filter, options),
    options.pagination
      ? Invoice.aggregate([{ $match: filter }, { $group: { _id: null, s: { $sum: baseAmt } } }])
      : Promise.resolve([]),
    options.pagination && currentPage > 1
      ? Invoice.aggregate([
          { $match: filter },
          { $sort: { [sortField]: sortOrder === 'asc' ? 1 : -1, _id: -1 } },
          { $limit: skip },
          { $group: { _id: null, s: { $sum: baseAmt } } },
        ])
      : Promise.resolve([]),
  ]);

  if (result.results.length > 0) {
    const customerIds = [...new Set(result.results.map(inv => inv.customerId?.toString()).filter(Boolean))];
    const customers = await Customer.find({ _id: { $in: customerIds } })
      .select('customerDisplayName companyName bpPrimaryContactName customerPhoneNumber bpEmail')
      .lean();
    const customerMap = new Map(customers.map(c => [c._id.toString(), c]));
    result.results = result.results.map(invoice => {
      const obj = invoice.toJSON ? invoice.toJSON() : { ...invoice };
      obj.customerId = customerMap.get(invoice.customerId?.toString()) || null;
      return obj;
    });
  }

  if (options.pagination) {
    const currentPageSum = result.results.reduce((sum, inv) => sum + Math.round((inv.total || 0) * (inv.exchangeRate ?? 1)), 0);
    const broughtForward = Math.round(bfAggResult[0]?.s || 0);
    result.totalOverall = Math.round(totalAggResult[0]?.s || 0);
    result.broughtForward = broughtForward;
    result.carriedOver = Math.round(broughtForward + currentPageSum);
  }

  return result;
};

const billBarGraph = async filter => {
  const { Bill } = getBooksModels();
  const { startDate, endDate } = resolveFinancialYearRange({ fy: filter.FY });
  const fyStartYear = startDate.getFullYear();
  const matchStage = {
    companyId: new mongoose.Types.ObjectId(filter.companyId),
    billDate: {
      $gte: startDate,
      $lte: endDate,
    },
    status: { $nin: [BILL_STATUSES.CANCELLED] },
  };

  if (filter.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    matchStage.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
    matchStage.branchId = { $in: branchArray };
  }

  const aggregateBills = async (matchOverride = {}) => {
    const baseStage = { ...matchStage, ...matchOverride };

    return Bill.aggregate([
      { $match: baseStage },
      {
        $group: {
          _id: '$_id',
          billDate: { $first: '$billDate' },
          subTotal: { $first: '$subTotal' },
          total: { $first: '$total' },
          exchangeRate: { $first: '$exchangeRate' },
        },
      },
      {
        $addFields: {
          year: { $year: '$billDate' },
          month: { $month: '$billDate' },
          baseTotal: { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] },
          baseSubTotal: { $multiply: ['$subTotal', { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
      {
        $group: {
          _id: { year: '$year', month: '$month' },
          totalOrders: { $sum: 1 },
          totalSubTotal: { $sum: '$baseSubTotal' },
          totalFinal: { $sum: '$baseTotal' },
        },
      },
      {
        $project: {
          _id: 0,
          year: '$_id.year',
          month: '$_id.month',
          totalOrders: 1,
          totalSubTotal: 1,
          totalFinal: 1,
        },
      },
      { $sort: { year: 1, month: 1 } },
    ]);
  };

  const allBills = await aggregateBills({ isSplit: false });
  const allBillsMap = allBills.reduce((acc, bill) => {
    const key = `${bill.year}-${bill.month}`;
    acc[key] = bill;
    return acc;
  }, {});

  const fyMonths = Array.from({ length: 12 }, (_, index) => {
    const month = ((3 + index) % 12) + 1; // Apr -> Mar
    const year = month >= 4 ? fyStartYear : fyStartYear + 1;
    const key = `${year}-${month}`;
    const bill = allBillsMap[key];

    return {
      year,
      month,
      totalOrders: bill?.totalOrders || 0,
      totalSubTotal: bill?.totalSubTotal || 0,
      totalFinal: bill?.totalFinal || 0,
    };
  });

  if (filter?.isSplit === true) {
    const splitBills = await aggregateBills({ isSplit: true });

    const splitBillsMap = splitBills.reduce((acc, bill) => {
      const key = `${bill.year}-${bill.month}`;
      acc[key] = bill.totalFinal;
      return acc;
    }, {});

    return fyMonths.map(bill => {
      const key = `${bill.year}-${bill.month}`;
      return {
        ...bill,
        splitPurchaseTotal: splitBillsMap[key] || 0,
      };
    });
  }

  return fyMonths;
};

const billBarGraphDetail = async (filter, options) => {
  const { Bill } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { sortField = 'billDate', sortOrder = 'asc' } = filter;

  if (filter.startDate && filter.endDate) {
    filter.billDate = {
      $gte: new Date(filter.startDate),
      $lte: new Date(filter.endDate),
    };
  }

  if (filter.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    filter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
    filter.branchId = { $in: branchArray };
  }

  delete filter.startDate;
  delete filter.endDate;
  delete filter.sortField;
  delete filter.sortOrder;

  if (filter?.isSplit == undefined) {
    filter.$or = [{ isSplit: false }, { isSplit: { $exists: false } }];
    delete filter.isSplit;
  }

  if (filter?.isSplit === false) {
    delete filter.isSplit;
  }

  filter.status = { $nin: [BILL_STATUSES.CANCELLED] };
  filter.companyId = new mongoose.Types.ObjectId(filter.companyId);

  options.sortBy = `${sortField}:${sortOrder}`;
  options.pagination = ![false, 'false'].includes(options.pagination);
  options.select =
    'billDate billId status paidAmount balanceAmount dueDate total exchangeRate vendor items additionalCharges isSplit';

  const pageLimit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const currentPage = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (currentPage - 1) * pageLimit;

  const billBaseAmt = { $multiply: ['$total', { $ifNull: ['$exchangeRate', 1] }] };

  const [result, totalAggResult, bfAggResult] = await Promise.all([
    Bill.paginate(filter, options),
    options.pagination
      ? Bill.aggregate([{ $match: filter }, { $group: { _id: null, s: { $sum: billBaseAmt } } }])
      : Promise.resolve([]),
    options.pagination && currentPage > 1
      ? Bill.aggregate([
          { $match: filter },
          { $sort: { [sortField]: sortOrder === 'asc' ? 1 : -1, _id: -1 } },
          { $limit: skip },
          { $group: { _id: null, s: { $sum: billBaseAmt } } },
        ])
      : Promise.resolve([]),
  ]);

  if (result.results.length > 0) {
    const vendorIds = [...new Set(result.results.map(b => b.vendor?.toString()).filter(Boolean))];
    const vendors = await Customer.find({ _id: { $in: vendorIds } })
      .select('customerDisplayName companyName bpPrimaryContactName customerPhoneNumber bpEmail')
      .lean();
    const vendorMap = new Map(vendors.map(v => [v._id.toString(), v]));
    result.results = result.results.map(bill => {
      const obj = bill.toJSON ? bill.toJSON() : { ...bill };
      obj.vendor = vendorMap.get(bill.vendor?.toString()) || null;
      return obj;
    });
  }

  if (options.pagination) {
    const currentPageSum = result.results.reduce((sum, b) => sum + Math.round((b.total || 0) * (b.exchangeRate ?? 1)), 0);
    const broughtForward = Math.round(bfAggResult[0]?.s || 0);
    result.totalOverall = Math.round(totalAggResult[0]?.s || 0);
    result.broughtForward = broughtForward;
    result.carriedOver = Math.round(broughtForward + currentPageSum);
  }

  return result;
};

const PARTY_REPORT_TYPE = {
  CREDITOR: 'CREDITOR',
  DEBTOR: 'DEBTOR',
};

// Builds the company-base-currency conversion map for opening balances: each currency id maps to
// its exchangeRate (base currency maps to 1). Opening balances are stored in the party's currency.
const buildOpeningBalanceRateMap = async companyId => {
  const { Company, Currency } = getCommonModels();
  const company = await Company.findById(companyId).select('baseCurrency').lean();
  const currencies = await Currency.find({ companyId }).select('exchangeRate').lean();
  return new Map(
    currencies.map(cur => [String(cur._id), String(cur._id) === String(company?.baseCurrency) ? 1 : (cur.exchangeRate ?? 1)]),
  );
};

const sumManualJournalEntries = (manualJournalDocs, customerids) => {
  const map = new Map();
  for (const doc of manualJournalDocs) {
    const rate = doc.exchangeRate ?? 1;
    for (const j of doc.journalEntries || []) {
      const partyIdStr = j.businessAccountLedgerMasterId?.toString();
      if (!customerids.find(id => id.toString() === partyIdStr)) {
        continue;
      }
      const amount = Number(j.credits || -j.debits || 0) * rate;
      map.set(partyIdStr, (map.get(partyIdStr) || 0) + amount);
    }
  }
  return map;
};

// Computes bill/invoice, debitNote/creditNote and paymentMade/paymentReceived totals for one side
// (creditor = vendor-facing, debtor = customer-facing) of a business partner - current period,
// the period before startDate (used to roll the static opening balance forward, same "opening
// balance as of startDate" logic used by the ledger), and split data.
const computePartySideTotals = async (filter, customerids, isCreditor) => {
  const { startDate, endDate } = filter || {};
  const { PaymentReceived } = getBooksCrmModels();
  const { Bill, DebitNote, PaymentMade, Invoice, CreditNote, ManualJournal, Expenses } = getBooksModels();

  const txnModel = isCreditor ? Bill : Invoice;
  const txnPartyField = isCreditor ? 'vendor' : 'customerId';
  const txnDateField = isCreditor ? 'billDate' : 'invoiceDate';
  const txnCancelledStatus = isCreditor ? BILL_STATUSES.CANCELLED : SALES_ORDER_INVOICE_STATUS.CANCELLED;
  const txnOverdueStatus = isCreditor ? BILL_STATUSES.OVERDUE : INVOICE_STATUS.OVERDUE;

  const noteModel = isCreditor ? DebitNote : CreditNote;
  const notePartyField = isCreditor ? 'vendorId' : 'customerId';
  const noteDateField = isCreditor ? 'debitNoteDate' : 'creditNoteDate';
  const noteCancelledStatus = isCreditor ? DEBIT_NOTE_STATUS.CANCELLED : CREDIT_NOTE_STATUS.CANCELLED;

  const paymentModel = isCreditor ? PaymentMade : PaymentReceived;
  const paymentPartyField = isCreditor ? 'vendorId' : 'customerId';
  const paymentAmountField = isCreditor ? 'paymentMade' : 'amountReceived';

  const buildMatch = (partyField, dateField, extra, dateOverride) => {
    const match = {
      [partyField]: { $in: customerids },
      companyId: new mongoose.Types.ObjectId(filter.companyId),
      isSplit: false, // Always get non-split data
      ...extra,
    };
    const dateFilter = dateOverride || (startDate && endDate ? { $gte: new Date(startDate), $lte: new Date(endDate) } : null);
    if (dateFilter) {
      match[dateField] = dateFilter;
    }
    if (filter.divisionId) {
      const divisionArray = filter.divisionId.split(',').filter(Boolean);
      match.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
    }
    if (filter.branchId) {
      const branchArray = filter.branchId.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
      match.branchId = { $in: branchArray };
    }
    return match;
  };

  // Amounts are stored in each document's transaction currency; convert to the company base
  // currency by multiplying by the document exchangeRate (defaulting to 1 when absent).
  const aggregateSum = (model, match, groupField, sumField) =>
    model.aggregate([
      { $match: match },
      {
        $group: {
          _id: `$${groupField}`,
          totalAmount: { $sum: { $multiply: [`$${sumField}`, { $ifNull: ['$exchangeRate', 1] }] } },
        },
      },
      { $project: { customerId: '$_id', totalAmount: 1, _id: 0 } },
      { $sort: { totalAmount: -1 } },
    ]);

  const toMap = arr => new Map(arr.map(x => [x.customerId.toString(), x.totalAmount]));

  // A billable expense is charged to its party like an invoice (customer) or a bill (vendor); it has no split copy.
  const addBillableExpenses = async (targetMap, dateOverride) => {
    const { isSplit, ...expenseMatch } = buildMatch(
      'party',
      'date',
      {
        partyType: isCreditor ? LEDGER_PARTY_TYPES.VENDOR : LEDGER_PARTY_TYPES.CUSTOMER,
        isBillable: true,
      },
      dateOverride,
    );
    for (const [partyId, amount] of toMap(await aggregateSum(Expenses, expenseMatch, 'party', 'total'))) {
      targetMap.set(partyId, (targetMap.get(partyId) || 0) + amount);
    }
  };

  // ------------------------------------- current period (non-split) -------------------------------
  const matchStageTxn = buildMatch(txnPartyField, txnDateField, { status: { $nin: [txnCancelledStatus] } });
  const totalMap = toMap(await aggregateSum(txnModel, matchStageTxn, txnPartyField, 'total'));
  await addBillableExpenses(totalMap);

  const matchStageOverdueTxn = { ...matchStageTxn, status: { $in: [txnOverdueStatus] } };
  const overdueMap = toMap(await aggregateSum(txnModel, matchStageOverdueTxn, txnPartyField, 'balanceAmount'));

  const matchStageNote = buildMatch(notePartyField, noteDateField, { status: { $nin: [noteCancelledStatus] } });
  const noteMap = toMap(await aggregateSum(noteModel, matchStageNote, notePartyField, 'total'));

  const matchStagePayment = buildMatch(paymentPartyField, 'paymentDate', { status: PAYMENT_STATUS.APPROVED });
  const paymentMap = toMap(await aggregateSum(paymentModel, matchStagePayment, paymentPartyField, paymentAmountField));
  const unusedPaymentMap = toMap(await aggregateSum(paymentModel, matchStagePayment, paymentPartyField, 'unusedAmount'));

  // ------------------------------------- Manual Journal -------------------------------
  const buildManualJournalMatch = dateOverride => {
    const match = {
      companyId: new mongoose.Types.ObjectId(filter.companyId),
      journalEntries: { $elemMatch: { businessAccountLedgerMasterId: { $in: customerids } } },
    };
    const dateFilter = dateOverride || (startDate && endDate ? { $gte: new Date(startDate), $lte: new Date(endDate) } : null);
    if (dateFilter) {
      match.date = dateFilter;
    }
    if (filter.divisionId) {
      const divisionArray = filter.divisionId.split(',').filter(Boolean);
      match.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
    }
    if (filter.branchId) {
      const branchArray = filter.branchId.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
      match.branchId = { $in: branchArray };
    }
    return match;
  };

  const manualJournal = await ManualJournal.aggregate([{ $match: buildManualJournalMatch() }]);
  const manualJournalMap = sumManualJournalEntries(manualJournal, customerids);

  // ===================== PRE-STARTDATE DATA (rolls the static opening balance forward to startDate) =====================
  let preTotalMap = new Map();
  let preNoteMap = new Map();
  let prePaymentMap = new Map();
  let preManualJournalMap = new Map();

  if (startDate && endDate) {
    const beforeDateFilter = { $lt: new Date(startDate) };

    const matchStageTxnBefore = buildMatch(
      txnPartyField,
      txnDateField,
      { status: { $nin: [txnCancelledStatus] } },
      beforeDateFilter,
    );
    preTotalMap = toMap(await aggregateSum(txnModel, matchStageTxnBefore, txnPartyField, 'total'));
    await addBillableExpenses(preTotalMap, beforeDateFilter);

    const matchStageNoteBefore = buildMatch(
      notePartyField,
      noteDateField,
      { status: { $nin: [noteCancelledStatus] } },
      beforeDateFilter,
    );
    preNoteMap = toMap(await aggregateSum(noteModel, matchStageNoteBefore, notePartyField, 'total'));

    const matchStagePaymentBefore = buildMatch(
      paymentPartyField,
      'paymentDate',
      { status: PAYMENT_STATUS.APPROVED },
      beforeDateFilter,
    );
    prePaymentMap = toMap(await aggregateSum(paymentModel, matchStagePaymentBefore, paymentPartyField, paymentAmountField));

    const manualJournalBefore = await ManualJournal.aggregate([{ $match: buildManualJournalMatch(beforeDateFilter) }]);
    preManualJournalMap = sumManualJournalEntries(manualJournalBefore, customerids);
  }

  // ===================== SPLIT DATA (only when filter.isSplit === true) =====================
  let splitTotalMap = new Map();
  let splitOverdueMap = new Map();
  let splitNoteMap = new Map();
  let splitPaymentMap = new Map();
  let splitUnusedPaymentMap = new Map();
  let preSplitTotalMap = new Map();
  let preSplitNoteMap = new Map();
  let preSplitPaymentMap = new Map();

  if (filter.isSplit === true) {
    const matchStageSplitTxn = { ...matchStageTxn, isSplit: true, status: { $nin: [txnCancelledStatus] } };
    splitTotalMap = toMap(await aggregateSum(txnModel, matchStageSplitTxn, txnPartyField, 'total'));

    const matchStageSplitOverdueTxn = { ...matchStageTxn, isSplit: true, status: { $in: [txnOverdueStatus] } };
    splitOverdueMap = toMap(await aggregateSum(txnModel, matchStageSplitOverdueTxn, txnPartyField, 'balanceAmount'));

    const matchStageSplitNote = { ...matchStageNote, isSplit: true };
    splitNoteMap = toMap(await aggregateSum(noteModel, matchStageSplitNote, notePartyField, 'total'));

    const matchStageSplitPayment = { ...matchStagePayment, isSplit: true };
    splitPaymentMap = toMap(await aggregateSum(paymentModel, matchStageSplitPayment, paymentPartyField, paymentAmountField));
    splitUnusedPaymentMap = toMap(await aggregateSum(paymentModel, matchStageSplitPayment, paymentPartyField, 'unusedAmount'));

    if (startDate && endDate) {
      const beforeDateFilter = { $lt: new Date(startDate) };

      const matchStageSplitTxnBefore = {
        ...buildMatch(txnPartyField, txnDateField, { status: { $nin: [txnCancelledStatus] } }, beforeDateFilter),
        isSplit: true,
      };
      preSplitTotalMap = toMap(await aggregateSum(txnModel, matchStageSplitTxnBefore, txnPartyField, 'total'));

      const matchStageSplitNoteBefore = {
        ...buildMatch(notePartyField, noteDateField, { status: { $nin: [noteCancelledStatus] } }, beforeDateFilter),
        isSplit: true,
      };
      preSplitNoteMap = toMap(await aggregateSum(noteModel, matchStageSplitNoteBefore, notePartyField, 'total'));

      const matchStageSplitPaymentBefore = {
        ...buildMatch(paymentPartyField, 'paymentDate', { status: PAYMENT_STATUS.APPROVED }, beforeDateFilter),
        isSplit: true,
      };
      preSplitPaymentMap = toMap(
        await aggregateSum(paymentModel, matchStageSplitPaymentBefore, paymentPartyField, paymentAmountField),
      );
    }
  }

  return {
    totalMap,
    overdueMap,
    noteMap,
    paymentMap,
    unusedPaymentMap,
    manualJournalMap,
    preTotalMap,
    preNoteMap,
    prePaymentMap,
    preManualJournalMap,
    splitTotalMap,
    splitOverdueMap,
    splitNoteMap,
    splitPaymentMap,
    splitUnusedPaymentMap,
    preSplitTotalMap,
    preSplitNoteMap,
    preSplitPaymentMap,
  };
};

const buildCombinedPartyReport = async filter => {
  const { Customer } = getBooksCrmModels();

  const customer = await Customer.find({
    companyId: filter.companyId,
    $or: [{ 'Role.isVendor': true }, { 'Role.isCustomer': true }],
  }).select('customerDisplayName companyName customerPhoneNumber bpEmail branch Role otherDetails.currency vendorId customerId');

  const customerids = customer.map(c => new mongoose.Types.ObjectId(c.id));
  const docById = new Map(customer.map(c => [c._id.toString(), c]));

  const [creditorTotals, debtorTotals, obRateMap] = await Promise.all([
    computePartySideTotals(filter, customerids, true),
    computePartySideTotals(filter, customerids, false),
    buildOpeningBalanceRateMap(filter.companyId),
  ]);

  const computeRow = c => {
    const id = c._id.toString();
    const totalOpeningBalance = computeOpeningBalanceTotal(c, obRateMap, filter);
    const splitOpeningBalance =
      filter.isSplit === true ? computeOpeningBalanceTotal(c, obRateMap, filter, { splitOnly: true }) : 0;

    const isCustomerRole = !!c.Role?.isCustomer;
    const payableOpeningBalance = isCustomerRole ? 0 : totalOpeningBalance;
    const receivableOpeningBalance = isCustomerRole ? totalOpeningBalance : 0;
    const splitPayableOpeningBalance = isCustomerRole ? 0 : splitOpeningBalance;
    const splitReceivableOpeningBalance = isCustomerRole ? splitOpeningBalance : 0;

    const billTotal = creditorTotals.totalMap.get(id) || 0;
    const overdueBillTotal = Math.max(
      0,
      (creditorTotals.overdueMap.get(id) || 0) - (creditorTotals.unusedPaymentMap.get(id) || 0),
    );
    const debitNoteTotal = creditorTotals.noteMap.get(id) || 0;
    const paymentMadeTotal = creditorTotals.paymentMap.get(id) || 0;
    const creditorManualJournalTotal = creditorTotals.manualJournalMap.get(id) || 0;
    const preBillTotal = creditorTotals.preTotalMap.get(id) || 0;
    const preDebitNoteTotal = creditorTotals.preNoteMap.get(id) || 0;
    const prePaymentMadeTotal = creditorTotals.prePaymentMap.get(id) || 0;
    const preCreditorManualJournalTotal = creditorTotals.preManualJournalMap.get(id) || 0;
    const rolledPayableOpeningBalance =
      payableOpeningBalance + (preBillTotal - (preDebitNoteTotal + prePaymentMadeTotal)) + preCreditorManualJournalTotal;
    const netPayable =
      rolledPayableOpeningBalance + (billTotal - (debitNoteTotal + paymentMadeTotal)) + creditorManualJournalTotal;

    const invoiceTotal = debtorTotals.totalMap.get(id) || 0;
    const overdueInvoiceTotal = Math.max(
      0,
      (debtorTotals.overdueMap.get(id) || 0) - (debtorTotals.unusedPaymentMap.get(id) || 0),
    );
    const creditNoteTotal = debtorTotals.noteMap.get(id) || 0;
    const paymentReceivedTotal = debtorTotals.paymentMap.get(id) || 0;
    const debtorManualJournalTotal = debtorTotals.manualJournalMap.get(id) || 0;
    const preInvoiceTotal = debtorTotals.preTotalMap.get(id) || 0;
    const preCreditNoteTotal = debtorTotals.preNoteMap.get(id) || 0;
    const prePaymentReceivedTotal = debtorTotals.prePaymentMap.get(id) || 0;
    const preDebtorManualJournalTotal = debtorTotals.preManualJournalMap.get(id) || 0;
    const rolledReceivableOpeningBalance =
      receivableOpeningBalance + (preInvoiceTotal - (preCreditNoteTotal + prePaymentReceivedTotal + preDebtorManualJournalTotal));
    const netReceivable =
      rolledReceivableOpeningBalance + (invoiceTotal - (creditNoteTotal + paymentReceivedTotal + debtorManualJournalTotal));

    const netBalance = netReceivable - netPayable;

    const responseObj = {
      customerId: c._id,
      customerDisplayName: c.customerDisplayName,
      companyName: c.companyName,
      bpEmail: c.bpEmail,
      customerPhoneNumber: c.customerPhoneNumber,
      isVendor: !!c.Role?.isVendor,
      isCustomer: !!c.Role?.isCustomer,
      billTotal: parseInt(billTotal),
      overdueBillTotal: parseInt(overdueBillTotal),
      debitNoteTotal: parseInt(debitNoteTotal),
      paymentMadeTotal: parseInt(paymentMadeTotal),
      netPayable: Number(netPayable.toFixed(2)),
      invoiceTotal: parseInt(invoiceTotal),
      overdueInvoiceTotal: parseInt(overdueInvoiceTotal),
      creditNoteTotal: parseInt(creditNoteTotal),
      paymentReceivedTotal: parseInt(paymentReceivedTotal),
      netReceivable: Number(netReceivable.toFixed(2)),
      netBalance: Number(netBalance.toFixed(2)),
    };

    if (filter.isSplit === true) {
      const splitBillTotal = creditorTotals.splitTotalMap.get(id) || 0;
      const splitOverdueBillTotal = Math.max(
        0,
        (creditorTotals.splitOverdueMap.get(id) || 0) - (creditorTotals.splitUnusedPaymentMap.get(id) || 0),
      );
      const splitDebitNoteTotal = creditorTotals.splitNoteMap.get(id) || 0;
      const splitPaymentMadeTotal = creditorTotals.splitPaymentMap.get(id) || 0;
      const preSplitBillTotal = creditorTotals.preSplitTotalMap.get(id) || 0;
      const preSplitDebitNoteTotal = creditorTotals.preSplitNoteMap.get(id) || 0;
      const preSplitPaymentMadeTotal = creditorTotals.preSplitPaymentMap.get(id) || 0;
      const splitNetPayable =
        splitPayableOpeningBalance +
        preSplitBillTotal -
        (preSplitDebitNoteTotal + preSplitPaymentMadeTotal) +
        (splitBillTotal - (splitDebitNoteTotal + splitPaymentMadeTotal));

      const splitInvoiceTotal = debtorTotals.splitTotalMap.get(id) || 0;
      const splitOverdueInvoiceTotal = Math.max(
        0,
        (debtorTotals.splitOverdueMap.get(id) || 0) - (debtorTotals.splitUnusedPaymentMap.get(id) || 0),
      );
      const splitCreditNoteTotal = debtorTotals.splitNoteMap.get(id) || 0;
      const splitPaymentReceivedTotal = debtorTotals.splitPaymentMap.get(id) || 0;
      const preSplitInvoiceTotal = debtorTotals.preSplitTotalMap.get(id) || 0;
      const preSplitCreditNoteTotal = debtorTotals.preSplitNoteMap.get(id) || 0;
      const preSplitPaymentReceivedTotal = debtorTotals.preSplitPaymentMap.get(id) || 0;
      const splitNetReceivable =
        splitReceivableOpeningBalance +
        preSplitInvoiceTotal -
        (preSplitCreditNoteTotal + preSplitPaymentReceivedTotal) +
        (splitInvoiceTotal - (splitCreditNoteTotal + splitPaymentReceivedTotal));

      responseObj.splitBillTotal = parseInt(splitBillTotal);
      responseObj.splitOverdueBillTotal = parseInt(splitOverdueBillTotal);
      responseObj.splitDebitNoteTotal = parseInt(splitDebitNoteTotal);
      responseObj.splitPaymentMadeTotal = parseInt(splitPaymentMadeTotal);
      responseObj.splitNetPayable = parseInt(splitNetPayable);
      responseObj.totalOverdueBillWithSplit = parseInt(overdueBillTotal + splitOverdueBillTotal);

      responseObj.splitInvoiceTotal = parseInt(splitInvoiceTotal);
      responseObj.splitOverdueInvoiceTotal = parseInt(splitOverdueInvoiceTotal);
      responseObj.splitCreditNoteTotal = parseInt(splitCreditNoteTotal);
      responseObj.splitPaymentReceivedTotal = parseInt(splitPaymentReceivedTotal);
      responseObj.splitNetReceivable = parseInt(splitNetReceivable);
      responseObj.totalOverdueInvoiceWithSplit = parseInt(overdueInvoiceTotal + splitOverdueInvoiceTotal);

      responseObj.splitNetBalance = Number((splitNetReceivable - splitNetPayable).toFixed(2));
    }

    return responseObj;
  };

  const mergeLinkedRows = (customerRow, vendorRow) => {
    const merged = {
      customerId: customerRow.customerId,
      customerDisplayName: customerRow.customerDisplayName,
      companyName: customerRow.companyName,
      bpEmail: customerRow.bpEmail,
      customerPhoneNumber: customerRow.customerPhoneNumber,
      isVendor: true,
      isCustomer: true,
      billTotal: vendorRow.billTotal,
      overdueBillTotal: vendorRow.overdueBillTotal,
      debitNoteTotal: vendorRow.debitNoteTotal,
      paymentMadeTotal: vendorRow.paymentMadeTotal,
      netPayable: vendorRow.netPayable,
      invoiceTotal: customerRow.invoiceTotal,
      overdueInvoiceTotal: customerRow.overdueInvoiceTotal,
      creditNoteTotal: customerRow.creditNoteTotal,
      paymentReceivedTotal: customerRow.paymentReceivedTotal,
      netReceivable: customerRow.netReceivable,
      netBalance: Number((customerRow.netReceivable - vendorRow.netPayable).toFixed(2)),
    };

    if (filter.isSplit === true) {
      merged.splitBillTotal = vendorRow.splitBillTotal;
      merged.splitOverdueBillTotal = vendorRow.splitOverdueBillTotal;
      merged.splitDebitNoteTotal = vendorRow.splitDebitNoteTotal;
      merged.splitPaymentMadeTotal = vendorRow.splitPaymentMadeTotal;
      merged.splitNetPayable = vendorRow.splitNetPayable;
      merged.totalOverdueBillWithSplit = vendorRow.totalOverdueBillWithSplit;

      merged.splitInvoiceTotal = customerRow.splitInvoiceTotal;
      merged.splitOverdueInvoiceTotal = customerRow.splitOverdueInvoiceTotal;
      merged.splitCreditNoteTotal = customerRow.splitCreditNoteTotal;
      merged.splitPaymentReceivedTotal = customerRow.splitPaymentReceivedTotal;
      merged.splitNetReceivable = customerRow.splitNetReceivable;
      merged.totalOverdueInvoiceWithSplit = customerRow.totalOverdueInvoiceWithSplit;

      merged.splitNetBalance = Number((customerRow.splitNetReceivable - vendorRow.splitNetPayable).toFixed(2));
    }

    return merged;
  };

  const processedIds = new Set();
  const report = [];

  for (const c of customer) {
    const id = c._id.toString();
    if (processedIds.has(id)) continue;

    const partnerId = c.vendorId ? c.vendorId.toString() : c.customerId ? c.customerId.toString() : null;
    const partnerDoc = partnerId ? docById.get(partnerId) : null;

    if (partnerDoc && !processedIds.has(partnerId)) {
      const customerSideDoc = c.vendorId ? c : partnerDoc;
      const vendorSideDoc = c.vendorId ? partnerDoc : c;
      report.push(mergeLinkedRows(computeRow(customerSideDoc), computeRow(vendorSideDoc)));
      processedIds.add(id);
      processedIds.add(partnerId);
    } else {
      report.push(computeRow(c));
      processedIds.add(id);
    }
  }

  const filteredReport = filter.withZeroBalance
    ? report
    : report.filter(
        r =>
          r.netPayable !== 0 ||
          r.netReceivable !== 0 ||
          (filter.isSplit === true && (r.splitNetPayable !== 0 || r.splitNetReceivable !== 0)),
      );

  filteredReport.sort((a, b) => b.netBalance - a.netBalance);

  let response = filteredReport;

  if (filter?.column == 'CREDIT') {
    response = filteredReport.filter(r => r.netBalance < 0);
  }
  if (filter?.column == 'DEBIT') {
    response = filteredReport.filter(r => r.netBalance > 0);
  }

  return response;
};

const emptyPartyTotals = () => ({
  totalMap: new Map(),
  overdueMap: new Map(),
  noteMap: new Map(),
  paymentMap: new Map(),
  unusedPaymentMap: new Map(),
  manualJournalMap: new Map(),
  preTotalMap: new Map(),
  preNoteMap: new Map(),
  prePaymentMap: new Map(),
  preManualJournalMap: new Map(),
  splitTotalMap: new Map(),
  splitOverdueMap: new Map(),
  splitNoteMap: new Map(),
  splitPaymentMap: new Map(),
  splitUnusedPaymentMap: new Map(),
  preSplitTotalMap: new Map(),
  preSplitNoteMap: new Map(),
  preSplitPaymentMap: new Map(),
});

const computeOpeningBalanceTotal = (c, obRateMap, filter, { splitOnly = false } = {}) => {
  const obRate = obRateMap.get(String(c?.otherDetails?.currency)) ?? 1;
  let total = 0;
  if (c?.branch?.length > 0) {
    const branchArray = filter.branchId ? filter.branchId.split(',').map(bid => bid.trim()) : null;
    for (const i of c.branch) {
      if (branchArray && !branchArray.includes(i.branchId?.toString())) continue;
      const isSplitBal = i.isSplitBalance === true;
      if (splitOnly ? isSplitBal : !isSplitBal) {
        total += (i.openingBalance || 0) * obRate;
      }
    }
  }
  return total;
};

const computeNetForDoc = (c, totalsMap, obRateMap, filter, isCreditorSide) => {
  const id = c._id.toString();
  const openingBalance = computeOpeningBalanceTotal(c, obRateMap, filter);
  const splitOpeningBalance = filter.isSplit === true ? computeOpeningBalanceTotal(c, obRateMap, filter, { splitOnly: true }) : 0;

  const total = totalsMap.totalMap.get(id) || 0;
  const noteTotal = totalsMap.noteMap.get(id) || 0;
  const paymentTotal = totalsMap.paymentMap.get(id) || 0;
  const manualJournalTotal = totalsMap.manualJournalMap.get(id) || 0;
  const preTotal = totalsMap.preTotalMap.get(id) || 0;
  const preNoteTotal = totalsMap.preNoteMap.get(id) || 0;
  const prePaymentTotal = totalsMap.prePaymentMap.get(id) || 0;
  const preManualJournalTotal = totalsMap.preManualJournalMap.get(id) || 0;

  const rolledOpeningBalance = isCreditorSide
    ? openingBalance + (preTotal - (preNoteTotal + prePaymentTotal)) + preManualJournalTotal
    : openingBalance + (preTotal - (preNoteTotal + prePaymentTotal + preManualJournalTotal));

  const net = isCreditorSide
    ? rolledOpeningBalance + (total - (noteTotal + paymentTotal)) + manualJournalTotal
    : rolledOpeningBalance + (total - (noteTotal + paymentTotal + manualJournalTotal));

  const splitTotal = totalsMap.splitTotalMap.get(id) || 0;
  const splitNoteTotal = totalsMap.splitNoteMap.get(id) || 0;
  const splitPaymentTotal = totalsMap.splitPaymentMap.get(id) || 0;
  const preSplitTotal = totalsMap.preSplitTotalMap.get(id) || 0;
  const preSplitNoteTotal = totalsMap.preSplitNoteMap.get(id) || 0;
  const preSplitPaymentTotal = totalsMap.preSplitPaymentMap.get(id) || 0;
  const rolledSplitOpening = splitOpeningBalance + (preSplitTotal - (preSplitNoteTotal + preSplitPaymentTotal));
  const splitNet = rolledSplitOpening + (splitTotal - (splitNoteTotal + splitPaymentTotal));

  return { net, splitNet };
};

const buildPartyReport = async (filter, partyType) => {
  if (!partyType) {
    return buildCombinedPartyReport(filter);
  }

  const isCreditor = partyType === PARTY_REPORT_TYPE.CREDITOR;
  const { Customer } = getBooksCrmModels();

  const includeLinkedData = filter?.includeLinkedData === true || filter?.includeLinkedData === 'true';

  const selectFields =
    'customerDisplayName companyName customerPhoneNumber bpEmail branch otherDetails.currency' +
    (includeLinkedData ? ' vendorId customerId' : '');

  const customer = await Customer.find({
    [isCreditor ? 'Role.isVendor' : 'Role.isCustomer']: true,
    companyId: filter.companyId,
  }).select(selectFields);

  const customerids = customer.map(c => new mongoose.Types.ObjectId(c.id));

  const partnerLinkField = isCreditor ? 'customerId' : 'vendorId';
  let partnerById = new Map();
  let partnerObjectIds = [];
  if (includeLinkedData) {
    const partnerIds = [...new Set(customer.map(c => c[partnerLinkField]?.toString()).filter(Boolean))];
    const partners = partnerIds.length
      ? await Customer.find({ _id: { $in: partnerIds }, companyId: filter.companyId }).select('branch otherDetails.currency')
      : [];
    partnerById = new Map(partners.map(p => [p._id.toString(), p]));
    partnerObjectIds = partners.map(p => new mongoose.Types.ObjectId(p.id));
  }

  const [totals, oppositeTotals, obRateMap] = await Promise.all([
    computePartySideTotals(filter, customerids, isCreditor),
    partnerObjectIds.length ? computePartySideTotals(filter, partnerObjectIds, !isCreditor) : Promise.resolve(emptyPartyTotals()),
    buildOpeningBalanceRateMap(filter.companyId),
  ]);

  const fieldNames = isCreditor
    ? {
        total: 'billTotal',
        overdueTotal: 'overdueBillTotal',
        noteTotal: 'debitNoteTotal',
        paymentTotal: 'paymentMadeTotal',
        splitTotal: 'splitBillTotal',
        splitOverdueTotal: 'splitOverdueBillTotal',
        splitNoteTotal: 'splitDebitNoteTotal',
        splitPaymentTotal: 'splitPaymentMadeTotal',
      }
    : {
        total: 'invoiceTotal',
        overdueTotal: 'overdueInvoiceTotal',
        noteTotal: 'creditNoteTotal',
        paymentTotal: 'paymentReceivedTotal',
        splitTotal: 'splitInvoiceTotal',
        splitOverdueTotal: 'splitOverdueInvoiceTotal',
        splitNoteTotal: 'splitCreditNoteTotal',
        splitPaymentTotal: 'splitPaymentReceivedTotal',
      };

  const report = customer.map(c => {
    const id = c._id.toString();
    const totalOpeningBalance = computeOpeningBalanceTotal(c, obRateMap, filter);

    const total = totals.totalMap.get(id) || 0;
    const overdueTotal = Math.max(0, (totals.overdueMap.get(id) || 0) - (totals.unusedPaymentMap.get(id) || 0));
    const noteTotal = totals.noteMap.get(id) || 0;
    const paymentTotal = totals.paymentMap.get(id) || 0;
    const manualJournalTotal = totals.manualJournalMap.get(id) || 0;

    const preTotal = totals.preTotalMap.get(id) || 0;
    const preNoteTotal = totals.preNoteMap.get(id) || 0;
    const prePaymentTotal = totals.prePaymentMap.get(id) || 0;
    const preManualJournalTotal = totals.preManualJournalMap.get(id) || 0;

    const rolledOpeningBalance = isCreditor
      ? totalOpeningBalance + (preTotal - (preNoteTotal + prePaymentTotal)) + preManualJournalTotal
      : totalOpeningBalance + (preTotal - (preNoteTotal + prePaymentTotal + preManualJournalTotal));

    const netPayable = isCreditor
      ? rolledOpeningBalance + (total - (noteTotal + paymentTotal)) + manualJournalTotal
      : rolledOpeningBalance + (total - (noteTotal + paymentTotal + manualJournalTotal));

    const partnerId = c[partnerLinkField]?.toString();
    const partnerDoc = partnerId ? partnerById.get(partnerId) : null;
    const linked = partnerDoc
      ? computeNetForDoc(partnerDoc, oppositeTotals, obRateMap, filter, !isCreditor)
      : { net: 0, splitNet: 0 };

    const finalNetPayable = netPayable - linked.net;

    const responseObj = {
      customerId: c._id,
      customerDisplayName: c.customerDisplayName,
      companyName: c.companyName,
      bpEmail: c.bpEmail,
      customerPhoneNumber: c.customerPhoneNumber,
      openingBalance: Number(rolledOpeningBalance.toFixed(2)),
      [fieldNames.total]: isCreditor ? total : parseInt(total),
      [fieldNames.overdueTotal]: parseInt(overdueTotal),
      [fieldNames.noteTotal]: parseInt(noteTotal),
      [fieldNames.paymentTotal]: parseInt(paymentTotal),
      netPayable: Number(finalNetPayable.toFixed(2)),
    };

    if (filter.isSplit === true) {
      const splitOpeningBalance = computeOpeningBalanceTotal(c, obRateMap, filter, { splitOnly: true });
      const splitTotal = totals.splitTotalMap.get(id) || 0;
      const splitOverdueTotal = Math.max(0, (totals.splitOverdueMap.get(id) || 0) - (totals.splitUnusedPaymentMap.get(id) || 0));
      const splitNoteTotal = totals.splitNoteMap.get(id) || 0;
      const splitPaymentTotal = totals.splitPaymentMap.get(id) || 0;

      const preSplitTotal = totals.preSplitTotalMap.get(id) || 0;
      const preSplitNoteTotal = totals.preSplitNoteMap.get(id) || 0;
      const preSplitPaymentTotal = totals.preSplitPaymentMap.get(id) || 0;
      const rolledSplitOpening = splitOpeningBalance + (preSplitTotal - (preSplitNoteTotal + preSplitPaymentTotal));

      const splitNetPayable = rolledSplitOpening + (splitTotal - (splitNoteTotal + splitPaymentTotal));
      const finalSplitNetPayable = splitNetPayable - linked.splitNet;

      responseObj[fieldNames.splitTotal] = parseInt(splitTotal);
      responseObj[fieldNames.splitOverdueTotal] = parseInt(splitOverdueTotal);
      responseObj[fieldNames.splitNoteTotal] = parseInt(splitNoteTotal);
      responseObj[fieldNames.splitPaymentTotal] = parseInt(splitPaymentTotal);
      responseObj.splitNetPayable = parseInt(finalSplitNetPayable);
      responseObj.totalOverdueBillWithSplit = parseInt(overdueTotal + splitOverdueTotal);

      const positiveBucketKey = isCreditor ? 'totalCreditsWithSplit' : 'totalDebitsWithSplit';
      const negativeBucketKey = isCreditor ? 'totalDebitsWithSplit' : 'totalCreditsWithSplit';
      responseObj[positiveBucketKey] = parseInt(
        (finalNetPayable > 0 ? finalNetPayable : 0) + (finalSplitNetPayable > 0 ? finalSplitNetPayable : 0),
      );
      responseObj[negativeBucketKey] = parseInt(
        (finalNetPayable < 0 ? finalNetPayable : 0) + (finalSplitNetPayable < 0 ? finalSplitNetPayable : 0),
      );
    }

    return responseObj;
  });

  const filteredReport = filter.withZeroBalance
    ? report
    : report.filter(r => r.netPayable !== 0 || (filter.isSplit === true && r.splitNetPayable !== 0));

  filteredReport.sort((a, b) => b.netPayable - a.netPayable);

  let response = filteredReport;

  if (filter?.column == 'CREDIT') {
    response = filteredReport.filter(r => (isCreditor ? r.netPayable > 0 : r.netPayable < 0));
  }
  if (filter?.column == 'DEBIT') {
    response = filteredReport.filter(r => (isCreditor ? r.netPayable < 0 : r.netPayable > 0));
  }

  return response;
};

const creditorsReport = filter => buildPartyReport(filter, PARTY_REPORT_TYPE.CREDITOR);

const debtorsReport = filter => buildPartyReport(filter, PARTY_REPORT_TYPE.DEBTOR);

// Prepare bank statement data for display by resolving branch/division names and calculating the running balance in the bank's own currency.
const queryBankHistories = async (filter, options) => {
  if (!filter.accountId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'accountId is required');
  }

  const paginationEnabled = ![false, 'false'].includes(options.pagination);
  const page = options.page ? Number(options.page) : 1;
  const limit = options.limit ? Number(options.limit) : 10;

  const statement = await bankService.getBankStatement({
    companyId: filter.companyId,
    accountId: filter.accountId,
    page,
    limit,
    pagination: paginationEnabled,
    startDate: filter.startDate,
    endDate: filter.endDate,
    branchId: filter.branchId,
    divisionId: filter.divisionId,
    isSplit: filter.isSplit,
    sortOrder: filter.sortOrder || 'asc',
  });

  const { Branch, Division } = getBooksCrmModels();
  const branchIds = [
    ...new Set(
      statement.entries
        .map(entry => entry.branchId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const divisionIds = [
    ...new Set(
      statement.entries
        .map(entry => entry.divisionId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const [branches, divisions] = await Promise.all([
    branchIds.length
      ? Branch.find({ _id: { $in: branchIds } })
          .select('name')
          .lean()
      : [],
    divisionIds.length
      ? Division.find({ _id: { $in: divisionIds } })
          .select('name')
          .lean()
      : [],
  ]);
  const branchById = new Map(branches.map(branch => [String(branch._id), branch]));
  const divisionById = new Map(divisions.map(division => [String(division._id), division]));

  const results = statement.entries.map(entry => ({
    id: entry.id,
    date: entry.date,
    partyName: entry.partyName,
    referenceType: entry.type,
    sourceModule: entry.sourceModule,
    documentId: entry.sourceId,
    documentNo: entry.documentNo,
    narration: entry.narration,
    branchId: entry.branchId ? branchById.get(String(entry.branchId)) || null : null,
    divisionId: entry.divisionId ? divisionById.get(String(entry.divisionId)) || null : null,
    effectType: entry.effectType,
    amount: entry.amount,
    availableBalance: entry.availableBalance,
  }));

  return {
    results,
    page: statement.page,
    limit: statement.limit,
    totalPages: statement.totalPages,
    totalResults: statement.totalResults,
    openingBalance: statement.account.openingBalance,
    closingBalance: statement.account.closingBalance,
    broughtForward: statement.broughtForward,
    carriedOver: statement.carriedOver,
    totalIn: statement.account.totalDebit,
    totalOut: statement.account.totalCredit,
  };
};

const ITEM_MODULEWISE_SUPPORTED_MODULES = [
  MODULE_NAMES.QUOTATION,
  MODULE_NAMES.SALES_ORDER,
  MODULE_NAMES.DELIVERY_CHALLAN,
  MODULE_NAMES.INVOICE,
  MODULE_NAMES.PURCHASE_ORDER,
  MODULE_NAMES.BILL,
  MODULE_NAMES.GRPO,
  MODULE_NAMES.PRODUCTION_ORDER,
];

const parseObjectIdList = (value, fieldName) => {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(id => id.trim())
    .filter(Boolean)
    .map(id => {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new ApiError(httpStatus.BAD_REQUEST, `${fieldName} must contain valid ObjectId values`);
      }
      return new mongoose.Types.ObjectId(id);
    });
};

const itemModulewiseDetails = async query => {
  const { companyId, itemId, moduleName, startDate, endDate, branchId, divisionId, page, limit, isSplit } = query;

  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const itemObjectId = itemId ? new mongoose.Types.ObjectId(itemId) : null;

  const normalizedModuleName = moduleName ? moduleName.trim().toUpperCase() : null;
  if (normalizedModuleName && !ITEM_MODULEWISE_SUPPORTED_MODULES.includes(normalizedModuleName)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid module name provided');
  }

  const branchObjectIds = parseObjectIdList(branchId, 'Branch Id');
  const divisionObjectIds = parseObjectIdList(divisionId, 'Division Id');

  const itemLimitValue = Number(limit) > 0 ? Number(limit) : 10;
  const itemPageValue = Number(page) > 0 ? Number(page) : 1;
  const itemSkip = (itemPageValue - 1) * itemLimitValue;

  const booksCrmModels = getBooksCrmModels();
  const booksModels = getBooksModels();

  const ItemModel = booksCrmModels?.Item;
  if (!ItemModel) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Item model not available');
  }

  const moduleConfigs = {
    [MODULE_NAMES.QUOTATION]: {
      model: booksCrmModels?.Quote,
      documentNoField: 'quoteId',
      dateField: 'quoteDate',
      statusField: 'status',
      allowedStatuses: [QUOTE_STATUS.DRAFT, QUOTE_STATUS.SENT, QUOTE_STATUS.ACCEPTED],
    },
    [MODULE_NAMES.SALES_ORDER]: {
      model: booksCrmModels?.SalesOrder,
      documentNoField: 'orderId',
      dateField: 'orderDate',
      statusField: 'status',
      allowedStatuses: [SALES_ORDER_STATUS.DRAFT, SALES_ORDER_STATUS.OPEN],
    },
    [MODULE_NAMES.DELIVERY_CHALLAN]: {
      model: booksModels?.DeliveryChallan,
      documentNoField: 'challanId',
      dateField: 'challanDate',
      statusField: 'status',
      allowedStatuses: [DELIVERY_CHALLAN_STATUS.DRAFT, DELIVERY_CHALLAN_STATUS.SENT],
    },
    [MODULE_NAMES.INVOICE]: {
      model: booksModels?.Invoice,
      documentNoField: 'invoiceId',
      dateField: 'invoiceDate',
      allowedStatuses: [INVOICE_STATUS.DRAFT, INVOICE_STATUS.SENT],
      splitFilter: true,
    },
    [MODULE_NAMES.PURCHASE_ORDER]: {
      model: booksModels?.PurchaseOrder,
      documentNoField: 'purchaseOrderId',
      dateField: 'date',
      statusField: 'status',
      allowedStatuses: [PO_STATUSES.DRAFT, PO_STATUSES.SENT, PO_STATUSES.ACCEPTED],
    },
    [MODULE_NAMES.BILL]: {
      model: booksModels?.Bill,
      documentNoField: 'billId',
      dateField: 'billDate',
      allowedStatuses: [BILL_STATUSES.DRAFT, BILL_STATUSES.OPEN],
      splitFilter: true,
    },
    [MODULE_NAMES.GRPO]: {
      model: booksModels?.GrpoOrder,
      documentNoField: 'grpoOrderId',
      dateField: 'date',
      statusField: 'status',
      allowedStatuses: [GRPO_STATUSES.DRAFT, GRPO_STATUSES.RECORDED],
    },
    [MODULE_NAMES.PRODUCTION_ORDER]: {
      model: booksModels?.ProductionOrder,
      documentNoField: 'productionOrderCode',
      dateField: 'productionDate',
      customHandler: 'productionOrder',
    },
  };

  const availableModules = Object.entries(moduleConfigs).filter(([, config]) => !!config.model);
  if (availableModules.length === 0) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'No modules available for processing');
  }

  let moduleOrder = availableModules.map(([name]) => name);
  if (normalizedModuleName) {
    if (!moduleOrder.includes(normalizedModuleName)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Requested module is not available');
    }
    moduleOrder = [normalizedModuleName, ...moduleOrder.filter(name => name !== normalizedModuleName)];
  }

  const buildMatchQuery = (config, targetItemId) => {
    let match = {
      companyId: companyObjectId,
    };

    if (config?.splitFilter) {
      if (isSplit == undefined) {
        match.isSplit = false;
      }
    }

    if (config.customHandler === 'productionOrder') {
      match.$or = [
        { itemId: targetItemId },
        { 'rawMaterials.rawMaterialId': targetItemId },
        { 'processBased.processes.processRawMaterialInput.item': targetItemId },
        { 'processBased.processes.scrapOutProcess.item': targetItemId },
        { 'submissionHistory.rawMaterialsConsumed.rawMaterialId': targetItemId },
      ];
    } else {
      match['items.itemId'] = targetItemId;
    }

    if (branchObjectIds.length > 0) {
      match.branchId = { $in: branchObjectIds };
    }

    if (divisionObjectIds.length > 0) {
      match.divisionId = { $in: divisionObjectIds };
    }

    if (startDate || endDate) {
      match[config.dateField] = {};
      if (startDate) {
        match[config.dateField].$gte = new Date(startDate);
      }
      if (endDate) {
        match[config.dateField].$lte = new Date(endDate);
      }
    }

    if (config.allowedStatuses && config.allowedStatuses.length > 0) {
      const statusField = config.statusField || 'status';
      match[statusField] = { $in: config.allowedStatuses };
    }

    return match;
  };

  const buildProductionOrderModuleData = async (config, match, targetItemId, moduleName) => {
    if (!config.model) {
      return {
        moduleName,
        totalQuantity: 0,
        totalDocuments: 0,
        totalsByRole: { FG: 0, RM: 0, SCRAP: 0 },
        results: [],
      };
    }

    const itemIdStr = targetItemId.toString();
    const documents = await config.model
      .find(match)
      .sort({ [config.dateField]: -1, _id: -1 })
      .select({
        [config.documentNoField]: 1,
        [config.dateField]: 1,
        productionManageMethod: 1,
        status: 1,
        itemId: 1,
        fgSubmittedQty: 1,
        totalFgSubmittedQty: 1,
        'submissionHistory.fgSubmittedQty': 1,
        'submissionHistory.rawMaterialsConsumed.rawMaterialId': 1,
        'submissionHistory.rawMaterialsConsumed.productionOrderSubmittedUnit': 1,
        'submissionHistory.rawMaterialsConsumed.rejectQty': 1,
        'processBased.processes.processRawMaterialInput.item': 1,
        'processBased.processes.processRawMaterialInput.value': 1,
        'processBased.processes.scrapOutProcess.item': 1,
        'processBased.processes.scrapOutProcess.value': 1,
      })
      .lean();

    const totalsByRole = { FG: 0, RM: 0, SCRAP: 0 };
    const uniqueDocumentIds = new Set();
    const results = [];

    documents.forEach(doc => {
      const docId = doc._id ? doc._id.toString() : null;
      const documentNo = doc[config.documentNoField] || null;
      const documentDate = doc[config.dateField] || null;
      const productionManageMethod = doc.productionManageMethod || null;
      const status = doc.status || null;
      let docHasContribution = false;

      const pushResult = (role, quantity) => {
        if (!quantity || quantity <= 0) {
          return;
        }

        docHasContribution = true;
        totalsByRole[role] += quantity;
        results.push({
          documentId: docId,
          documentNo,
          quantity,
          date: documentDate,
          role,
          effectType: role === 'RM' ? 'OUT' : 'IN',
          productionManageMethod,
          status,
        });
      };

      if (doc.itemId && doc.itemId.toString() === itemIdStr) {
        let fgQuantity = 0;
        if (Array.isArray(doc.submissionHistory) && doc.submissionHistory.length > 0) {
          fgQuantity = doc.submissionHistory.reduce((sum, submission) => sum + (submission?.fgSubmittedQty || 0), 0);
        } else {
          fgQuantity = doc.totalFgSubmittedQty || doc.fgSubmittedQty || 0;
        }
        pushResult('FG', fgQuantity);
      }

      if (doc.productionManageMethod === 'BOM_BASED' && Array.isArray(doc.submissionHistory)) {
        let rawMaterialQuantity = 0;

        doc.submissionHistory.forEach(submission => {
          if (Array.isArray(submission?.rawMaterialsConsumed)) {
            submission.rawMaterialsConsumed.forEach(consumed => {
              if (consumed?.rawMaterialId && consumed.rawMaterialId.toString() === itemIdStr) {
                rawMaterialQuantity += consumed.productionOrderSubmittedUnit || 0;
              }
            });
          }
        });

        pushResult('RM', rawMaterialQuantity);
      }

      if (doc.productionManageMethod === 'PROCESS_ROUTE' && doc.processBased?.processes) {
        let rawMaterialQuantity = 0;

        doc.processBased.processes.forEach(process => {
          if (Array.isArray(process?.processRawMaterialInput)) {
            process.processRawMaterialInput.forEach(input => {
              if (input?.item && input.item.toString() === itemIdStr) {
                rawMaterialQuantity += input.value || 0;
              }
            });
          }

          // Scrap handling skipped for now
        });

        pushResult('RM', rawMaterialQuantity);
      }

      if (docHasContribution && docId) {
        uniqueDocumentIds.add(docId);
      }
    });

    results.sort((a, b) => {
      const dateA = a.date ? new Date(a.date).getTime() : 0;
      const dateB = b.date ? new Date(b.date).getTime() : 0;

      if (dateA !== dateB) {
        return dateB - dateA;
      }

      if (a.documentId && b.documentId) {
        return b.documentId.localeCompare(a.documentId);
      }

      return 0;
    });

    const totalQuantity = Object.values(totalsByRole).reduce((sum, value) => sum + value, 0);

    return {
      moduleName,
      totalQuantity,
      totalDocuments: uniqueDocumentIds.size,
      totalsByRole,
      results,
    };
  };

  const activeItemIds = new Set();

  for (const [, config] of availableModules) {
    if (!config.model) continue;

    const match = {
      companyId: companyObjectId,
    };

    if (config?.splitFilter && isSplit == undefined) {
      match.isSplit = false;
    }

    if (branchObjectIds.length) {
      match.branchId = { $in: branchObjectIds };
    }

    if (divisionObjectIds.length) {
      match.divisionId = { $in: divisionObjectIds };
    }

    if (startDate || endDate) {
      match[config.dateField] = {};

      if (startDate) {
        match[config.dateField].$gte = new Date(startDate);
      }

      if (endDate) {
        match[config.dateField].$lte = new Date(endDate);
      }
    }

    if (config.allowedStatuses?.length) {
      match[config.statusField || 'status'] = {
        $in: config.allowedStatuses,
      };
    }

    if (config.customHandler === 'productionOrder') {
      // FG
      const fgItems = await config.model.aggregate([
        {
          $match: {
            ...match,
            itemId: { $exists: true, $ne: null },
          },
        },
        {
          $project: {
            itemId: 1,
            qty: {
              $cond: [
                {
                  $gt: [
                    {
                      $size: {
                        $ifNull: ['$submissionHistory', []],
                      },
                    },
                    0,
                  ],
                },
                {
                  $sum: '$submissionHistory.fgSubmittedQty',
                },
                {
                  $ifNull: ['$totalFgSubmittedQty', '$fgSubmittedQty'],
                },
              ],
            },
          },
        },
        {
          $match: {
            qty: { $gt: 0 },
          },
        },
        {
          $group: {
            _id: '$itemId',
          },
        },
      ]);

      fgItems.forEach(x => activeItemIds.add(x._id.toString()));

      // BOM Raw Materials
      const rmItems = await config.model.aggregate([
        { $match: match },
        { $unwind: '$submissionHistory' },
        { $unwind: '$submissionHistory.rawMaterialsConsumed' },
        {
          $match: {
            'submissionHistory.rawMaterialsConsumed.productionOrderSubmittedUnit': {
              $gt: 0,
            },
            'submissionHistory.rawMaterialsConsumed.rawMaterialId': { $ne: null },
          },
        },
        {
          $group: {
            _id: '$submissionHistory.rawMaterialsConsumed.rawMaterialId',
          },
        },
      ]);

      rmItems.forEach(x => activeItemIds.add(x._id.toString()));

      // Process Route
      const processItems = await config.model.aggregate([
        { $match: match },
        { $unwind: '$processBased.processes' },
        { $unwind: '$processBased.processes.processRawMaterialInput' },
        {
          $match: {
            'processBased.processes.processRawMaterialInput.value': {
              $gt: 0,
            },
            'processBased.processes.processRawMaterialInput.item': { $ne: null },
          },
        },
        {
          $group: {
            _id: '$processBased.processes.processRawMaterialInput.item',
          },
        },
      ]);

      processItems.forEach(x => activeItemIds.add(x._id.toString()));
    } else {
      const ids = await config.model.aggregate([
        { $match: match },
        { $unwind: '$items' },
        {
          $match: {
            'items.quantity': { $gt: 0 },
            'items.itemId': { $ne: null },
          },
        },
        {
          $group: {
            _id: '$items.itemId',
          },
        },
      ]);

      ids.forEach(x => activeItemIds.add(x._id.toString()));
    }
  }

  const itemFilter = {
    companyId: companyObjectId,
    _id: {
      $in: [...activeItemIds].map(id => new mongoose.Types.ObjectId(id)),
    },
  };

  if (itemObjectId) {
    itemFilter._id = itemObjectId;
  }

  const totalItems = await ItemModel.countDocuments(itemFilter);
  if (totalItems === 0) {
    return {
      companyId,
      page: itemPageValue,
      limit: itemLimitValue,
      totalItems: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPrevPage: false,
      items: [],
    };
  }

  const items = await ItemModel.find(itemFilter)
    .sort({ itemName: 1 })
    .skip(itemSkip)
    .limit(itemLimitValue)
    .select({ itemName: 1, itemNo: 1 })
    .lean();

  const itemsData = await Promise.all(
    items.map(async item => {
      const currentItemId = item._id;

      const modules = await Promise.all(
        moduleOrder.map(async name => {
          const config = moduleConfigs[name];
          const match = buildMatchQuery(config, currentItemId);

          if (config.customHandler === 'productionOrder') {
            return buildProductionOrderModuleData(config, match, currentItemId, name);
          }

          const [detailDocuments, totalsAggregation] = await Promise.all([
            config.model
              .aggregate([
                { $match: match },
                {
                  $addFields: {
                    documentDate: { $ifNull: [`$${config.dateField}`, null] },
                    documentNo: { $ifNull: [`$${config.documentNoField}`, null] },
                  },
                },
                {
                  $addFields: {
                    matchingItems: {
                      $filter: {
                        input: '$items',
                        as: 'item',
                        cond: { $eq: ['$$item.itemId', currentItemId] },
                      },
                    },
                  },
                },
                {
                  $addFields: {
                    quantity: {
                      $sum: {
                        $map: {
                          input: '$matchingItems',
                          as: 'matched',
                          in: { $ifNull: ['$$matched.quantity', 0] },
                        },
                      },
                    },
                  },
                },
                { $match: { quantity: { $gt: 0 } } },
                { $sort: { documentDate: -1, _id: -1 } },
                {
                  $project: {
                    matchingItems: 0,
                    items: 0,
                  },
                },
              ])
              .allowDiskUse(true),
            config.model
              .aggregate([
                { $match: match },
                { $unwind: '$items' },
                { $match: { 'items.itemId': currentItemId } },
                {
                  $group: {
                    _id: '$_id',
                    documentQuantity: { $sum: { $ifNull: ['$items.quantity', 0] } },
                  },
                },
                {
                  $group: {
                    _id: null,
                    totalQuantity: { $sum: '$documentQuantity' },
                    totalDocuments: { $sum: 1 },
                  },
                },
              ])
              .allowDiskUse(true),
          ]);

          const totals = totalsAggregation[0] || {};
          const totalDocuments = totals.totalDocuments || 0;
          const totalQuantity = totals.totalQuantity || 0;

          return {
            moduleName: name,
            totalQuantity,
            totalDocuments,
            results: detailDocuments.map(doc => ({
              documentId: doc._id ? doc._id.toString() : null,
              documentNo: doc.documentNo,
              quantity: doc.quantity || 0,
              date: doc.documentDate,
            })),
          };
        }),
      );

      return {
        itemId: currentItemId.toString(),
        itemName: item.itemName,
        itemNo: item.itemNo,
        modules,
      };
    }),
  );

  const totalPages = itemLimitValue > 0 ? Math.ceil(totalItems / itemLimitValue) : totalItems > 0 ? 1 : 0;

  return {
    companyId,
    items: itemsData,
    page: itemPageValue,
    limit: itemLimitValue,
    totalItems,
    totalPages,
    hasNextPage: itemPageValue < totalPages,
    hasPrevPage: itemPageValue > 1,
  };
};

// ============================================================================
// CONSTANTS
// ============================================================================

// The blocks a statement is printed in. These are labels of this report format, not properties
// of an account, so they are named here rather than on the chart of accounts itself.
// ============================================================================
// HELPERS
// ============================================================================

const round = v => Math.round((Number(v) || 0) * 100) / 100;
const toKey = n => n.toLowerCase().replace(/[\s\/]+/g, '');
const toObjId = id => new mongoose.Types.ObjectId(id);

const getChildIds = (accounts, parentId, ids = new Set()) => {
  if (!parentId) return ids;
  ids.add(parentId.toString());
  accounts.filter(a => a.parentAccountId?.toString() === parentId.toString()).forEach(c => getChildIds(accounts, c._id, ids));
  return ids;
};

const addBranchFilter = (q, branchId, divisionId) => {
  if (branchId) {
    const arr = branchId.split(',').filter(Boolean);
    if (arr.length) q.branchId = { $in: arr };
  }
  if (divisionId) q.divisionId = divisionId;
  return q;
};

// ============================================================================
// CALCULATED ITEMS (Batch Optimized)
// ============================================================================

const getReceivablesPayablesInventory = async (companyId, endDate, branchId, divisionId) => {
  const { AccountInvoice, AccountPaymentReceived, AccountBill, AccountPaymentMade, ItemBatch } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const cid = toObjId(companyId);
  const dateFilter = { $lte: new Date(endDate) };

  // Parallel fetch all data
  const [invoices, paymentsRcvd, bills, paymentsMade, items, batches] = await Promise.all([
    AccountInvoice.find(
      addBranchFilter(
        { companyId: cid, status: { $nin: [SALES_ORDER_INVOICE_STATUS.CANCELLED] }, invoiceDate: dateFilter },
        branchId,
        divisionId,
      ),
    )
      .select('total')
      .lean(),
    AccountPaymentReceived.find(
      addBranchFilter({ companyId: cid, status: PAYMENT_STATUS.APPROVED, paymentDate: dateFilter }, branchId, divisionId),
    )
      .select('amountReceived')
      .lean(),
    AccountBill.find(
      addBranchFilter(
        { companyId: cid, status: { $nin: [BILL_STATUSES.CANCELLED] }, billDate: dateFilter },
        branchId,
        divisionId,
      ),
    )
      .select('total')
      .lean(),
    AccountPaymentMade.find(
      addBranchFilter({ companyId: cid, status: PAYMENT_STATUS.APPROVED, paymentDate: dateFilter }, branchId, divisionId),
    )
      .select('paymentMade bills')
      .lean(),
    Item.find({ companyId: cid, isActive: true }).select('itemName itemNo inventoryData').lean(),
    ItemBatch.find({ companyId: cid }).select('itemId branchDetails').lean(),
  ]);

  // Receivables
  const totalInvoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const totalReceived = paymentsRcvd.reduce((s, p) => s + (p.amountReceived || 0), 0);

  // Payables
  const totalBilled = bills.reduce((s, b) => s + (b.total || 0), 0);
  const totalPaid = paymentsMade.reduce((s, p) => {
    if (p.bills?.length) return s + p.bills.reduce((a, b) => a + (b.amountApplied || 0), 0);
    return s + (p.paymentMade || 0);
  }, 0);

  // Inventory
  const batchMap = new Map(batches.map(b => [b.itemId.toString(), b]));
  const branchArr = branchId?.split(',').filter(Boolean) || [];
  let invValue = 0;
  const invDetails = [];

  items.forEach(item => {
    const batch = batchMap.get(item._id.toString());
    let qty = 0,
      val = 0;

    if (batch?.branchDetails) {
      batch.branchDetails.forEach(br => {
        if (branchArr.length && !branchArr.includes(br.branchId?.toString())) return;
        (br.availableBatches || []).forEach(b => {
          const q = b.remainingQty || b.quantity || 0;
          qty += q;
          val += q * (b.purchasePrice || 0);
        });
      });
    }

    if (!qty && item.inventoryData?.totalOpeningStock > 0) {
      qty = item.inventoryData.totalOpeningStock;
      val = qty * (item.inventoryData.purchasePrice || 0);
    }

    if (val > 0) {
      invValue += val;
      if (invDetails.length < 50)
        invDetails.push({
          itemId: item._id.toString(),
          itemName: item.itemName,
          sku: item.itemNo,
          quantity: qty,
          value: round(val),
        });
    }
  });

  return {
    receivable: {
      name: 'Accounts Receivable',
      totalInvoiced: round(totalInvoiced),
      totalReceived: round(totalReceived),
      balance: round(Math.max(0, totalInvoiced - totalReceived)),
      balanceType: 'DR',
      count: invoices.length,
    },
    payable: {
      name: 'Accounts Payable',
      totalBilled: round(totalBilled),
      totalPaid: round(totalPaid),
      balance: round(Math.max(0, totalBilled - totalPaid)),
      balanceType: 'CR',
      count: bills.length,
    },
    inventory: {
      name: 'Inventory',
      balance: round(invValue),
      balanceType: 'DR',
      itemCount: invDetails.length,
      details: invDetails,
    },
  };
};

// ============================================================================
// LEDGER TRANSACTIONS (Batch Fetch)
// ============================================================================

const fetchAllTransactions = async (companyId, endDate, branchId, divisionId, ledgerIds) => {
  const { AccountBill, AccountPaymentMade, AccountInvoice, AccountPaymentReceived, ManualJournal } = getBooksModels();
  const dateFilter = { $lte: new Date(endDate) };
  const idSet = new Set(ledgerIds);

  const [allBills, allPmtMade, allInvoices, allPmtRcvd, allJournals] = await Promise.all([
    AccountBill.find(
      addBranchFilter({ companyId, status: { $nin: [BILL_STATUSES.CANCELLED] }, billDate: dateFilter }, branchId, divisionId),
    )
      .select('vendor total')
      .lean(),
    AccountPaymentMade.find(
      addBranchFilter({ companyId, status: PAYMENT_STATUS.APPROVED, paymentDate: dateFilter }, branchId, divisionId),
    )
      .select('vendorId paymentMade bills')
      .lean(),
    AccountInvoice.find(
      addBranchFilter(
        { companyId, status: { $nin: [SALES_ORDER_INVOICE_STATUS.CANCELLED] }, invoiceDate: dateFilter },
        branchId,
        divisionId,
      ),
    )
      .select('customerId total')
      .lean(),
    AccountPaymentReceived.find(
      addBranchFilter({ companyId, status: PAYMENT_STATUS.APPROVED, paymentDate: dateFilter }, branchId, divisionId),
    )
      .select('customerId amountReceived')
      .lean(),
    ManualJournal.find({ companyId, date: dateFilter }).select('journalEntries exchangeRate').lean(),
  ]);

  // Group by ledgerId
  const txns = {};
  ledgerIds.forEach(id => {
    txns[id] = { bills: 0, pmtMade: 0, invoices: 0, pmtRcvd: 0, jrnlDr: 0, jrnlCr: 0 };
  });

  allBills.forEach(b => {
    if (txns[b.vendor?.toString()]) txns[b.vendor.toString()].bills += b.total || 0;
  });
  allPmtMade.forEach(p => {
    const id = p.vendorId?.toString();
    if (txns[id]) {
      txns[id].pmtMade += p.bills?.length ? p.bills.reduce((s, x) => s + (x.amountApplied || 0), 0) : p.paymentMade || 0;
    }
  });
  allInvoices.forEach(i => {
    if (txns[i.customerId?.toString()]) txns[i.customerId.toString()].invoices += i.total || 0;
  });
  allPmtRcvd.forEach(p => {
    if (txns[p.customerId?.toString()]) txns[p.customerId.toString()].pmtRcvd += p.amountReceived || 0;
  });
  allJournals.forEach(j => {
    const rate = j.exchangeRate ?? 1;
    (j.journalEntries || []).forEach(e => {
      const id = e.businessAccountLedgerMasterId?.toString();
      if (txns[id]) {
        txns[id].jrnlDr += (e.debits || 0) * rate;
        txns[id].jrnlCr += (e.credits || 0) * rate;
      }
    });
  });

  return txns;
};

// ============================================================================
// CALCULATE LEDGER BALANCES
// ============================================================================

const calcLedgerBalances = (ledgers, txns, branchId, nature) => {
  return ledgers.map(l => {
    const id = l._id.toString();
    const t = txns[id] || { bills: 0, pmtMade: 0, invoices: 0, pmtRcvd: 0, jrnlDr: 0, jrnlCr: 0 };

    const opening = Number(l?.openingBalance ?? 0);

    // Role detection from transactions
    const isVendor = t.bills > 0 || t.pmtMade > 0;
    const isCustomer = t.invoices > 0 || t.pmtRcvd > 0;

    // Debits/Credits
    let dr = t.invoices + t.pmtMade + t.jrnlDr;
    let cr = t.bills + t.pmtRcvd + t.jrnlCr;

    // Net balance by nature
    const net = nature === 'DR' ? opening + dr - cr : opening + cr - dr;
    const type = nature === 'DR' ? (net >= 0 ? 'DR' : 'CR') : net >= 0 ? 'CR' : 'DR';

    return {
      ledgerId: id,
      ledgerMasterId: l.businessAccountLedgerMasterId,
      personName: l.personName,
      role: { isCustomer, isVendor },
      openingBalance: round(opening),
      totalDebit: round(dr),
      totalCredit: round(cr),
      balance: round(Math.abs(net)),
      balanceType: type,
      netBalance: round(net),
    };
  });
};

// ============================================================================
// BUILD ACCOUNT TREE
// ============================================================================

const buildTree = (accounts, ledgerMap, txns, parentId, catIds, nature, branchId) => {
  return accounts
    .filter(a => {
      if (!catIds.has(a._id.toString())) return false;
      const pid = a.parentAccountId?.toString() || null;
      return parentId === null ? !pid || !catIds.has(pid) : pid === parentId;
    })
    .map(a => {
      const aid = a._id.toString();
      const ledgers = ledgerMap.get(aid) || [];
      const ledgerDetails = calcLedgerBalances(ledgers, txns, branchId, nature);

      // Sum balances
      let bal = 0;
      ledgerDetails.forEach(l => {
        bal +=
          nature === 'DR' ? (l.balanceType === 'DR' ? l.balance : -l.balance) : l.balanceType === 'CR' ? l.balance : -l.balance;
      });

      // Recurse children
      const children = buildTree(accounts, ledgerMap, txns, aid, catIds, nature, branchId);
      const childBal = children.reduce((s, c) => s + (c.grandTotal || 0), 0);

      return {
        accountId: aid,
        accountName: a.accountName,
        ledgers: ledgerDetails,
        ledgerCount: ledgerDetails.length,
        balance: round(bal),
        balanceType: nature,
        grandTotal: round(bal + childBal),
        hasChildren: children.length > 0,
        children,
        childCount: children.length,
      };
    });
};

// ============================================================================
// MAIN SERVICE
// ============================================================================

const getBalanceSheetSummary = async filter => {
  const { Account } = getBooksModels();
  const { companyId, startDate, endDate, category, branchId, divisionId } = filter;

  if (!companyId || !startDate || !endDate) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID, start date and end date are required');
  }

  const cid = toObjId(companyId);

  const companyProfile = await getCompanyProfile(companyId, null);
  // Fetch accounts
  const accounts = await Account.find({
    $or: [{ companyId: cid }, { isDefault: true }],
    isActive: true,
  })
    .select('_id accountName parentAccountId category')
    .lean();

  // Build category account IDs
  const cats = category ? [category] : BALANCE_SHEET_SECTIONS;
  const catAccounts = {};

  cats.forEach(cat => {
    const key = toKey(cat);
    catAccounts[key] = new Set();

    accounts
      .filter(a => a.accountName?.toLowerCase().trim() === cat.toLowerCase().trim() || sectionOfCategory(a.category) === cat)
      .forEach(a => getChildIds(accounts, a._id).forEach(id => catAccounts[key].add(id)));

    accounts
      .filter(a => {
        if (!a.parentAccountId) return false;
        const p = accounts.find(x => x._id.toString() === a.parentAccountId.toString());
        return p?.accountName?.toLowerCase().trim() === cat.toLowerCase().trim();
      })
      .forEach(a => getChildIds(accounts, a._id).forEach(id => catAccounts[key].add(id)));
  });

  // All account IDs
  const allIds = new Set();
  Object.values(catAccounts).forEach(s => s.forEach(id => allIds.add(id)));
  // const idArr = [...allIds].map(toObjId);

  // Party rows came from the deprecated BusinessAccountLedgerMaster (accountId / openingBalance); AccountLedger has neither.
  // const ledgers = await BusinessAccountLedgerMaster.find({ companyId: cid, accountId: { $in: idArr } })
  //   .select('accountId businessAccountLedgerMasterId personName openingBalance email phoneNo pan gstNo')
  //   .lean();
  const ledgers = [];

  // Group ledgers
  const ledgerMap = new Map();
  ledgers.forEach(l => {
    const aid = l.accountId?.toString();
    if (aid) {
      if (!ledgerMap.has(aid)) ledgerMap.set(aid, []);
      ledgerMap.get(aid).push(l);
    }
  });

  // Fetch all transactions + calculated items in parallel
  const ledgerIds = ledgers.map(l => l._id.toString());
  const [txns, calculated] = await Promise.all([
    fetchAllTransactions(companyId, endDate, branchId, divisionId, ledgerIds),
    getReceivablesPayablesInventory(companyId, endDate, branchId, divisionId),
  ]);

  // Build result
  const result = {};
  cats.forEach(cat => {
    const key = toKey(cat);
    const ids = catAccounts[key];
    const nature = BALANCE_SHEET_SECTION_NATURE[cat];
    const tree = buildTree(accounts, ledgerMap, txns, null, ids, nature, branchId);

    let total = tree.reduce((s, a) => s + (a.grandTotal || 0), 0);
    if (key === 'currentassets') total += calculated.receivable.balance + calculated.inventory.balance;
    if (key === 'currentliabilities') total += calculated.payable.balance;

    result[key] = {
      categoryName: cat,
      accountNature: nature,
      accountCount: ids.size,
      accounts: tree,
      totalBalance: round(total),
      balanceType: nature,
      ledgerCount: ledgers.filter(l => ids.has(l.accountId?.toString())).length,
    };
  });

  // Add special items
  if (result.currentassets)
    result.currentassets.specialItems = { accountsReceivable: calculated.receivable, inventory: calculated.inventory };
  if (result.currentliabilities) result.currentliabilities.specialItems = { accountsPayable: calculated.payable };

  // Summary
  const fa = result.fixedassets?.totalBalance || 0;
  const ca = result.currentassets?.totalBalance || 0;
  const ncl = result.noncurrentliabilities?.totalBalance || 0;
  const cl = result.currentliabilities?.totalBalance || 0;
  const ce = result.capitalequity?.totalBalance || 0;

  const assets = fa + ca;
  const liabilities = ncl + cl;
  const liabPlusEq = liabilities + ce;
  const diff = Math.abs(assets - liabPlusEq);

  return {
    period: { startDate, endDate },
    categories: result,
    summary: {
      assets: { fixedAssets: round(fa), currentAssets: round(ca), totalAssets: round(assets), balanceType: 'DR' },
      liabilities: {
        nonCurrentLiabilities: round(ncl),
        currentLiabilities: round(cl),
        totalLiabilities: round(liabilities),
        balanceType: 'CR',
      },
      equity: { capitalEquity: round(ce), totalEquity: round(ce), balanceType: 'CR' },
      liabilitiesPlusEquity: round(liabPlusEq),
      isBalanced: diff < 1,
      difference: round(diff),
    },
    calculatedItems: calculated,
    statistics: { totalAccounts: allIds.size, totalLedgers: ledgers.length, categoriesProcessed: cats.length },
    metadata: {
      generatedAt: new Date(),
      currency: companyProfile?.baseCurrency?.code || '',
      companyId,
      note: diff < 1 ? 'Balance Sheet is balanced' : `Difference: ${companyProfile?.baseCurrency?.symbol || '₹'}${round(diff)}`,
    },
  };
};

const buildLocDateFilters = filter => {
  const loc = {};
  if (filter.branchId) {
    loc.branchId = {
      $in: filter.branchId
        .split(',')
        .filter(Boolean)
        .map(id => new mongoose.Types.ObjectId(id)),
    };
  }
  if (filter.divisionId) loc.divisionId = new mongoose.Types.ObjectId(filter.divisionId);

  let dateFilter = {};
  if (filter.startDate && filter.endDate) {
    const s = new Date(filter.startDate);
    const e = new Date(filter.endDate);
    s.setHours(0, 0, 0, 0);
    e.setHours(23, 59, 59, 999);
    dateFilter = { $gte: s, $lte: e };
  }

  return { loc, dateFilter };
};

const buildAccountTree = (accounts, amountMap) => {
  if (!accounts.length) return [];

  const idsInSection = new Set(accounts.map(account => account.id.toString()));
  const childrenByParent = new Map();
  for (const account of accounts) {
    const parentId = account.parentAccountId?.toString();
    // A sub-account whose parent sits in another section is a root of this one, so it still shows.
    const key = parentId && idsInSection.has(parentId) ? parentId : 'root';
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(account);
  }

  const byName = (a, b) => (a.accountName || '').localeCompare(b.accountName || '');

  const build = (account, depth) => {
    const id = account.id.toString();
    const children = (childrenByParent.get(id) || []).sort(byName).map(child => build(child, depth + 1));
    const childSum = children.reduce((sum, child) => sum + child.amount, 0);
    return {
      accountId: id,
      accountName: account.accountName || '',
      level: `L${depth}`,
      amount: round((amountMap.get(id) || 0) + childSum),
      children,
    };
  };

  return (childrenByParent.get('root') || []).sort(byName).map(account => build(account, 1));
};

const getStockSummary = async (filter, startDate, endDate) => {
  const { companyId, branchId, divisionId, warehouseId } = filter;
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const today = new Date();
  today.setHours(23, 59, 59, 999);

  const periodEnd = new Date(endDate);
  periodEnd.setHours(23, 59, 59, 999);

  // Single source of truth used by BOTH DB queries and the JS compute loop
  const effectivePeriodEnd = periodEnd > today ? today : periodEnd;

  const dateUpToEnd = { $lte: effectivePeriodEnd };

  // ── location match for aggregation pipelines ──────────────────────────────
  const locMatch = {};
  if (branchId) locMatch.branchId = new mongoose.Types.ObjectId(branchId);
  if (divisionId) locMatch.divisionId = new mongoose.Types.ObjectId(divisionId);
  if (warehouseId) locMatch.warehouseId = new mongoose.Types.ObjectId(warehouseId);

  const [dcConfig, invConfig, grpoConfig, billConfig] = await Promise.all([
    getInventoryConfig(companyId, MODULE_NAMES.DELIVERY_CHALLAN),
    getInventoryConfig(companyId, MODULE_NAMES.INVOICE),
    getInventoryConfig(companyId, MODULE_NAMES.GRPO),
    getInventoryConfig(companyId, MODULE_NAMES.BILL),
  ]);

  const inventoryConfig = {
    deliveryChallanDeducts: dcConfig.stockDeductEnabled === true,
    invoiceDeducts: invConfig.stockDeductEnabled === true,
    grpoAdds: grpoConfig.stockAddEnabled === true,
    billAdds: billConfig.stockAddEnabled === true,
  };

  const {
    DeliveryChallan,
    Invoice,
    CreditNote,
    DebitNote,
    GrpoOrder,
    Bill,
    InventoryLogs,
    InventoryTransferRequest,
    InventoryAdjustment,
    ProductionOrder,
  } = getBooksModels();

  const { Warehouse } = getBooksCrmModels();
  const pipelines = [];

  if (inventoryConfig.deliveryChallanDeducts) {
    pipelines.push(
      DeliveryChallan.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            challanDate: dateUpToEnd, // ← date filter
            status: { $ne: DELIVERY_CHALLAN_STATUS.CANCELLED },
            'inventoryConfig.stockDeductEnabled': true,
            ...locMatch,
          },
        },
        { $unwind: '$items' },
        { $match: { 'items.itemId': { $exists: true }, 'items.quantity': { $gt: 0 } } },
        {
          $project: {
            date: '$challanDate',
            itemId: '$items.itemId',
            warehouseId: '$warehouseId',
            branchId: '$branchId',
            quantity: { $multiply: ['$items.quantity', -1] },
            value: { $multiply: ['$items.quantity', { $ifNull: ['$items.rate', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          },
        },
      ]),
    );
  }

  if (inventoryConfig.invoiceDeducts) {
    pipelines.push(
      Invoice.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            invoiceDate: dateUpToEnd,
            status: { $nin: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.DRAFT] },
            'inventoryConfig.stockDeductEnabled': true,
            ...locMatch,
          },
        },
        { $unwind: '$items' },
        { $match: { 'items.itemId': { $exists: true }, 'items.quantity': { $gt: 0 } } },
        {
          $project: {
            date: '$invoiceDate',
            itemId: '$items.itemId',
            warehouseId: '$warehouseId',
            branchId: '$branchId',
            quantity: { $multiply: ['$items.quantity', -1] },
            value: { $multiply: ['$items.quantity', { $ifNull: ['$items.rate', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          },
        },
      ]),
    );
  }

  pipelines.push(
    CreditNote.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          creditNoteDate: dateUpToEnd,
          type: CREDIT_NOTE_TYPE.GOODS_RETURN,
          status: { $nin: [CREDIT_NOTE_STATUS.CANCELLED, CREDIT_NOTE_STATUS.DRAFT] },
          ...locMatch,
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.itemId': { $exists: true }, 'items.quantity': { $gt: 0 } } },
      {
        $project: {
          date: '$creditNoteDate',
          itemId: '$items.itemId',
          warehouseId: '$warehouseId',
          branchId: '$branchId',
          quantity: '$items.quantity',
          value: { $multiply: ['$items.quantity', { $ifNull: ['$items.rate', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
    ]),
  );

  pipelines.push(
    DebitNote.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          debitNoteDate: dateUpToEnd,
          type: CREDIT_NOTE_TYPE.GOODS_RETURN,
          status: { $nin: [DEBIT_NOTE_STATUS.CANCELLED, DEBIT_NOTE_STATUS.DRAFT] },
          ...locMatch,
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.itemId': { $exists: true }, 'items.quantity': { $gt: 0 } } },
      {
        $project: {
          date: '$debitNoteDate',
          itemId: '$items.itemId',
          warehouseId: '$warehouseId',
          branchId: '$branchId',
          quantity: { $multiply: ['$items.quantity', -1] },
          value: { $multiply: ['$items.quantity', { $ifNull: ['$items.rate', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
        },
      },
    ]),
  );

  if (inventoryConfig.grpoAdds) {
    pipelines.push(
      GrpoOrder.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            date: dateUpToEnd,
            status: { $ne: GRPO_STATUSES.CANCELLED },
            'inventoryConfig.stockAddEnabled': true,
            ...locMatch,
          },
        },
        { $unwind: '$items' },
        {
          $project: {
            date: '$date',
            itemId: '$items.itemId',
            warehouseId: '$warehouseId',
            branchId: '$branchId',
            quantity: '$items.quantity',
            value: { $multiply: ['$items.quantity', { $ifNull: ['$items.rate', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          },
        },
      ]),
    );
  }

  if (inventoryConfig.billAdds) {
    pipelines.push(
      Bill.aggregate([
        {
          $match: {
            companyId: companyObjectId,
            billDate: dateUpToEnd,
            status: { $nin: [BILL_STATUSES.CANCELLED, BILL_STATUSES.DRAFT] },
            'inventoryConfig.stockAddEnabled': true,
            $and: [
              { $or: [{ grpoId: { $exists: false } }, { grpoId: null }] },
              { $or: [{ grpoIds: { $exists: false } }, { grpoIds: { $size: 0 } }] },
            ],
            ...locMatch,
          },
        },
        { $unwind: '$items' },
        {
          $project: {
            date: '$billDate',
            itemId: '$items.itemId',
            warehouseId: '$warehouseId',
            branchId: '$branchId',
            quantity: '$items.quantity',
            value: { $multiply: ['$items.quantity', { $ifNull: ['$items.rate', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
          },
        },
      ]),
    );
  }

  pipelines.push(
    InventoryLogs.aggregate([
      {
        $match: {
          companyId: companyObjectId,
          createdAt: dateUpToEnd,
          ...locMatch,
        },
      },
      {
        $project: {
          date: '$createdAt',
          itemId: '$itemId',
          warehouseId: '$warehouseId',
          branchId: '$branchId',
          quantity: '$quantity',
          value: { $multiply: ['$quantity', { $ifNull: ['$price', 0] }] },
        },
      },
    ]),
  );

  // ── fetch transfers, adjustments, production orders in parallel ───────────
  const [aggResults, transfers, adjustments, orders] = await Promise.all([
    Promise.all(pipelines),

    InventoryTransferRequest.find({
      companyId: companyObjectId,
      status: INVENTORY_TRANSFER_REQUEST.APPROVED,
      updatedAt: dateUpToEnd,
    })
      .select('updatedAt itemId fromWarehouseId toWarehouseId quantity rawMaterials isProductionOrderReq productionOrderId')
      .lean(),

    InventoryAdjustment.find({
      companyId: companyObjectId,
      status: 'APPROVED',
      adjustmentDate: dateUpToEnd,
      ...locMatch,
    }).lean(),

    ProductionOrder.find({
      companyId: companyObjectId,
      status: {
        $in: [PRODUCTION_ORDER_STATUS.INVENTORY_ISSUED, PRODUCTION_ORDER_STATUS.PARTIAL, PRODUCTION_ORDER_STATUS.COMPLETED],
      },
      updatedAt: dateUpToEnd,
    }).lean(),
  ]);

  const movements = aggResults.flat();

  // ── transfers ──
  const whIdStr = warehouseId ? warehouseId.toString() : null;

  for (const doc of transfers) {
    if (whIdStr) {
      const fromMatch = doc.fromWarehouseId?.toString() === whIdStr;
      const toMatch = doc.toWarehouseId?.toString() === whIdStr;
      if (!fromMatch && !toMatch) continue;
    }

    const postDate = doc.updatedAt ? new Date(doc.updatedAt) : null;
    if (!postDate) continue;

    const transferId = doc._id.toString();

    const pushOut = (itemId, fromWh, qty) => {
      if (whIdStr && (!fromWh || fromWh.toString() !== whIdStr)) return;
      movements.push({
        date: postDate,
        itemId,
        warehouseId: fromWh,
        quantity: -qty,
        value: 0,
        transferId: `${transferId}-${itemId}`,
        isOut: true,
      });
    };

    const pushIn = (itemId, toWh, qty) => {
      if (whIdStr && (!toWh || toWh.toString() !== whIdStr)) return;
      movements.push({
        date: postDate,
        itemId,
        warehouseId: toWh,
        quantity: qty,
        value: 0,
        transferId: `${transferId}-${itemId}`,
        isOut: false,
      });
    };

    if (doc.isProductionOrderReq && doc.rawMaterials?.length) {
      for (const rm of doc.rawMaterials) {
        if (!rm.rawMaterialId) continue;
        const qty = Number(rm.productionOrderRequiredUnit) || 0;
        if (qty <= 0) continue;
        pushOut(rm.rawMaterialId, doc.fromWarehouseId, qty);
        pushIn(rm.rawMaterialId, doc.toWarehouseId, qty);
      }
    } else if (doc.itemId) {
      const qty = Number(doc.quantity) || 0;
      if (qty <= 0) continue;
      pushOut(doc.itemId, doc.fromWarehouseId, qty);
      pushIn(doc.itemId, doc.toWarehouseId, qty);
    }
  }

  // ── adjustments ──
  for (const doc of adjustments) {
    const postDate = doc.adjustmentDate ? new Date(doc.adjustmentDate) : null;
    if (!postDate) continue;

    for (const it of doc.items || []) {
      const adj = it.adjustedStock ?? Number(it.updatedStock || 0) - Number(it.currentStock || 0);
      if (!adj) continue;

      movements.push({
        date: postDate,
        itemId: it.itemId,
        warehouseId: doc.warehouseId,
        branchId: doc.branchId,
        quantity: adj,
        value: 0,
      });
    }
  }

  // ── production orders — batch warehouse lookup ──
  const whIdsNeeded = new Set();
  for (const order of orders) {
    if (order.inventoryInwarehouseId && !order.branchId) {
      whIdsNeeded.add(order.inventoryInwarehouseId.toString());
    }
  }

  const warehouseBranchMap = new Map();
  if (whIdsNeeded.size) {
    const whDocs = await Warehouse.find({
      _id: { $in: [...whIdsNeeded].map(id => new mongoose.Types.ObjectId(id)) },
    })
      .select('branchId')
      .lean();

    for (const wh of whDocs) {
      warehouseBranchMap.set(wh._id.toString(), wh.branchId);
    }
  }

  for (const order of orders) {
    const postDate = order.updatedAt ? new Date(order.updatedAt) : null;
    if (!postDate) continue;

    let fgBranchId = order.branchId;
    const invWh = order.inventoryInwarehouseId;

    if (invWh && !fgBranchId) {
      fgBranchId = warehouseBranchMap.get(invWh.toString());
    }

    // raw material consumption: used + rejected leave stock; returned material never left, so no movement
    for (const rm of order.rawMaterials || []) {
      const submitted = Number(rm.productionOrderSubmittedUnit) || 0;
      const reject = Number(rm.rejectQty) || 0;
      const consumed = submitted + reject;

      if (consumed > 0) {
        movements.push({
          date: postDate,
          itemId: rm.rawMaterialId,
          warehouseId: order.productionWarehouseId,
          branchId: order.branchId,
          quantity: -consumed,
          value: consumed * (rm.rate || 0),
        });
      }
    }

    // finished goods
    const fgQty = order.batches?.reduce((s, b) => s + (b.quantity || 0), 0) || order.totalFgSubmittedQty || 0;

    if (order.itemId && fgQty > 0) {
      movements.push({
        date: postDate,
        itemId: order.itemId,
        warehouseId: invWh,
        branchId: fgBranchId,
        quantity: fgQty,
        value: 0,
      });
    }
  }

  // ── compute opening / closing from sorted movements ──
  if (!movements.length) {
    return { totalOpeningStockAmount: 0, totalClosingStockAmount: 0 };
  }

  const start = new Date(startDate);
  const end = effectivePeriodEnd;

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return { totalOpeningStockAmount: 0, totalClosingStockAmount: 0 };
  }

  start.setHours(0, 0, 0, 0);
  const dayBeforeStart = new Date(start);
  dayBeforeStart.setDate(dayBeforeStart.getDate() - 1);
  dayBeforeStart.setHours(23, 59, 59, 999);

  const balances = new Map();
  const transferOutValues = new Map();

  let openingTotal = 0;
  let closingTotal = 0;
  let openingCaptured = false;
  let closingCaptured = false;

  const getKey = (itemId, warehouseId) => `${itemId || ''}_${warehouseId || ''}`;
  const sumBalances = () => {
    let t = 0;
    balances.forEach(v => (t += v.value));
    return t;
  };

  movements.sort((a, b) => {
    const diff = a.date - b.date;
    if (diff !== 0) return diff;
    return (a.isOut ? 0 : 1) - (b.isOut ? 0 : 1);
  });

  for (const m of movements) {
    const postDate = new Date(m.date);
    if (Number.isNaN(postDate)) continue;

    if (!openingCaptured && postDate > dayBeforeStart) {
      openingTotal = sumBalances();
      openingCaptured = true;
    }

    if (postDate > end) {
      if (!closingCaptured) {
        closingTotal = sumBalances();
        closingCaptured = true;
      }
      continue;
    }

    const key = getKey(m.itemId, m.warehouseId);
    let balance = balances.get(key);
    if (!balance) {
      balance = { qty: 0, value: 0 };
      balances.set(key, balance);
    }

    const qty = Number(m.quantity) || 0;

    if (qty > 0) {
      let value = Number(m.value) || 0;
      if (m.transferId && !m.isOut) value = transferOutValues.get(m.transferId) || 0;
      balance.qty += qty;
      balance.value += value;
    } else {
      const outQty = -qty;
      const avgCost = balance.qty > 0 ? balance.value / balance.qty : 0;
      const value = outQty * avgCost;
      if (m.transferId && m.isOut) transferOutValues.set(m.transferId, value);
      balance.qty -= outQty;
      balance.value -= value;
      if (balance.qty < 0) balance.qty = 0;
      if (balance.value < 0) balance.value = 0;
    }
  }

  if (!openingCaptured) openingTotal = sumBalances();
  if (!closingCaptured) closingTotal = sumBalances();

  return {
    totalOpeningStockAmount: round(openingTotal),
    totalClosingStockAmount: round(closingTotal),
  };
};

const getProfitLossReport = async (companyId, filter) => {
  const { loc, dateFilter } = buildLocDateFilters(filter);

  const { AccountBill, AccountInvoice, AccountExpense, AccountPaymentReceived, Account } = getBooksModels();

  const buildAmountPipeline = (Model, dateField, ledgerField, amountExpression, statusFilter, sections) =>
    Model.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
          ...(dateFilter && Object.keys(dateFilter).length ? { [dateField]: dateFilter } : {}),
          ...(statusFilter || {}),
          ...loc,
        },
      },
      // Party account fallback came from the deprecated BusinessAccountLedgerMaster; AccountLedger has no accountId.
      // {
      //   $lookup: {
      //     from: BusinessAccountLedgerMaster.collection.name,
      //     localField: ledgerField,
      //     foreignField: '_id',
      //     as: 'ledger',
      //   },
      // },
      // { $unwind: { path: '$ledger', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          // effectiveAccountId: { $ifNull: ['$accountId', '$ledger.accountId'] },
          effectiveAccountId: '$accountId',
          calcAmount: amountExpression,
        },
      },
      { $match: { effectiveAccountId: { $ne: null } } },
      {
        $lookup: {
          from: Account.collection.name,
          localField: 'effectiveAccountId',
          foreignField: '_id',
          as: 'account',
        },
      },
      { $unwind: '$account' },
      {
        $match: {
          'account.category': {
            $in: sections.flatMap(section => REPORT_CATEGORIES_BY_SECTION[section] || []),
          },
        },
      },
      {
        $group: {
          _id: { accountId: '$effectiveAccountId', category: '$account.category' },
          amount: { $sum: '$calcAmount' },
        },
      },
    ]);

  const [accounts, purchaseRows, salesRows, expenseRows, incomeRows] = await Promise.all([
    getAccountsByCompany(companyId),

    buildAmountPipeline(
      AccountBill,
      'billDate',
      'vendor',
      {
        $add: [{ $ifNull: ['$subTotal', 0] }, { $sum: { $ifNull: ['$additionalCharges.amount', []] } }],
      },
      { status: { $nin: [ACCOUNT_BILL_STATUSES.DRAFT, ACCOUNT_BILL_STATUSES.CANCELLED] } },
      [REPORT_SECTIONS.PURCHASE_ACCOUNT],
    ),

    buildAmountPipeline(
      AccountInvoice,
      'invoiceDate',
      'customerId',
      {
        $add: [{ $ifNull: ['$subTotal', 0] }, { $sum: { $ifNull: ['$additionalCharges.amount', []] } }],
      },
      { status: { $nin: [SALES_ORDER_INVOICE_STATUS.DRAFT, SALES_ORDER_INVOICE_STATUS.CANCELLED] } },
      [REPORT_SECTIONS.SALES_ACCOUNT],
    ),

    buildAmountPipeline(AccountExpense, 'date', 'customer', { $ifNull: ['$amount', 0] }, null, [
      REPORT_SECTIONS.DIRECT_EXPENSE,
      REPORT_SECTIONS.INDIRECT_EXPENSE,
    ]),

    buildAmountPipeline(
      AccountPaymentReceived,
      'paymentDate',
      'customerId',
      { $ifNull: ['$amountReceived', 0] },
      { status: PAYMENT_STATUS.APPROVED },
      [REPORT_SECTIONS.DIRECT_INCOME, REPORT_SECTIONS.INDIRECT_INCOME],
    ),
  ]);

  const toMap = (rows, section) => {
    const m = new Map();
    for (const r of rows) {
      if (sectionOfCategory(r._id.category) === section) m.set(r._id.accountId.toString(), r.amount);
    }
    return m;
  };

  const bySection = {};
  for (const a of accounts) {
    const section = sectionOfCategory(a.category);
    if (!section) continue;
    if (!bySection[section]) bySection[section] = [];
    bySection[section].push(a);
  }

  const g = section => bySection[section] || [];

  return {
    purchaseAccounts: buildAccountTree(
      g(REPORT_SECTIONS.PURCHASE_ACCOUNT),
      toMap(purchaseRows, REPORT_SECTIONS.PURCHASE_ACCOUNT),
    ),
    directExpenses: buildAccountTree(g(REPORT_SECTIONS.DIRECT_EXPENSE), toMap(expenseRows, REPORT_SECTIONS.DIRECT_EXPENSE)),
    indirectExpenses: buildAccountTree(g(REPORT_SECTIONS.INDIRECT_EXPENSE), toMap(expenseRows, REPORT_SECTIONS.INDIRECT_EXPENSE)),
    salesAccounts: buildAccountTree(g(REPORT_SECTIONS.SALES_ACCOUNT), toMap(salesRows, REPORT_SECTIONS.SALES_ACCOUNT)),
    directIncomes: buildAccountTree(g(REPORT_SECTIONS.DIRECT_INCOME), toMap(incomeRows, REPORT_SECTIONS.DIRECT_INCOME)),
    indirectIncomes: buildAccountTree(g(REPORT_SECTIONS.INDIRECT_INCOME), toMap(incomeRows, REPORT_SECTIONS.INDIRECT_INCOME)),
  };
};

const getProfitLossSheet = async filter => {
  const { companyId, startDate, endDate } = filter;

  const emptyResult = {
    summary: { totalOpeningStockAmount: 0, totalClosingStockAmount: 0 },
    purchaseAccounts: [],
    directExpenses: [],
    indirectExpenses: [],
    salesAccounts: [],
    directIncomes: [],
    indirectIncomes: [],
  };

  if (!companyId || !endDate) return emptyResult;

  // Run both independent data fetches in parallel
  const [summary, pnlData] = await Promise.all([
    getStockSummary(filter, startDate, endDate).catch(() => ({
      totalOpeningStockAmount: 0,
      totalClosingStockAmount: 0,
    })),
    getProfitLossReport(companyId, filter).catch(() => ({
      purchaseAccounts: [],
      directExpenses: [],
      indirectExpenses: [],
      salesAccounts: [],
      directIncomes: [],
      indirectIncomes: [],
    })),
  ]);

  return {
    summary,
    purchaseAccounts: pnlData.purchaseAccounts,
    directExpenses: pnlData.directExpenses,
    indirectExpenses: pnlData.indirectExpenses,
    salesAccounts: pnlData.salesAccounts,
    directIncomes: pnlData.directIncomes,
    indirectIncomes: pnlData.indirectIncomes,
  };
};

module.exports = {
  getLedgerReport,
  invoiceBarGraph,
  invoiceBarGraphDetail,
  billBarGraph,
  billBarGraphDetail,
  creditorsReport,
  debtorsReport,
  queryBankHistories,
  itemModulewiseDetails,
  getProfitLossSheet,
  getBalanceSheetSummary,
};
