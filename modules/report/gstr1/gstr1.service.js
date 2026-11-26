const mongoose = require('mongoose');
const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { GSTR1_MESSAGES } = require('../../../utils/messages');
const { getCommonModels, getBooksModels, getBooksCrmModels } = require('../../../services/model.service');
const { MONTH_NAMES, DOCUMENT_TYPE_LABELS, NIL_BUCKET_KEYS, BUCKET_LABELS } = require('../../../utils/enum');
const { INVOICE_STATUS, CREDIT_NOTE_STATUS } = require('../../../utils/enum');
const { getGstRateForCalculation, getGstCategory } = require('../../../utils/gstRate');
const {
  getStateIndex,
  getStateCodeFromGstin,
  getStateCodeFromStateValue,
  getStateLabelFromCode,
} = require('./locationMaster.service');

const EXCLUDED_STATUSES = [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.DRAFT];

const round2 = num => Math.round((Number(num) || 0) * 100) / 100;
const toObjectId = id => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id));
const toISODate = d => (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];
const normDates = (from, to) => ({ start: new Date(from), end: new Date(to) });
const toSerial = val => (val == null || val === '' ? '' : String(val));

const fmtDDMMYYYY = date => {
  const d = date instanceof Date ? date : new Date(date);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
};

const getStateCode = (stateIndex, stateName) => {
  if (!stateName) return null;
  return getStateCodeFromStateValue(stateIndex, stateName);
};

const getPosStateCode = (stateIndex, customer) => {
  const gstin = (customer?.otherDetails?.gstinUin || customer?.gstin || '').trim();
  const fromGstin = getStateCodeFromGstin(stateIndex, gstin);
  if (fromGstin) return fromGstin;
  const state = customer?.address?.billing?.state || customer?.address?.shipping?.state || '';
  return getStateCode(stateIndex, state) || '';
};

const getGstinInfo = cust => {
  const gstin = (cust?.otherDetails?.gstinUin || cust?.gstin || '')?.trim() || '';
  return { gstin, hasGstin: !!gstin };
};

const getFYBounds = (date = new Date()) => {
  const yr = date.getFullYear();
  const mo = date.getMonth() + 1;
  const fy = mo < 4 ? yr - 1 : yr;
  return {
    previousFYStart: new Date(fy - 1, 3, 1),
    previousFYEnd: new Date(fy, 2, 31, 23, 59, 59, 999),
    currentFYQ1Start: new Date(fy, 3, 1),
    currentFYQ1End: new Date(fy, 5, 30, 23, 59, 59, 999),
  };
};

const getReturnPeriodDetails = (start, end) => {
  const s = start instanceof Date ? start : new Date(start);
  const label = `${MONTH_NAMES[s.getMonth()]} ${s.getFullYear()}`;
  return {
    label,
    periodStart: toISODate(s),
    periodEnd: toISODate(end),
    displayRange: `${label} (${fmtDDMMYYYY(s)} to ${fmtDDMMYYYY(end)})`,
  };
};

const baseInvoiceMatch = (cId, start, end) => ({
  companyId: cId,
  isSplit: false,
  invoiceDate: { $gte: start, $lte: end },
  status: { $nin: EXCLUDED_STATUSES },
});

const fetchCustomersMap = async (ids, select, companyId = null) => {
  if (!ids?.length) return new Map();
  const { Customer } = getBooksCrmModels();
  const filter = { _id: { $in: ids } };
  if (companyId) filter.companyId = toObjectId(companyId);
  const docs = await Customer.find(filter).select(select).lean();
  return new Map(docs.map(c => [c._id.toString(), c]));
};

const fetchItemsForReport = async (itemIds, companyId = null) => {
  if (!itemIds?.length) return { itemGstMap: new Map(), itemMetaMap: new Map() };
  const { Item } = getBooksCrmModels();
  const uniq = [...new Set(itemIds.map(id => id?._id ?? id).filter(Boolean))];
  const filter = { _id: { $in: uniq } };
  if (companyId) filter.companyId = toObjectId(companyId);
  const items = await Item.find(filter).select('gst hsnCode itemCategory itemUnit').lean();
  const itemGstMap = new Map(items.map(i => [i._id.toString(), getGstRateForCalculation(i.gst)]));
  const itemMetaMap = new Map(
    items.map(i => [
      i._id.toString(),
      {
        unit: i.itemUnit,
        itemType: i.itemCategory?.isService ? 'service' : 'good',
        hsnCode: i.hsnCode || '',
      },
    ]),
  );
  return { itemGstMap, itemMetaMap };
};

const calculateTurnover = async companyId => {
  const { Invoice, CreditNote } = getBooksModels();
  const cId = toObjectId(companyId);
  const { previousFYStart, previousFYEnd, currentFYQ1Start, currentFYQ1End } = getFYBounds();

  const invoiceMatch = {
    companyId: cId,
    isSplit: false,
    status: { $nin: EXCLUDED_STATUSES },
    invoiceDate: { $gte: previousFYStart, $lte: currentFYQ1End },
  };

  const chargesAmountReduce = {
    $reduce: {
      input: { $ifNull: ['$additionalCharges', []] },
      initialValue: 0,
      in: { $add: ['$$value', { $ifNull: ['$$this.amount', 0] }] },
    },
  };

  const [invResult, cnResult] = await Promise.all([
    Invoice.aggregate([
      { $match: invoiceMatch },
      { $addFields: { chargesAmount: chargesAmountReduce } },
      {
        $group: {
          _id: null,
          prevFY: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$invoiceDate', previousFYStart] }, { $lte: ['$invoiceDate', previousFYEnd] }] },
                { $add: ['$subTotal', '$chargesAmount'] },
                0,
              ],
            },
          },
          q1: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$invoiceDate', currentFYQ1Start] }, { $lte: ['$invoiceDate', currentFYQ1End] }] },
                { $add: ['$subTotal', '$chargesAmount'] },
                0,
              ],
            },
          },
        },
      },
    ]),
    CreditNote.aggregate([
      {
        $match: {
          companyId: cId,
          status: { $ne: CREDIT_NOTE_STATUS.CANCELLED },
          creditNoteDate: { $gte: previousFYStart, $lte: currentFYQ1End },
          invoiceId: { $exists: true, $ne: null },
        },
      },
      { $addFields: { chargesAmount: chargesAmountReduce } },
      {
        $group: {
          _id: null,
          prevFY: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$creditNoteDate', previousFYStart] }, { $lte: ['$creditNoteDate', previousFYEnd] }] },
                { $add: ['$subTotal', '$chargesAmount'] },
                0,
              ],
            },
          },
          q1: {
            $sum: {
              $cond: [
                {
                  $and: [{ $gte: ['$creditNoteDate', currentFYQ1Start] }, { $lte: ['$creditNoteDate', currentFYQ1End] }],
                },
                { $add: ['$subTotal', '$chargesAmount'] },
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const inv = invResult[0] || { prevFY: 0, q1: 0 };
  const cn = cnResult[0] || { prevFY: 0, q1: 0 };

  return {
    previousYearTurnover: round2(Math.max(0, (inv.prevFY ?? 0) - (cn.prevFY ?? 0))),
    firstQuarterTurnover: round2(Math.max(0, (inv.q1 ?? 0) - (cn.q1 ?? 0))),
  };
};

/**
 * Is First Return: true if the taxpayer has no invoices before the current return period
 */
const checkIsFirstReturn = async (companyId, startDate, endDate) => {
  try {
    const { Invoice } = getBooksModels();
    const cId = toObjectId(companyId);
    const start = startDate instanceof Date ? startDate : new Date(startDate);
    const end = endDate instanceof Date ? endDate : new Date(endDate);

    const earliest = await Invoice.findOne({
      companyId: cId,
      isSplit: false,
      status: { $nin: EXCLUDED_STATUSES },
    })
      .sort({ invoiceDate: 1 })
      .select('invoiceDate')
      .lean();

    if (!earliest?.invoiceDate) return true;
    const d = new Date(earliest.invoiceDate);
    return d >= start && d <= end;
  } catch {
    return true;
  }
};

// ─── Tax Calculation ──────────────────────────────────────────────────────────
const getItemTaxableAmount = (item, gstRate, isTaxInclusive) => {
  const qty = parseFloat(item.quantity || 0);
  const rate = parseFloat(item.rate || 0);
  let gross = qty * rate;
  const dc = item.discountConfig;
  if (dc) {
    gross -= dc.discountType === 'AMOUNT' ? parseFloat(dc.discountValue || 0) : (gross * parseFloat(dc.discountValue || 0)) / 100;
  }
  gross = Math.max(0, gross);
  return round2(isTaxInclusive && gstRate > 0 ? (gross * 100) / (100 + gstRate) : gross);
};

const computeItemTaxes = (taxable, rate, posCode, companyCode) => {
  const r = parseFloat(rate || 0);
  const totalTax = round2((taxable * r) / 100);
  const intraState = posCode != null && companyCode != null && Number(posCode) === Number(companyCode);

  const cgstV = intraState ? round2(totalTax / 2) : 0;
  const sgstV = intraState ? round2(totalTax - cgstV) : 0;
  const igstV = intraState ? 0 : totalTax;

  return {
    taxableAmount: round2(taxable),
    totalTaxPercent: r,
    totalTaxValue: totalTax,
    totalTaxValueWithoutCess: totalTax,
    gstTaxPercent: r,
    cess: 0,
    cessRate: 0,
    sgst: { taxRate: intraState ? r / 2 : 0, taxValue: sgstV },
    igst: { taxRate: intraState ? 0 : r, taxValue: igstV },
    cgst: { taxRate: intraState ? r / 2 : 0, taxValue: cgstV },
    ugst: { taxRate: 0, taxValue: 0 },
    sgstUgst: { taxRate: intraState ? r / 2 : 0, taxValue: sgstV },
  };
};

const toChargeLineItems = (additionalCharges = []) =>
  (additionalCharges || [])
    .filter(c => c && Number(c.amount || 0) !== 0)
    .map(c => ({
      itemId: null,
      quantity: 1,
      rate: Number(c.amount || 0),
      gst: c.isTaxable ? String(c.taxRate || 0) : '0',
      itemName: c.name || '',
      hsnCode: '996511',
      itemType: 'service',
      unit: 'OTH',
    }));

const buildLineItems = (items = [], posCode, companyCode) => {
  const byRate = new Map();
  (items || []).forEach(item => {
    const gst = getGstRateForCalculation(item.gst);
    const taxable = getItemTaxableAmount(item, gst, false);
    const sum = byRate.get(gst) ?? 0;
    byRate.set(gst, round2(sum + taxable));
  });
  return [...byRate.entries()].map(([gst, taxable]) => {
    const itemTax = computeItemTaxes(taxable, gst, posCode, companyCode);
    return { itemFinalAmount: round2(taxable + itemTax.totalTaxValue), itemTax };
  });
};

// ─── Invoice Totals ───────────────────────────────────────────────────────────
const calculateInvoiceTotals = (invoices, itemGstMap, companyCode, stateIndex) =>
  invoices.map(inv => {
    const posCode = getPosStateCode(stateIndex, inv.customer);
    const posStateLabel = getStateLabelFromCode(stateIndex, posCode);
    const posState =
      posStateLabel !== 'N/A'
        ? posStateLabel
        : inv.customer?.address?.billing?.state || inv.customer?.address?.shipping?.state || 'N/A';
    const lineItems = buildLineItems(inv.items, posCode, companyCode);
    return {
      invoiceNumber: inv.invoiceId || '',
      invoiceId: inv._id.toString(),
      invoiceDate: inv.invoiceDate ? toISODate(inv.invoiceDate) : '',
      invoiceType: 'sales_invoice',
      invoiceAmount: round2(lineItems.reduce((s, li) => s + li.itemFinalAmount, 0)),
      contact: { name: inv.customer?.customerDisplayName || inv.customer?.companyName || '', gstin: inv.buyerGstin || '' },
      destination: { state: posState, stateCode: posCode, isSameState: !!(companyCode && posCode && companyCode === posCode) },
      lineItems,
    };
  });

const hasTaxableLine = inv => inv.lineItems.some(li => (li.itemTax?.gstTaxPercent || 0) > 0);
const filterTaxable = (calced, raw) => {
  const out = { calculated: [], raw: [] };
  calced.forEach((c, i) => {
    if (hasTaxableLine(c)) {
      out.calculated.push(c);
      out.raw.push(raw[i]);
    }
  });
  return out;
};

// ─── Summary Builders ─────────────────────────────────────────────────────────
const buildDistinctGstinSummary = invoices => {
  const map = new Map();
  invoices.forEach(inv => {
    const gstin = inv.contact?.gstin || inv.buyerGstin || '';
    if (gstin) map.set(gstin, (map.get(gstin) || 0) + 1);
  });
  return [...map.entries()].map(([gstin, invoiceCount]) => ({ gstin, invoiceCount }));
};

const computeB2BTotals = invoices => {
  let taxable = 0,
    invoice = 0,
    cess = 0;
  invoices.forEach(inv => {
    invoice += inv.invoiceAmount || 0;
    inv.lineItems.forEach(li => {
      if ((li.itemTax?.gstTaxPercent || 0) > 0) taxable += li.itemTax?.taxableAmount || 0;
      cess += li.itemTax?.cess || 0;
    });
  });
  return {
    totalTaxableAmount: String(round2(taxable)),
    totalInvoiceAmount: String(round2(invoice)),
    totalCessAmount: String(round2(cess)),
  };
};

const getInvTaxableTaxCess = inv => {
  let taxable = 0,
    tax = 0,
    cess = 0;
  inv.lineItems.forEach(li => {
    if ((li.itemTax?.gstTaxPercent || 0) > 0) {
      taxable += li.itemTax?.taxableAmount || 0;
      tax += li.itemTax?.totalTaxValue || 0;
    }
    cess += li.itemTax?.cess || 0;
  });
  return { taxable: round2(taxable), tax: round2(tax), cess: round2(cess) };
};

const buildB2CSection = (calcInvoices, creditNoteMap) => {
  let totalInv = 0,
    totalTax = 0,
    totalCess = 0;

  const invoices = calcInvoices.map(inv => {
    const { taxable, tax, cess } = getInvTaxableTaxCess(inv);
    const credit = creditNoteMap.get(inv.invoiceId) || { taxable: 0, tax: 0, total: 0, cess: 0 };
    const netTotal = round2((Number(inv.invoiceAmount) || 0) - credit.total);
    const netTaxable = round2(taxable - credit.taxable);
    const netCess = round2(cess - credit.cess);
    totalInv += inv.invoiceAmount || 0;
    totalTax += taxable;
    totalCess += cess;
    return {
      ...inv,
      invoiceAmount: inv.invoiceAmount || 0,
      netTaxableAmount: netTaxable,
      netTaxAmount: round2(tax - credit.tax),
      netCessAmount: netCess,
    };
  });

  return {
    distinctGstinSummary: [],
    invoices,
    totalInvoiceAmount: round2(totalInv),
    totalTaxableAmount: round2(totalTax),
    totalCessAmount: round2(totalCess),
  };
};

// ─── Notes (CDNR / CDNUR) ─────────────────────────────────────────────────────
const buildNoteLineItems = (items = [], posCode, companyCode) => {
  const sign = 1;
  return buildLineItems(items, posCode, companyCode).map(li => {
    const t = li.itemTax;
    return {
      itemFinalAmount: round2(sign * li.itemFinalAmount),
      itemTax: {
        taxableAmount: round2(sign * t.taxableAmount),
        totalTaxPercent: t.totalTaxPercent,
        totalTaxValue: round2(sign * t.totalTaxValue),
        totalTaxValueWithoutCess: round2(sign * t.totalTaxValueWithoutCess),
        gstTaxPercent: t.gstTaxPercent,
        cess: round2(sign * t.cess),
        cessRate: t.cessRate,
        sgst: { taxRate: t.sgst.taxRate, taxValue: round2(sign * t.sgst.taxValue) },
        igst: { taxRate: t.igst.taxRate, taxValue: round2(sign * t.igst.taxValue) },
        cgst: { taxRate: t.cgst.taxRate, taxValue: round2(sign * t.cgst.taxValue) },
        ugst: { taxRate: t.ugst.taxRate, taxValue: round2(sign * t.ugst.taxValue) },
        sgstUgst: { taxRate: t.sgstUgst.taxRate, taxValue: round2(sign * t.sgstUgst.taxValue) },
      },
    };
  });
};

const buildNoteResponse = (note, companyCode, stateIndex) => {
  const posCode = note.placeOfSupplyStateCode || '';
  const posStateLabel = getStateLabelFromCode(stateIndex, note.placeOfSupplyStateCode);
  const posState =
    posStateLabel !== 'N/A'
      ? posStateLabel
      : note.customer?.address?.billing?.state || note.customer?.address?.shipping?.state || 'N/A';
  const lineItems = buildNoteLineItems(note.items, posCode, companyCode);
  const sign = note.noteType === 'credit_note' ? -1 : 1;

  return {
    noteId: note._id.toString(),
    noteNumber: note.creditNoteId || '',
    noteDate: note.creditNoteDate ? toISODate(note.creditNoteDate) : '',
    noteType: note.noteType,
    originalInvoiceNumber: note.originalInvoiceNumber || '',
    originalInvoiceDate: note.originalInvoiceDate || '',
    originalInvoiceId: note.originalInvoiceId || '',
    recipientGSTIN: note.hasGstin ? note.recipientGstin || '' : null,
    recipientName: note.customer?.customerDisplayName || note.customer?.companyName || '',
    placeOfSupply: posState,
    stateCode: posCode,
    isInterState: !!(companyCode && posCode && posCode !== companyCode),
    lineItems,
    _adjustedNoteTotal: round2(sign * (Number(note.total) || 0)),
    _adjustedTaxableAmount: round2(
      sign * lineItems.reduce((s, li) => s + ((li.itemTax?.gstTaxPercent || 0) > 0 ? li.itemTax?.taxableAmount || 0 : 0), 0),
    ),
    _adjustedTaxAmount: round2(
      sign * lineItems.reduce((s, li) => s + ((li.itemTax?.gstTaxPercent || 0) > 0 ? li.itemTax?.totalTaxValue || 0 : 0), 0),
    ),
    _adjustedCessAmount: round2(sign * lineItems.reduce((s, li) => s + (li.itemTax?.cess || 0), 0)),
  };
};

const buildNotesSection = (notes, companyCode, isRegistered, stateIndex) => {
  const full = notes.map(n => buildNoteResponse(n, companyCode, stateIndex));
  const byGstin = new Map();
  if (isRegistered)
    full.forEach(r => {
      const g = r.recipientGSTIN || '';
      if (g) byGstin.set(g, (byGstin.get(g) || 0) + 1);
    });

  const totalNoteAmount = round2(full.reduce((s, r) => s + r._adjustedNoteTotal, 0));
  const totalTaxableAmount = round2(full.reduce((s, r) => s + r._adjustedTaxableAmount, 0));
  const totalCessAmount = round2(full.reduce((s, r) => s + r._adjustedCessAmount, 0));

  const stripped = full.map(({ _adjustedNoteTotal, _adjustedTaxableAmount, _adjustedTaxAmount, _adjustedCessAmount, ...r }) => r);
  if (!isRegistered)
    stripped.forEach(r => {
      r.recipientGSTIN = null;
    });

  return {
    distinctGstinSummary: isRegistered ? [...byGstin.entries()].map(([gstin, noteCount]) => ({ gstin, noteCount })) : [],
    notes: stripped,
    totalNoteAmount,
    totalTaxableAmount,
    totalCessAmount,
  };
};

const buildCDNRSection = (notes, code, stateIndex) => buildNotesSection(notes, code, true, stateIndex);
const buildCDNURSection = (notes, code, stateIndex) => buildNotesSection(notes, code, false, stateIndex);

// HSN Helpers

const collectHsnLinesFromInvoices = (rawInvoices, calcInvoices, itemMetaMap, sign) => {
  const lines = [];
  rawInvoices.forEach((raw, i) => {
    const calc = calcInvoices[i];
    const rawItems = raw.items || [];
    calc?.lineItems?.forEach((li, j) => {
      const rawItem = rawItems[j];
      if (!rawItem || !li.itemTax || !(li.itemTax.gstTaxPercent > 0)) return;
      const meta = rawItem.itemId ? itemMetaMap.get(rawItem.itemId.toString()) : null;
      lines.push({
        quantity: sign * (parseFloat(rawItem.quantity) || 0),
        hsnCode: (rawItem.hsnCode || meta?.hsnCode || '').toString().trim() || 'N/A',
        description: rawItem.itemName || rawItem.description || '',
        unit: rawItem.itemUnit,
        itemType: (rawItem.itemType || meta?.itemType || 'good').toString(),
        gstTaxPercent: li.itemTax.gstTaxPercent,
        taxableValue: round2(sign * (li.itemTax.taxableAmount || 0)),
        totalItemValue: round2(sign * (li.itemFinalAmount || 0)),
        igst: round2(sign * (li.itemTax.igst?.taxValue || 0)),
        cgst: round2(sign * (li.itemTax.cgst?.taxValue || 0)),
        sgst: round2(sign * (li.itemTax.sgst?.taxValue || 0)),
        sgstUgst: round2(sign * (li.itemTax.sgstUgst?.taxValue || 0)),
        cess: round2(sign * (li.itemTax.cess || 0)),
      });
    });
  });
  return lines;
};

const collectHsnLinesFromNotes = (rawNotes, noteResponses, itemMetaMap) => {
  const lines = [];
  rawNotes.forEach((raw, i) => {
    const resp = noteResponses[i];
    const rawItems = raw.items || [];
    resp?.lineItems?.forEach((li, j) => {
      const rawItem = rawItems[j];
      if (!rawItem || !li.itemTax || !(li.itemTax.gstTaxPercent > 0)) return;
      const meta = rawItem.itemId ? itemMetaMap.get(rawItem.itemId.toString()) : null;
      lines.push({
        quantity:
          li.itemTax.taxableAmount < 0
            ? -(parseFloat(rawItem.quantity) || 0) // credit note → negative qty
            : parseFloat(rawItem.quantity) || 0, // debit note  → positive qty
        hsnCode: (rawItem.hsnCode || meta?.hsnCode || '').toString().trim() || 'N/A',
        description: rawItem.itemName || rawItem.description || '',
        unit: rawItem.itemUnit,
        itemType: (rawItem.itemType || meta?.itemType || 'good').toString(),
        gstTaxPercent: li.itemTax.gstTaxPercent,
        taxableValue: li.itemTax.taxableAmount || 0,
        totalItemValue: li.itemFinalAmount || 0,
        igst: li.itemTax.igst?.taxValue || 0,
        cgst: li.itemTax.cgst?.taxValue || 0,
        sgst: li.itemTax.sgst?.taxValue || 0,
        sgstUgst: li.itemTax.sgstUgst?.taxValue || 0,
        cess: li.itemTax.cess || 0,
      });
    });
  });
  return lines;
};

const buildHsnSummary = lines => {
  const groups = new Map();
  lines.forEach(l => {
    const key = `${l.hsnCode}|${l.gstTaxPercent}|${l.unit}|${l.itemType}`;
    const r = groups.get(key) || {
      hsnCode: l.hsnCode,
      description: l.description,
      unit: l.unit,
      itemType: l.itemType,
      gstTaxPercent: l.gstTaxPercent,
      totalQuantity: 0,
      totalTaxableValue: 0,
      totalCgst: 0,
      totalSgst: 0,
      totalIgst: 0,
      totalSgstUgst: 0,
      totalCess: 0,
      totalItemValue: 0,
    };
    r.totalQuantity = round2(r.totalQuantity + l.quantity);
    r.totalTaxableValue = round2(r.totalTaxableValue + l.taxableValue);
    r.totalCgst = round2(r.totalCgst + l.cgst);
    r.totalSgst = round2(r.totalSgst + l.sgst);
    r.totalIgst = round2(r.totalIgst + l.igst);
    r.totalSgstUgst = round2(r.totalSgstUgst + l.sgstUgst);
    r.totalCess = round2(r.totalCess + l.cess);
    r.totalItemValue = round2(r.totalItemValue + l.totalItemValue);
    groups.set(key, r);
  });
  return [...groups.values()];
};

const buildHsnSectionWithTotals = lines => {
  const hsnSummary = buildHsnSummary(lines);
  const noOfHsn = hsnSummary.length;
  const totalValue = round2(hsnSummary.reduce((s, r) => s + (r.totalItemValue || 0), 0));
  const totalTaxableValue = round2(hsnSummary.reduce((s, r) => s + (r.totalTaxableValue || 0), 0));
  const totalIntegratedTax = round2(hsnSummary.reduce((s, r) => s + (r.totalIgst || 0), 0));
  const totalCentralTax = round2(hsnSummary.reduce((s, r) => s + (r.totalCgst || 0), 0));
  const totalStateUtTax = round2(hsnSummary.reduce((s, r) => s + (r.totalSgst || 0) + (r.totalSgstUgst || 0), 0));
  const totalCess = round2(hsnSummary.reduce((s, r) => s + (r.totalCess || 0), 0));
  return {
    hsnSummary,
    noOfHsn,
    totalValue,
    totalTaxableValue,
    totalIntegratedTax,
    totalCentralTax,
    totalStateUtTax,
    totalCess,
  };
};

// Documents Issued Summary
const docTypeToLabelKey = docType =>
  String(docType || '')
    .replace(/-/g, '_')
    .toUpperCase();

const aggDocSummary = async (model, pipeline) => {
  const results = await model.aggregate(pipeline);
  return results
    .filter(r => r.totalIssued > 0)
    .map(r => ({
      documentType: r._id,
      documentLabel: DOCUMENT_TYPE_LABELS[docTypeToLabelKey(r._id)] || r._id,
      serialFrom: toSerial(r.serialFrom),
      serialTo: toSerial(r.serialTo),
      totalIssued: r.totalIssued,
      cancelledCount: r.cancelledCount,
      netIssued: r.netIssued,
    }));
};

const makeDocPipeline = (cId, dateField, idField, docType, start, end) => [
  { $match: { companyId: cId, [dateField]: { $gte: start, $lte: end } } },
  {
    $group: {
      _id: { $literal: docType },
      serialFrom: { $min: `$${idField}` },
      serialTo: { $max: `$${idField}` },
      totalIssued: { $sum: 1 },
      cancelledCount: { $sum: { $cond: [{ $in: ['$status', ['CANCELLED', 'Cancelled']] }, 1, 0] } },
    },
  },
  { $addFields: { netIssued: { $subtract: ['$totalIssued', '$cancelledCount'] } } },
];

const getDocumentsIssuedSummary = async (companyId, fromDate, toDate) => {
  const cId = toObjectId(companyId);
  const { start, end } = normDates(fromDate, toDate);
  const { Invoice, CreditNote, Bill, DeliveryChallan, DebitNote } = getBooksModels();
  const { Customer } = getBooksCrmModels();

  const [invoiceSummary, creditNoteSummary, debitNoteSummary, deliveryChallanSummary, billsInRange] = await Promise.all([
    aggDocSummary(Invoice, makeDocPipeline(cId, 'invoiceDate', 'invoiceId', 'outward_supply_invoice', start, end)),
    aggDocSummary(CreditNote, makeDocPipeline(cId, 'creditNoteDate', 'creditNoteId', 'credit_note', start, end)),
    aggDocSummary(DebitNote, makeDocPipeline(cId, 'debitNoteDate', 'debitNoteId', 'debit_note', start, end)),
    aggDocSummary(DeliveryChallan, makeDocPipeline(cId, 'challanDate', 'challanId', 'delivery_challan', start, end)),
    Bill.find({ companyId: cId, billDate: { $gte: start, $lte: end } })
      .select('billId billDate status vendor')
      .lean(),
  ]);

  let purchaseInvoiceRows = [];
  if (billsInRange.length > 0) {
    const vendorIds = [...new Set(billsInRange.map(b => b.vendor).filter(Boolean))];
    const vendors = await Customer.find({ companyId: cId, _id: { $in: vendorIds } })
      .select('otherDetails.gstinUin gstin')
      .lean();
    const unregSet = new Set(
      vendors.filter(v => !(v?.otherDetails?.gstinUin || v?.gstin || '').trim()).map(v => v._id.toString()),
    );
    const unregBills = billsInRange.filter(b => b.vendor && unregSet.has(b.vendor.toString()));

    if (unregBills.length > 0) {
      const serials = unregBills.map(b => toSerial(b.billId)).filter(Boolean);
      const cancelledCount = unregBills.filter(b => String(b.status).toUpperCase() === 'CANCELLED').length;
      purchaseInvoiceRows = [
        {
          documentType: 'inward_supply_unregistered',
          documentLabel: DOCUMENT_TYPE_LABELS.INWARD_SUPPLY_UNREGISTERED,
          serialFrom: serials.length ? serials.reduce((a, b) => (a < b ? a : b)) : '',
          serialTo: serials.length ? serials.reduce((a, b) => (a > b ? a : b)) : '',
          totalIssued: unregBills.length,
          cancelledCount,
          netIssued: unregBills.length - cancelledCount,
        },
      ];
    }
  }

  const documentSummary = [
    ...invoiceSummary,
    ...purchaseInvoiceRows,
    ...debitNoteSummary,
    ...creditNoteSummary,
    ...deliveryChallanSummary,
  ];
  return {
    documentSummary,
    totalDocuments: documentSummary.reduce((s, d) => s + d.totalIssued, 0),
    totalCancelled: documentSummary.reduce((s, d) => s + d.cancelledCount, 0),
    totalNetIssued: documentSummary.reduce((s, d) => s + d.netIssued, 0),
  };
};

const emptyNilBuckets = () => Object.fromEntries(NIL_BUCKET_KEYS.map(k => [k, { non_gst: 0, exempt: 0, nil_rated: 0 }]));

const getNilBucketKey = (cust, companyCode) => {
  const posCode = getPosStateCode(cust);
  const isInter = !!(companyCode && posCode && companyCode !== posCode);
  const isReg = getGstinInfo(cust).hasGstin;
  return `${isInter ? 'inter' : 'intra'}_${isReg ? 'registered' : 'unregistered'}`;
};

/** Process docs (invoices or credit notes); sign: +1 add, -1 subtract. Categories: 0%→non_gst, Exempted→exempt, None→nil_rated. */
const processNilExemptDocs = (docs, getCust, companyCode, itemGstMap, buckets, sign) => {
  for (const doc of docs) {
    const key = getNilBucketKey(getCust(doc), companyCode);
    for (const item of doc.items || []) {
      const rate = getGstRateForCalculation(item.gst);

      if (round2(Number(rate)) !== 0) continue;
      const category = getGstCategory(item.gst);
      buckets[key][category] = round2(buckets[key][category] + sign * getItemTaxableAmount(item, rate, false));
    }
  }
};

const _computeNilExempt = (invoices, custMap, itemGstMap, companyCode, creditNotes = []) => {
  const buckets = emptyNilBuckets();
  const getCustInv = inv => custMap.get(inv.customerId?.toString()) || null;
  const getCustNote = note => note.customer || custMap.get(note.customerId?.toString()) || null;
  processNilExemptDocs(invoices, getCustInv, companyCode, itemGstMap, buckets, 1);
  processNilExemptDocs(creditNotes, getCustNote, companyCode, itemGstMap, buckets, -1);
  return buildNilResponse(buckets);
};

const buildNilResponse = buckets => {
  const sum = cat => round2(NIL_BUCKET_KEYS.reduce((s, k) => s + (buckets[k]?.[cat] || 0), 0));
  const section = k => ({
    description: BUCKET_LABELS[k],
    non_gst: round2(buckets[k]?.non_gst || 0),
    exempt: round2(buckets[k]?.exempt || 0),
    nil_rated: round2(buckets[k]?.nil_rated || 0),
  });
  return {
    ...Object.fromEntries(NIL_BUCKET_KEYS.map(k => [k, section(k)])),
    total_nil_rated_supply: sum('nil_rated'),
    total_exempt: sum('exempt'),
    total_non_gst: sum('non_gst'),
  };
};

// GSTR-1 Report
const generateGstr1Report = async ({ companyId, startDate, endDate }) => {
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, GSTR1_MESSAGES.COMPANY_REQUIRED);
  }
  if (!startDate || !endDate) {
    throw new ApiError(httpStatus.BAD_REQUEST, GSTR1_MESSAGES.DATE_RANGE_REQUIRED);
  }

  const { start, end } = normDates(startDate, endDate);
  const cId = toObjectId(companyId);
  const stateIndex = await getStateIndex({ mode: 'GST' });

  const { Invoice } = getBooksModels();
  const { CreditNote } = getBooksModels();
  const { Company } = getCommonModels();

  // Company fetched once and reused for taxpayer, state code, turnover, docs, nil-exempt
  const [company, rawInvoices, rawCreditNotes, turnoverData, isFirstReturn, docs] = await Promise.all([
    Company.findById(cId).select('name gstNumber address').lean(),
    Invoice.find(baseInvoiceMatch(cId, start, end))
      .select('invoiceId invoiceDate customerId items total subTotal isSplit status invoiceType additionalCharges')
      .sort({ invoiceDate: 1, invoiceId: 1 })
      .lean(),
    CreditNote.find({
      companyId: cId,
      creditNoteDate: { $gte: start, $lte: end },
      status: { $ne: CREDIT_NOTE_STATUS.CANCELLED },
      invoiceId: { $exists: true, $ne: null },
    })
      .select(
        'creditNoteId creditNoteDate customerId invoiceId items total subTotal igst cgst sgst status invoiceNo additionalCharges',
      )
      .sort({ creditNoteDate: 1, creditNoteId: 1 })
      .lean(),
    calculateTurnover(companyId),
    checkIsFirstReturn(companyId, start, end),
    getDocumentsIssuedSummary(companyId, start, end),
  ]);

  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, GSTR1_MESSAGES.COMPANY_NOT_FOUND);
  }

  const companyCode =
    getStateCodeFromGstin(stateIndex, company.gstNumber) || getStateCode(stateIndex, company.address?.state) || '';

  // Augment invoice items with additional charges so they flow through the same tax pipeline
  for (const inv of rawInvoices) {
    inv.items = [...(inv.items || []), ...toChargeLineItems(inv.additionalCharges)];
  }

  // Taxpayer details
  const taxpayerDetails = {
    gstin: company.gstNumber || '',
    legalName: company.name || '',
    tradeName: company.name || '',
  };

  // Collect unique IDs across invoices + credit notes
  const allCustIds = [
    ...new Set([...rawInvoices.map(i => i.customerId), ...rawCreditNotes.map(n => n.customerId)].filter(Boolean)),
  ];

  const allItemIds = [
    ...new Set(
      [
        ...rawInvoices.flatMap(i => (i.items || []).map(x => x.itemId)),
        ...rawCreditNotes.flatMap(n => (n.items || []).map(x => x.itemId)),
      ].filter(Boolean),
    ),
  ];

  // All invoice IDs referenced by credit notes
  const refInvIds = [...new Set(rawCreditNotes.map(n => n.invoiceId?._id ?? n.invoiceId).filter(Boolean))];

  const [custMap, { itemGstMap, itemMetaMap }, origInvoices] = await Promise.all([
    fetchCustomersMap(allCustIds, 'customerDisplayName companyName otherDetails address', companyId),
    fetchItemsForReport(allItemIds, companyId),
    refInvIds.length
      ? Invoice.find({ companyId: cId, _id: { $in: refInvIds } })
          .select('invoiceId invoiceDate total')
          .lean()
      : Promise.resolve([]),
  ]);

  const origInvMap = new Map(origInvoices.map(i => [i._id.toString(), i]));

  // Split invoices B2B/B2C using shared custMap
  const b2bInvoices = [],
    b2cInvoices = [];
  for (const inv of rawInvoices) {
    const cust = inv.customerId ? custMap.get(inv.customerId.toString()) : null;
    const { gstin, hasGstin } = getGstinInfo(cust);
    const enriched = { ...inv, customer: cust, buyerGstin: gstin };
    if (hasGstin) {
      b2bInvoices.push(enriched);
    } else {
      b2cInvoices.push({
        ...enriched,
        placeOfSupplyStateCode: getPosStateCode(stateIndex, cust),
        grandTotal: Number(inv.total) || 0,
      });
    }
  }

  // Enrich credit notes using shared custMap + origInvMap; augment items with additional charges
  const cdnNotes = rawCreditNotes.map(note => {
    const cust = note.customerId ? custMap.get(note.customerId.toString()) : null;
    const { gstin, hasGstin } = getGstinInfo(cust);
    const invIdStr = (note.invoiceId?._id ?? note.invoiceId)?.toString() || '';
    const origInv = invIdStr ? origInvMap.get(invIdStr) : null;
    const posCode = getPosStateCode(stateIndex, cust);
    const itemsWithCharges = [...(note.items || []), ...toChargeLineItems(note.additionalCharges)];
    return {
      ...note,
      items: itemsWithCharges,
      noteType: 'credit_note',
      customer: cust,
      recipientGstin: gstin,
      hasGstin,
      originalInvoice: origInv,
      originalInvoiceId: invIdStr,
      originalInvoiceNumber: origInv?.invoiceId || note.invoiceNo || '',
      originalInvoiceDate: origInv?.invoiceDate ? toISODate(origInv.invoiceDate) : '',
      placeOfSupplyStateCode: posCode,
      isOriginalInterState: !!(posCode && companyCode && posCode !== companyCode),
      originalGrandTotal: origInv ? Number(origInv.total) || 0 : 0,
    };
  });

  // Nil/Exempt using invoices + credit notes (notes reduce exempt value)
  const exempt = _computeNilExempt(rawInvoices, custMap, itemGstMap, companyCode, cdnNotes);

  // Calculate invoice totals
  const b2bCalc = filterTaxable(calculateInvoiceTotals(b2bInvoices, itemGstMap, companyCode, stateIndex), b2bInvoices);
  const calcB2B = b2bCalc.calculated;
  const rawB2B = b2bCalc.raw;

  // B2CL / B2CS
  let b2cl = emptyB2C(),
    b2cs = emptyB2C();
  if (b2cInvoices.length) {
    let b2cCalc = calculateInvoiceTotals(b2cInvoices, itemGstMap, companyCode, stateIndex);
    b2cCalc.forEach((inv, i) => {
      inv.grandTotal = b2cInvoices[i].grandTotal;
    });

    const b2cTax = filterTaxable(b2cCalc, b2cInvoices);
    b2cCalc = b2cTax.calculated;

    const isB2CL = inv => !inv.destination?.isSameState && (inv.grandTotal || 0) > 250000;
    const b2clCalc = b2cCalc.filter(isB2CL);
    const b2csCalc = b2cCalc.filter(inv => !isB2CL(inv));

    // Build credit note map using calculated taxable (only items with GST) for consistency
    const b2cInvoiceIdSet = new Set(b2cCalc.map(i => i.invoiceId));
    const creditMap = new Map();
    for (const note of cdnNotes) {
      const key = note.originalInvoiceId || '';
      if (!key || !b2cInvoiceIdSet.has(key)) continue;
      const lineItems = buildNoteLineItems(note.items, note.placeOfSupplyStateCode, companyCode);
      let cnTaxable = 0;
      let cnTax = 0;
      lineItems.forEach(li => {
        if ((li.itemTax?.gstTaxPercent || 0) > 0) {
          cnTaxable += li.itemTax?.taxableAmount || 0;
          cnTax += li.itemTax?.totalTaxValue || 0;
        }
      });
      const prev = creditMap.get(key) || { taxable: 0, tax: 0, total: 0, cess: 0 };
      creditMap.set(key, {
        taxable: round2(prev.taxable + cnTaxable),
        tax: round2(prev.tax + cnTax),
        total: round2(prev.total + (Number(note.total) || 0)),
        cess: 0,
      });
    }

    b2cl = buildB2CSection(b2clCalc, creditMap);
    b2cs = buildB2CSection(b2csCalc, creditMap);
  }

  // CDNR / CDNUR (only notes with at least one taxable item; nil/exempt/non-GST excluded → EXEMP)
  const cdnNotesTaxable = cdnNotes.filter(n => {
    const posCode = n.placeOfSupplyStateCode || '';
    const lineItems = buildLineItems(n.items || [], posCode, companyCode);
    return lineItems.some(li => (li.itemTax?.gstTaxPercent || 0) > 0 || (li.itemTax?.totalTaxValue || 0) !== 0);
  });
  const cdnrNotes = cdnNotesTaxable.filter(n => n.hasGstin);
  const cdnurNotes = cdnNotesTaxable.filter(n => !n.hasGstin && n.isOriginalInterState && (n.originalGrandTotal || 0) > 250000);
  const cdnr = buildCDNRSection(cdnrNotes, companyCode, stateIndex);
  const cdnur = buildCDNURSection(cdnurNotes, companyCode, stateIndex);

  // HSN
  const calcB2CFull = calculateInvoiceTotals(b2cInvoices, itemGstMap, companyCode, stateIndex);

  const hsn_b2b = buildHsnSectionWithTotals([
    ...collectHsnLinesFromInvoices(rawB2B, calcB2B, itemMetaMap, 1),
    ...collectHsnLinesFromNotes(cdnrNotes, cdnr.notes, itemMetaMap),
  ]);
  const hsn_b2c = buildHsnSectionWithTotals([
    ...collectHsnLinesFromInvoices(b2cInvoices, calcB2CFull, itemMetaMap, 1),
    ...collectHsnLinesFromNotes(cdnurNotes, cdnur.notes, itemMetaMap),
  ]);

  const totals = computeB2BTotals(calcB2B);

  return {
    taxpayerDetails,
    returnPeriodDetails: getReturnPeriodDetails(start, end),
    turnoverSummary: {
      previousYearTurnover: turnoverData.previousYearTurnover,
      firstQuarterTurnover: turnoverData.firstQuarterTurnover,
      isFirstReturn,
    },
    b2b: {
      distinctGstinSummary: buildDistinctGstinSummary(calcB2B),
      invoices: calcB2B,
      ...totals,
    },
    b2cl: {
      distinctGstinSummary: b2cl.distinctGstinSummary,
      invoices: b2cl.invoices,
      totalInvoiceAmount: b2cl.totalInvoiceAmount,
      totalTaxableAmount: b2cl.totalTaxableAmount,
      totalCessAmount: b2cl.totalCessAmount,
    },
    b2cs: {
      distinctGstinSummary: b2cs.distinctGstinSummary,
      invoices: b2cs.invoices,
      totalInvoiceAmount: b2cs.totalInvoiceAmount,
      totalTaxableAmount: b2cs.totalTaxableAmount,
      totalCessAmount: b2cs.totalCessAmount,
    },
    cdnr: {
      distinctGstinSummary: cdnr.distinctGstinSummary,
      notes: cdnr.notes,
      totalNoteAmount: cdnr.totalNoteAmount,
      totalTaxableAmount: cdnr.totalTaxableAmount,
      totalCessAmount: cdnr.totalCessAmount,
    },
    cdnur: {
      distinctGstinSummary: cdnur.distinctGstinSummary,
      notes: cdnur.notes,
      totalNoteAmount: cdnur.totalNoteAmount,
      totalTaxableAmount: cdnur.totalTaxableAmount,
      totalCessAmount: cdnur.totalCessAmount,
    },
    hsn_b2b,
    hsn_b2c,
    exempt,
    docs: {
      documentSummary: docs.documentSummary,
      totalDocuments: docs.totalDocuments,
      totalCancelled: docs.totalCancelled,
      totalNetIssued: docs.totalNetIssued,
    },
  };
};

const emptyB2C = () => ({
  distinctGstinSummary: [],
  invoices: [],
  totalInvoiceAmount: 0,
  totalTaxableAmount: 0,
  totalCessAmount: 0,
});

module.exports = {
  generateGstr1Report,
};
