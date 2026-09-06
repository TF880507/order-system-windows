const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionHours = Number(process.env.SESSION_HOURS || 12);
const initialAdminPassword = process.env.ADMIN_PASSWORD || 'admin12345';
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'orders.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    specification TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    barcode_snapshot TEXT NOT NULL,
    product_name_snapshot TEXT NOT NULL,
    specification_snapshot TEXT DEFAULT '',
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    note TEXT DEFAULT '',
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const seedUser = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!seedUser) {
  db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
    .run('admin', bcrypt.hashSync(initialAdminPassword, 12), '系統管理員', 'admin');
}

const seedProduct = db.prepare('INSERT OR IGNORE INTO products (barcode, name, specification) VALUES (?, ?, ?)');
[
  ['4719585678958', '測試商品 A', '標準包裝'],
  ['4710088432415', '測試商品 B', '盒裝'],
  ['4902430781026', '測試商品 C', '單入']
].forEach((row) => seedProduct.run(...row));

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie).order_session;
  if (!token) return res.status(401).json({ error: '請先登入' });

  const session = db.prepare(`
    SELECT users.id, users.username, users.display_name, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > datetime('now') AND users.active = 1
  `).get(token);

  if (!session) return res.status(401).json({ error: '登入已逾時，請重新登入' });
  req.user = session;
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅系統管理員可管理商品' });
  next();
}

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))")
    .run(token, user.id, `+${sessionHours} hours`);

  res.setHeader('Set-Cookie', `order_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionHours * 3600}`);
  res.json({ id: user.id, username: user.username, displayName: user.display_name, role: user.role });
});

app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  res.setHeader('Set-Cookie', 'order_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.status(204).end();
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.get('/api/products/:barcode', requireAuth, (req, res) => {
  const product = db.prepare('SELECT id, barcode, name, specification FROM products WHERE barcode = ? AND active = 1')
    .get(req.params.barcode.trim());
  if (!product) return res.status(404).json({ error: '查無此商品條碼' });
  res.json(product);
});

app.get('/api/products', requireAuth, requireAdmin, (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 512);
  const filter = query ? `AND (barcode LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR specification LIKE ? ESCAPE '\\')` : '';
  const escaped = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  res.json(db.prepare(`
    SELECT id, barcode, name, specification, created_at AS createdAt
    FROM products WHERE active = 1 ${filter} ORDER BY id DESC
  `).all(...(query ? [escaped, escaped, escaped] : [])));
});

app.post('/api/products', requireAuth, requireAdmin, (req, res) => {
  const barcode = String(req.body.barcode || '').trim();
  const name = String(req.body.name || '').trim();
  const specification = String(req.body.specification || '').trim();
  if (!barcode || barcode.length > 512) return res.status(400).json({ error: '請輸入有效商品條碼' });
  if (!name || name.length > 120) return res.status(400).json({ error: '請輸入商品名稱（最多 120 字）' });
  if (specification.length > 300) return res.status(400).json({ error: '規格最多 300 字' });
  try {
    const result = db.prepare('INSERT INTO products (barcode, name, specification) VALUES (?, ?, ?)')
      .run(barcode, name, specification);
    res.status(201).json(db.prepare('SELECT id, barcode, name, specification FROM products WHERE id = ?').get(result.lastInsertRowid));
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: '此商品條碼已存在，請勿重複新增' });
    throw error;
  }
});

app.put('/api/products/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const barcode = String(req.body.barcode || '').trim();
  const name = String(req.body.name || '').trim();
  const specification = String(req.body.specification || '').trim();
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: '查無此商品' });
  if (!barcode || barcode.length > 512) return res.status(400).json({ error: '請輸入有效商品條碼' });
  if (!name || name.length > 120) return res.status(400).json({ error: '請輸入商品名稱（最多 120 字）' });
  if (specification.length > 300) return res.status(400).json({ error: '規格最多 300 字' });
  try {
    const result = db.prepare('UPDATE products SET barcode = ?, name = ?, specification = ? WHERE id = ? AND active = 1').run(barcode, name, specification, id);
    if (!result.changes) return res.status(404).json({ error: '查無此商品或商品已刪除' });
    res.json(db.prepare('SELECT id, barcode, name, specification FROM products WHERE id = ?').get(id));
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return res.status(409).json({ error: '此商品條碼已存在，請勿重複使用' });
    throw error;
  }
});

app.delete('/api/products/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: '查無此商品' });
  const result = db.prepare('UPDATE products SET active = 0 WHERE id = ? AND active = 1').run(id);
  if (!result.changes) return res.status(404).json({ error: '查無此商品或商品已刪除' });
  res.status(204).end();
});

const createOrder = db.transaction((userId, items) => {
  const datePrefix = db.prepare("SELECT strftime('%Y%m%d', 'now', 'localtime') AS value").get().value;
  const count = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE order_number LIKE ?').get(`${datePrefix}-%`).count + 1;
  const orderNumber = `${datePrefix}-${String(count).padStart(4, '0')}`;
  const order = db.prepare('INSERT INTO orders (order_number, user_id) VALUES (?, ?)').run(orderNumber, userId);
  const insertItem = db.prepare(`
    INSERT INTO order_items
      (order_id, product_id, barcode_snapshot, product_name_snapshot, specification_snapshot, quantity, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE barcode = ? AND active = 1').get(String(item.barcode));
    if (!product) throw new Error(`查無商品：${item.barcode}`);
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new Error('商品數量不正確');
    insertItem.run(order.lastInsertRowid, product.id, product.barcode, product.name, product.specification, quantity, String(item.note || '').slice(0, 500));
  }
  return { id: Number(order.lastInsertRowid), orderNumber };
});

app.post('/api/orders', requireAuth, (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: '訂單至少需要一項商品' });
  try {
    res.status(201).json(createOrder(req.user.id, items));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/orders', requireAuth, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
    ? req.query.date
    : new Date().toISOString().slice(0, 10);
  const orders = db.prepare(`
    SELECT orders.id, orders.order_number AS orderNumber, orders.status, orders.created_at AS createdAt,
           users.display_name AS memberName, COUNT(order_items.id) AS itemCount,
           COALESCE(SUM(order_items.quantity), 0) AS totalQuantity
    FROM orders
    JOIN users ON users.id = orders.user_id
    LEFT JOIN order_items ON order_items.order_id = orders.id
    WHERE date(orders.created_at, 'localtime') = date(?)
    GROUP BY orders.id ORDER BY orders.id DESC
  `).all(date);
  res.json(orders);
});

app.get('/api/orders/:id', requireAuth, (req, res) => {
  const order = db.prepare(`
    SELECT orders.id, orders.order_number AS orderNumber, orders.status, orders.created_at AS createdAt,
           users.display_name AS memberName
    FROM orders JOIN users ON users.id = orders.user_id WHERE orders.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).json({ error: '查無訂單' });
  order.items = db.prepare(`
    SELECT barcode_snapshot AS barcode, product_name_snapshot AS name,
           specification_snapshot AS specification, quantity, note
    FROM order_items WHERE order_id = ? ORDER BY id
  `).all(order.id);
  res.json(order);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(port, '0.0.0.0', () => {
  console.log(`訂單系統已啟動：http://localhost:${port}`);
});
