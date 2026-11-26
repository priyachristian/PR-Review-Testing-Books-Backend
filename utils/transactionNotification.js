const logger = require('../config/logger');
const { getBooksModels, getBooksCrmModels, getCommonModels } = require('../services/model.service');
const { sendMulticastPushNotification } = require('./firebase');
const { emitNotificationToUser } = require('../socket/handlers/notification.handler');
const {
  DEVICE_USER_TYPE,
  NOTIFICATION_TYPE,
  NOTIFICATION_ACTOR_TYPE,
  MODULE_NAMES,
} = require('@smit9313/abss-models-core/src/utils/enum');

const NOTIFICATION_CONTENT = {
  // Customer Order
  [NOTIFICATION_TYPE.CUSTOMER_ORDER_UNDER_REVIEW]: {
    title: 'Order Under Review',
    body: id => `Your order ${id} is under review.`,
  },
  [NOTIFICATION_TYPE.CUSTOMER_ORDER_ACCEPTED]: {
    title: 'Order Accepted',
    body: id => `Your order ${id} has been accepted.`,
  },
  [NOTIFICATION_TYPE.CUSTOMER_ORDER_REJECTED]: {
    title: 'Order Rejected',
    body: id => `Your order ${id} has been rejected.`,
  },
  [NOTIFICATION_TYPE.CUSTOMER_ORDER_COMPLETED]: {
    title: 'Order Completed',
    body: id => `Your order ${id} has been completed.`,
  },

  // Sales Order
  [NOTIFICATION_TYPE.SALES_ORDER_CREATED]: {
    title: 'Sales Order Created',
    body: id => `Sales order ${id} has been created for your account.`,
  },
  [NOTIFICATION_TYPE.SALES_ORDER_UPDATED]: {
    title: 'Sales Order Modified',
    body: id => `Your sales order ${id} has been modified.`,
  },
  [NOTIFICATION_TYPE.SALES_ORDER_DELETED]: {
    title: 'Sales Order Deleted',
    body: id => `Your sales order ${id} has been deleted.`,
  },

  // Delivery Challan
  [NOTIFICATION_TYPE.DELIVERY_CHALLAN_CREATED]: {
    title: 'Delivery Challan Created',
    body: id => `A delivery challan ${id} has been created for your order.`,
  },
  [NOTIFICATION_TYPE.DELIVERY_CHALLAN_UPDATED]: {
    title: 'Delivery Challan Modified',
    body: id => `Delivery challan ${id} has been modified.`,
  },
  [NOTIFICATION_TYPE.DELIVERY_CHALLAN_DELETED]: {
    title: 'Delivery Challan Deleted',
    body: id => `Delivery challan ${id} has been deleted.`,
  },

  // Invoice
  [NOTIFICATION_TYPE.INVOICE_CREATED]: {
    title: 'Invoice Generated',
    body: id => `Invoice ${id} has been generated for your account.`,
  },
  [NOTIFICATION_TYPE.INVOICE_UPDATED]: {
    title: 'Invoice Modified',
    body: id => `Invoice ${id} has been modified.`,
  },
  [NOTIFICATION_TYPE.INVOICE_DELETED]: {
    title: 'Invoice Deleted',
    body: id => `Invoice ${id} has been deleted.`,
  },

  // Payment Received
  [NOTIFICATION_TYPE.PAYMENT_RECEIVED_CREATED]: {
    title: 'Payment Recorded',
    body: id => `Payment ${id} has been recorded for your account.`,
  },
  [NOTIFICATION_TYPE.PAYMENT_RECEIVED_UPDATED]: {
    title: 'Payment Modified',
    body: id => `Payment record ${id} has been modified.`,
  },
  [NOTIFICATION_TYPE.PAYMENT_RECEIVED_DELETED]: {
    title: 'Payment Removed',
    body: id => `Payment record ${id} has been removed.`,
  },

  // Credit Note
  [NOTIFICATION_TYPE.CREDIT_NOTE_CREATED]: {
    title: 'Credit Note Issued',
    body: id => `Credit note ${id} has been issued for your account.`,
  },
  [NOTIFICATION_TYPE.CREDIT_NOTE_UPDATED]: {
    title: 'Credit Note Modified',
    body: id => `Credit note ${id} has been modified.`,
  },
  [NOTIFICATION_TYPE.CREDIT_NOTE_DELETED]: {
    title: 'Credit Note Deleted',
    body: id => `Credit note ${id} has been deleted.`,
  },

  // Quote
  [NOTIFICATION_TYPE.QUOTE_CREATED]: {
    title: 'Quotation Created',
    body: id => `Quotation ${id} has been created for your account.`,
  },
  [NOTIFICATION_TYPE.QUOTE_UPDATED]: {
    title: 'Quotation Modified',
    body: id => `Quotation ${id} has been modified.`,
  },
  [NOTIFICATION_TYPE.QUOTE_DELETED]: {
    title: 'Quotation Deleted',
    body: id => `Quotation ${id} has been deleted.`,
  },
  [NOTIFICATION_TYPE.QUOTE_SENT]: {
    title: 'Quotation Sent',
    body: id => `Quotation ${id} has been sent for your review.`,
  },
};

const STATUS_CHANGED_CONTENT = {
  [NOTIFICATION_TYPE.SALES_ORDER_STATUS_CHANGED]: {
    title: status => `Sales Order ${status}`,
    body: (id, status) => `Your sales order ${id} is now ${status}.`,
  },
  [NOTIFICATION_TYPE.DELIVERY_CHALLAN_STATUS_CHANGED]: {
    title: status => `Delivery Challan ${status}`,
    body: (id, status) => `Delivery challan ${id} is now ${status}.`,
  },
  [NOTIFICATION_TYPE.INVOICE_STATUS_CHANGED]: {
    title: status => `Invoice ${status}`,
    body: (id, status) => `Invoice ${id} is now ${status}.`,
  },
  [NOTIFICATION_TYPE.PAYMENT_RECEIVED_STATUS_CHANGED]: {
    title: status => `Payment ${status}`,
    body: (id, status) => `Payment ${id} has been ${status}.`,
  },
  [NOTIFICATION_TYPE.CREDIT_NOTE_STATUS_CHANGED]: {
    title: status => `Credit Note ${status}`,
    body: (id, status) => `Credit note ${id} is now ${status}.`,
  },
  [NOTIFICATION_TYPE.QUOTE_STATUS_CHANGED]: {
    title: status => `Quotation ${status}`,
    body: (id, status) => `Quotation ${id} is now ${status}.`,
  },
};

const TYPE_TO_MODULE = {
  [NOTIFICATION_TYPE.CUSTOMER_ORDER_UNDER_REVIEW]: MODULE_NAMES.CUSTOMER_ORDER,
  [NOTIFICATION_TYPE.CUSTOMER_ORDER_ACCEPTED]: MODULE_NAMES.CUSTOMER_ORDER,
  [NOTIFICATION_TYPE.CUSTOMER_ORDER_REJECTED]: MODULE_NAMES.CUSTOMER_ORDER,
  [NOTIFICATION_TYPE.CUSTOMER_ORDER_COMPLETED]: MODULE_NAMES.CUSTOMER_ORDER,

  [NOTIFICATION_TYPE.QUOTE_CREATED]: MODULE_NAMES.QUOTES,
  [NOTIFICATION_TYPE.QUOTE_UPDATED]: MODULE_NAMES.QUOTES,
  [NOTIFICATION_TYPE.QUOTE_DELETED]: MODULE_NAMES.QUOTES,
  [NOTIFICATION_TYPE.QUOTE_SENT]: MODULE_NAMES.QUOTES,
  [NOTIFICATION_TYPE.QUOTE_STATUS_CHANGED]: MODULE_NAMES.QUOTES,

  [NOTIFICATION_TYPE.SALES_ORDER_CREATED]: MODULE_NAMES.SALES_ORDER,
  [NOTIFICATION_TYPE.SALES_ORDER_STATUS_CHANGED]: MODULE_NAMES.SALES_ORDER,
  [NOTIFICATION_TYPE.SALES_ORDER_UPDATED]: MODULE_NAMES.SALES_ORDER,
  [NOTIFICATION_TYPE.SALES_ORDER_DELETED]: MODULE_NAMES.SALES_ORDER,

  [NOTIFICATION_TYPE.DELIVERY_CHALLAN_CREATED]: MODULE_NAMES.DELIVERY_CHALLAN,
  [NOTIFICATION_TYPE.DELIVERY_CHALLAN_STATUS_CHANGED]: MODULE_NAMES.DELIVERY_CHALLAN,
  [NOTIFICATION_TYPE.DELIVERY_CHALLAN_UPDATED]: MODULE_NAMES.DELIVERY_CHALLAN,
  [NOTIFICATION_TYPE.DELIVERY_CHALLAN_DELETED]: MODULE_NAMES.DELIVERY_CHALLAN,

  [NOTIFICATION_TYPE.INVOICE_CREATED]: MODULE_NAMES.INVOICE,
  [NOTIFICATION_TYPE.INVOICE_STATUS_CHANGED]: MODULE_NAMES.INVOICE,
  [NOTIFICATION_TYPE.INVOICE_UPDATED]: MODULE_NAMES.INVOICE,
  [NOTIFICATION_TYPE.INVOICE_DELETED]: MODULE_NAMES.INVOICE,

  [NOTIFICATION_TYPE.PAYMENT_RECEIVED_CREATED]: MODULE_NAMES.PAYMENT_RECEIVED,
  [NOTIFICATION_TYPE.PAYMENT_RECEIVED_STATUS_CHANGED]: MODULE_NAMES.PAYMENT_RECEIVED,
  [NOTIFICATION_TYPE.PAYMENT_RECEIVED_UPDATED]: MODULE_NAMES.PAYMENT_RECEIVED,
  [NOTIFICATION_TYPE.PAYMENT_RECEIVED_DELETED]: MODULE_NAMES.PAYMENT_RECEIVED,

  [NOTIFICATION_TYPE.CREDIT_NOTE_CREATED]: MODULE_NAMES.CREDIT_NOTE,
  [NOTIFICATION_TYPE.CREDIT_NOTE_STATUS_CHANGED]: MODULE_NAMES.CREDIT_NOTE,
  [NOTIFICATION_TYPE.CREDIT_NOTE_UPDATED]: MODULE_NAMES.CREDIT_NOTE,
  [NOTIFICATION_TYPE.CREDIT_NOTE_DELETED]: MODULE_NAMES.CREDIT_NOTE,
};

const sendTransactionNotification = async ({
  customerId,
  companyId,
  notificationType,
  entityId,
  entityDisplayId,
  triggeredByUserId,
  newStatus,
}) => {
  try {
    const module = TYPE_TO_MODULE[notificationType];

    let notificationTitle, notificationBody;
    const statusContent = newStatus && STATUS_CHANGED_CONTENT[notificationType];
    if (statusContent) {
      notificationTitle = statusContent.title(newStatus);
      notificationBody = statusContent.body(entityDisplayId, newStatus);
    } else {
      const content = NOTIFICATION_CONTENT[notificationType];
      if (!content) return;
      notificationTitle = content.title;
      notificationBody = content.body(entityDisplayId);
    }

    const { Customer } = getBooksCrmModels();
    const { CustomerPortalUser, Notification } = getBooksModels();
    const { Device } = getCommonModels();

    if (!customerId) {
      logger.warn('sendTransactionNotification: customerId is missing, skipping notification');
      return;
    }

    const customer = await Customer.findById(customerId)
      .select('otherDetails.enablePortal otherDetails.isCustomerPortalActivated')
      .lean();
    if (!customer?.otherDetails?.enablePortal || !customer?.otherDetails?.isCustomerPortalActivated) return;

    // 1. Resolve all active customer portal users linked to this customer + company
    const portalUsers = await CustomerPortalUser.find({
      links: {
        $elemMatch: {
          customerId,
          companyId,
          isActive: true,
        },
      },
    })
      .select('_id isNotificationEnabled')
      .lean();

    if (!portalUsers.length) return;

    const portalUserIds = portalUsers.map(u => u._id);

    // 3. Persist one Notification document per portal user (all users)
    const notificationDocs = portalUserIds.map(uid => ({
      userId: uid,
      userType: DEVICE_USER_TYPE.CUSTOMER_PORTAL_USER,
      companyId,
      type: notificationType,
      title: notificationTitle,
      body: notificationBody,
      module,
      actionId: entityId,
      data: {
        entityId: entityId.toString(),
        entityDisplayId,
        companyId: companyId.toString(),
        type: notificationType,
      },
      ...(triggeredByUserId && {
        triggeredBy: triggeredByUserId,
        triggeredByType: NOTIFICATION_ACTOR_TYPE.USER,
      }),
    }));

    const inserted = await Notification.insertMany(notificationDocs, { ordered: false });

    // 4. Emit realtime socket notification to ALL portal users' connected devices
    inserted.forEach(doc => emitNotificationToUser(doc.userId, doc));

    // 5. Collect active push tokens only for portal users who have push notifications enabled
    const pushEnabledUserIds = portalUsers.filter(u => u.isNotificationEnabled !== false).map(u => u._id);

    if (!pushEnabledUserIds.length) return;

    const devices = await Device.find({
      userId: { $in: pushEnabledUserIds },
      userType: DEVICE_USER_TYPE.CUSTOMER_PORTAL_USER,
      isActive: true,
      pushToken: { $ne: null },
    })
      .select('pushToken')
      .lean();

    const tokens = [...new Set(devices.map(d => d.pushToken).filter(Boolean))];
    if (!tokens.length) return;

    // 6. Send multicast push notification via Firebase customer portal app
    const { invalidTokens } = await sendMulticastPushNotification({
      tokens,
      title: notificationTitle,
      body: notificationBody,
      data: {
        entityId: entityId.toString(),
        entityDisplayId,
        companyId: companyId.toString(),
        type: notificationType,
      },
      portal: 'customer',
    });

    // 7. Deactivate permanently-invalid tokens (NotRegistered / invalid-registration-token)
    if (invalidTokens.length) {
      await Device.updateMany({ pushToken: { $in: invalidTokens } }, { $set: { isActive: false } }).catch(err =>
        logger.error('Failed to deactivate invalid push tokens:', err.message),
      );
      logger.info(`Deactivated ${invalidTokens.length} invalid device token(s) after transaction notification push`);
    }
  } catch (err) {
    logger.error(`Failed to send transaction notification [${notificationType}]:`, err.message);
  }
};

module.exports = { sendTransactionNotification };
