/**
 * Repair documents that carry BOTH intra-state (SGST/CGST) and inter-state (IGST) tax.
 *
 * Both fields describe the same tax, so a document holding both doubles the tax when
 * it is posted to the ledger. The correct pair is decided the same way the document
 * totals are validated: by comparing the company's GSTIN/state with the customer's,
 * then the inapplicable fields are zeroed. Amounts themselves are never changed —
 * totalTax, subTotal and total stay exactly as they are.
 *
 * Reports (does not write) unless --apply is passed.
 *
 * Run: node migrations/fixDocumentTaxSplit.js                     (report, all companies)
 *      node migrations/fixDocumentTaxSplit.js <companyId>         (report, one company)
 *      node migrations/fixDocumentTaxSplit.js <companyId> --apply (write)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const rajatbhaiCompanyId = '69c90d21c86df473a32b1e4a';
const adarshCompanyId = '6836dc3df550bf7dae8cd010';

const EXCLUDED_COMPANY_IDS = [rajatbhaiCompanyId, adarshCompanyId];

const excludedObjectIds = EXCLUDED_COMPANY_IDS.map(id => new ObjectId(id));
const isCompanyExcluded = companyId => excludedObjectIds.some(excluded => excluded.equals(companyId));

const TARGETS = [
  { db: 'books', collection: 'invoices', party: 'customerId' },
  { db: 'books', collection: 'creditnotes', party: 'customerId' },
  { db: 'books', collection: 'deliverychallans', party: 'customerId' },
  { db: 'booksCrm', collection: 'quotes', party: 'customerId' },
  { db: 'booksCrm', collection: 'salesorders', party: 'customerId' },
  { db: 'books', collection: 'bills', party: 'vendorId' },
  { db: 'books', collection: 'debitnotes', party: 'vendorId' },
  { db: 'books', collection: 'purchaseorders', party: 'vendorId' },
  { db: 'books', collection: 'grpoorders', party: 'vendorId' },
];

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const normalizeState = state =>
  typeof state === 'string'
    ? state
        .replace(/^\[[A-Z]{2,5}\]\s*-\s*/i, '')
        .trim()
        .toLowerCase()
    : '';

const isInterState = ({ companyState, partyState, companyGstin, partyGstin }) => {
  if (companyGstin && partyGstin) {
    return companyGstin.substring(0, 2) !== partyGstin.substring(0, 2);
  }
  const company = normalizeState(companyState);
  const party = normalizeState(partyState);
  if (!company || !party) return false;
  return company !== party;
};

const migrate = async () => {
  let client;
  try {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const targetCompanyId = args.find(arg => !arg.startsWith('--'))
      ? new ObjectId(args.find(arg => !arg.startsWith('--')))
      : null;

    if (targetCompanyId && isCompanyExcluded(targetCompanyId)) {
      console.log(`Company ${targetCompanyId} is in EXCLUDED_COMPANY_IDS — nothing to do.`);
      return;
    }

    const companyScope = targetCompanyId
      ? { companyId: targetCompanyId }
      : excludedObjectIds.length
        ? { companyId: { $nin: excludedObjectIds } }
        : {};

    const db = await getConnection();
    client = db.client;
    console.log(`Connected to MongoDB — ${apply ? 'APPLYING CHANGES' : 'report only (pass --apply to write)'}`);
    if (!targetCompanyId && excludedObjectIds.length) {
      console.log(`Excluding ${excludedObjectIds.length} company(ies): ${excludedObjectIds.map(String).join(', ')}`);
    }

    const companies = new Map();
    const customers = new Map();

    for (const target of TARGETS) {
      const collection = db[target.db].collection(target.collection);

      // Documents holding both representations of the same tax.
      const documents = await collection
        .find({
          ...companyScope,
          igst: { $gt: 0 },
          $or: [{ sgst: { $gt: 0 } }, { cgst: { $gt: 0 } }],
        })
        .project({ _id: 1, companyId: 1, sgst: 1, cgst: 1, igst: 1, totalTax: 1, [target.party]: 1 })
        .toArray();

      let intra = 0;
      let inter = 0;
      let skipped = 0;

      for (const document of documents) {
        const companyId = document.companyId?.toString();
        if (!companies.has(companyId)) {
          companies.set(companyId, await db.common.collection('companies').findOne({ _id: document.companyId }));
        }
        const company = companies.get(companyId);

        const partyId = document[target.party]?.toString();
        if (partyId && !customers.has(partyId)) {
          customers.set(partyId, await db.booksCrm.collection('customers').findOne({ _id: document[target.party] }));
        }
        const party = partyId ? customers.get(partyId) : null;

        const taxTotal = round2(document.totalTax);
        const intraTotal = round2((document.sgst || 0) + (document.cgst || 0));
        const interTotal = round2(document.igst);

        // Only repair when both sides genuinely describe the same total tax.
        if (taxTotal === 0 || intraTotal !== taxTotal || interTotal !== taxTotal) {
          skipped += 1;
          continue;
        }

        const useInterState = isInterState({
          companyState: company?.address?.state,
          partyState: party?.address?.shipping?.state,
          companyGstin: company?.gstNumber,
          partyGstin: party?.otherDetails?.gstinUin || party?.otherDetails?.registeredBusinessValue,
        });

        const update = useInterState ? { sgst: 0, cgst: 0 } : { igst: 0 };
        if (apply) {
          await collection.updateOne({ _id: document._id }, { $set: update });
        }
        if (useInterState) inter += 1;
        else intra += 1;
      }

      console.log(
        `${target.collection}: ${documents.length} with both — ${intra} kept intra-state (IGST cleared), ${inter} kept inter-state (SGST/CGST cleared), ${skipped} skipped as inconsistent`,
      );
    }

    console.log(apply ? 'Tax split repair completed successfully!' : 'Report complete — no changes were written.');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
