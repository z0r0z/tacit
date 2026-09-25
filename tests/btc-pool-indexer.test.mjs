// Bitcoin-native shielded pool indexer: parsers, shield kernel, spend acceptance, undo/rollback, raw block
// parsing, canonical shield-input validation (recorded signet ancestry + synthetic Tacit txs), and an
// end-to-end replay over synthetic blocks. No network.
//   node tests/btc-pool-indexer.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import * as bp from '../worker/src/btc-shielded-pool.js';
import { execFileSync } from 'node:child_process';
import {
  parseBlock, parseTx, decodeEnvelopeScript, txEnvelope, txEnvelopes,
} from '../worker-relay/src/lib/btc-pool-chain.js';
import { openBtcPoolStore } from '../worker-relay/src/lib/btc-pool-store.js';
import { createIndexer, createHandler } from '../worker-relay/src/btc-pool-indexer.js';
import { loadTacit, makeShieldInputResolver, TransparentUnavailableError } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { bpRangeAggProve } from './bulletproofs.mjs';

// Every fetch tacit.js makes goes through here, so tests can answer worker reads.
const baseFetch = globalThis.fetch;
let fetchHook = null;
globalThis.fetch = (input, init) => (fetchHook && fetchHook(String(input?.url ?? input), init)) || baseFetch(input, init);
const withFetch = async (hook, fn) => { fetchHook = hook; try { return await fn(); } finally { fetchHook = null; } };
const jsonRes = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

const tacit = await loadTacit('signet');

const { concat, hexToBytes, bytesToHex, sha256, keccak, mulPoint, G, H, pointXY } = bp;
const N = rootSecp.CURVE.n;
const P = rootSecp.CURVE.p;

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── helpers ──
const big = (b) => BigInt('0x' + bytesToHex(b));
const b32 = (n) => hexToBytes(n.toString(16).padStart(64, '0'));
const u32le = (v) => Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
const u16le = (v) => Uint8Array.of(v & 0xff, v >> 8);
const u64le = (v) => { const o = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const scalar = (tag) => (big(keccak(new TextEncoder().encode(String(tag)))) % (N - 1n)) + 1n;
const compress = (Pt) => { const { cx, cy } = pointXY(Pt); return concat(Uint8Array.of(cy[31] & 1 ? 3 : 2), cx); };
const tagged = (tag, ...parts) => { const t = sha256(new TextEncoder().encode(tag)); return sha256(t, t, ...parts); };

function schnorrSign(msg, d) {
  d = ((d % N) + N) % N;
  const Pt = mulPoint(G, d);
  const { cx: px, cy: py } = pointXY(Pt);
  if (py[31] & 1) d = N - d;
  let k = big(sha256(b32(d), msg)) % N || 1n;
  const R = mulPoint(G, k);
  const { cx: rx, cy: ry } = pointXY(R);
  if (ry[31] & 1) k = N - k;
  const e = big(tagged('BIP0340/challenge', rx, px, msg)) % N;
  return concat(rx, b32((k + e * d) % N));
}

function noteKeys(tag) {
  return {
    spendKey: pointXY(mulPoint(G, scalar('a' + tag))).cx,
    nkPub: compress(mulPoint(G, scalar('n' + tag))),
    pkEph: compress(mulPoint(G, scalar('e' + tag))),
    ctNote: concat(keccak(new TextEncoder().encode('ct' + tag)), keccak(new TextEncoder().encode('ct2' + tag)).slice(0, 24)),
  };
}

const ASSET = keccak(new TextEncoder().encode('asset'));
const OTHER_ASSET = keccak(new TextEncoder().encode('other-asset'));

function shieldBytes({ asset = ASSET, nIn, C, keys, sig }) {
  const { cx, cy } = pointXY(C);
  return concat(Uint8Array.of(0x6c), asset, Uint8Array.of(nIn), cx, cy, keys.spendKey, keys.nkPub, keys.pkEph, keys.ctNote, sig);
}

// Valid shield of transparent notes {value, r, outpoint} into one pool note.
function makeShield(inputs, { asset = ASSET, tag = 's', poolValue, poolR = scalar('pr' + tag), signKey } = {}) {
  const v = poolValue ?? inputs.reduce((s, i) => s + i.value, 0n);
  const C = bp.pedersen(v, poolR);
  const keys = noteKeys(tag);
  const unsigned = { asset, nIn: inputs.length, ...pointXY(C), ...keys };
  const msg = bp.shieldKernelMsg(unsigned, inputs.map((i) => i.outpoint));
  const d = signKey ?? (poolR - inputs.reduce((s, i) => s + i.r, 0n));
  return { bytes: shieldBytes({ asset, nIn: inputs.length, C, keys, sig: schnorrSign(msg, d) }), C, keys, v, poolR };
}

function payOut(tag, value) {
  const C = bp.pedersen(value, scalar('or' + tag));
  const k = noteKeys(tag);
  const { cx, cy } = pointXY(C);
  return concat(cx, cy, k.spendKey, k.nkPub, k.pkEph, k.ctNote);
}
// 0x6D ‖ asset ‖ h_anchor ‖ n_in ‖ nf×n_in ‖ n_out ‖ output×n_out ‖ has_exit ‖ [exit] ‖ proof_len ‖ proof.
function spendBytes({ asset = ASSET, hAnchor, nfs, pay = [], exit = null, proof = new Uint8Array(260).fill(7), proofLen }) {
  const parts = [Uint8Array.of(0x6d), asset, u32le(hAnchor), Uint8Array.of(nfs.length), ...nfs, Uint8Array.of(pay.length), ...pay];
  if (exit) {
    const { cx, cy } = pointXY(bp.pedersen(exit.value ?? 5n, exit.r ?? scalar('exit')));
    parts.push(Uint8Array.of(1), u32le(exit.vout), cx, cy, exit.destHash);
  } else parts.push(Uint8Array.of(0));
  parts.push(u16le(proofLen ?? proof.length), proof);
  return concat(...parts);
}
const nf = (t) => keccak(new TextEncoder().encode('nf' + t));

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
  const parts = [push(key), Uint8Array.of(0xac, 0x00, 0x63), push(new TextEncoder().encode('TACIT')), push(Uint8Array.of(1))];
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
const fakeOutpoint = (tag) => ({ txid: bytesToHex(keccak(new TextEncoder().encode('op' + tag))), vout: 0 });
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
    witness0: [new Uint8Array(64), envelopeScript(payload), new Uint8Array(33).fill(0xc0)],
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
function buildBlock(prevHash, height, txs) {
  const all = [coinbase(height, txs), ...txs];
  const level = merkle(all.map((t) => hexToBytes(t.txid).reverse()));
  const header = concat(u32le(0x20000000), hexToBytes(prevHash).reverse(), level[0], u32le(1700000000 + height), u32le(0x1d00ffff), u32le(nonceCtr++));
  const raw = concat(header, varint(all.length), ...all.map((t) => t.raw));
  return { raw, hash: bytesToHex(sha256d(header).reverse()), txs: all };
}

// Transparent Tacit txs built with the dapp's own encoders and a real range prover, so they pass (or, when
// forged, fail) the canonical validator exactly as on chain.
const noAmount = new Uint8Array(8);
function etchTx(value, r, { badProof = false } = {}) {
  const { proof } = bpRangeAggProve([badProof ? value + 1n : value], [r]);
  const payload = tacit.encodeCEtchPayload({ ticker: 'TP', decimals: 0, commitment: compress(bp.pedersen(value, r)), rangeproof: proof, encryptedAmount: noAmount });
  const t = carrier(payload);
  return { ...t, asset: tacit.assetIdFor(t.txid, 0) };
}
// ins [{ outpoint, value, r }] → outs [{ value, r }]. `forge` signs the kernel with an unrelated key.
function cxferTx(asset, ins, outs, { forge = false } = {}) {
  const Cs = outs.map((o) => compress(bp.pedersen(o.value, o.r)));
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
  const msg = sha256(new TextEncoder().encode('m'));
  const d = scalar('k');
  const sig = schnorrSign(msg, d);
  const px = pointXY(mulPoint(G, d)).cx;
  assert.ok(bp.bip340Verify(sig, msg, px));
  const bad = sig.slice(); bad[63] ^= 1;
  assert.ok(!bp.bip340Verify(bad, msg, px));
  assert.ok(!bp.bip340Verify(sig, sha256(msg), px));
  const hi = sig.slice(); hi.set(b32(N), 32);
  assert.ok(!bp.bip340Verify(hi, msg, px));
});

test('tree matches dapp confidential-pool Tree (roots, paths) and truncates exactly', () => {
  const pool = makeConfidentialPool({ secp: rootSecp, keccak256: keccak_256, sha256: nobleSha256 });
  const ref = new pool.Tree();
  const t = new bp.KeccakTree();
  assert.equal('0x' + bytesToHex(t.root()), ref.root());
  const roots = [bytesToHex(t.root())];
  for (let i = 0; i < 11; i++) {
    const leaf = keccak(Uint8Array.of(i));
    ref.insert('0x' + bytesToHex(leaf));
    t.append(leaf);
    roots.push(bytesToHex(t.root()));
    assert.equal('0x' + bytesToHex(t.root()), ref.root());
    for (const j of [0, i, Math.floor(i / 2), i + 1]) {
      const a = ref.rootAndPath(j), b = t.rootAndPath(j);
      assert.deepEqual(b.path.map((x) => '0x' + bytesToHex(x)), a.path);
      if (j <= i) assert.equal(bytesToHex(bp.rootFromPath(t.leaf(j), j, b.path)), bytesToHex(t.root()));
    }
  }
  for (let n = 11; n >= 0; n--) { t.truncate(n); assert.equal(bytesToHex(t.root()), roots[n]); }
});

test('spend public values are abi.encode(uint16 1, root, keccak(body))', () => {
  const root = keccak(Uint8Array.of(1)), body = Uint8Array.of(0x6d, 1, 2);
  const pv = bp.spendPublicValues(root, body);
  assert.equal(pv.length, 96);
  assert.equal(bytesToHex(pv.subarray(0, 32)), '00'.repeat(31) + '01');
  assert.deepEqual(pv.subarray(32, 64), root);
  assert.deepEqual(pv.subarray(64), keccak(body));
});

test('nullifier binds leaf, nk_note and leaf position', () => {
  const leaf = keccak(Uint8Array.of(5));
  const a = bp.nullifier(leaf, 7n, 0), b = bp.nullifier(leaf, 7n, 1), c = bp.nullifier(leaf, 8n, 0);
  assert.notDeepEqual(a, b); assert.notDeepEqual(a, c);
  assert.deepEqual(a, keccak(new TextEncoder().encode('tacit-btc-pool-nf-v1'), leaf, b32(7n), new Uint8Array(8)));
});

// ── parsers ──
const inNote = (tag, value) => ({ value, r: scalar('r' + tag), outpoint: fakeOutpoint(tag) });

test('parseShield: valid envelope', () => {
  const s = makeShield([inNote('a', 10n)]);
  assert.equal(s.bytes.length, 316);
  const p = bp.parseShield(s.bytes);
  assert.ok(p);
  assert.equal(p.nIn, 1);
  assert.deepEqual(p.nkPub, s.keys.nkPub);
});

test('parseShield: every malformed case', () => {
  const good = makeShield([inNote('a', 10n)]).bytes;
  const mut = (off, val) => { const b = good.slice(); b[off] = val; return b; };
  const setAt = (off, bytes) => { const b = good.slice(); b.set(bytes, off); return b; };
  const O = { nIn: 33, cx: 34, cy: 66, sk: 98, nk: 130, eph: 163 };
  assert.equal(bp.parseShield(good.slice(0, 315)), null, 'short');
  assert.equal(bp.parseShield(concat(good, Uint8Array.of(0))), null, 'trailing');
  assert.equal(bp.parseShield(mut(0, 0x6d)), null, 'opcode');
  assert.equal(bp.parseShield(mut(O.nIn, 0)), null, 'n_in 0');
  assert.equal(bp.parseShield(mut(O.nIn, 9)), null, 'n_in 9');
  assert.ok(bp.parseShield(mut(O.nIn, 8)), 'n_in 8 parses');
  assert.equal(bp.parseShield(mut(O.cy + 31, good[O.cy + 31] ^ 1)), null, 'off-curve C');
  assert.equal(bp.parseShield(setAt(O.cx, b32(P + 1n))), null, 'Cx >= p');
  const { cx, cy } = pointXY(makeShield([inNote('a', 10n)]).C);
  assert.equal(bp.parseShield(setAt(O.cy, b32(P))), null, 'Cy >= p');
  assert.equal(bp.pointFromXY(cx, b32(P - big(cy))) !== null, true, 'negated y is on curve');
  let nonX = 5n; while (bp.liftX(b32(nonX))) nonX++;
  assert.equal(bp.parseShield(setAt(O.sk, b32(nonX))), null, 'spend_key not on curve');
  assert.equal(bp.parseShield(setAt(O.sk, b32(P))), null, 'spend_key >= p');
  assert.equal(bp.parseShield(mut(O.nk, 0x04)), null, 'nk_pub prefix');
  assert.equal(bp.parseShield(setAt(O.nk + 1, b32(nonX))), null, 'nk_pub not on curve');
  assert.equal(bp.parseShield(mut(O.eph, 0x00)), null, 'pk_eph prefix');
  assert.equal(bp.parseShield(setAt(O.eph + 1, b32(P + 2n))), null, 'pk_eph x >= p');
});

test('parseSpend: valid pay (1/1, 2/2, 1/3), exit, partial exit; body excludes proof_len', () => {
  const one = spendBytes({ hAnchor: 100, nfs: [nf(1)], pay: [payOut('p', 3n)] });
  const p1 = bp.parseSpend(one);
  assert.ok(p1);
  assert.equal(p1.hAnchor, 100);
  assert.equal(p1.outputs.length, 1);
  assert.equal(p1.exit, null);
  assert.equal(p1.body.length, one.length - 2 - 260);
  assert.equal(p1.body.length, 1 + 32 + 4 + 1 + 32 + 1 + 218 + 1);
  assert.equal(p1.proof.length, 260);
  const two = bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1), nf(2)], pay: [payOut('p', 1n), payOut('q', 2n)] }));
  assert.equal(two.nullifiers.length, 2); assert.equal(two.outputs.length, 2);
  const three = bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [payOut('p', 1n), payOut('q', 2n), payOut('r', 3n)] }));
  assert.equal(three.outputs.length, 3);
  const ex = bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 3, destHash: sha256(Uint8Array.of(1)) } }));
  assert.equal(ex.outputs.length, 0); assert.equal(ex.exit.exitVout, 3);
  assert.deepEqual(ex.exit.destSpkHash, sha256(Uint8Array.of(1)));
  assert.equal(ex.body.length, 1 + 32 + 4 + 1 + 32 + 1 + 1 + 100);
  const partial = bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1), nf(2)], pay: [payOut('p', 1n)], exit: { vout: 70000, destHash: new Uint8Array(32) } }));
  assert.equal(partial.outputs.length, 1); assert.equal(partial.exit.exitVout, 70000);
  assert.ok(bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 0, destHash: new Uint8Array(32) }, proof: new Uint8Array(512) })));
  assert.ok(bp.parseSpend(spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 0, destHash: new Uint8Array(32) }, proof: new Uint8Array(0) })));
});

test('parseSpend: every malformed case', () => {
  const pay = [payOut('p', 3n)];
  const good = spendBytes({ hAnchor: 100, nfs: [nf(1)], pay });
  const mut = (off, val) => { const b = good.slice(); b[off] = val; return b; };
  const HAS_EXIT = 1 + 32 + 4 + 1 + 32 + 1 + 218;
  assert.equal(bp.parseSpend(mut(0, 0x6c)), null, 'opcode');
  assert.equal(bp.parseSpend(mut(37, 0)), null, 'n_in 0');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1), nf(2), nf(3)], pay })), null, 'n_in 3');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [pay[0], pay[0], pay[0], pay[0]] })), null, 'n_out 4');
  assert.equal(bp.parseSpend(mut(70, 4)), null, 'n_out byte 4');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)] })), null, 'no output and no exit');
  assert.equal(bp.parseSpend(mut(HAS_EXIT, 2)), null, 'has_exit 2');
  assert.equal(bp.parseSpend(mut(HAS_EXIT, 1)), null, 'has_exit 1 without exit bytes');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay, proof: new Uint8Array(513) })), null, 'proof 513');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay, proofLen: 259 })), null, 'proof_len short of proof');
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay, proofLen: 261 })), null, 'proof_len beyond proof');
  assert.equal(bp.parseSpend(concat(good, Uint8Array.of(0))), null, 'trailing');
  for (const cut of [1, 36, 38, 70, 71, 100, 71 + 218, HAS_EXIT + 1, HAS_EXIT + 2, good.length - 261]) assert.equal(bp.parseSpend(good.slice(0, cut)), null, `truncated at ${cut}`);
  const badOut = pay[0].slice(); badOut[32 + 31] ^= 1;
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [badOut] })), null, 'pay C off curve');
  const badNk = pay[0].slice(); badNk[96] = 0x05;
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [badNk] })), null, 'pay nk_pub');
  const badEph = pay[0].slice(); badEph.set(b32(P), 130);
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [badEph] })), null, 'pay pk_eph');
  let nonX = 5n; while (bp.liftX(b32(nonX))) nonX++;
  const badSk = pay[0].slice(); badSk.set(b32(nonX), 64);
  assert.equal(bp.parseSpend(spendBytes({ hAnchor: 1, nfs: [nf(1)], pay: [badSk] })), null, 'pay spend_key');
  const ex = spendBytes({ hAnchor: 7, nfs: [nf(1)], exit: { vout: 0, destHash: new Uint8Array(32) } });
  const exBad = ex.slice(); exBad[1 + 32 + 4 + 1 + 32 + 1 + 1 + 4 + 63] ^= 1;
  assert.equal(bp.parseSpend(exBad), null, 'exit C off curve');
  const exCxP = ex.slice(); exCxP.set(b32(P + 1n), 1 + 32 + 4 + 1 + 32 + 1 + 1 + 4);
  assert.equal(bp.parseSpend(exCxP), null, 'exit Cx >= p');
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
const resolverFor = (notes) => async (op, assetHex) => {
  const n = notes.get(`${op.txid}:${op.vout}`);
  if (!n || n.asset !== assetHex) return null;
  return pointXY(bp.pedersen(n.value, n.r));
};
function shieldCtx(inputs, extra = {}) {
  const notes = new Map(inputs.map((i) => [`${i.outpoint.txid}:${i.outpoint.vout}`, { ...i, asset: bytesToHex(ASSET) }]));
  return { txid: 'aa'.repeat(32), inputs: [fakeOutpoint('commit'), ...inputs.map((i) => i.outpoint)], resolveInput: resolverFor(notes), ...extra };
}
async function freshState(h = 1000) { const st = new bp.BtcPoolState(); st.beginBlock(h); return st; }

test('shield: accepted, leaf appended', async () => {
  const ins = [inNote('a', 10n), inNote('b', 32n)];
  const s = makeShield(ins);
  const st = await freshState();
  const r = await st.acceptShield(bp.parseShield(s.bytes), shieldCtx(ins));
  assert.ok(r.accepted, r.reason);
  assert.equal(st.tree.size, 1);
  assert.deepEqual(st.tree.leaf(0), bp.noteLeaf({ asset: ASSET, ...pointXY(s.C), ...s.keys }));
});

test('shield: rejects wrong kernel key, value mismatch, infinity, bad inputs, rebound outpoints', async () => {
  const ins = [inNote('a', 10n), inNote('b', 32n)];
  const cases = [
    ['wrong kernel key', makeShield(ins, { signKey: scalar('wrong') }), shieldCtx(ins), /kernel/],
    ['value mismatch', makeShield(ins, { poolValue: 43n }), shieldCtx(ins), /kernel/],
    ['too few carrier inputs', makeShield(ins), { ...shieldCtx(ins), inputs: shieldCtx(ins).inputs.slice(0, 2) }, /too few/],
    ['unresolved input', makeShield(ins), shieldCtx([ins[0]], { inputs: shieldCtx(ins).inputs }), /not a valid note/],
  ];
  // Excess at infinity: pool commitment equals the input sum exactly.
  const eqR = ins[0].r + ins[1].r;
  cases.push(['excess infinity', makeShield(ins, { poolR: eqR, signKey: 1n }), shieldCtx(ins), /excess is infinity/]);
  // Asset mismatch on a resolved input.
  const wrongAsset = { ...shieldCtx(ins), resolveInput: resolverFor(new Map(ins.map((i) => [`${i.outpoint.txid}:${i.outpoint.vout}`, { ...i, asset: bytesToHex(OTHER_ASSET) }]))) };
  cases.push(['input of another asset', makeShield(ins), wrongAsset, /not a valid note/]);
  // Kernel signed over different outpoints than the carrier spends.
  const moved = [inNote('a', 10n), { ...inNote('b', 32n), outpoint: fakeOutpoint('elsewhere') }];
  const movedCtx = shieldCtx(moved);
  cases.push(['kernel bound to other outpoints', makeShield(ins), { ...movedCtx, resolveInput: resolverFor(new Map(moved.map((i) => [`${i.outpoint.txid}:${i.outpoint.vout}`, { ...i, asset: bytesToHex(ASSET) }]))) }, /kernel/]);
  for (const [name, s, ctx, re] of cases) {
    const st = await freshState();
    const r = await st.acceptShield(bp.parseShield(s.bytes), ctx);
    assert.ok(!r.accepted, name);
    assert.match(r.reason, re, name);
    assert.equal(st.tree.size, 0, name);
  }
});

test('shield: resolver I/O failure propagates (never a rejection)', async () => {
  const ins = [inNote('a', 10n)];
  const st = await freshState();
  await assert.rejects(st.acceptShield(bp.parseShield(makeShield(ins).bytes), { ...shieldCtx(ins), resolveInput: async () => { throw new Error('esplora down'); } }), /esplora down/);
});

// A state with one shielded leaf at `start`, then empty blocks up to `tip`.
async function stateWithLeaf(start, tip) {
  const st = new bp.BtcPoolState();
  const ins = [inNote('a', 10n)];
  st.beginBlock(start);
  assert.ok((await st.acceptShield(bp.parseShield(makeShield(ins).bytes), shieldCtx(ins))).accepted);
  st.endBlock();
  for (let h = start + 1; h <= tip; h++) { st.beginBlock(h); st.endBlock(); }
  return st;
}
const accept = async () => true;
const spendCtx = (extra = {}) => ({ txid: 'bb'.repeat(32), outputs: [{ scriptPubKey: Uint8Array.of(0x51) }], verifyProof: accept, ...extra });
const paySpend = (hAnchor, nfs = [nf(1)]) => bp.parseSpend(spendBytes({ hAnchor, nfs, pay: [payOut('p', 10n)] }));

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
  assert.equal(st.nullifiers.size, 1);
});

test('spend: exit destination and vout checks, recorded note', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  const spk = Uint8Array.of(0x00, 0x14, ...new Uint8Array(20).fill(3));
  const outputs = [{ scriptPubKey: Uint8Array.of(0x6a) }, { scriptPubKey: spk }];
  let called = 0;
  const verifyProof = async () => { called++; return true; };
  const ex = (vout, destHash) => bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('x' + vout)], exit: { vout, destHash } }));
  assert.match((await st.acceptSpend(ex(1, sha256(Uint8Array.of(0x6a))), spendCtx({ outputs, verifyProof }))).reason, /dest_spk_hash/);
  assert.match((await st.acceptSpend(ex(2, sha256(spk)), spendCtx({ outputs, verifyProof }))).reason, /not an output/);
  assert.equal(called, 0, 'proof not checked before the exit checks');
  const r = await st.acceptSpend(ex(1, sha256(spk)), spendCtx({ outputs, verifyProof }));
  assert.ok(r.accepted);
  assert.ok(st.exits.has(`${'bb'.repeat(32)}:1`));
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
  const partial = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('v0q')], pay: [payOut('q', 1n)], exit: { vout: 0, destHash: sha256(spk) } }));
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
  const rejectedFirst = await st.acceptSpend(ex('c0', 0, spkB), ctx);
  assert.match(rejectedFirst.reason, /dest_spk_hash/);
  assert.ok((await st.acceptSpend(ex('c1', 0, spkA), ctx)).accepted, 'a rejected exit claims nothing');
  assert.match((await st.acceptSpend(ex('c2', 0, spkA), ctx)).reason, /already claimed/);
  assert.ok((await st.acceptSpend(ex('c3', 1, spkB), ctx)).accepted, 'a distinct output');
  assert.match((await st.acceptSpend(ex('c1', 1, spkB), ctx)).reason, /already spent/, 'earlier envelope nullifier');
  assert.ok((await st.acceptSpend(ex('c4', 0, spkA), spendCtx({ txid: 'cc'.repeat(32), outputs: ctx.outputs }))).accepted, 'another carrier');
  assert.deepEqual([...st.exits.keys()].sort(), [`${'bb'.repeat(32)}:0`, `${'bb'.repeat(32)}:1`, `${'cc'.repeat(32)}:0`]);
  assert.equal(st.nullifiers.size, 3);
});

test('capacity: a full tree rejects leaf-creating envelopes and still takes an exit-only spend', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.maxLeaves = 2;
  st.beginBlock(1002);
  const spk = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(7));
  const two = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('f2')], pay: [payOut('a', 1n), payOut('b', 1n)] }));
  let called = 0;
  const ctx = spendCtx({ outputs: [{ scriptPubKey: spk }], verifyProof: async () => { called++; return true; } });
  assert.match((await st.acceptSpend(two, ctx)).reason, /tree is full/);
  assert.equal(called, 0, 'capacity checked before the proof');
  assert.ok((await st.acceptSpend(paySpend(1001, [nf('f1')]), ctx)).accepted, 'one leaf fits');
  assert.equal(st.tree.size, 2);
  assert.match((await st.acceptSpend(paySpend(1001, [nf('f3')]), ctx)).reason, /tree is full/);
  const ins = [inNote('full', 3n)];
  assert.match((await st.acceptShield(bp.parseShield(makeShield(ins, { tag: 'full' }).bytes), shieldCtx(ins))).reason, /tree is full/);
  const exitOnly = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('f4')], exit: { vout: 0, destHash: sha256(spk) } }));
  assert.ok((await st.acceptSpend(exitOnly, ctx)).accepted, 'exit-only creates no leaf');
  const partial = bp.parseSpend(spendBytes({ hAnchor: 1001, nfs: [nf('f5')], pay: [payOut('c', 1n)], exit: { vout: 0, destHash: sha256(spk) } }));
  assert.match((await st.acceptSpend(partial, spendCtx({ txid: 'dd'.repeat(32), outputs: ctx.outputs }))).reason, /tree is full/);
  assert.equal(bp.MAX_LEAVES, 2 ** 32);
  assert.equal(new bp.BtcPoolState().maxLeaves, 2 ** 32);
});

test('spend: verifier sees exact public values; a false verdict rejects; a missing verifier throws', async () => {
  const st = await stateWithLeaf(1000, 1001);
  st.beginBlock(1002);
  const s = paySpend(1001);
  let seen;
  const r1 = await st.acceptSpend(s, spendCtx({ verifyProof: async (x) => { seen = x; return false; } }));
  assert.match(r1.reason, /proof/);
  assert.deepEqual(seen.publicValues, bp.spendPublicValues(st.roots.get(1001), s.body));
  assert.deepEqual(seen.proof, s.proof);
  assert.match((await st.acceptSpend(s, spendCtx({ verifyProof: async () => 1 }))).reason, /proof/, 'only true accepts');
  await assert.rejects(st.acceptSpend(s, spendCtx({ verifyProof: null })), bp.VerifierUnavailableError);
  assert.equal(st.nullifiers.size, 0);
  assert.equal(st.tree.size, 1);
  // Order: anchor, then nullifiers, then exit, then capacity, then proof.
  const bad = bp.parseSpend(spendBytes({ hAnchor: 5, nfs: [nf(1)], pay: [payOut('p', 1n)] }));
  assert.match((await st.acceptSpend(bad, spendCtx({ verifyProof: null }))).reason, /window/);
});

function fingerprint(st) {
  return JSON.stringify({
    tip: st.tip, size: st.tree.size, root: bytesToHex(st.tree.root()),
    levels: st.tree.levels.map((l) => l.map(bytesToHex)),
    heights: st.leafHeights,
    nfs: [...st.nullifiers.keys()].sort(), exits: [...st.exits.keys()].sort(),
    roots: [...st.roots.entries()].sort((a, b) => a[0] - b[0]).map(([h, r]) => [h, bytesToHex(r)]),
  });
}

async function busyBlocks(st, from, to) {
  for (let h = from; h <= to; h++) {
    st.beginBlock(h);
    if (h % 3 === 0) {
      const ins = [inNote('u' + h, BigInt(h))];
      assert.ok((await st.acceptShield(bp.parseShield(makeShield(ins, { tag: 'u' + h }).bytes), shieldCtx(ins))).accepted);
    }
    if (h % 4 === 0) assert.ok((await st.acceptSpend(paySpend(h - 1, [nf('u' + h)]), spendCtx())).accepted);
    if (h % 5 === 0) {
      const spk = Uint8Array.of(0x51, h & 0xff);
      assert.ok((await st.acceptSpend(bp.parseSpend(spendBytes({ hAnchor: h - 2, nfs: [nf('x' + h)], exit: { vout: 0, destHash: sha256(spk) } })), spendCtx({ txid: bytesToHex(keccak(u32le(h))), outputs: [{ scriptPubKey: spk }] }))).accepted);
    }
    st.endBlock();
  }
}

test('undo: rollbackFrom restores tree, nullifiers, exits and roots exactly (incl. pruned roots)', async () => {
  const st = await stateWithLeaf(1000, 1200);
  await busyBlocks(st, 1201, 1300);
  const snap = fingerprint(st);
  await busyBlocks(st, 1301, 1500);
  assert.notEqual(fingerprint(st), snap);
  st.rollbackFrom(1301);
  assert.equal(fingerprint(st), snap);
});

test('undo: depth limit, and abortBlock discards a half-applied block', async () => {
  const st = await stateWithLeaf(1000, 1000);
  await busyBlocks(st, 1001, 1400);
  const snap = fingerprint(st);
  assert.throws(() => st.rollbackFrom(1400 - 288), bp.ReorgTooDeepError);
  assert.equal(fingerprint(st), snap, 'failed rollback leaves state untouched');
  st.rollbackFrom(1400 - 287);
  assert.equal(st.tip, 1400 - 288);
  const before = fingerprint(st);
  st.beginBlock(st.tip + 1);
  const ins = [inNote('z', 1n)];
  await st.acceptShield(bp.parseShield(makeShield(ins, { tag: 'z' }).bytes), shieldCtx(ins));
  await st.acceptSpend(paySpend(st.tip, [nf('zz')]), spendCtx());
  st.abortBlock();
  assert.equal(fingerprint(st), before);
});

// ── raw parsing against a real signet block ──
const FIX = JSON.parse(readFileSync(new URL('./fixtures/btc-pool-signet-block-323648.json', import.meta.url)));

test('raw block parser: real signet block (hash, merkle root, every txid)', () => {
  const blk = parseBlock(hexToBytes(FIX.raw), FIX.hash);
  assert.equal(blk.txs.length, FIX.txids.length);
  assert.deepEqual(blk.txs.map((t) => t.txid), FIX.txids);
  const tampered = hexToBytes(FIX.raw); tampered[tampered.length - 10] ^= 1;
  assert.throws(() => parseBlock(tampered, FIX.hash), /witness commitment/, 'witness-only change');
  const lastTx = blk.txs[blk.txs.length - 1];
  const vo = hexToBytes(FIX.raw); vo[vo.length - 1] ^= 1;
  assert.throws(() => parseBlock(vo, FIX.hash), /merkle root/, 'locktime change');
  assert.ok(lastTx.txid);
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
  assert.deepEqual(g.Cx, pointXY(bp.pedersen(7n, scalar('ge'))).cx);
  assert.ok(await resolve(ANC.target.txid, 0), 'the real parent itself still validates');
});

test('transparent: an unreachable source throws; an unknown tx is not a note; own exits resolve first', async () => {
  const deepest = Object.keys(ANC.txs).find((t) => !ANC.txs[t].status || ANC.txs[t].status.block_height === Math.min(...Object.values(ANC.txs).map((v) => v.status.block_height)));
  const down = makeShieldInputResolver({ esplora: recordedEsplora({ down: new Set([deepest]) }), network: 'signet', exits: noExits });
  await assert.rejects(down(ANC.target.txid, 0), TransparentUnavailableError, 'ancestor unreachable');
  const top = makeShieldInputResolver({ esplora: recordedEsplora({ down: new Set([ANC.target.txid]) }), network: 'signet', exits: noExits });
  await assert.rejects(top(ANC.target.txid, 0), TransparentUnavailableError, 'note itself unreachable');
  const resolve = makeShieldInputResolver({ esplora: recordedEsplora(), network: 'signet', exits: noExits });
  assert.equal(await resolve('ab'.repeat(32), 0), null);
  const x = { txid: 'cd'.repeat(32), vout: 1, asset: ASSET, ...pointXY(bp.pedersen(5n, scalar('x'))) };
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
  const payload = spendBytes({ hAnchor: 1, nfs: [nf(1), nf(2)], pay: [payOut('a', 1n), payOut('b', 2n)], proof: new Uint8Array(512).fill(3) });
  assert.ok(payload.length > 520);
  const s = envelopeScript(payload);
  assert.deepEqual(decodeEnvelopeScript(s).payload, payload);
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
function call(handler, path) {
  return new Promise((resolve) => {
    const res = { code: 0, writeHead(c) { this.code = c; }, end(b) { resolve({ code: this.code, body: b ? JSON.parse(b) : null }); } };
    handler({ method: 'GET', url: path }, res);
  });
}

async function scenario() {
  const ch = fakeChain();
  const r0 = scalar('t0'), r1 = scalar('t1'), r2 = scalar('t2');
  const etch = etchTx(42n, r0);
  const creator = cxferTx(etch.asset, [{ outpoint: { txid: etch.txid, vout: 0 }, value: 42n, r: r0 }], [{ value: 40n, r: r1 }, { value: 2n, r: r2 }]);
  ch.add([etch, creator]); // 500
  const ins = [{ value: 40n, r: r1, outpoint: { txid: creator.txid, vout: 0 } }, { value: 2n, r: r2, outpoint: { txid: creator.txid, vout: 1 } }];
  const sh = makeShield(ins, { tag: 'e2e', asset: etch.asset });
  const shTx = carrier(sh.bytes, { inputs: ins.map((i) => i.outpoint) });
  const junk = carrier(Uint8Array.of(0x6c, 1, 2, 3));
  ch.add([junk, shTx]); // 501
  const spk = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(8));
  const pay = carrier(spendBytes({ hAnchor: 501, nfs: [nf('e1')], pay: [payOut('o1', 20n), payOut('o2', 22n)] }));
  const exit = carrier(spendBytes({ hAnchor: 501, nfs: [nf('e2')], exit: { vout: 1, destHash: sha256(spk) } }), { outputs: [{ spk: Uint8Array.of(0x6a) }, { spk }] });
  ch.add([pay, exit]); // 502
  ch.add([]); // 503
  return { ch, shTx, pay, exit, sh, creator, etch };
}
const trueVerifier = { enabled: true, verify: async () => true };
const newIndexer = (ch, extra = {}) => createIndexer({ store: openBtcPoolStore(':memory:'), esplora: ch.esplora, verifier: trueVerifier, network: 'signet', startHeight: 500, log: () => {}, ...extra });

test('indexer: replays shields, pays and exits; persists; serves HTTP', async () => {
  const { ch, exit, sh } = await scenario();
  const store = openBtcPoolStore(':memory:');
  const verifier = { enabled: true, verify: async () => true };
  const ix = createIndexer({ store, esplora: ch.esplora, verifier, network: 'signet', startHeight: 500, log: () => {} });
  await ix.syncOnce();
  assert.equal(ix.state.tip, 503);
  assert.equal(ix.state.tree.size, 3);
  assert.equal(ix.state.nullifiers.size, 2);
  assert.ok(ix.state.exits.has(`${exit.txid}:1`));
  const h = createHandler(ix, store);
  const st = (await call(h, '/btc-pool/status')).body;
  assert.equal(st.height, 503); assert.equal(st.leafCount, 3); assert.equal(st.root, '0x' + bytesToHex(ix.state.tree.root()));
  const notes = (await call(h, '/btc-pool/notes?from=0&limit=2')).body;
  assert.equal(notes.notes.length, 2); assert.equal(notes.next, 2);
  assert.equal(notes.notes[0].Cx, '0x' + bytesToHex(pointXY(sh.C).cx));
  assert.equal(notes.notes[0].nk_pub, '0x' + bytesToHex(sh.keys.nkPub));
  const path = (await call(h, '/btc-pool/path/1')).body;
  assert.equal(bytesToHex(bp.rootFromPath(hexToBytes(path.leaf), 1, path.path.map(hexToBytes))), bytesToHex(ix.state.tree.root()));
  assert.equal((await call(h, `/btc-pool/nullifier/${bytesToHex(nf('e1'))}`)).body.spent, true);
  assert.equal((await call(h, `/btc-pool/nullifier/${'00'.repeat(32)}`)).body.spent, false);
  assert.equal((await call(h, `/btc-pool/exit/${exit.txid}/1`)).body.exists, true);
  assert.equal((await call(h, `/btc-pool/exit/${exit.txid}/0`)).body.exists, false);
  assert.equal((await call(h, '/btc-pool/root/501')).body.retained, true);
  assert.equal((await call(h, '/btc-pool/roots')).body.roots.length, 4);
  const envs = store.db.prepare('SELECT * FROM envelopes ORDER BY height, tx_index').all();
  assert.deepEqual(envs.map((e) => e.accepted), [0, 1, 1, 1]);
  // Restart from the database reproduces the live state, undo records included.
  const ix2 = createIndexer({ store, esplora: ch.esplora, verifier, network: 'signet', startHeight: 500, log: () => {} });
  assert.equal(fingerprint(ix2.state), fingerprint(ix.state));
  ix2.state.rollbackFrom(502); ix.state.rollbackFrom(502);
  assert.equal(fingerprint(ix2.state), fingerprint(ix.state));
  assert.throws(() => createIndexer({ store, esplora: ch.esplora, verifier, network: 'mainnet', startHeight: 500, log: () => {} }), /signet/);
});

test('indexer: reorg rolls back to the fork point and replays the new branch', async () => {
  const { ch } = await scenario();
  const store = openBtcPoolStore(':memory:');
  const ix = createIndexer({ store, esplora: ch.esplora, verifier: { enabled: true, verify: async () => true }, network: 'signet', startHeight: 500, log: () => {} });
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
  assert.equal(store.block(502).hash, ch.blocks[2].hash);
  const fresh = createIndexer({ store: openBtcPoolStore(':memory:'), esplora: ch.esplora, verifier: { enabled: true, verify: async () => true }, network: 'signet', startHeight: 500, log: () => {} });
  await fresh.syncOnce();
  assert.equal(fingerprint(fresh.state), fingerprint(ix.state));
});

test('indexer: without a verifier, shields replay and the first spend halts the indexer', async () => {
  const { ch } = await scenario();
  const store = openBtcPoolStore(':memory:');
  const ix = createIndexer({ store, esplora: ch.esplora, verifier: { enabled: false, reason: 'missing', verify: null }, network: 'signet', startHeight: 500, log: () => {} });
  await assert.rejects(ix.syncOnce(), bp.VerifierUnavailableError);
  assert.equal(ix.state.tip, 501);
  assert.equal(ix.state.tree.size, 1);
  assert.equal(ix.state.pending, null);
  assert.equal(ix.status().halted.height, 502);
  assert.equal(store.tip().height, 501);
});

test('indexer: verifier internal error stops the block without applying it', async () => {
  const { ch } = await scenario();
  const store = openBtcPoolStore(':memory:');
  const ix = createIndexer({ store, esplora: ch.esplora, verifier: { enabled: true, verify: async () => { throw new Error('exit 101'); } }, network: 'signet', startHeight: 500, log: () => {} });
  await assert.rejects(ix.syncOnce(), /exit 101/);
  assert.equal(ix.state.tip, 501);
  assert.equal(store.tip().height, 501);
});

test('indexer: a shield of a note whose parent fails validation is rejected; a valid parent is shielded', async () => {
  const ch = fakeChain();
  const etch = etchTx(1000n, scalar('ie'));
  // A CXFER that spends nothing it can open and declares 10^6 of the etched asset.
  const forged = cxferTx(etch.asset, [{ outpoint: { txid: etch.txid, vout: 0 }, value: 1000n, r: scalar('ie') }], [{ value: 10n ** 6n, r: scalar('if') }], { forge: true });
  ch.add([etch, forged]); // 500
  const bad = makeShield([{ value: 10n ** 6n, r: scalar('if'), outpoint: { txid: forged.txid, vout: 0 } }], { asset: etch.asset, tag: 'bad' });
  const good = makeShield([{ value: 1000n, r: scalar('ie'), outpoint: { txid: etch.txid, vout: 0 } }], { asset: etch.asset, tag: 'good' });
  ch.add([carrier(bad.bytes, { inputs: [{ txid: forged.txid, vout: 0 }] }), carrier(good.bytes, { inputs: [{ txid: etch.txid, vout: 0 }] })]); // 501
  const store = openBtcPoolStore(':memory:');
  const ix = newIndexer(ch, { store });
  await ix.syncOnce();
  assert.equal(ix.state.tip, 501);
  assert.equal(ix.state.tree.size, 1);
  assert.deepEqual(ix.state.tree.leaf(0), bp.noteLeaf({ asset: etch.asset, ...pointXY(good.C), ...good.keys }));
  const envs = store.db.prepare('SELECT accepted, reason FROM envelopes ORDER BY tx_index').all();
  assert.deepEqual(envs.map((e) => e.accepted), [0, 1]);
  assert.match(envs[0].reason, /not a valid note/);
  assert.equal(ix.status().shieldInputValidation, 'canonical');
});

test('indexer: an unreachable ancestor halts the block, and it replays once the source is back', async () => {
  const { ch, etch } = await scenario();
  ch.down.add(etch.txid);
  const store = openBtcPoolStore(':memory:');
  const ix = createIndexer({ store, esplora: ch.esplora, verifier: trueVerifier, network: 'signet', startHeight: 500, log: () => {} });
  await assert.rejects(ix.syncOnce(), TransparentUnavailableError);
  assert.equal(ix.state.tip, 500);
  assert.equal(ix.state.tree.size, 0);
  assert.equal(ix.state.pending, null);
  assert.equal(store.tip().height, 500);
  assert.equal(ix.status().halted.height, 501);
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
  const rExit = scalar('exit'), rOut = scalar('seam-out');
  // Spends the exit note (5 under rExit) into a fresh transparent note.
  const fromExit = cxferTx(ASSET, [{ outpoint: { txid: exit.txid, vout: 1 }, value: 5n, r: rExit }], [{ value: 5n, r: rOut }]);
  // Same, but from vout 0 of the exit carrier, which the pool never recorded.
  const fromOther = cxferTx(ASSET, [{ outpoint: { txid: exit.txid, vout: 0 }, value: 5n, r: rExit }], [{ value: 5n, r: scalar('seam-x') }]);
  ch.add([fromExit, fromOther]); // 504
  const viaCxfer = makeShield([{ value: 5n, r: rOut, outpoint: { txid: fromExit.txid, vout: 0 } }], { tag: 'seam1' });
  const viaOther = makeShield([{ value: 5n, r: scalar('seam-x'), outpoint: { txid: fromOther.txid, vout: 0 } }], { tag: 'seam2' });
  ch.add([
    carrier(viaCxfer.bytes, { inputs: [{ txid: fromExit.txid, vout: 0 }] }),
    carrier(viaOther.bytes, { inputs: [{ txid: fromOther.txid, vout: 0 }] }),
  ]); // 505
  const ix = newIndexer(ch);
  await ix.syncOnce();
  assert.equal(ix.state.tip, 505);
  assert.equal(ix.state.tree.size, 4, 'three from the scenario, one via the exit ancestry');
  assert.deepEqual(ix.state.tree.leaf(3), bp.noteLeaf({ asset: ASSET, ...pointXY(viaCxfer.C), ...viaCxfer.keys }));

  // A shield spending the exit output itself resolves from the pool's own record.
  const ch2 = (await scenario()).ch;
  const exit2 = ch2.blocks[2].txs.find((t) => txEnvelope(parseTx(t.raw).tx)?.payload[0] === 0x6d && parseTx(t.raw).tx.vout.length === 2);
  const direct = makeShield([{ value: 5n, r: rExit, outpoint: { txid: exit2.txid, vout: 1 } }], { tag: 'seam3' });
  ch2.add([carrier(direct.bytes, { inputs: [{ txid: exit2.txid, vout: 1 }] })]); // 504
  const ix2 = newIndexer(ch2);
  await ix2.syncOnce();
  assert.equal(ix2.state.tree.size, 4);
});

test('indexer: every input of a carrier is replayed in order; exits claim distinct outputs; vin[0] rules apply', async () => {
  const { ch } = await scenario();
  const spkA = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(0xa1)), spkB = Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(0xb2));
  const exitTo = (t, vout, spk, extra = {}) => spendBytes({ hAnchor: 503, nfs: [nf(t)], exit: { vout, destHash: sha256(spk) }, ...extra });
  const pay = (t) => spendBytes({ hAnchor: 503, nfs: [nf(t)], pay: [payOut('m' + t, 1n)] });
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
  const m5 = multiCarrier([null, makeShield([inNote('m5', 1n)], { tag: 'm5' }).bytes]);
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
  const rE = scalar('exit');
  const from = (op, tag) => cxferTx(ASSET, [{ outpoint: op, value: 5n, r: rE }], [{ value: 5n, r: scalar(tag) }]);
  const c1 = from({ txid: m1.txid, vout: 1 }, 'anc1'), c2 = from({ txid: m2.txid, vout: 0 }, 'anc2'), c3 = from({ txid: m3.txid, vout: 0 }, 'anc3');
  ch.add([c1, c2, c3]); // 505
  const shieldOf = (c, tag) => {
    const sh = makeShield([{ value: 5n, r: scalar(tag), outpoint: { txid: c.txid, vout: 0 } }], { tag: 's' + tag });
    return { sh, tx: carrier(sh.bytes, { inputs: [{ txid: c.txid, vout: 0 }] }) };
  };
  const s1 = shieldOf(c1, 'anc1'), s2 = shieldOf(c2, 'anc2'), s3 = shieldOf(c3, 'anc3');
  ch.add([s1.tx, s2.tx, s3.tx]); // 506
  const ix3 = newIndexer(ch);
  await ix3.syncOnce();
  assert.equal(ix3.state.tip, 506);
  assert.equal(ix3.state.tree.size, 5 + 2);
  assert.deepEqual(ix3.state.tree.leaf(5), bp.noteLeaf({ asset: ASSET, ...pointXY(s1.sh.C), ...s1.sh.keys }));
  assert.deepEqual(ix3.state.tree.leaf(6), bp.noteLeaf({ asset: ASSET, ...pointXY(s2.sh.C), ...s2.sh.keys }));
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
    const Cs = outs.map((o) => compress(bp.pedersen(o.value, o.r)));
    const { proof } = bpRangeAggProve(outs.map((o) => o.value), outs.map((o) => o.r));
    const msg = tacit.computeKernelMsg(etch.asset, ins.map((i) => i.outpoint), Cs, 0n);
    const d = outs.reduce((a, o) => a + o.r, 0n) - ins.reduce((a, i) => a + i.r, 0n);
    const cx = tacit.encodeCXferPayload({ assetId: etch.asset, kernelSig: schnorrSign(msg, forge ? scalar('bf') : d), outputs: Cs.map((commitment) => ({ commitment, encryptedAmount: noAmount })), rangeproof: proof });
    const payload = concat(Uint8Array.of(0x39), keccak(new TextEncoder().encode('target')), cx.subarray(1));
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
  assert.deepEqual(pd.commitment, compress(bp.pedersen(5n, r2)));
  const resolve = makeShieldInputResolver({ esplora: recordedEsplora({ extra: new Map([[etch.txid, etch], [good.txid, good]]) }), network: 'signet', exits: noExits });
  assert.deepEqual((await resolve(good.txid, 0)).Cx, pointXY(bp.pedersen(4n, r1)).cx);
});

test('dapp validateOutpoint: T_CROSSOUT_MINT is a note only when the mint record names this tx; unknown is unavailable', async () => {
  const p2tr = (b) => Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(b));
  const rM = scalar('co-r');
  const { cx, cy } = pointXY(bp.pedersen(12n, rM));
  const claim = (t) => keccak(new TextEncoder().encode('claim' + t));
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
    assert.deepEqual(pd, { assetIdHex: bytesToHex(ASSET), commitment: compress(bp.pedersen(12n, rM)) });
    assert.equal(await tacit.getParentEnvelopeData(tacit.txOutputEnvelope(espTx(other)), 0, other.txid), null);

    const extra = new Map([minted, other, undecided, next].map((t) => [t.txid, t]));
    const resolve = makeShieldInputResolver({ esplora: recordedEsplora({ extra }), network: 'signet', exits: noExits });
    assert.deepEqual(await resolve(minted.txid, 0), { asset: bytesToHex(ASSET), Cx: cx, Cy: cy });
    assert.equal(await resolve(other.txid, 0), null);
    await assert.rejects(resolve(undecided.txid, 0), TransparentUnavailableError, 'unknown halts');
    const nextU = cxferTx(ASSET, [{ outpoint: { txid: undecided.txid, vout: 0 }, value: 12n, r: rM }], [{ value: 12n, r: scalar('co-u') }]);
    extra.set(nextU.txid, nextU);
    await assert.rejects(resolve(nextU.txid, 0), TransparentUnavailableError, 'unknown ancestor halts');
    assert.ok(await resolve(next.txid, 0), 'minted ancestor');
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
  const x = { txid: m.txid, vout: 1, asset: ASSET, ...pointXY(bp.pedersen(5n, scalar('exit'))) };
  const resolve = makeShieldInputResolver({ esplora: recordedEsplora({ extra: new Map([[m.txid, m]]) }), network: 'signet', exits: () => new Map([[`${m.txid}:1`, x]]) });
  const spender = cxferTx(ASSET, [{ outpoint: { txid: m.txid, vout: 1 }, value: 5n, r: scalar('exit') }], [{ value: 5n, r: scalar('late-o') }]);
  const spender0 = cxferTx(ASSET, [{ outpoint: { txid: m.txid, vout: 0 }, value: 5n, r: scalar('exit') }], [{ value: 5n, r: scalar('late-p') }]);
  const r2 = makeShieldInputResolver({ esplora: recordedEsplora({ extra: new Map([[m.txid, m], [spender.txid, spender], [spender0.txid, spender0]]) }), network: 'signet', exits: () => new Map([[`${m.txid}:1`, x]]) });
  assert.deepEqual((await resolve(m.txid, 1)).Cx, x.cx);
  assert.ok(await r2(spender.txid, 0), 'exit output as an ancestor');
  assert.equal(await r2(spender0.txid, 0), null, 'unrecorded output of the carrier');
});

// Cross-check against the Rust reference vectors when present.
const VEC = new URL('./vectors/btc-pool-vectors.json', import.meta.url);
test('reference vectors (tests/vectors/btc-pool-vectors.json) match byte for byte', () => {
  if (!existsSync(VEC)) { console.log('    (skipped: vectors file not present)'); return; }
  const V = JSON.parse(readFileSync(VEC, 'utf8'));
  const X = (b) => '0x' + bytesToHex(b);
  const nkPubOf = (nk) => X(compress(mulPoint(G, big(hexToBytes(nk)))));
  for (const v of V.leaf_and_nullifier) {
    const C = pointXY(bp.pedersen(BigInt(v.value), big(hexToBytes(v.blinding))));
    assert.equal(X(C.cx), v.cx); assert.equal(X(C.cy), v.cy);
    assert.equal(nkPubOf(v.nk_note), v.nk_pub);
    const leaf = bp.noteLeaf({ asset: v.asset, cx: v.cx, cy: v.cy, spendKey: v.spend_key, nkPub: v.nk_pub });
    assert.equal(X(leaf), v.leaf);
    assert.equal(X(bp.nullifier(leaf, v.nk_note, v.leaf_index)), v.nullifier);
  }
  for (const v of V.spend_msg) assert.equal(X(bp.spendMsg(hexToBytes(v.body))), v.spend_msg);
  let n = 0;
  for (const v of V.spends) {
    const f = v.fields;
    const env = concat(hexToBytes(f.body), u16le(0));
    const s = bp.parseSpend(env);
    assert.ok(s, v.name);
    assert.equal(X(s.body), f.body);
    assert.equal(X(s.asset), f.asset);
    assert.equal(s.hAnchor, f.h_anchor);
    assert.deepEqual(s.nullifiers.map(X), f.nullifiers);
    assert.equal(s.outputs.length, f.outputs.length, v.name);
    f.outputs.forEach((o, i) => {
      const g = s.outputs[i];
      assert.deepEqual([X(g.cx), X(g.cy), X(g.spendKey), X(g.nkPub), X(g.pkEph), X(g.ctNote)], [o.cx, o.cy, o.spend_key, o.nk_pub, o.pk_eph, o.ct_note]);
      assert.equal(X(bp.noteLeaf({ asset: s.asset, ...g })), o.leaf);
    });
    assert.equal(s.exit ? 1 : 0, f.has_exit, v.name);
    if (f.has_exit) {
      const e = f.exit;
      assert.deepEqual([X(s.exit.cx), X(s.exit.cy), X(s.exit.destSpkHash), s.exit.exitVout], [e.cx, e.cy, e.dest_spk_hash, e.exit_vout]);
    } else assert.equal(f.exit, null);
    assert.equal(X(keccak(s.body)), f.body_hash);
    assert.equal(X(bp.spendMsg(s.body)), f.spend_msg);
    assert.equal(X(bp.spendPublicValues(v.witness.root, s.body)), v.public_values);
    v.witness.inputs.forEach((w, i) => {
      assert.equal(nkPubOf(w.nk_note), w.nk_pub);
      const leaf = bp.noteLeaf({ asset: s.asset, cx: w.cx, cy: w.cy, spendKey: w.spend_key, nkPub: w.nk_pub });
      assert.equal(X(leaf), v.notes_spent[i].leaf);
      assert.equal(X(bp.rootFromPath(leaf, w.leaf_index, w.path)), v.witness.root);
      assert.equal(X(bp.nullifier(leaf, w.nk_note, w.leaf_index)), f.nullifiers[i]);
      assert.ok(bp.bip340Verify(w.sig, bp.spendMsg(s.body), w.spend_key), 'input signature over spend msg');
    });
    n++;
  }
  assert.equal(n, V.spends.length);
  assert.deepEqual(V.spends.map((v) => [v.fields.outputs.length, v.fields.has_exit]), [[1, 0], [3, 0], [0, 1], [2, 1]]);
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ok -', name); }
  catch (e) { console.error('  FAIL -', name); console.error(e); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} passed`);
// tacit.js leaves timers running.
process.exit(process.exitCode ?? 0);
