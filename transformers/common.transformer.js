const commonTransformers = {
  querySalesDocuments: (salesDocument, options = {}) => {
    const partyKey = options.partyKey || 'customerId'; // default fallback
    const party = salesDocument?.[partyKey] || {};
    return {
      _id: salesDocument._id.toString(),
      id: salesDocument._id.toString(),
      [partyKey]: party?._id?.toString() || '',
      customerDisplayName: party?.customerDisplayName || party?.vendorDisplayName || party?.name || party?.personName || '-',
      status: salesDocument.status || '',
      subTotal: salesDocument.subTotal || '',
      total: salesDocument.total || '',
      customerNotes: salesDocument.customerNotes || '',
      divisionName: salesDocument.divisionId?.name || '',
      branchName: salesDocument.branchId?.name || '',
      warehouseName: salesDocument.warehouseId?.name || '',
      reference: salesDocument.reference || '',
      subject: salesDocument.subject || '',
      createdAt: salesDocument.createdAt.toISOString(),
      updatedAt: salesDocument.updatedAt.toISOString(),
      appliesTo: salesDocument?.appliesTo || '',
      isRoundOff: salesDocument.isRoundOff || false,
      roundOffAmount: salesDocument.roundOffAmount || '',
      discountConfig: salesDocument?.discountConfig || {},
      currency: salesDocument?.currency || null,
      itemCount: salesDocument.itemCount ?? 0,
      quantitySummary: salesDocument.quantitySummary || null,
    };
  },
};

module.exports = commonTransformers;
