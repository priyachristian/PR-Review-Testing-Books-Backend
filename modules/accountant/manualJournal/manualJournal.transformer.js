const manualJournalTransformers = {
  queryManualJournals: manualJournals => {
    const transformedManualJournals = manualJournals.map(q => {
      // Convert Mongoose document to plain object if needed
      const manualJournalObj = q.toObject ? q.toObject() : q;

      return {
        id: manualJournalObj._id?.toString() || '',
        date: manualJournalObj.date || '',
        manualJournalId: manualJournalObj.manualJournalId || '',
        totalDebits: manualJournalObj.totalDebits || 0,
        totalCredits: manualJournalObj.totalCredits || 0,
        totalAmount: manualJournalObj.totalDebits,
        reportingMethod: manualJournalObj.reportingMethod || '',
        vchNo: manualJournalObj.vchNo || '',
        notes: manualJournalObj.notes || '',
        addedBy: manualJournalObj.addedBy?._id?.toString() || '',
        branchName: manualJournalObj.branchId?.name || '',
        divisionName: manualJournalObj.divisionId?.name || '',
        warehouseName: manualJournalObj.warehouseId?.name || '',
        branchId: manualJournalObj.branchId?._id?.toString() || '',
        divisionId: manualJournalObj.divisionId?._id?.toString() || '',
        warehouseId: manualJournalObj.warehouseId?._id?.toString() || '',
        addedBy: manualJournalObj.addedBy || '',
        updatedBy: manualJournalObj.updatedBy || '',
      };
    });
    return transformedManualJournals;
  },
  queryManualJournal: manualJournal => ({
    id: manualJournal._id?.toString() || '',
    date: manualJournal.date || '',
    manualJournalId: manualJournal.manualJournalId || '',
    attachments: manualJournal.attachments || [],
    totalDebits: manualJournal.totalDebits || 0,
    totalCredits: manualJournal.totalCredits || 0,
    totalAmount: manualJournal.totalDebits,
    reportingMethod: manualJournal.reportingMethod || '',
    currency: manualJournal.currency || '',
    notes: manualJournal.notes || '',
    journalEntries: manualJournal.journalEntries || [],
    vchNo: manualJournal.vchNo || '',
    addedBy: manualJournal.addedBy?._id?.toString() || '',
    branchName: manualJournal.branchId?.name || '',
    divisionName: manualJournal.divisionId?.name || '',
    warehouseName: manualJournal.warehouseId?.name || '',
    branchId: manualJournal.branchId?._id?.toString() || '',
    divisionId: manualJournal.divisionId?._id?.toString() || '',
    warehouseId: manualJournal.warehouseId?._id?.toString() || '',
    addedBy: manualJournal.addedBy?.firstName || '' + ' ' + manualJournal.addedBy?.lastName || '',
  }),
};

module.exports = manualJournalTransformers;
