const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseLegacyDump } = require('./scripts/legacy-dump-parser');

test('streams MySQL rows and decodes escaped values', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-order-dump-'));
  const file = path.join(directory, 'sample.sql');
  await fs.writeFile(file, "INSERT INTO `goods` VALUES (1,'471','商品\\'A','盒\\n裝'),(2,NULL,'B','');\n");
  const rows = [];
  for await (const value of parseLegacyDump(file, new Set(['goods']))) rows.push(value.row);
  assert.deepEqual(rows, [['1', '471', "商品'A", '盒\n裝'], ['2', null, 'B', '']]);
  await fs.rm(directory, { recursive:true, force:true });
});
