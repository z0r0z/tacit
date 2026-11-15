// A scan that is cut short keeps how far it got (confidential-memo.js scanSliced `onProgress`, confidential-pool-ux.js partial checkpoint): the next scan of the same
// key starts there and finds the notes a whole scan finds. Run on a chain of 620 leaves whose memos are sealed to other keys, with notes sealed to the key at 7, 300, 450 and 617. A partial checkpoint stops at a whole block of 256 leaves.
//   node --test tests/memo-partial-checkpoint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
const encodeLeavesInserted = (leaves, memos) => {
  const lv = [w32(leaves.length), ...leaves.map((l) => String(l).replace(/^0x/, '').padStart(64, '0'))].join('');
  const bodies = memos.map((m) => { const h = String(m).replace(/^0x/, ''); const len = h.length / 2; return w32(len) + h.padEnd(Math.ceil(len / 32) * 64, '0'); });
  let off = 32 * memos.length; const heads = [];
  for (const b of bodies) { heads.push(w32(off)); off += b.length / 2; }
  return '0x' + w32(64) + w32(64 + lv.length / 2) + lv + (w32(memos.length) + heads.join('') + bodies.join(''));
};
const TOPIC = '0x' + Buffer.from(keccak_256(new TextEncoder().encode('LeavesInserted(uint256,bytes32[],bytes[])'))).toString('hex');

const store = new Map();
const prior = globalThis.localStorage;
globalThis.localStorage = {
  get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
};

// the chain: one LeavesInserted event of 160 leaves, memos sealed to other keys except two to the key under test
const N = 620, OLD = 7, NEW = N - 3, MID = [300, 450];
let ux, mine, leavesHex, memosHex;
const build = () => {
  const deps = { secp, keccak256: keccak_256, sha256, network: 'mainnet', logStore: null };
  const boot = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => { throw new Error('no network'); } });
  const priv = '0x' + '5a'.repeat(32);
  const id = boot.identity(priv);
  const asset = boot.assetByTicker.cETH.assetId;
  const note = (value, seed) => {
    const blinding = BigInt('0x' + sha256(new TextEncoder().encode('b' + seed)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')) % secp.CURVE.n;
    const nk = '0x' + w32(BigInt('0x' + sha256(new TextEncoder().encode('n' + seed)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')) % secp.CURVE.n);
    const owner = boot.pool.nkToOwner(nk), { cx, cy } = boot.pool.commitXY(value, '0x' + w32(blinding));
    return { value, blinding: '0x' + w32(blinding), secret: nk, asset, owner, cx, cy };
  };
  const leaves = [], memos = [];
  let e = 1n;
  const rand = () => (e = (e * 6364136223846793005n + 1442695040888963407n) % secp.CURVE.n) || 1n;
  for (let i = 0; i < N; i++) {
    const n = note(1000 + i, i);
    const stranger = secp.ProjectivePoint.BASE.multiply(BigInt(i + 2)).toHex(true);
    const to = i === OLD || i === NEW || MID.includes(i) ? id.pubHex : '0x' + stranger;
    leaves.push(boot.pool.leaf(asset, n.cx, n.cy, n.owner));
    memos.push(boot.memo.encodeMemo(boot.memo.sealMemo(to, n, rand)));
  }
  mine = { priv, pub: id.pubHex };
  leavesHex = leaves; memosHex = memos;
  const log = { address: boot.cfg.pool, topics: [TOPIC, '0x' + w32(0)], data: encodeLeavesInserted(leaves, memos), blockNumber: '0x' + (boot.cfg.deployBlock + 1).toString(16), transactionHash: '0x' + 'cd'.repeat(32), logIndex: '0x0' };
  ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    const obj = body && body.method === 'eth_blockNumber' ? { result: '0x' + (boot.cfg.deployBlock + 200).toString(16) }
      : body && body.method === 'eth_getLogs' ? { result: [log] } : { result: '0x0' };
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  } });
};


const WANT = [OLD, ...MID, NEW];
const idx = (r) => r.notes.map((n) => Number(n.leafIndex)).sort((a, b) => a - b);
const cks = () => [...store.keys()].filter((k) => k.startsWith('tacit-memo-ck-v1:'));
const ckOf = () => JSON.parse(store.get(cks()[0]));

// scanSliced is asked in batches of 40 here, and the scan is cut short after `stopAfter` of them: the scan the caller waits for ends there, as a closed tab
// ends it, and nothing more is kept from it
function interrupt(instance, { stopAfter = Infinity, seen = [] } = {}) {
  const orig = instance.indexer._memo.scanSliced;
  let cut = false, stop;
  const stopped = new Promise((_, no) => { stop = no; });
  stopped.catch(() => {});
  instance.indexer._memo.scanSliced = (priv, events, spent, nu, o = {}) => {
    seen.covered = o.covered;
    return Promise.race([orig(priv, events, spent, nu, {
      ...o, batch: 40,
      onProgress: (p) => {
        if (cut) return;
        seen.push({ upTo: p.upTo, mine: p.mine.map((n) => Number(n.leafIndex)) });
        o.onProgress?.(p);
        if (seen.length >= stopAfter) { cut = true; stop(new Error('cut short')); }
      },
    }), stopped]);
  };
  return () => { instance.indexer._memo.scanSliced = orig; };
}

test('a scan reports how far it got after each batch: a frontier in leaf order and the notes found below it', async () => {
  build();
  const seen = [];
  const undo = interrupt(ux, { seen });
  const r = await ux.balance(mine.priv, { cbtc: false, bridge: false });
  undo();
  assert.deepEqual(idx(r), WANT, 'the whole scan finds all four');
  assert.ok(seen.length >= 3, `reported ${seen.length} times for 620 leaves in batches of 40`);
  assert.ok(seen.every((p, i) => i === 0 || p.upTo > seen[i - 1].upTo), 'the frontier only moves forward');
  assert.ok(seen.every((p) => p.mine.every((i) => i < p.upTo)), 'every note reported is below the frontier');
  assert.deepEqual(seen.at(-1).mine, [OLD, ...MID].filter((i) => i < seen.at(-1).upTo), 'and every note below it is reported');
});

test('a scan cut short leaves a partial checkpoint, and the next scan starts from it and finds everything', async () => {
  store.clear();
  build();
  const seen = [];
  const undo = interrupt(ux, { stopAfter: 9, seen });   // nine batches of 40: it has got to leaf 360
  await assert.rejects(ux.balance(mine.priv, { cbtc: false, bridge: false }), /cut short/);
  undo();
  assert.equal(cks().length, 1, 'the cut-short scan kept a checkpoint');
  const ck = ckOf();
  assert.equal(ck.upTo, 256, `a partial one, at the last whole block of 256 it had passed (${ck.upTo} of ${N})`);
  assert.deepEqual(ck.mine, [OLD], 'with the notes found below it');
  // a new page: nothing in memory, the checkpoint in the browser's store
  build();
  const again = [];
  const undo2 = interrupt(ux, { seen: again });
  const r = await ux.balance(mine.priv, { cbtc: false, bridge: false });
  undo2();
  assert.deepEqual(idx(r), WANT, 'the resumed scan finds all four, the one before the checkpoint too');
  assert.equal(again.covered?.upTo, 256, 'it began where the cut-short one was kept');
  assert.equal(ckOf().upTo, N, 'and the checkpoint is now of the whole chain');
  // and that checkpoint, whose digest was carried on from the partial one, is the one a fresh read of the same leaves makes
  build();
  const third = [];
  const undo3 = interrupt(ux, { seen: third });
  const r3 = await ux.balance(mine.priv, { cbtc: false, bridge: false });
  undo3();
  assert.equal(third.covered?.upTo, N, 'a third scan trusts it: the digest is the same as one made from the leaves alone');
  assert.deepEqual(idx(r3), WANT);
});

test('a checkpoint made of other leaves is not trusted', async () => {
  const stale = ckOf();
  store.set(cks()[0], JSON.stringify({ ...stale, upTo: 256, digest: '00'.repeat(32), mine: [] }));
  build();
  const seen = [];
  const undo = interrupt(ux, { seen });
  const r = await ux.balance(mine.priv, { cbtc: false, bridge: false });
  undo();
  assert.deepEqual(idx(r), WANT, 'every leaf is opened again');
  assert.equal(seen.covered, null, 'the digest said the leaves below it are not these');
});

test('a quick read keeps no checkpoint at all, partial or not', async () => {
  store.clear();
  build();
  const seen = [];
  const undo = interrupt(ux, { seen });
  await ux.balance(mine.priv, { cbtc: false, bridge: false, recent: 60 });
  undo();
  assert.equal(cks().length, 0);
});
