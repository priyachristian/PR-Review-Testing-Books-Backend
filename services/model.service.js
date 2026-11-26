const httpStatus = require('http-status');
const ApiError = require('../utils/ApiError');

// services/model.service.js
let appInstance = null;

const setApp = app => {
  appInstance = app;
};

const getModels = () => {
  if (!appInstance) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'App instance not set. Make sure to call setApp before using models.');
  }
  return appInstance.locals.db.models;
};

const getClient = () => {
  if (!appInstance) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'App instance not set. Make sure to call setApp before using models.');
  }
  return appInstance.locals.db.client;
};

// const getConnection = () => {
//   if (!appInstance) {
//     throw new ApiError(httpStatus.SERVICE_UNAVAILABLE,'App instance not set. Make sure to call setApp before using models.');
//   }
//   return appInstance.locals.db.connections;
// };

const getClientConnection = () => {
  if (!appInstance) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'App instance not set. Make sure to call setApp before using models.');
  }
  return appInstance.locals.db.connection;
};

const getCommonModels = () => {
  if (!appInstance) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'App instance not set. Make sure to call setApp before using models.');
  }
  return appInstance.locals.db.models.common;
};

const getBooksCrmModels = () => {
  if (!appInstance) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'App instance not set. Make sure to call setApp before using models.');
  }

  return appInstance.locals.db.models.booksCrm;
};

const getBooksModels = () => {
  if (!appInstance) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'App instance not set. Make sure to call setApp before using models.');
  }
  return appInstance.locals.db.models.books;
};

const getCrmModels = () => {
  if (!appInstance) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'App instance not set. Make sure to call setApp before using models.');
  }
  return appInstance.locals.db.models.crm;
};

const getAbssAdminModels = () => {
  if (!appInstance) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'App instance not set. Make sure to call setApp before using models.');
  }

  return appInstance.locals.db.models.abssAdmin;
};

module.exports = {
  setApp,
  getModels,
  getClientConnection,
  getClient,
  // getConnection,
  getCommonModels,
  getBooksCrmModels,
  getBooksModels,
  getCrmModels,
  getAbssAdminModels,
};
