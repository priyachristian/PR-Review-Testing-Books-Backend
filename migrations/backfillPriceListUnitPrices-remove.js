/**
 * Adds `unitPrices` to price list item lines that have none.
 *
 * For every line in pricelists.items[] whose `unitPrices` is missing or empty, one entry is added:
 *   { itemUnitId: <items.itemUnitId of the line's item>, netPrice: <the line's own netPrice> }
 * Lines that already have `unitPrices`, or have no numeric `netPrice`, are never touched.
 * Lines whose item is missing or has no `itemUnitId` are skipped and reported.
 *
 * Re-running is safe: only lines still without `unitPrices` are considered.
 *
 * Run: node migrations/backfillPriceListUnitPrices-remove.js                      (report, all companies)
 *      node migrations/backfillPriceListUnitPrices-remove.js <companyId>           (report, one company)
 *      node migrations/backfillPriceListUnitPrices-remove.js --apply               (write, all companies)
 *      node migrations/backfillPriceListUnitPrices-remove.js <companyId> --apply   (write, one company)
 */
const { ObjectId } = require('mongodb');
const { getConnection } = require('../config/db');

const hasNoUnitPrices = line => !(line.unitPrices && line.unitPrices.length);

const migrate = async () => {
  let client;
  try {
    const db = await getConnection();
    client = db.client;

    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const companyArg = args.find(arg => !arg.startsWith('--'));
    const targetCompanyId = companyArg ? new ObjectId(companyArg) : null;
    const companyScope = targetCompanyId ? { companyId: targetCompanyId } : {};

    console.log(`\nScope  : ${targetCompanyId ? targetCompanyId.toString() : 'ALL COMPANIES'}`);
    console.log(apply ? 'Mode   : APPLYING CHANGES\n' : 'Mode   : report only — pass --apply to write\n');

    const priceLists = db.booksCrm.collection('pricelists');
    const items = db.booksCrm.collection('items');

    const priceListFilter = {
      ...companyScope,
      items: {
        $elemMatch: {
          netPrice: { $type: 'number' },
          $or: [{ unitPrices: { $exists: false } }, { unitPrices: { $size: 0 } }],
        },
      },
    };

    const docs = await priceLists.find(priceListFilter).toArray();
    console.log(`Price lists with lines missing unitPrices: ${docs.length}`);

    // item _id string -> item.itemUnitId (or null)
    const itemIds = [
      ...new Set(
        docs.flatMap(doc => doc.items.filter(line => hasNoUnitPrices(line) && line.itemId).map(line => line.itemId.toString())),
      ),
    ];
    const itemDocs = await items
      .find({ _id: { $in: itemIds.map(id => new ObjectId(id)) } })
      .project({ itemUnitId: 1 })
      .toArray();
    const unitByItemId = new Map(itemDocs.map(item => [item._id.toString(), item.itemUnitId || null]));

    const totals = { lines: 0, added: 0, skipped: 0, docsModified: 0 };
    const skippedSummary = []; // { priceListCode, itemId }

    for (const doc of docs) {
      const operations = {};

      doc.items.forEach((line, index) => {
        if (!hasNoUnitPrices(line) || typeof line.netPrice !== 'number') return;
        totals.lines += 1;

        const itemUnitId = line.itemId ? unitByItemId.get(line.itemId.toString()) : null;
        console.log(unitByItemId);
        if (!itemUnitId) {
          totals.skipped += 1;
          skippedSummary.push({ priceListCode: doc.priceListCode, itemId: line.itemId });
          return;
        }

        totals.added += 1;
        operations[`items.${index}.unitPrices`] = [{ _id: new ObjectId(), itemUnitId, netPrice: line.netPrice }];
      });

      if (apply && Object.keys(operations).length) {
        // eslint-disable-next-line no-await-in-loop
        const result = await priceLists.updateOne({ _id: doc._id }, { $set: operations });
        totals.docsModified += result.modifiedCount;
      }
    }

    console.log('\nSUMMARY');
    console.log(`   lines missing unitPrices        : ${totals.lines}`);
    console.log(`   unitPrices entry to add         : ${totals.added}`);
    console.log(`   skipped (item has no itemUnitId): ${totals.skipped}`);

    if (skippedSummary.length) {
      console.log('\nSKIPPED (price list code | itemId)');
      skippedSummary.forEach(({ priceListCode, itemId }) => console.log(`   ${priceListCode} | ${itemId}`));
    }

    if (!apply) {
      console.log('\nNothing was written. Re-run with --apply to backfill.\n');
      return;
    }

    console.log('\nWRITTEN');
    console.log(`   price lists modified : ${totals.docsModified}`);
    console.log('\nPrice list unitPrices backfill complete.\n');
  } catch (error) {
    console.error('Price list unitPrices backfill failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('MongoDB connection closed');
    }
  }
};

migrate();
