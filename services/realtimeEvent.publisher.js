const crypto = require('crypto');
const { createQueue } = require('../config/queueConfig');

const REALTIME_QUEUE_NAME = 'abss-realtime-events';

const REALTIME_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 200 },
};

const buildEnvelope = ({ type, version, source, data }) => ({
  eventId: crypto.randomUUID(),
  type,
  version,
  source,
  occurredAt: new Date().toISOString(),
  data,
});

const publishRealtimeEvent = async envelope => {
  const queue = createQueue(REALTIME_QUEUE_NAME);
  await queue.add(envelope.type, envelope, {
    ...REALTIME_JOB_OPTIONS,
    jobId: envelope.eventId,
  });
};

module.exports = {
  buildEnvelope,
  publishRealtimeEvent,
};
