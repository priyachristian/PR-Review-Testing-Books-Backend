/**
 * One-time migration script:
 * - Ensures default currencies exist for a company in Common DB (`currencies` collection)
 * - Sets company.baseCurrency based on company.address.country (ISO/name aware)
 *
 * Phase 2 currency migration run order (use --dry-run first on each):
 *   0. migrate-company-empty-country.js          (empty address.country → India)
 *   1. migrate-company-default-currencies.js
 *   2. migrate-customer-vendor-currency-id.js
 *   3. migrate-transaction-currency-default.js
 *   4. migrate-price-list-currency-id.js
 *   5. migrate-opening-balance-currency-default.js
 *   6. migrate-payment-currency-default.js
 *   7. migrate-bank-currency-id.js
 *   8. migrate-bank-transfer-log-currency-id.js
 *   9. migrate-manual-journal-currency-id.js
 *  10. migrate-account-currency-default.js
 *
 * Usage:
 *   NODE_ENV=development node scripts/migrate-company-default-currencies.js
 *   NODE_ENV=development node scripts/migrate-company-default-currencies.js --all
 *   NODE_ENV=development node scripts/migrate-company-default-currencies.js --companyId=6807613f8ae03f454c934df1
 *   NODE_ENV=development node scripts/migrate-company-default-currencies.js --companyId=6807613f8ae03f454c934df1 --dry-run
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const DEFAULT_COMPANY_CURRENCIES = [
  { code: 'AED', symbol: 'AED', name: 'UAE Dirham', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'AUD', symbol: '$', name: 'Australian Dollar', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'CAD', symbol: '$', name: 'Canadian Dollar', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'CNY', symbol: 'CNY', name: 'Yuan Renminbi', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'EUR', symbol: '€', name: 'Euro', decimalPlaces: 2, format: '1.234.567,89' },
  { code: 'GBP', symbol: '£', name: 'Pound Sterling', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', decimalPlaces: 2, format: '1,23,45,678.90' },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'SAR', symbol: 'SAR', name: 'Saudi Riyal', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'USD', symbol: '$', name: 'United States Dollar', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'YER', symbol: 'YER', name: 'Yemeni Rial', decimalPlaces: 2, format: '1,234,567.89' },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', decimalPlaces: 2, format: '1,234,567.89' },
];

const COUNTRY_TO_CURRENCY_CODE = {
  IN: 'INR',
  AE: 'AED',
  AU: 'AUD',
  CA: 'CAD',
  CN: 'CNY',
  EU: 'EUR',
  FR: 'EUR',
  DE: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  GB: 'GBP',
  JP: 'JPY',
  SA: 'SAR',
  US: 'USD',
  YE: 'YER',
  ZA: 'ZAR',
};

const COUNTRY_NAME_TO_ISO = {
  INDIA: 'IN',
  UAE: 'AE',
  'UNITED ARAB EMIRATES': 'AE',
  AUSTRALIA: 'AU',
  CANADA: 'CA',
  CHINA: 'CN',
  EUROPE: 'EU',
  FRANCE: 'FR',
  GERMANY: 'DE',
  ITALY: 'IT',
  SPAIN: 'ES',
  UK: 'GB',
  'UNITED KINGDOM': 'GB',
  JAPAN: 'JP',
  KSA: 'SA',
  'SAUDI ARABIA': 'SA',
  USA: 'US',
  'UNITED STATES': 'US',
  'UNITED STATES OF AMERICA': 'US',
  YEMEN: 'YE',
  'SOUTH AFRICA': 'ZA',
};

function parseArgs() {
  const args = process.argv.slice(2);
  let companyId = null;
  let runAll = true;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--companyId=')) {
      companyId = arg.split('=')[1]?.trim();
      runAll = false;
    } else if (arg === '--all') {
      runAll = true;
      companyId = null;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }
  return { companyId, runAll, dryRun };
}

function normalizeCountryValue(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function resolveCountryIsoCode(country) {
  if (!country) return null;

  if (typeof country === 'object') {
    const possibleCode = country.isoCode || country.iso2 || country.code || country.countryCode || country.shortName;
    const normalizedCode = normalizeCountryValue(possibleCode);
    if (COUNTRY_TO_CURRENCY_CODE[normalizedCode]) return normalizedCode;

    const normalizedName = normalizeCountryValue(country.name || country.country || country.label || country.value);
    return COUNTRY_NAME_TO_ISO[normalizedName] || null;
  }

  const normalized = normalizeCountryValue(country);
  if (COUNTRY_TO_CURRENCY_CODE[normalized]) return normalized;
  return COUNTRY_NAME_TO_ISO[normalized] || null;
}

function getCurrencyCodeByCountry(country) {
  const isoCode = resolveCountryIsoCode(country);
  return isoCode ? COUNTRY_TO_CURRENCY_CODE[isoCode] || null : null;
}

async function migrateSingleCompany({ companies, currencies, company, dryRun }) {
  const companyObjectId = company._id;
  const companyId = String(companyObjectId);

  const existing = await currencies.find({ companyId: companyObjectId }).toArray();
  const existingByCode = new Map(existing.map(row => [String(row.code || '').toUpperCase(), row]));

  const now = new Date();
  const updatesMeta = {
    userId: company.addedBy || null,
    updatedAt: now,
  };

  const toInsert = DEFAULT_COMPANY_CURRENCIES.filter(cur => !existingByCode.has(cur.code)).map(cur => ({
    companyId: companyObjectId,
    ...cur,
    createdAt: now,
    updatedAt: now,
    ...(company.addedBy ? { addedBy: company.addedBy } : {}),
    updatedBy: [updatesMeta],
  }));

  if (!dryRun && toInsert.length > 0) {
    const insertResult = await currencies.insertMany(toInsert);
    console.log(`[Currency Migration] [${companyId}] Inserted ${Object.keys(insertResult.insertedIds || {}).length} currencies`);
  }

  const allCurrencies =
    toInsert.length > 0 && !dryRun ? await currencies.find({ companyId: companyObjectId }).toArray() : existing;
  const allByCode = new Map(allCurrencies.map(row => [String(row.code || '').toUpperCase(), row]));

  const countryValue = company?.address?.country;
  const countryCurrencyCode = getCurrencyCodeByCountry(countryValue);
  const fallbackCode =
    DEFAULT_COMPANY_CURRENCIES.find(currency => currency.code === 'INR')?.code || DEFAULT_COMPANY_CURRENCIES[0]?.code;
  const selectedCode = countryCurrencyCode && allByCode.has(countryCurrencyCode) ? countryCurrencyCode : fallbackCode;
  const selectedCurrency = allByCode.get(selectedCode) || allByCode.get(fallbackCode) || allCurrencies[0];
  const dryRunCurrency =
    selectedCurrency ||
    toInsert.find(currency => currency.code === selectedCode) ||
    toInsert.find(currency => currency.code === fallbackCode) ||
    toInsert[0];

  if (!dryRun && !selectedCurrency?._id) {
    throw new Error(`Unable to resolve base currency after seeding for company ${companyId}`);
  }

  console.log(
    `[Currency Migration] [${companyId}] Existing=${existing.length}, ToInsert=${toInsert.length}, Country=${JSON.stringify(countryValue)}, Base=${selectedCode}`,
  );

  if (!dryRun) {
    await companies.updateOne(
      { _id: companyObjectId },
      {
        $set: {
          baseCurrency: selectedCurrency._id,
          updatedAt: now,
        },
        $push: {
          updatedBy: updatesMeta,
        },
      },
    );
  }

  return {
    insertedCount: toInsert.length,
    baseCurrencyId: selectedCurrency?._id ? String(selectedCurrency._id) : dryRunCurrency?.code || null,
  };
}

async function run() {
  const { companyId, runAll, dryRun } = parseArgs();
  if (!runAll && (!companyId || !ObjectId.isValid(companyId))) {
    throw new Error(`Invalid companyId: ${companyId}`);
  }

  console.log(
    `[Currency Migration] Start${runAll ? ' for ALL companies' : ` for companyId=${companyId}`}${dryRun ? ' (DRY RUN)' : ''}`,
  );

  let client;
  try {
    const db = await getConnection();
    client = db.client;
    const commonDb = db.common;

    const companies = commonDb.collection('companies');
    const currencies = commonDb.collection('currencies');
    const companyQuery = runAll ? {} : { _id: new ObjectId(companyId) };
    const cursor = companies.find(companyQuery, { projection: { _id: 1, addedBy: 1, address: 1 } });

    let processed = 0;
    let totalInserted = 0;
    let failed = 0;

    while (await cursor.hasNext()) {
      const company = await cursor.next();
      try {
        const result = await migrateSingleCompany({ companies, currencies, company, dryRun });
        processed += 1;
        totalInserted += result.insertedCount;
      } catch (error) {
        failed += 1;
        console.error(`[Currency Migration] [${String(company?._id)}] Failed: ${error.message}`);
      }
    }

    console.log(`[Currency Migration] Completed. Processed=${processed}, Failed=${failed}, TotalInserted=${totalInserted}`);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

run()
  .then(() => {
    console.log('[Currency Migration] Done');
    process.exit(0);
  })
  .catch(error => {
    console.error('[Currency Migration] Failed:', error.message);
    process.exit(1);
  });
