const moment = require('moment-timezone');
const httpStatus = require('http-status');
const ApiError = require('../../../../../utils/ApiError');

const IST_TIMEZONE = 'Asia/Kolkata';
const formatIstDate = value => moment.tz(value, IST_TIMEZONE).format('DD/MM/YYYY');
const {
  getStateIndex,
  getStateCodeFromStateValue,
  verifyPinCodeByStateCode,
  isIGSTExists,
} = require('../../../../report/gstr1/locationMaster.service');
const {
  getEInvoiceShipToAddress,
  getAdditionalChargeHsn,
  getGstDocumentType,
} = require('../../../gstDocument/gstDocument.service');

const round2 = v => Math.round(Number(v) * 100) / 100;
const URP_GSTIN = 'URP';

const buildGenerateEInvoicePayload = async (invoiceData, ewbDtlsValues, company) => {
  // Choices the user made in the generate modal; each one falls back to the value sent before it existed.
  const options = invoiceData?.eInvoiceOptions || {};
  let addressId = invoiceData?.addressId;
  if (!addressId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Address is required');
  }

  const customerAddress = invoiceData?.customer?.address?.billing;
  if (!customerAddress) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Customer address not found');
  }

  const shippingRaw = invoiceData?.customer?.address?.shipping;
  const hasSeparateShipping = Boolean(
    shippingRaw && (shippingRaw?.address?.street1 || shippingRaw?.city || shippingRaw?.pinCode || shippingRaw?.state),
  );
  // The ship-to is the address chosen on the document; it decided the place of supply and the tax.
  const shipAddress = getEInvoiceShipToAddress(invoiceData) || (hasSeparateShipping ? shippingRaw : customerAddress);
  const dispatchAddress = company.address;

  if (!invoiceData?.customer?.otherDetails?.gstinUin) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This customer is unregistered under GST, so an e-invoice (IRN) cannot be generated. \nPlease proceed with a standard invoice.',
    );
  }

  const stateIndex = await getStateIndex({ mode: 'GST' });
  const getStateCode = stateValue => getStateCodeFromStateValue(stateIndex, stateValue) || '';

  const customerState = invoiceData.customer.address?.billing?.state || invoiceData.customer.address?.shipping?.state;
  if (!customerState) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Customer address state is required to determine GST type (IGST/CGST/SGST) for e-invoice generation. Please update the customer address.',
    );
  }

  // The portal rejects an empty city (location). The billing city feeds buyer_details.location and is
  // the fallback for ship_details.location, so it must exist — surface a clear message pointing at the
  // address to fix instead of the raw "location, none is not an allowed value" error. A missing ship-to
  // city is not fatal: ship_details.location falls back to the billing city below.
  if (!customerAddress?.city) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Customer billing address city is required for e-invoice generation. Please update the customer billing address.',
    );
  }

  const isIGST = isIGSTExists({
    stateIndex,
    myState: company.address.state,
    customerState,
    myGSTNo: company.gstNumber,
    customerGSTNo: invoiceData.customer.otherDetails.gstinUin,
  });

  const buyerStateCode = getStateCode(customerAddress?.state);
  const shipStateCode = getStateCode(shipAddress?.state);
  const shipToGstin =
    shipStateCode && shipStateCode === buyerStateCode ? invoiceData?.customer?.otherDetails?.gstinUin || URP_GSTIN : URP_GSTIN;
  const dispatchStateCode = getStateCode(dispatchAddress?.state);

  const isItemDiscount = invoiceData?.appliesTo === 'ITEM';
  const isTxnDiscount = invoiceData?.appliesTo === 'TRANSACTION';
  const txnDiscountConfig = invoiceData?.discountConfig || {};
  const grossSubTotal = invoiceData.subTotal || 0;
  let allocatedDiscount = 0;

  const itemList = invoiceData.items.map((item, index) => {
    const gross = Number(((item.rate || 0) * (item.quantity || 0)).toFixed(2));
    const gstRt = Number(item.gst) || 0;

    let discount = 0;
    let assAmt = gross;

    if (isItemDiscount) {
      assAmt = Number((item.amount || 0).toFixed(2));
      discount = Number(Math.max(0, gross - assAmt).toFixed(2));
    } else if (isTxnDiscount) {
      const { discountType, discountValue = 0 } = txnDiscountConfig;
      const isLastItem = index === invoiceData.items.length - 1;
      if (discountType === 'PERCENTAGE') {
        discount = Number(((gross * discountValue) / 100).toFixed(2));
      } else if (discountType === 'AMOUNT' && grossSubTotal > 0) {
        discount = isLastItem
          ? Number(Math.max(0, discountValue - allocatedDiscount).toFixed(2))
          : Number(((gross / grossSubTotal) * discountValue).toFixed(2));
        if (!isLastItem) allocatedDiscount += discount;
      }
      assAmt = Number(Math.max(0, gross - discount).toFixed(2));
    }

    const cgstAmt = isIGST ? 0 : round2((assAmt * gstRt) / 200);
    const sgstAmt = isIGST ? 0 : cgstAmt;
    const igstAmt = isIGST ? round2((assAmt * gstRt) / 100) : 0;

    return {
      item_serial_number: String(index + 1),
      product_description: item.itemName || '',
      // From the item master; additional charges below are always services.
      is_service: item.isService ? 'Y' : 'N',
      hsn_code: item.hsnCode || '',
      quantity: item.quantity || 1,
      unit: item?.itemUnitObj?.name || item.itemUnit || 'PCS',
      unit_price: item.rate,
      total_amount: gross,
      discount,
      assessable_value: assAmt,
      gst_rate: gstRt,
      cgst_amount: cgstAmt,
      sgst_amount: sgstAmt,
      igst_amount: igstAmt,
      total_item_value: Number((assAmt + cgstAmt + sgstAmt + igstAmt).toFixed(2)),
    };
  });

  if (invoiceData?.additionalCharges?.length > 0) {
    const baseIndex = itemList.length;
    invoiceData.additionalCharges.forEach((charge, chargeIndex) => {
      const assAmt = Number(charge.amount.toFixed(2));
      const gstRate = charge.isTaxable ? Number(charge.taxRate || 0) : 0;
      let igstAmt = 0;
      let cgstAmt = 0;
      let sgstAmt = 0;

      if (isIGST && charge.isTaxable) {
        igstAmt = Number(((assAmt * gstRate) / 100).toFixed(2));
      } else if (charge.isTaxable) {
        cgstAmt = round2((assAmt * gstRate) / 200);
        sgstAmt = cgstAmt;
      }

      itemList.push({
        item_serial_number: String(baseIndex + chargeIndex + 1),
        product_description: charge.name || '',
        is_service: 'Y',
        hsn_code: getAdditionalChargeHsn(options, chargeIndex),
        quantity: 0,
        unit: 'OTH',
        unit_price: 0,
        total_amount: assAmt,
        discount: 0,
        assessable_value: assAmt,
        gst_rate: gstRate,
        cgst_amount: cgstAmt,
        sgst_amount: sgstAmt,
        igst_amount: igstAmt,
        total_item_value: Number((assAmt + cgstAmt + sgstAmt + igstAmt).toFixed(2)),
      });
    });
  }

  const invalidHsnItems = itemList.filter(it => !/^(?:\d{4}|\d{6}|\d{8})$/.test(String(it.hsn_code || '')));
  if (invalidHsnItems.length > 0) {
    const invalidHsnCodes = [...new Set(invalidHsnItems.map(it => String(it.hsn_code || '').trim() || 'MISSING'))];
    const details = invalidHsnItems
      .map(it => `${it.product_description || 'Item'} (HSN: ${it.hsn_code || 'missing'})`)
      .join(', ');
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `A 6 to 8 digit HSN code is mandatory for taxpayers with AATO >= 5 Crores. Please update the HSN code for: ${details}. Invalid HSN code(s): ${invalidHsnCodes.join(', ')}.`,
      0,
      { invalidHsn: true, invalidHsnCodes },
    );
  }

  const valueDetails = {
    total_assessable_value: Number(itemList.reduce((sum, it) => sum + it.assessable_value, 0).toFixed(2)),
    total_cgst_value: Number(itemList.reduce((sum, it) => sum + it.cgst_amount, 0).toFixed(2)),
    total_sgst_value: Number(itemList.reduce((sum, it) => sum + it.sgst_amount, 0).toFixed(2)),
    total_igst_value: Number(itemList.reduce((sum, it) => sum + it.igst_amount, 0).toFixed(2)),
    total_cess_value: 0,
    total_cess_value_of_state: 0,
    total_discount: Number(itemList.reduce((sum, it) => sum + (it.discount || 0), 0).toFixed(2)),
    total_other_charge: 0,
    round_off_amount: invoiceData.isRoundOff ? Number((invoiceData.roundOffAmount || 0).toFixed(2)) : 0,
    total_invoice_value: Number((invoiceData.total || 0).toFixed(2)),
  };

  const seller_pincode = verifyPinCodeByStateCode(
    stateIndex,
    getStateCode(company?.address?.state),
    company?.address?.pinCode,
    'Seller',
  )
    ? company?.address?.pinCode
    : undefined;

  const payload = {
    data_source: 'erp',
    transaction_details: {
      supply_type: invoiceData.supplyType || 'B2B',
      charge_type: 'N',
      igst_on_intra: 'N',
      ecommerce_gstin: options.ecommerceGstin || '',
    },
    document_details: {
      document_type: getGstDocumentType(invoiceData).nicDocType,
      document_number: invoiceData.invoiceId,
      document_date: formatIstDate(invoiceData.invoiceDate || new Date()),
    },
    seller_details: {
      gstin: company?.gstNumber,
      legal_name: company?.name,
      trade_name: options.sellerTradeName || company?.name,
      address1: company?.address?.street1 || '',
      address2: company?.address?.street2 || '',
      location: company?.address?.city || '',
      pincode: seller_pincode,
      state_code: getStateCode(company?.address?.state),
      phone_number: company.contactPhone || '',
      email: company.email || '',
    },
    buyer_details: {
      gstin: invoiceData?.customer?.otherDetails?.gstinUin || URP_GSTIN,
      legal_name: invoiceData?.customer?.companyName || invoiceData?.customer?.customerDisplayName,
      trade_name: invoiceData?.customer?.companyName || invoiceData?.customer?.customerDisplayName,
      address1: customerAddress?.address?.street1 || '',
      address2: customerAddress?.address?.street2 || '',
      location: customerAddress?.city || '',
      pincode: verifyPinCodeByStateCode(stateIndex, buyerStateCode, customerAddress?.pinCode, 'Customer')
        ? customerAddress?.pinCode
        : undefined,
      place_of_supply: buyerStateCode,
      state_code: buyerStateCode,
      phone_number: invoiceData?.customer?.customerPhoneNumber || '',
      email: invoiceData?.customer?.bpEmail || '',
    },
    dispatch_details: {
      company_name: company?.name,
      address1: dispatchAddress?.street1 || '',
      address2: dispatchAddress?.street2 || '',
      location: dispatchAddress?.city || '',
      pincode: verifyPinCodeByStateCode(stateIndex, dispatchStateCode, dispatchAddress?.pinCode, 'Dispatch From')
        ? dispatchAddress?.pinCode
        : undefined,
      state_code: dispatchStateCode,
    },
    ship_details: {
      gstin: shipToGstin,
      legal_name: invoiceData?.customer?.companyName || invoiceData?.customer?.customerDisplayName,
      address1: shipAddress?.address?.street1 || '',
      address2: shipAddress?.address?.street2 || '',
      location: shipAddress?.city || customerAddress?.city || '',
      pincode: verifyPinCodeByStateCode(stateIndex, shipStateCode, shipAddress?.pinCode, 'Customer')
        ? shipAddress?.pinCode
        : undefined,
      state_code: shipStateCode,
    },
    value_details: valueDetails,
    item_list: itemList,
  };

  if (options.remarks || options.poNumber) {
    payload.reference_details = {};
    if (options.remarks) payload.reference_details.invoice_remarks = options.remarks;
    if (options.poNumber) {
      payload.reference_details.contract_details = [
        {
          po_reference_number: options.poNumber,
          ...(options.poDate && { po_reference_date: formatIstDate(options.poDate) }),
        },
      ];
    }
  }

  if (ewbDtlsValues) {
    const ewaybillDetails = {
      transportation_distance: ewbDtlsValues.Distance,
      transportation_mode: ewbDtlsValues.TransMode,
    };
    if (ewbDtlsValues.TransId) ewaybillDetails.transporter_id = ewbDtlsValues.TransId;
    if (ewbDtlsValues.TransName) ewaybillDetails.transporter_name = ewbDtlsValues.TransName;

    if (ewbDtlsValues.TransMode === '1') {
      ewaybillDetails.vehicle_number = ewbDtlsValues.VehNo;
      ewaybillDetails.vehicle_type = ewbDtlsValues.VehType;
    } else if (ewbDtlsValues.TransMode === '2') {
      ewaybillDetails.transporter_document_number = ewbDtlsValues.RRNo;
      ewaybillDetails.transporter_document_date = formatIstDate(ewbDtlsValues.RRDate);
    } else if (ewbDtlsValues.TransMode === '3') {
      ewaybillDetails.transporter_document_number = ewbDtlsValues.AWBNo;
      ewaybillDetails.transporter_document_date = formatIstDate(ewbDtlsValues.AWBDate);
    } else if (ewbDtlsValues.TransMode === '4') {
      ewaybillDetails.transporter_document_number = ewbDtlsValues.BLNo;
      ewaybillDetails.transporter_document_date = formatIstDate(ewbDtlsValues.BLDate);
    }

    payload.ewaybill_details = ewaybillDetails;
  }

  return payload;
};

module.exports = { buildGenerateEInvoicePayload };
