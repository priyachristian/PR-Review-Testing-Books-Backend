const httpStatus = require('http-status');
const moment = require('moment-timezone');
const { getBooksModels, getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const pick = require('../../../utils/pick');
const { createSearchRegex, escapeRegex } = require('../../../utils/regexUtils');
const { TAX_MESSAGES } = require('../../../utils/messages');

const TAX_STATUS = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  INACTIVE: 'INACTIVE',
};

const withSectionAndStatus = async taxes => {
  if (!taxes.length) return [];

  const { IncomeTaxSection } = getCommonModels();
  const sectionIds = [...new Set(taxes.map(tax => String(tax.sectionId)))];
  const sections = await IncomeTaxSection.find({ _id: { $in: sectionIds } })
    .select('sectionKey sectionNo name description oldSectionNo paymentCode')
    .lean();

  const sectionById = new Map(sections.map(section => [String(section._id), section]));
  const todayStart = moment.tz('Asia/Kolkata').startOf('day').toDate();

  return taxes.map(tax => {
    const section = sectionById.get(String(tax.sectionId));
    let status = TAX_STATUS.ACTIVE;

    if (!tax.isActive) {
      status = TAX_STATUS.INACTIVE;
    } else if (tax.endDate && tax.endDate < todayStart) {
      status = TAX_STATUS.EXPIRED;
    }

    return {
      ...tax.toJSON(),
      section: {
        id: String(section._id),
        ...pick(section, ['sectionKey', 'name', 'description', 'oldSectionNo', 'paymentCode']),
        sectionNo: `Section ${section.sectionNo}`,
      },
      status,
    };
  });
};

const findTax = async (taxId, companyId) => {
  const { Tax } = getBooksModels();
  const tax = await Tax.findOne({ _id: taxId, companyId });

  if (!tax) {
    throw new ApiError(httpStatus.NOT_FOUND, TAX_MESSAGES.NOT_FOUND);
  }

  return tax;
};

const queryTaxes = async query => {
  const { Tax } = getBooksModels();
  const filter = pick(query, ['companyId', 'type']);
  const options = pick(query, ['sortBy', 'limit', 'page', 'pagination']);

  if (query.search) {
    filter.taxName = createSearchRegex(query.search.trim());
  }

  const result = await Tax.paginate(filter, options);

  return {
    ...result,
    results: await withSectionAndStatus(result.results),
  };
};

const getTaxSections = async ({ type }) => {
  const { IncomeTaxSection } = getCommonModels();

  const sections = await IncomeTaxSection.find({ taxType: type })
    .select('sectionKey sectionNo name description oldSectionNo paymentCode')
    .sort({ paymentCode: 1 });

  return sections.map(section => ({
    ...section.toJSON(),
    sectionNo: `Section ${section.sectionNo}`,
  }));
};

// Active taxes whose period covers the document date, shaped as the document's tax snapshot.
const getTaxesDropdown = async ({ companyId, type, date }) => {
  const { Tax } = getBooksModels();
  const { IncomeTaxSection } = getCommonModels();

  const taxes = await Tax.find({
    companyId,
    type,
    isActive: true,
    startDate: { $lte: date },
    $or: [{ endDate: null }, { endDate: { $gte: date } }],
  })
    .select('type taxName taxRate sectionId')
    .sort({ taxName: 1 })
    .lean();

  const sectionIds = [...new Set(taxes.map(tax => String(tax.sectionId)))];
  const sections = await IncomeTaxSection.find({ _id: { $in: sectionIds } })
    .select('sectionNo name paymentCode')
    .lean();
  const sectionById = new Map(sections.map(section => [String(section._id), section]));

  return taxes.map(tax => {
    const section = sectionById.get(String(tax.sectionId));
    return {
      type: tax.type,
      taxId: tax._id,
      taxName: tax.taxName,
      sectionId: tax.sectionId,
      sectionNo: `Section ${section.sectionNo}`,
      sectionName: section.name,
      paymentCode: section.paymentCode,
      rate: tax.taxRate,
    };
  });
};

const createTax = async (body, userId) => {
  const { Tax } = getBooksModels();
  const { IncomeTaxSection } = getCommonModels();

  const isValidSection = await IncomeTaxSection.exists({
    _id: body.sectionId,
    taxType: body.type,
  });

  if (!isValidSection) {
    throw new ApiError(httpStatus.BAD_REQUEST, TAX_MESSAGES.INVALID_SECTION);
  }

  const isDuplicate = await Tax.exists({
    companyId: body.companyId,
    type: body.type,
    taxName: {
      $regex: new RegExp(`^${escapeRegex(body.taxName)}$`, 'i'),
    },
  });

  if (isDuplicate) {
    throw new ApiError(httpStatus.CONFLICT, TAX_MESSAGES.DUPLICATE_NAME);
  }

  const tax = await Tax.create({
    companyId: body.companyId,
    type: body.type,
    taxName: body.taxName,
    taxRate: body.taxRate,
    sectionId: body.sectionId,
    startDate: body.startDate,
    endDate: body.endDate,
    isActive: true,
    createdBy: userId,
  });

  const [result] = await withSectionAndStatus([tax]);
  return result;
};

const getTaxById = async (taxId, companyId) => {
  const tax = await findTax(taxId, companyId);
  const [result] = await withSectionAndStatus([tax]);

  return result;
};

const updateTaxById = async (taxId, updateBody, userId) => {
  const { Tax } = getBooksModels();
  const { IncomeTaxSection } = getCommonModels();
  const tax = await findTax(taxId, updateBody.companyId);

  if (updateBody.taxName !== undefined) {
    const isDuplicate = await Tax.exists({
      _id: { $ne: tax._id },
      companyId: tax.companyId,
      type: tax.type,
      taxName: {
        $regex: new RegExp(`^${escapeRegex(updateBody.taxName)}$`, 'i'),
      },
    });

    if (isDuplicate) {
      throw new ApiError(httpStatus.CONFLICT, TAX_MESSAGES.DUPLICATE_NAME);
    }

    tax.taxName = updateBody.taxName;
  }

  if (updateBody.sectionId !== undefined) {
    const isValidSection = await IncomeTaxSection.exists({
      _id: updateBody.sectionId,
      taxType: tax.type,
    });

    if (!isValidSection) {
      throw new ApiError(httpStatus.BAD_REQUEST, TAX_MESSAGES.INVALID_SECTION);
    }

    tax.sectionId = updateBody.sectionId;
  }

  if (updateBody.taxRate !== undefined) tax.taxRate = updateBody.taxRate;
  if (updateBody.startDate !== undefined) tax.startDate = updateBody.startDate;
  if (updateBody.endDate !== undefined) tax.endDate = updateBody.endDate;

  if (tax.endDate && tax.endDate < tax.startDate) {
    throw new ApiError(httpStatus.BAD_REQUEST, TAX_MESSAGES.END_BEFORE_START);
  }

  tax.updatedBy = userId;
  await tax.save();

  const [result] = await withSectionAndStatus([tax]);
  return result;
};

const updateTaxStatus = async (taxId, isActive, companyId, userId) => {
  const tax = await findTax(taxId, companyId);

  tax.isActive = isActive;
  tax.updatedBy = userId;
  await tax.save();

  const [result] = await withSectionAndStatus([tax]);
  return result;
};

const deleteTaxById = async (taxId, companyId) => {
  const tax = await findTax(taxId, companyId);
  await tax.deleteOne();

  return tax;
};

module.exports = {
  queryTaxes,
  getTaxSections,
  getTaxesDropdown,
  createTax,
  getTaxById,
  updateTaxById,
  updateTaxStatus,
  deleteTaxById,
};
