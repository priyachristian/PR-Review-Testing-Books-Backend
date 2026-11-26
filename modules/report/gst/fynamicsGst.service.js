const { logApiCall } = require('../../sales/invoice/eInvoice.service');
const { default: axios } = require('axios');
const { getClientConnection, getCommonModels } = require('../../../services/model.service');
const ApiError = require('../../../utils/ApiError');
const httpStatus = require('http-status');
const { GST_MESSAGES } = require('../../../utils/messages');
const { THIRD_PARTY_PROVIDERS } = require('../../../utils/enum');
const { getFynamicsClientToken, resolveSandboxOverrides } = require('../../../utils/getFynamicsAuthToken');
const { FYNAMICS_ROUTES, buildFynamicsUrl } = require('../../../utils/fynamicsApiRoutes');
const { decryptBlob } = require('../../../utils/cryptography');
const { normalizeFynamicsResponse, isAuthExpiryError } = require('../../sales/invoice/fynamicsEInvoice.service');
const { getStateIndex, getStateCodeFromStateValue } = require('../gstr1/locationMaster.service');

const FYNAMICS_SEARCH_TAXPAYER_ACTION = 'TP';

const toTaxpayerResponseShape = (data, stateIndex) => {
  const addr = data?.pradr?.addr || {};
  return {
    ...data,
    TradeName: data?.tradeNam ?? '',
    LegalName: data?.lgnm ?? '',
    Gstin: data?.gstin ?? '',
    AddrBno: addr.bno ?? '',
    AddrBnm: addr.bnm ?? '',
    AddrSt: addr.st ?? '',
    AddrLoc: addr.loc ?? '',
    AddrPncd: addr.pncd ?? '',
    StateCode: addr.stcd ? getStateCodeFromStateValue(stateIndex, addr.stcd) || '' : '',
  };
};

const getFynamicsGstDetails = async (gstin, companyId, userId) => {
  const connection = getClientConnection();
  const { ThirdPartyCredentials, Company } = getCommonModels();
  const session = await connection.startSession();
  try {
    await session.startTransaction();
    const credentials = await ThirdPartyCredentials.findOne({ companyId, platformName: THIRD_PARTY_PROVIDERS.FYNAMICS });
    if (!credentials) {
      throw new ApiError(httpStatus.NOT_FOUND, GST_MESSAGES.CREDENTIALS_NOT_FOUND);
    }

    const company = await Company.findOne({ _id: companyId }, { applicableFeature: 1 }).lean();
    if (!company) {
      throw new ApiError(httpStatus.BAD_REQUEST, GST_MESSAGES.COMPANY_NOT_FOUND);
    }
    if (!company.applicableFeature) {
      throw new ApiError(httpStatus.BAD_REQUEST, GST_MESSAGES.APPLICABLE_FEATURE_NOT_CONFIGURED);
    }

    const sandbox = resolveSandboxOverrides(decryptBlob(credentials.credentialsJson));
    const URL = `${buildFynamicsUrl(FYNAMICS_ROUTES.GST_SEARCH_TAXPAYER, sandbox?.baseUrl)}/${FYNAMICS_SEARCH_TAXPAYER_ACTION}/${gstin}`;

    let requestHeaders;
    const callFynamics = async ({ forceRefresh = false } = {}) => {
      const clientToken = await getFynamicsClientToken({ forceRefresh, sandbox });
      requestHeaders = { accept: 'application/json', Authorization: `Bearer ${clientToken}` };
      return axios.get(URL, { headers: requestHeaders });
    };

    try {
      let response = await callFynamics();
      let normalized = normalizeFynamicsResponse(response.data);

      if (isAuthExpiryError(normalized)) {
        response = await callFynamics({ forceRefresh: true });
        normalized = normalizeFynamicsResponse(response.data);
      }

      let message = GST_MESSAGES.FETCH_SUCCESS;
      if (normalized.status != 1) {
        message = normalized?.error?.map(err => err.errorMsg).join(', ') || 'Failed to fetch GSTIN details';
      }

      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        {},
        response.data,
        message,
        response.status,
        String(normalized.status ?? '0'),
        {
          packageName: company.applicableFeature,
          chargeable: true,
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: requestHeaders,
          responseHeader: response.headers,
        },
      );

      if (normalized.status != 1) {
        throw new ApiError(httpStatus.BAD_REQUEST, message);
      }

      const stateIndex = await getStateIndex({ mode: 'GST' });
      return { status: 1, data: toTaxpayerResponseShape(normalized.data, stateIndex) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const apiResponseData = error?.response?.data;
      const normalizedError = normalizeFynamicsResponse(apiResponseData);
      const errorMessage =
        normalizedError?.error
          ?.map(err => err?.errorMsg)
          .filter(Boolean)
          .join(', ') ||
        apiResponseData?.message ||
        error?.message ||
        'Failed to fetch GSTIN details';
      await logApiCall(
        credentials._id,
        userId,
        companyId,
        URL,
        {},
        apiResponseData,
        errorMessage,
        error?.response?.status || httpStatus.BAD_GATEWAY,
        String(normalizedError?.status ?? '0'),
        {
          packageName: company.applicableFeature,
          chargeable: Boolean(error?.response),
          providerName: THIRD_PARTY_PROVIDERS.FYNAMICS,
          requestHeader: requestHeaders,
          responseHeader: error?.response?.headers,
        },
      );
      throw new ApiError(error?.response?.status || httpStatus.BAD_GATEWAY, errorMessage);
    }
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  getFynamicsGstDetails,
};
