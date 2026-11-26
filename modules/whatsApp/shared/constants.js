const TIMEZONE = 'Asia/Kolkata';

// Retain the "already sent" marker for 3 days — long enough to cover retries and
// restarts across any schedule, short enough to self-clean.
const SEND_MARKER_TTL_SECONDS = 3 * 24 * 60 * 60;

// Last-send outcome per company, retained ~40 days so the config page can always show
// the most recent result (covering the longest — monthly — schedule).
const SUMMARY_STATUS_TTL_SECONDS = 40 * 24 * 60 * 60;

const SUMMARY_TYPES = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
};

const WEEKDAY_MAP = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

module.exports = {
  TIMEZONE,
  SEND_MARKER_TTL_SECONDS,
  SUMMARY_STATUS_TTL_SECONDS,
  SUMMARY_TYPES,
  WEEKDAY_MAP,
};
