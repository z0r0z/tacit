// dapp/confidential-recovery.js walkWraps / walkWrapsSliced: the walk that hands the thread back between indexes finds exactly what the one that runs
// to the end does (the wraps of a key, the indexes it tried), however often it yields.
//   node --test tests/wrap-walk-sliced.test.mjs
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
const R = makeConfidentialRecovery({ pool, memo: {}, keccak256: keccak_256, secp, hmac, sha256: nobleSha256, curveOrder: secp.CURVE.n, lockScan: {}, airdrop: {}, cdp: {}, bpp: { H: bppGens().H, G: BPP_G } });

const priv = Uint8Array.from(Buffer.from('7a'.repeat(32), 'hex')), ASSET = '0x' + 'a5'.repeat(32), OTHER = '0x' + 'b6'.repeat(32);
// the Wrap event this key's note at `index` would have been deposited by
function wrapAt(assetId, index, value) {
  const dn = pool.deriveNote(priv, assetId, index), owner = pool.nkToOwner(dn.secret);
  const { cx, cy } = pool.commitXY(BigInt(value), BigInt(dn.blinding));
  return { type: 'Wrap', assetId, amount: BigInt(value), depositId: pool.depositId(assetId, BigInt(value), cx, cy, owner) };
}
const args = { priv, assets: [{ assetId: ASSET, ticker: 'A' }, { assetId: OTHER, ticker: 'B' }], events: [wrapAt(ASSET, 0, 1000), wrapAt(ASSET, 3, 25000), wrapAt(OTHER, 1, 700), { type: 'Wrap', assetId: ASSET, amount: 5n, depositId: '0x' + '99'.repeat(32) }], gap: 6 };

test('the walk finds this key\'s wraps, with the indexes it tried', () => {
  const r = R.walkWraps(args);
  assert.deepStrictEqual(r.found.map((n) => [n.asset, n.index, n.value]).sort(), [[ASSET, 0, 1000n], [ASSET, 3, 25000n], [OTHER, 1, 700n]].sort());
  const a = r.scanned.find((s) => s.assetId === ASSET);
  assert.strictEqual(a.matched, 2);
  assert.strictEqual(a.lastMatch, 3);
  assert.ok(a.stoppedOnGap && a.scannedThrough === 3 + 6, 'it stops after `gap` misses past the last match');
});

test('walked in slices, however often the thread is handed back, it reads the same', async () => {
  const whole = R.walkWraps(args);
  for (const sliceMs of [12, 1, 0]) {
    const sliced = await R.walkWrapsSliced(args, { sliceMs });
    assert.deepStrictEqual(sliced, whole, `sliceMs ${sliceMs}`);
  }
});

test('a key with no wraps among the events is walked to the gap and finds none, in slices as at once', async () => {
  const none = { ...args, events: [{ type: 'Wrap', assetId: ASSET, amount: 9n, depositId: '0x' + '77'.repeat(32) }], gap: 4 };
  const whole = R.walkWraps(none), sliced = await R.walkWrapsSliced(none, { sliceMs: 0 });
  assert.deepStrictEqual(sliced, whole);
  assert.strictEqual(whole.found.length, 0);
  assert.strictEqual(whole.scanned[0].indexesTried, 4);
});

test('assets with no Wrap events are skipped, and the walk of nothing is empty', async () => {
  assert.deepStrictEqual(await R.walkWrapsSliced({ ...args, events: [] }), { found: [], scanned: [] });
  assert.deepStrictEqual(R.walkWraps({ ...args, assets: [] }), { found: [], scanned: [] });
});
