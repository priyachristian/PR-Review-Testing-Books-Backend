const creditNoteTransformers = {
  queryCreditNotes: (creditNotes, isSplit) => {
    const transformedCreditNotes = creditNotes.map(q => {
      // Convert Mongoose document to plain object if needed
      const creditNoteObj = q.toObject ? q.toObject() : q;

      return {
        _id: creditNoteObj._id || '',
        id: creditNoteObj._id.toString(),
        creditNoteId: creditNoteObj.creditNoteId || '',
        companyId: creditNoteObj.companyId || '',
        total: creditNoteObj.total || '',
        availableBalance: creditNoteObj.availableBalance,
        referenceNumber: creditNoteObj.referenceNumber || '',
        rejectionOrderDetails: creditNoteObj.rejectionOrderDetails || null,
        status: creditNoteObj.status || '-',
        creditNoteDate: creditNoteObj.creditNoteDate,
        creditNoteType: creditNoteObj.type?.split('_').join(' ') || '',
        customerId: creditNoteObj.customerId?._id?.toString() || '',
        addressId: creditNoteObj.addressId?.toString() || '',
        addressIn: creditNoteObj.addressIn || null,
        customerDisplayName: creditNoteObj.customerId?.customerDisplayName || '',
        currency: creditNoteObj.currency || null,
        itemCount: creditNoteObj.itemCount ?? 0,
        quantitySummary: creditNoteObj.quantitySummary || null,
        createdAt: creditNoteObj.createdAt.toISOString(),
        updatedAt: creditNoteObj.updatedAt.toISOString(),
        divisionId: creditNoteObj.divisionId?._id.toString() || '',
        branchId: creditNoteObj.branchId?._id.toString() || '',
        divisionName: creditNoteObj.divisionId?.name || '',
        branchName: creditNoteObj.branchId?.name || '',
        warehouseId: creditNoteObj.warehouseId?._id.toString() || '',
        warehouseName: creditNoteObj.warehouseId?.name || '',
        isDeletable: (creditNoteObj?.invoicesApplied?.length ?? 0) === 0 && (creditNoteObj?.refunds?.length ?? 0) === 0,
        invoiceNo: creditNoteObj?.invoiceNo || '',
        ...(isSplit && {
          isSplit: creditNoteObj?.isSplit,
        }),
        addedBy: `${creditNoteObj.addedBy?.firstName || ''} ${creditNoteObj.addedBy?.lastName || ''}`,
        updatedBy: `${creditNoteObj.updatedBy?.firstName || ''} ${creditNoteObj.updatedBy?.lastName || ''}`,
      };
    });

    return transformedCreditNotes;
  },
};

module.exports = creditNoteTransformers;
