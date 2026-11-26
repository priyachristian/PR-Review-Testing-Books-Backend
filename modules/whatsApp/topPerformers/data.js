const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { getBooksCrmModels, getBooksModels, getCommonModels } = require('../../../services/model.service');
const { INVOICE_STATUS } = require('../../../utils/enum');
const { formatTemplateAmount, formatTemplateCount } = require('../shared/schedule');
const { TIMEZONE } = require('../shared/constants');

const getPeriodTopPerformerStats = async (companyId, startDate, endDate) => {
  const { Invoice } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { User } = getCommonModels();

  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    invoiceDate: { $gte: startDate, $lte: endDate },
    status: { $ne: INVOICE_STATUS.CANCELLED },
  };

  const amountExpr = {
    $sum: { $multiply: [{ $ifNull: ['$total', 0] }, { $ifNull: ['$exchangeRate', 1] }] },
  };

  const [topCustomersAggregation, topItemsAggregation, topSalespersonAggregation] = await Promise.all([
    Invoice.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$customerId',
          totalSales: amountExpr,
        },
      },
      { $sort: { totalSales: -1 } },
      { $limit: 3 },
    ]),

    Invoice.aggregate([
      { $match: match },
      {
        $match: {
          $or: [
            { isSplit: false },
            { isSplit: { $exists: false } },
            {
              isSplit: true,
              splitWiseType: { $ne: 'Split By Price' },
            },
          ],
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.itemId',
          name: { $first: '$items.itemName' },
          quantity: { $sum: '$items.quantity' },
        },
      },
      { $sort: { quantity: -1 } },
      { $limit: 3 },
    ]),

    Invoice.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$addedBy',
          totalSales: amountExpr,
        },
      },
      { $sort: { totalSales: -1 } },
      { $limit: 1 },
    ]),
  ]);

  const customerIds = topCustomersAggregation.map(c => c._id).filter(Boolean);
  const customers =
    customerIds.length > 0
      ? await Customer.find({ _id: { $in: customerIds } }, { companyName: 1, customerDisplayName: 1 }).lean()
      : [];
  const customerMap = customers.reduce((acc, curr) => {
    acc[curr._id.toString()] = curr.companyName || curr.customerDisplayName || 'Unknown';
    return acc;
  }, {});

  const userIds = topSalespersonAggregation.map(s => s._id).filter(Boolean);
  const users = userIds.length > 0 ? await User.find({ _id: { $in: userIds } }).lean() : [];
  const userMap = users.reduce((acc, curr) => {
    acc[curr._id.toString()] = `${curr.firstName || ''} ${curr.lastName || ''}`.trim() || 'Unknown';
    return acc;
  }, {});

  const topCustomersStr =
    topCustomersAggregation.length > 0
      ? topCustomersAggregation
          .map(c => {
            const name = c._id ? customerMap[c._id.toString()] : 'Unknown';
            return `${name || 'Unknown'} = ₹${formatTemplateAmount(c.totalSales)}`;
          })
          .join(' · ')
      : 'No data';

  const topItemsStr =
    topItemsAggregation.length > 0
      ? topItemsAggregation.map(i => `${i.name || 'Unknown'} (${formatTemplateCount(i.quantity)})`).join(' · ')
      : 'No data';

  let topSalesPersonName = 'N/A';
  let topSalesPersonAmount = '0';

  if (topSalespersonAggregation.length > 0) {
    const spId = topSalespersonAggregation[0]._id;
    topSalesPersonName = spId ? userMap[spId.toString()] || 'Unknown' : 'Unknown';
    topSalesPersonAmount = formatTemplateAmount(topSalespersonAggregation[0].totalSales);
  }

  return {
    TopCustomers: topCustomersStr,
    TopItems: topItemsStr,
    TopSalesPerson: topSalesPersonName,
    TopSalesPersonAmount: topSalesPersonAmount,
  };
};

const formatMtdPeriodLabel = periodEnd => {
  const end = moment.isMoment(periodEnd) ? periodEnd.clone().tz(TIMEZONE) : moment(periodEnd).tz(TIMEZONE);
  const start = end.clone().startOf('month');
  return `${start.format('D MMM YYYY')} to ${end.format('D MMM YYYY')}`;
};

const getSummaryData = async (companyId, startDate, endDate, dateLabel, companyName, options = {}) => {
  const { incremental = false, periodEnd } = options;

  const periodStats = await getPeriodTopPerformerStats(companyId, startDate, endDate);

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
  const mtdStats = await getPeriodTopPerformerStats(companyId, mtdStart, mtdEnd);

  return {
    ...summary,
    incremental: true,
    MtdDate: formatMtdPeriodLabel(mtdEndMoment),
    MtdTopCustomers: mtdStats.TopCustomers,
    MtdTopItems: mtdStats.TopItems,
    MtdTopSalesPerson: mtdStats.TopSalesPerson,
    MtdTopSalesPersonAmount: mtdStats.TopSalesPersonAmount,
  };
};

const buildPeriodBodyParameters = data => [
  { type: 'text', text: data.Date },
  { type: 'text', text: data.CompanyName },
  { type: 'text', text: data.TopCustomers },
  { type: 'text', text: data.TopItems },
  { type: 'text', text: data.TopSalesPerson },
  { type: 'text', text: data.TopSalesPersonAmount },
];

const buildTemplateComponents = data => {
  const parameters = buildPeriodBodyParameters(data);

  if (data.incremental) {
    parameters.push(
      { type: 'text', text: data.MtdDate },
      { type: 'text', text: data.MtdTopCustomers },
      { type: 'text', text: data.MtdTopItems },
      { type: 'text', text: data.MtdTopSalesPerson },
      { type: 'text', text: data.MtdTopSalesPersonAmount },
    );
  }

  return [{ type: 'body', parameters }];
};

module.exports = {
  getSummaryData,
  buildTemplateComponents,
};
