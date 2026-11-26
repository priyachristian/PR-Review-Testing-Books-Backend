const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { getCommonModels, getBooksCrmModels } = require('../services/model.service');
const { TAX_TYPES } = require('../utils/enum');

const toNumber = (value, fallback = 0) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

const round2 = value => Math.round(toNumber(value, 0) * 100) / 100;

const applyRoundOff = (rawTotal, isRoundOff) => {
  const preciseTotal = round2(rawTotal);
  if (!isRoundOff) return { total: preciseTotal, roundOffAmount: 0 };
  const rounded = Math.round(preciseTotal);
  return { total: rounded, roundOffAmount: round2(rounded - preciseTotal) };
};

const getGstNumericRate = gst => {
  if (gst == null || gst === '') return 0;
  const normalized = String(gst).trim().toLowerCase();
  return normalized === 'none' || normalized === 'exempted' ? 0 : toNumber(gst, 0);
};

const normalizeStateForTaxComparison = state => {
  if (!state || typeof state !== 'string') return '';
  const trimmed = state.trim();
  const withoutLegacyCode = trimmed.replace(/^\[[A-Z]{2,5}\]\s*-\s*/i, '');
  return withoutLegacyCode.trim().toLowerCase();
};

// Copied in abss-customer-app-backend services/customerOrder.service.js (isInterState, lineTax) for sample orders.
// Change both together, or converted sample orders fail this check.
const isIGSTExists = ({ myState = '', customerState = '', myGSTNo = '', customerGSTNo = '' }) => {
  let isIGST = false;

  if (myGSTNo && customerGSTNo) {
    if (myGSTNo?.substring(0, 2) !== customerGSTNo?.substring(0, 2)) {
      isIGST = true;
    } else {
      isIGST = false;
    }
  } else {
    if (myState && customerState) {
      const normalizedMyState = normalizeStateForTaxComparison(myState);
      const normalizedCustomerState = normalizeStateForTaxComparison(customerState);

      if (normalizedMyState && normalizedMyState === normalizedCustomerState) {
        isIGST = false;
      } else {
        isIGST = true;
      }
    } else {
      isIGST = false;
    }
  }

  return isIGST;
};

const validateDocumentTotals = async (req, res, next) => {
  try {
    const { Company } = getCommonModels();
    const { Customer } = getBooksCrmModels();

    const items = Array.isArray(req?.body?.items) ? req?.body?.items : [];
    const additionalCharges = Array.isArray(req?.body?.additionalCharges) ? req?.body?.additionalCharges : [];

    // Fetch company and customer in parallel
    const [company, customer] = await Promise.all([
      Company.findById(req.query?.companyId),
      Customer.findById(req.body?.customerId || req.body?.vendorId || req.body?.vendor || req.body?.customer),
    ]);

    let shippingAddress = null;
    const isVendorDocument = Boolean(req.body?.vendorId || req.body?.vendor);

    if (isVendorDocument) {
      shippingAddress = customer?.address?.billing || null;
    } else {
      if (req.body?.addressId) {
        if (req.body.addressId.toString() === customer?.address?.shipping?._id?.toString()) {
          shippingAddress = customer?.address?.shipping;
        }
        if (!shippingAddress) {
          shippingAddress = customer?.address?.additionalShippingAddresses?.find(
            addr => addr?._id?.toString() === req.body.addressId.toString(),
          );
        }
      }
    }

    // Fall back to customer's default shipping address if no specific address selected
    if (!shippingAddress) {
      shippingAddress = customer?.address?.shipping || null;
    }

    const isIGST = isIGSTExists({
      myState: company?.address?.state,
      customerState: shippingAddress?.state,
      myGSTNo: company?.gstNumber,
      customerGSTNo: customer?.otherDetails?.gstinUin || customer?.otherDetails?.registeredBusinessValue,
    });

    const isItemDiscount = req?.body?.appliesTo === 'ITEM';
    const isTxnDiscount = req?.body?.appliesTo === 'TRANSACTION';

    const isSplitOnlyDocument = Boolean(req.body?.isSplit) && !req.body?.split;

    let additionalChargesTotal = 0;
    let additionalChargesTaxTotal = 0;

    const prepared = items.map(item => {
      const qty = toNumber(item?.quantity, 0);
      const rate = toNumber(item?.rate, 0);
      const gst = getGstNumericRate(item?.gst);

      const lineAmount = round2(qty * rate);

      let discountAmount = 0;
      let taxableAmount = lineAmount;

      if (isItemDiscount) {
        const { discountType, discountValue } = item?.discountConfig || {};

        if (discountType === 'PERCENTAGE') {
          discountAmount = (lineAmount * toNumber(discountValue, 0)) / 100;
        } else if (discountType === 'AMOUNT') {
          discountAmount = toNumber(discountValue, 0);
        }

        taxableAmount = round2(Math.max(0, lineAmount - discountAmount));
      }

      let gstAmount = 0;
      let cgstAmount = 0;

      // Use server-computed isIGST (same source of truth as validation below)
      if (!isIGST) {
        const halfGst = gst / 2;

        cgstAmount = round2((taxableAmount * halfGst) / 100);
        gstAmount = round2(cgstAmount * 2);
      } else {
        gstAmount = round2((taxableAmount * gst) / 100);
      }

      if (isSplitOnlyDocument) {
        gstAmount = 0;
        cgstAmount = 0;
      }

      return {
        qty,
        rate,
        gst,
        lineAmount,
        discountAmount,
        taxableAmount,
        gstAmount,
        cgstAmount,
        amountWithGst: round2(taxableAmount + gstAmount),
      };
    });

    let subTotal = prepared.reduce((sum, item) => sum + item.taxableAmount, 0);
    let validatedSubTotal = 0;

    if (isItemDiscount) {
      validatedSubTotal = prepared.reduce((sum, item) => sum + item.taxableAmount, 0);
    } else {
      validatedSubTotal = prepared.reduce((sum, item) => sum + item.lineAmount, 0);
    }

    validatedSubTotal = round2(validatedSubTotal);

    let totalGstAmount = prepared.reduce((sum, item) => sum + item.gstAmount, 0);

    if (isTxnDiscount) {
      const { discountType, discountValue } = req?.body?.discountConfig || {};
      const originalSubTotal = prepared.reduce((sum, item) => sum + item.lineAmount, 0);

      subTotal = 0;
      totalGstAmount = 0;

      let allocatedDiscount = 0;

      prepared.forEach((item, index) => {
        let discountedLineAmount = item.lineAmount;

        if (discountType === 'PERCENTAGE') {
          const itemDiscount = round2((item.lineAmount * toNumber(discountValue, 0)) / 100);
          discountedLineAmount = Math.max(0, item.lineAmount - itemDiscount);
        } else if (discountType === 'AMOUNT' && originalSubTotal > 0) {
          let itemDiscount = 0;

          if (index === prepared.length - 1) {
            // Last item gets remaining discount to absorb rounding differences
            itemDiscount = round2(toNumber(discountValue, 0) - allocatedDiscount);
          } else {
            itemDiscount = round2((item.lineAmount / originalSubTotal) * toNumber(discountValue, 0));
            allocatedDiscount += itemDiscount;
          }

          discountedLineAmount = Math.max(0, item.lineAmount - itemDiscount);
        }

        let gstAmount = 0;
        let cgstAmount = 0;

        // Use server-computed isIGST (same source of truth as validation below)
        if (!isIGST) {
          const halfGst = item.gst / 2;

          cgstAmount = round2((discountedLineAmount * halfGst) / 100);
          gstAmount = round2(cgstAmount * 2);
        } else {
          gstAmount = round2((discountedLineAmount * item.gst) / 100);
        }

        if (isSplitOnlyDocument) {
          gstAmount = 0;
        }

        totalGstAmount += gstAmount;
        subTotal += discountedLineAmount;
      });
    }

    additionalCharges.forEach(charge => {
      const amount = toNumber(charge?.amount, 0);

      additionalChargesTotal += amount;

      if (charge?.isTaxable && amount > 0) {
        const tax = (amount * toNumber(charge?.taxRate, 0)) / 100;

        additionalChargesTaxTotal += tax;
      }
    });

    totalGstAmount += additionalChargesTaxTotal;
    totalGstAmount = round2(totalGstAmount);

    // Use rounded totalGstAmount for grand total — matches frontend which rounds gst before summing
    let rawTotal = subTotal + totalGstAmount + additionalChargesTotal;

    // TDS is deducted from the total and TCS is added, using the amount stored on the document.
    const tdsTcs = req?.body?.tax;
    if (tdsTcs?.taxId && !req.body?.isSplit) {
      const tdsTcsAmount = round2(toNumber(tdsTcs.amount, 0));
      rawTotal += tdsTcs.type === TAX_TYPES.TDS ? -tdsTcsAmount : tdsTcsAmount;
    }

    const { total } = applyRoundOff(rawTotal, req?.body?.isRoundOff);

    if (!isIGST) {
      const getCgst = round2(totalGstAmount / 2);
      const bodyCgst = toNumber(req.body?.cgst, 0);
      const bodySgst = toNumber(req.body?.sgst, 0);

      // An intra-state document must not also carry inter-state tax: storing both
      if (toNumber(req.body?.igst, 0) !== 0) {
        return next(
          new ApiError(httpStatus.BAD_REQUEST, 'IGST must be 0 on an intra-state document that already carries SGST and CGST'),
        );
      }

      if (bodyCgst !== getCgst) {
        return next(
          new ApiError(httpStatus.BAD_REQUEST, `CGST mismatch: expected cgst is ${getCgst} received cgst is ${bodyCgst}`),
        );
      }

      if (bodySgst !== getCgst) {
        return next(
          new ApiError(httpStatus.BAD_REQUEST, `SGST mismatch: expected sgst is ${getCgst} received sgst is ${bodySgst}`),
        );
      }
    } else {
      const bodyIgst = toNumber(req.body?.igst, 0);

      if (toNumber(req.body?.sgst, 0) !== 0 || toNumber(req.body?.cgst, 0) !== 0) {
        return next(
          new ApiError(httpStatus.BAD_REQUEST, 'SGST and CGST must be 0 on an inter-state document that already carries IGST'),
        );
      }

      if (bodyIgst !== totalGstAmount) {
        return next(
          new ApiError(httpStatus.BAD_REQUEST, `IGST mismatch: expected igst is ${totalGstAmount} received igst is ${bodyIgst}`),
        );
      }
    }

    if (req?.body?.subTotal !== validatedSubTotal) {
      return next(
        new ApiError(
          httpStatus.BAD_REQUEST,
          `SubTotal mismatch: expected subTotal is ${validatedSubTotal} received subTotal is ${req?.body?.subTotal}`,
        ),
      );
    }

    if (req?.body?.totalTax !== totalGstAmount) {
      return next(
        new ApiError(
          httpStatus.BAD_REQUEST,
          `Total GST Amount mismatch: expected totalGstAmount is ${totalGstAmount} received totalGstAmount is ${req?.body?.totalTax}`,
        ),
      );
    }

    if (req?.body?.total !== total) {
      return next(
        new ApiError(httpStatus.BAD_REQUEST, `Total mismatch: expected total is ${total} received total is ${req?.body?.total}`),
      );
    }

    return next();
  } catch (error) {
    return next(new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to validate document totals'));
  }
};

module.exports = validateDocumentTotals;
