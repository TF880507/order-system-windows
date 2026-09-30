const bcrypt = require('bcryptjs');

async function migrateLegacyPasswords(client, rows, { cost = 12, clearPlaintext = true } = {}) {
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    const password = row.password == null ? '' : String(row.password);
    if (!password) {
      skipped += 1;
      continue;
    }
    const hash = await bcrypt.hash(password, cost);
    if (!await bcrypt.compare(password, hash)) throw new Error(`密碼雜湊驗證失敗：${row.username}`);
    const result = await client.query(`
      UPDATE users SET password_hash=$1, password_reset_required=FALSE
      WHERE username=$2 AND legacy_customer_id IS NOT NULL
    `, [hash, row.username]);
    migrated += result.rowCount;
  }
  if (clearPlaintext) await client.query('UPDATE users SET legacy_password=NULL WHERE legacy_customer_id IS NOT NULL');
  return { migrated, skipped };
}

module.exports = { migrateLegacyPasswords };
