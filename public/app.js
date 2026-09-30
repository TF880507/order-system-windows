const state = { user: null, scanProduct: null, manualProduct: null, products: [], editingProductId: null, productPage:1, productTotalPages:1, adminOrders:[], adminOrderPage:1, adminOrderTotalPages:1, adminOrder:null };
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
  if (name === 'schedule') loadSchedule();
  if (name === 'admin-orders') loadAdminOrders();
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
  const text = String(value || '');
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
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
    target.innerHTML = rows.length ? rows.map((order) => `<tr><td><b>#${escapeHtml(order.orderNumber)}</b></td><td>${escapeHtml(formatDateTime(order.createdAt))}</td><td>${escapeHtml(order.memberName)}</td><td>${order.itemCount} 項</td>${targetSelector === '#order-list' ? `<td>${order.totalQuantity}</td>` : ''}<td><span class="status-tag ${order.editable ? '' : 'disabled-tag'}">${order.editable ? '當日可編輯' : '已鎖定'}</span></td></tr>`).join('') : `<tr><td colspan="${columns}" class="empty">此日期尚無訂單</td></tr>`;
  } catch (error) { target.innerHTML = `<tr><td colspan="${columns}" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}

async function loadAdminOrders() {
  if (!state.user || state.user.role !== 'admin') return;
  const target = $('#admin-order-list');
  target.innerHTML = '<tr><td colspan="8" class="empty">載入中</td></tr>';
  const params = new URLSearchParams({ page:String(state.adminOrderPage), pageSize:'20' });
  const filters = {
    from:$('#admin-order-from').value,
    to:$('#admin-order-to').value,
    query:$('#admin-order-query').value.trim(),
    status:$('#admin-order-status').value
  };
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
  try {
    const [summary, data] = await Promise.all([api('/api/admin/orders/summary'), api(`/api/admin/orders?${params}`)]);
    $('#admin-stat-today').textContent = Number(summary.todayTotal).toLocaleString();
    $('#admin-stat-total').textContent = Number(summary.total).toLocaleString();
    $('#admin-stat-pending').textContent = Number(summary.pending).toLocaleString();
    $('#admin-stat-closed').textContent = Number(summary.closed).toLocaleString();
    state.adminOrders = data.items;
    state.adminOrderPage = data.page;
    state.adminOrderTotalPages = data.totalPages;
    target.innerHTML = data.items.length ? data.items.map((order) => `<tr>
      <td><b>${escapeHtml(order.businessDate)}</b></td>
      <td>#${escapeHtml(order.orderNumber)}</td>
      <td><button class="member-link" data-filter-member="${escapeHtml(order.memberName)}" type="button"><b>${escapeHtml(order.memberName)}</b><small>${escapeHtml(order.memberUsername)}</small></button></td>
      <td>${escapeHtml(formatDateTime(order.createdAt))}</td><td>${order.itemCount} 項</td><td>${order.totalQuantity}</td>
      <td><span class="status-tag ${order.editable ? '' : 'disabled-tag'}">${order.editable ? '待結單' : '已結單'}</span></td>
      <td><button class="text-button" data-view-order="${order.id}" type="button">查看明細</button></td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty">查無符合的訂單</td></tr>';
    $('#admin-order-page-info').textContent = `共 ${data.total.toLocaleString()} 筆｜第 ${data.page} / ${data.totalPages} 頁`;
    $('#admin-order-page-prev').disabled = data.page <= 1;
    $('#admin-order-page-next').disabled = data.page >= data.totalPages;
  } catch (error) {
    target.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(error.message)}</td></tr>`;
  }
}

function closeOrderDetail() {
  state.adminOrder = null;
  $('#order-detail-modal').classList.add('hidden');
  clearMessage('#order-detail-message');
}

async function openOrderDetail(id) {
  try {
    const order = await api(`/api/admin/orders/${id}`);
    state.adminOrder = order;
    $('#order-detail-title').textContent = `#${order.orderNumber}`;
    $('#order-detail-meta').innerHTML = `
      <div><span>客戶名稱</span><b>${escapeHtml(order.memberName)}</b><small>${escapeHtml(order.memberUsername)}</small></div>
      <div><span>營業日期</span><b>${escapeHtml(order.businessDate)}</b><small>${escapeHtml(formatDateTime(order.createdAt))}</small></div>
      <div><span>客戶資料</span><b>${escapeHtml(order.phone || '未提供電話')}</b><small>統編：${escapeHtml(order.taxId || '—')}　代碼：${escapeHtml(order.customerCode || '—')}</small></div>
      <div><span>訂單狀態</span><b>${order.editable ? '待結單' : '已結單'}</b><small>${order.editable ? '可勾選並刪除品項' : '已鎖定，不可修改'}</small></div>`;
    $('#order-detail-items').innerHTML = order.items.length ? order.items.map((item) => `<tr>
      <td><input class="detail-item-check" type="checkbox" value="${item.id}" aria-label="選取 ${escapeHtml(item.name)}" ${order.editable ? '' : 'disabled'}></td>
      <td>${escapeHtml(item.barcode)}</td><td><b>${escapeHtml(item.name)}</b></td><td>${escapeHtml(item.specification || '—')}</td>
      <td>${item.quantity}${item.originalQuantity && item.originalQuantity !== String(item.quantity) ? `<small class="original-quantity">原始：${escapeHtml(item.originalQuantity)}</small>` : ''}</td><td>${escapeHtml(item.note || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">此訂單沒有商品明細</td></tr>';
    $('#order-detail-select-all').checked = false;
    $('#order-detail-select-all').disabled = !order.editable || !order.items.length;
    $('#order-detail-delete').disabled = !order.editable || !order.items.length;
    $('#order-detail-export').href = `${appBase}/api/admin/orders/${order.id}/export`;
    clearMessage('#order-detail-message');
    $('#order-detail-modal').classList.remove('hidden');
  } catch (error) { showToast(error.message); }
}

async function loadProducts() {
  const target = $('#product-list');
  if (!state.user || state.user.role !== 'admin') return;
  target.innerHTML = '<tr><td colspan="4" class="empty">載入中</td></tr>';
  try {
    const data = await api(`/api/products?query=${encodeURIComponent($('#product-search').value.trim())}&page=${state.productPage}&pageSize=50`);
    state.products = data.items;
    state.productPage = data.page;
    state.productTotalPages = data.totalPages;
    target.innerHTML = data.items.length ? data.items.map((product) => `<tr><td><b>${escapeHtml(product.name)}</b></td><td>${escapeHtml(product.barcode)}</td><td>${escapeHtml(product.specification || '—')}</td><td class="row-actions"><button class="text-button" data-edit-product="${product.id}" type="button">編輯</button><button class="text-button danger" data-delete-product="${product.id}" type="button">刪除</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">查無符合的商品</td></tr>';
    $('#product-page-info').textContent = `共 ${data.total.toLocaleString()} 筆｜第 ${data.page} / ${data.totalPages} 頁`;
    $('#product-page-prev').disabled = data.page <= 1;
    $('#product-page-next').disabled = data.page >= data.totalPages;
  } catch (error) { target.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}

async function loadSchedule() {
  if (!state.user || state.user.role !== 'admin') return;
  const target = $('#schedule-list');
  target.innerHTML = '<tr><td colspan="7" class="empty">載入中</td></tr>';
  try {
    const data = await api('/api/schedule');
    $('#schedule-enabled').checked = data.setting.enabled;
    $('#schedule-time').value = data.setting.closeTime;
    $('#export-date').value ||= data.today;
    $('#schedule-state').textContent = data.setting.enabled ? `每日 ${data.setting.closeTime} 啟用中` : '排程已停用';
    $('#schedule-state').classList.toggle('disabled-tag', !data.setting.enabled);
    target.innerHTML = data.exports.length ? data.exports.map((item) => `<tr><td><b>${escapeHtml(item.businessDate)}</b></td><td>${item.exportType === 'automatic' ? '自動排程' : '手動匯出'}</td><td>${escapeHtml(formatDateTime(item.exportedAt))}</td><td>${item.orderCount}</td><td>${item.itemCount} 項／${item.totalQuantity} 件</td><td><span class="status-tag">${item.closed ? '已結單' : '快照'}</span></td><td><a class="text-button download-link" href="${appBase}/api/exports/${item.id}/download">下載 CSV</a></td></tr>`).join('') : '<tr><td colspan="7" class="empty">尚無匯出紀錄</td></tr>';
  } catch (error) { target.innerHTML = `<tr><td colspan="7" class="empty">${escapeHtml(error.message)}</td></tr>`; }
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
  const product = state.products.find((item) => Number(item.id) === id);
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
    $('#admin-orders-nav').classList.toggle('hidden', state.user.role !== 'admin');
    $('#products-nav').classList.toggle('hidden', state.user.role !== 'admin');
    $('#schedule-nav').classList.toggle('hidden', state.user.role !== 'admin');
    showWork('scan');
  } catch (error) { showMessage('#login-error', error.message); }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST' }); } catch (_) {}
  clearOrderForm('scan'); clearOrderForm('manual');
  state.user = null; $('#user-name').textContent = ''; $('#logout-button').classList.add('hidden'); showPage('login');
  $('#admin-orders-nav').classList.add('hidden');
  $('#products-nav').classList.add('hidden');
  $('#schedule-nav').classList.add('hidden');
  closeOrderDetail();
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
$('#admin-order-filters').addEventListener('submit', (event) => { event.preventDefault(); state.adminOrderPage = 1; loadAdminOrders(); });
$('#admin-order-reset').addEventListener('click', () => { $('#admin-order-filters').reset(); state.adminOrderPage = 1; loadAdminOrders(); });
$('#admin-order-page-prev').addEventListener('click', () => { if (state.adminOrderPage > 1) { state.adminOrderPage -= 1; loadAdminOrders(); } });
$('#admin-order-page-next').addEventListener('click', () => { if (state.adminOrderPage < state.adminOrderTotalPages) { state.adminOrderPage += 1; loadAdminOrders(); } });
$('#admin-order-list').addEventListener('click', (event) => {
  const detail = event.target.closest('[data-view-order]');
  if (detail) return openOrderDetail(Number(detail.dataset.viewOrder));
  const member = event.target.closest('[data-filter-member]');
  if (member) { $('#admin-order-query').value = member.dataset.filterMember; state.adminOrderPage = 1; loadAdminOrders(); }
});
$('#order-detail-close').addEventListener('click', closeOrderDetail);
$('#order-detail-modal').addEventListener('click', (event) => { if (event.target === $('#order-detail-modal')) closeOrderDetail(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#order-detail-modal').classList.contains('hidden')) closeOrderDetail(); });
$('#order-detail-select-all').addEventListener('change', (event) => { $$('.detail-item-check:not(:disabled)').forEach((box) => { box.checked = event.target.checked; }); });
$('#order-detail-delete').addEventListener('click', async () => {
  const order = state.adminOrder;
  const itemIds = $$('.detail-item-check:checked').map((box) => Number(box.value));
  if (!order || !itemIds.length) return showMessage('#order-detail-message', '請先勾選要刪除的商品品項');
  if (!window.confirm(`確定從訂單 #${order.orderNumber} 刪除 ${itemIds.length} 個品項嗎？`)) return;
  try {
    const result = await api(`/api/admin/orders/${order.id}/items`, { method:'DELETE', body:JSON.stringify({ itemIds }) });
    showToast(`已刪除 ${result.deleted} 個訂單品項`);
    if (result.orderDeleted) closeOrderDetail(); else await openOrderDetail(order.id);
    loadAdminOrders();
  } catch (error) { showMessage('#order-detail-message', error.message); }
});
$('#admin-export').addEventListener('click', async () => {
  const businessDate = $('#admin-export-date').value;
  if (!businessDate) return showToast('請先選擇匯出日期');
  try {
    const exported = await api('/api/schedule/export', { method:'POST', body:JSON.stringify({ businessDate }) });
    showToast(`${businessDate} 訂單 CSV 已建立`);
    window.location.assign(`${appBase}/api/exports/${exported.id}/download`);
  } catch (error) { showToast(error.message); }
});
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
$('#product-search').addEventListener('input', () => { clearTimeout(productSearchTimer); state.productPage = 1; productSearchTimer = setTimeout(loadProducts, 180); });
$('#product-page-prev').addEventListener('click', () => { if (state.productPage > 1) { state.productPage -= 1; loadProducts(); } });
$('#product-page-next').addEventListener('click', () => { if (state.productPage < state.productTotalPages) { state.productPage += 1; loadProducts(); } });
$('#product-list').addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit-product]');
  if (editButton) return editProduct(Number(editButton.dataset.editProduct));
  const deleteButton = event.target.closest('[data-delete-product]');
  if (!deleteButton) return;
  const id = Number(deleteButton.dataset.deleteProduct);
  const product = state.products.find((item) => Number(item.id) === id);
  if (!product || !window.confirm(`要刪除「${product.name}」嗎？\n它不會再被掃碼或新增訂單找到，既有訂單會保留。`)) return;
  try {
    await api(`/api/products/${id}`, { method:'DELETE' });
    if (state.editingProductId === id) clearProductForm();
    showToast(`商品「${product.name}」已刪除`);
    loadProducts();
  } catch (error) { showMessage('#product-message', error.message); }
});
$('#schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault(); clearMessage('#schedule-message');
  try {
    await api('/api/schedule', { method:'PUT', body:JSON.stringify({ enabled:$('#schedule-enabled').checked, closeTime:$('#schedule-time').value }) });
    showMessage('#schedule-message', '排程設定已儲存', 'success');
    loadSchedule();
  } catch (error) { showMessage('#schedule-message', error.message); }
});
$('#manual-export').addEventListener('click', async () => {
  clearMessage('#export-message');
  try {
    const exported = await api('/api/schedule/export', { method:'POST', body:JSON.stringify({ businessDate:$('#export-date').value }) });
    showMessage('#export-message', 'CSV 已建立並開始下載', 'success');
    window.location.assign(`${appBase}/api/exports/${exported.id}/download`);
    loadSchedule();
  } catch (error) { showMessage('#export-message', error.message); }
});
$('#manual-close').addEventListener('click', async () => {
  const date = $('#export-date').value;
  if (!date || !window.confirm(`確定要結清 ${date} 的訂單嗎？\n結單後該日期不可再新增或修改訂單。`)) return;
  clearMessage('#export-message');
  try {
    await api('/api/schedule/close', { method:'POST', body:JSON.stringify({ businessDate:date }) });
    showMessage('#export-message', `${date} 已結單`, 'success');
    loadSchedule();
  } catch (error) { showMessage('#export-message', error.message); }
});
$('#schedule-refresh').addEventListener('click', loadSchedule);
$$('[data-page]').forEach((button) => button.addEventListener('click', () => button.dataset.page === 'workspace' && !state.user ? showPage('login') : showPage(button.dataset.page)));
$$('[data-go-work]').forEach((button) => button.addEventListener('click', () => state.user ? showWork(button.dataset.goWork) : showPage('login')));
$$('[data-work]').forEach((button) => button.addEventListener('click', () => showWork(button.dataset.work)));

$('#order-date').value = new Date().toLocaleDateString('en-CA');
$('#admin-export-date').value = new Date().toLocaleDateString('en-CA');
api('/api/me').then((user) => { state.user = user; $('#user-name').textContent = user.display_name || user.displayName; $('#logout-button').classList.remove('hidden'); $('#admin-orders-nav').classList.toggle('hidden', user.role !== 'admin'); $('#products-nav').classList.toggle('hidden', user.role !== 'admin'); $('#schedule-nav').classList.toggle('hidden', user.role !== 'admin'); loadOrders('#recent-orders', 5); }).catch(() => {});
