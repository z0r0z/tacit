// dapp/confidential-recovery.js walkWraps with a memo (newWrapMemo): the walk is asked again whenever the pool has a new wrap, and what an earlier walk of the key worked out is kept, so a later walk
// works out only what is new: the amounts not seen before at the indexes tried, the indexes past where the last walk stopped. Whatever the events do between walks (grow with ids, amounts, a deposit
// of this key at an index tried before or past where the walk stopped, a new asset, or shrink), the walk with a memo returns exactly what a walk with none returns. The count of keccaks the recovery
// makes (two for each index and amount worked out) says what was worked out.
//   node --test tests/wrap-walk-memo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialRecovery } from '../dapp/confidential-recovery.js';
import { bppGens, G as BPP_G } from '../dapp/bulletproofs-plus.js';

const cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
let calls = 0;
const counting = (b) => { calls++; return keccak_256(b); };
const R = makeConfidentialRecovery({ pool, memo: {}, keccak256: counting, secp, hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n, lockScan: {}, airdrop: {}, cdp: {}, bpp: { H: bppGens().H, G: BPP_G } });
const lc = (h) => String(h).toLowerCase();
const w32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

const priv = Uint8Array.from(Buffer.from('7a'.repeat(32), 'hex')), priv2 = Uint8Array.from(Buffer.from('3c'.repeat(32), 'hex'));
const A = '0x' + 'a5'.repeat(32), B = '0x' + 'b6'.repeat(32), C = '0x' + 'c7'.repeat(32), D = '0x' + 'd8'.repeat(32);
const assets = [{ assetId: A, ticker: 'A' }, { assetId: B, ticker: 'B' }, { assetId: C, ticker: 'C', unitScale: 1000 }, { assetId: D, ticker: 'D' }];
function wrapAt(assetId, index, value, scale = 1n, key = priv) {
  const dn = pool.deriveNote(key, assetId, index), owner = pool.nkToOwner(dn.secret);
  const { cx, cy } = pool.commitXY(BigInt(value), BigInt(dn.blinding));
  return { type: 'Wrap', assetId, amount: BigInt(value) * scale, depositId: pool.depositId(assetId, BigInt(value), cx, cy, owner) };
}
let nextId = 0x5000;
const other = (assetId, amount) => ({ type: 'Wrap', assetId, amount: BigInt(amount), depositId: w32(nextId++) });
const crowd = (assetId, from, n) => Array.from({ length: n }, (_, i) => other(assetId, (from + i) * 1000 + (i % 7)));
// the distinct amounts the walk makes a point of for an asset
const valuesOf = (events, a) => new Set(events.filter((e) => e.type === 'Wrap' && lc(e.assetId) === lc(a.assetId)).map((e) => BigInt(e.amount)).filter((x) => x > 0n && x % BigInt(a.unitScale || 1) === 0n).map((x) => x / BigInt(a.unitScale || 1))).size;

const E0 = [wrapAt(A, 0, 1000), wrapAt(A, 3, 25000), wrapAt(A, 9, 777), ...crowd(A, 1, 30), wrapAt(B, 1, 700), ...crowd(B, 40, 12), wrapAt(C, 5, 4, 1000n), other(C, 1500), other(C, 2000)];
const fresh = (args) => R.walkWraps({ priv, assets, ...args });
// a walk with a memo: the result, and the keccaks it made
const withMemo = (memo, args, key = priv) => { calls = 0; const r = R.walkWraps({ priv: key, assets, ...args, memo }); return { r, calls }; };
const pairsOf = (r, events, only = null) => r.scanned.filter((s) => !only || only.includes(s.assetId)).reduce((n, s) => n + s.indexesTried * valuesOf(events, assets.find((a) => a.assetId === s.assetId)), 0);

test('a first walk with a memo is the walk with none, and works out every index and amount once', () => {
  const memo = R.newWrapMemo();
  const { r, calls: used } = withMemo(memo, { events: E0 });
  assert.strictEqual(json(r), json(fresh({ events: E0 })));
  assert.strictEqual(used, 2 * pairsOf(r, E0), 'two keccaks for each (index, amount)');
  assert.ok(r.found.length === 5, `found ${r.found.length}`);
});

test('the same events again: the walk is the same and works out nothing', () => {
  const memo = R.newWrapMemo();
  const first = withMemo(memo, { events: E0 });
  const again = withMemo(memo, { events: E0 });
  assert.strictEqual(json(again.r), json(first.r));
  assert.strictEqual(again.calls, 0);
});

test('new ids for amounts already seen cost nothing, new amounts cost only the indexes already tried, each amount once', () => {
  const memo = R.newWrapMemo();
  withMemo(memo, { events: E0 });
  const E1 = [...E0, ...crowd(A, 1, 5), other(B, 41001), other(C, 2000)];       // ids of others, with amounts the pool has seen (crowd amounts carry an offset; C's are in units of 1000)
  const a1 = withMemo(memo, { events: E1 });
  assert.strictEqual(json(a1.r), json(fresh({ events: E1 })));
  assert.strictEqual(a1.calls, 0, 'nothing is hashed for ids alone');
  const E2 = [...E1, other(A, 777777), other(A, 888888), other(A, 999999)];     // three amounts the pool has not seen
  const a2 = withMemo(memo, { events: E2 });
  assert.strictEqual(json(a2.r), json(fresh({ events: E2 })));
  assert.strictEqual(a2.calls, 2 * a2.r.scanned.find((s) => s.assetId === A).indexesTried * 3, 'three amounts at each index of A, nothing else');
  assert.strictEqual(withMemo(memo, { events: E2 }).calls, 0, 'and then they are kept');
});

test('a deposit of this key at an index tried before is found without hashing anything', () => {
  const memo = R.newWrapMemo();
  const before = withMemo(memo, { events: E0 });
  const tried = before.r.scanned.find((s) => s.assetId === A).indexesTried;
  assert.ok(tried > 12 && !before.r.found.some((n) => n.asset === A && n.index === 5));
  const E3 = [...E0, wrapAt(A, 5, 1000), wrapAt(A, 6, 25000)];
  const got = withMemo(memo, { events: E3 });
  assert.strictEqual(got.calls, 0, 'found from what was kept');
  assert.strictEqual(json(got.r), json(fresh({ events: E3 })));
  assert.deepStrictEqual(got.r.found.filter((n) => n.asset === A).map((n) => [n.index, n.value]), [[0, 1000n], [3, 25000n], [5, 1000n], [6, 25000n], [9, 777n]]);
});

test('a deposit near where the walk stopped carries it on, and only the indexes past that are worked out', () => {
  const memo = R.newWrapMemo();
  const before = withMemo(memo, { events: E0 });
  const sa = before.r.scanned.find((s) => s.assetId === A);
  const E4 = [...E0, wrapAt(A, sa.scannedThrough - 2, 1000)];
  const got = withMemo(memo, { events: E4 });
  assert.strictEqual(json(got.r), json(fresh({ events: E4 })));
  const sb = got.r.scanned.find((s) => s.assetId === A);
  assert.ok(sb.indexesTried > sa.indexesTried, 'the walk went on');
  assert.strictEqual(got.calls, 2 * (sb.indexesTried - sa.indexesTried) * valuesOf(E4, assets[0]), 'only the new indexes of A, every amount');
});

test('events that go away leave nothing behind: what is no longer there is not found', () => {
  const memo = R.newWrapMemo();
  withMemo(memo, { events: [...E0, wrapAt(A, 5, 1000), wrapAt(A, 30, 25000)] });
  const back = withMemo(memo, { events: E0 });
  assert.strictEqual(json(back.r), json(fresh({ events: E0 })));
  assert.ok(!back.r.found.some((n) => n.asset === A && (n.index === 5 || n.index === 30)));
  assert.strictEqual(back.calls, 0);
  const none = withMemo(memo, { events: [] });
  assert.deepStrictEqual(none.r, { found: [], scanned: [] });
});

test('an asset the pool has not had a wrap of before is worked out alone', () => {
  const memo = R.newWrapMemo();
  withMemo(memo, { events: E0 });
  const E5 = [...E0, wrapAt(D, 2, 55), other(D, 66)];
  const got = withMemo(memo, { events: E5 });
  assert.strictEqual(json(got.r), json(fresh({ events: E5 })));
  assert.strictEqual(got.calls, 2 * pairsOf(got.r, E5, [D]));
});

test('a memo of another key is not used and not changed, and the first key still has its own', () => {
  const memo = R.newWrapMemo();
  const mine = withMemo(memo, { events: E0 });
  const E6 = [...E0, wrapAt(A, 4, 1000, 1n, priv2)];
  const theirs = withMemo(memo, { events: E6 }, priv2);
  assert.strictEqual(json(theirs.r), json(R.walkWraps({ priv: priv2, assets, events: E6 })), 'what the other key finds is what it finds with no memo');
  assert.ok(theirs.r.found.some((n) => n.asset === A && n.index === 4), 'and it finds its own');
  assert.strictEqual(theirs.calls, 2 * pairsOf(theirs.r, E6), 'it worked every pair out itself');
  const back = withMemo(memo, { events: E0 });
  assert.strictEqual(json(back.r), json(mine.r));
  assert.strictEqual(back.calls, 0, 'the first key\'s memo was left as it was');
});

test('hints, a short maxIndex and a short gap are the same with a memo as without, however the memo came to be', () => {
  const memo = R.newWrapMemo();
  withMemo(memo, { events: E0 });
  for (const args of [{ minIndex: 40 }, { minIndex: (id) => (id === B ? 35 : 0) }, { maxIndex: 7 }, { gap: 2 }, { gap: 40 }]) {
    const E = [...E0, wrapAt(A, 12, 1000)];
    assert.strictEqual(json(withMemo(memo, { events: E, ...args }).r), json(fresh({ events: E, ...args })), json(args));
  }
});

test('walks that overlap and share a memo each return what a walk with none returns', async () => {
  const memo = R.newWrapMemo();
  const EA = [...E0, wrapAt(A, 5, 1000), other(A, 123456)], EB = [...E0, wrapAt(A, 7, 777), wrapAt(B, 3, 700), other(B, 654321)];
  const [a, b, a2] = await Promise.all([
    R.walkWrapsSliced({ priv, assets, events: EA, memo }, { sliceMs: 0 }),
    R.walkWrapsSliced({ priv, assets, events: EB, memo }, { sliceMs: 0 }),
    R.walkWrapsSliced({ priv, assets, events: E0, memo }, { sliceMs: 0 }),
  ]);
  assert.strictEqual(json(a), json(fresh({ events: EA })));
  assert.strictEqual(json(b), json(fresh({ events: EB })));
  assert.strictEqual(json(a2), json(fresh({ events: E0 })));
  assert.strictEqual(json(withMemo(memo, { events: EB }).r), json(fresh({ events: EB })), 'and the memo they left is sound');
});

test('a thousand amounts: the memo grows by amount, and a later walk with more of them works out only the new ones', () => {
  const memo = R.newWrapMemo();
  const big = [wrapAt(A, 2, 123456), ...crowd(A, 1, 500)];
  const first = withMemo(memo, { events: big, gap: 3 });
  const bigger = [...big, ...crowd(A, 700, 500)];
  const got = withMemo(memo, { events: bigger, gap: 3 });
  assert.strictEqual(json(got.r), json(fresh({ events: bigger, gap: 3 })));
  const tried = got.r.scanned[0].indexesTried;
  assert.strictEqual(got.calls, 2 * tried * (valuesOf(bigger, assets[0]) - valuesOf(big, assets[0])), 'only the amounts that are new, at each index');
  assert.ok(first.calls > 0);
});
