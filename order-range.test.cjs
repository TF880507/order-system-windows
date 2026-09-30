const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIsoDate, validateOrderDateRange } = require('./order-range');

test('日期只接受真實的 YYYY-MM-DD', () => {
  assert.equal(parseIsoDate('2026-02-29'), null);
  assert.equal(parseIsoDate('2026-10-01').toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(parseIsoDate("2026-10-01' OR 1=1 --"), null);
});

test('歷史訂單區間必填且不可超過三個月', () => {
  assert.match(validateOrderDateRange('', '2026-10-01').error, /必填/);
  assert.match(validateOrderDateRange('2026-10-02', '2026-10-01').error, /不可早於/);
  assert.deepEqual(validateOrderDateRange('2026-07-01', '2026-09-30'), { startDate:'2026-07-01', endDate:'2026-09-30' });
  assert.match(validateOrderDateRange('2026-07-01', '2026-10-01').error, /3 個月/);
});
