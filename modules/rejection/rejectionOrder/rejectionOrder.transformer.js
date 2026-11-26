const rejectionOrderTransformers = {
  queryRejectionOrders: orders =>
    (orders || []).map(order => {
      const obj = order.toObject ? order.toObject() : order;
      const items = obj.items || [];

      return {
        _id: obj._id?.toString(),
        rejectionOrderId: obj.rejectionOrderId,
        status: obj.status,
        customerDisplayName: obj.customerId?.customerDisplayName || obj.customerId?.companyName || '',
        branchName: obj.branchId?.name || '',
        divisionName: obj.divisionId?.name || '',
        warehouseName: obj.warehouseId?.name || '',
        address: obj.address || {},
        arrivalDate: obj.arrivalDate || null,
        createdAt: obj.createdAt,
        addedBy: [obj.addedBy?.firstName, obj.addedBy?.lastName].filter(Boolean).join(' ').trim(),
        itemsCount: items.length,
        totalPc: items.reduce((sum, item) => sum + (item.bookedQty || 0), 0),
      };
    }),
};

module.exports = rejectionOrderTransformers;
