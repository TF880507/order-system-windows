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

module.exports = { BUSINESS_TIME_ZONE, getBusinessClock, shiftDate };
