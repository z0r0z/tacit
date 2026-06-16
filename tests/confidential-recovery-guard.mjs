#!/usr/bin/env node
// Seed-only recovery guardrail — proves the shared seal helper + submit-time tripwire that every
// leaf-creating op must use, and that it CLOSES the OP_BID seller-leg gap (the seller seals memos
// for its own outputs; the buyer's seed-derived outputs are flagged, not memo'd).
//
// Run: node tests/confidential-recovery-guard.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar, G } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';
import { makeRecoveryGuard } from '../dapp/confidential-recovery-guard.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const deps = { secp, keccak256, sha256 };
const pool = makeConfidentialPool(deps);
const idx = makeConfidentialIndexer(deps);
const guard = makeRecoveryGuard({ memo: idx._memo });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET = '0x' + 'aa'.repeat(32);
const hx = (b) => '0x' + Buffer.from(b).toString('hex');

// A wallet identity: scan key + the 33B owner pubkey (memo target) + the 32B leaf owner field.
function identity(priv) {
  const pub = secp.getPublicKey(priv, true);
  return { priv, pubHex: hx(pub), owner: hx(pub.subarray(1, 33)) };
}

// Build a note owned by `id` for `value` with blinding `r`.
function note(id, value, r) {
  const rHex = '0x' + BigInt(r).toString(16).padStart(64, '0');
  const { cx, cy } = pool.commitXY(value, rHex);
  return { value, blinding: rHex, secret: 0, asset: ASSET, owner: id.owner, ownerPub: id.pubHex, cx, cy,
           leaf: pool.leaf(ASSET, cx, cy, id.owner) };
}

const eph = () => randomScalar();

// ── 1. sealMemosForOutputs + idx.recover round-trips a memo-sealed output ──
const alice = identity(randomScalar());
const a1 = note(alice, 7n, randomScalar());
const memos1 = guard.sealMemosForOutputs({ outputs: [a1], ephRand: eph });
guard.assertOutputsRecoverable({ leaves: [a1.leaf], outputs: [a1], memos: memos1 });
const ev1 = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [a1.leaf], memos: memos1 }];
const rec1 = idx.recover(ev1, alice.priv);
assert.strictEqual(rec1.length, 1, 'alice recovers her memo-sealed note');
assert.strictEqual(rec1[0].value, 7n, 'recovered value');
assert.strictEqual(rec1[0].blinding.toLowerCase(), a1.blinding.toLowerCase(), 'recovered blinding opens the commitment');
ok('sealMemosForOutputs → idx.recover round-trips a memo-sealed output from the seed alone');

// ── 2. a seed-derived output is flagged (empty memo) and the tripwire accepts it ──
const memos2 = guard.sealMemosForOutputs({ outputs: [{ seedDerived: true }], ephRand: eph });
assert.strictEqual(memos2[0], '0x', 'seed-derived output → empty memo placeholder');
guard.assertOutputsRecoverable({ leaves: ['0x' + '11'.repeat(32)], outputs: [{ seedDerived: true }], memos: memos2 });
ok('a seed-derived output gets an empty memo and the tripwire accepts it (owner re-derives on rescan)');

// ── 3. the tripwire THROWS on a leaf that is neither seed-derived nor memo-covered ──
assert.throws(
  () => guard.assertOutputsRecoverable({ leaves: [a1.leaf], outputs: [{}], memos: ['0x'] }),
  /no recovery channel/,
  'an output with neither a memo nor a seedDerived flag is rejected'
);
assert.throws(
  () => guard.sealMemosForOutputs({ outputs: [{ value: 1n, asset: ASSET, owner: alice.owner }], ephRand: eph }),
  /unrecoverable/,
  'sealing an output with no ownerPub and not seedDerived is rejected'
);
ok('the tripwire rejects an output with no recovery channel (forgotten seal can\'t reach the chain)');

// ── 4. OP_BID seller-leg gap CLOSED: the seller seals memos for its own pay+change; the buyer\n//       outputs are seedDerived. The seller recovers its pay note from the seed alone ──
const seller = identity(randomScalar());
const buyer = identity(randomScalar());
const sellerPay = note(seller, 200n, randomScalar());   // seller receives asset_b (pay)
const sellerChange = note(seller, 5n, randomScalar());  // seller change
// buyer outputs (received-A + refund-B): the seller cannot open these → seed-derived, no memo.
const buyerRecvLeaf = pool.leaf(ASSET, '0x' + 'cc'.repeat(32), '0x' + 'dd'.repeat(32), buyer.owner);
const buyerRefundLeaf = pool.leaf(ASSET, '0x' + 'ce'.repeat(32), '0x' + 'df'.repeat(32), buyer.owner);

const batchOutputs = [
  { seedDerived: true },                 // buyer received-A
  { seedDerived: true },                 // buyer refund-B
  sellerPay,                             // seller pay (memo-sealed to seller)
  sellerChange,                          // seller change (memo-sealed to seller)
];
const batchLeaves = [buyerRecvLeaf, buyerRefundLeaf, sellerPay.leaf, sellerChange.leaf];
const batchMemos = guard.sealMemosForOutputs({ outputs: batchOutputs, ephRand: eph });
guard.assertOutputsRecoverable({ leaves: batchLeaves, outputs: batchOutputs, memos: batchMemos });
assert.strictEqual(batchMemos[0], '0x', 'buyer outputs carry empty memos');
assert.strictEqual(batchMemos[1], '0x', 'buyer outputs carry empty memos');

const ev4 = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: batchLeaves, memos: batchMemos }];
const sellerRec = idx.recover(ev4, seller.priv);
assert.strictEqual(sellerRec.length, 2, 'seller recovers its pay + change notes from the seed alone');
assert.ok(sellerRec.some((r) => r.value === 200n) && sellerRec.some((r) => r.value === 5n), 'seller pay (200) + change (5)');
const buyerViaMemo = idx.recover(ev4, buyer.priv);
assert.strictEqual(buyerViaMemo.length, 0, 'buyer outputs are not memo-recoverable (seed-derived, by design)');
ok('OP_BID seller-leg recoverable via memo; buyer-leg correctly seed-derived — both channels covered');

console.log(`\n${n} recovery-guard checks passed.`);
