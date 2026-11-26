const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getClientConnection, getBooksModels } = require('../../../services/model.service');
const { INVOICE_DISPATCH_MESSAGES } = require('../../../utils/messages');
const { handleFileUpdate } = require('../../commonModule/fileUpload/fileUploadS3.service');
const logger = require('../../../config/logger');
const { MODULE_NAMES } = require('../../../utils/enum');
const { sendModuleEmail } = require('../../../services/moduleEmailNotification.service');
const { sendInvoiceDispatchWhatsApp } = require('../../../services/wpDispatch.service');

const getDispatchForCompany = async (id, companyId, session = null) => {
  const { InvoiceDispatch, Invoice } = getBooksModels();
  const query = InvoiceDispatch.findById(id).populate('transportCourier.transportId');
  const dispatch = session ? await query.session(session) : await query;
  if (!dispatch) {
    throw new ApiError(httpStatus.NOT_FOUND, INVOICE_DISPATCH_MESSAGES.NOT_FOUND);
  }
  const invoiceQuery = Invoice.findOne({ _id: dispatch.invoiceId, companyId });
  const invoice = session ? await invoiceQuery.session(session) : await invoiceQuery;
  if (!invoice) {
    throw new ApiError(httpStatus.NOT_FOUND, INVOICE_DISPATCH_MESSAGES.NOT_FOUND);
  }
  return dispatch;
};

/**
 * Create an invoice dispatch
 * @param {Object} invoiceDispatchBody
 * @param {string} userId
 * @returns {Promise<InvoiceDispatch>}
 */
const createInvoiceDispatch = async (
  invoiceDispatchBody,
  companyId,
  userId,
  bookingCopyImage,
  truck_goodsImage,
  vehicle_goodsImage,
) => {
  const { InvoiceDispatch, Invoice } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  const existing = await InvoiceDispatch.findOne({ invoiceId: invoiceDispatchBody.invoiceId }).session(session);
  if (existing) {
    throw new ApiError(httpStatus.BAD_REQUEST, INVOICE_DISPATCH_MESSAGES.ALREADY_EXISTS);
  }

  try {
    await session.startTransaction();
    const invoice = await Invoice.findOne({ _id: invoiceDispatchBody.invoiceId, companyId }).session(session);
    if (!invoice) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Invoice not found');
    }
    switch (invoiceDispatchBody.dispatchMode) {
      case 'Transport & Courier Service':
        const bookingCopyImageUrls = await handleFileUpdate({
          newFiles: bookingCopyImage,
          currentUrls: [],
          existingUrls: [],
          userId,
          companyId,
        });
        invoiceDispatchBody.transportCourier.bookingCopyImage = bookingCopyImageUrls.length > 0 ? bookingCopyImageUrls : [];
        break;
      case 'Full Truck Load':
        const truck_goodsImageUrls = await handleFileUpdate({
          newFiles: truck_goodsImage,
          currentUrls: [],
          existingUrls: [],
          userId,
          companyId,
        });
        invoiceDispatchBody.truckLoad.truck_goodsImage = truck_goodsImageUrls.length > 0 ? truck_goodsImageUrls : [];
        break;
      case 'OurSelf Delivery':
      case 'Pickup By Customer':
        const vehicle_goodsImageUrls = await handleFileUpdate({
          newFiles: vehicle_goodsImage,
          currentUrls: [],
          existingUrls: [],
          userId,
          companyId,
        });
        invoiceDispatchBody.selfDelivery.vehicle_goodsImage = vehicle_goodsImageUrls.length > 0 ? vehicle_goodsImageUrls : [];
        break;
      default:
        throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid dispatch mode');
    }

    const payload = {
      ...invoiceDispatchBody,
      companyId,
      addedBy: userId,
      updatedBy: userId,
    };

    const [newDispatch] = await InvoiceDispatch.create([payload], { session });
    await Invoice.findByIdAndUpdate(
      invoiceDispatchBody.invoiceId,
      {
        $set: { invoiceDispatchId: newDispatch._id, updatedBy: userId },
        $push: {
          commentHistory: {
            message: `Invoice dispatch created via ${invoiceDispatchBody.dispatchMode}`,
            addedBy: userId,
            createdAt: new Date(),
          },
        },
      },
      { session },
    );

    await session.commitTransaction();

    // Split invoices are never sent to the customer, so their dispatch isn't either.
    if (!invoice.isSplit) {
      sendModuleEmail({
        companyId,
        moduleName: MODULE_NAMES.DISPATCH,
        document: newDispatch,
      }).catch(err => logger.error(`Failed to send invoice dispatch email notification: ${err.message}`));

      sendInvoiceDispatchWhatsApp({
        companyId,
        dispatch: newDispatch,
        invoiceId: invoiceDispatchBody.invoiceId,
      }).catch(err => logger.error(`Failed to send invoice dispatch WhatsApp notification: ${err.message}`));
    }

    return newDispatch;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message || INVOICE_DISPATCH_MESSAGES.FAILED_TO_CREATE);
  } finally {
    await session.endSession();
  }
};

const getDispatchById = async (id, companyId) => {
  return getDispatchForCompany(id, companyId);
};

/**
 * Update an invoice dispatch by ID
 * @param {string} id - Dispatch ID
 * @param {Object} updateBody - Fields to update
 * @param {string} userId - User performing the update
 * @returns {Promise<InvoiceDispatch>}
 */
const updateInvoiceDispatchById = async (
  id,
  updateBody,
  userId,
  companyId,
  bookingCopyImage,
  truck_goodsImage,
  vehicle_goodsImage,
) => {
  const dispatch = await getDispatchForCompany(id, companyId);
  const { Invoice } = getBooksModels();

  const mode = updateBody.dispatchMode || dispatch.dispatchMode;

  switch (mode) {
    case 'Transport & Courier Service':
      const bookingCopyImageUrls = await handleFileUpdate({
        newFiles: bookingCopyImage,
        currentUrls: updateBody.transportCourier?.bookingCopyImage ? updateBody.transportCourier.bookingCopyImage : [],
        existingUrls: dispatch.transportCourier?.bookingCopyImage ? dispatch.transportCourier.bookingCopyImage : [],
        userId,
        companyId,
      });
      if (updateBody.transportCourier) {
        updateBody.transportCourier.bookingCopyImage = bookingCopyImageUrls.length > 0 ? bookingCopyImageUrls : [];
      }
      break;
    case 'Full Truck Load':
      const truck_goodsImageUrls = await handleFileUpdate({
        newFiles: truck_goodsImage,
        currentUrls: updateBody.truckLoad?.truck_goodsImage ? updateBody.truckLoad.truck_goodsImage : [],
        existingUrls: dispatch.truckLoad?.truck_goodsImage ? dispatch.truckLoad.truck_goodsImage : [],
        userId,
        companyId,
      });
      if (updateBody.truckLoad) {
        updateBody.truckLoad.truck_goodsImage = truck_goodsImageUrls.length > 0 ? truck_goodsImageUrls : [];
      }
      break;
    case 'OurSelf Delivery':
    case 'Pickup By Customer':
      const vehicle_goodsImageUrls = await handleFileUpdate({
        newFiles: vehicle_goodsImage,
        currentUrls: updateBody.selfDelivery?.vehicle_goodsImage ? updateBody.selfDelivery.vehicle_goodsImage : [],
        existingUrls: dispatch.selfDelivery?.vehicle_goodsImage ? dispatch.selfDelivery.vehicle_goodsImage : [],
        userId,
        companyId,
      });
      if (updateBody.selfDelivery) {
        updateBody.selfDelivery.vehicle_goodsImage = vehicle_goodsImageUrls.length > 0 ? vehicle_goodsImageUrls : [];
      }
      break;
    default:
      throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid dispatch mode');
  }

  Object.assign(dispatch, updateBody);
  dispatch.updatedBy = userId;

  const connection = await getClientConnection();
  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    await dispatch.save({ session });
    await Invoice.findByIdAndUpdate(
      dispatch.invoiceId,
      {
        $set: { updatedBy: userId },
        $push: {
          commentHistory: {
            message: `Invoice dispatch updated (${mode})`,
            addedBy: userId,
            createdAt: new Date(),
          },
        },
      },
      { session },
    );
    await session.commitTransaction();

    // Split invoices are never sent to the customer, so their dispatch isn't either.
    const invoice = await Invoice.findOne({ _id: dispatch.invoiceId, companyId }).select('isSplit').lean();
    if (!invoice.isSplit) {
      sendModuleEmail({
        companyId,
        moduleName: MODULE_NAMES.DISPATCH,
        document: dispatch,
      }).catch(err => logger.error(`Failed to send invoice dispatch email notification on update: ${err.message}`));

      sendInvoiceDispatchWhatsApp({
        companyId,
        dispatch,
        invoiceId: dispatch.invoiceId,
      }).catch(err => logger.error(`Failed to send invoice dispatch WhatsApp notification on update: ${err.message}`));
    }

    return dispatch;
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const deleteInvoiceDispatch = async (id, companyId, userId = null) => {
  const { InvoiceDispatch, Invoice } = getBooksModels();
  const connection = await getClientConnection();

  if (!connection) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, "We're unable to process this right now. Please try again shortly.");
  }

  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const invoiceDispatch = await getDispatchForCompany(id, companyId, session);

    await Invoice.findByIdAndUpdate(
      invoiceDispatch.invoiceId,
      {
        $unset: {
          invoiceDispatchId: '',
        },
        $push: {
          commentHistory: {
            message: `Invoice dispatch deleted`,
            addedBy: userId,
            createdAt: new Date(),
          },
        },
      },
      { session },
    );

    await InvoiceDispatch.findByIdAndDelete(id, { session });

    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, error.message || INVOICE_DISPATCH_MESSAGES.FAILED_TO_CREATE);
  } finally {
    await session.endSession();
  }
};

module.exports = {
  createInvoiceDispatch,
  getDispatchById,
  updateInvoiceDispatchById,
  deleteInvoiceDispatch,
};
