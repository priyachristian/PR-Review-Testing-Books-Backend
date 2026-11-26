const debitNoteTransformers = {
  queryDebitNotes: (debitNotes, isSplit) => {
    const transformedDebitNotes = debitNotes.map(q => {
      // Convert Mongoose document to plain object if needed
      const debitNoteObj = q.toObject ? q.toObject() : q;

      return {
        _id: debitNoteObj._id || '',
        id: debitNoteObj._id.toString(),
        debitNoteId: debitNoteObj.debitNoteId || '',
        companyId: debitNoteObj.companyId || '',
        total: debitNoteObj.total || '',
        availableBalance: debitNoteObj.availableBalance,
        reference: debitNoteObj.reference || '',
        status: debitNoteObj.status || '-',
        debitNoteDate: debitNoteObj.debitNoteDate,
        vendorId: debitNoteObj.vendorId?._id?.toString() || '',
        addressId: debitNoteObj.addressId?.toString() || '',
        addressIn: debitNoteObj.addressIn || null,
        customerDisplayName: debitNoteObj.vendorId?.customerDisplayName || '',
        currency: debitNoteObj.currency || null,
        itemCount: debitNoteObj.itemCount ?? 0,
        quantitySummary: debitNoteObj.quantitySummary || null,
        createdAt: debitNoteObj.createdAt.toISOString(),
        updatedAt: debitNoteObj.updatedAt.toISOString(),
        divisionId: debitNoteObj.divisionId?._id.toString() || '',
        branchId: debitNoteObj.branchId?._id.toString() || '',
        divisionName: debitNoteObj.divisionId?.name || '',
        branchName: debitNoteObj.branchId?.name || '',
        warehouseId: debitNoteObj.warehouseId?._id.toString() || '',
        warehouseName: debitNoteObj.warehouseId?.name || '',
        billNo: debitNoteObj?.billNo || '',
        isDeletable: (debitNoteObj?.billsApplied?.length ?? 0) === 0 && (debitNoteObj?.refunds?.length ?? 0) === 0,
        debitNoteType: debitNoteObj.type ? String(debitNoteObj.type).split('_').join(' ') : '',
        ...(isSplit && {
          isSplit: debitNoteObj?.isSplit,
        }),
        addedBy: `${debitNoteObj.addedBy?.firstName || ''} ${debitNoteObj.addedBy?.lastName || ''}`,
        updatedBy: `${debitNoteObj.updatedBy?.firstName || ''} ${debitNoteObj.updatedBy?.lastName || ''}`,
      };
    });

    return transformedDebitNotes;
  },
};

module.exports = debitNoteTransformers;
