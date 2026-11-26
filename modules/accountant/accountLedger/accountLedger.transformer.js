const accountLedgerTransformers = {
  getLedgers: ledgerMaster => {
    const transformedLedgers = ledgerMaster.map(q => {
      const ledgerMasterObj = q.toObject ? q.toObject() : q;

      return {
        id: ledgerMasterObj._id.toString(),
        businessAccountLedgerMasterId: ledgerMasterObj.businessAccountLedgerMasterId || '',
        companyId: ledgerMasterObj.companyId || '',
        personName: ledgerMasterObj.personName || '',
        total: ledgerMasterObj.total || '',
        gstinUin: ledgerMasterObj?.gstinUin || '',
        addedBy: ledgerMasterObj.addedBy || '',
        updatedBy: ledgerMasterObj.updatedBy || '',
      };
    });

    return transformedLedgers;
  },
};

module.exports = accountLedgerTransformers;
