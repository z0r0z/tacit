#!/usr/bin/env node
// Build a full-scan reflection input around a SYNTHETIC swap_var (T_SWAP_VAR 0x32) against a SEEDED C0-backed
// pool, so the reflection guest folds it and MUST land on the JS assembler's newDigest — the reflect-exec
// guest<->JS digest-parity check for the C-01 current-price + refund-floor swap_var fold.
//
// The confirmed tx now carries P2TR outputs at vout 1 (receipt), vout 2 (change) and vout 3 (refund); the fold
// reads each destination's x-only key from the tx (like the guest) and FORMS the receipt from delta_out'
// recomputed against the CURRENT reserves. SWAPVAR_SCENARIO selects the branch:
//   fresh    (default) — reserves == the declared snapshot, min_out met → receipt onboards, reserves advance.
//   stale              — the pool has ADVANCED past the declared snapshot; the swap still clears at the MOVED
//                        price (closes C-01: no skip-and-strand). Expected outcome: DIGEST_MATCH-with-receipt.
//   overslip           — min_out above what the pool clears → REFUND at vout 3. DIGEST_MATCH-with-refund.
//   expired            — expiry_height < block height → REFUND at vout 3. DIGEST_MATCH-with-refund.
// SWAPVAR_CHANGE>0 adds a non-sentinel change note (vout 2) for the fresh/stale cases.
//   node tests/gen-reflection-swapvar-synth.mjs > /tmp/swapvar-reflect-input.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { bppRangeProve } from '../dapp/bulletproofs-plus.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';
import { swapVarKernelSig } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
// A P2TR output: value(8 LE) ‖ 0x22 (scriptlen 34) ‖ 0x51 0x20 ‖ x-only(32).
const p2trOut = (xonlyHex) => cat([u64le(0), [0x22], [0x51, 0x20], hb(xonlyHex)]);

const SCENARIO = process.env.SWAPVAR_SCENARIO || 'fresh';
const ASSET_A = '0x' + 'a1'.repeat(32), ASSET_B = '0x' + 'b2'.repeat(32), POOL_ID = '0x' + '99'.repeat(32);
const ZERO_OWNER = '0x' + '00'.repeat(32);
const BLOCK_HEIGHT = 310000;
// x-only keys of the confirmed receipt / change / refund outputs — the fold binds each onboarded note to these.
const RECEIPT_XONLY = 'e1'.repeat(32), CHANGE_XONLY = 'e2'.repeat(32), REFUND_XONLY = 'e3'.repeat(32), V0_XONLY = 'e0'.repeat(32), TIP_XONLY = 'e4'.repeat(32);

// The trader's SIGNED snapshot (declared on the wire, no longer priced against). The pool is SEEDED to either
// the same reserves (fresh) or advanced ones (stale) — the fold prices against the seeded (current) reserves.
const declA = 1000000n, declB = 2000000n, deltaIn = 1000n;
const seedA = SCENARIO === 'stale' ? declA + 500000n : declA;
const seedB = SCENARIO === 'stale' ? declB - 900000n : declB;
const rIn = 0xAAA1n, rReceipt = 0xBBB2n;
const CHANGE = BigInt(process.env.SWAPVAR_CHANGE || 0), rChange = 0xC3C3n;
const TIP = BigInt(process.env.SWAPVAR_TIP || 0);   // settler tip (gasless relay) — onboarded to vout 4
// The amount the fold clears to against the SEEDED reserves (fee 0), and the min_out per scenario.
const clearedOut = pool.getAmountOut(deltaIn, seedA, seedB, 0);
const minOut = SCENARIO === 'overslip' ? clearedOut + 1n : 0n;
const expiry = SCENARIO === 'expired' ? BLOCK_HEIGHT - 1 : BLOCK_HEIGHT + 1000;
const willRefund = SCENARIO === 'overslip' || SCENARIO === 'expired';

// The input covers delta_in + tip (both drawn by the kernel) + change; cIn − cChange = (delta_in+tip)·H + rIn·G.
const cInXY = CHANGE > 0n ? pool.commitXY(deltaIn + TIP + CHANGE, rIn + rChange) : pool.commitXY(deltaIn + TIP, rIn);
const cIn = pool.compressXY(cInXY.cx, cInXY.cy);
const cReceiptXY = pool.commitXY(clearedOut, rReceipt); // the DECLARED c_receipt (ignored by the fold; wire only)
const cReceipt = pool.compressXY(cReceiptXY.cx, cReceiptXY.cy);
const cChangeHex = CHANGE > 0n ? pool.compressXY(...Object.values(pool.commitXY(CHANGE, rChange))) : ('0x' + '00'.repeat(33));
const SENTINEL = Buffer.alloc(33);
const cChangeField = CHANGE > 0n ? hb(cChangeHex) : SENTINEL;
const seedTxid = Buffer.alloc(32, 0x77), seedVout = 0;

const kernelSig = swapVarKernelSig({ assetHex: ASSET_A, txidHex: '0x' + seedTxid.toString('hex'), vout: seedVout, cChangeBytes: cChangeField, deltaInTotal: deltaIn + TIP, rIn });

// A real trader keypair; the guest (and the JS assembler) rebuild the intent message from the tx output scripts +
// envelope and BIP-340-verify it, so the fixture MUST carry a valid intent_sig or the fold skips (auth fails).
const TRADER_PRIV_HEX = '44'.repeat(32);
const isSentinel = CHANGE === 0n;
const P2TR = (x) => '0x5120' + x;
const receiveSpk = P2TR(RECEIPT_XONLY), changeSpk = P2TR(CHANGE_XONLY), refundSpk = P2TR(REFUND_XONLY);
// Derive the trader x-only from the private key (0x02 ‖ x, BIP-340 even-y convention the verifier assumes).
const TRADER_X = Buffer.from(secp.ProjectivePoint.BASE.multiply(BigInt('0x' + TRADER_PRIV_HEX)).toRawBytes(true)).slice(1).toString('hex');
const TRADER_PUB = '0x02' + TRADER_X;
const intentMsg = pool.swapVarIntentMsg({
  poolId: POOL_ID, direction: 0, deltaIn, deltaInMin: 0, deltaInMax: 0, minOut, tipAmount: TIP, tipAsset: 0,
  expiryHeight: expiry, traderPubkey: TRADER_PUB, inputTxid: '0x' + seedTxid.toString('hex'), inputVout: seedVout,
  receiveSpk, rReceipt: '0x' + Buffer.from(be(rReceipt, 32)).toString('hex'), cChangeOrSentinel: cChangeHex,
  changeSpk: isSentinel ? new Uint8Array(0) : changeSpk, refundSpk,
});
const intentSig = signSchnorr(intentMsg, Uint8Array.from(Buffer.from(TRADER_PRIV_HEX, 'hex')));

// m=1 BP+ range proof over [C_change_or_sentinel] — the guest verify_range's it UNCONDITIONALLY (sentinel ⇒
// value 0 ⇒ V = identity). Without it the guest skips the whole fold. Prove the actual change for a real change.
const rangeProof = Buffer.from(CHANGE > 0n ? bppRangeProve([CHANGE], [rChange]).proof : bppRangeProve([0n], [0n]).proof);

// T_SWAP_VAR envelope (layout per parse_swap_var_envelope): min_out @82, expiry_height @99, range_proof @269.
const envelope = cat([
  [0x32], hb(POOL_ID), [0x00],
  u64le(declA), u64le(declB),
  u64le(deltaIn), u64le(0), u64le(0),
  u64le(clearedOut), u64le(minOut),
  u64le(TIP), [0x00], u32le(expiry),
  hb(TRADER_PUB),                                    // trader_pubkey (33) — the guest verifies intent_sig under it
  hb(cIn), cChangeField, hb(cReceipt), be(rReceipt, 32),
  u16le(rangeProof.length), rangeProof,             // rp_len ‖ range_proof (m=1 BP+ over the change)
  Buffer.from(kernelSig), Buffer.from(intentSig),    // kernel_sig, intent_sig (real BIP-340 over swapVarIntentMsg)
]);

const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([envelope.length & 0xff, (envelope.length >> 8) & 0xff]), envelope, [0x68]]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]);
// 5 outputs: vout0 (unused), vout1 receipt, vout2 change, vout3 refund, vout4 settler-tip — all P2TR so the fold reads real x-only keys.
const outputs = cat([p2trOut(V0_XONLY), p2trOut(RECEIPT_XONLY), p2trOut(CHANGE_XONLY), p2trOut(REFUND_XONLY), p2trOut(TIP_XONLY)]);
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x05], outputs, wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx);
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

// Seed the prior: the C0-backed pool (at the SEEDED — possibly advanced — reserves) + the taker's input note.
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.pools.load([{ poolId: POOL_ID, assetA: ASSET_A, assetB: ASSET_B, reserveA: seedA.toString(), reserveB: seedB.toString(), totalShares: '1000', c0Backed: true, feeBps: 0, protocolFeeBps: 0, kLast: (seedA * seedB).toString(), protocolFeeAccrued: '0' }]);
const coords = new Map();
const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
state.foldOutput(pool.leaf(ASSET_A, cInXY.cx, cInXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(cInXY.cx, cInXY.cy), ASSET_A);
coords.set(inOutpoint.toLowerCase(), { cx: cInXY.cx, cy: cInXY.cy });

const txSpec = {
  txData: '0x' + tx.toString('hex'),
  txid: '0x' + Buffer.from(txid).toString('hex'),
  vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }],
  env: {
    type: 'swap_var', poolId: POOL_ID, direction: 0,
    rAPre: declA.toString(), rBPre: declB.toString(),
    deltaIn: deltaIn.toString(), deltaInMin: 0, deltaInMax: 0, tipAmount: TIP.toString(), tipAsset: 0, deltaOut: clearedOut.toString(),
    minOut: minOut.toString(), expiryHeight: expiry, traderPubkey: TRADER_PUB,
    cIn, cChangeOrSentinel: cChangeHex, cReceipt,
    rReceipt: '0x' + Buffer.from(be(rReceipt, 32)).toString('hex'), rangeProof: '0x' + rangeProof.toString('hex'),
    kernelSig: '0x' + Buffer.from(kernelSig).toString('hex'),
    intentSig: '0x' + Buffer.from(intentSig).toString('hex'),
  },
};
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, coords);

const p = state.pools.get(POOL_ID);
const reservesMoved = !(BigInt(p.reserveA) === seedA && BigInt(p.reserveB) === seedB);
const noteAdded = state.counts().note === 2; // 1 seeded input + 1 onboarded (receipt or refund)
if (willRefund) {
  if (reservesMoved) { console.error('FATAL: refund scenario moved the reserves (should be untouched)'); process.exit(1); }
  if (!noteAdded) { console.error('FATAL: refund scenario onboarded no note'); process.exit(1); }
  const rf = pool.decompressCommitment(cIn);
  const refundLeaf = pool.btcNoteLeaf(ASSET_A, rf.cx, rf.cy, '0x' + REFUND_XONLY);
  if (!state._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === refundLeaf.toLowerCase())) { console.error('FATAL: refund leaf not onboarded'); process.exit(1); }
} else {
  if (!(BigInt(p.reserveA) === seedA + deltaIn && BigInt(p.reserveB) === seedB - clearedOut)) { console.error('FATAL: fresh/stale reserves did not advance to the cleared price'); process.exit(1); }
  const rc = pool.commitXY(clearedOut, rReceipt);
  const recvLeaf = pool.btcNoteLeaf(ASSET_B, rc.cx, rc.cy, '0x' + RECEIPT_XONLY);
  if (!state._acc.notes.leaves.some((l) => pool.hx(l).toLowerCase() === recvLeaf.toLowerCase())) { console.error('FATAL: receipt leaf not onboarded'); process.exit(1); }
  const expectedNotes = 2 + (CHANGE > 0n ? 1 : 0) + (TIP > 0n ? 1 : 0); // seed input + receipt (+ change) (+ settler tip)
  if (state.counts().note !== expectedNotes) { console.error(`FATAL: note count ${state.counts().note} != expected ${expectedNotes} (change/tip onboarding)`); process.exit(1); }
}
console.error(`swap_var[${SCENARIO}]: dIn=${deltaIn} clearedOut=${clearedOut} minOut=${minOut} refund=${willRefund} reservesPost=A:${p.reserveA} B:${p.reserveB} newDigest=${input.newDigest}`);
console.log(JSON.stringify(input));
