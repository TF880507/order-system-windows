const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanScannerValue, barcodeCandidates } = require('./barcode-lookup');

test('keeps exact EAN-13, EAN-8, Code 39, Code 128 and ITF-14 values first', () => {
  for (const barcode of ['4710731642320', '12345670', 'ABC-123', 'CODE128-A9', '14710731642327']) {
    assert.equal(barcodeCandidates(barcode)[0], barcode);
  }
});

test('maps UPC-A and its EAN-13 leading-zero representation both ways', () => {
  assert.deepEqual(barcodeCandidates('012345678905').slice(0, 2), ['012345678905', '0012345678905']);
  assert.deepEqual(barcodeCandidates('0012345678905').slice(0, 2), ['0012345678905', '012345678905']);
});

test('extracts GTIN from GS1-128 AI 01 including ZXing symbology prefix', () => {
  assert.deepEqual(barcodeCandidates(']C10104710731642320').slice(0, 4), [
    ']C10104710731642320', '0104710731642320', '04710731642320', '4710731642320'
  ]);
  const candidates = barcodeCandidates('(01)04710731642320\u001d10LOT1');
  assert.ok(candidates.includes('04710731642320'));
  assert.ok(candidates.includes('4710731642320'));
});

test('removes Android and hardware scanner framing controls', () => {
  assert.equal(cleanScannerValue('\u00024710731642320\u0003\r\n'), '4710731642320');
  assert.equal(cleanScannerValue('\u200E4719585678958\u200F'), '4719585678958');
  const candidates = barcodeCandidates('\u00024711246121607\u0003');
  assert.equal(candidates[0], '4711246121607');
  assert.ok(candidates.includes('\u00024711246121607'));
});
