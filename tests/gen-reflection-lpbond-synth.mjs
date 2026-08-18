#!/usr/bin/env node
// Focused reflection fixture for the trustless LP-BOND fold (0x35) — the share-lock that opens a farm position
// in isolation (the farm-lifecycle fixture covers harvest+unbond; this pins bond alone). The LP spends a live
// LP-share note of the farm's `lp_asset` (value == bond_amount); the share-lock kernel binds bond_amount to
// that spend (Σ C_in − bond_amount·H = r·G, signed by the input blinding r). fold_lp_bond accrues the farm,
// adds bond_amount to total_shares, APPENDS the RECEIPT note (the stable position id) and stamps its entry (=
// live rps, owner, nonce). The guest must land on the JS assembler's newDigest — the reflect-exec guest↔JS
// digest-parity check for the bond fold.
//   node tests/gen-reflection-lpbond-synth.mjs > /tmp/lpbond-reflect.json
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { G } from '../dapp/bulletproofs.js';
import { computeTxid, computeMerkleRoot, mineHeader, varint, cat, makeCoinbaseForEnvTx } from './btc-mini.mjs';
import { bip340Sign } from './_swapvar-kernel.mjs';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128le = (n) => { const b = Buffer.alloc(16); let v = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const be = (n, len = 32) => Uint8Array.from(Buffer.from(BigInt(n).toString(16).padStart(len * 2, '0'), 'hex'));
const hb = (h) => Buffer.from(h.replace(/^0x/, ''), 'hex');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const N = secp.CURVE.n;

const POOL_ID = '0x' + '35'.repeat(32), FARM_ID = '0x' + '44'.repeat(32);
const REWARD_ASSET = '0x' + 'c3'.repeat(32);
const NONCE0 = '0x' + '07'.repeat(32);
const LAUNCHER_PUB = '0x02' + 'aa'.repeat(32);
const SHARES = 100, RATE = 100, TREASURY = 1_000_000n;
const BLOCK_HEIGHT = 313000, GAP = 10; // farm seeded GAP blocks ago ⇒ live rps accrues on bond accrue()
const ZERO_OWNER = '0x' + '00'.repeat(32);

// The farm's bondable LP-share asset (derived from the pool id, mirrored by foldFarmInitRewards / the guest).
const LP_ASSET = pool.ammDeriveLpAssetId(POOL_ID); // already a 0x-hex string

// One-time receipt owner (blinded pubkey+b·G in production; an x-only key suffices for the receipt leaf here).
const OWNER_PRIV = be('0x0b0c0d0e0f0102030405060708090a0b0c0d0e0f01020304050607080900aabb', 32);
const OWNER = hx(G.multiply(BigInt(hx(OWNER_PRIV))).toRawBytes(true).slice(1)); // x-only (32 bytes)

// The LP-share note the bond CONSUMES: a live note of `lp_asset` opening to bond_amount under blinding r.
// value == bond_amount ⇒ Σ C_in − bond_amount·H = r·G, so the share-lock kernel key is r (the input blinding).
const BOND_R = 0xABCDEF12n;
const seedTxid = Buffer.alloc(32, 0xb0), seedVout = 0;
const shareXY = pool.commitXY(BigInt(SHARES), BOND_R);

// Share-lock kernel sig (mirror lp_bond_kernel_verify / LP_BOND_KERNEL_DOMAIN): msg = domain ‖ farm_id ‖
// lp_asset ‖ bond_amount_LE ‖ n_inputs ‖ (txid ‖ vout_LE)* — signed with the LP-share input blinding r.
const kernelParts = [new TextEncoder().encode('tacit-amm-lp-bond-v1'), hb(FARM_ID), hb(LP_ASSET), u64le(SHARES), Uint8Array.of(1), seedTxid, u32le(seedVout)];
const kernelSig = bip340Sign(sha256(cat(kernelParts)), BOND_R % N);

// The bonder authorizes the bond with a BIP-340 sig over lp_bond_msg (H-04: a zero sig is correctly rejected).
const BONDER_PRIV = be('0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20', 32);
const BONDER_PUB = G.multiply(BigInt(hx(BONDER_PRIV))).toRawBytes(true); // compressed (33)
const BOND_VIEW_H = 0, ENTRY_ACC = 0n;
const REFUND_EXPIRY = 999999, REFUND_DEST = hb('0x' + 'ee'.repeat(32)), REFUND_BLIND = hb('0x' + 'ef'.repeat(32));
// funding_hash = sha256( (prev_txid(32) ‖ prev_vout(4 LE))* ‖ sha256(kernel_sig) ), the lp_asset spend in kernel
// order (mirror the assembler's ammFundingHash: guest-internal outpoint bytes, no reversal).
const bondFundingHash = sha256(cat([seedTxid, u32le(seedVout), sha256(Buffer.from(kernelSig))]));
// lp_bond_msg = domain ‖ farm_id ‖ bonder_pubkey ‖ bond_amount(8) ‖ entry_acc(16) ‖ view_h(4) ‖ owner(32) ‖
// nonce(32) ‖ funding_hash(32) ‖ refund_expiry(4) ‖ refund_dest_xonly(32) ‖ refund_blinding(32).
const bondMsg = sha256(cat([
  new TextEncoder().encode('tacit-amm-farm-bond-v1'), hb(FARM_ID), BONDER_PUB,
  u64le(SHARES), u128le(ENTRY_ACC), u32le(BOND_VIEW_H), hb(OWNER), hb(NONCE0), bondFundingHash,
  u32le(REFUND_EXPIRY), REFUND_DEST, REFUND_BLIND,
]));
const bonderSig = bip340Sign(bondMsg, BigInt(hx(BONDER_PRIV)) % N);

// 0x35 envelope (389, rp_len=0): op ‖ farm_id(32) ‖ bonder_pubkey(33) ‖ bond_amount(8) ‖ entry_acc(16) ‖
// view_h(4) ‖ owner_commit(32) ‖ nonce(32) ‖ c_change(33) ‖ rp_len(2)=0 ‖ kernel_sig(64) ‖ bonder_sig(64) ‖
// refund_expiry(4) ‖ refund_dest_xonly(32) ‖ refund_blinding(32).
const bondEnv = cat([
  [0x35], hb(FARM_ID), Buffer.from(BONDER_PUB), u64le(SHARES), u128le(ENTRY_ACC), u32le(BOND_VIEW_H),
  hb(OWNER), hb(NONCE0), Buffer.alloc(33), u16le(0),
  Buffer.from(kernelSig), Buffer.from(bonderSig),
  u32le(REFUND_EXPIRY), REFUND_DEST, REFUND_BLIND,
]);
if (bondEnv.length !== 389) { console.error(`FATAL: bond envelope length ${bondEnv.length} (want 389)`); process.exit(1); }

const tapscript = cat([[0x20], Buffer.alloc(32), [0xac], [0x00, 0x63], [0x05], Buffer.from('TACIT'), [0x01, 0x01], [0x4d], Buffer.from([bondEnv.length & 0xff, (bondEnv.length >> 8) & 0xff]), bondEnv, [0x68]]);
const inputsBuf = cat([seedTxid, u32le(seedVout), [0x00], [0xfd, 0xff, 0xff, 0xff]]); // spends the live LP-share note
const wit0 = cat([[0x03], [0x40], Buffer.alloc(0x40), varint(tapscript.length), tapscript, [0x21], Buffer.alloc(0x21, 0xc0)]);
const tx = cat([[0x02, 0x00, 0x00, 0x00], [0x00, 0x01], varint(1), inputsBuf, [0x01], Buffer.alloc(8), [0x00], wit0, Buffer.alloc(4)]);
const txid = computeTxid(tx);
const { coinbaseSpec, cbTxid } = makeCoinbaseForEnvTx(tx); // coinbase at tx 0 (guest extracts envelopes for ti != 0)
const header = mineHeader(computeMerkleRoot([cbTxid, txid]));

// prior: a registered farm (launcher_pubkey + lp_asset) + the C0-backed treasury + the live LP-share note.
const state = pool.makeScanReflectionState();
state.setHeight(BLOCK_HEIGHT - 1);
state.farmRewards.load([{ farmId: FARM_ID, rate: String(RATE), totalShares: '0', rps: '0', totalRewardDebt: '0', lastHeight: String(BLOCK_HEIGHT - GAP), launcherPubkey: LAUNCHER_PUB, lpAsset: LP_ASSET }]);
state.pools.load([{ poolId: FARM_ID, assetA: REWARD_ASSET, assetB: ZERO_OWNER, reserveA: TREASURY.toString(), reserveB: '0', totalShares: '0', c0Backed: true, protocolFeeBps: 0, kLast: '0', protocolFeeAccrued: '0' }]);
const coords = new Map();
const inOutpoint = pool.outpointKey('0x' + seedTxid.toString('hex'), seedVout);
state.foldOutput(pool.leaf(LP_ASSET, shareXY.cx, shareXY.cy, ZERO_OWNER), inOutpoint, pool.commitmentHash(shareXY.cx, shareXY.cy), LP_ASSET);
coords.set(inOutpoint.toLowerCase(), { cx: shareXY.cx, cy: shareXY.cy });

const txSpec = {
  txData: '0x' + tx.toString('hex'), txid: hx(txid),
  vins: [{ prevTxid: '0x' + seedTxid.toString('hex'), vout: seedVout }],
  env: { type: 'lp_bond', farmId: FARM_ID, bondAmount: SHARES, entryAcc: ENTRY_ACC.toString(), bondViewHeight: BOND_VIEW_H, owner: OWNER, nonce: NONCE0, kernelSig: hx(kernelSig), bonderPubkey: hx(BONDER_PUB), bonderSig: hx(bonderSig), refundExpiry: REFUND_EXPIRY, refundDestXonly: hx(REFUND_DEST), refundBlinding: hx(REFUND_BLIND) },
};

const sharesPre = BigInt(state.farmRewards.get(FARM_ID).totalShares);
const noteCountPre = state._acc.notes.leaves.length;
const input = await pool.assembleReflectionScanInput(state, {
  anchorHeight: BLOCK_HEIGHT, headers: ['0x' + Buffer.from(header).toString('hex')], blocks: [{ txs: [coinbaseSpec, txSpec] }],
}, coords);

// Compute the EXACT receipt leaf the bond must append (the entry is stamped in state, not in the leaf).
const stPost = state.farmRewards.get(FARM_ID);
const expectedReceipt = pool.farmReceiptLeaf(FARM_ID, LP_ASSET, SHARES, OWNER, NONCE0);

const lb = input.blocks[0].txs[1].lpBond;
const sharesPost = BigInt(stPost.totalShares);
const noteCountPost = state._acc.notes.leaves.length;
const receiptAppended = state._acc.notes.leaves.some((l) => hx(l).toLowerCase() === expectedReceipt.toLowerCase());
const lpNullified = state.live.get(inOutpoint) == null; // the spent LP-share note left the live set
console.error(`lp_bond: shares ${sharesPre}->${sharesPost} notes ${noteCountPre}->${noteCountPost} receiptAppended=${receiptAppended} lpNullified=${lpNullified} folded=${!!(lb && lb.owner !== ZERO_OWNER)} newDigest=${input.newDigest}`);

// Anti-false-pass: assert REAL post-fold state mutations read from `state` (not the fold-object, which is set
// even on the unbacked skip path). The bond must: (1) APPEND the exact owner-blinded receipt leaf to the note
// tree (count +1, the specific leaf present), (2) credit total_shares += bond_amount, (3) nullify the consumed
// LP-share input. A skip (e.g. wrong envelope length / unbacked kernel) appends nothing → would be a both-skip
// false pass; FATAL it.
if (!receiptAppended) { console.error(`FATAL: bond receipt leaf NOT appended (fold skipped — would be a both-skip false pass)`); process.exit(1); }
if (noteCountPost !== noteCountPre + 1) { console.error(`FATAL: note count did not increase by 1 (${noteCountPre}->${noteCountPost})`); process.exit(1); }
if (sharesPost !== sharesPre + BigInt(SHARES)) { console.error(`FATAL: total_shares not credited by ${SHARES} (${sharesPre}->${sharesPost})`); process.exit(1); }
if (!lpNullified) { console.error('FATAL: consumed LP-share input was not nullified'); process.exit(1); }
console.log(JSON.stringify(input));
