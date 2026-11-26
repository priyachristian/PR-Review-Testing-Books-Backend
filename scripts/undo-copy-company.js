/**
 * Undo a company data copy — deletes ALL data for a given companyId across
 * all databases (books-crm, books, crm, common settings).
 *
 * USE WITH CAUTION: This is destructive and cannot be reversed.
 * Only use this to clean up a target company that was populated by copy-company.js.
 *
 * Usage:
 *   node scripts/undo-copy-company.js --target=<targetCompanyId> [--confirm]
 *
 * The --confirm flag is required to actually delete. Without it the script runs
 * in dry-run mode and only prints what would be deleted.
 *
 * Example (dry-run first, then real delete):
 *   NODE_ENV=development node scripts/undo-copy-company.js --target=64f9e8d7c6b5a4329abcdef1
 *   NODE_ENV=development node scripts/undo-copy-company.js --target=64f9e8d7c6b5a4329abcdef1 --confirm
 */

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

require('../config/config');

const mongoose = require('mongoose');
const readline = require('readline');
const { getModelsAndConnections } = require('@smit9313/abss-models-core');

// ─── CLI ARGS ────────────────────────────────────────────────────────────────

function parseArgs() {
  const result = {};
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--(\w+)=?(.*)$/);
    if (match) result[match[1]] = match[2] || true;
  }
  return result;
}

// ─── PROMPT ──────────────────────────────────────────────────────────────────

function prompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── DELETE COLLECTION ───────────────────────────────────────────────────────

/**
 * Count (dry-run) or delete all documents for the given companyId.
 */
async function deleteCollection(Model, companyId, isDryRun, label) {
  if (!Model) {
    return { label: label || '?', count: 0, skipped: true };
  }

  const name = label || Model.modelName;
  const filter = { companyId: new mongoose.Types.ObjectId(companyId) };
  const count = await Model.countDocuments(filter);

  if (count === 0) {
    console.log(`  - ${name}: 0 docs`);
    return { label: name, count: 0 };
  }

  if (isDryRun) {
    console.log(`  ~ ${name}: ${count} docs would be deleted`);
  } else {
    await Model.deleteMany(filter);
    console.log(`  ✓ ${name}: ${count} docs deleted`);
  }

  return { label: name, count };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const TARGET = args.target;
  const isDryRun = !args.confirm;

  if (!TARGET) {
    console.error('Usage: node scripts/undo-copy-company.js --target=<companyId> [--confirm]');
    process.exit(1);
  }

  console.log('\n========================================');
  console.log('     ABSS — Undo Copy Company Script');
  console.log('========================================');
  console.log(`Target  : ${TARGET}`);
  console.log(`Mode    : ${isDryRun ? 'DRY-RUN (no changes)' : 'LIVE DELETE'}`);
  console.log(`Env     : ${process.env.NODE_ENV}\n`);

  if (isDryRun) {
    console.log('Running in DRY-RUN mode — nothing will be deleted.');
    console.log('Add --confirm to perform actual deletion.\n');
  } else {
    // Safety confirmation prompt
    console.log('WARNING: This will permanently delete ALL data for this company.');
    console.log('This cannot be undone.\n');
    const answer = await prompt(`Type the target company ID to confirm deletion: `);
    if (answer !== TARGET) {
      console.log('\nConfirmation failed. Aborting.');
      process.exit(1);
    }
    console.log();
  }

  console.log('Connecting to databases...');
  const { models } = await getModelsAndConnections();
  console.log('Connected.\n');

  const BC = models['books-crm'];
  const B = models['books'];
  const C = models['crm'];
  const CM = models['common'];

  const startTime = Date.now();
  let totalDocs = 0;

  const track = result => {
    totalDocs += result.count;
  };

  // ── Common ────────────────────────────────────────────────────────────────
  console.log('Common DB');
  if (CM?.CompanySettings) {
    const filter = { companyId: new mongoose.Types.ObjectId(TARGET) };
    const count = await CM.CompanySettings.countDocuments(filter);
    if (count > 0) {
      if (isDryRun) {
        console.log(`  ~ CompanySettings: ${count} docs would be deleted`);
      } else {
        await CM.CompanySettings.deleteMany(filter);
        console.log(`  ✓ CompanySettings: ${count} docs deleted`);
      }
      totalDocs += count;
    } else {
      console.log('  - CompanySettings: 0 docs');
    }
  }

  // ── CRM ───────────────────────────────────────────────────────────────────
  console.log('\nCRM DB');
  if (C) {
    track(await deleteCollection(C.UserRole, TARGET, isDryRun, 'CRM.UserRole'));
    track(await deleteCollection(C.Lead, TARGET, isDryRun, 'Lead'));
    track(await deleteCollection(C.Campaign, TARGET, isDryRun, 'Campaign'));
    track(await deleteCollection(C.Platform, TARGET, isDryRun, 'Platform'));
    track(await deleteCollection(C.LeadSource, TARGET, isDryRun, 'LeadSource'));
    track(await deleteCollection(C.LeadStatus, TARGET, isDryRun, 'LeadStatus'));
    track(await deleteCollection(C.LeadIndustry, TARGET, isDryRun, 'LeadIndustry'));
    track(await deleteCollection(C.Role, TARGET, isDryRun, 'CRM.Role'));
  }

  // ── Books-CRM ─────────────────────────────────────────────────────────────
  console.log('\nBooks-CRM DB');
  track(await deleteCollection(BC.PaymentReceived, TARGET, isDryRun, 'PaymentReceived'));
  track(await deleteCollection(BC.BankTransferLog, TARGET, isDryRun, 'BankTransferLog'));
  track(await deleteCollection(BC.OpeningBalanceTransaction, TARGET, isDryRun, 'OpeningBalanceTransaction'));
  track(await deleteCollection(BC.SalesOrder, TARGET, isDryRun, 'SalesOrder'));
  track(await deleteCollection(BC.Quote, TARGET, isDryRun, 'Quote'));
  track(await deleteCollection(BC.ItemHistory, TARGET, isDryRun, 'ItemHistory'));
  track(await deleteCollection(BC.ItemInventory, TARGET, isDryRun, 'ItemInventory'));
  track(await deleteCollection(BC.ItemBatch, TARGET, isDryRun, 'ItemBatch'));
  track(await deleteCollection(BC.PriceList, TARGET, isDryRun, 'PriceList'));
  track(await deleteCollection(BC.Customer, TARGET, isDryRun, 'Customer'));
  track(await deleteCollection(BC.Item, TARGET, isDryRun, 'Item'));
  track(await deleteCollection(BC.Bank, TARGET, isDryRun, 'Bank'));
  track(await deleteCollection(BC.Warehouse, TARGET, isDryRun, 'Warehouse'));
  track(await deleteCollection(BC.Branch, TARGET, isDryRun, 'Branch'));
  track(await deleteCollection(BC.Division, TARGET, isDryRun, 'Division'));
  track(await deleteCollection(BC.ItemGroup, TARGET, isDryRun, 'ItemGroup'));
  track(await deleteCollection(BC.ItemUnit, TARGET, isDryRun, 'ItemUnit'));
  track(await deleteCollection(BC.ModuleSettings, TARGET, isDryRun, 'ModuleSettings'));

  // ── Books ─────────────────────────────────────────────────────────────────
  console.log('\nBooks DB');
  track(await deleteCollection(B.UserRole, TARGET, isDryRun, 'Books.UserRole'));
  track(await deleteCollection(B.Project, TARGET, isDryRun, 'Project'));
  track(await deleteCollection(B.GeneralSalesAnalytics, TARGET, isDryRun, 'GeneralSalesAnalytics'));
  track(await deleteCollection(B.ItemGroupAnalyticsConfig, TARGET, isDryRun, 'ItemGroupAnalyticsConfig'));
  track(await deleteCollection(B.InvoiceDispatch, TARGET, isDryRun, 'InvoiceDispatch'));
  track(await deleteCollection(B.TimeSheet, TARGET, isDryRun, 'TimeSheet'));
  track(await deleteCollection(B.Expenses, TARGET, isDryRun, 'Expenses'));
  track(await deleteCollection(B.ProductionOrder, TARGET, isDryRun, 'ProductionOrder'));
  track(await deleteCollection(B.RecurringConfig, TARGET, isDryRun, 'RecurringConfig'));
  track(await deleteCollection(B.RecurringExpense, TARGET, isDryRun, 'RecurringExpense'));
  track(await deleteCollection(B.RecurringBills, TARGET, isDryRun, 'RecurringBills'));
  track(await deleteCollection(B.RecurringInvoice, TARGET, isDryRun, 'RecurringInvoice'));
  track(await deleteCollection(B.Stock, TARGET, isDryRun, 'Stock'));
  track(await deleteCollection(B.InventoryTransferRequest, TARGET, isDryRun, 'InventoryTransferRequest'));
  track(await deleteCollection(B.InventoryLogs, TARGET, isDryRun, 'InventoryLogs'));
  track(await deleteCollection(B.InventoryAdjustment, TARGET, isDryRun, 'InventoryAdjustment'));
  track(await deleteCollection(B.ManualJournal, TARGET, isDryRun, 'ManualJournal'));
  track(await deleteCollection(B.PaymentMade, TARGET, isDryRun, 'PaymentMade'));
  track(await deleteCollection(B.DebitNote, TARGET, isDryRun, 'DebitNote'));
  track(await deleteCollection(B.Bill, TARGET, isDryRun, 'Bill'));
  track(await deleteCollection(B.CreditNote, TARGET, isDryRun, 'CreditNote'));
  track(await deleteCollection(B.Invoice, TARGET, isDryRun, 'Invoice'));
  track(await deleteCollection(B.DeliveryChallan, TARGET, isDryRun, 'DeliveryChallan'));
  track(await deleteCollection(B.GrpoOrder, TARGET, isDryRun, 'GrpoOrder'));
  track(await deleteCollection(B.PurchaseOrder, TARGET, isDryRun, 'PurchaseOrder'));
  if (B.ItemBatch) track(await deleteCollection(B.ItemBatch, TARGET, isDryRun, 'Books.ItemBatch'));
  track(await deleteCollection(B.AccountItemMaster, TARGET, isDryRun, 'AccountItemMaster'));
  track(await deleteCollection(B.AccountItemGroup, TARGET, isDryRun, 'AccountItemGroup'));
  track(await deleteCollection(B.AccountLedger, TARGET, isDryRun, 'AccountLedger'));
  track(await deleteCollection(B.Account, TARGET, isDryRun, 'Account'));
  track(await deleteCollection(B.Role, TARGET, isDryRun, 'Books.Role'));
  track(await deleteCollection(B.Process, TARGET, isDryRun, 'Process'));
  track(await deleteCollection(B.Recipe, TARGET, isDryRun, 'Recipe'));
  track(await deleteCollection(B.ManPower, TARGET, isDryRun, 'ManPower'));
  track(await deleteCollection(B.TransportCourier, TARGET, isDryRun, 'TransportCourier'));
  track(await deleteCollection(B.SalesPerson, TARGET, isDryRun, 'SalesPerson'));
  track(await deleteCollection(B.Gst, TARGET, isDryRun, 'Gst'));
  track(await deleteCollection(B.Tax, TARGET, isDryRun, 'Tax'));
  track(await deleteCollection(B.CustomField, TARGET, isDryRun, 'CustomField'));
  track(await deleteCollection(B.QualityMaster, TARGET, isDryRun, 'QualityMaster'));

  // ── InvoiceDispatch & TimeSheet (no companyId — delete via parent IDs) ───
  console.log('\nBooks DB (no companyId)');
  if (B.Invoice && B.InvoiceDispatch) {
    const invoiceIds = (await B.Invoice.find({ companyId: new mongoose.Types.ObjectId(TARGET) }, '_id').lean()).map(d => d._id);
    if (invoiceIds.length > 0) {
      const count = await B.InvoiceDispatch.countDocuments({ invoiceId: { $in: invoiceIds } });
      if (count > 0) {
        if (isDryRun) {
          console.log(`  ~ InvoiceDispatch: ${count} docs would be deleted`);
        } else {
          await B.InvoiceDispatch.deleteMany({ invoiceId: { $in: invoiceIds } });
          console.log(`  ✓ InvoiceDispatch: ${count} docs deleted`);
        }
        totalDocs += count;
      } else {
        console.log('  - InvoiceDispatch: 0 docs');
      }
    } else {
      console.log('  - InvoiceDispatch: 0 docs (no invoices)');
    }
  }

  if (B.Project && B.TimeSheet) {
    const projectIds = (await B.Project.find({ companyId: new mongoose.Types.ObjectId(TARGET) }, '_id').lean()).map(d => d._id);
    if (projectIds.length > 0) {
      const count = await B.TimeSheet.countDocuments({ projectId: { $in: projectIds } });
      if (count > 0) {
        if (isDryRun) {
          console.log(`  ~ TimeSheet: ${count} docs would be deleted`);
        } else {
          await B.TimeSheet.deleteMany({ projectId: { $in: projectIds } });
          console.log(`  ✓ TimeSheet: ${count} docs deleted`);
        }
        totalDocs += count;
      } else {
        console.log('  - TimeSheet: 0 docs');
      }
    } else {
      console.log('  - TimeSheet: 0 docs (no projects)');
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n========================================');
  if (isDryRun) {
    console.log(`  DRY-RUN complete in ${elapsed}s`);
    console.log(`  ${totalDocs} documents would be deleted`);
    console.log('\n  Run with --confirm to perform actual deletion.');
  } else {
    console.log(`  Done in ${elapsed}s — ${totalDocs} documents deleted`);
  }
  console.log('========================================\n');

  process.exit(0);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
