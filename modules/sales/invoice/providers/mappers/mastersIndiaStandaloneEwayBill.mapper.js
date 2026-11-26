const moment = require('moment-timezone');
const httpStatus = require('http-status');
const ApiError = require('../../../../../utils/ApiError');

const IST_TIMEZONE = 'Asia/Kolkata';
const formatIstDate = value => moment.tz(value, IST_TIMEZONE).format('DD/MM/YYYY');
const { getGstRateForCalculation } = require('../../../../../utils/gstRate');
const {
  getStateIndex,
  getStateCodeFromStateValue,
  getStateCodeFromGstin,
  verifyPinCodeByStateCode,
  isIGSTExists,
} = require('../../../../report/gstr1/locationMaster.service');
const {
  getAdditionalChargeHsn,
  isReturnMovement,
  resolveEWayBillDocumentType,
  swapParties,
} = require('../../../gstDocument/gstDocument.service');

// Sender and receiver fields of the Masters India e-way bill payload, swapped for a return movement.
const PARTY_FIELD_PAIRS = [
  ['gstin_of_consignor', 'gstin_of_consignee'],
  ['legal_name_of_consignor', 'legal_name_of_consignee'],
  ['address1_of_consignor', 'address1_of_consignee'],
  ['address2_of_consignor', 'address2_of_consignee'],
  ['place_of_consignor', 'place_of_consignee'],
  ['pincode_of_consignor', 'pincode_of_consignee'],
  ['state_of_consignor', 'state_of_supply'],
  ['actual_from_state_name', 'actual_to_state_name'],
];

const buildStandaloneEWayBillPayload = async (invoiceData, ewbDtlsValues, company) => {
  const addressId = invoiceData.addressId;
  if (!addressId) throw new ApiError(httpStatus.BAD_REQUEST, 'Address is required');

  const { shipping, billing, additionalShippingAddresses } = invoiceData?.customer?.address || {};
  const customerAddress =
    shipping?._id?.toString() === addressId?.toString()
      ? shipping
      : billing?._id?.toString() === addressId?.toString()
        ? billing
        : additionalShippingAddresses?.find(address => address?._id?.toString() === addressId?.toString());

  if (!customerAddress) throw new ApiError(httpStatus.BAD_REQUEST, 'Customer address not found');
  if (!customerAddress.state) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Customer address state is required to determine GST type (IGST/CGST/SGST) for e-invoice generation. Please update the customer address.',
    );
  }

  const stateIndex = await getStateIndex({ mode: 'GST' });
  const getStateCode = stateValue => getStateCodeFromStateValue(stateIndex, stateValue) || '';

  // Goods can move from and to addresses other than the billing ones; both default to the billing addresses.
  // The party side is the address chosen on the document; the company side is its registered address.
  const dispatchAddress = company.address;
  const shipAddress = customerAddress;
  const documentType = resolveEWayBillDocumentType(invoiceData, ewbDtlsValues);

  // Resolve state from the GSTIN (authoritative) and fall back to the address state name.
  // Masters India's e-way bill API validates state by its own name-master, which rejects
  // some canonical names (e.g. the merged UT "Dadra and Nagar Haveli and Daman and Diu", code 26).
  // Sending the 2-digit GST state code is unambiguous and matches the MI e-invoice / Fynamics paths.
  const consignorStateCode = getStateCodeFromGstin(stateIndex, company.gstNumber) || getStateCode(company.address.state);
  const consigneeStateCode =
    getStateCodeFromGstin(stateIndex, invoiceData.customer.otherDetails.gstinUin) || getStateCode(customerAddress.state);

  const isIGST = isIGSTExists({
    stateIndex,
    myState: company.address.state,
    customerState: customerAddress.state,
    myGSTNo: company.gstNumber,
    customerGSTNo: invoiceData.customer.otherDetails.gstinUin,
  });

  const isTxnDiscount = invoiceData.appliesTo === 'TRANSACTION';
  const isItemDiscount = invoiceData.appliesTo === 'ITEM';
  const txnDiscountConfig = invoiceData?.discountConfig || {};
  const originalSubTotal = isTxnDiscount ? invoiceData.items.reduce((sum, item) => sum + item.rate * item.quantity, 0) : 0;
  let allocatedDiscount = 0;

  const itemList = invoiceData.items.map((item, index) => {
    const gross = item.rate * item.quantity;
    const gstRate = getGstRateForCalculation(item.gst);

    let discount = 0;

    if (isItemDiscount) {
      const { discountType, discountValue } = item?.discountConfig || {};
      if (discountType === 'PERCENTAGE') {
        discount = (gross * (discountValue || 0)) / 100;
      } else if (discountType === 'AMOUNT') {
        discount = discountValue || 0;
      }
      discount = Number(discount.toFixed(2));
    } else if (isTxnDiscount) {
      const { discountType, discountValue } = txnDiscountConfig;
      if (discountType === 'PERCENTAGE') {
        discount = Number(((gross * (discountValue || 0)) / 100).toFixed(2));
      } else if (discountType === 'AMOUNT' && originalSubTotal > 0) {
        if (index === invoiceData.items.length - 1) {
          discount = Number(Math.max(0, (discountValue || 0) - allocatedDiscount).toFixed(2));
        } else {
          discount = Number(((gross / originalSubTotal) * (discountValue || 0)).toFixed(2));
          allocatedDiscount += discount;
        }
      }
    }

    const taxableAmount = Number(Math.max(0, gross - discount).toFixed(2));

    return {
      product_name: item.itemName || '',
      product_description: item.itemName || '',
      hsn_code: item.hsnCode || '',
      quantity: item.quantity,
      unit_of_product: item?.itemUnitObj?.name || item?.itemUnit || 'PCS',
      taxable_amount: taxableAmount,
      cgst_rate: isIGST ? 0 : gstRate / 2,
      sgst_rate: isIGST ? 0 : gstRate / 2,
      igst_rate: isIGST ? gstRate : 0,
      cess_rate: 0,
      cessNonAdvol: 0,
    };
  });

  if (invoiceData?.additionalCharges?.length > 0) {
    invoiceData.additionalCharges.forEach((charge, chargeIndex) => {
      const taxableAmount = Number(charge.amount.toFixed(2));
      const gstRate = charge.isTaxable ? Number(charge.taxRate || 0) : 0;

      itemList.push({
        product_name: charge.name || '',
        product_description: charge.name || '',
        hsn_code: getAdditionalChargeHsn(ewbDtlsValues, chargeIndex),
        quantity: 0,
        unit_of_product: 'OTH',
        taxable_amount: taxableAmount,
        cgst_rate: isIGST || !charge.isTaxable ? 0 : gstRate / 2,
        sgst_rate: isIGST || !charge.isTaxable ? 0 : gstRate / 2,
        igst_rate: isIGST && charge.isTaxable ? gstRate : 0,
        cess_rate: 0,
        cessNonAdvol: 0,
      });
    });
  }

  const invalidHsnItems = itemList.filter(it => !/^(?:\d{4}|\d{6}|\d{8})$/.test(String(it.hsn_code || '')));
  if (invalidHsnItems.length > 0) {
    const invalidHsnCodes = [...new Set(invalidHsnItems.map(it => String(it.hsn_code || '').trim() || 'MISSING'))];
    const details = invalidHsnItems.map(it => `${it.product_name || 'Item'} (HSN: ${it.hsn_code || 'missing'})`).join(', ');
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A 6 to 8 digit HSN code is mandatory for taxpayers with AATO >= 5 Crores. Please update the HSN code for: ${details}. Invalid HSN code(s): ${invalidHsnCodes.join(', ')}.`,
      0,
      { invalidHsn: true, invalidHsnCodes },
    );
  }

  const valDtls = itemList.reduce(
    (a, i) => {
      const tax = i.taxable_amount;
      const cgst = (tax * i.cgst_rate) / 100;
      const sgst = (tax * i.sgst_rate) / 100;
      const igst = (tax * i.igst_rate) / 100;

      a.assVal += tax;
      a.cgstVal += cgst;
      a.sgstVal += sgst;
      a.igstVal += igst;
      a.totInvVal += tax + cgst + sgst + igst;

      return a;
    },
    { assVal: 0, cgstVal: 0, sgstVal: 0, igstVal: 0, totInvVal: 0 },
  );

  if (invoiceData.isRoundOff) {
    valDtls.totInvVal += invoiceData.roundOffAmount || 0;
  }

  const payload = {
    supply_type: ewbDtlsValues.supplyType,
    sub_supply_type: ewbDtlsValues.subSupplyType,
    ...(ewbDtlsValues.subSupplyDesc && { sub_supply_description: ewbDtlsValues.subSupplyDesc }),
    document_type: documentType.mastersIndiaName,
    document_number: invoiceData.invoiceId,
    document_date: formatIstDate(invoiceData.invoiceDate),

    gstin_of_consignor: company.gstNumber,
    legal_name_of_consignor: company.name,
    address1_of_consignor: dispatchAddress.street1,
    address2_of_consignor: dispatchAddress.street2,
    place_of_consignor: dispatchAddress.city,
    pincode_of_consignor: verifyPinCodeByStateCode(
      stateIndex,
      getStateCode(dispatchAddress.state),
      dispatchAddress?.pinCode,
      'Company',
    )
      ? dispatchAddress?.pinCode
      : undefined,
    state_of_consignor: consignorStateCode,
    // Where the goods actually leave from: the state of the dispatch address (the GSTIN state when it is not known).
    actual_from_state_name: getStateCode(dispatchAddress.state) || consignorStateCode,

    gstin_of_consignee: invoiceData.customer.otherDetails.gstinUin || 'URP',
    legal_name_of_consignee: invoiceData.customer.companyName || invoiceData.customer.customerDisplayName,
    address1_of_consignee: shipAddress.address.street1,
    address2_of_consignee: shipAddress.address.street2,
    place_of_consignee: shipAddress.city,
    pincode_of_consignee: verifyPinCodeByStateCode(stateIndex, getStateCode(shipAddress.state), shipAddress?.pinCode, 'Customer')
      ? shipAddress?.pinCode
      : undefined,
    state_of_supply: consigneeStateCode,
    // Where the goods actually go: the state of the document address (the GSTIN state when it is not known).
    actual_to_state_name: getStateCode(shipAddress.state) || consigneeStateCode,

    total_invoice_value: Number(valDtls.totInvVal.toFixed(2)),
    taxable_amount: Number(valDtls.assVal.toFixed(2)),
    cgst_amount: isIGST ? 0 : Number(valDtls.cgstVal.toFixed(2)),
    sgst_amount: isIGST ? 0 : Number(valDtls.sgstVal.toFixed(2)),
    igst_amount: isIGST ? Number(valDtls.igstVal.toFixed(2)) : 0,
    cess_amount: 0,
    cess_nonadvol_value: 0,

    transportation_distance: ewbDtlsValues.Distance,
    itemList,
  };

  if (ewbDtlsValues.transporterId && ewbDtlsValues.transporterName) {
    payload.transporter_id = ewbDtlsValues.transporterId;
    payload.transporter_name = ewbDtlsValues.transporterName;
  }

  if (ewbDtlsValues.transportMode === '1') {
    payload.vehicle_number = ewbDtlsValues.VehNo;
    payload.vehicle_type = ewbDtlsValues.VehType;
    payload.transportation_mode = '1';
    // Road consignments may carry a transporter document (LR) number.
    if (ewbDtlsValues.transDocNo) {
      payload.transporter_document_number = ewbDtlsValues.transDocNo;
      if (ewbDtlsValues.transDocDate) payload.transporter_document_date = formatIstDate(ewbDtlsValues.transDocDate);
    }
  } else if (ewbDtlsValues.transportMode === '2') {
    payload.transporter_document_number = ewbDtlsValues.RRNo;
    payload.transporter_document_date = formatIstDate(ewbDtlsValues.RRDate);
    payload.transportation_mode = '2';
  } else if (ewbDtlsValues.transportMode === '3') {
    payload.transporter_document_number = ewbDtlsValues.AWBNo;
    payload.transporter_document_date = formatIstDate(ewbDtlsValues.AWBDate);
    payload.transportation_mode = '3';
  } else if (ewbDtlsValues.transportMode === '4') {
    payload.transporter_document_number = ewbDtlsValues.BLNo;
    payload.transporter_document_date = formatIstDate(ewbDtlsValues.BLDate);
    payload.transportation_mode = '4';
  }

  // Built company to party; a return moves the other way.
  return isReturnMovement(invoiceData) ? swapParties(payload, PARTY_FIELD_PAIRS) : payload;
};

module.exports = { buildStandaloneEWayBillPayload };
