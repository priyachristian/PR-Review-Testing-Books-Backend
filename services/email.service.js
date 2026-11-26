const httpStatus = require('http-status');
const ejs = require('ejs');
const { APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');
const { getAbssAdminModels } = require('./model.service');
const { sendEmail } = require('../utils/email');

const EMAIL_TEMPLATE_NAMES = {
  BOOKS_INVITE_USER: 'books-invite-user',
  BOOKS_PORTAL_INVITE: 'books-portal-invite',
  MODULE_DOCUMENT_NOTIFICATION: 'books-module-document-notification',
  DISPATCH_DELIVERY_PICKUP: 'Delivery & Pickup Update',
  DISPATCH_FULL_TRUCK_LOAD: 'Full Truck Load Dispatch Confirmation',
  DISPATCH_INVOICE_DETAILS: 'Invoice Dispatch Details',
};

const DISPATCH_EMAIL_TEMPLATES = {
  'Transport & Courier Service': EMAIL_TEMPLATE_NAMES.DISPATCH_INVOICE_DETAILS,
  'Full Truck Load': EMAIL_TEMPLATE_NAMES.DISPATCH_FULL_TRUCK_LOAD,
  'OurSelf Delivery': EMAIL_TEMPLATE_NAMES.DISPATCH_DELIVERY_PICKUP,
  'Pickup By Customer': EMAIL_TEMPLATE_NAMES.DISPATCH_DELIVERY_PICKUP,
};

const getDispatchEmailTemplateName = dispatchMode => DISPATCH_EMAIL_TEMPLATES[dispatchMode] || null;

const sendBookInviteEmail = async ({ email, customerName, companyName, invitedByName, verifyEmailLink }) => {
  try {
    const { EmailTemplate } = getAbssAdminModels();

    const emailTemplate = await EmailTemplate.findOne({
      name: EMAIL_TEMPLATE_NAMES.BOOKS_INVITE_USER,
      isActive: true,
    }).lean();

    if (!emailTemplate) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Email template not found');
    }

    if (emailTemplate) {
      const decodedHtmlText = decodeHtml(emailTemplate?.body, {
        customerName: customerName || 'Customer',
        companyName: companyName || '',
        invitedByName: invitedByName || '',
        verifyEmailLink,
      });

      const subjectTemplate = emailTemplate?.subject?.replace(/&lt;/g, '<')?.replace(/&gt;/g, '>');

      const renderedSubject = ejs.render(subjectTemplate || '', {
        companyName: companyName || '',
      });

      await sendEmail(email, renderedSubject, null, decodedHtmlText);
    }
  } catch (error) {
    logger.error('Error sending Books invite email:', error);
    throw error;
  }
};

const sendPortalInviteEmail = async ({ email, customerName, companyName, inviteLink, expiryDays = 7 }) => {
  try {
    const { EmailTemplate } = getAbssAdminModels();

    const emailTemplate = await EmailTemplate.findOne({
      name: EMAIL_TEMPLATE_NAMES.BOOKS_PORTAL_INVITE,
      isActive: true,
    }).lean();

    if (!emailTemplate) {
      throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Email template not found');
    }

    const templateData = {
      customerName: customerName || 'Valued Customer',
      companyName: companyName || '',
      inviteLink,
      expiryDays: expiryDays.toString(),
      currentYear: new Date().getFullYear().toString(),
    };

    const decodedHtmlText = decodeHtml(emailTemplate?.body, templateData);

    const subjectTemplate = emailTemplate?.subject?.replace(/&lt;/g, '<')?.replace(/&gt;/g, '>');

    const renderedSubject = ejs.render(subjectTemplate || '', templateData);

    await sendEmail(email, renderedSubject, null, decodedHtmlText);
  } catch (error) {
    logger.error('Error sending portal invite email:', error);
    throw error;
  }
};

const buildModuleDocumentEmail = async ({
  title,
  companyName,
  companyLogo,
  customerName,
  moduleLabel,
  documentId,
  status,
  hasAttachment,
  supportEmail,
  templateVariables = {},
  templateName = EMAIL_TEMPLATE_NAMES.MODULE_DOCUMENT_NOTIFICATION,
}) => {
  const { EmailTemplate } = getAbssAdminModels();

  const emailTemplate = await EmailTemplate.findOne({
    name: templateName,
    isActive: true,
  }).lean();

  if (!emailTemplate) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Email template not found');
  }

  const templateData = {
    title,
    companyName: companyName || '',
    companyLogo: companyLogo || null,
    customerName: customerName || 'Customer',
    moduleLabel: moduleLabel || '',
    documentId: documentId || '',
    status: status || '',
    hasAttachment: Boolean(hasAttachment),
    supportEmail: supportEmail || null,
    ...templateVariables,
  };

  const html = decodeHtml(emailTemplate.body, templateData);

  const subjectTemplate = emailTemplate?.subject?.replace(/&lt;/g, '<')?.replace(/&gt;/g, '>');
  const subject = ejs.render(subjectTemplate || '', templateData);

  return { subject, html };
};

const decodeHtml = (htmlTemplate, data) => {
  const decodedHtml = htmlTemplate.replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const finalHtml = ejs.render(decodedHtml, data);

  return finalHtml;
};

module.exports = {
  sendBookInviteEmail,
  sendPortalInviteEmail,
  buildModuleDocumentEmail,
  getDispatchEmailTemplateName,
  EMAIL_TEMPLATE_NAMES,
};
