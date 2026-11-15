// dapp/bound-swap.js, the PINNED offer (v2): part of a note sold in one round, the seller signing SIGHASH_ALL over the exact commit
// (from one of the bid wallet's coins at a fee rate it names) and reveal. The buyer rebuilds the same pair, the Bitcoin validator
// accepts both notes, the seller's change reopens from its key alone at its P2WPKH address, and each tampering (another coin,
// another fee rate, a redirected payout) is refused. The worker's shape check accepts it. Offline (tests/lib/btc-sim.mjs).
//   node tests/bound-swap-pinned.test.mjs

import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32, pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { tacitKit } from '../dapp/adaptor-btc-tx.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import * as bs from '../dapp/bound-swap.js';
import { parseCxferBoundEnvelope } from '../dapp/burn-deposit-bitcoin.js';
import { fetched, tacit, te, scalar, etchNote, validate, NOTE_VALUE } from './lib/btc-sim.mjs';

const sha = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const h2b = (h) => hexToBytes(String(h).replace(/^0x/, ''));
const h0x = (b) => '0x' + bytesToHex(b);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log(`  ok - ${m}`); } else { failed++; console.log(`  FAIL - ${m}`); } };
const section = async (t, fn) => { console.log(`\n# ${t}`); try { await fn(); } catch (e) { failed++; console.log(`  FAIL - ${t} threw\n${e.stack}`); } };
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
const walletOf = (tag) => makeBtcWallet({ priv: bigintToBytes32(scalar(tag)), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 3 }).prims;
const buyer = walletOf('offer-buyer'), seller = walletOf('offer-seller');
const kit = tacitKit(tacit);
const BUYER_TR = buyer.p2trScript(buyer.wallet.xonly()), BUYER_WPKH = buyer.p2wpkhScript(buyer.wallet.pub);
const SELLER_TR = seller.p2trScript(seller.wallet.xonly()), SELLER_WPKH = seller.p2wpkhScript(seller.wallet.pub);
const PAYOUT = bs.p2trScriptOf(bs.xonlyOf(scalar('offer-seller-sats')));
const V = 5000n, PRICE = 25_000, FEE_RATE = 3;
const coin = (tag, script, value = 80_000) => ({ txid: bytesToHex(sha(te('coin/' + tag))), vout: 0, value, script });
const R_S = scalar('offer-note-blinding'), C_IN = pedersenCommit(V, R_S), A_IN = C_IN.toAffine();
const etchTr = etchNote({ ticker: 'OTR', value: V, r: R_S, script: SELLER_TR, signerD: scalar('offer-etcher-1') });
const etchWpkh = etchNote({ ticker: 'OWP', value: V, r: R_S, script: SELLER_WPKH, signerD: scalar('offer-etcher-2') });
const noteOf = (e, script) => ({ txid: e.txid, vout: 0, value: NOTE_VALUE, script, asset: h0x(e.asset), amount: V, blinding: R_S, cx: A_IN.x, cy: A_IN.y });
const TR_NOTE = noteOf(etchTr, SELLER_TR), WPKH_NOTE = noteOf(etchWpkh, SELLER_WPKH);
const esploraOf = (hex) => {
  const t = bs.parseTx(hex);
  return { txid: t.txid, status: { confirmed: true, block_height: 330002 }, vin: t.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })),
    vout: t.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })) };
};
const offerOf = (note, over = {}) => bs.sellerOffer({ prims: seller, kit, assetId: note.asset, sellerNote: note, buyerXonly: buyer.wallet.xonly(), chainBinding: CHAIN_BINDING, sellerPayoutScript: PAYOUT, priceSats: PRICE, ...over });
const expectedOf = (note) => ({ assetId: note.asset, chainBinding: CHAIN_BINDING, sellerNoteCommitment: C_IN.toRawBytes(true) });
const take = (offer, note, over = {}) => bs.buyerTakeOffer({ prims: buyer, kit, offer, fundingUtxo: coin('fund-tr', BUYER_TR), feeRate: FEE_RATE, expected: expectedOf(note), ...over });

import { openBoundNote } from '../dapp/btc-bind.js';
import { boundOfferShape, boundOfferMsg as workerMsg } from '../worker/src/bound-offers.js';

const FUND = coin('bid-wallet', BUYER_WPKH, 40_000);
const pinned = (note, toBuyer, over = {}) => bs.sellerPinnedOffer({ prims: seller, kit, assetId: note.asset, sellerNote: note, toBuyer, buyerPub: buyer.wallet.pub, fund: FUND, feeRate: FEE_RATE,
  chainBinding: CHAIN_BINDING, sellerPayoutScript: PAYOUT, priceSats: 10_000, ...over });
const takeP = (offer, note, over = {}) => bs.buyerTakeOffer({ prims: buyer, kit, offer, fundingUtxo: null, feeRate: 99, maxFeeRate: 25, expected: expectedOf(note), ...over });
const PART = 2000n;

await section('a part of a Taproot note, pinned to the bid wallet\'s coin', async () => {
  const offer = pinned(TR_NOTE, PART);
  ok(offer.v === 2 && offer.amount === PART.toString() && offer.change.amount === (V - PART).toString(), 'the offer sells 2000 of a 5000 note, 3000 coming back as change');
  ok(offer.noteScripts[1] === bytesToHex(SELLER_WPKH), 'the change sits at the seller\'s P2WPKH address (a note its wallet reads, not fast-lane spendable, so it can be sold again)');
  ok(h2b(offer.witness[0]).length === 65 && h2b(offer.witness[0])[64] === 0x01, 'the seller signs SIGHASH_ALL: its signature covers the commit, so the envelope its payload rides in');
  const t = takeP(offer, TR_NOTE);
  ok(t.revealTxid === offer.revealTxid && t.commitTxid === offer.commitTxid, 'the buyer rebuilds exactly the pair the seller signed (from the offer\'s coin and fee rate, not its own)');
  const v = bs.verifyBoundSwap({ revealHex: t.revealHex, commitHex: t.commitHex, prims: buyer, expected: {
    assetId: TR_NOTE.asset, amountToBuyer: PART, buyerXonly: buyer.wallet.xonly(), buyerBlinding: t.buyerNote.blinding, sellerPayoutScript: PAYOUT, priceSats: 10_000,
    chainBinding: CHAIN_BINDING, sellerNoteOutpoint: TR_NOTE, sellerNoteCommitment: C_IN.toRawBytes(true), sellerNote: TR_NOTE } });
  ok(v.ok, `the pair verifies (${JSON.stringify(v.reasons)})`);
  tacit.clearValidatorCaches();
  const f = async (id) => ({ [etchTr.txid]: etchTr.esplora, [t.revealTxid]: esploraOf(t.revealHex) })[id] || null;
  const v0 = await validate(f, t.revealTxid, 0), v1 = await validate(f, t.revealTxid, 1);
  ok(v0.ok && v1.ok, `the Bitcoin validator accepts the buyer's note and the seller's change (${JSON.stringify(v0)}, ${JSON.stringify(v1)})`);
  const tx = esploraOf(t.revealHex);
  const mine = openBoundNote({ tacit, priv: seller.wallet.priv, pub: seller.wallet.pub, tx, vout: 1 });
  ok(mine && mine.amount === V - PART, `the seller's key alone reopens its change, as its wallet's scan does (${mine?.amount})`);
  ok(t.buyerNote.amount === PART && bytesToHex(pointToBytes(pedersenCommit(PART, t.buyerNote.blinding))) === strip(parseCxferBoundEnvelope(strip(offer.payload)).commitments[0]), 'the buyer\'s note opens to the part bought');
  const rv = bs.parseTx(t.revealHex);
  ok(rv.outputs[2].value === 10_000 && bytesToHex(rv.outputs[2].script) === bytesToHex(PAYOUT), 'the seller is paid its price');
  ok(strip(String(bs.parseTx(t.commitHex).inputs[0].txid)) === strip(FUND.txid), 'the commit spends the coin the offer names');
});

await section('a part of a P2WPKH note, and a whole note pinned', async () => {
  const offer = pinned(WPKH_NOTE, PART);
  const t = takeP(offer, WPKH_NOTE);
  tacit.clearValidatorCaches();
  const f = async (id) => ({ [etchWpkh.txid]: etchWpkh.esplora, [t.revealTxid]: esploraOf(t.revealHex) })[id] || null;
  ok((await validate(f, t.revealTxid, 0)).ok && (await validate(f, t.revealTxid, 1)).ok, 'a P2WPKH note sold in part: both notes validate');
  const whole = pinned(TR_NOTE, V);
  ok(whole.change.amount === '0' && takeP(whole, TR_NOTE).revealTxid === whole.revealTxid, 'the whole amount pinned works too (a zero change)');
});

await section('a pinned offer that does not check is refused', async () => {
  const offer = pinned(TR_NOTE, PART);
  ok(throws(() => takeP({ ...offer, feeRate: FEE_RATE + 1 }, TR_NOTE), /does not check: the pair/), 'another fee rate builds another pair: refused');
  ok(throws(() => takeP({ ...offer, fund: { ...offer.fund, value: offer.fund.value + 1 } }, TR_NOTE), /does not check: the pair/), 'another coin value: refused');
  ok(throws(() => takeP({ ...offer, fund: { ...offer.fund, txid: '22'.repeat(32) } }, TR_NOTE), /does not check: the pair/), 'another coin: refused');
  ok(throws(() => takeP(pinned(TR_NOTE, PART, { feeRate: 40 }), TR_NOTE), /fee rate 40 is over 25/), 'a fee rate over the buyer\'s ceiling: refused');
  ok(throws(() => takeP({ ...offer, payoutScript: bytesToHex(bs.p2trScriptOf(bs.xonlyOf(scalar('thief')))), revealTxid: undefined }, TR_NOTE), /does not check|does not verify|signature/), 'a payout redirected after the seller signed: refused');
  ok(throws(() => pinned(TR_NOTE, V + 1n), /within the note/), 'more than the note holds: refused');
  ok(throws(() => pinned(TR_NOTE, PART, { fund: coin('not-the-bid', SELLER_WPKH) }), /funding coin/), 'a coin that is not the bid key\'s: refused');
  ok(throws(() => pinned(TR_NOTE, PART, { fund: coin('tiny', BUYER_WPKH, 1000) }), /too small/), 'a coin too small to pay the pair: "too small" (the page tries the next coin)');
});

await section('the worker takes the pinned shape and signs over its coin', async () => {
  const offer = JSON.parse(JSON.stringify(pinned(TR_NOTE, PART)));
  const asset = strip(TR_NOTE.asset);
  ok(boundOfferShape(offer, asset) === null, `the worker's shape check accepts a pinned offer (${boundOfferShape(offer, asset)})`);
  ok(/SIGHASH_ALL/.test(boundOfferShape({ ...offer, witness: [offer.witness[0].slice(0, -2) + '81'] }, asset) || ''), 'a pinned offer signed ALL|ANYONECANPAY: refused by shape');
  ok(/noteScripts/.test(boundOfferShape({ ...offer, noteScripts: [offer.noteScripts[0], bytesToHex(SELLER_TR)] }, asset) || ''), 'a pinned offer whose change is not at the seller\'s P2WPKH: refused by shape');
  ok(/fund/.test(boundOfferShape({ ...offer, fund: { ...offer.fund, script: bytesToHex(SELLER_WPKH) } }, asset) || ''), 'a coin that is not the bid key\'s: refused by shape');
  ok(/feeRate/.test(boundOfferShape({ ...offer, feeRate: 0 }, asset) || ''), 'no fee rate: refused by shape');
  const m1 = bytesToHex(workerMsg('signet', offer, 'ab'.repeat(16), 1)), m2 = bytesToHex(bs.boundOfferMsg('signet', offer, 'ab'.repeat(16), 1));
  ok(m1 === m2, 'the worker and the page sign the same message');
  ok(bytesToHex(workerMsg('signet', { ...offer, fund: { ...offer.fund, vout: 1 } }, 'ab'.repeat(16), 1)) !== m1, 'the coin is part of what the seller signs');
  const v1 = JSON.parse(JSON.stringify(offerOf(TR_NOTE)));
  ok(boundOfferShape(v1, asset) === null, 'a whole-note offer (v1) still passes');
});

console.log(`\n${passed} bound-swap-pinned checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
