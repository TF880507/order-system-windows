const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

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

test('order details are read-only and cannot delete the whole order', () => {
  assert.doesNotMatch(html, /id="order-detail-delete-order"/);
  assert.doesNotMatch(app, /data-save-order-item/);
  assert.doesNotMatch(app, /data-item-quantity/);
  assert.doesNotMatch(app, /data-item-note/);
});

test('product and vendor lists use requested pagination and labels', () => {
  assert.match(html, /<th>單位<\/th><th>操作<\/th>/);
  assert.match(html, /<th>客戶序號<\/th><th>帳號<\/th><th>密碼<\/th><th>客戶名稱<\/th>/);
  assert.match(app, /state\.productPage}&pageSize=20/);
  assert.match(app, /state\.vendorPage}&pageSize=10/);
});
