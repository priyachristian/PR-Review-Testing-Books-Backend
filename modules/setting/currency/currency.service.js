const httpStatus = require('http-status');
const { getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const pick = require('../../../utils/pick');
const { escapeRegex } = require('../../../utils/regexUtils');

const createCurrency = async body => {
  const { Currency } = getCommonModels();

  const existing = await Currency.findOne({ companyId: body.companyId, code: body.code?.toUpperCase() });
  if (existing) {
    throw new ApiError(httpStatus.CONFLICT, 'A currency with this code already exists for this company.');
  }

  return Currency.create(body);
};

const queryCurrencies = async query => {
  const { Currency, Company } = getCommonModels();
  const filter = pick(query, ['companyId']);
  const options = pick(query, ['sortBy', 'limit', 'page', 'pagination']);

  if (query.search) {
    const regex = new RegExp(escapeRegex(String(query.search).trim()), 'i');
    filter.$or = [{ code: regex }, { name: regex }, { symbol: regex }];
  }

  const companyPromise = Company.findById(filter?.companyId).select('baseCurrency').lean();
  const [result, company] = await Promise.all([Currency.paginate(filter, options), companyPromise]);
  const baseCurrencyId = company?.baseCurrency ? String(company.baseCurrency) : '';

  result.results = result.results.map(currency => ({
    ...currency.toObject(),
    isBaseCurrency: baseCurrencyId ? String(currency._id) === baseCurrencyId : false,
  }));

  return result;
};

const updateCurrencyById = async (currencyId, updateBody) => {
  const { Currency, Company } = getCommonModels();

  const currency = await Currency.findOne({ _id: currencyId, companyId: updateBody.companyId });
  if (!currency) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Currency not found');
  }

  if (updateBody.code) {
    const existing = await Currency.findOne({
      _id: { $ne: currencyId },
      companyId: currency.companyId,
      code: updateBody.code.toUpperCase(),
    });
    if (existing) {
      throw new ApiError(httpStatus.CONFLICT, 'A currency with this code already exists for this company.');
    }
  }

  const company = await Company.findById(updateBody.companyId).select('baseCurrency').lean();
  if (company?.baseCurrency && String(company.baseCurrency) === String(currencyId)) {
    updateBody.exchangeRate = null;
  }

  Object.assign(currency, updateBody);
  await currency.save();
  return currency;
};

const deleteCurrencyById = async (currencyId, companyId) => {
  const { Currency, Company } = getCommonModels();

  const currency = await Currency.findOne({ _id: currencyId, companyId });
  if (!currency) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Currency not found');
  }

  const company = await Company.findById(companyId).select('baseCurrency').lean();
  if (company?.baseCurrency && String(company.baseCurrency) === String(currencyId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete the base currency of the company');
  }

  await currency.deleteOne();
};

module.exports = {
  createCurrency,
  queryCurrencies,
  updateCurrencyById,
  deleteCurrencyById,
};
