const { getCommonModels } = require('../../../services/model.service');
const { getTemplateSchedule } = require('./schedule');

// Falls back to the company-adding admin's phone (then the company's contact phone) when
// the template itself has no adminPhoneNumber set — mirrors companyProfile.service.js's
// getDefaultAdminPhone, duplicated here to avoid a circular require (that module requires
// getSummaryStatus from the whatsApp module).
const getDefaultAdminPhone = async companyId => {
  const { Company, User } = getCommonModels();
  const company = await Company.findById(companyId).select('addedBy contactPhone').lean();
  if (!company) return '';

  if (company.addedBy) {
    const admin = await User.findById(company.addedBy).select('phone').lean();
    if (admin?.phone) return admin.phone;
  }

  return company.contactPhone || '';
};

const getEffectiveAdminPhones = async (config, templateKey) => {
  const templatePhones = (getTemplateSchedule(config, templateKey)?.adminPhoneNumber || [])
    .map(phone => phone?.trim())
    .filter(Boolean);
  if (templatePhones.length) return templatePhones;

  const defaultPhone = await getDefaultAdminPhone(config.companyId);
  return defaultPhone ? [defaultPhone] : [];
};

module.exports = {
  getEffectiveAdminPhones,
};
