const { Worker } = require('bullmq');
const connection = require('../config/bullmq-connection');

let workerInstance = null;

const startRecurringExpenseWorker = () => {
  const { runRecurringExpensesCron } = require('../cronJobs/recurringExpenseCronJob');

  workerInstance = new Worker(
    'recurring-expense',
    async job => {
      console.log(`[BullMQ Worker] 🏃 Processing job id=${job.id} name=${job.name}`);
      await runRecurringExpensesCron();
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

  console.log('[BullMQ Worker] 🚀 recurringExpenseWorker started');
  return workerInstance;
};

const stopRecurringExpenseWorker = async () => {
  if (workerInstance) {
    await workerInstance.close();
    console.log('[BullMQ Worker] 🔚 recurringExpenseWorker closed');
  }
};

module.exports = { startRecurringExpenseWorker, stopRecurringExpenseWorker };
