const { Worker } = require('bullmq');
const connection = require('../config/bullmq-connection');
const logger = require('../config/logger');
const {
  processModuleEmail,
  processModuleWhatsApp,
  MODULE_EMAIL_QUEUE,
  MODULE_WHATSAPP_QUEUE,
} = require('../services/moduleEmailNotification.service');

let emailWorkerInstance = null;
let whatsappWorkerInstance = null;

const attachWorkerLogging = (worker, queueName) => {
  worker.on('completed', job => {
    logger.info(`[BullMQ Worker] Completed ${queueName} job id=${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[BullMQ Worker] Failed ${queueName} job id=${job?.id} after ${job?.attemptsMade} attempt(s): ${err.message}`);
  });

  worker.on('error', err => {
    logger.error(`[BullMQ Worker] ${queueName} worker error: ${err.message}`);
  });
};

const startModuleEmailWorker = () => {
  emailWorkerInstance = new Worker(
    MODULE_EMAIL_QUEUE,
    async job => {
      const { companyId, moduleName, document } = job.data || {};
      logger.info(
        `[BullMQ Worker] Processing ${MODULE_EMAIL_QUEUE} job id=${job.id} attempt=${job.attemptsMade + 1} module=${moduleName}`,
      );

      const sent = await processModuleEmail({ companyId, moduleName, document });

      logger.info(`[BullMQ Worker] Finished ${MODULE_EMAIL_QUEUE} job id=${job.id} sent=${sent}`);
      return { sent };
    },
    {
      connection,
      concurrency: 2,
    },
  );
  attachWorkerLogging(emailWorkerInstance, MODULE_EMAIL_QUEUE);

  whatsappWorkerInstance = new Worker(
    MODULE_WHATSAPP_QUEUE,
    async job => {
      const { companyId, moduleName, document, invoiceId } = job.data || {};
      logger.info(
        `[BullMQ Worker] Processing ${MODULE_WHATSAPP_QUEUE} job id=${job.id} attempt=${job.attemptsMade + 1} module=${moduleName}`,
      );

      const sent = await processModuleWhatsApp({ companyId, moduleName, document, invoiceId });

      logger.info(`[BullMQ Worker] Finished ${MODULE_WHATSAPP_QUEUE} job id=${job.id} sent=${sent}`);
      return { sent };
    },
    {
      connection,
      concurrency: 2,
    },
  );
  attachWorkerLogging(whatsappWorkerInstance, MODULE_WHATSAPP_QUEUE);

  logger.info(`[BullMQ Worker] ${MODULE_EMAIL_QUEUE} + ${MODULE_WHATSAPP_QUEUE} workers started`);
  return { emailWorkerInstance, whatsappWorkerInstance };
};

const stopModuleEmailWorker = async () => {
  if (emailWorkerInstance) {
    await emailWorkerInstance.close();
    emailWorkerInstance = null;
    logger.info(`[BullMQ Worker] ${MODULE_EMAIL_QUEUE} worker closed`);
  }
  if (whatsappWorkerInstance) {
    await whatsappWorkerInstance.close();
    whatsappWorkerInstance = null;
    logger.info(`[BullMQ Worker] ${MODULE_WHATSAPP_QUEUE} worker closed`);
  }
};

module.exports = { startModuleEmailWorker, stopModuleEmailWorker };
