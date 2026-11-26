const dotenv = require('dotenv');
const path = require('path');
const Joi = require('joi');
const ApiError = require('../utils/ApiError');
const httpStatus = require('http-status');

// Determine environment
const env = process.env.NODE_ENV || 'development';

// Load environment-specific .env file
dotenv.config({ path: path.join(__dirname, `../.env.${env}`) });
// Fallback to default .env if environment-specific file doesn't exist
dotenv.config({ path: path.join(__dirname, '../.env') });

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test', 'pcbzone', 'staging').required(),
    PORT: Joi.number().default(3000),

    // Database URI
    ABSS_CLUSTER: Joi.string().required().description('abss cluster url'),

    // Database Name
    ABSS_BOOKS: Joi.string().required().description('abss-book db'),
    ABSS_CORE_DEV: Joi.string().required().description('abss-core-dev db'),
    ABSS_BOOKS_CRM_DEV: Joi.string().required().description('abss-books-crm-dev db'),
    ABSS_CRM_DEV: Joi.string().required().description('abss-crm-dev db'),
    ABSS_ADMIN: Joi.string().required().description('abss-admin db'),

    // Authentication

    // Authentication
    JWT_SECRET: Joi.string().required().description('JWT secret key'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(30).description('minutes after which access tokens expire'),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().default(30).description('days after which refresh tokens expire'),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which reset password token expires'),
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number().default(10).description('minutes after which verify email token expires'),

    // Email configuration
    EMAIL_FROM: Joi.string().description('the from field in the emails sent by the app'),
    TEAMS_WEBHOOK_URL: Joi.string().description('Microsoft Teams webhook URL for error alerts'),
    // Microsoft Graph API configuration
    MS_GRAPH_TENANT_ID: Joi.string().description('Microsoft Graph tenant ID'),
    MS_GRAPH_CLIENT_ID: Joi.string().description('Microsoft Graph client ID'),
    MS_GRAPH_CLIENT_SECRET: Joi.string().description('Microsoft Graph client secret'),

    FRONTEND_URL: Joi.string().description('frontend url '),
    ALLOWED_ORIGIN: Joi.string().description('allow origin '),
    DOMAIN: Joi.string().description('domain name '),
    // AWS S3 configuration
    S3_BUCKET_NAME: Joi.string(),
    AWS_REGION: Joi.string(),
    AWS_SECRET_ACCESS_KEY: Joi.string(),
    AWS_ACCESS_KEY_ID: Joi.string(),
    AWS_FOLDER_NAME: Joi.string(),

    // Credentials Encryption Key
    CREDENTIALS_ENCRYPTION_KEY: Joi.string().required().description('credentials encryption key (at rest, server only)'),
    CREDENTIALS_TRANSPORT_KEY: Joi.string()
      .allow('')
      .description('credentials transport key, shared with the frontend bundle — never the at-rest key'),
    FYNAMICS_BASE_URL: Joi.string().required().description('fynamics base url'),
    FYNAMICS_CLIENT_ID: Joi.string().required().description('fynamics client id'),
    FYNAMICS_CLIENT_SECRET: Joi.string().required().description('fynamics client secret'),

    MASTERS_INDIA_BASE_URL: Joi.string().optional().description('masters india base url'),
    MASTERS_INDIA_TIMEOUT_MS: Joi.number().integer().min(1000).default(30000).description('masters india request timeout (ms)'),
    MASTERS_INDIA_USERNAME: Joi.string().required().description('ABSS Masters India account username'),
    MASTERS_INDIA_PASSWORD: Joi.string().required().description('ABSS Masters India account password'),
    // Masters India common API (GSTIN taxpayer search): OAuth with the same username and password plus its own client.
    MASTERS_INDIA_COMMON_API_BASE_URL: Joi.string()
      .default('https://commonapi.mastersindia.co')
      .description('masters india common api base url'),
    MASTERS_INDIA_COMMON_API_CLIENT_ID: Joi.string().optional().allow('').description('masters india common api client id'),
    MASTERS_INDIA_COMMON_API_CLIENT_SECRET: Joi.string()
      .optional()
      .allow('')
      .description('masters india common api client secret'),

    // Redis configuration
    REDIS_HOST: Joi.string().required().description('redis host'),
    REDIS_PORT: Joi.number().required().description('redis port'),
    REDIS_USERNAME: Joi.string().required().description('redis username'),
    REDIS_PASSWORD: Joi.string().required().description('redis password'),

    // Account-backend websocket bus (cross-app broadcast — auth sync, maintenance mode, live notifications)
    ACCOUNT_WS_URL: Joi.string().optional().description('account-backend websocket url'),

    //New Relic configuration
    NEW_RELIC_LICENSE_KEY: Joi.string().required().description('new relic license key'),
    NEW_RELIC_APP_NAME: Joi.string().required().description('new relic app name'),

    // Firebase ABSS App Project (FIREBASE_* env vars)
    FIREBASE_TYPE: Joi.string().description('Firebase abss app type'),
    FIREBASE_PROJECT_ID: Joi.string().description('Firebase abss app project ID'),
    FIREBASE_PRIVATE_KEY_ID: Joi.string().description('Firebase abss app private key ID'),
    FIREBASE_PRIVATE_KEY: Joi.string().description('Firebase abss app private key'),
    FIREBASE_CLIENT_EMAIL: Joi.string().description('Firebase abss app client email'),
    FIREBASE_CLIENT_ID: Joi.string().description('Firebase abss app client ID'),
    FIREBASE_AUTH_URI: Joi.string().description('Firebase abss app auth URI'),
    FIREBASE_TOKEN_URI: Joi.string().description('Firebase abss app token URI'),
    FIREBASE_AUTH_PROVIDER_X509_CERT_URL: Joi.string().description('Firebase abss app auth provider cert URL'),
    FIREBASE_CLIENT_X509_CERT_URL: Joi.string().description('Firebase abss app client cert URL'),
    FIREBASE_UNIVERSE_DOMAIN: Joi.string().description('Firebase abss app universe domain'),

    // Firebase Customer Portal Project (FIREBASE_CUSTOMER_* env vars)
    FIREBASE_CUSTOMER_TYPE: Joi.string().description('Firebase customer portal type'),
    FIREBASE_CUSTOMER_PROJECT_ID: Joi.string().description('Firebase customer portal project ID'),
    FIREBASE_CUSTOMER_PRIVATE_KEY_ID: Joi.string().description('Firebase customer portal private key ID'),
    FIREBASE_CUSTOMER_PRIVATE_KEY: Joi.string().description('Firebase customer portal private key'),
    FIREBASE_CUSTOMER_CLIENT_EMAIL: Joi.string().description('Firebase customer portal client email'),
    FIREBASE_CUSTOMER_CLIENT_ID: Joi.string().description('Firebase customer portal client ID'),
    FIREBASE_CUSTOMER_AUTH_URI: Joi.string().description('Firebase customer portal auth URI'),
    FIREBASE_CUSTOMER_TOKEN_URI: Joi.string().description('Firebase customer portal token URI'),
    FIREBASE_CUSTOMER_AUTH_PROVIDER_X509_CERT_URL: Joi.string().description('Firebase customer portal auth provider cert URL'),
    FIREBASE_CUSTOMER_CLIENT_X509_CERT_URL: Joi.string().description('Firebase customer portal client cert URL'),
    FIREBASE_CUSTOMER_UNIVERSE_DOMAIN: Joi.string().description('Firebase customer portal universe domain'),

    BULL_BOARD_USERNAME: Joi.string().optional().description('Bull Board username'),
    BULL_BOARD_PASSWORD: Joi.string().optional().description('Bull Board password'),

    WHATSAPP_PHONE_NUMBER_ID: Joi.string().optional().description('WhatsApp Business phone number ID'),
    WHATSAPP_ACCESS_TOKEN: Joi.string().optional().description('WhatsApp Cloud API access token'),
    WHATSAPP_API_VERSION: Joi.string().optional().description('WhatsApp Graph API version'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, `Config validation error: ${error.message}`);
}

// Export configuration
module.exports = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,

  // Database configuration
  mongoose: {
    cluster_url: envVars.ABSS_CLUSTER,
    db_names: {
      common: envVars.ABSS_CORE_DEV,
      booksCrm: envVars.ABSS_BOOKS_CRM_DEV,
      books: envVars.ABSS_BOOKS,
      crm: envVars.ABSS_CRM_DEV,
      admin: envVars.ABSS_ADMIN,
    },
  },

  // JWT configuration
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
  },

  // Email configuration
  email: {
    from: envVars.EMAIL_FROM,
    graph: {
      tenantId: envVars.MS_GRAPH_TENANT_ID,
      clientId: envVars.MS_GRAPH_CLIENT_ID,
      clientSecret: envVars.MS_GRAPH_CLIENT_SECRET,
    },
  },
  teams_webhook_url: envVars.TEAMS_WEBHOOK_URL,
  // Frontend URL (for callbacks, emails, etc.)
  frontendUrl: envVars.FRONTEND_URL,
  allowedOrigin: envVars.ALLOWED_ORIGIN,
  domain: envVars.DOMAIN,

  // AWS S3 configuration
  s3bucket: {
    AWS_ACCESS_KEY_ID: envVars.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: envVars.AWS_SECRET_ACCESS_KEY,
    AWS_REGION: envVars.AWS_REGION,
    S3_BUCKET_NAME: envVars.S3_BUCKET_NAME,
    AWS_FOLDER_NAME: envVars.AWS_FOLDER_NAME,
  },

  redis: {
    host: envVars.REDIS_HOST,
    port: envVars.REDIS_PORT,
    username: envVars.REDIS_USERNAME,
    password: envVars.REDIS_PASSWORD,
  },

  accountWsUrl: envVars.ACCOUNT_WS_URL,

  // Credentials Encryption Key
  credentialsEncryptionKey: envVars.CREDENTIALS_ENCRYPTION_KEY,
  credentialsTransportKey: envVars.CREDENTIALS_TRANSPORT_KEY,
  fynamics: {
    baseUrl: envVars.FYNAMICS_BASE_URL,
    clientId: envVars.FYNAMICS_CLIENT_ID,
    clientSecret: envVars.FYNAMICS_CLIENT_SECRET,
  },
  mastersIndia: {
    baseUrl: envVars.MASTERS_INDIA_BASE_URL,
    timeoutMs: envVars.MASTERS_INDIA_TIMEOUT_MS,
    username: envVars.MASTERS_INDIA_USERNAME,
    password: envVars.MASTERS_INDIA_PASSWORD,
    commonApi: {
      baseUrl: envVars.MASTERS_INDIA_COMMON_API_BASE_URL,
      clientId: envVars.MASTERS_INDIA_COMMON_API_CLIENT_ID,
      clientSecret: envVars.MASTERS_INDIA_COMMON_API_CLIENT_SECRET,
    },
  },

  //New Relic Configration
  newRelic: {
    licenseKey: envVars.NEW_RELIC_LICENSE_KEY,
    appName: envVars.NEW_RELIC_APP_NAME,
  },

  // Firebase ABSS App Project
  firebase_abss: {
    type: envVars.FIREBASE_TYPE,
    projectId: envVars.FIREBASE_PROJECT_ID,
    privateKeyId: envVars.FIREBASE_PRIVATE_KEY_ID,
    privateKey: envVars.FIREBASE_PRIVATE_KEY,
    clientEmail: envVars.FIREBASE_CLIENT_EMAIL,
    clientId: envVars.FIREBASE_CLIENT_ID,
    authUri: envVars.FIREBASE_AUTH_URI,
    tokenUri: envVars.FIREBASE_TOKEN_URI,
    authProviderX509CertUrl: envVars.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    clientX509CertUrl: envVars.FIREBASE_CLIENT_X509_CERT_URL,
    universeDomain: envVars.FIREBASE_UNIVERSE_DOMAIN,
  },

  // Firebase Customer Portal Project
  firebaseCustomer: {
    type: envVars.FIREBASE_CUSTOMER_TYPE,
    projectId: envVars.FIREBASE_CUSTOMER_PROJECT_ID,
    privateKeyId: envVars.FIREBASE_CUSTOMER_PRIVATE_KEY_ID,
    privateKey: envVars.FIREBASE_CUSTOMER_PRIVATE_KEY,
    clientEmail: envVars.FIREBASE_CUSTOMER_CLIENT_EMAIL,
    clientId: envVars.FIREBASE_CUSTOMER_CLIENT_ID,
    authUri: envVars.FIREBASE_CUSTOMER_AUTH_URI,
    tokenUri: envVars.FIREBASE_CUSTOMER_TOKEN_URI,
    authProviderX509CertUrl: envVars.FIREBASE_CUSTOMER_AUTH_PROVIDER_X509_CERT_URL,
    clientX509CertUrl: envVars.FIREBASE_CUSTOMER_CLIENT_X509_CERT_URL,
    universeDomain: envVars.FIREBASE_CUSTOMER_UNIVERSE_DOMAIN,
  },
  bullBoard: {
    username: envVars.BULL_BOARD_USERNAME,
    password: envVars.BULL_BOARD_PASSWORD,
  },

  //WhatsApp Configration
  whatsapp: {
    phoneNumberId: envVars.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: envVars.WHATSAPP_ACCESS_TOKEN,
    apiVersion: envVars.WHATSAPP_API_VERSION,
  },
};
