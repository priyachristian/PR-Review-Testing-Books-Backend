/**
 * Email Service using Microsoft Graph API (Recommended)
 *
 * This service uses Microsoft Graph API with OAuth 2.0 for secure email sending.
 * This is the recommended approach as it:
 * - Works with Security Defaults enabled
 * - Is more secure than SMTP basic auth
 * - Is future-proof (SMTP basic auth will be blocked in March 2026)
 *
 * Configuration (via .env file):
 *
 * Microsoft Graph API (Required):
 *   MS_GRAPH_TENANT_ID=your-tenant-id
 *   MS_GRAPH_CLIENT_ID=your-client-id
 *   MS_GRAPH_CLIENT_SECRET=your-client-secret
 *   EMAIL_FROM=your-email@yourdomain.com
 *
 * Setup Instructions:
 * 1. Register an app in Microsoft Entra ID (Azure Portal)
 *    - Go to: https://entra.microsoft.com > App registrations > New registration
 * 2. Add API permissions:
 *    - Microsoft Graph > Application permissions > Mail.Send
 * 3. Grant admin consent
 * 4. Create a Client Secret
 * 5. Copy Tenant ID, Client ID, and Client Secret to .env file
 */
const httpStatus = require('http-status');
const nodemailer = require('nodemailer');
const config = require('../config/config');
const logger = require('../config/logger');
const ApiError = require('./ApiError');
const { ClientSecretCredential } = require('@azure/identity');
const { Client } = require('@microsoft/microsoft-graph-client');
const { decryptBlobRaw, looksEncrypted } = require('../utils/cryptography');
const {
  TokenCredentialAuthenticationProvider,
} = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');

let graphClient = null;

/**
 * Initialize Microsoft Graph Client
 * @returns {Object} Microsoft Graph Client instance
 */
const initializeGraphClient = () => {
  if (graphClient) {
    return graphClient;
  }

  // Check if Graph API is configured
  if (!config.email.graph.tenantId || !config.email.graph.clientId || !config.email.graph.clientSecret) {
    logger.warn(
      'Microsoft Graph API not configured. Please set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, and MS_GRAPH_CLIENT_SECRET',
    );
    return null;
  }

  try {
    // Create credential using Client Secret
    const credential = new ClientSecretCredential(
      config.email.graph.tenantId,
      config.email.graph.clientId,
      config.email.graph.clientSecret,
    );

    // Create authentication provider
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });

    // Initialize Graph client
    graphClient = Client.initWithMiddleware({ authProvider });

    logger.info('Microsoft Graph client initialized successfully');
    return graphClient;
  } catch (error) {
    logger.error('Failed to initialize Microsoft Graph client:', error);
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, `Failed to initialize Graph client: ${error.message}`);
  }
};

/**
 * Send email using Microsoft Graph API
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} text - Plain text email content
 * @param {string} html - HTML email content (optional)
 * @returns {Promise<void>}
 */
const sendEmailViaGraph = async (to, subject, text, html = null) => {
  const client = initializeGraphClient();

  if (!client) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Microsoft Graph client not initialized. Please check your configuration.',
    );
  }

  if (!config.email.from) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'EMAIL_FROM is not configured. Please set the sender email address.');
  }

  try {
    // Prepare email message
    const message = {
      message: {
        subject,
        body: {
          contentType: html ? 'html' : 'text',
          content: html || text,
        },
        toRecipients: [
          {
            emailAddress: {
              address: to,
            },
          },
        ],
      },
    };

    // Send email using Graph API
    // The sender email must match the authenticated app's user or be a mailbox the app has permission to send from
    const senderEmail = config.email.from;
    await client.api(`/users/${senderEmail}/sendMail`).post(message);

    logger.info(`Email sent to ${to} via Microsoft Graph API`);
  } catch (error) {
    logger.error('Microsoft Graph API error:', error);

    // Provide more helpful error messages
    if (error.statusCode === 401) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        'Authentication failed. Please check your Microsoft Graph credentials (Tenant ID, Client ID, Client Secret)',
      );
    } else if (error.statusCode === 403) {
      throw new ApiError(
        httpStatus.FORBIDDEN,
        'Permission denied. Please ensure Mail.Send permission is granted and admin consent is provided.',
      );
    } else if (error.statusCode === 404) {
      throw new ApiError(httpStatus.NOT_FOUND, `User not found: ${config.email.from}. Please verify the sender email address.`);
    } else {
      throw new ApiError(httpStatus.BAD_GATEWAY, `Failed to send email via Graph API: ${error.message}`);
    }
  }
};

/**
 * Send email using Microsoft Graph API
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} text - Plain text email content
 * @param {string} html - HTML email content (optional)
 * @returns {Promise<void>}
 */
const sendEmail = async (to, subject, text, html = null) => {
  if (!config.email.graph.tenantId || !config.email.graph.clientId || !config.email.graph.clientSecret) {
    throw new ApiError(
      httpStatus.SERVICE_UNAVAILABLE,
      'Email service not configured. Please configure Microsoft Graph API credentials.',
    );
  }

  await sendEmailViaGraph(to, subject, text, html);
};

/**
 * Send email using company SMTP configuration (nodemailer)
 * @param {Object} params
 * @param {Object} params.smtpConfig - { smtpHost, smtpPort, secure, username, password }
 * @param {string} params.to - Recipient email address
 * @param {string} params.subject - Email subject
 * @param {string} [params.text] - Plain text content
 * @param {string} [params.html] - HTML content
 * @param {Array} [params.attachments] - Nodemailer attachments [{ filename, content, contentType }]
 * @returns {Promise<void>}
 */
const sendEmailViaSmtp = async ({ smtpConfig, to, subject, text, html = null, attachments = [] }) => {
  if (!smtpConfig?.smtpHost || !smtpConfig?.smtpPort || !smtpConfig?.username || !smtpConfig?.password) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'SMTP configuration is incomplete.');
  }

  if (!to) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Recipient email address is required.');
  }

  const config = { ...smtpConfig };

  if (config.password && looksEncrypted(config.password)) {
    config.password = decryptBlobRaw(JSON.parse(config.password));
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: Boolean(config.secure),
      auth: {
        user: config.username,
        pass: config.password,
      },
    });

    await transporter.sendMail({
      from: config.username,
      to,
      subject,
      text: text || undefined,
      html: html || undefined,
      attachments: attachments?.length ? attachments : undefined,
    });

    logger.info(`Email sent to ${to} via SMTP (${smtpConfig.smtpHost})`);
  } catch (error) {
    logger.error('SMTP email error:', error);
    throw new ApiError(httpStatus.BAD_GATEWAY, `Failed to send email via SMTP: ${error.message}`);
  }
};

module.exports = {
  sendEmail,
  sendEmailViaSmtp,
};
