const { getSummaryData, buildTemplateComponents } = require('./data');

const DAILY_TEMPLATE = { name: 'daily_inventory_movement', languageCode: 'en' };
const DAILY_INCREMENTAL_TEMPLATE = { name: 'daily_inventory_movement_inc', languageCode: 'en' };
const WEEKLY_TEMPLATE = { name: 'weekly_inventory_movement', languageCode: 'en' };
const WEEKLY_INCREMENTAL_TEMPLATE = { name: 'weekly_inventory_movement_inc', languageCode: 'en' };

module.exports = {
  key: 'inventoryMovement',
  implemented: true,
  periods: {
    daily: { period: 'daily', template: DAILY_TEMPLATE },
    weekly: { period: 'weekly', template: WEEKLY_TEMPLATE },
    monthly: { period: 'monthly', template: { name: 'monthly_inventory_movement', languageCode: 'en' } },
  },
  getPeriodTemplate: (summaryType, { incremental = false } = {}) => {
    if (!incremental) return null;
    if (summaryType === 'daily') return DAILY_INCREMENTAL_TEMPLATE;
    if (summaryType === 'weekly') return WEEKLY_INCREMENTAL_TEMPLATE;
    return null;
  },
  getSummaryData,
  buildTemplateComponents,
};
