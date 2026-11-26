const reportTransformer = {
  invoiceBarGraphDetail: invoices => {
    return invoices.map(invoice => ({
      id: invoice.id || invoice._id?.toString() || '',
      invoiceDate: invoice.invoiceDate || null,
      customerDisplayName: invoice.customerId?.customerDisplayName || '',
      invoiceId: invoice.invoiceId || '',
      total: invoice.total || 0,
      credit: null,
    }));
  },
  billBarGraphDetail: bills => {
    return bills.map(bill => ({
      id: bill.id || bill._id?.toString() || '',
      billDate: bill.billDate || null,
      customerDisplayName: bill?.vendor?.customerDisplayName || '',
      billId: bill.billId || '',
      total: bill.total || 0,
      debit: null,
    }));
  },
};

module.exports = reportTransformer;
