const test = require('node:test');
const assert = require('node:assert/strict');
const { getBusinessClock, shiftDate, csvCell } = require('./schedule');

test('uses the Asia/Taipei business date across UTC midnight', () => {
  assert.deepEqual(getBusinessClock(new Date('2026-09-08T16:05:00Z')), { date:'2026-09-09', time:'00:05' });
});

test('shifts business dates across month boundaries', () => {
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
});

test('escapes CSV values for Excel-compatible exports', () => {
  assert.equal(csvCell('一箱,「特價」'), '"一箱,「特價」"');
  assert.equal(csvCell('他說"要"'), '"他說""要"""');
});
