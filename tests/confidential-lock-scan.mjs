#!/usr/bin/env node
// Calldata-based stealth lock-set scanner (dapp/confidential-lock-scan.js). Validates the ABI decoding
// against SYNTHETIC, independently-hand-encoded fixtures — deliberately NOT sharing an encoder with the
// module under test, so agreement between this test's encoder and the module's decoder is a real
// cross-check, not a tautology. Run: node tests/confidential-lock-scan.mjs

import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialLockScan } from '../dapp/confidential-lock-scan.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const scan = makeConfidentialLockScan({ pool });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// ── minimal, independent ABI encoding helpers ──
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const bytes32 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
function encBytes(hex) {
  const b = String(hex).replace(/^0x/, '');
  const pad = (64 - (b.length % 64)) % 64;
  return word(b.length / 2) + b + '0'.repeat(pad);
}
function encBytes32Array(items) { return word(items.length) + items.map(bytes32).join(''); }
function encBytesArray(items) {
  const encs = items.map(encBytes);
  let off = items.length * 32, head = '';
  for (const e of encs) { head += word(off); off += e.length / 2; }
  return word(items.length) + head + encs.join('');
}
const selector = (sig) => Array.from(keccak_256(new TextEncoder().encode(sig)).slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');
function encodeSettleCall({ publicValues, proof, memos }) {
  const pvEnc = encBytes(publicValues), proofEnc = encBytes(proof), memosEnc = encBytesArray(memos);
  const offPv = 3 * 32, offProof = offPv + pvEnc.length / 2, offMemos = offProof + proofEnc.length / 2;
  return '0x' + selector('settle(bytes,bytes,bytes[])') + word(offPv) + word(offProof) + word(offMemos) + pvEnc + proofEnc + memosEnc;
}
// Build an 18-field (indices 0..17) PublicValues-shaped tuple: field types match the real struct's
// declaration order in contracts/src/ConfidentialPool.sol. Fields the decoder doesn't touch are filled
// with structurally-valid placeholders (a zero bytes32 for statics, an empty array for dynamics) — the
// point is proving the decoder finds 4/16/17 at the right POSITION, not that it tolerates garbage there.
function encodePublicValuesPrefix({ leaves, lockSetRoot, lockLeaves }) {
  const zero32 = bytes32('0x' + '00'.repeat(32));
  const FIELDS = [
    { static: word(1) },                          // 0  version
    { static: zero32 },                           // 1  chainBinding
    { static: zero32 },                           // 2  spendRoot
    { dynEnc: encBytes32Array([]) },               // 3  nullifiers
    { dynEnc: encBytes32Array(leaves) },           // 4  leaves            ← under test
    { dynEnc: encBytes32Array([]) },               // 5  depositsConsumed
    { dynEnc: word(0) },                           // 6  withdrawals (struct[], empty)
    { dynEnc: word(0) },                           // 7  fees (struct[], empty)
    { dynEnc: encBytes32Array([]) },               // 8  bitcoinBurnsConsumed
    { dynEnc: word(0) },                           // 9  crossOuts (struct[], empty)
    { dynEnc: encBytes32Array([]) },               // 10 bitcoinRootsUsed
    { static: zero32 },                            // 11 bitcoinSpentRoot
    { static: zero32 },                            // 12 bitcoinBurnRoot
    { dynEnc: word(0) },                           // 13 swaps (struct[], empty)
    { dynEnc: word(0) },                           // 14 liquidity (struct[], empty)
    { static: word(0) },                           // 15 deadline
    { static: bytes32(lockSetRoot) },              // 16 lockSetRoot       ← under test
    { dynEnc: encBytes32Array(lockLeaves) },       // 17 lockLeaves        ← under test
  ];
  let head = '', tail = '', tailPos = FIELDS.length * 32;
  for (const f of FIELDS) {
    if (f.static != null) { head += f.static; continue; }
    head += word(tailPos); tail += f.dynEnc; tailPos += f.dynEnc.length / 2;
  }
  return '0x' + head + tail;
}

// ── 1. decodeSettleCalldata: round-trips publicValues/proof/memos exactly, incl. an empty memo ──
{
  const pv = '0x' + 'aa'.repeat(37); // odd length exercises the ABI right-padding
  const proof = '0x' + 'bb'.repeat(64);
  const memos = ['0x' + 'cc'.repeat(10), '0x', '0x' + 'ee'.repeat(50)];
  const calldata = encodeSettleCall({ publicValues: pv, proof, memos });
  const decoded = scan.decodeSettleCalldata(calldata);
  assert.strictEqual(decoded.publicValues.toLowerCase(), pv.toLowerCase(), 'publicValues round-trips');
  assert.strictEqual(decoded.proof.toLowerCase(), proof.toLowerCase(), 'proof round-trips');
  assert.deepStrictEqual(decoded.memos.map((m) => m.toLowerCase()), memos.map((m) => m.toLowerCase()), 'memos[] round-trips, incl. an empty one');
  ok('decodeSettleCalldata: round-trips a settle(bytes,bytes,bytes[]) call exactly');
}

// ── 2. decodePublicValuesLockFields: finds leaves(4)/lockSetRoot(16)/lockLeaves(17) at the right
// position regardless of every other field, both static and dynamic, before and after them ──
{
  const KNOWN_LEAVES = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32)];
  const KNOWN_LOCK_SET_ROOT = '0x' + '44'.repeat(32);
  const KNOWN_LOCK_LEAVES = ['0x' + '55'.repeat(32), '0x' + '66'.repeat(32)];
  const publicValues = encodePublicValuesPrefix({ leaves: KNOWN_LEAVES, lockSetRoot: KNOWN_LOCK_SET_ROOT, lockLeaves: KNOWN_LOCK_LEAVES });
  const out = scan.decodePublicValuesLockFields(publicValues);
  assert.strictEqual(out.leavesCount, KNOWN_LEAVES.length, 'leaves count read from field 4 (dynamic)');
  assert.strictEqual(out.lockSetRoot.toLowerCase(), KNOWN_LOCK_SET_ROOT.toLowerCase(), 'lockSetRoot read from field 16 (static)');
  assert.deepStrictEqual(out.lockLeaves.map((x) => x.toLowerCase()), KNOWN_LOCK_LEAVES.map((x) => x.toLowerCase()), 'lockLeaves read from field 17 (dynamic)');

  // A lock-only settle (mirroring OP_STEALTH_LOCK: leaves is EMPTY, lockLeaves is not) still decodes clean.
  const lockOnly = encodePublicValuesPrefix({ leaves: [], lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: KNOWN_LOCK_LEAVES });
  const out2 = scan.decodePublicValuesLockFields(lockOnly);
  assert.strictEqual(out2.leavesCount, 0, 'a lock-only settle has an empty ordinary leaves array');
  assert.deepStrictEqual(out2.lockLeaves.map((x) => x.toLowerCase()), KNOWN_LOCK_LEAVES.map((x) => x.toLowerCase()));
  ok('decodePublicValuesLockFields: reads leaves/lockSetRoot/lockLeaves correctly amid realistic filler fields');
}

// ── 3. scanLockLeaves: walks a settle-tx stream (out of chain order), skips non-lock settles and
// malformed inputs, reconstructs the lock-set tree in on-chain (block, logIndex) order ──
{
  const LOCK_A = ['0x' + 'a1'.repeat(32), '0x' + 'a2'.repeat(32)];
  const LOCK_B = ['0x' + 'b1'.repeat(32)];
  // tx "early": 2 note leaves + 1 lock-memo-tail entry is WRONG on purpose below to prove tail-slicing —
  // here it's a clean 2 note leaves (2 memos) + LOCK_A (2 lock leaves, 2 more memos) = 4 memos total.
  const pvEarly = encodePublicValuesPrefix({ leaves: ['0x' + 'e1'.repeat(32), '0x' + 'e2'.repeat(32)], lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: LOCK_A });
  const memosEarly = ['0x' + 'aa'.repeat(5), '0x' + 'bb'.repeat(5), '0x' + 'cc'.repeat(5) /* lock memo A0 */, '0x' + 'dd'.repeat(5) /* lock memo A1 */];
  const txEarly = encodeSettleCall({ publicValues: pvEarly, proof: '0x1234', memos: memosEarly });

  // tx "late" (higher block): a pure lock settle, no note leaves, one lock leaf + its one memo.
  const pvLate = encodePublicValuesPrefix({ leaves: [], lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: LOCK_B });
  const memosLate = ['0x' + 'ee'.repeat(5) /* lock memo B0 */];
  const txLate = encodeSettleCall({ publicValues: pvLate, proof: '0x5678', memos: memosLate });

  // tx "no-lock": an ordinary transfer settle (one note leaf, zero locks) — must be skipped entirely.
  const pvNoLock = encodePublicValuesPrefix({ leaves: ['0x' + 'ff'.repeat(32)], lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: [] });
  const txNoLock = encodeSettleCall({ publicValues: pvNoLock, proof: '0x9999', memos: ['0x' + '77'.repeat(5)] });

  const events = [
    // Deliberately out of chain order (late before early) and a duplicate txHash for "late" (a caller
    // merging streams), plus a garbled tx and a tx the RPC fetcher can't find (getTxInput → null).
    { txHash: '0xlate', blockNumber: 200, logIndex: 0 },
    { txHash: '0xlate', blockNumber: 200, logIndex: 0 }, // duplicate — must not double-count
    { txHash: '0xearly', blockNumber: 100, logIndex: 3 },
    { txHash: '0xnolock', blockNumber: 150, logIndex: 1 },
    { txHash: '0xgarbage', blockNumber: 160, logIndex: 0 },
    { txHash: '0xmissing', blockNumber: 170, logIndex: 0 },
  ];
  const inputs = { '0xearly': txEarly, '0xlate': txLate, '0xnolock': txNoLock, '0xgarbage': '0xdeadbeef', '0xmissing': null };
  const getTxInput = async (h) => inputs[h];

  const result = await scan.scanLockLeaves({ events, getTxInput });
  assert.deepStrictEqual(result.lockLeaves.map((x) => x.toLowerCase()), [...LOCK_A, ...LOCK_B].map((x) => x.toLowerCase()), 'lock leaves in chain (block, logIndex) order, duplicate tx not double-counted, no-lock/garbled/missing txs skipped');
  assert.deepStrictEqual(result.lockMemos.map((x) => x.toLowerCase()), ['0x' + 'cc'.repeat(5), '0x' + 'dd'.repeat(5), '0x' + 'ee'.repeat(5)].map((x) => x.toLowerCase()), 'lock memos correctly sliced from the tail (after the ordinary note memos) and aligned to lockLeaves order');

  // The reconstructed tree's root matches inserting the same leaves, in the same order, into a fresh tree.
  const ref = new pool.Tree();
  for (const lf of [...LOCK_A, ...LOCK_B]) ref.insert(lf);
  assert.strictEqual(result.lockSetRoot, ref.root(), 'reconstructed lock-set root matches a reference tree over the same leaves/order');
  ok('scanLockLeaves: reconstructs the lock-set tree + memo tail across an out-of-order, noisy tx stream');
}

console.log(`\n${n}/${n} confidential-lock-scan checks passed`);
