const httpStatus = require('http-status');
const { getBooksCrmModels, getBooksModels, getClientConnection } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const { PRICE_LIST_MESSAGES } = require('../../../utils/messages');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');
const { withTransientRetry } = require('../../../utils/withTransientRetry');
const { MODULE_NAMES } = require('../../../utils/enum');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { getCurrency } = require('../../../services/currencyResolver.service');

/**
 * Create a price list
 * @param {Object} priceListBody
 * @returns {Promise<PriceList>}
 */
const createPriceList = async priceListBody => {
  const { PriceList } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  if (!(await getCurrency(priceListBody.companyId, priceListBody.currency))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid currency for this company');
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();

    priceListBody.priceListCode = await generateUniqueId(
      PriceList,
      priceListBody?.companyId,
      MODULE_NAMES.PRICE_LIST,
      'priceListCode',
      'PL',
      session,
      priceListBody.priceListCode,
    );

    const existingPriceList = await PriceList.findOne({
      companyId: priceListBody.companyId,
      priceListName: priceListBody.priceListName,
    }).session(session);

    if (existingPriceList) {
      throw new ApiError(httpStatus.CONFLICT, 'PriceList with name already exists');
    }

    const priceList = await PriceList.create([priceListBody], { session });
    await session.commitTransaction();
    const priceListObj = priceList[0].toJSON();
    priceListObj.currency = await getCurrency(priceListBody.companyId, priceListObj.currency);
    return priceListObj;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Query for price lists
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryPriceLists = async (query, filter, options) => {
  const { PriceList } = getBooksCrmModels();

  if (query.search) {
    const searchRegex = createSearchRegex(query.search.trim());
    filter.$or = [{ priceListName: searchRegex }, { priceListCode: searchRegex }, { remarks: searchRegex }];
  }

  options.populate = 'items.itemId:itemName itemNo itemType,items.itemGroup:name';

  const priceLists = await PriceList.paginate(filter, options);
  const currencies = await getCurrency(
    filter.companyId,
    priceLists.results.map(pl => pl.currency),
  );

  priceLists.results = priceLists.results.map(pl => ({
    ...pl.toJSON(),
    currency: currencies.find(c => String(c._id) === String(pl.currency)),
  }));

  return priceLists;
};

/**
 * Get price list by id
 * @param {ObjectId} id
 * @returns {Promise<PriceList>}
 */
const getPriceListById = async (id, companyId) => {
  const { PriceList } = getBooksCrmModels();

  // Populate only _id (exclude itemName)
  const priceList = await PriceList.findOne({ _id: id, companyId })
    .populate('items.itemId', 'itemName itemNo itemType')
    .populate('items.itemGroup', 'name')
    .populate('items.unitPrices.itemUnitId', 'name');

  if (!priceList) {
    throw new ApiError(httpStatus.NOT_FOUND, PRICE_LIST_MESSAGES.FETCH_ONE_NOT_FOUND);
  }

  const plainPriceList = priceList.toObject();

  plainPriceList.items = plainPriceList.items.map(item => {
    let itemId = item.itemId;
    let itemGroup = item.itemGroup;

    if (itemId && typeof itemId === 'object') {
      // If populated object, rename _id to id
      itemId = {
        id: itemId._id?.toString() || itemId,
        itemName: itemId.itemName,
        itemNo: itemId.itemNo,
        itemType: itemId.itemType,
      };
    }

    if (itemGroup && typeof itemGroup === 'object') {
      // If populated object, rename _id to id
      itemGroup = {
        id: itemGroup._id?.toString() || itemGroup,
        name: itemGroup.name,
      };
    }

    const unitPrices = (item.unitPrices || []).map(unitPrice => {
      const unit = unitPrice.itemUnitId;
      if (unit && typeof unit === 'object') {
        return {
          ...unitPrice,
          itemUnitId: { id: unit._id?.toString(), name: unit.name },
        };
      }
      return unitPrice;
    });

    return {
      ...item,
      itemId, // Now with renamed `id`
      itemGroup,
      unitPrices,
    };
  });

  plainPriceList.currency = await getCurrency(companyId, plainPriceList.currency);

  return plainPriceList;
};

/**
 * Update price list by id
 * @param {ObjectId} priceListId
 * @param {Object} updateBody
 * @returns {Promise<PriceList>}
 */
const updatePriceListById = async (priceListId, updateBody) => {
  const { PriceList } = getBooksCrmModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const priceList = await PriceList.findById(priceListId).session(session);
    if (!priceList) {
      throw new ApiError(httpStatus.NOT_FOUND, PRICE_LIST_MESSAGES.FETCH_ONE_NOT_FOUND);
    }

    const existingPriceList = await PriceList.findOne({
      companyId: priceList.companyId,
      priceListName: updateBody.priceListName,
      _id: { $ne: priceListId },
    }).session(session);

    if (existingPriceList) {
      throw new ApiError(httpStatus.CONFLICT, 'PriceList with name already exists');
    }

    if (updateBody.currency) {
      if (!(await getCurrency(priceList.companyId, updateBody.currency))) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid currency for this company');
      }
    }

    Object.assign(priceList, updateBody);
    await priceList.save({ session });
    await session.commitTransaction();

    const priceListObj = priceList.toJSON();
    priceListObj.currency = await getCurrency(priceList.companyId, priceList.currency);
    return priceListObj;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Delete price list by id
 * @param {ObjectId} priceListId
 * @returns {Promise<PriceList>}
 */
const deletePriceListById = async (priceListId, companyId) => {
  const { PriceList, Customer, Quote, SalesOrder } = getBooksCrmModels();
  const { DeliveryChallan, Invoice, RecurringInvoice } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const [
    customerUsingPriceList,
    quoteUsingPriceList,
    salesOrderUsingPriceList,
    deliveryChallanUsingPriceList,
    invoiceUsingPriceList,
    recurringInvoiceUsingPriceList,
  ] = await Promise.all([
    Customer.findOne({ companyId, priceList: priceListId }),
    Quote.findOne({ companyId, priceListId }),
    SalesOrder.findOne({ companyId, priceListId }),
    DeliveryChallan.findOne({ companyId, priceListId }),
    Invoice.findOne({ companyId, priceListId }),
    RecurringInvoice.findOne({ companyId, priceListId }),
  ]);

  if (
    customerUsingPriceList ||
    quoteUsingPriceList ||
    salesOrderUsingPriceList ||
    deliveryChallanUsingPriceList ||
    invoiceUsingPriceList ||
    recurringInvoiceUsingPriceList
  ) {
    throw new ApiError(httpStatus.BAD_REQUEST, PRICE_LIST_MESSAGES.DELETE_IN_USE);
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const priceList = await PriceList.findOne({ _id: priceListId, companyId }).session(session);
    if (!priceList) {
      throw new ApiError(httpStatus.NOT_FOUND, PRICE_LIST_MESSAGES.FETCH_ONE_NOT_FOUND);
    }
    await PriceList.deleteOne({ _id: priceListId, companyId }, { session });
    await session.commitTransaction();
    return priceList;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const dropdownPriceLists = async filter => {
  const { PriceList } = getBooksCrmModels();

  const priceLists = await PriceList.find(filter).populate([
    {
      path: 'items.itemId',
      select: 'itemName',
    },
    {
      path: 'items.itemGroup',
      select: 'name',
    },
  ]);

  return priceLists;
};

module.exports = {
  createPriceList: withTransientRetry(createPriceList),
  queryPriceLists,
  getPriceListById,
  updatePriceListById,
  deletePriceListById,
  dropdownPriceLists,
};
