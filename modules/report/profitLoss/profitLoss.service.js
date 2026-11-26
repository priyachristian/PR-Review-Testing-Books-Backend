const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const { getInventoryConfigForProfitLoss } = require('../../../utils/inventoryConfig');
const { MODULE_NAMES, ITEM_BATCH_SOURCE_TYPE } = require('../../../utils/enum');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { PROFIT_LOSS_MESSAGES } = require('../../../utils/messages');
const mongoose = require('mongoose');

const DIRECT_INVOICE_MATCH = { deliveryChallanId: null, 'deliveryChallanIds.0': { $exists: false } };

const invoiceDocFields = { documentNo: '$invoiceId', documentDate: '$invoiceDate', moduleName: MODULE_NAMES.INVOICE };
const challanDocFields = { documentNo: '$challanId', documentDate: '$challanDate', moduleName: MODULE_NAMES.DELIVERY_CHALLAN };

const salesSourceStages = (isInvoiceSource, sourceMatchFilter) => {
  const stages = [{ $match: sourceMatchFilter }, { $addFields: isInvoiceSource ? invoiceDocFields : challanDocFields }];
  if (!isInvoiceSource) {
    const invoiceMatch = { ...sourceMatchFilter, ...DIRECT_INVOICE_MATCH };
    if (invoiceMatch.challanDate) {
      invoiceMatch.invoiceDate = invoiceMatch.challanDate;
      delete invoiceMatch.challanDate;
    }
    stages.push({ $unionWith: { coll: 'invoices', pipeline: [{ $match: invoiceMatch }, { $addFields: invoiceDocFields }] } });
  }
  return stages;
};

/**
 * Fetch source details (sourceId, sourceType, and sourceNo) from itemBatch collection with populated source documents
 * @param {string} itemId - Item ID
 * @param {string} companyId - Company ID
 * @param {number} batchNo - Batch number
 * @param {string} branchId - Branch ID
 * @returns {Promise<Object|null>} Source details with sourceNo or null if not found
 */
const getBatchSourceDetails = async (itemId, companyId, itemBatchId) => {
  const { Bill, CreditNote, ProductionOrder, GrpoOrder, InventoryTransferRequest, DeliveryChallan } = getBooksModels();
  const { ItemBatch } = getBooksCrmModels();
  try {
    const batch = await ItemBatch.findOne(
      {
        _id: new mongoose.Types.ObjectId(itemBatchId),
        itemId: new mongoose.Types.ObjectId(itemId),
        companyId: new mongoose.Types.ObjectId(companyId),
      },
      { sourceId: 1, sourceType: 1, batchNo: 1 },
    ).lean();

    if (!batch) {
      return null;
    }

    const { sourceId, sourceType, batchNo } = batch;
    const sourceCompanyMatch = { _id: sourceId, companyId: new mongoose.Types.ObjectId(companyId) };

    let sourceNo = null;
    switch (sourceType) {
      case MODULE_NAMES.BILL: {
        const doc = await Bill.findOne(sourceCompanyMatch, { billId: 1 }).lean();
        sourceNo = doc?.billId ?? null;
        break;
      }
      case MODULE_NAMES.CREDIT_NOTE: {
        const doc = await CreditNote.findOne(sourceCompanyMatch, { creditNoteId: 1 }).lean();
        sourceNo = doc?.creditNoteId ?? null;
        break;
      }
      case 'PRODUCTION_ORDER': {
        const doc = await ProductionOrder.findOne(sourceCompanyMatch, { productionOrderCode: 1 }).lean();
        sourceNo = doc?.productionOrderCode ?? null;
        break;
      }
      case MODULE_NAMES.GRPO: {
        const doc = await GrpoOrder.findOne(sourceCompanyMatch, { grpoOrderId: 1 }).lean();
        sourceNo = doc?.grpoOrderId ?? null;
        break;
      }
      case 'MANUAL_STOCK_TRANSFER':
      case 'PRODUCTIONORDER_STOCK_TRANSFER': {
        const doc = await InventoryTransferRequest.findOne(sourceCompanyMatch, { transferId: 1 }).lean();
        sourceNo = doc?.transferId ?? null;
        break;
      }
      case ITEM_BATCH_SOURCE_TYPE.DELIVERY_CHALLAN_STOCK_TRANSFER: {
        const doc = await DeliveryChallan.findOne(sourceCompanyMatch, { challanId: 1 }).lean();
        sourceNo = doc?.challanId ?? null;
        break;
      }
      default:
        sourceNo = null;
    }

    return { sourceId, sourceType, sourceNo, batchNo };
  } catch (error) {
    console.error('Error fetching batch source details:', error);
    return null;
  }
};

/**
 * Get batch source details for a single item and its batches
 * @param {Object} filter - Filter criteria containing companyId, itemId, and batches array
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Batch source details
 */
const getBatchSourceDetailsBulk = async filter => {
  const { companyId, itemId, batches } = filter;

  const results = [];

  // Process each batch for this item
  for (const batch of batches) {
    const { itemBatchId } = batch;

    try {
      const sourceDetails = await getBatchSourceDetails(itemId, companyId, itemBatchId);
      results.push({
        itemBatchId,
        batchNo: sourceDetails?.batchNo || null,
        sourceId: sourceDetails?.sourceId || null,
        sourceType: sourceDetails?.sourceType || null,
        sourceNo: sourceDetails?.sourceNo || null,
      });
    } catch (error) {
      console.error(`Error fetching source details for item ${itemId}:`, error);
      results.push({
        batchNo: null,
        sourceId: null,
        sourceType: null,
        sourceNo: null,
      });
    }
  }

  return {
    data: {
      itemId,
      batches: results,
    },
  };
};

/**
 * Calculate profit/loss by customer
 * @param {Object} filter - Filter criteria
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Profit/loss data
 */
const getProfitLossByCustomer = async (filter, options) => {
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId, customerId } = filter;

  // Validate required parameters
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  if (!customerId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Customer ID is required for customer details');
  }

  // Get inventory configuration to check if invoice is the deduction source
  const inventoryConfig = await getInventoryConfigForProfitLoss(companyId);
  let isInvoiceSource = inventoryConfig.stockDeductSource === MODULE_NAMES.INVOICE;

  // Simple match filter - only companyId and customerId
  const sourceMatchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    customerId: new mongoose.Types.ObjectId(customerId),
    status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
  };

  // Choose source collection based on inventory config
  const sourceCollection = isInvoiceSource ? Invoice : DeliveryChallan;

  // Optimized aggregation pipeline for single customerId
  const pipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    // Add explicit customerId match after unwind to ensure we get the exact customer
    {
      $match: {
        customerId: new mongoose.Types.ObjectId(customerId),
      },
    },
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $project: {
        _id: 1,
        customerId: '$customerId',
        documentId: '$_id',
        documentNo: '$documentNo',
        documentDate: '$documentDate',
        createdAt: '$createdAt',
        itemId: '$items.itemId',
        itemName: '$items.itemName',
        itemNo: '$items.itemNo',
        batchNo: '$items.batches.batchNo',
        itemBatchId: '$items.batches.itemBatchId',
        quantity: '$items.batches.quantity',
        purchasePrice: '$items.batches.purchasePrice',
        sellingPrice: '$items.batches.sellingPrice',
        branchId: '$items.batches.branchId',
        // Calculate net profit for this batch
        netProfit: {
          $multiply: [
            '$items.batches.quantity',
            {
              $subtract: [
                { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                '$items.batches.purchasePrice',
              ],
            },
          ],
        },
        // Calculate total cost for this batch
        totalCost: {
          $multiply: ['$items.batches.quantity', '$items.batches.purchasePrice'],
        },
        // Calculate total revenue for this batch
        totalRevenue: {
          $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
        },
      },
    },
    {
      $group: {
        _id: {
          customerId: '$customerId',
          documentId: '$documentId',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          createdAt: '$createdAt',
          itemId: '$itemId',
          itemName: '$itemName',
          itemNo: '$itemNo',
        },
        batches: {
          $push: {
            batchNo: '$batchNo',
            itemBatchId: '$itemBatchId',
            quantity: '$quantity',
            purchasePrice: '$purchasePrice',
            sellingPrice: '$sellingPrice',
            branchId: '$branchId',
            netProfit: '$netProfit',
            totalCost: '$totalCost',
            totalRevenue: '$totalRevenue',
          },
        },
        totalQuantity: { $sum: '$quantity' },
        totalNetProfit: { $sum: '$netProfit' },
        totalCost: { $sum: '$totalCost' },
        totalRevenue: { $sum: '$totalRevenue' },
      },
    },
    {
      $group: {
        _id: {
          customerId: '$_id.customerId',
          documentId: '$_id.documentId',
          documentNo: '$_id.documentNo',
          documentDate: '$_id.documentDate',
        },
        customerId: { $first: '$_id.customerId' },
        documentId: { $first: '$_id.documentId' },
        documentNo: { $first: '$_id.documentNo' },
        documentDate: { $first: '$_id.documentDate' },
        createdAt: { $first: '$_id.createdAt' },
        totalNetProfit: { $sum: '$totalNetProfit' },
        totalCost: { $sum: '$totalCost' },
        totalRevenue: { $sum: '$totalRevenue' },
        totalQuantity: { $sum: '$totalQuantity' },
        totalItems: { $sum: 1 },
        totalBatches: { $sum: { $size: '$batches' } },
      },
    },
    // Sort by createdAt (newest first) for consistent ordering
    {
      $sort: {
        createdAt: -1,
      },
    },
  ];

  // Execute aggregation to get all documents for the customer
  const documentResults = await sourceCollection.aggregate(pipeline);

  // Since we know there's only one customer, process directly
  let customerData = null;
  if (documentResults.length > 0) {
    const firstDoc = documentResults[0];

    customerData = {
      customerId: firstDoc.customerId,
      documents: documentResults.map(doc => ({
        documentId: doc.documentId,
        documentNo: doc.documentNo,
        documentDate: doc.documentDate,
        createdAt: doc.createdAt,
        totalNetProfit: doc.totalNetProfit,
        totalCost: doc.totalCost,
        totalRevenue: doc.totalRevenue,
        totalQuantity: doc.totalQuantity,
        totalItems: doc.totalItems,
        totalBatches: doc.totalBatches,
      })),
      totalNetProfit: documentResults.reduce((sum, doc) => sum + doc.totalNetProfit, 0),
      totalCost: documentResults.reduce((sum, doc) => sum + doc.totalCost, 0),
      totalRevenue: documentResults.reduce((sum, doc) => sum + doc.totalRevenue, 0),
      totalQuantity: documentResults.reduce((sum, doc) => sum + doc.totalQuantity, 0),
      totalItems: documentResults.reduce((sum, doc) => sum + doc.totalItems, 0),
      totalBatches: documentResults.reduce((sum, doc) => sum + doc.totalBatches, 0),
      documentCount: documentResults.length,
    };
  }

  // Apply pagination to documents within the customer
  let paginatedCustomerData = null;
  if (customerData) {
    const pageNum = options.page ? parseInt(options.page) : 1;
    const limitNum = options.limit ? parseInt(options.limit) : 10;
    const skip = (pageNum - 1) * limitNum;

    // Apply pagination to documents
    const paginatedDocuments = customerData.documents.slice(skip, skip + limitNum);

    // Create paginated customer data
    paginatedCustomerData = {
      ...customerData,
      documents: paginatedDocuments,
      documentCount: paginatedDocuments.length,
    };
  }

  // Get total count for pagination
  const countPipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $group: {
        _id: {
          customerId: '$customerId',
          documentId: '$_id',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          itemId: '$items.itemId',
          itemName: '$items.itemName',
          itemNo: '$items.itemNo',
        },
      },
    },
    // Group to unique document per customer
    {
      $group: {
        _id: {
          customerId: '$_id.customerId',
          documentId: '$_id.documentId',
          documentNo: '$_id.documentNo',
          documentDate: '$_id.documentDate',
        },
      },
    },
    {
      $count: 'total',
    },
  ];

  const countResult = await sourceCollection.aggregate(countPipeline);
  const totalCount = countResult.length > 0 ? countResult[0].total : 0;

  // Add pagination info to response
  const pageNum = options.page ? parseInt(options.page) : 1;
  const limitNum = options.limit ? parseInt(options.limit) : 10;
  const paginationInfo = {
    page: pageNum,
    limit: limitNum,
    totalResults: paginatedCustomerData ? paginatedCustomerData.documents.length : 0,
    totalPages: Math.ceil(customerData ? customerData.documentCount / limitNum : 1) || 1,
    totalRecords: customerData ? customerData.documentCount : 0,
  };

  // Get customer details
  const customer = await Customer.findById(customerId).select('customerDisplayName Role');

  // Calculate summary statistics
  const summary = {
    totalCustomers: 1, // Always 1 for specific customer
    totalNetProfit: customerData ? customerData.totalNetProfit : 0,
    totalCost: customerData ? customerData.totalCost : 0,
    totalRevenue: customerData ? customerData.totalRevenue : 0,
    totalQuantity: customerData ? customerData.totalQuantity : 0,
    totalItems: customerData ? customerData.totalItems : 0,
    totalBatches: customerData ? customerData.totalBatches : 0,
    totalDocuments: customerData ? customerData.documentCount : 0,
  };

  // Calculate profit margin percentage
  summary.profitMarginPercentage =
    summary.totalRevenue > 0 ? ((summary.totalNetProfit / summary.totalRevenue) * 100).toFixed(2) : 0;

  // Add customer details and calculate profit margin for documents
  const customerWithDetails = paginatedCustomerData
    ? {
        customerId: paginatedCustomerData.customerId,
        customerDisplayName: customer ? customer.customerDisplayName : null,
        Role: customer ? customer.Role : null,
        documents: paginatedCustomerData.documents.map(document => ({
          ...document,
          profitMarginPercentage:
            document.totalRevenue > 0 ? ((document.totalNetProfit / document.totalRevenue) * 100).toFixed(2) : 0,
        })),
      }
    : null;

  return {
    summary,
    customer: customerWithDetails,
    pagination: paginationInfo,
  };
};

/**
 * Get profit/loss summary by customer (without detailed items)
 * @param {Object} filter - Filter criteria
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Profit/loss summary data
 */
const getProfitLossSummaryByCustomer = async (filter, options) => {
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId, customerId, startDate, endDate, branchId, divisionId, search } = filter;

  // Validate required parameters
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  // customerId is optional - if not provided, will fetch data for all customers

  // Handle search filter for customer display name
  let customerIdsToFilter = [];
  if (search) {
    const searchRegex = createSearchRegex(search.trim());
    const customers = await Customer.find(
      {
        companyId: new mongoose.Types.ObjectId(companyId),
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );
    customerIdsToFilter = customers.map(c => c._id);
  }

  // Build match filter for aggregation
  const matchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
  };

  // Add customerId filter only if provided
  if (customerId) {
    matchFilter.customerId = new mongoose.Types.ObjectId(customerId);
  } else if (search && customerIdsToFilter.length > 0) {
    // If search is provided and we found matching customers, filter by those customer IDs
    matchFilter.customerId = { $in: customerIdsToFilter };
  } else if (search && customerIdsToFilter.length === 0) {
    // If search is provided but no customers found, return empty result
    return {
      summary: {
        totalCustomers: 0,
        totalNetProfit: 0,
        totalCost: 0,
        totalRevenue: 0,
        totalQuantity: 0,
        totalItems: 0,
        totalDocuments: 0,
        profitMarginPercentage: 0,
      },
      customers: [],
    };
  }

  // Add date range filter if provided
  if (startDate || endDate) {
    matchFilter.invoiceDate = {};
    if (startDate) {
      matchFilter.invoiceDate.$gte = new Date(startDate);
    }
    if (endDate) {
      matchFilter.invoiceDate.$lte = new Date(endDate);
    }
  }

  // Add branch filter if provided
  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    matchFilter.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  // Add division filter if provided
  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    matchFilter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  // Get inventory configuration to check which source is used for stock deduction
  const inventoryConfig = await getInventoryConfigForProfitLoss(companyId);
  // Determine the source collection based on stock deduction configuration
  let sourceCollection = Invoice;
  let sourceMatchFilter = { ...matchFilter };
  let isInvoiceSource = inventoryConfig.stockDeductSource === MODULE_NAMES.INVOICE;

  if (!isInvoiceSource) {
    // Use delivery challan as the source
    sourceCollection = DeliveryChallan;
    sourceMatchFilter = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
    };

    // Add customerId filter only if provided
    if (customerId) {
      sourceMatchFilter.customerId = new mongoose.Types.ObjectId(customerId);
    } else if (search && customerIdsToFilter.length > 0) {
      // If search is provided and we found matching customers, filter by those customer IDs
      sourceMatchFilter.customerId = { $in: customerIdsToFilter };
    }

    if (startDate || endDate) {
      sourceMatchFilter.challanDate = {};
      if (startDate) {
        sourceMatchFilter.challanDate.$gte = new Date(startDate);
      }
      if (endDate) {
        sourceMatchFilter.challanDate.$lte = new Date(endDate);
      }
    }

    if (branchId) {
      const branchArray = branchId.split(',').filter(Boolean);
      sourceMatchFilter.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
    }

    if (divisionId) {
      const divisionArray = divisionId.split(',').filter(Boolean);
      sourceMatchFilter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
    }
  }

  // Aggregate pipeline for summary only (grouped by customer)
  const pipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $group: {
        _id: {
          customerId: '$customerId',
          documentId: '$_id',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          itemId: '$items.itemId',
          itemName: '$items.itemName',
          itemNo: '$items.itemNo',
        },
        totalNetProfit: {
          $sum: {
            $multiply: [
              '$items.batches.quantity',
              {
                $subtract: [
                  { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                  '$items.batches.purchasePrice',
                ],
              },
            ],
          },
        },
        totalCost: {
          $sum: {
            $multiply: ['$items.batches.quantity', '$items.batches.purchasePrice'],
          },
        },
        totalRevenue: {
          $sum: {
            $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
          },
        },
        totalQuantity: { $sum: '$items.batches.quantity' },
      },
    },
    {
      $group: {
        _id: '$_id.customerId',
        totalNetProfit: { $sum: '$totalNetProfit' },
        totalCost: { $sum: '$totalCost' },
        totalRevenue: { $sum: '$totalRevenue' },
        totalQuantity: { $sum: '$totalQuantity' },
        totalItems: { $sum: 1 },
        documentCount: { $addToSet: '$_id.documentId' },
      },
    },
    {
      $sort: {
        totalNetProfit: -1,
      },
    },
  ];

  // Add pagination if required (apply when limit is provided; default page=1)
  if (options?.limit) {
    const pageNum = options.page ? parseInt(options.page) : 1;
    const limitNum = parseInt(options.limit);
    const skip = (pageNum - 1) * limitNum;
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum });
  }

  // Execute aggregation
  const results = await sourceCollection.aggregate(pipeline);

  // Get total count for pagination (without pagination applied)
  let totalCount = 0;
  if (options?.limit) {
    const countPipeline = [
      ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
      {
        $unwind: {
          path: '$items',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $unwind: {
          path: '$items.batches',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: {
            customerId: '$customerId',
            documentId: '$_id',
            documentNo: '$documentNo',
            documentDate: '$documentDate',
            itemId: '$items.itemId',
            itemName: '$items.itemName',
            itemNo: '$items.itemNo',
          },
        },
      },
      {
        $group: {
          _id: '$_id.customerId',
        },
      },
      {
        $count: 'total',
      },
    ];

    const countResult = await sourceCollection.aggregate(countPipeline);
    totalCount = countResult.length > 0 ? countResult[0].total : 0;
  }

  // Get customer details
  let customer = null;
  let customersMap = new Map();

  if (customerId) {
    customer = await Customer.findById(customerId).select('customerDisplayName');
  } else {
    // If no specific customer, get all unique customer IDs from results
    const customerIds = results.map(item => item._id);
    if (customerIds.length > 0) {
      const customers = await Customer.find({ _id: { $in: customerIds } }).select('customerDisplayName');
      // Create a map for quick lookup
      customers.forEach(cust => {
        customersMap.set(cust._id.toString(), cust);
      });
    }
  }

  // Calculate summary statistics from ALL data (not just current page)
  // We need to get the total calculations from all matching records
  let totalSummary = {
    totalNetProfit: 0,
    totalCost: 0,
    totalRevenue: 0,
    totalQuantity: 0,
    totalItems: 0,
    totalDocuments: 0,
  };

  // If we have pagination, we need to calculate totals from all data
  if (options?.limit) {
    // Get all results without pagination for summary calculation
    const summaryPipeline = [
      ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
      {
        $unwind: {
          path: '$items',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $unwind: {
          path: '$items.batches',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: {
            customerId: '$customerId',
            documentId: '$_id',
            documentNo: '$documentNo',
            documentDate: '$documentDate',
            itemId: '$items.itemId',
            itemName: '$items.itemName',
            itemNo: '$items.itemNo',
          },
          totalNetProfit: {
            $sum: {
              $multiply: [
                '$items.batches.quantity',
                {
                  $subtract: [
                    { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                    '$items.batches.purchasePrice',
                  ],
                },
              ],
            },
          },
          totalCost: {
            $sum: {
              $multiply: ['$items.batches.quantity', '$items.batches.purchasePrice'],
            },
          },
          totalRevenue: {
            $sum: {
              $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
            },
          },
          totalQuantity: { $sum: '$items.batches.quantity' },
        },
      },
      {
        $group: {
          _id: '$_id.customerId',
          totalNetProfit: { $sum: '$totalNetProfit' },
          totalCost: { $sum: '$totalCost' },
          totalRevenue: { $sum: '$totalRevenue' },
          totalQuantity: { $sum: '$totalQuantity' },
          totalItems: { $sum: 1 },
          documentCount: { $addToSet: '$_id.documentId' },
        },
      },
    ];

    const allResults = await sourceCollection.aggregate(summaryPipeline);

    allResults.forEach(customerData => {
      totalSummary.totalNetProfit += customerData.totalNetProfit || 0;
      totalSummary.totalCost += customerData.totalCost || 0;
      totalSummary.totalRevenue += customerData.totalRevenue || 0;
      totalSummary.totalQuantity += customerData.totalQuantity || 0;
      totalSummary.totalItems += customerData.totalItems || 0;
      totalSummary.totalDocuments += Array.isArray(customerData.documentCount)
        ? customerData.documentCount.length
        : customerData.documentCount || 0;
    });
  } else {
    // No pagination, calculate from current results
    results.forEach(customerData => {
      totalSummary.totalNetProfit += customerData.totalNetProfit || 0;
      totalSummary.totalCost += customerData.totalCost || 0;
      totalSummary.totalRevenue += customerData.totalRevenue || 0;
      totalSummary.totalQuantity += customerData.totalQuantity || 0;
      totalSummary.totalItems += customerData.totalItems || 0;
      totalSummary.totalDocuments += Array.isArray(customerData.documentCount)
        ? customerData.documentCount.length
        : customerData.documentCount || 0;
    });
  }

  const summary = {
    totalCustomers: totalCount || results.length,
    totalNetProfit: totalSummary.totalNetProfit,
    totalCost: totalSummary.totalCost,
    totalRevenue: totalSummary.totalRevenue,
    totalQuantity: totalSummary.totalQuantity,
    totalItems: totalSummary.totalItems,
    totalDocuments: totalSummary.totalDocuments,
  };

  // Calculate profit margin percentage
  summary.profitMarginPercentage =
    summary.totalRevenue > 0 ? ((summary.totalNetProfit / summary.totalRevenue) * 100).toFixed(2) : 0;

  // Add pagination info to response
  const currentPageResults = results.length;
  const paginationInfo = {
    totalResults: currentPageResults,
    page: options.page ? parseInt(options.page) : 1,
    limit: options.limit ? parseInt(options.limit) : 10,
    totalPages: options.limit ? Math.ceil((totalCount || results.length) / parseInt(options.limit)) : 1,
    totalRecords: totalCount || results.length,
  };

  // Add customer details to each customer group
  let customersWithDetails = results;
  if (!customerId && customersMap.size > 0) {
    customersWithDetails = results.map(customerData => ({
      customerId: customerData._id,
      customerDisplayName: customersMap.get(customerData._id.toString())
        ? customersMap.get(customerData._id.toString()).customerDisplayName
        : null,
      totalNetProfit: customerData.totalNetProfit,
      totalCost: customerData.totalCost,
      totalRevenue: customerData.totalRevenue,
      totalQuantity: customerData.totalQuantity,
      totalItems: customerData.totalItems,
      documentCount: Array.isArray(customerData.documentCount) ? customerData.documentCount.length : customerData.documentCount,
      profitMarginPercentage:
        customerData.totalRevenue > 0 ? ((customerData.totalNetProfit / customerData.totalRevenue) * 100).toFixed(2) : 0,
    }));
  } else if (customerId && customer) {
    customersWithDetails = results.map(customerData => ({
      customerId: customerData._id,
      customerDisplayName: customer.customerDisplayName,
      totalNetProfit: customerData.totalNetProfit,
      totalCost: customerData.totalCost,
      totalRevenue: customerData.totalRevenue,
      totalQuantity: customerData.totalQuantity,
      totalItems: customerData.totalItems,
      documentCount: Array.isArray(customerData.documentCount) ? customerData.documentCount.length : customerData.documentCount,
      profitMarginPercentage:
        customerData.totalRevenue > 0 ? ((customerData.totalNetProfit / customerData.totalRevenue) * 100).toFixed(2) : 0,
    }));
  }

  return {
    summary,
    customers: customersWithDetails,
    pagination: paginationInfo,
  };
};

/**
 * Get profit/loss summary by item (without detailed documents)
 * @param {Object} filter - Filter criteria
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Profit/loss summary data grouped by item
 */
const getProfitLossSummaryByItem = async (filter, options) => {
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { Item, ItemGroup } = getBooksCrmModels();
  const { companyId, itemId, startDate, endDate, branchId, divisionId, search, itemType, itemGroup } = filter;

  if (filter?.branchId?.split(',').length > 0) {
    filter.branchId = {
      $in: filter.branchId.split(',').map(id => new mongoose.Types.ObjectId(id.trim())),
    };
  }

  if (filter?.divisionId?.split(',').length > 0) {
    filter.divisionId = {
      $in: filter.divisionId.split(',').map(id => new mongoose.Types.ObjectId(id.trim())),
    };
  }

  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  let itemIdsToFilter = [];

  // Build match filter for aggregation
  const matchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
  };

  // Handle itemType and itemGroup filters
  let filteredItemIds = [];

  if (itemType || itemGroup) {
    // Build filter for Item collection
    const itemFilter = {};

    if (itemType) {
      itemFilter.itemType = itemType;
    }

    if (itemGroup) {
      itemFilter.itemGroup = new mongoose.Types.ObjectId(itemGroup);
    }

    // Get all items that match the filters
    const matchingItems = await Item.find(itemFilter, { _id: 1 }).lean();
    filteredItemIds = matchingItems.map(item => item._id);

    if (filteredItemIds.length === 0) {
      // No items match the filters, return empty result
      return {
        summary: {
          totalItems: 0,
          totalNetProfit: 0,
          totalCost: 0,
          totalRevenue: 0,
          totalQuantity: 0,
          totalDocuments: 0,
          profitMarginPercentage: 0,
        },
        items: [],
      };
    }
  }

  // Build itemId filter with proper combination logic
  let finalItemIds = [];

  // Start with itemType/itemGroup filtered IDs
  if (itemType || itemGroup) {
    finalItemIds = filteredItemIds;
  }

  // Apply itemId filter if provided (highest priority)
  if (itemId) {
    const itemIdStr = itemId.toString();
    if (finalItemIds.length > 0) {
      // Check if the specific itemId is in our filtered results
      if (!finalItemIds.some(id => id.toString() === itemIdStr)) {
        return {
          summary: {
            totalItems: 0,
            totalNetProfit: 0,
            totalCost: 0,
            totalRevenue: 0,
            totalQuantity: 0,
            totalDocuments: 0,
            profitMarginPercentage: 0,
          },
          items: [],
        };
      }
    }
    matchFilter['items.itemId'] = new mongoose.Types.ObjectId(itemId);
  } else if (finalItemIds.length > 0) {
    // Apply combined filters
    matchFilter['items.itemId'] = { $in: finalItemIds };
  }

  // Add date range filter if provided
  if (startDate || endDate) {
    matchFilter.invoiceDate = {};
    if (startDate) {
      matchFilter.invoiceDate.$gte = new Date(startDate);
    }
    if (endDate) {
      matchFilter.invoiceDate.$lte = new Date(endDate);
    }
  }

  // Add branch filter if provided
  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    matchFilter.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  // Add division filter if provided
  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    matchFilter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  // Get inventory configuration to check which source is used for stock deduction
  const inventoryConfig = await getInventoryConfigForProfitLoss(companyId);
  // Determine the source collection based on stock deduction configuration
  let sourceCollection = Invoice;
  let sourceMatchFilter = { ...matchFilter };
  let isInvoiceSource = inventoryConfig.stockDeductSource === MODULE_NAMES.INVOICE;

  if (!isInvoiceSource) {
    // Use delivery challan as the source
    sourceCollection = DeliveryChallan;
    sourceMatchFilter = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
    };

    // Add itemId filter with proper combination logic (same as matchFilter)
    if (itemId) {
      sourceMatchFilter['items.itemId'] = new mongoose.Types.ObjectId(itemId);
    } else if (finalItemIds.length > 0) {
      // Apply combined filters (itemType + itemGroup + search)
      sourceMatchFilter['items.itemId'] = { $in: finalItemIds };
    }

    if (startDate || endDate) {
      sourceMatchFilter.challanDate = {};
      if (startDate) {
        sourceMatchFilter.challanDate.$gte = new Date(startDate);
      }
      if (endDate) {
        sourceMatchFilter.challanDate.$lte = new Date(endDate);
      }
    }

    if (branchId) {
      const branchArray = branchId.split(',').filter(Boolean);
      sourceMatchFilter.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
    }

    if (divisionId) {
      const divisionArray = divisionId.split(',').filter(Boolean);
      sourceMatchFilter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
    }
  }

  // Perform search only on the determined source collection
  if (search) {
    const searchRegex = createSearchRegex(search.trim());
    // Search in the items array of the documents for the specific source collection
    const itemsByName = await sourceCollection.distinct('items.itemId', {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: { $ne: 'CANCELLED' },
      'items.itemName': searchRegex,
    });

    const itemsByNo = await sourceCollection.distinct('items.itemId', {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: { $ne: 'CANCELLED' },
      'items.itemNo': searchRegex,
    });

    itemIdsToFilter = [...new Set([...itemsByName, ...itemsByNo])];

    // Update finalItemIds with search results
    if (itemType || itemGroup) {
      // Intersect itemType/itemGroup results with search results
      const searchItemIds = itemIdsToFilter.map(id => id.toString());
      finalItemIds = finalItemIds.filter(id => searchItemIds.includes(id.toString()));
    } else {
      // Only search filter is active
      finalItemIds = itemIdsToFilter;
    }

    // Update sourceMatchFilter with search results
    if (finalItemIds.length > 0) {
      sourceMatchFilter['items.itemId'] = { $in: finalItemIds };
    } else {
      // Search provided but no results found
      return {
        summary: {
          totalItems: 0,
          totalNetProfit: 0,
          totalCost: 0,
          totalRevenue: 0,
          totalQuantity: 0,
          totalDocuments: 0,
          profitMarginPercentage: 0,
        },
        items: [],
      };
    }
  }

  // Aggregate pipeline for summary only (grouped by item)
  const pipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    // Filter items after unwind to ensure only matching items are included
    ...(finalItemIds.length > 0
      ? [
          {
            $match: {
              'items.itemId': { $in: finalItemIds },
            },
          },
        ]
      : []),
    // Add search filter for item name and item number
    ...(search
      ? [
          {
            $match: {
              $or: [
                { 'items.itemName': { $regex: search.trim(), $options: 'i' } },
                { 'items.itemNo': { $regex: search.trim(), $options: 'i' } },
              ],
            },
          },
        ]
      : []),
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $group: {
        _id: {
          itemId: '$items.itemId',
          itemName: '$items.itemName',
          itemNo: '$items.itemNo',
          documentId: '$_id',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          customerId: '$customerId',
        },
        totalNetProfit: {
          $sum: {
            $multiply: [
              '$items.batches.quantity',
              {
                $subtract: [
                  { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                  '$items.batches.purchasePrice',
                ],
              },
            ],
          },
        },
        totalCost: {
          $sum: {
            $multiply: ['$items.batches.quantity', '$items.batches.purchasePrice'],
          },
        },
        totalRevenue: {
          $sum: {
            $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
          },
        },
        totalQuantity: { $sum: '$items.batches.quantity' },
      },
    },
    {
      $group: {
        _id: '$_id.itemId',
        itemId: { $first: '$_id.itemId' },
        itemName: { $first: '$_id.itemName' },
        itemNo: { $first: '$_id.itemNo' },
        totalNetProfit: { $sum: '$totalNetProfit' },
        totalCost: { $sum: '$totalCost' },
        totalRevenue: { $sum: '$totalRevenue' },
        totalQuantity: { $sum: '$totalQuantity' },
        totalItems: { $sum: 1 },
        documentCount: { $addToSet: '$_id.documentId' },
      },
    },
    {
      $sort: {
        totalNetProfit: -1,
      },
    },
  ];

  // Add pagination if required (default page=1, limit=10)
  const pageNum_item = options.page ? parseInt(options.page) : 1;
  const limitNum_item = options.limit ? parseInt(options.limit) : 10;
  if (options?.limit || options?.page) {
    const skip = (pageNum_item - 1) * limitNum_item;
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum_item });
  }

  // Execute aggregation
  const results = await sourceCollection.aggregate(pipeline);

  // Post-aggregation: Fetch item and itemGroup details
  const itemIds = results.map(item => item.itemId);

  // Fetch item details from books-crm database
  const itemDetails = await Item.find({ _id: { $in: itemIds } }, { _id: 1, itemType: 1, itemGroup: 1 }).lean();

  // Create item details map
  const itemDetailsMap = itemDetails.reduce((acc, item) => {
    acc[item._id.toString()] = item;
    return acc;
  }, {});

  // Get unique itemGroup IDs
  const itemGroupIds = itemDetails
    .map(item => item.itemGroup)
    .filter(Boolean)
    .map(id => id.toString());

  // Fetch itemGroup details from books-crm database
  const itemGroupDetails = await ItemGroup.find({ _id: { $in: itemGroupIds } }, { _id: 1, name: 1 }).lean();

  // Create itemGroup details map
  const itemGroupDetailsMap = itemGroupDetails.reduce((acc, group) => {
    acc[group._id.toString()] = group;
    return acc;
  }, {});

  // Get total count for pagination (without pagination applied)
  let totalCount = 0;
  if (options?.limit || options?.page) {
    const countPipeline = [
      ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
      {
        $unwind: {
          path: '$items',
          preserveNullAndEmptyArrays: false,
        },
      },
      // Filter items after unwind to ensure only matching items are included
      ...(finalItemIds.length > 0
        ? [
            {
              $match: {
                'items.itemId': { $in: finalItemIds },
              },
            },
          ]
        : []),
      // Add search filter for item name and item number
      ...(search
        ? [
            {
              $match: {
                $or: [
                  { 'items.itemName': { $regex: search.trim(), $options: 'i' } },
                  { 'items.itemNo': { $regex: search.trim(), $options: 'i' } },
                ],
              },
            },
          ]
        : []),
      {
        $unwind: {
          path: '$items.batches',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: {
            itemId: '$items.itemId',
            itemName: '$items.itemName',
            itemNo: '$items.itemNo',
            documentId: '$_id',
            documentNo: '$documentNo',
            documentDate: '$documentDate',
            customerId: '$customerId',
          },
        },
      },
      {
        $group: {
          _id: '$_id.itemId',
        },
      },
      {
        $count: 'total',
      },
    ];

    const countResult = await sourceCollection.aggregate(countPipeline);
    totalCount = countResult.length > 0 ? countResult[0].total : 0;
  }

  // Calculate summary statistics from ALL data (not just current page)
  // We need to get the total calculations from all matching records
  let totalSummary = {
    totalNetProfit: 0,
    totalCost: 0,
    totalRevenue: 0,
    totalQuantity: 0,
    totalDocuments: 0,
  };

  // If we have pagination, we need to calculate totals from all data
  if (options?.limit || options?.page) {
    // Get all results without pagination for summary calculation
    const summaryPipeline = [
      ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
      {
        $unwind: {
          path: '$items',
          preserveNullAndEmptyArrays: false,
        },
      },
      // Filter items after unwind to ensure only matching items are included
      ...(finalItemIds.length > 0
        ? [
            {
              $match: {
                'items.itemId': { $in: finalItemIds },
              },
            },
          ]
        : []),
      // Add search filter for item name and item number
      ...(search
        ? [
            {
              $match: {
                $or: [
                  { 'items.itemName': { $regex: search.trim(), $options: 'i' } },
                  { 'items.itemNo': { $regex: search.trim(), $options: 'i' } },
                ],
              },
            },
          ]
        : []),
      {
        $unwind: {
          path: '$items.batches',
          preserveNullAndEmptyArrays: false,
        },
      },
      {
        $group: {
          _id: {
            itemId: '$items.itemId',
            itemName: '$items.itemName',
            itemNo: '$items.itemNo',
            documentId: '$_id',
            documentNo: '$documentNo',
            documentDate: '$documentDate',
            customerId: '$customerId',
          },
          totalNetProfit: {
            $sum: {
              $multiply: [
                '$items.batches.quantity',
                {
                  $subtract: [
                    { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                    '$items.batches.purchasePrice',
                  ],
                },
              ],
            },
          },
          totalCost: {
            $sum: {
              $multiply: ['$items.batches.quantity', '$items.batches.purchasePrice'],
            },
          },
          totalRevenue: {
            $sum: {
              $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
            },
          },
          totalQuantity: { $sum: '$items.batches.quantity' },
        },
      },
      {
        $group: {
          _id: '$_id.itemId',
          totalNetProfit: { $sum: '$totalNetProfit' },
          totalCost: { $sum: '$totalCost' },
          totalRevenue: { $sum: '$totalRevenue' },
          totalQuantity: { $sum: '$totalQuantity' },
          documentCount: { $addToSet: '$_id.documentId' },
        },
      },
    ];

    const allResults = await sourceCollection.aggregate(summaryPipeline);

    allResults.forEach(itemData => {
      totalSummary.totalNetProfit += itemData.totalNetProfit || 0;
      totalSummary.totalCost += itemData.totalCost || 0;
      totalSummary.totalRevenue += itemData.totalRevenue || 0;
      totalSummary.totalQuantity += itemData.totalQuantity || 0;
      totalSummary.totalDocuments += Array.isArray(itemData.documentCount)
        ? itemData.documentCount.length
        : itemData.documentCount || 0;
    });
  } else {
    // No pagination, calculate from current results
    results.forEach(itemData => {
      totalSummary.totalNetProfit += itemData.totalNetProfit || 0;
      totalSummary.totalCost += itemData.totalCost || 0;
      totalSummary.totalRevenue += itemData.totalRevenue || 0;
      totalSummary.totalQuantity += itemData.totalQuantity || 0;
      totalSummary.totalDocuments += Array.isArray(itemData.documentCount)
        ? itemData.documentCount.length
        : itemData.documentCount || 0;
    });
  }

  const summary = {
    totalItems: totalCount || results.length,
    totalNetProfit: totalSummary.totalNetProfit,
    totalCost: totalSummary.totalCost,
    totalRevenue: totalSummary.totalRevenue,
    totalQuantity: totalSummary.totalQuantity,
    totalDocuments: totalSummary.totalDocuments,
  };

  // Calculate profit margin percentage
  summary.profitMarginPercentage =
    summary.totalRevenue > 0 ? ((summary.totalNetProfit / summary.totalRevenue) * 100).toFixed(2) : 0;

  // Add pagination info to response
  const paginationInfo = {
    totalResults: results.length,
    page: pageNum_item,
    limit: limitNum_item,
    totalPages: Math.ceil((totalCount || results.length) / limitNum_item) || 1,
    totalRecords: totalCount || results.length,
  };

  // Add profit margin percentage to each item
  const itemsWithDetails = results.map(itemData => {
    const itemDetail = itemDetailsMap[itemData.itemId.toString()];
    const itemGroupDetail = itemDetail?.itemGroup ? itemGroupDetailsMap[itemDetail.itemGroup.toString()] : null;

    return {
      itemId: itemData.itemId,
      itemName: itemData.itemName,
      itemNo: itemData.itemNo,
      itemType: itemDetail?.itemType || null,
      itemGroup: itemDetail?.itemGroup || null,
      itemGroupName: itemGroupDetail?.name || null,
      totalNetProfit: itemData.totalNetProfit,
      totalCost: itemData.totalCost,
      totalRevenue: itemData.totalRevenue,
      totalQuantity: itemData.totalQuantity,
      documentCount: Array.isArray(itemData.documentCount) ? itemData.documentCount.length : itemData.documentCount,
      profitMarginPercentage:
        itemData.totalRevenue > 0 ? ((itemData.totalNetProfit / itemData.totalRevenue) * 100).toFixed(2) : 0,
    };
  });

  return {
    summary,
    items: itemsWithDetails,
    pagination: paginationInfo,
  };
};

/**
 * Calculate profit/loss by item
 * @param {Object} filter - Filter criteria
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Profit/loss data grouped by item
 */
const getProfitLossByItem = async (filter, options) => {
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId, itemId } = filter;

  // Validate required parameters
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  if (!itemId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Item ID is required for item details');
  }

  // Get inventory configuration to check if invoice is the deduction source
  const inventoryConfig = await getInventoryConfigForProfitLoss(companyId);
  let isInvoiceSource = inventoryConfig.stockDeductSource === MODULE_NAMES.INVOICE;

  // Simple match filter - only companyId and itemId
  const sourceMatchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    'items.itemId': new mongoose.Types.ObjectId(itemId),
    status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
  };

  // Choose source collection based on inventory config
  const sourceCollection = isInvoiceSource ? Invoice : DeliveryChallan;

  // Optimized aggregation pipeline for single itemId
  const pipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    // Add explicit itemId match after unwind to ensure we get the exact item
    {
      $match: {
        'items.itemId': new mongoose.Types.ObjectId(itemId),
      },
    },
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $project: {
        _id: 1,
        customerId: '$customerId',
        documentId: '$_id',
        documentNo: '$documentNo',
        documentDate: '$documentDate',
        createdAt: '$createdAt',
        moduleName: '$moduleName',
        itemId: '$items.itemId',
        itemName: '$items.itemName',
        itemNo: '$items.itemNo',
        batchNo: '$items.batches.batchNo',
        itemBatchId: '$items.batches.itemBatchId',
        quantity: '$items.batches.quantity',
        purchasePrice: '$items.batches.purchasePrice',
        sellingPrice: '$items.batches.sellingPrice',
        branchId: '$items.batches.branchId',
        // Calculate net profit for this batch
        netProfit: {
          $multiply: [
            '$items.batches.quantity',
            {
              $subtract: [
                { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                '$items.batches.purchasePrice',
              ],
            },
          ],
        },
        // Calculate total cost for this batch
        totalCost: {
          $multiply: ['$items.batches.quantity', '$items.batches.purchasePrice'],
        },
        // Calculate total revenue for this batch
        totalRevenue: {
          $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
        },
      },
    },
    {
      $group: {
        _id: {
          documentId: '$documentId',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          createdAt: '$createdAt',
          customerId: '$customerId',
        },
        itemId: { $first: '$itemId' },
        itemName: { $first: '$itemName' },
        itemNo: { $first: '$itemNo' },
        createdAt: { $first: '$createdAt' },
        moduleName: { $first: '$moduleName' },
        batches: {
          $push: {
            batchNo: '$batchNo',
            itemBatchId: '$itemBatchId',
            quantity: '$quantity',
            purchasePrice: '$purchasePrice',
            sellingPrice: '$sellingPrice',
            branchId: '$branchId',
            netProfit: '$netProfit',
            totalCost: '$totalCost',
            totalRevenue: '$totalRevenue',
          },
        },
        totalQuantity: { $sum: '$quantity' },
        totalNetProfit: { $sum: '$netProfit' },
        totalCost: { $sum: '$totalCost' },
        totalRevenue: { $sum: '$totalRevenue' },
        totalBatches: { $sum: 1 },
      },
    },
    // Sort by createdAt (newest first) for consistent ordering
    {
      $sort: {
        createdAt: -1,
      },
    },
  ];

  // Execute aggregation to get all documents for the item
  const documentResults = await sourceCollection.aggregate(pipeline);

  // Since we know there's only one item, process directly
  let itemData = null;
  if (documentResults.length > 0) {
    const firstDoc = documentResults[0];

    itemData = {
      itemId: firstDoc.itemId,
      itemName: firstDoc.itemName,
      itemNo: firstDoc.itemNo,
      documents: documentResults.map(doc => ({
        documentId: doc._id.documentId,
        documentNo: doc._id.documentNo,
        documentDate: doc._id.documentDate,
        createdAt: doc.createdAt,
        moduleName: doc.moduleName,
        customerId: doc._id.customerId,
        totalNetProfit: doc.totalNetProfit,
        totalCost: doc.totalCost,
        totalRevenue: doc.totalRevenue,
        totalQuantity: doc.totalQuantity,
        totalBatches: doc.totalBatches,
      })),
      totalNetProfit: documentResults.reduce((sum, doc) => sum + doc.totalNetProfit, 0),
      totalCost: documentResults.reduce((sum, doc) => sum + doc.totalCost, 0),
      totalRevenue: documentResults.reduce((sum, doc) => sum + doc.totalRevenue, 0),
      totalQuantity: documentResults.reduce((sum, doc) => sum + doc.totalQuantity, 0),
      totalBatches: documentResults.reduce((sum, doc) => sum + doc.totalBatches, 0),
      documentCount: documentResults.length,
    };
  }

  /** Map customerId -> display name for documents in this item */
  let customerNameById = new Map();
  if (itemData?.documents?.length) {
    const uniqueCustomerIds = [
      ...new Set(
        itemData.documents
          .map(d => d.customerId)
          .filter(id => id != null)
          .map(id => id.toString()),
      ),
    ];
    if (uniqueCustomerIds.length > 0) {
      const customerObjectIds = uniqueCustomerIds.map(id => new mongoose.Types.ObjectId(id));
      const customers = await Customer.find({
        _id: { $in: customerObjectIds },
        companyId: new mongoose.Types.ObjectId(companyId),
      }).select('customerDisplayName companyName');
      customers.forEach(c => {
        const displayName = c.customerDisplayName || c.companyName || null;
        customerNameById.set(c._id.toString(), displayName);
      });
    }
  }

  // Apply pagination to documents within the item
  let paginatedItemData = null;
  if (itemData) {
    const pageNum = options.page ? parseInt(options.page) : 1;
    const limitNum = options.limit ? parseInt(options.limit) : 10;
    const skip = (pageNum - 1) * limitNum;

    // Apply pagination to documents
    const paginatedDocuments = itemData.documents.slice(skip, skip + limitNum);

    // Create paginated item data
    paginatedItemData = {
      ...itemData,
      documents: paginatedDocuments,
      documentCount: paginatedDocuments.length,
    };
  }

  // Get total count for pagination
  const countPipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $group: {
        _id: {
          itemId: '$items.itemId',
          itemName: '$items.itemName',
          itemNo: '$items.itemNo',
          documentId: '$_id',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          customerId: '$customerId',
        },
      },
    },
    {
      $group: {
        _id: {
          itemId: '$_id.itemId',
          itemName: '$_id.itemName',
          itemNo: '$_id.itemNo',
          documentId: '$_id.documentId',
          documentNo: '$_id.documentNo',
          documentDate: '$_id.documentDate',
        },
      },
    },
    {
      $count: 'total',
    },
  ];

  const countResult = await sourceCollection.aggregate(countPipeline);
  const totalCount = countResult.length > 0 ? countResult[0].total : 0;

  // Add pagination info to response
  const pageNum = options.page ? parseInt(options.page) : 1;
  const limitNum = options.limit ? parseInt(options.limit) : 10;
  const paginationInfo = {
    page: pageNum,
    limit: limitNum,
    totalResults: paginatedItemData ? paginatedItemData.documents.length : 0,
    totalPages: Math.ceil(itemData ? itemData.documentCount / limitNum : 1) || 1,
    totalRecords: itemData ? itemData.documentCount : 0,
  };

  // Calculate summary statistics
  const summary = {
    totalItems: totalCount || (itemData ? 1 : 0),
    totalNetProfit: itemData ? itemData.totalNetProfit : 0,
    totalCost: itemData ? itemData.totalCost : 0,
    totalRevenue: itemData ? itemData.totalRevenue : 0,
    totalQuantity: itemData ? itemData.totalQuantity : 0,
    totalBatches: itemData ? itemData.totalBatches : 0,
    totalDocuments: itemData ? itemData.documentCount : 0,
  };

  // Calculate profit margin percentage
  summary.profitMarginPercentage =
    summary.totalRevenue > 0 ? ((summary.totalNetProfit / summary.totalRevenue) * 100).toFixed(2) : 0;

  // Add profit margin percentage to each document
  const itemWithDetails = paginatedItemData
    ? {
        itemId: paginatedItemData.itemId,
        itemName: paginatedItemData.itemName,
        itemNo: paginatedItemData.itemNo,
        documentType: isInvoiceSource ? MODULE_NAMES.INVOICE : MODULE_NAMES.DELIVERY_CHALLAN,
        documents: paginatedItemData.documents.map(document => ({
          ...document,
          customerName: document.customerId ? (customerNameById.get(document.customerId.toString()) ?? null) : null,
          profitMarginPercentage:
            document.totalRevenue > 0 ? ((document.totalNetProfit / document.totalRevenue) * 100).toFixed(2) : 0,
        })),
      }
    : null;

  return {
    summary,
    item: itemWithDetails,
    pagination: paginationInfo,
  };
};

const getProfitLossByCustomerMonthWise = async (filter, options) => {
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId, customerId, startDate, endDate, branchId, divisionId, search, months = 3 } = filter;

  // Validate required parameters
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  // Calculate default date range if not provided (current month + previous months)
  let effectiveStartDate = startDate;
  let effectiveEndDate = endDate;

  if (!startDate || !endDate) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    // Calculate end date (end of current month)
    effectiveEndDate = new Date(currentYear, currentMonth + 1, 0, 23, 59, 59, 999);

    // Calculate start date (beginning of previous months)
    effectiveStartDate = new Date(currentYear, currentMonth - (months - 1), 1, 0, 0, 0, 0);
  }

  // Handle search filter for customer display name
  let customerIdsToFilter = [];
  if (search) {
    const searchRegex = createSearchRegex(search.trim());
    const customers = await Customer.find(
      {
        companyId: new mongoose.Types.ObjectId(companyId),
        $or: [{ customerDisplayName: searchRegex }, { companyName: searchRegex }],
      },
      { _id: 1 },
    );
    customerIdsToFilter = customers.map(c => c._id);
  }

  // Build match filter for aggregation
  const matchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
  };

  // Add customerId filter only if provided
  if (customerId) {
    matchFilter.customerId = new mongoose.Types.ObjectId(customerId);
  } else if (search && customerIdsToFilter.length > 0) {
    // If search is provided and we found matching customers, filter by those customer IDs
    matchFilter.customerId = { $in: customerIdsToFilter };
  } else if (search && customerIdsToFilter.length === 0) {
    // If search is provided but no customers found, return empty result
    // But if we have a specific customerId, we'll still process it later
    if (!customerId) {
      return {
        summary: {
          totalCustomers: 0,
          totalNetProfit: 0,
          totalRevenue: 0,
          totalDocuments: 0,
          profitMarginPercentage: 0,
        },
        customers: [],
        pagination: {
          totalResults: 0,
          page: options.page ? parseInt(options.page) : 1,
          limit: options.limit ? parseInt(options.limit) : 10,
          totalPages: 1,
          totalRecords: 0,
        },
      };
    }
  }

  // Add date range filter
  matchFilter.invoiceDate = {
    $gte: new Date(effectiveStartDate),
    $lte: new Date(effectiveEndDate),
  };

  // Add branch filter if provided
  if (branchId) {
    const branchArray = branchId.split(',').filter(Boolean);
    matchFilter.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  // Add division filter if provided
  if (divisionId) {
    const divisionArray = divisionId.split(',').filter(Boolean);
    matchFilter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
  }

  // Get inventory configuration to check which source is used for stock deduction
  const inventoryConfig = await getInventoryConfigForProfitLoss(companyId);
  // Determine the source collection based on stock deduction configuration
  let sourceCollection = Invoice;
  let sourceMatchFilter = { ...matchFilter };
  let isInvoiceSource = inventoryConfig.stockDeductSource === MODULE_NAMES.INVOICE;

  if (!isInvoiceSource) {
    // Use delivery challan as the source
    sourceCollection = DeliveryChallan;
    sourceMatchFilter = {
      companyId: new mongoose.Types.ObjectId(companyId),
      status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
    };

    // Add customerId filter only if provided
    if (customerId) {
      sourceMatchFilter.customerId = new mongoose.Types.ObjectId(customerId);
    } else if (search && customerIdsToFilter.length > 0) {
      // If search is provided and we found matching customers, filter by those customer IDs
      sourceMatchFilter.customerId = { $in: customerIdsToFilter };
    }

    // Add date range filter for delivery challan
    sourceMatchFilter.challanDate = {
      $gte: new Date(effectiveStartDate),
      $lte: new Date(effectiveEndDate),
    };

    if (branchId) {
      const branchArray = branchId.split(',').filter(Boolean);
      sourceMatchFilter.branchId = { $in: branchArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
    }

    if (divisionId) {
      const divisionArray = divisionId.split(',').filter(Boolean);
      sourceMatchFilter.divisionId = { $in: divisionArray.map(id => new mongoose.Types.ObjectId(id.trim())) };
    }
  }

  // Aggregate pipeline for month-wise data
  const pipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $addFields: {
        documentDate: '$documentDate',
        year: {
          $year: { $dateFromString: { dateString: { $toString: '$documentDate' } } },
        },
        month: {
          $month: { $dateFromString: { dateString: { $toString: '$documentDate' } } },
        },
      },
    },
    {
      $group: {
        _id: {
          customerId: '$customerId',
          year: '$year',
          month: '$month',
          documentId: '$_id',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          itemId: '$items.itemId',
          itemName: '$items.itemName',
          itemNo: '$items.itemNo',
        },
        totalNetProfit: {
          $sum: {
            $multiply: [
              '$items.batches.quantity',
              {
                $subtract: [
                  { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                  '$items.batches.purchasePrice',
                ],
              },
            ],
          },
        },
        totalRevenue: {
          $sum: {
            $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
          },
        },
      },
    },
    {
      $group: {
        _id: {
          customerId: '$_id.customerId',
          year: '$_id.year',
          month: '$_id.month',
        },
        totalNetProfit: { $sum: '$totalNetProfit' },
        totalRevenue: { $sum: '$totalRevenue' },
        documentCount: { $addToSet: '$_id.documentId' },
      },
    },
    {
      $sort: {
        '_id.year': -1,
        '_id.month': -1,
        totalNetProfit: -1,
      },
    },
  ];

  // Execute aggregation
  const results = await sourceCollection.aggregate(pipeline);

  // Get customer details
  let customer = null;
  let customersMap = new Map();

  if (customerId) {
    customer = await Customer.findById(customerId).select('customerDisplayName');
  } else {
    // If no specific customer, get all unique customer IDs from results
    const customerIds = [...new Set(results.map(item => item._id.customerId))];
    if (customerIds.length > 0) {
      const customers = await Customer.find({ _id: { $in: customerIds } }).select('customerDisplayName');
      // Create a map for quick lookup
      customers.forEach(cust => {
        customersMap.set(cust._id.toString(), cust);
      });
    }
  }

  // Group results by customer and month
  const customerMonthMap = new Map();
  const monthNames = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  // Generate all months in the date range
  const generateAllMonths = () => {
    const months = [];
    const startDate = new Date(effectiveStartDate);
    const endDate = new Date(effectiveEndDate);

    let currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

    while (currentDate <= endDate) {
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth() + 1;
      const monthKey = `${year}-${month.toString().padStart(2, '0')}`;
      const monthName = monthNames[month - 1];

      months.push({
        monthKey,
        monthName,
        year,
        month,
      });

      // Move to next month
      currentDate.setMonth(currentDate.getMonth() + 1);
    }

    return months;
  };

  const allMonths = generateAllMonths();

  results.forEach(item => {
    const customerId = item._id.customerId.toString();
    const year = item._id.year;
    const month = item._id.month;
    const monthKey = `${year}-${month.toString().padStart(2, '0')}`;
    const monthName = monthNames[month - 1];

    if (!customerMonthMap.has(customerId)) {
      customerMonthMap.set(customerId, {
        customerId: item._id.customerId,
        customerDisplayName:
          customerId && customersMap.get(customerId)
            ? customersMap.get(customerId).customerDisplayName
            : customerId && customer
              ? customer.customerDisplayName
              : null,
        months: {},
        totalNetProfit: 0,
        totalRevenue: 0,
        totalDocuments: 0,
      });
    }

    const customerData = customerMonthMap.get(customerId);

    // Add month data
    customerData.months[monthKey] = {
      monthName,
      year,
      month,
      totalNetProfit: item.totalNetProfit,
      totalRevenue: item.totalRevenue,
      documentCount: Array.isArray(item.documentCount) ? item.documentCount.length : item.documentCount,
      profitMarginPercentage: item.totalRevenue > 0 ? ((item.totalNetProfit / item.totalRevenue) * 100).toFixed(2) : 0,
    };

    // Update totals
    customerData.totalNetProfit += item.totalNetProfit;
    customerData.totalRevenue += item.totalRevenue;
    customerData.totalDocuments += Array.isArray(item.documentCount) ? item.documentCount.length : item.documentCount;
  });

  // Add missing months with zero values for each customer
  customerMonthMap.forEach((customerData, customerId) => {
    allMonths.forEach(monthInfo => {
      if (!customerData.months[monthInfo.monthKey]) {
        customerData.months[monthInfo.monthKey] = {
          monthName: monthInfo.monthName,
          year: monthInfo.year,
          month: monthInfo.month,
          totalNetProfit: 0,
          totalRevenue: 0,
          documentCount: 0,
          profitMarginPercentage: '0.00',
        };
      }
    });
  });

  // If no customers found but we have a specific customerId, create an entry with all months having zero values
  if (customerMonthMap.size === 0 && customerId) {
    const customerData = {
      customerId: new mongoose.Types.ObjectId(customerId),
      customerDisplayName: customer ? customer.customerDisplayName : null,
      months: {},
      totalNetProfit: 0,
      totalRevenue: 0,
      totalDocuments: 0,
    };

    // Add all months with zero values
    allMonths.forEach(monthInfo => {
      customerData.months[monthInfo.monthKey] = {
        monthName: monthInfo.monthName,
        year: monthInfo.year,
        month: monthInfo.month,
        totalNetProfit: 0,
        totalRevenue: 0,
        documentCount: 0,
        profitMarginPercentage: '0.00',
      };
    });

    customerMonthMap.set(customerId, customerData);
  }

  // If no customers found and no specific customerId, but we have customers from search, create entries for them
  if (customerMonthMap.size === 0 && !customerId && customerIdsToFilter.length > 0) {
    // Get customer details for the filtered customers
    const filteredCustomers = await Customer.find({ _id: { $in: customerIdsToFilter } }).select('customerDisplayName');

    filteredCustomers.forEach(cust => {
      const customerData = {
        customerId: cust._id,
        customerDisplayName: cust.customerDisplayName,
        months: {},
        totalNetProfit: 0,
        totalRevenue: 0,
        totalDocuments: 0,
      };

      // Add all months with zero values
      allMonths.forEach(monthInfo => {
        customerData.months[monthInfo.monthKey] = {
          monthName: monthInfo.monthName,
          year: monthInfo.year,
          month: monthInfo.month,
          totalNetProfit: 0,
          totalRevenue: 0,
          documentCount: 0,
          profitMarginPercentage: '0.00',
        };
      });

      customerMonthMap.set(cust._id.toString(), customerData);
    });
  }

  // Convert to array and add overall profit margin, sort months, and calculate profit differences
  const customersWithMonths = Array.from(customerMonthMap.values()).map(customerData => {
    // Sort months in ascending order (earliest to latest)
    const sortedMonthKeys = Object.keys(customerData.months).sort();

    // Create new months object with sorted data and profit differences
    const sortedMonths = {};
    let previousMonthProfit = null;

    sortedMonthKeys.forEach((monthKey, index) => {
      const monthData = customerData.months[monthKey];

      // Calculate profit difference from previous month
      let profitDifference = null;
      let profitDifferencePercentage = null;

      if (previousMonthProfit !== null) {
        profitDifference = monthData.totalNetProfit - previousMonthProfit;

        // Calculate percentage difference
        if (previousMonthProfit !== 0) {
          profitDifferencePercentage = ((profitDifference / Math.abs(previousMonthProfit)) * 100).toFixed(2);
        } else if (monthData.totalNetProfit !== 0) {
          // If previous month was 0 and current month has profit, it's 100% increase
          profitDifferencePercentage = monthData.totalNetProfit > 0 ? '100.00' : '-100.00';
        } else {
          // Both months are 0
          profitDifferencePercentage = '0.00';
        }
      }

      sortedMonths[monthKey] = {
        ...monthData,
        profitDifference,
        profitDifferencePercentage,
      };

      // Update previous month profit for next iteration
      previousMonthProfit = monthData.totalNetProfit;
    });

    return {
      ...customerData,
      months: sortedMonths,
      profitMarginPercentage:
        customerData.totalRevenue > 0 ? ((customerData.totalNetProfit / customerData.totalRevenue) * 100).toFixed(2) : 0,
    };
  });

  // Apply pagination
  let paginatedCustomers = customersWithMonths;
  let totalCount = customersWithMonths.length;

  if (options.page && options.limit) {
    const skip = (options.page - 1) * options.limit;
    const limit = parseInt(options.limit);
    paginatedCustomers = customersWithMonths.slice(skip, skip + limit);
  }

  // Calculate summary statistics
  const totalSummary = {
    totalNetProfit: 0,
    totalRevenue: 0,
    totalDocuments: 0,
  };

  customersWithMonths.forEach(customerData => {
    totalSummary.totalNetProfit += customerData.totalNetProfit || 0;
    totalSummary.totalRevenue += customerData.totalRevenue || 0;
    totalSummary.totalDocuments += customerData.totalDocuments || 0;
  });

  // Calculate month-wise totals (from ALL customers, not just paginated ones)
  const monthWiseTotals = {};

  // Initialize all months with zero values
  allMonths.forEach(monthInfo => {
    monthWiseTotals[monthInfo.monthKey] = {
      monthName: monthInfo.monthName,
      year: monthInfo.year,
      month: monthInfo.month,
      totalNetProfit: 0,
      totalRevenue: 0,
      totalDocuments: 0,
      profitMarginPercentage: '0.00',
    };
  });

  // Aggregate data from ALL customers (not just paginated ones)
  customersWithMonths.forEach(customerData => {
    Object.keys(customerData.months).forEach(monthKey => {
      const monthData = customerData.months[monthKey];
      if (monthWiseTotals[monthKey]) {
        monthWiseTotals[monthKey].totalNetProfit += monthData.totalNetProfit || 0;
        monthWiseTotals[monthKey].totalRevenue += monthData.totalRevenue || 0;
        monthWiseTotals[monthKey].totalDocuments += monthData.documentCount || 0;
      }
    });
  });

  // Calculate profit margin percentage for each month
  Object.keys(monthWiseTotals).forEach(monthKey => {
    const monthData = monthWiseTotals[monthKey];
    monthData.profitMarginPercentage =
      monthData.totalRevenue > 0 ? ((monthData.totalNetProfit / monthData.totalRevenue) * 100).toFixed(2) : '0.00';
  });

  const summary = {
    totalCustomers: totalCount,
    totalNetProfit: totalSummary.totalNetProfit,
    totalRevenue: totalSummary.totalRevenue,
    totalDocuments: totalSummary.totalDocuments,
    profitMarginPercentage:
      totalSummary.totalRevenue > 0 ? ((totalSummary.totalNetProfit / totalSummary.totalRevenue) * 100).toFixed(2) : 0,
  };

  // Add pagination info to response
  const paginationInfo = {
    totalResults: totalCount,
    page: options.page ? parseInt(options.page) : 1,
    limit: options.limit ? parseInt(options.limit) : 10,
    totalPages: options.limit ? Math.ceil(totalCount / parseInt(options.limit)) : 1,
    totalRecords: totalCount,
  };

  return {
    summary,
    customers: paginatedCustomers,
    pagination: paginationInfo,
    monthWiseTotals,
  };
};

/**
 * Get document details with items and batches for a specific document
 * @param {Object} filter - Filter criteria containing documentId and companyId
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Document details with items and batches
 */
const getDocumentDetails = async (filter, options) => {
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { Customer } = getBooksCrmModels();
  const { companyId, documentId } = filter;

  // Validate required parameters
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  if (!documentId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Document ID is required');
  }

  // Get inventory configuration to check if invoice is the deduction source
  const inventoryConfig = await getInventoryConfigForProfitLoss(companyId);
  let isInvoiceSource = inventoryConfig.stockDeductSource === MODULE_NAMES.INVOICE;

  // Choose source collection based on inventory config
  const sourceCollection = isInvoiceSource ? Invoice : DeliveryChallan;

  // Match filter for specific document
  const sourceMatchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    _id: new mongoose.Types.ObjectId(documentId),
    status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
  };

  // Aggregation pipeline for single document
  const pipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $project: {
        _id: 1,
        customerId: '$customerId',
        documentId: '$_id',
        documentNo: '$documentNo',
        documentDate: '$documentDate',
        createdAt: '$createdAt',
        itemId: '$items.itemId',
        itemName: '$items.itemName',
        itemNo: '$items.itemNo',
        batchNo: '$items.batches.batchNo',
        itemBatchId: '$items.batches.itemBatchId',
        quantity: '$items.batches.quantity',
        purchasePrice: '$items.batches.purchasePrice',
        sellingPrice: '$items.batches.sellingPrice',
        branchId: '$items.batches.branchId',
        // Calculate net profit for this batch
        netProfit: {
          $multiply: [
            '$items.batches.quantity',
            {
              $subtract: [
                { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                '$items.batches.purchasePrice',
              ],
            },
          ],
        },
        // Calculate total cost for this batch
        totalCost: {
          $multiply: ['$items.batches.quantity', '$items.batches.purchasePrice'],
        },
        // Calculate total revenue for this batch
        totalRevenue: {
          $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
        },
      },
    },
    {
      $group: {
        _id: {
          documentId: '$documentId',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          createdAt: '$createdAt',
          itemId: '$itemId',
          itemName: '$itemName',
          itemNo: '$itemNo',
        },
        batches: {
          $push: {
            batchNo: '$batchNo',
            itemBatchId: '$itemBatchId',
            quantity: '$quantity',
            purchasePrice: '$purchasePrice',
            sellingPrice: '$sellingPrice',
            branchId: '$branchId',
            netProfit: '$netProfit',
            totalCost: '$totalCost',
            totalRevenue: '$totalRevenue',
          },
        },
        totalQuantity: { $sum: '$quantity' },
        totalNetProfit: { $sum: '$netProfit' },
        totalCost: { $sum: '$totalCost' },
        totalRevenue: { $sum: '$totalRevenue' },
      },
    },
    {
      $group: {
        _id: {
          documentId: '$_id.documentId',
          documentNo: '$_id.documentNo',
          documentDate: '$_id.documentDate',
        },
        documentId: { $first: '$_id.documentId' },
        documentNo: { $first: '$_id.documentNo' },
        documentDate: { $first: '$_id.documentDate' },
        createdAt: { $first: '$_id.createdAt' },
        items: {
          $push: {
            itemId: '$_id.itemId',
            itemName: '$_id.itemName',
            itemNo: '$_id.itemNo',
            batches: '$batches',
            totalQuantity: '$totalQuantity',
            totalNetProfit: '$totalNetProfit',
            totalCost: '$totalCost',
            totalRevenue: '$totalRevenue',
          },
        },
        totalNetProfit: { $sum: '$totalNetProfit' },
        totalCost: { $sum: '$totalCost' },
        totalRevenue: { $sum: '$totalRevenue' },
        totalQuantity: { $sum: '$totalQuantity' },
        totalItems: { $sum: 1 },
        totalBatches: { $sum: { $size: '$batches' } },
      },
    },
  ];

  // Execute aggregation to get document details
  const documentResults = await sourceCollection.aggregate(pipeline);

  if (documentResults.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, PROFIT_LOSS_MESSAGES.DOCUMENT_NOT_FOUND);
  }

  const documentData = documentResults[0];
  let resolvedDoc = await sourceCollection.findOne(sourceMatchFilter).select('customerId').lean();
  let resolvedDocumentType = isInvoiceSource ? MODULE_NAMES.INVOICE : MODULE_NAMES.DELIVERY_CHALLAN;
  if (!resolvedDoc && !isInvoiceSource) {
    resolvedDoc = await Invoice.findOne({ ...sourceMatchFilter, ...DIRECT_INVOICE_MATCH })
      .select('customerId')
      .lean();
    if (resolvedDoc) resolvedDocumentType = MODULE_NAMES.INVOICE;
  }
  const customerId = resolvedDoc?.customerId;

  const customerDisplayName = customerId
    ? (await Customer.findById(customerId).select('customerDisplayName').lean())?.customerDisplayName
    : null;

  // Calculate profit margin percentage for the document
  const profitMarginPercentage =
    documentData.totalRevenue > 0 ? ((documentData.totalNetProfit / documentData.totalRevenue) * 100).toFixed(2) : 0;

  // Enhance items with source details for each batch
  const itemsWithSourceDetails = await Promise.all(
    documentData.items.map(async item => {
      const enhancedBatches = await Promise.all(
        item.batches.map(async batch => {
          const sourceDetails = await getBatchSourceDetails(item.itemId, companyId, batch.itemBatchId);

          return {
            ...batch,
            sourceId: sourceDetails?.sourceId || null,
            sourceType: sourceDetails?.sourceType || null,
            sourceNo: sourceDetails?.sourceNo || null,
          };
        }),
      );

      return {
        ...item,
        batches: enhancedBatches,
        profitMarginPercentage: item.totalRevenue > 0 ? ((item.totalNetProfit / item.totalRevenue) * 100).toFixed(2) : 0,
      };
    }),
  );

  // Create summary object for extras
  const summary = {
    totalNetProfit: documentData.totalNetProfit,
    totalCost: documentData.totalCost,
    totalRevenue: documentData.totalRevenue,
    totalQuantity: documentData.totalQuantity,
    totalItems: documentData.totalItems,
    totalBatches: documentData.totalBatches,
    profitMarginPercentage,
  };

  return {
    documentId: documentData.documentId,
    documentNo: documentData.documentNo,
    documentType: resolvedDocumentType,
    documentDate: documentData.documentDate,
    createdAt: documentData.createdAt,
    customerId: customerId || null,
    customerDisplayName,
    items: itemsWithSourceDetails,
    summary,
  };
};

/**
 * Get document details for a specific item within a document
 * @param {Object} filter - Filter criteria containing documentId, itemId and companyId
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Document and item details
 */
const getDocumentDetailsByItemId = async (filter, options) => {
  const { Invoice, DeliveryChallan } = getBooksModels();
  const { companyId, documentId, itemId } = filter;

  // Validate required parameters
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  if (!documentId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Document ID is required');
  }

  if (!itemId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Item ID is required');
  }

  // Get inventory configuration to check if invoice is the deduction source
  const inventoryConfig = await getInventoryConfigForProfitLoss(companyId);
  let isInvoiceSource = inventoryConfig.stockDeductSource === MODULE_NAMES.INVOICE;

  // Choose source collection based on inventory config
  const sourceCollection = isInvoiceSource ? Invoice : DeliveryChallan;

  // Match filter for specific document and item
  const sourceMatchFilter = {
    companyId: new mongoose.Types.ObjectId(companyId),
    _id: new mongoose.Types.ObjectId(documentId),
    'items.itemId': new mongoose.Types.ObjectId(itemId),
    status: { $ne: 'CANCELLED' }, // Exclude cancelled documents
  };

  // Aggregation pipeline for single document and item
  const pipeline = [
    ...salesSourceStages(isInvoiceSource, sourceMatchFilter),
    {
      $unwind: {
        path: '$items',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $match: {
        'items.itemId': new mongoose.Types.ObjectId(itemId),
      },
    },
    {
      $unwind: {
        path: '$items.batches',
        preserveNullAndEmptyArrays: false,
      },
    },
    {
      $project: {
        _id: 1,
        customerId: '$customerId',
        documentId: '$_id',
        documentNo: '$documentNo',
        documentDate: '$documentDate',
        createdAt: '$createdAt',
        itemId: '$items.itemId',
        itemName: '$items.itemName',
        itemNo: '$items.itemNo',
        batchNo: '$items.batches.batchNo',
        itemBatchId: '$items.batches.itemBatchId',
        quantity: '$items.batches.quantity',
        purchasePrice: '$items.batches.purchasePrice',
        sellingPrice: '$items.batches.sellingPrice',
        branchId: '$items.batches.branchId',
        // Calculate net profit for this batch
        netProfit: {
          $multiply: [
            '$items.batches.quantity',
            {
              $subtract: [
                { $multiply: ['$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }] },
                '$items.batches.purchasePrice',
              ],
            },
          ],
        },
        // Calculate total cost for this batch
        totalCost: {
          $multiply: ['$items.batches.quantity', '$items.batches.purchasePrice'],
        },
        // Calculate total revenue for this batch
        totalRevenue: {
          $multiply: ['$items.batches.quantity', '$items.batches.sellingPrice', { $ifNull: ['$exchangeRate', 1] }],
        },
      },
    },
    {
      $group: {
        _id: {
          documentId: '$documentId',
          documentNo: '$documentNo',
          documentDate: '$documentDate',
          createdAt: '$createdAt',
          itemId: '$itemId',
          itemName: '$itemName',
          itemNo: '$itemNo',
        },
        batches: {
          $push: {
            batchNo: '$batchNo',
            itemBatchId: '$itemBatchId',
            quantity: '$quantity',
            purchasePrice: '$purchasePrice',
            sellingPrice: '$sellingPrice',
            branchId: '$branchId',
            netProfit: '$netProfit',
            totalCost: '$totalCost',
            totalRevenue: '$totalRevenue',
          },
        },
        totalQuantity: { $sum: '$quantity' },
        totalNetProfit: { $sum: '$netProfit' },
        totalCost: { $sum: '$totalCost' },
        totalRevenue: { $sum: '$totalRevenue' },
      },
    },
  ];

  // Execute aggregation to get document and item details
  const documentResults = await sourceCollection.aggregate(pipeline);

  if (documentResults.length === 0) {
    throw new ApiError(httpStatus.NOT_FOUND, PROFIT_LOSS_MESSAGES.DOCUMENT_OR_ITEM_NOT_FOUND);
  }

  const documentData = documentResults[0];

  // Calculate profit margin percentage for the item
  const profitMarginPercentage =
    documentData.totalRevenue > 0 ? ((documentData.totalNetProfit / documentData.totalRevenue) * 100).toFixed(2) : 0;

  // Create summary object for extras
  const summary = {
    totalNetProfit: documentData.totalNetProfit,
    totalCost: documentData.totalCost,
    totalRevenue: documentData.totalRevenue,
    totalQuantity: documentData.totalQuantity,
    totalBatches: documentData.batches.length,
    profitMarginPercentage,
  };

  let resolvedDocumentType = isInvoiceSource ? MODULE_NAMES.INVOICE : MODULE_NAMES.DELIVERY_CHALLAN;
  if (!isInvoiceSource && (await Invoice.exists({ ...sourceMatchFilter, ...DIRECT_INVOICE_MATCH }))) {
    resolvedDocumentType = MODULE_NAMES.INVOICE;
  }

  return {
    documentId: documentData._id.documentId,
    documentNo: documentData._id.documentNo,
    documentType: resolvedDocumentType,
    documentDate: documentData._id.documentDate,
    createdAt: documentData._id.createdAt,
    item: {
      itemId: documentData._id.itemId,
      itemName: documentData._id.itemName,
      itemNo: documentData._id.itemNo,
      batches: documentData.batches,
    },
    summary,
  };
};

/**
 * Get production order details
 * @param {Object} filter - Filter criteria containing companyId and productionOrderId
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Production order details
 */
const getProductionOrderDetails = async (filter, options) => {
  const { ProductionOrder } = getBooksModels();
  const { companyId, productionOrderId } = filter;

  // Validate required parameters
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  if (!productionOrderId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Production Order ID is required');
  }

  // Find the production order
  const productionOrder = await ProductionOrder.findOne({
    _id: new mongoose.Types.ObjectId(productionOrderId),
    companyId: new mongoose.Types.ObjectId(companyId),
  });

  if (!productionOrder) {
    throw new ApiError(httpStatus.NOT_FOUND, PROFIT_LOSS_MESSAGES.PRODUCTION_ORDER_NOT_FOUND);
  }

  const productionDate = productionOrder.productionDate ?? null;

  // Return the production order details
  const response = {
    productionOrderId: productionOrder._id,
    productionOrderNo: productionOrder.productionOrderNo,
    productionDate,
    productionOrderDate: productionDate,
    status: productionOrder.status,
    productionManageMethod: productionOrder.productionManageMethod,
  };

  // If productionManageMethod is BOM_BASED, include additional fields
  if (productionOrder.productionManageMethod === 'BOM_BASED') {
    response.rawMaterials = productionOrder.rawMaterials || [];
    response.batches = productionOrder.batches || [];
    response.submissionHistory = productionOrder.submissionHistory || [];
    response.productionOrderCode = productionOrder.productionOrderCode || null;
    response.objId = productionOrder._id; // ObjectId for reference
  }

  // If productionManageMethod is PROCESS_BASED, include process-based fields
  if (productionOrder.productionManageMethod === 'PROCESS_ROUTE') {
    response.processBased = productionOrder.processBased || [];
    response.batches = productionOrder.batches || [];
    response.productionOrderCode = productionOrder.productionOrderCode || null;
    response.objId = productionOrder._id; // ObjectId for reference
  }

  return response;
};

/**
 * Get production order details
 * @param {Object} filter - Filter criteria containing companyId and productionOrderId
 * @param {Object} options - Query options
 * @returns {Promise<Object>} Production order details
 */
const getProductionOrderDetails_v2 = async (filter, options) => {
  const { ProductionOrder } = getBooksModels();
  const { Item } = getBooksCrmModels();
  const { companyId, productionOrderId } = filter;

  // Validate required parameters
  if (!companyId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Company ID is required');
  }

  if (!productionOrderId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Production Order ID is required');
  }

  // Find the production order
  const productionOrder = await ProductionOrder.findOne({
    _id: new mongoose.Types.ObjectId(productionOrderId),
    companyId: new mongoose.Types.ObjectId(companyId),
  });

  if (!productionOrder) {
    throw new ApiError(httpStatus.NOT_FOUND, PROFIT_LOSS_MESSAGES.PRODUCTION_ORDER_NOT_FOUND);
  }

  // Convert Mongoose document to plain object to avoid metadata issues
  const productionOrderObj = productionOrder.toObject();

  // Fetch item details from CRM database if itemId exists
  let itemDetails = null;
  if (productionOrderObj.itemId) {
    itemDetails = await Item.findById(productionOrderObj.itemId).select('itemName itemNo').lean();
  }

  const productionDate = productionOrderObj.productionDate ?? null;

  // Return the production order details
  const response = {
    productionOrderId: productionOrderObj._id,
    productionOrderNo: productionOrderObj.productionOrderNo,
    productionDate,
    productionOrderDate: productionDate,
    status: productionOrderObj.status,
    productionManageMethod: productionOrderObj.productionManageMethod,
    itemId: productionOrderObj.itemId,
    itemName: itemDetails?.itemName || null,
    itemNo: itemDetails?.itemNo || null,
  };

  // If productionManageMethod is BOM_BASED, include additional fields
  if (productionOrderObj.productionManageMethod === 'BOM_BASED') {
    // Process rawMaterials to create cost breakdown
    const rawMaterials = productionOrderObj.rawMaterials || [];
    const batches = productionOrderObj.batches || [];

    // Get all raw material IDs to fetch item names
    const rawMaterialIds = rawMaterials.map(rm => rm.rawMaterialId);

    // Fetch item names and item numbers for all raw materials
    const items = await Item.find({ _id: { $in: rawMaterialIds } }, { _id: 1, itemName: 1, itemNo: 1 }).lean();

    // Create maps for quick lookup
    const itemNameMap = {};
    const itemNoMap = {};
    items.forEach(item => {
      itemNameMap[item._id.toString()] = item.itemName;
      itemNoMap[item._id.toString()] = item.itemNo;
    });

    // Calculate rawMaterialCost for each raw material
    const processedRawMaterials = rawMaterials.map(rawMaterial => {
      // Remove specified fields from rawMaterials
      const {
        perItemRequiredUnit,
        productionOrderRequiredUnit,
        productionOrderSubmittedUnit,
        bomRRQty,
        rejectQty,
        returnQty,
        ...filteredRawMaterial
      } = rawMaterial;

      // Calculate rawMaterialCost from the rawMaterial's own batches
      let rawMaterialCost = 0;
      if (rawMaterial.batches && rawMaterial.batches.length > 0) {
        rawMaterialCost = rawMaterial.batches.reduce((totalCost, batch) => {
          const purchasePrice = batch.purchasePrice || 0;
          const quantity = batch.quantity || 0;
          return totalCost + purchasePrice * quantity;
        }, 0);
      }

      // Get item name and item number for this raw material
      const itemName = itemNameMap[rawMaterial.rawMaterialId.toString()] || null;
      const itemNo = itemNoMap[rawMaterial.rawMaterialId.toString()] || null;

      return {
        ...filteredRawMaterial,
        rawMaterialCost,
        itemName,
        itemNo,
      };
    });

    response.rawMaterials = processedRawMaterials;
    response.batches = batches;
    response.submissionHistory = productionOrderObj.submissionHistory || [];
    response.productionOrderCode = productionOrderObj.productionOrderCode || null;
    response.objId = productionOrderObj._id; // ObjectId for reference
    response.totalFgSubmittedQty = productionOrderObj.totalFgSubmittedQty || 0;

    // Calculate total additional cost from submission history
    const submissionHistory = productionOrderObj.submissionHistory || [];
    const totalAdditionalCost = submissionHistory.reduce((total, submission) => {
      const additionalCosts = submission.additionalCost || [];
      const amount = additionalCosts.reduce((sum, cost) => sum + (cost.amount || 0), 0);
      return total + amount;
    }, 0);
    response.totalAdditionalCost = totalAdditionalCost;

    // Calculate total manpower cost from submission history
    const totalManpowerCost = submissionHistory.reduce((total, submission) => {
      const manpowerCost = submission.manpowerCost || [];
      const submissionManpowerCost = manpowerCost.reduce((submissionTotal, manpower) => {
        const workerCost = manpower.workerCost || 0;
        return submissionTotal + workerCost;
      }, 0);
      return total + submissionManpowerCost;
    }, 0);
    response.totalManpowerCost = totalManpowerCost;

    // Calculate total raw material cost from all raw materials
    const totalRawMaterialCost = processedRawMaterials.reduce((total, rawMaterial) => {
      return total + (rawMaterial.rawMaterialCost || 0);
    }, 0);
    response.totalRawMaterialCost = totalRawMaterialCost;

    // Calculate total production cost
    const totalProductionCost = totalAdditionalCost + totalManpowerCost + totalRawMaterialCost;
    response.totalProductionCost = totalProductionCost;

    // Calculate per item finished goods cost
    const totalFgSubmittedQty = productionOrderObj.totalFgSubmittedQty || 0;
    const perItemFGCost = totalFgSubmittedQty > 0 ? totalProductionCost / totalFgSubmittedQty : 0;
    response.perItemFGCost = perItemFGCost;
  }

  // If productionManageMethod is PROCESS_BASED, include process-based fields
  if (productionOrderObj.productionManageMethod === 'PROCESS_ROUTE') {
    // Process the processBased data to add rawMaterialCost
    const processBased = productionOrderObj.processBased || {};
    if (processBased.processes && processBased.processes.length > 0) {
      // Get all item IDs from all processes
      const allItemIds = [];
      processBased.processes.forEach(process => {
        if (process.processRawMaterialInput && process.processRawMaterialInput.length > 0) {
          process.processRawMaterialInput.forEach(rawMaterial => {
            if (rawMaterial.item) {
              allItemIds.push(rawMaterial.item);
            }
          });
        }
      });

      // Fetch item names and item numbers for all raw materials
      const items = await Item.find({ _id: { $in: allItemIds } }, { _id: 1, itemName: 1, itemNo: 1 }).lean();

      // Create maps for quick lookup
      const itemNameMap = {};
      const itemNoMap = {};
      items.forEach(item => {
        itemNameMap[item._id.toString()] = item.itemName;
        itemNoMap[item._id.toString()] = item.itemNo;
      });

      const processedProcesses = processBased.processes.map(process => {
        if (process.processRawMaterialInput && process.processRawMaterialInput.length > 0) {
          const processedRawMaterials = process.processRawMaterialInput.map(rawMaterial => {
            // Calculate rawMaterialCost from batches
            let rawMaterialCost = 0;
            if (rawMaterial.batches && rawMaterial.batches.length > 0) {
              rawMaterialCost = rawMaterial.batches.reduce((totalCost, batch) => {
                const purchasePrice = batch.purchasePrice || 0;
                const quantity = batch.quantity || 0;
                return totalCost + purchasePrice * quantity;
              }, 0);
            }

            // Get item name and item number for this raw material
            const itemName = itemNameMap[rawMaterial.item.toString()] || null;
            const itemNo = itemNoMap[rawMaterial.item.toString()] || null;

            return {
              ...rawMaterial,
              rawMaterialCost,
              itemName,
              itemNo,
            };
          });

          return {
            ...process,
            processRawMaterialInput: processedRawMaterials,
          };
        }
        return process;
      });

      response.processBased = {
        ...processBased,
        processes: processedProcesses,
      };
    } else {
      response.processBased = processBased;
    }

    response.batches = productionOrderObj.batches || [];
    response.productionOrderCode = productionOrderObj.productionOrderCode || null;
    response.objId = productionOrderObj._id; // ObjectId for reference

    // Calculate total raw material cost from all processes
    let totalRawMaterialCost = 0;
    if (response.processBased && response.processBased.processes && response.processBased.processes.length > 0) {
      response.processBased.processes.forEach(process => {
        if (process.processRawMaterialInput && process.processRawMaterialInput.length > 0) {
          process.processRawMaterialInput.forEach(rawMaterial => {
            totalRawMaterialCost += rawMaterial.rawMaterialCost || 0;
          });
        }
      });
    }
    response.totalRawMaterialCost = totalRawMaterialCost;

    // Calculate total additional cost from all processes
    let totalAdditionalCost = 0;
    if (response.processBased && response.processBased.processes && response.processBased.processes.length > 0) {
      response.processBased.processes.forEach(process => {
        (process.additionalCost || []).forEach(cost => {
          totalAdditionalCost += cost?.amount || 0;
        });
      });
    }
    response.totalAdditionalCost = totalAdditionalCost;

    // Calculate total manpower cost from all processes
    let totalManpowerCost = 0;
    if (response.processBased && response.processBased.processes && response.processBased.processes.length > 0) {
      response.processBased.processes.forEach(process => {
        if (process.manPower && process.manPower.length > 0) {
          process.manPower.forEach(worker => {
            totalManpowerCost += worker.workerCost || 0;
          });
        }
      });
    }
    response.totalManpowerCost = totalManpowerCost;

    // Calculate total production cost
    const totalProductionCost = totalRawMaterialCost + totalAdditionalCost + totalManpowerCost;
    response.totalProductionCost = totalProductionCost;

    // Get total finished goods submitted quantity from last process output
    let totalFgSubmittedQty = 0;
    if (response.processBased && response.processBased.processes && response.processBased.processes.length > 0) {
      const lastProcess = response.processBased.processes[response.processBased.processes.length - 1];
      totalFgSubmittedQty = lastProcess.processOUT || 0;
    }
    response.totalFgSubmittedQty = totalFgSubmittedQty;

    // Calculate per item finished goods cost from last process output
    let perItemFGCost = 0;
    if (response.processBased && response.processBased.processes && response.processBased.processes.length > 0) {
      const lastProcess = response.processBased.processes[response.processBased.processes.length - 1];
      const lastProcessOutput = lastProcess.processOUT || 0;
      perItemFGCost = lastProcessOutput > 0 ? totalProductionCost / lastProcessOutput : 0;
    }
    response.perItemFGCost = perItemFGCost;
  }

  return response;
};

module.exports = {
  getProfitLossByCustomer,
  getProfitLossSummaryByCustomer,
  getProfitLossByItem,
  getProfitLossSummaryByItem,
  getProfitLossByCustomerMonthWise,
  getDocumentDetails,
  getDocumentDetailsByItemId,
  getBatchSourceDetails,
  getBatchSourceDetailsBulk,
  getProductionOrderDetails,
  getProductionOrderDetails_v2,
};
