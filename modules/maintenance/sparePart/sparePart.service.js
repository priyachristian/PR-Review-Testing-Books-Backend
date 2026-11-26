const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getClientConnection, getBooksModels, getBooksCrmModels } = require('../../../services/model.service');
const { generateNextCode, withCodeRetry } = require('../../../utils/autoIncrementCode');
const { SPARE_PART_MESSAGES } = require('../../../utils/messages');
const { postEntries } = require('../spareStockLedger/spareStockLedger.service');
const { SPARE_STOCK_TRANSACTION_TYPE, SPARE_STOCK_REFERENCE_TYPE } = require('@smit9313/abss-models-core/src/utils/enum');

const escapeRegex = value => value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const attachUom = async (spareParts, companyId) => {
  const { ItemUnit } = getBooksCrmModels();
  const list = spareParts.map(part => (typeof part.toJSON === 'function' ? part.toJSON() : part));
  const uomIds = [...new Set(list.map(part => part.uom?.toString()).filter(Boolean))];
  const units = uomIds.length
    ? await ItemUnit.find({ _id: { $in: uomIds }, companyId })
        .select('name')
        .lean()
    : [];
  const unitMap = new Map(units.map(unit => [unit._id.toString(), { id: unit._id, name: unit.name }]));
  return list.map(part => ({ ...part, uom: part.uom ? unitMap.get(part.uom.toString()) || null : null }));
};

const validateReferences = async (data, companyId, session) => {
  const { Machine } = getBooksModels();
  const { ItemUnit } = getBooksCrmModels();

  if (data.uom) {
    const unit = await ItemUnit.exists({ _id: data.uom, companyId }).session(session);
    if (!unit) {
      throw new ApiError(httpStatus.BAD_REQUEST, SPARE_PART_MESSAGES.UOM_NOT_FOUND);
    }
  }

  if (data.fitsOnMachines?.length) {
    const count = await Machine.countDocuments({ _id: { $in: data.fitsOnMachines }, companyId }).session(session);
    if (count !== data.fitsOnMachines.length) {
      throw new ApiError(httpStatus.BAD_REQUEST, SPARE_PART_MESSAGES.MACHINE_NOT_FOUND);
    }
  }
};

// Names are compared ignoring case and surrounding spaces; inactive spare parts count too.
const assertNameAvailable = async (name, companyId, session, excludeId) => {
  const { SparePart } = getBooksModels();
  const query = { companyId, name: new RegExp(`^${escapeRegex(name)}$`, 'i') };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }
  if (await SparePart.exists(query).session(session)) {
    throw new ApiError(httpStatus.BAD_REQUEST, SPARE_PART_MESSAGES.DUPLICATE_NAME);
  }
};

const startSession = async () => {
  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  return connection.startSession();
};

const SPARE_PART_CODE_PREFIX = 'SP-';

const createSparePartOnce = async (data, userId) => {
  const { SparePart } = getBooksModels();
  const session = await startSession();

  try {
    await session.startTransaction();

    await assertNameAvailable(data.name, data.companyId, session);
    const code = await generateNextCode(SparePart, data.companyId, 'code', SPARE_PART_CODE_PREFIX, session);
    // stock is not a spare part field; it becomes an OPENING entry in the ledger below.
    const { stock, ...sparePartData } = data;
    const payload = { ...sparePartData, code, isActive: true, addedBy: userId, updatedBy: userId };
    if (!payload.uom) {
      delete payload.uom;
    }
    await validateReferences(payload, data.companyId, session);

    const [created] = await SparePart.create([payload], { session });

    if (stock > 0) {
      await postEntries(
        [
          {
            companyId: data.companyId,
            sparePartId: created._id,
            transactionType: SPARE_STOCK_TRANSACTION_TYPE.OPENING,
            qty: stock,
            ...(payload.standardRate != null && { rate: payload.standardRate }),
            referenceId: created._id,
            referenceType: SPARE_STOCK_REFERENCE_TYPE.SPARE_PART,
            remarks: 'Opening stock',
            createdBy: userId,
          },
        ],
        session,
      );
    }
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const createSparePart = (data, userId) => withCodeRetry(() => createSparePartOnce(data, userId), 'code');

const getAllSpareParts = async (query, filter, options) => {
  const { SparePart } = getBooksModels();
  const { search, category, machineId } = query;

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ code: searchRegex }, { name: searchRegex }, { preferredVendor: searchRegex }];
  }
  if (category) {
    filter.category = category;
  }
  if (machineId) {
    filter.fitsOnMachines = machineId;
  }

  const spareParts = await SparePart.paginate(filter, { ...options, populate: 'fitsOnMachines:machineCode|machineName' });
  if (!spareParts) {
    throw new ApiError(httpStatus.NOT_FOUND, SPARE_PART_MESSAGES.NOT_FOUND);
  }

  return { ...spareParts, results: await attachUom(spareParts.results, filter.companyId) };
};

const getSparePartById = async (id, companyId) => {
  const { SparePart } = getBooksModels();
  const sparePart = await SparePart.findOne({ _id: id, companyId }).populate('fitsOnMachines', 'machineCode machineName');
  if (!sparePart) {
    throw new ApiError(httpStatus.NOT_FOUND, SPARE_PART_MESSAGES.NOT_FOUND);
  }
  const [result] = await attachUom([sparePart], companyId);
  return result;
};

const updateSparePartById = async (id, data, companyId, userId) => {
  const { SparePart } = getBooksModels();
  const session = await startSession();

  try {
    await session.startTransaction();
    const sparePart = await SparePart.findOne({ _id: id, companyId }).session(session);
    if (!sparePart) {
      throw new ApiError(httpStatus.NOT_FOUND, SPARE_PART_MESSAGES.NOT_FOUND);
    }

    if (data.name !== undefined) {
      await assertNameAvailable(data.name, companyId, session, sparePart._id);
    }

    const rest = { ...data };
    if (rest.uom === '') {
      rest.uom = null;
    }
    await validateReferences(rest, companyId, session);

    Object.assign(sparePart, rest);
    sparePart.updatedBy = userId;
    await sparePart.save({ session });
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const updateActiveStatus = async (id, isActive, companyId, userId) => {
  const { SparePart } = getBooksModels();
  const { matchedCount } = await SparePart.updateOne({ _id: id, companyId }, { isActive, updatedBy: userId });
  if (!matchedCount) {
    throw new ApiError(httpStatus.NOT_FOUND, SPARE_PART_MESSAGES.NOT_FOUND);
  }
};

const deleteSparePartById = async (id, companyId) => {
  const { SparePart, Machine, PartRequest, MaintenancePurchase, SpareStockLedger } = getBooksModels();
  const session = await startSession();

  try {
    await session.startTransaction();
    const sparePart = await SparePart.findOne({ _id: id, companyId }).session(session);
    if (!sparePart) {
      throw new ApiError(httpStatus.NOT_FOUND, SPARE_PART_MESSAGES.NOT_FOUND);
    }

    const usages = await Promise.all([
      Machine.exists({ companyId, 'wearParts.sparePartId': id }).session(session),
      PartRequest.exists({ companyId, sparePartId: id }).session(session),
      MaintenancePurchase.exists({ companyId, 'items.sparePartId': id }).session(session),
      SpareStockLedger.exists({ companyId, sparePartId: id }).session(session),
    ]);
    if (usages.some(Boolean)) {
      throw new ApiError(httpStatus.BAD_REQUEST, SPARE_PART_MESSAGES.DELETE_IN_USE);
    }

    await SparePart.deleteOne({ _id: id, companyId }, { session });
    await session.commitTransaction();
    return sparePart;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const getSparePartDropdown = async filter => {
  const { SparePart } = getBooksModels();
  const { companyId, category, machineId } = filter;
  const query = { companyId, isActive: true };
  if (category) {
    query.category = category;
  }
  if (machineId) {
    query.fitsOnMachines = machineId;
  }

  const spareParts = await SparePart.find(query).select('_id code name category uom').sort({ name: 1 });

  // uom lives in the books-crm database, so it can't be populated across connections.
  const { ItemUnit } = getBooksCrmModels();
  const uomIds = [...new Set(spareParts.map(part => part.uom?.toString()).filter(Boolean))];
  const units = uomIds.length
    ? await ItemUnit.find({ _id: { $in: uomIds }, companyId })
        .select('name')
        .lean()
    : [];
  const unitMap = new Map(units.map(unit => [unit._id.toString(), { id: unit._id, name: unit.name }]));

  return spareParts.map(part => ({ ...part.toJSON(), uom: part.uom ? unitMap.get(part.uom.toString()) || null : null }));
};

module.exports = {
  createSparePart,
  getAllSpareParts,
  getSparePartById,
  updateSparePartById,
  updateActiveStatus,
  deleteSparePartById,
  getSparePartDropdown,
};
