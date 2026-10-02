const state = { user: null, scanProduct: null, manualProduct: null, products: [], editingProductId: null, productPage:1, productTotalPages:1, vendors:[], editingVendorId:null, vendorPage:1, vendorTotalPages:1, adminOrders:[], adminOrderPage:1, adminOrderTotalPages:1, adminOrder:null, memberOrderPage:1, memberOrderTotalPages:1, memberOrderMode:'month' };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const appBase = window.location.pathname.endsWith('/')
  ? window.location.pathname.replace(/\/$/, '')
  : window.location.pathname.slice(0, window.location.pathname.lastIndexOf('/'));
const scanPlatform = /Android/i.test(navigator.userAgent) || Boolean(window.AndroidScanner)
  ? 'android'
  : (/Windows/i.test(navigator.userAgent) ? 'windows' : 'desktop');
const hasNativeAndroidScanner = scanPlatform === 'android' && typeof window.AndroidScanner?.scanBarcode === 'function';
document.documentElement.classList.add(`platform-${scanPlatform}`);

function focusHardwareScanner() {
  if (scanPlatform !== 'android') scanner.focus();
}

function configureScannerPlatform() {
  const label = $('#platform-scanner-label');
  const caption = $('#scan-entry-caption');
  const instruction = $('#scan-device-instruction');
  const cameraActions = $('#android-camera-actions');
  if (scanPlatform === 'android') {
    label.textContent = hasNativeAndroidScanner ? 'Android 相機掃描' : 'Android 掃碼';
    caption.textContent = hasNativeAndroidScanner ? '開啟裝置相機掃描商品條碼或 QR Code' : '請使用 Android App 開啟相機掃描';
    instruction.textContent = hasNativeAndroidScanner
      ? '按下按鈕開啟裝置鏡頭，將商品條碼或 QR Code 對準掃描框。'
      : '目前瀏覽器無法直接使用相機，請改用好市吉 Android App。';
    cameraActions.classList.remove('hidden');
    $('#camera-scan-open').disabled = !hasNativeAndroidScanner;
    $('#scan-status').textContent = hasNativeAndroidScanner ? '相機掃描已就緒' : '請使用 Android App';
  } else {
    label.textContent = scanPlatform === 'windows' ? 'Windows USB 掃碼輸入' : 'USB 掃碼輸入';
    caption.textContent = '使用 USB 掃碼器快速帶入商品';
    instruction.textContent = '請使用英文輸入法。掃碼後自動查詢商品；填寫數量或備註後，點「繼續掃描」接收下一筆。';
  }
}

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
  if (name === 'workspace') setTimeout(focusHardwareScanner, 0);
  if (name === 'products') { loadProducts(); setTimeout(() => productScanner.focus(), 0); }
  if (name === 'vendors') loadVendors();
  if (name === 'schedule') loadSchedule();
  if (name === 'admin-orders') loadAdminOrders();
}

function showWork(name) {
  showPage('workspace');
  $$('.work-view').forEach((view) => view.classList.toggle('active', view.id === `work-${name}`));
  $$('.tabs button').forEach((button) => button.classList.toggle('active', button.dataset.work === name));
  if (name === 'scan') setTimeout(focusHardwareScanner, 0);
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
function setAuthenticatedUi(user) {
  state.user = user;
  $('#user-name').textContent = user ? (user.display_name || user.displayName) : '';
  $('#logout-button').classList.toggle('hidden', !user);
  $('#login-nav').classList.toggle('hidden', Boolean(user));
  const isAdmin = user?.role === 'admin';
  $('#admin-orders-nav').classList.toggle('hidden', !isAdmin);
  $('#vendors-nav').classList.toggle('hidden', !isAdmin);
  $('#products-nav').classList.toggle('hidden', !isAdmin);
  $('#schedule-nav').classList.toggle('hidden', !isAdmin);
}
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
  if (mode === 'scan') { scanner.cancel(); $('#scanner-input').value = ''; scanReady(false); focusHardwareScanner(); }
  if (mode === 'manual') $('#manual-barcode').value = '';
}

async function loadOrders(targetSelector, limit = 0) {
  const target = $(targetSelector);
  const isFullList = targetSelector === '#order-list';
  const columns = isFullList ? 7 : 5;
  if (!state.user) { target.innerHTML = `<tr><td colspan="${columns}" class="empty">登入後顯示訂單</td></tr>`; return; }
  try {
    const params = new URLSearchParams({ page:String(isFullList ? state.memberOrderPage : 1), pageSize:String(limit || 50) });
    let endpoint = '/api/orders';
    if (isFullList && state.memberOrderMode === 'history') {
      endpoint = '/api/orders/history';
      params.set('start_date', $('#history-start-date').value);
      params.set('end_date', $('#history-end-date').value);
    }
    const data = await api(`${endpoint}?${params}`);
    const rows = data.items;
    target.innerHTML = rows.length ? rows.map((order) => `<tr><td><b>#${escapeHtml(order.orderNumber)}</b></td><td>${escapeHtml(formatDateTime(order.orderDate || order.createdAt))}</td><td>${escapeHtml(order.memberName)}</td><td>${order.itemCount} 項</td>${isFullList ? `<td>${order.totalQuantity}</td>` : ''}<td><span class="status-tag ${order.editable ? '' : 'disabled-tag'}">${order.editable ? '可編輯' : '已鎖定'}</span></td>${isFullList ? `<td><button class="text-button" data-view-member-order="${order.id}" type="button">查看明細</button></td>` : ''}</tr>`).join('') : `<tr><td colspan="${columns}" class="empty">查無符合的訂單</td></tr>`;
    if (isFullList) {
      state.memberOrderPage = data.page;
      state.memberOrderTotalPages = data.totalPages;
      $('#member-order-page-info').textContent = `共 ${data.total.toLocaleString()} 筆｜第 ${data.page} / ${data.totalPages} 頁`;
      $('#member-order-page-prev').disabled = data.page <= 1;
      $('#member-order-page-next').disabled = data.page >= data.totalPages;
      clearMessage('#history-order-message');
    }
  } catch (error) {
    target.innerHTML = `<tr><td colspan="${columns}" class="empty">${escapeHtml(error.message)}</td></tr>`;
    if (isFullList) showMessage('#history-order-message', error.message);
  }
}

async function loadAdminOrders() {
  if (!state.user || state.user.role !== 'admin') return;
  const target = $('#admin-order-list');
  target.innerHTML = '<tr><td colspan="8" class="empty">載入中</td></tr>';
  const params = new URLSearchParams({ page:String(state.adminOrderPage), pageSize:'50' });
  const filters = {
    from:$('#admin-order-from').value,
    to:$('#admin-order-to').value,
    query:$('#admin-order-query').value.trim(),
    queryField:$('#admin-order-query-field').value,
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
    clearMessage('#admin-order-message');
  } catch (error) {
    target.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(error.message)}</td></tr>`;
    showMessage('#admin-order-message', error.message);
  }
}

function closeOrderDetail() {
  state.adminOrder = null;
  $('#order-detail-modal').classList.add('hidden');
  clearMessage('#order-detail-message');
}

async function openOrderDetail(id) {
  try {
    const order = await api(`/api/orders/${id}`);
    state.adminOrder = order;
    $('#order-detail-title').textContent = `#${order.orderNumber}`;
    $('#order-detail-meta').innerHTML = `
      <div><span>客戶名稱</span><b>${escapeHtml(order.memberName)}</b><small>${escapeHtml(order.memberUsername)}</small></div>
      <div><span>營業日期</span><b>${escapeHtml(order.businessDate)}</b><small>${escapeHtml(formatDateTime(order.createdAt))}</small></div>
      <div><span>客戶資料</span><b>${escapeHtml(order.phone || '未提供電話')}</b><small>統編：${escapeHtml(order.taxId || '—')}　代碼：${escapeHtml(order.customerCode || '—')}</small></div>
      <div><span>訂單狀態</span><b>${order.editable ? '待結單' : '已結單'}</b><small>${order.editable ? '可修改數量、備註或刪除品項' : '已鎖定，不可修改'}</small></div>`;
    $('#order-detail-items').innerHTML = order.items.length ? order.items.map((item) => `<tr>
      <td><input class="detail-item-check" type="checkbox" value="${item.id}" aria-label="選取 ${escapeHtml(item.name)}" ${order.editable && state.user.role === 'admin' ? '' : 'disabled'}></td>
      <td>${escapeHtml(item.barcode)}</td><td><b>${escapeHtml(item.name)}</b></td><td>${escapeHtml(item.specification || '—')}</td>
      <td><input class="detail-quantity" data-item-quantity="${item.id}" type="number" min="1" max="9999" value="${item.quantity}" ${order.editable ? '' : 'disabled'}>${item.originalQuantity && item.originalQuantity !== String(item.quantity) ? `<small class="original-quantity">原始：${escapeHtml(item.originalQuantity)}</small>` : ''}</td>
      <td><input class="detail-note" data-item-note="${item.id}" maxlength="500" value="${escapeHtml(item.note || '')}" placeholder="備註" ${order.editable ? '' : 'disabled'}></td>
      <td class="row-actions"><button class="text-button" data-save-order-item="${item.id}" type="button" ${order.editable ? '' : 'disabled'}>儲存</button><button class="text-button danger" data-delete-order-item="${item.id}" type="button" ${order.editable ? '' : 'disabled'}>刪除</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">此訂單沒有商品明細</td></tr>';
    const isAdmin = state.user.role === 'admin';
    $('#order-detail-select-wrap').classList.toggle('hidden', !isAdmin);
    $('#order-detail-delete').classList.toggle('hidden', !isAdmin);
    $('#order-detail-export').classList.toggle('hidden', !isAdmin);
    $('#order-detail-select-all').checked = false;
    $('#order-detail-select-all').disabled = !isAdmin || !order.editable || !order.items.length;
    $('#order-detail-delete').disabled = !isAdmin || !order.editable || !order.items.length;
    $('#order-detail-delete-order').disabled = !order.editable;
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
    const data = await api(`/api/products?query=${encodeURIComponent($('#product-search').value.trim())}&queryField=${encodeURIComponent($('#product-search-field').value)}&page=${state.productPage}&pageSize=50`);
    state.products = data.items;
    state.productPage = data.page;
    state.productTotalPages = data.totalPages;
    target.innerHTML = data.items.length ? data.items.map((product) => `<tr><td><b>${escapeHtml(product.name)}</b></td><td>${escapeHtml(product.barcode)}</td><td>${escapeHtml(product.specification || '—')}</td><td class="row-actions"><button class="text-button" data-edit-product="${product.id}" type="button">編輯</button><button class="text-button danger" data-delete-product="${product.id}" type="button">刪除</button></td></tr>`).join('') : '<tr><td colspan="4" class="empty">查無符合的商品</td></tr>';
    $('#product-page-info').textContent = `共 ${data.total.toLocaleString()} 筆｜第 ${data.page} / ${data.totalPages} 頁`;
    $('#product-page-prev').disabled = data.page <= 1;
    $('#product-page-next').disabled = data.page >= data.totalPages;
  } catch (error) { target.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(error.message)}</td></tr>`; }
}

async function loadVendors() {
  const target = $('#vendor-list');
  if (!state.user || state.user.role !== 'admin') return;
  target.innerHTML = '<tr><td colspan="9" class="empty">載入中</td></tr>';
  try {
    const query = encodeURIComponent($('#vendor-search').value.trim());
    const data = await api(`/api/admin/vendors?query=${query}&page=${state.vendorPage}&pageSize=50`);
    state.vendors = data.items;
    state.vendorPage = data.page;
    state.vendorTotalPages = data.totalPages;
    target.innerHTML = data.items.length ? data.items.map((vendor) => `<tr>
      <td><b>${escapeHtml(vendor.displayName)}</b></td>
      <td>${escapeHtml(vendor.username)}</td>
      <td>${escapeHtml(vendor.customerCode || '—')}</td>
      <td>${escapeHtml(vendor.phone || '—')}</td>
      <td>${escapeHtml(vendor.taxId || '—')}</td>
      <td>${Number(vendor.orderCount).toLocaleString()}</td>
      <td>${escapeHtml(vendor.latestOrderDate || '—')}</td>
      <td><span class="status-tag${vendor.active ? '' : ' disabled-tag'}">${vendor.active ? '啟用' : '停用'}</span></td>
      <td class="row-actions"><button class="text-button" data-vendor-orders="${vendor.id}" type="button">訂單</button><button class="text-button" data-edit-vendor="${vendor.id}" type="button">修改</button><button class="text-button${vendor.active ? ' danger' : ''}" data-toggle-vendor="${vendor.id}" type="button">${vendor.active ? '停權' : '復權'}</button></td>
    </tr>`).join('') : '<tr><td colspan="9" class="empty">查無符合的廠商</td></tr>';
    $('#vendor-page-info').textContent = `共 ${data.total.toLocaleString()} 筆｜第 ${data.page} / ${data.totalPages} 頁`;
    $('#vendor-page-prev').disabled = data.page <= 1;
    $('#vendor-page-next').disabled = data.page >= data.totalPages;
  } catch (error) {
    target.innerHTML = `<tr><td colspan="9" class="empty">${escapeHtml(error.message)}</td></tr>`;
  }
}

function closeVendorEditor() {
  $('#vendor-form').reset();
  $('#vendor-editor').classList.add('hidden');
  state.editingVendorId = null;
  clearMessage('#vendor-message');
}

function openVendorEditor(vendor = null) {
  $('#vendor-form').reset();
  state.editingVendorId = vendor ? Number(vendor.id) : null;
  $('#vendor-form-title').textContent = vendor ? '修改廠商' : '新增廠商';
  $('#vendor-save').textContent = vendor ? '儲存修改' : '新增廠商';
  $('#vendor-password').required = !vendor;
  if (vendor) {
    $('#vendor-customer-code').value = vendor.customerCode || '';
    $('#vendor-display-name').value = vendor.displayName || '';
    $('#vendor-tax-id').value = vendor.taxId || '';
    $('#vendor-username').value = vendor.username || '';
    $('#vendor-phone').value = vendor.phone || '';
  }
  clearMessage('#vendor-message');
  $('#vendor-editor').classList.remove('hidden');
  setTimeout(() => $('#vendor-customer-code').focus(), 150);
}

function closeVendorImport() {
  $('#vendor-import-form').reset();
  $('#vendor-import-modal').classList.add('hidden');
  clearMessage('#vendor-import-message');
}

function openVendorImport() {
  $('#vendor-import-form').reset();
  clearMessage('#vendor-import-message');
  $('#vendor-import-modal').classList.remove('hidden');
  setTimeout(() => $('#vendor-import-file').focus(), 100);
}

function closeProductImport() {
  $('#product-import-form').reset();
  $('#product-import-modal').classList.add('hidden');
  clearMessage('#product-import-message');
}

function openProductImport() {
  $('#product-import-form').reset();
  clearMessage('#product-import-message');
  $('#product-import-modal').classList.remove('hidden');
  setTimeout(() => $('#product-import-file').focus(), 100);
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
    setAuthenticatedUi(await api('/api/login', { method:'POST', body:JSON.stringify({ username:$('#login-username').value, password:$('#login-password').value }) }));
    showWork('scan');
  } catch (error) { showMessage('#login-error', error.message); }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST' }); } catch (_) {}
  clearOrderForm('scan'); clearOrderForm('manual');
  setAuthenticatedUi(null);
  showPage('login');
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
$('#scan-zone').addEventListener('click', (event) => { if (scanPlatform !== 'android' && !event.target.closest('input,button,textarea')) scanner.focus(); });
$('#camera-scan-open').addEventListener('click', () => {
  if (!hasNativeAndroidScanner) {
    showMessage('#scan-message', '請使用好市吉 Android App 才能啟動裝置相機掃描');
    return;
  }
  $('#scan-status').textContent = '相機掃描中';
  clearMessage('#scan-message');
  window.AndroidScanner.scanBarcode();
});
window.handleNativeBarcodeScan = async (value, format) => {
  showWork('scan');
  $('#scan-status').textContent = `已掃描${format ? `（${format}）` : ''}`;
  await scanner.submit(value);
};
window.handleNativeBarcodeScanError = (message) => {
  $('#scan-status').textContent = '相機掃描已停止';
  if (message) showMessage('#scan-message', message);
};
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
    if (!state.scanProduct) focusHardwareScanner();
  }
});

$('#manual-form').addEventListener('submit', async (event) => { event.preventDefault(); try { if (!state.manualProduct || state.manualProduct.barcode !== $('#manual-barcode').value.trim()) await lookupProduct($('#manual-barcode').value, 'manual'); await createSingleItemOrder('manual'); } catch (error) { showMessage('#manual-message', error.message); } });
$('#manual-lookup').addEventListener('click', async () => { try { await lookupProduct($('#manual-barcode').value, 'manual'); } catch (error) { state.manualProduct = null; setProduct($('#manual-product'), null, '輸入條碼後查詢商品'); showMessage('#manual-message', error.message); } });
$('#scan-clear').addEventListener('click', () => clearOrderForm('scan'));
$('#history-order-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.memberOrderMode = 'history';
  state.memberOrderPage = 1;
  $('#member-orders-title').textContent = '歷史訂單區間查詢';
  $('#member-orders-caption').textContent = `${$('#history-start-date').value} 至 ${$('#history-end-date').value}（包含結束當天）`;
  loadOrders('#order-list');
});
$('#query-current-month').addEventListener('click', () => {
  state.memberOrderMode = 'month';
  state.memberOrderPage = 1;
  $('#member-orders-title').textContent = '當月訂單';
  $('#member-orders-caption').textContent = '自動顯示本月最新訂單，每頁 50 筆。';
  clearMessage('#history-order-message');
  loadOrders('#order-list');
});
$('#member-order-page-prev').addEventListener('click', () => { if (state.memberOrderPage > 1) { state.memberOrderPage -= 1; loadOrders('#order-list'); } });
$('#member-order-page-next').addEventListener('click', () => { if (state.memberOrderPage < state.memberOrderTotalPages) { state.memberOrderPage += 1; loadOrders('#order-list'); } });
$('#order-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view-member-order]');
  if (button) openOrderDetail(Number(button.dataset.viewMemberOrder));
});
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
$('#order-detail-items').addEventListener('click', async (event) => {
  const saveButton = event.target.closest('[data-save-order-item]');
  const deleteButton = event.target.closest('[data-delete-order-item]');
  if (!saveButton && !deleteButton) return;
  const order = state.adminOrder;
  const itemId = Number((saveButton || deleteButton).dataset[saveButton ? 'saveOrderItem' : 'deleteOrderItem']);
  if (!order) return;
  clearMessage('#order-detail-message');
  try {
    if (saveButton) {
      const quantity = Number($(`[data-item-quantity="${itemId}"]`).value);
      const note = $(`[data-item-note="${itemId}"]`).value;
      await api(`/api/orders/${order.id}/items/${itemId}`, { method:'PUT', body:JSON.stringify({ quantity, note }) });
      showToast('訂單品項已更新');
      await openOrderDetail(order.id);
    } else {
      if (!window.confirm('確定要刪除這個訂單品項嗎？')) return;
      const result = await api(`/api/orders/${order.id}/items/${itemId}`, { method:'DELETE' });
      showToast('訂單品項已刪除');
      if (result.orderDeleted) closeOrderDetail(); else await openOrderDetail(order.id);
    }
    loadOrders('#order-list');
    loadOrders('#recent-orders', 5);
    if (state.user.role === 'admin') loadAdminOrders();
  } catch (error) { showMessage('#order-detail-message', error.message); }
});
$('#order-detail-delete-order').addEventListener('click', async () => {
  const order = state.adminOrder;
  if (!order || !window.confirm(`確定刪除整張訂單 #${order.orderNumber} 嗎？`)) return;
  try {
    await api(`/api/orders/${order.id}`, { method:'DELETE' });
    closeOrderDetail();
    showToast('訂單已刪除');
    loadOrders('#order-list');
    loadOrders('#recent-orders', 5);
    if (state.user.role === 'admin') loadAdminOrders();
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
$('#product-search-field').addEventListener('change', () => { state.productPage = 1; loadProducts(); });
$('#product-page-prev').addEventListener('click', () => { if (state.productPage > 1) { state.productPage -= 1; loadProducts(); } });
$('#product-page-next').addEventListener('click', () => { if (state.productPage < state.productTotalPages) { state.productPage += 1; loadProducts(); } });
$('#product-import-open').addEventListener('click', openProductImport);
$('#product-import-close').addEventListener('click', closeProductImport);
$('#product-import-cancel').addEventListener('click', closeProductImport);
$('#product-import-modal').addEventListener('click', (event) => { if (event.target === $('#product-import-modal')) closeProductImport(); });
$('#product-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage('#product-import-message');
  const file = $('#product-import-file').files[0];
  if (!file) return showMessage('#product-import-message', '請選擇要匯入的檔案');
  if (file.size > 10 * 1024 * 1024) return showMessage('#product-import-message', '檔案不可超過 10 MB');
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const result = await api('/api/admin/products/import', {
      method:'POST', headers:{ 'Content-Type':'application/octet-stream', 'X-File-Name':encodeURIComponent(file.name) }, body:await file.arrayBuffer()
    });
    const disabledNote = result.disabled ? `；其中 ${result.disabled} 筆設為停用` : '';
    showToast(`匯入完成：新增 ${result.inserted} 筆、更新 ${result.updated} 筆${disabledNote}`);
    closeProductImport();
    state.productPage = 1;
    loadProducts();
  } catch (error) { showMessage('#product-import-message', error.message); }
  finally { if (submit) submit.disabled = false; }
});
$('#vendors-refresh').addEventListener('click', loadVendors);
let vendorSearchTimer;
$('#vendor-search').addEventListener('input', () => { clearTimeout(vendorSearchTimer); state.vendorPage = 1; vendorSearchTimer = setTimeout(loadVendors, 180); });
$('#vendor-page-prev').addEventListener('click', () => { if (state.vendorPage > 1) { state.vendorPage -= 1; loadVendors(); } });
$('#vendor-page-next').addEventListener('click', () => { if (state.vendorPage < state.vendorTotalPages) { state.vendorPage += 1; loadVendors(); } });
$('#vendor-create').addEventListener('click', () => openVendorEditor());
$('#vendor-editor-close').addEventListener('click', closeVendorEditor);
$('#vendor-cancel').addEventListener('click', closeVendorEditor);
$('#vendor-import-open').addEventListener('click', openVendorImport);
$('#vendor-import-close').addEventListener('click', closeVendorImport);
$('#vendor-import-cancel').addEventListener('click', closeVendorImport);
$('#vendor-editor').addEventListener('click', (event) => { if (event.target === $('#vendor-editor')) closeVendorEditor(); });
$('#vendor-import-modal').addEventListener('click', (event) => { if (event.target === $('#vendor-import-modal')) closeVendorImport(); });
$('#vendor-import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage('#vendor-import-message');
  const file = $('#vendor-import-file').files[0];
  if (!file) return showMessage('#vendor-import-message', '請選擇要匯入的檔案');
  if (file.size > 3 * 1024 * 1024) return showMessage('#vendor-import-message', '檔案不可超過 3 MB');
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const result = await api('/api/admin/vendors/import', {
      method:'POST', headers:{ 'Content-Type':'application/octet-stream', 'X-File-Name':encodeURIComponent(file.name) }, body:await file.arrayBuffer()
    });
    const defaultNote = result.defaultPasswordCount ? `；${result.defaultPasswordCount} 筆未填密碼的新帳號使用預設密碼 000000` : '';
    showToast(`匯入完成：新增 ${result.inserted} 筆、更新 ${result.updated} 筆${defaultNote}`);
    closeVendorImport();
    state.vendorPage = 1;
    loadVendors();
  } catch (error) { showMessage('#vendor-import-message', error.message); }
  finally { if (submit) submit.disabled = false; }
});
$('#vendor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage('#vendor-message');
  const editing = state.editingVendorId;
  const payload = {
    customerCode:$('#vendor-customer-code').value,
    displayName:$('#vendor-display-name').value,
    taxId:$('#vendor-tax-id').value,
    username:$('#vendor-username').value,
    password:$('#vendor-password').value,
    phone:$('#vendor-phone').value
  };
  try {
    const vendor = await api(editing ? `/api/admin/vendors/${editing}` : '/api/admin/vendors', {
      method:editing ? 'PUT' : 'POST', body:JSON.stringify(payload)
    });
    showToast(`廠商「${vendor.displayName}」已${editing ? '更新' : '建立'}`);
    closeVendorEditor();
    state.vendorPage = 1;
    loadVendors();
  } catch (error) { showMessage('#vendor-message', error.message); }
});
$('#vendor-list').addEventListener('click', async (event) => {
  const ordersButton = event.target.closest('[data-vendor-orders]');
  if (ordersButton) {
    const vendor = state.vendors.find((item) => Number(item.id) === Number(ordersButton.dataset.vendorOrders));
    if (!vendor) return;
    $('#admin-order-query').value = vendor.username;
    $('#admin-order-query-field').value = 'vendor';
    state.adminOrderPage = 1;
    showPage('admin-orders');
    return;
  }
  const editButton = event.target.closest('[data-edit-vendor]');
  if (editButton) {
    const vendor = state.vendors.find((item) => Number(item.id) === Number(editButton.dataset.editVendor));
    if (vendor) openVendorEditor(vendor);
    return;
  }
  const statusButton = event.target.closest('[data-toggle-vendor]');
  if (!statusButton) return;
  const vendor = state.vendors.find((item) => Number(item.id) === Number(statusButton.dataset.toggleVendor));
  if (!vendor) return;
  const nextActive = !vendor.active;
  if (!window.confirm(`確定要${nextActive ? '恢復' : '停用'}「${vendor.displayName}」的登入權限嗎？`)) return;
  try {
    await api(`/api/admin/vendors/${vendor.id}/status`, { method:'PATCH', body:JSON.stringify({ active:nextActive }) });
    showToast(`廠商「${vendor.displayName}」已${nextActive ? '復權' : '停權'}`);
    loadVendors();
  } catch (error) { showToast(error.message); }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('#product-import-modal').classList.contains('hidden')) closeProductImport();
  else if (!$('#vendor-import-modal').classList.contains('hidden')) closeVendorImport();
  else if (!$('#vendor-editor').classList.contains('hidden')) closeVendorEditor();
});
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

function sortTableByColumn(header) {
  const table = header.closest('table');
  const body = table?.tBodies[0];
  if (!body) return;
  const headers = [...header.parentElement.children];
  const column = headers.indexOf(header);
  const direction = header.dataset.sortDirection === 'asc' ? 'desc' : 'asc';
  headers.forEach((item) => { delete item.dataset.sortDirection; item.removeAttribute('aria-sort'); });
  header.dataset.sortDirection = direction;
  header.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
  const collator = new Intl.Collator('zh-Hant', { numeric:true, sensitivity:'base' });
  const rows = [...body.rows].filter((row) => !row.querySelector('.empty'));
  rows.sort((left, right) => {
    const leftValue = left.cells[column]?.querySelector('input,select')?.value || left.cells[column]?.textContent.trim() || '';
    const rightValue = right.cells[column]?.querySelector('input,select')?.value || right.cells[column]?.textContent.trim() || '';
    return collator.compare(leftValue, rightValue) * (direction === 'asc' ? 1 : -1);
  });
  rows.forEach((row) => body.appendChild(row));
}

$$('table thead th').forEach((header) => {
  if (['選取', '操作', '檔案'].includes(header.textContent.trim())) return;
  header.classList.add('sortable-header');
  header.tabIndex = 0;
  header.title = '點擊快速排序';
  header.addEventListener('click', () => sortTableByColumn(header));
  header.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); sortTableByColumn(header); } });
});

const today = new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Taipei' });
const historyStart = new Date(`${today}T00:00:00`);
historyStart.setMonth(historyStart.getMonth() - 1);
$('#history-start-date').value = historyStart.toLocaleDateString('en-CA');
$('#history-end-date').value = today;
$('#admin-export-date').value = today;
configureScannerPlatform();
api('/api/me').then((user) => { setAuthenticatedUi(user); loadOrders('#recent-orders', 5); }).catch(() => setAuthenticatedUi(null));
