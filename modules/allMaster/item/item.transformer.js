const itemTransformers = {
  viewItem: item => {
    const itemObj = item.toObject ? item.toObject() : item;
    return {
      id: itemObj._id?.toString(),
      itemNo: itemObj.itemNo ?? null,
      itemName: itemObj.itemName ?? null,
      itemType: itemObj.itemType ?? null,
      itemModelNo: itemObj.itemModelNo ?? null,
      itemGroup: itemObj.itemGroup ?? null,
      itemUnit: itemObj.itemUnit ?? null,
      description: itemObj.description ?? null,
      itemStatus: itemObj.itemStatus ?? null,
      trackInventory: itemObj.trackInventory ?? null,
      itemCategory: itemObj.itemCategory ?? null,
      hsnCode: itemObj.hsnCode ?? null,
      gst: itemObj.gst ?? null,
      salesInformation: itemObj.salesInformation ?? null,
      purchaseInformation: itemObj.purchaseInformation ?? null,
      inventoryData: itemObj.inventoryData ?? null,
    };
  },
  queryItems: items => {
    return (items || []).map(q => {
      const itemObj = q.toObject ? q.toObject() : q;
      return {
        id: itemObj._id?.toString(),
        itemNo: itemObj.itemNo ?? null,
        itemName: itemObj.itemName ?? null,
        itemType: itemObj.itemType ?? null,
        itemStatus: itemObj.itemStatus ?? null,
        itemModelNo: itemObj.itemModelNo ?? null,
        itemUnit: itemObj.itemUnit ?? null,
        itemGroup: itemObj.itemGroup?.name ?? null,
        subItemGroup: itemObj.subItemGroup?.name ?? null,
        hsnCode: itemObj.hsnCode ?? null,
        gst: itemObj.gst ?? null,
        description: itemObj.description ?? null,
        appName: itemObj.appName ?? null,
        productionManageMethod: itemObj.productionData?.productionManageMethod ?? null,
        sellingPrice: itemObj.salesInformation?.sellingPrice ?? null,
        costPrice: itemObj.purchaseInformation?.costPrice ?? null,
        salesInformation: itemObj.salesInformation ?? null,
        purchaseInformation: itemObj.purchaseInformation ?? null,
        inventoryAccountName: itemObj.inventoryAccountName ?? null,
        trackInventory: itemObj.trackInventory ?? null,
        itemCategory: itemObj.itemCategory ?? null,
      };
    });
  },
  itemTransactions: rows => {
    return (rows || []).map(row => ({
      id: row.id ?? null,
      type: row.type ?? null,
      refNo: row.refNo ?? null,
      date: row.date ?? null,
      status: row.status ?? null,
      customerId: row.customerId ?? null,
      customerName: row.customerName ?? '',
      quantity: row.quantity ?? 0,
      rate: row.rate ?? 0,
      amount: row.amount ?? 0,
      currencySymbol: row.currencySymbol ?? null,
    }));
  },
};

module.exports = itemTransformers;
