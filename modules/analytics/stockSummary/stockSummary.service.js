const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { getBooksCrmModels } = require('../../../services/model.service');
const { SOURCE_DOCUMENTS } = require('../../../utils/enum');
const { resolveCompanyTimezone, toLocalDateBoundary, mongoDateParts } = require('../../../utils/companyTimezone');

const { ObjectId } = mongoose.Types;

const ITEM_NAME_COLLATION = { locale: 'en', strength: 2 };
const SPLIT_SOURCE_TYPES = Object.keys(SOURCE_DOCUMENTS).filter(key => key.startsWith('SPLIT_'));

const shouldExcludeSplitSources = isSplit => !(isSplit === true || isSplit === 'true');

const isNonSplitSourceExpr = fieldPath => ({
  $not: [{ $in: [{ $ifNull: [fieldPath, ''] }, SPLIT_SOURCE_TYPES] }],
});

function buildBaseMatch(filter) {
  const match = { companyId: new ObjectId(filter.companyId) };
  if (filter.branchId) match.branchId = new ObjectId(filter.branchId);
  if (filter.divisionId) match.divisionId = new ObjectId(filter.divisionId);
  if (filter.warehouseId) match.warehouseId = new ObjectId(filter.warehouseId);
  if (filter.itemId) match.itemId = new ObjectId(filter.itemId);
  return match;
}

async function resolveItemGroupFilter(filter) {
  if (!filter.itemGroupId) return null;
  const { Item } = getBooksCrmModels();
  const groupIds = filter.itemGroupId
    .split(',')
    .filter(Boolean)
    .map(id => new ObjectId(id));
  const items = await Item.find({ itemGroup: { $in: groupIds }, companyId: new ObjectId(filter.companyId) })
    .select('_id')
    .lean();
  return items.map(i => i._id);
}

function buildStockPipeline({ matchStage, startDate, endDate, excludeSplit = true }) {
  const inwardEligible = excludeSplit ? [isNonSplitSourceExpr('$sourceType')] : [];
  const deductionEligible = excludeSplit ? [isNonSplitSourceExpr('$$d.deductedSourceType')] : [];

  return [
    { $match: matchStage },
    {
      $addFields: {
        prePeriodInward: {
          $cond: [{ $and: [{ $lt: ['$createdAt', startDate] }, ...inwardEligible] }, '$quantity', 0],
        },
        periodInward: {
          $cond: [
            {
              $and: [{ $gte: ['$createdAt', startDate] }, { $lte: ['$createdAt', endDate] }, ...inwardEligible],
            },
            '$quantity',
            0,
          ],
        },
        prePeriodOutward: {
          $reduce: {
            input: {
              $filter: {
                input: '$deductions',
                as: 'd',
                cond: { $and: [{ $lt: ['$$d.deductedAt', startDate] }, ...deductionEligible] },
              },
            },
            initialValue: 0,
            in: { $add: ['$$value', '$$this.quantityDeducted'] },
          },
        },
        periodOutward: {
          $reduce: {
            input: {
              $filter: {
                input: '$deductions',
                as: 'd',
                cond: {
                  $and: [{ $gte: ['$$d.deductedAt', startDate] }, { $lte: ['$$d.deductedAt', endDate] }, ...deductionEligible],
                },
              },
            },
            initialValue: 0,
            in: { $add: ['$$value', '$$this.quantityDeducted'] },
          },
        },
      },
    },
    {
      $group: {
        _id: { itemId: '$itemId', warehouseId: '$warehouseId' },
        branchId: { $first: '$branchId' },
        divisionId: { $first: '$divisionId' },
        prePeriodInward: { $sum: '$prePeriodInward' },
        periodInward: { $sum: '$periodInward' },
        prePeriodOutward: { $sum: '$prePeriodOutward' },
        periodOutward: { $sum: '$periodOutward' },
      },
    },
    {
      $addFields: {
        openingQty: { $round: [{ $subtract: ['$prePeriodInward', '$prePeriodOutward'] }, 3] },
        inwardQty: { $round: ['$periodInward', 3] },
        outwardQty: { $round: ['$periodOutward', 3] },
        closingQty: {
          $round: [
            {
              $subtract: [
                { $add: [{ $subtract: ['$prePeriodInward', '$prePeriodOutward'] }, '$periodInward'] },
                '$periodOutward',
              ],
            },
            3,
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'items',
        localField: '_id.itemId',
        foreignField: '_id',
        as: 'item',
        pipeline: [{ $project: { itemName: 1, itemNo: 1, itemGroup: 1 } }],
      },
    },
    { $unwind: { path: '$item', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'warehouses',
        localField: '_id.warehouseId',
        foreignField: '_id',
        as: 'warehouse',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    { $unwind: { path: '$warehouse', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'iteminventories',
        localField: '_id.itemId',
        foreignField: 'itemId',
        as: 'itemInventory',
        pipeline: [{ $project: { minimumStockLevel: 1, maximumStockLevel: 1 } }],
      },
    },
    { $unwind: { path: '$itemInventory', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        stockStatus: {
          $switch: {
            branches: [
              {
                case: {
                  $and: [
                    { $gt: [{ $ifNull: ['$itemInventory.minimumStockLevel', 0] }, 0] },
                    { $lt: ['$closingQty', '$itemInventory.minimumStockLevel'] },
                  ],
                },
                then: 'BELOW_MINIMUM',
              },
              {
                case: {
                  $and: [
                    { $gt: [{ $ifNull: ['$itemInventory.maximumStockLevel', 0] }, 0] },
                    { $gt: ['$closingQty', '$itemInventory.maximumStockLevel'] },
                  ],
                },
                then: 'ABOVE_MAXIMUM',
              },
            ],
            default: 'NORMAL',
          },
        },
      },
    },
  ];
}

const getStockSummary = async (query, filter, options) => {
  const { ItemBatch } = getBooksCrmModels();

  const timezone = await resolveCompanyTimezone(filter.companyId);
  const startDate = toLocalDateBoundary(filter.fromDate, { timezone });
  const endDate = toLocalDateBoundary(filter.toDate, { endOfDay: true, timezone });
  const page = parseInt(options.page) || 1;
  const limit = parseInt(options.limit) || 15;
  const isPaginated = ![false, 'false'].includes(options.pagination);
  const search = query.search?.trim();

  const matchStage = buildBaseMatch(filter);

  const itemGroupItemIds = await resolveItemGroupFilter(filter);
  if (itemGroupItemIds) matchStage.itemId = { $in: itemGroupItemIds };

  const excludeSplit = shouldExcludeSplitSources(filter.isSplit);
  const pipeline = buildStockPipeline({ matchStage, startDate, endDate, excludeSplit });

  if (search) {
    pipeline.push({
      $match: {
        $or: [{ 'item.itemName': { $regex: search, $options: 'i' } }, { 'item.itemNo': { $regex: search, $options: 'i' } }],
      },
    });
  }

  if (filter.stockStatus) {
    pipeline.push({ $match: { stockStatus: filter.stockStatus } });
  }

  const projectStage = {
    $project: {
      _id: 0,
      itemId: '$_id.itemId',
      warehouseId: '$_id.warehouseId',
      itemName: '$item.itemName',
      itemNo: '$item.itemNo',
      warehouseName: '$warehouse.name',
      openingQty: 1,
      inwardQty: 1,
      outwardQty: 1,
      closingQty: 1,
      stockStatus: 1,
      minimumStockLevel: { $ifNull: ['$itemInventory.minimumStockLevel', 0] },
      maximumStockLevel: { $ifNull: ['$itemInventory.maximumStockLevel', 0] },
    },
  };

  const dataStages = isPaginated
    ? [{ $sort: { 'item.itemName': 1 } }, { $skip: (page - 1) * limit }, { $limit: limit }, projectStage]
    : [{ $sort: { 'item.itemName': 1 } }, projectStage];

  pipeline.push({
    $facet: {
      data: dataStages,
      kpis: [
        {
          $group: {
            _id: null,
            totalItems: { $sum: 1 },
            totalInward: { $sum: '$inwardQty' },
            totalOutward: { $sum: '$outwardQty' },
            netMovement: { $sum: { $subtract: ['$inwardQty', '$outwardQty'] } },
            lowStockCount: { $sum: { $cond: [{ $eq: ['$stockStatus', 'BELOW_MINIMUM'] }, 1, 0] } },
          },
        },
      ],
      total: [{ $count: 'count' }],
    },
  });

  const [result] = await ItemBatch.aggregate(pipeline).collation(ITEM_NAME_COLLATION);
  const totalResults = result?.total?.[0]?.count || 0;
  const totalPages = isPaginated ? Math.ceil(totalResults / limit) : 1;

  return {
    results: result?.data || [],
    kpis: result?.kpis?.[0] || { totalItems: 0, totalInward: 0, totalOutward: 0, netMovement: 0, lowStockCount: 0 },
    page: isPaginated ? page : 1,
    limit: isPaginated ? limit : totalResults,
    totalResults,
    totalPages,
  };
};

const getDateWiseBreakdown = async (filter, options = {}) => {
  const { ItemBatch } = getBooksCrmModels();

  const timezone = await resolveCompanyTimezone(filter.companyId);
  const startDate = toLocalDateBoundary(filter.fromDate, { timezone });
  const endDate = toLocalDateBoundary(filter.toDate, { endOfDay: true, timezone });
  const page = parseInt(options.page) || 1;
  const limit = parseInt(options.limit) || 15;
  const isPaginated = ![false, 'false'].includes(options.pagination);

  const matchStage = {
    companyId: new ObjectId(filter.companyId),
    itemId: new ObjectId(filter.itemId),
    warehouseId: new ObjectId(filter.warehouseId),
  };

  const excludeSplit = shouldExcludeSplitSources(filter.isSplit);
  const inwardEligible = excludeSplit ? [isNonSplitSourceExpr('$sourceType')] : [];
  const deductionEligible = excludeSplit ? [isNonSplitSourceExpr('$$d.deductedSourceType')] : [];
  const inwardMatch = excludeSplit ? { sourceType: { $nin: SPLIT_SOURCE_TYPES } } : {};
  const outwardDeductionMatch = excludeSplit ? { 'deductions.deductedSourceType': { $nin: SPLIT_SOURCE_TYPES } } : {};

  const openingPipeline = [
    { $match: matchStage },
    {
      $addFields: {
        prePeriodInward: {
          $cond: [{ $and: [{ $lt: ['$createdAt', startDate] }, ...inwardEligible] }, '$quantity', 0],
        },
        prePeriodOutward: {
          $reduce: {
            input: {
              $filter: {
                input: '$deductions',
                as: 'd',
                cond: { $and: [{ $lt: ['$$d.deductedAt', startDate] }, ...deductionEligible] },
              },
            },
            initialValue: 0,
            in: { $add: ['$$value', '$$this.quantityDeducted'] },
          },
        },
      },
    },
    {
      $group: {
        _id: null,
        prePeriodInward: { $sum: '$prePeriodInward' },
        prePeriodOutward: { $sum: '$prePeriodOutward' },
      },
    },
  ];

  const inwardPipeline = [
    {
      $match: {
        ...matchStage,
        ...inwardMatch,
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: mongoDateParts('$createdAt', timezone),
        inwardQty: { $sum: '$quantity' },
      },
    },
  ];

  const outwardPipeline = [
    { $match: matchStage },
    { $unwind: '$deductions' },
    {
      $match: {
        'deductions.deductedAt': { $gte: startDate, $lte: endDate },
        ...outwardDeductionMatch,
      },
    },
    {
      $group: {
        _id: mongoDateParts('$deductions.deductedAt', timezone),
        outwardQty: { $sum: '$deductions.quantityDeducted' },
      },
    },
  ];

  const [openingResult, inwardDays, outwardDays] = await Promise.all([
    ItemBatch.aggregate(openingPipeline),
    ItemBatch.aggregate(inwardPipeline),
    ItemBatch.aggregate(outwardPipeline),
  ]);

  const openingQty = (openingResult?.[0]?.prePeriodInward || 0) - (openingResult?.[0]?.prePeriodOutward || 0);

  const dayMap = new Map();

  inwardDays.forEach(d => {
    const key = `${d._id.year}-${String(d._id.month).padStart(2, '0')}-${String(d._id.day).padStart(2, '0')}`;
    dayMap.set(key, { ...dayMap.get(key), inwardQty: d.inwardQty });
  });
  outwardDays.forEach(d => {
    const key = `${d._id.year}-${String(d._id.month).padStart(2, '0')}-${String(d._id.day).padStart(2, '0')}`;
    dayMap.set(key, { ...dayMap.get(key), outwardQty: d.outwardQty });
  });

  const rows = [];
  let runningStock = openingQty;
  const current = moment.tz(startDate, timezone).startOf('day');
  const rangeEnd = moment.tz(endDate, timezone).startOf('day');
  while (current.isSameOrBefore(rangeEnd, 'day')) {
    const key = current.format('YYYY-MM-DD');
    const inward = dayMap.get(key)?.inwardQty || 0;
    const outward = dayMap.get(key)?.outwardQty || 0;
    const opening = runningStock;
    runningStock = opening + inward - outward;
    rows.push({
      date: key,
      openingQty: Math.round(opening * 1000) / 1000,
      inwardQty: Math.round(inward * 1000) / 1000,
      outwardQty: Math.round(outward * 1000) / 1000,
      closingQty: Math.round(runningStock * 1000) / 1000,
    });
    current.add(1, 'day');
  }

  const totalResults = rows.length;
  const totalPages = isPaginated ? Math.ceil(totalResults / limit) || 1 : 1;
  const pagedRows = isPaginated ? rows.slice((page - 1) * limit, page * limit) : rows;

  return {
    openingQty: Math.round(openingQty * 1000) / 1000,
    rows: pagedRows,
    page: isPaginated ? page : 1,
    limit: isPaginated ? limit : totalResults,
    totalResults,
    totalPages,
  };
};

module.exports = { getStockSummary, getDateWiseBreakdown };
