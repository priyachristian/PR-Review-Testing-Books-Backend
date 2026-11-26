const { getAbssAdminModels } = require('../../services/model.service');

const getCountries = async () => {
  const { Country } = getAbssAdminModels();
  return Country.find({}).select('_id name isoCode').sort({ name: 1 }).lean();
};

const getStates = async countryId => {
  const { State } = getAbssAdminModels();
  return State.find({ countryId }).select('_id name isoCode').sort({ name: 1 }).lean();
};

const getCities = async stateId => {
  const { City } = getAbssAdminModels();
  return City.find({ stateId }).select('_id name').sort({ name: 1 }).lean();
};

module.exports = {
  getCountries,
  getStates,
  getCities,
};
