const commonTransformers = require('../../../transformers/common.transformer');

const grpoTransformers = {
  queryGrpo: grpos => {
    const transformedGrpos = grpos.map(q => {
      // Convert Mongoose document to plain object if needed
      const grpoObj = q.toObject ? q.toObject() : q;

      const transformedGrpo = commonTransformers.querySalesDocuments(grpoObj, { partyKey: 'vendor' });
      const statusFields = {};
      const includeStatuses = ['RECORDED'];

      if (includeStatuses.includes(grpoObj.status)) {
        Object.assign(statusFields, {
          warehouseId: grpoObj.warehouseId?._id?.toString() || '',
          branchId: grpoObj.branchId?._id?.toString() || '',
          divisionId: grpoObj.divisionId?._id?.toString() || '',
          items: grpoObj.items || [],
          cgst: grpoObj.cgst || '',
          sgst: grpoObj.sgst || '',
          igst: grpoObj.igst || '',
          totalTax: grpoObj.totalTax || '',
          additionalCharges: grpoObj.additionalCharges || '',
          roundOffAmount: grpoObj.roundOffAmount ?? 0,
          isRoundOff: grpoObj.isRoundOff ?? true,
        });
      }
      const vendor = grpoObj.vendor || {};
      return {
        ...transformedGrpo,
        addressId: grpoObj.addressId?.toString() || '',
        addressIn: grpoObj.addressIn || null,
        ...statusFields,
        vendor: {
          _id: vendor._id?.toString() || '',
          customerDisplayName: vendor.customerDisplayName || '',
          gstinUin: vendor.otherDetails?.gstinUin || '',
          address: {
            billing: { state: vendor.address?.billing?.state || '' },
            shipping: { state: vendor.address?.shipping?.state || '' },
          },
        },
        subTotal: grpoObj.subTotal || '',
        grpoOrderId: grpoObj.grpoOrderId || '',
        date: grpoObj.date || '',
        dueDate: grpoObj.dueDate || '-',
        paymentTermsId: grpoObj.paymentTermsId || null,
        createdAt: grpoObj.createdAt.toISOString(),
        updatedAt: grpoObj.updatedAt.toISOString(),
        addedBy: `${grpoObj.addedBy?.firstName || ''} ${grpoObj.addedBy?.lastName || ''}`,
        updatedBy: `${grpoObj.updatedBy?.firstName || ''} ${grpoObj.updatedBy?.lastName || ''}`,
        bills: grpoObj.bills || [],
      };
    });
    return transformedGrpos;
  },
};

module.exports = grpoTransformers;
