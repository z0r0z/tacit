// dapp/bound-swap.js, side by side: the buyer's note secrets, the seller's payload, the buyer's commit and reveal, the
// seller's signature, the buyer's finish and the pre-broadcast check (verifyBoundSwap). An honest swap of an etched
// (non-TAC) note for sats is accepted by the dapp's tacit.validateOutpoint and opened again from each party's key alone;
// then verifyBoundSwap is shown refusing each tampering by name, and the signers refusing what would not fold.
// Offline (tests/lib/btc-sim.mjs); the only Ethereum read, a bound output's nullifier, is answered "unspent" here.
//   node tests/bound-swap.test.mjs

import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32, signSchnorr, pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { tacitKit } from '../dapp/adaptor-btc-tx.js';
import { openBoundNote } from '../dapp/btc-bind.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import * as bs from '../dapp/bound-swap.js';
import { fetched, tacit, te, scalar, etchNote, validate, NOTE_VALUE } from './lib/btc-sim.mjs';

const sha = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const h2b = (h) => hexToBytes(String(h).replace(/^0x/, ''));
const h0x = (b) => '0x' + bytesToHex(b);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ok - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } };
const section = async (title, fn) => {
  console.log(`\n# ${title}`);
  try { await fn(); } catch (e) { failed++; console.log(`  FAIL - ${title} threw\n${e.stack}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message) || (console.log(`    (threw: ${e.message})`), false); } };

const dep = getConfidentialDeployment('signet');
const CHAIN_BINDING = h0x(keccak_256(h2b(BigInt(dep.chainId).toString(16).padStart(64, '0') + strip(dep.pool))));
const OTHER_BINDING = h0x(keccak_256(te('another pool deployment')));
const offline = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const body = String(init?.body || '');
  if (init?.method !== 'POST' || !body.includes('eth_getStorageAt')) return offline(input, init);
  const req = JSON.parse(body);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: word(0) }), { headers: { 'content-type': 'application/json' } });
};

const walletOf = (tag) => makeBtcWallet({ priv: bigintToBytes32(scalar(tag)), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1 }).prims;
const buyer = walletOf('unit-buyer'), seller = walletOf('unit-seller');
const kit = tacitKit(tacit);
const BUYER_TR = buyer.p2trScript(buyer.wallet.xonly()), BUYER_WPKH = buyer.p2wpkhScript(buyer.wallet.pub);
const SELLER_TR = seller.p2trScript(seller.wallet.xonly()), SELLER_WPKH = seller.p2wpkhScript(seller.wallet.pub);
const PAYOUT = bs.p2trScriptOf(bs.xonlyOf(scalar('unit-seller-sats')));
const OTHER = bs.p2trScriptOf(bs.xonlyOf(scalar('someone-else')));
const V = 5000n, BUY = 3000n, PRICE = 25_000, FEE_RATE = 3;
const coin = (tag, script, value = 80_000) => ({ txid: bytesToHex(sha(te('coin/' + tag))), vout: 0, value, script });

// The seller's notes: an etched asset at its Taproot address, and another at its P2WPKH address.
const R_S = scalar('unit-note-blinding');
const C_IN = pedersenCommit(V, R_S), A_IN = C_IN.toAffine();
const etchTr = etchNote({ ticker: 'BTR', value: V, r: R_S, script: SELLER_TR, signerD: scalar('unit-etcher-1') });
const etchWpkh = etchNote({ ticker: 'BWP', value: V, r: R_S, script: SELLER_WPKH, signerD: scalar('unit-etcher-2') });
const noteOf = (e, script) => ({ txid: e.txid, vout: 0, value: NOTE_VALUE, script, asset: h0x(e.asset) });
const TR_NOTE = noteOf(etchTr, SELLER_TR), WPKH_NOTE = noteOf(etchWpkh, SELLER_WPKH);

function offerFor(note, { chainBinding = CHAIN_BINDING } = {}) {
  const secrets = bs.buyerNoteSecrets({ kit, buyerKey: buyer.wallet.priv, sellerNoteOutpoint: note, amount: BUY });
  const offer = bs.sellerPayload({
    prims: seller, kit, assetId: note.asset, chainBinding, toBuyer: BUY,
    sellerNote: { txid: note.txid, vout: note.vout, amount: V, blinding: R_S, cx: A_IN.x, cy: A_IN.y },
    buyerXonly: secrets.buyerXonly, buyerBlinding: secrets.buyerBlinding, buyerAmountCt: secrets.buyerAmountCt,
  });
  return { secrets, offer };
}
const txsFor = (note, offer, { funding = coin('fund-tr', BUYER_TR), price = PRICE, payout = PAYOUT } = {}) =>
  bs.buyerTxs({ prims: buyer, payload: offer.payload, noteScripts: offer.noteScripts, fundingUtxo: funding, sellerNote: note, sellerPayoutScript: payout, priceSats: price, feeRate: FEE_RATE });
const expectOf = (note, offer, secrets) => ({ sellerNote: note, noteScripts: offer.noteScripts, payoutScript: PAYOUT, priceSats: PRICE, payload: offer.payload, buyerXonly: secrets.buyerXonly });
const expectedOf = (note, secrets, over = {}) => ({
  assetId: note.asset, amountToBuyer: BUY, buyerXonly: secrets.buyerXonly, buyerBlinding: secrets.buyerBlinding, sellerPayoutScript: PAYOUT,
  priceSats: PRICE, chainBinding: CHAIN_BINDING, sellerNoteOutpoint: { txid: note.txid, vout: note.vout }, sellerNoteCommitment: C_IN.toRawBytes(true), ...over,
});
const esploraOf = (hex) => {
  const t = bs.parseTx(hex);
  return { txid: t.txid, status: { confirmed: true, block_height: 330002 }, vin: t.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })), vout: t.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })) };
};
const retx = (hex, fn) => { const t = bs.parseTx(hex); fn(t); return bytesToHex(buyer.serializeTx(t)); };
const sum = (xs) => xs.reduce((s, x) => s + x.value, 0);

// ---- the honest swap: Taproot note, Taproot funding, SIGHASH_ALL ----------------------------------------------------------
const { secrets, offer } = offerFor(TR_NOTE);
const swap = txsFor(TR_NOTE, offer);
const signed = bs.sellerSign({ prims: seller, reveal: swap.toSign.reveal, prevouts: swap.toSign.prevouts, kind: 'taproot', sighash: 0x01, expect: expectOf(TR_NOTE, offer, secrets) });
const fin = bs.buyerFinish({ prims: buyer, swap, sellerWitness: signed.witness });
const expected = expectedOf(TR_NOTE, secrets);
const otherOffer = offerFor(TR_NOTE, { chainBinding: OTHER_BINDING });   // the same trade, its payload naming another deployment

await section('the honest swap', async () => {
  const k = bs.kernelMsg(TR_NOTE.asset, [TR_NOTE, WPKH_NOTE], [offer.buyerNote.commitment, offer.change.commitment]);
  const t = tacit.computeKernelMsg(h2b(TR_NOTE.asset), [TR_NOTE, WPKH_NOTE].map((n) => ({ txid: n.txid, vout: n.vout })), [offer.buyerNote.commitment, offer.change.commitment], 0n);
  ok(bytesToHex(k) === bytesToHex(t), 'kernelMsg is tacit.js computeKernelMsg byte for byte');
  ok(bs.parseTx(fin.commitHex).txid === buyer.txid(swap.commitTx) && bs.parseTx(fin.revealHex).txid === buyer.txid(fin.revealTx) && fin.revealTxid === swap.revealTxid,
    'parseTx reads back the wallet\'s own serialization (same txids), and the reveal\'s txid was final before anyone signed');
  const v = bs.verifyBoundSwap({ revealHex: fin.revealHex, commitHex: fin.commitHex, expected });
  ok(v.ok && v.reasons.length === 0, `verifyBoundSwap passes the honest pair (${JSON.stringify(v)})`);
  tacit.clearValidatorCaches();
  const f = async (id) => ({ [etchTr.txid]: etchTr.esplora, [fin.revealTxid]: esploraOf(fin.revealHex) })[id] || null;
  const v0 = await validate(f, fin.revealTxid, 0), v1 = await validate(f, fin.revealTxid, 1);
  ok(v0.ok && v1.ok && fetched.length === 0, `the Bitcoin validator accepts both notes (${JSON.stringify(v0)}, ${JSON.stringify(v1)})`);
  const esp = esploraOf(fin.revealHex);
  const b0 = openBoundNote({ tacit, priv: buyer.wallet.priv, pub: buyer.wallet.pub, tx: esp, vout: 0 });
  const s1 = openBoundNote({ tacit, priv: seller.wallet.priv, pub: seller.wallet.pub, tx: esp, vout: 1 });
  ok(b0 && b0.amount === BUY && b0.blinding === secrets.buyerBlinding && s1 && s1.amount === V - BUY && s1.blinding === offer.change.blinding
    && !openBoundNote({ tacit, priv: buyer.wallet.priv, pub: buyer.wallet.pub, tx: esp, vout: 1 }) && !openBoundNote({ tacit, priv: seller.wallet.priv, pub: seller.wallet.pub, tx: esp, vout: 0 }),
    `each party's key alone opens its own note (buyer ${b0?.amount} at vout 0, seller ${s1?.amount} at vout 1) and not the other's`);
  const c = swap.commitTx;
  ok(sum(swap.prevouts) - sum(fin.revealTx.outputs) === swap.revealFee && 80_000 - sum(c.outputs) === swap.commitFee && bytesToHex(c.outputs[1].script) === bytesToHex(BUYER_TR) && fin.revealTx.outputs[2].value === PRICE,
    `fees add up (commit ${swap.commitFee}, reveal ${swap.revealFee} at ${FEE_RATE} sat/vB), the buyer's change (${c.outputs[1].value}) returns to its funding script, the payout is the price`);
});

await section('a P2WPKH note signed ALL|ANYONECANPAY, funded from P2WPKH', async () => {
  const w = offerFor(WPKH_NOTE);
  const sw = txsFor(WPKH_NOTE, w.offer, { funding: coin('fund-wpkh', BUYER_WPKH) });
  ok(bytesToHex(sw.commitTx.inputs[0].witness[0]) === bytesToHex(buyer.signP2wpkhInput(sw.commitTx, 0, 80_000)[0]),
    'the commit\'s P2WPKH signature is the wallet\'s own BIP-143 signer\'s, byte for byte');
  const all = bs.sellerSign({ prims: seller, reveal: sw.toSign.reveal, prevouts: sw.toSign.prevouts, kind: 'p2wpkh', sighash: 0x01 });
  ok(bytesToHex(all.witness[0]) === bytesToHex(seller.signP2wpkhInput(sw.reveal, 1, NOTE_VALUE)[0]), 'sellerSign p2wpkh SIGHASH_ALL is the wallet\'s own BIP-143 signer\'s, byte for byte');
  const acp = bs.sellerSign({ prims: seller, reveal: sw.toSign.reveal, prevouts: sw.toSign.prevouts, kind: 'p2wpkh', sighash: 0x81, expect: expectOf(WPKH_NOTE, w.offer, w.secrets) });
  const f2 = bs.buyerFinish({ prims: buyer, swap: sw, sellerWitness: acp.witness });
  const v = bs.verifyBoundSwap({ revealHex: f2.revealHex, commitHex: f2.commitHex, expected: expectedOf(WPKH_NOTE, w.secrets) });
  tacit.clearValidatorCaches();
  const f = async (id) => ({ [etchWpkh.txid]: etchWpkh.esplora, [f2.revealTxid]: esploraOf(f2.revealHex) })[id] || null;
  const v0 = await validate(f, f2.revealTxid, 0);
  ok(acp.witness[0].at(-1) === 0x81 && v.ok && v0.ok, `0x81: buyerFinish verifies the ECDSA signature, verifyBoundSwap passes (${v.reasons}), the validator accepts the buyer's note (${JSON.stringify(v0)})`);
  // ANYONECANPAY commits to the seller's input only: the same signature finishes a reveal on another commit (the seller can sign first).
  const sw2 = txsFor(WPKH_NOTE, w.offer, { funding: coin('fund-wpkh-2', BUYER_WPKH, 90_000) });
  const f3 = bs.buyerFinish({ prims: buyer, swap: sw2, sellerWitness: acp.witness });
  ok(sw2.commitTxid !== sw.commitTxid && f3.revealTxid !== f2.revealTxid && bs.verifyBoundSwap({ revealHex: f3.revealHex, commitHex: f3.commitHex, expected: expectedOf(WPKH_NOTE, w.secrets) }).ok,
    'the 0x81 signature stays valid on a reveal spending a different commit; with 0x01 it would not');
  ok(throws(() => bs.buyerFinish({ prims: buyer, swap: sw2, sellerWitness: all.witness }), /does not verify/), 'buyerFinish refuses a SIGHASH_ALL signature made for another commit');
});

// ---- verifyBoundSwap refuses each tampering ---------------------------------------------------------------------------------
await section('verifyBoundSwap refuses each tampering, by name', async () => {
  const n = 2;
  const check = (label, revealHex, want, exp = expected, commitHex = fin.commitHex) => {
    const v = bs.verifyBoundSwap({ revealHex, commitHex, expected: exp });
    ok(!v.ok && v.reasons.join() === want.join(), `${label}: refused (${v.reasons.join(', ')})`);
  };
  check('payout one sat under the price', retx(fin.revealHex, (t) => { t.outputs[n].value = PRICE - 1; }), ['payout-value']);
  check('payout to another script', retx(fin.revealHex, (t) => { t.outputs[n].script = OTHER; }), ['payout-script']);
  check('the buyer\'s note at another script', retx(fin.revealHex, (t) => { t.outputs[0].script = OTHER; }), ['buyer-note-script']);
  check('another amount to the buyer', fin.revealHex, ['buyer-note-opening'], { ...expected, amountToBuyer: BUY + 1n });
  check('another blinding for the buyer', fin.revealHex, ['buyer-note-opening'], { ...expected, buyerBlinding: secrets.buyerBlinding + 1n });
  const sig83 = signSchnorr(seller.tapSighashKeyPath(fin.revealTx, 1, swap.prevouts, 0x83), seller.wallet.priv);
  check('the seller signed SINGLE|ANYONECANPAY (0x83)', retx(fin.revealHex, (t) => { t.inputs[1].witness = [Uint8Array.from([...sig83, 0x83])]; }), ['unbound-seller-signature']);
  const obSwap = txsFor(TR_NOTE, otherOffer.offer);
  const obFin = bs.buyerFinish({ prims: buyer, swap: obSwap, sellerWitness: bs.sellerSign({ prims: seller, reveal: obSwap.toSign.reveal, prevouts: obSwap.toSign.prevouts, kind: 'taproot' }).witness });
  check('a payload naming another deployment', obFin.revealHex, ['wrong-chain-binding'], expected, obFin.commitHex);
  check('a check against another deployment', fin.revealHex, ['wrong-chain-binding'], { ...expected, chainBinding: OTHER_BINDING });
  check('an extra reveal input', retx(fin.revealHex, (t) => { t.inputs.push({ txid: coin('extra', BUYER_TR).txid, vout: 0, scriptSig: new Uint8Array(0), sequence: 0xfffffffd, witness: [new Uint8Array(64)] }); }), ['extra-inputs']);
  check('the payload outputs swapped (vout 0 and 1)', retx(fin.revealHex, (t) => { [t.outputs[0], t.outputs[1]] = [t.outputs[1], t.outputs[0]]; }), ['buyer-note-script']);
  check('the payout moved ahead of the notes', retx(fin.revealHex, (t) => { t.outputs = [t.outputs[2], t.outputs[0], t.outputs[1]]; }), ['buyer-note-script', 'payout-script', 'payout-value']);
  check('vin[0] not the commit', retx(fin.revealHex, (t) => { t.inputs[0].txid = coin('not-the-commit', BUYER_TR).txid; }), ['commit-not-spent']);
  check('another seller note commitment', fin.revealHex, ['kernel'], { ...expected, sellerNoteCommitment: pointToBytes(pedersenCommit(V + 1n, R_S)) });
  check('a corrupted range proof', retx(fin.revealHex, (t) => { const s = t.inputs[0].witness[1]; s[s.length - 2] ^= 1; }), ['range-proof']);
  check('the seller\'s input unsigned', retx(fin.revealHex, (t) => { t.inputs[1].witness = []; }), ['unsigned', 'unbound-seller-signature']);
  const nb = bs.verifyBoundSwap({ revealHex: fin.commitHex, commitHex: fin.commitHex, expected });
  ok(!nb.ok && nb.reasons.join() === 'not-a-bound-transfer', `a transaction that is not a 0x39 reveal: refused (${nb.reasons})`);
});

// ---- the signers refuse what would not fold or not pay ---------------------------------------------------------------------
await section('the signers and builders refuse', async () => {
  const sign = (kind, sighash, extra = {}) => () => bs.sellerSign({ prims: seller, reveal: swap.toSign.reveal, prevouts: swap.toSign.prevouts, kind, sighash, ...extra });
  ok([0x83, 0x03, 0x02, 0x82].every((h) => throws(sign('taproot', h), /leaves outputs free/)), 'sellerSign (Taproot) refuses 0x83, 0x03, 0x02 and 0x82');
  const wsw = txsFor(WPKH_NOTE, offerFor(WPKH_NOTE).offer);
  ok([0x83, 0x03, 0x00].every((h) => throws(() => bs.sellerSign({ prims: seller, reveal: wsw.toSign.reveal, prevouts: wsw.toSign.prevouts, kind: 'p2wpkh', sighash: h }), /leaves outputs free/)), 'sellerSign (P2WPKH) refuses 0x83, 0x03 and 0x00');
  const cheap = txsFor(TR_NOTE, offer, { price: PRICE - 1000 });
  ok(throws(() => bs.sellerSign({ prims: seller, reveal: cheap.toSign.reveal, prevouts: cheap.toSign.prevouts, kind: 'taproot', expect: expectOf(TR_NOTE, offer, secrets) }), /refusing to sign: payout-value/), 'sellerSign with expectations refuses a reveal that pays under the price');
  ok(throws(sign('taproot', 0x01, { expect: { ...expectOf(TR_NOTE, offer, secrets), payload: otherOffer.offer.payload } }), /commit-envelope-mismatch/), 'and one whose commit does not carry the seller\'s payload');
  ok(throws(sign('taproot', 0x01, { sellerKey: buyer.wallet.priv }), /not at this key/), 'sellerSign refuses a key that does not hold the note');
  const forged = [Uint8Array.from([...signSchnorr(seller.tapSighashKeyPath(swap.reveal, 1, swap.prevouts, 0x01), buyer.wallet.priv), 0x01])];
  ok(throws(() => bs.buyerFinish({ prims: buyer, swap, sellerWitness: forged }), /does not verify/), 'buyerFinish refuses a signature by another key');
  ok(throws(() => bs.buyerTxs({ prims: buyer, payload: Uint8Array.from([0x26, ...offer.payload.subarray(1)]), noteScripts: offer.noteScripts, fundingUtxo: coin('fund-tr', BUYER_TR), sellerNote: TR_NOTE, sellerPayoutScript: PAYOUT, priceSats: PRICE, feeRate: FEE_RATE }), /0x39/),
    'buyerTxs refuses any payload but 0x39');
  ok(throws(() => bs.buyerTxs({ prims: buyer, payload: offer.payload, noteScripts: [OTHER, offer.noteScripts[1]], fundingUtxo: coin('fund-tr', BUYER_TR), sellerNote: TR_NOTE, sellerPayoutScript: PAYOUT, priceSats: PRICE, feeRate: FEE_RATE }), /buyer key/),
    'buyerTxs refuses a payload whose first output is not the buyer\'s');
  const base = { prims: seller, kit, assetId: TR_NOTE.asset, chainBinding: CHAIN_BINDING, buyerXonly: secrets.buyerXonly, buyerBlinding: secrets.buyerBlinding };
  ok(throws(() => bs.sellerPayload({ ...base, toBuyer: V + 1n, sellerNote: { ...TR_NOTE, amount: V, blinding: R_S } }), /within the seller/)
    && throws(() => bs.sellerPayload({ ...base, toBuyer: BUY, sellerNote: { ...TR_NOTE, amount: V + 1n, blinding: R_S, cx: A_IN.x, cy: A_IN.y } }), /do not open/),
    'sellerPayload refuses more than the note holds, and an opening that does not match the note\'s commitment');
});

console.log(`\n${passed} bound-swap checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
