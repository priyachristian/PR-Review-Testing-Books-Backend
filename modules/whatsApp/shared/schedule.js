const moment = require('moment-timezone');
const { TIMEZONE, SUMMARY_TYPES, WEEKDAY_MAP } = require('./constants');

const getCurrentIstMoment = () => moment.tz(TIMEZONE);

const formatTemplateAmount = amount => Math.round(amount || 0).toLocaleString('en-IN');
const formatTemplateCount = count => String(count || 0);

// The period param ({{1}}) is formatted to match each template's wording:
//   daily   → "16 Jul 2026"
//   weekly  → "14 Jul 2026 to 20 Jul 2026"
//   monthly → "July 2026"
const formatPeriodLabel = (summaryType, periodStart, periodEnd) => {
  if (summaryType === SUMMARY_TYPES.MONTHLY) {
    return periodStart.format('MMMM YYYY');
  }
  if (summaryType === SUMMARY_TYPES.WEEKLY) {
    return `${periodStart.format('D MMM YYYY')} to ${periodEnd.format('D MMM YYYY')}`;
  }
  return periodStart.format('D MMM YYYY');
};

const getTemplateSchedule = (config, templateKey) => (config?.whatsapp?.templates || []).find(t => t?.key === templateKey) || {};

const isTemplateEnabled = (config, templateKey) => !!getTemplateSchedule(config, templateKey)?.enabled;

// Daily, weekly and monthly are independent schedules and may all be enabled at once.
// Returns every enabled type (0–3) for the given template key.
const getEnabledSummaryTypes = (config, templateKey) => {
  if (!isTemplateEnabled(config, templateKey)) return [];

  const { daily, weekly, monthly } = getTemplateSchedule(config, templateKey);
  const enabled = [];
  if (daily?.enabled) enabled.push(SUMMARY_TYPES.DAILY);
  if (weekly?.enabled) enabled.push(SUMMARY_TYPES.WEEKLY);
  if (monthly?.enabled) enabled.push(SUMMARY_TYPES.MONTHLY);

  return enabled;
};

const isSummaryScheduleDue = (config, templateKey, summaryType, now) => {
  const schedule = getTemplateSchedule(config, templateKey);

  if (summaryType === SUMMARY_TYPES.DAILY) {
    return schedule.daily?.time === now.format('HH:mm');
  }

  if (summaryType === SUMMARY_TYPES.WEEKLY) {
    if (schedule.weekly?.time !== now.format('HH:mm')) return false;
    return now.day() === WEEKDAY_MAP[schedule.weekly.day];
  }

  if (summaryType === SUMMARY_TYPES.MONTHLY) {
    if (schedule.monthly?.time !== now.format('HH:mm')) return false;
    const configuredDate = schedule.monthly.date;
    const effectiveDate = Math.min(configuredDate, now.daysInMonth());
    return now.date() === effectiveDate;
  }

  return false;
};

const getDueSummaryTypes = (config, templateKey, now = getCurrentIstMoment()) =>
  getEnabledSummaryTypes(config, templateKey).filter(summaryType => isSummaryScheduleDue(config, templateKey, summaryType, now));

const getDateRangeForSummaryType = (summaryType, now = getCurrentIstMoment()) => {
  if (summaryType === SUMMARY_TYPES.DAILY) {
    const periodStart = now.clone().startOf('day');
    const periodEnd = now.clone().endOf('day');
    return {
      periodStart,
      periodEnd,
      startDate: periodStart.toDate(),
      endDate: periodEnd.toDate(),
    };
  }

  if (summaryType === SUMMARY_TYPES.WEEKLY) {
    const periodEnd = now.clone().subtract(1, 'day').endOf('day');
    const periodStart = periodEnd.clone().subtract(6, 'days').startOf('day');
    return {
      periodStart,
      periodEnd,
      startDate: periodStart.toDate(),
      endDate: periodEnd.toDate(),
    };
  }

  if (now.date() === 1) {
    const periodStart = now.clone().subtract(1, 'month').startOf('month');
    const periodEnd = now.clone().subtract(1, 'month').endOf('month');
    return {
      periodStart,
      periodEnd,
      startDate: periodStart.toDate(),
      endDate: periodEnd.toDate(),
    };
  }

  const periodStart = now.clone().startOf('month');
  const periodEnd = now.clone().subtract(1, 'day').endOf('day');
  return {
    periodStart,
    periodEnd,
    startDate: periodStart.toDate(),
    endDate: periodEnd.toDate(),
  };
};

// A stable key for the period a given send covers, so the same period is only sent
// once regardless of retries. Daily → the day; weekly → the ISO week; monthly → the month.
const getPeriodKey = (summaryType, periodStart) => {
  if (summaryType === SUMMARY_TYPES.WEEKLY) return `w-${periodStart.format('GGGG-WW')}`;
  if (summaryType === SUMMARY_TYPES.MONTHLY) return `m-${periodStart.format('YYYY-MM')}`;
  return `d-${periodStart.format('YYYY-MM-DD')}`;
};

module.exports = {
  getCurrentIstMoment,
  formatTemplateAmount,
  formatTemplateCount,
  formatPeriodLabel,
  getTemplateSchedule,
  isTemplateEnabled,
  getEnabledSummaryTypes,
  getDueSummaryTypes,
  getDateRangeForSummaryType,
  getPeriodKey,
};
