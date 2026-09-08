'use strict';

const BUSINESS_TIME_ZONE = 'Asia/Taipei';

function getBusinessClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).reduce((value, part) => ({ ...value, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function shiftDate(date, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不正確');
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildOrdersCsv(rows) {
  const headings = ['營業日', '訂單編號', '建立時間', '會員', '商品條碼', '商品名稱', '規格', '數量', '備註', '狀態'];
  const body = rows.map((row) => [
    row.businessDate, row.orderNumber, row.createdAt, row.memberName,
    row.barcode, row.productName, row.specification, row.quantity, row.note, row.status
  ].map(csvCell).join(','));
  return `\uFEFF${[headings.join(','), ...body].join('\r\n')}\r\n`;
}

module.exports = { BUSINESS_TIME_ZONE, getBusinessClock, shiftDate, csvCell, buildOrdersCsv };
