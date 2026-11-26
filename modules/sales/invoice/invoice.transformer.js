const commonTransformers = require('../../../transformers/common.transformer');

const invoiceTransformers = {
  queryInvoice: invoices => {
    const transformedInvoices = invoices.map(q => {
      // Convert Mongoose document to plain object if needed
      const invoiceObj = q.toObject ? q.toObject() : q;

      const transformedInvoice = commonTransformers.querySalesDocuments(invoiceObj, { partyKey: 'customerId' });

      return {
        ...transformedInvoice,
        addressId: invoiceObj.addressId?.toString() || '',
        addressIn: invoiceObj.addressIn || null,
        invoiceDispatchId: invoiceObj.invoiceDispatchId || '',
        deliveryChallanIds: invoiceObj.deliveryChallanIds || '',
        salesOrders: invoiceObj.salesOrders || '',
        invoiceId: invoiceObj.invoiceId,
        invoiceDate: invoiceObj.invoiceDate || '',
        dueDate: invoiceObj.dueDate || '',
        balanceAmount: invoiceObj.balanceAmount,
        referenceNumber: invoiceObj.referenceNumber || '',
        createdAt: invoiceObj.createdAt.toISOString(),
        updatedAt: invoiceObj.updatedAt.toISOString(),
        paymentTermsId: invoiceObj?.paymentTermsId || null,
        ...(invoiceObj?.orderToInvoiceDays !== undefined && {
          orderToInvoiceDays: invoiceObj.orderToInvoiceDays,
          splitInvoiceId: invoiceObj?.splitInvoiceId || null,
          splitWarehouseId: invoiceObj?.splitWarehouseId || null,
          splitInvoiceNo: invoiceObj?.splitInvoiceNo || null,
        }),
        orderToPaymentDays: invoiceObj?.orderToPaymentDays ?? null,
        // Minimal e-invoice / e-way projection so the list can show a Yes/No indicator per invoice.
        eInvoice: invoiceObj.eInvoice ? { irn: invoiceObj.eInvoice.irn || '', status: invoiceObj.eInvoice.status || '' } : null,
        eWayBill: invoiceObj.eWayBill
          ? { eWayBillNo: invoiceObj.eWayBill.eWayBillNo || '', status: invoiceObj.eWayBill.status || '' }
          : null,
        openingBalanceApplications: invoiceObj.openingBalanceApplications || [],
        payments: invoiceObj.payments || [],
        addedBy: `${invoiceObj.addedBy?.firstName || ''} ${invoiceObj.addedBy?.lastName || ''}`,
        updatedBy: `${invoiceObj.updatedBy?.firstName || ''} ${invoiceObj.updatedBy?.lastName || ''}`,
      };
    });
    return transformedInvoices;
  },
};

module.exports = invoiceTransformers;
