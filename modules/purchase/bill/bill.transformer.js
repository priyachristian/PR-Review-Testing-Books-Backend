const commonTransformers = require('../../../transformers/common.transformer');

const billTransformers = {
  queryBill: bills => {
    const transformedBills = bills.map(q => {
      // Convert Mongoose document to plain object if needed
      const billObj = q.toObject ? q.toObject() : q;

      const transformedBill = commonTransformers.querySalesDocuments(billObj, { partyKey: 'vendor' });

      return {
        ...transformedBill,
        addressId: billObj.addressId?.toString() || '',
        addressIn: billObj.addressIn || null,
        billId: billObj.billId || '',
        billDate: billObj.billDate || '',
        dueDate: billObj.dueDate || '-',
        paidAmount: billObj.paidAmount,
        balanceAmount: billObj.balanceAmount,
        createdAt: billObj.createdAt.toISOString(),
        updatedAt: billObj.updatedAt.toISOString(),
        paymentTermsId: billObj?.paymentTermsId || null,
        splitBillId: billObj?.splitBillId || null,
        splitWarehouseId: billObj?.splitWarehouseId || null,
        splitBillNo: billObj?.splitBillNo || null,
        openingBalanceApplications: billObj.openingBalanceApplications || [],
        addedBy: `${billObj.addedBy?.firstName || ''} ${billObj.addedBy?.lastName || ''}`,
        updatedBy: `${billObj.updatedBy?.firstName || ''} ${billObj.updatedBy?.lastName || ''}`,
        payments: billObj.payments || [],
      };
    });
    return transformedBills;
  },
};

module.exports = billTransformers;
