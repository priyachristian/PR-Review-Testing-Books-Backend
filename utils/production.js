/**
 * Production data is considered "complete" only when the chosen management method is actually
 * fulfilled:
 *   - BOM_BASED      => at least one BOM row with a non-null item
 *   - PROCESS_ROUTE  => a process recipe is selected
 * Any other case (no method, or method selected but nothing filled in) is treated as incomplete.
 */
const isProductionDataComplete = productionData => {
  const method = productionData?.productionManageMethod;

  if (method === 'BOM_BASED') {
    return Array.isArray(productionData?.bomBased) && productionData.bomBased.some(row => row?.item != null && row.item !== '');
  }

  if (method === 'PROCESS_ROUTE') {
    return productionData?.selectProcessRecipe != null && productionData.selectProcessRecipe !== '';
  }

  return false;
};

module.exports = { isProductionDataComplete };
