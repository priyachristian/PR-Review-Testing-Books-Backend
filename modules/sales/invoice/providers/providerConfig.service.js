const { EINVOICE_PROVIDERS, THIRD_PARTY_PROVIDERS } = require('../../../../utils/enum');
const { getCommonModels } = require('../../../../services/model.service');
const { hasMastersIndiaCredentials } = require('../../../../utils/getMastersIndiaAuthToken');
const { getPortalCredentials } = require('../../../setting/thirdPartyCredentials/thirdPartyCredentials.service');

const isProviderAvailable = async (companyId, providerKey) => {
  if (providerKey === EINVOICE_PROVIDERS.MASTERS_INDIA) {
    return hasMastersIndiaCredentials();
  }
  if (providerKey === EINVOICE_PROVIDERS.FYNAMICS) {
    const credentials = await getPortalCredentials(companyId);
    return Boolean(credentials?.username && credentials?.password);
  }
  return false;
};

const getOrderedProviders = async companyId => {
  const { Company } = getCommonModels();
  const company = await Company.findById(companyId, { eInvoiceProvider: 1 }).lean();
  const isMastersIndiaPrimary = company?.eInvoiceProvider === EINVOICE_PROVIDERS.MASTERS_INDIA;
  const candidateOrder = isMastersIndiaPrimary
    ? [EINVOICE_PROVIDERS.MASTERS_INDIA, EINVOICE_PROVIDERS.FYNAMICS]
    : [EINVOICE_PROVIDERS.FYNAMICS];

  const checks = await Promise.all(candidateOrder.map(providerKey => isProviderAvailable(companyId, providerKey)));
  return candidateOrder.filter((_, index) => checks[index]);
};

const PROVIDER_KEY_BY_LABEL = {
  [THIRD_PARTY_PROVIDERS.MASTERS_INDIA]: EINVOICE_PROVIDERS.MASTERS_INDIA,
  [THIRD_PARTY_PROVIDERS.FYNAMICS]: EINVOICE_PROVIDERS.FYNAMICS,
};

const resolveProviderKey = (label, fallbackKey = EINVOICE_PROVIDERS.FYNAMICS) => PROVIDER_KEY_BY_LABEL[label] || fallbackKey;

module.exports = { getOrderedProviders, resolveProviderKey };
