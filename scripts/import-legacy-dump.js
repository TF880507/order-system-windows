'use strict';

const path = require('path');
const bcrypt = require('bcryptjs');
const { migrateLegacyPasswords } = require('./legacy-passwords');
const { Pool } = require('pg');
const { parseLegacyDump } = require('./legacy-dump-parser');

const definitions = {
  administrator:{ table:'legacy_stage_administrators', columns:['id','account','password'] },
  customer:{ table:'legacy_stage_customers', columns:['id','customer_code','account','password','name','phone','tax_id','suspended'] },
  detail:{ table:'legacy_stage_details', columns:['id','order_id','product_id','ordered_date','hour','minute','second','customer_id','quantity','note'] },
  goods:{ table:'legacy_stage_goods', columns:['id','barcode','name','unit'] },
  order:{ table:'legacy_stage_orders', columns:['id','ordered_date','hour','minute','second','customer_id','status'] },
  roots:{ table:'legacy_stage_roots', columns:['account','password'] },
  timer:{ table:'legacy_stage_timer', columns:['id','hour','minute','second','status'] }
};

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    result[key] = argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function stageSchema() {
  const tables = Object.values(definitions).map(({ table, columns }) =>
    `CREATE UNLOGGED TABLE IF NOT EXISTS ${table} (${columns.map((column) => `${column} TEXT`).join(', ')})`
  );
  return `${tables.join(';')};\n${Object.values(definitions).map(({ table }) => `TRUNCATE ${table}`).join(';')};`;
}

async function flush(pool, definition, rows) {
  if (!rows.length) return;
  const record = definition.columns.map((column) => `${column} TEXT`).join(', ');
  const columns = definition.columns.join(', ');
  await pool.query(`INSERT INTO ${definition.table} (${columns}) SELECT ${columns} FROM jsonb_to_recordset($1::jsonb) AS value(${record})`, [JSON.stringify(rows)]);
  rows.length = 0;
}

async function stageDump(pool, dumpPath) {
  await pool.query(stageSchema());
  const counts = Object.fromEntries(Object.keys(definitions).map((table) => [table, 0]));
  const batches = Object.fromEntries(Object.keys(definitions).map((table) => [table, []]));
  for await (const { table, row } of parseLegacyDump(dumpPath, new Set(Object.keys(definitions)))) {
    const definition = definitions[table];
    const value = Object.fromEntries(definition.columns.map((column, index) => [column, row[index]]));
    batches[table].push(value);
    counts[table] += 1;
    if (batches[table].length >= 5000) await flush(pool, definition, batches[table]);
    if (table === 'detail' && counts.detail % 500000 === 0) console.log(`已暫存 ${counts.detail.toLocaleString()} 筆訂單明細`);
  }
  for (const table of Object.keys(definitions)) await flush(pool, definitions[table], batches[table]);
  return counts;
}

async function stagedCounts(pool) {
  const result = {};
  for (const [name, definition] of Object.entries(definitions)) {
    result[name] = Number((await pool.query(`SELECT COUNT(*) AS count FROM ${definition.table}`)).rows[0].count);
  }
  return result;
}

const quantitySql = `CASE
  WHEN btrim(d.quantity) ~ '^[0-9]+$' AND btrim(d.quantity)::numeric BETWEEN 1 AND 999999 THEN btrim(d.quantity)::integer
  WHEN upper(btrim(d.quantity)) ~ '^[0-9]+O$' THEN replace(upper(btrim(d.quantity)), 'O', '0')::integer
  WHEN substring(translate(d.quantity, '０１２３４５６７８９', '0123456789') from '[0-9]+') IS NOT NULL
    THEN GREATEST(1::numeric, LEAST(999999::numeric, substring(translate(d.quantity, '０１２３４５６７８９', '0123456789') from '[0-9]+')::numeric))::integer
  ELSE 1 END`;

async function transform(pool, dumpPath, memberPasswordHash, counts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL synchronous_commit=off');
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_customer_id BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_code TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS tax_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS legacy_password TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN NOT NULL DEFAULT FALSE;
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_legacy_customer_id ON users(legacy_customer_id) WHERE legacy_customer_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_legacy_order_id ON orders(legacy_order_id) WHERE legacy_order_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_legacy_detail_id ON order_items(legacy_detail_id) WHERE legacy_detail_id IS NOT NULL;
    `);

    await client.query(`
      INSERT INTO users (username, password_hash, display_name, role, active, legacy_customer_id, customer_code, phone, tax_id, legacy_password, password_reset_required)
      SELECT account, $1, COALESCE(NULLIF(name,''), account), 'member', suspended <> '1', id::bigint,
             customer_code, phone, tax_id, password, TRUE
      FROM legacy_stage_customers
      ON CONFLICT (username) DO UPDATE SET
        display_name=EXCLUDED.display_name, active=EXCLUDED.active, legacy_customer_id=EXCLUDED.legacy_customer_id,
        customer_code=EXCLUDED.customer_code, phone=EXCLUDED.phone, tax_id=EXCLUDED.tax_id,
        legacy_password=EXCLUDED.legacy_password, password_hash=EXCLUDED.password_hash,
        password_reset_required=TRUE
    `, [memberPasswordHash]);

    const legacyPasswordResult = await migrateLegacyPasswords(client, (await client.query(`
      SELECT account AS username, password
      FROM legacy_stage_customers
      WHERE NULLIF(account,'') IS NOT NULL
      ORDER BY id::bigint
    `)).rows);

    await client.query(`
      INSERT INTO users (username, password_hash, display_name, role, active, legacy_password, password_reset_required)
      SELECT DISTINCT ON (account) account, $1, account, 'admin', TRUE, password, TRUE
      FROM (
        SELECT id::bigint AS source_order, account, password FROM legacy_stage_administrators
        UNION ALL
        SELECT 1000000000::bigint AS source_order, account, password FROM legacy_stage_roots
      ) legacy_admins
      WHERE NULLIF(btrim(account),'') IS NOT NULL
      ORDER BY account, source_order
      ON CONFLICT (username) DO UPDATE SET
        role='admin', active=TRUE, legacy_password=EXCLUDED.legacy_password
    `, [memberPasswordHash]);

    await client.query(`
      INSERT INTO users (username, password_hash, display_name, role, active, legacy_customer_id, password_reset_required)
      SELECT 'legacy-user-' || source.customer_id, $1, '舊會員 #' || source.customer_id, 'member', FALSE, source.customer_id::bigint, TRUE
      FROM (
        SELECT DISTINCT customer_id FROM legacy_stage_details
        UNION SELECT DISTINCT customer_id FROM legacy_stage_orders
      ) source
      WHERE source.customer_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM users WHERE legacy_customer_id=source.customer_id::bigint
      )
      ON CONFLICT (username) DO NOTHING
    `, [memberPasswordHash]);

    await client.query(`
      INSERT INTO products (barcode, name, specification, active)
      SELECT DISTINCT ON (btrim(barcode)) btrim(barcode), COALESCE(NULLIF(name,''), '未命名商品'), COALESCE(unit,''), TRUE
      FROM legacy_stage_goods WHERE NULLIF(btrim(barcode),'') IS NOT NULL ORDER BY btrim(barcode), id::bigint DESC
      ON CONFLICT (barcode) DO UPDATE SET name=EXCLUDED.name, specification=EXCLUDED.specification, active=TRUE;

      INSERT INTO legacy_product_links (legacy_product_id, product_id)
      SELECT goods.id::bigint, products.id FROM legacy_stage_goods goods JOIN products ON products.barcode=btrim(goods.barcode)
      ON CONFLICT (legacy_product_id) DO UPDATE SET product_id=EXCLUDED.product_id;

      INSERT INTO products (barcode, name, specification, active)
      SELECT 'LEGACY-MISSING-' || source.product_id, '舊商品 #' || source.product_id || '（原商品主檔已刪除）', '', FALSE
      FROM (SELECT DISTINCT product_id FROM legacy_stage_details) source
      WHERE source.product_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM legacy_product_links WHERE legacy_product_id=source.product_id::bigint
      ) ON CONFLICT (barcode) DO NOTHING;

      INSERT INTO legacy_product_links (legacy_product_id, product_id)
      SELECT source.product_id::bigint, products.id
      FROM (SELECT DISTINCT product_id FROM legacy_stage_details) source
      JOIN products ON products.barcode='LEGACY-MISSING-' || source.product_id
      ON CONFLICT (legacy_product_id) DO UPDATE SET product_id=EXCLUDED.product_id;
    `);

    await client.query(`
      INSERT INTO orders (order_number, user_id, status, created_at, business_date, legacy_order_id)
      SELECT 'LEGACY-' || source.id, users.id, CASE WHEN source.status='1' THEN 'closed' ELSE 'created' END,
        ((source.ordered_date || ' ' || lpad(source.hour,2,'0') || ':' || lpad(source.minute,2,'0') || ':' || lpad(source.second,2,'0'))::timestamp AT TIME ZONE 'Asia/Taipei'),
        source.ordered_date::date, source.id::bigint
      FROM legacy_stage_orders source JOIN users ON users.legacy_customer_id=source.customer_id::bigint
      ON CONFLICT (order_number) DO UPDATE SET user_id=EXCLUDED.user_id, status=EXCLUDED.status,
        created_at=EXCLUDED.created_at, business_date=EXCLUDED.business_date, legacy_order_id=EXCLUDED.legacy_order_id;

      INSERT INTO orders (order_number, user_id, status, created_at, business_date, legacy_order_id)
      SELECT 'LEGACY-' || source.order_id, users.id, 'closed',
        ((source.ordered_date || ' ' || lpad(source.hour,2,'0') || ':' || lpad(source.minute,2,'0') || ':' || lpad(source.second,2,'0'))::timestamp AT TIME ZONE 'Asia/Taipei'),
        source.ordered_date::date, source.order_id::bigint
      FROM (
        SELECT DISTINCT ON (order_id) order_id, customer_id, ordered_date, hour, minute, second
        FROM legacy_stage_details WHERE order_id IS NOT NULL ORDER BY order_id, id::bigint
      ) source JOIN users ON users.legacy_customer_id=source.customer_id::bigint
      WHERE NOT EXISTS (SELECT 1 FROM orders WHERE legacy_order_id=source.order_id::bigint)
      ON CONFLICT (order_number) DO NOTHING;
    `);

    console.log('正在寫入訂單明細，資料量較大，請勿關閉視窗…');
    await client.query(`
      INSERT INTO order_items (order_id, product_id, barcode_snapshot, product_name_snapshot,
        specification_snapshot, quantity, legacy_quantity, note, legacy_detail_id)
      SELECT orders.id, products.id, products.barcode, products.name, products.specification,
        ${quantitySql}, d.quantity, COALESCE(d.note,''), d.id::bigint
      FROM legacy_stage_details d
      JOIN orders ON orders.legacy_order_id=d.order_id::bigint
      JOIN legacy_product_links links ON links.legacy_product_id=d.product_id::bigint
      JOIN products ON products.id=links.product_id
      ON CONFLICT (legacy_detail_id) WHERE legacy_detail_id IS NOT NULL DO UPDATE SET
        order_id=EXCLUDED.order_id, product_id=EXCLUDED.product_id, barcode_snapshot=EXCLUDED.barcode_snapshot,
        product_name_snapshot=EXCLUDED.product_name_snapshot, specification_snapshot=EXCLUDED.specification_snapshot,
        quantity=EXCLUDED.quantity, legacy_quantity=EXCLUDED.legacy_quantity, note=EXCLUDED.note;
    `);

    // If the web service created an empty automatic closing while the import was still running,
    // remove that empty record so the scheduler can close and export the newly imported orders.
    await client.query(`
      WITH removed AS (
        DELETE FROM daily_closings closing
        USING order_exports exported
        WHERE closing.export_id=exported.id AND exported.export_type='automatic' AND exported.order_count=0
          AND EXISTS (
            SELECT 1 FROM orders WHERE orders.business_date=closing.business_date
              AND orders.legacy_order_id IS NOT NULL AND orders.status <> 'closed'
          )
        RETURNING closing.export_id
      )
      DELETE FROM order_exports exported USING removed WHERE exported.id=removed.export_id
    `);

    const timer = (await client.query('SELECT hour, minute, second FROM legacy_stage_timer ORDER BY id::bigint LIMIT 1')).rows[0];
    if (timer) {
      const hour = String(Number(timer.hour) % 24).padStart(2, '0');
      const minute = String(Number(timer.minute) || 0).padStart(2, '0');
      await client.query(`UPDATE schedule_settings SET enabled=TRUE, close_time=$1, timezone='Asia/Taipei',
        last_closed_date=(SELECT MAX(business_date) FROM orders WHERE status='closed'), updated_at=NOW() WHERE id=1`, [`${hour}:${minute}`]);
    }

    const statistics = (await client.query(`SELECT
      (SELECT COUNT(*)::integer FROM users WHERE legacy_customer_id IS NOT NULL) AS customers,
      (SELECT COUNT(*)::integer FROM users WHERE role='admin' AND active) AS administrators,
      (SELECT COUNT(*)::integer FROM legacy_product_links) AS product_links,
      (SELECT COUNT(*)::integer FROM orders WHERE legacy_order_id IS NOT NULL) AS orders,
      (SELECT COUNT(*)::integer FROM order_items WHERE legacy_detail_id IS NOT NULL) AS details,
      (SELECT COUNT(*)::integer FROM products WHERE barcode LIKE 'LEGACY-MISSING-%') AS placeholder_products,
      (SELECT COUNT(*)::integer FROM users WHERE username LIKE 'legacy-user-%') AS placeholder_customers
    `)).rows[0];
    statistics.passwords = legacyPasswordResult;
    await client.query('INSERT INTO legacy_import_runs (source_file, statistics) VALUES ($1,$2::jsonb)', [dumpPath, JSON.stringify({ staged:counts, imported:statistics })]);
    await client.query('COMMIT');
    return statistics;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const value = options(process.argv.slice(2));
  if (!value.dump) throw new Error('缺少 --dump <Dump.sql>');
  const dumpPath = path.resolve(value.dump);
  const databaseUrl = value['database-url'] || process.env.DATABASE_URL;
  const memberPassword = value['member-password'] || process.env.LEGACY_MEMBER_PASSWORD;
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL 或 --database-url');
  if (!memberPassword || memberPassword.length < 8) throw new Error('LEGACY_MEMBER_PASSWORD 或 --member-password 至少需要 8 個字元');

  const pool = new Pool({ connectionString:databaseUrl, max:4 });
  try {
    await pool.query('SELECT 1 FROM users LIMIT 1');
    console.log(value['use-staging'] ? '沿用已完成的暫存資料' : `開始解析 ${dumpPath}`);
    const counts = value['use-staging'] ? await stagedCounts(pool) : await stageDump(pool, dumpPath);
    console.log('SQL dump 暫存完成：', counts);
    const memberPasswordHash = await bcrypt.hash(memberPassword, 12);
    const statistics = await transform(pool, dumpPath, memberPasswordHash, counts);
    if (!value['keep-staging']) {
      await pool.query(Object.values(definitions).map(({ table }) => `DROP TABLE IF EXISTS ${table}`).join(';'));
    }
    console.log('舊資料匯入完成：', statistics);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('匯入失敗：', error);
  process.exitCode = 1;
});
