// dapp/confidential-recovery.js walkWraps: the walk hashes from bytes, takes one field inversion for all the amounts of an index and looks a digest up by its first six bytes before it
// writes it out and checks it, and it finds exactly what the walk that works out each (index, amount) with pool.depositId and one inversion apiece finds: the same notes in the same order,
// the same account of what was tried. `reference` below is that walk.
//   node --test tests/wrap-walk-exact.test.mjs
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
import { toAffineBatch } from '../dapp/confidential-bridge-walk.js';
import { secp as vendorSecp } from '../dapp/vendor/tacit-deps.min.js';

const cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const H = bppGens().H, G = BPP_G;
const R = makeConfidentialRecovery({ pool, memo: {}, keccak256: keccak_256, secp, hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n, lockScan: {}, airdrop: {}, cdp: {}, bpp: { H, G } });
const lc = (h) => String(h == null ? '' : h).toLowerCase();
const w32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

// the walk as it was: every (index, amount) with its own inversion and pool.depositId
function reference({ priv, events, assets, gap = 24, maxIndex = 4096, minIndex = 0 }) {
  const floorFor = (assetId) => { const n = Number(typeof minIndex === 'function' ? minIndex(assetId) : minIndex); return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), maxIndex) : 0; };
  const byAsset = new Map();
  for (const e of events || []) {
    if (!e || e.type !== 'Wrap') continue;
    let d = byAsset.get(lc(e.assetId));
    if (!d) byAsset.set(lc(e.assetId), (d = { ids: new Set(), amounts: new Set() }));
    d.ids.add(lc(e.depositId)); d.amounts.add(BigInt(e.amount));
  }
  const found = [], scanned = [];
  for (const a of assets || []) {
    const d = byAsset.get(lc(a.assetId));
    if (!d) continue;
    const scale = BigInt(a.unitScale || 1);
    const values = [...new Set([...d.amounts].filter((x) => x > 0n && x % scale === 0n).map((x) => x / scale))];
    const Hv = new Map(values.map((v) => [v, H.multiply(v)]));
    const floor = floorFor(a.assetId);
    let miss = 0, tried = 0, matched = 0, lastMatch = -1;
    for (let i = 0; i <= maxIndex && (miss < gap || i <= floor); i++) {
      tried++;
      const dn = pool.deriveNote(priv, a.assetId, i);
      const owner = pool.nkToOwner(dn.secret);
      const Gr = G.multiply(BigInt(dn.blinding));
      let hit = false;
      for (const v of values) {
        const p = Hv.get(v).add(Gr).toAffine(), cx = w32(p.x), cy = w32(p.y);
        const depositId = pool.depositId(a.assetId, v, cx, cy, owner);
        if (!d.ids.has(lc(depositId))) continue;
        hit = true; matched++; lastMatch = i;
        found.push({ index: i, value: v, blinding: w32(dn.blinding), secret: dn.secret, asset: a.assetId, owner, cx, cy, leaf: pool.leaf(a.assetId, cx, cy, owner), depositId });
      }
      miss = hit ? 0 : miss + 1;
    }
    const scannedThrough = tried - 1;
    scanned.push({ assetId: a.assetId, ticker: a.ticker || null, deposits: d.ids.size, indexesTried: tried, matched, minIndex: floor, scannedThrough, lastMatch, stoppedOnGap: miss >= gap && scannedThrough < maxIndex, stoppedAtMaxIndex: scannedThrough >= maxIndex });
  }
  return { found, scanned };
}

const priv = Uint8Array.from(Buffer.from('7a'.repeat(32), 'hex'));
const A = '0x' + 'a5'.repeat(32), B = '0x' + 'b6'.repeat(32), C = '0x' + 'c7'.repeat(32), D = '0x' + 'd8'.repeat(32);
// the Wrap event this key's note at `index` is deposited by, for an asset whose units are `scale` base units
function wrapAt(assetId, index, value, scale = 1n) {
  const dn = pool.deriveNote(priv, assetId, index), owner = pool.nkToOwner(dn.secret);
  const { cx, cy } = pool.commitXY(BigInt(value), BigInt(dn.blinding));
  return { type: 'Wrap', assetId, amount: BigInt(value) * scale, depositId: pool.depositId(assetId, BigInt(value), cx, cy, owner) };
}
const other = (assetId, amount, n) => ({ type: 'Wrap', assetId, amount: BigInt(amount), depositId: '0x' + n.toString(16).padStart(64, '0') });
// a few dozen amounts of other depositors, so each index has that many points to take
const crowd = (assetId, from, n) => Array.from({ length: n }, (_, i) => other(assetId, (from + i) * 1000 + (i % 7), 0x1000 + from + i));
const flip = (id) => id.slice(0, -2) + (id.endsWith('ff') ? '00' : 'ff');

const mine = [wrapAt(A, 0, 1000), wrapAt(A, 3, 25000), wrapAt(A, 3, 31000), wrapAt(A, 9, 777), wrapAt(B, 1, 700), wrapAt(B, 20, 12), wrapAt(C, 5, 4, 1000n), wrapAt(C, 6, 90, 1000n)];
const events = [...mine, ...crowd(A, 1, 30), ...crowd(B, 40, 12), other(C, 1500, 0x3001), other(C, 2000, 0x3002), other(D, 0, 0x4001), other(D, 5, 0x4002)];
const assets = [{ assetId: A, ticker: 'A' }, { assetId: B, ticker: 'B' }, { assetId: C, ticker: 'C', unitScale: 1000 }, { assetId: D, ticker: 'D', unitScale: 10 }, { assetId: '0x' + 'ee'.repeat(32), ticker: 'none' }];
const same = (args, label) => assert.deepStrictEqual(R.walkWraps({ priv, assets, ...args }), reference({ priv, assets, ...args }), label);

test('with several assets, amounts, a unit scale, two notes at one index and a gap that runs past the last of them, it finds what the reference does', () => {
  const r = R.walkWraps({ priv, events, assets });
  assert.deepStrictEqual(r.found.map((n) => [n.asset, n.index, n.value]), [[A, 0, 1000n], [A, 3, 25000n], [A, 3, 31000n], [A, 9, 777n], [B, 1, 700n], [B, 20, 12n], [C, 5, 4n], [C, 6, 90n]]);
  assert.ok(r.scanned.find((s) => s.assetId === A).matched === 4 && r.scanned.find((s) => s.assetId === A).lastMatch === 9);
  same({ events }, 'events');
});

test('an index hint, a function hint, a short maxIndex and a short gap give what the reference gives', () => {
  same({ events, minIndex: 40 }, 'floor 40');
  same({ events, minIndex: (id) => (id === B ? 35 : 0) }, 'floor for one asset');
  same({ events, maxIndex: 7 }, 'maxIndex 7 (stops at the limit, finds the notes before it)');
  same({ events, gap: 2 }, 'gap 2');
  same({ events, gap: 40 }, 'gap 40');
});

test('a deposit id that begins as a real one does is not a note of this key', () => {
  const decoys = mine.map((m) => ({ ...m, depositId: flip(m.depositId) }));
  const only = [...decoys, ...crowd(A, 1, 6)];
  const r = R.walkWraps({ priv, events: only, assets });
  assert.strictEqual(r.found.length, 0);
  assert.deepStrictEqual(r, reference({ priv, events: only, assets }));
  // and the real ones among such decoys are still found
  const both = [...decoys, ...mine];
  assert.strictEqual(R.walkWraps({ priv, events: both, assets }).found.length, mine.length);
  assert.deepStrictEqual(R.walkWraps({ priv, events: both, assets }), reference({ priv, events: both, assets }));
});

test('ids given in capitals, short, or not hex are read as before', () => {
  const odd = mine.map((m, k) => ({ ...m, depositId: k % 2 ? '0x' + m.depositId.slice(2).toUpperCase() : m.depositId }));
  const junk = [{ type: 'Wrap', assetId: A, amount: 5n, depositId: '0x12' }, { type: 'Wrap', assetId: A, amount: 6n, depositId: 'zz' }, { type: 'Wrap', assetId: A, amount: 7n, depositId: '' }, { type: 'Wrap', assetId: A, amount: 8n, depositId: '0x' + 'g'.repeat(64) }];
  const ev = [...odd, ...junk];
  const r = R.walkWraps({ priv, events: ev, assets });
  assert.strictEqual(r.found.length, mine.length, 'a capitalised id is the same id');
  assert.deepStrictEqual(r, reference({ priv, events: ev, assets }));
});

test('an asset whose amounts are all zero or off its unit scale is walked to the gap and finds nothing', () => {
  const ev = [other(C, 1500, 1), other(C, 1001, 2), other(D, 0, 3), other(D, 15, 4)];
  const as = [{ assetId: C, ticker: 'C', unitScale: 1000 }, { assetId: D, ticker: 'D', unitScale: 100 }];
  const r = R.walkWraps({ priv, events: ev, assets: as, gap: 5 });
  assert.deepStrictEqual(r, reference({ priv, events: ev, assets: as, gap: 5 }));
  assert.ok(r.scanned.every((s) => s.indexesTried === 5 && s.matched === 0));
});

test('a thousand amounts at an index are taken in one inversion and still found', () => {
  const ev = [wrapAt(A, 2, 123456789), ...crowd(A, 1, 1000)];
  const r = R.walkWraps({ priv, events: ev, assets: [assets[0]], gap: 3 });
  assert.deepStrictEqual(r.found.map((n) => [n.index, n.value]), [[2, 123456789n]]);
  assert.deepStrictEqual(r, reference({ priv, events: ev, assets: [assets[0]], gap: 3 }));
});

test('the page\'s own curve library gives points toAffineBatch can invert together, and the same coordinates', () => {
  const P = vendorSecp.ProjectivePoint, pts = [3n, 5n, 7n, 11n].map((k) => P.BASE.multiply(k).add(P.BASE));
  assert.ok(pts.every((p) => typeof p.pz === 'bigint' && p.pz !== 0n), 'the batch path is taken, not the fallback');
  assert.deepStrictEqual(toAffineBatch(pts), pts.map((p) => { const a = p.toAffine(); return { x: a.x, y: a.y }; }));
});

test('the multiples of H the walk uses are the curve library\'s own, for any amount, and are kept', async () => {
  const { makeMultiples } = await import('../dapp/point-multiples.js');
  const multiple = makeMultiples(H);
  const U64 = (1n << 64n) - 1n;
  let seed = 0x2545f491n;
  const rnd = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return seed; };
  const amounts = [1n, 2n, 15n, 16n, 17n, 255n, 256n, 10n ** 18n, U64, U64 - 1n, 1n << 63n, 1n << 32n, (1n << 32n) - 1n, ...Array.from({ length: 60 }, () => rnd()), ...Array.from({ length: 40 }, () => rnd() >> BigInt(Number(rnd() % 60n)))].filter((v) => v > 0n);
  for (const v of amounts) assert.ok(multiple(v).equals(H.multiply(v)), `v = ${v}`);
  for (const v of [1n << 64n, (1n << 64n) + 5n, 1n << 100n]) assert.ok(multiple(v).equals(H.multiply(v)), `v >= 2^64: ${v}`);
  assert.strictEqual(multiple(12345n), multiple(12345n), 'the same point is handed out again');
  assert.throws(() => multiple(0n), 'no multiple of nothing, as with the library');
});
