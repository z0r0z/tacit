import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialInvoice } from '../dapp/confidential-invoice.js';

// secp.sign (RFC 6979) needs the sync HMAC set (the dapp bundle does this at boot).
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };

const BOB = '0x' + 'b0'.repeat(32); // recipient (holds the seed → the spend key)
const ALICE = '0x' + 'a1'.repeat(32); // payer (only ever sees the public invoice)
const AMOUNT = '1000000000000000'; // 0.001 ETH; cETH unitScale 1 ⇒ value == amount

function setup() {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const inv = makeConfidentialInvoice({ ux });
  return { ux, inv, pool: ux.pool };
}

function unwrapCtx(pool, ux, note, recipient, fee = 0n, deadline = 0n) {
  const recip32 = '0x' + '0'.repeat(24) + recipient.replace(/^0x/, '');
  return pool.intentContext('tacit-unwrap-intent-v1', ux.chainBindingHex(), note.asset, recip32,
    [[note.cx, note.cy, note.owner]], [BigInt(note.value), fee, deadline]);
}

test('createInvoice: well-formed, verifies, and re-derives the canonical buildWrap note', () => {
  const { ux, inv, pool } = setup();
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, ticker: 'cETH', amountWei: AMOUNT, index: 0 });
  assert.equal(invoice.v, 1);
  assert.equal(invoice.amount, AMOUNT);
  assert.equal(invoice.value, AMOUNT); // unitScale 1
  // the public ids all bind the same (cx,cy,owner,value)
  assert.equal(invoice.commit, pool.depositCommit(invoice.cx, invoice.cy, invoice.owner));
  assert.equal(invoice.leaf, pool.leaf(invoice.assetId, invoice.cx, invoice.cy, invoice.owner));
  assert.equal(invoice.depositId, pool.depositId(invoice.assetId, BigInt(invoice.value), invoice.cx, invoice.cy, invoice.owner));
  // owner == recipient's note owner (pubkey x); commitment re-derives from value + (the recipient's) blinding
  const id = ux.identity(BOB);
  assert.equal(invoice.owner, id.owner);
  assert.ok(inv.verifyInvoice(invoice), 'payer-side verification passes');
});

test('SECURITY: the invoice carries no spend key (no raw blinding / secret)', () => {
  const { inv } = setup();
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, ticker: 'cETH', amountWei: AMOUNT });
  assert.equal(invoice.blinding, undefined, 'no raw blinding in the invoice');
  assert.equal(invoice.secret, undefined, 'no secret in the invoice');
  assert.equal(invoice.witness.blinding, undefined, 'no blinding in the pre-signed witness');
  assert.equal(invoice.witness.secret, undefined, 'no secret in the pre-signed witness');
});

test('SECURITY: the pre-signed sigma authorizes the CONSUME but not a SPEND', () => {
  const { ux, inv, pool } = setup();
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, ticker: 'cETH', amountWei: AMOUNT });
  const value = BigInt(invoice.value);
  // consume context (what the OP_WRAP guest checks) — verifies, so the payer knows the note is claimable
  const consumeCtx = pool.intentContext('tacit-wrap-intent-v1', invoice.chainBinding, invoice.assetId,
    invoice.depositId, [[invoice.cx, invoice.cy, invoice.owner]], [value]);
  assert.ok(pool.verifyOpeningSigma(invoice.cx, invoice.cy, value, invoice.witness.sigR, invoice.witness.sigZ, consumeCtx),
    'pre-signed consume sigma verifies');
  // a SPEND (unwrap to anyone) is a different context → the same sigma must NOT authorize it
  const spendCtx = unwrapCtx(pool, ux, { asset: invoice.assetId, cx: invoice.cx, cy: invoice.cy, owner: invoice.owner, value }, '0x' + 'ee'.repeat(20));
  assert.ok(!pool.verifyOpeningSigma(invoice.cx, invoice.cy, value, invoice.witness.sigR, invoice.witness.sigZ, spendCtx),
    'the pre-signed consume cannot be replayed as a withdrawal');
});

test('RECIPIENT can spend; PAYER cannot (only the seed-holder re-derives the blinding)', () => {
  const { ux, inv, pool } = setup();
  const { invoice, claim } = inv.createInvoice({ recipientPriv: BOB, ticker: 'cETH', amountWei: AMOUNT, index: 0 });
  const z = '0x' + '00'.repeat(32);
  // Bob re-derives the spendable note from his seed alone (membership attached from the tree; dummy here)
  const note = inv.recoverNote({ recipientPriv: BOB, invoice, index: claim.index, root: z, leafIndex: 0, path: [z] });
  assert.equal(note.cx, invoice.cx, 're-derived commitment matches the invoice');
  assert.notEqual(note.blinding, undefined);
  // Bob authors a withdrawal — its opening sigma verifies under the spend context (he CAN spend)
  const built = ux.buildUnwrap({ note, walletPriv: BOB, selfSettle: true });
  const ctx = unwrapCtx(pool, ux, note, built.op.recipient, 0n, BigInt(built.op.deadline));
  assert.ok(pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), built.op.sigR, built.op.sigZ, ctx),
    'recipient authors a valid spend');
  // Alice (payer) only has the invoice — no blinding — so she has no input to author a spend at all
  assert.throws(() => inv.recoverNote({ recipientPriv: ALICE, invoice, index: claim.index, root: z, leafIndex: 0, path: [z] }),
    /wrong seed\/index/, 'a non-recipient cannot re-derive the note');
});

test('payArgs + settleInputs: consistent router inputs for pay + one-tx finalize', () => {
  const { inv } = setup();
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, ticker: 'cETH', amountWei: AMOUNT });
  const pa = inv.payArgs(invoice);
  assert.equal(pa.amount, AMOUNT);
  assert.equal(pa.commit, invoice.commit);
  assert.equal(pa.assetId, invoice.assetId);
  assert.equal(pa.native, true, 'cETH underlying is native ETH → direct payable wrap (no permit)');
  const si = inv.settleInputs(invoice);
  assert.deepEqual(si.depositsConsumed, [invoice.depositId]);
  assert.deepEqual(si.leaves, [invoice.leaf]);
  assert.deepEqual(si.memos, [invoice.memo]);
  assert.equal(si.witness, invoice.witness);
});

test('isPaid: detects the deposit landing in a Wrap event', () => {
  const { inv } = setup();
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, ticker: 'cETH', amountWei: AMOUNT });
  assert.equal(inv.isPaid(invoice, []), false);
  assert.equal(inv.isPaid(invoice, [{ depositId: '0xdead', assetId: invoice.assetId, amount: AMOUNT }]), false);
  assert.equal(inv.isPaid(invoice, [{ depositId: invoice.depositId, assetId: invoice.assetId, amount: AMOUNT }]), true);
});

test('discovery: the recipient finds the settled note by normal scan; the payer does not', () => {
  const { ux, inv } = setup();
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, ticker: 'cETH', amountWei: AMOUNT });
  // the LeavesInserted the pool emits when the deposit settles (memo sealed to Bob, leaf = Bob's note)
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [invoice.leaf], memos: [invoice.memo] }];
  const bobNotes = ux.indexer.recover(events, BOB);
  assert.equal(bobNotes.length, 1, 'recipient discovers the payment via the recipient-agnostic memo scan');
  assert.equal(BigInt(bobNotes[0].value), BigInt(AMOUNT));
  assert.equal(bobNotes[0].cx.toLowerCase(), invoice.cx.toLowerCase());
  const aliceNotes = ux.indexer.recover(events, ALICE);
  assert.equal(aliceNotes.length, 0, 'the payer cannot open the memo (sealed to the recipient)');
});

test('payer protection: verifyInvoice rejects a tampered/unclaimable invoice', () => {
  const { inv } = setup();
  const base = inv.createInvoice({ recipientPriv: BOB, ticker: 'cETH', amountWei: AMOUNT }).invoice;
  assert.ok(inv.verifyInvoice(base));
  // mutate the value (would mislead the payer on amount, and breaks the depositId/sigma binds)
  assert.equal(inv.verifyInvoice({ ...base, value: (BigInt(base.value) + 1n).toString() }), false);
  // swap in a commit for a different note (sigma no longer opens it) — would lock the payer's funds
  assert.equal(inv.verifyInvoice({ ...base, commit: '0x' + 'cc'.repeat(32) }), false);
  // strip the pre-signed witness
  assert.equal(inv.verifyInvoice({ ...base, witness: undefined }), false);
  // a forged sigma can't open the commitment to `value`
  assert.equal(inv.verifyInvoice({ ...base, witness: { ...base.witness, sigZ: '0x' + '11'.repeat(32) } }), false);
});
