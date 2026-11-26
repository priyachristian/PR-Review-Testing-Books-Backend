const { OB_PAYMENT_ENTRY_SOURCE } = require('./enum');

const obLinesFromPayments = (payments, idPrefix, getPaymentDocumentNo) => {
  const rows = [];
  for (const payment of payments || []) {
    for (const line of payment.openingBalanceTransactions || []) {
      if (!line.openingBalanceTransactionId || line.amountApplied == null || line.amountApplied <= 0) continue;
      const stableId = line._id
        ? line._id.toString()
        : `${idPrefix}-${payment._id}-${line.openingBalanceTransactionId}-${String(line.appliedDate || '')}`;
      rows.push({
        _id: line._id || stableId,
        openingBalanceTransactionId: line.openingBalanceTransactionId,
        transactionNo: line.transactionNo,
        amountApplied: line.amountApplied,
        appliedDate: line.appliedDate,
        paymentDocumentNo: getPaymentDocumentNo(payment),
        sourcePaymentId: payment._id,
        relatedDocumentStatus: payment.status,
      });
    }
  }
  return rows;
};

const obLinesFromPaymentsReceived = payments =>
  obLinesFromPayments(payments, 'pr', p => p.paymentReceivedId).map(r => ({ ...r, paymentNavKind: 'received' }));

const obLinesFromPaymentsMade = payments =>
  obLinesFromPayments(payments, 'pm', p => p.paymentMadeId).map(r => ({ ...r, paymentNavKind: 'made' }));

const enrichObLines = async (rows, getBooksCrmModels) => {
  if (!rows?.length) return [];
  const { OpeningBalanceTransaction } = getBooksCrmModels();
  const ids = [...new Set(rows.map(a => a.openingBalanceTransactionId?.toString()).filter(Boolean))];
  const txns = await OpeningBalanceTransaction.find({ _id: { $in: ids } })
    .select('type transactionNo')
    .lean();
  const txnById = Object.fromEntries(txns.map(t => [t._id.toString(), t]));
  return rows.map(a => {
    const tid = a.openingBalanceTransactionId?.toString();
    const txn = txnById[tid];
    return {
      ...a,
      transactionNo: a.transactionNo || txn?.transactionNo || (tid ? `OB-${tid}` : '-'),
      type: a.type || txn?.type || null,
    };
  });
};

const isCreditNoteLine = (e, cnByDocNo = null) => {
  if (e.invoiceId || e.invoiceApplicationId || e.invoiceNo) return false;
  if (e.entrySource && e.entrySource !== OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT) return false;
  const docNo = e.paymentDocumentNo ? String(e.paymentDocumentNo) : '';
  return Boolean(docNo && cnByDocNo?.has(docNo));
};

const isDebitNoteLine = (e, dnByDocNo = null) => {
  if (e.billId || e.billApplicationId || e.billNo) return false;
  if (e.entrySource && e.entrySource !== OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT) return false;
  const docNo = e.paymentDocumentNo ? String(e.paymentDocumentNo) : '';
  return Boolean(docNo && dnByDocNo?.has(docNo));
};

const isInvoiceCreditLine = (e, cnByDocNo = null) => {
  if (isCreditNoteLine(e, cnByDocNo)) return false;
  return (
    e.entrySource === OB_PAYMENT_ENTRY_SOURCE.INVOICE_CREDIT || Boolean(e.invoiceId || e.invoiceApplicationId || e.invoiceNo)
  );
};

const isBillCreditLine = (e, dnByDocNo = null) => {
  if (isDebitNoteLine(e, dnByDocNo)) return false;
  return e.entrySource === OB_PAYMENT_ENTRY_SOURCE.BILL_CREDIT || Boolean(e.billId || e.billApplicationId || e.billNo);
};

const mapById = docs => new Map((docs || []).map(d => [d._id.toString(), d]));

const mapByDocNo = (docs, noField) => {
  const map = new Map();
  for (const doc of docs || []) {
    const no = doc?.[noField] != null ? String(doc[noField]) : '';
    if (no) map.set(no, doc);
  }
  return map;
};

const nestRelatedDoc = (key, displayField, displayValue, id) => {
  if (!displayValue && !id) return {};
  return {
    [key]: {
      ...(displayValue ? { [displayField]: displayValue } : {}),
      ...(id ? { _id: id } : {}),
    },
  };
};

const withPaymentDocumentNo = raw => (raw.paymentDocumentNo ? { paymentDocumentNo: raw.paymentDocumentNo } : {});

module.exports = {
  obLinesFromPaymentsReceived,
  obLinesFromPaymentsMade,
  enrichObLines,
  isInvoiceCreditLine,
  isBillCreditLine,
  isCreditNoteLine,
  isDebitNoteLine,
  mapById,
  mapByDocNo,
  nestRelatedDoc,
  withPaymentDocumentNo,
};
