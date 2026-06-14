#!/usr/bin/env node
// Build a FULL-SCAN reflection input exercising the TAC BURN-DEPOSIT dispatch (reflect.rs): a 0x2B burn of a
// note that is NOT in the live set, admitted because the witness proves it descends from the asset's etch
// supply note C_0 through a confirmed, conserving CXFER (scan-free realness). Everything is internally
// consistent + low-difficulty PoW so the guest accepts it under a native execute (no GPU):
//   - CETCH etch committing C_0 (fixed supply, mint_authority = 0) → asset_id = sha256(etch_txid ‖ vout0)
//   - a real conserving 1-in/1-out CXFER spending the supply note (C_0) → the burned note (BIP-340 kernel +
//     BP+ range), in a PRE-anchor block
//   - a 0x2B burn spending the burned note, in the SCAN block
//   - a contiguous easy-PoW chain: [etch, cxfer] (provHeaders) then [burn] (scan); prov_tip == prev_hash
// Validate: node tests/gen-reflection-burn-deposit.mjs > .../reflection_input.json, then the reflect
// harness native-executes it and the PV's bitcoinBurnRoot reflects the folded burn (env_nu → env_dest).
//
//   node tests/gen-reflection-burn-deposit.mjs > contracts/sp1/confidential/fixtures/reflection_burn_deposit.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialProver } from '../dapp/evm-confidential.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { computeTxid, computeMerkleRoot, bitsToTarget, dsha256, varint, cat } from './btc-mini.mjs';

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
const hexp = (b) => '0x' + Buffer.from(b).toString('hex');
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
  return { sig: _cat([Rx, be((k + e * d) % N)]), px: Px };
}

// A P2TR reveal tx with a SPECIFIC input outpoint embedding the Tacit `payload` (matches
// extract_taproot_envelope + the synth generator's tx shape; witness-stripped txid is byte-compatible).
function revealTx(payload, prevTxid, prevVout) {
  const tapscript = cat([
    [0x20], Buffer.alloc(32), [0xac], [0x00, 0x63],
    [0x05], Buffer.from('TACIT'), [0x01, 0x01],
    [0x4d], Buffer.from([payload.length & 0xff, (payload.length >> 8) & 0xff]), payload,
    [0x68],
  ]);
  const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
  return cat([
    [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
    [0x01], Buffer.from(prevTxid), u32le(prevVout), [0x00], [0xfd, 0xff, 0xff, 0xff],
    [0x01], Buffer.alloc(8), [0x00],
    wit0,
    Buffer.alloc(4),
  ]);
}

// Easy-PoW header for merkleRoot with an explicit prev (so a chain links). Mirrors btc-mini.mineHeader.
function mineLinked(merkleRoot, prev, bits = 0x1f00ffff) {
  const target = bitsToTarget(bits);
  const h = Buffer.alloc(80);
  h.writeUInt32LE(0x20000000, 0);
  Buffer.from(prev).copy(h, 4);
  Buffer.from(merkleRoot).copy(h, 36);
  h.writeUInt32LE(1700000000, 68);
  h.writeUInt32LE(bits, 72);
  for (let nonce = 0; nonce < 0xffffffff; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (Buffer.compare(Buffer.from(dsha256(h)).reverse(), target) <= 0) return h;
  }
  throw new Error('no nonce');
}

const ANCHOR_HEIGHT = 308800;

// ── 1. Supply note C_0 (fixed supply S). ──
const S = 1000n, r0 = 0x5151n;
const C0 = prover.commit(S, r0);
const C0c = compress(C0);

// ── 2. CETCH etch committing C_0 (canonical layout; mint_authority = 0 → fixed supply). ──
const cetch = cat([
  [0x21], [0x03], Buffer.from('TAC'), [0x08],
  C0c,                 // commitment = C_0 (33B)
  Buffer.alloc(8),     // amount_ct
  [0x00, 0x00],        // rp_len = 0
  Buffer.alloc(32),    // mint_authority = NONE
  [0x00, 0x00],        // img_len = 0
]);
const etchTx = revealTx(cetch, Buffer.alloc(32), 0);
const etchTxid = computeTxid(etchTx);
const assetId = sha256(cat([etchTxid, u32le(0)])); // asset_id_from_etch (vout 0)
const etchTxidHex = hexp(etchTxid);
const assetHex = hexp(assetId);

// ── 3. Provenance CXFER: (etchTxid,0) C_0 → burned note (1-in/1-out conserving, value S). ──
const r1 = 0x6262n;
const burned = prover.commit(S, r1);
const burnedC = compress(burned);
const { proof: cxRange } = bppRangeProve([S], [r1]);
const excess = ((r0 - r1) % N + N) % N;
const kmsg = sha256(_cat([
  new TextEncoder().encode('tacit-kernel-v1'), assetId, new Uint8Array([1]),
  etchTxid, u32le(0), new Uint8Array([1]), burnedC, u64le(0),
].map((x) => Uint8Array.from(x))));
const { sig: cxSig, px } = bip340Sign(kmsg, excess);
const Pchk = C0.add(burned.negate());
if (Buffer.compare(Buffer.from(compress(Pchk).slice(1)), Buffer.from(px)) !== 0) throw new Error('cxfer not conserving');
const cxEnv = cat([
  [0x22], assetId, cxSig, [0x01],
  burnedC, Buffer.alloc(8),
  u16le(cxRange.length), cxRange,
]);
const cxTx = revealTx(cxEnv, etchTxid, 0);
const cxTxid = computeTxid(cxTx);
const cxTxidHex = hexp(cxTxid);
const { cx: burnedCx, cy: burnedCy } = xyHex(burned);

// ── 4. Burn tx (0x2B) spending the burned note → env_nu (the note's real ν) + env_dest. ──
const envNu = pool.nullifier(burnedCx, burnedCy);
const envDest = '0x' + 'dd'.repeat(32);
const burnEnv = cat([
  [0x2b], assetId, Buffer.alloc(32), // bitcoinPoolRoot field (unused by parse_burn_envelope)
  Buffer.from(envNu.slice(2), 'hex'), Buffer.from(envDest.slice(2), 'hex'),
]);
const burnTx = revealTx(burnEnv, cxTxid, 0);
const burnTxid = computeTxid(burnTx);

// ── 5. Contiguous easy-PoW chain: [etch, cxfer] (prov) then [burn] (scan); prov_tip == prev_hash. ──
const etchHdr = mineLinked(computeMerkleRoot([etchTxid]), Buffer.alloc(32));
const cxHdr = mineLinked(computeMerkleRoot([cxTxid]), dsha256(etchHdr));
const burnHdr = mineLinked(computeMerkleRoot([burnTxid]), dsha256(cxHdr));

// ── 6. IMT inserts from genesis (the burned note's ν + the bridge-out dest). ──
const state = pool.makeScanReflectionState();
state.setHeight(ANCHOR_HEIGHT - 1);
const c0 = state.counts();
const prior = {
  poolRoot: state.poolRoot(), noteCount: c0.note,
  spentRoot: state.spentRoot(), spentCount: c0.spent,
  live: [], liveCount: 0,
  burnRoot: state.burnRoot(), burnCount: c0.burn,
  height: c0.height,
  cbtcLocks: [], cbtcBackingSats: 0, // the gap the committed assembler/harness omit (guest reads them)
};
const spentInsert = state.foldSpent(envNu);
const burnInsert = state.foldBurn(envNu, envDest);

// ── 7. Fixture (the burnDeposit witness on the scan tx). Single-tx blocks → merkle root == txid. ──
const burnDeposit = {
  etchTx: hexp(etchTx),
  etchIndex: 0,
  etchSiblings: [],
  provHeaders: [hexp(etchHdr), hexp(cxHdr)],
  cxfers: [{
    txid: cxTxidHex,
    inputs: [{ prevTxid: etchTxidHex, prevVout: 0, commitment: hexp(C0c) }],
    outputs: [{ commitment: hexp(burnedC), vout: 0 }],
    rangeProof: hexp(cxRange),
    kernelSig: hexp(cxSig),
    merkleSiblings: [],
    merkleIndex: 0,
    confirmedBlockRoot: hexp(computeMerkleRoot([cxTxid])),
  }],
  burnedCx, burnedCy,
  spentInsert, burnInsert,
};
const fixture = {
  note: 'TAC burn-deposit: C_0 → conserving cxfer → burned note → 0x2B burn; native-exec the reflect guest to fold it.',
  prior,
  anchorHeight: ANCHOR_HEIGHT,
  headers: [hexp(burnHdr)],
  blocks: [{ txs: [{ txData: hexp(burnTx), openings: [], spentInserts: [], outputs: [], burnDeposit }] }],
};

console.error(`etch=${etchTxidHex.slice(0, 12)} cxfer=${cxTxidHex.slice(0, 12)} burn=${hexp(burnTxid).slice(0, 12)} env_nu=${envNu.slice(0, 12)} S=${S}`);
console.error(`prov_tip=${hexp(dsha256(cxHdr)).slice(0, 12)} scan_prev=${hexp(burnHdr.subarray(4, 36)).slice(0, 12)} (must match)`);
console.log(JSON.stringify(fixture, null, 2));
