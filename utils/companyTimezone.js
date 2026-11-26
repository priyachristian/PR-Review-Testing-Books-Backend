const moment = require('moment-timezone');
const { getCommonModels } = require('../services/model.service');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DATE_ONLY_FORMAT = 'YYYY-MM-DD';

const extractIanaTimezone = value => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (moment.tz.zone(trimmed)) return trimmed;

  const matches = [...trimmed.matchAll(/\(([^)]+)\)/g)].map(m => m[1].trim());
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (moment.tz.zone(matches[i])) return matches[i];
  }
  return null;
};

const resolveCompanyTimezone = async companyId => {
  if (!companyId) return DEFAULT_TIMEZONE;
  const { Company } = getCommonModels();
  const company = await Company.findById(companyId).select('timeZone').lean();
  return extractIanaTimezone(company?.timeZone) || DEFAULT_TIMEZONE;
};

const toLocalDateBoundary = (dateInput, { endOfDay = false, timezone = DEFAULT_TIMEZONE } = {}) => {
  const m =
    typeof dateInput === 'string' ? moment.tz(dateInput, DATE_ONLY_FORMAT, true, timezone) : moment.tz(dateInput, timezone);

  if (!m.isValid()) {
    throw new Error(`Invalid date "${dateInput}". Expected format ${DATE_ONLY_FORMAT}.`);
  }

  return (endOfDay ? m.endOf('day') : m.startOf('day')).toDate();
};

const getLocalYearRange = (year, timezone = DEFAULT_TIMEZONE) => {
  const yearInt = parseInt(year, 10);
  const startDate = moment.tz({ year: yearInt, month: 0, day: 1 }, timezone).startOf('day').toDate();
  const endDate = moment.tz({ year: yearInt, month: 11, day: 31 }, timezone).endOf('day').toDate();
  return { startDate, endDate };
};

const getLocalMonthRange = (year, month, timezone = DEFAULT_TIMEZONE) => {
  const yearInt = parseInt(year, 10);
  const monthInt = parseInt(month, 10);
  const startDate = moment
    .tz({ year: yearInt, month: monthInt - 1, day: 1 }, timezone)
    .startOf('month')
    .toDate();
  const endDate = moment
    .tz({ year: yearInt, month: monthInt - 1, day: 1 }, timezone)
    .endOf('month')
    .toDate();
  return { startDate, endDate };
};

const mongoDateUnit = (unit, dateField, timezone = DEFAULT_TIMEZONE) => ({
  [`$${unit}`]: { date: dateField, timezone },
});

const mongoDateParts = (dateField, timezone = DEFAULT_TIMEZONE) => ({
  year: { $year: { date: dateField, timezone } },
  month: { $month: { date: dateField, timezone } },
  day: { $dayOfMonth: { date: dateField, timezone } },
});

module.exports = {
  DEFAULT_TIMEZONE,
  DATE_ONLY_FORMAT,
  extractIanaTimezone,
  resolveCompanyTimezone,
  toLocalDateBoundary,
  getLocalYearRange,
  getLocalMonthRange,
  mongoDateUnit,
  mongoDateParts,
};
