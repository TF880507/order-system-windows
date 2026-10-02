function barcodeCandidates(value) {
  const original = String(value ?? '').trim();
  if (!original) return [];
  const candidates = [];
  const add = (candidate) => {
    const clean = String(candidate || '').trim();
    if (clean && clean.length <= 512 && !candidates.includes(clean)) candidates.push(clean);
  };
  const addNumericVariants = (digits) => {
    if (!/^\d+$/.test(digits)) return;
    add(digits);
    if (digits.length === 12) add(`0${digits}`); // UPC-A can be decoded as EAN-13.
    if (digits.length === 13 && digits.startsWith('0')) add(digits.slice(1));
    if (digits.length === 14 && digits.startsWith('0')) {
      add(digits.slice(1));
      if (digits.startsWith('00')) add(digits.slice(2));
    }
  };

  add(original);
  const withoutSymbology = original.replace(/^\]C1/, '');
  if (withoutSymbology !== original) add(withoutSymbology);
  addNumericVariants(withoutSymbology);

  // GS1-128 product identifiers use AI (01) followed by a 14-digit GTIN.
  const compact = withoutSymbology.replace(/[\s\u001d]/g, '');
  const gs1Match = compact.match(/^(?:\(01\)|01)(\d{14})/);
  if (gs1Match) addNumericVariants(gs1Match[1]);
  return candidates;
}

module.exports = { barcodeCandidates };
