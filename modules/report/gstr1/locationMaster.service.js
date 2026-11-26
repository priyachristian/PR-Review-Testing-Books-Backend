const httpStatus = require('http-status');
const ApiError = require('../../../utils/ApiError');
const { getAbssAdminModels } = require('../../../services/model.service');

const normalize = v => (v || '').toLowerCase().trim();

const parseRanges = v =>
  (v || '').split(',').map(r => {
    const [s, e] = r.split('-').map(Number);
    return { start: s, end: e || s };
  });

const buildStateIndex = states => {
  const stateByCode = {};
  const codeByName = new Map();

  states.forEach(s => {
    const code = s.gstStateCode;
    if (!code) return;

    stateByCode[code] = s;

    codeByName.set(normalize(s.name), code);
    if (s.isoCode) codeByName.set(normalize(s.isoCode), code);
  });

  return { stateByCode, codeByName };
};

const getStateIndexByCountryIso = async countryIso => {
  const { State } = getAbssAdminModels();
  const isoCode = String(countryIso || '')
    .trim()
    .toUpperCase();

  if (!isoCode) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'countryIso is required');
  }

  const states = await State.aggregate([
    {
      $lookup: {
        from: 'countries',
        localField: 'countryId',
        foreignField: '_id',
        as: 'country',
      },
    },
    { $unwind: '$country' },
    {
      $match: {
        'country.isoCode': isoCode,
      },
    },
    {
      $project: {
        name: 1,
        isoCode: 1,
        countryCode: 1,
        gstStateCode: 1,
        pincodeRange: 1,
      },
    },
  ]);

  if (!states.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, `No states found for countryIso=${isoCode}`);
  }

  return buildStateIndex(states);
};

const getGstStateIndex = async () => {
  const { State } = getAbssAdminModels();

  const states = await State.find({
    gstStateCode: { $exists: true, $ne: '' },
  })
    .select('name isoCode countryCode gstStateCode pincodeRange')
    .lean();

  if (!states.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'GST state metadata not configured');
  }

  return buildStateIndex(states);
};

const getStateIndex = async ({ countryIso, mode } = {}) => {
  if (mode === 'GST') {
    return getGstStateIndex();
  }
  return getStateIndexByCountryIso(countryIso);
};

// Get state code from GSTIN
const getStateCodeFromGstin = ({ stateByCode }, gstin) => {
  const code = String(gstin || '').slice(0, 2);
  return stateByCode[code] ? code : null;
};

// Get state code from state name
const getStateCodeFromStateValue = ({ codeByName }, state) => {
  return codeByName.get(normalize(state)) || null;
};

//  Get state label
const getStateLabelFromCode = ({ stateByCode }, code) => {
  return stateByCode[code]?.name || 'N/A';
};

// Validate pincode
const verifyPinCodeByStateCode = ({ stateByCode }, stateCode, pinCode, entity) => {
  const state = stateByCode[stateCode];
  if (!state) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid State for ${entity}`);
  }

  if (!pinCode) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Pin Code required for ${entity}`);
  }

  const ranges = parseRanges(state.pincodeRange);
  if (!ranges.length) return true;

  const prefix = Number(String(pinCode).slice(0, 3));
  if (Number.isNaN(prefix)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid Pin Code for ${entity}`);
  }

  const valid = ranges.some(r => prefix >= r.start && prefix <= r.end);
  if (!valid) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid Pin Code for ${entity}`);
  }

  return true;
};

const isIGSTExists = ({ stateIndex, myState, customerState, myGSTNo, customerGSTNo }) => {
  const myCode = getStateCodeFromGstin(stateIndex, myGSTNo) || getStateCodeFromStateValue(stateIndex, myState);

  const customerCode = getStateCodeFromGstin(stateIndex, customerGSTNo) || getStateCodeFromStateValue(stateIndex, customerState);

  if (myCode && customerCode) {
    return myCode !== customerCode;
  }

  return normalize(myState) !== normalize(customerState);
};

module.exports = {
  getStateIndex,
  getStateIndexByCountryIso,
  getGstStateIndex,
  getStateCodeFromGstin,
  getStateCodeFromStateValue,
  getStateLabelFromCode,
  verifyPinCodeByStateCode,
  isIGSTExists,
};
