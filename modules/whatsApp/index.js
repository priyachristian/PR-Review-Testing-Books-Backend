const httpStatus = require('http-status');
const { getBooksModels, getCommonModels } = require('../../services/model.service');
const ApiError = require('../../utils/ApiError');
const { sendWhatsAppTemplate } = require('../../utils/whatsapp');
const { APP_NAME, SUBSCRIPTION_STATUS } = require('@smit9313/abss-models-core/src/utils/enum');

const { TIMEZONE } = require('./shared/constants');
const {
  getCurrentIstMoment,
  getDueSummaryTypes,
  getDateRangeForSummaryType,
  formatPeriodLabel,
  isTemplateEnabled,
  getTemplateSchedule,
} = require('./shared/schedule');
const { getEffectiveAdminPhones } = require('./shared/phones');
const { claimSummarySend, releaseSummaryClaim, recordSummaryStatus, getSummaryStatus } = require('./shared/markers');

const financialSummary = require('./financialSummary');
const quotationsSummary = require('./quotationsSummary');
const dailyActivityByUser = require('./dailyActivityByUser');
const salesPipeline = require('./salesPipeline');
const inventoryMovement = require('./inventoryMovement');
const topPerformers = require('./topPerformers');

const TEMPLATES = {
  [financialSummary.key]: financialSummary,
  [quotationsSummary.key]: quotationsSummary,
  [dailyActivityByUser.key]: dailyActivityByUser,
  [salesPipeline.key]: salesPipeline,
  [inventoryMovement.key]: inventoryMovement,
  [topPerformers.key]: topPerformers,
};

const getImplementedTemplates = () => Object.values(TEMPLATES).filter(t => t.implemented);

const getTemplateHandler = templateKey => {
  const handler = TEMPLATES[templateKey];
  if (!handler?.implemented) {
    throw new ApiError(httpStatus.BAD_REQUEST, `WhatsApp template "${templateKey}" is not implemented yet`);
  }
  return handler;
};

const getPeriodTemplate = (handler, summaryType, { incremental = false } = {}) => {
  const override =
    typeof handler.getPeriodTemplate === 'function' ? handler.getPeriodTemplate(summaryType, { incremental }) : null;
  if (override) return override;

  const period = handler.periods?.[summaryType];
  if (!period?.template) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Period "${summaryType}" is not configured for ${handler.key}`);
  }
  return period.template;
};

const sendSummaryToCompany = async ({
  companyId,
  phones,
  templateKey,
  summaryType,
  startDate,
  endDate,
  periodStart,
  periodEnd,
  companyName,
  incremental = false,
}) => {
  const handler = getTemplateHandler(templateKey);
  const template = getPeriodTemplate(handler, summaryType, { incremental });
  const dateLabel = formatPeriodLabel(summaryType, periodStart, periodEnd);
  const summaryData = await handler.getSummaryData(companyId, startDate, endDate, dateLabel, companyName, {
    incremental,
    periodEnd,
  });
  const components = handler.buildTemplateComponents(summaryData);

  const sendResults = await Promise.all(
    phones.map(phone =>
      sendWhatsAppTemplate(phone, {
        name: template.name,
        languageCode: template.languageCode,
        components,
      }),
    ),
  );

  return {
    summaryData,
    template,
    templateKey,
    sendResults,
    summaryType,
    incremental: !!incremental,
    period: {
      start: periodStart.format('YYYY-MM-DD'),
      end: periodEnd.format('YYYY-MM-DD'),
    },
  };
};

const sendWpSummaryToCompany = async params =>
  sendSummaryToCompany({
    ...params,
    templateKey: params.templateKey || financialSummary.key,
  });

const getDueSummaryRecipients = async (now = getCurrentIstMoment()) => {
  const { Company, CompanySubscription } = getCommonModels();
  const { AdminSummarySetting } = getBooksModels();

  if (!AdminSummarySetting) {
    return [];
  }

  const implementedKeys = getImplementedTemplates().map(t => t.key);

  const configs = await AdminSummarySetting.find({
    'whatsapp.templates': {
      $elemMatch: {
        key: { $in: implementedKeys },
        enabled: true,
        $or: [{ 'daily.enabled': true }, { 'weekly.enabled': true }, { 'monthly.enabled': true }],
      },
    },
  }).lean();

  if (!configs.length) return [];

  const recipientsByConfig = await Promise.all(
    configs.map(async config => {
      const due = [];

      for (const templateKey of implementedKeys) {
        if (!isTemplateEnabled(config, templateKey)) continue;

        const phones = await getEffectiveAdminPhones(config, templateKey);
        if (!phones.length) continue;

        const templateSchedule = getTemplateSchedule(config, templateKey);

        for (const summaryType of getDueSummaryTypes(config, templateKey, now)) {
          if (!TEMPLATES[templateKey]?.periods?.[summaryType]) continue;

          const incremental =
            summaryType === 'daily'
              ? !!(templateSchedule.daily?.incremental ?? templateSchedule.incremental)
              : summaryType === 'weekly'
                ? !!(templateSchedule.weekly?.incremental ?? templateSchedule.incremental)
                : false;

          due.push({
            config,
            templateKey,
            summaryType,
            phones,
            incremental,
            ...getDateRangeForSummaryType(summaryType, now),
          });
        }
      }

      return due;
    }),
  );

  const recipients = recipientsByConfig.flat();
  if (!recipients.length) return [];

  const companyIds = [...new Set(recipients.map(r => r.config.companyId.toString()))];

  const activeSubscriptions = await CompanySubscription.find({
    companyId: { $in: companyIds },
    appName: APP_NAME.BOOKS,
    status: {
      $in: [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.DUE],
    },
  })
    .select('companyId')
    .lean();

  const activeCompanyIds = new Set(activeSubscriptions.map(s => s.companyId.toString()));
  const eligibleRecipients = recipients.filter(r => activeCompanyIds.has(r.config.companyId.toString()));
  if (!eligibleRecipients.length) return [];

  const companies = await Company.find({ _id: { $in: eligibleRecipients.map(r => r.config.companyId) } })
    .select('name')
    .lean();

  const companyMap = new Map(companies.map(c => [c._id.toString(), c]));

  return eligibleRecipients.map(recipient => ({
    ...recipient,
    company: companyMap.get(recipient.config.companyId.toString()) || { name: 'Company' },
  }));
};

module.exports = {
  TIMEZONE,
  getCurrentIstMoment,
  getDueSummaryRecipients,
  sendWpSummaryToCompany,
  claimSummarySend,
  releaseSummaryClaim,
  recordSummaryStatus,
  getSummaryStatus,
};
