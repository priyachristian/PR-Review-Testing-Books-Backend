const moment = require('moment');
const logger = require('../config/logger');
const {
  MODULE_NAMES,
  INVOICE_STATUS,
  QUOTE_STATUS,
  SALES_ORDER_STATUS,
  DELIVERY_CHALLAN_STATUS,
  PO_STATUSES,
  GRPO_STATUSES,
  BILL_STATUSES,
  CREDIT_NOTE_STATUS,
  DEBIT_NOTE_STATUS,
} = require('../utils/enum');
const { sendEmailViaSmtp } = require('../utils/email');
const { getCommonModels, getBooksCrmModels, getBooksModels } = require('./model.service');
const { decryptBlobRaw } = require('../utils/cryptography');
const { generateNativePdf, isNativePdfModule, PdfGenerationError } = require('./pdfNative.service');
const { createQueue } = require('../config/queueConfig');
const { buildTeamsAlert, sendTeamsAlert } = require('../utils/teamsNotifier');
const { getCurrency, enrichDocumentCurrency } = require('./currencyResolver.service');
const { getPrimaryBankDetails } = require('../modules/banking/bank/bank.service');
const { resolveCustomerPaymentTermsId, applyCompanyPaymentTermsFallback } = require('../utils/customerPaymentTerms');
const { isWhatsAppConfigured, uploadWhatsAppMedia } = require('../utils/whatsapp');
const { sendSalesDocumentTemplate, sendPurchaseDocumentTemplate } = require('./wpDailySummary.service');
const { getCommentModuleConfig } = require('../utils/moduleConfig');
const { buildModuleDocumentEmail, getDispatchEmailTemplateName } = require('./email.service');

const MODULE_EMAIL_QUEUE = 'module-email';
const MODULE_WHATSAPP_QUEUE = 'module-whatsapp';

/** BullMQ custom job ids cannot contain `:`. Include timestamp so Quote SENT→DRAFT→SENT can notify again. */
const buildNotificationJobId = (channel, companyId, moduleName, mongoId, status) =>
  [channel, companyId, moduleName, mongoId, status || 'status', Date.now()]
    .map(part => String(part).replace(/:/g, '-'))
    .join('-');

const MODULE_DISPLAY_NAMES = {
  [MODULE_NAMES.QUOTATION]: 'Quotation',
  [MODULE_NAMES.SALES_ORDER]: 'Sales Order',
  [MODULE_NAMES.DELIVERY_CHALLAN]: 'Delivery Challan',
  [MODULE_NAMES.INVOICE]: 'Invoice',
  [MODULE_NAMES.PURCHASE_ORDER]: 'Purchase Order',
  [MODULE_NAMES.GRPO]: 'GRPO',
  [MODULE_NAMES.BILL]: 'Bill',
  [MODULE_NAMES.CREDIT_NOTE]: 'Credit Note',
  [MODULE_NAMES.DEBIT_NOTE]: 'Debit Note',
  [MODULE_NAMES.PAYMENT_RECEIVED]: 'Payment Received',
  [MODULE_NAMES.PAYMENT_MADE]: 'Payment Made',
  [MODULE_NAMES.EXPENSE]: 'Expense',
  [MODULE_NAMES.DISPATCH]: 'Dispatch',
};

const MODULE_DOCUMENT_ID_FIELDS = {
  [MODULE_NAMES.QUOTATION]: 'quoteId',
  [MODULE_NAMES.SALES_ORDER]: 'orderId',
  [MODULE_NAMES.DELIVERY_CHALLAN]: 'challanId',
  [MODULE_NAMES.INVOICE]: 'invoiceId',
  [MODULE_NAMES.PURCHASE_ORDER]: 'purchaseOrderId',
  [MODULE_NAMES.GRPO]: 'grpoOrderId',
  [MODULE_NAMES.BILL]: 'billId',
  [MODULE_NAMES.CREDIT_NOTE]: 'creditNoteId',
  [MODULE_NAMES.DEBIT_NOTE]: 'debitNoteId',
  [MODULE_NAMES.PAYMENT_RECEIVED]: 'paymentReceivedId',
  [MODULE_NAMES.PAYMENT_MADE]: 'paymentMadeId',
  [MODULE_NAMES.EXPENSE]: 'expenseId',
  [MODULE_NAMES.DISPATCH]: '_id',
};

const MODULE_WHATSAPP_CONFIG = {
  [MODULE_NAMES.QUOTATION]: {
    channel: 'sales',
    docType: 'Quote',
    dateField: 'quoteDate',
    partyField: 'customerId',
  },
  [MODULE_NAMES.SALES_ORDER]: {
    channel: 'sales',
    docType: 'Sales Order',
    dateField: 'orderDate',
    partyField: 'customerId',
  },
  [MODULE_NAMES.DELIVERY_CHALLAN]: {
    channel: 'sales',
    docType: 'Delivery Challan',
    dateField: 'challanDate',
    partyField: 'customerId',
  },
  [MODULE_NAMES.INVOICE]: {
    channel: 'sales',
    docType: 'Invoice',
    dateField: 'invoiceDate',
    partyField: 'customerId',
  },
  [MODULE_NAMES.PURCHASE_ORDER]: {
    channel: 'purchase',
    docType: 'Purchase Order',
    dateField: 'date',
    partyField: 'vendor',
  },
  [MODULE_NAMES.GRPO]: {
    channel: 'purchase',
    docType: 'GRPO',
    dateField: 'date',
    partyField: 'vendor',
  },
  [MODULE_NAMES.BILL]: {
    channel: 'purchase',
    docType: 'Bill',
    dateField: 'billDate',
    partyField: 'vendor',
  },
  [MODULE_NAMES.CREDIT_NOTE]: {
    channel: 'sales',
    docType: 'Credit Note',
    dateField: 'creditNoteDate',
    partyField: 'customerId',
  },
  [MODULE_NAMES.DEBIT_NOTE]: {
    channel: 'purchase',
    docType: 'Debit Note',
    dateField: 'debitNoteDate',
    partyField: 'vendorId',
  },
};

/**
 * Cancel/void/reject statuses across the notified modules. A document that lands in one of
 * these must never trigger a customer-facing notification (we would email/WhatsApp a cancelled
 * document). Built from the enum values so a rename in the enums stays in sync.
 */
const NON_ISSUED_STATUSES = new Set([
  INVOICE_STATUS.CANCELLED,
  INVOICE_STATUS.VOID,
  QUOTE_STATUS.CANCELLED,
  QUOTE_STATUS.REJECTED,
  SALES_ORDER_STATUS.CANCELLED,
  DELIVERY_CHALLAN_STATUS.CANCELLED,
  PO_STATUSES.CANCELLED,
  PO_STATUSES.REJECTED,
  GRPO_STATUSES.CANCELLED,
  BILL_STATUSES.CANCELLED,
  CREDIT_NOTE_STATUS.CANCELLED,
  DEBIT_NOTE_STATUS.CANCELLED,
]);

/**
 * Returns true only for the first status transition away from the module's initial status,
 * and never when the new status is a cancel/void/reject status.
 * @param {string} oldStatus
 * @param {string} newStatus
 * @param {string} [initialStatus='DRAFT']
 * @returns {boolean}
 */
const isFirstStatusChange = (oldStatus, newStatus, initialStatus = 'DRAFT') =>
  oldStatus === initialStatus && newStatus !== initialStatus && !NON_ISSUED_STATUSES.has(newStatus);

const getDocumentDisplayId = (moduleName, document) => {
  if (!document) return '';
  const field = MODULE_DOCUMENT_ID_FIELDS[moduleName];
  if (field && document[field]) return document[field];
  return document._id?.toString() || '';
};

const toPlain = doc => {
  if (!doc) return null;
  if (typeof doc.toObject === 'function') return doc.toObject();
  return { ...doc };
};

const resolveRecipient = async (document, moduleName, companyId) => {
  let partyId =
    document?.customerId?._id || document?.customerId || document?.vendorId?._id || document?.vendorId || document?.vendor;
  let documentId;
  let invoiceDate;

  if (moduleName === MODULE_NAMES.DISPATCH) {
    const invoiceId = document?.invoiceId?._id || document?.invoiceId;
    if (!invoiceId) return null;

    const { Invoice } = getBooksModels();
    const invoice = await Invoice.findOne({ _id: invoiceId, companyId }).select('invoiceId invoiceDate customerId').lean();
    if (!invoice) return null;

    partyId = invoice.customerId?._id || invoice.customerId;
    documentId = invoice.invoiceId;
    invoiceDate = invoice.invoiceDate;
  }

  if (!partyId) {
    return null;
  }

  const { Customer } = getBooksCrmModels();
  const customer = await Customer.findById(partyId).select('bpEmail customerDisplayName companyName bpPrimaryContactName').lean();
  if (!customer?.bpEmail) return null;

  const primaryContactName = [customer.bpPrimaryContactName?.firstName, customer.bpPrimaryContactName?.lastName]
    .filter(Boolean)
    .join(' ');
  return {
    email: customer.bpEmail,
    name: customer.customerDisplayName || customer.companyName || 'Customer',
    recipientName: primaryContactName || customer.customerDisplayName || customer.companyName || 'Customer',
    documentId,
    ...(invoiceDate ? { invoiceDate } : {}),
  };
};

const buildPlainTextFallback = ({ moduleLabel, documentId, status, companyName, customerName, hasAttachment, supportEmail }) =>
  [
    `Hello ${customerName},`,
    ``,
    `The status of ${moduleLabel} ${documentId} has been updated to ${status} by ${companyName}.`,
    hasAttachment ? `A copy of ${moduleLabel} ${documentId} is attached to this email as a PDF for your records.` : null,
    ``,
    supportEmail
      ? `Have a question? If you have any questions regarding this ${moduleLabel.toLowerCase()}, please reply to this email or contact us at ${supportEmail}.`
      : null,
    ``,
    `Regards,`,
    companyName ? `${companyName} Team` : null,
    ``,
    companyName ? `This email was sent by ABSS on behalf of ${companyName}.` : null,
  ]
    .filter(Boolean)
    .join('\n');

const MODULES_WITH_PAYMENT_TERMS = new Set([MODULE_NAMES.QUOTATION, MODULE_NAMES.DELIVERY_CHALLAN]);

const MODULES_WITH_COMPANY_SHIPPING = new Set([
  MODULE_NAMES.PURCHASE_ORDER,
  MODULE_NAMES.GRPO,
  MODULE_NAMES.BILL,
  MODULE_NAMES.DEBIT_NOTE,
]);

const enrichDocumentForPdf = async (document, { moduleName, companyId } = {}) => {
  const plain = toPlain(document);
  if (!plain) return null;

  const partyId =
    plain.customerId?._id || plain.customerId || plain.vendorId?._id || plain.vendorId || plain.vendor?._id || plain.vendor;

  // Populate whenever party id exists but none of the party fields is a loaded object with address.
  const shouldPopulate =
    partyId &&
    !(typeof plain.customerId === 'object' && plain.customerId?.address) &&
    !(typeof plain.vendorId === 'object' && plain.vendorId?.address) &&
    !(typeof plain.vendor === 'object' && plain.vendor?.address);

  const needsPaymentTerms = MODULES_WITH_PAYMENT_TERMS.has(moduleName);
  const partySelect = needsPaymentTerms
    ? 'customerDisplayName customerNumber customerPhoneNumber companyName address otherDetails bpEmail useBranchPaymentTerms paymentTermsId paymentTerms branch _id'
    : 'customerDisplayName customerNumber customerPhoneNumber companyName address otherDetails bpEmail _id';

  let party = null;

  if (shouldPopulate) {
    const { Customer } = getBooksCrmModels();
    let partyQuery = Customer.findById(partyId).select(partySelect);
    if (needsPaymentTerms) {
      partyQuery = partyQuery.populate('paymentTermsId').populate('branch.paymentTermsId');
    }
    party = await partyQuery.lean();

    if (party) {
      if (plain.vendorId) plain.vendorId = party;
      if (plain.vendor) plain.vendor = party;
      plain.customerId = party;
    }
  } else {
    party = plain.customerId?.address
      ? plain.customerId
      : plain.vendorId?.address
        ? plain.vendorId
        : plain.vendor?.address
          ? plain.vendor
          : null;
  }

  if (MODULES_WITH_COMPANY_SHIPPING.has(moduleName)) {
    let companyShippingAddress = {};
    if (plain.addressId) {
      const addressId = plain.addressId.toString();
      if (!plain.customer) {
        const { Company } = getCommonModels();
        const company = companyId ? await Company.findById(companyId).select('address additionalShippingAddresses').lean() : null;
        if (company?.address?._id?.toString() === addressId) {
          companyShippingAddress = company.address;
        } else {
          const additional = company?.additionalShippingAddresses?.find(addr => addr._id?.toString() === addressId);
          if (additional) companyShippingAddress = additional;
        }
      } else {
        const { Customer } = getBooksCrmModels();
        const dropShipCustomerId = plain.customer?._id || plain.customer;
        const dropShipCustomer = await Customer.findById(dropShipCustomerId).select('address customerDisplayName').lean();
        if (dropShipCustomer?.address?.shipping?._id?.toString() === addressId) {
          companyShippingAddress = dropShipCustomer.address.shipping;
        } else {
          const additional = dropShipCustomer?.address?.additionalShippingAddresses?.find(
            addr => addr._id?.toString() === addressId,
          );
          if (additional) companyShippingAddress = additional;
        }
        if (dropShipCustomer?.customerDisplayName) {
          plain.customerDisplayName = dropShipCustomer.customerDisplayName;
        }
      }
    }
    plain.shippingAddress = companyShippingAddress;
  } else if (moduleName === MODULE_NAMES.QUOTATION) {
    let quoteShippingAddress = {};
    if (plain.addressId) {
      const addressId = plain.addressId.toString();
      if (party?.address?.shipping?._id?.toString() === addressId) {
        quoteShippingAddress = party.address.shipping;
      } else {
        const additional = party?.address?.additionalShippingAddresses?.find(addr => addr._id?.toString() === addressId);
        if (additional) quoteShippingAddress = additional;
      }
    }
    plain.shippingAddress = quoteShippingAddress;
  } else if (!plain.shippingAddress || !Object.keys(plain.shippingAddress).length) {
    let shippingAddress = {};
    if (party && plain.addressId) {
      const addressId = plain.addressId.toString();
      if (party.address?.shipping?._id?.toString() === addressId) {
        shippingAddress = party.address.shipping;
      } else {
        const additional = party.address?.additionalShippingAddresses?.find(addr => addr._id?.toString() === addressId);
        if (additional) shippingAddress = additional;
      }
    }
    plain.shippingAddress = shippingAddress;
  }

  const { Branch, Item } = getBooksCrmModels();
  const [branch, bankDetails] = await Promise.all([
    plain.branchId ? Branch.findById(plain.branchId).select('name').lean() : null,
    plain.bankAccountId ? getPrimaryBankDetails(plain.bankAccountId) : null,
  ]);
  plain.branchName = branch?.name || null;
  plain.bankAccountId = bankDetails || {};

  if (needsPaymentTerms) {
    const { CompanySettings } = getCommonModels();
    const { PaymentTerm } = getBooksCrmModels();
    const companySettings = companyId
      ? await CompanySettings.findOne({ companyId })
          .select('salesCreditLimit')
          .populate({ path: 'salesCreditLimit.paymentTermsId', model: PaymentTerm })
          .populate({ path: 'salesCreditLimit.branch.paymentTermsId', model: PaymentTerm })
          .lean()
      : null;
    applyCompanyPaymentTermsFallback(party, companySettings?.salesCreditLimit, plain.branchId);
    plain.paymentTermsId = resolveCustomerPaymentTermsId(party, plain.branchId);
  } else if (plain.paymentTermsId && typeof plain.paymentTermsId !== 'object') {
    const { PaymentTerm } = getBooksCrmModels();
    plain.paymentTermsId = await PaymentTerm.findById(plain.paymentTermsId).lean();
  }

  const missingItemIds = [
    ...new Set(
      (plain.items || [])
        .filter(item => item.itemId && (!item.itemName || !item.itemNo || !item.hsnCode || !item.itemUnit))
        .map(item => (item.itemId._id || item.itemId).toString()),
    ),
  ];
  if (missingItemIds.length && companyId) {
    const masterItems = await Item.find({ _id: { $in: missingItemIds }, companyId })
      .select('itemName itemNo itemCode hsnCode itemUnit')
      .lean();
    const masterMap = masterItems.reduce((acc, mi) => ({ ...acc, [mi._id.toString()]: mi }), {});
    plain.items = (plain.items || []).map(item => {
      const itemIdStr = item.itemId && (item.itemId._id || item.itemId).toString();
      const master = itemIdStr && masterMap[itemIdStr];
      if (!master) return item;
      return {
        ...item,
        itemName: item.itemName || master.itemName || '',
        itemNo: item.itemNo || master.itemNo || master.itemCode || '',
        hsnCode: item.hsnCode || master.hsnCode || '',
        itemUnit: item.itemUnit || master.itemUnit || '',
      };
    });
  }

  if (moduleName === MODULE_NAMES.INVOICE && plain.invoiceDispatchId && !plain.dispatchDetails) {
    const { InvoiceDispatch } = getBooksModels();
    plain.dispatchDetails = await InvoiceDispatch.findById(plain.invoiceDispatchId)
      .populate('transportCourier.transportId', 'name trackingLink bookingOfficeAddress gstNo')
      .lean();
  }

  return companyId ? enrichDocumentCurrency(companyId, plain) : plain;
};

const loadCompanyProfile = async companyId => {
  const { Company } = getCommonModels();
  const company = await Company.findById(companyId).populate('baseCurrency').lean();
  return company || null;
};

const normalizeEmailAttachments = ({ pdf = null, defaultFileName = 'document.pdf' } = {}) => {
  if (!pdf || !Buffer.isBuffer(pdf.content)) return [];

  return [
    {
      filename: pdf.filename || defaultFileName,
      content: pdf.content,
      contentType: pdf.contentType || pdf.mimetype || 'application/pdf',
    },
  ];
};

const fetchFreshDocument = async (moduleName, document) => {
  const documentId = document?._id?.toString?.() || document?._id;
  if (!documentId) return document;

  const moduleConfig = getCommentModuleConfig(moduleName);
  if (!moduleConfig?.model) return document;

  try {
    const fresh = await moduleConfig.model.findById(documentId);
    return fresh || document;
  } catch (error) {
    logger.warn(`fetchFreshDocument: falling back to stale snapshot for ${moduleName} ${documentId}: ${error?.message}`);
    return document;
  }
};

// Renders a document to PDF natively via @smit9313/abss-pdf (no Puppeteer/Chromium).
// Returns { content: Buffer, filename, contentType } or null.
// When throwOnFailure is true (email/WhatsApp path), a rendering failure raises PdfGenerationError.
const generateModuleDocumentPdf = async ({ companyId, moduleName, document, throwOnFailure = false }) => {
  const documentDisplayId = getDocumentDisplayId(moduleName, document);

  try {
    const freshDocument = await fetchFreshDocument(moduleName, document);
    const profile = await loadCompanyProfile(companyId);
    const pdfDocument = await enrichDocumentForPdf(freshDocument, { moduleName, companyId });

    if (!profile || !pdfDocument) {
      logger.warn(`generateModuleDocumentPdf: unable to prepare PDF payload for ${moduleName} ${documentDisplayId}`);
      return null;
    }

    const moduleLabel = MODULE_DISPLAY_NAMES[moduleName] || moduleName;
    const fileName = `${moduleLabel.replace(/\s+/g, '_')}_${documentDisplayId || 'document'}.pdf`;

    return await generateNativePdf({
      companyId,
      moduleName,
      document: pdfDocument,
      profile,
      fileName,
    });
  } catch (error) {
    logger.error(`generateModuleDocumentPdf: PDF generation failed for ${moduleName} ${documentDisplayId}:`, error);
    if (throwOnFailure) {
      if (error instanceof PdfGenerationError) throw error;
      throw new PdfGenerationError(error?.message || 'PDF generation failed', {
        moduleName,
        documentDisplayId,
      });
    }
    return null;
  }
};

const alertPdfNotificationFailure = async ({ channel, companyId, moduleName, documentDisplayId, reason }) => {
  const message = `PDF ${channel} aborted: ${moduleName} ${documentDisplayId} (company ${companyId}) — ${reason}`;
  logger.error(
    `module${channel}: aborting send — PDF unavailable for ${moduleName} ${documentDisplayId} (company=${companyId}): ${reason}`,
  );

  try {
    await sendTeamsAlert(
      buildTeamsAlert({
        title: '🚨 MODULE PDF ALERT',
        errorLogId: 'MODULE_NOTIFICATION',
        service: moduleName,
        controller: `processModule${channel}`,
        message,
      }),
    );
  } catch {}
};

const alertEmailTemplateFailure = async ({ companyId, moduleName, documentDisplayId, reason }) => {
  const message = `Module email aborted: ${moduleName} ${documentDisplayId} (company ${companyId}) — email template unavailable: ${reason}`;
  logger.error(
    `processModuleEmail: aborting send — email template unavailable for ${moduleName} ${documentDisplayId} (company=${companyId}): ${reason}`,
  );

  try {
    await sendTeamsAlert(
      buildTeamsAlert({
        title: '🚨 MODULE EMAIL ALERT',
        errorLogId: 'MODULE_NOTIFICATION',
        service: moduleName,
        controller: 'processModuleEmail',
        message,
      }),
    );
  } catch {}
};

const isModuleWhatsAppEnabled = async (companyId, moduleName) => {
  const { CompanySettings } = getCommonModels();
  const settings = await CompanySettings.findOne({ companyId }).select('moduleEmailConfig').lean();
  const moduleConfig = (settings?.moduleEmailConfig || []).find(config => config.moduleName === moduleName);
  return !!moduleConfig?.isWhatsAppEnabled;
};

const processModuleEmail = async ({ companyId, moduleName, document }) => {
  if (!companyId || !moduleName || !document) {
    logger.warn('processModuleEmail: missing companyId, moduleName, or document');
    return false;
  }

  const documentDisplayId = getDocumentDisplayId(moduleName, document);
  const expectsPdf = isNativePdfModule(moduleName);

  const { CompanySettings, Company } = getCommonModels();
  const settings = await CompanySettings.findOne({ companyId })
    .select('isEmailEnabled emailConfiguration moduleEmailConfig')
    .lean();

  if (!settings?.isEmailEnabled) {
    logger.debug(`processModuleEmail: email disabled for company ${companyId}`);
    return false;
  }

  if (!settings.emailConfiguration) {
    logger.warn(`processModuleEmail: SMTP config missing for company ${companyId}`);
    return false;
  }

  const moduleConfig = (settings.moduleEmailConfig || []).find(cfg => cfg.moduleName === moduleName);

  if (!moduleConfig) {
    logger.debug(`processModuleEmail: module ${moduleName} not configured for company ${companyId}`);
    return false;
  }

  if (!moduleConfig.isEnabled) {
    logger.debug(`processModuleEmail: module ${moduleName} email disabled for company ${companyId}`);
    return false;
  }

  const smtpConfig = {
    ...settings.emailConfiguration,
  };

  if (smtpConfig.password) {
    smtpConfig.password = decryptBlobRaw(JSON.parse(smtpConfig.password));
  }

  const recipient = await resolveRecipient(document, moduleName, companyId);
  if (!recipient) {
    logger.warn(`processModuleEmail: no recipient email for ${moduleName} document ${documentDisplayId}`);
    return false;
  }
  const { email: recipientEmail, name: customerName } = recipient;
  const emailDocumentId = recipient.documentId || documentDisplayId;

  const company = await Company.findById(companyId).select('name companyLogo email').lean();
  const companyName = company?.name || '';
  const companyLogo = company?.companyLogo || null;
  const supportEmail = company?.email || smtpConfig.username || null;
  const moduleLabel = MODULE_DISPLAY_NAMES[moduleName] || moduleName;
  const status = moduleName === MODULE_NAMES.DISPATCH ? document?.dispatchMode || '' : document?.status || '';
  const title = `${moduleLabel} ${emailDocumentId} from ${companyName}`.trim();
  let templateVariables = {};
  let templateName;

  if (moduleName === MODULE_NAMES.DISPATCH) {
    templateName = getDispatchEmailTemplateName(document?.dispatchMode);
    if (!templateName) {
      logger.warn(`processModuleEmail: unsupported dispatch mode "${document?.dispatchMode}"`);
      return false;
    }

    const { buildInvoiceDispatchTemplateData, resolveTransportCourierName } = require('./wpDispatch.service');
    const transportCourierName = await resolveTransportCourierName(document);

    templateVariables = {
      ...(buildInvoiceDispatchTemplateData({
        dispatch: document,
        invoice: { invoiceId: emailDocumentId, invoiceDate: recipient.invoiceDate },
        customer: { customerDisplayName: customerName, recipientName: recipient.recipientName },
        transportCourierName,
        recipientName: recipient.recipientName,
      }) || {}),
    };
  }

  let subject;
  let html;
  try {
    ({ subject, html } = await buildModuleDocumentEmail({
      title,
      companyName,
      companyLogo,
      customerName,
      moduleLabel,
      documentId: emailDocumentId,
      status,
      hasAttachment: expectsPdf,
      supportEmail,
      templateVariables,
      templateName,
    }));
  } catch (error) {
    await alertEmailTemplateFailure({
      companyId,
      moduleName,
      documentDisplayId,
      reason: error?.message || 'failed to build email content',
    });
    return false;
  }
  const text = buildPlainTextFallback({
    moduleLabel,
    documentId: emailDocumentId,
    status,
    companyName,
    customerName,
    hasAttachment: expectsPdf,
    supportEmail,
  });

  const defaultFileName = `${moduleLabel.replace(/\s+/g, '_')}_${emailDocumentId || 'document'}.pdf`;

  let pdfAttachment = null;
  try {
    pdfAttachment = await generateModuleDocumentPdf({ companyId, moduleName, document, throwOnFailure: true });
  } catch (error) {
    await alertPdfNotificationFailure({
      channel: 'Email',
      companyId,
      moduleName,
      documentDisplayId,
      reason: error?.message || 'PDF generation failed',
    });
    throw error;
  }

  if (expectsPdf && !pdfAttachment) {
    await alertPdfNotificationFailure({
      channel: 'Email',
      companyId,
      moduleName,
      documentDisplayId,
      reason: 'PDF generator returned null (misconfiguration or unsupported input)',
    });
    return false;
  }

  const emailAttachments = normalizeEmailAttachments({
    pdf: pdfAttachment,
    defaultFileName,
  });

  if (moduleName === MODULE_NAMES.DISPATCH) {
    try {
      const { downloadDispatchAttachment, getDispatchFileUrl } = require('./wpDispatch.service');
      const dispatchFileUrl = getDispatchFileUrl(templateVariables.attachmentLink);
      if (dispatchFileUrl) {
        const dispatchFile = await downloadDispatchAttachment(dispatchFileUrl);
        emailAttachments.push({
          filename: dispatchFile.filename,
          content: dispatchFile.buffer,
          contentType: dispatchFile.mimeType,
        });
      }
    } catch (error) {
      logger.error(`processModuleEmail: failed to attach dispatch file for ${emailDocumentId}: ${error.message}`);
    }
  }

  if (expectsPdf && emailAttachments.length === 0) {
    await alertPdfNotificationFailure({
      channel: 'Email',
      companyId,
      moduleName,
      documentDisplayId,
      reason: 'normalized attachments empty after PDF generation',
    });
    return false;
  }

  await sendEmailViaSmtp({
    smtpConfig,
    to: recipientEmail,
    subject,
    text,
    html,
    attachments: emailAttachments,
  });

  logger.info(
    `processModuleEmail: sent ${moduleName} ${emailDocumentId} to ${recipientEmail} with ${emailAttachments.length} attachment(s)`,
  );
  return true;
};

const sendModuleEmail = async ({ companyId, moduleName, document }) => {
  try {
    if (!companyId || !moduleName || !document) {
      logger.warn('sendModuleEmail: missing companyId, moduleName, or document');
      return false;
    }

    const documentDisplayId = getDocumentDisplayId(moduleName, document);
    const plainDocument = toPlain(document);
    const mongoId = plainDocument?._id?.toString?.() || plainDocument?._id || documentDisplayId;
    const jobId = buildNotificationJobId('module-email', companyId, moduleName, mongoId, plainDocument?.status);

    await createQueue(MODULE_EMAIL_QUEUE).add(
      'send-module-email',
      {
        companyId: companyId.toString(),
        moduleName,
        document: JSON.parse(JSON.stringify(plainDocument)),
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      },
    );

    logger.info(`sendModuleEmail: enqueued ${moduleName} ${documentDisplayId} (jobId=${jobId})`);
    return true;
  } catch (error) {
    logger.error(`sendModuleEmail enqueue failed for module ${moduleName}, falling back to inline:`, error);
    try {
      return await processModuleEmail({ companyId, moduleName, document });
    } catch (inlineError) {
      logger.error(`sendModuleEmail inline fallback failed for module ${moduleName}:`, inlineError);
      return false;
    }
  }
};

const resolveWhatsAppPartyId = (document, partyField) => {
  const party = document?.[partyField];
  return party?._id || party || null;
};

const processModuleWhatsApp = async ({ companyId, moduleName, document, invoiceId }) => {
  if (!companyId || !moduleName || (!document && !invoiceId)) {
    logger.warn('processModuleWhatsApp: missing companyId, moduleName, or document');
    return false;
  }

  if (moduleName === MODULE_NAMES.DISPATCH) {
    const { processInvoiceDispatchWhatsApp } = require('./wpDispatch.service');
    return await processInvoiceDispatchWhatsApp({ companyId, dispatch: document, invoiceId });
  }

  if (!isWhatsAppConfigured()) {
    logger.debug('processModuleWhatsApp: WhatsApp is not configured');
    return false;
  }

  if (!(await isModuleWhatsAppEnabled(companyId, moduleName))) {
    logger.debug(`processModuleWhatsApp: WhatsApp disabled for ${moduleName} company ${companyId}`);
    return false;
  }

  const waConfig = MODULE_WHATSAPP_CONFIG[moduleName];
  if (!waConfig) {
    logger.warn(`processModuleWhatsApp: unsupported module ${moduleName}`);
    return false;
  }

  const documentDisplayId = getDocumentDisplayId(moduleName, document);
  const expectsPdf = isNativePdfModule(moduleName);
  const partyId = resolveWhatsAppPartyId(document, waConfig.partyField);

  if (!partyId) {
    logger.warn(`processModuleWhatsApp: no party on ${moduleName} ${documentDisplayId}`);
    return false;
  }

  const { Customer } = getBooksCrmModels();
  const { Company } = getCommonModels();

  const [party, company, currency] = await Promise.all([
    Customer.findById(partyId).select('customerPhoneNumber').lean(),
    Company.findById(companyId).select('name').lean(),
    document.currency ? getCurrency(companyId, document.currency) : null,
  ]);

  const phone = party?.customerPhoneNumber;
  if (!phone) {
    logger.warn(`processModuleWhatsApp: no phone for ${moduleName} ${documentDisplayId}`);
    return false;
  }

  let pdfAttachment = null;
  try {
    pdfAttachment = await generateModuleDocumentPdf({
      companyId,
      moduleName,
      document,
      throwOnFailure: true,
    });
  } catch (error) {
    await alertPdfNotificationFailure({
      channel: 'WhatsApp',
      companyId,
      moduleName,
      documentDisplayId,
      reason: error?.message || 'PDF generation failed',
    });
    throw error;
  }

  if (expectsPdf && !pdfAttachment) {
    await alertPdfNotificationFailure({
      channel: 'WhatsApp',
      companyId,
      moduleName,
      documentDisplayId,
      reason: 'PDF generator returned null (misconfiguration or unsupported input)',
    });
    return false;
  }

  let mediaId = null;
  if (pdfAttachment) {
    try {
      mediaId = await uploadWhatsAppMedia({
        buffer: pdfAttachment.content,
        filename: pdfAttachment.filename,
        mimeType: pdfAttachment.contentType,
      });
    } catch (err) {
      await alertPdfNotificationFailure({
        channel: 'WhatsApp',
        companyId,
        moduleName,
        documentDisplayId,
        reason: `media upload failed: ${err.message}`,
      });
      throw err;
    }
  }

  if (expectsPdf && !mediaId) {
    await alertPdfNotificationFailure({
      channel: 'WhatsApp',
      companyId,
      moduleName,
      documentDisplayId,
      reason: 'PDF media id missing after upload',
    });
    return false;
  }

  const documentDate = document[waConfig.dateField];
  const templatePayload = {
    DocType: waConfig.docType,
    CompanyName: company?.name || '',
    DocumentNumber: documentDisplayId,
    DocumentDate: documentDate ? moment(documentDate).format('D MMM YYYY') : '',
    Amount: document.total,
    CurrencySymbol: currency?.symbol,
    MediaId: mediaId,
    MediaFilename: pdfAttachment?.filename,
  };

  if (waConfig.channel === 'purchase') {
    await sendPurchaseDocumentTemplate(phone, templatePayload);
  } else {
    await sendSalesDocumentTemplate(phone, templatePayload);
  }

  logger.info(`processModuleWhatsApp: sent ${moduleName} ${documentDisplayId} to ${phone} mediaId=${mediaId || 'none'}`);
  return true;
};

const sendModuleWhatsApp = async ({ companyId, moduleName, document }) => {
  try {
    if (!companyId || !moduleName || !document) {
      logger.warn('sendModuleWhatsApp: missing companyId, moduleName, or document');
      return false;
    }

    if (!MODULE_WHATSAPP_CONFIG[moduleName]) {
      logger.warn(`sendModuleWhatsApp: unsupported module ${moduleName}`);
      return false;
    }

    const documentDisplayId = getDocumentDisplayId(moduleName, document);
    const plainDocument = toPlain(document);
    const mongoId = plainDocument?._id?.toString?.() || plainDocument?._id || documentDisplayId;
    const jobId = buildNotificationJobId('module-whatsapp', companyId, moduleName, mongoId, plainDocument?.status);

    await createQueue(MODULE_WHATSAPP_QUEUE).add(
      'send-module-whatsapp',
      {
        companyId: companyId.toString(),
        moduleName,
        document: JSON.parse(JSON.stringify(plainDocument)),
      },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
      },
    );

    logger.info(`sendModuleWhatsApp: enqueued ${moduleName} ${documentDisplayId} (jobId=${jobId})`);
    return true;
  } catch (error) {
    logger.error(`sendModuleWhatsApp enqueue failed for module ${moduleName}, falling back to inline:`, error);
    try {
      return await processModuleWhatsApp({ companyId, moduleName, document });
    } catch (inlineError) {
      logger.error(`sendModuleWhatsApp inline fallback failed for module ${moduleName}:`, inlineError);
      return false;
    }
  }
};

/**
 * Send email + WhatsApp for a status/create notification.
 * Quote may go SENT → DRAFT → SENT; each leave-DRAFT notifies again.
 */
const sendModuleCustomerNotifications = async ({ companyId, moduleName, document }) => {
  if (!companyId || !moduleName || !document) {
    logger.warn('sendModuleCustomerNotifications: missing companyId, moduleName, or document');
    return false;
  }

  if (document.isSplit) {
    return false;
  }

  const plain = toPlain(document);
  const documentDisplayId = getDocumentDisplayId(moduleName, plain);

  try {
    const emailOk = await sendModuleEmail({ companyId, moduleName, document: plain });
    const whatsappOk = await sendModuleWhatsApp({ companyId, moduleName, document: plain });
    return Boolean(emailOk || whatsappOk);
  } catch (error) {
    logger.error(`sendModuleCustomerNotifications failed for ${moduleName} ${documentDisplayId}:`, error);
    return false;
  }
};

/**
 * Fire email + WhatsApp when a document is created already past DRAFT
 * (Save & Sent / Save & Open). Split docs are skipped.
 */
const notifyModuleDocumentIfNonDraft = ({ companyId, moduleName, document, initialStatus = 'DRAFT' }) => {
  if (!companyId || !moduleName || !document) return false;
  if (document.isSplit) return false;

  const status = document.status || initialStatus;
  if (status === initialStatus) return false;
  if (NON_ISSUED_STATUSES.has(status)) return false;

  const plain = typeof document.toObject === 'function' ? document.toObject() : { ...document };

  sendModuleCustomerNotifications({ companyId, moduleName, document: plain }).catch(err =>
    logger.error(
      `notifyModuleDocumentIfNonDraft failed for ${moduleName} ${getDocumentDisplayId(moduleName, plain)}: ${err.message}`,
    ),
  );

  return true;
};

module.exports = {
  buildNotificationJobId,
  sendModuleEmail,
  processModuleEmail,
  sendModuleWhatsApp,
  processModuleWhatsApp,
  sendModuleCustomerNotifications,
  notifyModuleDocumentIfNonDraft,
  isFirstStatusChange,
  isModuleWhatsAppEnabled,
  generateModuleDocumentPdf,
  normalizeEmailAttachments,
  MODULE_DISPLAY_NAMES,
  MODULE_DOCUMENT_ID_FIELDS,
  MODULE_EMAIL_QUEUE,
  MODULE_WHATSAPP_QUEUE,
};
