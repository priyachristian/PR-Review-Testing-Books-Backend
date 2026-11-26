const getGstRateForCalculation = gst => {
  if (gst == null || gst === '') return 0;
  const s = String(gst).trim().toLowerCase();
  if (s === 'none' || s === 'exempted') return 0;
  const num = parseFloat(gst);
  return Number.isFinite(num) ? num : 0;
};

const GST_CATEGORY = {
  NON_GST: 'non_gst',
  EXEMPT: 'exempt',
  NIL_RATED: 'nil_rated',
};

const getGstCategory = gst => {
  if (gst == null || gst === '') return GST_CATEGORY.NON_GST;
  const s = String(gst).trim().toLowerCase();
  if (s === 'exempted') return GST_CATEGORY.EXEMPT;
  if (s === 'none') return GST_CATEGORY.NIL_RATED;
  return GST_CATEGORY.NON_GST; // 0, '0', or any other zero rate
};

module.exports = {
  getGstRateForCalculation,
  getGstCategory,
  GST_CATEGORY,
};
