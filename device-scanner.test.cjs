const test = require('node:test');
const assert = require('node:assert/strict');
const { detectScanEnvironment, describeCameraError } = require('./public/device-scanner');

test('Android App prefers the native scanner bridge', () => {
  const result = detectScanEnvironment({
    userAgent: 'Mozilla/5.0 (Linux; Android 14)',
    hasNativeScanner: true,
    isSecureContext: false,
    hasMediaDevices: false
  });
  assert.equal(result.platform, 'android-app');
  assert.equal(result.canUseCamera, true);
  assert.equal(result.useHardwareInput, false);
});

test('Android and iPhone browsers use the HTTPS web camera', () => {
  for (const userAgent of [
    'Mozilla/5.0 (Linux; Android 14; Mobile) Chrome/140',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1'
  ]) {
    const result = detectScanEnvironment({ userAgent, isSecureContext: true, hasMediaDevices: true });
    assert.equal(result.platform, 'mobile-web');
    assert.equal(result.canUseWebCamera, true);
    assert.equal(result.useHardwareInput, false);
  }
});

test('Windows keeps hardware scanner input and can also use a camera', () => {
  const result = detectScanEnvironment({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140',
    isSecureContext: true,
    hasMediaDevices: true
  });
  assert.equal(result.platform, 'windows');
  assert.equal(result.useHardwareInput, true);
  assert.equal(result.canUseWebCamera, true);
});

test('HTTP browser receives a clear HTTPS instruction', () => {
  const result = detectScanEnvironment({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile)',
    isSecureContext: false,
    hasMediaDevices: true
  });
  assert.equal(result.canUseCamera, false);
  assert.match(result.cameraUnavailableReason, /HTTPS/);
});

test('camera permission errors are translated for users', () => {
  assert.match(describeCameraError({ name: 'NotAllowedError' }), /權限/);
  assert.match(describeCameraError({ name: 'NotFoundError' }), /找不到/);
  assert.match(describeCameraError({ name: 'NotReadableError' }), /其他程式/);
});
