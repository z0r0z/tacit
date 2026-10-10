// dapp/note-opening.js: the opening of an output a key received or changed follows from the transaction that made it and the
// key alone, with the real derivations tacit.js uses; any other key, a changed commitment or a missing envelope opens nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeNoteOpener } from '../dapp/note-opening.js';
import { secp, hexToBytes, concatBytes, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import('./_domshim.mjs');
globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
const tacit = await import('../dapp/tacit.js');
globalThis.fetch = realFetch;
const { deriveAmountKeystreamECDH, deriveAmountKeystreamSelf, decryptAmount, encryptAmount, deriveBlinding, deriveChangeBlinding, pedersenCommit, bytesToPoint } = tacit;

const reverseBytes = (b) => Uint8Array.from(b).reverse();
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const SENDER = new Uint8Array(32).fill(0x41), RECIPIENT = new Uint8Array(32).fill(0x42), STRANGER = new Uint8Array(32).fill(0x43);
const pub = (k) => secp.getPublicKey(k, true);
const ASSET = new Uint8Array(32).fill(0xa5);
const INPUT = { txid: 'aa'.repeat(32), vout: 3 };
const anchor = concatBytes(reverseBytes(hexToBytes(INPUT.txid)), u32le(INPUT.vout));
const SENT = 250_000_000n, CHANGE = 7_000_000_123n;

// The transfer: output 0 sent to RECIPIENT, output 1 changed back to SENDER, built the way the sender's wallet builds them.
const out0 = { amount: SENT, blinding: deriveBlinding(SENDER, pub(RECIPIENT), anchor, 0) };
out0.encryptedAmount = encryptAmount(SENT, deriveAmountKeystreamECDH(SENDER, pub(RECIPIENT), anchor, 0));
out0.commitment = pedersenCommit(SENT, out0.blinding).toRawBytes(true);
const out1 = { amount: CHANGE, blinding: deriveChangeBlinding(SENDER, anchor, 1) };
out1.encryptedAmount = encryptAmount(CHANGE, deriveAmountKeystreamSelf(SENDER, anchor, 1));
out1.commitment = pedersenCommit(CHANGE, out1.blinding).toRawBytes(true);

const decoded = { assetId: ASSET, outputs: [out0, out1] };
const open = (over = {}) => makeNoteOpener({
  hexToBytes, concatBytes, reverseBytes, deriveAmountKeystreamECDH, deriveAmountKeystreamSelf, decryptAmount, deriveBlinding, deriveChangeBlinding, pedersenCommit, bytesToPoint,
  decodeEnvelopeScript: () => ({ opcode: 0x23, payload: new Uint8Array(1) }),
  decodePayload: () => decoded,
  ...over,
});
const tx = (over = {}) => ({
  vin: [{ txid: 'bb'.repeat(32), vout: 0, witness: ['00'.repeat(64), 'cc'.repeat(40), 'dd'.repeat(33)] },
        { ...INPUT, witness: ['00'.repeat(71), bytesToHex(pub(SENDER))] }],
  ...over,
});

test('the recipient opens the output sent to it, from the transaction and its key alone', () => {
  const r = open()({ tx: tx(), vout: 0, walletPriv: RECIPIENT });
  assert.ok(r, 'opens');
  assert.strictEqual(r.amount, SENT);
  assert.strictEqual(r.blinding, out0.blinding);
  assert.deepStrictEqual(Array.from(r.assetId), Array.from(ASSET));
});

test('the sender opens the change it made to itself', () => {
  const r = open()({ tx: tx(), vout: 1, walletPriv: SENDER });
  assert.ok(r);
  assert.strictEqual(r.amount, CHANGE);
  assert.strictEqual(r.blinding, out1.blinding);
});

test('no other key opens either output, and neither key opens the other\'s', () => {
  const o = open();
  for (const vout of [0, 1]) assert.strictEqual(o({ tx: tx(), vout, walletPriv: STRANGER }), null, `a stranger, output ${vout}`);
  assert.strictEqual(o({ tx: tx(), vout: 1, walletPriv: RECIPIENT }), null, 'the recipient does not open the sender\'s change');
  assert.strictEqual(o({ tx: tx(), vout: 0, walletPriv: SENDER }), null, 'the sender does not open what it sent away');
});

test('an output whose commitment is not the one that was opened is refused', () => {
  const tampered = { ...decoded, outputs: [{ ...out0, commitment: pedersenCommit(SENT + 1n, out0.blinding).toRawBytes(true) }, out1] };
  assert.strictEqual(open({ decodePayload: () => tampered })({ tx: tx(), vout: 0, walletPriv: RECIPIENT }), null);
});

test('a transaction with no envelope, one input, or no such output opens nothing', () => {
  assert.strictEqual(open({ decodeEnvelopeScript: () => null })({ tx: tx(), vout: 0, walletPriv: RECIPIENT }), null, 'no envelope');
  assert.strictEqual(open()({ tx: { vin: [tx().vin[0]] }, vout: 0, walletPriv: RECIPIENT }), null, 'one input');
  assert.strictEqual(open()({ tx: tx({ vin: [{ txid: 'bb'.repeat(32), vout: 0, witness: [] }, tx().vin[1]] }), vout: 0, walletPriv: RECIPIENT }), null, 'no witness on the envelope input');
  assert.strictEqual(open()({ tx: tx(), vout: 5, walletPriv: RECIPIENT }), null, 'an output the transfer does not have');
  assert.strictEqual(open({ decodePayload: () => null })({ tx: tx(), vout: 0, walletPriv: RECIPIENT }), null, 'a payload that does not decode');
  assert.strictEqual(open()({ tx: null, vout: 0, walletPriv: RECIPIENT }), null, 'no transaction');
});

test('it will not be built without the primitives it depends on', () => {
  assert.throws(() => makeNoteOpener({}), /required/);
});
