const mongoose = require('mongoose');
const moment = require('moment');

/**
 * Builds OR conditions for branchId and/or divisionId filters
 * @param {Object} filter - Filter object containing branchId and/or divisionId (comma-separated strings)
 * @returns {Object|null} - Query conditions object or null if no conditions
 */
const buildBranchDivisionOrCondition = (filter, options = {}) => {
  const condition = {};

  if (filter.branchId) {
    const branchArray = filter.branchId.split(',').filter(Boolean);
    if (branchArray.length > 0) {
      condition.branchId = {
        $in: branchArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.divisionId) {
    const divisionArray = filter.divisionId.split(',').filter(Boolean);
    if (divisionArray.length > 0) {
      condition.divisionId = {
        $in: divisionArray.map(id => new mongoose.Types.ObjectId(id)),
      };
    }
  }

  if (filter.startDate && filter.endDate && options.dateField) {
    condition[options.dateField] = {
      $gte: moment(filter.startDate).startOf('day').toDate(),
      $lte: moment(filter.endDate).endOf('day').toDate(),
    };
  } else if (options.dateField && (filter.date || filter[options.dateField])) {
    const day = filter.date || filter[options.dateField];
    if (day) {
      condition[options.dateField] = {
        $gte: moment(day).startOf('day').toDate(),
        $lte: moment(day).endOf('day').toDate(),
      };
    }
  }

  return Object.keys(condition).length > 0 ? condition : null;
};

const resolveFinancialYearRange = ({ fy } = {}) => {
  const now = new Date();
  let fyStartYear;

  if (typeof fy === 'string' && fy.trim()) {
    const match = fy.match(/^(\d{4})(?:\s*-\s*(\d{2,4}))?$/);
    if (match) fyStartYear = Number(match[1]);
  }

  if (!fyStartYear) {
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    fyStartYear = currentMonth >= 3 ? currentYear : currentYear - 1;
  }

  const startDate = new Date(fyStartYear, 3, 1, 0, 0, 0, 0);
  const endDate = new Date(fyStartYear + 1, 2, 31, 23, 59, 59, 999);

  return {
    fy: `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`,
    startDate,
    endDate,
  };
};

module.exports = {
  buildBranchDivisionOrCondition,
  resolveFinancialYearRange,
};
