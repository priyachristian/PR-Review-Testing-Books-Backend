const CODE_NUMBER_WIDTH = 5;
const MAX_CODE_ATTEMPTS = 3;

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns the next code for a company in the form `<prefix><zero-padded number>` (e.g. MCH-00001),
 * one higher than the largest existing code that matches the prefix.
 */
const generateNextCode = async (Model, companyId, field, prefix, session) => {
  const last = await Model.findOne({ companyId, [field]: new RegExp(`^${escapeRegex(prefix)}\\d+$`) })
    .select(field)
    .sort({ [field]: -1 })
    .collation({ locale: 'en', numericOrdering: true })
    .session(session)
    .lean();

  const lastNumber = last ? parseInt(last[field].slice(prefix.length), 10) : 0;
  return `${prefix}${String(lastNumber + 1).padStart(CODE_NUMBER_WIDTH, '0')}`;
};

const isDuplicateCodeError = (error, field) =>
  error?.code === 11000 && (Boolean(error.keyPattern?.[field]) || String(error.message).includes(field));

/**
 * Runs a create attempt (which should generate its own code inside a transaction) and retries it when two
 * requests race to the same code and the unique index rejects the loser.
 */
const withCodeRetry = async (attempt, field) => {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (tries >= MAX_CODE_ATTEMPTS || !isDuplicateCodeError(error, field)) {
        throw error;
      }
    }
  }
};

module.exports = { generateNextCode, withCodeRetry };
