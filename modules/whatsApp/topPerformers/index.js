const { getSummaryData, buildTemplateComponents } = require('./data');

const DAILY_TEMPLATE = { name: 'daily_top_performers', languageCode: 'en' };
const DAILY_INCREMENTAL_TEMPLATE = { name: 'daily_top_performers_inc', languageCode: 'en' };
const WEEKLY_TEMPLATE = { name: 'weekly_top_performers', languageCode: 'en' };
const WEEKLY_INCREMENTAL_TEMPLATE = { name: 'weekly_top_performers_inc', languageCode: 'en' };

module.exports = {
  key: 'topPerformers',
  implemented: true,
  periods: {
    daily: { period: 'daily', template: DAILY_TEMPLATE },
    weekly: { period: 'weekly', template: WEEKLY_TEMPLATE },
    monthly: { period: 'monthly', template: { name: 'monthly_top_performers', languageCode: 'en' } },
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
