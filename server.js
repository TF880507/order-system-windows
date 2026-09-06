const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionHours = Number(process.env.SESSION_HOURS || 12);
const initialAdminPassword = process.env.ADMIN_PASSWORD || 'test123';
const databaseUrl = process.env.DATABASE_URL || 'postgresql://order_app:order_dev_password@127.0.0.1:5432/order_system';
const pool = new Pool({ connectionString: databaseUrl });

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      barcode TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      specification TEXT DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      user_id BIGINT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'created',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL REFERENCES products(id),
      barcode_snapshot TEXT NOT NULL,
      product_name_snapshot TEXT NOT NULL,
      specification_snapshot TEXT DEFAULT '',
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      note TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  const adminHash = await bcrypt.hash(initialAdminPassword, 12);
  await pool.query(`
    INSERT INTO users (username, password_hash, display_name, role, active)
    VALUES ('admin', $1, '系統管理員', 'admin', TRUE)
    ON CONFLICT (username) DO UPDATE
      SET password_hash = EXCLUDED.password_hash, role = 'admin', active = TRUE
  `, [adminHash]);

  const products = [
    ['4719585678958', '測試商品 A', '標準包裝'],
    ['4710088432415', '測試商品 B', '盒裝'],
    ['4902430781026', '測試商品 C', '單入']
  ];
  for (const product of products) {
    await pool.query(`
      INSERT INTO products (barcode, name, specification)
      VALUES ($1, $2, $3) ON CONFLICT (barcode) DO NOTHING
    `, product);
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie).order_session;
    if (!token) return res.status(401).json({ error: '請先登入' });
    const { rows } = await pool.query(`
      SELECT users.id, users.username, users.display_name, users.role
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = $1 AND sessions.expires_at > NOW() AND users.active = TRUE
    `, [token]);
    if (!rows[0]) return res.status(401).json({ error: '登入已逾時，請重新登入' });
    req.user = rows[0];
    req.sessionToken = token;
    next();
  } catch (error) { next(error); }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅系統管理員可管理商品' });
  next();
}

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND active = TRUE', [username]);
  const user = rows[0];
  if (!user || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: '帳號或密碼錯誤' });

  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  await pool.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 * INTERVAL \'1 hour\'))', [token, user.id, sessionHours]);
  res.setHeader('Set-Cookie', `order_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionHours * 3600}`);
  res.json({ id:user.id, username:user.username, displayName:user.display_name, role:user.role });
});

app.post('/api/logout', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token = $1', [req.sessionToken]);
  res.setHeader('Set-Cookie', 'order_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.status(204).end();
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.get('/api/products/:barcode', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, barcode, name, specification FROM products WHERE barcode = $1 AND active = TRUE', [req.params.barcode.trim()]);
  if (!rows[0]) return res.status(404).json({ error: '查無此商品條碼' });
  res.json(rows[0]);
});

app.get('/api/products', requireAuth, requireAdmin, async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 512);
  const values = query ? [`%${query}%`] : [];
  const filter = query ? 'AND (barcode ILIKE $1 OR name ILIKE $1 OR specification ILIKE $1)' : '';
  const { rows } = await pool.query(`SELECT id, barcode, name, specification, created_at AS "createdAt" FROM products WHERE active = TRUE ${filter} ORDER BY id DESC`, values);
  res.json(rows);
});

app.post('/api/products', requireAuth, requireAdmin, async (req, res) => {
  const barcode = String(req.body.barcode || '').trim();
  const name = String(req.body.name || '').trim();
  const specification = String(req.body.specification || '').trim();
  if (!barcode || barcode.length > 512) return res.status(400).json({ error: '請輸入有效商品條碼' });
  if (!name || name.length > 120) return res.status(400).json({ error: '請輸入商品名稱（最多 120 字）' });
  if (specification.length > 300) return res.status(400).json({ error: '規格最多 300 字' });
  try {
    const { rows } = await pool.query('INSERT INTO products (barcode, name, specification) VALUES ($1, $2, $3) RETURNING id, barcode, name, specification', [barcode, name, specification]);
    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: '此商品條碼已存在，請勿重複新增' });
    throw error;
  }
});

app.put('/api/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const barcode = String(req.body.barcode || '').trim();
  const name = String(req.body.name || '').trim();
  const specification = String(req.body.specification || '').trim();
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: '查無此商品' });
  if (!barcode || barcode.length > 512) return res.status(400).json({ error: '請輸入有效商品條碼' });
  if (!name || name.length > 120) return res.status(400).json({ error: '請輸入商品名稱（最多 120 字）' });
  if (specification.length > 300) return res.status(400).json({ error: '規格最多 300 字' });
  try {
    const { rows } = await pool.query('UPDATE products SET barcode=$1, name=$2, specification=$3 WHERE id=$4 AND active=TRUE RETURNING id, barcode, name, specification', [barcode, name, specification, id]);
    if (!rows[0]) return res.status(404).json({ error: '查無此商品或商品已刪除' });
    res.json(rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: '此商品條碼已存在，請勿重複使用' });
    throw error;
  }
});

app.delete('/api/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: '查無此商品' });
  const result = await pool.query('UPDATE products SET active=FALSE WHERE id=$1 AND active=TRUE', [id]);
  if (!result.rowCount) return res.status(404).json({ error: '查無此商品或商品已刪除' });
  res.status(204).end();
});

async function createOrder(userId, items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const datePrefix = (await client.query("SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei', 'YYYYMMDD') AS value")).rows[0].value;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [datePrefix]);
    const count = Number((await client.query('SELECT COUNT(*) AS count FROM orders WHERE order_number LIKE $1', [`${datePrefix}-%`])).rows[0].count) + 1;
    const orderNumber = `${datePrefix}-${String(count).padStart(4, '0')}`;
    const order = (await client.query('INSERT INTO orders (order_number, user_id) VALUES ($1, $2) RETURNING id', [orderNumber, userId])).rows[0];

    for (const item of items) {
      const product = (await client.query('SELECT * FROM products WHERE barcode=$1 AND active=TRUE', [String(item.barcode)])).rows[0];
      if (!product) throw new Error(`查無商品：${item.barcode}`);
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new Error('商品數量不正確');
      await client.query(`INSERT INTO order_items (order_id, product_id, barcode_snapshot, product_name_snapshot, specification_snapshot, quantity, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [order.id, product.id, product.barcode, product.name, product.specification, quantity, String(item.note || '').slice(0, 500)]);
    }
    await client.query('COMMIT');
    return { id:Number(order.id), orderNumber };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

app.post('/api/orders', requireAuth, async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: '訂單至少需要一項商品' });
  try { res.status(201).json(await createOrder(req.user.id, items)); }
  catch (error) { res.status(400).json({ error:error.message }); }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : new Date().toLocaleDateString('en-CA', { timeZone:'Asia/Taipei' });
  const { rows } = await pool.query(`
    SELECT orders.id, orders.order_number AS "orderNumber", orders.status, orders.created_at AS "createdAt",
           users.display_name AS "memberName", COUNT(order_items.id)::integer AS "itemCount",
           COALESCE(SUM(order_items.quantity),0)::integer AS "totalQuantity"
    FROM orders JOIN users ON users.id=orders.user_id LEFT JOIN order_items ON order_items.order_id=orders.id
    WHERE (orders.created_at AT TIME ZONE 'Asia/Taipei')::date=$1::date
    GROUP BY orders.id, users.display_name ORDER BY orders.id DESC
  `, [date]);
  res.json(rows);
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT orders.id, orders.order_number AS "orderNumber", orders.status, orders.created_at AS "createdAt", users.display_name AS "memberName" FROM orders JOIN users ON users.id=orders.user_id WHERE orders.id=$1`, [req.params.id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error: '查無訂單' });
  order.items = (await pool.query(`SELECT barcode_snapshot AS barcode, product_name_snapshot AS name, specification_snapshot AS specification, quantity, note FROM order_items WHERE order_id=$1 ORDER BY id`, [order.id])).rows;
  res.json(order);
});

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok:true, database:'postgresql' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error:'伺服器發生錯誤' });
});

initializeDatabase().then(() => app.listen(port, '0.0.0.0', () => console.log(`訂單系統已啟動：http://localhost:${port}`))).catch((error) => {
  console.error('資料庫初始化失敗', error);
  process.exit(1);
});
