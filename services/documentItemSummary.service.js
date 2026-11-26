// services/documentItemSummary.service.js
//
// List-API summary of a document's lines (item count + unit-wise quantity) shared by every Sales and
// Purchase list, so the grid can show "3 items · 150 PCS" without loading the full item details.
//
// Quantities are summed only within the unit each line was entered in (no unit conversion). If more than one
// unit is present the summary is "Mixed Units" and the unit-wise `breakdown` carries the numbers for the
// hover/click view.

const { getBooksCrmModels } = require('./model.service');
const { roundQty } = require('./warehouseBatch.service');

const MIXED_UNITS_LABEL = 'Mixed Units';

const idOf = value => value?._id?.toString?.() || value?.toString?.() || null;

const loadUnitNames = async unitIds => {
  if (!unitIds.size) return new Map();
  const { ItemUnit } = getBooksCrmModels();
  const units = await ItemUnit.find({ _id: { $in: [...unitIds] } })
    .select('name')
    .lean();
  return new Map(units.map(unit => [String(unit._id), unit.name]));
};

const buildSummary = (items, unitNameMap) => {
  const uniqueItems = new Set();
  const totals = new Map();

  (items || []).forEach((line, index) => {
    uniqueItems.add(idOf(line.itemId) || line.itemName || `line-${index}`);

    const unitId = idOf(line.itemUnitId);
    const populatedName = line.itemUnitId && typeof line.itemUnitId === 'object' ? line.itemUnitId.name : null;
    const unitName = (unitId && unitNameMap.get(unitId)) || populatedName || line.itemUnit || '';
    const key = unitId || `name:${unitName}`;

    const entry = totals.get(key) || { unitId, unit: unitName, quantity: 0 };
    entry.quantity += Number(line.quantity) || 0;
    totals.set(key, entry);
  });

  const breakdown = [...totals.values()].map(entry => ({ ...entry, quantity: roundQty(entry.quantity) }));
  const isMixedUnits = breakdown.length > 1;

  return {
    itemCount: uniqueItems.size,
    quantitySummary: {
      isMixedUnits,
      totalQuantity: isMixedUnits ? null : (breakdown[0]?.quantity ?? 0),
      unit: isMixedUnits ? null : (breakdown[0]?.unit ?? ''),
      label: isMixedUnits ? MIXED_UNITS_LABEL : `${breakdown[0]?.quantity ?? 0} ${breakdown[0]?.unit ?? ''}`.trim(),
      breakdown,
    },
  };
};

/**
 * Adds `itemCount` and `quantitySummary` to each (plain-object) document of a list page. One small batched
 * lookup of unit names for the whole page; the items themselves are not loaded.
 *
 * @param {Array<Object>} docs documents with `items[]` ({ itemId, itemUnitId, quantity, ... })
 * @returns {Promise<Array<Object>>} new document objects
 */
const attachItemSummaries = async docs => {
  try {
    const unitIds = new Set();
    docs.forEach(doc =>
      (doc.items || []).forEach(line => {
        const unitId = idOf(line.itemUnitId);
        if (unitId) unitIds.add(unitId);
      }),
    );

    const unitNameMap = await loadUnitNames(unitIds);
    return docs.map(doc => ({ ...doc, ...buildSummary(doc.items, unitNameMap) }));
  } catch {
    return docs.map(doc => ({ ...doc, itemCount: 0, quantitySummary: null }));
  }
};

module.exports = { attachItemSummaries, MIXED_UNITS_LABEL };
