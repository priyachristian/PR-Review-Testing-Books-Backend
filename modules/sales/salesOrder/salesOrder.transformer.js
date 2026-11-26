const commonTransformers = require('../../../transformers/common.transformer');
const { SALES_ORDER_STATUS } = require('../../../utils/enum');
const { resolveCustomerPaymentTermsId } = require('../../../utils/customerPaymentTerms');

const salesTransformers = {
  querySales: salesOrders => {
    const transformedSalesOrders = salesOrders.map(q => {
      // Convert Mongoose document to plain object if needed
      const salesObj = q.toObject ? q.toObject() : q;

      const transformedSo = commonTransformers.querySalesDocuments(salesObj, { partyKey: 'customerId' });
      const statusFields = {};
      const includeStatuses = [SALES_ORDER_STATUS.OPEN, SALES_ORDER_STATUS.PARTIALLY_RECORDED];

      if (includeStatuses.includes(salesObj.status)) {
        Object.assign(statusFields, {
          warehouseId: salesObj.warehouseId?._id?.toString() || '',
          branchId: salesObj.branchId?._id?.toString() || '',
          divisionId: salesObj.divisionId?._id?.toString() || '',
          items: salesObj.items || [],
          cgst: salesObj.cgst || '',
          sgst: salesObj.sgst || '',
          igst: salesObj.igst || '',
          subTotal: salesObj.subTotal || '',
          totalTax: salesObj.totalTax || '',
          additionalCharges: salesObj.additionalCharges || '',
          roundOffAmount: salesObj.roundOffAmount ?? 0,
          isRoundOff: salesObj.isRoundOff ?? true,
        });
      }
      return {
        ...transformedSo,
        addressId: salesObj.addressId?.toString() || '',
        addressIn: salesObj.addressIn || null,
        ...statusFields,
        items: salesObj.items || [],
        appName: salesObj.appName ?? null,
        orderId: salesObj.orderId || '',
        subTotal: salesObj.subTotal || '',
        productionOrderStatus: salesObj.productionOrderStatus || '',
        orderDate: salesObj.orderDate || '',
        deliveryMethod: salesObj.deliveryMethod || '',
        paymentTermsId: salesObj.paymentTermsId || resolveCustomerPaymentTermsId(salesObj.customerId, salesObj.branchId?._id),
        expectedShipmentDate: salesObj.expectedShipmentDate || '',
        createdAt: salesObj.createdAt.toISOString(),
        updatedAt: salesObj.updatedAt.toISOString(),
        addedBy: `${salesObj.addedBy?.firstName || ''} ${salesObj.addedBy?.lastName || ''}`,
        updatedBy: `${salesObj.updatedBy?.firstName || ''} ${salesObj.updatedBy?.lastName || ''}`,
        remainingAmount: salesObj?.remainingAmount,
        hasPendingProduction: salesObj?.hasPendingProduction || false,
        tagId: salesObj.tagId?._id?.toString() || '',
        tagName: salesObj?.tagName || '',
        tagColor: salesObj?.tagColor || '',
        deliveryChallans: salesObj.deliveryChallans || [],
        invoices: salesObj.invoices || [],
      };
    });

    return transformedSalesOrders;
  },
};

module.exports = salesTransformers;
