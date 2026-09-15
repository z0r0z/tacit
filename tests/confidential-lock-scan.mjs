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
// Encode a SettleCall (publicValues,proof,memos) tuple's OWN local head+tail — structurally identical to
// encodeSettleCall's body above, just without a leading selector (this is a tuple, not a top-level call).
function encSettleCallTuple({ publicValues, proof, memos }) {
  const pvEnc = encBytes(publicValues), proofEnc = encBytes(proof), memosEnc = encBytesArray(memos);
  const offPv = 3 * 32, offProof = offPv + pvEnc.length / 2, offMemos = offProof + proofEnc.length / 2;
  return word(offPv) + word(offProof) + word(offMemos) + pvEnc + proofEnc + memosEnc;
}
// Independent encoder for TacitRelayer.relaySettle((bytes,bytes,bytes[])[],address[],uint256[],address[],uint256[]).
// Only `calls` matters for these tests; the fee-routing params are filled with structurally-valid minimal values.
function encodeRelaySettleCall(calls) {
  const tuples = calls.map(encSettleCallTuple);
  let tailPos = calls.length * 32, headWords = [];
  for (const t of tuples) { headWords.push(word(tailPos)); tailPos += t.length / 2; }
  const callsArrayEnc = word(calls.length) + headWords.join('') + tuples.join('');
  const feeAssets = encBytes32Array([]); // address[] empty encodes identically to bytes32[] empty (just a length word)
  const minOut = encBytes32Array([]);
  const recipients = encBytes32Array(['0x' + '11'.repeat(20)]); // one non-zero recipient (BadArgs guard, unused by the scanner)
  const bps = encBytes32Array([word(10000)]);
  const offCalls = 5 * 32;
  const offFeeAssets = offCalls + callsArrayEnc.length / 2;
  const offMinOut = offFeeAssets + feeAssets.length / 2;
  const offRecipients = offMinOut + minOut.length / 2;
  const offBps = offRecipients + recipients.length / 2;
  return '0x' + selector('relaySettle((bytes,bytes,bytes[])[],address[],uint256[],address[],uint256[])')
    + word(offCalls) + word(offFeeAssets) + word(offMinOut) + word(offRecipients) + word(offBps)
    + callsArrayEnc + feeAssets + minOut + recipients + bps;
}
// Build an 18-field (indices 0..17) PublicValues-shaped tuple: field types match the real struct's
// declaration order in contracts/src/ConfidentialPool.sol. Fields the decoder doesn't touch are filled
// with structurally-valid placeholders (a zero bytes32 for statics, an empty array for dynamics) — the
// point is proving the decoder finds 4/16/17 at the right POSITION, not that it tolerates garbage there.
function encodePublicValuesPrefix({ leaves, lockSetRoot, lockLeaves, nullifiers = [] }) {
  const zero32 = bytes32('0x' + '00'.repeat(32));
  const FIELDS = [
    { static: word(1) },                          // 0  version
    { static: zero32 },                           // 1  chainBinding
    { static: zero32 },                           // 2  spendRoot
    { dynEnc: encBytes32Array(nullifiers) },       // 3  nullifiers        ← under test
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
  // abi.decode(publicValues, (PublicValues)) decodes a single DYNAMIC struct as a one-element tuple,
  // which per ABI rules prepends an offset word (always 0x20 here) pointing at the struct's own
  // encoding — verified against a real mainnet settle tx. Match that here or this fixture is decoded
  // by a rule the real contract doesn't use.
  return '0x' + word(32) + head + tail;
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
// malformed inputs, reconstructs the lock-set tree in on-chain (block, logIndex) order — corroborating
// each call against the ACTUAL events that tx emitted, not just its calldata ──
{
  const LOCK_A = ['0x' + 'a1'.repeat(32), '0x' + 'a2'.repeat(32)];
  const LOCK_B = ['0x' + 'b1'.repeat(32)];
  const NULL_B = ['0x' + 'nb'.repeat(32)];
  const LEAVES_E = ['0x' + 'e1'.repeat(32), '0x' + 'e2'.repeat(32)];
  const MEMOS_E = ['0x' + 'aa'.repeat(5), '0x' + 'bb'.repeat(5)];
  // tx "early": 2 note leaves (LeavesInserted-corroborated) + LOCK_A (2 lock leaves, 2 more memos).
  const pvEarly = encodePublicValuesPrefix({ leaves: LEAVES_E, lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: LOCK_A });
  const memosEarly = [...MEMOS_E, '0x' + 'cc'.repeat(5) /* lock memo A0 */, '0x' + 'dd'.repeat(5) /* lock memo A1 */];
  const txEarly = encodeSettleCall({ publicValues: pvEarly, proof: '0x1234', memos: memosEarly });

  // tx "late" (higher block): a pure lock settle that ALSO spends a note (NullifiersSpent-corroborated,
  // no ordinary leaves), one lock leaf + its one memo.
  const pvLate = encodePublicValuesPrefix({ leaves: [], lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: LOCK_B, nullifiers: NULL_B });
  const memosLate = ['0x' + 'ee'.repeat(5) /* lock memo B0 */];
  const txLate = encodeSettleCall({ publicValues: pvLate, proof: '0x5678', memos: memosLate });

  // tx "no-lock": an ordinary transfer settle (one note leaf, zero locks) — must be skipped entirely.
  const pvNoLock = encodePublicValuesPrefix({ leaves: ['0x' + 'ff'.repeat(32)], lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: [] });
  const txNoLock = encodeSettleCall({ publicValues: pvNoLock, proof: '0x9999', memos: ['0x' + '77'.repeat(5)] });

  const events = [
    // Deliberately out of chain order (late before early) and a duplicate LeavesInserted-shaped event for
    // "late" (a caller merging streams), plus a garbled tx and a tx the RPC fetcher can't find (→ null).
    { type: 'NullifiersSpent', txHash: '0xlate', blockNumber: 200, logIndex: 0, nullifiers: NULL_B },
    { type: 'NullifiersSpent', txHash: '0xlate', blockNumber: 200, logIndex: 0, nullifiers: NULL_B }, // duplicate — must not double-count
    { type: 'LeavesInserted', txHash: '0xearly', blockNumber: 100, logIndex: 3, leaves: LEAVES_E, memos: MEMOS_E },
    { type: 'LeavesInserted', txHash: '0xnolock', blockNumber: 150, logIndex: 1, leaves: ['0x' + 'ff'.repeat(32)], memos: ['0x' + '77'.repeat(5)] },
    { type: 'LeavesInserted', txHash: '0xgarbage', blockNumber: 160, logIndex: 0, leaves: [], memos: [] },
    { type: 'NullifiersSpent', txHash: '0xmissing', blockNumber: 170, logIndex: 0, nullifiers: [] },
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
  ok('scanLockLeaves: reconstructs the lock-set tree + memo tail across an out-of-order, noisy tx stream, corroborated by real events');
}

// ── 3b. scanLockLeaves: a relaySettle batch's calldata can carry a call that never actually landed —
// TacitRelayer._relay try/catches each inner POOL.settle() and silently skips a failed one. A call with
// no corroborating event for its own effects must be excluded, even though its calldata looks valid ──
{
  const LOCK_LANDED = ['0x' + 'c1'.repeat(32)];
  const NULL_LANDED = ['0x' + 'nc'.repeat(32)];
  const LOCK_PHANTOM = ['0x' + 'd1'.repeat(32)]; // this inner call's calldata claims this lock — it never landed
  const NULL_PHANTOM = ['0x' + 'nd'.repeat(32)];

  const pvLanded = encodePublicValuesPrefix({ leaves: [], lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: LOCK_LANDED, nullifiers: NULL_LANDED });
  const pvPhantom = encodePublicValuesPrefix({ leaves: [], lockSetRoot: '0x' + '00'.repeat(32), lockLeaves: LOCK_PHANTOM, nullifiers: NULL_PHANTOM });
  const callLanded = { publicValues: pvLanded, proof: '0xaaaa', memos: ['0x' + '11'.repeat(5)] };
  const callPhantom = { publicValues: pvPhantom, proof: '0xbbbb', memos: ['0x' + '22'.repeat(5)] };
  const txBatch = encodeRelaySettleCall([callLanded, callPhantom]);

  const events = [
    // ONLY the landed call's NullifiersSpent is present — nothing corroborates the phantom call.
    { type: 'NullifiersSpent', txHash: '0xbatch', blockNumber: 300, logIndex: 0, nullifiers: NULL_LANDED },
  ];
  const getTxInput = async (h) => (h === '0xbatch' ? txBatch : null);

  const result = await scan.scanLockLeaves({ events, getTxInput });
  assert.deepStrictEqual(result.lockLeaves.map((x) => x.toLowerCase()), LOCK_LANDED.map((x) => x.toLowerCase()), 'only the corroborated inner call\'s lock leaf is included; the phantom (uncorroborated) call is excluded despite valid-looking calldata');
  assert.deepStrictEqual(result.lockMemos, ['0x' + '11'.repeat(5)]);
  ok('scanLockLeaves: excludes a relaySettle inner call whose own effects have no corroborating event (silently-skipped/failed call)');
}

// ── 4. Real mainnet fixture: the ACTUAL settle() calldata of the first-ever OP_STEALTH_LOCK on the
// live pool (tx 0x20d46c1d..., 2026-09-05). Hardcoded raw, not built by this file's own encoder — this
// is what caught the original bug: decodePublicValuesLockFields assumed `publicValues` bytes were the
// PublicValues tuple's own head/tail encoding, but the contract does
// `abi.decode(publicValues, (PublicValues))`, which — because PublicValues contains dynamic fields —
// ABI-encodes it as a single-element tuple, prepending an extra offset word (0x20) before the struct's
// own fields. The old code read that word's *target* as if it were the struct's first field, producing
// garbage. This exact transaction produced leavesCount=1696 and a nonsense lockLeaves array before the
// fix; every synthetic fixture in this file (and confidential-stealth-send.mjs's) passed throughout,
// because their own encoder shared the same wrong assumption. Never delete this without also deleting
// the vulnerability: it is the one check here that cannot silently regress back to that bug via a
// self-consistent test+encoder pair.
{
  const REAL_LOCK_TX_INPUT = '0x717fd7f200000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000760000000000000000000000000000000000000000000000000000000000000090000000000000000000000000000000000000000000000000000000000000006e0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000019a0780d8f6c11b97e4df995e8238e6218c776580693f7f556a40897482ac6e5ffab28cd8970154006ea358b59dcd0e72a58fee7568f254a77f2136dbff6a5a7c00000000000000000000000000000000000000000000000000000000000003e0000000000000000000000000000000000000000000000000000000000000042000000000000000000000000000000000000000000000000000000000000004400000000000000000000000000000000000000000000000000000000000000460000000000000000000000000000000000000000000000000000000000000048000000000000000000000000000000000000000000000000000000000000004a000000000000000000000000000000000000000000000000000000000000004c000000000000000000000000000000000000000000000000000000000000004e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000520000000000000000000000000000000000000000000000000000000006b13411d00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000540000000000000000000000000000000000000000000000000000000000000058000000000000000000000000000000000000000000000000000000000000005a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005c000000000000000000000000000000000000000000000000000000000000005e00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000062000000000000000000000000000000000000000000000000000000000000006400b029ca377f0a281874041e1ab8ed2df48d30aceacef2960d6895dcbc465dedc0000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000068000000000000000000000000000000000000000000000000000000000000006a00000000000000000000000000000000000000000000000000000000000000001105e147384b3ed49228e666c415055b66754fce3cc6c8a0b4ae23b7783bcdf020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001b817febcad202fcc65d97b580a0136d1d67c0c541c2074f7cfee60ae57c57e13000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001644388a21c0000000000000000000000000000000000000000000000000000000000000000002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f2535200000000000000000000000000000000000000000000000000000000000000002ab7d6a0dc4359b122a3f6a512556521f7ae324f18205f4b3d0a623e6199e35f17e5ae1a059844ce901609004a0c20e45e9fdfae638bb6884143bed6df5f6d69139482c8a2c43ecf821f6acbfd18f39a09e81b88c95a04b84662c21b2da8e64d1e29ee18496895e2ab3272a6fb673216372d83ab9d991bf91c5cc6dc07e38dab01619aee927a43beb7ea6552e34c450892fa3cbbf632a1374f590581e5a58b030a707435270420e3587777b9f31afa33491b7403dfcc7365e40f6804705a3125222743b4a7fb561a818c76dff7346409ff7c89a244b44ccc629aa687ad411ef22fa137a04060e480c014925438100cbc326d30d88fbd69cd62403a80118b91b20000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000009103274d9c345b14fdeb0ef5120a7eeea3bb61d7c36fb0a2e4ea72b1971a4cc8d25612a86a04169708e1ac1555d58d5769776f79cad1469656dfb0a59a30bfc701aa997785b3dffb456ee2d698d1321e82dd1a28513877e9a4610ce7141f23a36fec32464e3eca88dc71bdf8ef3fb0df490a109e92b7338fe5dfaa149a0e3a601e8f69975bead8222b16fd8e0afddbcafc9d000000000000000000000000000000';
  const decoded = scan.decodeSettleCalldata(REAL_LOCK_TX_INPUT);
  const fields = scan.decodePublicValuesLockFields(decoded.publicValues);
  assert.strictEqual(fields.leavesCount, 0, 'real tx: a pure lock mints no note leaf');
  assert.strictEqual(fields.lockSetRoot, '0x' + '00'.repeat(32), 'real tx: a lock APPENDS to the lock-set, no membership read');
  assert.deepStrictEqual(fields.lockLeaves.map((x) => x.toLowerCase()), ['0xb817febcad202fcc65d97b580a0136d1d67c0c541c2074f7cfee60ae57c57e13'], 'real tx: lockLeaves matches the lock this settle actually appended on mainnet');
  ok('decodePublicValuesLockFields: correctly decodes the REAL first-ever OP_STEALTH_LOCK settle on mainnet (regression fixture, not self-encoded)');
}

// ── 5. A settle nested behind TWO selectors (an entry call carrying an account's execute(pool, 0, settle(...)))
// starts 4 bytes past a word boundary; it is decoded and, once corroborated, counted ──
{
  const zero = '0x' + '00'.repeat(32);
  const LOCK_N = ['0x' + '4e'.repeat(32)];
  const NULL_N = ['0x' + '5e'.repeat(32)];
  const pvN = encodePublicValuesPrefix({ leaves: [], lockSetRoot: zero, lockLeaves: LOCK_N, nullifiers: NULL_N });
  const settle = encodeSettleCall({ publicValues: pvN, proof: '0xabcd', memos: ['0x' + '31'.repeat(5)] });
  const execute = '0x' + selector('execute(address,uint256,bytes)') + word('0x' + '22'.repeat(20)) + word(0) + word(96) + encBytes(settle);
  const outer = '0x' + selector('handleOp(bytes)') + word(32) + encBytes(execute);
  const at = outer.slice(2).indexOf(selector('settle(bytes,bytes,bytes[])'), 8) / 2;
  assert.strictEqual((at - 4) % 32, 4, 'the fixture puts the settle 4 bytes past a word boundary');
  const calls = scan.decodeNestedSettles(outer);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(scan.decodePublicValuesLockFields(calls[0].publicValues).lockLeaves, LOCK_N);
  const events = [{ type: 'NullifiersSpent', txHash: '0xaa', blockNumber: 1, logIndex: 0, nullifiers: NULL_N }];
  const res = await scan.scanLockLeaves({ events, getTxInput: async () => outer });
  assert.deepStrictEqual(res.lockLeaves, LOCK_N);
  assert.deepStrictEqual(res.lockMemos, ['0x' + '31'.repeat(5)]);
  ok('decodeNestedSettles: a settle at any byte offset is a candidate (here 4 mod 32, behind two selectors)');
}

// ── 6. scanLockLeaves against the pool's own lockNextLeafIndex/lockRoot: a decoy ahead of a wrapper's real call
// wins corroboration, and the chain's root sets it aside ──
{
  const POOL = '0x0000000098A73197B3255aD9db1ed8544410f5Ba';
  const RELAYER = '0x00000000705D345449950e900271F27E7fEEABc5';
  const WRAPPER = '0x' + '77'.repeat(20);
  const zero = '0x' + '00'.repeat(32);
  const LOCK_D = ['0x' + 'd7'.repeat(32)], NULL_D = ['0x' + 'd8'.repeat(32)];
  const LOCK_R = ['0x' + 'e7'.repeat(32)], NULL_R = ['0x' + 'e8'.repeat(32)];
  const FAKE = ['0x' + 'fa'.repeat(32)];
  const RL = ['0x' + 'f1'.repeat(32)], RM = ['0x' + '61'.repeat(5)];
  const direct = encodeSettleCall({ publicValues: encodePublicValuesPrefix({ leaves: [], lockSetRoot: zero, lockLeaves: LOCK_D, nullifiers: NULL_D }), proof: '0x01', memos: ['0x' + '62'.repeat(5)] });
  const relayed = encodeRelaySettleCall([{ publicValues: encodePublicValuesPrefix({ leaves: [], lockSetRoot: zero, lockLeaves: LOCK_R, nullifiers: NULL_R }), proof: '0x02', memos: ['0x' + '63'.repeat(5)] }]);
  // The contract forwards `real` (no locks); `decoy` rides ahead of it with the same leaves, memos and nullifiers.
  const real = { publicValues: encodePublicValuesPrefix({ leaves: RL, lockSetRoot: zero, lockLeaves: [] }), proof: '0x03', memos: RM };
  const decoy = { publicValues: encodePublicValuesPrefix({ leaves: RL, lockSetRoot: zero, lockLeaves: FAKE }), proof: '0x03', memos: [...RM, '0x' + '64'.repeat(5)] };
  const wrapped = '0x' + selector('multicall(bytes[])') + word(32) + encBytesArray([encodeSettleCall(decoy), encodeSettleCall(real)]);
  const txs = { '0xdirect': { input: direct, to: POOL }, '0xrelay': { input: relayed, to: RELAYER.toLowerCase() }, '0xwrap': { input: wrapped, to: WRAPPER } };
  const events = [
    { type: 'NullifiersSpent', txHash: '0xdirect', blockNumber: 10, logIndex: 0, nullifiers: NULL_D },
    { type: 'NullifiersSpent', txHash: '0xrelay', blockNumber: 20, logIndex: 0, nullifiers: NULL_R },
    { type: 'LeavesInserted', txHash: '0xwrap', blockNumber: 30, logIndex: 0, leaves: RL, memos: RM },
  ];
  const getTx = async (h) => txs[h];
  const getTxInput = async (h) => txs[h].input;
  const rootOf = (leaves) => { const t = new pool.Tree(); for (const l of leaves) t.insert(l); return t.root(); };
  const onChain = [...LOCK_D, ...LOCK_R];
  const getLockState = async () => ({ count: '0x' + word(onChain.length), root: rootOf(onChain) });

  let res = await scan.scanLockLeaves({ events, getTxInput });
  assert.deepStrictEqual(res.lockLeaves, [...onChain, ...FAKE], 'calldata and events alone take the decoy');
  assert.strictEqual(res.verified, null, 'no chain state: unverified');
  assert.deepStrictEqual(res.excluded, []);

  res = await scan.scanLockLeaves({ events: events.slice(0, 2), getTx, getLockState });
  assert.strictEqual(res.verified, true);
  assert.deepStrictEqual(res.excluded, []);
  assert.strictEqual(res.lockSetRoot, rootOf(onChain));

  for (const src of [{ getTx }, { getTxInput }]) {
    res = await scan.scanLockLeaves({ events, getLockState, ...src });
    assert.strictEqual(res.verified, true);
    assert.deepStrictEqual(res.lockLeaves, onChain);
    assert.deepStrictEqual(res.lockMemos, ['0x' + '62'.repeat(5), '0x' + '63'.repeat(5)]);
    assert.strictEqual(res.lockSetRoot, rootOf(onChain));
    assert.strictEqual(res.tree.root(), rootOf(onChain));
    assert.deepStrictEqual(res.excluded, [{ txHash: '0xwrap', lockLeaves: FAKE }]);
  }

  // A contract exposing settle(bytes,bytes,bytes[]) itself: its selector looks direct; only where the tx went tells.
  const shim = { ...txs, '0xwrap': { input: encodeSettleCall(decoy), to: WRAPPER } };
  res = await scan.scanLockLeaves({ events, getTxInput: async (h) => shim[h].input, getLockState });
  assert.strictEqual(res.verified, false, 'by selector alone nothing is untrusted, so nothing can be set aside');
  assert.deepStrictEqual(res.lockLeaves, [...onChain, ...FAKE], 'an unverified scan returns the full rebuilt set');
  res = await scan.scanLockLeaves({ events, getTx: async (h) => shim[h], getLockState });
  assert.strictEqual(res.verified, true);
  assert.deepStrictEqual(res.lockLeaves, onChain);
  assert.deepStrictEqual(res.excluded, [{ txHash: '0xwrap', lockLeaves: FAKE }]);
  res = await scan.scanLockLeaves({ events, getTx: async (h) => shim[h], getLockState, poolAddress: WRAPPER });
  assert.strictEqual(res.verified, false, 'the pool address is a parameter');

  res = await scan.scanLockLeaves({ events, getTx, getLockState: async () => { throw new Error('rpc down'); } });
  assert.strictEqual(res.verified, null, 'an unreadable lock state leaves the scan unverified');
  assert.deepStrictEqual(res.lockLeaves, [...onChain, ...FAKE]);
  ok('scanLockLeaves: checked against the pool\'s lock count and root, untrusted (nested or wrapper-sent) calls set aside only when that reproduces them');
}

console.log(`\n${n}/${n} confidential-lock-scan checks passed`);
