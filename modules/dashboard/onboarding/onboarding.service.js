const httpStatus = require('http-status');
const mongoose = require('mongoose');
const ApiError = require('../../../utils/ApiError');
const { getCommonModels, getBooksCrmModels, getBooksModels } = require('../../../services/model.service');
const { PAYMENT_ACCOUNT_CATEGORIES } = require('../../../utils/enum');

const STEP_KEYS = {
  ORG_DETAILS: 'orgDetails',
  ADD_ITEM: 'addItem',
  ADD_CUSTOMER: 'addCustomer',
  ADD_VENDOR: 'addVendor',
  SETUP_BANKING: 'setupBanking',
  INVITE_TEAM: 'inviteTeam',
  CREATE_INVOICE: 'createInvoice',
  CREATE_BILL: 'createBill',
};

const STEP_DEFS = [
  {
    key: STEP_KEYS.ORG_DETAILS,
    label: 'Add Organisation Details',
    description: 'Add your GSTIN, base currency, address and financial year so they auto-fill across transactions.',
    cta: { label: 'Add details', path: '/setting/profile' },
  },
  {
    key: STEP_KEYS.ADD_ITEM,
    label: 'Add your first item',
    description: 'Create the goods or services you sell or purchase.',
    cta: { label: 'Add item', path: '/item-master/new' },
  },
  {
    key: STEP_KEYS.ADD_CUSTOMER,
    label: 'Add your first customer',
    description: 'Add the business partners you transact with.',
    cta: { label: 'Add customer', path: '/customer-master/new' },
  },
  {
    key: STEP_KEYS.SETUP_BANKING,
    label: 'Setup banking',
    description: 'Add a bank or cash account to track money in and out.',
    cta: { label: 'Setup banking', path: '/banks/new' },
  },
  {
    key: STEP_KEYS.INVITE_TEAM,
    label: 'Invite your team',
    description: 'Invite users and give them access to your organisation.',
    cta: { label: 'Invite team', path: '/setting/users' },
  },
  {
    key: STEP_KEYS.CREATE_INVOICE,
    label: 'Create your first invoice',
    description: 'Bill your customers and start tracking receivables.',
    cta: { label: 'Create invoice', path: '/invoices/new' },
  },
  {
    key: STEP_KEYS.ADD_VENDOR,
    label: 'Add your first vendor',
    description: 'Add the business partners you transact with.',
    cta: { label: 'Add vendor', path: '/vendors/new' },
  },
  {
    key: STEP_KEYS.CREATE_BILL,
    label: 'Create your first bill',
    description: 'Record vendor bills to track payables.',
    cta: { label: 'Create bill', path: '/bills/new' },
  },
];

const toObjectId = id => new mongoose.Types.ObjectId(id);

const probeSteps = async companyId => {
  const cid = toObjectId(companyId);
  const { Company } = getCommonModels();
  const { Customer, Item } = getBooksCrmModels();
  const { Invoice, Bill, UserRole, Account } = getBooksModels();

  const [company, itemCount, customerCount, vendorCount, bankCount, teamUserIds, invoiceCount, billCount] = await Promise.all([
    Company.findById(cid).select('gstNumber panNumber baseCurrency address fiscalYear').lean(),
    Item.countDocuments({ companyId: cid }),
    Customer.countDocuments({ companyId: cid, 'Role.isCustomer': true }),
    Customer.countDocuments({ companyId: cid, 'Role.isVendor': true }),
    Account.countDocuments({
      companyId: cid,
      category: { $in: PAYMENT_ACCOUNT_CATEGORIES },
      'bankDetails.isPrimary': true,
      isActive: true,
    }),
    UserRole.distinct('userId', { companyId: cid }),
    Invoice.countDocuments({ companyId: cid }),
    Bill.countDocuments({ companyId: cid }),
  ]);

  if (!company) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Company not found');
  }

  const addr = company.address || {};
  const hasAddress = !!(addr.street1 && addr.country && addr.state && addr.city);
  const hasOrgDetails = !!(company.gstNumber || company.panNumber) && !!company.baseCurrency && hasAddress;

  const teamCount = Array.isArray(teamUserIds) ? teamUserIds.length : 0;

  return {
    [STEP_KEYS.ORG_DETAILS]: { autoDone: hasOrgDetails, count: hasOrgDetails ? 1 : 0 },
    [STEP_KEYS.ADD_ITEM]: { autoDone: itemCount > 0, count: itemCount },
    [STEP_KEYS.ADD_CUSTOMER]: { autoDone: customerCount > 0, count: customerCount },
    [STEP_KEYS.ADD_VENDOR]: { autoDone: vendorCount > 0, count: vendorCount },
    [STEP_KEYS.SETUP_BANKING]: { autoDone: bankCount > 0, count: bankCount },
    [STEP_KEYS.INVITE_TEAM]: { autoDone: teamCount > 1, count: teamCount },
    [STEP_KEYS.CREATE_INVOICE]: { autoDone: invoiceCount > 0, count: invoiceCount },
    [STEP_KEYS.CREATE_BILL]: { autoDone: billCount > 0, count: billCount },
  };
};

const getOnboardingStatus = async ({ companyId }) => {
  const probes = await probeSteps(companyId);

  const steps = STEP_DEFS.map(def => {
    const probe = probes[def.key] || { autoDone: false, count: 0 };
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      cta: def.cta,
      done: probe.autoDone,
      count: probe.count,
    };
  });

  const completedCount = steps.filter(s => s.done).length;
  const total = steps.length;
  const progress = total === 0 ? 0 : Math.round((completedCount / total) * 100);

  return { steps, total, completedCount, progress };
};

module.exports = {
  STEP_KEYS,
  getOnboardingStatus,
};
