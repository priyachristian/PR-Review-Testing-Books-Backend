const httpStatus = require('http-status');
const mongoose = require('mongoose');
const { getBooksModels, getBooksCrmModels, getCommonModels, getClientConnection } = require('../../../services/model.service');
const { SAMPLE_CATALOG_STATUS, SAMPLE_CATALOG_VISIBILITY } = require('@smit9313/abss-models-core/src/utils/enum');
const ApiError = require('../../../utils/ApiError');
const { MODULE_NAMES } = require('../../../utils/enum');
const { SAMPLE_CATALOG_MESSAGES } = require('../../../utils/messages');
const { createSearchRegex } = require('../../../utils/regexUtils');
const { generateUniqueId } = require('../../../utils/uniqueIdGenerator');

const DEFAULT_CODE_PREFIX = 'SC-';

const allowedUnitIds = item =>
  new Set([String(item.itemUnitId), ...(item.unitConversions || []).map(conversion => String(conversion.itemUnitId))]);

// Every incoming item must be an active company item, and each unit must be its base unit or a conversion unit.
const assertItemsValid = async (companyId, items, session) => {
  if (!items.length) return;
  const { Item } = getBooksCrmModels();
  const itemIds = items.map(item => item.itemId);
  const found = await Item.find({ _id: { $in: itemIds }, companyId, itemStatus: true })
    .select('itemName itemUnitId unitConversions')
    .session(session)
    .lean();
  if (found.length !== itemIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, SAMPLE_CATALOG_MESSAGES.ITEM_NOT_FOUND);
  }

  const itemMap = new Map(found.map(item => [String(item._id), item]));
  items.forEach(line => {
    const item = itemMap.get(String(line.itemId));
    const allowed = allowedUnitIds(item);
    const invalidUnit = line.units.find(unit => !allowed.has(String(unit.itemUnitId)));
    if (invalidUnit) {
      throw new ApiError(httpStatus.BAD_REQUEST, `${SAMPLE_CATALOG_MESSAGES.UNIT_NOT_ALLOWED} ${item.itemName}`);
    }
  });
};

const assertCustomersValid = async (companyId, visibility, customerIds, session) => {
  if (visibility !== SAMPLE_CATALOG_VISIBILITY.SELECTED_CUSTOMERS) return;
  const { Customer } = getBooksCrmModels();
  const count = await Customer.countDocuments({
    _id: { $in: customerIds },
    companyId,
    isActive: true,
    'Role.isCustomer': true,
    'otherDetails.enablePortal': true,
  }).session(session);
  if (count !== customerIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, SAMPLE_CATALOG_MESSAGES.CUSTOMER_NOT_FOUND);
  }
};

// Same rule as the customer app item list: portal on, and either open to all or listing every catalog customer.
const isVisibleToAudience = (salesData, visibility, customerIds) => {
  if (!salesData?.customerPortalEnable) return false;
  if (!salesData.specificCustomerEnable) return true;
  if (visibility === SAMPLE_CATALOG_VISIBILITY.ALL_CUSTOMERS) return false;
  const allowed = new Set((salesData.specificCustomers || []).map(String));
  return customerIds.every(customerId => allowed.has(String(customerId)));
};

/**
 * Every catalog item must be visible in the portal to the catalog's customers. Without the user's
 * confirmation this throws 409 with the items; with it, the items are turned on in the same session.
 * All customers: the item's customer restriction is removed. Selected: only the catalog's customers are added.
 */
const ensureItemsOnPortal = async ({ companyId, itemIds, visibility, customerIds = [], activate, userId, session }) => {
  if (!itemIds.length) return;
  const { Item } = getBooksCrmModels();
  const items = await Item.find({ _id: { $in: itemIds }, companyId })
    .select('itemName salesData.customerPortalEnable salesData.specificCustomerEnable salesData.specificCustomers')
    .session(session)
    .lean();
  const hidden = items.filter(item => !isVisibleToAudience(item.salesData, visibility, customerIds));
  if (!hidden.length) return;

  if (!activate) {
    throw new ApiError(httpStatus.CONFLICT, SAMPLE_CATALOG_MESSAGES.ITEMS_NOT_ON_PORTAL(hidden.map(item => item.itemName)), 0, {
      portalActivationRequired: true,
      visibility,
      items: hidden.map(item => ({ itemId: String(item._id), itemName: item.itemName })),
    });
  }

  const forAll = visibility === SAMPLE_CATALOG_VISIBILITY.ALL_CUSTOMERS;
  const update = forAll
    ? {
        $set: {
          'salesData.customerPortalEnable': true,
          'salesData.specificCustomerEnable': false,
          'salesData.specificCustomers': [],
          updatedBy: userId,
        },
      }
    : {
        $set: { 'salesData.customerPortalEnable': true, 'salesData.specificCustomerEnable': true, updatedBy: userId },
        $addToSet: { 'salesData.specificCustomers': { $each: customerIds.map(id => new mongoose.Types.ObjectId(id)) } },
      };
  await Item.updateMany({ _id: { $in: hidden.map(item => item._id) }, companyId }, update, { session });
};

const hasItems = items => items.some(item => item.units?.length);

const assertCanBeActive = catalog => {
  if (!hasItems(catalog.items)) {
    throw new ApiError(httpStatus.BAD_REQUEST, SAMPLE_CATALOG_MESSAGES.ACTIVATE_NEEDS_ITEM);
  }
  if (catalog.endDate && new Date(catalog.endDate) < new Date()) {
    throw new ApiError(httpStatus.BAD_REQUEST, SAMPLE_CATALOG_MESSAGES.ACTIVATE_EXPIRED);
  }
};

const toUnit = unit => ({
  itemUnitId: unit.itemUnitId,
  samplePrice: unit.samplePrice,
  minQty: unit.minQty,
  maxQty: unit.maxQty,
});

// The payload is the full list; lines and units left out are removed.
const toItems = items => items.map(item => ({ itemId: item.itemId, units: item.units.map(toUnit) }));

const startSession = async () => {
  const connection = getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  return connection.startSession();
};

const createSampleCatalog = async ({ activateItemPortal, ...body }, companyId, userId) => {
  const { SampleCatalog } = getBooksModels();
  const session = await startSession();

  try {
    let catalog;
    await session.withTransaction(async () => {
      await assertItemsValid(companyId, body.items, session);
      await assertCustomersValid(companyId, body.visibility, body.customerIds, session);
      await ensureItemsOnPortal({
        companyId,
        itemIds: body.items.map(item => item.itemId),
        visibility: body.visibility,
        customerIds: body.customerIds,
        activate: activateItemPortal,
        userId,
        session,
      });

      const items = toItems(body.items);
      if (body.status === SAMPLE_CATALOG_STATUS.ACTIVE) {
        assertCanBeActive({ items, endDate: body.endDate });
      }

      const catalogCode = await generateUniqueId(
        SampleCatalog,
        companyId,
        MODULE_NAMES.SAMPLE_CATALOG,
        'catalogCode',
        DEFAULT_CODE_PREFIX,
        session,
        body.catalogCode || undefined,
      );

      [catalog] = await SampleCatalog.create(
        [
          {
            ...body,
            items,
            catalogCode,
            companyId,
            addedBy: userId,
            updatedBy: userId,
          },
        ],
        { session },
      );
    });
    return catalog;
  } finally {
    await session.endSession();
  }
};

const updateSampleCatalog = async (sampleCatalogId, companyId, { activateItemPortal, ...body }, userId) => {
  const { SampleCatalog } = getBooksModels();
  const session = await startSession();

  try {
    let catalog;
    await session.withTransaction(async () => {
      catalog = await SampleCatalog.findOne({ _id: sampleCatalogId, companyId }).session(session);
      if (!catalog) {
        throw new ApiError(httpStatus.NOT_FOUND, SAMPLE_CATALOG_MESSAGES.NOT_FOUND);
      }

      await assertItemsValid(companyId, body.items, session);
      await assertCustomersValid(companyId, body.visibility, body.customerIds, session);
      await ensureItemsOnPortal({
        companyId,
        itemIds: body.items.map(item => item.itemId),
        visibility: body.visibility,
        customerIds: body.customerIds,
        activate: activateItemPortal,
        userId,
        session,
      });

      const items = toItems(body.items);
      if (catalog.status === SAMPLE_CATALOG_STATUS.ACTIVE && !hasItems(items)) {
        throw new ApiError(httpStatus.BAD_REQUEST, SAMPLE_CATALOG_MESSAGES.ACTIVATE_NEEDS_ITEM);
      }

      catalog.set({
        name: body.name,
        description: body.description,
        startDate: body.startDate ?? null,
        endDate: body.endDate ?? null,
        visibility: body.visibility,
        customerIds: body.customerIds,
        items,
        updatedBy: userId,
      });
      // Mongoose versioning on the items array rejects a concurrent edit instead of overwriting it.
      catalog.increment();
      await catalog.save({ session });
    });
    return catalog;
  } finally {
    await session.endSession();
  }
};

const updateSampleCatalogStatus = async (sampleCatalogId, companyId, status, userId, activateItemPortal = false) => {
  const { SampleCatalog } = getBooksModels();
  const session = await startSession();

  try {
    let updated;
    await session.withTransaction(async () => {
      const catalog = await SampleCatalog.findOne({ _id: sampleCatalogId, companyId }).session(session).lean();
      if (!catalog) {
        throw new ApiError(httpStatus.NOT_FOUND, SAMPLE_CATALOG_MESSAGES.NOT_FOUND);
      }
      if (catalog.status === status) {
        throw new ApiError(httpStatus.BAD_REQUEST, SAMPLE_CATALOG_MESSAGES.STATUS_UNCHANGED);
      }
      if (status === SAMPLE_CATALOG_STATUS.ACTIVE) {
        assertCanBeActive(catalog);
        await ensureItemsOnPortal({
          companyId,
          itemIds: catalog.items.map(item => item.itemId),
          visibility: catalog.visibility,
          customerIds: catalog.customerIds || [],
          activate: activateItemPortal,
          userId,
          session,
        });
      }

      updated = await SampleCatalog.findOneAndUpdate(
        { _id: sampleCatalogId, companyId, status: catalog.status },
        { $set: { status, updatedBy: userId } },
        { new: true, session },
      );
      if (!updated) {
        throw new ApiError(httpStatus.CONFLICT, SAMPLE_CATALOG_MESSAGES.UPDATE_STATUS_FAILURE);
      }
    });
    return updated;
  } finally {
    await session.endSession();
  }
};

const querySampleCatalogs = async (filter, options) => {
  const { SampleCatalog } = getBooksModels();
  const query = { companyId: new mongoose.Types.ObjectId(filter.companyId) };

  if (filter.status) {
    const statuses = filter.status.split(',').filter(Boolean);
    if (statuses.length) query.status = { $in: statuses };
  }
  if (filter.visibility) {
    query.visibility = filter.visibility;
  }
  if (filter.search) {
    const searchRegex = createSearchRegex(filter.search.trim());
    query.$or = [{ name: searchRegex }, { catalogCode: searchRegex }];
  }

  return SampleCatalog.paginate(query, {
    ...options,
    sortBy: options.sortBy || 'createdAt:desc',
    select: 'catalogCode name status visibility startDate endDate customerIds items.itemId createdAt updatedAt',
  });
};

const getSampleCatalogById = async (sampleCatalogId, companyId) => {
  const { SampleCatalog } = getBooksModels();
  const { Item, ItemUnit, Customer } = getBooksCrmModels();
  const { User } = getCommonModels();

  // Item, ItemUnit and Customer live in booksCrm, User in common, so each populate names its model.
  const catalog = await SampleCatalog.findOne({ _id: sampleCatalogId, companyId })
    .populate({ path: 'items.itemId', select: 'itemName itemNo hsnCode gst itemUnitId unitConversions itemStatus', model: Item })
    .populate({ path: 'items.units.itemUnitId', select: 'name', model: ItemUnit })
    .populate({ path: 'customerIds', select: 'customerDisplayName companyName customerNumber', model: Customer })
    .populate({ path: 'addedBy updatedBy', select: 'firstName lastName', model: User })
    .lean();

  if (!catalog) {
    throw new ApiError(httpStatus.NOT_FOUND, SAMPLE_CATALOG_MESSAGES.NOT_FOUND);
  }
  return catalog;
};

module.exports = {
  createSampleCatalog,
  updateSampleCatalog,
  updateSampleCatalogStatus,
  querySampleCatalogs,
  getSampleCatalogById,
};
