const calculateDueDate = paymentTerm => {
  const today = new Date();
  let dueDate = new Date(today);

  if (!paymentTerm) return dueDate;

  switch (paymentTerm.name) {
    // Due immediately — no day offset to apply even though days is stored as 0.
    case 'Advance':
    case 'After Dispatch':
    case 'Due On Receipt':
      break;
    case 'Due end of the month':
      dueDate = new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, 0);
      break;
    case 'Due end of next month':
      dueDate = new Date(dueDate.getFullYear(), dueDate.getMonth() + 2, 0);
      break;
    default:
      dueDate.setDate(dueDate.getDate() + (paymentTerm.days || 0));
      break;
  }

  return dueDate;
};

const calculateFinalPrice = item => {
  let finalPrice = item.rate;
  if (item.discountConfig) {
    let discountAmount = 0;
    if (item.discountConfig.discountType === 'PERCENTAGE' && item.discountConfig.discountValue > 0) {
      discountAmount = (item.rate * item.discountConfig.discountValue) / 100;
    } else if (item.discountConfig.discountType === 'AMOUNT' && item.discountConfig.discountValue > 0) {
      discountAmount = item.quantity > 0 ? item.discountConfig.discountValue / item.quantity : 0;
    }
    finalPrice = item.rate - discountAmount;
  }
  return finalPrice;
};

module.exports = { calculateDueDate, calculateFinalPrice };
