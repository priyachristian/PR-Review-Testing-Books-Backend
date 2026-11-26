const { MASTERS_INDIA_EWB_CANCEL_REASONS, MASTERS_INDIA_EWB_CANCEL_REASON_DEFAULT } = require('../../../../../utils/enum');

const buildCancelEWayBillPayload = cancellationDetails => {
  const reason =
    MASTERS_INDIA_EWB_CANCEL_REASONS[Number(cancellationDetails.cancellationReasonCode)] ||
    MASTERS_INDIA_EWB_CANCEL_REASON_DEFAULT;
  return {
    eway_bill_number: Number(cancellationDetails.eWayBillNo),
    reason_of_cancel: reason,
    cancel_remark: cancellationDetails.cancellationReasonRemarks || reason,
    data_source: 'erp',
  };
};

module.exports = { buildCancelEWayBillPayload };
