const { Pool } = require('pg');
const { migrateLegacyPasswords } = require('./legacy-passwords');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
  const pool = new Pool({ connectionString:databaseUrl, max:1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      SELECT username, legacy_password AS password
      FROM users WHERE legacy_customer_id IS NOT NULL AND legacy_password IS NOT NULL
      ORDER BY id
    `);
    const result = await migrateLegacyPasswords(client, rows);
    await client.query('COMMIT');
    console.log(`舊會員密碼轉換完成：${result.migrated} 位可使用原密碼登入，${result.skipped} 位空白密碼保留臨時密碼。`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('舊會員密碼轉換失敗：', error.message);
  process.exitCode = 1;
});
