'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { createProductTemplateBuffer, createProductsExportBuffer, parseProductImportBuffer } = require('./product-spreadsheet');

test('product template follows database-backed headers and formats barcode as text', () => {
  const workbook = XLSX.read(createProductTemplateBuffer(), { type:'buffer', cellNF:true });
  const sheet = workbook.Sheets['商品匯入'];
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header:1, range:'A1:D1' })[0], ['商品條碼', '商品名稱', '規格／備註', '狀態']);
  assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.A2.z, '@');
});

test('product import preserves leading zero and long text barcodes', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['商品條碼', '商品名稱', '規格／備註', '狀態'],
    ['00123456789012345678', '測試商品', '箱', '啟用']
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '商品匯入');
  const result = parseProductImportBuffer(XLSX.write(workbook, { type:'buffer', bookType:'xlsx' }));
  assert.equal(result[0].barcode, '00123456789012345678');
  assert.equal(result[0].active, true);
});

test('product import rejects scientific notation barcodes', () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['商品條碼', '商品名稱'],
    ['4.7107E+12', '錯誤商品']
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '商品匯入');
  const buffer = XLSX.write(workbook, { type:'buffer', bookType:'xlsx' });
  assert.throws(() => parseProductImportBuffer(buffer), /科學記號/);
});

test('product export writes barcode cells as text', () => {
  const buffer = createProductsExportBuffer([{ barcode:'00123456789012345678', name:'商品', specification:'個', active:true, createdAt:'2026-10-02' }]);
  const sheet = XLSX.read(buffer, { type:'buffer', cellNF:true }).Sheets['商品資料'];
  assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.A2.v, '00123456789012345678');
  assert.equal(sheet.A2.z, '@');
});
