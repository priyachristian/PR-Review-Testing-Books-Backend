const commonTransformers = require('../../../transformers/common.transformer');
const { PO_STATUSES } = require('../../../utils/enum');

const purchaseOrderTransformers = {
  queryPurchaseOrders: purchaseOrders => {
    const transformedPurchaseOrders = purchaseOrders.map(q => {
      // Convert Mongoose document to plain object if needed
      const purchaseOrderObj = q.toObject ? q.toObject() : q;

      const transformedPurchaseOrder = commonTransformers.querySalesDocuments(purchaseOrderObj, { partyKey: 'vendor' });
      const statusFields = {};
      const includeStatuses = [PO_STATUSES.ACCEPTED, PO_STATUSES.PARTIALLY_RECORDED];

      if (includeStatuses.includes(purchaseOrderObj.status)) {
        Object.assign(statusFields, {
          warehouseId: purchaseOrderObj.warehouseId?._id?.toString() || '',
          branchId: purchaseOrderObj.branchId?._id?.toString() || '',
          divisionId: purchaseOrderObj.divisionId?._id?.toString() || '',
          items: purchaseOrderObj.items || [],
          cgst: purchaseOrderObj.cgst || '',
          sgst: purchaseOrderObj.sgst || '',
          igst: purchaseOrderObj.igst || '',
          totalTax: purchaseOrderObj.totalTax || '',
          additionalCharges: purchaseOrderObj.additionalCharges || '',
          roundOffAmount: purchaseOrderObj.roundOffAmount ?? 0,
          isRoundOff: purchaseOrderObj.isRoundOff ?? true,
        });
      }
      const vendor = purchaseOrderObj.vendor || {};
      return {
        ...transformedPurchaseOrder,
        addressId: purchaseOrderObj.addressId?.toString() || '',
        addressIn: purchaseOrderObj.addressIn || null,
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
        subTotal: purchaseOrderObj.subTotal || '',
        purchaseOrderId: purchaseOrderObj.purchaseOrderId || '',
        date: purchaseOrderObj.date || '',
        deliveryDate: purchaseOrderObj.deliveryDate || '-',
        paymentTermsId: purchaseOrderObj.paymentTermsId || null,
        createdAt: purchaseOrderObj.createdAt.toISOString(),
        updatedAt: purchaseOrderObj.updatedAt.toISOString(),
        addedBy: `${purchaseOrderObj.addedBy?.firstName || ''} ${purchaseOrderObj.addedBy?.lastName || ''}`,
        updatedBy: `${purchaseOrderObj.updatedBy?.firstName || ''} ${purchaseOrderObj.updatedBy?.lastName || ''}`,
        grpos: purchaseOrderObj.grpos || [],
        bills: purchaseOrderObj.bills || [],
      };
    });
    return transformedPurchaseOrders;
  },
};

module.exports = purchaseOrderTransformers;
