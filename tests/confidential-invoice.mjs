import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { makeConfidentialInvoice } from '../dapp/confidential-invoice.js';
import { stdinFor } from '../dapp/sp1-stdin.js';

// secp.sign (RFC 6979) needs the sync HMAC set (the dapp bundle does this at boot).
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };

const BOB = '0x' + 'b0'.repeat(32); // recipient (holds the seed → the spend key)
const ALICE = '0x' + 'a1'.repeat(32); // payer (only ever sees the public invoice)
const AMOUNT = '1000000000000000'; // 0.001 ETH (wei) — the payer's public wrap amount
// cETH's unitScale is 1e10 (18-dec ETH → 8-dec in-system units) on the live pool, so compute the
// expected in-system value from the deployment config rather than assuming AMOUNT == value.
function cEthUnitScale(ux) { return BigInt(ux.assetByTicker.cETH.unitScale); }

function setup(options = {}) {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {}, ...options });
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
  assert.equal(BigInt(invoice.value), BigInt(AMOUNT) / cEthUnitScale(ux), 'in-system value = amountWei / unitScale');
  // the public ids all bind the same (cx,cy,owner,value)
  assert.equal(invoice.commit, pool.depositCommit(invoice.cx, invoice.cy, invoice.owner));
  assert.equal(invoice.leaf, pool.leaf(invoice.assetId, invoice.cx, invoice.cy, invoice.owner));
  assert.equal(invoice.depositId, pool.depositId(invoice.assetId, BigInt(invoice.value), invoice.cx, invoice.cy, invoice.owner));
  // owner is the PER-NOTE derived owner buildWrap mints (pool.deriveNote(priv, assetId, index) → H(nk)) —
  // NOT the wallet-constant id.owner: buildWrap uses per-note derivation precisely so a wallet's
  // notes are unlinkable, so invoice.owner must differ from id.owner.
  const id = ux.identity(BOB);
  const meta = ux.assetByTicker.cETH;
  const { secret: perNoteSecret } = pool.deriveNote(id.priv, meta.assetId, 0);
  assert.equal(invoice.owner, pool.nkToOwner(perNoteSecret), 'invoice owner matches buildWrap\'s per-note H(nk)');
  assert.notEqual(invoice.owner, id.owner, 'per-note owner is NOT the wallet-constant owner (unlinkable)');
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
  assert.equal(BigInt(bobNotes[0].value), BigInt(AMOUNT) / cEthUnitScale(ux));
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

function paymentRpc() {
  const calls = [];
  return { calls, fetchImpl: async (_url, options) => {
    const q = JSON.parse(options.body);
    calls.push(q);
    const result = q.method === 'eth_getTransactionCount' ? '0x0'
      : q.method === 'eth_sendRawTransaction' ? '0x' + 'aa'.repeat(32)
      : '0x3b9aca00';
    return { ok: true, json: async () => ({ result }) };
  } };
}

test('payer protection: a changed public amount cannot fund a different deposit than the proved note', async () => {
  const rpc = paymentRpc(), { ux, inv, pool } = setup(rpc);
  const base = inv.createInvoice({ recipientPriv: BOB, amountWei: AMOUNT }).invoice;
  const invoice = { ...base, amount: (BigInt(base.amount) * 2n).toString() };
  const paidValue = BigInt(invoice.amount) / cEthUnitScale(ux);
  const actualDeposit = pool.depositId(invoice.assetId, paidValue, invoice.cx, invoice.cy, invoice.owner);
  assert.notEqual(actualDeposit, invoice.depositId, 'the trigger would register an unconsumable deposit');
  assert.equal(inv.verifyInvoice(invoice), false);
  assert.throws(() => inv.payArgs(invoice), /invoice failed verification/);
  assert.throws(() => inv.settleInputs(invoice), /invoice failed verification/);
  // Direct callers must not bypass the UI's verifier; this must fail even before RPC or signing.
  await assert.rejects(ux.payInvoice({ payerPriv: ALICE, invoice }), /invoice failed verification/);
  assert.deepEqual(rpc.calls, []);
});

test('payer protection: asset, chain, amount and witness substitutions reject before payment side effects', async () => {
  const rpc = paymentRpc(), { ux, inv } = setup(rpc);
  const base = inv.createInvoice({ recipientPriv: BOB, amountWei: AMOUNT }).invoice;
  const b32 = '0x' + 'ef'.repeat(32);
  const bad = [
    { amount: (BigInt(base.amount) + 1n).toString() }, // not unit-aligned
    { amount: '0' }, { amount: '-1' }, { amount: true }, { amount: {} }, { amount: 2 ** 60 },
    { underlying: '0x' + '12'.repeat(20) }, { assetId: b32 }, { chainBinding: b32 },
    { ticker: 'unregistered' }, { ticker: 'constructor' },
    ...['chainBinding', 'asset', 'cx', 'cy', 'owner'].map((k) => ({ witness: { ...base.witness, [k]: b32 } })),
    { witness: { ...base.witness, value: (BigInt(base.value) + 1n).toString() } },
  ];
  for (const change of bad) {
    const invoice = { ...base, ...change };
    assert.equal(inv.verifyInvoice(invoice), false, JSON.stringify(change));
    await assert.rejects(ux.payInvoice({ payerPriv: ALICE, invoice, broadcast: false }), /invoice failed verification/, JSON.stringify(change));
  }
  assert.deepEqual(rpc.calls, [], 'invalid invoices never reach nonce, fee, permit or broadcast work');
});

// Build mathematically valid requests outside the allowed payment domain, rather than only breaking a
// signature: the verifier must enforce the active deployment and the contract's positive u64 value.
function signedRequest(ux, base, { value = BigInt(base.value), chainBinding = base.chainBinding } = {}) {
  const pool = ux.pool, blinding = '0x' + '01'.repeat(32);
  const { cx, cy } = pool.commitXY(value, blinding);
  const commit = pool.depositCommit(cx, cy, base.owner);
  const leaf = pool.leaf(base.assetId, cx, cy, base.owner);
  const depositId = pool.depositId(base.assetId, value, cx, cy, base.owner);
  const ctx = pool.intentContext('tacit-wrap-intent-v1', chainBinding, base.assetId, depositId, [[cx, cy, base.owner]], [value]);
  const sig = pool.openingSigma(value, blinding, ctx, pool.deriveOpeningNonce(blinding, ctx, 'wrap'));
  assert.ok(pool.verifyOpeningSigma(cx, cy, value, sig.R, sig.z, ctx), 'counterexample has a valid sigma');
  return { ...base, amount: (value * cEthUnitScale(ux)).toString(), value: value.toString(),
    chainBinding, cx, cy, commit, leaf, depositId,
    witness: { ...base.witness, chainBinding, value: value.toString(), cx, cy, sigR: sig.R, sigZ: sig.z } };
}

test('payer protection: valid signatures cannot authorize another pool/chain or nonpositive/out-of-u64 values', async () => {
  const rpc = paymentRpc(), { ux, inv } = setup(rpc);
  const base = inv.createInvoice({ recipientPriv: BOB, amountWei: AMOUNT }).invoice;
  assert.ok(inv.verifyInvoice(signedRequest(ux, base, { value: (1n << 64n) - 1n })), 'the positive u64 upper bound remains valid');
  const invalid = [
    signedRequest(ux, base, { value: 0n }),
    signedRequest(ux, base, { value: 1n << 64n }),
    signedRequest(ux, base, { chainBinding: '0x' + 'ef'.repeat(32) }),
  ];
  for (const invoice of invalid) {
    assert.equal(inv.verifyInvoice(invoice), false);
    await assert.rejects(ux.payInvoice({ payerPriv: ALICE, invoice }), /invoice failed verification/);
  }
  assert.deepEqual(rpc.calls, []);
});

test('valid controls: configured native/ERC20 invoices and equivalent exact integer/hex representations still verify', () => {
  for (const network of ['signet', 'mainnet']) {
    const { ux, inv } = setup({ network });
    for (const [ticker, meta] of Object.entries(ux.assetByTicker)) {
      if (!/^0x[0-9a-f]{40}$/i.test(meta.underlying || '')) continue;
      const amount = (BigInt(meta.unitScale) * 12345n).toString();
      const { invoice } = inv.createInvoice({ recipientPriv: BOB, ticker, amountWei: amount });
      assert.ok(inv.verifyInvoice(JSON.parse(JSON.stringify(invoice))), `${network}/${ticker}: existing JSON format`);
      const equivalent = { ...invoice, amount: '0x' + BigInt(amount).toString(16), value: Number(invoice.value),
        assetId: '0x' + invoice.assetId.slice(2).toUpperCase(),
        underlying: '0x' + invoice.underlying.slice(2).toUpperCase(),
        witness: { ...invoice.witness, value: '+' + invoice.value.padStart(invoice.value.length + 2, '0') } };
      assert.ok(inv.verifyInvoice(equivalent), `${network}/${ticker}: exact equivalent values`);
    }
  }
});

// Decode the bincode entry boundaries the guest's io::read consumes. Its r33/r32 helpers require an
// exact vector length even where the browser's curve parser accepts the same point/scalar in other forms.
function stdinEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Number(view.getBigUint64(0, true)), entries = [];
  let offset = 8;
  for (let i = 0; i < count; i++) {
    const length = Number(view.getBigUint64(offset, true));
    offset += 8;
    entries.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return entries;
}

test('payer protection: witness value and sigma encodings must be accepted by the wrap harness/guest', async () => {
  const rpc = paymentRpc(), { ux, inv, pool } = setup(rpc);
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, amountWei: AMOUNT });
  const memoHashes = ['0x' + Buffer.from(keccak_256(Buffer.from(invoice.memo.slice(2), 'hex'))).toString('hex')];
  const input = (witness) => stdinFor('wrap', { ...witness, memoHashes });
  const original = input(invoice.witness), entries = stdinEntries(original);
  assert.equal(entries.at(-3).length, 8 + 33, 'generated R is a 33-byte Vec');
  assert.equal(entries.at(-2).length, 8 + 32, 'generated Z is a 32-byte Vec');
  assert.ok(inv.verifyInvoice(invoice), 'generated invoice stays unchanged');
  const plusZeros = { ...invoice.witness, value: '+' + invoice.value.padStart(invoice.value.length + 2, '0') };
  assert.deepEqual(input(plusZeros), original, 'Rust-compatible decimal spellings produce identical guest input');
  assert.ok(inv.verifyInvoice({ ...invoice, witness: plusZeros }));

  for (const badValue of [Number(invoice.value), '0x' + BigInt(invoice.value).toString(16), ' ' + invoice.value, BigInt(invoice.value)]) {
    const witness = { ...invoice.witness, value: badValue };
    if (typeof badValue !== 'bigint') assert.throws(() => input(witness), /decimal string/);
    const changed = { ...invoice, witness };
    assert.equal(inv.verifyInvoice(changed), false);
    await assert.rejects(ux.payInvoice({ payerPriv: ALICE, invoice: changed }), /invoice failed verification/);
  }

  const point = secp.ProjectivePoint.fromHex(invoice.witness.sigR.slice(2));
  const encodings = [
    { sigR: '0x' + point.toHex(false) }, // same point, 65-byte uncompressed form
    { sigZ: '0x00' + invoice.witness.sigZ.slice(2) }, // same scalar, 33-byte form
    { sigZ: BigInt(invoice.witness.sigZ).toString() }, // JS parses decimal; the harness parses hex bytes
  ];
  for (const encoding of encodings) {
    const witness = { ...invoice.witness, ...encoding };
    const context = pool.intentContext('tacit-wrap-intent-v1', invoice.chainBinding, invoice.assetId, invoice.depositId,
      [[invoice.cx, invoice.cy, invoice.owner]], [BigInt(invoice.value)]);
    assert.ok(pool.verifyOpeningSigma(invoice.cx, invoice.cy, BigInt(invoice.value), witness.sigR, witness.sigZ, context), 'the curve proof alone accepts the alternate encoding');
    const changed = { ...invoice, witness };
    assert.equal(inv.verifyInvoice(changed), false);
    await assert.rejects(ux.payInvoice({ payerPriv: ALICE, invoice: changed }), /invoice failed verification/);
  }
  const longR = stdinEntries(input({ ...invoice.witness, ...encodings[0] }));
  const longZ = stdinEntries(input({ ...invoice.witness, ...encodings[1] }));
  assert.equal(longR.at(-3).length, 8 + 65, 'uncompressed R cannot fit the guest r33 read');
  assert.equal(longZ.at(-2).length, 8 + 33, 'padded Z cannot fit the guest r32 read');
  assert.deepEqual(rpc.calls, [], 'bad witness encodings never reach payment side effects');
});

test('valid payment control: native invoice signs and broadcasts its verified public amount and commitment', async () => {
  const rpc = paymentRpc(), { ux, inv } = setup(rpc);
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, amountWei: AMOUNT });
  const paid = await ux.payInvoice({ payerPriv: ALICE, invoice });
  assert.equal(paid.amount, invoice.amount);
  assert.equal(paid.commit, invoice.commit);
  const word = (v) => BigInt(v).toString(16).padStart(64, '0');
  const data = Buffer.from(keccak_256(new TextEncoder().encode('wrap(bytes32,uint256,bytes32)'))).toString('hex').slice(0, 8)
    + invoice.assetId.slice(2) + word(invoice.amount) + invoice.commit.slice(2);
  assert.ok(paid.signedRaw.includes(data), 'the signed calldata preserves the verified asset/amount/commit');
  assert.equal(rpc.calls.filter((q) => q.method === 'eth_sendRawTransaction').length, 1);
});

test('valid payment control: configured ERC20 invoice still reaches the existing permit/router signer', async () => {
  const rpc = paymentRpc(), { ux, inv } = setup({ ...rpc, network: 'mainnet' });
  const ticker = Object.keys(ux.assetByTicker).find((t) => /^0x[0-9a-f]{40}$/i.test(ux.assetByTicker[t].underlying || '')
    && !/^0x0{40}$/.test(ux.assetByTicker[t].underlying));
  assert.ok(ticker, 'mainnet has a configured ERC20 control');
  const meta = ux.assetByTicker[ticker];
  const { invoice } = inv.createInvoice({ recipientPriv: BOB, ticker, amountWei: (BigInt(meta.unitScale) * 12345n).toString() });
  const paid = await ux.payInvoice({ payerPriv: ALICE, invoice, broadcast: false });
  assert.equal(paid.amount, invoice.amount);
  assert.ok(paid.signedRaw.includes(invoice.underlying.slice(2).toLowerCase().padStart(64, '0')), 'router calldata contains the verified token');
  assert.equal(rpc.calls.filter((q) => q.method === 'eth_sendRawTransaction').length, 0);
});
