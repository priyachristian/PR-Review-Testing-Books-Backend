'use strict';

const admin = require('firebase-admin');
const config = require('./config');

// Project: abss-customer  (FIREBASE_* env vars)
// Used for: Customer App (abss-customer-app) tokens
// Send with: portal = 'abss'
const abssPortalServiceAccount = {
  type: config.firebase_abss.type,
  project_id: config.firebase_abss.projectId,
  private_key_id: config.firebase_abss.privateKeyId,
  private_key: (config.firebase_abss.privateKey || '').replace(/\\n/g, '\n'),
  client_email: config.firebase_abss.clientEmail,
  client_id: config.firebase_abss.clientId,
  auth_uri: config.firebase_abss.authUri,
  token_uri: config.firebase_abss.tokenUri,
  auth_provider_x509_cert_url: config.firebase_abss.authProviderX509CertUrl,
  client_x509_cert_url: config.firebase_abss.clientX509CertUrl,
  universe_domain: config.firebase_abss.universeDomain,
};

// Project: abss-18ce4  (FIREBASE_CUSTOMER_* env vars)
// Used for: ABSS Books frontend (abss-books-frontend) tokens
// Send with: portal = 'customer'
const abssCustomerPortalServiceAccount = {
  type: config.firebaseCustomer.type,
  project_id: config.firebaseCustomer.projectId,
  private_key_id: config.firebaseCustomer.privateKeyId,
  private_key: (config.firebaseCustomer.privateKey || '').replace(/\\n/g, '\n'),
  client_email: config.firebaseCustomer.clientEmail,
  client_id: config.firebaseCustomer.clientId,
  auth_uri: config.firebaseCustomer.authUri,
  token_uri: config.firebaseCustomer.tokenUri,
  auth_provider_x509_cert_url: config.firebaseCustomer.authProviderX509CertUrl,
  client_x509_cert_url: config.firebaseCustomer.clientX509CertUrl,
  universe_domain: config.firebaseCustomer.universeDomain,
};

const abssPortal =
  admin.apps.find(a => a.name === 'abssPortal') ||
  admin.initializeApp({ credential: admin.credential.cert(abssPortalServiceAccount) }, 'abssPortal');

const abssCustomerPortal =
  admin.apps.find(a => a.name === 'abssCustomerPortal') ||
  admin.initializeApp({ credential: admin.credential.cert(abssCustomerPortalServiceAccount) }, 'abssCustomerPortal');

module.exports = { abssPortal, abssCustomerPortal };
