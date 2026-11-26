const httpStatus = require('http-status');
const mongoose = require('mongoose');
const moment = require('moment');
const ApiError = require('../../../utils/ApiError');
const { getBooksModels, getBooksCrmModels } = require('../../../services/model.service');
const { PAYMENT_STATUS, INVOICE_STATUS, BILL_STATUSES } = require('../../../utils/enum');

const MIN_COLUMNS = 1;
const MAX_COLUMNS = 8;
const MIN_DURATION = 1;
const MAX_DURATION = 100;
const UNIT_TO_DAYS = {
  days: 1,
  weeks: 7,
  months: 30,
  years: 365,
};
const COLUMN_TYPE_LABELS = {
  days: 'Days',
  weeks: 'Weeks',
  months: 'Months',
  years: 'Years',
};
const MAX_DOCUMENTS_PER_BUCKET = 50;
const MAX_TOTAL_DOCUMENTS = 1000;
const MAX_DATE_RANGE_DAYS = 365;

const applySplitFilter = (queryFilter, filter) => {
  if (filter?.isSplit == undefined) {
    queryFilter.isSplit = false;
  }
  if (filter?.splitOnly) {
    queryFilter.isSplit = true;
  }
};

const validateDate = date => {
  if (!date) return null;
  const dateMoment = moment(date);
  return dateMoment.isValid() ? dateMoment : null;
};

const validateDateRange = (startDate, endDate) => {
  const start = validateDate(startDate);
  if (!start) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid startDate format');
  }

  const end = validateDate(endDate);
  if (!end) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid endDate format');
  }

  const today = moment().startOf('day');
  if (start.isBefore(today)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'startDate must be today or a future date');
  }

  if (end.isBefore(start) || end.isSame(start)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'endDate must be after startDate');
  }

  const daysDiff = end.diff(start, 'days');
  if (daysDiff > MAX_DATE_RANGE_DAYS) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`);
  }
};

const generateBuckets = ({ numColumns, columnType, duration, startDate = null, endDate = null, mode = 'aging' }) => {
  // Input validation
  const numColumnsInt = Math.floor(Number(numColumns));
  if (!Number.isInteger(numColumnsInt) || numColumnsInt < MIN_COLUMNS || numColumnsInt > MAX_COLUMNS) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Invalid parameter: numColumns must be an integer between ${MIN_COLUMNS}-${MAX_COLUMNS}`,
    );
  }

  const validColumnTypes = Object.keys(UNIT_TO_DAYS);
  if (!validColumnTypes.includes(columnType)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid parameter: columnType must be one of ${validColumnTypes.join(', ')}`);
  }

  const numDuration = Math.floor(Number(duration));
  if (!Number.isInteger(numDuration) || numDuration < MIN_DURATION || numDuration > MAX_DURATION) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Invalid parameter: duration must be an integer between ${MIN_DURATION}-${MAX_DURATION}`,
    );
  }

  const isUpcoming = mode === 'upcoming';
  const baseDate = startDate ? moment(startDate).startOf('day') : moment().startOf('day');
  const daysPerColumn = numDuration * (UNIT_TO_DAYS[columnType] || 1);
  const labelSuffix = COLUMN_TYPE_LABELS[columnType] || 'Days';
  const buckets = [];

  // Edge case: single bucket
  if (numColumnsInt === 1) {
    const bucket = {
      minDays: 0,
      maxDays: daysPerColumn,
      label: isUpcoming ? `0-${numDuration} ${columnType}` : `0-${numDuration} ${labelSuffix}`,
      bucket: `0-${numDuration} ${columnType}`,
    };

    if (isUpcoming) {
      bucket.isOpenEnded = false;
      bucket.receivableAmount = 0;
      bucket.payableAmount = 0;
      bucket.count = 0;
      bucket.receivables = [];
      bucket.payables = [];
      bucket.isEmpty = true;
      bucket.startDate = baseDate.format('YYYY-MM-DD');
      bucket.endDate = baseDate.clone().add(daysPerColumn, 'days').format('YYYY-MM-DD');
    } else {
      bucket.amount = 0;
      bucket.count = 0;
      bucket.percentage = 0;
      bucket.documents = [];
    }

    buckets.push(bucket);
    return buckets;
  }

  // Generate multiple buckets. Use contiguous day ranges so every age falls in the correct bucket
  for (let i = 0; i < numColumnsInt; i++) {
    const isFirst = i === 0;
    const isLast = i === numColumnsInt - 1;
    let minDays, maxDays, startValue, endValue, label, bucketStr;

    if (isFirst) {
      startValue = 0;
      endValue = numDuration;
      minDays = 0;
      maxDays = daysPerColumn;
      bucketStr = `${startValue}-${endValue} ${columnType}`;
      label = isUpcoming ? bucketStr : `${startValue}-${endValue} ${labelSuffix}`;
    } else if (isLast) {
      const thresholdValue = i * numDuration;
      startValue = thresholdValue + 1;
      minDays = (numColumnsInt - 1) * daysPerColumn + 1;
      maxDays = Infinity;
      const displayThreshold = thresholdValue + 1;
      bucketStr = `Greater than ${displayThreshold} ${columnType}`;
      label = isUpcoming ? bucketStr : `Greater than ${displayThreshold} ${labelSuffix}`;
    } else {
      startValue = isUpcoming ? i * numDuration : i * numDuration + 1;
      endValue = (i + 1) * numDuration;
      minDays = i * daysPerColumn + 1;
      maxDays = (i + 1) * daysPerColumn;
      bucketStr = `${startValue}-${endValue} ${columnType}`;
      label = isUpcoming ? bucketStr : `${startValue}-${endValue} ${labelSuffix}`;
    }

    const bucket = {
      minDays,
      maxDays,
      bucket: bucketStr,
      label,
    };

    if (isUpcoming) {
      bucket.isOpenEnded = isLast;
      bucket.receivableAmount = 0;
      bucket.payableAmount = 0;
      bucket.count = 0;
      bucket.receivables = [];
      bucket.payables = [];
      bucket.isEmpty = true;
      bucket.startDate = baseDate.clone().add(minDays, 'days').format('YYYY-MM-DD');
      bucket.endDate = isLast
        ? baseDate.clone().add(MAX_DATE_RANGE_DAYS, 'days').format('YYYY-MM-DD')
        : baseDate.clone().add(maxDays, 'days').format('YYYY-MM-DD');
    } else {
      bucket.amount = 0;
      bucket.count = 0;
      bucket.percentage = 0;
      bucket.documents = [];
    }

    buckets.push(bucket);
  }

  return buckets;
};

const calculateDaysUntilDue = dueDate => {
  if (!dueDate) return null;

  const due = moment(dueDate);
  if (!due.isValid()) return null;

  const today = moment().startOf('day');
  const dueStart = due.startOf('day');

  const daysDiff = dueStart.diff(today, 'days');

  // Exclude overdue items from upcoming payments (only future dates)
  // Return null for overdue items (daysDiff < 0)
  return daysDiff >= 0 ? daysDiff : null;
};

const assignToUpcomingBucket = (daysUntilDue, buckets) => {
  if (daysUntilDue === null || daysUntilDue === undefined) {
    return buckets.length - 1; // Fallback to last bucket for invalid dates
  }

  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    if (daysUntilDue >= bucket.minDays && (bucket.maxDays === Infinity || daysUntilDue <= bucket.maxDays)) {
      return i;
    }
  }

  // Fallback to last bucket
  return buckets.length - 1;
};

const calculateDocumentStatus = (amount, balanceAmount) => {
  if (balanceAmount === 0) return 'paid';
  if (balanceAmount < amount) return 'partially_paid';
  return 'unpaid';
};

const formatDocumentForBucket = (doc, type, customerMap, vendorMap, branchMap) => {
  if (!doc.dueDate || !doc.total || doc.total <= 0) return null;

  const daysUntilDue = calculateDaysUntilDue(doc.dueDate);
  if (daysUntilDue === null) return null; // Skip overdue or invalid dates

  const rate = doc.exchangeRate ?? 1;
  const amount = Number(doc.total || 0) * rate;
  const balanceAmount = Number(doc.balanceAmount || 0) * rate;

  if (amount <= 0 || balanceAmount < 0) return null; // Skip invalid amounts

  const status = calculateDocumentStatus(amount, balanceAmount);

  if (type === 'receivable') {
    const customerName = customerMap.get(doc.customerId?.toString()) || 'Unknown';
    const branchName = branchMap.get(doc.branchId?.toString()) || 'Unknown';
    return {
      invoiceId: doc._id.toString(),
      invoiceNumber: doc.invoiceId || 'N/A',
      invoiceDate: doc.invoiceDate,
      customerName,
      branchName,
      amount: parseFloat(amount.toFixed(2)),
      balanceAmount: parseFloat(balanceAmount.toFixed(2)),
      dueDate: moment(doc.dueDate).format('YYYY-MM-DD'),
      daysUntilDue,
      expectedPaymentDate: moment(doc.dueDate).format('YYYY-MM-DD'),
      redirectUrl: `/invoices/${doc._id.toString()}`,
      status,
    };
  } else {
    // payable
    const vendorName = vendorMap.get(doc.vendor?.toString()) || 'Unknown';
    const branchName = branchMap.get(doc.branchId?.toString()) || 'Unknown';
    return {
      billId: doc._id.toString(),
      billNumber: doc.billId || 'N/A',
      billDate: doc.billDate,
      vendorName,
      branchName,
      amount: parseFloat(amount.toFixed(2)),
      balanceAmount: parseFloat(balanceAmount.toFixed(2)),
      dueDate: moment(doc.dueDate).format('YYYY-MM-DD'),
      daysUntilDue,
      expectedPaymentDate: moment(doc.dueDate).format('YYYY-MM-DD'),
      redirectUrl: `/bills/${doc._id.toString()}`,
      status,
    };
  }
};

const buildDocumentQuery = (companyId, dateRange, entityIds, entityField, includePartiallyPaid = true) => {
  const query = {
    companyId: new mongoose.Types.ObjectId(companyId),
    dueDate: dateRange,
    balanceAmount: { $gt: 0 },
  };

  // Status filter: exclude fully paid, optionally include partially paid
  if (includePartiallyPaid) {
    query.status = { $ne: 'paid' };
  } else {
    query.status = 'unpaid';
  }

  if (entityIds && entityIds.length > 0) {
    query[entityField] = {
      $in: entityIds.map(id => new mongoose.Types.ObjectId(id)),
    };
  }

  return query;
};

const getUpcomingPayments = async params => {
  // Whitelist allowed parameters
  const allowedParams = [
    'companyId',
    'branchId',
    'startDate',
    'endDate',
    'numberOfColumns',
    'columnType',
    'duration',
    'customerIds',
    'vendorIds',
    'includePartiallyPaid',
    'sortBy',
  ];

  // Validate parameter names
  const paramKeys = Object.keys(params);
  const invalidParams = paramKeys.filter(key => !allowedParams.includes(key));
  if (invalidParams.length > 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid parameters: ${invalidParams.join(', ')}`);
  }

  // Extract and validate required parameters
  const {
    companyId,
    branchId,
    startDate,
    endDate,
    numberOfColumns,
    columnType,
    duration,
    customerIds,
    vendorIds,
    includePartiallyPaid = true,
    sortBy = null,
  } = params;

  // Validate required parameters with specific error messages
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required parameter: companyId');
  }
  if (!startDate) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required parameter: startDate');
  }
  if (!endDate) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required parameter: endDate');
  }
  if (!numberOfColumns) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required parameter: numberOfColumns');
  }
  if (!columnType) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required parameter: columnType');
  }
  if (!duration) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required parameter: duration');
  }

  // Validate date range
  validateDateRange(startDate, endDate);

  let bucketSortField = null;
  let bucketSortOrder = 'asc';

  if (sortBy) {
    const sortParts = sortBy.split(':');
    if (sortParts.length !== 2) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'sortBy must be in format "field:direction" (e.g., "receivableAmount:asc")');
    }

    bucketSortField = sortParts[0].trim();
    bucketSortOrder = sortParts[1].trim().toLowerCase();

    const validBucketSortFields = ['receivableAmount', 'payableAmount', 'count', 'receivablesCount', 'payablesCount'];
    const validSortOrders = ['asc', 'desc'];

    if (!validBucketSortFields.includes(bucketSortField)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `sortBy field must be one of: ${validBucketSortFields.join(', ')}`);
    }

    if (!validSortOrders.includes(bucketSortOrder)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `sortBy direction must be one of: ${validSortOrders.join(', ')}`);
    }
  }

  // IDs are already normalized by controller (processFilter converts strings to arrays)
  // Filter out any falsy values and ensure they're arrays
  const normalizedBranchIds = Array.isArray(branchId) ? branchId.filter(Boolean) : undefined;
  const normalizedCustomerIds = Array.isArray(customerIds) ? customerIds.filter(Boolean) : undefined;
  const normalizedVendorIds = Array.isArray(vendorIds) ? vendorIds.filter(Boolean) : undefined;

  // Get models
  const { Invoice, Bill } = getBooksModels();
  const { Customer, Branch } = getBooksCrmModels();

  // Generate buckets
  const buckets = generateBuckets({
    numColumns: Number(numberOfColumns),
    columnType,
    duration: Number(duration),
    mode: 'upcoming',
  });

  // Build date range for queries
  const dateRange = {
    $gte: moment(startDate).toDate(),
    $lte: moment(endDate).toDate(),
  };

  // Build queries using helper
  const invoiceQuery = buildDocumentQuery(companyId, dateRange, normalizedBranchIds, 'branchId', includePartiallyPaid);

  if (normalizedCustomerIds && normalizedCustomerIds.length > 0) {
    invoiceQuery.customerId = {
      $in: normalizedCustomerIds.map(id => new mongoose.Types.ObjectId(id)),
    };
  }

  const billQuery = buildDocumentQuery(companyId, dateRange, normalizedBranchIds, 'branchId', includePartiallyPaid);

  if (normalizedVendorIds && normalizedVendorIds.length > 0) {
    billQuery.vendor = {
      $in: normalizedVendorIds.map(id => new mongoose.Types.ObjectId(id)),
    };
  }

  // Build sort object for documents (always sort by dueDate for consistent bucket assignment)
  const sortObj = { dueDate: 1 };

  try {
    // Optimized: Fetch invoices and bills in parallel (2 queries)
    const [invoices, bills] = await Promise.all([
      Invoice.find(invoiceQuery)
        .select('_id invoiceId invoiceDate customerId branchId total balanceAmount dueDate exchangeRate')
        .sort(sortObj)
        .lean()
        .exec(),
      Bill.find(billQuery)
        .select('_id billId billDate vendor branchId total balanceAmount dueDate exchangeRate')
        .sort(sortObj)
        .lean()
        .exec(),
    ]);

    // Extract unique IDs for population (optimized: single query per entity type)
    const customerIdSet = new Set();
    const branchIdSet = new Set();
    const vendorIdSet = new Set();

    invoices.forEach(inv => {
      if (inv.customerId) customerIdSet.add(inv.customerId.toString());
      if (inv.branchId) branchIdSet.add(inv.branchId.toString());
    });

    bills.forEach(bill => {
      if (bill.vendor) vendorIdSet.add(bill.vendor.toString());
      if (bill.branchId) branchIdSet.add(bill.branchId.toString());
    });

    // Fetch customer, vendor, and branch data in parallel (3 queries total = 5 queries reduced to 3)
    // Note: Vendors are stored in Customer model with Role.isVendor: true
    const [customers, vendors, branches] = await Promise.all([
      customerIdSet.size > 0
        ? Customer.find({ _id: { $in: Array.from(customerIdSet).map(id => new mongoose.Types.ObjectId(id)) } })
            .select('customerDisplayName _id')
            .lean()
            .exec()
        : [],
      vendorIdSet.size > 0
        ? Customer.find({ _id: { $in: Array.from(vendorIdSet).map(id => new mongoose.Types.ObjectId(id)) } })
            .select('customerDisplayName _id')
            .lean()
            .exec()
        : [],
      branchIdSet.size > 0
        ? Branch.find({ _id: { $in: Array.from(branchIdSet).map(id => new mongoose.Types.ObjectId(id)) } })
            .select('name _id')
            .lean()
            .exec()
        : [],
    ]);

    // Create maps for quick lookup
    const customerMap = new Map(customers.map(c => [c._id.toString(), c.customerDisplayName || 'Unknown']));
    const vendorMap = new Map(vendors.map(v => [v._id.toString(), v.customerDisplayName || 'Unknown']));
    const branchMap = new Map(branches.map(b => [b._id.toString(), b.name || 'Unknown']));

    // Track total documents to enforce limit
    let totalDocumentsProcessed = 0;

    // Process invoices (receivables) with pagination limit
    if (Array.isArray(invoices)) {
      for (const invoice of invoices) {
        if (totalDocumentsProcessed >= MAX_TOTAL_DOCUMENTS) break;

        const formattedDoc = formatDocumentForBucket(invoice, 'receivable', customerMap, vendorMap, branchMap);
        if (!formattedDoc) continue;

        const daysUntilDue = formattedDoc.daysUntilDue;
        const bucketIndex = assignToUpcomingBucket(daysUntilDue, buckets);
        const bucket = buckets[bucketIndex];

        // Limit documents per bucket
        if (bucket.receivables.length < MAX_DOCUMENTS_PER_BUCKET) {
          bucket.receivables.push(formattedDoc);
          bucket.receivableAmount += formattedDoc.balanceAmount;
          bucket.count += 1;
          bucket.isEmpty = false;
          totalDocumentsProcessed += 1;
        }
      }
    }

    // Process bills (payables) with pagination limit
    if (Array.isArray(bills)) {
      for (const bill of bills) {
        if (totalDocumentsProcessed >= MAX_TOTAL_DOCUMENTS) break;

        const formattedDoc = formatDocumentForBucket(bill, 'payable', customerMap, vendorMap, branchMap);
        if (!formattedDoc) continue;

        const daysUntilDue = formattedDoc.daysUntilDue;
        const bucketIndex = assignToUpcomingBucket(daysUntilDue, buckets);
        const bucket = buckets[bucketIndex];

        // Limit documents per bucket
        if (bucket.payables.length < MAX_DOCUMENTS_PER_BUCKET) {
          bucket.payables.push(formattedDoc);
          bucket.payableAmount += formattedDoc.balanceAmount;
          bucket.count += 1;
          bucket.isEmpty = false;
          totalDocumentsProcessed += 1;
        }
      }
    }

    // Calculate summary totals
    const totalAmount = buckets.reduce((sum, bucket) => sum + bucket.receivableAmount + bucket.payableAmount, 0);
    const totalDocuments = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

    // Format buckets for response (convert Infinity to null, format currency, add metadata)
    let formattedBuckets = buckets.map(bucket => {
      // Format currency amounts to 2 decimals
      const receivableAmount = parseFloat(bucket.receivableAmount.toFixed(2));
      const payableAmount = parseFloat(bucket.payableAmount.toFixed(2));
      const receivablesCount = bucket.receivables ? bucket.receivables.length : 0;
      const payablesCount = bucket.payables ? bucket.payables.length : 0;

      return {
        label: bucket.label,
        minDays: bucket.minDays,
        maxDays: bucket.maxDays === Infinity ? null : bucket.maxDays,
        isOpenEnded: bucket.isOpenEnded || false,
        receivableAmount,
        payableAmount,
        count: bucket.count,
        receivables: bucket.receivables,
        payables: bucket.payables,
        receivablesCount,
        payablesCount,
        isEmpty: bucket.isEmpty || (receivableAmount === 0 && payableAmount === 0),
        startDate: bucket.startDate,
        endDate: bucket.endDate,
      };
    });

    if (bucketSortField) {
      formattedBuckets.sort((a, b) => {
        let aValue, bValue;

        switch (bucketSortField) {
          case 'receivableAmount':
            aValue = a.receivableAmount || 0;
            bValue = b.receivableAmount || 0;
            break;
          case 'payableAmount':
            aValue = a.payableAmount || 0;
            bValue = b.payableAmount || 0;
            break;
          case 'count':
            aValue = a.count || 0;
            bValue = b.count || 0;
            break;
          case 'receivablesCount':
            aValue = a.receivablesCount || 0;
            bValue = b.receivablesCount || 0;
            break;
          case 'payablesCount':
            aValue = a.payablesCount || 0;
            bValue = b.payablesCount || 0;
            break;
          default:
            return 0;
        }

        // Handle numeric comparison
        if (typeof aValue === 'number' && typeof bValue === 'number') {
          const diff = aValue - bValue;
          return bucketSortOrder === 'asc' ? diff : -diff;
        }

        // Fallback to string comparison
        const aStr = String(aValue || '');
        const bStr = String(bValue || '');
        const comparison = aStr.localeCompare(bStr);
        return bucketSortOrder === 'asc' ? comparison : -comparison;
      });
    }

    return {
      summary: {
        totalAmount: parseFloat(totalAmount.toFixed(2)),
        totalDocuments,
        bucketConfig: {
          numberOfColumns: Number(numberOfColumns),
          columnType,
          duration: Number(duration),
        },
      },
      buckets: formattedBuckets,
    };
  } catch (error) {
    // Re-throw ApiError as-is
    if (error instanceof ApiError) {
      throw error;
    }

    // Wrap other errors with context
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, `Error fetching upcoming payments: ${error.message}`);
  }
};

const calculateAgeDays = (date, currentDate = new Date()) => {
  if (!date) return 0;
  return Math.max(0, moment(currentDate).diff(moment(date), 'days'));
};

const getDynamicBucket = (ageDays, buckets) => {
  for (const bucket of buckets) {
    if (ageDays >= bucket.minDays && (bucket.maxDays === Infinity || ageDays <= bucket.maxDays)) {
      return bucket;
    }
  }
  return buckets[buckets.length - 1];
};

const calculateOutstanding = (documents, payments, type) => {
  const paidAmountMap = {};
  const paymentItemKey = type === 'customer' ? 'invoices' : 'bills';
  const docIdKey = type === 'customer' ? 'invoiceId' : 'billId';

  for (const payment of payments) {
    const exchangeRate = payment.exchangeRate ?? 1;
    const paymentItems = payment[paymentItemKey] || [];
    for (const item of paymentItems) {
      const docId = item[docIdKey]?.toString();
      if (docId) {
        paidAmountMap[docId] = (paidAmountMap[docId] || 0) + (item.amountApplied || 0) * exchangeRate;
      }
    }
  }

  const completed = [];
  const outstanding = [];

  for (const doc of documents) {
    const docId = doc._id.toString();
    const totalAmount = parseFloat(doc.total || 0) * (doc.exchangeRate ?? 1);
    const paidAmount = paidAmountMap[docId] || 0;
    const balanceAmount = totalAmount - paidAmount;

    const docData = {
      ...(doc.toObject ? doc.toObject() : doc),
      totalAmount,
      paidAmount,
      balanceAmount,
    };

    if (balanceAmount === 0) {
      completed.push(docData);
    } else if (balanceAmount > 0) {
      outstanding.push(docData);
    }
  }

  return { completed, outstanding };
};

const formatAgingResponse = (data, type, numberOfColumns, columnType, duration, dateRange) => {
  const { summary, agingBuckets, details } = data;
  return {
    reportType: type,
    dateRange: dateRange
      ? {
          startDate: moment(dateRange.startDate).format('YYYY-MM-DD'),
          endDate: moment(dateRange.endDate).format('YYYY-MM-DD'),
        }
      : null,
    numberOfColumns,
    columnType,
    duration,
    summary: {
      totalOutstanding: summary.totalOutstanding || 0,
      totalCompleted: summary.totalCompleted || 0,
      totalDocuments: summary.totalDocuments || 0,
      totalEntities: summary.totalEntities || 0,
    },
    agingBuckets: agingBuckets || [],
    details: details || [],
  };
};

const buildEntityQueryFilter = (entityIds, companyId, type, branchId = null, divisionId = null) => {
  const filter = {
    _id: { $in: entityIds.map(id => new mongoose.Types.ObjectId(id)) },
    companyId: new mongoose.Types.ObjectId(companyId),
    [type === 'vendor' ? 'Role.isVendor' : 'Role.isCustomer']: true,
  };

  // Convert branchId and divisionId to arrays
  const branchIdArray = branchId
    ? Array.isArray(branchId)
      ? branchId.map(id => new mongoose.Types.ObjectId(id))
      : branchId.split(',').map(id => new mongoose.Types.ObjectId(id.trim()))
    : [];

  const divisionIdArray = divisionId
    ? Array.isArray(divisionId)
      ? divisionId.map(id => new mongoose.Types.ObjectId(id))
      : divisionId.split(',').map(id => new mongoose.Types.ObjectId(id.trim()))
    : [];

  // If both branchId and divisionId are provided, use $elemMatch to find customers with matching branch entry
  if (branchIdArray.length > 0 && divisionIdArray.length > 0) {
    filter.branch = {
      $elemMatch: {
        branchId: { $in: branchIdArray },
        divisionId: { $in: divisionIdArray },
      },
    };
  } else if (branchIdArray.length > 0) {
    // Only branchId provided - check if customer has this branchId in branch array
    filter['branch.branchId'] = { $in: branchIdArray };
  } else if (divisionIdArray.length > 0) {
    // Only divisionId provided - check if customer has this divisionId in branch array
    filter['branch.divisionId'] = { $in: divisionIdArray };
  }

  return filter;
};

const normalizeEntityDetails = entity => {
  return {
    ...entity,
    name: entity.customerDisplayName || entity.companyName || 'Unknown',
    email: entity.bpEmail || '',
    phone: entity.customerPhoneNumber || '',
  };
};

const createDocumentItem = (doc, bucket, ageDays, type) => {
  const docDate = doc.invoiceDate || doc.billDate;
  const docNo = doc.invoiceId || doc.billId || 'N/A';
  const balanceAmount = doc.balanceAmount || 0;
  const totalAmount = doc.totalAmount || 0;

  return {
    documentId: doc._id.toString(),
    documentNo: docNo,
    documentDate: moment(docDate).format('YYYY-MM-DD'),
    dueDate: doc.dueDate ? moment(doc.dueDate).format('YYYY-MM-DD') : null,
    totalAmount,
    paidAmount: doc.paidAmount || 0,
    balanceAmount,
    ageDays,
    bucket: bucket.bucket,
    bucketLabel: bucket.label,
    status: balanceAmount === 0 ? 'paid' : balanceAmount >= totalAmount ? 'unpaid' : 'partially_paid',
  };
};

const getAgingReport = async filter => {
  const { type, startDate, endDate, numberOfColumns, columnType, duration, companyId, entityIds, divisionId, branchId, sortBy } =
    filter;

  if (type !== 'customer' && type !== 'vendor') {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid type: ${type}. Must be 'customer' or 'vendor'`);
  }

  const { Invoice, Bill, PaymentMade } = getBooksModels();
  const booksCrmModels = getBooksCrmModels();

  if (!booksCrmModels?.Customer) {
    const availableModels = Object.keys(booksCrmModels || {}).join(', ') || 'none';
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      `Customer model is not available from getBooksCrmModels(). Available models: ${availableModels}`,
    );
  }

  const Customer = booksCrmModels.Customer;
  const PaymentReceived = booksCrmModels.PaymentReceived;

  if (typeof Customer.find !== 'function') {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Customer model is not a valid Mongoose model (missing find method)');
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const today = moment().startOf('day');
  const hasDateFilter = startDate && endDate && moment(startDate).isValid() && moment(endDate).isValid();

  let start;
  let end;
  if (hasDateFilter) {
    const startMoment = moment(startDate).startOf('day');
    const endMoment = moment(endDate).endOf('day');
    if (startMoment.isAfter(today, 'day')) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Start date cannot be a future date');
    }
    if (endMoment.isAfter(today, 'day')) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'End date cannot be a future date');
    }
    start = startMoment.toDate();
    end = endMoment.toDate();
  }

  const dynamicBuckets = generateBuckets({
    numColumns: numberOfColumns,
    columnType,
    duration,
    mode: 'aging',
  });

  const queryFilter = {
    companyId: companyObjectId,
    status: { $nin: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.DRAFT] },
  };

  const entityIdArray = entityIds
    ? Array.isArray(entityIds)
      ? entityIds.map(id => new mongoose.Types.ObjectId(id))
      : entityIds.split(',').map(id => new mongoose.Types.ObjectId(id.trim()))
    : [];

  // Handle branchId filter - apply to database query for Invoice/Bill
  // Step 1: First filter by branch to get all invoices/bills for that branch
  // Step 2: Then filter by customer/vendor if provided
  if (branchId) {
    const branchIdArray = Array.isArray(branchId)
      ? branchId.filter(Boolean).map(id => new mongoose.Types.ObjectId(id))
      : branchId
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id));
    if (branchIdArray.length > 0) {
      queryFilter.branchId = { $in: branchIdArray };
    }
  }

  // Handle divisionId filter - apply to database query for Invoice/Bill
  if (divisionId) {
    const divisionIdArray = Array.isArray(divisionId)
      ? divisionId.filter(Boolean).map(id => new mongoose.Types.ObjectId(id))
      : divisionId
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id));
    if (divisionIdArray.length > 0) {
      queryFilter.divisionId = { $in: divisionIdArray };
    }
  }

  const entityField = type === 'customer' ? 'customerId' : 'vendor';
  const dateField = type === 'customer' ? 'invoiceDate' : 'billDate';
  const DocumentModel = type === 'customer' ? Invoice : Bill;
  const PaymentModel = type === 'customer' ? PaymentReceived : PaymentMade;
  const paymentItemField = type === 'customer' ? 'invoices.invoiceId' : 'bills.billId';
  const docIdField = type === 'customer' ? 'invoiceId' : 'billId';

  if (hasDateFilter) {
    queryFilter[dateField] = { $gte: start, $lte: end };
  }

  // Step 2: Filter by customer/vendor if provided (applied after branch filter)
  if (entityIdArray.length > 0) {
    queryFilter[entityField] = { $in: entityIdArray };
  }

  applySplitFilter(queryFilter, filter);

  const documents = await DocumentModel.find(queryFilter).lean();

  const docIds = documents.map(doc => doc._id);

  const paymentFilter = {
    companyId: companyObjectId,
    [paymentItemField]: { $in: docIds },
    status: PAYMENT_STATUS.APPROVED,
  };
  applySplitFilter(paymentFilter, filter);

  const payments = docIds.length > 0 ? await PaymentModel.find(paymentFilter).lean() : [];

  const { completed, outstanding } = calculateOutstanding(documents, payments, type);
  const totalCompleted = completed.length;
  const totalDocuments = documents.length;

  if (completed.length === 0) {
    return formatAgingResponse(
      {
        summary: {
          totalOutstanding: 0,
          totalCompleted: 0,
          totalDocuments: 0,
          totalEntities: 0,
        },
        agingBuckets: dynamicBuckets.map(b => ({
          bucket: b.bucket,
          label: b.label,
          minDays: b.minDays,
          maxDays: b.maxDays === Infinity ? null : b.maxDays,
          amount: 0,
          count: 0,
          percentage: 0,
          documents: [],
        })),
        details: [],
      },
      type,
      numberOfColumns,
      columnType,
      duration,
      hasDateFilter ? { startDate, endDate } : null,
    );
  }

  const completedEntityIds = [
    ...new Set(
      completed
        .map(doc => doc[entityField])
        .filter(id => id != null)
        .map(id => id.toString()),
    ),
  ];

  const entityDetailsMap = {};
  if (completedEntityIds.length > 0) {
    const entityQueryFilter = buildEntityQueryFilter(completedEntityIds, companyId, type, branchId, divisionId);
    const entities = await Customer.find(entityQueryFilter)
      .select('_id customerDisplayName bpEmail customerPhoneNumber companyName')
      .lean();

    for (const entity of entities) {
      entityDetailsMap[entity._id.toString()] = normalizeEntityDetails(entity);
    }
  }

  const completedCountByEntity = {};
  for (const doc of completed) {
    const entityId = doc[entityField]?.toString();
    if (entityId) {
      completedCountByEntity[entityId] = (completedCountByEntity[entityId] || 0) + 1;
    }
  }

  const entityMap = {};
  const paymentItemKey = type === 'customer' ? 'invoices' : 'bills';

  for (const doc of completed) {
    const entityId = doc[entityField]?.toString();
    if (!entityId) continue;

    const docId = doc._id.toString();
    let paymentDate = null;

    const docPayments = payments
      .filter(p => {
        if (p.status !== PAYMENT_STATUS.APPROVED) return false;
        const items = p[paymentItemKey] || [];
        return items.some(item => item[docIdField]?.toString() === docId);
      })
      .sort((a, b) => new Date(a.paymentDate) - new Date(b.paymentDate));

    let cumulativeAmount = 0;
    for (const payment of docPayments) {
      const item = payment[paymentItemKey]?.find(i => i[docIdField]?.toString() === docId);
      if (item) {
        cumulativeAmount += (item.amountApplied || 0) * (payment.exchangeRate ?? 1);
        if (cumulativeAmount >= doc.totalAmount) {
          paymentDate = payment.paymentDate;
          break;
        }
      }
    }
    let ageDays = 0;
    if (paymentDate) {
      const referenceDate = doc.invoiceDate || doc.billDate;
      if (referenceDate) {
        ageDays = Math.max(0, moment(paymentDate).diff(moment(referenceDate), 'days'));
      }
    }

    const bucket = getDynamicBucket(ageDays, dynamicBuckets);
    const documentItem = createDocumentItem(doc, bucket, ageDays, type);

    if (!entityMap[entityId]) {
      const entityDetails = entityDetailsMap[entityId] || {};
      entityMap[entityId] = {
        entityId,
        entityName: entityDetails.name || 'Unknown',
        entityType: type,
        contactEmail: entityDetails.email || '',
        contactPhone: entityDetails.phone || '',
        totalOutstanding: 0,
        completedCount: completedCountByEntity[entityId] || 0,
        oldestInvoiceDate: doc.invoiceDate || doc.billDate,
        items: [],
      };
    }

    entityMap[entityId].totalOutstanding += doc.totalAmount;
    entityMap[entityId].items.push(documentItem);

    const docDate = doc.invoiceDate || doc.billDate;
    if (new Date(docDate) < new Date(entityMap[entityId].oldestInvoiceDate)) {
      entityMap[entityId].oldestInvoiceDate = docDate;
    }

    bucket.amount += doc.totalAmount;
    bucket.count += 1;
    bucket.documents.push({
      ...documentItem,
      entityId,
      entityName: entityMap[entityId].entityName,
      entityType: type,
    });
  }

  let details = Object.values(entityMap).map(entity => ({
    ...entity,
    oldestInvoiceDate: entity.oldestInvoiceDate ? moment(entity.oldestInvoiceDate).format('YYYY-MM-DD') : null,
  }));

  if (sortBy) {
    const sortParts = sortBy.split(':');
    if (sortParts.length === 2) {
      const [sortField, sortDirection] = sortParts;
      const isAscending = sortDirection === 'asc';

      if (sortField === 'completedCount' || sortField === 'totalOutstanding') {
        details.sort((a, b) => {
          const aValue = a[sortField] || 0;
          const bValue = b[sortField] || 0;
          return isAscending ? aValue - bValue : bValue - aValue;
        });
      } else if (sortField.startsWith('bucket_')) {
        const bucketIndex = parseInt(sortField.replace('bucket_', ''), 10);
        if (!isNaN(bucketIndex) && bucketIndex >= 0 && bucketIndex < dynamicBuckets.length) {
          const targetBucket = dynamicBuckets[bucketIndex];
          const bucketLabel = targetBucket.label;
          const bucketStr = targetBucket.bucket;

          details.sort((a, b) => {
            const aBucketAmount =
              a.items && Array.isArray(a.items)
                ? a.items
                    .filter(item => item.bucket === bucketStr || item.bucketLabel === bucketLabel)
                    .reduce((sum, item) => sum + (item.totalAmount || 0), 0)
                : 0;

            const bBucketAmount =
              b.items && Array.isArray(b.items)
                ? b.items
                    .filter(item => item.bucket === bucketStr || item.bucketLabel === bucketLabel)
                    .reduce((sum, item) => sum + (item.totalAmount || 0), 0)
                : 0;

            return isAscending ? aBucketAmount - bBucketAmount : bBucketAmount - aBucketAmount;
          });
        }
      }
    }
  }

  const totalOutstanding = completed.reduce((sum, doc) => sum + doc.totalAmount, 0);
  const totalEntities = details.length;

  const agingBuckets = dynamicBuckets.map(bucket => ({
    bucket: bucket.bucket,
    label: bucket.label,
    minDays: bucket.minDays,
    maxDays: bucket.maxDays === Infinity ? null : bucket.maxDays,
    amount: bucket.amount,
    count: bucket.count,
    percentage: totalOutstanding > 0 ? Number(((bucket.amount / totalOutstanding) * 100).toFixed(2)) : 0,
    documents: bucket.documents || [],
  }));

  return formatAgingResponse(
    {
      summary: {
        totalOutstanding,
        totalCompleted,
        totalDocuments,
        totalEntities,
      },
      agingBuckets,
      details,
    },
    type,
    numberOfColumns,
    columnType,
    duration,
    hasDateFilter ? { startDate, endDate } : null,
  );
};

const getCustomerAging = async filter => {
  return getAgingReport({
    ...filter,
    type: 'customer',
    entityIds: filter.customerIds,
    divisionId: filter.divisionId,
    branchId: filter.branchId,
  });
};

const getVendorAging = async filter => {
  return getAgingReport({
    ...filter,
    type: 'vendor',
    entityIds: filter.vendorIds,
    divisionId: filter.divisionId,
    branchId: filter.branchId,
  });
};

const getCustomerAgingDetails = async (customerId, filter) => {
  const { companyId, startDate, endDate } = filter;
  const { Invoice } = getBooksModels();
  const booksCrmModels = getBooksCrmModels();
  const Customer = booksCrmModels.Customer;
  const PaymentReceived = booksCrmModels.PaymentReceived;

  if (!Customer || !PaymentReceived) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Required models (Customer, PaymentReceived) are not available');
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const customerObjectId = new mongoose.Types.ObjectId(customerId);
  const today = moment().startOf('day');
  const startMoment = moment(startDate).startOf('day');
  const endMoment = moment(endDate).endOf('day');

  if (startMoment.isAfter(today, 'day')) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Start date cannot be a future date');
  }
  if (endMoment.isAfter(today, 'day')) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'End date cannot be a future date');
  }

  const start = startMoment.toDate();
  const end = endMoment.toDate();
  const currentDate = today.toDate();

  const customer = await Customer.findOne({
    _id: customerObjectId,
    companyId: companyObjectId,
    'Role.isCustomer': true,
  })
    .select('_id customerDisplayName bpEmail customerPhoneNumber companyName')
    .lean();

  if (!customer) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Customer not found');
  }

  const customerDetails = normalizeEntityDetails(customer);

  const invoiceQuery = {
    companyId: companyObjectId,
    customerId: customerObjectId,
    invoiceDate: { $gte: start, $lte: end },
    status: { $nin: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.DRAFT] },
  };
  applySplitFilter(invoiceQuery, filter);

  const invoices = await Invoice.find(invoiceQuery).lean();

  const invoiceIds = invoices.map(inv => inv._id);

  const paymentQuery = {
    companyId: companyObjectId,
    customerId: customerObjectId,
    'invoices.invoiceId': { $in: invoiceIds },
    status: PAYMENT_STATUS.APPROVED,
  };
  applySplitFilter(paymentQuery, filter);

  const payments = invoiceIds.length > 0 ? await PaymentReceived.find(paymentQuery).lean() : [];

  const paidAmountMap = {};
  for (const payment of payments) {
    const paymentRate = payment.exchangeRate ?? 1;
    const paymentInvoices = payment.invoices || [];
    for (const item of paymentInvoices) {
      const invId = item.invoiceId?.toString();
      if (invId && invoiceIds.some(id => id.toString() === invId)) {
        paidAmountMap[invId] = (paidAmountMap[invId] || 0) + (item.amountApplied || 0) * paymentRate;
      }
    }
  }

  const invoiceList = invoices.map(inv => {
    const invId = inv._id.toString();
    const totalAmount = parseFloat(inv.total || 0) * (inv.exchangeRate ?? 1);
    const paidAmount = paidAmountMap[invId] || 0;
    const balanceAmount = totalAmount - paidAmount;
    const ageDays = calculateAgeDays(inv.invoiceDate, currentDate);

    return {
      invoiceId: invId,
      invoiceNo: inv.invoiceId || 'N/A',
      invoiceDate: moment(inv.invoiceDate).format('YYYY-MM-DD'),
      dueDate: inv.dueDate ? moment(inv.dueDate).format('YYYY-MM-DD') : null,
      total: totalAmount,
      paidAmount,
      balanceAmount,
      ageDays,
      status: balanceAmount === 0 ? 'paid' : balanceAmount >= totalAmount ? 'unpaid' : 'partially_paid',
    };
  });

  const paymentList = payments.map(payment => ({
    paymentReceivedId: payment.paymentReceivedId || payment._id.toString(),
    paymentDate: moment(payment.paymentDate).format('YYYY-MM-DD'),
    paymentMode: payment.paymentMode,
    amountReceived: parseFloat(payment.amountReceived || 0) * (payment.exchangeRate ?? 1),
    invoices: (payment.invoices || [])
      .map(item => ({
        invoiceId: item.invoiceId?.toString(),
        invoiceNo: item.invoiceNo || 'N/A',
        amountApplied: parseFloat(item.amountApplied || 0) * (payment.exchangeRate ?? 1),
        appliedDate: item.appliedDate ? moment(item.appliedDate).format('YYYY-MM-DD') : null,
      }))
      .filter(item => invoiceIds.some(id => id.toString() === item.invoiceId)),
  }));

  const totalOutstanding = invoiceList.reduce((sum, inv) => sum + inv.balanceAmount, 0);
  const defaultBuckets = generateBuckets({
    numColumns: 5,
    columnType: 'days',
    duration: 30,
    mode: 'aging',
  });
  const agingBreakdown = defaultBuckets.map(bucket => ({
    bucket: bucket.bucket,
    label: bucket.label,
    minDays: bucket.minDays,
    maxDays: bucket.maxDays === Infinity ? null : bucket.maxDays,
    count: 0,
    amount: 0,
  }));

  for (const inv of invoiceList) {
    if (inv.balanceAmount > 0) {
      const bucket = getDynamicBucket(inv.ageDays, defaultBuckets);
      const breakdownBucket = agingBreakdown.find(b => b.bucket === bucket.bucket);
      if (breakdownBucket) {
        breakdownBucket.count += 1;
        breakdownBucket.amount += inv.balanceAmount;
      }
    }
  }

  return {
    customer: {
      customerId: customerDetails._id.toString(),
      customerName: customerDetails.name,
      contactEmail: customerDetails.email,
      contactPhone: customerDetails.phone,
      totalOutstanding,
    },
    invoices: invoiceList,
    payments: paymentList,
    agingBreakdown,
    dateRange: {
      startDate: moment(startDate).format('YYYY-MM-DD'),
      endDate: moment(endDate).format('YYYY-MM-DD'),
    },
  };
};

const getVendorAgingDetails = async (vendorId, filter) => {
  const { companyId, startDate, endDate } = filter;
  const { Bill, PaymentMade } = getBooksModels();
  const booksCrmModels = getBooksCrmModels();
  const Customer = booksCrmModels.Customer;

  if (!Customer || !PaymentMade) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Required models (Customer, PaymentMade) are not available');
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const vendorObjectId = new mongoose.Types.ObjectId(vendorId);
  const today = moment().startOf('day');
  const startMoment = moment(startDate).startOf('day');
  const endMoment = moment(endDate).endOf('day');

  if (startMoment.isAfter(today, 'day')) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Start date cannot be a future date');
  }
  if (endMoment.isAfter(today, 'day')) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'End date cannot be a future date');
  }

  const start = startMoment.toDate();
  const end = endMoment.toDate();
  const currentDate = today.toDate();

  const vendor = await Customer.findOne({
    _id: vendorObjectId,
    companyId: companyObjectId,
    'Role.isVendor': true,
  })
    .select('_id customerDisplayName bpEmail customerPhoneNumber companyName')
    .lean();

  if (!vendor) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Vendor not found');
  }

  const vendorDetails = normalizeEntityDetails(vendor);

  const billQuery = {
    companyId: companyObjectId,
    vendor: vendorObjectId,
    billDate: { $gte: start, $lte: end },
    status: { $nin: [BILL_STATUSES.CANCELLED, BILL_STATUSES.DRAFT] },
  };
  applySplitFilter(billQuery, filter);

  const bills = await Bill.find(billQuery).lean();

  const billIds = bills.map(bill => bill._id);

  const paymentQuery = {
    companyId: companyObjectId,
    vendorId: vendorObjectId,
    'bills.billId': { $in: billIds },
    status: PAYMENT_STATUS.APPROVED,
  };
  applySplitFilter(paymentQuery, filter);

  const payments = billIds.length > 0 ? await PaymentMade.find(paymentQuery).lean() : [];

  const paidAmountMap = {};
  for (const payment of payments) {
    const paymentRate = payment.exchangeRate ?? 1;
    const paymentBills = payment.bills || [];
    for (const item of paymentBills) {
      const billId = item.billId?.toString();
      if (billId && billIds.some(id => id.toString() === billId)) {
        paidAmountMap[billId] = (paidAmountMap[billId] || 0) + (item.amountApplied || 0) * paymentRate;
      }
    }
  }

  const billList = bills.map(bill => {
    const billId = bill._id.toString();
    const totalAmount = parseFloat(bill.total || 0) * (bill.exchangeRate ?? 1);
    const paidAmount = paidAmountMap[billId] || 0;
    const balanceAmount = totalAmount - paidAmount;
    const ageDays = calculateAgeDays(bill.billDate, currentDate);

    return {
      billId,
      billNo: bill.billId || 'N/A',
      billDate: moment(bill.billDate).format('YYYY-MM-DD'),
      dueDate: bill.dueDate ? moment(bill.dueDate).format('YYYY-MM-DD') : null,
      total: totalAmount,
      paidAmount,
      balanceAmount,
      ageDays,
      status: balanceAmount === 0 ? 'paid' : balanceAmount >= totalAmount ? 'unpaid' : 'partially_paid',
    };
  });

  const paymentList = payments.map(payment => ({
    paymentMadeId: payment.paymentMadeId || payment._id.toString(),
    paymentDate: moment(payment.paymentDate).format('YYYY-MM-DD'),
    paymentMode: payment.paymentMode,
    paymentMade: parseFloat(payment.paymentMade || 0) * (payment.exchangeRate ?? 1),
    bills: (payment.bills || [])
      .map(item => ({
        billId: item.billId?.toString(),
        billNo: item.billNo || 'N/A',
        amountApplied: parseFloat(item.amountApplied || 0) * (payment.exchangeRate ?? 1),
      }))
      .filter(item => billIds.some(id => id.toString() === item.billId)),
  }));

  const totalOutstanding = billList.reduce((sum, bill) => sum + bill.balanceAmount, 0);
  const defaultBuckets = generateBuckets({
    numColumns: 5,
    columnType: 'days',
    duration: 30,
    mode: 'aging',
  });
  const agingBreakdown = defaultBuckets.map(bucket => ({
    bucket: bucket.bucket,
    label: bucket.label,
    minDays: bucket.minDays,
    maxDays: bucket.maxDays === Infinity ? null : bucket.maxDays,
    count: 0,
    amount: 0,
  }));

  for (const bill of billList) {
    if (bill.balanceAmount > 0) {
      const bucket = getDynamicBucket(bill.ageDays, defaultBuckets);
      const breakdownBucket = agingBreakdown.find(b => b.bucket === bucket.bucket);
      if (breakdownBucket) {
        breakdownBucket.count += 1;
        breakdownBucket.amount += bill.balanceAmount;
      }
    }
  }

  return {
    vendor: {
      vendorId: vendorDetails._id.toString(),
      vendorName: vendorDetails.name,
      contactEmail: vendorDetails.email,
      contactPhone: vendorDetails.phone,
      totalOutstanding,
    },
    bills: billList,
    payments: paymentList,
    agingBreakdown,
    dateRange: {
      startDate: moment(startDate).format('YYYY-MM-DD'),
      endDate: moment(endDate).format('YYYY-MM-DD'),
    },
  };
};

const getCustomerAgingBucket = async filter => {
  const { companyId, startDate, endDate, minDays, maxDays, customerIds, branchId } = filter;
  const { Invoice } = getBooksModels();
  const booksCrmModels = getBooksCrmModels();
  const Customer = booksCrmModels.Customer;
  const PaymentReceived = booksCrmModels.PaymentReceived;

  if (!Customer || !PaymentReceived) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Required models (Customer, PaymentReceived) are not available');
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const today = moment().startOf('day');
  const hasDateFilter = startDate && endDate && moment(startDate).isValid() && moment(endDate).isValid();

  let start;
  let end;
  if (hasDateFilter) {
    const startMoment = moment(startDate).startOf('day');
    const endMoment = moment(endDate).endOf('day');
    if (startMoment.isAfter(today, 'day')) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Start date cannot be a future date');
    }
    if (endMoment.isAfter(today, 'day')) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'End date cannot be a future date');
    }
    start = startMoment.toDate();
    end = endMoment.toDate();
  }

  const queryFilter = {
    companyId: companyObjectId,
    status: { $nin: [INVOICE_STATUS.CANCELLED, INVOICE_STATUS.DRAFT] },
    balanceAmount: 0,
  };
  if (hasDateFilter) {
    queryFilter.invoiceDate = { $gte: start, $lte: end };
  }

  if (customerIds) {
    const customerIdArray = Array.isArray(customerIds)
      ? customerIds.map(id => new mongoose.Types.ObjectId(id))
      : [new mongoose.Types.ObjectId(customerIds)];
    queryFilter.customerId = { $in: customerIdArray };
  }

  if (branchId) {
    const branchIdArray = Array.isArray(branchId)
      ? branchId.filter(Boolean).map(id => new mongoose.Types.ObjectId(id))
      : branchId
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id));
    if (branchIdArray.length > 0) {
      queryFilter.branchId = { $in: branchIdArray };
    }
  }

  applySplitFilter(queryFilter, filter);

  const invoices = await Invoice.find(queryFilter).lean();
  const invoiceIds = invoices.map(inv => inv._id);

  const paymentFilter = {
    companyId: companyObjectId,
    'invoices.invoiceId': { $in: invoiceIds },
    status: PAYMENT_STATUS.APPROVED,
  };
  applySplitFilter(paymentFilter, filter);

  const payments =
    invoiceIds.length > 0
      ? await PaymentReceived.find(paymentFilter).select('paymentDate invoices exchangeRate').sort({ paymentDate: 1 }).lean()
      : [];

  const invoiceList = [];
  for (const inv of invoices) {
    const invId = inv._id.toString();
    const totalAmount = parseFloat(inv.total || 0) * (inv.exchangeRate ?? 1);

    const invoicePayments = payments.filter(p => {
      const paymentInvoices = p.invoices || [];
      return paymentInvoices.some(item => item.invoiceId?.toString() === invId);
    });

    let paymentDate = null;
    let cumulativeAmount = 0;

    for (const payment of invoicePayments) {
      // Get all entries for this invoice inside the payment
      const invoiceEntries = payment.invoices?.filter(item => item.invoiceId?.toString() === invId) || [];

      // Sum amount applied in this payment for the invoice
      const paymentAmount =
        invoiceEntries.reduce((sum, item) => sum + (item.amountApplied || 0), 0) * (payment.exchangeRate ?? 1);

      if (paymentAmount > 0) {
        cumulativeAmount += paymentAmount;

        // If fully paid (including partial payments)
        if (cumulativeAmount >= totalAmount) {
          paymentDate = payment.paymentDate;
          break;
        }
      }
    }

    let ageDays = 0;
    if (paymentDate && inv.invoiceDate) {
      ageDays = Math.max(0, moment(paymentDate).diff(moment(inv.invoiceDate), 'days'));
    }

    const inRange = ageDays >= minDays && (maxDays === null || maxDays === undefined || ageDays <= maxDays);
    const fullyPaidByApproved = paymentDate !== null;

    if (inRange && fullyPaidByApproved) {
      invoiceList.push({
        customerId: inv.customerId?.toString(),
        invoiceId: invId,
        invoiceNo: inv.invoiceId || 'N/A',
        invoiceDate: moment(inv.invoiceDate).format('YYYY-MM-DD'),
        dueDate: inv.dueDate ? moment(inv.dueDate).format('YYYY-MM-DD') : null,
        paymentDate: paymentDate ? moment(paymentDate).format('YYYY-MM-DD') : null,
        total: totalAmount,
        paidAmount: totalAmount,
        balanceAmount: 0,
        ageDays,
        status: 'paid',
      });
    }
  }

  const uniqueCustomerIds = [...new Set(invoiceList.map(inv => inv.customerId).filter(Boolean))];
  const customerMap = {};

  if (uniqueCustomerIds.length > 0) {
    const customers = await Customer.find({
      _id: { $in: uniqueCustomerIds.map(id => new mongoose.Types.ObjectId(id)) },
      companyId: companyObjectId,
      'Role.isCustomer': true,
    })
      .select('_id customerDisplayName companyName')
      .lean();

    for (const customer of customers) {
      customerMap[customer._id.toString()] = normalizeEntityDetails(customer);
    }
  }

  const invoicesWithCustomerDetails = invoiceList.map(inv => ({
    ...inv,
    customerName: customerMap[inv.customerId]?.name || 'Unknown',
  }));

  invoicesWithCustomerDetails.sort((a, b) => b.ageDays - a.ageDays);

  const totalAmount = invoicesWithCustomerDetails.reduce((sum, inv) => sum + inv.total, 0);
  const count = invoicesWithCustomerDetails.length;

  let bucketLabel = '';
  if (maxDays === null || maxDays === undefined) {
    bucketLabel = `Greater than ${minDays} days`;
  } else if (minDays === maxDays) {
    bucketLabel = `${minDays} days`;
  } else {
    bucketLabel = `${minDays}-${maxDays} days`;
  }

  return {
    bucket: {
      minDays,
      maxDays: maxDays === null || maxDays === undefined ? null : maxDays,
      label: bucketLabel,
      totalAmount,
      count,
    },
    invoices: invoicesWithCustomerDetails,
    dateRange: hasDateFilter
      ? { startDate: moment(startDate).format('YYYY-MM-DD'), endDate: moment(endDate).format('YYYY-MM-DD') }
      : null,
  };
};

const getVendorAgingBucket = async filter => {
  const { companyId, startDate, endDate, minDays, maxDays, vendorIds, branchId } = filter;
  const { Bill, PaymentMade } = getBooksModels();
  const booksCrmModels = getBooksCrmModels();
  const Customer = booksCrmModels.Customer;

  if (!Customer || !PaymentMade) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Required models (Customer, PaymentMade) are not available');
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId);
  const today = moment().startOf('day');
  const hasDateFilter = startDate && endDate && moment(startDate).isValid() && moment(endDate).isValid();

  let start;
  let end;
  if (hasDateFilter) {
    const startMoment = moment(startDate).startOf('day');
    const endMoment = moment(endDate).endOf('day');
    if (startMoment.isAfter(today, 'day')) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Start date cannot be a future date');
    }
    if (endMoment.isAfter(today, 'day')) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'End date cannot be a future date');
    }
    start = startMoment.toDate();
    end = endMoment.toDate();
  }

  const queryFilter = {
    companyId: companyObjectId,
    status: { $nin: [BILL_STATUSES.CANCELLED, BILL_STATUSES.DRAFT] },
    balanceAmount: 0,
  };
  if (hasDateFilter) {
    queryFilter.billDate = { $gte: start, $lte: end };
  }

  if (vendorIds) {
    const vendorIdArray = Array.isArray(vendorIds)
      ? vendorIds.map(id => new mongoose.Types.ObjectId(id))
      : [new mongoose.Types.ObjectId(vendorIds)];
    queryFilter.vendor = { $in: vendorIdArray };
  }

  if (branchId) {
    const branchIdArray = Array.isArray(branchId)
      ? branchId.filter(Boolean).map(id => new mongoose.Types.ObjectId(id))
      : branchId
          .split(',')
          .map(id => id.trim())
          .filter(Boolean)
          .map(id => new mongoose.Types.ObjectId(id));
    if (branchIdArray.length > 0) {
      queryFilter.branchId = { $in: branchIdArray };
    }
  }

  applySplitFilter(queryFilter, filter);

  const bills = await Bill.find(queryFilter).lean();
  const billIds = bills.map(bill => bill._id);

  const paymentFilter = {
    companyId: companyObjectId,
    'bills.billId': { $in: billIds },
    status: PAYMENT_STATUS.APPROVED,
  };
  applySplitFilter(paymentFilter, filter);

  const payments =
    billIds.length > 0
      ? await PaymentMade.find(paymentFilter).select('paymentDate bills exchangeRate').sort({ paymentDate: 1 }).lean()
      : [];

  const billList = [];
  for (const bill of bills) {
    const billId = bill._id.toString();
    const totalAmount = parseFloat(bill.total || 0) * (bill.exchangeRate ?? 1);

    const billPayments = payments.filter(p => {
      const paymentBills = p.bills || [];
      return paymentBills.some(item => item.billId?.toString() === billId);
    });

    let paymentDate = null;
    let cumulativeAmount = 0;
    for (const payment of billPayments) {
      const billEntries = payment.bills?.filter(item => item.billId?.toString() === billId) || [];

      // Sum all applied amounts for this bill in this payment
      const paymentAmount = billEntries.reduce((sum, item) => sum + (item.amountApplied || 0), 0) * (payment.exchangeRate ?? 1);

      if (paymentAmount > 0) {
        cumulativeAmount += paymentAmount;

        if (cumulativeAmount >= totalAmount) {
          paymentDate = payment.paymentDate;
          break;
        }
      }
    }

    let ageDays = 0;
    if (paymentDate && bill.billDate) {
      ageDays = Math.max(0, moment(paymentDate).diff(moment(bill.billDate), 'days'));
    }

    const inRange = ageDays >= minDays && (maxDays === null || maxDays === undefined || ageDays <= maxDays);
    const fullyPaidByApproved = paymentDate !== null;

    if (inRange && fullyPaidByApproved) {
      billList.push({
        vendorId: bill.vendor?.toString(),
        billId,
        billNo: bill.billId || 'N/A',
        billDate: moment(bill.billDate).format('YYYY-MM-DD'),
        dueDate: bill.dueDate ? moment(bill.dueDate).format('YYYY-MM-DD') : null,
        paymentDate: paymentDate ? moment(paymentDate).format('YYYY-MM-DD') : null,
        total: totalAmount,
        paidAmount: totalAmount,
        balanceAmount: 0,
        ageDays,
        status: 'paid',
      });
    }
  }

  const uniqueVendorIds = [...new Set(billList.map(bill => bill.vendorId).filter(Boolean))];
  const vendorMap = {};

  if (uniqueVendorIds.length > 0) {
    const vendors = await Customer.find({
      _id: { $in: uniqueVendorIds.map(id => new mongoose.Types.ObjectId(id)) },
      companyId: companyObjectId,
      'Role.isVendor': true,
    })
      .select('_id customerDisplayName companyName')
      .lean();

    for (const vendor of vendors) {
      vendorMap[vendor._id.toString()] = normalizeEntityDetails(vendor);
    }
  }

  const billsWithVendorDetails = billList.map(bill => ({
    ...bill,
    vendorName: vendorMap[bill.vendorId]?.name || 'Unknown',
  }));

  billsWithVendorDetails.sort((a, b) => b.ageDays - a.ageDays);

  const totalAmount = billsWithVendorDetails.reduce((sum, bill) => sum + bill.total, 0);
  const count = billsWithVendorDetails.length;

  let bucketLabel = '';
  if (maxDays === null || maxDays === undefined) {
    bucketLabel = `Greater than ${minDays} days`;
  } else if (minDays === maxDays) {
    bucketLabel = `${minDays} days`;
  } else {
    bucketLabel = `${minDays}-${maxDays} days`;
  }

  return {
    bucket: {
      minDays,
      maxDays: maxDays === null || maxDays === undefined ? null : maxDays,
      label: bucketLabel,
      totalAmount,
      count,
    },
    bills: billsWithVendorDetails,
    dateRange: hasDateFilter
      ? { startDate: moment(startDate).format('YYYY-MM-DD'), endDate: moment(endDate).format('YYYY-MM-DD') }
      : null,
  };
};

module.exports = {
  getCustomerAging,
  getVendorAging,
  getCustomerAgingDetails,
  getVendorAgingDetails,
  getCustomerAgingBucket,
  getVendorAgingBucket,
  calculateAgeDays,
  generateBuckets,
  getDynamicBucket,
  calculateOutstanding,
  formatAgingResponse,
  calculateDaysUntilDue,
  assignToUpcomingBucket,
  getUpcomingPayments,
};
