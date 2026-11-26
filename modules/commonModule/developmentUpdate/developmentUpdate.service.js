const { getBooksModels } = require('../../../services/model.service');

const listDevelopmentUpdate = async companyId => {
  const { DevelopmentUpdate } = getBooksModels();

  return DevelopmentUpdate.find({
    isActive: true,
    $or: [{ scope: 'GLOBAL' }, { scope: 'COMPANY', companyId: companyId }],
  })
    .sort({ date: -1 })
    .lean();
};

module.exports = {
  listDevelopmentUpdate,
};
