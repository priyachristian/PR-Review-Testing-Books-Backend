const { EINVOICE_PROVIDERS } = require('../../../../utils/enum');
const { MastersIndiaProvider } = require('./mastersIndia.provider');
const { FynamicsProvider } = require('./fynamics.provider');

const PROVIDER_REGISTRY = {
  [EINVOICE_PROVIDERS.MASTERS_INDIA]: MastersIndiaProvider,
  [EINVOICE_PROVIDERS.FYNAMICS]: FynamicsProvider,
};

const providerInstances = new Map();

const getProviderInstance = providerKey => {
  const ProviderClass = PROVIDER_REGISTRY[providerKey];
  if (!ProviderClass) {
    throw new Error(`No provider adapter registered for "${providerKey}"`);
  }
  if (!providerInstances.has(providerKey)) {
    providerInstances.set(providerKey, new ProviderClass());
  }
  return providerInstances.get(providerKey);
};

module.exports = { PROVIDER_REGISTRY, getProviderInstance };
