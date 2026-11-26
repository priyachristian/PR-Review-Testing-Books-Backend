const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');
const { getCommonModels, getBooksCrmModels } = require('./model.service');

const CURRENCY_FIELDS = 'code symbol name exchangeRate decimalPlaces format';

const getCurrency = async (companyId, currencyId) => {
  const { Currency } = getCommonModels();
  const many = Array.isArray(currencyId);
  const ids = [...new Set((many ? currencyId : [currencyId]).filter(Boolean).map(String))];
  if (!ids.length) return many ? [] : null;

  const rows = await Currency.find({ _id: { $in: ids }, companyId })
    .select(CURRENCY_FIELDS)
    .lean();
  if (many) return rows;
  return rows.find(r => String(r._id) === String(currencyId)) || null;
};

const resolveTransactionCurrency = async ({ companyId, currencyId, customerId, vendorId }) => {
  const { Company } = getCommonModels();
  const { Customer } = getBooksCrmModels();
  const company = await Company.findById(companyId).select('baseCurrency').lean();

  const partyId = customerId || vendorId;

  const resolvedId =
    currencyId ||
    (partyId ? (await Customer.findById(partyId).select('otherDetails.currency').lean())?.otherDetails?.currency : null) ||
    company?.baseCurrency;

  if (!resolvedId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Currency is required');
  }

  const master = await getCurrency(companyId, resolvedId);
  if (!master) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid currency for this company');
  }

  const isBaseCurrency = String(resolvedId) === String(company?.baseCurrency);

  return {
    currency: master._id,
    exchangeRate: isBaseCurrency ? 1 : (master.exchangeRate ?? 1),
    decimalPlaces: master.decimalPlaces ?? null,
  };
};

const enrichDocumentCurrency = async (companyId, input) => {
  const docs = Array.isArray(input) ? input : [input];
  const masters = await getCurrency(companyId, docs.map(d => d.currency).filter(Boolean));
  const masterMap = new Map(masters.map(m => [String(m._id), m]));

  const enriched = docs.map(doc => {
    const master = doc.currency ? masterMap.get(String(doc.currency)) : null;
    const { exchangeRate, decimalPlaces, ...rest } = doc;
    return {
      ...rest,
      currency: master
        ? {
            _id: master._id,
            code: master.code,
            symbol: master.symbol,
            name: master.name,
            format: master.format ?? null,
            decimalPlaces: decimalPlaces ?? master.decimalPlaces ?? null,
            exchangeRate: exchangeRate ?? 1,
          }
        : null,
    };
  });

  return Array.isArray(input) ? enriched : enriched[0];
};

module.exports = {
  getCurrency,
  resolveTransactionCurrency,
  enrichDocumentCurrency,
};
