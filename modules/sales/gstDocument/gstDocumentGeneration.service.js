const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels, getBooksCrmModels, getCommonModels, getClientConnection } = require('../../../services/model.service');
const { DELIVERY_CHALLAN_STATUS, E_INVOICE_STATUS, E_WAY_BILL_STATUS, GST_DOCUMENT_TYPES } = require('../../../utils/enum');
const { DELIVERY_CHALLAN_MESSAGES } = require('../../../utils/messages');
const { getTransferAddresses } = require('../deliveryChallan/deliveryChallanStockTransfer.service');
const providerOrchestrator = require('../invoice/providers/providerOrchestrator.service');
const { resolveProviderKey } = require('../invoice/providers/providerConfig.service');
const {
  attachItemServiceFlags,
  toProviderDocument,
  buildEInvoiceOptionSnapshot,
  buildEWayBillOptionSnapshot,
  buildGstDocumentOptions,
} = require('./gstDocument.service');

/**
 * E-invoice and e-way bill operations for any document type in GST_DOCUMENT_TYPES other than the invoice,
 * which keeps its own flow in the invoice service. `type` is one of those configs.
 */

const getDocumentModel = type => getBooksModels()[type.modelName];

const isActive = (generated, activeStatus) => Boolean(generated) && generated.status === activeStatus;

const runInTransaction = async work => {
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const findDocument = async ({ type, documentId, companyId, session }) => {
  const document = await getDocumentModel(type).findOne({ _id: documentId, companyId }).session(session);
  if (!document) {
    throw new ApiError(httpStatus.NOT_FOUND, `${type.label} not found`);
  }
  return document;
};

const TRANSFER_SHIP_TO_ADDRESS_ID = 'STOCK_TRANSFER_TO_WAREHOUSE';

const toPartyAddress = (warehouseAddress, _id) => ({
  _id,
  address: { street1: warehouseAddress.street1 || '', street2: warehouseAddress.street2 || '' },
  city: warehouseAddress.city,
  state: warehouseAddress.state,
  pinCode: warehouseAddress.pinCode,
  country: warehouseAddress.country,
});

const withTransferAddresses = async ({ type, document, company, party, companyId, session = null }) => {
  if (!type.canBeStockTransfer || !document?.isStockTransfer || !document?.stockTransfer) {
    return { company, party, addressId: document?.addressId };
  }

  const { from, to } = await getTransferAddresses({
    companyId,
    fromWarehouseId: document.stockTransfer.fromWarehouseId,
    toWarehouseId: document.warehouseId,
    session,
  });
  const plainCompany = typeof company?.toObject === 'function' ? company.toObject() : company;
  const partyAddress = party?.address || {};

  return {
    company: { ...plainCompany, address: { ...from } },
    party: {
      ...party,
      address: {
        ...partyAddress,
        additionalShippingAddresses: [
          ...(partyAddress.additionalShippingAddresses || []),
          toPartyAddress(to, TRANSFER_SHIP_TO_ADDRESS_ID),
        ],
      },
    },
    addressId: TRANSFER_SHIP_TO_ADDRESS_ID,
  };
};

/** Loads the document with its customer or vendor and the company, shaped for the provider builders. */
const loadGenerationContext = async ({ type, documentId, companyId, session }) => {
  const { Customer, ItemUnit } = getBooksCrmModels();
  const { Company } = getCommonModels();

  const document = await findDocument({ type, documentId, companyId, session });

  const itemUnitIds = [];
  document.items.forEach(item => {
    if (item?.itemId && item?.itemUnitId) {
      itemUnitIds.push(item.itemUnitId.toString());
    }
  });

  const itemUnits = await ItemUnit.find({ _id: { $in: itemUnitIds }, companyId })
    .session(session)
    .lean();

  const [party, company] = await Promise.all([
    Customer.findOne({ _id: document[type.partyField], companyId }).lean(),
    Company.findById(companyId).session(session),
  ]);
  if (!party) {
    throw new ApiError(httpStatus.NOT_FOUND, `${type.label} party not found`);
  }

  const documentObj = document.toObject();
  documentObj.items = documentObj.items.map(item => {
    const itemUnit = itemUnits.find(unit => unit._id.toString() === item.itemUnitId?.toString());
    return {
      ...item,
      itemUnitObj: itemUnit || null,
    };
  });

  const resolved = await withTransferAddresses({ type, document, company, party, companyId, session });
  return {
    document,
    party: resolved.party,
    company: resolved.company,
    providerDocument: toProviderDocument(type, { ...documentObj, addressId: resolved.addressId }, resolved.party),
  };
};

const E_WAY_BILL_CHALLAN_STATUSES = [DELIVERY_CHALLAN_STATUS.SENT, DELIVERY_CHALLAN_STATUS.DELIVERED];

/** A delivery challan carries an e-way bill once it is sent; a stock transfer also needs its stock moved. */
const assertEWayBillAllowed = (type, document) => {
  if (type.key !== GST_DOCUMENT_TYPES.DELIVERY_CHALLAN.key) return;
  const isSent = E_WAY_BILL_CHALLAN_STATUSES.includes(document.status);
  const isTransferPending = Boolean(document.isStockTransfer) && !document.stockTransfer?.transferredAt;
  if (!isSent || isTransferPending) {
    throw new ApiError(httpStatus.BAD_REQUEST, DELIVERY_CHALLAN_MESSAGES.EWAY_BILL_NOT_ALLOWED);
  }
};

/** Saves HSN corrections made in the generate modal on the document lines, and on the item master when asked. */
const applyHsnUpdates = async ({ type, documentId, companyId, userId, items = [], updateItemMaster = false }) => {
  if (!items?.length) return;
  const { Item } = getBooksCrmModels();
  const document = await findDocument({ type, documentId, companyId });

  const itemMasterUpdates = [];
  let changed = false;
  items.forEach(item => {
    if (!item?.hsn || !item?.itemId) return;
    const line = document.items.find(
      documentItem => documentItem.itemId?.toString() === item.itemId.toString() && documentItem.hsnCode !== item.hsn,
    );
    if (!line) return;
    line.hsnCode = item.hsn;
    changed = true;
    if (updateItemMaster) {
      itemMasterUpdates.push({
        updateOne: { filter: { _id: item.itemId, companyId }, update: { $set: { hsnCode: item.hsn } } },
      });
    }
  });

  if (changed) {
    document.updatedBy = userId;
    await document.save();
  }
  if (itemMasterUpdates.length > 0) {
    await Item.bulkWrite(itemMasterUpdates);
  }
};

const saveOptionSnapshot = async ({ type, documentId, companyId, generatedFilter, snapshot, session }) => {
  if (!Object.keys(snapshot).length) return;
  await getDocumentModel(type).updateOne({ _id: documentId, companyId, ...generatedFilter }, { $set: snapshot }, { session });
};

const providerContext = ({ type, document, companyId, userId, generated }) => ({
  companyId,
  userId,
  referenceId: document._id,
  referenceType: type.modelName,
  ...(generated?.provider && { preferredProvider: resolveProviderKey(generated.provider) }),
});

const generateEInvoice = async ({ type, documentId, companyId, userId, eInvoiceOptions = null, items, updateItemMaster }) => {
  if (!type.nicDocType) {
    throw new ApiError(httpStatus.BAD_REQUEST, `An e-invoice cannot be generated for a ${type.label}.`);
  }
  await applyHsnUpdates({ type, documentId, companyId, userId, items, updateItemMaster });

  return runInTransaction(async session => {
    const { document, company, providerDocument } = await loadGenerationContext({ type, documentId, companyId, session });

    if (isActive(document.eInvoice, E_INVOICE_STATUS.ACT.value)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'E Invoice already generated');
    }
    if (document.eInvoice?.status === E_INVOICE_STATUS.CNL.value) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `An e-invoice (IRN) was already generated and cancelled for this ${type.label}. As per GST rules, a new IRN cannot be generated for the same document number. Please raise a new ${type.label}.`,
      );
    }

    providerDocument.eInvoiceOptions = eInvoiceOptions;
    await attachItemServiceFlags({ document: providerDocument, companyId });
    const response = await providerOrchestrator.execute(
      'generateEInvoice',
      { invoiceData: providerDocument, ewbDtlsValues: null, company, items, session },
      providerContext({ type, document, companyId, userId }),
    );
    if (!response.success) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to generate E Invoice');
    }

    await saveOptionSnapshot({
      type,
      documentId,
      companyId,
      generatedFilter: { 'eInvoice.irn': { $exists: true } },
      snapshot: buildEInvoiceOptionSnapshot({ options: eInvoiceOptions }),
      session,
    });
    return response;
  });
};

const generateEWayBill = async ({ type, documentId, companyId, userId, ewbDtls, items, updateItemMaster }) => {
  await applyHsnUpdates({ type, documentId, companyId, userId, items, updateItemMaster });

  return runInTransaction(async session => {
    const { document, company, providerDocument } = await loadGenerationContext({ type, documentId, companyId, session });

    assertEWayBillAllowed(type, document);
    if (isActive(document.eWayBill, E_WAY_BILL_STATUS.ACT.value)) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'E-Way Bill already generated');
    }

    const response = await providerOrchestrator.execute(
      'generateEWayBill',
      { invoiceData: providerDocument, ewbDtlsValues: ewbDtls, company, onlyEWayBill: true, session },
      providerContext({ type, document, companyId, userId }),
    );
    if (!response.success) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Failed to generate E Way Bill');
    }

    await saveOptionSnapshot({
      type,
      documentId,
      companyId,
      generatedFilter: { 'eWayBill.eWayBillNo': { $exists: true } },
      snapshot: buildEWayBillOptionSnapshot({ options: ewbDtls, document: providerDocument }),
      session,
    });
    return response;
  });
};

const cancelEInvoice = async ({ type, documentId, companyId, userId, cancellationDetails }) =>
  runInTransaction(async session => {
    const { Company } = getCommonModels();
    const document = await findDocument({ type, documentId, companyId, session });

    if (!document.eInvoice?.irn) {
      throw new ApiError(httpStatus.BAD_REQUEST, `No e-invoice has been generated for this ${type.label}.`);
    }
    if (document.eInvoice.status !== E_INVOICE_STATUS.ACT.value) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'This e-invoice IRN is already cancelled.');
    }

    const company = await Company.findById(companyId).session(session);
    const response = await providerOrchestrator.execute(
      'cancelEInvoice',
      { cancellationDetails: { ...cancellationDetails, irn: document.eInvoice.irn }, company },
      providerContext({ type, document, companyId, userId, generated: document.eInvoice }),
    );

    document.eInvoice.status = E_INVOICE_STATUS.CNL.value;
    document.commentHistory.push({
      message: `E-Invoice (IRN: ${document.eInvoice.irn}) cancelled successfully for ${type.label} No: ${document[type.numberField]}.`,
      addedBy: userId,
      createdAt: new Date(),
    });
    document.updatedBy = userId;
    await document.save({ session });
    return response;
  });

const cancelEWayBill = async ({ type, documentId, companyId, userId, cancellationDetails }) =>
  runInTransaction(async session => {
    const { Company } = getCommonModels();
    const document = await findDocument({ type, documentId, companyId, session });

    if (!document.eWayBill?.eWayBillNo) {
      throw new ApiError(httpStatus.BAD_REQUEST, `E-Way Bill not found for this ${type.label}`);
    }
    if (document.eWayBill.status !== E_WAY_BILL_STATUS.ACT.value) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'This E-Way Bill is already cancelled.');
    }

    const company = await Company.findById(companyId).session(session);
    const response = await providerOrchestrator.execute(
      'cancelEWayBill',
      { cancellationDetails: { ...cancellationDetails, eWayBillNo: document.eWayBill.eWayBillNo }, company },
      providerContext({ type, document, companyId, userId, generated: document.eWayBill }),
    );

    document.eWayBill.status = E_WAY_BILL_STATUS.CNL.value;
    document.commentHistory.push({
      message: `E-Way Bill (No: ${document.eWayBill.eWayBillNo}) cancelled successfully for ${type.label} No: ${document[type.numberField]}.`,
      addedBy: userId,
      createdAt: new Date(),
    });
    document.updatedBy = userId;
    await document.save({ session });
    return response;
  });

const getOptions = async ({ type, documentId, companyId }) => {
  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();

  const document = await getDocumentModel(type)
    .findOne({ _id: documentId, companyId })
    .select(
      `${type.partyField} addressId additionalCharges${type.canBeStockTransfer ? ' isStockTransfer stockTransfer warehouseId' : ''}`,
    )
    .lean();
  if (!document) {
    throw new ApiError(httpStatus.NOT_FOUND, `${type.label} not found`);
  }

  const [customer, company] = await Promise.all([
    Customer.findOne({ _id: document[type.partyField], companyId })
      .select('companyName customerDisplayName address otherDetails.gstinUin')
      .lean(),
    Company.findById(companyId).select('name address additionalShippingAddresses').lean(),
  ]);

  const resolved = await withTransferAddresses({ type, document, company, party: customer, companyId });
  return buildGstDocumentOptions({
    document: { ...document, addressId: resolved.addressId },
    company: resolved.company,
    customer: resolved.party,
    type,
  });
};

module.exports = { generateEInvoice, generateEWayBill, cancelEInvoice, cancelEWayBill, getOptions };
