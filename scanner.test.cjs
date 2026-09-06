const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(`${__dirname}/public/scanner.js`, 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
function setup(lookup = async barcode => ({ barcode })) {
  const listeners = {};
  const input = { value: '', select() { this.selected = true; }, focus() {}, addEventListener(type, handler) { listeners[type] = handler; } };
  const document = { activeElement: input };
  const context = vm.createContext({ document, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const results = [], errors = [], requests = [];
  let enabled = true, invalidations = 0;
  const scanner = context.attachScanner({ input, active: () => enabled, delay: 5,
    invalidate: () => invalidations++, lookup: code => { requests.push(code); return lookup(code); },
    success: product => results.push(product.barcode), failure: error => errors.push(error.message) });
  return { input, document, scanner, results, errors, requests, listeners,
    disable: () => { enabled = false; scanner.cancel(); },
    type: value => { input.value = value; listeners.input(); },
    key: key => { const event = { key, preventDefault() { this.prevented = true; } }; listeners.keydown(event); return event; } };
}
test('Enter + LF and idle timer trigger a single lookup, preserving leading zeros', async () => {
  const s = setup(); s.type('0012345'); assert.equal(s.key('Enter').prevented, true); s.key('Enter');
  await tick(); assert.deepEqual(s.requests, ['0012345']); assert.deepEqual(s.results, ['0012345']); assert.equal(s.input.selected, true);
});
test('Tab suffix and scanners without suffix both work', async () => {
  const s = setup(); s.type('ABC-123'); assert.equal(s.key('Tab').prevented, true); await tick();
  s.type('4719585678958'); await tick(); assert.deepEqual(s.results, ['ABC-123', '4719585678958']);
});
test('out-of-order lookup responses cannot replace the latest product', async () => {
  const resolve = {}; const s = setup(code => new Promise(done => { resolve[code] = done; }));
  s.type('old'); s.key('Enter'); s.type('new'); s.key('Enter');
  resolve.new({ barcode: 'new' }); await tick(); resolve.old({ barcode: 'old' }); await tick();
  assert.deepEqual(s.results, ['new']);
});
test('failed lookup recovers on the next scan and does not throw on event.currentTarget', async () => {
  const s = setup(async code => { if (code === 'bad') throw new Error('查無商品'); return { barcode: code }; });
  s.type('bad'); s.key('Enter'); await tick(); s.type('good'); s.key('Enter'); await tick();
  assert.deepEqual(s.errors, ['查無商品']); assert.deepEqual(s.results, ['good']);
});
test('leaving the scan view or clearing cancels pending responses and timers', async () => {
  let resolve; const s = setup(() => new Promise(done => { resolve = done; }));
  s.type('old'); s.key('Enter'); s.disable(); resolve({ barcode: 'old' }); await tick();
  assert.deepEqual(s.results, []); s.type('hidden'); await tick(); assert.deepEqual(s.requests, ['old']);
});
test('lookup completion does not steal focus from quantity or note', async () => {
  const s = setup(); s.type('abc'); s.document.activeElement = {}; s.key('Enter'); await tick();
  assert.equal(s.input.selected, undefined);
});
test('IME composition is not submitted prematurely', async () => {
  const s = setup(); s.listeners.compositionstart(); s.type('471'); s.key('Enter'); await tick();
  assert.deepEqual(s.requests, []); s.listeners.compositionend(); await tick(); assert.deepEqual(s.results, ['471']);
});
