/**
 * Fix bank transfer log currency fields by transaction type (idempotent repair).
 *
 * DEPOSIT    → currency from toBank only (removes extra transfer fields)
 * WITHDRAWAL → currency from fromBank only (removes extra transfer fields)
 * TRANSFER   → currency, fromCurrencyId, toCurrencyId, fromCurrency, toCurrency from banks
 *
 * Also fixes legacy string currency codes (e.g. "INR") → ObjectId.
 * Sets exchangeRate = 1 where missing/null.
 * Run migrate-bank-currency-id.js first.
 *
 *   node scripts/migrate-bank-transfer-log-currency-id.js
 *   node scripts/migrate-bank-transfer-log-currency-id.js --apply
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { getConnection } = require('../config/db');

const TXN = {
  DEPOSIT: 'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
  TRANSFER: 'TRANSFER',
};

const TRANSFER_ONLY_FIELDS = ['fromCurrencyId', 'toCurrencyId', 'fromCurrency', 'toCurrency'];

function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function buildUpdate(doc, fromBank, toBank, baseCurrency, currencyById) {
  const type = doc.transactionType;
  const companyKey = String(doc.companyId);
  const fromCur = fromBank?.currency || baseCurrency || null;
  const toCur = toBank?.currency || baseCurrency || null;
  const $set = {};
  const $unset = {};

  if (doc.exchangeRate == null) $set.exchangeRate = 1;

  if (type === TXN.DEPOSIT) {
    if (!toCur) return null;
    if (!sameId(doc.currency, toCur)) $set.currency = toCur;
    TRANSFER_ONLY_FIELDS.forEach(f => {
      if (doc[f] != null && doc[f] !== '') $unset[f] = '';
    });
  } else if (type === TXN.WITHDRAWAL) {
    if (!fromCur) return null;
    if (!sameId(doc.currency, fromCur)) $set.currency = fromCur;
    TRANSFER_ONLY_FIELDS.forEach(f => {
      if (doc[f] != null && doc[f] !== '') $unset[f] = '';
    });
  } else if (type === TXN.TRANSFER) {
    if (!fromCur || !toCur) return null;

    if (!sameId(doc.currency, toCur)) $set.currency = toCur;
    if (!sameId(doc.fromCurrencyId, fromCur)) $set.fromCurrencyId = fromCur;
    if (!sameId(doc.toCurrencyId, toCur)) $set.toCurrencyId = toCur;

    const fromCode = currencyById.get(String(fromCur))?.code;
    const toCode = currencyById.get(String(toCur))?.code;
    if (fromCode && doc.fromCurrency !== fromCode) $set.fromCurrency = fromCode;
    if (toCode && doc.toCurrency !== toCode) $set.toCurrency = toCode;
  } else {
    return null;
  }

  if (!Object.keys($set).length && !Object.keys($unset).length) return null;
  return { $set, $unset };
}

async function run() {
  const apply = process.argv.includes('--apply');
  let db;

  try {
    db = await getConnection();
    const coll = db.booksCrm.collection('banktransferlogs');

    const companies = await db.common
      .collection('companies')
      .find({ baseCurrency: { $ne: null } }, { projection: { _id: 1, baseCurrency: 1 } })
      .toArray();
    const baseByCompany = new Map(companies.map(c => [String(c._id), c.baseCurrency]));

    const currencies = await db.common.collection('currencies').find({}).project({ _id: 1, companyId: 1, code: 1 }).toArray();
    const currencyById = new Map(currencies.map(c => [String(c._id), c]));

    const docs = await coll
      .find({ transactionType: { $in: [TXN.DEPOSIT, TXN.WITHDRAWAL, TXN.TRANSFER] } })
      .project({
        _id: 1,
        companyId: 1,
        transactionType: 1,
        transactionDescription: 1,
        fromBankId: 1,
        toBankId: 1,
        currency: 1,
        exchangeRate: 1,
        fromCurrencyId: 1,
        toCurrencyId: 1,
        fromCurrency: 1,
        toCurrency: 1,
      })
      .toArray();

    const banks = docs.length
      ? await db.booksCrm
          .collection('banks')
          .find({ _id: { $in: docs.flatMap(d => [d.fromBankId, d.toBankId]).filter(Boolean) } })
          .project({ _id: 1, currency: 1, accountName: 1, bankName: 1 })
          .toArray()
      : [];
    const bankById = new Map(banks.map(b => [String(b._id), b]));

    const toUpdate = [];
    const skipped = [];

    for (const doc of docs) {
      const baseCurrency = baseByCompany.get(String(doc.companyId)) || null;
      const fromBank = doc.fromBankId ? bankById.get(String(doc.fromBankId)) : null;
      const toBank = doc.toBankId ? bankById.get(String(doc.toBankId)) : null;
      const update = buildUpdate(doc, fromBank, toBank, baseCurrency, currencyById);

      if (!update) {
        skipped.push(doc);
        continue;
      }

      toUpdate.push({ doc, update, fromBank, toBank });
    }

    console.log('--- Bank transfer log currency repair ---');
    console.log(`Scanned: ${docs.length}`);
    console.log(`To update: ${toUpdate.length}`);
    console.log(`Already correct: ${skipped.length}\n`);

    toUpdate.forEach(({ doc, update, fromBank, toBank }, i) => {
      const fromLabel = fromBank?.accountName || fromBank?.bankName || doc.fromBankId || '-';
      const toLabel = toBank?.accountName || toBank?.bankName || doc.toBankId || '-';
      const parts = [];
      if (Object.keys(update.$set).length) parts.push(`set=${JSON.stringify(update.$set)}`);
      if (Object.keys(update.$unset).length) parts.push(`unset=${JSON.stringify(Object.keys(update.$unset))}`);

      console.log(
        `${i + 1}. [${doc.transactionType}] _id=${doc._id} fromBank=${fromLabel} toBank=${toLabel} was currency=${JSON.stringify(doc.currency)} ${parts.join(' ')}`,
      );
    });

    if (!apply) {
      console.log('\nDry-run. Re-run with --apply to write.');
      return;
    }

    if (toUpdate.length === 0) return;

    const res = await coll.bulkWrite(
      toUpdate.map(({ doc, update }) => {
        const op = {};
        if (Object.keys(update.$set).length) op.$set = update.$set;
        if (Object.keys(update.$unset).length) op.$unset = update.$unset;
        return { updateOne: { filter: { _id: doc._id }, update: op } };
      }),
      { ordered: false },
    );

    console.log(`\nUpdated: ${res.modifiedCount ?? 0}`);
  } finally {
    if (db?.client) await db.client.close();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
