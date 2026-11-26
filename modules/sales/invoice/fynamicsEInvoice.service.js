const { default: axios } = require('axios');
const moment = require('moment');
const momentTz = require('moment-timezone');
const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { GST_MESSAGES } = require('../../../utils/messages');
const logger = require('../../../config/logger');
const { decryptBlob } = require('../../../utils/cryptography');
const { eInvoiceSchema, generateOnlyEWayBillSchema, generateEWayBillByIrnSchema } = require('./eInvoice.validation');
const { getGstRateForCalculation } = require('../../../utils/gstRate');

const NIC_API_ERROR_CODES = require('../../../utils/nicErrorMap');
const {
  getStateIndex,
  getStateCodeFromStateValue,
  verifyPinCodeByStateCode,
  isIGSTExists,
} = require('../../report/gstr1/locationMaster.service');
const { getCommonModels, getBooksModels } = require('../../../services/model.service');
const {
  getFynamicsEInvoiceAuth,
  getFynamicsEWayBillAuth,
  getFynamicsClientToken,
  resolveSandboxOverrides,
} = require('../../../utils/getFynamicsAuthToken');
const { FYNAMICS_ROUTES, buildFynamicsUrl } = require('../../../utils/fynamicsApiRoutes');
const { logApiCall } = require('./eInvoice.service');
const {
  CANCELLATION_REASONS,
  E_WAY_BILL_CANCELLATION_REASONS,
  THIRD_PARTY_API_LOG_REFERENCE_TYPES,
  THIRD_PARTY_PROVIDERS,
  E_WAY_BILL_STATUS,
} = require('../../../utils/enum');
const {
  getEInvoiceShipToAddress,
  getAdditionalChargeHsn,
  resolveEWayBillDocumentType,
  getGstDocumentModel,
  getGstDocumentType,
  getGstDocumentLabel,
  isReturnMovement,
  swapParties,
} = require('../gstDocument/gstDocument.service');

// Sender and receiver fields of the NIC e-way bill payload, swapped for a return movement.
const EWB_PARTY_FIELD_PAIRS = [
  ['fromGstin', 'toGstin'],
  ['fromTrdName', 'toTrdName'],
  ['fromAddr1', 'toAddr1'],
  ['fromAddr2', 'toAddr2'],
  ['fromPlace', 'toPlace'],
  ['fromPincode', 'toPincode'],
  ['fromStateCode', 'toStateCode'],
  ['actFromStateCode', 'actToStateCode'],
];
const { PLAN_FEATURES } = require('@smit9313/abss-models-core/src/utils/enum');

const round2 = v => Math.round(Number(v) * 100) / 100;

const NIC_SCHEMA_VERSION = '1.1';

const HSN_LENGTH_ERROR_CODES = ['282', '283'];
const HSN_ERROR_CODES = ['216', '282', '283', '327', '337', '724'];

const buildQRCodeFromSignedQr = signedQrCode => {
  if (!signedQrCode || typeof signedQrCode !== 'string') {
    return null;
  }
  const payloadPart = signedQrCode.split('.')[1];
  if (!payloadPart) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch (err) {
    console.error('Failed to decode signedQrCode for QRCode:', err?.message);
    return null;
  }
};

function parseDmy(dateStr, format = 'DD/MM/YYYY hh:mm:ss A', timezone = 'Asia/Kolkata') {
  const date = momentTz.tz(dateStr.trim(), format, timezone);

  if (!date.isValid()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid date format');
  }

  return date.utc().toISOString();
}

const toNormalisedError = (code, message) => {
  const errorCodes = code ?? undefined;

  const friendlyMessage = errorCodes != null ? NIC_API_ERROR_CODES.CLIENT_FRIENDLY_ERROR_CODES[errorCodes] : undefined;
  const rawMsg = message || (errorCodes != null ? NIC_API_ERROR_CODES[errorCodes] || `Error code ${errorCodes}` : undefined);
  const resolved = friendlyMessage || rawMsg;
  return { errorCodes, errorMsg: resolved, rawMsg };
};

const expandErrorCodes = value => {
  if (value == null) return [];
  return String(value)
    .split(',')
    .map(code => code.trim())
    .filter(Boolean);
};

const toNormalisedErrors = (code, message) => {
  const codes = expandErrorCodes(code);
  if (codes.length > 1) {
    return codes.map(single => toNormalisedError(single, undefined));
  }
  return [toNormalisedError(codes.length === 1 ? codes[0] : code, message)];
};

const buildErrorMessage = (normalized, fallback) => {
  const joined = Array.isArray(normalized?.error)
    ? normalized.error
        .map(err => err?.errorMsg)
        .filter(Boolean)
        .join(', ')
    : typeof normalized?.error === 'string'
      ? normalized.error
      : '';
  return joined || fallback;
};

const mapFynamicsErrors = responseData => {
  const errorDetails = responseData.ErrorDetails ?? responseData.errorDetails;
  if (Array.isArray(errorDetails)) {
    return errorDetails.flatMap(err => toNormalisedErrors(err?.ErrorCode ?? err?.errorCodes, err?.ErrorMessage ?? err?.errorMsg));
  }
  if (typeof errorDetails === 'string' && errorDetails) {
    return [toNormalisedError(responseData.ErrorCode ?? responseData.errorCode, errorDetails)];
  }

  const nestedError = responseData.error;
  if (Array.isArray(nestedError)) {
    return nestedError.flatMap(err =>
      toNormalisedErrors(err?.error_cd ?? err?.ErrorCode ?? err?.errorCodes, err?.message ?? err?.ErrorMessage ?? err?.errorMsg),
    );
  }
  if (nestedError && typeof nestedError === 'object') {
    const nestedCode = nestedError.error_cd ?? nestedError.ErrorCode ?? nestedError.errorCodes;
    const nestedMessage = nestedError.message ?? nestedError.ErrorMessage ?? nestedError.errorMsg;
    if (nestedMessage || nestedCode != null) {
      return toNormalisedErrors(nestedCode, nestedMessage);
    }
  }

  const flatCode = responseData.ErrorCode ?? responseData.errorCode ?? responseData.errorCodes;
  const flatMessage = responseData.errorMessage ?? responseData.ErrorMessage ?? responseData.message;
  if (flatMessage || flatCode != null) {
    return toNormalisedErrors(flatCode, flatMessage);
  }
  return null;
};

const toPin = value => {
  const pin = Number(value);
  return Number.isFinite(pin) && pin > 0 ? pin : undefined;
};

const emptyToUndefined = value => (value === '' || value === null ? undefined : value);

const sanitizeEmail = value => {
  const email = String(value ?? '').trim();
  if (!email) return undefined;
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 100;
  return isValid ? email : undefined;
};

const sanitizePhone = value => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 12 ? digits : undefined;
};

const normalizeForCompare = value =>
  String(value ?? '')
    .toUpperCase()
    .replace(/\s*,\s*/g, ',')
    .replace(/,+/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();

const URP_GSTIN = 'URP';

const isSeparateShipToParty = (shipDtls, buyerDtls) => {
  if (!shipDtls) return false;
  const shipGstin = normalizeForCompare(shipDtls.gstin);
  const buyerGstin = normalizeForCompare(buyerDtls?.gstin);
  if (!shipGstin) return false;
  if (shipGstin === URP_GSTIN) return true;
  return shipGstin !== buyerGstin;
};

const isDispatchSameAsSeller = (dispDtls, sellerDtls) => {
  if (!dispDtls || !sellerDtls) return false;
  return (
    normalizeForCompare(dispDtls.nm) === normalizeForCompare(sellerDtls.lglNm) &&
    normalizeForCompare(dispDtls.addr1) === normalizeForCompare(sellerDtls.addr1) &&
    normalizeForCompare(dispDtls.addr2) === normalizeForCompare(sellerDtls.addr2) &&
    normalizeForCompare(dispDtls.loc) === normalizeForCompare(sellerDtls.loc) &&
    toPin(dispDtls.pin) === toPin(sellerDtls.pin) &&
    normalizeForCompare(dispDtls.stcd) === normalizeForCompare(sellerDtls.stcd)
  );
};

const shipsToAnotherAddress = (shipDtls, buyerDtls) =>
  normalizeForCompare(shipDtls?.addr1) !== normalizeForCompare(buyerDtls?.addr1) ||
  normalizeForCompare(shipDtls?.loc) !== normalizeForCompare(buyerDtls?.loc) ||
  toPin(shipDtls?.pin) !== toPin(buyerDtls?.pin);

const toNicPayload = (data, options = {}) => {
  const nic = {
    Version: NIC_SCHEMA_VERSION,
    TranDtls: {
      TaxSch: data.tranDtls.taxSch,
      SupTyp: data.tranDtls.supTyp,
      RegRev: data.tranDtls.regRev,
      IgstOnIntra: data.tranDtls.igstOnIntra,
      EcmGstin: emptyToUndefined(options.ecommerceGstin),
    },
    DocDtls: {
      Typ: data.docDtls.typ,
      No: data.docDtls.no,
      Dt: data.docDtls.dt,
    },
    SellerDtls: {
      Gstin: data.sellerDtls.gstin,
      LglNm: data.sellerDtls.lglNm,
      TrdNm: emptyToUndefined(data.sellerDtls.trdNm),
      Addr1: data.sellerDtls.addr1,
      Addr2: emptyToUndefined(data.sellerDtls.addr2),
      Loc: data.sellerDtls.loc,
      Pin: toPin(data.sellerDtls.pin),
      Stcd: data.sellerDtls.stcd,
      Ph: sanitizePhone(data.sellerDtls.ph),
      Em: sanitizeEmail(data.sellerDtls.em),
    },
    BuyerDtls: {
      Gstin: data.buyerDtls.gstin,
      LglNm: data.buyerDtls.lglNm,
      TrdNm: emptyToUndefined(data.buyerDtls.trdNm),
      Pos: data.buyerDtls.pos,
      Addr1: data.buyerDtls.addr1,
      Addr2: emptyToUndefined(data.buyerDtls.addr2),
      Loc: data.buyerDtls.loc,
      Pin: toPin(data.buyerDtls.pin),
      Stcd: data.buyerDtls.stcd,
      Ph: sanitizePhone(data.buyerDtls.ph),
      Em: sanitizeEmail(data.buyerDtls.em),
    },
    ValDtls: {
      AssVal: data.valDtls.assVal,
      CgstVal: data.valDtls.cgstVal,
      SgstVal: data.valDtls.sgstVal,
      IgstVal: data.valDtls.igstVal,
      CesVal: data.valDtls.cesVal,
      StCesVal: data.valDtls.stCesVal,
      OthChrg: data.valDtls.othChrg,
      RndOffAmt: data.valDtls.rndOffAmt,
      TotInvVal: data.valDtls.totInvVal,
    },
    ItemList: data.itemList.map(item => ({
      SlNo: item.slNo,
      PrdDesc: item.prdDesc,
      IsServc: item.isServc,
      HsnCd: item.hsnCd,
      Qty: item.qty,
      Unit: item.unit,
      UnitPrice: item.unitPrice,
      TotAmt: item.totAmt,
      Discount: item.discount,
      AssAmt: item.assAmt,
      GstRt: item.gstRt,
      IgstAmt: item.igstAmt,
      CgstAmt: item.cgstAmt,
      SgstAmt: item.sgstAmt,
      TotItemVal: item.totItemVal,
    })),
  };

  if (data.dispDtls && !isDispatchSameAsSeller(data.dispDtls, data.sellerDtls)) {
    nic.DispDtls = {
      Nm: data.dispDtls.nm,
      Addr1: data.dispDtls.addr1,
      Addr2: emptyToUndefined(data.dispDtls.addr2),
      Loc: data.dispDtls.loc,
      Pin: toPin(data.dispDtls.pin),
      Stcd: data.dispDtls.stcd,
    };
  }

  // Sent when the goods go to another party or to an address other than the buyer's billing address.
  if (
    data.shipDtls &&
    (isSeparateShipToParty(data.shipDtls, data.buyerDtls) || shipsToAnotherAddress(data.shipDtls, data.buyerDtls))
  ) {
    nic.ShipDtls = {
      Gstin: data.shipDtls.gstin,
      LglNm: data.shipDtls.lglNm,
      TrdNm: emptyToUndefined(data.shipDtls.trdNm),
      Addr1: data.shipDtls.addr1,
      Addr2: emptyToUndefined(data.shipDtls.addr2),
      Loc: data.shipDtls.loc,
      Pin: toPin(data.shipDtls.pin),
      Stcd: data.shipDtls.stcd,
    };
  }

  if (options.remarks || options.poNumber) {
    nic.RefDtls = {};
    if (options.remarks) nic.RefDtls.InvRm = options.remarks;
    if (options.poNumber) {
      nic.RefDtls.ContrDtls = [
        { PORefr: options.poNumber, PORefDt: options.poDate ? moment(options.poDate).format('DD/MM/YYYY') : undefined },
      ];
    }
  }

  if (data.ewbDtls) {
    const ewb = data.ewbDtls;

    const transDocNo = emptyToUndefined(ewb.RRNo || ewb.AWBNo || ewb.BLNo);
    const transDocDt = emptyToUndefined(ewb.RRDate || ewb.AWBDate || ewb.BLDate || ewb.transDocDt);
    const hasTransDoc = Boolean(transDocNo && transDocDt);
    nic.EwbDtls = {
      TransId: emptyToUndefined(ewb.TransId),
      TransName: emptyToUndefined(ewb.TransName),
      TransMode: emptyToUndefined(ewb.TransMode),
      Distance: Number(ewb.Distance) || 0,
      TransDocNo: hasTransDoc ? transDocNo : undefined,
      TransDocDt: hasTransDoc ? transDocDt : undefined,
      VehNo: emptyToUndefined(ewb.VehNo),
      VehType: emptyToUndefined(ewb.VehType),
    };
  }

  return nic;
};

const normalizeFynamicsResponse = responseData => {
  if (!responseData || typeof responseData !== 'object') {
    return { status: 0, data: null, error: null, info: null };
  }

  const hasErrorSignal =
    !!(responseData.errorMessage || responseData.ErrorMessage) ||
    (Array.isArray(responseData.ErrorDetails) && responseData.ErrorDetails.length > 0) ||
    !!responseData.error;

  const NIC_SUCCESS_MARKERS = ['Irn', 'AckNo', 'EwbNo', 'ewayBillNo', 'gstin'];
  const isUnwrapped = !hasErrorSignal && NIC_SUCCESS_MARKERS.some(key => responseData[key] !== undefined);
  if (isUnwrapped) {
    return { status: 1, data: responseData, error: null, info: responseData.InfoDtls || null };
  }

  return {
    status: responseData.Status ?? responseData.status ?? responseData.status_cd,
    data: responseData.Data ?? responseData.data ?? null,
    error: mapFynamicsErrors(responseData),
    info: responseData.InfoDtls ?? responseData.infoDtls ?? null,
  };
};

const AUTH_EXPIRY_ERROR_CODES = ['1005'];

const AUTH_EXPIRY_PATTERNS = [/authorization\s+bearer/i, /invalid\s+token/i, /token\s+.*expired/i];

const isAuthExpiryError = normalized => {
  if (!Array.isArray(normalized?.error)) return false;
  return normalized.error.some(
    err =>
      AUTH_EXPIRY_ERROR_CODES.includes(String(err?.errorCodes)) ||
      AUTH_EXPIRY_PATTERNS.some(pattern => pattern.test(String(err?.rawMsg ?? err?.errorMsg ?? ''))),
  );
};

const COLLECTION = { EINVOICE: 'einvoice', EWAYBILL: 'ewaybill' };

const buildFynamicsHeaders = async ({
  credentials,
  companyId,
  gstNumber,
  collection = COLLECTION.EINVOICE,
  forceRefresh = false,
  userId,
  packageName,
  referenceId,
  referenceType,
}) => {
  const authOptions = { forceRefresh, userId, packageName, referenceId, referenceType };
  const auth =
    collection === COLLECTION.EWAYBILL
      ? await getFynamicsEWayBillAuth(credentials, companyId, gstNumber, authOptions)
      : await getFynamicsEInvoiceAuth(credentials, companyId, gstNumber, authOptions);
  const clientToken = await getFynamicsClientToken({ forceRefresh, sandbox: resolveSandboxOverrides(credentials) });

  const headers = {
    Authorization: `Bearer ${clientToken}`,
    gstin: gstNumber,
    user_name: auth.UserName,
    sek: auth.Sek,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (collection === COLLECTION.EWAYBILL) {
    headers.authtoken = auth.AuthToken;

    headers.username = auth.UserName;
  } else {
    headers.AuthToken = auth.AuthToken;
  }
  return headers;
};

const requestFynamics = async (route, authContext, { method = 'post', payload = null, params = null, headerTracker } = {}) => {
  const URL = buildFynamicsUrl(route, resolveSandboxOverrides(authContext.credentials)?.baseUrl);
  const send = headers => (method === 'get' ? axios.get(URL, { headers, params }) : axios.post(URL, payload, { headers }));

  let headers = await buildFynamicsHeaders(authContext);
  if (headerTracker) headerTracker.headers = headers;
  let response = await send(headers);
  let normalized = normalizeFynamicsResponse(response.data);

  if (isAuthExpiryError(normalized)) {
    console.log('FYNAMICS_AUTH_EXPIRED — refreshing tokens and retrying once');
    headers = await buildFynamicsHeaders({ ...authContext, forceRefresh: true });
    if (headerTracker) headerTracker.headers = headers;
    response = await send(headers);
    normalized = normalizeFynamicsResponse(response.data);
  }

  return { URL, response, normalized };
};

const postToFynamics = (route, payload, authContext, headerTracker) =>
  requestFynamics(route, authContext, { method: 'post', payload, headerTracker });

const generateFynamicsEInvoice = async (invoiceData, ewbDtlsValues, companyId, userId, items = [], session) => {
  const { Company, ThirdPartyCredentials } = getCommonModels();
  const Invoice = getGstDocumentModel(invoiceData);
  try {
    const company = await Company.findById(companyId);
    if (!company) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
    }

    const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.FYNAMICS });
    if (!credentials) {
      throw new ApiError(httpStatus.NOT_FOUND, GST_MESSAGES.CREDENTIALS_NOT_FOUND);
    }
    const decryptedCredentials = decryptBlob(credentials.credentialsJson);
    // Choices the user made in the generate modal; each one falls back to the value sent before it existed.
    const options = invoiceData?.eInvoiceOptions || {};
    let addressId = invoiceData?.addressId;
    if (!addressId) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Address is required');
    }
    let customerAddress = invoiceData?.customer?.address?.billing;

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
        slNo: String(index + 1),
        prdDesc: item.itemName || '',
        // From the item master; additional charges are always services.
        isServc: item.isService ? 'Y' : 'N',
        hsnCd: item.hsnCode || '',
        qty: item.quantity || 1,
        unit: item?.itemUnitObj?.name || item.itemUnit || 'PCS',
        unitPrice: item.rate,
        totAmt: gross,
        discount,
        assAmt,
        gstRt,
        cgstAmt,
        sgstAmt,
        igstAmt,
        totItemVal: Number((assAmt + cgstAmt + sgstAmt + igstAmt).toFixed(2)),
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
          slNo: String(baseIndex + chargeIndex + 1),
          prdDesc: charge.name || '',
          isServc: 'Y',
          hsnCd: getAdditionalChargeHsn(options, chargeIndex),
          qty: 0,
          unit: 'OTH',
          unitPrice: 0,
          totAmt: assAmt,
          discount: 0,
          assAmt,
          gstRt: gstRate,
          cgstAmt,
          sgstAmt,
          igstAmt,
          totItemVal: Number((assAmt + cgstAmt + sgstAmt + igstAmt).toFixed(2)),
        });
      });
    }

    const invalidHsnItems = itemList.filter(it => !/^(?:\d{4}|\d{6}|\d{8})$/.test(String(it.hsnCd || '')));
    if (invalidHsnItems.length > 0) {
      const invalidHsnCodes = [...new Set(invalidHsnItems.map(it => String(it.hsnCd || '').trim() || 'MISSING'))];
      const details = invalidHsnItems.map(it => `${it.prdDesc || 'Item'} (HSN: ${it.hsnCd || 'missing'})`).join(', ');
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `A 6 to 8 digit HSN code is mandatory for taxpayers with AATO >= 5 Crores. Please update the HSN code for: ${details}. Invalid HSN code(s): ${invalidHsnCodes.join(', ')}.`,
        0,
        { invalidHsn: true, invalidHsnCodes },
      );
    }

    const assVal = Number(itemList.reduce((sum, it) => sum + it.assAmt, 0).toFixed(2));

    const valDtls = {
      assVal,
      cgstVal: Number(itemList.reduce((sum, it) => sum + it.cgstAmt, 0).toFixed(2)),
      sgstVal: Number(itemList.reduce((sum, it) => sum + it.sgstAmt, 0).toFixed(2)),
      igstVal: Number(itemList.reduce((sum, it) => sum + it.igstAmt, 0).toFixed(2)),
      cesVal: 0,
      stCesVal: 0,
      othChrg: 0,
      rndOffAmt: invoiceData.isRoundOff ? Number((invoiceData.roundOffAmount || 0).toFixed(2)) : 0,
      totInvVal: Number((invoiceData.total || 0).toFixed(2)),
    };
    let ewbDtls = {};
    if (ewbDtlsValues) {
      ewbDtls = {
        Distance: ewbDtlsValues.Distance,
        transDocDt: moment().format('DD/MM/YYYY'),
      };
    }

    if (ewbDtlsValues?.TransMode) {
      ewbDtls.TransMode = ewbDtlsValues.TransMode;
    }

    if (ewbDtlsValues?.TransId) {
      ewbDtls.TransId = ewbDtlsValues.TransId;
    }
    if (ewbDtlsValues?.TransName) {
      ewbDtls.TransName = ewbDtlsValues.TransName;
    }

    if (ewbDtls.TransMode === '1') {
      ewbDtls.VehNo = ewbDtlsValues.VehNo;
      ewbDtls.VehType = ewbDtlsValues.VehType;
    } else if (ewbDtls.TransMode === '2') {
      ewbDtls.RRNo = ewbDtlsValues.RRNo;
      ewbDtls.RRDate = moment(ewbDtlsValues.RRDate).format('DD/MM/YYYY');
    } else if (ewbDtls.TransMode === '3') {
      ewbDtls.AWBNo = ewbDtlsValues.AWBNo;
      ewbDtls.AWBDate = moment(ewbDtlsValues.AWBDate).format('DD/MM/YYYY');
    } else if (ewbDtls.TransMode === '4') {
      ewbDtls.BLNo = ewbDtlsValues.BLNo;
      ewbDtls.BLDate = moment(ewbDtlsValues.BLDate).format('DD/MM/YYYY');
    }

    const docNo = invoiceData.invoiceId;
    const requestPayload = {
      action: 'GENERATEIRN',
      data: {
        version: '1.01',
        tranDtls: {
          taxSch: 'GST',
          supTyp: invoiceData.supplyType || 'B2B',
          regRev: 'N',
          igstOnIntra: 'N',
        },
        docDtls: {
          typ: getGstDocumentType(invoiceData).nicDocType,
          no: docNo,
          dt: moment(invoiceData.invoiceDate || new Date()).format('DD/MM/YYYY'),
        },
        sellerDtls: {
          gstin: company?.gstNumber,
          lglNm: company?.name,
          trdNm: options.sellerTradeName || company?.name,
          addr1: company?.address?.street1 || '',
          addr2: company?.address?.street2 || '',
          loc: company?.address?.city || '',
          pin: verifyPinCodeByStateCode(stateIndex, getStateCode(company?.address?.state), company?.address?.pinCode, 'Seller')
            ? company?.address?.pinCode
            : '',
          stcd: getStateCode(company?.address?.state),
          ph: company.contactPhone || '',
          em: company.email || '',
        },
        buyerDtls: {
          gstin: invoiceData?.customer?.otherDetails?.gstinUin || 'URP',
          lglNm: invoiceData?.customer?.companyName || invoiceData?.customer?.customerDisplayName,
          trdNm: invoiceData?.customer?.companyName || invoiceData?.customer?.customerDisplayName,
          addr1: customerAddress?.address?.street1 || '',
          addr2: customerAddress?.address?.street2 || '',
          loc: customerAddress?.city || '',
          pin: verifyPinCodeByStateCode(stateIndex, getStateCode(customerAddress?.state), customerAddress?.pinCode, 'Customer')
            ? customerAddress?.pinCode
            : '',
          pos: getStateCode(customerAddress?.state),
          stcd: getStateCode(customerAddress?.state),
          ph: invoiceData?.customer?.customerPhoneNumber || '',
          em: invoiceData?.customer?.bpEmail || '',
        },
        dispDtls: {
          nm: company?.name,
          addr1: dispatchAddress?.street1 || '',
          addr2: dispatchAddress?.street2 || '',
          loc: dispatchAddress?.city || '',
          pin: verifyPinCodeByStateCode(
            stateIndex,
            getStateCode(dispatchAddress?.state),
            dispatchAddress?.pinCode,
            'Dispatch From',
          )
            ? dispatchAddress?.pinCode
            : '',
          stcd: getStateCode(dispatchAddress?.state),
        },
        shipDtls: {
          gstin: shipToGstin,
          lglNm: invoiceData?.customer?.companyName || invoiceData?.customer?.customerDisplayName,
          addr1: shipAddress?.address?.street1 || '',
          addr2: shipAddress?.address?.street2 || '',
          loc: shipAddress?.city || '',
          pin: verifyPinCodeByStateCode(stateIndex, getStateCode(shipAddress?.state), shipAddress?.pinCode, 'Customer')
            ? shipAddress?.pinCode
            : '',
          stcd: getStateCode(shipAddress?.state),
        },
        valDtls,
        itemList,
      },
    };

    if (ewbDtlsValues) {
      requestPayload.data.ewbDtls = ewbDtls;
    }

    const validatedRequestPayload = await eInvoiceSchema.validate(requestPayload);
    if (validatedRequestPayload.error) {
      throw new ApiError(httpStatus.BAD_REQUEST, validatedRequestPayload.error.message);
    }

    const nicPayload = toNicPayload(requestPayload.data, options);
    logger.info(
      `[eInvoice IRN request] doc=${nicPayload?.DocDtls?.No} company=${companyId} payload=${JSON.stringify(nicPayload)}`,
    );
    const authContext = {
      credentials: decryptedCredentials,
      companyId,
      gstNumber: company.gstNumber,
      userId,
      packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
      referenceId: invoiceData._id,
      referenceType: getGstDocumentType(invoiceData).modelName,
    };
    let URL = buildFynamicsUrl(FYNAMICS_ROUTES.EINVOICE_GENERATE_IRN, resolveSandboxOverrides(decryptedCredentials)?.baseUrl);
    const headerTracker = {};
    try {
      const result = await postToFynamics(FYNAMICS_ROUTES.EINVOICE_GENERATE_IRN, nicPayload, authContext, headerTracker);
      const { response, normalized } = result;
      URL = result.URL;
      console.log('FYNAMICS_EINVOICE_RESPONSE ==============================> ', response?.data);

      let message = 'E Invoice generated successfully';
      if (normalized.status != 1) {
        message = buildErrorMessage(normalized, 'Failed to generate E Invoice');
      }

      const hsnApiError = normalized?.error?.find(err => String(err.errorCodes) === '2311');
      if (hsnApiError) {
        const invalidHsnCodes = [
          ...new Set(
            itemList.filter(it => !/^\d{6}$|^\d{8}$/.test(String(it.hsnCd || ''))).map(it => String(it.hsnCd || 'MISSING')),
          ),
        ];
        await logApiCall(
          credentials._id,
          userId,
          companyId,
          URL,
          nicPayload,
          response.data,
          hsnApiError.errorMsg,
          response.status,
          String(normalized.status ?? '0'),
          {
            packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
            referenceId: invoiceData._id,
            referenceType: getGstDocumentType(invoiceData).modelName,
            chargeable: true,
            providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
            requestHeader: headerTracker.headers,
            responseHeader: response.headers,
          },
        );
        throw new ApiError(httpStatus.BAD_REQUEST, hsnApiError.errorMsg, 0, { invalidHsn: true, invalidHsnCodes });
      }

      if (normalized.status == 1) {
        const invoice = await Invoice.findById(invoiceData._id).session(session);
        if (invoice) {
          const data = normalized.data;
          const eInvoicePayload = {
            status: data?.Status,
            QRCode: data?.QRCode || buildQRCodeFromSignedQr(data?.SignedQRCode),
            irn: data?.Irn,
            remarks: data?.Remarks,
            signedQrCode: data?.SignedQRCode,
            signedInvoice: data?.SignedInvoice,
            ackNo: data?.AckNo,
            ackDate: data?.AckDt ? parseDmy(data?.AckDt, 'YYYY-MM-DD HH:mm:ss') : null,
            docNo: invoiceData.invoiceId,
            provider: THIRD_PARTY_PROVIDERS.FYNAMICS,
          };

          if (data?.EwbNo) {
            const eWayBillPayload = {
              eWayBillNo: Number(data?.EwbNo || 0),
              eWayBillDate: data?.EwbDt ? parseDmy(data?.EwbDt, 'YYYY-MM-DD HH:mm:ss') : null,
              eWayBillExpiryDate: data?.EwbValidTill ? parseDmy(data?.EwbValidTill, 'YYYY-MM-DD HH:mm:ss') : null,
              linkedIrn: data?.Irn,
              provider: THIRD_PARTY_PROVIDERS.FYNAMICS,
            };

            if (ewbDtlsValues?.TransMode) {
              eWayBillPayload.transportMode = ewbDtlsValues?.TransMode;
            }

            eWayBillPayload.transDocNo = invoiceData.invoiceId;

            if (ewbDtlsValues?.TransId) {
              eWayBillPayload.transporterId = ewbDtlsValues?.TransId;
            }
            if (ewbDtlsValues?.TransName) {
              eWayBillPayload.transporterName = ewbDtlsValues?.TransName;
            }

            if (ewbDtlsValues?.TransMode === '1') {
              eWayBillPayload.vehicleNumber = ewbDtlsValues?.VehNo;
              eWayBillPayload.vehicleType = ewbDtlsValues?.VehType;
            } else if (ewbDtlsValues?.TransMode === '2') {
              eWayBillPayload.railwayReceiptNumber = ewbDtlsValues?.RRNo;
              eWayBillPayload.railwayReceiptDate = ewbDtlsValues?.RRDate;
            } else if (ewbDtlsValues?.TransMode === '3') {
              eWayBillPayload.airwayBillNumber = ewbDtlsValues?.AWBNo;
              eWayBillPayload.airwayBillDate = ewbDtlsValues?.AWBDate;
            } else if (ewbDtlsValues?.TransMode === '4') {
              eWayBillPayload.seawayBillNumber = ewbDtlsValues?.BLNo;
              eWayBillPayload.seawayBillDate = ewbDtlsValues?.BLDate;
            }

            const infoList = Array.isArray(normalized.info) ? normalized.info : [];
            const ewbInfo = infoList.find(infoItem => infoItem?.InfCd === 'EWBPPD');

            if (ewbInfo && typeof ewbInfo?.Desc === 'string') {
              const match = ewbInfo.Desc.match(/(\d+)\s*KM/i);
              if (match && match[1]) {
                eWayBillPayload.distance = Number(match[1]);
              }
            }

            invoice.eWayBill = eWayBillPayload;
          }

          invoice.eInvoice = eInvoicePayload;
          const generationMessage = data?.EwbNo
            ? `E-Invoice (IRN: ${invoice?.eInvoice?.irn}) and E-Way Bill (No: ${invoice?.eWayBill?.eWayBillNo}) generated successfully for ${getGstDocumentLabel(invoiceData)} No: ${invoice?.eInvoice?.docNo}.`
            : `E-Invoice (IRN: ${invoice?.eInvoice?.irn}) generated successfully for ${getGstDocumentLabel(invoiceData)} No: ${invoice?.eInvoice?.docNo}.`;
          invoice.commentHistory.push({
            message: generationMessage,
            addedBy: userId,
            createdAt: new Date(),
          });
          invoice.updatedBy = userId;
          await invoice.save({ session });
        }
      }
      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        nicPayload,
        response.data,
        message,
        response.status,
        String(normalized.status ?? '0'),
        {
          packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
          referenceId: invoiceData._id,
          referenceType: getGstDocumentType(invoiceData).modelName,
          chargeable: true,
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: response.headers,
        },
      );
      return normalized;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const apiResponseData = error?.response?.data;
      const normalizedError = normalizeFynamicsResponse(apiResponseData);
      const errData = normalizedError?.error;
      const errorMessage =
        apiResponseData?.message ||
        (Array.isArray(errData)
          ? errData
              .map(err => err?.errorMsg)
              .filter(Boolean)
              .join(', ')
          : typeof errData === 'string'
            ? errData
            : null) ||
        error?.message ||
        'E-Invoice generation failed';
      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        nicPayload,
        apiResponseData,
        errorMessage,
        error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
        String(normalizedError?.status ?? '0'),
        {
          packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
          referenceId: invoiceData._id,
          referenceType: getGstDocumentType(invoiceData).modelName,
          chargeable: Boolean(error?.response),
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: error?.response?.headers,
        },
      );
      const hsnApiErrorInCatch = Array.isArray(errData) && errData.find(err => String(err.errorCodes) === '2311');
      if (hsnApiErrorInCatch) {
        const invalidHsnCodes = [
          ...new Set(
            itemList.filter(it => !/^\d{6}$|^\d{8}$/.test(String(it.hsnCd || ''))).map(it => String(it.hsnCd || 'MISSING')),
          ),
        ];
        throw new ApiError(httpStatus.BAD_REQUEST, errorMessage, 0, { invalidHsn: true, invalidHsnCodes });
      }
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, errorMessage);
    }
  } catch (error) {
    throw error;
  }
};

const cancelFynamicsEInvoice = async (cancellationDetails, companyId, userId, referenceId) => {
  const { Company, ThirdPartyCredentials } = getCommonModels();
  try {
    const company = await Company.findById(companyId);
    if (!company) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
    }

    const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.FYNAMICS });
    if (!credentials) {
      throw new ApiError(httpStatus.NOT_FOUND, GST_MESSAGES.CREDENTIALS_NOT_FOUND);
    }
    const decryptedCredentials = decryptBlob(credentials.credentialsJson);

    const requestPayload = {
      Irn: cancellationDetails.irn,
      CnlRsn: CANCELLATION_REASONS[cancellationDetails.cancellationReasonCode].value,
      CnlRem:
        cancellationDetails.cancellationReasonCode !== 4
          ? CANCELLATION_REASONS[cancellationDetails.cancellationReasonCode].label
          : cancellationDetails.cancellationReasonRemarks,
    };

    const authContext = {
      credentials: decryptedCredentials,
      companyId,
      gstNumber: company.gstNumber,
      userId,
      packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
      referenceId,
      referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
    };
    let URL = buildFynamicsUrl(FYNAMICS_ROUTES.EINVOICE_CANCEL_IRN, resolveSandboxOverrides(decryptedCredentials)?.baseUrl);
    const headerTracker = {};
    try {
      const result = await postToFynamics(FYNAMICS_ROUTES.EINVOICE_CANCEL_IRN, requestPayload, authContext, headerTracker);
      const { response, normalized } = result;
      URL = result.URL;
      console.log('FYNAMICS_CANCEL_EINVOICE_RESPONSE ==============================> ', response?.data);

      let message = 'E Invoice cancelled successfully';
      if (normalized.status != 1) {
        message = buildErrorMessage(normalized, 'Failed to cancel E Invoice');
      }

      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        requestPayload,
        response.data,
        message,
        response.status,
        String(normalized.status ?? '0'),
        {
          packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
          referenceId,
          referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
          chargeable: true,
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: response.headers,
        },
      );
      return normalized;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const apiResponseData = error?.response?.data;
      const normalizedError = normalizeFynamicsResponse(apiResponseData);
      const errData = normalizedError?.error;
      const errorMessage =
        (Array.isArray(errData)
          ? errData
              .map(err => err?.errorMsg)
              .filter(Boolean)
              .join(', ')
          : typeof errData === 'string'
            ? errData
            : null) ||
        apiResponseData?.message ||
        error?.message ||
        'Failed to cancel E Invoice';
      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        requestPayload,
        apiResponseData,
        errorMessage,
        error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
        String(normalizedError?.status ?? '0'),
        {
          packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
          referenceId,
          referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
          chargeable: true,
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: error?.response?.headers,
        },
      );
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, errorMessage);
    }
  } catch (error) {
    throw error;
  }
};

const getFynamicsEInvoiceByDocDetails = async (invoice, companyId, userId, session) => {
  const { Company, ThirdPartyCredentials } = getCommonModels();

  const company = await Company.findById(companyId);
  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.FYNAMICS });
  if (!credentials) {
    throw new ApiError(httpStatus.NOT_FOUND, GST_MESSAGES.CREDENTIALS_NOT_FOUND);
  }
  const decryptedCredentials = decryptBlob(credentials.credentialsJson);

  const params = {
    doctype: 'INV',
    docno: invoice.invoiceId,
    docdt: moment(invoice.invoiceDate || new Date()).format('DD/MM/YYYY'),
  };

  const authContext = {
    credentials: decryptedCredentials,
    companyId,
    gstNumber: company.gstNumber,
    userId,
    packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
    referenceId: invoice._id,
    referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
  };
  let URL = buildFynamicsUrl(FYNAMICS_ROUTES.EINVOICE_GET_IRN_BY_DOC, resolveSandboxOverrides(decryptedCredentials)?.baseUrl);
  const headerTracker = {};

  try {
    const result = await requestFynamics(FYNAMICS_ROUTES.EINVOICE_GET_IRN_BY_DOC, authContext, {
      method: 'get',
      params,
      headerTracker,
    });
    const { response, normalized } = result;
    URL = result.URL;
    console.log('FYNAMICS_GET_IRN_BY_DOC_RESPONSE ==============================> ', response?.data);

    let message = 'E-Invoice details fetched successfully';
    if (normalized.status != 1) {
      message = buildErrorMessage(normalized, 'Failed to fetch E-Invoice details');
    }

    if (normalized.status == 1) {
      const data = normalized.data;
      invoice.eInvoice = {
        status: data?.Status,
        QRCode: data?.QRCode || buildQRCodeFromSignedQr(data?.SignedQRCode),
        irn: data?.Irn,
        remarks: data?.Remarks,
        signedQrCode: data?.SignedQRCode,
        signedInvoice: data?.SignedInvoice,
        ackNo: data?.AckNo,
        ackDate: data?.AckDt ? parseDmy(data?.AckDt, 'YYYY-MM-DD HH:mm:ss') : null,
        docNo: invoice?.invoiceId,
        provider: THIRD_PARTY_PROVIDERS.FYNAMICS,
      };
      invoice.commentHistory.push({
        message: `E-Invoice (IRN: ${invoice?.eInvoice?.irn}) re-fetched for Invoice No: ${invoice?.invoiceId}.`,
        addedBy: userId,
        createdAt: new Date(),
      });
      invoice.updatedBy = userId;
      await invoice.save({ session });
    }

    await logApiCall(
      credentials._id,
      userId,
      companyId,
      URL,
      { params },
      response.data,
      message,
      response.status,
      String(normalized.status ?? '0'),
      {
        packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
        referenceId: invoice._id,
        referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
        chargeable: true,
        providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
        requestHeader: headerTracker.headers,
        responseHeader: response.headers,
      },
    );
    return normalized;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const apiResponseData = error?.response?.data;
    const normalizedError = normalizeFynamicsResponse(apiResponseData);
    const errData = normalizedError?.error;
    const errorMessage =
      (Array.isArray(errData)
        ? errData
            .map(err => err?.errorMsg)
            .filter(Boolean)
            .join(', ')
        : typeof errData === 'string'
          ? errData
          : null) ||
      apiResponseData?.message ||
      error?.message ||
      'Failed to fetch E-Invoice details';
    await logApiCall(
      credentials._id,
      userId,
      companyId,
      URL,
      { params },
      apiResponseData,
      errorMessage,
      error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
      String(normalizedError?.status ?? '0'),
      {
        packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
        referenceId: invoice._id,
        referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
        chargeable: Boolean(error?.response),
        providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
        requestHeader: headerTracker.headers,
        responseHeader: error?.response?.headers,
      },
    );
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, errorMessage);
  }
};

const generateFynamicsEWayBill = async (invoiceData, ewaybillDtlsValues, companyId, userId, session) => {
  const { Company, ThirdPartyCredentials } = getCommonModels();
  const Invoice = getGstDocumentModel(invoiceData);
  try {
    const company = await Company.findById(companyId);
    if (!company) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
    }

    const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.FYNAMICS });
    if (!credentials) {
      throw new ApiError(httpStatus.NOT_FOUND, GST_MESSAGES.CREDENTIALS_NOT_FOUND);
    }
    const decryptedCredentials = decryptBlob(credentials.credentialsJson);

    const irn = invoiceData?.eInvoice?.irn;
    if (!irn) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'IRN not found for this invoice. Please generate the e-invoice first.');
    }

    const requestPayload = {
      Irn: irn,
      Distance: Number(ewaybillDtlsValues.Distance) || 0,
      TransDocDt: moment().format('DD/MM/YYYY'),
    };

    if (ewaybillDtlsValues?.TransMode) {
      requestPayload.TransMode = ewaybillDtlsValues.TransMode;
    }
    if (ewaybillDtlsValues?.TransId) {
      requestPayload.TransId = ewaybillDtlsValues.TransId;
    }
    if (ewaybillDtlsValues?.TransName) {
      requestPayload.TransName = ewaybillDtlsValues.TransName;
    }

    if (ewaybillDtlsValues?.TransMode === '1') {
      requestPayload.VehNo = ewaybillDtlsValues.VehNo;
      requestPayload.VehType = ewaybillDtlsValues.VehType;
    } else if (ewaybillDtlsValues?.TransMode === '2') {
      requestPayload.TransDocNo = ewaybillDtlsValues.RRNo;
      requestPayload.TransDocDt = moment(ewaybillDtlsValues.RRDate).format('DD/MM/YYYY');
    } else if (ewaybillDtlsValues?.TransMode === '3') {
      requestPayload.TransDocNo = ewaybillDtlsValues.AWBNo;
      requestPayload.TransDocDt = moment(ewaybillDtlsValues.AWBDate).format('DD/MM/YYYY');
    } else if (ewaybillDtlsValues?.TransMode === '4') {
      requestPayload.TransDocNo = ewaybillDtlsValues.BLNo;
      requestPayload.TransDocDt = moment(ewaybillDtlsValues.BLDate).format('DD/MM/YYYY');
    }

    const validated = generateEWayBillByIrnSchema.validate(requestPayload);
    if (validated.error) {
      throw new ApiError(httpStatus.BAD_REQUEST, validated.error.message);
    }

    const authContext = {
      credentials: decryptedCredentials,
      companyId,
      gstNumber: company.gstNumber,
      collection: COLLECTION.EWAYBILL,
      userId,
      packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
      referenceId: invoiceData._id,
      referenceType: getGstDocumentType(invoiceData).modelName,
    };
    let URL = buildFynamicsUrl(FYNAMICS_ROUTES.EWAYBILL_GENERATE_BY_IRN, resolveSandboxOverrides(decryptedCredentials)?.baseUrl);
    const headerTracker = {};
    try {
      const result = await postToFynamics(FYNAMICS_ROUTES.EWAYBILL_GENERATE_BY_IRN, requestPayload, authContext, headerTracker);
      const { response, normalized } = result;
      URL = result.URL;
      console.log('FYNAMICS_EWAYBILL_BY_IRN_RESPONSE ==============================> ', response?.data);

      let message = 'E Way Bill generated successfully';
      if (normalized.status != 1) {
        message = buildErrorMessage(normalized, 'Failed to generate E Way Bill');
      }

      if (normalized.status == 1) {
        const invoice = await Invoice.findById(invoiceData._id).session(session);
        if (invoice) {
          const data = normalized.data;
          const eWayBillPayload = {
            eWayBillNo: Number(data?.EwbNo || 0),
            eWayBillDate: data?.EwbDt ? parseDmy(data?.EwbDt, 'YYYY-MM-DD HH:mm:ss') : null,
            eWayBillExpiryDate: data?.EwbValidTill ? parseDmy(data?.EwbValidTill, 'YYYY-MM-DD HH:mm:ss') : null,
            linkedIrn: irn,
            transDocNo: requestPayload.TransDocNo,
            provider: THIRD_PARTY_PROVIDERS.FYNAMICS,
          };

          if (ewaybillDtlsValues?.TransId) {
            eWayBillPayload.transporterId = ewaybillDtlsValues.TransId;
          }
          if (ewaybillDtlsValues?.TransName) {
            eWayBillPayload.transporterName = ewaybillDtlsValues.TransName;
          }
          if (ewaybillDtlsValues?.TransMode) {
            eWayBillPayload.transportMode = ewaybillDtlsValues.TransMode;
          }

          if (ewaybillDtlsValues?.TransMode === '1') {
            eWayBillPayload.vehicleNumber = ewaybillDtlsValues.VehNo;
            eWayBillPayload.vehicleType = ewaybillDtlsValues.VehType;
          } else if (ewaybillDtlsValues?.TransMode === '2') {
            eWayBillPayload.railwayReceiptNumber = ewaybillDtlsValues.RRNo;
            eWayBillPayload.railwayReceiptDate = ewaybillDtlsValues.RRDate;
          } else if (ewaybillDtlsValues?.TransMode === '3') {
            eWayBillPayload.airwayBillNumber = ewaybillDtlsValues.AWBNo;
            eWayBillPayload.airwayBillDate = ewaybillDtlsValues.AWBDate;
          } else if (ewaybillDtlsValues?.TransMode === '4') {
            eWayBillPayload.seawayBillNumber = ewaybillDtlsValues.BLNo;
            eWayBillPayload.seawayBillDate = ewaybillDtlsValues.BLDate;
          }

          const infoDescriptions = Array.isArray(normalized.info) ? normalized.info.map(item => item?.Desc) : [normalized.info];
          const distanceFromProvider = [data?.Remarks, ...infoDescriptions]
            .filter(text => typeof text === 'string')
            .map(text => text.match(/(\d+)\s*KM/i))
            .find(match => match && match[1]);

          if (distanceFromProvider) {
            eWayBillPayload.distance = Number(distanceFromProvider[1]);
          }
          if (
            (!invoice?.eWayBill?.distance || invoice?.eWayBill?.status === E_WAY_BILL_STATUS.CNL.value) &&
            ewaybillDtlsValues?.Distance > 0
          ) {
            eWayBillPayload.distance = ewaybillDtlsValues.Distance;
          }
          if (!eWayBillPayload.distance) {
            eWayBillPayload.distance = Number(requestPayload.Distance) || 0;
          }

          invoice.eWayBill = eWayBillPayload;
          invoice.commentHistory.push({
            message: `E-Way Bill (No: ${invoice?.eWayBill?.eWayBillNo}) generated successfully for ${getGstDocumentLabel(invoiceData)} No: ${invoiceData.invoiceId}.`,
            addedBy: userId,
            createdAt: new Date(),
          });
          invoice.updatedBy = userId;
          await invoice.save({ session });
        }
      }

      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        requestPayload,
        response.data,
        message,
        response.status,
        String(normalized.status ?? '0'),
        {
          packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
          referenceId: invoiceData._id,
          referenceType: getGstDocumentType(invoiceData).modelName,
          chargeable: true,
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: response.headers,
        },
      );
      return normalized;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const apiResponseData = error?.response?.data;
      const normalizedError = normalizeFynamicsResponse(apiResponseData);
      const errData = normalizedError?.error;
      const errorMessage =
        (Array.isArray(errData)
          ? errData
              .map(err => err?.errorMsg)
              .filter(Boolean)
              .join(', ')
          : typeof errData === 'string'
            ? errData
            : null) ||
        apiResponseData?.message ||
        error?.message ||
        'Failed to generate E Way Bill';
      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        requestPayload,
        apiResponseData,
        errorMessage,
        error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
        String(normalizedError?.status ?? '0'),
        {
          packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
          referenceId: invoiceData._id,
          referenceType: getGstDocumentType(invoiceData).modelName,
          chargeable: Boolean(error?.response),
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: error?.response?.headers,
        },
      );
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, errorMessage);
    }
  } catch (error) {
    throw error;
  }
};

const cancelFynamicsEWayBill = async (cancellationDetails, companyId, userId, referenceId) => {
  const { Company, ThirdPartyCredentials } = getCommonModels();
  try {
    const company = await Company.findById(companyId);
    if (!company) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
    }

    const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.FYNAMICS });
    if (!credentials) {
      throw new ApiError(httpStatus.NOT_FOUND, GST_MESSAGES.CREDENTIALS_NOT_FOUND);
    }
    const decryptedCredentials = decryptBlob(credentials.credentialsJson);

    const requestPayload = {
      ewbNo: Number(cancellationDetails.eWayBillNo),
      cancelRsnCode: Number(E_WAY_BILL_CANCELLATION_REASONS[cancellationDetails.cancellationReasonCode].value),
      cancelRmrk:
        cancellationDetails.cancellationReasonCode !== 2
          ? E_WAY_BILL_CANCELLATION_REASONS[cancellationDetails.cancellationReasonCode].label
          : cancellationDetails.cancellationReasonRemarks,
    };

    const authContext = {
      credentials: decryptedCredentials,
      companyId,
      gstNumber: company.gstNumber,
      collection: COLLECTION.EWAYBILL,
      userId,
      packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
      referenceId,
      referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
    };
    let URL = buildFynamicsUrl(FYNAMICS_ROUTES.EWAYBILL_CANCEL, resolveSandboxOverrides(decryptedCredentials)?.baseUrl);
    const headerTracker = {};
    try {
      const result = await postToFynamics(FYNAMICS_ROUTES.EWAYBILL_CANCEL, requestPayload, authContext, headerTracker);
      const { response, normalized } = result;
      URL = result.URL;
      console.log('FYNAMICS_CANCEL_EWAYBILL_RESPONSE ==============================> ', response?.data);

      let message = 'E Way Bill cancelled successfully';
      if (normalized.status != 1) {
        message = buildErrorMessage(normalized, 'Failed to cancel E Way Bill');
      }

      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        requestPayload,
        response.data,
        message,
        response.status,
        String(normalized.status ?? '0'),
        {
          packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
          referenceId,
          referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
          chargeable: true,
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: response.headers,
        },
      );
      return normalized;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const apiResponseData = error?.response?.data;
      const normalizedError = normalizeFynamicsResponse(apiResponseData);
      const errData = normalizedError?.error;
      const errorMessage =
        (Array.isArray(errData)
          ? errData
              .map(err => err?.errorMsg)
              .filter(Boolean)
              .join(', ')
          : typeof errData === 'string'
            ? errData
            : null) ||
        apiResponseData?.message ||
        error?.message ||
        'Failed to cancel E Way Bill';
      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        requestPayload,
        apiResponseData,
        errorMessage,
        error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
        String(normalizedError?.status ?? '0'),
        {
          packageName: PLAN_FEATURES.E_INVOICE_AND_E_WAY_BILL,
          referenceId,
          referenceType: THIRD_PARTY_API_LOG_REFERENCE_TYPES.INVOICE,
          chargeable: Boolean(error?.response),
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: error?.response?.headers,
        },
      );
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, errorMessage);
    }
  } catch (error) {
    throw error;
  }
};

const generateFynamicsOnlyEWayBill = async (invoiceData, ewaybillDtlsValues, companyId, userId, session) => {
  const { Company, ThirdPartyCredentials } = getCommonModels();
  const Invoice = getGstDocumentModel(invoiceData);
  try {
    const company = await Company.findById(companyId);
    if (!company) throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');

    const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.FYNAMICS });
    if (!credentials) throw new ApiError(httpStatus.BAD_REQUEST, GST_MESSAGES.CREDENTIALS_NOT_FOUND);

    const decryptedCredentials = decryptBlob(credentials.credentialsJson);

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

    const isIGST = isIGSTExists({
      stateIndex,
      myState: company.address.state,
      customerState: customerAddress.state,
      myGSTNo: company.gstNumber,
      customerGSTNo: invoiceData.customer.otherDetails.gstinUin,
    });

    // Goods can move from and to addresses other than the billing ones; both default to the billing addresses.
    // The party side is the address chosen on the document; the company side is its registered address.
    const dispatchAddress = company.address;
    const shipAddress = customerAddress;

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
        productDesc: item.itemName || '',
        productName: item.itemName || '',
        hsnCode: item.hsnCode || '',
        quantity: item.quantity,
        qtyUnit: item?.itemUnitObj?.name || item.itemUnit || 'PCS',
        unitPrice: item.rate,
        taxableAmount,

        cgstRate: isIGST ? 0 : gstRate / 2,
        sgstRate: isIGST ? 0 : gstRate / 2,
        igstRate: isIGST ? gstRate : 0,

        cessRate: 0,
        cessNonAdvol: 0,
      };
    });

    if (invoiceData?.additionalCharges?.length > 0) {
      invoiceData.additionalCharges.forEach((charge, chargeIndex) => {
        const taxableAmount = Number(charge.amount.toFixed(2));
        const gstRate = charge.isTaxable ? Number(charge.taxRate || 0) : 0;

        itemList.push({
          productDesc: charge.name || '',
          productName: charge.name || '',
          hsnCode: getAdditionalChargeHsn(ewaybillDtlsValues, chargeIndex),
          quantity: 0,
          qtyUnit: 'OTH',
          unitPrice: 0,
          taxableAmount,

          cgstRate: isIGST || !charge.isTaxable ? 0 : gstRate / 2,
          sgstRate: isIGST || !charge.isTaxable ? 0 : gstRate / 2,
          igstRate: isIGST && charge.isTaxable ? gstRate : 0,

          cessRate: 0,
          cessNonAdvol: 0,
        });
      });
    }

    const invalidHsnItems = itemList.filter(it => !/^(?:\d{4}|\d{6}|\d{8})$/.test(String(it.hsnCode || '')));
    if (invalidHsnItems.length > 0) {
      const invalidHsnCodes = [...new Set(invalidHsnItems.map(it => String(it.hsnCode || '').trim() || 'MISSING'))];
      const details = invalidHsnItems.map(it => `${it.productName || 'Item'} (HSN: ${it.hsnCode || 'missing'})`).join(', ');
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        `A 6 to 8 digit HSN code is mandatory for taxpayers with AATO >= 5 Crores. Please update the HSN code for: ${details}. Invalid HSN code(s): ${invalidHsnCodes.join(', ')}.`,
        0,
        { invalidHsn: true, invalidHsnCodes },
      );
    }

    const valDtls = itemList.reduce(
      (a, i) => {
        const tax = i.taxableAmount;
        const cgst = (tax * i.cgstRate) / 100;
        const sgst = (tax * i.sgstRate) / 100;
        const igst = (tax * i.igstRate) / 100;

        a.assVal += tax;
        a.cgstVal += cgst;
        a.sgstVal += sgst;
        a.igstVal += igst;
        a.totInvVal += tax + cgst + sgst + igst;

        return a;
      },
      { assVal: 0, cgstVal: 0, sgstVal: 0, igstVal: 0, totInvVal: 0 },
    );

    valDtls.othChrg = 0;

    if (invoiceData.isRoundOff) {
      valDtls.othChrg = invoiceData.roundOffAmount || 0;
      valDtls.totInvVal += valDtls.othChrg;
    }

    const data = {
      supplyType: ewaybillDtlsValues.supplyType,
      subSupplyType: ewaybillDtlsValues.subSupplyType,
      ...(ewaybillDtlsValues.subSupplyDesc && { subSupplyDesc: ewaybillDtlsValues.subSupplyDesc }),
      docType: resolveEWayBillDocumentType(invoiceData, ewaybillDtlsValues).value,
      docNo: invoiceData.invoiceId,
      docDate: moment(invoiceData.invoiceDate).format('DD/MM/YYYY'),

      fromGstin: company.gstNumber,
      fromTrdName: company.name,
      fromAddr1: dispatchAddress.street1,
      fromAddr2: dispatchAddress.street2,
      fromPlace: dispatchAddress.city,
      fromPincode: verifyPinCodeByStateCode(stateIndex, getStateCode(dispatchAddress.state), dispatchAddress?.pinCode, 'Company')
        ? dispatchAddress?.pinCode
        : '',
      actFromStateCode: getStateCode(dispatchAddress.state),
      fromStateCode: getStateCode(company.address.state),

      toGstin: invoiceData.customer.otherDetails.gstinUin || 'URP',
      toTrdName: invoiceData.customer.companyName || invoiceData.customer.customerDisplayName,
      toAddr1: shipAddress.address.street1,
      toAddr2: shipAddress.address.street2,
      toPlace: shipAddress.city,
      toPincode: verifyPinCodeByStateCode(stateIndex, getStateCode(shipAddress.state), shipAddress?.pinCode, 'Customer')
        ? shipAddress?.pinCode
        : '',
      actToStateCode: getStateCode(shipAddress.state),
      toStateCode: getStateCode(customerAddress.state),

      transactionType: '1',

      totalValue: parseFloat(valDtls.assVal?.toFixed(2)),
      cgstValue: isIGST ? 0 : parseFloat(valDtls.cgstVal?.toFixed(2)),
      sgstValue: isIGST ? 0 : parseFloat(valDtls.sgstVal?.toFixed(2)),
      igstValue: isIGST ? parseFloat(valDtls.igstVal?.toFixed(2)) : 0,
      cessValue: 0,
      cessNonAdvolValue: 0,
      totInvValue: parseFloat(valDtls.totInvVal?.toFixed(2)),
      otherValue: parseFloat((valDtls.othChrg || 0).toFixed(2)),

      transDistance: ewaybillDtlsValues.Distance,
      itemList,
    };

    if (ewaybillDtlsValues.transporterId && ewaybillDtlsValues.transporterName) {
      data.transporterId = ewaybillDtlsValues.transporterId;
      data.transporterName = ewaybillDtlsValues.transporterName;
    }

    if (ewaybillDtlsValues.transportMode === '1') {
      data.vehicleNo = ewaybillDtlsValues.VehNo;
      data.vehicleType = ewaybillDtlsValues.VehType;
      data.transMode = '1';
      // Road consignments may carry a transporter document (LR) number.
      if (ewaybillDtlsValues.transDocNo) {
        data.transDocNo = ewaybillDtlsValues.transDocNo;
        if (ewaybillDtlsValues.transDocDate) data.transDocDate = moment(ewaybillDtlsValues.transDocDate).format('DD/MM/YYYY');
      }
    } else if (ewaybillDtlsValues.transportMode === '2') {
      data.railwayReceiptNumber = ewaybillDtlsValues.RRNo;
      data.railwayReceiptDate = ewaybillDtlsValues.RRDate;
      data.transMode = '2';
    } else if (ewaybillDtlsValues.transportMode === '3') {
      data.airwayBillNumber = ewaybillDtlsValues.AWBNo;
      data.airwayBillDate = ewaybillDtlsValues.AWBDate;
      data.transMode = '3';
    } else if (ewaybillDtlsValues.transportMode === '4') {
      data.seawayBillNumber = ewaybillDtlsValues.BLNo;
      data.seawayBillDate = ewaybillDtlsValues.BLDate;
      data.transMode = '4';
    }

    // Built company to party; a return moves the other way.
    if (isReturnMovement(invoiceData)) swapParties(data, EWB_PARTY_FIELD_PAIRS);

    const validated = generateOnlyEWayBillSchema.validate({ action: 'GENEWAYBILL', data });
    if (validated.error) {
      throw new ApiError(httpStatus.BAD_REQUEST, validated.error.message);
    }
    const requestPayload = validated.value.data;
    requestPayload.itemList = requestPayload.itemList.map(({ cessNonAdvol, ...item }, index) => ({
      ...item,

      hsnCode: itemList[index]?.hsnCode ?? item.hsnCode,

      cessNonadvol: cessNonAdvol ?? 0,
    }));

    const authContext = {
      credentials: decryptedCredentials,
      companyId,
      gstNumber: company.gstNumber,
      collection: COLLECTION.EWAYBILL,
      userId,
      packageName: PLAN_FEATURES.ONLY_E_WAY_BILL,
      referenceId: invoiceData._id,
      referenceType: getGstDocumentType(invoiceData).modelName,
    };
    let URL = buildFynamicsUrl(FYNAMICS_ROUTES.EWAYBILL_GENERATE, resolveSandboxOverrides(decryptedCredentials)?.baseUrl);
    const headerTracker = {};
    try {
      const result = await postToFynamics(FYNAMICS_ROUTES.EWAYBILL_GENERATE, requestPayload, authContext, headerTracker);
      const { response, normalized } = result;
      URL = result.URL;
      console.log('FYNAMICS_ONLY_EWAYBILL_RESPONSE ==============================> ', response?.data);

      let message = 'E Way Bill generated successfully';
      if (normalized.status != 1) {
        message = buildErrorMessage(normalized, 'Failed to generate E Way Bill');
      }

      const hsnApiError = Array.isArray(normalized.error)
        ? normalized.error.find(err => expandErrorCodes(err?.errorCodes).some(code => HSN_ERROR_CODES.includes(code)))
        : null;
      if (hsnApiError) {
        const isLengthError = expandErrorCodes(hsnApiError.errorCodes).some(code => HSN_LENGTH_ERROR_CODES.includes(code));
        const invalidHsnCodes = isLengthError
          ? [
              ...new Set(
                itemList
                  .filter(it => !/^(?:\d{6}|\d{8})$/.test(String(it.hsnCode || '')))
                  .map(it => String(it.hsnCode || '').trim() || 'MISSING'),
              ),
            ]
          : [];
        await logApiCall(
          credentials._id,
          userId,
          companyId,
          URL,
          requestPayload,
          response?.data,
          message,
          response?.status,
          String(normalized.status ?? '0'),
          {
            packageName: PLAN_FEATURES.ONLY_E_WAY_BILL,
            referenceId: invoiceData._id,
            referenceType: getGstDocumentType(invoiceData).modelName,
            chargeable: true,
            providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
            requestHeader: headerTracker.headers,
            responseHeader: response?.headers,
          },
        );
        throw new ApiError(httpStatus.BAD_REQUEST, message, 0, { invalidHsn: true, invalidHsnCodes });
      }

      if (normalized.status == 1) {
        const invoice = await Invoice.findById(invoiceData._id).session(session);
        if (invoice) {
          const respData = normalized.data;
          const eWayBillPayload = {
            eWayBillNo: Number(respData?.ewayBillNo),
            eWayBillDate: respData?.ewayBillDate ? parseDmy(respData.ewayBillDate) : null,
            eWayBillExpiryDate: respData?.validUpto ? parseDmy(respData.validUpto) : null,
            transportMode: data.transMode,
            provider: THIRD_PARTY_PROVIDERS.FYNAMICS,
          };

          if (ewaybillDtlsValues.transporterId && ewaybillDtlsValues.transporterName) {
            eWayBillPayload.transporterId = ewaybillDtlsValues.transporterId;
            eWayBillPayload.transporterName = ewaybillDtlsValues.transporterName;
          }

          if (data.transMode === '1') {
            eWayBillPayload.vehicleNumber = data.vehicleNo;
            eWayBillPayload.vehicleType = data.vehicleType;
          } else if (data.transMode === '2') {
            eWayBillPayload.railwayReceiptNumber = data.railwayReceiptNumber;
            eWayBillPayload.railwayReceiptDate = data.railwayReceiptDate;
          } else if (data.transMode === '3') {
            eWayBillPayload.airwayBillNumber = data.airwayBillNumber;
            eWayBillPayload.airwayBillDate = data.airwayBillDate;
          } else if (data.transMode === '4') {
            eWayBillPayload.seawayBillNumber = data.seawayBillNumber;
            eWayBillPayload.seawayBillDate = data.seawayBillDate;
          }

          if (data.supplyType) eWayBillPayload.supplyType = data.supplyType;
          if (data.subSupplyType) eWayBillPayload.subSupplyType = data.subSupplyType;

          const match = typeof respData?.alert === 'string' ? respData.alert.match(/is\s*(\d+)/i) : null;
          if (match && match[1]) {
            eWayBillPayload.distance = Number(match[1]);
          }
          if (!eWayBillPayload.distance) {
            eWayBillPayload.distance = data.transDistance;
          }

          invoice.eWayBill = eWayBillPayload;
          invoice.commentHistory.push({
            message: `E-Way Bill (No: ${invoice?.eWayBill?.eWayBillNo}) generated successfully for ${getGstDocumentLabel(invoiceData)} No: ${invoiceData.invoiceId}.`,
            addedBy: userId,
            createdAt: new Date(),
          });
          invoice.updatedBy = userId;
          await invoice.save({ session });
        }
      }

      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        requestPayload,
        response?.data,
        message,
        response?.status,
        String(normalized.status ?? '0'),
        {
          packageName: PLAN_FEATURES.ONLY_E_WAY_BILL,
          referenceId: invoiceData._id,
          referenceType: getGstDocumentType(invoiceData).modelName,
          chargeable: true,
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: response?.headers,
        },
      );
      return normalized;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const apiResponseData = error?.response?.data;
      const normalizedError = normalizeFynamicsResponse(apiResponseData);
      const errData = normalizedError?.error;
      const errorMessage =
        (Array.isArray(errData)
          ? errData
              .map(err => err?.errorMsg)
              .filter(Boolean)
              .join(', ')
          : typeof errData === 'string'
            ? errData
            : null) ||
        apiResponseData?.message ||
        error?.message ||
        'Failed to generate E Way Bill';
      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        requestPayload,
        apiResponseData,
        errorMessage,
        error?.response?.status || httpStatus.INTERNAL_SERVER_ERROR,
        String(normalizedError?.status ?? '0'),
        {
          packageName: PLAN_FEATURES.ONLY_E_WAY_BILL,
          referenceId: invoiceData._id,
          referenceType: getGstDocumentType(invoiceData).modelName,
          chargeable: Boolean(error?.response),
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: headerTracker.headers,
          responseHeader: error?.response?.headers,
        },
      );
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, errorMessage);
    }
  } catch (error) {
    throw error;
  }
};

module.exports = {
  generateFynamicsEInvoice,
  cancelFynamicsEInvoice,
  getFynamicsEInvoiceByDocDetails,
  generateFynamicsEWayBill,
  cancelFynamicsEWayBill,
  generateFynamicsOnlyEWayBill,

  normalizeFynamicsResponse,
  isAuthExpiryError,
};
