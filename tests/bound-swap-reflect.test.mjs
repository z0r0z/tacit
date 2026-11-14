// An interactive atomic swap of a bridged pool token for sats, built on the generation-bound transfer T_CXFER_BOUND (0x39),
// as the reflection and the Bitcoin validator each see it. No network, no funds: real transactions are built with the
// wallet's own BIP-341 helpers and fed to the reflection's JS mirror (confidential-reflection-scan-indexer.js over
// confidential-pool.js assembleReflectionScanInput, the guest's fold) and to the dapp's tacit.validateOutpoint.
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
//      the live set): a TAC-style resting ask cannot carry a bridged token
//   3  a payload naming another deployment's chain binding folds nothing
//   4  the same transfer as a TAC-style 0x26 sale or 0x22 transfer of the non-TAC asset folds nothing (only TAC folds there)
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
import { bigintToBytes32, signSchnorr, verifySchnorr, pedersenCommit, modN } from '../dapp/bulletproofs.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx, encodeCxferBoundEnvelope, inputFirstWitnessItem, sigBindsAllOutputs } from '../dapp/burn-deposit-bitcoin.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import { P, fetched, tacit, te, scalar, xonly, etchNote, validate, p2trKey, NOTE_VALUE } from './lib/btc-sim.mjs';
import { bpRangeAggProve } from './bulletproofs.mjs';

const sha = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const h2b = (h) => hexToBytes(String(h).replace(/^0x/, ''));
const h0x = (b) => '0x' + bytesToHex(b);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ok - ${msg}`); } else { failed++; console.log(`  FAIL - ${msg}`); } };
const section = async (title, fn) => {
  console.log(`\n# ${title}`);
  try { await fn(); } catch (e) { failed++; console.log(`  FAIL - ${title} threw\n${e.stack}`); }
};

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
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const SPX = '0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48';  // a bridged pool token (cross-out minted)
const BUYER_D = scalar('watchtower-bid-key'), SELLER_D = scalar('seller-note-key'), SELLER_PAY_D = scalar('seller-sats');
const BUYER_SPK = p2trKey(xonly(BUYER_D)), SELLER_SPK = p2trKey(xonly(SELLER_D)), SELLER_PAY_SPK = p2trKey(xonly(SELLER_PAY_D));
const SELLER_AUTH = h0x(xonly(SELLER_D));

const V = 1000n, BUY = 600n, CHANGE = 400n;                 // the seller's note, the buyer's part, the seller's change
const R_S = scalar('seller-note-blinding'), R_1 = scalar('buyer-note-blinding'), R_2 = scalar('seller-change-blinding');
const C_IN = pedersenCommit(V, R_S), C_1 = pedersenCommit(BUY, R_1).toRawBytes(true), C_2 = pedersenCommit(CHANGE, R_2).toRawBytes(true);
const { proof: RANGE } = bpRangeAggProve([BUY, CHANGE], [R_1, R_2]);  // covers the outputs only, so every variant shares it

const PRICE = 50_000, REVEAL_FEE = 1_200, COMMIT_FEE = 400, TOPUP = 30_000;
const BUYER_FUNDING = { txid: bytesToHex(sha(te('buyer-funding'))), vout: 0, value: 100_000, script: BUYER_SPK };
const COMMIT_OUT = PRICE + NOTE_VALUE + REVEAL_FEE;
const BUYER_CHANGE = BUYER_FUNDING.value - COMMIT_OUT - COMMIT_FEE;

// The seller's live unbound notes: an SPX cross-out mint for the mirror, an etched asset for the Bitcoin validator.
const CROSSOUT = { txid: bytesToHex(sha(te('crossout-mint/spx'))), vout: 0, value: NOTE_VALUE, script: SELLER_SPK };
const etch = etchNote({ ticker: 'SWP', value: V, r: R_S, script: SELLER_SPK, signerD: scalar('etcher') });
const ETCHED = { txid: etch.txid, vout: 0, value: NOTE_VALUE, script: SELLER_SPK };
const ETCH_ASSET = h0x(etch.asset);

// ---- payloads ------------------------------------------------------------------------------------------------------
// The kernel binds the asset, the note inputs (the seller's note only: the commit is not a note) and the two output
// commitments; it signs the excess ΣC_out − ΣC_in = (r1 + r2 − r_s)·G, the amounts conserving (600 + 400 = 1000).
const kernelFor = (asset, notes) => signSchnorr(
  tacit.computeKernelMsg(h2b(asset), notes.map((n) => ({ txid: n.txid, vout: n.vout })), [C_1, C_2], 0n),
  bigintToBytes32(modN(R_1 + R_2 - R_S)),
);
const outs = () => [C_1, C_2].map((commitment) => ({ commitment, encryptedAmount: new Uint8Array(8) }));
const boundPayload = (asset, note, target = CHAIN_BINDING) => h2b(encodeCxferBoundEnvelope({
  target: h2b(target), asset: h2b(asset), kernelSig: kernelFor(asset, [note]),
  outputs: [C_1, C_2].map((commitment) => ({ commitment, amountCt: new Uint8Array(8) })), rangeProof: RANGE,
}));
const salePayload = (asset, note) => tacit.encodeAxferPayload({ assetId: h2b(asset), assetInputCount: 1, kernelSig: kernelFor(asset, [note]), outputs: outs(), rangeproof: RANGE });
const xferPayload = (asset, note) => tacit.encodeCXferBppPayload({ assetId: h2b(asset), kernelSig: kernelFor(asset, [note]), outputs: outs(), rangeproof: RANGE });

// ---- the swap transactions -----------------------------------------------------------------------------------------
// sellerHashType: 0x00 = SIGHASH_DEFAULT (64-byte signature), else the 65-byte signature's trailing byte.
function buildSwap({ payload, note, sellerHashType = 0x01, extraInputs = [], extraOutputs = [] }) {
  const script = P.encodeEnvelopeScript(xonly(BUYER_D), payload);
  const leaf = P.tapLeafHash(script);
  const { Q_xonly, parity } = P.tweakedOutputKey(P.TAP_NUMS, leaf);
  const commitSpk = P.p2trScript(Q_xonly);
  const commit = {
    version: 2, locktime: 0,
    inputs: [{ txid: BUYER_FUNDING.txid, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: COMMIT_OUT, script: commitSpk }, { value: BUYER_CHANGE, script: BUYER_SPK }],
  };
  commit.inputs[0].witness = [signSchnorr(P.tapSighashKeyPath(commit, 0, [BUYER_FUNDING], 0x00), bigintToBytes32(BUYER_D))];
  const reveal = {
    version: 2, locktime: 0,
    inputs: [{ txid: P.txid(commit), vout: 0, sequence: 0xfffffffd, witness: [] },
      { txid: note.txid, vout: note.vout, sequence: 0xfffffffd, witness: [] },
      ...extraInputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 0xfffffffd, witness: [] }))],
    outputs: [{ value: NOTE_VALUE, script: BUYER_SPK }, { value: NOTE_VALUE, script: SELLER_SPK }, { value: PRICE, script: SELLER_PAY_SPK }, ...extraOutputs],
  };
  const prevouts = [{ value: COMMIT_OUT, script: commitSpk }, note, ...extraInputs];
  reveal.inputs[0].witness = [signSchnorr(P.tapSighash(reveal, 0, prevouts, leaf, 0x00), bigintToBytes32(BUYER_D)), script, P.controlBlock(P.TAP_NUMS, parity)];
  const sellerSighash = P.tapSighashKeyPath(reveal, 1, prevouts, sellerHashType);
  const sellerSig = signSchnorr(sellerSighash, bigintToBytes32(SELLER_D));
  reveal.inputs[1].witness = [sellerHashType === 0x00 ? sellerSig : cat(sellerSig, Uint8Array.of(sellerHashType))];
  extraInputs.forEach((i, k) => { reveal.inputs[2 + k].witness = [signSchnorr(P.tapSighashKeyPath(reveal, 2 + k, prevouts, 0x00), bigintToBytes32(BUYER_D))]; });
  const txid = P.txid(reveal);
  const fee = prevouts.reduce((s, p) => s + p.value, 0) - reveal.outputs.reduce((s, o) => s + o.value, 0);
  return {
    txid, commit, reveal, fee, sellerSighash, sellerSig,
    rows: [{ tx: commit, txid: P.txid(commit) }, { tx: reveal, txid }].map(({ tx, txid: id }) => ({ txid: id, hex: bytesToHex(P.serializeTx(tx)), vins: tx.inputs.map((i) => ({ txid: i.txid, vout: i.vout })) })),
    esplora: {
      txid, status: { confirmed: true, block_height: 330001 },
      vin: reveal.inputs.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(bytesToHex) })),
      vout: reveal.outputs.map((o) => ({ scriptpubkey: bytesToHex(o.script), value: o.value })),
    },
  };
}

// ---- the reflection mirror -----------------------------------------------------------------------------------------
// A fresh scan state holding the seller's note as a live UNBOUND entry (what folding its cross-out mint leaves), then
// one block [commit, reveal] through the indexer and the classifier, with the deployment's chain binding.
async function reflect(swap, { asset, note, chainBinding = CHAIN_BINDING }) {
  const ix = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256: nobleSha256 });
  const cp = ix.pool, norm = (x) => cp._internal.hx(cp._internal.b32(x));
  const A = C_IN.toAffine();
  const cx = word(A.x), cy = word(A.y);
  const key = cp.outpointKey('0x' + rev(note.txid), note.vout);
  ix.state()._acc.live.insert(key, cp.commitmentHash(cx, cy), asset, SELLER_AUTH);
  ix.coords().set(norm(key), { cx, cy });
  const before = ix.state().counts();
  const input = await ix.assembleBlocks([{ txs: swap.rows.map((t) => ({ txidDisplay: t.txid, rawHex: t.hex, decode: classifyConfidentialTx('0x' + t.hex), vins: t.vins.map((i) => ({ prevTxidDisplay: i.txid, vout: i.vout })) })) }],
    { headers: [], anchorHeight: 100, chainBinding });
  const after = ix.state().counts();
  const k = (txid, vout) => cp.outpointKey('0x' + rev(txid), vout);
  const live = (txid, vout) => ix.state()._acc.live.get(k(txid, vout)) != null;
  const bound = (txid, vout) => ix.state()._acc.live.boundTag(k(txid, vout));
  return { folded: input.blocks[0].txs.map((t) => t.outputs.length), skipped: input.nonConserving, before, after, live, bound };
}

const foldedSwap = (r, swap, note) => r.folded[0] === 0 && r.folded[1] === 2
  && r.live(swap.txid, 0) && r.live(swap.txid, 1) && !r.live(swap.txid, 2)
  && r.bound(swap.txid, 0) === 1 && r.bound(swap.txid, 1) === 1
  && !r.live(note.txid, note.vout)
  && r.after.live === r.before.live - 1 + 2 && r.after.note === r.before.note + 2 && r.after.spent === r.before.spent + 1;
const skippedSwap = (r, swap, note, reason) => r.folded[1] === 0
  && !r.live(swap.txid, 0) && !r.live(swap.txid, 1)
  && !r.live(note.txid, note.vout) && r.after.live === r.before.live - 1 && r.after.note === r.before.note && r.after.spent === r.before.spent + 1
  && r.skipped.length === 1 && r.skipped[0].reason === reason;

// ---- 1 + 2: the seller's signature -----------------------------------------------------------------------------------
const spxPayload = boundPayload(SPX, CROSSOUT);
await section('1. the mirror folds the 0x39 swap of a non-TAC asset (SPX) when the seller\'s signature binds every output', async () => {
  const d = classifyConfidentialTx('0x' + buildSwap({ payload: spxPayload, note: CROSSOUT }).rows[1].hex);
  ok(d && d.type === 'cxfer_bound' && strip(d.assetId) === strip(SPX) && strip(d.target) === strip(CHAIN_BINDING) && d.vouts.join() === '0,1',
    'the reveal classifies as cxfer_bound for SPX, naming the deployment, payload outputs at vout 0 and 1 (identity layout)');
  for (const [h, label] of [[0x01, 'SIGHASH_ALL (0x01)'], [0x81, 'SIGHASH_ALL|ANYONECANPAY (0x81)'], [0x00, 'a 64-byte key-path signature (SIGHASH_DEFAULT)']]) {
    const swap = buildSwap({ payload: spxPayload, note: CROSSOUT, sellerHashType: h });
    const item = inputFirstWitnessItem('0x' + bytesToHex(P.serializeTx(swap.reveal)), 1);
    ok(item && item.length === (h ? 65 : 64) && verifySchnorr(swap.sellerSig, swap.sellerSighash, xonly(SELLER_D)) && sigBindsAllOutputs(item),
      `seller ${label}: a real BIP-341 key-path signature, read by the destination binding as binding all outputs`);
    const r = await reflect(swap, { asset: SPX, note: CROSSOUT });
    ok(foldedSwap(r, swap, CROSSOUT),
      `seller ${label}: folds [commit 0, reveal 2]; buyer note (vout 0) and seller change note (vout 1) live as BOUND notes, the sats payout (vout 2) is not, the seller's note is nullified (live ${r.before.live}->${r.after.live}, notes +${r.after.note - r.before.note}, spent +${r.after.spent - r.before.spent})`);
  }
  const s = buildSwap({ payload: spxPayload, note: CROSSOUT });
  ok(s.fee === REVEAL_FEE && s.commit.outputs[1].value === BUYER_CHANGE && s.commit.outputs[1].script === BUYER_SPK,
    `the buyer funds the whole reveal from the commit (payout ${PRICE} sats + one dust note + ${REVEAL_FEE} fee), the buyer's change (${BUYER_CHANGE}) stays in the commit`);
});

await section('2. SINGLE|ANYONECANPAY (0x83) leaves the outputs free: the fold skips', async () => {
  const swap = buildSwap({ payload: spxPayload, note: CROSSOUT, sellerHashType: 0x83 });
  const item = inputFirstWitnessItem('0x' + bytesToHex(P.serializeTx(swap.reveal)), 1);
  ok(item && item.length === 65 && item[64] === 0x83 && verifySchnorr(swap.sellerSig, swap.sellerSighash, xonly(SELLER_D)) && !sigBindsAllOutputs(item),
    'seller 0x83: a real signature that commits to its own input and output 1 only, so it does not bind the outputs');
  const r = await reflect(swap, { asset: SPX, note: CROSSOUT });
  ok(skippedSwap(r, swap, CROSSOUT, 'unbound-destination'),
    `seller 0x83: nothing onboards (reason ${r.skipped[0]?.reason}), and the seller's note still leaves the live set (live ${r.before.live}->${r.after.live}): a TAC-style resting ask cannot carry a bridged token`);
});

// ---- 3: the target --------------------------------------------------------------------------------------------------
await section('3. a payload naming another deployment folds nothing', async () => {
  const swap = buildSwap({ payload: boundPayload(SPX, CROSSOUT, OTHER_BINDING), note: CROSSOUT, sellerHashType: 0x01 });
  const r = await reflect(swap, { asset: SPX, note: CROSSOUT });
  ok(skippedSwap(r, swap, CROSSOUT, 'wrong-chain-binding'), `target_chain_binding != the deployment's: skipped (reason ${r.skipped[0]?.reason}) though the seller signed 0x01 and the kernel is valid`);
  const same = buildSwap({ payload: spxPayload, note: CROSSOUT, sellerHashType: 0x01 });
  const r2 = await reflect(same, { asset: SPX, note: CROSSOUT, chainBinding: OTHER_BINDING });
  ok(skippedSwap(r2, same, CROSSOUT, 'wrong-chain-binding'), 'and the right payload read by a reflection of another deployment is skipped the same way');
});

// ---- 4: the legacy opcodes ------------------------------------------------------------------------------------------
await section('4. the same transfer as a TAC-style 0x26 sale or 0x22 transfer of SPX folds nothing (legacy gate)', async () => {
  for (const [mk, label] of [[salePayload, '0x26 atomic sale'], [xferPayload, '0x22 transfer']]) {
    const swap = buildSwap({ payload: mk(SPX, CROSSOUT), note: CROSSOUT, sellerHashType: 0x01 });
    const d = classifyConfidentialTx('0x' + swap.rows[1].hex);
    const r = await reflect(swap, { asset: SPX, note: CROSSOUT });
    ok(d && d.type === 'cxfer' && d.opcode === (label.startsWith('0x26') ? 0x26 : 0x22) && skippedSwap(r, swap, CROSSOUT, 'non-legacy-asset'),
      `${label} of SPX, seller 0x01, same kernel and range proof: skipped (reason ${r.skipped[0]?.reason})`);
  }
  // Control: the same 0x22 shape for TAC folds, so the skip above is the asset gate and nothing else in the construction.
  const tac = buildSwap({ payload: xferPayload(TAC, CROSSOUT), note: CROSSOUT, sellerHashType: 0x01 });
  const r = await reflect(tac, { asset: TAC, note: CROSSOUT });
  ok(r.folded[1] === 2 && r.live(tac.txid, 0) && r.live(tac.txid, 1) && r.bound(tac.txid, 0) === 0 && r.skipped.length === 0,
    'control: the identical 0x22 shape for TAC folds (two UNBOUND notes), so the SPX skip is the legacy asset gate');
});

// ---- 5: the Bitcoin side ----------------------------------------------------------------------------------------------
await section('5. Bitcoin side: the real validator on the buyer-funded reveal, and on a reveal with a plain sats input', async () => {
  tacit.clearValidatorCaches();
  const swap = buildSwap({ payload: boundPayload(ETCH_ASSET, ETCHED), note: ETCHED, sellerHashType: 0x01 });
  const fetchTx = async (id) => ({ [etch.txid]: etch.esplora, [swap.txid]: swap.esplora })[id] || null;
  const v0 = await validate(fetchTx, swap.txid, 0);
  const v1 = await validate(fetchTx, swap.txid, 1);
  const v2 = await validate(fetchTx, swap.txid, 2);
  ok(v0.ok === true && v1.ok === true, `reveal [commit, seller's etched note]: the buyer's note (vout 0) and the seller's change note (vout 1) are valid notes (${JSON.stringify(v0)}, ${JSON.stringify(v1)})`);
  ok(v2.ok === false, 'the sats payout (vout 2) is not a note');
  ok(ethReads.length >= 2 && ethReads.every(([to]) => strip(to) === strip(dep.pool)) && fetched.length === 0,
    `each bound output was checked unspent in the pool its payload names (${ethReads.length} reads of ${dep.pool}), nothing else read from the network`);
  const r = await reflect(swap, { asset: ETCH_ASSET, note: ETCHED });
  ok(foldedSwap(r, swap, ETCHED), 'the mirror folds the identical bytes the validator accepted: both bound notes onboard, the etched note nullified');

  // A plain sats UTXO of the buyer's, made by an ordinary P2WPKH-funded transaction, added to the REVEAL as vin[2].
  const topupParent = {
    txid: bytesToHex(sha(te('buyer-topup-parent'))), status: { confirmed: true, block_height: 329990 },
    vin: [{ txid: bytesToHex(sha(te('p2wpkh-coin'))), vout: 0, witness: [bytesToHex(cat(Uint8Array.of(0x30, 0x44), new Uint8Array(70 - 2).fill(7), Uint8Array.of(0x01))), bytesToHex(cat(Uint8Array.of(2), xonly(BUYER_D)))], prevout: { scriptpubkey_type: 'v0_p2wpkh' } }],
    vout: [{ scriptpubkey: bytesToHex(BUYER_SPK), value: TOPUP }],
  };
  const topup = { txid: topupParent.txid, vout: 0, value: TOPUP, script: BUYER_SPK };
  tacit.clearValidatorCaches();
  const x = buildSwap({ payload: boundPayload(ETCH_ASSET, ETCHED), note: ETCHED, sellerHashType: 0x01, extraInputs: [topup], extraOutputs: [{ value: TOPUP - 300, script: BUYER_SPK }] });
  const fx = async (id) => ({ [etch.txid]: etch.esplora, [x.txid]: x.esplora, [topup.txid]: topupParent })[id] || null;
  const x0 = await validate(fx, x.txid, 0);
  const x1 = await validate(fx, x.txid, 1);
  ok(x0.ok === false && x0.reason === 'invalid' && x1.ok === false,
    `reveal [commit, seller note, plain sats input]: invalid on Bitcoin (${JSON.stringify(x0)}): 0x39 requires every vin[1..] to be a validated note and counts each in the kernel`);
  const rx = await reflect(x, { asset: ETCH_ASSET, note: ETCHED });
  ok(foldedSwap(rx, x, ETCHED), 'yet the mirror folds it (it ignores non-live inputs and its kernel covers the live note only): the buyer must fund through the commit (vin[0]), never a reveal input');
});

console.log(`\n${passed} bound-swap-reflect checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
