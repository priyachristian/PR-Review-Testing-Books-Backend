const {
  EXPENSE_BILLABLE_STATUS,
  EXPENSE_TAX_SPLIT,
  LEDGER_PARTY_TYPES,
  TAX_TYPES,
} = require('@smit9313/abss-models-core/src/utils/enum');

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const expenseTransformers = {
  // Builds every stored amount from the entered lines and the party's role.
  buildExpenseFields: (body, party) => {
    let partyType = null;
    if (party?.Role?.isCustomer) partyType = LEDGER_PARTY_TYPES.CUSTOMER;
    else if (party?.Role?.isVendor) partyType = LEDGER_PARTY_TYPES.VENDOR;

    const isBillable = body.isBillable === true;
    // A vendor's billable expense was paid by the vendor for us: it is our cost and we owe the vendor.
    const isVendorBillable = isBillable && partyType === LEDGER_PARTY_TYPES.VENDOR;
    const isCustomerBillable = isBillable && !isVendorBillable;
    let subTotal = 0;
    let totalTax = 0;
    let eligibleTax = 0;
    let totalCost = 0;

    const lines = body.lines.map(line => {
      // 'none' and 'exempted' have no number, so they count as 0%.
      const rate = Number(line.gst) || 0;
      const amount = Number(line.amount);
      const baseAmount = body.isTaxInclusive && rate ? round2(amount / (1 + rate / 100)) : amount;
      const taxAmount = body.isTaxInclusive ? round2(amount - baseAmount) : round2((amount * rate) / 100);

      const isItcEligible = rate > 0 && line.isItcEligible === true;
      const cost = isItcEligible ? baseAmount : round2(baseAmount + taxAmount);

      subTotal += baseAmount;
      totalTax += taxAmount;
      totalCost += cost;
      if (isItcEligible) eligibleTax += taxAmount;

      return { ...line, amount, baseAmount, taxAmount, cost };
    });

    subTotal = round2(subTotal);
    totalTax = round2(totalTax);

    const isIgst = body.taxSplit === EXPENSE_TAX_SPLIT.IGST;
    const cgst = isIgst ? 0 : round2(totalTax / 2);

    // TDS is deducted from what is paid and TCS is added. A billable expense carries neither.
    const tax = isBillable || !body.tax?.taxId ? null : body.tax;
    const directTax = round2(tax?.amount);
    const preciseTotal = round2(subTotal + totalTax + (tax?.type === TAX_TYPES.TDS ? -directTax : directTax));
    const total = body.isRoundOff ? Math.round(preciseTotal) : preciseTotal;

    return {
      partyType,
      lines,
      expenseAccount: lines[0].accountId,
      paidThroughAccountId: isVendorBillable ? null : body.paidThroughAccountId,
      subTotal,
      cgst,
      sgst: isIgst ? 0 : round2(totalTax - cgst),
      igst: isIgst ? totalTax : 0,
      totalTax,
      eligibleTax: round2(eligibleTax),
      expenseCost: isCustomerBillable ? 0 : round2(totalCost),
      tax,
      roundOffAmount: round2(total - preciseTotal),
      total,
      isBillable,
      billableStatus: isBillable ? EXPENSE_BILLABLE_STATUS.UNPAID : null,
      paidAmount: isBillable ? 0 : null,
      balanceAmount: isBillable ? total : null,
    };
  },
};

module.exports = expenseTransformers;
