const { getSummaryData, buildTemplateComponents } = require('./data');

module.exports = {
  key: 'dailyActivityByUser',
  implemented: true,
  periods: {
    daily: { period: 'daily', template: { name: 'daily_activity_by_user', languageCode: 'en' } },
  },
  getSummaryData,
  buildTemplateComponents,
};
