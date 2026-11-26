/**
 * Atomically increments Account.currentBalance and rounds the result to 2 decimal
 * places within the same update, using MongoDB's $round aggregation-pipeline update.
 * Plain `{ $inc: { currentBalance: amount } }` updates accumulate floating point
 * error across many transactions (e.g. 11150.79000000006); this avoids that drift
 * without losing the atomicity $inc provided.
 */
const incBankBalance = (Account, accountId, amount, options = {}) =>
  Account.findByIdAndUpdate(
    accountId,
    [{ $set: { currentBalance: { $round: [{ $add: [{ $ifNull: ['$currentBalance', 0] }, amount] }, 2] } } }],
    options,
  );

module.exports = { incBankBalance };
