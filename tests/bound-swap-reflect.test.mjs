// An interactive atomic swap of a bridged pool token for sats, built on the generation-bound transfer T_CXFER_BOUND (0x39)
// by dapp/bound-swap.js, as the reflection and the Bitcoin validator each see it. No network, no funds: the module builds
// real transactions with the wallet's own BIP-341 helpers, and they are fed to the reflection's JS mirror
// (confidential-reflection-scan-indexer.js over confidential-pool.js assembleReflectionScanInput, the guest's fold) and
// to the dapp's tacit.validateOutpoint.
//
//   commit  the BUYER (a watchtower bid key) funds it from a sats UTXO; its Taproot output carries the 0x39 envelope and
//           the buyer's change stays in the commit
//   reveal  vin[0] = commit:0 (buyer, script path), vin[1] = the SELLER's live unbound note (key path)
//           vout[0] buyer note, vout[1] seller change note (the payload's 0x39 outputs, identity layout), vout[2] the
//           seller's sats payout (not a payload output)
//
// What it shows:
//   1  the mirror folds the swap for a non-TAC asset when the seller signs SIGHASH_ALL (0x01), ALL|ANYONECANPAY (0x81) or
//      SIGHASH_DEFAULT (a 64-byte key-path signature): two bound notes onboard, the seller's note nullified
//   2  SINGLE|ANYONECANPAY (0x83) leaves the other outputs free, so nothing onboards (and the seller's note still leaves
//      the live set): a TAC-style resting ask cannot carry a bridged token. The module refuses to make or take one.
//   3  a payload naming another deployment's chain binding folds nothing
//   4  the same transfer as a TAC-style 0x26 sale or 0x22 transfer of the non-TAC asset folds nothing (only TAC folds there);
//      the module refuses those opcodes, so these reveals are put together here from its payload's parts
//   5  the Bitcoin validator accepts the buyer-funded reveal [commit, seller note] (the mirror folds the identical bytes),
//      and refuses a reveal that adds a plain sats input (0x39 counts every vin[1..] as a note) though the mirror folds it
//
// The Bitcoin side uses an etched note in place of a cross-out mint: the validator's 0x39 branch reads either through
// getParentEnvelopeData (asset id + commitment), and an etch needs no Ethereum state to validate offline.
//   node tests/bound-swap-reflect.test.mjs

import { createHash } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32, signSchnorr, verifySchnorr, pedersenCommit } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx, parseCxferBoundEnvelope, inputFirstWitnessItem, sigBindsAllOutputs } from '../dapp/burn-deposit-bitcoin.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import * as bs from '../dapp/bound-swap.js';
import { fetched, tacit, te, scalar, etchNote, validate, NOTE_VALUE } from './lib/btc-sim.mjs';

const sha = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const h2b = (h) => hexToBytes(String(h).replace(/^0x/, ''));
const h0x = (b) => '0x' + bytesToHex(b);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ok - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } };
const section = async (title, fn) => {
  console.log(`\n# ${title}`);
  try { await fn(); } catch (e) { failed++; console.log(`  FAIL - ${title} threw\n${e.stack}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// ---- the deployment the validator (signet build) and the mirror both name -------------------------------------------
const dep = getConfidentialDeployment('signet');
const CHAIN_BINDING = h0x(keccak_256(h2b(BigInt(dep.chainId).toString(16).padStart(64, '0') + strip(dep.pool))));
const OTHER_BINDING = h0x(keccak_256(te('another pool deployment')));

// Ethereum as the validator reads it for a bound output: the pool's nullifier map, here with nothing spent.
const ethReads = [];
const offline = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const body = String(init?.body || '');
  if (init?.method !== 'POST' || !body.includes('eth_getStorageAt')) return offline(input, init);
  const req = JSON.parse(body);
  ethReads.push(req.params);
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: word(0) }), { headers: { 'content-type': 'application/json' } });
};

// ---- parties, assets, amounts --------------------------------------------------------------------------------------
const walletOf = (tag) => makeBtcWallet({ priv: bigintToBytes32(scalar(tag)), hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1 }).prims;
const buyer = walletOf('watchtower-bid-key'), seller = walletOf('seller-note-key');
const kit = tacitKit(tacit);
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const SPX = '0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48';  // a bridged pool token (cross-out minted)
const BUYER_SPK = buyer.p2trScript(buyer.wallet.xonly()), SELLER_SPK = seller.p2trScript(seller.wallet.xonly());
const SELLER_PAY_SPK = bs.p2trScriptOf(bs.xonlyOf(scalar('seller-sats')));
const SELLER_AUTH = h0x(seller.wallet.xonly());

const V = 1000n, BUY = 600n;                                 // the seller's note and the buyer's part (the seller keeps 400)
const R_S = scalar('seller-note-blinding');
const C_IN = pedersenCommit(V, R_S), A_IN = C_IN.toAffine();
const PRICE = 50_000, FEE_RATE = 2, TOPUP = 30_000;
const BUYER_FUNDING = { txid: bytesToHex(sha(te('buyer-funding'))), vout: 0, value: 100_000, script: BUYER_SPK };

// The seller's live unbound notes: an SPX cross-out mint for the mirror, an etched asset for the Bitcoin validator.
const CROSSOUT = { txid: bytesToHex(sha(te('crossout-mint/spx'))), vout: 0, value: NOTE_VALUE, script: SELLER_SPK };
const etch = etchNote({ ticker: 'SWP', value: V, r: R_S, script: SELLER_SPK, signerD: scalar('etcher') });
const ETCHED = { txid: etch.txid, vout: 0, value: NOTE_VALUE, script: SELLER_SPK };
const ETCH_ASSET = h0x(etch.asset);

// ---- the swap, through the module --------------------------------------------------------------------------------------
// The buyer's note secrets (its own change channel at the seller's note), the seller's payload, the buyer's commit and
// unsigned reveal; then `finish(h)` has the seller sign with sighash h and the buyer complete vin[0].
function trade({ asset, note, chainBinding = CHAIN_BINDING }) {
  const secrets = bs.buyerNoteSecrets({ kit, buyerKey: buyer.wallet.priv, sellerNoteOutpoint: note, amount: BUY });
  const offer = bs.sellerPayload({
    prims: seller, kit, assetId: asset, chainBinding, toBuyer: BUY,
    sellerNote: { txid: note.txid, vout: note.vout, amount: V, blinding: R_S, cx: A_IN.x, cy: A_IN.y },
    buyerXonly: secrets.buyerXonly, buyerBlinding: secrets.buyerBlinding, buyerAmountCt: secrets.buyerAmountCt,
  });
  const swap = bs.buyerTxs({ prims: buyer, payload: offer.payload, noteScripts: offer.noteScripts, fundingUtxo: BUYER_FUNDING, sellerNote: note, sellerPayoutScript: SELLER_PAY_SPK, priceSats: PRICE, feeRate: FEE_RATE });
  const expect = { sellerNote: note, noteScripts: offer.noteScripts, payoutScript: SELLER_PAY_SPK, priceSats: PRICE, payload: offer.payload, buyerXonly: secrets.buyerXonly };
  const finish = (sighash) => {
    const { witness } = bs.sellerSign({ prims: seller, reveal: swap.toSign.reveal, prevouts: swap.toSign.prevouts, kind: 'taproot', sighash, expect });
    return bs.buyerFinish({ prims: buyer, swap, sellerWitness: witness });
  };
  return { secrets, offer, swap, finish };
}
// A finished reveal with the seller's witness replaced (a witness is not part of the txid, so vin[0]'s signature stands).
const withSellerWitness = (fin, witness) => {
  const tx = { ...fin.revealTx, inputs: fin.revealTx.inputs.map((i, k) => ({ ...i, witness: k === 1 ? witness : i.witness })) };
  return { ...fin, revealTx: tx, revealHex: bytesToHex(buyer.serializeTx(tx)) };
};
const rowsOf = (...hexes) => hexes.map((h) => { const t = bs.parseTx(h); return { txid: t.txid, hex: strip(h), vins: t.inputs.map((i) => ({ txid: i.txid, vout: i.vout })) }; });
const esploraOf = (hex) => {
  const t = bs.parseTx(hex);
  return { txid: t.txid, status: { confirmed: true, block_height: 330001 }, vin: t.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })), vout: t.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })) };
};
const sellerSig83 = (fin, prevouts) => {
  const sig = signSchnorr(seller.tapSighashKeyPath(fin.revealTx, 1, prevouts, 0x83), seller.wallet.priv);
  return [Uint8Array.from([...sig, 0x83])];
};

// ---- the reflection mirror -----------------------------------------------------------------------------------------
// A fresh scan state holding the seller's note as a live UNBOUND entry (what folding its cross-out mint leaves), then
// one block [commit, reveal] through the indexer and the classifier, with the deployment's chain binding.
async function reflect(rows, { asset, note, chainBinding = CHAIN_BINDING }) {
  const ix = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256: nobleSha256 });
  const cp = ix.pool, norm = (x) => cp._internal.hx(cp._internal.b32(x));
  const cx = word(A_IN.x), cy = word(A_IN.y);
  const key = cp.outpointKey('0x' + rev(note.txid), note.vout);
  ix.state()._acc.live.insert(key, cp.commitmentHash(cx, cy), asset, SELLER_AUTH);
  ix.coords().set(norm(key), { cx, cy });
  const before = ix.state().counts();
  const input = await ix.assembleBlocks([{ txs: rows.map((t) => ({ txidDisplay: t.txid, rawHex: t.hex, decode: classifyConfidentialTx('0x' + t.hex), vins: t.vins.map((i) => ({ prevTxidDisplay: i.txid, vout: i.vout })) })) }],
    { headers: [], anchorHeight: 100, chainBinding });
  const after = ix.state().counts();
  const k = (txid, vout) => cp.outpointKey('0x' + rev(txid), vout);
  const live = (txid, vout) => ix.state()._acc.live.get(k(txid, vout)) != null;
  const bound = (txid, vout) => ix.state()._acc.live.boundTag(k(txid, vout));
  return { folded: input.blocks[0].txs.map((t) => t.outputs.length), skipped: input.nonConserving, before, after, live, bound };
}

const foldedSwap = (r, txid, note) => r.folded[0] === 0 && r.folded[1] === 2
  && r.live(txid, 0) && r.live(txid, 1) && !r.live(txid, 2)
  && r.bound(txid, 0) === 1 && r.bound(txid, 1) === 1
  && !r.live(note.txid, note.vout)
  && r.after.live === r.before.live - 1 + 2 && r.after.note === r.before.note + 2 && r.after.spent === r.before.spent + 1;
const skippedSwap = (r, txid, note, reason) => r.folded[1] === 0
  && !r.live(txid, 0) && !r.live(txid, 1)
  && !r.live(note.txid, note.vout) && r.after.live === r.before.live - 1 && r.after.note === r.before.note && r.after.spent === r.before.spent + 1
  && r.skipped.length === 1 && r.skipped[0].reason === reason;

// ---- 1 + 2: the seller's signature -----------------------------------------------------------------------------------
const spx = trade({ asset: SPX, note: CROSSOUT });
const spxAll = spx.finish(0x01);
await section('1. the mirror folds the 0x39 swap of a non-TAC asset (SPX) when the seller\'s signature binds every output', async () => {
  const d = classifyConfidentialTx('0x' + spxAll.revealHex);
  ok(d && d.type === 'cxfer_bound' && strip(d.assetId) === strip(SPX) && strip(d.target) === strip(CHAIN_BINDING) && d.vouts.join() === '0,1',
    'the reveal classifies as cxfer_bound for SPX, naming the deployment, payload outputs at vout 0 and 1 (identity layout)');
  for (const [h, label] of [[0x01, 'SIGHASH_ALL (0x01)'], [0x81, 'SIGHASH_ALL|ANYONECANPAY (0x81)'], [0x00, 'a 64-byte key-path signature (SIGHASH_DEFAULT)']]) {
    const fin = spx.finish(h);
    const item = inputFirstWitnessItem('0x' + fin.revealHex, 1);
    ok(item && item.length === (h ? 65 : 64) && verifySchnorr(item.subarray(0, 64), seller.tapSighashKeyPath(fin.revealTx, 1, spx.swap.prevouts, h), seller.wallet.xonly()) && sigBindsAllOutputs(item),
      `seller ${label}: a real BIP-341 key-path signature, read by the destination binding as binding all outputs`);
    const r = await reflect(rowsOf(fin.commitHex, fin.revealHex), { asset: SPX, note: CROSSOUT });
    ok(foldedSwap(r, fin.revealTxid, CROSSOUT),
      `seller ${label}: folds [commit 0, reveal 2]; buyer note (vout 0) and seller change note (vout 1) live as BOUND notes, the sats payout (vout 2) is not, the seller's note is nullified (live ${r.before.live}->${r.after.live}, notes +${r.after.note - r.before.note}, spent +${r.after.spent - r.before.spent})`);
  }
  const s = spx.swap, c = s.commitTx;
  const commitValue = 2 * buyer.DUST + PRICE + s.revealFee - NOTE_VALUE;
  ok(c.outputs[0].value === commitValue && c.outputs[1].value === BUYER_FUNDING.value - commitValue - s.commitFee && bytesToHex(c.outputs[1].script) === bytesToHex(BUYER_SPK) && s.reveal.outputs[2].value === PRICE,
    `the buyer funds the whole reveal from the commit (payout ${PRICE} sats + one dust note + ${s.revealFee} fee), the buyer's change (${c.outputs[1].value}) stays in the commit`);
});

await section('2. SINGLE|ANYONECANPAY (0x83) leaves the outputs free: the fold skips', async () => {
  const w83 = sellerSig83(spxAll, spx.swap.prevouts);
  const fin = withSellerWitness(spxAll, w83);
  const item = inputFirstWitnessItem('0x' + fin.revealHex, 1);
  const refused = throws(() => bs.sellerSign({ prims: seller, reveal: spx.swap.toSign.reveal, prevouts: spx.swap.toSign.prevouts, kind: 'taproot', sighash: 0x83 }), /leaves outputs free/)
    && throws(() => bs.buyerFinish({ prims: buyer, swap: spx.swap, sellerWitness: w83 }), /leaves outputs free/);
  ok(refused && item && item.length === 65 && item[64] === 0x83 && verifySchnorr(item.subarray(0, 64), seller.tapSighashKeyPath(fin.revealTx, 1, spx.swap.prevouts, 0x83), seller.wallet.xonly()) && !sigBindsAllOutputs(item),
    'seller 0x83: a real signature that commits to its own input and output 1 only, so it does not bind the outputs (sellerSign will not make it, buyerFinish will not take it)');
  const r = await reflect(rowsOf(fin.commitHex, fin.revealHex), { asset: SPX, note: CROSSOUT });
  ok(skippedSwap(r, fin.revealTxid, CROSSOUT, 'unbound-destination'),
    `seller 0x83: nothing onboards (reason ${r.skipped[0]?.reason}), and the seller's note still leaves the live set (live ${r.before.live}->${r.after.live}): a TAC-style resting ask cannot carry a bridged token`);
});

// ---- 3: the target --------------------------------------------------------------------------------------------------
await section('3. a payload naming another deployment folds nothing', async () => {
  const fin = trade({ asset: SPX, note: CROSSOUT, chainBinding: OTHER_BINDING }).finish(0x01);
  const r = await reflect(rowsOf(fin.commitHex, fin.revealHex), { asset: SPX, note: CROSSOUT });
  ok(skippedSwap(r, fin.revealTxid, CROSSOUT, 'wrong-chain-binding'), `target_chain_binding != the deployment's: skipped (reason ${r.skipped[0]?.reason}) though the seller signed 0x01 and the kernel is valid`);
  const r2 = await reflect(rowsOf(spxAll.commitHex, spxAll.revealHex), { asset: SPX, note: CROSSOUT, chainBinding: OTHER_BINDING });
  ok(skippedSwap(r2, spxAll.revealTxid, CROSSOUT, 'wrong-chain-binding'), 'and the right payload read by a reflection of another deployment is skipped the same way');
});

// ---- 4: the legacy opcodes ------------------------------------------------------------------------------------------
// The module builds 0x39 only (buyerTxs refuses any other payload), so a legacy-opcode reveal is put together here from
// its payload's parts (same kernel, commitments and range proof) and signed by the module's sellerSign.
function legacyReveal(offer, payload) {
  const script = buyer.encodeEnvelopeScript(buyer.wallet.xonly(), payload);
  const leaf = buyer.tapLeafHash(script);
  const { Q_xonly, parity } = buyer.tweakedOutputKey(buyer.TAP_NUMS, leaf);
  const commitSpk = buyer.p2trScript(Q_xonly);
  const commit = { version: 2, locktime: 0, inputs: [{ txid: BUYER_FUNDING.txid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: PRICE + 2000, script: commitSpk }] };
  commit.inputs[0].witness = [signSchnorr(buyer.tapSighashKeyPath(commit, 0, [BUYER_FUNDING], 0x00), buyer.wallet.priv)];
  const reveal = {
    version: 2, locktime: 0,
    inputs: [{ txid: buyer.txid(commit), vout: 0, sequence: 0xfffffffd, witness: [] }, { txid: CROSSOUT.txid, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [...offer.noteScripts.map((s) => ({ value: buyer.DUST, script: s })), { value: PRICE, script: SELLER_PAY_SPK }],
  };
  const prevouts = [{ value: PRICE + 2000, script: commitSpk }, CROSSOUT];
  reveal.inputs[1].witness = bs.sellerSign({ prims: seller, reveal, prevouts, kind: 'taproot', sighash: 0x01 }).witness;
  reveal.inputs[0].witness = [signSchnorr(buyer.tapSighash(reveal, 0, prevouts, leaf, 0x00), buyer.wallet.priv), script, buyer.controlBlock(buyer.TAP_NUMS, parity)];
  return { txid: buyer.txid(reveal), rows: rowsOf(bytesToHex(buyer.serializeTx(commit)), bytesToHex(buyer.serializeTx(reveal))) };
}
const partsOf = (asset, offer) => {
  const d = parseCxferBoundEnvelope(bytesToHex(offer.payload));
  return { assetId: h2b(asset), kernelSig: h2b(d.kernelSig), outputs: d.commitments.map((c) => ({ commitment: h2b(c), encryptedAmount: new Uint8Array(8) })), rangeproof: h2b(d.rangeProof) };
};
await section('4. the same transfer as a TAC-style 0x26 sale or 0x22 transfer of SPX folds nothing (legacy gate)', async () => {
  const parts = partsOf(SPX, spx.offer);
  for (const [payload, op, label] of [[tacit.encodeAxferPayload({ ...parts, assetInputCount: 1 }), 0x26, '0x26 atomic sale'], [tacit.encodeCXferBppPayload(parts), 0x22, '0x22 transfer']]) {
    const lr = legacyReveal(spx.offer, payload);
    const d = classifyConfidentialTx('0x' + lr.rows[1].hex);
    const r = await reflect(lr.rows, { asset: SPX, note: CROSSOUT });
    ok(d && d.type === 'cxfer' && d.opcode === op && skippedSwap(r, lr.txid, CROSSOUT, 'non-legacy-asset'),
      `${label} of SPX, seller 0x01, same kernel and range proof: skipped (reason ${r.skipped[0]?.reason})`);
  }
  // Control: the same 0x22 shape for TAC folds, so the skip above is the asset gate and nothing else in the construction.
  const tacOffer = trade({ asset: TAC, note: CROSSOUT }).offer;
  const lr = legacyReveal(tacOffer, tacit.encodeCXferBppPayload(partsOf(TAC, tacOffer)));
  const r = await reflect(lr.rows, { asset: TAC, note: CROSSOUT });
  ok(r.folded[1] === 2 && r.live(lr.txid, 0) && r.live(lr.txid, 1) && r.bound(lr.txid, 0) === 0 && r.skipped.length === 0,
    'control: the identical 0x22 shape for TAC folds (two UNBOUND notes), so the SPX skip is the legacy asset gate');
});

// ---- 5: the Bitcoin side ----------------------------------------------------------------------------------------------
await section('5. Bitcoin side: the real validator on the buyer-funded reveal, and on a reveal with a plain sats input', async () => {
  tacit.clearValidatorCaches();
  const t = trade({ asset: ETCH_ASSET, note: ETCHED });
  const fin = t.finish(0x01);
  const expected = {
    assetId: ETCH_ASSET, amountToBuyer: BUY, buyerXonly: t.secrets.buyerXonly, buyerBlinding: t.secrets.buyerBlinding, sellerPayoutScript: SELLER_PAY_SPK,
    priceSats: PRICE, chainBinding: CHAIN_BINDING, sellerNoteOutpoint: ETCHED, sellerNoteCommitment: C_IN.toRawBytes(true),
  };
  const fetchTx = async (id) => ({ [etch.txid]: etch.esplora, [fin.revealTxid]: esploraOf(fin.revealHex) })[id] || null;
  const v0 = await validate(fetchTx, fin.revealTxid, 0);
  const v1 = await validate(fetchTx, fin.revealTxid, 1);
  const v2 = await validate(fetchTx, fin.revealTxid, 2);
  const vf = bs.verifyBoundSwap({ revealHex: fin.revealHex, commitHex: fin.commitHex, expected });
  ok(v0.ok === true && v1.ok === true && vf.ok,
    `reveal [commit, seller's etched note]: the buyer's note (vout 0) and the seller's change note (vout 1) are valid notes (${JSON.stringify(v0)}, ${JSON.stringify(v1)}), and verifyBoundSwap passes it (${JSON.stringify(vf)})`);
  ok(v2.ok === false, 'the sats payout (vout 2) is not a note');
  ok(ethReads.length >= 2 && ethReads.every(([to]) => strip(to) === strip(dep.pool)) && fetched.length === 0,
    `each bound output was checked unspent in the pool its payload names (${ethReads.length} reads of ${dep.pool}), nothing else read from the network`);
  const r = await reflect(rowsOf(fin.commitHex, fin.revealHex), { asset: ETCH_ASSET, note: ETCHED });
  ok(foldedSwap(r, fin.revealTxid, ETCHED), 'the mirror folds the identical bytes the validator accepted: both bound notes onboard, the etched note nullified');

  // A plain sats UTXO of the buyer's, made by an ordinary P2WPKH-funded transaction, added to the REVEAL as vin[2] (the
  // module never builds this: here its reveal is extended by hand, the seller re-signs it, and the buyer signs vin[2]).
  const topupParent = {
    txid: bytesToHex(sha(te('buyer-topup-parent'))), status: { confirmed: true, block_height: 329990 },
    vin: [{ txid: bytesToHex(sha(te('p2wpkh-coin'))), vout: 0, witness: [bytesToHex(Uint8Array.from([0x30, 0x44, ...new Uint8Array(68).fill(7), 0x01])), bytesToHex(buyer.wallet.pub)], prevout: { scriptpubkey_type: 'v0_p2wpkh' } }],
    vout: [{ scriptpubkey: bytesToHex(BUYER_SPK), value: TOPUP }],
  };
  const topup = { txid: topupParent.txid, vout: 0, value: TOPUP, script: BUYER_SPK };
  const xReveal = { ...t.swap.reveal, inputs: [...t.swap.reveal.inputs, { txid: topup.txid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [...t.swap.reveal.outputs, { value: TOPUP - 300, script: BUYER_SPK }] };
  const x = { ...t.swap, reveal: xReveal, prevouts: [...t.swap.prevouts, topup] };
  const xf = bs.buyerFinish({ prims: buyer, swap: x, sellerWitness: bs.sellerSign({ prims: seller, reveal: xReveal, prevouts: x.prevouts, kind: 'taproot', sighash: 0x01 }).witness });
  xf.revealTx.inputs[2].witness = [signSchnorr(buyer.tapSighashKeyPath(xf.revealTx, 2, x.prevouts, 0x00), buyer.wallet.priv)];
  const xHex = bytesToHex(buyer.serializeTx(xf.revealTx));
  tacit.clearValidatorCaches();
  const fx = async (id) => ({ [etch.txid]: etch.esplora, [xf.revealTxid]: esploraOf(xHex), [topup.txid]: topupParent })[id] || null;
  const x0 = await validate(fx, xf.revealTxid, 0);
  const x1 = await validate(fx, xf.revealTxid, 1);
  const xv = bs.verifyBoundSwap({ revealHex: xHex, commitHex: xf.commitHex, expected });
  ok(x0.ok === false && x0.reason === 'invalid' && x1.ok === false && xv.reasons.includes('extra-inputs'),
    `reveal [commit, seller note, plain sats input]: invalid on Bitcoin (${JSON.stringify(x0)}): 0x39 requires every vin[1..] to be a validated note and counts each in the kernel; verifyBoundSwap refuses it (${xv.reasons})`);
  const rx = await reflect(rowsOf(xf.commitHex, xHex), { asset: ETCH_ASSET, note: ETCHED });
  ok(foldedSwap(rx, xf.revealTxid, ETCHED), 'yet the mirror folds it (it ignores non-live inputs and its kernel covers the live note only): the buyer must fund through the commit (vin[0]), never a reveal input');
});

await section('6. a PINNED offer (a part, the seller signing SIGHASH_ALL over the pair it built, change at its P2WPKH) folds', async () => {
  const wpkh = buyer.p2wpkhScript(buyer.wallet.pub);
  const offer = bs.sellerPinnedOffer({ prims: seller, kit, assetId: SPX, chainBinding: CHAIN_BINDING, toBuyer: BUY, buyerPub: buyer.wallet.pub, feeRate: FEE_RATE,
    fund: { ...BUYER_FUNDING, script: wpkh }, sellerPayoutScript: SELLER_PAY_SPK, priceSats: PRICE,
    sellerNote: { ...CROSSOUT, amount: V, blinding: R_S, cx: A_IN.x, cy: A_IN.y } });
  const t = bs.buyerTakeOffer({ prims: buyer, kit, offer, fundingUtxo: null, feeRate: 1, maxFeeRate: 25, expected: { assetId: SPX, chainBinding: CHAIN_BINDING, sellerNoteCommitment: C_IN.toRawBytes(true) } });
  ok(t.revealTxid === offer.revealTxid, 'the watchtower rebuilds the pair the seller signed');
  const r = await reflect(rowsOf(t.commitHex, t.revealHex), { asset: SPX, note: CROSSOUT });
  ok(foldedSwap(r, t.revealTxid, CROSSOUT), `folds: the buyer's ${BUY} (vout 0, P2TR) and the seller's ${V - BUY} change (vout 1, P2WPKH) live as BOUND notes, the seller's note nullified (live ${r.before.live}->${r.after.live})`);
});

console.log(`\n${passed} bound-swap-reflect checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
