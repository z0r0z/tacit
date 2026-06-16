#!/usr/bin/env node
// Wiring proof: the recovery-guard composes with the REAL confidential-transfer assembler so a
// shielded transfer's outputs are seed-only recoverable by construction — the sender re-opens its
// CHANGE note and the recipient re-opens its RECEIVED note, each from its own key, via the same
// on-chain memo channel buildWrap uses. This is the template every op caller (transfer/OTC/BID
// seller leg) follows: build the proof, seal a memo per output via guard.sealMemosForOutputs, gate
// guard.assertOutputsRecoverable, then submit leaves+memos.
//
// Run: node tests/confidential-op-recovery.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';
import { makeRecoveryGuard } from '../dapp/confidential-recovery-guard.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const deps = { secp, keccak256, sha256 };
const pool = makeConfidentialPool(deps);
const xfer = makeConfidentialTransfer({ keccak256 });
const idx = makeConfidentialIndexer(deps);
const guard = makeRecoveryGuard({ memo: idx._memo });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const ASSET = '0x' + 'aa'.repeat(32);
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const id = (priv) => { const pub = secp.getPublicKey(priv, true); return { priv, pubHex: hx(pub), owner: hx(pub.subarray(1, 33)) }; };

const sender = id(randomScalar());
const recipient = id(randomScalar());

// A real conserved transfer: 100 in → 40 change (sender) + 60 received (recipient).
const rIn = randomScalar(), rChange = randomScalar(), rRecv = randomScalar();
const built = xfer.buildTransfer({
  inputs: [{ value: 100n, blinding: rIn }],
  outputs: [{ value: 40n, blinding: rChange }, { value: 60n, blinding: rRecv }],
});
assert.ok(xfer.verifyTransfer(built), 'the transfer proof verifies (range + conservation)');
ok('real confidential-transfer build verifies (40 change + 60 received conserve 100)');

// Each output as a guard descriptor: the settler knows the opening + the owner pubkey of BOTH
// outputs (the sender chose the recipient's blinding), so it seals a memo to each owner.
const changeC = pool.commitXY(40n, '0x' + rChange.toString(16).padStart(64, '0'));
const recvC = pool.commitXY(60n, '0x' + rRecv.toString(16).padStart(64, '0'));
const outputs = [
  { ownerPub: sender.pubHex,    value: 40n, blinding: '0x' + rChange.toString(16).padStart(64, '0'), asset: ASSET, owner: sender.owner },
  { ownerPub: recipient.pubHex, value: 60n, blinding: '0x' + rRecv.toString(16).padStart(64, '0'),   asset: ASSET, owner: recipient.owner },
];
const leaves = [
  pool.leaf(ASSET, changeC.cx, changeC.cy, sender.owner),
  pool.leaf(ASSET, recvC.cx, recvC.cy, recipient.owner),
];
const memos = guard.sealMemosForOutputs({ outputs, ephRand: () => randomScalar() });
guard.assertOutputsRecoverable({ leaves, outputs, memos }); // tripwire passes — both outputs memo-sealed
ok('guard seals a memo per transfer output and the recoverability tripwire passes');

const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves, memos }];

// Sender recovers ONLY its change note from its key alone.
const senderRec = idx.recover(events, sender.priv);
assert.strictEqual(senderRec.length, 1, 'sender recovers exactly its change note');
assert.strictEqual(senderRec[0].value, 40n, 'change value 40');
// Recipient recovers ONLY its received note from its key alone.
const recipRec = idx.recover(events, recipient.priv);
assert.strictEqual(recipRec.length, 1, 'recipient recovers exactly its received note');
assert.strictEqual(recipRec[0].value, 60n, 'received value 60');
ok('sender recovers its change, recipient recovers its received note — each from its seed alone');

// The recovered notes are spendable: the recovered blinding reopens the on-chain commitment.
for (const [r, owner] of [[senderRec[0], sender], [recipRec[0], recipient]]) {
  const c = pool.commitXY(r.value, r.blinding);
  assert.strictEqual(pool.leaf(r.asset, c.cx, c.cy, owner.owner).toLowerCase(), String(r.leaf).toLowerCase(), 'recovered opening recommits to the on-chain leaf');
}
ok('recovered transfer notes are spendable (blindings reopen the on-chain commitments)');

console.log(`\n${n} confidential-op recovery checks passed.`);
