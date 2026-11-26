const { getBooksModels } = require('../../../services/model.service');

const getStatus = async () => {
  const { MaintenanceMode } = await getBooksModels();
  let status = await MaintenanceMode.findOne();
  if (!status) {
    status = await MaintenanceMode.create({}); // default record
  }
  return status;
};

const updateStatus = async (data, userId) => {
  const { MaintenanceMode } = await getBooksModels();
  let status = await MaintenanceMode.findOne();
  if (!status) status = new MaintenanceMode();
  status.isActive = data.isActive;
  status.message = data.message || status.message;
  status.updatedBy = userId;
  await status.save();
  return status;
};

module.exports = {
  getStatus,
  updateStatus,
};
