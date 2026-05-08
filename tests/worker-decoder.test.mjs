// Worker decoder return-shape contract.
//
// What this pins down: the exact field names every worker decoder returns,
// so a handler that consumes those fields can never silently drift.
//
// Why it exists: the atomic-intent-open path was 100% broken for an unknown
// stretch because handleAtomicIntentPost read `ax.assetInputCount` (camelCase)
// against a `decodeAxferPayload` that returns `asset_input_count` (snake_case).
// JS doesn't error on undefined-property reads, so the bug was invisible to
// the type system, lint, and every existing test. This file synthesises a
// minimum-valid envelope payload for every opcode and asserts the decoder's
// return shape — both that the documented keys ARE present and that the
// historically-wrong camelCase keys are NOT.
//
// Run: `node worker-decoder.test.mjs`

import {
  decodeCEtchPayload, decodeCMintPayload, decodeCXferPayload,
  decodeAxferPayload, decodeCBurnPayload,
  decodeCPetchPayload, decodeCPmintPayload,
  T_CETCH, T_CXFER, T_MINT, T_BURN, T_AXFER, T_PETCH, T_PMINT,
} from '../worker/src/index.js';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

const u8 = (...nums) => new Uint8Array(nums);
const zeroes = (n) => new Uint8Array(n);
function concat(...bufs) {
  let n = 0; for (const b of bufs) n += b.length;
  const out = new Uint8Array(n); let p = 0;
  for (const b of bufs) { out.set(b, p); p += b.length; }
  return out;
}
const keysSorted = (obj) => JSON.stringify(Object.keys(obj).sort());

console.log('Worker decoder return-shape contract:');

// ---------------------------------------------------------------------------
// T_AXFER — the regression case. Wire format (SPEC §5.7):
//   opcode(1) || asset_id(32) || asset_input_count(1) || kernel_sig(64) ||
//   N(1) || N*[commitment(33) || amount_ct(8)] || rp_len(2 LE) || rp(rp_len)
// ---------------------------------------------------------------------------
const minAxfer = () => concat(
  u8(T_AXFER), zeroes(32), u8(1), zeroes(64), u8(1), zeroes(33), zeroes(8), u8(0, 0),
);

test('decodeAxferPayload returns { asset_id, asset_input_count, outputs }', () => {
  const d = decodeAxferPayload(minAxfer());
  if (!d) return false;
  if (keysSorted(d) !== keysSorted({ asset_id: 0, asset_input_count: 0, outputs: 0 })) return false;
  if (typeof d.asset_id !== 'string' || d.asset_id.length !== 64) return false;
  if (d.asset_input_count !== 1) return false;
  if (!Array.isArray(d.outputs) || d.outputs.length !== 1) return false;
  if (keysSorted(d.outputs[0]) !== JSON.stringify(['commitment'])) return false;
  return true;
});

test('decodeAxferPayload return shape has NO camelCase keys (regression sentinel)', () => {
  // The exact field names that bit handleAtomicIntentPost. If any of these
  // ever start being defined, the decoder shape has drifted and the handler
  // is at risk of reading the snake_case field as undefined again.
  const d = decodeAxferPayload(minAxfer());
  return d.assetId === undefined && d.assetInputCount === undefined;
});

// ---------------------------------------------------------------------------
// T_CXFER — opcode(1) || asset_id(32) || kernel_sig(64) || N(1) ||
//   N*[commitment(33) || amount_ct(8)] || rp_len(2 LE) || rp(rp_len)
// ---------------------------------------------------------------------------
test('decodeCXferPayload returns { asset_id, outputs }', () => {
  const payload = concat(
    u8(T_CXFER), zeroes(32), zeroes(64), u8(1), zeroes(33), zeroes(8), u8(0, 0),
  );
  const d = decodeCXferPayload(payload);
  if (!d) return false;
  if (keysSorted(d) !== keysSorted({ asset_id: 0, outputs: 0 })) return false;
  if (d.assetId !== undefined) return false;
  return true;
});

// ---------------------------------------------------------------------------
// T_MINT — opcode(1) || asset_id(32) || etch_txid(32) || commitment(33) ||
//   amount_ct(8) || rp_len(2 LE) || rp(rp_len) || issuer_sig(64)
// ---------------------------------------------------------------------------
test('decodeCMintPayload returns { asset_id, etch_txid, commitment }', () => {
  const payload = concat(
    u8(T_MINT), zeroes(32), zeroes(32), zeroes(33), zeroes(8), u8(0, 0), zeroes(64),
  );
  const d = decodeCMintPayload(payload);
  if (!d) return false;
  if (keysSorted(d) !== keysSorted({ asset_id: 0, etch_txid: 0, commitment: 0 })) return false;
  if (d.assetId !== undefined || d.etchTxid !== undefined) return false;
  return true;
});

// ---------------------------------------------------------------------------
// T_BURN — opcode(1) || asset_id(32) || burned_amount(8 LE) || kernel_sig(64) ||
//   n(1) || n*[commitment(33) || amount_ct(8)] || (rp_len(2 LE) || rp if n>0)
// ---------------------------------------------------------------------------
test('decodeCBurnPayload returns { asset_id, burned_amount, outputs }', () => {
  const payload = concat(
    u8(T_BURN), zeroes(32), zeroes(8), zeroes(64), u8(0),
  );
  const d = decodeCBurnPayload(payload);
  if (!d) return false;
  if (keysSorted(d) !== keysSorted({ asset_id: 0, burned_amount: 0, outputs: 0 })) return false;
  if (d.assetId !== undefined || d.burnedAmount !== undefined) return false;
  if (typeof d.burned_amount !== 'string') return false;
  return true;
});

// ---------------------------------------------------------------------------
// T_CETCH — opcode(1) || tlen(1) || ticker(tlen) || decimals(1) ||
//   commitment(33) || amount_ct(8) || rp_len(2 LE) || rp(rp_len) ||
//   mint_authority(32) || img_len(2 LE) || image_uri(img_len)
// ---------------------------------------------------------------------------
const minCetch = () => concat(
  u8(T_CETCH), u8(1), u8(0x41), u8(0), zeroes(33), zeroes(8), u8(0, 0), zeroes(32), u8(0, 0),
);

test('decodeCEtchPayload returns { ticker, decimals, commitment, image_uri, mintable, mint_authority }', () => {
  const d = decodeCEtchPayload(minCetch());
  if (!d) return false;
  const expected = keysSorted({
    ticker: 0, decimals: 0, commitment: 0, image_uri: 0, mintable: 0, mint_authority: 0,
  });
  return keysSorted(d) === expected;
});

test('decodeCEtchPayload uses snake_case image_uri (regression sentinel for mixed-case footgun)', () => {
  // Pre-fix this decoder returned `imageUri` (camelCase) alongside snake_case
  // siblings. A new caller written from muscle memory expecting `image_uri`
  // would silently get undefined. Pin the snake_case shape down.
  const d = decodeCEtchPayload(minCetch());
  return d.imageUri === undefined && (d.image_uri === null || typeof d.image_uri === 'string');
});

// ---------------------------------------------------------------------------
// T_PETCH (SPEC §5.8) — opcode(1) || tlen(1) || ticker(tlen) || decimals(1) ||
//   cap(8 LE) || limit(8 LE) || start_h(4 LE) || end_h(4 LE) ||
//   img_len(2 LE) || image_uri(img_len)
// ---------------------------------------------------------------------------
const u64le = (n) => {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, Number(BigInt(n) & 0xffffffffn), true);
  v.setUint32(4, Number((BigInt(n) >> 32n) & 0xffffffffn), true);
  return b;
};
const u32le = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
const minPetch = ({ cap = 1000n, limit = 100n, start = 0, end = 0, ticker = 'A', decimals = 0, img = '' } = {}) => {
  const t = new TextEncoder().encode(ticker);
  const i = new TextEncoder().encode(img);
  return concat(
    u8(T_PETCH), u8(t.length), t, u8(decimals),
    u64le(cap), u64le(limit),
    u32le(start), u32le(end),
    u8(i.length & 0xff, (i.length >> 8) & 0xff), i,
  );
};

test('decodeCPetchPayload returns expected snake_case shape', () => {
  const d = decodeCPetchPayload(minPetch());
  if (!d) return false;
  const expected = keysSorted({
    ticker: 0, decimals: 0, cap_amount: 0, mint_limit: 0,
    mint_start_height: 0, mint_end_height: 0, image_uri: 0,
  });
  if (keysSorted(d) !== expected) return false;
  if (typeof d.cap_amount !== 'string' || typeof d.mint_limit !== 'string') return false;
  if (d.cap_amount !== '1000' || d.mint_limit !== '100') return false;
  return true;
});

test('decodeCPetchPayload no camelCase keys (regression sentinel)', () => {
  const d = decodeCPetchPayload(minPetch());
  return d.capAmount === undefined && d.mintLimit === undefined
    && d.mintStartHeight === undefined && d.mintEndHeight === undefined
    && d.imageUri === undefined;
});

test('decodeCPetchPayload rejects cap not divisible by limit', () => {
  return decodeCPetchPayload(minPetch({ cap: 1000n, limit: 333n })) === null;
});

test('decodeCPetchPayload rejects mint_limit > cap_amount', () => {
  return decodeCPetchPayload(minPetch({ cap: 100n, limit: 1000n })) === null;
});

test('decodeCPetchPayload rejects cap_amount == 0', () => {
  return decodeCPetchPayload(minPetch({ cap: 0n, limit: 100n })) === null;
});

test('decodeCPetchPayload rejects mint_limit == 0', () => {
  return decodeCPetchPayload(minPetch({ cap: 1000n, limit: 0n })) === null;
});

test('decodeCPetchPayload rejects decimals > 8', () => {
  return decodeCPetchPayload(minPetch({ decimals: 9 })) === null;
});

test('decodeCPetchPayload rejects ticker_len == 0', () => {
  // Construct manually since minPetch encodes a 1-char default
  const payload = concat(
    u8(T_PETCH), u8(0),
    u8(0), u64le(1000n), u64le(100n), u32le(0), u32le(0), u8(0, 0),
  );
  return decodeCPetchPayload(payload) === null;
});

test('decodeCPetchPayload rejects ticker_len > 16', () => {
  return decodeCPetchPayload(minPetch({ ticker: 'A'.repeat(17) })) === null;
});

test('decodeCPetchPayload rejects mint_end_height <= mint_start_height when both nonzero', () => {
  return decodeCPetchPayload(minPetch({ start: 100, end: 100 })) === null
    && decodeCPetchPayload(minPetch({ start: 100, end: 50 })) === null;
});

test('decodeCPetchPayload accepts mint_end_height == 0 (no end)', () => {
  return decodeCPetchPayload(minPetch({ start: 100, end: 0 })) !== null;
});

test('decodeCPetchPayload rejects opcode != T_PETCH', () => {
  const p = minPetch();
  p[0] = T_CETCH;   // wrong opcode
  return decodeCPetchPayload(p) === null;
});

// ---------------------------------------------------------------------------
// T_PMINT (SPEC §5.9) — opcode(1) || asset_id(32) || etch_txid(32) ||
//   commitment(33) || amount(8 LE) || blinding(32). Total 138 bytes exactly.
// ---------------------------------------------------------------------------
const minPmint = ({ amount = 100n, blinding = null, commitment = null } = {}) => {
  const blind = blinding || (() => { const b = new Uint8Array(32); b[31] = 1; return b; })();
  const comm = commitment || (() => { const c = new Uint8Array(33); c[0] = 0x02; c[32] = 1; return c; })();
  return concat(
    u8(T_PMINT), zeroes(32), zeroes(32), comm, u64le(amount), blind,
  );
};

test('decodeCPmintPayload returns expected snake_case shape', () => {
  const d = decodeCPmintPayload(minPmint());
  if (!d) return false;
  const expected = keysSorted({
    asset_id: 0, etch_txid: 0, commitment: 0, amount: 0, blinding: 0,
  });
  if (keysSorted(d) !== expected) return false;
  if (typeof d.amount !== 'string') return false;
  if (d.amount !== '100') return false;
  return true;
});

test('decodeCPmintPayload no camelCase keys (regression sentinel)', () => {
  const d = decodeCPmintPayload(minPmint());
  return d.assetId === undefined && d.etchTxid === undefined;
});

test('decodeCPmintPayload rejects all-zero blinding', () => {
  return decodeCPmintPayload(minPmint({ blinding: zeroes(32) })) === null;
});

test('decodeCPmintPayload rejects amount == 0', () => {
  return decodeCPmintPayload(minPmint({ amount: 0n })) === null;
});

test('decodeCPmintPayload rejects wrong total length', () => {
  const p = minPmint();
  // Trim one byte
  return decodeCPmintPayload(p.slice(0, p.length - 1)) === null;
});

test('decodeCPmintPayload rejects opcode != T_PMINT', () => {
  const p = minPmint();
  p[0] = T_MINT;
  return decodeCPmintPayload(p) === null;
});

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
