const { escapeRegex } = require('./regexUtils');
const { ADDRESS_TYPES } = require('./enum');

const LOCATION_FIELDS = ['country', 'state', 'city'];

const customerAddresses = address => [address?.billing, address?.shipping, ...(address?.additionalShippingAddresses || [])];
// Billing for 'billTo'; shipping plus additional shipping addresses for 'shipTo'; all of them when no type is given
const customerAddressesOfType = (address, addressType) => {
  if (addressType === ADDRESS_TYPES.BILL_TO) return [address?.billing];
  if (addressType === ADDRESS_TYPES.SHIP_TO) return [address?.shipping, ...(address?.additionalShippingAddresses || [])];
  return customerAddresses(address);
};
const companyAddresses = company => [company?.address, ...(company?.additionalShippingAddresses || [])];

// Build { country|state|city: { $in: [regex] } } from the (comma separated) filters; null when none is applied
const buildLocationConditions = filter => {
  const conditions = {};
  LOCATION_FIELDS.forEach(field => {
    if (!filter[field]) return;
    const regexes = String(filter[field])
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => new RegExp(`^${escapeRegex(value)}$`, 'i'));
    if (regexes.length) conditions[field] = { $in: regexes };
  });
  return Object.keys(conditions).length ? conditions : null;
};

const matchesLocation = (conditions, address) =>
  Object.entries(conditions).every(([field, cond]) => cond.$in.some(re => re.test(address?.[field] || '')));

/**
 * Resolve the addressType and country/state/city filters to the matching customer address ids. A document's
 * root-level addressId is looked up in the customer's addresses: 'billTo' only considers the billing address,
 * 'shipTo' the shipping and additional shipping addresses, no type considers all of them.
 * Returns null when neither a type nor a location filter is applied.
 *
 * @param {Object} Customer - Customer model
 * @param {ObjectId} companyId
 * @param {{addressType?: string, country?: string, state?: string, city?: string}} filter - comma separated values allowed for location
 * @returns {Promise<ObjectId[]|null>}
 */
const getMatchingAddressIds = async (Customer, companyId, filter) => {
  const addressType = Object.values(ADDRESS_TYPES).includes(filter.addressType) ? filter.addressType : null;
  const conditions = buildLocationConditions(filter);
  if (!conditions && !addressType) return null;

  const prefixed = prefix =>
    Object.fromEntries(Object.entries(conditions || {}).map(([field, cond]) => [`${prefix}${field}`, cond]));

  const customerQuery = { companyId };
  if (conditions) {
    const byPath = {
      [ADDRESS_TYPES.BILL_TO]: [prefixed('address.billing.')],
      [ADDRESS_TYPES.SHIP_TO]: [
        prefixed('address.shipping.'),
        { 'address.additionalShippingAddresses': { $elemMatch: conditions } },
      ],
    };
    customerQuery.$or = byPath[addressType] || [...byPath[ADDRESS_TYPES.BILL_TO], ...byPath[ADDRESS_TYPES.SHIP_TO]];
  }

  const customers = await Customer.find(customerQuery).select('address').lean();

  const ids = [];
  customers.forEach(({ address }) => {
    customerAddressesOfType(address, addressType).forEach(addr => {
      if (addr?._id && matchesLocation(conditions || {}, addr)) ids.push(addr._id);
    });
  });
  return ids;
};

/**
 * Query condition for the sales document lists' addressType + country/state/city filters; null when none applies.
 * A document's addressId points at the shipping-side address picked on it, so 'shipTo' matches on addressId. The
 * billing address is the customer's own and isn't referenced by addressId, so 'billTo' matches the documents of
 * customers whose billing address satisfies the location filters. Without a type, either one may match.
 *
 * @param {Object} Customer - Customer model
 * @param {ObjectId} companyId
 * @param {{addressType?: string, country?: string, state?: string, city?: string}} filter
 * @param {string} [partyField] - document field holding the customer/vendor used for 'billTo'
 * @returns {Promise<Object|null>}
 */
const getAddressFilterCondition = async (Customer, companyId, filter, partyField = 'customerId') => {
  const conditions = buildLocationConditions(filter);
  const billingCondition = async () => {
    const billingQuery = Object.fromEntries(
      Object.entries(conditions).map(([field, cond]) => [`address.billing.${field}`, cond]),
    );
    const customers = await Customer.find({ companyId, ...billingQuery })
      .select('_id')
      .lean();
    return { [partyField]: { $in: customers.map(customer => customer._id) } };
  };
  const shippingCondition = async () => {
    const addressIds = await getMatchingAddressIds(Customer, companyId, { ...filter, addressType: ADDRESS_TYPES.SHIP_TO });
    return { addressId: { $in: addressIds } };
  };

  if (filter.addressType === ADDRESS_TYPES.BILL_TO) return conditions ? billingCondition() : null;
  if (filter.addressType === ADDRESS_TYPES.SHIP_TO) return conditions ? shippingCondition() : null;
  if (!conditions) return null;
  // No type: either the billing address or the shipping-side address picked on the document satisfies the filters
  const [billing, shipping] = await Promise.all([billingCondition(), shippingCondition()]);
  return { $or: [billing, shipping] };
};

/**
 * Query condition for documents without an address picked on them (payments): country/state/city filters match the
 * billing address of the customer/vendor in `partyField`. Null when no location filter is applied.
 *
 * @param {Object} Customer - Customer model
 * @param {ObjectId} companyId
 * @param {{country?: string, state?: string, city?: string}} filter
 * @param {string} partyField - document field holding the customer/vendor id
 * @returns {Promise<Object|null>}
 */
const getBillingLocationCondition = (Customer, companyId, filter, partyField) =>
  getAddressFilterCondition(Customer, companyId, { ...filter, addressType: ADDRESS_TYPES.BILL_TO }, partyField);

/**
 * Find an address by id among a customer's billing, shipping and additional shipping addresses.
 *
 * @param {Object} address - customer.address
 * @param {ObjectId|string} addressId
 * @returns {Object|null}
 */
const findAddressById = (address, addressId) => {
  if (!addressId) return null;
  return customerAddresses(address).find(addr => addr?._id?.toString() === addressId.toString()) || null;
};

/**
 * Build an addressId -> address map from the billing/shipping/additional shipping addresses of the given customers.
 *
 * @param {Object} Customer - Customer model
 * @param {Array} customerIds
 * @returns {Promise<Object>}
 */
const getCustomerAddressMap = async (Customer, customerIds) => {
  const ids = customerIds.filter(Boolean);
  if (!ids.length) return {};
  const customers = await Customer.find({ _id: { $in: ids } })
    .select('address')
    .lean();
  const map = {};
  customers.forEach(({ address }) => {
    customerAddresses(address).forEach(addr => {
      if (addr?._id) map[addr._id.toString()] = addr;
    });
  });
  return map;
};

const fetchCompanyAddresses = (Company, companyId) =>
  Company.findById(companyId).select('address additionalShippingAddresses').lean();

/**
 * Resolve the country/state/city filters to the matching ids among company.address and
 * company.additionalShippingAddresses (documents such as expenses point addressId at the company's addresses).
 * Returns null when no location filter is applied.
 *
 * @param {Object} Company - Company model
 * @param {ObjectId|string} companyId
 * @param {{country?: string, state?: string, city?: string}} filter - comma separated values allowed
 * @returns {Promise<ObjectId[]|null>}
 */
const getMatchingCompanyAddressIds = async (Company, companyId, filter) => {
  const conditions = buildLocationConditions(filter);
  if (!conditions) return null;

  const company = await fetchCompanyAddresses(Company, companyId);
  return companyAddresses(company)
    .filter(addr => addr?._id && matchesLocation(conditions, addr))
    .map(addr => addr._id);
};

/**
 * Build a resolver that finds a document's addressId in company.address / company.additionalShippingAddresses.
 *
 * @param {Object} Company - Company model
 * @param {ObjectId|string} companyId
 * @returns {Promise<function(Object): Object|null>}
 */
const getCompanyAddressResolver = async (Company, companyId) => {
  const company = await fetchCompanyAddresses(Company, companyId);
  return doc => {
    if (!doc.addressId) return null;
    return companyAddresses(company).find(addr => addr?._id?.toString() === doc.addressId.toString()) || null;
  };
};

/**
 * Query condition for the purchase document lists' addressType + country/state/city filters; null when none applies.
 * 'billTo' matches the documents whose vendor's billing address satisfies the location filters; 'shipTo' matches
 * addressId (no type: either one): the drop-ship customer's shipping / additional shipping addresses when `customer` is set, else the
 * company's address / additional shipping addresses.
 *
 * @param {Object} Customer - Customer model
 * @param {Object} Company - Company model
 * @param {ObjectId} companyId
 * @param {{addressType?: string, country?: string, state?: string, city?: string}} filter
 * @param {string} [vendorField] - document field holding the vendor ('vendor', 'vendorId' on debit notes)
 * @returns {Promise<Object|null>}
 */
const getPurchaseAddressCondition = async (Customer, Company, companyId, filter, vendorField = 'vendor') => {
  const conditions = buildLocationConditions(filter);
  if (!conditions) return null;
  if (filter.addressType === ADDRESS_TYPES.BILL_TO) {
    return getAddressFilterCondition(Customer, companyId, filter, vendorField);
  }

  const shipping = await getPurchaseShippingCondition(Customer, Company, companyId, filter, conditions);
  if (filter.addressType === ADDRESS_TYPES.SHIP_TO) return shipping;
  // No type: the vendor's billing address or the shipping address on the document may match
  const billing = await getAddressFilterCondition(
    Customer,
    companyId,
    { ...filter, addressType: ADDRESS_TYPES.BILL_TO },
    vendorField,
  );
  return { $or: [billing, shipping] };
};

const getPurchaseShippingCondition = async (Customer, Company, companyId, filter, conditions) => {
  const [customerAddressIds, company] = await Promise.all([
    getMatchingAddressIds(Customer, companyId, { ...filter, addressType: ADDRESS_TYPES.SHIP_TO }),
    fetchCompanyAddresses(Company, companyId),
  ]);
  const companyAddressIds = companyAddresses(company)
    .filter(addr => addr?._id && matchesLocation(conditions, addr))
    .map(addr => addr._id);
  return {
    $or: [
      { customer: { $ne: null }, addressId: { $in: customerAddressIds } },
      { customer: null, addressId: { $in: companyAddressIds } },
    ],
  };
};

/**
 * Expense variant: addressId always points at the company's addresses, so only 'billTo' (vendor billing address)
 * differs from getMatchingCompanyAddressIds.
 */
const getExpenseAddressCondition = async (Customer, Company, companyId, filter) => {
  if (filter.addressType === ADDRESS_TYPES.BILL_TO) {
    return getAddressFilterCondition(Customer, companyId, filter, 'vendor');
  }
  const addressIds = await getMatchingCompanyAddressIds(Company, companyId, filter);
  if (!addressIds) return null;
  const shipping = { addressId: { $in: addressIds } };
  if (filter.addressType === ADDRESS_TYPES.SHIP_TO) return shipping;
  // No type: the vendor's billing address or the company address on the expense may match
  const billing = await getAddressFilterCondition(
    Customer,
    companyId,
    { ...filter, addressType: ADDRESS_TYPES.BILL_TO },
    'vendor',
  );
  return { $or: [billing, shipping] };
};

/**
 * Resolve a purchase document's addressId: from the drop-ship customer's addresses when `customer` has a value,
 * otherwise from company.address / company.additionalShippingAddresses.
 *
 * @param {Object} Customer - Customer model
 * @param {Object} Company - Company model
 * @param {ObjectId} companyId
 * @param {Array<{customer?: any}>} documents
 * @returns {Promise<function(Object): Object|null>} resolver taking a document and returning its address
 */
const getPurchaseAddressResolver = async (Customer, Company, companyId, documents) => {
  const customerIdOf = doc => doc.customer?._id?.toString() || doc.customer?.toString();
  const customerIds = [...new Set(documents.map(customerIdOf).filter(Boolean))];
  const [customers, company] = await Promise.all([
    customerIds.length
      ? Customer.find({ _id: { $in: customerIds } })
          .select('address')
          .lean()
      : [],
    Company.findById(companyId).select('address additionalShippingAddresses').lean(),
  ]);
  const customerMap = Object.fromEntries(customers.map(customer => [customer._id.toString(), customer]));

  return doc => {
    if (!doc.addressId) return null;
    const customerId = customerIdOf(doc);
    if (customerId) return findAddressById(customerMap[customerId]?.address, doc.addressId);
    return companyAddresses(company).find(addr => addr?._id?.toString() === doc.addressId.toString()) || null;
  };
};

module.exports = {
  getMatchingAddressIds,
  getAddressFilterCondition,
  getBillingLocationCondition,
  getCustomerAddressMap,
  findAddressById,
  getPurchaseAddressCondition,
  getExpenseAddressCondition,
  getPurchaseAddressResolver,
  getMatchingCompanyAddressIds,
  getCompanyAddressResolver,
};
