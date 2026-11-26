const { THIRD_PARTY_PROVIDERS } = require('../../../utils/enum');
const { SUBSCRIPTION_STATUS, APP_NAME } = require('@smit9313/abss-models-core/src/utils/enum');
const { getCommonModels, getBooksModels } = require('../../../services/model.service');
const { encryptBlob } = require('../../../utils/cryptography');

async function logApiCall(
  credentialsId,
  userId,
  companyId,
  endpoint,
  requestBody,
  responseBody,
  message,
  statusCode,
  responseStatus,
  {
    packageName,
    referenceId,
    referenceType,
    chargeable = false,
    providerName = THIRD_PARTY_PROVIDERS.FYNAMICS,
    requestHeader,
    responseHeader,
  } = {},
) {
  // Logging must never fail the caller — the IRN/e-waybill may already be generated.
  try {
    const { UserThirdPartyApiLogs, ThirdPartyProvider, ThirdPartyApiPackage } = getBooksModels();
    const payload = {
      companyId,
      userId,
      thirdPartyCredentialsId: credentialsId,
      endpoint,
      requestBody,
      responseBody: responseBody ?? { message: message || 'No response received from provider' },
      statusCode,
      message,
      isSuccess: String(responseStatus) === '1',
      requestHeader: requestHeader ? encryptBlob(requestHeader) : undefined,
      responseHeader: responseHeader ? encryptBlob(responseHeader) : undefined,
    };

    if (referenceId && referenceType) {
      payload.referenceId = referenceId;
      payload.referenceType = referenceType;
    }

    const { CompanySubscription } = getCommonModels();
    const subscription = await CompanySubscription.findOne(
      {
        companyId,
        status: { $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.DUE] },
        appName: APP_NAME.BOOKS,
      },
      { _id: 1, currentBillingCycleId: 1 },
    )
      .sort({ createdAt: -1 })
      .lean();

    if (subscription) {
      payload.subscriptionId = subscription._id;
      payload.billingCycleId = subscription.currentBillingCycleId || null;
    }

    if (chargeable && packageName) {
      const provider = await ThirdPartyProvider.findOne({ name: providerName, isActive: true }).lean();
      const apiPackage =
        provider && (await ThirdPartyApiPackage.findOne({ providerId: provider._id, packageName, isActive: true }).lean());
      if (apiPackage) {
        payload.thirdPartyApiPackageId = apiPackage._id;
        payload.chargeAmount = apiPackage.salesCost;
        payload.costAmount = apiPackage.purchaseCost;
        payload.currency = apiPackage.currency;
      }
    }

    await UserThirdPartyApiLogs.create(payload);
  } catch (err) {
    console.error('logApiCall failed (non-fatal):', err?.message || err);
  }
}

module.exports = {
  logApiCall,
};
