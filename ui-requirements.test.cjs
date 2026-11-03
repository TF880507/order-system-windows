const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const styles = fs.readFileSync('public/styles.css', 'utf8');

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
  assert.doesNotMatch(server, /app\.put\('\/api\/orders\/:id\/items\/:itemId'/);
  assert.doesNotMatch(server, /app\.delete\('\/api\/orders\/:id\/items\/:itemId'/);
  assert.doesNotMatch(server, /app\.delete\('\/api\/orders\/:id'/);
  assert.match(server, /app\.delete\('\/api\/admin\/orders\/:id\/items', requireAuth, requireAdmin/);
});

test('draft order items allow quantity and note corrections before final submission', () => {
  assert.match(app, /data-draft-quantity/);
  assert.match(app, /data-draft-note/);
  assert.match(html, /完成整張訂單並產生編號/);
});

test('product and vendor lists use requested pagination and labels', () => {
  assert.match(html, /<th>單位<\/th><th>操作<\/th>/);
  assert.match(html, /<th>客戶序號<\/th><th>帳號<\/th><th>密碼<\/th><th>客戶名稱<\/th>/);
  assert.doesNotMatch(html, /<h2 id="product-form-title">新增商品<\/h2>/);
  assert.match(app, /class="vendor-suspend-check" data-toggle-vendor=/);
  assert.match(app, /state\.productPage}&pageSize=20/);
  assert.match(app, /state\.vendorPage}&pageSize=10/);
});

test('scan order entry keeps the three requested fields at a readable size', () => {
  assert.match(html, /<label>條碼<div id="scan-product"/);
  assert.match(html, /<label>數量<input id="scan-quantity"/);
  assert.match(html, /<label>說明<textarea id="scan-note"/);
  assert.match(styles, /body \{[^}]*font-size:20px;/);
  assert.match(styles, /\.scan-order-form input,\.scan-order-form textarea,\.scan-order-form \.product-preview \{ font-size:22px;/);
});
