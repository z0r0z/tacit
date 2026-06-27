#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC T_PREAUTH_BID_VAR (0x5C) orderbook bid fill — a
// CXFER on the tacit-asset side: the seller's asset input conserves into the buyer's filled note + the
// seller's change under tacit-kernel-v1 with one BP+ range over the outputs. The reflection guest folds it
// via the IDENTICAL cxfer fold (re-verify Σ C_in = Σ C_out + range, REFLECT-1) at vouts 1,2, so it MUST land
// on the JS assembler's newDigest — the reflect-exec guest↔JS check for the bid mirror (parser → classify →
// cxfer fold at the bid vout base). Exercises parsePreauthBidEnvelope + classifyConfidentialTx (voutBase 1).
//   node tests/gen-reflection-bid-synth.mjs > /tmp/bid-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';

const _cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const prover = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const G = secp.ProjectivePoint.BASE, N = secp.CURVE.n;
const bytesToBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const compress = (P) => P.toRawBytes(true);
const xyHex = (P) => { const a = P.toAffine(); return { cx: '0x' + a.x.toString(16).padStart(64, '0'), cy: '0x' + a.y.toString(16).padStart(64, '0') }; };
function taggedHash(tag, msg) { const th = sha256(new TextEncoder().encode(tag)); return sha256(_cat([th, th, msg])); }
function bip340Sign(msg, dIn) {
  let d = dIn % N; if (d === 0n) throw new Error('zero key');
  if (G.multiply(d).toAffine().y & 1n) d = N - d;
  const Px = be(G.multiply(d).toAffine().x);
  let k = bytesToBig(sha256(_cat([be(d), msg]))) % N; if (k === 0n) k = 1n;
  if (G.multiply(k).toAffine().y & 1n) k = N - k;
  const Rx = be(G.multiply(k).toAffine().x);
  const e = bytesToBig(taggedHash('BIP0340/challenge', _cat([Rx, Px, msg]))) % N;
  return _cat([Rx, be((k + e * d) % N)]);
}

const ASSET = Uint8Array.from(Buffer.from('a1'.repeat(32), 'hex')), ASSET_HEX = '0x' + 'a1'.repeat(32);
const ZERO_OWNER = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 317000;
// 1 seller input (1000) → buyer's filled note (600) + seller change (400). Σ in = Σ out, burned = 0.
const seller = { d: 1000n, r: 0x1111n, txid: Buffer.alloc(32, 0x5c), vout: 0 };
const outs = [{ d: 600n, r: 0x3333n }, { d: 400n, r: 0x4444n }];
const Cin = prover.commit(seller.d, seller.r);
const Cout = outs.map((o) => prover.commit(o.d, o.r));
const { proof: rangeProof } = bppRangeProve(outs.map((o) => o.d), outs.map((o) => o.r));
const excess = ((seller.r - outs.reduce((s, o) => s + o.r, 0n)) % N + N) % N;

// kernel (tacit-kernel-v1, burned 0): sha256(domain ‖ asset ‖ inN ‖ (txid‖voutLE)×in ‖ outN ‖ compress(Cout)×out ‖ burnedLE8)
const msgParts = [new TextEncoder().encode('tacit-kernel-v1'), ASSET, new Uint8Array([1]), seller.txid, u32le(seller.vout), new Uint8Array([Cout.length])];
for (const C of Cout) msgParts.push(compress(C));
msgParts.push(u64le(0));
const sig = bip340Sign(sha256(_cat(msgParts.map((x) => Uint8Array.from(x)))), excess);

// 0x5C envelope: op ‖ asset(32) ‖ skip(1) ‖ inline(134) ‖ kernel_sig(64) ‖ N=2 ‖ out0(33) ‖ out1(33) ‖ amount_ct(8) ‖ rpLen(2) ‖ rp.
const envelope = cat([
  [0x5C], Buffer.from(ASSET), Buffer.alloc(1), Buffer.alloc(134), Buffer.from(sig), [0x02],
  Buffer.from(compress(Cout[0])), Buffer.from(compress(Cout[1])), Buffer.alloc(8),
  u16le(rangeProof.length), Buffer.from(rangeProof),
]);
const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inputsBuf = cat([seller.txid, u32le(seller.vout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx), txHex = '0x' + tx.toString('hex');
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx); // tx 0 = coinbase; the bid envelope tx is tx 1
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

// Classify via the REAL dapp path (parser → cxfer decode + the per-output vout map), then build the env exactly
// as the indexer does. The classifier returns the bid-fill output vouts in `decode.vouts` (the §5.7.12 layout).
const decode = classifyConfidentialTx(txHex);
if (!decode || decode.type !== 'cxfer' || !Array.isArray(decode.vouts) || decode.vouts.length !== decode.commitments.length) {
  console.error('FATAL: bid did not classify as cxfer with a per-output vout map:', decode); process.exit(1);
}

const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
const coords = new Map();
const { cx: icx, cy: icy } = xyHex(Cin);
const inOutpoint = pool.outpointKey('0x' + seller.txid.toString('hex'), seller.vout);
state.foldOutput(pool.leaf(ASSET_HEX, icx, icy, ZERO_OWNER), inOutpoint, pool.commitmentHash(icx, icy), ASSET_HEX);
coords.set(inOutpoint.toLowerCase(), { cx: icx, cy: icy });

const txSpec = {
  txData: txHex, txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + seller.txid.toString('hex'), vout: seller.vout }],
  env: {
    type: 'cxfer', assetId: decode.assetId, kernelSig: decode.kernelSig, rangeProof: decode.rangeProof,
    outputs: decode.commitments.map((comm, j) => { const { cx, cy } = pool.decompressCommitment(comm); return { cx, cy, compressed: comm, commitmentHash: pool.commitmentHash(cx, cy), noteLeaf: pool.leaf(decode.assetId, cx, cy, ZERO_OWNER), vout: decode.vouts[j] }; }),
  },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, coords);

const folded = input.blocks[0].txs[1].outputs.length === 2;
console.error(`bid fill: 1000→[600 buyer, 400 change] vouts=[${txSpec.env.outputs.map((o) => o.vout)}] folded=${folded} newDigest=${input.newDigest}`);
if (!folded) { console.error('FATAL: bid outputs not folded (conservation failed) — fixture would not validate'); process.exit(1); }
console.log(JSON.stringify(input));
