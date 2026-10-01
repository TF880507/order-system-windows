const crypto = require('crypto');

function matchesLegacyMd5(password, storedValue) {
  const stored = String(storedValue || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(stored)) return false;
  const digest = crypto.createHash('md5').update(String(password), 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(stored, 'hex'));
}

module.exports = { matchesLegacyMd5 };
