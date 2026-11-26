const paymentMadeTransformers = {
  getPaymentMades: (payments, isSplit) => {
    const transformedPayments = payments.map(q => {
      // Convert Mongoose document to plain object if needed
      const paymentObj = q.toObject ? q.toObject() : q;

      return {
        _id: paymentObj._id || '',
        id: paymentObj._id.toString(),
        companyId: paymentObj.companyId || '',
        paymentDate: paymentObj.paymentDate,
        depositDate: paymentObj.depositDate || '',
        clearingDate: paymentObj.clearingDate || '',
        chequeStatus: paymentObj.chequeStatus || '',
        chequeApprovalNote: paymentObj.chequeApprovalNote || '',
        paymentMode: paymentObj.paymentMode,
        status: paymentObj.status,
        availableBalance: paymentObj.unusedAmount ?? 0,
        unusedAmount: paymentObj.unusedAmount ?? 0,
        pdcChequeDate: paymentObj.pdcChequeDate || '',
        paidThroughAccountName: paymentObj?.paidThroughAccountId?.accountName || '',
        paidThroughAccountId: paymentObj?.paidThroughAccountId?._id || '',
        vendorId: paymentObj?.vendorId?._id?.toString() || '',
        paymentMade: paymentObj.paymentMade || '',
        paymentMadeId: paymentObj.paymentMadeId || '',
        customerDisplayName: paymentObj?.vendorId?.customerDisplayName || '',
        currency: paymentObj.currency || null,
        createdAt: paymentObj.createdAt.toISOString(),
        updatedAt: paymentObj.updatedAt.toISOString(),
        divisionName: paymentObj.divisionId?.name || '',
        branchName: paymentObj.branchId?.name || '',
        warehouseName: paymentObj.warehouseId?.name || '',
        reference: paymentObj.reference || '',
        notes: paymentObj.notes || '',
        approvalNote: paymentObj.approvalNote || '',
        paymentMadeType: paymentObj.isAdvancePayment ? 'Advance' : 'Bill',
        ...(isSplit && {
          isSplit: paymentObj?.isSplit,
        }),
        branchId: paymentObj.branchId?._id?.toString() || '',
        addedBy: `${paymentObj.addedBy?.firstName || ''} ${paymentObj.addedBy?.lastName || ''}`,
        updatedBy: `${paymentObj.updatedBy?.firstName || ''} ${paymentObj.updatedBy?.lastName || ''}`,
      };
    });

    return transformedPayments;
  },
};

module.exports = paymentMadeTransformers;
