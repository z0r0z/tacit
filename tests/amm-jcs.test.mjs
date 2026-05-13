// JCS canonicalization + launcher-gate extraction tests.

import { canonicalize, extractLauncherPubkey } from './amm-jcs.mjs';
import { bytesToHex } from '@noble/hashes/utils';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

const dec = (b) => new TextDecoder().decode(b);
const enc = (s) => new TextEncoder().encode(s);

console.log('JCS canonicalization');
test('empty object', () => dec(canonicalize({})) === '{}');
test('empty array', () => dec(canonicalize([])) === '[]');
test('null', () => dec(canonicalize(null)) === 'null');
test('booleans', () => dec(canonicalize(true)) === 'true' && dec(canonicalize(false)) === 'false');
test('integer', () => dec(canonicalize(42)) === '42');
test('zero', () => dec(canonicalize(0)) === '0');
test('negative integer', () => dec(canonicalize(-7)) === '-7');
test('simple string', () => dec(canonicalize('hello')) === '"hello"');
test('string with quotes', () => dec(canonicalize('say "hi"')) === '"say \\"hi\\""');
test('string with backslash', () => dec(canonicalize('a\\b')) === '"a\\\\b"');
test('string with newline', () => dec(canonicalize('line1\nline2')) === '"line1\\nline2"');
test('string with control char', () => dec(canonicalize('\x01')) === '"\\u0001"');

test('object keys sorted', () => {
  const out = dec(canonicalize({ b: 2, a: 1, c: 3 }));
  return out === '{"a":1,"b":2,"c":3}';
});
test('nested objects', () => {
  const out = dec(canonicalize({ outer: { z: 1, a: 2 } }));
  return out === '{"outer":{"a":2,"z":1}}';
});
test('arrays preserve order', () => {
  return dec(canonicalize([3, 1, 2])) === '[3,1,2]';
});
test('no insignificant whitespace', () => {
  const out = dec(canonicalize({ a: 1, b: [1, 2] }));
  return !/\s/.test(out);
});

test('non-integer number throws', () => {
  try { canonicalize(1.5); return false; }
  catch (e) { return /non-integer/.test(e.message); }
});
test('integer > 2^53 throws', () => {
  try { canonicalize(Number.MAX_SAFE_INTEGER + 1); return false; }
  catch (e) { return /2\^53|exceeds/.test(e.message); }
});
test('NaN/Infinity throws', () => {
  try { canonicalize(NaN); return false; }
  catch (e) { return /NaN/.test(e.message); }
});

console.log('\nLauncher-gate extraction');

// Canonical blob WITH a launcher gate set.
const launcherHex = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const blobWithLauncher = canonicalize({
  tacit_amm_launcher: launcherHex,
  tacit_attest: {
    blinding: 'aa'.repeat(32),
    commitment: 'bb'.repeat(33),
    supply: '1000000',
  },
});
test('canonical blob with valid launcher ⇒ extracted', () => {
  const pk = extractLauncherPubkey(blobWithLauncher);
  return pk !== null && bytesToHex(pk) === launcherHex;
});

// Canonical blob WITHOUT a launcher gate.
const blobNoLauncher = canonicalize({
  tacit_attest: {
    blinding: 'aa'.repeat(32),
    commitment: 'bb'.repeat(33),
    supply: '1000000',
  },
});
test('canonical blob without launcher ⇒ null', () => {
  return extractLauncherPubkey(blobNoLauncher) === null;
});

// Non-canonical blob (whitespace) ⇒ rejected (conservative default).
test('blob with whitespace ⇒ rejected (treated as no gate)', () => {
  const noncanonical = enc(`{ "tacit_amm_launcher": "${launcherHex}" }`);
  return extractLauncherPubkey(noncanonical) === null;
});

// Non-canonical blob (wrong key order) ⇒ rejected.
test('blob with wrong key order ⇒ rejected', () => {
  const noncanonical = enc(`{"tacit_amm_launcher":"${launcherHex}","tacit_attest":{"supply":"1","blinding":"aa","commitment":"bb"}}`);
  // tacit_amm_launcher should come AFTER tacit_attest in sorted order.
  return extractLauncherPubkey(noncanonical) === null;
});

// Malformed JSON ⇒ rejected.
test('malformed JSON ⇒ null', () => {
  return extractLauncherPubkey(enc('not json')) === null;
});

// Wrong pubkey length ⇒ rejected.
test('launcher field with wrong length ⇒ null', () => {
  const bad = canonicalize({ tacit_amm_launcher: '0279be' });
  return extractLauncherPubkey(bad) === null;
});

// Non-hex launcher ⇒ rejected.
test('launcher field with non-hex chars ⇒ null', () => {
  const bad = canonicalize({ tacit_amm_launcher: 'XX'.repeat(33) });
  return extractLauncherPubkey(bad) === null;
});

// Uppercase hex ⇒ rejected (lowercase normative).
test('launcher field with uppercase hex ⇒ null', () => {
  const bad = canonicalize({ tacit_amm_launcher: 'AA'.repeat(33) });
  return extractLauncherPubkey(bad) === null;
});

// Wrong compressed pubkey prefix (not 02 or 03) ⇒ rejected.
test('launcher field with invalid prefix (04) ⇒ null', () => {
  const bad = canonicalize({ tacit_amm_launcher: '04' + 'aa'.repeat(32) });
  return extractLauncherPubkey(bad) === null;
});

// Launcher field not a string ⇒ rejected.
test('launcher field as object ⇒ null', () => {
  const bad = canonicalize({ tacit_amm_launcher: { hex: launcherHex } });
  return extractLauncherPubkey(bad) === null;
});

// Top-level array (not object) ⇒ rejected.
test('top-level array ⇒ null', () => {
  const bad = canonicalize([launcherHex]);
  return extractLauncherPubkey(bad) === null;
});

// Empty input ⇒ null.
test('non-Uint8Array input ⇒ null', () => {
  return extractLauncherPubkey('string input') === null;
});

console.log('\nRound-trip canonicalization');
test('canonicalize(parse(canonical)) == canonical', () => {
  const original = canonicalize({ tacit_amm_launcher: launcherHex, foo: { z: 1, a: 'bar' } });
  const re = canonicalize(JSON.parse(dec(original)));
  return dec(original) === dec(re);
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
