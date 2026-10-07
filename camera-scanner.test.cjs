const test = require('node:test');
const assert = require('node:assert/strict');
const { isRoutineDecodeMiss } = require('./public/camera-scanner');

test('ignores ZXing no-code frame errors while the camera keeps scanning', () => {
  assert.equal(isRoutineDecodeMiss({
    getKind: () => 'NotFoundException',
    message: 'No MultiFormat Readers were able to detect the code.'
  }), true);
  assert.equal(isRoutineDecodeMiss({ message: 'No MultiFormat Readers were able to detect the code.' }), true);
  assert.equal(isRoutineDecodeMiss({ name: 'ChecksumException' }), true);
});

test('does not hide real camera failures', () => {
  assert.equal(isRoutineDecodeMiss({ name: 'NotAllowedError', message: 'Permission denied' }), false);
  assert.equal(isRoutineDecodeMiss({ name: 'NotReadableError', message: 'Camera stopped' }), false);
});
