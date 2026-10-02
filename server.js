const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const XLSX = require('xlsx');
const { BUSINESS_TIME_ZONE, getBusinessClock, shiftDate, csvCell, buildOrdersCsv } = require('./schedule');
const { validateOrderDateRange } = require('./order-range');
const { matchesLegacyMd5 } = require('./legacy-login');
const { MAX_PRODUCT_IMPORT_ROWS, createProductTemplateBuffer, createProductsExportBuffer, parseProductImportBuffer } = require('./product-spreadsheet');
const { barcodeCandidates } = require('./barcode-lookup');

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

    ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_customer_id BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_password TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN NOT NULL DEFAULT FALSE;

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

    CREATE TABLE IF NOT EXISTS order_number_sequences (
      business_date DATE PRIMARY KEY,
      last_number INTEGER NOT NULL CHECK (last_number > 0)
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

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS legacy_order_id BIGINT;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS legacy_detail_id BIGINT;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS legacy_quantity TEXT;

    CREATE TABLE IF NOT EXISTS legacy_product_links (
      legacy_product_id BIGINT PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS legacy_import_runs (
      id BIGSERIAL PRIMARY KEY,
      source_file TEXT NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      statistics JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS business_date DATE;
    UPDATE orders SET business_date=(created_at AT TIME ZONE 'Asia/Taipei')::date WHERE business_date IS NULL;
    ALTER TABLE orders ALTER COLUMN business_date SET NOT NULL;

    CREATE TABLE IF NOT EXISTS schedule_settings (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      close_time TEXT NOT NULL DEFAULT '00:00',
      timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
      last_closed_date DATE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by BIGINT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_exports (
      id BIGSERIAL PRIMARY KEY,
      business_date DATE NOT NULL,
      export_type TEXT NOT NULL CHECK (export_type IN ('automatic', 'manual')),
      exported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      exported_by BIGINT REFERENCES users(id),
      order_count INTEGER NOT NULL,
      item_count INTEGER NOT NULL,
      total_quantity INTEGER NOT NULL,
      csv_content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_closings (
      business_date DATE PRIMARY KEY,
      closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('automatic', 'manual')),
      closed_by BIGINT REFERENCES users(id),
      export_id BIGINT NOT NULL REFERENCES order_exports(id)
    );

    INSERT INTO schedule_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_business_date ON orders(business_date DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_user_id_business_date ON orders(user_id, business_date DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status_business_date ON orders(status, business_date DESC);
    CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);
    CREATE INDEX IF NOT EXISTS idx_order_exports_business_date ON order_exports(business_date DESC, exported_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_legacy_customer_id ON users(legacy_customer_id) WHERE legacy_customer_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_legacy_order_id ON orders(legacy_order_id) WHERE legacy_order_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_legacy_detail_id ON order_items(legacy_detail_id) WHERE legacy_detail_id IS NOT NULL;
  `);

  const adminHash = await bcrypt.hash(initialAdminPassword, 12);
  await pool.query(`
    INSERT INTO users (username, password_hash, display_name, role, active)
    VALUES ('admin', $1, '系統管理員', 'admin', TRUE)
    ON CONFLICT (username) DO UPDATE
      SET display_name = EXCLUDED.display_name, role = 'admin', active = TRUE
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
  if (req.user.role !== 'admin') return res.status(403).json({ error: '僅系統管理員可使用此功能' });
  next();
}

function orderScope(req, values, alias = 'orders') {
  if (req.user.role === 'admin') return 'TRUE';
  values.push(req.user.id);
  return `${alias}.user_id=$${values.length}`;
}

function parsePagination(req, defaultPageSize = 50) {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(req.query.pageSize, 10) || defaultPageSize));
  return { page, pageSize, offset:(page - 1) * pageSize };
}

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND active = TRUE', [username]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: '帳號或密碼錯誤' });
  let passwordMatches = await bcrypt.compare(password, user.password_hash).catch(() => false);
  if (!passwordMatches && user.role === 'admin' && matchesLegacyMd5(password, user.legacy_password)) {
    const upgradedHash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash=$1, legacy_password=NULL, password_reset_required=FALSE WHERE id=$2', [upgradedHash, user.id]);
    passwordMatches = true;
  }
  if (!passwordMatches) return res.status(401).json({ error: '帳號或密碼錯誤' });
  if (user.role === 'admin' && user.legacy_password) {
    await pool.query('UPDATE users SET legacy_password=NULL WHERE id=$1', [user.id]);
  }

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

app.get('/api/admin/vendors', requireAuth, requireAdmin, async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 200);
  const { page, pageSize, offset } = parsePagination(req);
  const values = query ? [`%${query}%`] : [];
  const filter = query ? `AND (
    users.display_name ILIKE $1 OR users.username ILIKE $1 OR
    COALESCE(users.customer_code, '') ILIKE $1 OR COALESCE(users.phone, '') ILIKE $1 OR
    COALESCE(users.tax_id, '') ILIKE $1
  )` : '';
  const total = Number((await pool.query(`
    SELECT COUNT(*) AS count FROM users WHERE role='member' ${filter}
  `, values)).rows[0].count);
  const listValues = [...values, pageSize, offset];
  const { rows } = await pool.query(`
    SELECT users.id, users.username, users.display_name AS "displayName",
      users.customer_code AS "customerCode", users.phone, users.tax_id AS "taxId", users.active,
      COALESCE(order_stats.order_count, 0)::integer AS "orderCount",
      order_stats.latest_order_date::text AS "latestOrderDate"
    FROM users
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS order_count, MAX(business_date) AS latest_order_date
      FROM orders WHERE orders.user_id=users.id
    ) order_stats ON TRUE
    WHERE users.role='member' ${filter}
    ORDER BY users.display_name, users.id
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `, listValues);
  res.json({ items:rows, total, page, pageSize, totalPages:Math.max(1, Math.ceil(total / pageSize)) });
});

function readVendorPayload(body, requirePassword = false) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim();
  const customerCode = String(body.customerCode || '').trim();
  const phone = String(body.phone || '').trim();
  const taxId = String(body.taxId || '').trim();
  if (!username || username.length > 120 || /\s/.test(username)) return { error:'登入帳號必填、不可包含空白，且最多 120 字' };
  if ((requirePassword || password) && (password.length < 6 || password.length > 200)) return { error:'密碼須為 6 至 200 個字元' };
  if (!displayName || displayName.length > 120) return { error:'廠商名稱必填，且最多 120 字' };
  if (!customerCode || customerCode.length > 80) return { error:'客戶序號必填，且最多 80 字' };
  if (phone.length > 80) return { error:'電話最多 80 字' };
  if (!taxId || taxId.length > 80) return { error:'統一編號必填，且最多 80 字' };
  return { username, password, displayName, customerCode, phone, taxId };
}

app.post('/api/admin/vendors', requireAuth, requireAdmin, async (req, res) => {
  const vendor = readVendorPayload(req.body, true);
  if (vendor.error) return res.status(400).json({ error:vendor.error });
  const passwordHash = await bcrypt.hash(vendor.password, 12);
  try {
    const { rows } = await pool.query(`
      INSERT INTO users (username, password_hash, display_name, role, active, customer_code, phone, tax_id, legacy_password, password_reset_required)
      VALUES ($1,$2,$3,'member',TRUE,$4,$5,$6,NULL,FALSE)
      RETURNING id, username, display_name AS "displayName", customer_code AS "customerCode", phone, tax_id AS "taxId", active
    `, [vendor.username, passwordHash, vendor.displayName, vendor.customerCode, vendor.phone, vendor.taxId]);
    res.status(201).json(rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error:'此登入帳號已存在，請使用其他帳號' });
    throw error;
  }
});

app.put('/api/admin/vendors/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error:'查無此廠商' });
  const vendor = readVendorPayload(req.body);
  if (vendor.error) return res.status(400).json({ error:vendor.error });
  const passwordHash = vendor.password ? await bcrypt.hash(vendor.password, 12) : null;
  try {
    const { rows } = await pool.query(`
      UPDATE users SET username=$1, display_name=$2, customer_code=$3, phone=$4, tax_id=$5,
        password_hash=COALESCE($6, password_hash),
        legacy_password=CASE WHEN $6::text IS NULL THEN legacy_password ELSE NULL END,
        password_reset_required=CASE WHEN $6::text IS NULL THEN password_reset_required ELSE FALSE END
      WHERE id=$7 AND role='member'
      RETURNING id, username, display_name AS "displayName", customer_code AS "customerCode", phone, tax_id AS "taxId", active
    `, [vendor.username, vendor.displayName, vendor.customerCode, vendor.phone, vendor.taxId, passwordHash, id]);
    if (!rows[0]) return res.status(404).json({ error:'查無此廠商' });
    res.json(rows[0]);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error:'此登入帳號已存在，請使用其他帳號' });
    throw error;
  }
});

app.patch('/api/admin/vendors/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const active = req.body.active;
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error:'查無此廠商' });
  if (typeof active !== 'boolean') return res.status(400).json({ error:'帳號狀態不正確' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      UPDATE users SET active=$1 WHERE id=$2 AND role='member'
      RETURNING id, username, display_name AS "displayName", active
    `, [active, id]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error:'查無此廠商' });
    }
    if (!active) await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

app.get('/api/admin/vendors/export', requireAuth, requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT users.display_name AS "displayName", users.username,
      users.customer_code AS "customerCode", users.phone, users.tax_id AS "taxId", users.active,
      COALESCE(order_stats.order_count, 0)::integer AS "orderCount",
      order_stats.latest_order_date::text AS "latestOrderDate"
    FROM users
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS order_count, MAX(business_date) AS latest_order_date
      FROM orders WHERE orders.user_id=users.id
    ) order_stats ON TRUE
    WHERE users.role='member'
    ORDER BY users.display_name, users.id
  `);
  const csvRows = [
    ['廠商名稱', '登入帳號', '客戶序號', '電話', '統一編號', '訂單數', '最近訂購日', '狀態'],
    ...rows.map((vendor) => [vendor.displayName, vendor.username, vendor.customerCode, vendor.phone, vendor.taxId, vendor.orderCount, vendor.latestOrderDate, vendor.active ? '啟用' : '停用'])
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="vendors.csv"');
  res.send(`\uFEFF${csvRows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`);
});

app.get('/api/admin/vendors/import-template', requireAuth, requireAdmin, (_req, res) => {
  const rows = [
    ['客戶序號', '廠商名稱', '電話', '統一編號', '登入帳號', '登入密碼'],
    ['6439A', '範例廠商（請刪除此列）', '02-1234-5678', '12345678', 'vendor001', '000000']
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="vendor-import-template.csv"');
  res.send(`\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`);
});

function importCell(row, aliases) {
  for (const [key, value] of Object.entries(row)) {
    const normalized = String(key).replace(/^\uFEFF/, '').replace(/[\s　]/g, '').replace(/[（(].*?[）)]/g, '');
    if (aliases.includes(normalized)) return String(value ?? '').trim();
  }
  return '';
}

app.post('/api/admin/vendors/import', requireAuth, requireAdmin,
  express.raw({ type:'application/octet-stream', limit:'3mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error:'請選擇要匯入的 CSV、XLS 或 XLSX 檔案' });
    let records;
    try {
      const workbook = XLSX.read(req.body, { type:'buffer', raw:false, cellDates:false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      records = XLSX.utils.sheet_to_json(sheet, { defval:'', raw:false });
    } catch (_error) {
      return res.status(400).json({ error:'檔案格式無法解析，請使用範本 CSV、XLS 或 XLSX' });
    }
    if (!records.length) return res.status(400).json({ error:'匯入檔案沒有資料' });
    if (records.length > 2000) return res.status(400).json({ error:'單次最多匯入 2,000 筆廠商' });

    const parsed = records.map((row, index) => {
      const customerCode = importCell(row, ['客戶代碼', '廠商序號', '客戶序號']);
      const displayName = importCell(row, ['廠商名稱', '客戶名稱', '客戶姓名']);
      const phone = importCell(row, ['電話', '電話號碼']);
      const taxId = importCell(row, ['統一編號', '統編']);
      const username = importCell(row, ['登入帳號', '帳號']) || taxId;
      const password = importCell(row, ['登入密碼', '密碼']);
      const error = !customerCode ? '缺少客戶序號' : !displayName ? '缺少廠商名稱' : !taxId ? '缺少統一編號' : !username ? '缺少登入帳號' : password && password.length < 6 ? '登入密碼至少需要 6 個字元' : '';
      return { row:index + 2, customerCode, displayName, phone, taxId, username, password, error };
    });
    const invalid = parsed.filter((item) => item.error);
    if (invalid.length) return res.status(400).json({ error:`第 ${invalid[0].row} 列${invalid[0].error}；請修正後重新匯入` });

    const client = await pool.connect();
    let inserted = 0;
    let updated = 0;
    let defaultPasswordCount = 0;
    try {
      await client.query('BEGIN');
      const defaultHash = await bcrypt.hash('000000', 12);
      for (const vendor of parsed) {
        const existing = (await client.query('SELECT id, role FROM users WHERE username=$1 FOR UPDATE', [vendor.username])).rows[0];
        if (existing?.role === 'admin') throw Object.assign(new Error(`第 ${vendor.row} 列的帳號屬於管理員，不能覆蓋`), { statusCode:409 });
        const passwordHash = vendor.password ? await bcrypt.hash(vendor.password, 12) : null;
        if (existing) {
          await client.query(`
            UPDATE users SET display_name=$1, customer_code=$2, phone=$3, tax_id=$4, active=TRUE,
              password_hash=COALESCE($5,password_hash), legacy_password=CASE WHEN $5::text IS NULL THEN legacy_password ELSE NULL END,
              password_reset_required=CASE WHEN $5::text IS NULL THEN password_reset_required ELSE FALSE END
            WHERE id=$6
          `, [vendor.displayName, vendor.customerCode, vendor.phone, vendor.taxId, passwordHash, existing.id]);
          updated += 1;
        } else {
          await client.query(`
            INSERT INTO users (username,password_hash,display_name,role,active,customer_code,phone,tax_id,password_reset_required)
            VALUES ($1,$2,$3,'member',TRUE,$4,$5,$6,$7)
          `, [vendor.username, passwordHash || defaultHash, vendor.displayName, vendor.customerCode, vendor.phone, vendor.taxId, !vendor.password]);
          inserted += 1;
          if (!vendor.password) defaultPasswordCount += 1;
        }
      }
      await client.query('COMMIT');
      res.json({ total:parsed.length, inserted, updated, defaultPasswordCount });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return res.status(409).json({ error:'匯入資料有重複帳號，請檢查檔案' });
      if (error.statusCode) return res.status(error.statusCode).json({ error:error.message });
      throw error;
    } finally { client.release(); }
  });

app.get('/api/admin/products/export', requireAuth, requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT barcode, name, specification, active, created_at AS "createdAt"
    FROM products ORDER BY active DESC, name, id
  `);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="products.xlsx"');
  res.send(createProductsExportBuffer(rows));
});

app.get('/api/admin/products/import-template', requireAuth, requireAdmin, (_req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="product-import-template.xlsx"');
  res.send(createProductTemplateBuffer());
});

app.post('/api/admin/products/import', requireAuth, requireAdmin,
  express.raw({ type:'application/octet-stream', limit:'10mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error:'請選擇要匯入的 CSV、XLS 或 XLSX 檔案' });
    let products;
    try {
      products = parseProductImportBuffer(req.body);
    } catch (error) {
      return res.status(400).json({ error:error.message });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const barcodes = products.map((product) => product.barcode);
      const existingRows = (await client.query('SELECT barcode, active FROM products WHERE barcode=ANY($1::text[]) FOR UPDATE', [barcodes])).rows;
      const existing = new Set(existingRows.map((product) => product.barcode));
      await client.query(`
        INSERT INTO products (barcode,name,specification,active)
        SELECT * FROM UNNEST($1::text[],$2::text[],$3::text[],$4::boolean[])
        ON CONFLICT (barcode) DO UPDATE SET
          name=EXCLUDED.name, specification=EXCLUDED.specification, active=EXCLUDED.active
      `, [
        barcodes,
        products.map((product) => product.name),
        products.map((product) => product.specification),
        products.map((product) => product.active)
      ]);
      await client.query('COMMIT');
      const disabled = products.filter((product) => !product.active).length;
      res.json({
        total:products.length,
        inserted:products.length - existing.size,
        updated:existing.size,
        disabled,
        limit:MAX_PRODUCT_IMPORT_ROWS
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return res.status(409).json({ error:'匯入資料包含重複商品條碼，請檢查檔案' });
      throw error;
    } finally { client.release(); }
  });

app.get('/api/products/:barcode', requireAuth, async (req, res) => {
  const candidates = barcodeCandidates(req.params.barcode);
  if (!candidates.length) return res.status(400).json({ error:'請輸入有效商品條碼' });
  const { rows } = await pool.query(`
    SELECT id, barcode, name, specification FROM products
    WHERE barcode=ANY($1::text[]) AND active=TRUE
    ORDER BY array_position($1::text[], barcode) LIMIT 1
  `, [candidates]);
  if (!rows[0]) return res.status(404).json({ error: '查無此商品條碼' });
  res.json(rows[0]);
});

app.get('/api/products', requireAuth, requireAdmin, async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 512);
  const queryField = ['barcode', 'name'].includes(String(req.query.queryField || '')) ? String(req.query.queryField) : 'all';
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(req.query.pageSize, 10) || 50));
  const values = query ? [`%${query}%`] : [];
  const filter = query ? (queryField === 'barcode' ? 'AND barcode ILIKE $1' : queryField === 'name' ? 'AND name ILIKE $1' : 'AND (barcode ILIKE $1 OR name ILIKE $1 OR specification ILIKE $1)') : '';
  const total = Number((await pool.query(`SELECT COUNT(*) AS count FROM products WHERE active = TRUE ${filter}`, values)).rows[0].count);
  const offset = (page - 1) * pageSize;
  const listValues = [...values, pageSize, offset];
  const { rows } = await pool.query(`SELECT id, barcode, name, specification, created_at AS "createdAt" FROM products WHERE active = TRUE ${filter} ORDER BY id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, listValues);
  res.json({ items:rows, total, page, pageSize, totalPages:Math.max(1, Math.ceil(total / pageSize)) });
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
    const businessDate = (await client.query("SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS value")).rows[0].value;
    const datePrefix = businessDate.replaceAll('-', '');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [datePrefix]);
    const closed = await client.query('SELECT 1 FROM daily_closings WHERE business_date=$1::date', [businessDate]);
    if (closed.rowCount) throw new Error('今日訂單已結單，無法再新增');
    const pattern = `^${datePrefix}-([0-9]+)$`;
    const sequence = Number((await client.query(`
      INSERT INTO order_number_sequences (business_date, last_number)
      SELECT $1::date, COALESCE(MAX((substring(order_number FROM $2))::integer),0)+1
      FROM orders WHERE business_date=$1::date AND order_number ~ $2
      ON CONFLICT (business_date) DO UPDATE
        SET last_number=order_number_sequences.last_number+1
      RETURNING last_number
    `, [businessDate, pattern])).rows[0].last_number);
    const orderNumber = `${datePrefix}-${String(sequence).padStart(4, '0')}`;
    const order = (await client.query('INSERT INTO orders (order_number, user_id, business_date) VALUES ($1, $2, $3) RETURNING id', [orderNumber, userId, businessDate])).rows[0];

    for (const item of items) {
      const candidates = barcodeCandidates(item.barcode);
      const product = (await client.query(`SELECT * FROM products WHERE barcode=ANY($1::text[]) AND active=TRUE ORDER BY array_position($1::text[],barcode) LIMIT 1`, [candidates])).rows[0];
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
  catch (error) {
    if (error.code === '23505' && error.constraint === 'orders_order_number_key') return res.status(409).json({ error:'訂單編號建立衝突，請重新送出一次' });
    res.status(400).json({ error:error.message });
  }
});

async function listOrders(req, res, range = null) {
  const { page, pageSize, offset } = parsePagination(req);
  const values = [];
  const conditions = [orderScope(req, values)];
  if (range) {
    values.push(range.startDate, range.endDate);
    conditions.push(`orders.business_date >= $${values.length - 1}::date`);
    conditions.push(`orders.business_date < ($${values.length}::date + INTERVAL '1 day')`);
  } else {
    conditions.push(`orders.business_date >= date_trunc('month', NOW())::date`);
    conditions.push(`orders.business_date < (date_trunc('month', NOW()) + INTERVAL '1 month')::date`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = Number((await pool.query(`SELECT COUNT(*) AS count FROM orders ${where}`, values)).rows[0].count);
  const listValues = [...values, pageSize, offset];
  const { rows } = await pool.query(`
    SELECT orders.id, orders.order_number AS "orderNumber", orders.status, orders.created_at AS "createdAt",
      orders.created_at AS "orderDate", orders.business_date::text AS "businessDate",
      (orders.status<>'closed' AND NOT EXISTS (SELECT 1 FROM daily_closings WHERE business_date=orders.business_date)) AS editable,
      users.display_name AS "memberName", users.username AS "memberUsername",
      COALESCE(items.item_count,0)::integer AS "itemCount", COALESCE(items.total_quantity,0)::integer AS "totalQuantity"
    FROM orders JOIN users ON users.id=orders.user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS item_count, COALESCE(SUM(quantity),0) AS total_quantity
      FROM order_items WHERE order_id=orders.id
    ) items ON TRUE
    ${where}
    ORDER BY orders.created_at DESC, orders.id DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `, listValues);
  res.json({ items:rows, total, page, pageSize, totalPages:Math.max(1, Math.ceil(total / pageSize)) });
}

app.get('/api/orders', requireAuth, async (req, res) => listOrders(req, res));

app.get('/api/orders/history', requireAuth, async (req, res) => {
  const range = validateOrderDateRange(req.query.start_date, req.query.end_date);
  if (range.error) return res.status(400).json({ error:range.error });
  return listOrders(req, res, range);
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error:'查無訂單' });
  const values = [id];
  const scope = orderScope(req, values);
  const { rows } = await pool.query(`
    SELECT orders.id, orders.order_number AS "orderNumber", orders.business_date::text AS "businessDate",
      orders.status, orders.created_at AS "createdAt", users.display_name AS "memberName",
      users.username AS "memberUsername", users.customer_code AS "customerCode", users.phone, users.tax_id AS "taxId",
      (orders.status<>'closed' AND NOT EXISTS (SELECT 1 FROM daily_closings WHERE business_date=orders.business_date)) AS editable
    FROM orders JOIN users ON users.id=orders.user_id WHERE orders.id=$1 AND ${scope}
  `, values);
  const order = rows[0];
  if (!order) return res.status(404).json({ error:'查無訂單，或您沒有權限查看此訂單' });
  order.items = (await pool.query(`
    SELECT id, barcode_snapshot AS barcode, product_name_snapshot AS name,
      specification_snapshot AS specification, quantity, legacy_quantity AS "originalQuantity", note
    FROM order_items WHERE order_id=$1 ORDER BY id
  `, [order.id])).rows;
  res.json(order);
});

async function lockEditableOrder(client, req, orderId) {
  const order = (await client.query(`
    SELECT orders.id, orders.user_id AS "userId", orders.status,
      NOT EXISTS (SELECT 1 FROM daily_closings WHERE business_date=orders.business_date) AS editable
    FROM orders WHERE orders.id=$1 FOR UPDATE
  `, [orderId])).rows[0];
  if (!order || (req.user.role !== 'admin' && Number(order.userId) !== Number(req.user.id))) {
    throw Object.assign(new Error('查無訂單，或您沒有權限修改此訂單'), { statusCode:404 });
  }
  if (order.status === 'closed' || !order.editable) {
    throw Object.assign(new Error('此訂單已結單，無法修改'), { statusCode:409 });
  }
  return order;
}

app.put('/api/orders/:id/items/:itemId', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const quantity = Number(req.body.quantity);
  const note = String(req.body.note || '').slice(0, 500);
  if (!Number.isInteger(orderId) || orderId < 1 || !Number.isInteger(itemId) || itemId < 1) return res.status(404).json({ error:'查無訂單品項' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) return res.status(400).json({ error:'商品數量須為 1 至 9999 的整數' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockEditableOrder(client, req, orderId);
    const { rows } = await client.query(`
      UPDATE order_items SET quantity=$1, note=$2 WHERE id=$3 AND order_id=$4
      RETURNING id, quantity, note
    `, [quantity, note, itemId, orderId]);
    if (!rows[0]) throw Object.assign(new Error('查無訂單品項'), { statusCode:404 });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ error:error.statusCode ? error.message : '修改訂單品項失敗' });
  } finally { client.release(); }
});

app.delete('/api/orders/:id/items/:itemId', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(orderId) || orderId < 1 || !Number.isInteger(itemId) || itemId < 1) return res.status(404).json({ error:'查無訂單品項' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockEditableOrder(client, req, orderId);
    const deleted = await client.query('DELETE FROM order_items WHERE id=$1 AND order_id=$2', [itemId, orderId]);
    if (!deleted.rowCount) throw Object.assign(new Error('查無訂單品項'), { statusCode:404 });
    const remaining = Number((await client.query('SELECT COUNT(*) AS count FROM order_items WHERE order_id=$1', [orderId])).rows[0].count);
    if (!remaining) await client.query('DELETE FROM orders WHERE id=$1', [orderId]);
    await client.query('COMMIT');
    res.json({ deleted:1, orderDeleted:remaining === 0, remaining });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ error:error.statusCode ? error.message : '刪除訂單品項失敗' });
  } finally { client.release(); }
});

app.delete('/api/orders/:id', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(404).json({ error:'查無訂單' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockEditableOrder(client, req, orderId);
    await client.query('DELETE FROM orders WHERE id=$1', [orderId]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ error:error.statusCode ? error.message : '刪除訂單失敗' });
  } finally { client.release(); }
});

app.get('/api/admin/orders/summary', requireAuth, requireAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE business_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date)::integer AS "todayTotal",
      COUNT(*) FILTER (WHERE status='closed')::integer AS closed,
      COUNT(*) FILTER (WHERE status<>'closed')::integer AS pending,
      MAX(business_date)::text AS "latestBusinessDate"
    FROM orders
  `);
  res.json(rows[0]);
});

app.get('/api/admin/orders', requireAuth, requireAdmin, async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 200);
  const queryField = ['order', 'vendor'].includes(String(req.query.queryField || '')) ? String(req.query.queryField) : 'all';
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const status = ['created', 'closed'].includes(String(req.query.status || '')) ? String(req.query.status) : '';
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(50, Math.max(10, Number.parseInt(req.query.pageSize, 10) || 50));
  const values = [];
  const conditions = [];
  const add = (value) => { values.push(value); return `$${values.length}`; };
  if (from || to) {
    const range = validateOrderDateRange(from, to);
    if (range.error) return res.status(400).json({ error:range.error });
    conditions.push(`orders.business_date >= ${add(range.startDate)}::date`);
    conditions.push(`orders.business_date < (${add(range.endDate)}::date + INTERVAL '1 day')`);
  } else {
    conditions.push(`orders.business_date >= date_trunc('month', NOW())::date`);
    conditions.push(`orders.business_date < (date_trunc('month', NOW()) + INTERVAL '1 month')::date`);
  }
  if (status) conditions.push(`orders.status = ${add(status)}`);
  if (query) {
    const placeholder = add(`%${query}%`);
    if (queryField === 'order') conditions.push(`orders.order_number ILIKE ${placeholder}`);
    else if (queryField === 'vendor') conditions.push(`(users.display_name ILIKE ${placeholder} OR users.username ILIKE ${placeholder} OR COALESCE(users.customer_code,'') ILIKE ${placeholder})`);
    else conditions.push(`(orders.order_number ILIKE ${placeholder} OR users.display_name ILIKE ${placeholder} OR users.username ILIKE ${placeholder} OR COALESCE(users.customer_code,'') ILIKE ${placeholder})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = Number((await pool.query(`SELECT COUNT(*) AS count FROM orders JOIN users ON users.id=orders.user_id ${where}`, values)).rows[0].count);
  const offset = (page - 1) * pageSize;
  const listValues = [...values, pageSize, offset];
  const { rows } = await pool.query(`
    SELECT orders.id, orders.order_number AS "orderNumber", orders.business_date::text AS "businessDate",
      orders.created_at AS "createdAt", orders.status, users.display_name AS "memberName",
      users.username AS "memberUsername", COALESCE(items.item_count,0)::integer AS "itemCount",
      COALESCE(items.total_quantity,0)::integer AS "totalQuantity",
      (orders.status<>'closed' AND NOT EXISTS (SELECT 1 FROM daily_closings WHERE business_date=orders.business_date)) AS editable
    FROM orders JOIN users ON users.id=orders.user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS item_count, COALESCE(SUM(quantity),0) AS total_quantity
      FROM order_items WHERE order_id=orders.id
    ) items ON TRUE
    ${where}
    ORDER BY orders.created_at DESC, orders.id DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `, listValues);
  res.json({ items:rows, total, page, pageSize, totalPages:Math.max(1, Math.ceil(total / pageSize)) });
});

app.get('/api/admin/orders/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error:'查無訂單' });
  const { rows } = await pool.query(`
    SELECT orders.id, orders.order_number AS "orderNumber", orders.business_date::text AS "businessDate",
      orders.created_at AS "createdAt", orders.status, users.display_name AS "memberName",
      users.username AS "memberUsername", users.customer_code AS "customerCode", users.phone, users.tax_id AS "taxId",
      (orders.status<>'closed' AND NOT EXISTS (SELECT 1 FROM daily_closings WHERE business_date=orders.business_date)) AS editable
    FROM orders JOIN users ON users.id=orders.user_id WHERE orders.id=$1
  `, [id]);
  const order = rows[0];
  if (!order) return res.status(404).json({ error:'查無訂單' });
  order.items = (await pool.query(`
    SELECT id, barcode_snapshot AS barcode, product_name_snapshot AS name,
      specification_snapshot AS specification, quantity, legacy_quantity AS "originalQuantity", note
    FROM order_items WHERE order_id=$1 ORDER BY id
  `, [id])).rows;
  res.json(order);
});

app.delete('/api/admin/orders/:id/items', requireAuth, requireAdmin, async (req, res) => {
  const orderId = Number(req.params.id);
  const itemIds = [...new Set((Array.isArray(req.body.itemIds) ? req.body.itemIds : []).map(Number).filter((id) => Number.isInteger(id) && id > 0))].slice(0, 500);
  if (!Number.isInteger(orderId) || orderId < 1 || !itemIds.length) return res.status(400).json({ error:'請選擇要刪除的品項' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const order = (await client.query(`
      SELECT orders.id, orders.status,
        NOT EXISTS (SELECT 1 FROM daily_closings WHERE business_date=orders.business_date) AS editable
      FROM orders WHERE orders.id=$1 FOR UPDATE
    `, [orderId])).rows[0];
    if (!order) throw Object.assign(new Error('查無訂單'), { statusCode:404 });
    if (order.status === 'closed' || !order.editable) throw Object.assign(new Error('此訂單已結單，無法刪除品項'), { statusCode:409 });
    const deleted = await client.query('DELETE FROM order_items WHERE order_id=$1 AND id=ANY($2::bigint[])', [orderId, itemIds]);
    if (!deleted.rowCount) throw Object.assign(new Error('找不到所選品項'), { statusCode:404 });
    const remaining = Number((await client.query('SELECT COUNT(*) AS count FROM order_items WHERE order_id=$1', [orderId])).rows[0].count);
    if (!remaining) await client.query('DELETE FROM orders WHERE id=$1', [orderId]);
    await client.query('COMMIT');
    res.json({ deleted:deleted.rowCount, orderDeleted:remaining === 0, remaining });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(error.statusCode || 500).json({ error:error.statusCode ? error.message : '刪除訂單品項失敗' });
  } finally { client.release(); }
});

app.get('/api/admin/orders/:id/export', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT orders.business_date::text AS "businessDate", orders.order_number AS "orderNumber",
      to_char(orders.created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
      users.display_name AS "memberName", order_items.barcode_snapshot AS barcode,
      order_items.product_name_snapshot AS "productName", order_items.specification_snapshot AS specification,
      order_items.quantity, order_items.legacy_quantity AS "originalQuantity", order_items.note, orders.status
    FROM orders JOIN users ON users.id=orders.user_id
    JOIN order_items ON order_items.order_id=orders.id
    WHERE orders.id=$1 ORDER BY order_items.id
  `, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error:'查無訂單明細' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="order-${rows[0].orderNumber}.csv"`);
  res.send(buildOrdersCsv(rows));
});

async function exportRows(client, businessDate) {
  return (await client.query(`
    SELECT orders.business_date::text AS "businessDate", orders.order_number AS "orderNumber",
      to_char(orders.created_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
      users.display_name AS "memberName", order_items.barcode_snapshot AS barcode,
      order_items.product_name_snapshot AS "productName", order_items.specification_snapshot AS specification,
      order_items.quantity, order_items.legacy_quantity AS "originalQuantity", order_items.note, orders.status
    FROM orders JOIN users ON users.id=orders.user_id
    JOIN order_items ON order_items.order_id=orders.id
    WHERE orders.business_date=$1::date ORDER BY orders.id, order_items.id
  `, [businessDate])).rows;
}

async function createExport(client, businessDate, exportType, userId = null) {
  const rows = await exportRows(client, businessDate);
  const totals = (await client.query(`
    SELECT COUNT(DISTINCT orders.id)::integer AS "orderCount", COUNT(order_items.id)::integer AS "itemCount",
      COALESCE(SUM(order_items.quantity),0)::integer AS "totalQuantity"
    FROM orders LEFT JOIN order_items ON order_items.order_id=orders.id WHERE orders.business_date=$1::date
  `, [businessDate])).rows[0];
  const result = await client.query(`
    INSERT INTO order_exports (business_date, export_type, exported_by, order_count, item_count, total_quantity, csv_content)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING id, business_date::text AS "businessDate", export_type AS "exportType", exported_at AS "exportedAt",
      order_count AS "orderCount", item_count AS "itemCount", total_quantity AS "totalQuantity"
  `, [businessDate, exportType, userId, totals.orderCount, totals.itemCount, totals.totalQuantity, buildOrdersCsv(rows)]);
  return result.rows[0];
}

async function closeBusinessDate(businessDate, triggerType = 'automatic', userId = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`order-close:${businessDate}`]);
    const existing = (await client.query(`
      SELECT daily_closings.business_date::text AS "businessDate", daily_closings.closed_at AS "closedAt",
        daily_closings.trigger_type AS "triggerType", order_exports.id AS "exportId",
        order_exports.order_count AS "orderCount", order_exports.item_count AS "itemCount",
        order_exports.total_quantity AS "totalQuantity"
      FROM daily_closings JOIN order_exports ON order_exports.id=daily_closings.export_id
      WHERE daily_closings.business_date=$1::date
    `, [businessDate])).rows[0];
    if (existing) { await client.query('COMMIT'); return existing; }
    await client.query("UPDATE orders SET status='closed' WHERE business_date=$1::date", [businessDate]);
    const exported = await createExport(client, businessDate, triggerType, userId);
    const closing = (await client.query(`
      INSERT INTO daily_closings (business_date, trigger_type, closed_by, export_id) VALUES ($1,$2,$3,$4)
      RETURNING business_date::text AS "businessDate", closed_at AS "closedAt", trigger_type AS "triggerType"
    `, [businessDate, triggerType, userId, exported.id])).rows[0];
    await client.query(`UPDATE schedule_settings SET last_closed_date=GREATEST(COALESCE(last_closed_date,$1::date),$1::date) WHERE id=1`, [businessDate]);
    await client.query('COMMIT');
    return { ...closing, exportId:exported.id, orderCount:exported.orderCount, itemCount:exported.itemCount, totalQuantity:exported.totalQuantity };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function runSchedule() {
  const setting = (await pool.query('SELECT enabled, close_time AS "closeTime" FROM schedule_settings WHERE id=1')).rows[0];
  if (!setting?.enabled) return;
  const now = getBusinessClock();
  if (now.time < setting.closeTime) return;
  const targetDate = shiftDate(now.date, -1);
  const dates = (await pool.query(`
    SELECT business_date::text AS date FROM orders
    WHERE business_date < $1::date AND NOT EXISTS (SELECT 1 FROM daily_closings WHERE daily_closings.business_date=orders.business_date)
      AND status <> 'closed'
    GROUP BY business_date ORDER BY business_date
  `, [now.date])).rows.map((row) => row.date);
  if (!dates.includes(targetDate)) dates.push(targetDate);
  for (const date of dates.sort()) await closeBusinessDate(date);
}

app.get('/api/schedule', requireAuth, requireAdmin, async (_req, res) => {
  const setting = (await pool.query(`SELECT enabled, close_time AS "closeTime", timezone, last_closed_date::text AS "lastClosedDate", updated_at AS "updatedAt" FROM schedule_settings WHERE id=1`)).rows[0];
  const { rows } = await pool.query(`
    SELECT order_exports.id, order_exports.business_date::text AS "businessDate", order_exports.export_type AS "exportType",
      order_exports.exported_at AS "exportedAt", order_exports.order_count AS "orderCount",
      order_exports.item_count AS "itemCount", order_exports.total_quantity AS "totalQuantity",
      (daily_closings.business_date IS NOT NULL) AS "closed"
    FROM order_exports LEFT JOIN daily_closings ON daily_closings.export_id=order_exports.id
    ORDER BY order_exports.id DESC LIMIT 30
  `);
  res.json({ setting, exports:rows, today:getBusinessClock().date });
});

app.put('/api/schedule', requireAuth, requireAdmin, async (req, res) => {
  const enabled = Boolean(req.body.enabled);
  const closeTime = String(req.body.closeTime || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime)) return res.status(400).json({ error:'排程時間格式不正確' });
  const { rows } = await pool.query(`UPDATE schedule_settings SET enabled=$1, close_time=$2, timezone=$3, updated_at=NOW(), updated_by=$4 WHERE id=1 RETURNING enabled, close_time AS "closeTime", timezone, updated_at AS "updatedAt"`, [enabled, closeTime, BUSINESS_TIME_ZONE, req.user.id]);
  res.json(rows[0]);
});

app.post('/api/schedule/export', requireAuth, requireAdmin, async (req, res) => {
  const businessDate = String(req.body.businessDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return res.status(400).json({ error:'請選擇匯出日期' });
  const client = await pool.connect();
  try { res.status(201).json(await createExport(client, businessDate, 'manual', req.user.id)); }
  finally { client.release(); }
});

app.post('/api/schedule/close', requireAuth, requireAdmin, async (req, res) => {
  const businessDate = String(req.body.businessDate || '');
  const today = getBusinessClock().date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || businessDate > today) return res.status(400).json({ error:'結單日期不正確' });
  res.status(201).json(await closeBusinessDate(businessDate, 'manual', req.user.id));
});

app.get('/api/exports/:id/download', requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT business_date::text AS "businessDate", csv_content AS content FROM order_exports WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error:'查無匯出紀錄' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${rows[0].businessDate}.csv"`);
  res.send(rows[0].content);
});

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok:true, database:'postgresql' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error:'伺服器發生錯誤' });
});

initializeDatabase().then(() => {
  app.listen(port, '0.0.0.0', () => console.log(`訂單系統已啟動：http://localhost:${port}`));
  runSchedule().catch((error) => console.error('排程初始檢查失敗', error));
  setInterval(() => runSchedule().catch((error) => console.error('排程執行失敗', error)), 30000).unref();
}).catch((error) => {
  console.error('資料庫初始化失敗', error);
  process.exit(1);
});
