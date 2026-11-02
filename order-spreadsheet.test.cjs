const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { createOrdersExportBuffer, groupOrderRows } = require('./order-spreadsheet');

const rows = [
  { customerId:7, customerCode:'0073', memberName:'王秀娟', memberUsername:'0927950957', taxId:'0927950957', barcode:'04710731642320', productName:'香水消臭液', quantity:1, specification:'瓶', note:'' },
  { customerId:7, customerCode:'0073', memberName:'王秀娟', memberUsername:'0927950957', taxId:'0927950957', barcode:'04710731642320', productName:'香水消臭液', quantity:2, specification:'瓶', note:'' },
  { customerId:8, customerCode:'0398', memberName:'廖進發', memberUsername:'121693412', taxId:'121693412', barcode:'4710000000001', productName:'測試商品', quantity:4, specification:'個', note:'要紅色' }
];

test('groups same customer and product into one daily item', () => {
  const groups = groupOrderRows(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].items[0].quantity, 3);
});

test('creates the legacy daily XLSX layout and preserves barcodes as text', () => {
  const buffer = createOrdersExportBuffer(rows, { businessDate:'2026-11-01', exportedAt:new Date('2026-11-01T00:00:03Z') });
  const workbook = XLSX.read(buffer, { type:'buffer', cellStyles:true });
  const sheet = workbook.Sheets.Worksheet;
  assert.deepEqual(XLSX.utils.sheet_to_json(sheet, { header:1, defval:'' }).slice(0, 9), [
    ['訂單存檔時間', '2026-11-01 08:00:03', '', '', ''],
    ['訂購廠商', '0073', '王秀娟', '0927950957', ''],
    ['條碼', '名稱', '數量', '單位', '說明'],
    ['04710731642320', '香水消臭液', 3, '瓶', ''],
    ['', '', '', '', ''],
    ['訂購廠商', '0398', '廖進發', '121693412', ''],
    ['條碼', '名稱', '數量', '單位', '說明'],
    ['4710000000001', '測試商品', 4, '個', '要紅色'],
    ['', '', '', '', '']
  ]);
  assert.equal(sheet.A4.t, 's');
  assert.equal(sheet.B2.t, 's');
  assert.equal(sheet['!cols'][0].width, 20);
  const container = XLSX.CFB.read(buffer, { type:'buffer' });
  const xml = (path) => Buffer.from(container.FileIndex[container.FullPaths.indexOf(`Root Entry/${path}`)].content).toString('utf8');
  assert.match(xml('xl/styles.xml'), /<fonts count="2">/);
  assert.match(xml('xl/worksheets/sheet1.xml'), /<c r="A2" s="2"/);
  for (const address of ['A3', 'B3', 'C3', 'D3', 'E3']) assert.match(xml('xl/worksheets/sheet1.xml'), new RegExp(`<c r="${address}" s="2"`));
});
