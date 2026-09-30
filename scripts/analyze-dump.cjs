'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error('用法：npm run analyze:dump -- /path/to/Dump.sql');
  process.exit(1);
}

const counts = {};
const tables = [];
let serverVersion = '';
const reader = readline.createInterface({ input:fs.createReadStream(dumpPath), crlfDelay:Infinity });

reader.on('line', (line) => {
  const version = line.match(/^-- Server version\s+(.+)$/);
  if (version) serverVersion = version[1];
  const create = line.match(/^CREATE TABLE `([^`]+)`/);
  if (create) tables.push(create[1]);
  const insert = line.match(/^INSERT INTO `([^`]+)` VALUES /);
  if (insert) counts[insert[1]] = (counts[insert[1]] || 0) + line.split('),(').length;
});

reader.on('close', () => {
  console.log(JSON.stringify({ serverVersion, tables, approximateRowCounts:counts }, null, 2));
});
