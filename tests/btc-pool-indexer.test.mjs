// Bitcoin-native shielded pool indexer: parsers, the Poseidon tree, shield kernel and boundary, spend
// acceptance, undo/rollback/restore, the SQLite store, raw block parsing, canonical shield-input validation
// (recorded signet ancestry + synthetic Tacit txs), an end-to-end replay over synthetic blocks, and real
// Groth16 proofs of spend.circom through the wallet and the pinned verifier. No network.
//   node tests/btc-pool-indexer.test.mjs        (ONLY=<regex> selects tests, TIMING=1 prints per-test time)

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import * as snarkjs from 'snarkjs';
import * as bp from '../worker/src/btc-shielded-pool.js';
import {
  parseBlock, parseTx, decodeEnvelopeScript, txEnvelope, txEnvelopes,
} from '../worker-relay/src/lib/btc-pool-chain.js';
import { openBtcPoolStore } from '../worker-relay/src/lib/btc-pool-store.js';
import { makeBtcPoolVerifier } from '../worker-relay/src/lib/btc-pool-verify.js';
import { createIndexer, createHandler } from '../worker-relay/src/btc-pool-indexer.js';
import { loadTacit, makeShieldInputResolver, TransparentUnavailableError } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';
import { makeGroth16System, vkHash } from '../dapp/btc-pool-zk-prover.js';
import { proveBoundary, encodeBoundary } from '../dapp/btc-pool-zk-boundary.js';
import { bodyHash, assetField, P_FR, L_BJJ } from '../dapp/btc-pool-zk.js';
import { unpackPoint } from '../dapp/amm-bjj.js';
import { bpRangeAggProve } from './bulletproofs.mjs';

// Every fetch tacit.js makes goes through here, so tests can answer worker reads.
const baseFetch = globalThis.fetch;
let fetchHook = null;
globalThis.fetch = (input, init) => (fetchHook && fetchHook(String(input?.url ?? input), init)) || baseFetch(input, init);
const withFetch = async (hook, fn) => { fetchHook = hook; try { return await fn(); } finally { fetchHook = null; } };
const jsonRes = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

const tacit = await loadTacit('signet');
const pool = makeBtcShieldedPool({ secp: rootSecp, keccak256: keccak_256, sha256: nobleSha256 });

const { concat, hexToBytes, bytesToHex, sha256, pointXY, G } = bp;
const N = rootSecp.CURVE.n;
const P = rootSecp.CURVE.p;
const t0 = performance.now();

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── helpers ──
const te = (s) => new TextEncoder().encode(String(s));
const keccak = (...parts) => keccak_256(concat(...parts));
const big = (b) => BigInt('0x' + (bytesToHex(b) || '0'));
const b32 = (n) => hexToBytes(BigInt(n).toString(16).padStart(64, '0'));
const u32le = (v) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const u16le = (v) => Uint8Array.of(v & 0xff, v >> 8);
const u64le = (v) => { const o = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const scalar = (tag) => (big(keccak(te(tag))) % (N - 1n)) + 1n;
const field = (tag) => (big(keccak(te('f' + tag))) % (P_FR - 1n)) + 1n;
const fe = (tag) => b32(field(tag));
const mul = (Pt, k) => { const s = ((BigInt(k) % N) + N) % N; return s === 0n ? bp.ZERO : Pt.multiply(s); };
// Points in the worker module's curve class (its @noble/secp256k1 is a separate install).
const H = bp.pointFromCompressed(pool.H.toRawBytes(true));
const pedersen = (v, r) => mul(H, v).add(mul(G, r));
const compress = (Pt) => Pt.toRawBytes(true);
const tagged = (tag, ...parts) => { const t = sha256(te(tag)); return sha256(t, t, ...parts); };
const dec = (x) => BigInt(x).toString();
let nonX = 5n; while (bp.liftX(b32(nonX))) nonX++;

function schnorrSign(msg, d) {
  d = ((d % N) + N) % N;
  const Pt = mul(G, d);
  const { cx: px, cy: py } = pointXY(Pt);
  if (py[31] & 1) d = N - d;
  let k = big(sha256(b32(d), msg)) % N || 1n;
  const R = mul(G, k);
  const { cx: rx, cy: ry } = pointXY(R);
  if (ry[31] & 1) k = N - k;
  const e = big(tagged('BIP0340/challenge', rx, px, msg)) % N;
  return concat(rx, b32((k + e * d) % N));
}

const ASSET = keccak(te('asset'));
const OTHER_ASSET = keccak(te('other-asset'));
const PROOF = new Uint8Array(256).fill(7);

// Boundaries (C_secp ‖ C_bjj ‖ sigma ‖ BP+) are reused: a shield only needs one opening to the inputs' total,
// an exit one to its value. B5 is also the exit note every seam test spends (5 under B5.r).
function mkBoundary(v, r, tag) {
  const rBjj = (big(keccak(te('rbjj' + tag))) % (L_BJJ - 1n)) + 1n;
  const bd = proveBoundary({ v, rSecp: r, rBjj, seedKey: keccak(te('seed' + tag)) });
  const bytes = encodeBoundary(bd);
  return { v, r, bytes, C: pedersen(v, r), cBjj: unpackPoint(bytes.slice(33, 65)) };
}
const B42 = mkBoundary(42n, scalar('pool42'), '42');
const B5 = mkBoundary(5n, scalar('exit'), '5');
const B5b = mkBoundary(5n, scalar('pool5'), '5b');
// Boundary variants that parse but do not verify.
const flip = (b, i) => { const c = b.slice(); c[i] ^= 1; return c; };
const BAD_SIGMA = flip(B42.bytes, 65 + 40);
const BAD_BPP = flip(B42.bytes, 825 - 20);
const OTHER_CBJJ = (() => { const c = B42.bytes.slice(); c.set(B5.bytes.slice(33, 65), 33); return c; })();

// output = leaf(32) ‖ pk_eph(33) ‖ ct_note(24).
const outBytes = (tag) => concat(fe('leaf' + tag), compress(mul(G, scalar('e' + tag))), keccak(te('ct' + tag)).slice(0, 24));
const leafOf = (o) => o.slice(0, 32);

// 0x6C ‖ asset ‖ n_in ‖ n_out ‖ output×n_out ‖ boundary ‖ kernel_sig ‖ proof_len ‖ proof. inputs [{ value, r,
// outpoint }] open to the boundary's value; the kernel key is r_pool − Σr_in unless `signKey` is given.
function makeShield(inputs, { asset = ASSET, bd = B42, outs = ['s'], signKey, proof = PROOF, boundary, nIn } = {}) {
  const outputs = outs.map((o) => (typeof o === 'string' ? outBytes(o) : o));
  const body = concat(Uint8Array.of(0x6c), asset, Uint8Array.of(nIn ?? inputs.length), Uint8Array.of(outputs.length), ...outputs, boundary ?? bd.bytes);
  const msg = bp.shieldKernelMsg(body, inputs.map((i) => i.outpoint));
  const d = signKey ?? (bd.r - inputs.reduce((s, i) => s + i.r, 0n));
  return { bytes: concat(body, schnorrSign(msg, d), u16le(proof.length), proof), body, outputs };
}

// 0x6D ‖ asset ‖ h_anchor ‖ bind ‖ n_in ‖ nf×n_in ‖ n_out ‖ output×n_out ‖ has_exit ‖ [exit_vout ‖ dest_spk_hash ‖
// boundary] ‖ has_want ‖ [want] ‖ proof_len ‖ proof. `bind` is { txid (display hex), vout }; `want` is
// { vout, value, spkHash }; exit is { vout, destHash, boundary? }.
const bindBytes = (b) => (b ? concat(hexToBytes(b.txid).reverse(), u32le(b.vout)) : new Uint8Array(36));
function spendBytes({ asset = ASSET, hAnchor, bind = null, nfs, pay = [], exit = null, want = null, proof = PROOF, proofLen }) {
  const parts = [Uint8Array.of(0x6d), asset, u32le(hAnchor), bindBytes(bind), Uint8Array.of(nfs.length), ...nfs, Uint8Array.of(pay.length), ...pay];
  if (exit) parts.push(Uint8Array.of(1), u32le(exit.vout), exit.destHash, exit.boundary ?? B5.bytes);
  else parts.push(Uint8Array.of(0));
  if (want) parts.push(Uint8Array.of(1), u32le(want.vout), u64le(want.value), want.spkHash);
  else parts.push(Uint8Array.of(0));
  parts.push(u16le(proofLen ?? proof.length), proof);
  return concat(...parts);
}
const PRE = 1 + 32 + 4 + 36;
const OUT = 89;
const EXIT = 4 + 32 + 825;
const nf = (t) => fe('nf' + t);

// ── raw tx / block builders ──
function varint(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return concat(Uint8Array.of(0xfe), u32le(n));
}
function push(data) {
  if (data.length === 0) return Uint8Array.of(0);
  if (data.length <= 75) return concat(Uint8Array.of(data.length), data);
  if (data.length <= 255) return concat(Uint8Array.of(0x4c, data.length), data);
  return concat(Uint8Array.of(0x4d), u16le(data.length), data);
}
function envelopeScript(payload, key = new Uint8Array(32).fill(9)) {
  const parts = [push(key), Uint8Array.of(0xac, 0x00, 0x63), push(te('TACIT')), push(Uint8Array.of(1))];
  for (let i = 0; i < payload.length; i += 520) parts.push(push(payload.subarray(i, i + 520)));
  parts.push(Uint8Array.of(0x68));
  return concat(...parts);
}
let nonceCtr = 0;
// `witnesses[i]` is vin[i]'s witness stack; `witness0` is shorthand for vin[0]'s alone.
function serTx({ inputs, outputs, witness0 = null, witnesses = null }) {
  const wits = witnesses || (witness0 ? [witness0] : null);
  const segwit = !!wits;
  const parts = [u32le(2)];
  if (segwit) parts.push(Uint8Array.of(0, 1));
  parts.push(varint(inputs.length));
  for (const i of inputs) parts.push(hexToBytes(i.txid).reverse(), u32le(i.vout), Uint8Array.of(0), u32le(0xffffffff));
  parts.push(varint(outputs.length));
  for (const o of outputs) parts.push(u64le(o.value ?? 1000), varint(o.spk.length), o.spk);
  if (segwit) {
    for (let i = 0; i < inputs.length; i++) {
      const st = wits[i] || [];
      parts.push(varint(st.length));
      for (const w of st) parts.push(varint(w.length), w);
    }
  }
  parts.push(u32le(0));
  const raw = concat(...parts);
  return { raw, txid: parseTx(raw).tx.txid };
}
const fakeOutpoint = (tag) => ({ txid: bytesToHex(keccak(te('op' + tag))), vout: 0 });
const envWitness = (payload) => [new Uint8Array(64), envelopeScript(payload), new Uint8Array(33).fill(0xc0)];
// A carrier whose inputs carry `payloads[i]` (null: a plain key-path input).
function multiCarrier(payloads, { outputs = [{ spk: Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(1)) }] } = {}) {
  return serTx({
    inputs: payloads.map((_, i) => fakeOutpoint('multi' + nonceCtr++ + ':' + i)),
    outputs,
    witnesses: payloads.map((p) => (p ? envWitness(p) : [new Uint8Array(64)])),
  });
}
function carrier(payload, { inputs = [], outputs = [{ spk: Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(1)) }] } = {}) {
  return serTx({
    inputs: [fakeOutpoint('commit' + nonceCtr++), ...inputs],
    outputs,
    witness0: envWitness(payload),
  });
}
function sha256d(b) { return nobleSha256(nobleSha256(b)); }
function merkle(level) {
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(concat(level[i], level[i + 1] || level[i])));
    level = next;
  }
  return level;
}
function coinbase(height, txs) {
  const outputs = [{ spk: concat(Uint8Array.of(0x6a), u32le(height)) }];
  if (!txs.length) return serTx({ inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff }], outputs });
  const wroot = merkle([new Uint8Array(32), ...txs.map((t) => sha256d(t.raw))])[0];
  outputs.push({ spk: concat(Uint8Array.of(0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed), sha256d(concat(wroot, new Uint8Array(32)))) });
  return serTx({ inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff }], outputs, witness0: [new Uint8Array(32)] });
}
// Regtest-style proof-of-work limit, so headers are ground in a couple of tries.
const TEST_BITS = 0x207fffff;
const TEST_CHAIN = { powLimitBits: TEST_BITS, checkpoint: null };
const meetsTarget = (header, bits = TEST_BITS) => BigInt('0x' + bytesToHex(sha256d(header).reverse())) <= BigInt(bits & 0x7fffff) << BigInt(8 * ((bits >>> 24) - 3));
function mineHeader(prevHash, root, time, bits = TEST_BITS) {
  for (;;) {
    const header = concat(u32le(0x20000000), hexToBytes(prevHash).reverse(), root, u32le(time), u32le(bits), u32le(nonceCtr++));
    if (meetsTarget(header, bits)) return header;
  }
}
function buildBlock(prevHash, height, txs, { bits = TEST_BITS } = {}) {
  const all = [coinbase(height, txs), ...txs];
  const level = merkle(all.map((t) => hexToBytes(t.txid).reverse()));
  const header = mineHeader(prevHash, level[0], 1700000000 + height, bits);
  const raw = concat(header, varint(all.length), ...all.map((t) => t.raw));
  return { raw, hash: bytesToHex(sha256d(header).reverse()), txs: all, header };
}

// Transparent Tacit txs built with the dapp's own encoders and a real range prover, so they pass (or, when
// forged, fail) the canonical validator exactly as on chain.
const noAmount = new Uint8Array(8);
function etchTx(value, r, { badProof = false } = {}) {
  const { proof } = bpRangeAggProve([badProof ? value + 1n : value], [r]);
  const payload = tacit.encodeCEtchPayload({ ticker: 'TP', decimals: 0, commitment: compress(pedersen(value, r)), rangeproof: proof, encryptedAmount: noAmount });
  const t = carrier(payload);
  return { ...t, asset: tacit.assetIdFor(t.txid, 0) };
}
// ins [{ outpoint, value, r }] → outs [{ value, r }]. `forge` signs the kernel with an unrelated key.
function cxferTx(asset, ins, outs, { forge = false } = {}) {
  const Cs = outs.map((o) => compress(pedersen(o.value, o.r)));
  const { proof } = bpRangeAggProve(outs.map((o) => o.value), outs.map((o) => o.r));
  const msg = tacit.computeKernelMsg(asset, ins.map((i) => i.outpoint), Cs, 0n);
  const d = outs.reduce((a, o) => a + o.r, 0n) - ins.reduce((a, i) => a + i.r, 0n);
  const kernelSig = schnorrSign(msg, forge ? scalar('forged') : d);
  const payload = tacit.encodeCXferPayload({ assetId: asset, kernelSig, outputs: Cs.map((commitment) => ({ commitment, encryptedAmount: noAmount })), rangeproof: proof });
  return carrier(payload, { inputs: ins.map((i) => i.outpoint), outputs: outs.map((_, k) => ({ spk: Uint8Array.of(0x51, k) })) });
}
const notFound = () => Object.assign(new Error('404'), { notFound: true });

// ── crypto / tree ──
test('H is the SPEC §2.1 generator', () => {
  const h = bytesToHex(compress(H));
  assert.ok(h.startsWith('02bd7bf4') && h.endsWith('5e56'), h);
});

test('BIP-340 verify matches the test signer and rejects tampering', () => {
  const msg = sha256(te('m'));
  const d = scalar('k');
  const sig = schnorrSign(msg, d);
  const px = pointXY(mul(G, d)).cx;
  assert.ok(bp.bip340Verify(sig, msg, px));
  assert.ok(!bp.bip340Verify(flip(sig, 63), msg, px));
  assert.ok(!bp.bip340Verify(sig, sha256(msg), px));
  const hi = sig.slice(); hi.set(b32(N), 32);
  assert.ok(!bp.bip340Verify(hi, msg, px));
  assert.ok(!bp.bip340Verify(sig, msg, b32(nonX)), 'key not on curve');
});

test('PoseidonTree matches btc-pool-zk tree() (roots, paths, prefix paths) and truncates exactly', () => {
  const zk = pool.zk;
  assert.deepEqual(bp.ZEROS_F, zk.zeros);
  const t = new bp.PoseidonTree();
  assert.equal(big(t.root()), zk.tree([]).root);
  const leaves = [];
  const roots = [bytesToHex(t.root())];
  for (let i = 0; i < 11; i++) {
    leaves.push(field('tl' + i));
    assert.equal(t.append(b32(leaves[i])), i);
    const ref = zk.tree(leaves);
    assert.equal(big(t.root()), ref.root);
    roots.push(bytesToHex(t.root()));
    for (const j of new Set([0, i, i >> 1])) {
      const { root, path } = t.rootAndPath(j);
      assert.equal(big(root), ref.root);
      assert.deepEqual(path.map(big), ref.path(j));
      assert.equal(big(bp.rootFromPath(t.leaf(j), j, path)), ref.root);
      assert.equal(zk.rootFromPath(leaves[j], j, ref.path(j)), ref.root);
    }
  }
  for (let n = 1; n <= 11; n++) {
    const ref = zk.tree(leaves.slice(0, n));
    for (let j = 0; j < n; j++) {
      const { root, path } = t.rootAndPathAt(j, n);
      assert.equal(big(root), ref.root, `prefix ${n} leaf ${j}`);
      assert.deepEqual(path.map(big), ref.path(j));
    }
  }
  assert.throws(() => t.rootAndPathAt(11, 11), /prefix/);
  assert.throws(() => t.rootAndPathAt(0, 12), /prefix/);
  for (let n = 11; n >= 0; n--) { t.truncate(n); assert.equal(bytesToHex(t.root()), roots[n]); assert.equal(t.size, n); }
  assert.throws(() => t.truncate(1), /beyond/);
  assert.throws(() => t.append(b32(P_FR)), /field element/);
  t.append(b32(P_FR - 1n));
});

test('PoseidonTree matches the zk reference vectors (tests/vectors/btc-pool-zk-vectors.json)', () => {
  const V = JSON.parse(readFileSync(new URL('./vectors/btc-pool-zk-vectors.json', import.meta.url), 'utf8')).tree;
  const t = new bp.PoseidonTree();
  for (const l of V.leaves) t.append(b32(BigInt(l)));
  assert.equal(dec(big(t.root())), V.root);
  assert.equal(dec(bp.ZEROS_F[32]), V.zeros32);
  for (const p of V.paths) assert.deepEqual(t.rootAndPath(p.index).path.map((x) => dec(big(x))), p.path);
});

test('nullifier binds nk_note, leaf and leaf position', () => {
  const leaf = fe('nl'), nk = 7n;
  const a = pool.nullifier(nk, leaf, 0), b = pool.nullifier(nk, leaf, 1), c = pool.nullifier(8n, leaf, 0);
  assert.notEqual(a, b); assert.notEqual(a, c);
  assert.equal(BigInt(a), pool.zk.H([nk, big(leaf), 0n]));
});

test('envelopePublics: root, bodyHash, asset, nf[2], outLeaf[3], exitC, depC as decimal strings', () => {
  const s = bp.parseSpend(spendBytes({ hAnchor: 9, nfs: [nf(1)], pay: [outBytes('p')] }));
  const root = fe('root');
  const pv = bp.envelopePublics(s, { root });
  assert.equal(pv.length, 12);
  assert.deepEqual(pv, [big(root), bodyHash(s.body), assetField(ASSET), big(nf(1)), 0n, big(leafOf(outBytes('p'))), 0n, 0n, 0n, 1n, 0n, 1n].map(dec));
  const ex = bp.parseSpend(spendBytes({ hAnchor: 9, nfs: [nf(1), nf(2)], exit: { vout: 0, destHash: new Uint8Array(32) } }));
  const pe = bp.envelopePublics(ex, { root, boundaryC: B5.cBjj });
  assert.deepEqual(pe.slice(3, 5), [nf(1), nf(2)].map((x) => dec(big(x))));
  assert.deepEqual(pe.slice(5, 8), ['0', '0', '0']);
  assert.deepEqual(pe.slice(8), [...B5.cBjj, 0n, 1n].map(dec));
  const sh = bp.parseShield(makeShield([inNote('a', 42n)], { outs: ['x', 'y'] }).bytes);
  const ps = bp.envelopePublics(sh, { root: fe('ignored'), boundaryC: B42.cBjj });
  assert.deepEqual(ps, [0n, bodyHash(sh.body), assetField(ASSET), 0n, 0n, big(leafOf(outBytes('x'))), big(leafOf(outBytes('y'))), 0n, 0n, 1n, ...B42.cBjj].map(dec));
});

// ── parsers ──
function inNote(tag, value) { return { value, r: scalar('r' + tag), outpoint: fakeOutpoint(tag) }; }

test('parseShield: valid envelope (1 and 3 outputs, 8 inputs); body excludes kernel_sig', () => {
  const s = makeShield([inNote('a', 10n), inNote('b', 32n)]);
  assert.equal(s.bytes.length, 35 + OUT + 825 + 64 + 2 + 256);
  const p = bp.parseShield(s.bytes);
  assert.ok(p);
  assert.equal(p.kind, 'shield');
  assert.equal(p.nIn, 2);
  assert.deepEqual(p.asset, ASSET);
  assert.equal(p.outputs.length, 1);
  assert.deepEqual(p.outputs[0].leaf, leafOf(s.outputs[0]));
  assert.deepEqual(p.outputs[0].pkEph, s.outputs[0].slice(32, 65));
  assert.deepEqual(p.outputs[0].ctNote, s.outputs[0].slice(65));
  assert.deepEqual(p.body, s.body);
  assert.equal(p.body.length, 35 + OUT + 825);
  assert.deepEqual(p.boundary.cSecp, B42.bytes.slice(0, 33));
  assert.equal(p.kernelSig.length, 64);
  assert.deepEqual(p.proof, PROOF);
  assert.deepEqual(bp.parseEnvelope(s.bytes), p);
  const three = bp.parseShield(makeShield([inNote('a', 42n)], { outs: ['x', 'y', 'z'] }).bytes);
  assert.equal(three.outputs.length, 3);
  assert.ok(bp.parseShield(makeShield([inNote('a', 42n)], { nIn: 8 }).bytes), 'n_in 8');
  assert.ok(bp.parseShield(makeShield([inNote('a', 42n)], { proof: new Uint8Array(0) }).bytes), 'empty proof');
  assert.ok(bp.parseShield(makeShield([inNote('a', 42n)], { proof: new Uint8Array(4096) }).bytes), 'proof 4096');
  // The boundary's C_bjj and proofs are checked on acceptance, not on parse.
  assert.ok(bp.parseShield(makeShield([inNote('a', 42n)], { boundary: BAD_SIGMA }).bytes));
});

test('parseShield: every malformed case', () => {
  const s = makeShield([inNote('a', 42n)]);
  const good = s.bytes;
  const mut = (off, val) => { const b = good.slice(); b[off] = val; return b; };
  const setAt = (off, bytes) => { const b = good.slice(); b.set(bytes, off); return b; };
  const O = { nIn: 33, nOut: 34, leaf: 35, eph: 67, bd: 35 + OUT, sig: 35 + OUT + 825 };
  O.len = O.sig + 64;
  assert.equal(bp.parseShield(good.slice(0, good.length - 1)), null, 'short');
  assert.equal(bp.parseShield(concat(good, Uint8Array.of(0))), null, 'trailing');
  assert.equal(bp.parseShield(mut(0, 0x6d)), null, 'opcode');
  assert.equal(bp.parseShield(mut(O.nIn, 0)), null, 'n_in 0');
  assert.equal(bp.parseShield(mut(O.nIn, 9)), null, 'n_in 9');
  assert.equal(bp.parseShield(mut(O.nOut, 0)), null, 'n_out 0');
  assert.equal(bp.parseShield(mut(O.nOut, 4)), null, 'n_out 4');
  assert.equal(bp.parseShield(mut(O.nOut, 2)), null, 'n_out 2 with one output');
  assert.equal(bp.parseShield(setAt(O.leaf, b32(P_FR))), null, 'leaf = p');
  assert.equal(bp.parseShield(setAt(O.leaf, new Uint8Array(32).fill(0xff))), null, 'leaf >= p');
  assert.equal(bp.parseShield(setAt(O.leaf, new Uint8Array(32))), null, 'leaf 0');
  assert.ok(bp.parseShield(setAt(O.leaf, b32(P_FR - 1n))), 'leaf p - 1');
  assert.equal(bp.parseShield(mut(O.eph, 0x04)), null, 'pk_eph prefix');
  assert.equal(bp.parseShield(setAt(O.eph + 1, b32(P + 2n))), null, 'pk_eph x >= p');
  assert.equal(bp.parseShield(setAt(O.eph + 1, b32(nonX))), null, 'pk_eph not on curve');
  assert.equal(bp.parseShield(mut(O.bd, 0x05)), null, 'boundary C_secp prefix');
  assert.equal(bp.parseShield(setAt(O.bd + 1, b32(nonX))), null, 'boundary C_secp not on curve');
  assert.equal(bp.parseShield(setAt(O.bd + 1, b32(P))), null, 'boundary C_secp x >= p');
  assert.equal(bp.parseShield(makeShield([inNote('a', 42n)], { proof: new Uint8Array(4097) }).bytes), null, 'proof 4097');
  assert.equal(bp.parseShield(setAt(O.len, u16le(255))), null, 'proof_len short of proof');
  assert.equal(bp.parseShield(setAt(O.len, u16le(257))), null, 'proof_len beyond proof');
  for (const cut of [1, 33, 34, 35, O.eph, O.bd, O.bd + 100, O.sig, O.sig + 63, O.len, O.len + 1]) assert.equal(bp.parseShield(good.slice(0, cut)), null, `truncated at ${cut}`);
  assert.equal(bp.parseEnvelope(Uint8Array.of(0x23, 1, 2)), null, 'other opcode');
  assert.equal(bp.parseEnvelope(new Uint8Array(0)), null, 'empty');
});

test('parseSpend: valid pay (1/1, 2/2, 1/3), exit, partial exit, bind, want; body excludes proof_len', () => {
  const one = spendBytes({ hAnchor: 100, nfs: [nf(1)], pay: [outBytes('p')] });
  const p1 = bp.parseSpend(one);
  assert.ok(p1);
  assert.equal(p1.kind, 'spend');
  assert.equal(p1.hAnchor, 100);
  assert.equal(p1.outputs.length, 1);
  assert.deepEqual(p1.outputs[0].leaf, leafOf(outBytes('p')));
  assert.deepEqual(p1.nullifiers, [nf(1)]);
  assert.equal(p1.exit, null);
  assert.equal(p1.body.length, one.length - 2 - 256);
  assert.equal(p1.body.length, PRE + 1 + 32 + 1 + OUT + 1 + 1);
  assert.equal(p1.bind, null); assert.equal(p1.want, null);
  assert.deepEqual(p1.proof, PROOF);
  const two = bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1), nf(2)], pay: [outBytes('p'), outBytes('q')] }));
  assert.equal(two.nullifiers.length, 2); assert.equal(two.outputs.length, 2);
  const three = bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [outBytes('p'), outBytes('q'), outBytes('r')] }));
  assert.equal(three.outputs.length, 3);
  const ex = bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 3, destHash: sha256(Uint8Array.of(1)) } }));
  assert.equal(ex.outputs.length, 0); assert.equal(ex.exit.exitVout, 3);
  assert.deepEqual(ex.exit.destSpkHash, sha256(Uint8Array.of(1)));
  assert.deepEqual(ex.exit.boundary.cSecp, B5.bytes.slice(0, 33));
  assert.deepEqual(ex.exit.boundary.cBjj, B5.bytes.slice(33, 65));
  assert.equal(ex.body.length, PRE + 1 + 32 + 1 + 1 + EXIT + 1);
  const partial = bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1), nf(2)], pay: [outBytes('p')], exit: { vout: 70000, destHash: new Uint8Array(32) } }));
  assert.equal(partial.outputs.length, 1); assert.equal(partial.exit.exitVout, 70000);
  assert.ok(bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 0, destHash: new Uint8Array(32) }, proof: new Uint8Array(4096) })), 'proof 4096');
  assert.ok(bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 0, destHash: new Uint8Array(32) }, proof: new Uint8Array(0) })), 'empty proof');
  assert.ok(bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [b32(P_FR - 1n)], pay: [outBytes('p')] })), 'nf p - 1');
  assert.ok(bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 0, destHash: new Uint8Array(32), boundary: BAD_BPP } })), 'boundary proofs are checked on acceptance');
  // bind in display order; want with a u64 value.
  const bound = bp.parseSpend(spendBytes({ hAnchor: 7, bind: { txid: '12'.repeat(31) + '34', vout: 70001 }, nfs: [nf(1)], pay: [outBytes('p')] }));
  assert.deepEqual(bound.bind, { txid: '12'.repeat(31) + '34', vout: 70001 });
  assert.equal(bound.body[37], 0x34, 'txid in input byte order on the wire');
  const w = bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1)], pay: [outBytes('p')], exit: { vout: 0, destHash: new Uint8Array(32) }, want: { vout: 2, value: 2n ** 64n - 1n, spkHash: sha256(Uint8Array.of(9)) } }));
  assert.deepEqual([w.want.vout, w.want.value], [2, 2n ** 64n - 1n]);
  assert.deepEqual(w.want.spkHash, sha256(Uint8Array.of(9)));
  assert.equal(w.body.length, PRE + 1 + 32 + 1 + OUT + 1 + EXIT + 1 + 44);
});

test('parseSpend: every malformed case', () => {
  const pay = [outBytes('p')];
  const good = spendBytes({ hAnchor: 100, nfs: [nf(1)], pay });
  const mut = (off, val) => { const b = good.slice(); b[off] = val; return b; };
  const setAt = (off, bytes) => { const b = good.slice(); b.set(bytes, off); return b; };
  const NF = PRE + 1, NOUT = NF + 32, OUT0 = NOUT + 1, HAS_EXIT = OUT0 + OUT, HAS_WANT = HAS_EXIT + 1;
  assert.equal(bp.parseSpend(mut(0, 0x6c)), null, 'opcode');
  assert.equal(bp.parseSpend(mut(PRE, 0)), null, 'n_in 0');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1), nf(2), nf(3)], pay })), null, 'n_in 3');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [pay[0], pay[0], pay[0], pay[0]] })), null, 'n_out 4');
  assert.equal(bp.parseSpend(mut(NOUT, 4)), null, 'n_out byte 4');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)] })), null, 'no output and no exit');
  assert.equal(bp.parseSpend(setAt(NF, new Uint8Array(32))), null, 'nf 0');
  assert.equal(bp.parseSpend(setAt(NF, b32(P_FR))), null, 'nf = p');
  assert.equal(bp.parseSpend(setAt(NF, new Uint8Array(32).fill(0xff))), null, 'nf >= p');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1), new Uint8Array(32)], pay })), null, 'second nf 0');
  assert.equal(bp.parseSpend(setAt(OUT0, b32(P_FR))), null, 'leaf = p');
  assert.equal(bp.parseSpend(setAt(OUT0, new Uint8Array(32))), null, 'leaf 0');
  assert.equal(bp.parseSpend(mut(OUT0 + 32, 0x05)), null, 'pk_eph prefix');
  assert.equal(bp.parseSpend(setAt(OUT0 + 33, b32(P))), null, 'pk_eph x >= p');
  assert.equal(bp.parseSpend(setAt(OUT0 + 33, b32(nonX))), null, 'pk_eph not on curve');
  assert.equal(bp.parseSpend(mut(HAS_EXIT, 2)), null, 'has_exit 2');
  assert.equal(bp.parseSpend(mut(HAS_EXIT, 1)), null, 'has_exit 1 without exit bytes');
  assert.equal(bp.parseSpend(mut(HAS_WANT, 2)), null, 'has_want 2');
  assert.equal(bp.parseSpend(mut(HAS_WANT, 0xff)), null, 'has_want 0xff');
  assert.equal(bp.parseSpend(mut(HAS_WANT, 1)), null, 'has_want 1 without want bytes');
  const withWant = spendBytes({ hAnchor: 1, nfs: [nf(1)], pay, want: { vout: 1, value: 5n, spkHash: new Uint8Array(32) }, proof: new Uint8Array(0) });
  for (let cut = 3; cut <= 2 + 44; cut++) assert.equal(bp.parseSpend(concat(withWant.slice(0, withWant.length - cut), u16le(0))), null, `want truncated by ${cut - 2}`);
  const wantOff = withWant.slice(); wantOff[HAS_WANT] = 0;
  assert.equal(bp.parseSpend(wantOff), null, 'want bytes after has_want = 0');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], want: { vout: 0, value: 1n, spkHash: new Uint8Array(32) } })), null, 'a want alone is not an output');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay, proof: new Uint8Array(4097) })), null, 'proof 4097');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay, proofLen: 255 })), null, 'proof_len short of proof');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay, proofLen: 257 })), null, 'proof_len beyond proof');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay, proof: new Uint8Array(0), proofLen: 0xffff })), null, 'proof_len 65535');
  assert.equal(bp.parseSpend(concat(good, Uint8Array.of(0))), null, 'trailing');
  for (const cut of [1, 36, 38, 60, PRE, PRE + 1, NF + 31, NOUT, OUT0 + 88, HAS_EXIT, HAS_WANT, HAS_WANT + 1, good.length - 257]) assert.equal(bp.parseSpend(good.slice(0, cut)), null, `truncated at ${cut}`);
  const ex = spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 0, destHash: new Uint8Array(32) } });
  const BD = PRE + 1 + 32 + 1 + 1 + 4 + 32;
  const exPrefix = ex.slice(); exPrefix[BD] = 0x04;
  assert.equal(bp.parseSpend(exPrefix), null, 'exit C_secp prefix');
  const exOff = ex.slice(); exOff.set(b32(nonX), BD + 1);
  assert.equal(bp.parseSpend(exOff), null, 'exit C_secp not on curve');
  const exP = ex.slice(); exP.set(b32(P + 1n), BD + 1);
  assert.equal(bp.parseSpend(exP), null, 'exit C_secp x >= p');
  for (const cut of [BD - 1, BD + 100, BD + 824]) assert.equal(bp.parseSpend(ex.slice(0, cut)), null, `exit truncated at ${cut}`);
});

test('carrierPoolEnvelopes: a shield on vin[0] is read alone; spends are read on every input in order', () => {
  const sh = { opcode: 0x6c, payload: Uint8Array.of(0x6c) }, sp = (t) => ({ opcode: 0x6d, payload: Uint8Array.of(0x6d, t) });
  const cx = { opcode: 0x23, payload: Uint8Array.of(0x23) };
  const vins = (r) => r.items.map((x) => x.vin);
  assert.deepEqual(vins(bp.carrierPoolEnvelopes([sh, sp(1), sp(2)])), [0]);
  assert.equal(bp.carrierPoolEnvelopes([sh, sp(1)]).vin0TacitOp, false);
  assert.deepEqual(vins(bp.carrierPoolEnvelopes([sp(0), null, sp(2), sp(3)])), [0, 2, 3]);
  assert.deepEqual(vins(bp.carrierPoolEnvelopes([null, sp(1), sh])), [1, 2]);
  const t = bp.carrierPoolEnvelopes([cx, sp(1)]);
  assert.equal(t.vin0TacitOp, true); assert.deepEqual(vins(t), [1]);
  assert.equal(bp.carrierPoolEnvelopes([null, sp(1)]).vin0TacitOp, false);
  assert.equal(bp.carrierPoolEnvelopes([sp(0), sp(1)]).vin0TacitOp, false);
});

// ── acceptance ──
const accept = async () => true;
const resolverFor = (notes) => async (op, assetHex) => {
  const n = notes.get(`${op.txid}:${op.vout}`);
  if (!n || n.asset !== assetHex) return null;
  return pointXY(pedersen(n.value, n.r));
};
const noteMap = (inputs, asset = ASSET) => new Map(inputs.map((i) => [`${i.outpoint.txid}:${i.outpoint.vout}`, { ...i, asset: bytesToHex(asset) }]));
function shieldCtx(inputs, extra = {}) {
  return { txid: 'aa'.repeat(32), inputs: [fakeOutpoint('commit'), ...inputs.map((i) => i.outpoint)], resolveInput: resolverFor(noteMap(inputs)), verifyProof: accept, ...extra };
}
async function freshState(h = 1000) { const st = new bp.BtcPoolState(); st.beginBlock(h); return st; }
const SH_INS = [inNote('a', 10n), inNote('b', 32n)];

test('shield: accepted, leaves appended, proof sees root 0, no nullifiers and the boundary as depC', async () => {
  const s = makeShield(SH_INS, { outs: ['s1', 's2'] });
  const st = await freshState();
  let seen = null;
  const r = await st.acceptShield(bp.parseShield(s.bytes), shieldCtx(SH_INS, { verifyProof: async (x) => { seen = x; return true; } }));
  assert.ok(r.accepted, r.reason);
  assert.equal(st.tree.size, 2);
  assert.deepEqual(st.tree.leaf(0), leafOf(s.outputs[0]));
  assert.deepEqual(st.tree.leaf(1), leafOf(s.outputs[1]));
  assert.deepEqual(r.leaves.map((l) => [l.leafIndex, l.txid, l.height, bytesToHex(l.asset), bytesToHex(l.pkEph), bytesToHex(l.ctNote)]),
    s.outputs.map((o, i) => [i, 'aa'.repeat(32), 1000, bytesToHex(ASSET), bytesToHex(o.slice(32, 65)), bytesToHex(o.slice(65))]));
  assert.deepEqual(seen.proof, PROOF);
  assert.deepEqual(seen.publics, [0n, bodyHash(s.body), assetField(ASSET), 0n, 0n, big(leafOf(s.outputs[0])), big(leafOf(s.outputs[1])), 0n, 0n, 1n, ...B42.cBjj].map(dec));
  assert.equal(st.nullifiers.size, 0);
});

test('shield: rejects wrong kernel key, value mismatch, infinity, bad inputs, rebound outpoints, failing boundary or proof', async () => {
  const ins = SH_INS;
  const cases = [
    ['wrong kernel key', makeShield(ins, { signKey: scalar('wrong') }), shieldCtx(ins), /kernel/],
    ['value mismatch', makeShield([ins[0], inNote('b', 33n)]), shieldCtx([ins[0], inNote('b', 33n)]), /kernel/],
    ['too few carrier inputs', makeShield(ins), { ...shieldCtx(ins), inputs: shieldCtx(ins).inputs.slice(0, 2) }, /too few/],
    ['unresolved input', makeShield(ins), shieldCtx([ins[0]], { inputs: shieldCtx(ins).inputs }), /not a valid note/],
    ['input of another asset', makeShield(ins), { ...shieldCtx(ins), resolveInput: resolverFor(noteMap(ins, OTHER_ASSET)) }, /not a valid note/],
    ['input off curve', makeShield(ins), { ...shieldCtx(ins), resolveInput: async () => ({ cx: b32(nonX), cy: b32(1n) }) }, /not a curve point/],
    ['bad sigma', makeShield(ins, { boundary: BAD_SIGMA }), shieldCtx(ins), /boundary does not verify/],
    ['bad range proof', makeShield(ins, { boundary: BAD_BPP }), shieldCtx(ins), /boundary does not verify/],
    ['C_bjj of another boundary', makeShield(ins, { boundary: OTHER_CBJJ }), shieldCtx(ins), /boundary does not verify/],
    ['proof false', makeShield(ins), shieldCtx(ins, { verifyProof: async () => false }), /proof does not verify/],
    ['proof truthy but not true', makeShield(ins), shieldCtx(ins, { verifyProof: async () => 1 }), /proof does not verify/],
  ];
  // Excess at infinity: the pool commitment equals the input sum exactly.
  const eq = [{ ...ins[0], r: scalar('eq') }, { ...ins[1], r: B42.r - scalar('eq') }];
  cases.push(['excess infinity', makeShield(eq, { signKey: 1n }), shieldCtx(eq), /excess is infinity/]);
  // Kernel signed over different outpoints than the carrier spends.
  const moved = [ins[0], { ...ins[1], outpoint: fakeOutpoint('elsewhere') }];
  cases.push(['kernel bound to other outpoints', makeShield(ins), shieldCtx(moved), /kernel/]);
  for (const [name, s, ctx, re] of cases) {
    const st = await freshState();
    let called = 0;
    const vp = ctx.verifyProof;
    const r = await st.acceptShield(bp.parseShield(s.bytes), { ...ctx, verifyProof: async (x) => { called++; return vp(x); } });
    assert.ok(!r.accepted, name);
    assert.match(r.reason, re, name);
    assert.equal(st.tree.size, 0, name);
    if (!/^proof/.test(name)) assert.equal(called, 0, `${name}: proof not checked`);
  }
});

test('shield: resolver I/O failure and a missing verifier throw (never a rejection); order before the verifier', async () => {
  const st = await freshState();
  const s = bp.parseShield(makeShield(SH_INS).bytes);
  await assert.rejects(st.acceptShield(s, { ...shieldCtx(SH_INS), resolveInput: async () => { throw new Error('esplora down'); } }), /esplora down/);
  await assert.rejects(st.acceptShield(s, shieldCtx(SH_INS, { verifyProof: null })), bp.VerifierUnavailableError);
  // A shield that fails earlier is rejected even without a verifier.
  assert.match((await st.acceptShield(s, { ...shieldCtx(SH_INS), inputs: [fakeOutpoint('c')], verifyProof: null })).reason, /too few/);
  assert.match((await st.acceptShield(bp.parseShield(makeShield(SH_INS, { boundary: BAD_SIGMA }).bytes), shieldCtx(SH_INS, { verifyProof: null }))).reason, /boundary/);
  assert.match((await st.acceptShield(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [outBytes('p')] })), shieldCtx(SH_INS))).reason, /not a shield/);
  assert.equal(st.tree.size, 0);
});

const spendCtx = (extra = {}) => ({ txid: 'bb'.repeat(32), outputs: [{ scriptPubKey: Uint8Array.of(0x51) }], verifyProof: accept, ...extra });
const paySpend = (hAnchor, nfs = [nf(1)], tag = 'p') => bp.parseSpend(spendBytes({ hAnchor, nfs, pay: [outBytes(tag)] }));

// A state with one leaf (a pay at `start`, anchored at the empty block start − 1), then empty blocks to `tip`.
async function stateWithLeaf(start, tip) {
  const st = new bp.BtcPoolState();
  st.beginBlock(start - 1); st.endBlock();
  st.beginBlock(start);
  assert.ok((await st.acceptSpend(paySpend(start - 1, [nf('seed')], 'seed'), spendCtx())).accepted);
  st.endBlock();
  for (let h = start + 1; h <= tip; h++) { st.beginBlock(h); st.endBlock(); }
  return st;
}

test('spend: anchor window is measured from the current block height', async () => {
  const st = await stateWithLeaf(1000, 1200);
  st.beginBlock(1201);
  assert.match((await st.acceptSpend(paySpend(1201), spendCtx())).reason, /window/, 'h_anchor = H');
  assert.match((await st.acceptSpend(paySpend(1300), spendCtx())).reason, /window/, 'future');
  assert.match((await st.acceptSpend(paySpend(1201 - 145), spendCtx())).reason, /window/, 'H-145');
  assert.ok((await st.acceptSpend(paySpend(1201 - 144, [nf('lo')]), spendCtx())).accepted, 'H-144 retained');
  assert.ok((await st.acceptSpend(paySpend(1200, [nf('hi')]), spendCtx())).accepted, 'H-1');
  st.endBlock();
  assert.ok(!st.roots.has(1201 - 144), 'pruned after commit');
  assert.ok(st.roots.has(1202 - 144));
});

test('spend: an anchor with no retained root is rejected', async () => {
  const st = await stateWithLeaf(1000, 1010);
  st.beginBlock(1011);
  assert.match((await st.acceptSpend(paySpend(990), spendCtx())).reason, /no root retained/);
  assert.match((await st.acceptSpend(bp.parseShield(makeShield(SH_INS).bytes), spendCtx())).reason, /not a spend/);
});

test('spend: nullifier replay and duplicates', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  assert.match((await st.acceptSpend(paySpend(1001, [nf(1), nf(1)]), spendCtx())).reason, /duplicate/);
  assert.ok((await st.acceptSpend(paySpend(1001, [nf(1)]), spendCtx())).accepted);
  assert.match((await st.acceptSpend(paySpend(1001, [nf(1)]), spendCtx())).reason, /already spent/, 'same block');
  st.endBlock();
  st.beginBlock(1003);
  assert.match((await st.acceptSpend(paySpend(1002, [nf(2), nf(1)]), spendCtx())).reason, /already spent/, 'later block');
  assert.match((await st.acceptSpend(paySpend(1002, [nf('seed')]), spendCtx())).reason, /already spent/, 'seed');
  assert.equal(st.nullifiers.size, 2);
  assert.deepEqual(st.nullifiers.get(bytesToHex(nf(1))), { nf: bytesToHex(nf(1)), height: 1002, txid: 'bb'.repeat(32) });
});

test('spend: exit destination and vout checks, recorded note from the boundary commitment', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  const spk = Uint8Array.of(0x00, 0x14, ...new Uint8Array(20).fill(3));
  const outputs = [{ scriptPubKey: Uint8Array.of(0x6a) }, { scriptPubKey: spk }];
  let called = 0;
  const verifyProof = async () => { called++; return true; };
  const ex = (vout, destHash, boundary) => bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('x' + vout)], exit: { vout, destHash, boundary } }));
  assert.match((await st.acceptSpend(ex(1, sha256(Uint8Array.of(0x6a))), spendCtx({ outputs, verifyProof }))).reason, /dest_spk_hash/);
  assert.match((await st.acceptSpend(ex(2, sha256(spk)), spendCtx({ outputs, verifyProof }))).reason, /not an output/);
  assert.match((await st.acceptSpend(ex(1, sha256(spk), BAD_BPP), spendCtx({ outputs, verifyProof }))).reason, /exit boundary does not verify/);
  assert.match((await st.acceptSpend(ex(1, sha256(spk), BAD_SIGMA), spendCtx({ outputs, verifyProof: null }))).reason, /exit boundary does not verify/, 'before the verifier');
  assert.equal(called, 0, 'proof not checked before the exit checks');
  let seen;
  const r = await st.acceptSpend(ex(1, sha256(spk)), spendCtx({ outputs, verifyProof: async (x) => { seen = x; return true; } }));
  assert.ok(r.accepted, r.reason);
  assert.deepEqual(seen.publics.slice(8), [...B5.cBjj, 0n, 1n].map(dec), 'exitC is the boundary point');
  const rec = st.exits.get(`${'bb'.repeat(32)}:1`);
  assert.deepEqual(rec, { txid: 'bb'.repeat(32), vout: 1, asset: ASSET, ...pointXY(B5.C), height: 1002 });
  assert.deepEqual(r.exit, rec);
  assert.equal(st.tree.size, 1, 'exit appends no leaf');
});

test('spend: an exit is rejected when vin[0] holds a transparent Tacit op; a pay in the same carrier is not', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  const spk = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(4));
  const exit = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('v0x')], exit: { vout: 0, destHash: sha256(spk) } }));
  let called = 0;
  const ctx = spendCtx({ outputs: [{ scriptPubKey: spk }], vin0TacitOp: true, verifyProof: async () => { called++; return true; } });
  assert.match((await st.acceptSpend(exit, ctx)).reason, /vin\[0\] holds a transparent Tacit op/);
  assert.equal(called, 0);
  assert.ok((await st.acceptSpend(paySpend(1001, [nf('v0p')]), ctx)).accepted, 'pay rides a carrier with a transparent vin[0]');
  const partial = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('v0q')], pay: [outBytes('q')], exit: { vout: 0, destHash: sha256(spk) } }));
  assert.match((await st.acceptSpend(partial, ctx)).reason, /transparent Tacit op/, 'partial exit too');
  assert.equal(st.exits.size, 0);
  assert.ok((await st.acceptSpend(exit, { ...ctx, vin0TacitOp: false })).accepted);
});

test('spend: within one carrier each output is claimed by at most one accepted exit, and nullifiers stay fresh', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  const spkA = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(5)), spkB = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(6));
  const ctx = spendCtx({ outputs: [{ scriptPubKey: spkA }, { scriptPubKey: spkB }] });
  const ex = (t, vout, spk) => bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf(t)], exit: { vout, destHash: sha256(spk) } }));
  assert.match((await st.acceptSpend(ex('c0', 0, spkB), ctx)).reason, /dest_spk_hash/);
  assert.ok((await st.acceptSpend(ex('c1', 0, spkA), ctx)).accepted, 'a rejected exit claims nothing');
  assert.match((await st.acceptSpend(ex('c2', 0, spkA), ctx)).reason, /already claimed/);
  assert.ok((await st.acceptSpend(ex('c3', 1, spkB), ctx)).accepted, 'a distinct output');
  assert.match((await st.acceptSpend(ex('c1', 1, spkB), ctx)).reason, /already spent/, 'earlier envelope nullifier');
  assert.ok((await st.acceptSpend(ex('c4', 0, spkA), spendCtx({ txid: 'cc'.repeat(32), outputs: ctx.outputs }))).accepted, 'another carrier');
  assert.deepEqual([...st.exits.keys()].sort(), [`${'bb'.repeat(32)}:0`, `${'bb'.repeat(32)}:1`, `${'cc'.repeat(32)}:0`]);
  assert.equal(st.nullifiers.size, 1 + 3);
});

test('spend: bind requires the carrier to spend the outpoint at some input', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  const bind = { txid: 'ab'.repeat(32), vout: 3 };
  let called = 0;
  const verifyProof = async () => { called++; return true; };
  const s = (t, b = bind) => bp.parseSpend(spendBytes({ hAnchor: 1001, bind: b, nfs: [nf(t)], pay: [outBytes('b' + t)] }));
  const ins = (...ops) => spendCtx({ inputs: ops, verifyProof });
  assert.match((await st.acceptSpend(s('b1'), ins({ txid: 'ab'.repeat(32), vout: 2 }))).reason, /bound outpoint/, 'another vout');
  assert.match((await st.acceptSpend(s('b1'), ins({ txid: 'ba'.repeat(32), vout: 3 }))).reason, /bound outpoint/, 'another txid');
  assert.match((await st.acceptSpend(s('b1'), spendCtx({ verifyProof }))).reason, /bound outpoint/, 'no inputs');
  assert.equal(called, 0, 'bind checked before the proof');
  assert.ok((await st.acceptSpend(s('b1'), ins({ txid: '11'.repeat(32), vout: 0 }, { txid: 'ab'.repeat(32), vout: 3 }))).accepted, 'bound outpoint at vin[1]');
  assert.ok((await st.acceptSpend(s('b2', null), ins({ txid: '11'.repeat(32), vout: 0 }))).accepted, 'zero bind: any carrier');
  // Bind is checked before the nullifiers: a replayed nullifier in the wrong carrier reports the bind.
  assert.match((await st.acceptSpend(s('b1'), ins({ txid: '22'.repeat(32), vout: 0 }))).reason, /bound outpoint/);
});

test('spend: want requires the named output to pay at least its value to its script; claims are exclusive', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  const maker = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(0x4d)), user = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(0x55));
  const outputs = [{ value: 546n, scriptPubKey: maker }, { value: 20_000n, scriptPubKey: user }, { value: 30_000n, scriptPubKey: user }];
  let called = 0;
  const ctx = spendCtx({ outputs, verifyProof: async () => { called++; return true; } });
  const ew = (t, { exitVout = 0, wantVout = 1, value = 20_000n, spk = user, exitSpk = maker, pay = [] } = {}) =>
    bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf(t)], pay, exit: exitVout == null ? null : { vout: exitVout, destHash: sha256(exitSpk) }, want: { vout: wantVout, value, spkHash: sha256(spk) } }));
  assert.match((await st.acceptSpend(ew('w1', { value: 20_001n }), ctx)).reason, /pays less/, 'underpaid');
  assert.match((await st.acceptSpend(ew('w1', { spk: maker }), ctx)).reason, /spk_hash/, 'other script');
  assert.match((await st.acceptSpend(ew('w1', { wantVout: 3 }), ctx)).reason, /not an output/, 'missing output');
  assert.match((await st.acceptSpend(ew('w1', { wantVout: 0, spk: maker }), ctx)).reason, /same output/, 'exit and want on one output');
  assert.equal(called, 0, 'want checked before the proof');
  assert.equal(st.nullifiers.size, 1);
  const ok = await st.acceptSpend(ew('w1'), ctx);
  assert.ok(ok.accepted, ok.reason);
  assert.deepEqual(ok.want, { txid: 'bb'.repeat(32), vout: 1, value: 20_000n });
  // Output 1 is now claimed: neither a second want nor an exit may take it.
  assert.match((await st.acceptSpend(ew('w2', { exitVout: null, pay: [outBytes('w2')] }), ctx)).reason, /already claimed/, 'second want');
  assert.match((await st.acceptSpend(bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('w3')], exit: { vout: 1, destHash: sha256(user) } })), ctx)).reason, /already claimed/, 'exit onto a wanted output');
  // An exit's output cannot be wanted by a later envelope either.
  assert.match((await st.acceptSpend(ew('w4', { exitVout: null, wantVout: 0, spk: maker, value: 1n, pay: [outBytes('w4')] }), ctx)).reason, /already claimed/, 'want onto an exit output');
  assert.ok((await st.acceptSpend(ew('w5', { exitVout: null, wantVout: 2, value: 30_000n, pay: [outBytes('w5')] }), ctx)).accepted, 'a distinct output');
  // Claims are per carrier.
  assert.ok((await st.acceptSpend(ew('w6', { exitVout: null, pay: [outBytes('w6')] }), spendCtx({ txid: 'cc'.repeat(32), outputs }))).accepted, 'another carrier');
  // A want on a carrier whose vin[0] holds a transparent op is still read (it creates no note).
  assert.ok((await st.acceptSpend(ew('w7', { exitVout: null, wantVout: 2, value: 1n, pay: [outBytes('w7')] }), spendCtx({ txid: 'dd'.repeat(32), outputs, vin0TacitOp: true }))).accepted);
  st.endBlock();
  // Want claims do not outlive their block.
  st.beginBlock(1003);
  assert.equal(st.pending.wants.size, 0);
});

test('capacity: a full tree rejects leaf-creating envelopes and still takes an exit-only spend', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.maxLeaves = 2;
  st.beginBlock(1002);
  const spk = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(7));
  const two = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('f2')], pay: [outBytes('a'), outBytes('b')] }));
  let called = 0;
  const ctx = spendCtx({ outputs: [{ scriptPubKey: spk }], verifyProof: async () => { called++; return true; } });
  assert.match((await st.acceptSpend(two, ctx)).reason, /tree is full/);
  assert.equal(called, 0, 'capacity checked before the proof');
  assert.ok((await st.acceptSpend(paySpend(1001, [nf('f1')]), ctx)).accepted, 'one leaf fits');
  assert.equal(st.tree.size, 2);
  assert.match((await st.acceptSpend(paySpend(1001, [nf('f3')]), ctx)).reason, /tree is full/);
  assert.match((await st.acceptShield(bp.parseShield(makeShield(SH_INS).bytes), shieldCtx(SH_INS))).reason, /tree is full/);
  const exitOnly = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('f4')], exit: { vout: 0, destHash: sha256(spk) } }));
  assert.ok((await st.acceptSpend(exitOnly, ctx)).accepted, 'exit-only creates no leaf');
  const partial = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('f5')], pay: [outBytes('c')], exit: { vout: 0, destHash: sha256(spk) } }));
  assert.match((await st.acceptSpend(partial, spendCtx({ txid: 'dd'.repeat(32), outputs: ctx.outputs }))).reason, /tree is full/);
  assert.equal(bp.MAX_LEAVES, 2 ** 32);
  assert.equal(new bp.BtcPoolState().maxLeaves, 2 ** 32);
});

test('spend: verifier sees exact public signals; a false verdict rejects; a missing verifier throws', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  const s = paySpend(1001);
  let seen;
  const r1 = await st.acceptSpend(s, spendCtx({ verifyProof: async (x) => { seen = x; return false; } }));
  assert.match(r1.reason, /proof/);
  assert.deepEqual(seen.publics, bp.envelopePublics(s, { root: st.roots.get(1001) }));
  assert.equal(seen.publics[0], dec(big(st.roots.get(1001))));
  assert.equal(seen.publics[1], dec(bodyHash(s.body)));
  assert.deepEqual(seen.proof, s.proof);
  assert.match((await st.acceptSpend(s, spendCtx({ verifyProof: async () => 1 }))).reason, /proof/, 'only true accepts');
  await assert.rejects(st.acceptSpend(s, spendCtx({ verifyProof: null })), bp.VerifierUnavailableError);
  await assert.rejects(st.acceptSpend(s, spendCtx({ verifyProof: async () => { throw new Error('boom'); } })), /boom/);
  assert.equal(st.nullifiers.size, 1);
  assert.equal(st.tree.size, 1);
  // Order: anchor, then nullifiers, then exit, then capacity, then proof.
  const bad = bp.parseSpend(spendBytes({ hAnchor: 5, nfs: [nf(1)], pay: [outBytes('p')] }));
  assert.match((await st.acceptSpend(bad, spendCtx({ verifyProof: null }))).reason, /window/);
  assert.match((await st.acceptSpend(paySpend(1001, [nf('seed')]), spendCtx({ verifyProof: null }))).reason, /already spent/);
  assert.throws(() => st.beginBlock(1003), /already open/);
});

test('state: blocks must be contiguous and opened', async () => {
  const st = new bp.BtcPoolState();
  await assert.rejects(st.acceptSpend(paySpend(1), spendCtx()), /no open block/);
  await assert.rejects(st.acceptShield(bp.parseShield(makeShield(SH_INS).bytes), shieldCtx(SH_INS)), /no open block/);
  assert.throws(() => st.endBlock(), /no open block/);
  st.beginBlock(10); st.endBlock();
  assert.throws(() => st.beginBlock(12), /expected block 11/);
  st.beginBlock(11); st.endBlock();
  assert.equal(st.tip, 11);
  assert.equal(st.leafCountAt(11), 0);
});

function fingerprint(st) {
  return JSON.stringify({
    tip: st.tip, size: st.tree.size, root: bytesToHex(st.tree.root()),
    levels: st.tree.levels.map((l) => l.map(String)),
    heights: st.leafHeights,
    nfs: [...st.nullifiers.keys()].sort(), exits: [...st.exits.keys()].sort(),
    roots: [...st.roots.entries()].sort((a, b) => a[0] - b[0]).map(([h, r]) => [h, bytesToHex(r)]),
  });
}

// Pays every other block; shields and exits (each a boundary check) at the given spacing.
async function busyBlocks(st, from, to, { shieldEvery = 50, exitEvery = 60, record = null } = {}) {
  for (let h = from; h <= to; h++) {
    st.beginBlock(h);
    if (h % shieldEvery === 0) {
      const ins = [inNote('u' + h, 10n), inNote('v' + h, 32n)];
      assert.ok((await st.acceptShield(bp.parseShield(makeShield(ins, { outs: ['u' + h, 'v' + h] }).bytes), shieldCtx(ins))).accepted);
    }
    if (h % 2 === 0) assert.ok((await st.acceptSpend(paySpend(h - 1, [nf('u' + h)], 'u' + h), spendCtx())).accepted);
    if (h % exitEvery === 0) {
      const spk = Uint8Array.of(0x51, h & 0xff);
      assert.ok((await st.acceptSpend(bp.parseSpend(spendBytes({ hAnchor: h - 2, nfs: [nf('x' + h)], exit: { vout: 0, destHash: sha256(spk) } })), spendCtx({ txid: bytesToHex(keccak(u32le(h))), outputs: [{ scriptPubKey: spk }] }))).accepted);
    }
    const { root } = st.endBlock();
    if (record) record.set(h, root);
  }
}

test('undo: rollbackFrom restores tree, nullifiers, exits and roots exactly (incl. pruned roots)', async () => {
  const st = await stateWithLeaf(1000, 1200);
  await busyBlocks(st, 1201, 1300, { shieldEvery: 100, exitEvery: 120 });
  const snap = fingerprint(st);
  await busyBlocks(st, 1301, 1500, { shieldEvery: 100, exitEvery: 120 });
  assert.notEqual(fingerprint(st), snap);
  st.rollbackFrom(1301);
  assert.equal(fingerprint(st), snap);
  st.rollbackFrom(1400);
  assert.equal(fingerprint(st), snap, 'rollback above the tip is a no-op');
});

test('undo: depth limit, and abortBlock discards a half-applied block', async () => {
  const st = await stateWithLeaf(1000, 1000);
  await busyBlocks(st, 1001, 1400, { shieldEvery: 200, exitEvery: 190 });
  const snap = fingerprint(st);
  assert.throws(() => st.rollbackFrom(1400 - 288), bp.ReorgTooDeepError);
  assert.equal(fingerprint(st), snap, 'failed rollback leaves state untouched');
  st.rollbackFrom(1400 - 287);
  assert.equal(st.tip, 1400 - 288);
  const before = fingerprint(st);
  st.beginBlock(st.tip + 1);
  const ins = [inNote('z', 42n)];
  assert.ok((await st.acceptShield(bp.parseShield(makeShield(ins, { outs: ['z'] }).bytes), shieldCtx(ins))).accepted);
  assert.ok((await st.acceptSpend(paySpend(st.tip, [nf('zz')]), spendCtx())).accepted);
  st.abortBlock();
  assert.equal(fingerprint(st), before);
});

test('restore: rebuilding from rows reproduces live state and its undo records', async () => {
  const st = await stateWithLeaf(1000, 1100);
  const allRoots = new Map(st.roots);
  await busyBlocks(st, 1101, 1240, { shieldEvery: 70, exitEvery: 90, record: allRoots });
  const rows = {
    tip: st.tip,
    leaves: Array.from({ length: st.tree.size }, (_, i) => ({ leafIndex: i, height: st.leafHeights[i], leaf: st.tree.leaf(i) })).reverse(),
    nullifiers: [...st.nullifiers.values()],
    exits: [...st.exits.values()],
    // Every recorded root, as the store keeps them; restore keeps only the window.
    roots: [...allRoots.entries()],
  };
  const back = bp.BtcPoolState.restore(rows);
  assert.equal(fingerprint(back), fingerprint(st));
  assert.equal(bp.BtcPoolState.restore({ tip: null }).tip, null);
  assert.throws(() => bp.BtcPoolState.restore({ ...rows, leaves: rows.leaves.filter((l) => l.leafIndex !== 1) }), /gap/);
  back.rollbackFrom(1201); st.rollbackFrom(1201);
  assert.equal(fingerprint(back), fingerprint(st));
});

test('store: commit, snapshot/restore round trip, rollback, wipe, schema reset', async () => {
  const store = openBtcPoolStore(':memory:');
  assert.equal(store.tip(), null);
  assert.deepEqual(store.snapshot(), { tip: null, leaves: [], nullifiers: [], exits: [], roots: [] });
  const st = new bp.BtcPoolState();
  const spk = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(9));
  for (let h = 200; h <= 204; h++) {
    st.beginBlock(h);
    if (h === 201) assert.ok((await st.acceptShield(bp.parseShield(makeShield(SH_INS, { outs: ['st1', 'st2'] }).bytes), shieldCtx(SH_INS, { txid: 'a1'.repeat(32) }))).accepted);
    if (h === 202) assert.ok((await st.acceptSpend(paySpend(201, [nf('st')], 'st3'), spendCtx({ txid: 'a2'.repeat(32) }))).accepted);
    if (h === 203) assert.ok((await st.acceptSpend(bp.parseSpend(spendBytes({ hAnchor: 202, nfs: [nf('sx')], exit: { vout: 0, destHash: sha256(spk) } })), spendCtx({ txid: 'a3'.repeat(32), outputs: [{ scriptPubKey: spk }] }))).accepted);
    const delta = st.endBlock();
    store.commitBlock(delta, bytesToHex(keccak(u32le(h))), h === 201 ? [{ txIndex: 1, vin: 0, txid: 'a1'.repeat(32), opcode: 0x6c, accepted: true }] : []);
  }
  assert.equal(store.tip().height, 204);
  assert.equal(store.block(202).root, bytesToHex(st.roots.get(202)));
  const back = bp.BtcPoolState.restore(store.snapshot());
  assert.equal(fingerprint(back), fingerprint(st));
  const notes = store.notes(0, 10);
  assert.equal(notes.length, 3);
  assert.deepEqual(Object.keys(notes[0]).sort(), ['asset', 'ct_note', 'height', 'idx', 'leaf', 'pk_eph', 'txid']);
  assert.deepEqual([notes[0].idx, notes[0].height, notes[0].txid, notes[0].leaf, notes[0].asset], [0, 201, 'a1'.repeat(32), bytesToHex(leafOf(outBytes('st1'))), bytesToHex(ASSET)]);
  assert.equal(notes[2].pk_eph, bytesToHex(outBytes('st3').slice(32, 65)));
  assert.equal(notes[2].ct_note, bytesToHex(outBytes('st3').slice(65)));
  assert.deepEqual(store.nullifier(bytesToHex(nf('st'))), { nf: bytesToHex(nf('st')), height: 202, txid: 'a2'.repeat(32) });
  const x = store.exit('a3'.repeat(32), 0);
  assert.deepEqual([x.height, x.asset, x.cx, x.cy], [203, bytesToHex(ASSET), bytesToHex(pointXY(B5.C).cx), bytesToHex(pointXY(B5.C).cy)]);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM envelopes').get().n, 1);
  store.rollbackFrom(202);
  st.rollbackFrom(202);
  assert.equal(store.tip().height, 201);
  assert.equal(store.notes(0, 10).length, 2);
  assert.equal(store.nullifier(bytesToHex(nf('st'))), null);
  assert.equal(store.exit('a3'.repeat(32), 0), null);
  assert.equal(fingerprint(bp.BtcPoolState.restore(store.snapshot())), fingerprint(st));
  store.wipe();
  assert.equal(store.tip(), null);
  assert.equal(store.notes(0, 10).length, 0);
  store.close();

  // A database written under another schema replays from scratch; relay state is kept.
  const dir = mkdtempSync(join(tmpdir(), 'btc-pool-store-'));
  try {
    const path = join(dir, 'db', 'pool.db');
    const a = openBtcPoolStore(path);
    a.commitBlock({ height: 7, root: new Uint8Array(32), leaves: [], nullifiers: [], exits: [] }, 'ab'.repeat(32), []);
    a.relay.save([{ id: 'p1', state: 'pending' }], []);
    a.setMeta('schema', '2');
    a.close();
    const b = openBtcPoolStore(path);
    assert.equal(b.tip(), null);
    assert.equal(b.meta('schema'), '3');
    assert.deepEqual(b.relay.load().payloads.map((r) => r.id), ['p1']);
    b.commitBlock({ height: 8, root: new Uint8Array(32), leaves: [], nullifiers: [], exits: [] }, 'cd'.repeat(32), []);
    b.close();
    const c = openBtcPoolStore(path);
    assert.equal(c.tip().height, 8, 'same schema keeps rows');
    c.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── raw parsing against a real signet block ──
const FIX = JSON.parse(readFileSync(new URL('./fixtures/btc-pool-signet-block-323648.json', import.meta.url)));

test('raw block parser: real signet block (hash, merkle root, every txid)', () => {
  const blk = parseBlock(hexToBytes(FIX.raw), FIX.hash);
  assert.equal(blk.txs.length, FIX.txids.length);
  assert.deepEqual(blk.txs.map((t) => t.txid), FIX.txids);
  const tampered = hexToBytes(FIX.raw); tampered[tampered.length - 10] ^= 1;
  assert.throws(() => parseBlock(tampered, FIX.hash), /witness commitment/, 'witness-only change');
  const vo = hexToBytes(FIX.raw); vo[vo.length - 1] ^= 1;
  assert.throws(() => parseBlock(vo, FIX.hash), /merkle root/, 'locktime change');
  assert.throws(() => parseBlock(hexToBytes(FIX.raw), '00'.repeat(32)), /hash/);
  assert.throws(() => parseBlock(concat(hexToBytes(FIX.raw), Uint8Array.of(0))), /trailing/);
});

test('envelope extraction: real signet T_CXFER reveal', () => {
  const { tx, end } = parseTx(hexToBytes(FIX.tacit_tx.hex));
  assert.equal(end, FIX.tacit_tx.hex.length / 2);
  assert.equal(tx.txid, FIX.tacit_tx.txid);
  const env = txEnvelope(tx);
  assert.ok(env && (env.opcode === 0x23 || env.opcode === 0x22));
  assert.equal(bytesToHex(env.payload.subarray(1, 33)), FIX.tacit_tx.asset);
});

// ── canonical shield-input validation ──
// Full recorded ancestry (7 txs) of the real signet T_CXFER note FIX.tacit_tx:0.
const ANC = JSON.parse(readFileSync(new URL('./fixtures/btc-pool-signet-transparent-ancestry.json', import.meta.url)));
function recordedEsplora({ extra = new Map(), down = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    rawTx: async (t) => {
      calls.push(t);
      if (down.has(t)) throw new Error('503 Service Unavailable');
      if (ANC.txs[t]) return hexToBytes(ANC.txs[t].hex);
      if (extra.has(t)) return extra.get(t).raw;
      throw notFound();
    },
    txStatus: async (t) => {
      if (down.has(t)) throw new Error('503 Service Unavailable');
      if (ANC.txs[t]) return ANC.txs[t].status;
      if (extra.has(t)) return { confirmed: true, block_height: 330000, block_hash: '00'.repeat(32) };
      throw notFound();
    },
  };
}
const noExits = () => new Map();

test('transparent: a real signet note validates through its recorded ancestry', async () => {
  assert.equal(ANC.target.txid, FIX.tacit_tx.txid);
  const esplora = recordedEsplora();
  const resolve = makeShieldInputResolver({ esplora, network: 'signet', exits: noExits });
  const r = await resolve(ANC.target.txid, 0);
  assert.equal(r.asset, FIX.tacit_tx.asset);
  assert.equal(bytesToHex(r.Cx), ANC.target.Cx);
  assert.equal(bytesToHex(r.Cy), ANC.target.Cy);
  const env = txEnvelope(parseTx(hexToBytes(ANC.txs[ANC.target.txid].hex)).tx);
  assert.ok(bytesToHex(env.payload).includes(bytesToHex(compress(bp.pointFromXY(r.Cx, r.Cy)))), 'the envelope-declared commitment');
  assert.equal(new Set(esplora.calls).size, Object.keys(ANC.txs).length, 'walked the whole ancestry');
  assert.equal(await resolve(ANC.target.txid, 8), null, 'not a Tacit output');
});

test('transparent: a parent that declares a commitment but fails validation is not a note', async () => {
  const asset = hexToBytes(FIX.tacit_tx.asset);
  const real = { outpoint: { txid: ANC.target.txid, vout: 0 }, value: 0n, r: 0n };
  // Spends the real note and declares a fresh 10^9 output; no key for the real note's blinding, so the
  // kernel is necessarily forged.
  const forged = cxferTx(asset, [real], [{ value: 10n ** 9n, r: scalar('mint') }], { forge: true });
  const badEtch = etchTx(7n, scalar('be'), { badProof: true });
  const goodEtch = etchTx(7n, scalar('ge'));
  const extra = new Map([[forged.txid, forged], [badEtch.txid, badEtch], [goodEtch.txid, goodEtch]]);
  const resolve = makeShieldInputResolver({ esplora: recordedEsplora({ extra }), network: 'signet', exits: noExits });
  assert.equal(await resolve(forged.txid, 0), null, 'forged kernel');
  assert.equal(await resolve(badEtch.txid, 0), null, 'range proof for another value');
  const g = await resolve(goodEtch.txid, 0);
  assert.equal(g.asset, bytesToHex(goodEtch.asset));
  assert.deepEqual(g.Cx, pointXY(pedersen(7n, scalar('ge'))).cx);
  assert.ok(await resolve(ANC.target.txid, 0), 'the real parent itself still validates');
});

test('transparent: an unreachable source throws; an unknown tx is unavailable, not absent; own exits resolve first', async () => {
  const deepest = Object.keys(ANC.txs).find((t) => !ANC.txs[t].status || ANC.txs[t].status.block_height === Math.min(...Object.values(ANC.txs).map((v) => v.status.block_height)));
  const down = makeShieldInputResolver({ esplora: recordedEsplora({ down: new Set([deepest]) }), network: 'signet', exits: noExits });
  await assert.rejects(down(ANC.target.txid, 0), TransparentUnavailableError, 'ancestor unreachable');
  const top = makeShieldInputResolver({ esplora: recordedEsplora({ down: new Set([ANC.target.txid]) }), network: 'signet', exits: noExits });
  await assert.rejects(top(ANC.target.txid, 0), TransparentUnavailableError, 'note itself unreachable');
  // The root outpoint is always a shield's own spent Bitcoin input, so a source not knowing it means the
  // source is behind or wrong, not that the note doesn't exist — the same rule as any other ancestor.
  const resolve = makeShieldInputResolver({ esplora: recordedEsplora(), network: 'signet', exits: noExits });
  await assert.rejects(resolve('ab'.repeat(32), 0), TransparentUnavailableError, 'unknown root outpoint');
  const x = { txid: 'cd'.repeat(32), vout: 1, asset: ASSET, ...pointXY(pedersen(5n, scalar('x'))) };
  const esplora = recordedEsplora();
  const withExit = makeShieldInputResolver({ esplora, network: 'signet', exits: () => new Map([[`${x.txid}:1`, x]]) });
  assert.deepEqual(await withExit(x.txid, 1), { asset: bytesToHex(ASSET), Cx: x.cx, Cy: x.cy });
  assert.equal(esplora.calls.length, 0);
});

test('dapp validateOutpoint: a T_BTC_SPEND output is not a note when no pool service is configured', () => {
  const exitTx = carrier(spendBytes({ hAnchor: 1, nfs: [nf('np')], exit: { vout: 0, destHash: new Uint8Array(32) } }));
  const t = parseTx(exitTx.raw).tx;
  const esp = { txid: t.txid, vin: t.vin.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })), vout: [], status: { confirmed: true } };
  const script = `
    import { JSDOM } from 'jsdom';
    const dom = new JSDOM('', { url: 'http://localhost/' });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location, __TACIT_NO_INIT__: true });
    localStorage.setItem('tacit-network-v1', 'signet');
    let fetched = 0; globalThis.fetch = async () => { fetched++; throw new Error('offline'); };
    const m = await import(${JSON.stringify(new URL('../dapp/tacit.js', import.meta.url).href)});
    const tx = ${JSON.stringify(esp)};
    const reasons = new Map();
    const ok = await m.validateOutpoint(tx.txid, 0, new Map(), async () => tx, 0, null, null, null, reasons);
    const pd = await m.getParentEnvelopeData(m.decodeEnvelopeScript(Uint8Array.from(Buffer.from(tx.vin[0].witness[1], 'hex'))), 0, tx.txid);
    console.log(JSON.stringify({ ok, pd, reason: reasons.get(tx.txid + ':0') }));
    process.exit(0);`;
  const env = { ...process.env }; delete env.TACIT_BTC_POOL_API;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('.', import.meta.url).pathname, env, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.ok, false);
  assert.equal(r.pd, null);
});

test('envelope script: multi-push payload round-trips; non-canonical forms rejected', () => {
  const payload = spendBytes({ hAnchor: 1, nfs: [nf(1), nf(2)], pay: [outBytes('a'), outBytes('b')], exit: { vout: 0, destHash: new Uint8Array(32) }, proof: new Uint8Array(512).fill(3) });
  assert.ok(payload.length > 3 * 520);
  const s = envelopeScript(payload);
  assert.deepEqual(decodeEnvelopeScript(s).payload, payload);
  assert.ok(bp.parseEnvelope(decodeEnvelopeScript(s).payload));
  assert.equal(decodeEnvelopeScript(concat(s, Uint8Array.of(0))), null, 'trailing after ENDIF');
  assert.equal(decodeEnvelopeScript(s.slice(0, s.length - 1)), null, 'no ENDIF');
  const badMagic = s.slice(); badMagic[38] ^= 1;
  assert.equal(decodeEnvelopeScript(badMagic), null, 'magic');
  const w = { vin: [{ witness: [new Uint8Array(64), s] }] };
  assert.equal(txEnvelope(w), null, 'witness needs 3 items');
});

// ── end to end over synthetic blocks ──
function fakeChain() {
  const blocks = []; // index = height - base
  const txs = new Map();
  const base = 500;
  const down = new Set(); // txids whose fetch fails as if the source were unreachable
  const heightOf = (txid) => blocks.findIndex((b) => b.txs.some((t) => t.txid === txid));
  return {
    blocks, txs, base, down,
    add(txList, prev = blocks.length ? blocks[blocks.length - 1].hash : 'ff'.repeat(32)) {
      const b = buildBlock(prev, base + blocks.length, txList);
      blocks.push(b);
      for (const t of b.txs) txs.set(t.txid, t.raw);
      return b;
    },
    esplora: {
      tipHeight: async () => base + blocks.length - 1,
      blockHash: async (h) => { const b = blocks[h - base]; if (!b) throw new Error('404'); return b.hash; },
      rawBlock: async (hash) => { const b = blocks.find((x) => x.hash === hash); if (!b) throw new Error('404'); return b.raw; },
      rawTx: async (txid) => {
        if (down.has(txid)) throw new Error('503 Service Unavailable');
        const r = txs.get(txid); if (!r) throw notFound(); return r;
      },
      txStatus: async (txid) => {
        if (down.has(txid)) throw new Error('503 Service Unavailable');
        const i = heightOf(txid); if (i < 0) throw notFound();
        return { confirmed: true, block_height: base + i, block_hash: blocks[i].hash };
      },
    },
  };
}
function call(handler, path, method = 'GET') {
  return new Promise((resolve) => {
    const res = { code: 0, writeHead(c) { this.code = c; }, end(b) { resolve({ code: this.code, body: b ? JSON.parse(b) : null }); } };
    handler({ method, url: path }, res);
  });
}

// The scenario's transactions carry real range proofs, so they are built once; each call mines a fresh chain.
let scenarioTxs = null;
function buildScenarioTxs() {
  const r0 = scalar('t0'), r1 = scalar('t1'), r2 = scalar('t2');
  const etch = etchTx(42n, r0);
  const creator = cxferTx(etch.asset, [{ outpoint: { txid: etch.txid, vout: 0 }, value: 42n, r: r0 }], [{ value: 40n, r: r1 }, { value: 2n, r: r2 }]);
  const ins = [{ value: 40n, r: r1, outpoint: { txid: creator.txid, vout: 0 } }, { value: 2n, r: r2, outpoint: { txid: creator.txid, vout: 1 } }];
  const sh = makeShield(ins, { asset: etch.asset, outs: ['e2e'] });
  const shTx = carrier(sh.bytes, { inputs: ins.map((i) => i.outpoint) });
  const junk = carrier(Uint8Array.of(0x6c, 1, 2, 3));
  const spk = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(8));
  const pay = carrier(spendBytes({ hAnchor: 501, nfs: [nf('e1')], pay: [outBytes('o1'), outBytes('o2')] }));
  const exit = carrier(spendBytes({ hAnchor: 501, nfs: [nf('e2')], exit: { vout: 1, destHash: sha256(spk) } }), { outputs: [{ spk: Uint8Array.of(0x6a) }, { spk }] });
  return { etch, creator, sh, shTx, junk, pay, exit };
}
async function scenario() {
  scenarioTxs ??= buildScenarioTxs();
  const { etch, creator, sh, shTx, junk, pay, exit } = scenarioTxs;
  const ch = fakeChain();
  ch.add([etch, creator]); // 500
  ch.add([junk, shTx]); // 501
  ch.add([pay, exit]); // 502
  ch.add([]); // 503
  return { ch, shTx, pay, exit, sh, creator, etch };
}
const trueVerifier = { enabled: true, verify: async () => true };
const newIndexer = (ch, extra = {}) => createIndexer({ store: openBtcPoolStore(':memory:'), esplora: ch.esplora, verifier: trueVerifier, network: 'signet', startHeight: 500, chain: TEST_CHAIN, log: () => {}, ...extra });

test('indexer: replays shields, pays and exits; persists; serves HTTP', async () => {
  const { ch, exit, sh, shTx, pay, etch } = await scenario();
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store });
  await ix.syncOnce();
  assert.equal(ix.state.tip, 503);
  assert.equal(ix.state.tree.size, 3);
  assert.equal(ix.state.nullifiers.size, 2);
  assert.ok(ix.state.exits.has(`${exit.txid}:1`));
  const h = createHandler(ix, store);
  const st = (await call(h, '/btc-pool/status')).body;
  assert.equal(st.height, 503); assert.equal(st.leafCount, 3); assert.equal(st.root, '0x' + bytesToHex(ix.state.tree.root()));
  assert.equal(st.verifierEnabled, true); assert.equal(st.halted, null); assert.equal(st.shieldInputValidation, 'canonical');
  const notes = (await call(h, '/btc-pool/notes?from=0&limit=2')).body;
  assert.equal(notes.notes.length, 2); assert.equal(notes.next, 2); assert.equal(notes.height, 503);
  const o = sh.outputs[0];
  assert.deepEqual(notes.notes[0], {
    leafIndex: 0, txid: shTx.txid, height: 501, leaf: '0x' + bytesToHex(leafOf(o)), asset: '0x' + bytesToHex(etch.asset),
    pk_eph: '0x' + bytesToHex(o.slice(32, 65)), ct_note: '0x' + bytesToHex(o.slice(65)),
  });
  assert.deepEqual([notes.notes[1].leafIndex, notes.notes[1].txid, notes.notes[1].leaf], [1, pay.txid, '0x' + bytesToHex(leafOf(outBytes('o1')))]);
  assert.deepEqual((await call(h, '/btc-pool/notes?from=3')).body.notes, []);
  // The feed is what the wallet scans: every field it reads is present.
  const feed = (await call(h, '/btc-pool/notes')).body.notes.map((n) => ({ leafIndex: n.leafIndex, leaf: n.leaf, asset: n.asset, pkEph: n.pk_eph, ctNote: n.ct_note }));
  assert.equal(feed.length, 3);
  assert.deepEqual(pool.scan(pool.walletFromSeed(new Uint8Array(32).fill(3), 'signet'), feed), []);
  const path = (await call(h, '/btc-pool/path/1')).body;
  assert.equal(bytesToHex(bp.rootFromPath(hexToBytes(path.leaf), 1, path.path.map(hexToBytes))), bytesToHex(ix.state.tree.root()));
  const at = (await call(h, '/btc-pool/path/0?at=501')).body;
  assert.equal(at.hAnchor, 501);
  assert.equal(at.root, '0x' + bytesToHex(ix.state.roots.get(501)));
  assert.equal(bytesToHex(bp.rootFromPath(hexToBytes(at.leaf), 0, at.path.map(hexToBytes))), bytesToHex(ix.state.roots.get(501)));
  assert.equal((await call(h, '/btc-pool/path/1?at=501')).code, 404, 'leaf 1 is not in the tree at 501');
  assert.equal((await call(h, '/btc-pool/path/0?at=abc')).code, 400);
  assert.equal((await call(h, '/btc-pool/path/0?at=10')).code, 404);
  assert.equal((await call(h, '/btc-pool/path/9')).code, 404);
  assert.equal((await call(h, `/btc-pool/nullifier/${bytesToHex(nf('e1'))}`)).body.spent, true);
  assert.equal((await call(h, `/btc-pool/nullifier/0x${bytesToHex(nf('e2'))}`)).body.height, 502);
  assert.equal((await call(h, `/btc-pool/nullifier/${'00'.repeat(32)}`)).body.spent, false);
  const { cx, cy } = pointXY(B5.C);
  assert.deepEqual((await call(h, `/btc-pool/exit/${exit.txid}/1`)).body, {
    exists: true, txid: exit.txid, vout: 1, height: 502, asset: '0x' + bytesToHex(ASSET), Cx: '0x' + bytesToHex(cx), Cy: '0x' + bytesToHex(cy),
  });
  assert.equal((await call(h, `/btc-pool/exit/${exit.txid}/0`)).body.exists, false);
  assert.equal((await call(h, '/btc-pool/root/501')).body.retained, true);
  assert.equal((await call(h, '/btc-pool/root/499')).code, 404);
  assert.equal((await call(h, '/btc-pool/roots')).body.roots.length, 4);
  assert.equal((await call(h, '/btc-pool/nope')).code, 404);
  assert.equal((await call(h, '/btc-pool/status', 'POST')).code, 405);
  const envs = store.db.prepare('SELECT * FROM envelopes ORDER BY height, tx_index').all();
  assert.deepEqual(envs.map((e) => e.accepted), [0, 1, 1, 1]);
  assert.match(envs[0].reason, /non-canonical/);
  // Restart from the database reproduces the live state, undo records included.
  const ix2 = newIndexer(ch, { store });
  assert.equal(fingerprint(ix2.state), fingerprint(ix.state));
  ix2.state.rollbackFrom(502); ix.state.rollbackFrom(502);
  assert.equal(fingerprint(ix2.state), fingerprint(ix.state));
  assert.throws(() => newIndexer(ch, { store, network: 'mainnet' }), /signet/);
  assert.throws(() => newIndexer(ch, { store, startHeight: 501 }), /starts at 500/);
});

test('indexer: reorg rolls back to the fork point and replays the new branch', async () => {
  const { ch } = await scenario();
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store });
  await ix.syncOnce();
  // Replace 502..503 with a branch that has no spends.
  ch.blocks.length = 2;
  ch.add([]); ch.add([]); ch.add([]);
  await ix.syncOnce();
  assert.equal(ix.state.tip, 504);
  assert.equal(ix.state.tree.size, 1);
  assert.equal(ix.state.nullifiers.size, 0);
  assert.equal(ix.state.exits.size, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM nullifiers').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM leaves').get().n, 1);
  assert.equal(store.block(502).hash, ch.blocks[2].hash);
  const fresh = newIndexer(ch);
  await fresh.syncOnce();
  assert.equal(fingerprint(fresh.state), fingerprint(ix.state));
});

test('indexer: without a verifier the first pool envelope halts the indexer, shield or spend', async () => {
  const { ch } = await scenario();
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store, verifier: { enabled: false, reason: 'missing', verify: null } });
  await assert.rejects(ix.syncOnce(), bp.VerifierUnavailableError);
  assert.equal(ix.state.tip, 500);
  assert.equal(ix.state.tree.size, 0);
  assert.equal(ix.state.pending, null);
  assert.deepEqual(ix.status().halted, { height: 501, txid: ch.blocks[1].txs[2].txid, reason: 'missing' });
  assert.equal(ix.status().verifierEnabled, false);
  assert.equal(store.tip().height, 500);
  // A chain whose first pool envelope is a spend halts there too.
  const c2 = fakeChain();
  c2.add([]);
  c2.add([carrier(spendBytes({ hAnchor: 500, nfs: [nf('h1')], pay: [outBytes('h1')] }))]);
  const ix2 = newIndexer(c2, { verifier: { enabled: false, reason: 'missing', verify: null } });
  await assert.rejects(ix2.syncOnce(), bp.VerifierUnavailableError);
  assert.equal(ix2.state.tip, 500);
  assert.equal(ix2.status().halted.height, 501);
  // Once a verifier is back the same database replays on.
  const ix3 = newIndexer(ch, { store });
  await ix3.syncOnce();
  assert.equal(ix3.state.tip, 503);
  assert.equal(ix3.status().halted, null);
});

test('indexer: verifier internal error stops the block without applying it', async () => {
  const { ch } = await scenario();
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store, verifier: { enabled: true, verify: async () => { throw new Error('exit 101'); } } });
  await assert.rejects(ix.syncOnce(), /exit 101/);
  assert.equal(ix.state.tip, 500);
  assert.equal(ix.state.pending, null);
  assert.equal(store.tip().height, 500);
  assert.equal(ix.status().halted.height, 501);
});

test('indexer: a shield of a note whose parent fails validation is rejected; a valid parent is shielded', async () => {
  const ch = fakeChain();
  const etch = etchTx(42n, scalar('ie'));
  // A CXFER that spends nothing it can open and declares 42 of the etched asset under a known blinding.
  const forged = cxferTx(etch.asset, [{ outpoint: { txid: etch.txid, vout: 0 }, value: 42n, r: scalar('ie') }], [{ value: 42n, r: scalar('if') }], { forge: true });
  ch.add([etch, forged]); // 500
  const bad = makeShield([{ value: 42n, r: scalar('if'), outpoint: { txid: forged.txid, vout: 0 } }], { asset: etch.asset, outs: ['bad'] });
  const good = makeShield([{ value: 42n, r: scalar('ie'), outpoint: { txid: etch.txid, vout: 0 } }], { asset: etch.asset, outs: ['good'] });
  // A valid note shielded under another asset id: the resolver's asset does not match.
  const wrongAsset = makeShield([{ value: 42n, r: scalar('ie'), outpoint: { txid: etch.txid, vout: 0 } }], { asset: OTHER_ASSET, outs: ['wa'] });
  ch.add([
    carrier(bad.bytes, { inputs: [{ txid: forged.txid, vout: 0 }] }),
    carrier(wrongAsset.bytes, { inputs: [{ txid: etch.txid, vout: 0 }] }),
    carrier(good.bytes, { inputs: [{ txid: etch.txid, vout: 0 }] }),
  ]); // 501
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store });
  await ix.syncOnce();
  assert.equal(ix.state.tip, 501);
  assert.equal(ix.state.tree.size, 1);
  assert.deepEqual(ix.state.tree.leaf(0), leafOf(good.outputs[0]));
  const envs = store.db.prepare('SELECT accepted, reason FROM envelopes ORDER BY tx_index').all();
  assert.deepEqual(envs.map((e) => e.accepted), [0, 0, 1]);
  assert.match(envs[0].reason, /not a valid note/);
  assert.match(envs[1].reason, /not a valid note/);
  assert.equal(ix.status().shieldInputValidation, 'canonical');
});

test('indexer: an unreachable ancestor halts the block, and it replays once the source is back', async () => {
  const { ch, etch } = await scenario();
  ch.down.add(etch.txid);
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store });
  await assert.rejects(ix.syncOnce(), TransparentUnavailableError);
  assert.equal(ix.state.tip, 500);
  assert.equal(ix.state.tree.size, 0);
  assert.equal(ix.state.pending, null);
  assert.equal(store.tip().height, 500);
  assert.equal(ix.status().halted.height, 501);
  assert.match(ix.status().halted.reason, /shield input unresolved/);
  ch.down.clear();
  await ix.syncOnce();
  assert.equal(ix.state.tip, 503);
  assert.equal(ix.state.tree.size, 3);
  assert.equal(ix.status().halted, null);
  const ref = newIndexer(ch);
  await ref.syncOnce();
  assert.equal(fingerprint(ix.state), fingerprint(ref.state));
});

test('seam: an accepted exit is a transparent note, directly and as an ancestor; an unrecorded 0x6D output is not', async () => {
  const { ch, exit } = await scenario();
  const rOut = scalar('seam-out');
  // Spends the exit note (5 under B5.r) into a fresh transparent note.
  const fromExit = cxferTx(ASSET, [{ outpoint: { txid: exit.txid, vout: 1 }, value: 5n, r: B5.r }], [{ value: 5n, r: rOut }]);
  // Same, but from vout 0 of the exit carrier, which the pool never recorded.
  const fromOther = cxferTx(ASSET, [{ outpoint: { txid: exit.txid, vout: 0 }, value: 5n, r: B5.r }], [{ value: 5n, r: scalar('seam-x') }]);
  ch.add([fromExit, fromOther]); // 504
  const viaCxfer = makeShield([{ value: 5n, r: rOut, outpoint: { txid: fromExit.txid, vout: 0 } }], { bd: B5b, outs: ['seam1'] });
  const viaOther = makeShield([{ value: 5n, r: scalar('seam-x'), outpoint: { txid: fromOther.txid, vout: 0 } }], { bd: B5b, outs: ['seam2'] });
  ch.add([
    carrier(viaCxfer.bytes, { inputs: [{ txid: fromExit.txid, vout: 0 }] }),
    carrier(viaOther.bytes, { inputs: [{ txid: fromOther.txid, vout: 0 }] }),
  ]); // 505
  const ix = newIndexer(ch);
  await ix.syncOnce();
  assert.equal(ix.state.tip, 505);
  assert.equal(ix.state.tree.size, 4, 'three from the scenario, one via the exit ancestry');
  assert.deepEqual(ix.state.tree.leaf(3), leafOf(viaCxfer.outputs[0]));

  // A shield spending the exit output itself resolves from the pool's own record.
  const s2 = await scenario();
  const direct = makeShield([{ value: 5n, r: B5.r, outpoint: { txid: s2.exit.txid, vout: 1 } }], { bd: B5b, outs: ['seam3'] });
  s2.ch.add([carrier(direct.bytes, { inputs: [{ txid: s2.exit.txid, vout: 1 }] })]); // 504
  const ix2 = newIndexer(s2.ch);
  await ix2.syncOnce();
  assert.equal(ix2.state.tree.size, 4);
  assert.deepEqual(ix2.state.tree.leaf(3), leafOf(direct.outputs[0]));
});

test('indexer: every input of a carrier is replayed in order; exits claim distinct outputs; vin[0] rules apply', async () => {
  const { ch } = await scenario();
  const spkA = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(0xa1)), spkB = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(0xb2));
  const exitTo = (t, vout, spk, extra = {}) => spendBytes({ hAnchor: 503, nfs: [nf(t)], exit: { vout, destHash: sha256(spk) }, ...extra });
  const pay = (t) => spendBytes({ hAnchor: 503, nfs: [nf(t)], pay: [outBytes('m' + t)] });
  const outs = [{ spk: spkA }, { spk: spkB }];
  // Three envelopes, two exits at distinct outputs, then a nullifier reused from vin[0].
  const m1 = multiCarrier([exitTo('m1a', 0, spkA), pay('m1b'), exitTo('m1c', 1, spkB), pay('m1a')], { outputs: outs });
  // vin[0] carries no envelope; the second exit to the same output is rejected.
  const m2 = multiCarrier([null, exitTo('m2a', 0, spkA), exitTo('m2b', 0, spkA)], { outputs: outs });
  // vin[0] holds a transparent op: the exit is rejected, the pay is not.
  const m3 = multiCarrier([Uint8Array.of(0x23, 1, 2, 3), exitTo('m3a', 0, spkA), pay('m3b')], { outputs: outs });
  // A shield on vin[0]: only vin[0] is read.
  const m4 = multiCarrier([Uint8Array.of(0x6c, 9), pay('m4b')]);
  // A shield on a later input.
  const m5 = multiCarrier([null, makeShield([inNote('m5', 5n)], { bd: B5b, outs: ['m5'] }).bytes]);
  ch.add([m1, m2, m3, m4, m5]); // 504
  assert.equal(txEnvelopes(parseTx(m1.raw).tx).filter(Boolean).length, 4);
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store });
  await ix.syncOnce();
  assert.equal(ix.state.tip, 504);
  const envs = store.db.prepare('SELECT tx_index, vin, accepted, reason FROM envelopes WHERE height = 504 ORDER BY tx_index, vin').all();
  const row = (tx, vin) => envs.find((e) => e.tx_index === tx && e.vin === vin);
  const txIndex = (t) => ch.blocks[4].txs.findIndex((x) => x.txid === t.txid);
  assert.deepEqual([0, 1, 2, 3].map((v) => row(txIndex(m1), v).accepted), [1, 1, 1, 0]);
  assert.match(row(txIndex(m1), 3).reason, /already spent/);
  assert.deepEqual([1, 2].map((v) => row(txIndex(m2), v).accepted), [1, 0]);
  assert.match(row(txIndex(m2), 2).reason, /already claimed/);
  assert.equal(row(txIndex(m2), 0), undefined);
  assert.equal(row(txIndex(m3), 0), undefined, 'the transparent op is not a pool envelope');
  assert.match(row(txIndex(m3), 1).reason, /transparent Tacit op/);
  assert.equal(row(txIndex(m3), 2).accepted, 1);
  assert.deepEqual(envs.filter((e) => e.tx_index === txIndex(m4)).map((e) => [e.vin, e.accepted]), [[0, 0]]);
  assert.match(row(txIndex(m5), 1).reason, /must ride vin\[0\]/);
  for (const k of [`${m1.txid}:0`, `${m1.txid}:1`, `${m2.txid}:0`]) assert.ok(ix.state.exits.has(k), k);
  assert.ok(!ix.state.exits.has(`${m3.txid}:0`));
  assert.equal(ix.state.exits.size, 1 + 3, 'the scenario exit plus three');
  assert.equal(ix.state.tree.size, 3 + 2);
  const h = createHandler(ix, store);
  assert.equal((await call(h, `/btc-pool/exit/${m1.txid}/1`)).body.exists, true);
  assert.equal((await call(h, `/btc-pool/exit/${m3.txid}/0`)).body.exists, false);
  // Restart and reorg reproduce the same state.
  const ix2 = newIndexer(ch, { store });
  assert.equal(fingerprint(ix2.state), fingerprint(ix.state));
  ix.state.rollbackFrom(504);
  assert.ok(!ix.state.exits.has(`${m1.txid}:0`));

  // Exits as ancestors: one riding vin[0], one riding a later input with no envelope on vin[0]; the rejected
  // exit's output is not a note.
  const from = (op, tag) => cxferTx(ASSET, [{ outpoint: op, value: 5n, r: B5.r }], [{ value: 5n, r: scalar(tag) }]);
  const c1 = from({ txid: m1.txid, vout: 1 }, 'anc1'), c2 = from({ txid: m2.txid, vout: 0 }, 'anc2'), c3 = from({ txid: m3.txid, vout: 0 }, 'anc3');
  ch.add([c1, c2, c3]); // 505
  const shieldOf = (c, tag) => {
    const sh = makeShield([{ value: 5n, r: scalar(tag), outpoint: { txid: c.txid, vout: 0 } }], { bd: B5b, outs: ['s' + tag] });
    return { sh, tx: carrier(sh.bytes, { inputs: [{ txid: c.txid, vout: 0 }] }) };
  };
  const s1 = shieldOf(c1, 'anc1'), s2 = shieldOf(c2, 'anc2'), s3 = shieldOf(c3, 'anc3');
  ch.add([s1.tx, s2.tx, s3.tx]); // 506
  const ix3 = newIndexer(ch);
  await ix3.syncOnce();
  assert.equal(ix3.state.tip, 506);
  assert.equal(ix3.state.tree.size, 5 + 2);
  assert.deepEqual(ix3.state.tree.leaf(5), leafOf(s1.sh.outputs[0]));
  assert.deepEqual(ix3.state.tree.leaf(6), leafOf(s2.sh.outputs[0]));
});

// esplora-shaped tx for tacit.validateOutpoint.
const espTx = (t) => {
  const x = parseTx(t.raw).tx;
  return {
    txid: x.txid, status: { confirmed: true, block_height: 330000 },
    vin: x.vin.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })),
    vout: x.vout.map((o) => ({ scriptpubkey: bytesToHex(o.scriptPubKey), value: Number(o.value) })),
  };
};
const fetchFrom = (...txs) => { const m = new Map(txs.map((t) => [t.txid, espTx(t)])); return async (id) => m.get(id) || null; };
const validate = async (fetchTx, txid, vout) => {
  const reasons = new Map();
  const ok = await tacit.validateOutpoint(txid, vout, new Map(), fetchTx, 0, null, null, null, reasons);
  return { ok, reason: reasons.get(`${txid}:${vout}`) };
};

test('dapp validateOutpoint: T_CXFER_BOUND validates like T_CXFER and resolves as a parent', async () => {
  const rE = scalar('bnd-e'), r1 = scalar('bnd-1'), r2 = scalar('bnd-2');
  const etch = etchTx(9n, rE);
  const boundOf = (ins, outs, { forge = false } = {}) => {
    const Cs = outs.map((o) => compress(pedersen(o.value, o.r)));
    const { proof } = bpRangeAggProve(outs.map((o) => o.value), outs.map((o) => o.r));
    const msg = tacit.computeKernelMsg(etch.asset, ins.map((i) => i.outpoint), Cs, 0n);
    const d = outs.reduce((a, o) => a + o.r, 0n) - ins.reduce((a, i) => a + i.r, 0n);
    const cx = tacit.encodeCXferPayload({ assetId: etch.asset, kernelSig: schnorrSign(msg, forge ? scalar('bf') : d), outputs: Cs.map((commitment) => ({ commitment, encryptedAmount: noAmount })), rangeproof: proof });
    const payload = concat(Uint8Array.of(0x39), keccak(te('target')), cx.subarray(1));
    return carrier(payload, { inputs: ins.map((i) => i.outpoint), outputs: outs.map((_, k) => ({ spk: Uint8Array.of(0x51, k) })) });
  };
  const ins = [{ outpoint: { txid: etch.txid, vout: 0 }, value: 9n, r: rE }];
  const good = boundOf(ins, [{ value: 4n, r: r1 }, { value: 5n, r: r2 }]);
  const forged = boundOf(ins, [{ value: 900n, r: r1 }], { forge: true });
  const next = cxferTx(etch.asset, [{ outpoint: { txid: good.txid, vout: 1 }, value: 5n, r: r2 }], [{ value: 5n, r: scalar('bnd-3') }]);
  const f = fetchFrom(etch, good, forged, next);
  assert.deepEqual(await validate(f, good.txid, 0), { ok: true, reason: undefined });
  assert.equal((await validate(f, good.txid, 1)).ok, true);
  assert.equal((await validate(f, good.txid, 2)).ok, false, 'no third output');
  assert.equal((await validate(f, forged.txid, 0)).ok, false, 'forged kernel');
  assert.equal((await validate(f, next.txid, 0)).ok, true, 'a CXFER spending a bound output');
  const env = tacit.txOutputEnvelope(espTx(good));
  const pd = await tacit.getParentEnvelopeData(env, 1, good.txid);
  assert.deepEqual(pd.commitment, compress(pedersen(5n, r2)));
  const resolve = makeShieldInputResolver({ esplora: recordedEsplora({ extra: new Map([[etch.txid, etch], [good.txid, good]]) }), network: 'signet', exits: noExits });
  const got = await resolve(good.txid, 0);
  assert.deepEqual(got.Cx, pointXY(pedersen(4n, r1)).cx);
  assert.equal(got.bound, true);
  // The indexer refuses a bound note as a shield input.
  const ch = fakeChain();
  ch.add([etch, good]); // 500
  const sh = makeShield([{ value: 4n, r: r1, outpoint: { txid: good.txid, vout: 0 } }], { asset: etch.asset, bd: B5b, outs: ['bnd'] });
  ch.add([carrier(sh.bytes, { inputs: [{ txid: good.txid, vout: 0 }] })]); // 501
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store });
  await ix.syncOnce();
  assert.equal(ix.state.tree.size, 0);
  assert.match(store.db.prepare('SELECT reason FROM envelopes').get().reason, /not a valid note/);
});

test('dapp validateOutpoint: T_CROSSOUT_MINT is a note only when the mint record names this tx; unknown is unavailable', async () => {
  const p2tr = (b) => Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(b));
  const rM = scalar('co-r');
  const { cx, cy } = pointXY(pedersen(12n, rM));
  const claim = (t) => keccak(te('claim' + t));
  const mintTx = (t, { spk = p2tr(0x77), c = [cx, cy] } = {}) =>
    carrier(concat(Uint8Array.of(0x65), ASSET, claim(t), c[0], c[1], new Uint8Array(32)), { outputs: [{ spk }, { spk: p2tr(0x78) }] });
  const minted = mintTx('ok'), other = mintTx('other'), undecided = mintTx('undecided'), rejected = mintTx('rej');
  const notP2tr = mintTx('p2wpkh', { spk: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20).fill(1)) });
  const offCurve = mintTx('curve', { c: [cx, b32(big(cy) ^ 1n)] });
  const status = new Map([
    [minted.txid, { decided: true, minted: true }],
    [other.txid, { decided: true, minted: false, mintedTxid: 'ab'.repeat(32) }],
    [rejected.txid, { decided: true, minted: false, status: 'rejected' }],
    [undecided.txid, { decided: false, minted: false }],
  ]);
  const seen = [];
  const hook = (url) => {
    if (!url.includes('/crossout/minted?')) return null;
    const q = new URL(url).searchParams;
    seen.push(q.get('txid'));
    assert.equal(q.get('network'), 'signet');
    assert.equal(q.get('asset'), bytesToHex(ASSET));
    return jsonRes(status.get(q.get('txid')) || { decided: false, minted: false });
  };
  const next = cxferTx(ASSET, [{ outpoint: { txid: minted.txid, vout: 0 }, value: 12n, r: rM }], [{ value: 12n, r: scalar('co-n') }]);
  const f = fetchFrom(minted, other, undecided, rejected, notP2tr, offCurve, next);
  await withFetch(hook, async () => {
    assert.deepEqual(await validate(f, minted.txid, 0), { ok: true, reason: undefined });
    assert.deepEqual(await validate(f, minted.txid, 1), { ok: false, reason: 'invalid' }, 'only vout 0');
    assert.deepEqual(await validate(f, other.txid, 0), { ok: false, reason: 'invalid' }, 'claim minted at another tx');
    assert.deepEqual(await validate(f, rejected.txid, 0), { ok: false, reason: 'invalid' });
    assert.deepEqual(await validate(f, undecided.txid, 0), { ok: false, reason: 'fetch-failed' });
    seen.length = 0;
    assert.deepEqual(await validate(f, notP2tr.txid, 0), { ok: false, reason: 'invalid' }, 'vout 0 not P2TR');
    assert.deepEqual(await validate(f, offCurve.txid, 0), { ok: false, reason: 'invalid' }, 'commitment off curve');
    assert.equal(seen.length, 0, 'decided locally');
    assert.equal((await validate(f, next.txid, 0)).ok, true, 'a CXFER spending the mint');
    const pd = await tacit.getParentEnvelopeData(tacit.txOutputEnvelope(espTx(minted)), 0, minted.txid);
    assert.deepEqual(pd, { assetIdHex: bytesToHex(ASSET), commitment: compress(pedersen(12n, rM)) });
    assert.equal(await tacit.getParentEnvelopeData(tacit.txOutputEnvelope(espTx(other)), 0, other.txid), null);

    // The pool refuses any T_CROSSOUT_MINT ancestry outright, in strict mode, with no worker call: a
    // deterministic reject rather than a halt, until proof-verified cross-out mints ship (design §9).
    const extra = new Map([minted, other, undecided, next].map((t) => [t.txid, t]));
    seen.length = 0;
    const resolve = makeShieldInputResolver({ esplora: recordedEsplora({ extra }), network: 'signet', exits: noExits });
    assert.equal(await resolve(minted.txid, 0), null, 'refused even though the worker would say minted');
    assert.equal(await resolve(other.txid, 0), null);
    assert.equal(await resolve(undecided.txid, 0), null, 'refused, not a halt');
    const nextU = cxferTx(ASSET, [{ outpoint: { txid: undecided.txid, vout: 0 }, value: 12n, r: rM }], [{ value: 12n, r: scalar('co-u') }]);
    extra.set(nextU.txid, nextU);
    assert.equal(await resolve(nextU.txid, 0), null, 'a descendant of a refused mint is refused, not shielded');
    assert.equal(await resolve(next.txid, 0), null, 'a descendant of a minted crossout is refused too');
    assert.equal(seen.length, 0, 'no worker call: the ancestry is refused before it would be consulted');
  });
  // No reachable status service: unknown.
  const lone = mintTx('offline');
  await withFetch((url) => (url.includes('/crossout/minted?') ? jsonRes({ error: 'down' }, 503) : null), async () => {
    assert.deepEqual(await validate(fetchFrom(lone), lone.txid, 0), { ok: false, reason: 'fetch-failed' });
  });
});

test('dapp validateOutpoint: an exit riding a later input, with no envelope on vin[0], resolves from the pool record', async () => {
  const spk = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(0x3c));
  const m = multiCarrier([null, spendBytes({ hAnchor: 1, nfs: [nf('late')], exit: { vout: 1, destHash: sha256(spk) } })], { outputs: [{ spk: Uint8Array.of(0x6a) }, { spk }] });
  const env = tacit.txOutputEnvelope(espTx(m));
  assert.equal(env.opcode, 0x6d);
  const x = { txid: m.txid, vout: 1, asset: ASSET, ...pointXY(B5.C) };
  const resolve = makeShieldInputResolver({ esplora: recordedEsplora({ extra: new Map([[m.txid, m]]) }), network: 'signet', exits: () => new Map([[`${m.txid}:1`, x]]) });
  const spender = cxferTx(ASSET, [{ outpoint: { txid: m.txid, vout: 1 }, value: 5n, r: B5.r }], [{ value: 5n, r: scalar('late-o') }]);
  const spender0 = cxferTx(ASSET, [{ outpoint: { txid: m.txid, vout: 0 }, value: 5n, r: B5.r }], [{ value: 5n, r: scalar('late-p') }]);
  const r2 = makeShieldInputResolver({ esplora: recordedEsplora({ extra: new Map([[m.txid, m], [spender.txid, spender], [spender0.txid, spender0]]) }), network: 'signet', exits: () => new Map([[`${m.txid}:1`, x]]) });
  assert.deepEqual((await resolve(m.txid, 1)).Cx, x.cx);
  assert.ok(await r2(spender.txid, 0), 'exit output as an ancestor');
  assert.equal(await r2(spender0.txid, 0), null, 'unrecorded output of the carrier');
  // A record whose commitment is not the carrier's exit commitment is not credited.
  const wrong = { ...x, ...pointXY(B5b.C) };
  const r3 = makeShieldInputResolver({ esplora: recordedEsplora({ extra: new Map([[m.txid, m], [spender.txid, spender]]) }), network: 'signet', exits: () => new Map([[`${m.txid}:1`, wrong]]) });
  assert.equal(await r3(spender.txid, 0), null, 'record does not match the carrier');
});

// ── real Groth16 proofs of spend.circom ──
const PIN_DIR = new URL('../dapp/btc-pool/', import.meta.url);
const PIN = JSON.parse(readFileSync(new URL('pin.json', PIN_DIR), 'utf8'));
const VK = JSON.parse(readFileSync(new URL(PIN.vk, PIN_DIR), 'utf8'));
let SYS = null;
const system = () => (SYS ??= makeGroth16System({ vk: VK, wasm: readFileSync(new URL(PIN.wasm, PIN_DIR)), zkey: readFileSync(new URL(PIN.zkey, PIN_DIR)), snarkjs, pinnedVkHash: PIN.vk_hash }));

test('real proofs: shield, pay + exit, pay with change; tampered proof, tampered body and wrong root rejected', async () => {
  const sys = system();
  const verifyProof = ({ proof, publics }) => sys.verify(publics, proof);
  const alice = pool.walletFromSeed(new Uint8Array(32).fill(1), 'signet');
  const bob = pool.walletFromSeed(new Uint8Array(32).fill(2), 'signet');
  const carol = pool.walletFromSeed(new Uint8Array(32).fill(4), 'signet');
  const r0 = 12345n;
  const C = pool.commitXY(1000n, r0);
  const txin = { txid: 'cd'.repeat(32), vout: 1, value: 1000n, blinding: r0, Cx: C.cx, Cy: C.cy };
  const assetHex = bytesToHex(ASSET);
  const resolveInput = async (op, a) => (op.txid === txin.txid && op.vout === 1 && a === assetHex ? { cx: C.cx, cy: C.cy } : null);
  const shInputs = [{ txid: 'aa'.repeat(32), vout: 0 }, { txid: txin.txid, vout: 1 }];

  // Shield.
  const sh = pool.buildShieldEnvelope({ asset: ASSET, inputs: [txin], recipientAddress: alice.addressString });
  const { payload: shPayload } = await pool.prove(sh, sys);
  const shParsed = bp.parseEnvelope(shPayload);
  assert.equal(shParsed.kind, 'shield');
  assert.equal(shParsed.proof.length, 256);
  const st = new bp.BtcPoolState();
  st.beginBlock(100);
  const shCtx = { txid: 'ee'.repeat(32), inputs: shInputs, resolveInput, verifyProof };
  const badShield = shPayload.slice(); badShield[badShield.length - 256 + 40] ^= 1;
  assert.match((await st.acceptShield(bp.parseEnvelope(badShield), shCtx)).reason, /proof does not verify/, 'tampered shield proof');
  const rs = await st.acceptShield(shParsed, shCtx);
  assert.ok(rs.accepted, rs.reason);
  st.endBlock();
  for (let h = 101; h <= 110; h++) { st.beginBlock(h); st.endBlock(); }
  const mine = pool.scan(alice, rs.leaves);
  assert.deepEqual(mine.map((x) => x.value), [1000n]);
  assert.equal(mine[0].leafIndex, 0);

  // Pay + exit, anchored at 102.
  const hA = 102;
  const { root, path } = st.tree.rootAndPathAt(mine[0].leafIndex, st.leafCountAt(hA));
  assert.deepEqual(root, st.roots.get(hA));
  const exitSpk = '0014' + '11'.repeat(20);
  const sp = pool.buildSpendBody({ asset: ASSET, hAnchor: hA, root, inputs: [{ ...mine[0], path }], outputs: [{ address: bob.addressString, value: 300n }], exit: { exitVout: 0, scriptPubKey: '0x' + exitSpk }, wallet: alice });
  const { payload: spPayload } = await pool.prove(sp, sys);
  const spParsed = bp.parseEnvelope(spPayload);
  assert.equal(spParsed.kind, 'spend');
  assert.ok(spParsed.exit);
  const outputs = [{ value: 546n, scriptPubKey: hexToBytes(exitSpk) }];
  const spCtx = (extra = {}) => ({ txid: 'ff'.repeat(32), inputs: [], outputs, vin0TacitOp: false, verifyProof, ...extra });

  // Wrong root: the same anchor height over a tree with one more leaf.
  const alt = new bp.BtcPoolState();
  alt.beginBlock(99); alt.endBlock();
  alt.beginBlock(100);
  assert.ok((await alt.acceptShield(shParsed, { ...shCtx, verifyProof: accept })).accepted);
  assert.ok((await alt.acceptSpend(paySpend(99, [nf('alt')], 'alt'), spendCtx())).accepted);
  alt.endBlock();
  for (let h = 101; h <= 110; h++) { alt.beginBlock(h); alt.endBlock(); }
  alt.beginBlock(111);
  assert.notDeepEqual(alt.roots.get(hA), st.roots.get(hA));
  assert.match((await alt.acceptSpend(spParsed, spCtx())).reason, /proof does not verify/, 'wrong root');

  st.beginBlock(111);
  const badProof = spPayload.slice(); badProof[badProof.length - 256 + 100] ^= 1;
  assert.match((await st.acceptSpend(bp.parseEnvelope(badProof), spCtx())).reason, /proof does not verify/, 'tampered proof');
  // A byte of an output's ct_note: still canonical, but the body hash the proof binds changes.
  const ctOff = PRE + 1 + 32 + 1 + 32 + 33;
  const badBody = spPayload.slice(); badBody[ctOff] ^= 1;
  const bb = bp.parseEnvelope(badBody);
  assert.ok(bb, 'still parses');
  assert.match((await st.acceptSpend(bb, spCtx())).reason, /proof does not verify/, 'tampered body');
  assert.match((await st.acceptSpend(spParsed, spCtx({ vin0TacitOp: true }))).reason, /transparent Tacit op/);
  assert.match((await st.acceptSpend(spParsed, spCtx({ outputs: [{ value: 546n, scriptPubKey: Uint8Array.of(0x51) }] }))).reason, /dest_spk_hash/);
  const r2 = await st.acceptSpend(spParsed, spCtx());
  assert.ok(r2.accepted, r2.reason);
  assert.deepEqual([bytesToHex(r2.exit.cx), bytesToHex(r2.exit.cy)], [sp.exit.cx.slice(2), sp.exit.cy.slice(2)]);
  assert.deepEqual(r2.nullifiers, [mine[0].nf.slice(2)]);
  st.endBlock();
  const bobNotes = pool.scan(bob, r2.leaves);
  assert.deepEqual(bobNotes.map((x) => x.value), [300n]);
  const rec = pool.recoverExit(alice, spPayload, mine, {});
  assert.equal(rec.value, 700n);
  assert.deepEqual([rec.cx, rec.cy], [sp.exit.cx, sp.exit.cy]);

  // Bob pays carol 100; change 200 and a zero pad go to his internal address (3 outputs).
  st.beginBlock(112);
  const h2 = 111;
  const bn = bobNotes[0];
  const p2 = st.tree.rootAndPathAt(bn.leafIndex, st.leafCountAt(h2));
  const pay = pool.buildSpendBody({ asset: ASSET, hAnchor: h2, root: p2.root, inputs: [{ ...bn, path: p2.path }], outputs: [{ address: carol.addressString, value: 100n }], wallet: bob });
  const { payload: payPayload } = await pool.prove(pay, sys);
  const payParsed = bp.parseEnvelope(payPayload);
  assert.equal(payParsed.outputs.length, 3);
  assert.equal(payParsed.exit, null);
  const r3 = await st.acceptSpend(payParsed, spCtx({ txid: '12'.repeat(32), outputs: [] }));
  assert.ok(r3.accepted, r3.reason);
  st.endBlock();
  assert.deepEqual(pool.scan(carol, r3.leaves).map((x) => x.value), [100n]);
  assert.deepEqual(pool.scan(bob, r3.leaves).map((x) => [x.value, x.internal]).sort((a, b) => Number(a[0] - b[0])), [[0n, true], [200n, true]]);
  assert.equal(st.tree.size, 1 + 1 + 3);
  // Replayed in a later block, the spend is a double spend.
  st.beginBlock(113);
  assert.match((await st.acceptSpend(payParsed, spCtx({ txid: '13'.repeat(32), outputs: [] }))).reason, /already spent/);
  assert.match((await st.acceptSpend(spParsed, spCtx({ txid: '14'.repeat(32) }))).reason, /already spent/);
  st.endBlock();
  // The pinned verifier and the proving system agree on the envelope's public signals.
  assert.equal(await sys.verify(bp.envelopePublics(payParsed, { root: st.roots.get(h2) }), payParsed.proof), true);
  assert.equal(await sys.verify(bp.envelopePublics(payParsed, { root: st.roots.get(h2 - 1) }), payParsed.proof), false);
  // The indexer's pinned verifier reaches the same verdicts.
  const pinned = makeBtcPoolVerifier({ network: 'signet', env: {}, log: () => {} }).verify;
  assert.equal(await pinned({ proof: shParsed.proof, publics: bp.envelopePublics(shParsed, { boundaryC: unpackPoint(shParsed.boundary.cBjj) }) }), true, 'shield');
  assert.equal(await pinned({ proof: spParsed.proof, publics: bp.envelopePublics(spParsed, { root: st.roots.get(hA), boundaryC: unpackPoint(spParsed.exit.boundary.cBjj) }) }), true, 'pay + exit');
  assert.equal(await pinned({ proof: payParsed.proof, publics: bp.envelopePublics(payParsed, { root: st.roots.get(h2) }) }), true, 'pay');
  assert.equal(await pinned({ proof: spParsed.proof, publics: bp.envelopePublics(spParsed, { root: st.roots.get(hA) }) }), false, 'exitC omitted');
  assert.equal(await pinned({ proof: bp.parseEnvelope(badProof).proof, publics: bp.envelopePublics(spParsed, { root: st.roots.get(hA), boundaryC: unpackPoint(spParsed.exit.boundary.cBjj) }) }), false, 'tampered');
});

test('verifier: pinned key loads; a mismatched pin disables it; garbage proofs fail; reference proofs verify', async () => {
  const v = makeBtcPoolVerifier({ network: 'signet', env: {}, log: () => {} });
  assert.equal(v.enabled, true, v.reason);
  assert.equal(v.vkHash, PIN.vk_hash);
  assert.equal(vkHash(VK), PIN.vk_hash);
  const logs = [];
  const off = makeBtcPoolVerifier({ network: 'signet', env: { BTC_POOL_VK_HASH: 'ab'.repeat(32) }, log: (m) => logs.push(m) });
  assert.equal(off.enabled, false);
  assert.equal(off.verify, null);
  assert.match(off.reason, /not the pinned/);
  assert.equal(logs.length, 1);
  assert.equal(makeBtcPoolVerifier({ network: 'mainnet', env: {}, log: () => {} }).enabled, false, 'signet pin on mainnet');
  const pubs = Array(12).fill('0');
  assert.equal(await v.verify({ proof: PROOF, publics: pubs }), false);
  assert.equal(await v.verify({ proof: new Uint8Array(255), publics: pubs }), false);
  const V = JSON.parse(readFileSync(new URL('./vectors/btc-pool-zk-vectors.json', import.meta.url), 'utf8')).groth16;
  const rv = makeBtcPoolVerifier({ vk: V.vk, vkHash: vkHash(V.vk), log: () => {} });
  for (const c of V.cases) assert.equal(await rv.verify({ proof: hexToBytes(c.proof), publics: c.publics }), c.valid, c.name);
});

const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const [name, fn] of tests) {
  if (only && !only.test(name)) continue;
  const ts = performance.now();
  try { await fn(); passed++; console.log('  ok -', name, process.env.TIMING ? `(${((performance.now() - ts) / 1000).toFixed(1)} s)` : ''); }
  catch (e) { console.error('  FAIL -', name); console.error(e); process.exitCode = 1; }
}
console.log(`${passed}/${only ? tests.filter(([n]) => only.test(n)).length : tests.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
// tacit.js and the prover leave timers and workers running.
process.exit(process.exitCode ?? 0);
