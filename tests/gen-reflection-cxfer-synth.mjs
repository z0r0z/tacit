#!/usr/bin/env node
// Build a FULL-SCAN reflection prover input around a SYNTHETIC but value-CONSERVING CXFER tx, so the
// fixed reflection guest (which re-verifies the CXFER kernel + range before folding outputs, REFLECT-1)
// ACCEPTS it. The earlier reflection_input.json seeded SYNTHETIC input commitments that don't conserve
// with the real signet envelope's kernel → the gated guest rightly rejects it. Here every piece is
// internally consistent: 2 input notes + 2 output notes with Σv_in = Σv_out, a real BIP-340 cxfer kernel
// over them, a real BP+ range proof over the outputs, wrapped in an easy-PoW 1-tx block.
//
//   node tests/gen-reflection-cxfer-synth.mjs > contracts/sp1/confidential/fixtures/reflection_input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat } from './btc-mini.mjs';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());

const prover = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const G = secp.ProjectivePoint.BASE;
const N = secp.CURVE.n;
const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const compress = (P) => P.toRawBytes(true);
const xyHex = (P) => { const a = P.toAffine(); return { cx: '0x' + a.x.toString(16).padStart(64, '0'), cy: '0x' + a.y.toString(16).padStart(64, '0') }; };

function taggedHash(tag, msg) { const th = sha256(new TextEncoder().encode(tag)); return sha256(_cat([th, th, msg])); }
// BIP-340 sign with private scalar d (even-y key/nonce; mirrors gen-cxfer-kernel-fixture / dapp verifySchnorr).
function bip340Sign(msg, dIn) {
  let d = dIn % N; if (d === 0n) throw new Error('zero key');
  if (G.multiply(d).toAffine().y & 1n) d = N - d;
  const Px = be(G.multiply(d).toAffine().x);
  let k = bytesToBig(sha256(_cat([be(d), msg]))) % N; if (k === 0n) k = 1n;
  if (G.multiply(k).toAffine().y & 1n) k = N - k;
  const Rx = be(G.multiply(k).toAffine().x);
  const e = bytesToBig(taggedHash('BIP0340/challenge', _cat([Rx, Px, msg]))) % N;
  return { sig: _cat([Rx, be((k + e * d) % N)]), px: Px };
}

const ASSET = Uint8Array.from(Buffer.from('879cf8e6f26b733497ca1d154ed22c80b2266a5702ed55476a8cd4a3c5e9c4ea', 'hex'));
const ZERO_OWNER = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 307547;

// 2 inputs, 2 outputs; Σv_in = Σv_out = 1000 (burned = 0). Distinct synthetic input outpoints.
const ins = [{ d: 700n, r: 0x1111n, txid: Buffer.alloc(32, 0xa1), vout: 0 },
             { d: 300n, r: 0x2222n, txid: Buffer.alloc(32, 0xb2), vout: 1 }];
const outs = [{ d: 600n, r: 0x3333n }, { d: 400n, r: 0x4444n }];

const Cin = ins.map((i) => prover.commit(i.d, i.r));
// Cout via prover.commit (same H as bppRangeProve) so the points are secp ProjectivePoints for the
// kernel/envelope; take ONLY the proof bytes from bppRangeProve — its V_j == prover.commit(d,r).
const Cout = outs.map((o) => prover.commit(o.d, o.r));
const { proof: rangeProof } = bppRangeProve(outs.map((o) => o.d), outs.map((o) => o.r));
const excess = ((ins.reduce((s, i) => s + i.r, 0n) - outs.reduce((s, o) => s + o.r, 0n)) % N + N) % N;

// kernel message: sha256("tacit-kernel-v1" ‖ asset ‖ inN ‖ (txid‖voutLE)×in ‖ outN ‖ compress(Cout)×out ‖ burnedLE8)
const msgParts = [new TextEncoder().encode('tacit-kernel-v1'), ASSET, new Uint8Array([ins.length])];
for (const i of ins) { msgParts.push(i.txid); msgParts.push(u32le(i.vout)); }
msgParts.push(new Uint8Array([Cout.length]));
for (const C of Cout) msgParts.push(compress(C));
msgParts.push(u64le(0));
const kernelMsg = sha256(_cat(msgParts.map((x) => Uint8Array.from(x))));
const { sig, px } = bip340Sign(kernelMsg, excess);
// sanity: P = Σ Cin − Σ Cout must be excess·G (x-only == signer pubkey x)
const P = Cin.reduce((a, c) => a.add(c), secp.ProjectivePoint.ZERO).add(Cout.reduce((a, c) => a.add(c), secp.ProjectivePoint.ZERO).negate());
if (Buffer.compare(Buffer.from(compress(P).slice(1)), Buffer.from(px)) !== 0) throw new Error('verify-key x mismatch — non-conserving');

// CXFER envelope (T_CXFER_BPP 0x22): opcode ‖ asset ‖ sig(64) ‖ N ‖ N×(commitment33 ‖ amount_ct8=0) ‖ rpLen(2 LE) ‖ rangeProof
const envParts = [Buffer.from([0x22]), Buffer.from(ASSET), Buffer.from(sig), Buffer.from([Cout.length])];
for (const C of Cout) { envParts.push(Buffer.from(compress(C))); envParts.push(Buffer.alloc(8)); }
envParts.push(u16le(rangeProof.length)); envParts.push(Buffer.from(rangeProof));
const envelope = cat(envParts);

// Build a 2-input segwit reveal tx: the envelope rides vin[0]'s tapscript witness; both inputs spend
// our seeded outpoints. (witness-stripped txid + merkle are byte-compatible with cxfer-core::bitcoin.)
const tapscript = cat([
  [0x20], Buffer.alloc(32), [0xac], [0x00, 0x63],
  [0x05], Buffer.from('TACIT'), [0x01, 0x01],
  [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope,
  [0x68],
]);
const inputsBuf = cat(ins.flatMap((i) => [i.txid, u32le(i.vout), [0x00], [0xfd, 0xff, 0xff, 0xff]]));
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const wit1 = cat([[0x01], [0x00]]); // 1 empty witness item for vin1
const tx = cat([
  [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
  varint(ins.length), inputsBuf,
  [0x01], Buffer.alloc(8), [0x00],   // 1 output: 0 value, empty scriptPubKey
  wit0, wit1,
  Buffer.alloc(4),                    // locktime
]);
const txid = computeTxid(tx);
const header = mineHeader(computeMerkleRoot([txid]));

// ── Reflection: seed the prior live set + note tree with the 2 input notes, then assemble the block. ──
const state = pool.makeScanReflectionState();
const coords = new Map();
state.setHeight(BLOCK_HEIGHT - 1);
ins.forEach((i, j) => {
  const { cx, cy } = xyHex(Cin[j]);
  const outpoint = pool.outpointKey('0x' + i.txid.toString('hex'), i.vout);
  const assetHex = '0x' + Buffer.from(ASSET).toString('hex');
  state.foldOutput(pool.leaf(assetHex, cx, cy, ZERO_OWNER), outpoint, pool.commitmentHash(cx, cy), assetHex);
  coords.set(outpoint.toLowerCase(), { cx, cy });
});

const ASSET_HEX = '0x' + Buffer.from(ASSET).toString('hex');
const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: ins.map((i) => ({ prevTxid: '0x' + i.txid.toString('hex'), vout: i.vout })),
  env: {
    type: 'cxfer',
    assetId: ASSET_HEX,
    kernelSig: '0x' + Buffer.from(sig).toString('hex'),
    rangeProof: '0x' + Buffer.from(rangeProof).toString('hex'),
    outputs: Cout.map((C, j) => { const { cx, cy } = xyHex(C); return { cx, cy, compressed: '0x' + Buffer.from(compress(C)).toString('hex'), commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.leaf(ASSET_HEX, cx, cy, ZERO_OWNER), vout: j }; }),
  },
};
const input = pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [txSpec] }],
}, coords);

console.error(`conserving CXFER: in=${ins.map((i) => i.d)} out=${outs.map((o) => o.d)} rangeProof=${rangeProof.length}B`);
console.error(`spendsDetected=${input.blocks[0].txs[0].openings.length} cxferOutputs=${input.blocks[0].txs[0].outputs.length} newDigest=${input.newDigest}`);
console.log(JSON.stringify(input));
