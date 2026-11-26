const mongoose = require('mongoose');
const { getBooksCrmModels, getBooksModels, getCommonModels } = require('../../../services/model.service');
const { formatTemplateCount } = require('../shared/schedule');

// Fixed display order for per-user activity lines.
const DOCUMENT_SOURCES = [
  { key: 'quote', label: 'Quotations', dateField: 'quoteDate', modelGroup: 'bookscrm', modelName: 'Quote' },
  {
    key: 'salesOrder',
    label: 'Sales Orders',
    dateField: 'orderDate',
    modelGroup: 'bookscrm',
    modelName: 'SalesOrder',
  },
  {
    key: 'deliveryChallan',
    label: 'Delivery Challan',
    dateField: 'challanDate',
    modelGroup: 'books',
    modelName: 'DeliveryChallan',
  },
  { key: 'invoice', label: 'Invoices', dateField: 'invoiceDate', modelGroup: 'books', modelName: 'Invoice' },
  {
    key: 'paymentReceived',
    label: 'Payments Rcvd',
    dateField: 'paymentDate',
    modelGroup: 'bookscrm',
    modelName: 'PaymentReceived',
  },
  {
    key: 'creditNote',
    label: 'Credit Notes',
    dateField: 'creditNoteDate',
    modelGroup: 'books',
    modelName: 'CreditNote',
  },
  {
    key: 'purchaseOrder',
    label: 'Purchase Orders',
    dateField: 'date',
    modelGroup: 'books',
    modelName: 'PurchaseOrder',
  },
  { key: 'grpo', label: 'GRPO', dateField: 'date', modelGroup: 'books', modelName: 'GrpoOrder' },
  { key: 'bill', label: 'Bills', dateField: 'billDate', modelGroup: 'books', modelName: 'Bill' },
  {
    key: 'debitNote',
    label: 'Debit Notes',
    dateField: 'debitNoteDate',
    modelGroup: 'books',
    modelName: 'DebitNote',
  },
  {
    key: 'paymentMade',
    label: 'Payments Made',
    dateField: 'paymentDate',
    modelGroup: 'books',
    modelName: 'PaymentMade',
  },
];

const getUserDisplayName = user => {
  if (!user) return 'User';
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || 'User';
};

const countByUser = async (Model, { companyId, dateField, startDate, endDate }) => {
  const match = {
    companyId: new mongoose.Types.ObjectId(companyId),
    [dateField]: { $gte: startDate, $lte: endDate },
    addedBy: { $exists: true, $ne: null },
    status: { $ne: 'CANCELLED' },
  };

  return Model.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$addedBy',
        count: { $sum: 1 },
      },
    },
  ]);
};

const getSummaryData = async (companyId, startDate, endDate, dateLabel, companyName) => {
  const bookscrmModels = getBooksCrmModels();
  const booksModels = getBooksModels();
  const { User } = getCommonModels();

  const modelResolver = {
    bookscrm: bookscrmModels,
    books: booksModels,
  };

  const perSourceRows = await Promise.all(
    DOCUMENT_SOURCES.map(source =>
      countByUser(modelResolver[source.modelGroup][source.modelName], {
        companyId,
        dateField: source.dateField,
        startDate,
        endDate,
      }).then(rows => ({ source, rows })),
    ),
  );

  const activityByUser = new Map();

  for (const { source, rows } of perSourceRows) {
    for (const row of rows) {
      if (!row._id) continue;
      const userId = row._id.toString();
      if (!activityByUser.has(userId)) {
        activityByUser.set(userId, { counts: {}, total: 0 });
      }
      const entry = activityByUser.get(userId);
      entry.counts[source.key] = row.count;
      entry.total += row.count;
    }
  }

  const LINE_BREAK = '||';
  const sanitizeParam = value =>
    String(value || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/ {5,}/g, '    ')
      .trim();

  if (!activityByUser.size) {
    return {
      Date: dateLabel,
      CompanyName: companyName || 'Company',
      ActivityByUser: '-',
      TotalDocuments: 0,
      ActiveUsers: 0,
    };
  }

  const users = await User.find({ _id: { $in: [...activityByUser.keys()] } })
    .select('firstName lastName email')
    .lean();
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  const rankedUsers = [...activityByUser.entries()].sort((a, b) => b[1].total - a[1].total);

  const activityLines = rankedUsers.map(([userId, entry]) => {
    const name = sanitizeParam(getUserDisplayName(userMap.get(userId)));
    const parts = DOCUMENT_SOURCES.filter(source => entry.counts[source.key] > 0).map(
      source => `${entry.counts[source.key]} ${source.label}`,
    );
    return `👤 ${name} • ${parts.join(' · ')}`;
  });

  const totalDocuments = rankedUsers.reduce((sum, [, entry]) => sum + entry.total, 0);

  return {
    Date: dateLabel,
    CompanyName: companyName || 'Company',
    ActivityByUser: activityLines.map(sanitizeParam).join(`${LINE_BREAK}${LINE_BREAK}`),
    TotalDocuments: totalDocuments,
    ActiveUsers: rankedUsers.length,
  };
};

const buildTemplateComponents = data => [
  {
    type: 'body',
    parameters: [
      { type: 'text', text: data.Date },
      { type: 'text', text: data.CompanyName },
      { type: 'text', text: data.ActivityByUser },
      { type: 'text', text: formatTemplateCount(data.TotalDocuments) },
      { type: 'text', text: formatTemplateCount(data.ActiveUsers) },
    ],
  },
];

module.exports = {
  getSummaryData,
  buildTemplateComponents,
};
