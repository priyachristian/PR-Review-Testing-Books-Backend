const bankTransformers = {
  /**
   * Transform bank transactions data
   * @param {Array} transactions - Array of transaction objects
   * @returns {Array} Transformed transactions
   */
  queryTransactions: transactions => {
    const transformedTransactions = transactions.map(transaction => {
      // Convert Mongoose document to plain object if needed
      const transactionObj = transaction.toObject ? transaction.toObject() : transaction;

      return {
        id: transactionObj._id?.toString() || '',
        companyId: transactionObj.companyId?.toString() || '',
        fromAccountId: transactionObj.fromAccountId?.toString() || '',
        toAccountId: transactionObj.toAccountId?.toString() || '',
        fromAccountName: transactionObj.fromAccountName || '',
        toAccountName: transactionObj.toAccountName || '',
        amount: transactionObj.amount || 0,
        currency: transactionObj.currency || '',
        fromAmount: transactionObj.fromAmount ?? null,
        fromCurrency: transactionObj.fromCurrency || '',
        toAmount: transactionObj.toAmount ?? null,
        toCurrency: transactionObj.toCurrency || '',
        exchangeRate: transactionObj.exchangeRate ?? null,
        transactionType: transactionObj.transactionType || '',
        transactionStatus: transactionObj.transactionStatus || '',
        transactionDate: transactionObj.date ? new Date(transactionObj.date).toISOString() : null,
        transactionDescription: transactionObj.transactionDescription || '',
        approvalNote: transactionObj.approvalNote || '',
        approvedBy: transactionObj.approvedBy?.toString() || '',
        approvedAt: transactionObj.approvedAt ? new Date(transactionObj.approvedAt).toISOString() : null,
        transferredByFullName:
          `${transactionObj.transferredBy?.firstName || ''} ${transactionObj.transferredBy?.lastName || ''}`.trim() ||
          'Unknown User',
        date: transactionObj.date ? new Date(transactionObj.date).toISOString() : null,
        createdAt: transactionObj.createdAt ? new Date(transactionObj.createdAt).toISOString() : null,
        updatedAt: transactionObj.updatedAt ? new Date(transactionObj.updatedAt).toISOString() : null,
      };
    });

    return transformedTransactions;
  },

  /**
   * Transform paginated transactions response
   * @param {Object} paginatedData - Paginated response with results array
   * @returns {Object} Transformed paginated response
   */
  paginatedTransactions: paginatedData => {
    return {
      ...paginatedData,
      results: bankTransformers.queryTransactions(paginatedData.results || []),
    };
  },
};

module.exports = bankTransformers;
