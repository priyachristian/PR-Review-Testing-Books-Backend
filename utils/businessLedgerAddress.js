const buildLedgerAddress = ledger => {
  if (!ledger) return null;
  return {
    address: { street1: ledger.address || '', street2: '' },
    city: ledger.city || '',
    pinCode: '',
    state: ledger.state || '',
    country: ledger.country || '',
    gstin: ledger.gstinUin || ledger.gst || '',
  };
};

module.exports = { buildLedgerAddress };
