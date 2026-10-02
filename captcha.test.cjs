const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCaptchaAnswer, hashCaptcha, captchaMatches, buildCaptchaSvg, captchaDataUrl } = require('./captcha');

test('creates a five-digit captcha including leading zeroes', () => {
  assert.equal(createCaptchaAnswer(() => 42), '00042');
  assert.equal(createCaptchaAnswer(() => 99999), '99999');
});

test('captcha hash is bound to challenge id, answer and secret', () => {
  const hash = hashCaptcha('challenge-1', '12345', 'secret');
  assert.equal(captchaMatches(hash, 'challenge-1', '12345', 'secret'), true);
  assert.equal(captchaMatches(hash, 'challenge-1', '12346', 'secret'), false);
  assert.equal(captchaMatches(hash, 'challenge-2', '12345', 'secret'), false);
});

test('renders a self-contained SVG data URL without external services', () => {
  const svg = buildCaptchaSvg('12345', (min) => min);
  assert.match(svg, /<svg/);
  assert.match(svg, />1<\/text>/);
  assert.match(captchaDataUrl(svg), /^data:image\/svg\+xml;base64,/);
});
