#!/usr/bin/env node
// The one-round bound swap of a bridged token for sats (dapp/bound-swap.js sellerOffer + buyerTakeOffer) as reflection inputs for the
// PINNED reflection guest. One block [coinbase, commit, reveal] over a prior live set holding the seller's SPX note as folding its
// cross-out mint leaves it (unbound, leaf btcNoteLeaf(SPX, C, sellerXonly), auth key = the seller's Taproot x-only):
//   commit  the buyer (bid key) funds it from a sats coin; its output 0 is P2TR(NUMS, the 0x39 envelope leaf)
//   reveal  vin[0] = commit:0 (buyer, script path), vin[1] = the seller's live UNBOUND note (key path)
//           vout[0] buyer note at P2TR(bid x-only), vout[1] the seller's zero change at P2TR(seller), vout[2] the sats payout
// Three cases, the same transactions but the seller's vin[1] signature:
//   81  ALL|ANYONECANPAY, the offer's own witness (made before the commit existed)   folds: buyer note + seller change onboard
//   01  ALL, signed over the final reveal                                              folds: the same
//   83  SINGLE|ANYONECANPAY (leaves outputs free)                                      skips: nothing onboards, the seller note
//                                                                                      still leaves the live set
// Each fixture carries the JS mirror's newDigest; reflect-local executes the pinned ELF on it and compares (DIGEST_MATCH).
// The chain binding is the mainnet deployment's (the pinned guest reads it from its input and commits it in its public values).
// The range proof and kernel take fresh nonces, so each run makes another reveal txid and, for the folding cases, another newDigest;
// the three executed against the pinned ELF are kept as contracts/sp1/confidential/fixtures/reflection_bound_offer_{81,01,83}.json.
//   node tests/gen-reflection-bound-offer-synth.mjs <outdir>
//   reflect-local contracts/sp1/confidential/elf/reflection-prover <outdir>/bound_offer_81.json

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32, pedersenCommit, signSchnorr, verifySchnorr } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { tacitKit } from '../dapp/adaptor-btc-tx.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { classifyConfidentialTx, inputFirstWitnessItem, sigBindsAllOutputs } from '../dapp/burn-deposit-bitcoin.js';
import * as bs from '../dapp/bound-swap.js';
import { computeTxid, computeMerkleRoot, mineHeader, cat } from './btc-mini.mjs';
import { tacit, te, scalar, NOTE_VALUE } from './lib/btc-sim.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: gen-reflection-bound-offer-synth.mjs <outdir>');
mkdirSync(outDir, { recursive: true });
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const dsha = (b) => sha256(sha256(b));
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
const h0x = (b) => '0x' + bytesToHex(b);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const BLOCK_HEIGHT = 970001;

const dep = getConfidentialDeployment('mainnet');
const CHAIN_BINDING = h0x(keccak_256(hexToBytes(BigInt(dep.chainId).toString(16).padStart(64, '0') + strip(dep.pool))));
const SPX = '0x45addc633189749428e8fc36ea4ca067fcb4b0c7abc186a095360db10dbe0b48';
const walletOf = (tag) => makeBtcWallet({ priv: bigintToBytes32(scalar(tag)), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 2 }).prims;
const buyer = walletOf('reflect-bound-offer-bid-key'), seller = walletOf('reflect-bound-offer-seller');
const kit = tacitKit(tacit);
const SELLER_TR = seller.p2trScript(seller.wallet.xonly()), BUYER_TR = buyer.p2trScript(buyer.wallet.xonly());
const V = 7_000_000_000n, PRICE = 20_000, FEE_RATE = 2;
const R_S = scalar('reflect-bound-offer-note-blinding'), C_IN = pedersenCommit(V, R_S), A_IN = C_IN.toAffine();
const NOTE = { txid: bytesToHex(sha256(te('reflect-bound-offer/crossout-mint/spx'))), vout: 0, value: NOTE_VALUE, script: SELLER_TR, amount: V, blinding: R_S, cx: A_IN.x, cy: A_IN.y };
const FUNDING = { txid: bytesToHex(sha256(te('reflect-bound-offer/bid-wallet-coin'))), vout: 0, value: 100_000, script: BUYER_TR };
const PAYOUT = seller.p2wpkhScript(seller.wallet.pub);

// The swap exactly as the dapp makes it: the seller's offer, then the buyer's take (check, commit, reveal, finish, verify).
const offer = bs.sellerOffer({ prims: seller, kit, assetId: SPX, sellerNote: NOTE, buyerXonly: buyer.wallet.xonly(), chainBinding: CHAIN_BINDING, sellerPayoutScript: PAYOUT, priceSats: PRICE });
const take = bs.buyerTakeOffer({ prims: buyer, kit, offer, fundingUtxo: FUNDING, feeRate: FEE_RATE, expected: { assetId: SPX, chainBinding: CHAIN_BINDING, sellerNoteCommitment: C_IN.toRawBytes(true) } });
const commit = bs.parseTx(take.commitHex);
const prevouts = [{ value: commit.outputs[0].value, script: commit.outputs[0].script }, { value: NOTE.value, script: NOTE.script }];
// Another seller signature on the same reveal: the witness is not in the txid, so the buyer's vin[0] signature stands.
const resigned = (h) => {
  const tx = { ...take.revealTx, inputs: take.revealTx.inputs.map((i) => ({ ...i })) };
  tx.inputs[1].witness = [Uint8Array.from([...signSchnorr(seller.tapSighashKeyPath(tx, 1, prevouts, h), seller.wallet.priv), h])];
  return bytesToHex(buyer.serializeTx(tx));
};
const cases = { 81: take.revealHex, '01': resigned(0x01), 83: resigned(0x83) };

function block(revealHex) {
  const txs = [take.commitHex, revealHex].map((h) => Buffer.from(strip(h), 'hex'));
  const ids = txs.map(computeTxid);
  const reserved = Buffer.alloc(32, 7);
  const wcommit = dsha(cat([computeMerkleRoot([Buffer.alloc(32), ...txs.map(dsha)]), reserved]));
  const coinbase = cat([
    [0x02, 0x00, 0x00, 0x00], [0x00, 0x01],
    [0x01], Buffer.alloc(32), [0xff, 0xff, 0xff, 0xff], [0x00], [0xff, 0xff, 0xff, 0xff],
    [0x01], Buffer.alloc(8), [0x26], [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], wcommit,
    [0x01], [0x20], reserved, Buffer.alloc(4),
  ]);
  const cbTxid = computeTxid(coinbase);
  return { coinbase, cbTxid, txs, ids, header: mineHeader(computeMerkleRoot([cbTxid, ...ids])) };
}

const summary = {};
for (const [name, revealHex] of Object.entries(cases)) {
  const reveal = bs.parseTx(revealHex);
  const item = inputFirstWitnessItem('0x' + strip(revealHex), 1);
  const flag = item[64];
  if (!verifySchnorr(item.subarray(0, 64), seller.tapSighashKeyPath(reveal, 1, prevouts, flag), seller.wallet.xonly())) throw new Error(`${name}: the seller signature does not verify`);
  const b = block(revealHex);
  const ix = makeScanReflectionIndexer({ secp, keccak256: keccak_256, sha256 });
  const cp = ix.pool, st = ix.state();
  st.setHeight(BLOCK_HEIGHT - 1);
  const cx = word(A_IN.x), cy = word(A_IN.y), auth = h0x(seller.wallet.xonly());
  const key = cp.outpointKey('0x' + rev(NOTE.txid), NOTE.vout);
  st.foldOutput(cp.btcNoteLeaf(SPX, cx, cy, auth), key, cp.commitmentHash(cx, cy), SPX, auth);
  ix.coords().set(key.toLowerCase(), { cx, cy });
  const before = st.counts();
  const input = await ix.assembleBlocks([{ txs: [
    { txidDisplay: Buffer.from(b.cbTxid).reverse().toString('hex'), rawHex: Buffer.from(b.coinbase).toString('hex'), decode: null, vins: [] },
    ...b.txs.map((raw, i) => {
      const t = bs.parseTx(raw.toString('hex'));
      return { txidDisplay: Buffer.from(b.ids[i]).reverse().toString('hex'), rawHex: raw.toString('hex'), decode: classifyConfidentialTx('0x' + raw.toString('hex')), vins: t.inputs.map((x) => ({ prevTxidDisplay: x.txid, vout: x.vout })) };
    }),
  ] }], { headers: ['0x' + Buffer.from(b.header).toString('hex')], anchorHeight: BLOCK_HEIGHT, chainBinding: CHAIN_BINDING });
  const after = st.counts();
  const k = (txid, vout) => cp.outpointKey('0x' + rev(txid), vout);
  const live = (txid, vout) => st._acc.live.get(k(txid, vout)) != null;
  const bound = (txid, vout) => st._acc.live.boundTag(k(txid, vout));
  const r = {
    sighash: '0x' + flag.toString(16).padStart(2, '0'), bindsAllOutputs: sigBindsAllOutputs(item),
    folded: input.blocks[0].txs.slice(1).map((t) => t.outputs.length), skipped: (input.nonConserving || []).map((s) => s.reason),
    buyerNoteLive: live(reveal.txid, 0), buyerNoteBound: bound(reveal.txid, 0), sellerChangeLive: live(reveal.txid, 1), payoutLive: live(reveal.txid, 2), sellerNoteLive: live(NOTE.txid, NOTE.vout),
    live: `${before.live}->${after.live}`, notes: `${before.note}->${after.note}`, spent: `${before.spent}->${after.spent}`,
    chainBinding: input.chainBinding, newDigest: input.newDigest, revealTxid: reveal.txid,
  };
  summary[name] = r;
  writeFileSync(join(outDir, `bound_offer_${name}.json`), JSON.stringify(input));
  console.error(`${name}: ${JSON.stringify(r)}`);
}
writeFileSync(join(outDir, 'bound_offer_summary.json'), JSON.stringify({ asset: SPX, chainBinding: CHAIN_BINDING, buyerXonly: bytesToHex(buyer.wallet.xonly()), sellerXonly: bytesToHex(seller.wallet.xonly()), commitTxid: take.commitTxid, cases: summary }, null, 2));
process.exit(0);   // the simulated Bitcoin side (tests/lib/btc-sim.mjs) keeps the event loop open
