'use strict';

const path = require('path');
const { parseLegacyDump } = require('./legacy-dump-parser');

async function main() {
  const filePath = path.resolve(process.argv[2] || '');
  if (!process.argv[2]) throw new Error('用法：node scripts/analyze-legacy-dump.js <Dump.sql>');

  const tables = new Set(['administrator', 'customer', 'detail', 'goods', 'order', 'roots', 'timer']);
  const counts = Object.fromEntries([...tables].map((table) => [table, 0]));
  const barcodes = new Map();
  const productIds = new Set();
  const customerIds = new Set();
  const orderIds = new Set();
  const detailOrderIds = new Set();
  let blankBarcodes = 0;
  let duplicateBarcodeRows = 0;
  let invalidQuantities = 0;
  let missingProductReferences = 0;
  let missingOrderReferences = 0;
  let firstOrderDate = null;
  let lastOrderDate = null;
  let timer = null;

  for await (const { table, row } of parseLegacyDump(filePath, tables)) {
    counts[table] += 1;
    if (table === 'customer') customerIds.add(row[0]);
    if (table === 'goods') {
      productIds.add(row[0]);
      const barcode = String(row[1] || '').trim();
      if (!barcode) blankBarcodes += 1;
      else {
        const seen = barcodes.get(barcode) || 0;
        if (seen) duplicateBarcodeRows += 1;
        barcodes.set(barcode, seen + 1);
      }
    }
    if (table === 'order') {
      orderIds.add(row[0]);
      const date = row[1];
      if (date && (!firstOrderDate || date < firstOrderDate)) firstOrderDate = date;
      if (date && (!lastOrderDate || date > lastOrderDate)) lastOrderDate = date;
    }
    if (table === 'detail') {
      detailOrderIds.add(row[1]);
      if (!/^\s*\d+\s*$/.test(String(row[8] || '')) || Number(row[8]) < 1) invalidQuantities += 1;
      // References are verified after all tables have been read because detail appears first in the dump.
    }
    if (table === 'timer') timer = row;
  }

  for await (const { row } of parseLegacyDump(filePath, new Set(['detail']))) {
    if (!orderIds.has(row[1])) missingOrderReferences += 1;
    if (!productIds.has(row[2])) missingProductReferences += 1;
  }

  const report = {
    file:filePath,
    counts,
    uniqueBarcodes:barcodes.size,
    blankBarcodes,
    duplicateBarcodeRows,
    invalidQuantities,
    missingProductReferences,
    missingOrderReferences,
    distinctDetailOrders:detailOrderIds.size,
    reconstructedOrders:[...detailOrderIds].filter((id) => !orderIds.has(id)).length,
    firstOrderDate,
    lastOrderDate,
    timer
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
