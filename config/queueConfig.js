const { Queue } = require('bullmq');
const connection = require('./bullmq-connection');

const defaultJobOptions = {
  removeOnComplete: { count: 100 }, // keep last 100 completed jobs (visible in dashboard)
  removeOnFail: { count: 50 }, // keep last 50 failed jobs for inspection
  attempts: 3, // retry up to 3 times on failure
  backoff: {
    type: 'exponential',
    delay: 5000, // first retry after 5s, then 10s, 20s …
  },
};

const _registry = new Map();

function createQueue(name) {
  if (_registry.has(name)) return _registry.get(name);

  const queue = new Queue(name, { connection, defaultJobOptions });

  queue.on('error', err => {
    console.error(`[BullMQ Queue] ${name} error:`, err.message);
  });

  console.log(`[BullMQ Queue] ✅ ${name} queue created`);

  _registry.set(name, queue);
  return queue;
}

module.exports = { createQueue, defaultJobOptions };
