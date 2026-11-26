/**
 * Escape special regex characters in a string
 * @param {string} string - The string to escape
 * @returns {string} - The escaped string
 */
const escapeRegex = string => {
  if (!string || typeof string !== 'string') {
    return string;
  }
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Create a case-insensitive regex pattern from a search string
 * @param {string} searchString - The search string
 * @returns {RegExp} - The regex pattern
 */
const createSearchRegex = searchString => {
  if (!searchString || typeof searchString !== 'string') {
    return null;
  }
  return new RegExp(escapeRegex(searchString), 'i');
};

module.exports = {
  escapeRegex,
  createSearchRegex,
};
