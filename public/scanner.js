// USB-HID scanners type into this dedicated field, just like a keyboard.
// Never intercept quantity, notes, passwords, or input in another page.
function attachScanner({ input, active, invalidate, lookup, success, failure, delay = 300 }) {
  let timer;
  let revision = 0;
  let lastValue = null;
  let composing = false;
  function cancel() {
    clearTimeout(timer);
    revision += 1;
    lastValue = null;
  }
  async function receive() {
    clearTimeout(timer);
    if (!active() || composing) return;
    const barcode = input.value.trim();
    if (!barcode || barcode === lastValue) return;
    lastValue = barcode;
    const request = ++revision;
    invalidate();
    try {
      const product = await lookup(barcode);
      if (request !== revision || !active()) return;
      success(product);
    } catch (error) {
      if (request !== revision || !active()) return;
      failure(error);
    }
    // Keep scan focus for the next item, but never steal focus from edits.
    if (document.activeElement === input) input.select();
  }
  input.addEventListener('input', () => {
    cancel();
    invalidate();
    if (!composing && active()) timer = setTimeout(receive, delay);
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || composing || !active()) return;
    if (event.key === 'Enter' || (event.key === 'Tab' && input.value.trim())) {
      event.preventDefault();
      receive();
    }
  });
  input.addEventListener('compositionstart', () => { composing = true; cancel(); invalidate(); });
  input.addEventListener('compositionend', () => {
    composing = false;
    cancel();
    if (active()) timer = setTimeout(receive, delay);
  });
  return { cancel, receive, focus() { if (active()) { input.focus(); input.select(); } } };
}
