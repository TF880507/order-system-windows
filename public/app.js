const state = { user: null, scanProduct: null, manualProduct: null, products: [], editingProductId: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const appBase = window.location.pathname.endsWith('/')
  ? window.location.pathname.replace(/\/$/, '')
  : window.location.pathname.slice(0, window.location.pathname.lastIndexOf('/'));

async function api(url, options = {}) {
  const response = await fetch(`${appBase}${url}`, { credentials:'same-origin', headers:{ 'Content-Type':'application/json', ...(options.headers || {}) }, ...options });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '系統發生錯誤');
  return data;
}

function showPage(name) {
  scanner.cancel();
  productScanner.cancel();
  $$('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  $$('#main-nav button').forEach((button) => button.classList.toggle('active', button.dataset.page === name));
  if (name === 'home') loadOrders('#recent-orders', 5);
  if (name === 'workspace') setTimeout(() => scanner.focus(), 0);
  if (name === 'products') { loadProducts(); setTimeout(() => productScanner.focus(), 0); }
}

function showWork(name) {
  showPage('workspace');
  $$('.work-view').forEach((view) => view.classList.toggle('active', view.id === `work-${name}`));
  $$('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.work === name));
  if (name === 'scan') setTimeout(() => scanner.focus(), 0);
  if (name === 'orders') loadOrders('#order-list');
}

function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 2600);
}

function showMessage(selector, text, kind = 'error') {
  const element = $(selector);
  element.textContent = text;
  element.className = `message ${kind}`;
}

function clearMessage(selector) { $(selector).className = 'message hidden'; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
function formatDateTime(value) {
  const parsed = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-TW', { hour12:false });
}

function setProduct(target, product, emptyText = '尚未讀取商品') {
  target.classList.toggle('empty', !product);
  target.innerHTML = product ? `<b>${escapeHtml(product.name)}</b><small>${escapeHtml(product.barcode)} · ${escapeHtml(product.specification || '無規格')}</small>` : emptyText;
}

async function lookupProduct(barcode, mode) {
  const clean = String(barcode || '').trim();
  if (!clean) throw new Error('請輸入商品條碼');
  const product = await api(`/api/products/${encodeURIComponent(clean)}`);
  state[`${mode}Product`] = product;
  setProduct($(`#${mode}-product`), product);
  showMessage(`#${mode}-message`, `已找到：${product.name}`, 'success');
  return product;
}

async function createSingleItemOrder(mode) {
  const product = state[`${mode}Product`];
  if (!product) throw new Error('請先掃描或查詢商品');
  const quantity = Number($(`#${mode}-quantity`).value);
  const note = $(`#${mode}-note`).value;
  const order = await api('/api/orders', { method:'POST', body:JSON.stringify({ items:[{ barcode:product.barcode, quantity, note }] }) });
  showToast(`訂單 ${order.orderNumber} 已建立`);
  clearOrderForm(mode);
}

function clearOrderForm(mode) {
  state[`${mode}Product`] = null;
  setProduct($(`#${mode}-product`), null, mode === 'manual' ? '輸入條碼後查詢商品' : '尚未讀取商品');
  $(`#${mode}-quantity`).value = 1;
  $(`#${mode}-note`).value = '';
  clearMessage(`#${mode}-message`);
  if (mode === 'scan') { scanner.cancel(); $('#scanner-input').value = ''; scanReady(false); scanner.focus(); }
  if (mode === 'manual') $('#manual-barcode').value = '';
}

async function loadOrders(targetSelector, limit = 0) {
  const target = $(targetSelector);
  const columns = targetSelector === '#order-list' ? 6 : 5;
  if (!state.user) { target.innerHTML = `<tr><td colspan="${columns}" class="empty">登入後顯示訂單</td></tr>`; return; }
  try {
    const orders = await api(`/api/orders?date=${encodeURIComponent($('#order-date').value)}`);
    const rows = limit ? orders.slice(0, limit) : orders;
    target.innerHTML = rows.length ? rows.map((order) => `<tr><td><b>#${escapeHtml(order.orderNumber)}</b></td><td>${escapeHtml(formatDateTime(order.createdAt))}</td><td>${escapeHtml(order.memberName)}</td><td>${order.itemCount} 項</td>${targetSelector === '#order-list' ? `<td>${order.totalQuantity}</td>` : ''}<td><span class="status-tag">已建立</span></td></tr>`).join('') : `<tr><td colspan="${columns}" class="empty">此日期尚無訂單</td></tr>`;
  } catch (error) { target.innerHTML = `<tr><td colspan="${columns}" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}

async function loadProducts() {
  const target = $('#product-list');
  if (!state.user || state.user.role !== 'admin') return;
  target.innerHTML = '<tr><td colspan="4" class="empty">載入中</td></tr>';
  try {
    const products = await api(`/api/products?query=${encodeURIComponent($('#product-search').value.trim())}`);
    state.products = products;
    target.innerHTML = products.length ? products.map((product) => `<tr><td><b>${escapeHtml(product.name)}</b></td><td>${escapeHtml(product.barcode)}</td><td>${escapeHtml(product.specification || '—')}</td><td class="row-actions"><button class="text-button" data-edit-product="${product.id}" type="button">編輯</button><button class="text-button danger" data-delete-product="${product.id}" type="button">刪除</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">查無符合的商品</td></tr>';
  } catch (error) { target.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}

function clearProductForm() {
  $('#product-form').reset();
  state.editingProductId = null;
  $('#product-form-title').textContent = '新增商品';
  $('#product-save').textContent = '儲存商品';
  clearMessage('#product-message');
  productScanner.focus();
}

function editProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  state.editingProductId = id;
  $('#product-form-title').textContent = '編輯商品';
  $('#product-save').textContent = '儲存修改';
  $('#product-barcode').value = product.barcode;
  $('#product-name').value = product.name;
  $('#product-specification').value = product.specification || '';
  clearMessage('#product-message');
  $('#product-name').focus();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); clearMessage('#login-error');
  try {
    state.user = await api('/api/login', { method:'POST', body:JSON.stringify({ username:$('#login-username').value, password:$('#login-password').value }) });
    $('#user-name').textContent = state.user.displayName;
    $('#logout-button').classList.remove('hidden');
    $('#products-nav').classList.toggle('hidden', state.user.role !== 'admin');
    showWork('scan');
  } catch (error) { showMessage('#login-error', error.message); }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST' }); } catch (_) {}
  clearOrderForm('scan'); clearOrderForm('manual');
  state.user = null; $('#user-name').textContent = ''; $('#logout-button').classList.add('hidden'); showPage('login');
  $('#products-nav').classList.add('hidden');
});

let scanSaving = false;
function scanActive() {
  return Boolean(state.user && !scanSaving && $('#page-workspace').classList.contains('active') && $('#work-scan').classList.contains('active'));
}
function scanReady(ready) {
  $('#scan-submit').disabled = !ready || scanSaving;
}
const scanner = attachScanner({
  input: $('#scanner-input'),
  active: scanActive,
  invalidate() {
    state.scanProduct = null;
    setProduct($('#scan-product'), null);
    scanReady(false);
    clearMessage('#scan-message');
  },
  lookup: (barcode) => api(`/api/products/${encodeURIComponent(barcode)}`),
  success(product) {
    state.scanProduct = product;
    setProduct($('#scan-product'), product);
    scanReady(true);
    showMessage('#scan-message', `已讀取：${product.barcode}，請確認數量後加入訂單`, 'success');
  },
  failure(error) { showMessage('#scan-message', error.message + '；請重新掃描或確認商品是否已建檔'); }
});
$('#scanner-input').addEventListener('focus', () => {
  $('#scan-status').textContent = '等待掃描';
});
$('#scanner-input').addEventListener('blur', () => {
  $('#scan-status').textContent = '已暫停接收，點「繼續掃描」';
});
$('#scan-resume').addEventListener('click', () => scanner.focus());
$('#scan-lookup').addEventListener('click', () => { scanner.cancel(); scanner.receive(); });
$('#scan-zone').addEventListener('click', (event) => { if (!event.target.closest('input,button,textarea')) scanner.focus(); });
$('#scan-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (scanSaving) return;
  if (!state.scanProduct || state.scanProduct.barcode !== $('#scanner-input').value.trim()) {
    showMessage('#scan-message', '請先掃描或查詢商品');
    return;
  }
  scanSaving = true;
  scanner.cancel();
  scanReady(false);
  $('#scanner-input').disabled = true;
  try { await createSingleItemOrder('scan'); }
  catch (error) { showMessage('#scan-message', error.message); }
  finally {
    scanSaving = false;
    $('#scanner-input').disabled = false;
    scanReady(Boolean(state.scanProduct));
    if (!state.scanProduct) scanner.focus();
  }
});

$('#manual-form').addEventListener('submit', async (event) => { event.preventDefault(); try { if (!state.manualProduct || state.manualProduct.barcode !== $('#manual-barcode').value.trim()) await lookupProduct($('#manual-barcode').value, 'manual'); await createSingleItemOrder('manual'); } catch (error) { showMessage('#manual-message', error.message); } });
$('#manual-lookup').addEventListener('click', async () => { try { await lookupProduct($('#manual-barcode').value, 'manual'); } catch (error) { state.manualProduct = null; setProduct($('#manual-product'), null, '輸入條碼後查詢商品'); showMessage('#manual-message', error.message); } });
$('#scan-clear').addEventListener('click', () => clearOrderForm('scan'));
$('#query-orders').addEventListener('click', () => loadOrders('#order-list'));
$('#product-form').addEventListener('submit', async (event) => {
  event.preventDefault(); clearMessage('#product-message');
  try {
    const payload = JSON.stringify({ barcode:$('#product-barcode').value, name:$('#product-name').value, specification:$('#product-specification').value });
    const editing = state.editingProductId;
    const product = await api(editing ? `/api/products/${editing}` : '/api/products', { method:editing ? 'PUT' : 'POST', body:payload });
    showToast(`商品「${product.name}」已${editing ? '更新' : '建立'}`);
    clearProductForm();
    loadProducts();
  } catch (error) { showMessage('#product-message', error.message); }
});
const productScanner = attachScanner({
  input: $('#product-barcode'),
  active: () => Boolean(state.user && state.user.role === 'admin' && $('#page-products').classList.contains('active')),
  invalidate() { clearMessage('#product-message'); },
  lookup: async (barcode) => ({ barcode }),
  success(product) {
    $('#product-barcode').value = product.barcode;
    showMessage('#product-message', `條碼 ${product.barcode} 已讀取，請填寫商品名稱後儲存`, 'success');
    $('#product-name').focus();
  },
  failure(error) { showMessage('#product-message', error.message); }
});
$('#product-clear').addEventListener('click', clearProductForm);
$('#products-refresh').addEventListener('click', loadProducts);
$('#product-scan-resume').addEventListener('click', () => productScanner.focus());
let productSearchTimer;
$('#product-search').addEventListener('input', () => { clearTimeout(productSearchTimer); productSearchTimer = setTimeout(loadProducts, 180); });
$('#product-list').addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit-product]');
  if (editButton) return editProduct(Number(editButton.dataset.editProduct));
  const deleteButton = event.target.closest('[data-delete-product]');
  if (!deleteButton) return;
  const id = Number(deleteButton.dataset.deleteProduct);
  const product = state.products.find((item) => item.id === id);
  if (!product || !window.confirm(`要刪除「${product.name}」嗎？\n它不會再被掃碼或新增訂單找到，既有訂單會保留。`)) return;
  try {
    await api(`/api/products/${id}`, { method:'DELETE' });
    if (state.editingProductId === id) clearProductForm();
    showToast(`商品「${product.name}」已刪除`);
    loadProducts();
  } catch (error) { showMessage('#product-message', error.message); }
});
$$('[data-page]').forEach((button) => button.addEventListener('click', () => button.dataset.page === 'workspace' && !state.user ? showPage('login') : showPage(button.dataset.page)));
$$('[data-go-work]').forEach((button) => button.addEventListener('click', () => state.user ? showWork(button.dataset.goWork) : showPage('login')));
$$('[data-work]').forEach((button) => button.addEventListener('click', () => showWork(button.dataset.work)));

$('#order-date').value = new Date().toLocaleDateString('en-CA');
api('/api/me').then((user) => { state.user = user; $('#user-name').textContent = user.display_name || user.displayName; $('#logout-button').classList.remove('hidden'); $('#products-nav').classList.toggle('hidden', user.role !== 'admin'); loadOrders('#recent-orders', 5); }).catch(() => {});
