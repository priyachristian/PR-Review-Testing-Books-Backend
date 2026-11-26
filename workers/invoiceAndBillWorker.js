const { Worker } = require('bullmq');
const connection = require('../config/bullmq-connection');

let workerInstance = null;

const startInvoiceAndBillWorker = () => {
  const { InvoiceAndBillCron } = require('../cronJobs/invoiceAndBillCron');

  workerInstance = new Worker(
    'invoice-and-bill-due',
    async job => {
      console.log(`[BullMQ Worker] 🏃 Processing job id=${job.id} name=${job.name}`);
      await InvoiceAndBillCron();
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

  console.log('[BullMQ Worker] 🚀 invoiceAndBillWorker started');
  return workerInstance;
};

const stopInvoiceAndBillWorker = async () => {
  if (workerInstance) {
    await workerInstance.close();
    console.log('[BullMQ Worker] 🔚 invoiceAndBillWorker closed');
  }
};

module.exports = { startInvoiceAndBillWorker, stopInvoiceAndBillWorker };
