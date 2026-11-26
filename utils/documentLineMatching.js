/**
 * Pairs the lines submitted on an edit with the lines the document already holds.
 *
 * The same item can sit on several lines of one document — at different prices, in different units, or both —
 * and every inventory line owns its own batch/deduction. Matching by itemId alone (or by position within an
 * item) hands a line the wrong batch as soon as lines are reordered, removed or repriced. A line is identified
 * by item + unit + effective unit price instead:
 *   1. exact match   — same item, same unit, same price (the line is untouched, or only its quantity changed)
 *   2. same unit     — same item and unit, price edited
 * Anything left on either side is unmatched: new submitted lines are created, old lines are released.
 * An existing line is never paired across units — a line's unit is fixed once the document exists.
 */

const roundPrice = value => Math.round((Number(value) || 0) * 10000) / 10000;

// Rate net of the line discount, per unit — the price the line is bought/sold at before the document exchange rate.
const effectiveUnitPrice = line => {
  const rate = Number(line?.rate) || 0;
  const discount = line?.discountConfig;
  const discountValue = Number(discount?.discountValue) || 0;
  if (!discount || discountValue <= 0) return roundPrice(rate);

  if (discount.discountType === 'PERCENTAGE') return roundPrice(rate - (rate * discountValue) / 100);
  if (discount.discountType === 'AMOUNT') {
    const quantity = Number(line?.quantity) || 0;
    return roundPrice(quantity > 0 ? rate - discountValue / quantity : rate);
  }
  return roundPrice(rate);
};

const lineIdentity = line => ({
  itemKey: String(line?.itemId ?? ''),
  unitKey: String(line?.itemUnitId ?? ''),
  price: effectiveUnitPrice(line),
});

/**
 * @param {Array} newLines  lines submitted on the edit
 * @param {Array} oldLines  lines currently stored on the document
 * @returns {{ matches: Array<Object|null>, unmatchedOldLines: Array<Object> }}
 *   `matches` is index-aligned with `newLines`; each entry is the paired old line or null.
 */
const pairLinesWithExisting = (newLines, oldLines) => {
  const remaining = (oldLines || []).map(line => ({ line, ...lineIdentity(line), taken: false }));
  const matches = new Array((newLines || []).length).fill(null);

  const claim = (index, predicate) => {
    const identity = lineIdentity(newLines[index]);
    const candidate = remaining.find(old => !old.taken && old.itemKey === identity.itemKey && predicate(old, identity));
    if (!candidate) return;
    candidate.taken = true;
    matches[index] = candidate.line;
  };

  // Exact matches first for every line, so a repriced line can never take the slot of a line that still matches exactly.
  (newLines || []).forEach((_, index) => claim(index, (old, id) => old.unitKey === id.unitKey && old.price === id.price));
  (newLines || []).forEach((_, index) => {
    if (!matches[index]) claim(index, (old, id) => old.unitKey === id.unitKey);
  });

  return { matches, unmatchedOldLines: remaining.filter(old => !old.taken).map(old => old.line) };
};

/**
 * For create flows that apply stock per line and then write the batches back onto the saved document lines.
 * Looking the saved line up by itemId alone gives every line of a repeated item the first line, so batches pile up
 * on it. The claimer hands out each saved line once, preferring the same unit + price, then the same unit.
 */
const createLineClaimer = docLines => {
  const claimed = new Set();
  return line => {
    const identity = lineIdentity(line);
    const pool = (docLines || []).filter(doc => !claimed.has(doc) && String(doc.itemId) === identity.itemKey);
    const sameUnit = pool.filter(doc => String(doc.itemUnitId ?? '') === identity.unitKey);
    const pick = sameUnit.find(doc => effectiveUnitPrice(doc) === identity.price) || sameUnit[0] || pool[0];
    if (pick) claimed.add(pick);
    return pick;
  };
};

module.exports = { pairLinesWithExisting, createLineClaimer, effectiveUnitPrice };
