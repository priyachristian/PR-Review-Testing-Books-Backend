/**
 * Refunds saved before the refund fix never changed the customer / vendor current balance.
 * This adds each refund back to the balance of the document's branch, as the fixed refund code now does.
 *
 * Run it ONCE with --apply, right after the refund fix is deployed; a second --apply would add the amounts again.
 *
 * Run: node migrations/fixRefundCurrentBalance-remove.js                       (report)
 *      node migrations/fixRefundCurrentBalance-remove.js <companyId>           (report, one company)
 *      node migrations/fixRefundCurrentBalance-remove.js --apply               (write)
 */
const mongoose = require('mongoose');
const config = require('../config/config');
const { getModelsAndConnections } = require('@smit9313/abss-models-core');
const modelService = require('../services/model.service');

const round2 = value => Math.round((Number(value) || 0) * 100) / 100;

const bootstrap = async () => {
  // A data fix must not build indexes or collections on the live database.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  const { models, connections } = await getModelsAndConnections(config.mongoose.db_names);
  modelService.setApp({
    locals: {
      db: {
        connections: {
          common: connections.common,
          booksCrm: connections['books-crm'],
          books: connections.books,
          crm: connections.crm,
          abssAdmin: connections['abss-admin'],
        },
        models: {
          common: models.common,
          booksCrm: models['books-crm'],
          books: models.books,
          crm: models.crm,
          abssAdmin: models['abss-admin'],
        },
        connection: connections.rawConnection,
      },
    },
  });
  return connections.rawConnection;
};

const migrate = async () => {
  const rawConnection = await bootstrap();
  const { updateBranchCurrentBalance } = require('../services/customerValidation.service');
  const { PaymentReceived } = modelService.getBooksCrmModels();
  const { PaymentMade, CreditNote, DebitNote } = modelService.getBooksModels();
  const { Company } = modelService.getCommonModels();
  const companyNames = new Map();

  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const companyArg = args.find(arg => !arg.startsWith('--'));
  const scope = companyArg ? { companyId: new mongoose.Types.ObjectId(companyArg) } : {};

  console.log('\nRUN');
  console.table([
    {
      Scope: companyArg || 'ALL COMPANIES',
      Mode: apply ? 'APPLYING CHANGES' : 'REPORT ONLY (nothing is written)',
    },
  ]);

  const sources = [
    {
      label: 'Payment Received',
      Model: PaymentReceived,
      filter: { status: 'APPROVED' },
      numberField: 'paymentReceivedId',
      partyField: 'customerId',
      amountField: 'amountRefunded',
    },
    {
      label: 'Payment Made',
      Model: PaymentMade,
      filter: { status: 'APPROVED' },
      numberField: 'paymentMadeId',
      partyField: 'vendorId',
      amountField: 'amountRefunded',
    },
    {
      label: 'Credit Note',
      Model: CreditNote,
      filter: {},
      numberField: 'creditNoteId',
      partyField: 'customerId',
      amountField: 'refundAmount',
    },
    {
      label: 'Debit Note',
      Model: DebitNote,
      filter: {},
      numberField: 'debitNoteId',
      partyField: 'vendorId',
      amountField: 'refundAmount',
    },
  ];

  const rows = [];
  let documents = 0;
  let total = 0;
  let failed = 0;

  for (const source of sources) {
    const docs = await source.Model.find({ ...scope, ...source.filter, 'refunds.0': { $exists: true } })
      .select(`companyId branchId ${source.numberField} ${source.partyField} refunds`)
      .lean();

    for (const doc of docs) {
      const amount = round2(doc.refunds.reduce((sum, refund) => sum + (Number(refund[source.amountField]) || 0), 0));
      if (!amount) continue;

      const companyId = String(doc.companyId);
      if (!companyNames.has(companyId)) {
        const company = await Company.findById(doc.companyId).select('name').lean();
        companyNames.set(companyId, company?.name || companyId);
      }

      const row = {
        Company: companyNames.get(companyId),
        Document: `${source.label} ${doc[source.numberField]}`,
        Refunds: doc.refunds.length,
        'Add to balance': amount,
        Result: apply ? '' : 'to fix',
      };
      rows.push(row);
      documents += 1;
      total += amount;
      if (!apply) continue;

      const session = await rawConnection.startSession();
      try {
        await session.withTransaction(async () => {
          await updateBranchCurrentBalance({ customerId: doc[source.partyField], branchId: doc.branchId, amount, session });
        });
        row.Result = 'DONE';
      } catch (error) {
        row.Result = `FAILED: ${error.message}`;
        failed += 1;
      } finally {
        await session.endSession();
      }
    }
  }

  console.table(rows);
  console.log('\nSUMMARY');
  console.table([{ Documents: documents, 'Total added': round2(total), Failed: failed }]);
};

migrate()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error.message);
    process.exit(1);
  });
