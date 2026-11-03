const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

test('logged-out root only exposes the login page', () => {
  assert.match(html, /<body class="logged-out">/);
  assert.match(html, /id="page-login" class="page active"/);
  assert.doesNotMatch(html, /id="page-home"/);
  assert.doesNotMatch(html, /data-page="home"/);
});

test('admin order list defaults to today with four columns and ten rows per page', () => {
  assert.match(html, /<th>訂單日期<\/th><th>廠商名稱<\/th><th>訂單明細<\/th><th>狀態<\/th>/);
  assert.match(app, /pageSize:'10'/);
  assert.match(app, /params\.set\('from', currentDate\)/);
  assert.match(app, /params\.set\('to', currentDate\)/);
});

test('editable order details support item updates and deletes without a whole-order delete control', () => {
  assert.doesNotMatch(html, /id="order-detail-delete-order"/);
  assert.match(app, /data-save-order-item/);
  assert.match(app, /data-delete-order-item/);
  assert.match(app, /data-item-quantity/);
  assert.match(app, /data-item-note/);
  assert.match(server, /app\.put\('\/api\/orders\/:id\/items\/:itemId'/);
  assert.match(server, /app\.delete\('\/api\/orders\/:id\/items\/:itemId'/);
  assert.match(server, /此訂單已結單，無法修改/);
});

test('draft order items allow quantity and note corrections before final submission', () => {
  assert.match(app, /data-draft-quantity/);
  assert.match(app, /data-draft-note/);
  assert.match(html, /完成整張訂單並產生編號/);
});

test('product and vendor lists use requested pagination and labels', () => {
  assert.match(html, /<th>單位<\/th><th>操作<\/th>/);
  assert.match(html, /<th>客戶序號<\/th><th>帳號<\/th><th>密碼<\/th><th>客戶名稱<\/th>/);
  assert.match(app, /state\.productPage}&pageSize=20/);
  assert.match(app, /state\.vendorPage}&pageSize=10/);
});
