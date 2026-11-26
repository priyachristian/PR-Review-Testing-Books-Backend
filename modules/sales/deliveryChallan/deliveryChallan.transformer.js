const commonTransformers = require('../../../transformers/common.transformer');

const deliveryChallanTransformers = {
  queryDeliveryChallan: deliveryChallan => {
    const transformedDeliveryChallans = deliveryChallan.map(q => {
      // Convert Mongoose document to plain object if needed
      const deliveryChallanObj = q.toObject ? q.toObject() : q;
      const statusFields = {};
      const includeStatuses = ['SENT'];

      if (includeStatuses.includes(deliveryChallanObj.status)) {
        Object.assign(statusFields, {
          warehouseId: deliveryChallanObj.warehouseId?._id?.toString() || '',
          branchId: deliveryChallanObj.branchId?._id?.toString() || '',
          divisionId: deliveryChallanObj.divisionId?._id?.toString() || '',
          items: deliveryChallanObj.items || [],
          cgst: deliveryChallanObj.cgst || '',
          sgst: deliveryChallanObj.sgst || '',
          igst: deliveryChallanObj.igst || '',
          totalTax: deliveryChallanObj.totalTax || '',
          additionalCharges: deliveryChallanObj.additionalCharges || '',
          roundOffAmount: deliveryChallanObj.roundOffAmount ?? 0,
          isRoundOff: deliveryChallanObj.isRoundOff ?? true,
        });
      }

      const transformedDC = commonTransformers.querySalesDocuments(deliveryChallanObj, { partyKey: 'customerId' });

      return {
        ...transformedDC,
        addressId: deliveryChallanObj.addressId?.toString() || '',
        addressIn: deliveryChallanObj.addressIn || null,
        ...statusFields,
        subTotal: deliveryChallanObj.subTotal || '',
        challanId: deliveryChallanObj.challanId || '',
        challanDate: deliveryChallanObj.challanDate || '',
        challanType: deliveryChallanObj.challanType || '',
        createdAt: deliveryChallanObj.createdAt.toISOString(),
        updatedAt: deliveryChallanObj.updatedAt.toISOString(),
        addedBy: `${deliveryChallanObj.addedBy?.firstName || ''} ${deliveryChallanObj.addedBy?.lastName || ''}`,
        updatedBy: `${deliveryChallanObj.updatedBy?.firstName || ''} ${deliveryChallanObj.updatedBy?.lastName || ''}`,
        paymentTermsId: deliveryChallanObj.paymentTermsId || null,
        invoices: deliveryChallanObj.invoices || [],
      };
    });
    return transformedDeliveryChallans;
  },
};

module.exports = deliveryChallanTransformers;
