const cron = require('node-cron');
const { INVOICE_STATUS, BILL_STATUSES } = require('../utils/enum');
const { createQueue } = require('../config/queueConfig');

let Invoice = null;
let Bill = null;
// Setup log stream

const InvoiceAndBillCron = async () => {
  try {
    const session = await Invoice.db.startSession();
    session.startTransaction();
    try {
      const todayDate = new Date();
      todayDate.setUTCHours(0, 0, 0, 0);

      const invoice = await Invoice.find({
        dueDate: { $lt: todayDate },
        status: { $in: [INVOICE_STATUS.SENT] },
      }).session(session);

      console.log(`Found ${invoice.length} over due invoices`);
      for (let i of invoice) {
        await Invoice.updateOne(
          { _id: i._id },
          {
            $set: {
              status: INVOICE_STATUS.OVERDUE,
            },
          },
          { session },
        );

        console.log(`Updated Invoice: ${i._id}`);
      }

      const bill = await Bill.find({
        dueDate: { $lt: todayDate },
        status: { $in: [BILL_STATUSES.OPEN] },
      }).session(session);

      console.log(`Found ${bill.length} over due bills`);

      for (let i of bill) {
        await Bill.updateOne(
          { _id: i._id },
          {
            $set: {
              status: BILL_STATUSES.OVERDUE,
            },
          },
          { session },
        );

        console.log(`Updated Bill: ${i._id}`);
      }
      await session.commitTransaction();
      console.log('✅ Transaction committed successfully');
    } catch (err) {
      console.log('❌ Transaction failed:', err.message);
      await session.abortTransaction();
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.log({ error });
  }
};

const startCron = booksModels => {
  Bill = booksModels.Bill;
  Invoice = booksModels.Invoice;

  console.log('🧾 Bill:', Bill ? '✅ Loaded' : '❌ Not loaded');
  console.log('📄 Invoice:', Invoice ? '✅ Loaded' : '❌ Not loaded');

  if (!Bill || !Invoice) {
    console.log('❌ Required models not available for cron');
    return;
  }

  console.log('📅 Cron initialized');

  cron.schedule('0 0 * * *', async () => {
    try {
      const jobId = `invoice-and-bill-due-${new Date().toISOString().split('T')[0]}`;
      const job = await createQueue('invoice-and-bill-due').add('process-invoice-and-bill-due', {}, { jobId });
      console.log(`[Cron] 📥 Enqueued invoice-and-bill-due job id=${job.id}`);
    } catch (err) {
      console.error('[Cron] ❌ Failed to enqueue invoice-and-bill-due job:', err.message);
    }
  });
};

module.exports = startCron;
// Named export used by the BullMQ worker to run the actual logic
module.exports.InvoiceAndBillCron = InvoiceAndBillCron;
