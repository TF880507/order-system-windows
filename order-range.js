const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value) {
  const text = String(value || '');
  if (!ISO_DATE_PATTERN.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : date;
}

function validateOrderDateRange(startValue, endValue) {
  const startDate = parseIsoDate(startValue);
  const endDate = parseIsoDate(endValue);
  if (!startDate || !endDate) return { error:'開始日期與結束日期皆為必填，格式須為 YYYY-MM-DD' };
  if (endDate < startDate) return { error:'結束日期不可早於開始日期' };
  const exclusiveLimit = new Date(startDate);
  exclusiveLimit.setUTCMonth(exclusiveLimit.getUTCMonth() + 3);
  if (endDate >= exclusiveLimit) return { error:'單次歷史訂單查詢最長為 3 個月' };
  return { startDate:String(startValue), endDate:String(endValue) };
}

module.exports = { parseIsoDate, validateOrderDateRange };
