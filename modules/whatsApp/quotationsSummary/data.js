const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { getBooksCrmModels, getCommonModels } = require('../../../services/model.service');
const { QUOTE_STATUS } = require('../../../utils/enum');
const { formatTemplateAmount, formatTemplateCount, getCurrentIstMoment } = require('../shared/schedule');
const { TIMEZONE } = require('../shared/constants');

const PERIOD_EXCLUDED_STATUSES = [QUOTE_STATUS.CANCELLED, QUOTE_STATUS.EXPIRED];
const OPEN_STATUSES = [QUOTE_STATUS.DRAFT, QUOTE_STATUS.SENT, QUOTE_STATUS.ACCEPTED];

const emptyStats = () => ({ count: 0, total: 0 });

const amountExpr = {
  $sum: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
};

const getPeriodMatch = (companyId, startDate, endDate) => ({
  companyId: new mongoose.Types.ObjectId(companyId),
  quoteDate: { $gte: startDate, $lte: endDate },
  status: { $nin: PERIOD_EXCLUDED_STATUSES },
});

const getStatusBreakdown = async (Quote, companyId, startDate, endDate) => {
  const rows = await Quote.aggregate([
    { $match: getPeriodMatch(companyId, startDate, endDate) },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        total: amountExpr,
      },
    },
  ]);

  const byStatus = Object.fromEntries(rows.map(row => [row._id, { count: row.count, total: row.total }]));
  const draft = byStatus[QUOTE_STATUS.DRAFT] || emptyStats();
  const sent = byStatus[QUOTE_STATUS.SENT] || emptyStats();
  const accepted = byStatus[QUOTE_STATUS.ACCEPTED] || emptyStats();
  const completed = byStatus[QUOTE_STATUS.COMPLETED] || emptyStats();
  const rejected = byStatus[QUOTE_STATUS.REJECTED] || emptyStats();

  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
  const totalAmount = rows.reduce((sum, row) => sum + row.total, 0);

  return {
    totalCount,
    totalAmount,
    acceptedCount: accepted.count + completed.count,
    rejectedCount: rejected.count,
    pendingCount: draft.count + sent.count,
  };
};

const getByUserLabel = async (Quote, companyId, startDate, endDate) => {
  const { User } = getCommonModels();

  const rows = await Quote.aggregate([
    { $match: getPeriodMatch(companyId, startDate, endDate) },
    {
      $group: {
        _id: '$addedBy',
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ]);

  if (!rows.length) return '-';

  const userIds = rows.map(row => row._id).filter(Boolean);
  const users = await User.find({ _id: { $in: userIds } })
    .select('firstName lastName email')
    .lean();
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  return rows
    .map(row => {
      const user = row._id ? userMap.get(row._id.toString()) : null;
      const name = user ? [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || 'User' : 'User';
      return `${name} = ${row.count}`;
    })
    .join(' · ');
};

const getExpiringSoonStats = async (Quote, companyId) => {
  const now = getCurrentIstMoment();
  const expiryStart = now.clone().startOf('day').toDate();
  const expiryEnd = now.clone().add(3, 'days').endOf('day').toDate();

  const [result] = await Quote.aggregate([
    {
      $match: {
        companyId: new mongoose.Types.ObjectId(companyId),
        status: { $in: OPEN_STATUSES },
        expiryDate: { $gte: expiryStart, $lte: expiryEnd },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total: amountExpr,
      },
    },
  ]);

  return {
    count: result?.count || 0,
    total: result?.total || 0,
  };
};

const getPeriodQuotationStats = async (companyId, startDate, endDate, { includeExpiringSoon = true } = {}) => {
  const { Quote } = getBooksCrmModels();

  const tasks = [getStatusBreakdown(Quote, companyId, startDate, endDate), getByUserLabel(Quote, companyId, startDate, endDate)];
  if (includeExpiringSoon) {
    tasks.push(getExpiringSoonStats(Quote, companyId));
  }

  const [periodStats, byUser, expiringSoon] = await Promise.all(tasks);

  return {
    QuotesCreated: periodStats.totalCount,
    TotalValue: periodStats.totalAmount,
    ByUser: byUser,
    Accepted: periodStats.acceptedCount,
    Rejected: periodStats.rejectedCount,
    Pending: periodStats.pendingCount,
    ExpiringSoonCount: includeExpiringSoon ? expiringSoon.count : undefined,
    ExpiringSoonValue: includeExpiringSoon ? expiringSoon.total : undefined,
  };
};

const formatMtdPeriodLabel = periodEnd => {
  const end = moment.isMoment(periodEnd) ? periodEnd.clone().tz(TIMEZONE) : moment(periodEnd).tz(TIMEZONE);
  const start = end.clone().startOf('month');
  return `${start.format('D MMM YYYY')} to ${end.format('D MMM YYYY')}`;
};

const getSummaryData = async (companyId, startDate, endDate, dateLabel, companyName, options = {}) => {
  const { incremental = false, periodEnd } = options;

  const periodStats = await getPeriodQuotationStats(companyId, startDate, endDate, { includeExpiringSoon: true });

  const summary = {
    Date: dateLabel,
    CompanyName: companyName || 'Company',
    ...periodStats,
    incremental: false,
  };

  if (!incremental) {
    return summary;
  }

  const mtdEndMoment = moment.isMoment(periodEnd) ? periodEnd.clone().tz(TIMEZONE) : moment(endDate).tz(TIMEZONE);
  const mtdStart = mtdEndMoment.clone().startOf('month').toDate();
  const mtdEnd = mtdEndMoment.clone().endOf('day').toDate();
  const mtdStats = await getPeriodQuotationStats(companyId, mtdStart, mtdEnd, { includeExpiringSoon: false });

  return {
    ...summary,
    incremental: true,
    MtdDate: formatMtdPeriodLabel(mtdEndMoment),
    MtdQuotesCreated: mtdStats.QuotesCreated,
    MtdTotalValue: mtdStats.TotalValue,
    MtdByUser: mtdStats.ByUser,
    MtdAccepted: mtdStats.Accepted,
    MtdRejected: mtdStats.Rejected,
    MtdPending: mtdStats.Pending,
  };
};

const buildPeriodBodyParameters = data => [
  { type: 'text', text: data.Date },
  { type: 'text', text: data.CompanyName },
  { type: 'text', text: formatTemplateCount(data.QuotesCreated) },
  { type: 'text', text: formatTemplateAmount(data.TotalValue) },
  { type: 'text', text: data.ByUser },
  { type: 'text', text: formatTemplateCount(data.Accepted) },
  { type: 'text', text: formatTemplateCount(data.Rejected) },
  { type: 'text', text: formatTemplateCount(data.Pending) },
  { type: 'text', text: formatTemplateCount(data.ExpiringSoonCount) },
  { type: 'text', text: formatTemplateAmount(data.ExpiringSoonValue) },
];

const buildTemplateComponents = data => {
  const parameters = buildPeriodBodyParameters(data);

  if (data.incremental) {
    parameters.push(
      { type: 'text', text: data.MtdDate },
      { type: 'text', text: formatTemplateCount(data.MtdQuotesCreated) },
      { type: 'text', text: formatTemplateAmount(data.MtdTotalValue) },
      { type: 'text', text: data.MtdByUser },
      { type: 'text', text: formatTemplateCount(data.MtdAccepted) },
      { type: 'text', text: formatTemplateCount(data.MtdRejected) },
      { type: 'text', text: formatTemplateCount(data.MtdPending) },
    );
  }

  return [{ type: 'body', parameters }];
};

module.exports = {
  getSummaryData,
  buildTemplateComponents,
};
