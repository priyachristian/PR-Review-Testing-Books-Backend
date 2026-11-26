const { CANCELLATION_REASONS } = require('../../../../../utils/enum');

const buildCancelEInvoicePayload = cancellationDetails => {
  const reason = CANCELLATION_REASONS[cancellationDetails.cancellationReasonCode];
  return {
    irn: cancellationDetails.irn,
    cancel_reason: reason.value,
    cancel_remarks:
      cancellationDetails.cancellationReasonCode !== 4 ? reason.label : cancellationDetails.cancellationReasonRemarks,
    ewaybill_cancel: '',
  };
};

module.exports = { buildCancelEInvoicePayload };
