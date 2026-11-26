const mongoose = require('mongoose');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const { OB_PAYMENT_ENTRY_SOURCE, TRANSACTION_TYPE } = require('../../../utils/enum');
const { getCurrency } = require('../../../services/currencyResolver.service');
const {
  isInvoiceCreditLine,
  isBillCreditLine,
  isCreditNoteLine,
  isDebitNoteLine,
  mapById,
  mapByDocNo,
  nestRelatedDoc,
  withPaymentDocumentNo,
} = require('../../../utils/openingBalancePaymentHistoryHelper');

const isObToObCreditMirrorEntry = (txnType, entry, obTransactionNos, cnByDocNo, dnByDocNo) => {
  const isTargetOb = txnType === TRANSACTION_TYPE.OPENING_RECEIVABLE || txnType === TRANSACTION_TYPE.OPENING_PAYABLE;
  if (!isTargetOb) return false;
  const docNo = entry?.paymentDocumentNo ? String(entry.paymentDocumentNo) : '';
  if (!docNo || !obTransactionNos.has(docNo)) return false;
  if (isInvoiceCreditLine(entry, cnByDocNo) && !entry.invoiceId && !entry.invoiceApplicationId) return true;
  if (isBillCreditLine(entry, dnByDocNo) && !entry.billId && !entry.billApplicationId) return true;
  return false;
};

const collectNoteDocNos = (txns, { isReceivedSide }) => {
  const docNos = new Set();
  for (const t of txns) {
    const entries = isReceivedSide ? t.paymentReceivedEntries || [] : t.paymentMadeEntries || [];
    for (const e of entries) {
      if (isReceivedSide) {
        if (e.invoiceId || e.invoiceApplicationId || e.invoiceNo) continue;
        if (e.entrySource && e.entrySource !== OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT) continue;
      } else {
        if (e.billId || e.billApplicationId || e.billNo) continue;
        if (e.entrySource && e.entrySource !== OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT) continue;
      }
      if (e.paymentDocumentNo) docNos.add(String(e.paymentDocumentNo));
    }
  }
  return docNos;
};

const collectRelatedIds = txns => {
  const invIds = new Set();
  const invNos = new Set();
  const billIds = new Set();
  const billNos = new Set();
  const paymentReceivedIds = new Set();
  const paymentMadeIds = new Set();

  for (const t of txns) {
    for (const e of t.paymentReceivedEntries || []) {
      if (e.invoiceId) invIds.add(e.invoiceId.toString());
      else if (e.invoiceNo) invNos.add(String(e.invoiceNo));
      else if (e.paymentDocumentNo) invNos.add(String(e.paymentDocumentNo));
      if (e.paymentReceivedId) paymentReceivedIds.add(e.paymentReceivedId.toString());
    }
    for (const e of t.paymentMadeEntries || []) {
      if (e.billId) billIds.add(e.billId.toString());
      else if (e.billNo) billNos.add(String(e.billNo));
      else if (e.paymentDocumentNo) billNos.add(String(e.paymentDocumentNo));
      if (e.paymentMadeId) paymentMadeIds.add(e.paymentMadeId.toString());
    }
  }

  return {
    invIds,
    invNos,
    billIds,
    billNos,
    paymentReceivedIds,
    paymentMadeIds,
    cnDocNos: collectNoteDocNos(txns, { isReceivedSide: true }),
    dnDocNos: collectNoteDocNos(txns, { isReceivedSide: false }),
  };
};

const findRelated = (Model, { ids, docNos, docNoField, companyObjectId, select }) => {
  const idSet = ids?.size ? ids : null;
  const noSet = docNos?.size && docNoField ? docNos : null;
  if (!idSet && !noSet) return Promise.resolve([]);
  return Model.find({
    companyId: companyObjectId,
    $or: [...(idSet ? [{ _id: { $in: [...idSet] } }] : []), ...(noSet ? [{ [docNoField]: { $in: [...noSet] } }] : [])],
  })
    .select(select)
    .lean();
};

const loadRelatedDocs = async (txns, companyObjectId) => {
  const { Invoice, Bill, PaymentMade, CreditNote, DebitNote } = getBooksModels();
  const { PaymentReceived } = getBooksCrmModels();
  const ids = collectRelatedIds(txns);

  const [invDocs, billDocs, prDocs, pmDocs, cnDocs, dnDocs] = await Promise.all([
    findRelated(Invoice, {
      ids: ids.invIds,
      docNos: ids.invNos,
      docNoField: 'invoiceId',
      companyObjectId,
      select: '_id invoiceId status',
    }),
    findRelated(Bill, {
      ids: ids.billIds,
      docNos: ids.billNos,
      docNoField: 'billId',
      companyObjectId,
      select: '_id billId status',
    }),
    findRelated(PaymentReceived, {
      ids: ids.paymentReceivedIds,
      companyObjectId,
      select: '_id paymentReceivedId status',
    }),
    findRelated(PaymentMade, {
      ids: ids.paymentMadeIds,
      companyObjectId,
      select: '_id paymentMadeId status',
    }),
    findRelated(CreditNote, {
      docNos: ids.cnDocNos,
      docNoField: 'creditNoteId',
      companyObjectId,
      select: '_id creditNoteId status',
    }),
    findRelated(DebitNote, {
      docNos: ids.dnDocNos,
      docNoField: 'debitNoteId',
      companyObjectId,
      select: '_id debitNoteId status',
    }),
  ]);

  return {
    invById: mapById(invDocs),
    invByNo: mapByDocNo(invDocs, 'invoiceId'),
    billById: mapById(billDocs),
    billByNo: mapByDocNo(billDocs, 'billId'),
    prById: mapById(prDocs),
    pmById: mapById(pmDocs),
    cnByDocNo: mapByDocNo(cnDocs, 'creditNoteId'),
    dnByDocNo: mapByDocNo(dnDocs, 'debitNoteId'),
  };
};

const resolveInvoice = (raw, docs) => {
  if (raw.invoiceId) return docs.invById.get(raw.invoiceId.toString()) || null;
  if (raw.invoiceNo) return docs.invByNo.get(String(raw.invoiceNo)) || null;
  if (raw.paymentDocumentNo) return docs.invByNo.get(String(raw.paymentDocumentNo)) || null;
  return null;
};

const resolveBill = (raw, docs) => {
  if (raw.billId) return docs.billById.get(raw.billId.toString()) || null;
  if (raw.billNo) return docs.billByNo.get(String(raw.billNo)) || null;
  if (raw.paymentDocumentNo) return docs.billByNo.get(String(raw.paymentDocumentNo)) || null;
  return null;
};

const resolveNoteByDocNo = (raw, byDocNo) => {
  if (!raw.paymentDocumentNo) return null;
  return byDocNo.get(String(raw.paymentDocumentNo)) || null;
};

const buildHistoryRow = ({ branch, currency, txn, side, relatedDocumentStatus, entry }) => ({
  branch,
  currency,
  openingBalanceTransactionId: txn._id,
  transactionNo: txn.transactionNo ?? null,
  obType: txn.type,
  side,
  relatedDocumentStatus,
  entry,
});

const entryBase = raw => ({
  _id: raw._id,
  appliedDate: raw.appliedDate,
  amountApplied: raw.amountApplied,
});

const mapReceivedEntry = (raw, txn, ctx) => {
  const { obTransactionNos, cnByDocNo, dnByDocNo, branch, currency, docs } = ctx;
  if (isObToObCreditMirrorEntry(txn.type, raw, obTransactionNos, cnByDocNo, dnByDocNo)) return null;

  const side = 'payment_received';
  const base = entryBase(raw);

  if (isCreditNoteLine(raw, cnByDocNo)) {
    const creditNote = resolveNoteByDocNo(raw, docs.cnByDocNo);
    const displayNo = creditNote?.creditNoteId ?? raw.paymentDocumentNo ?? null;
    return buildHistoryRow({
      branch,
      currency,
      txn,
      side,
      relatedDocumentStatus: creditNote?.status ?? null,
      entry: {
        ...base,
        entrySource: raw.entrySource || OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT,
        ...nestRelatedDoc('creditNote', 'creditNoteId', displayNo, creditNote?._id),
        ...withPaymentDocumentNo(raw),
      },
    });
  }

  if (isInvoiceCreditLine(raw, cnByDocNo)) {
    const inv = resolveInvoice(raw, docs);
    const displayNo = inv?.invoiceId ?? raw.invoiceNo ?? raw.paymentDocumentNo ?? null;
    const refId = inv?._id ?? raw.invoiceId ?? null;
    return buildHistoryRow({
      branch,
      currency,
      txn,
      side,
      relatedDocumentStatus: inv?.status ?? null,
      entry: {
        ...base,
        entrySource: raw.entrySource || OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT,
        ...nestRelatedDoc('invoice', 'invoiceId', displayNo, refId),
        ...withPaymentDocumentNo(raw),
      },
    });
  }

  const prDoc = raw.paymentReceivedId ? docs.prById.get(raw.paymentReceivedId.toString()) : null;
  const displayNo = prDoc?.paymentReceivedId ?? raw.paymentDocumentNo ?? null;
  return buildHistoryRow({
    branch,
    currency,
    txn,
    side,
    relatedDocumentStatus: prDoc?.status ?? null,
    entry: {
      ...base,
      entrySource: raw.entrySource || OB_PAYMENT_ENTRY_SOURCE.PAYMENT_RECEIVED,
      ...nestRelatedDoc('paymentReceived', 'paymentReceivedId', displayNo, prDoc?._id ?? raw.paymentReceivedId),
    },
  });
};

const mapMadeEntry = (raw, txn, ctx) => {
  const { obTransactionNos, cnByDocNo, dnByDocNo, branch, currency, docs } = ctx;
  if (isObToObCreditMirrorEntry(txn.type, raw, obTransactionNos, cnByDocNo, dnByDocNo)) return null;

  const side = 'payment_made';
  const base = entryBase(raw);

  if (isDebitNoteLine(raw, dnByDocNo)) {
    const debitNote = resolveNoteByDocNo(raw, docs.dnByDocNo);
    const displayNo = debitNote?.debitNoteId ?? raw.paymentDocumentNo ?? null;
    return buildHistoryRow({
      branch,
      currency,
      txn,
      side,
      relatedDocumentStatus: debitNote?.status ?? null,
      entry: {
        ...base,
        entrySource: raw.entrySource || OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT,
        ...nestRelatedDoc('debitNote', 'debitNoteId', displayNo, debitNote?._id),
        ...withPaymentDocumentNo(raw),
      },
    });
  }

  if (isBillCreditLine(raw, dnByDocNo)) {
    const bill = resolveBill(raw, docs);
    const displayNo = bill?.billId ?? raw.billNo ?? raw.paymentDocumentNo ?? null;
    const refId = bill?._id ?? raw.billId ?? null;
    return buildHistoryRow({
      branch,
      currency,
      txn,
      side,
      relatedDocumentStatus: bill?.status ?? null,
      entry: {
        ...base,
        entrySource: raw.entrySource || OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT,
        ...nestRelatedDoc('bill', 'billId', displayNo, refId),
        ...withPaymentDocumentNo(raw),
      },
    });
  }

  const pmDoc = raw.paymentMadeId ? docs.pmById.get(raw.paymentMadeId.toString()) : null;
  const displayNo = pmDoc?.paymentMadeId ?? raw.paymentDocumentNo ?? null;
  return buildHistoryRow({
    branch,
    currency,
    txn,
    side,
    relatedDocumentStatus: pmDoc?.status ?? null,
    entry: {
      ...base,
      entrySource: raw.entrySource || OB_PAYMENT_ENTRY_SOURCE.PAYMENT_MADE,
      ...nestRelatedDoc('paymentMade', 'paymentMadeId', displayNo, pmDoc?._id ?? raw.paymentMadeId),
    },
  });
};

async function getOpeningBalanceTransactionHistory(contactId, companyId, contactType) {
  const { OpeningBalanceTransaction, Branch } = getBooksCrmModels();

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const contactObjectId = new mongoose.Types.ObjectId(contactId);

  const txns = await OpeningBalanceTransaction.find({
    contactId: contactObjectId,
    companyId: companyObjectId,
    contactType,
  })
    .sort({ date: -1 })
    .lean();

  const branchIds = [
    ...new Set(
      txns
        .map(t => t.branchId)
        .filter(Boolean)
        .map(id => id.toString()),
    ),
  ];
  const branches = branchIds.length
    ? await Branch.find({
        _id: { $in: branchIds.map(id => new mongoose.Types.ObjectId(id)) },
        companyId: companyObjectId,
      })
        .select('name')
        .lean()
    : [];
  const branchById = mapById(branches);

  const docs = await loadRelatedDocs(txns, companyObjectId);

  const currencies = await getCurrency(
    companyId,
    txns.map(txn => txn.currency),
  );
  const currencyMap = new Map(currencies.map(c => [String(c._id), c]));
  const obTransactionNos = new Set(
    txns
      .map(t => t.transactionNo)
      .filter(Boolean)
      .map(String),
  );

  const flatHistory = [];

  for (const txn of txns) {
    const branch = txn.branchId ? { _id: txn.branchId, name: branchById.get(txn.branchId.toString())?.name ?? null } : null;
    const currency = currencyMap.get(String(txn.currency)) || null;
    const ctx = {
      obTransactionNos,
      cnByDocNo: docs.cnByDocNo,
      dnByDocNo: docs.dnByDocNo,
      branch,
      currency,
      docs,
    };

    for (const raw of txn.paymentReceivedEntries || []) {
      const row = mapReceivedEntry(raw, txn, ctx);
      if (row) flatHistory.push(row);
    }
    for (const raw of txn.paymentMadeEntries || []) {
      const row = mapMadeEntry(raw, txn, ctx);
      if (row) flatHistory.push(row);
    }
  }

  flatHistory.sort((a, b) => new Date(b.entry.appliedDate || 0) - new Date(a.entry.appliedDate || 0));

  return { flatHistory };
}

module.exports = {
  getOpeningBalanceTransactionHistory,
};
