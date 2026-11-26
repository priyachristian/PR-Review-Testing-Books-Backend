const { Worker } = require('bullmq');
const connection = require('../config/bullmq-connection');

let workerInstance = null;

const startRecurringInvoiceWorker = () => {
  const { runRecurringInvoiceCron } = require('../cronJobs/recurringInvoiceCronJob');

  workerInstance = new Worker(
    'recurring-invoice',
    async job => {
      console.log(`[BullMQ Worker] 🏃 Processing job id=${job.id} name=${job.name}`);
      await runRecurringInvoiceCron();
      console.log(`[BullMQ Worker] ✅ Job id=${job.id} finished`);
    },
    {
      connection,
      concurrency: 1,
    },
  );

  workerInstance.on('completed', job => {
    console.log(`[BullMQ Worker] ✅ Completed job id=${job.id}`);
  });

  workerInstance.on('failed', (job, err) => {
    console.error(`[BullMQ Worker] ❌ Failed job id=${job?.id}:`, err.message);
  });

  workerInstance.on('error', err => {
    console.error('[BullMQ Worker] ❌ Worker error:', err.message);
  });

  console.log('[BullMQ Worker] 🚀 recurringInvoiceWorker started');
  return workerInstance;
};

const stopRecurringInvoiceWorker = async () => {
  if (workerInstance) {
    await workerInstance.close();
    console.log('[BullMQ Worker] 🔚 recurringInvoiceWorker closed');
  }
};

module.exports = { startRecurringInvoiceWorker, stopRecurringInvoiceWorker };
