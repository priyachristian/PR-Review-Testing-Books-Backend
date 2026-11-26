const paymentReceivedTransformers = {
  queryPayments: (payments, isSplit) => {
    const transformedPayments = payments.map(q => {
      // Convert Mongoose document to plain object if needed
      const paymentObj = q.toObject ? q.toObject() : q;

      return {
        _id: paymentObj._id || '',
        id: paymentObj._id.toString(),
        appName: paymentObj.appName ?? null,
        companyId: paymentObj.companyId || '',
        chequeReceivedDate: paymentObj.chequeReceivedDate || '',
        depositDate: paymentObj.depositDate || '',
        clearingDate: paymentObj.clearingDate || '',
        chequeStatus: paymentObj.chequeStatus || '',
        chequeApprovalNote: paymentObj.chequeApprovalNote || '',
        paymentDate: paymentObj.paymentDate,
        paymentMode: paymentObj.paymentMode,
        status: paymentObj.status,
        availableBalance: paymentObj.unusedAmount ?? '',
        unusedAmount: paymentObj.unusedAmount ?? 0,
        depositToAccountName: paymentObj?.depositToAccountId?.accountName || '',
        depositToAccountId: paymentObj?.depositToAccountId?._id || '',
        customerId: paymentObj?.customerId?._id?.toString() || '',
        amountReceived: paymentObj.amountReceived || '',
        paymentReceivedId: paymentObj.paymentReceivedId || '',
        customerDisplayName: paymentObj?.customerId?.customerDisplayName || '',
        currency: paymentObj.currency || null,
        createdAt: paymentObj.createdAt.toISOString(),
        updatedAt: paymentObj.updatedAt.toISOString(),
        divisionName: paymentObj.divisionId?.name || '',
        branchName: paymentObj.branchId?.name || '',
        warehouseName: paymentObj.warehouseId?.name || '',
        reference: paymentObj.reference || '',
        notes: paymentObj.notes || '',
        attachments: paymentObj.attachments || [],
        approvalNote: paymentObj.approvalNote || '',
        paymentReceivedType: paymentObj.isAdvancePayment ? 'Advance' : 'Invoice',
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

module.exports = paymentReceivedTransformers;
