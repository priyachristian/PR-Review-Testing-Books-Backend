// Same { firstName, lastName } shape the shared DocumentMetadata component reads.
const actor = user => (user?.firstName ? { firstName: user.firstName, lastName: user.lastName || '' } : null);

const sampleCatalogTransformers = {
  querySampleCatalogs: catalogs =>
    catalogs.map(doc => {
      const catalog = doc.toObject ? doc.toObject() : doc;
      return {
        id: String(catalog._id),
        catalogCode: catalog.catalogCode,
        name: catalog.name,
        status: catalog.status,
        visibility: catalog.visibility,
        startDate: catalog.startDate || null,
        endDate: catalog.endDate || null,
        itemCount: (catalog.items || []).length,
        customerCount: (catalog.customerIds || []).length,
        createdAt: catalog.createdAt,
        updatedAt: catalog.updatedAt,
      };
    }),

  getSampleCatalog: catalog => ({
    id: String(catalog._id),
    catalogCode: catalog.catalogCode,
    name: catalog.name,
    description: catalog.description || '',
    status: catalog.status,
    visibility: catalog.visibility,
    startDate: catalog.startDate || null,
    endDate: catalog.endDate || null,
    customers: (catalog.customerIds || []).map(customer => ({
      id: String(customer._id),
      name: customer.customerDisplayName || customer.companyName || '',
      customerNumber: customer.customerNumber || '',
    })),
    items: (catalog.items || []).map(line => ({
      id: String(line._id),
      itemId: String(line.itemId?._id || line.itemId),
      itemName: line.itemId?.itemName || '',
      itemNo: line.itemId?.itemNo || '',
      hsnCode: line.itemId?.hsnCode || '',
      gst: line.itemId?.gst || '',
      isItemActive: line.itemId?.itemStatus !== false,
      units: line.units.map(unit => ({
        itemUnitId: String(unit.itemUnitId?._id || unit.itemUnitId),
        unitName: unit.itemUnitId?.name || '',
        samplePrice: unit.samplePrice,
        minQty: unit.minQty,
        maxQty: unit.maxQty ?? null,
      })),
    })),
    addedBy: actor(catalog.addedBy),
    updatedBy: actor(catalog.updatedBy),
    createdAt: catalog.createdAt,
    updatedAt: catalog.updatedAt,
  }),
};

module.exports = sampleCatalogTransformers;
