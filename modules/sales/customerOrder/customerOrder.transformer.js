const { CUSTOMER_ORDER_TYPE } = require('../../../utils/enum');

const customerOrderTransformers = {
  queryCustomerOrders: customerOrders => {
    return customerOrders.map(order => {
      const orderObj = order.toObject ? order.toObject() : order;
      const customer = orderObj.customerId || {};

      return {
        _id: orderObj._id.toString(),
        id: orderObj._id.toString(),
        customerId: customer?._id?.toString() || '',
        customerDisplayName: customer?.customerDisplayName || customer?.companyName || '-',
        customerOrderId: orderObj.customerOrderId || '',
        status: orderObj.status || '',
        orderType: orderObj.sampleCatalogId ? CUSTOMER_ORDER_TYPE.SAMPLE : CUSTOMER_ORDER_TYPE.REGULAR,
        sampleCatalogId: orderObj.sampleCatalogId?.toString() || null,
        catalogCode: orderObj.catalogCode || '',
        catalogName: orderObj.catalogName || '',
        subTotal: orderObj.subTotal || 0,
        total: orderObj.total || 0,
        currency: orderObj.currency || null,
        sgst: orderObj.sgst || 0,
        cgst: orderObj.cgst || 0,
        igst: orderObj.igst || 0,
        totalTax: orderObj.totalTax || 0,
        createdAt: orderObj.createdAt.toISOString(),
        updatedAt: orderObj.updatedAt.toISOString(),
        addedBy: orderObj.addedBy ? `${orderObj.addedBy?.firstName || ''} ${orderObj.addedBy?.lastName || ''}`.trim() : '',
        updatedBy: orderObj.updatedBy
          ? `${orderObj.updatedBy?.firstName || ''} ${orderObj.updatedBy?.lastName || ''}`.trim()
          : '',
      };
    });
  },
};

module.exports = customerOrderTransformers;
