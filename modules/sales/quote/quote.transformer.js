const commonTransformers = require('../../../transformers/common.transformer');

const quoteTransformers = {
  queryQuotes: quotes => {
    const transformedQuotes = quotes.map(q => {
      // Convert Mongoose document to plain object if needed
      const quoteObj = q.toObject ? q.toObject() : q;

      const transformedQuote = commonTransformers.querySalesDocuments(quoteObj, { partyKey: 'customerId' });
      const statusFields = {};
      const includeStatuses = ['ACCEPTED'];

      if (includeStatuses.includes(quoteObj.status)) {
        Object.assign(statusFields, {
          warehouseId: quoteObj.warehouseId?._id?.toString() || '',
          branchId: quoteObj.branchId?._id?.toString() || '',
          divisionId: quoteObj.divisionId?._id?.toString() || '',
          items: quoteObj.items || [],
          cgst: quoteObj.cgst || '',
          sgst: quoteObj.sgst || '',
          igst: quoteObj.igst || '',
          totalTax: quoteObj.totalTax || '',
          additionalCharges: quoteObj.additionalCharges || '',
          roundOffAmount: quoteObj.roundOffAmount ?? 0,
          isRoundOff: quoteObj.isRoundOff ?? true,
        });
      }
      const customer = quoteObj.customerId || {};
      return {
        ...transformedQuote,
        ...statusFields,
        customerId: {
          _id: customer._id?.toString() || '',
          customerDisplayName: customer.customerDisplayName || '',
          gstinUin: customer.otherDetails?.gstinUin || '',
          address: {
            billing: { state: customer.address?.billing?.state || '' },
            shipping: { state: customer.address?.shipping?.state || '' },
          },
        },
        addressId: quoteObj.addressId?.toString() || '',
        addressIn: quoteObj.addressIn || null,
        appName: quoteObj.appName ?? null,
        subTotal: quoteObj.subTotal || '',
        quoteId: quoteObj.quoteId || '',
        quoteDate: quoteObj.quoteDate || '',
        expiryDate: quoteObj.expiryDate || '',
        createdAt: quoteObj.createdAt.toISOString(),
        updatedAt: quoteObj.updatedAt.toISOString(),
        addedBy: `${quoteObj.addedBy?.firstName || ''} ${quoteObj.addedBy?.lastName || ''}`,
        updatedBy: `${quoteObj.updatedBy?.firstName || ''} ${quoteObj.updatedBy?.lastName || ''}`,
        paymentTermsId: quoteObj.paymentTermsId || null,
        invoices: quoteObj.invoices || [],
        salesOrder: quoteObj.salesOrders || [],
      };
    });
    return transformedQuotes;
  },
};

module.exports = quoteTransformers;
