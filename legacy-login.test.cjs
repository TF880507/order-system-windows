const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesLegacyMd5 } = require('./legacy-login');

test('舊管理員 MD5 密碼可核對並拒絕錯誤密碼', () => {
  assert.equal(matchesLegacyMd5('password', '5f4dcc3b5aa765d61d8327deb882cf99'), true);
  assert.equal(matchesLegacyMd5('wrong', '5f4dcc3b5aa765d61d8327deb882cf99'), false);
});

test('非 MD5 舊式加密值不會被誤認成密碼雜湊', () => {
  assert.equal(matchesLegacyMd5('746650', 'XWpTNgk+UjIHYQM3'), false);
});
