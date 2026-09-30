const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { migrateLegacyPasswords } = require('./scripts/legacy-passwords');

test('hashes exact legacy passwords including leading zeros and clears plaintext', async () => {
  const calls = [];
  const client = { query:async (sql, values) => { calls.push({ sql, values }); return { rowCount:values ? 1 : 2 }; } };
  const result = await migrateLegacyPasswords(client, [
    { username:'customer-a', password:'0000' },
    { username:'customer-b', password:'' }
  ], { cost:4 });

  assert.deepEqual(result, { migrated:1, skipped:1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].values[1], 'customer-a');
  assert.equal(await bcrypt.compare('0000', calls[0].values[0]), true);
  assert.match(calls[1].sql, /legacy_password=NULL/);
});
