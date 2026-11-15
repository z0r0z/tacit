// The reflection's tracked notes, checked against the attested digest (dapp/tracked-notes.js, GET /reflection/live), and the
// wallet validator crediting a tracked note without walking its history (dapp/tacit.js validateOutpoint).
// Run: node tests/tracked-notes.test.mjs
import { createHash } from 'node:crypto';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { keccak_256 } from '@noble/hashes/sha3';
import * as secp from '@noble/secp256k1';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { loadTrackedNotes } from '../dapp/tracked-notes.js';
import { modN, pointToBytes, bigintToBytes32, randomScalar, _bpGens, bpRangeAggProve } from './bulletproofs.mjs';
import { assetIdFor, encodeCEtchPayload, encodeCXferPayload, computeKernelMsg, signSchnorr } from './composition.mjs';
import { encodeEnvelopeScript } from './indexer.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok' : 'FAIL'} - ${m}`); c ? pass++ : fail++; };
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const rev = (h) => h.match(/../g).reverse().join('');
const hex32 = (n) => '0x' + n.toString(16).padStart(64, '0');

// ── the live set against the digest ──
const TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const NOTE_TXID = 'ab'.repeat(31) + '01';
const triples = [
  [pool.outpointKey('0x' + rev(NOTE_TXID), 1), hex32(0x1234n), '0x' + TAC, hex32(0n), 0],
  [pool.outpointKey('0x' + rev('cd'.repeat(32)), 0), hex32(0x5678n), '0x' + TAC, hex32(0n), 1],
].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
const ix = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256 });
ix.load({ liveTriples: triples, height: 970000 });
const onChain = ix.digest();
const answer = { network: 'mainnet', height: 970000, parts: ix.digestParts(), liveTriples: triples };
const load = (live, digest = onChain) => loadTrackedNotes({ pool, keccak256: keccak_256, fetchLive: async () => live, attestedDigest: async () => digest });

{
  const t = await load(answer);
  const n = t.get(NOTE_TXID, 1);
  ok(t.size === 2 && t.height === 970000 && n && n.asset === TAC && n.commitmentHash === hex32(0x1234n).slice(2) && n.bound === false,
    'a live set whose root and size are the digest words, hashing to the attested digest, is accepted, and a note is found by its display txid');
  ok(t.get(NOTE_TXID, 0) === null && t.get('cd'.repeat(32), 0).bound === true, 'an outpoint not in the set is not found, and a bound note says so');
}
for (const [label, live, digest] of [
  ['a set missing a note', { ...answer, liveTriples: triples.slice(1) }],
  ['a note with another commitment', { ...answer, liveTriples: triples.map((t, i) => (i ? t : [t[0], hex32(0x9999n), t[2], t[3], t[4]])) }],
  ['words that do not hash to the attested digest', { ...answer, parts: answer.parts.map((w, i) => (i === 8 ? hex32(1n) : w)) }],
  ['a digest the pool has not attested', answer, hex32(7n)],
  ['an empty digest read', answer, '0x'],
]) {
  let refused = false;
  try { await load(live, digest); } catch { refused = true; }
  ok(refused, `refused: ${label}`);
}

// ── the API's answer is one the wallet accepts ──
{
  const { default: worker } = await import('../worker/src/index.js');
  const raw = JSON.stringify({ snapshot: { liveTriples: triples, height: 970000 } });
  const env = { REGISTRY_KV: { get: async (k) => (k === 'reflection:scan:mainnet' ? raw : null), put: async () => {} } };
  const res = await worker.fetch(new Request('https://api.tacit.finance/reflection/live?network=mainnet'), env, { waitUntil() {} });
  const body = await res.json();
  const t = await load(body).catch(() => null);
  ok(res.status === 200 && t && t.size === 2, 'GET /reflection/live answers a set the wallet checks against the attested digest');
}

// ── the validator: a tracked note is credited without its history, and only at its attested commitment and asset ──
const store = new Map();
const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : el()), apply: () => el(), set: () => true });
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el(), head: el(), documentElement: el() };
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', hash: '', search: '', pathname: '/', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', onLine: true, language: 'en' }, configurable: true }); } catch {}
globalThis.addEventListener = () => {};
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
const T = await import('../dapp/tacit.js');
_bpGens();

let counter = 0;
const nextTxid = () => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(28, ++counter, false); return bytesToHex(b); };
function newChain() {
  const txs = new Map(), asked = [];
  const fetch = async (id) => { asked.push(id); return txs.get(id) || null; };
  const envelopeTx = (envelope, inputs) => ({
    vin: [
      { txid: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), vout: 0, witness: [bytesToHex(new Uint8Array(64)), bytesToHex(envelope), bytesToHex(new Uint8Array(33))] },
      ...inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: [bytesToHex(new Uint8Array(64)), bytesToHex(new Uint8Array(33))] })),
    ],
  });
  const etch = (supply) => {
    const blinding = randomScalar();
    const { proof, commitments } = bpRangeAggProve([supply], [blinding]);
    const payload = encodeCEtchPayload({ ticker: 'TST', decimals: 0, commitment: pointToBytes(commitments[0]), rangeproof: proof, encryptedAmount: new Uint8Array(8), mintAuthority: null });
    const txid = nextTxid();
    txs.set(txid, envelopeTx(encodeEnvelopeScript(crypto.getRandomValues(new Uint8Array(32)), payload), []));
    return { txid, vout: 0, amount: supply, blinding, assetIdHex: bytesToHex(assetIdFor(txid, 0)) };
  };
  const xfer = (assetIdHex, inputs, amounts, { skew = 0n } = {}) => {
    const outs = amounts.map((amount) => ({ amount, blinding: randomScalar() }));
    const { proof, commitments } = bpRangeAggProve(outs.map((o) => o.amount), outs.map((o) => o.blinding));
    const commits = commitments.map(pointToBytes);
    const excess = modN(outs.reduce((s, o) => modN(s + o.blinding), 0n) - inputs.reduce((s, i) => modN(s + i.blinding), 0n) + skew);
    const msg = computeKernelMsg(hexToBytes(assetIdHex), inputs.map((i) => ({ txid: i.txid, vout: i.vout })), commits);
    const payload = encodeCXferPayload({ assetId: hexToBytes(assetIdHex), kernelSig: signSchnorr(msg, bigintToBytes32(excess)), outputs: commits.map((commitment) => ({ commitment, encryptedAmount: new Uint8Array(8) })), rangeproof: proof });
    const txid = nextTxid();
    txs.set(txid, envelopeTx(encodeEnvelopeScript(crypto.getRandomValues(new Uint8Array(32)), payload), inputs));
    return outs.map((o, vout) => ({ txid, vout, amount: o.amount, blinding: o.blinding, commitment: commits[vout] }));
  };
  return { fetch, etch, xfer, asked };
}
const chOf = (commitment) => { const a = secp.ProjectivePoint.fromHex(bytesToHex(commitment)).toAffine(); const be = (n) => n.toString(16).padStart(64, '0'); return bytesToHex(keccak_256(hexToBytes(be(a.x) + be(a.y)))); };
const trackedOf = (entries) => ({ get: (txid, vout) => entries.get(`${txid}:${vout}`) || null });

{
  const c = newChain(), e = c.etch(1000n);
  T.registerAsset({ assetIdHex: e.assetIdHex, ticker: 'TST', decimals: 0, etchTxid: e.txid, etchVout: 0 });
  const [a] = c.xfer(e.assetIdHex, [e], [1000n]);
  const [b] = c.xfer(e.assetIdHex, [a], [1000n]);
  T._testSetTrackedNotes(trackedOf(new Map([[`${a.txid}:0`, { commitmentHash: chOf(a.commitment), asset: e.assetIdHex, bound: false }]])));
  const set = new Map();
  const valid = await T.validateOutpoint(b.txid, 0, set, c.fetch);
  ok(valid === true && !c.asked.includes(e.txid), 'a note spending a tracked note validates without its etch (or anything before the tracked note) being read');
  ok(set.get(`${a.txid}:0`) === true, 'the tracked note itself is credited');
}
{
  const c = newChain(), e = c.etch(1000n);
  T.registerAsset({ assetIdHex: e.assetIdHex, ticker: 'TST', decimals: 0, etchTxid: e.txid, etchVout: 0 });
  const [a] = c.xfer(e.assetIdHex, [e], [1000n]);
  T._testSetTrackedNotes(trackedOf(new Map([[`${a.txid}:0`, { commitmentHash: 'ff'.repeat(32), asset: e.assetIdHex, bound: false }]])));
  const valid = await T.validateOutpoint(a.txid, 0, new Map(), c.fetch);
  ok(valid === true && c.asked.includes(e.txid), 'a note whose commitment is not the attested one is walked as before (and still validates on its own history)');
}
{
  const c = newChain(), e = c.etch(1000n);
  T.registerAsset({ assetIdHex: e.assetIdHex, ticker: 'TST', decimals: 0, etchTxid: e.txid, etchVout: 0 });
  const [a] = c.xfer(e.assetIdHex, [e], [1000n]);
  T._testSetTrackedNotes(trackedOf(new Map([[`${a.txid}:0`, { commitmentHash: chOf(a.commitment), asset: 'ee'.repeat(32), bound: false }]])));
  await T.validateOutpoint(a.txid, 0, new Map(), c.fetch);
  ok(c.asked.includes(e.txid), 'a tracked entry naming another asset is not credited');
  const c2 = newChain(), e2 = c2.etch(1000n);
  T.registerAsset({ assetIdHex: e2.assetIdHex, ticker: 'TST', decimals: 0, etchTxid: e2.txid, etchVout: 0 });
  const [a2] = c2.xfer(e2.assetIdHex, [e2], [1000n]);
  T._testSetTrackedNotes(trackedOf(new Map([[`${a2.txid}:0`, { commitmentHash: chOf(a2.commitment), asset: e2.assetIdHex, bound: true }]])));
  await T.validateOutpoint(a2.txid, 0, new Map(), c2.fetch);
  ok(c2.asked.includes(e2.txid), 'nor is a bound one');
}
{
  const c = newChain(), e = c.etch(1000n);
  T.registerAsset({ assetIdHex: e.assetIdHex, ticker: 'TST', decimals: 0, etchTxid: e.txid, etchVout: 0 });
  const [a] = c.xfer(e.assetIdHex, [e], [1000n]);
  const [b] = c.xfer(e.assetIdHex, [a], [1001n]);
  T._testSetTrackedNotes(trackedOf(new Map([[`${a.txid}:0`, { commitmentHash: chOf(a.commitment), asset: e.assetIdHex, bound: false }]])));
  ok((await T.validateOutpoint(b.txid, 0, new Map(), c.fetch)) === false, 'a transfer out of a tracked note that does not balance is still refused');
}
{
  const c = newChain(), e = c.etch(1000n);
  const [a] = c.xfer(e.assetIdHex, [e], [1000n]);
  T._testSetTrackedNotes(trackedOf(new Map([[`${a.txid}:0`, { commitmentHash: chOf(a.commitment), asset: e.assetIdHex, bound: false }]])));
  await T.validateOutpoint(a.txid, 0, new Map(), c.fetch);
  ok(c.asked.includes(e.txid), 'an asset the wallet has no name for (other than TAC) is walked, so its etch names it');
  T._testSetTrackedNotes(null);
}

// ── the live set's root in workers (treeWorkers): the same set is accepted, the same sets are refused, and workers that are missing or wrong change nothing ──
{
  const { makeTreeWorkers } = await import('../dapp/confidential-tree-workers.js');
  const { makeTreeCore } = await import('../dapp/confidential-tree-core.js');
  const core = makeTreeCore({ keccak256: keccak_256 });
  const calls = [];
  const stand = ({ corruptLeaf = false } = {}) => makeTreeWorkers({
    available: () => true, count: () => 2, minLeaves: 1, idleMs: 100,
    make: () => ({ onmessage: null, onerror: null, terminate() {}, postMessage(m) {
      calls.push(!!m.pre);
      setTimeout(() => {
        const made = m.pre ? core.hashLeaves(new Uint8Array(m.leaves), m.count) : new Uint8Array(m.leaves);
        if (corruptLeaf) made[0] ^= 1;
        const levels = core.lower(made, m.count, m.h).map((b) => b.buffer);
        this.onmessage({ data: m.pre ? { id: m.id, leaves: made.buffer, levels } : { id: m.id, levels } });
      }, 1);
    } }),
  });
  const withWorkers = (live, treeWorkers, digest = onChain, p = pool) => loadTrackedNotes({ pool: p, keccak256: keccak_256, fetchLive: async () => live, attestedDigest: async () => digest, treeWorkers });
  const t = await withWorkers(answer, stand());
  ok(calls.length > 0 && calls.every(Boolean) && t.size === 2 && t.get(NOTE_TXID, 1)?.commitmentHash === hex32(0x1234n).slice(2), 'a set whose root the workers made is accepted, as the same set is without them');
  let refused = 0;
  for (const live of [{ ...answer, liveTriples: triples.slice(1) }, { ...answer, liveTriples: triples.map((x, i) => (i ? x : [x[0], hex32(0x9999n), x[2], x[3], x[4]])) }]) {
    try { await withWorkers(live, stand()); } catch { refused++; }
  }
  ok(refused === 2, 'a set that is not the attested one is refused with the workers as without them');
  const lying = await withWorkers(answer, stand({ corruptLeaf: true }));
  ok(lying.size === 2, 'workers whose leaf is wrong at its edge are not taken, and the set is checked on the root made here');
  const noRoot = { ...pool, makeLiveUtxoSet: () => { const s = pool.makeLiveUtxoSet(); delete s.rootAsync; return s; } };
  ok((await withWorkers(answer, stand(), onChain, noRoot)).size === 2, 'a pool from before rootAsync is checked as it always was');
  ok((await withWorkers(answer, null)).size === 2, 'no workers: as it always was');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
