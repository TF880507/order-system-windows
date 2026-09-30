const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const schema = fs.readFileSync('mysql-init/001-legacy-schema.sql', 'utf8');

test('local MySQL schema mirrors every required legacy table', () => {
  for (const table of ['administrator', 'customer', 'goods', 'order', 'detail', 'roots', 'timer']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS (?:\\\\\`)?${table}`));
  }
});

test('legacy midnight timer and order lock status are preserved', () => {
  assert.match(schema, /VALUES \(1,'24','00','00',2\)/);
  assert.match(schema, /status TINYINT\(1\).*1表示已匯出，不可修改/);
});
