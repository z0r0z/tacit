// dapp/bound-swap.js, the one-round swap: the seller's offer (its whole note, an ECDH buyer note, its note's ALL|ANYONECANPAY
// signature made before the commit exists) and the buyer's (watchtower's) take (check, commit, reveal, finish, verify). The
// pair the take returns is accepted by the dapp's tacit.validateOutpoint, the buyer's key reopens its note from the seller's
// x-only key alone, and each tampering of an offer is refused by name. Offline (tests/lib/btc-sim.mjs).
//   node tests/bound-swap-offer.test.mjs

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

await section('one ECDH, either side', async () => {
  let same = 0;
  for (const tag of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const s = walletOf('ecdh-s-' + tag), b = walletOf('ecdh-b-' + tag);
    const one = bs.buyerNoteEcdh({ kit, myKey: s.wallet.priv, theirXonly: b.wallet.xonly(), sellerNoteOutpoint: TR_NOTE, amount: 777n });
    const two = bs.buyerNoteEcdh({ kit, myKey: b.wallet.priv, theirXonly: s.wallet.xonly(), sellerNoteOutpoint: TR_NOTE, amount: 777n });
    if (one.blinding === two.blinding && bytesToHex(one.amountCt) === bytesToHex(two.amountCt)) same++;
  }
  ok(same === 6, 'the seller (its key × the buyer\'s x-only key) and the buyer (its key × the seller\'s) derive the same blinding and amount ciphertext, for six key pairs of either parity');
  const a = bs.buyerNoteEcdh({ kit, myKey: seller.wallet.priv, theirXonly: buyer.wallet.xonly(), sellerNoteOutpoint: TR_NOTE, amount: 1n });
  const b = bs.buyerNoteEcdh({ kit, myKey: seller.wallet.priv, theirXonly: buyer.wallet.xonly(), sellerNoteOutpoint: WPKH_NOTE, amount: 1n });
  ok(a.blinding !== b.blinding, 'anchored at the seller\'s note: another note gives another blinding');
});

let honest = null;
await section('the one-round swap (Taproot note)', async () => {
  const offer = offerOf(TR_NOTE);
  ok(offer.kind === 'taproot' && offer.amount === V.toString() && offer.witness.length === 1 && h2b(offer.witness[0]).length === 65 && h2b(offer.witness[0])[64] === 0x81,
    'the offer is the WHOLE note, signed by its Taproot key with ALL|ANYONECANPAY before any commit exists');
  ok(JSON.parse(JSON.stringify(offer)).payload === offer.payload, 'the offer is plain JSON (what the seller posts)');
  const chk = bs.buyerCheckOffer({ kit, offer, buyerKey: buyer.wallet.priv, expected: expectedOf(TR_NOTE) });
  ok(chk.ok && chk.amount === V, `the buyer's checks pass before it spends anything (${JSON.stringify(chk.reasons)})`);
  const t = take(offer, TR_NOTE);
  honest = { offer, t };
  const v = bs.verifyBoundSwap({ revealHex: t.revealHex, commitHex: t.commitHex, prims: buyer, expected: {
    assetId: TR_NOTE.asset, amountToBuyer: V, buyerXonly: buyer.wallet.xonly(), buyerBlinding: t.buyerNote.blinding, sellerPayoutScript: PAYOUT, priceSats: PRICE,
    chainBinding: CHAIN_BINDING, sellerNoteOutpoint: TR_NOTE, sellerNoteCommitment: C_IN.toRawBytes(true), sellerNote: TR_NOTE } });
  ok(v.ok, `the pair verifies with the seller's signature over THIS reveal and the commit's tweak checked (${JSON.stringify(v.reasons)})`);
  tacit.clearValidatorCaches();
  const f = async (id) => ({ [etchTr.txid]: etchTr.esplora, [t.revealTxid]: esploraOf(t.revealHex) })[id] || null;
  const v0 = await validate(f, t.revealTxid, 0), v1 = await validate(f, t.revealTxid, 1);
  ok(v0.ok && v1.ok && fetched.length === 0, `the Bitcoin validator accepts both notes of the reveal the watchtower built (${JSON.stringify(v0)}, ${JSON.stringify(v1)})`);
  const rv = bs.parseTx(t.revealHex);
  ok(rv.outputs.length === 3 && rv.outputs[2].value === PRICE && bytesToHex(rv.outputs[2].script) === bytesToHex(PAYOUT) && bytesToHex(rv.outputs[0].script) === bytesToHex(BUYER_TR),
    'the reveal pays the seller the price and the buyer its note at its Taproot address');
  // the buyer reopens its note from the seller's x-only key alone (the envelope's ciphertext, the ECDH keystream)
  const env = bs.parseTx(t.revealHex);
  const { blinding } = bs.buyerNoteEcdh({ kit, myKey: buyer.wallet.priv, theirXonly: h2b(offer.sellerXonly), sellerNoteOutpoint: TR_NOTE, amount: 0n });
  const C0 = parseCxferBoundEnvelope(strip(offer.payload)).commitments[0];
  ok(blinding === t.buyerNote.blinding && bytesToHex(pointToBytes(pedersenCommit(V, blinding))) === strip(C0),
    'the buyer\'s key and the seller\'s x-only key alone give the note\'s blinding again, and it opens the note to the whole amount');
  ok(env.inputs.length === 2 && strip(env.inputs[1].txid) === strip(TR_NOTE.txid), 'the reveal spends the commit and the seller\'s note, nothing else');
});

await section('the one-round swap (P2WPKH note), the seller\'s signature reused on the real commit', async () => {
  const offer = offerOf(WPKH_NOTE);
  ok(offer.kind === 'p2wpkh' && offer.witness.length === 2 && h2b(offer.witness[0]).at(-1) === 0x81, 'a P2WPKH note is signed BIP-143 ALL|ANYONECANPAY');
  const t = take(offer, WPKH_NOTE, { fundingUtxo: coin('fund-wpkh', BUYER_WPKH) });
  tacit.clearValidatorCaches();
  const f = async (id) => ({ [etchWpkh.txid]: etchWpkh.esplora, [t.revealTxid]: esploraOf(t.revealHex) })[id] || null;
  ok((await validate(f, t.revealTxid, 0)).ok, 'funded from P2WPKH, the buyer\'s note validates on Bitcoin');
});

await section('an offer that does not check is refused before anything is spent', async () => {
  const offer = offerOf(TR_NOTE);
  const reasonsOf = (o, exp = expectedOf(TR_NOTE)) => bs.buyerCheckOffer({ kit, offer: o, buyerKey: buyer.wallet.priv, expected: exp }).reasons;
  ok(reasonsOf({ ...offer, amount: (V - 1n).toString() }).includes('buyer-note-opening'), 'a claimed amount the buyer note does not open to: buyer-note-opening');
  ok(reasonsOf(offer, { ...expectedOf(TR_NOTE), chainBinding: OTHER_BINDING }).includes('wrong-chain-binding'), 'checked against another deployment: wrong-chain-binding');
  ok(reasonsOf(offerOf(TR_NOTE, { chainBinding: OTHER_BINDING })).includes('wrong-chain-binding'), 'a payload naming another deployment: wrong-chain-binding');
  ok(reasonsOf(offer, { ...expectedOf(TR_NOTE), assetId: '0x' + '11'.repeat(32) }).includes('wrong-asset'), 'another asset: wrong-asset');
  ok(reasonsOf(offer, { ...expectedOf(TR_NOTE), sellerNoteCommitment: pedersenCommit(V, R_S + 1n).toRawBytes(true) }).includes('kernel'), 'a note commitment the kernel does not spend: kernel');
  const otherBuyer = bs.sellerOffer({ prims: seller, kit, assetId: TR_NOTE.asset, sellerNote: TR_NOTE, buyerXonly: bs.xonlyOf(scalar('someone-else')), chainBinding: CHAIN_BINDING, sellerPayoutScript: PAYOUT, priceSats: PRICE });
  ok(reasonsOf(otherBuyer).includes('buyer-note-script'), 'an offer made to another buyer: buyer-note-script');
  ok(reasonsOf({ ...offer, sellerPub: bytesToHex(buyer.wallet.pub) }).some((r) => r === 'seller-key' || r === 'seller-note-script' || r === 'change-script'), 'a seller key that is not the note\'s: refused');
  ok(throws(() => take({ ...offer, priceSats: PRICE + 1 }, TR_NOTE), /does not verify|signature/), 'a price changed after the seller signed: the seller\'s signature no longer verifies');
  ok(throws(() => take({ ...offer, payoutScript: bytesToHex(bs.p2trScriptOf(bs.xonlyOf(scalar('thief')))) }, TR_NOTE), /does not verify|signature/), 'a payout redirected after the seller signed: refused');
  // a seller signature that is SIGHASH_ALL (not ANYONECANPAY), made over a placeholder commit, does not survive the real commit
  const rv = { version: 2, locktime: 0, inputs: [{ txid: '00'.repeat(32), vout: 0, sequence: 0xfffffffd, witness: [] }, { txid: TR_NOTE.txid, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: bs.revealOutputs({ prims: seller, noteScripts: offer.noteScripts, sellerPayoutScript: PAYOUT, priceSats: PRICE }) };
  const all = bs.sellerSign({ prims: seller, reveal: rv, prevouts: [{ value: 0, script: new Uint8Array(34) }, TR_NOTE], kind: 'taproot', sighash: 0x01 });
  ok(throws(() => take({ ...offer, witness: all.witness.map(bytesToHex) }, TR_NOTE), /does not verify/), 'a SIGHASH_ALL signature made before the commit does not verify on the real reveal (why the offer is ANYONECANPAY)');
  ok(throws(() => bs.sellerSign({ prims: seller, reveal: rv, prevouts: [{ value: 0, script: new Uint8Array(34) }, TR_NOTE], kind: 'taproot', sighash: 0x83 }), /leaves outputs free/), 'the seller cannot sign SINGLE|ANYONECANPAY (it would not fold)');
});

console.log(`\n${passed} bound-swap-offer checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
