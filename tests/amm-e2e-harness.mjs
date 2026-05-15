// End-to-end test harness for the tacit AMM.
//
// Wires up a mock Bitcoin chain, mock asset etching, LP / Trader / Settler
// actors, and the production-shape indexer (tests/amm-validator.mjs) so we
// can exercise the full circuit ⇄ indexer ⇄ chain-state loop without an
// actual Bitcoin node, Groth16 proving key, or worker websocket.
//
// What's real:
//   • All cryptographic primitives: Pedersen commitments, kernel sigs (mixer-
//     style Mimblewimble balance check), BIP-340 intent_sigs, sigma cross-
//     curve bindings, chain-side aggregate Pedersen, OP_RETURN envelope_hash
//     binding, three-origin asset-id resolution.
//   • All wire formats: envelope codecs round-trip through the actual
//     amm-envelope.mjs encoders/decoders.
//   • All indexer state transitions: pool registration, reserve tracking,
//     LP-share supply accounting, receipt crediting.
//   • Optionally: actual circom witness calculation per opcode invocation
//     (close the circuit-side loop pre-ceremony).
//
// What's stubbed:
//   • Groth16 proof generation/verification (no proving key until ceremony
//     finalizes). The validator accepts any proof bytes; circuit-witness
//     calculation is the alternative loop closure.
//   • Bitcoin transaction signatures (we abstract `SIGHASH_ALL` to a flag).
//   • Worker websocket — actors exchange messages directly.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes, randomScalar, bigintToBytes32, bytes32ToBigint,
} from './bulletproofs.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';

import {
  deriveAssetIdFromReveal, derivePoolId, deriveLpAssetId,
} from './amm-asset.mjs';
import {
  canonicalOutpoint, deriveReceiptBlinding,
  deriveSwapReceiptBlinding, deriveLpAddShareBlinding, deriveLpRemoveBlindings,
} from './amm-receipt.mjs';
import {
  lpAddKernelSign, lpRemoveKernelSign,
} from './amm-kernel.mjs';
import {
  MINIMUM_LIQUIDITY, deriveMinLiqBlinding, deriveMinLiqCommitment,
  deriveMinLiqAmountCt, deriveMinLiqNumsRecipient,
} from './amm-min-liq.mjs';
import {
  buildIntentMsg, deriveIntentId, signIntent,
  computeEnvelopeHash, buildCanonicalListBytes, computeQualifyingSetHash,
} from './amm-intent.mjs';
import {
  N_BJJ, pedersenBJJ, packPoint, addPoint, mulScalar, H_BJJ, G_BJJ,
} from './amm-bjj.mjs';
import {
  proveXCurve,
} from './amm-sigma-xcurve.mjs';
import {
  encodeLpAdd, encodeLpRemove, encodeSwapBatch,
} from './amm-envelope.mjs';
import {
  validateLpAdd, validateLpRemove, validateSwapBatch, SKIP_GROTH16_VERIFY_UNSAFE, SKIP_MIN_LIQ_VERIFY_UNSAFE,
} from './amm-validator.mjs';
import {
  solveClearing, amountOutForTrader, lpInitShares, lpAddShares, lpRemoveOutputs,
} from './amm-clearing.mjs';

// ---- low-level helpers ----

const hash160 = (b) => ripemd160(sha256(b));

function reverseBytes(b) { const r = new Uint8Array(b); r.reverse(); return r; }

export function randomBJJBlinding() {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n;
    for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < N_BJJ) return n;
  }
}

function syntheticTxid(label, index = 0) {
  return bytesToHex(sha256(new TextEncoder().encode(`tacit-e2e-txid-${label}-${index}`)));
}

// ---- mock chain ----

export class MockChain {
  constructor() {
    this.height = 0;
    this.blocks = [];                                      // [{ height, txs: [...] }]
    this.utxos = new Map();                                // outpointHex -> { value, scriptPubKey, txdata? }
    this.pendingTxs = [];                                  // queued for the next confirm()
    this.snapshots = [];                                   // for reorg rewind
  }

  outpointKey(txid, vout) { return `${txid}:${vout}`; }

  broadcast(tx) {
    if (!tx.txid) tx.txid = syntheticTxid(`tx-${this.height}`, this.pendingTxs.length);
    this.pendingTxs.push(tx);
    return tx.txid;
  }

  confirm(blocks = 1) {
    for (let i = 0; i < blocks; i++) {
      this.height += 1;
      const txs = this.pendingTxs.slice();
      this.pendingTxs = [];
      this.blocks.push({ height: this.height, txs });
      for (const tx of txs) {
        // Spend inputs
        for (const inp of (tx.vin || [])) {
          this.utxos.delete(this.outpointKey(inp.txid, inp.vout));
        }
        // Create outputs
        for (let v = 0; v < (tx.vout || []).length; v++) {
          const out = tx.vout[v];
          this.utxos.set(this.outpointKey(tx.txid, v), {
            value: out.value,
            scriptPubKey: out.scriptPubKey,
            txdata: out.txdata || null,                    // tacit asset payload, kernel sig, etc.
          });
        }
      }
    }
    return this.height;
  }

  snapshot(label) {
    // Deep-ish snapshot for reorg rewind.
    this.snapshots.push({
      label, height: this.height,
      blocks: this.blocks.slice(),
      utxos: new Map(this.utxos),
      pendingTxs: this.pendingTxs.slice(),
    });
  }

  rewindTo(label) {
    const idx = this.snapshots.findIndex(s => s.label === label);
    if (idx < 0) throw new Error(`no snapshot named ${label}`);
    const s = this.snapshots[idx];
    this.height = s.height;
    this.blocks = s.blocks.slice();
    this.utxos = new Map(s.utxos);
    this.pendingTxs = s.pendingTxs.slice();
    this.snapshots = this.snapshots.slice(0, idx + 1);
  }

  utxoExists(txid, vout) { return this.utxos.has(this.outpointKey(txid, vout)); }
  getUtxo(txid, vout)    { return this.utxos.get(this.outpointKey(txid, vout)); }
}

// ---- mock asset etching ----
//
// We don't run actual CETCH envelopes through the indexer here — the AMM
// validator only needs to resolve asset_ids via lookup. We construct a
// synthetic CETCH txid for each test asset and let the AMM validator's
// lookups treat it as canonical.

export function etchAsset({ chain, ticker, etcher, supply, decimals = 8 }) {
  // Synthetic reveal-tx txid for this asset.
  const revealTxid = syntheticTxid(`etch-${ticker}`, chain.height);
  const assetId = deriveAssetIdFromReveal(revealTxid, 0);

  // Mint the etcher one UTXO holding the entire supply with a random blinding.
  const r = randomScalar();
  const C = pedersenCommit(supply, r);
  // Confirmation: stage and confirm the etch tx so the UTXO exists in the chain.
  const tx = {
    vin: [],
    vout: [{
      value: 546,                                          // dust
      scriptPubKey: p2wpkhFor(etcher.pubkeyHash),
      txdata: { type: 'CETCH', assetId, amount: supply, blinding: r, commitment: C },
    }],
    txid: revealTxid,                                      // pinned so asset_id derives consistently
  };
  chain.broadcast(tx);
  chain.confirm(3);

  return {
    assetId,
    revealTxid,
    ticker,
    decimals,
    etcherUtxo: { txid: revealTxid, vout: 0, amount: supply, blinding: r, commitment: C },
  };
}

// ---- actors ----

function p2wpkhFor(hash160Bytes) {
  return concatBytes(new Uint8Array([0x00, 0x14]), hash160Bytes);   // OP_0 PUSH(20) <hash>
}

export class Actor {
  constructor(label) {
    this.label = label;
    this.privkey = new Uint8Array(32);
    for (let i = 0; i < 32; i++) this.privkey[i] = i + (this.constructor.actorCount = (this.constructor.actorCount || 0) + 1);
    const pub = secp.ProjectivePoint.fromPrivateKey(this.privkey);
    this.pubkey = pub.toRawBytes(true);
    this.pubkeyHash = hash160(this.pubkey);
    this.utxos = [];                                       // { txid, vout, assetId, amount, blinding, commitment }
  }

  registerUtxo(u) { this.utxos.push(u); }
  utxosForAsset(assetIdHex) {
    return this.utxos.filter(u => bytesToHex(u.assetId) === assetIdHex);
  }
  takeUtxo(predicate) {
    const idx = this.utxos.findIndex(predicate);
    if (idx < 0) return null;
    const [u] = this.utxos.splice(idx, 1);
    return u;
  }
}

// Split one of an actor's UTXOs into multiple sub-denominations off-chain
// (mocks a CXFER-style split). The blindings of the new UTXOs are random,
// with the LAST one chosen so Σ r_new = r_original (mod n_secp). This keeps
// Pedersen sums consistent if anyone were to verify.
//
// In a real chain, this would be a CXFER tx; here we just rewrite the actor's
// UTXO set since the AMM doesn't need to validate the split.
export function splitActorUtxo(actor, assetId, denominations) {
  const total = denominations.reduce((s, d) => s + d, 0n);
  // Find a UTXO with SUFFICIENT amount (sorted by amount desc to prefer larger).
  const candidates = actor.utxos
    .map((u, idx) => ({ u, idx }))
    .filter(({ u }) => bytesToHex(u.assetId) === bytesToHex(assetId) && u.amount >= total)
    .sort((a, b) => Number(b.u.amount - a.u.amount));
  if (candidates.length === 0) {
    throw new Error(`splitActorUtxo: no source UTXO of ≥ ${total} ${bytesToHex(assetId).slice(0, 8)}`);
  }
  const target = candidates[0].idx;
  const src = candidates[0].u;

  // Track blindings so Σ r_new = r_original (mod n_secp).
  let blindingAcc = 0n;
  const outputs = [];
  for (let i = 0; i < denominations.length; i++) {
    const r = (i === denominations.length - 1 && src.amount === total)
      ? modN(src.blinding - blindingAcc)
      : randomScalar();
    blindingAcc = modN(blindingAcc + r);
    outputs.push({
      txid: bytesToHex(sha256(new TextEncoder().encode(`split-${actor.label}-${i}-${denominations[i]}`))),
      vout: 0, assetId,
      amount: denominations[i], blinding: r,
      commitment: pedersenCommit(denominations[i], r),
    });
  }

  // Change output if not consumed exactly.
  if (src.amount > total) {
    const changeAmount = src.amount - total;
    const changeR = modN(src.blinding - blindingAcc);
    outputs.push({
      txid: bytesToHex(sha256(new TextEncoder().encode(`split-${actor.label}-change`))),
      vout: 0, assetId,
      amount: changeAmount, blinding: changeR,
      commitment: pedersenCommit(changeAmount, changeR),
    });
  }

  actor.utxos.splice(target, 1);
  for (const o of outputs) actor.registerUtxo(o);
}

// Aggregate a UTXO list into one canonical Pedersen-commitment + sum.
export function aggregateUtxos(utxoList) {
  let sumAmount = 0n;
  let sumBlinding = 0n;
  let sumCommitment = ZERO;
  for (const u of utxoList) {
    sumAmount += u.amount;
    sumBlinding = modN(sumBlinding + u.blinding);
    sumCommitment = sumCommitment.add(u.commitment);
  }
  return { sumAmount, sumBlinding, sumCommitment };
}

// ---- LP-side flows ----

export function buildAndSubmitPoolInit({
  chain, indexer, lp, assetA_info, assetB_info, deltaA, deltaB, feeBps, vkCid, ceremonyCid,
}) {
  // Canonical asset-pair ordering: smaller asset_id first.
  let [assetA, assetB, infoA, infoB] = [assetA_info.assetId, assetB_info.assetId, assetA_info, assetB_info];
  let flipped = false;
  for (let i = 0; i < 32; i++) {
    if (assetA[i] < assetB[i]) break;
    if (assetA[i] > assetB[i]) {
      [assetA, assetB] = [assetB, assetA];
      [infoA, infoB] = [infoB, infoA];
      [deltaA, deltaB] = [deltaB, deltaA];
      flipped = true;
      break;
    }
  }

  // LP needs to consume their UTXOs of asset A and B summing to deltaA/deltaB.
  const inputA = lp.takeUtxo(u => bytesToHex(u.assetId) === bytesToHex(assetA) && u.amount >= deltaA);
  const inputB = lp.takeUtxo(u => bytesToHex(u.assetId) === bytesToHex(assetB) && u.amount >= deltaB);
  if (!inputA || !inputB) throw new Error('LP missing inputs');

  // For e2e simplicity, deltaA/deltaB must exactly match the input UTXO amounts.
  // (In production, LP would pre-split via CXFER; we elide that.)
  if (inputA.amount !== deltaA || inputB.amount !== deltaB) {
    throw new Error(`LP UTXO amount mismatch (input: ${inputA.amount}/${inputB.amount}, delta: ${deltaA}/${deltaB})`);
  }

  const poolId = derivePoolId(assetA, assetB);
  const lpAssetId = deriveLpAssetId(poolId);

  // LP-share: founder gets isqrt(deltaA·deltaB) - MINIMUM_LIQUIDITY.
  const { total_shares, founder_shares, locked_shares } = lpInitShares(deltaA, deltaB, MINIMUM_LIQUIDITY);

  // Share Pedersen commitment (BJJ + secp), deterministic from LP privkey.
  const lpInputAOutpoint = canonicalOutpoint(inputA.txid, inputA.vout);
  const { r_secp: r_share_secp, r_BJJ: r_share_BJJ } = deriveLpAddShareBlinding({
    recipientPrivkey: lp.privkey,
    poolId, lpInputAOutpoint, lpAssetId,
  });
  const C_share_secp = pedersenCommit(founder_shares, r_share_secp);
  const C_share_BJJ_pt = pedersenBJJ(founder_shares, r_share_BJJ);

  // Cross-curve binding proof on share commitment.
  const xres = proveXCurve({
    a: founder_shares, r_secp: r_share_secp, r_BJJ: r_share_BJJ,
    C_secp: C_share_secp, C_BJJ: C_share_BJJ_pt,
  });

  // Per-asset kernel sigs.
  const kSigA = lpAddKernelSign({
    variant: 1, poolId, assetX: assetA, deltaX: deltaA, shareAmount: founder_shares,
    shareCSecpBytes: pointToBytes(C_share_secp),
    inputsX: [{ txid: inputA.txid, vout: inputA.vout }],
    inputCommitments: [inputA.commitment], excessX: inputA.blinding,
  });
  const kSigB = lpAddKernelSign({
    variant: 1, poolId, assetX: assetB, deltaX: deltaB, shareAmount: founder_shares,
    shareCSecpBytes: pointToBytes(C_share_secp),
    inputsX: [{ txid: inputB.txid, vout: inputB.vout }],
    inputCommitments: [inputB.commitment], excessX: inputB.blinding,
  });

  // MINIMUM_LIQUIDITY locked output info.
  const minLiqCommit = deriveMinLiqCommitment(poolId);
  const minLiqAmountCt = deriveMinLiqAmountCt(poolId);
  const { p2wpkh: minLiqP2wpkh } = deriveMinLiqNumsRecipient(poolId);

  // POOL_INIT envelope payload.
  // Set POOL_CAP_SOLO_INTENT_ALLOWED (0x01) so the e2e harness's N=1 swap
  // scenarios exercise the swap path. Default V1 pools reject N=1 for
  // amount confidentiality; the harness intentionally opts
  // in here to keep scenario coverage broad.
  const payload = encodeLpAdd({
    variant: 1, assetA, assetB, deltaA, deltaB, shareAmount: founder_shares,
    shareCSecp: pointToBytes(C_share_secp),
    shareCBJJ: packPoint(C_share_BJJ_pt),
    shareXcurveSigma: xres.proof,
    kernelSigA: kSigA, kernelSigB: kSigB,
    feeBps, vkCid, ceremonyCid,
    arbiterPubkeys: [], launcherSigs: [],
    poolCapabilityFlags: 0x02,                             // POOL_CAP_SOLO_INTENT_ALLOWED
    proof: new Uint8Array(256),                            // Groth16 stub
  });

  // Bitcoin tx layout:
  //   vin[0]  = settler/LP envelope-bearing input (we elide the script-path detail)
  //   vin[1+] = LP's asset-A input + asset-B input
  //   vout[0] = founder LP-share UTXO at p2wpkh of LP
  //   vout[1] = MINIMUM_LIQUIDITY locked NUMS output
  const txid = syntheticTxid(`pool-init-${bytesToHex(poolId).slice(0, 8)}`);
  const tx = {
    vin: [
      { txid: 'envelope', vout: 0 },                       // synthetic envelope source
      { txid: inputA.txid, vout: inputA.vout },
      { txid: inputB.txid, vout: inputB.vout },
    ],
    vout: [
      {
        value: 546,
        scriptPubKey: p2wpkhFor(lp.pubkeyHash),
        txdata: {
          type: 'LP_SHARE_FOUNDER',
          assetId: lpAssetId,
          amount: founder_shares,
          blinding: r_share_secp,
          commitment: C_share_secp,
        },
      },
      {
        value: 546,
        scriptPubKey: p2wpkhFor(minLiqP2wpkh),
        txdata: {
          type: 'LP_SHARE_LOCKED',
          assetId: lpAssetId,
          amount: MINIMUM_LIQUIDITY,
          blinding: deriveMinLiqBlinding(poolId),
          commitment: minLiqCommit,
        },
      },
    ],
    txid,
    envelope: payload,
  };
  chain.broadcast(tx);
  chain.confirm(3);                                        // depth-3 for AMM_OP_CONFIRMATION_DEPTH

  // Indexer validation.
  const result = validateLpAdd({
    payload, pool: null,
    inputCommitmentsA: [inputA.commitment], inputCommitmentsB: [inputB.commitment],
    inputsA: [{ txid: inputA.txid, vout: inputA.vout }],
    inputsB: [{ txid: inputB.txid, vout: inputB.vout }],
    groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
    currentHeight: chain.height,
    minLiqOutput: {
      commitBytes: pointToBytes(minLiqCommit),
      amtCt: minLiqAmountCt,
      p2wpkh: minLiqP2wpkh,
    },
  });
  if (!result.valid) throw new Error(`POOL_INIT rejected: ${result.reason}`);
  indexer.registerPool(result.newPoolState);

  // Credit the LP with the founder LP-share UTXO.
  lp.registerUtxo({
    txid, vout: 0, assetId: lpAssetId,
    amount: founder_shares, blinding: r_share_secp, commitment: C_share_secp,
  });

  return { poolId, lpAssetId, totalShares: total_shares, founderShares: founder_shares, txid };
}

export function buildAndSubmitLpAdd({
  chain, indexer, lp, pool, deltaA, deltaB,
}) {
  const assetA = pool.asset_A, assetB = pool.asset_B;
  const inputA = lp.takeUtxo(u => bytesToHex(u.assetId) === bytesToHex(assetA) && u.amount >= deltaA);
  const inputB = lp.takeUtxo(u => bytesToHex(u.assetId) === bytesToHex(assetB) && u.amount >= deltaB);
  if (!inputA || !inputB) throw new Error('LP_ADD: missing inputs');
  if (inputA.amount !== deltaA || inputB.amount !== deltaB) throw new Error('LP_ADD: UTXO amount mismatch');

  const expectedShares = lpAddShares(deltaA, deltaB, pool.reserve_A, pool.reserve_B, pool.lp_total_shares);

  const lpInputAOutpoint = canonicalOutpoint(inputA.txid, inputA.vout);
  const { r_secp: r_share_secp, r_BJJ: r_share_BJJ } = deriveLpAddShareBlinding({
    recipientPrivkey: lp.privkey,
    poolId: pool.pool_id, lpInputAOutpoint, lpAssetId: pool.lp_asset_id,
  });
  const C_share_secp = pedersenCommit(expectedShares, r_share_secp);
  const C_share_BJJ_pt = pedersenBJJ(expectedShares, r_share_BJJ);
  const xres = proveXCurve({
    a: expectedShares, r_secp: r_share_secp, r_BJJ: r_share_BJJ,
    C_secp: C_share_secp, C_BJJ: C_share_BJJ_pt,
  });
  const kSigA = lpAddKernelSign({
    variant: 0, poolId: pool.pool_id, assetX: assetA, deltaX: deltaA, shareAmount: expectedShares,
    shareCSecpBytes: pointToBytes(C_share_secp),
    inputsX: [{ txid: inputA.txid, vout: inputA.vout }],
    inputCommitments: [inputA.commitment], excessX: inputA.blinding,
  });
  const kSigB = lpAddKernelSign({
    variant: 0, poolId: pool.pool_id, assetX: assetB, deltaX: deltaB, shareAmount: expectedShares,
    shareCSecpBytes: pointToBytes(C_share_secp),
    inputsX: [{ txid: inputB.txid, vout: inputB.vout }],
    inputCommitments: [inputB.commitment], excessX: inputB.blinding,
  });
  const payload = encodeLpAdd({
    variant: 0, assetA, assetB, deltaA, deltaB, shareAmount: expectedShares,
    shareCSecp: pointToBytes(C_share_secp),
    shareCBJJ: packPoint(C_share_BJJ_pt),
    shareXcurveSigma: xres.proof,
    kernelSigA: kSigA, kernelSigB: kSigB,
    proof: new Uint8Array(256),
  });
  const txid = syntheticTxid(`lp-add-${chain.height}`);
  const tx = {
    vin: [
      { txid: 'envelope', vout: 0 },
      { txid: inputA.txid, vout: inputA.vout },
      { txid: inputB.txid, vout: inputB.vout },
    ],
    vout: [{
      value: 546,
      scriptPubKey: p2wpkhFor(lp.pubkeyHash),
      txdata: {
        type: 'LP_SHARE',
        assetId: pool.lp_asset_id,
        amount: expectedShares,
        blinding: r_share_secp,
        commitment: C_share_secp,
      },
    }],
    txid, envelope: payload,
  };
  chain.broadcast(tx);
  // Advance past AMM_INITIAL_LP_LOCK_BLOCKS so the variant-0 LP_ADD is
  // allowed against the freshly initialized pool.
  chain.confirm(8);

  const result = validateLpAdd({
    payload, pool,
    inputCommitmentsA: [inputA.commitment], inputCommitmentsB: [inputB.commitment],
    inputsA: [{ txid: inputA.txid, vout: inputA.vout }],
    inputsB: [{ txid: inputB.txid, vout: inputB.vout }],
    groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
    currentHeight: chain.height,
  });
  if (!result.valid) throw new Error(`LP_ADD rejected: ${result.reason}`);
  indexer.updatePool(result.newPoolState);
  lp.registerUtxo({
    txid, vout: 0, assetId: pool.lp_asset_id,
    amount: expectedShares, blinding: r_share_secp, commitment: C_share_secp,
  });

  return { sharesMinted: expectedShares, txid, payload };
}

export function buildAndSubmitLpRemove({
  chain, indexer, lp, pool, shareAmount,
}) {
  // LP must hold a single lp_asset_id UTXO with that amount (for simplicity).
  const lpShareUtxo = lp.takeUtxo(u =>
    bytesToHex(u.assetId) === bytesToHex(pool.lp_asset_id) && u.amount === shareAmount,
  );
  if (!lpShareUtxo) throw new Error(`LP_REMOVE: no lp_share UTXO with exact amount ${shareAmount}`);

  const { delta_a, delta_b } = lpRemoveOutputs(shareAmount, pool.reserve_A, pool.reserve_B, pool.lp_total_shares);
  const lpShareInputOutpoint = canonicalOutpoint(lpShareUtxo.txid, lpShareUtxo.vout);
  const { legA, legB } = deriveLpRemoveBlindings({
    recipientPrivkey: lp.privkey, poolId: pool.pool_id,
    lpShareInputOutpoint, assetIdA: pool.asset_A, assetIdB: pool.asset_B,
  });
  const C_recvA_secp = pedersenCommit(delta_a, legA.r_secp);
  const C_recvA_BJJ  = pedersenBJJ(delta_a, legA.r_BJJ);
  const C_recvB_secp = pedersenCommit(delta_b, legB.r_secp);
  const C_recvB_BJJ  = pedersenBJJ(delta_b, legB.r_BJJ);
  const xresA = proveXCurve({ a: delta_a, r_secp: legA.r_secp, r_BJJ: legA.r_BJJ, C_secp: C_recvA_secp, C_BJJ: C_recvA_BJJ });
  const xresB = proveXCurve({ a: delta_b, r_secp: legB.r_secp, r_BJJ: legB.r_BJJ, C_secp: C_recvB_secp, C_BJJ: C_recvB_BJJ });
  const kSig = lpRemoveKernelSign({
    poolId: pool.pool_id, shareAmount, deltaA: delta_a, deltaB: delta_b,
    recvACSecpBytes: pointToBytes(C_recvA_secp),
    recvBCSecpBytes: pointToBytes(C_recvB_secp),
    lpInputs: [{ txid: lpShareUtxo.txid, vout: lpShareUtxo.vout }],
    lpInputCommitments: [lpShareUtxo.commitment], excessLP: lpShareUtxo.blinding,
  });
  const payload = encodeLpRemove({
    assetA: pool.asset_A, assetB: pool.asset_B,
    shareAmount, deltaA: delta_a, deltaB: delta_b,
    recvACSecp: pointToBytes(C_recvA_secp), recvACBJJ: packPoint(C_recvA_BJJ), recvAXcurveSigma: xresA.proof,
    recvBCSecp: pointToBytes(C_recvB_secp), recvBCBJJ: packPoint(C_recvB_BJJ), recvBXcurveSigma: xresB.proof,
    kernelSigLP: kSig,
    proof: new Uint8Array(256),
  });
  const txid = syntheticTxid(`lp-remove-${chain.height}`);
  const tx = {
    vin: [
      { txid: 'envelope', vout: 0 },
      { txid: lpShareUtxo.txid, vout: lpShareUtxo.vout },
    ],
    vout: [
      {
        value: 546, scriptPubKey: p2wpkhFor(lp.pubkeyHash),
        txdata: {
          type: 'LP_WITHDRAW_A', assetId: pool.asset_A,
          amount: delta_a, blinding: legA.r_secp, commitment: C_recvA_secp,
        },
      },
      {
        value: 546, scriptPubKey: p2wpkhFor(lp.pubkeyHash),
        txdata: {
          type: 'LP_WITHDRAW_B', assetId: pool.asset_B,
          amount: delta_b, blinding: legB.r_secp, commitment: C_recvB_secp,
        },
      },
    ],
    txid, envelope: payload,
  };
  chain.broadcast(tx);
  chain.confirm(3);

  const result = validateLpRemove({
    payload, pool,
    lpInputCommitments: [lpShareUtxo.commitment],
    lpInputs: [{ txid: lpShareUtxo.txid, vout: lpShareUtxo.vout }],
    groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
  });
  if (!result.valid) throw new Error(`LP_REMOVE rejected: ${result.reason}`);
  indexer.updatePool(result.newPoolState);

  lp.registerUtxo({
    txid, vout: 0, assetId: pool.asset_A,
    amount: delta_a, blinding: legA.r_secp, commitment: C_recvA_secp,
  });
  lp.registerUtxo({
    txid, vout: 1, assetId: pool.asset_B,
    amount: delta_b, blinding: legB.r_secp, commitment: C_recvB_secp,
  });

  return { deltaA: delta_a, deltaB: delta_b, txid, payload };
}

// ---- Trader and Settler ----

export function buildIntent({ trader, pool, direction, amountIn, tipAmount, minOut, expiryHeight, settlerPubkey }) {
  // Trader has one input UTXO covering amountIn + tipAmount of the input asset.
  const inputAssetId = direction === 0 ? pool.asset_A : pool.asset_B;
  const totalIn = amountIn + tipAmount;
  const inputUtxo = trader.takeUtxo(u =>
    bytesToHex(u.assetId) === bytesToHex(inputAssetId) && u.amount === totalIn,
  );
  if (!inputUtxo) throw new Error(`trader missing input UTXO of exactly ${totalIn} ${direction === 0 ? 'A' : 'B'}`);

  // BJJ commitment to total input amount.
  const r_in_BJJ = randomBJJBlinding();
  const C_in_BJJ_pt = pedersenBJJ(totalIn, r_in_BJJ);

  // Cross-curve binding proof on trader's input.
  const xres = proveXCurve({
    a: totalIn, r_secp: inputUtxo.blinding, r_BJJ: r_in_BJJ,
    C_secp: inputUtxo.commitment, C_BJJ: C_in_BJJ_pt,
  });

  const receiveSpk = p2wpkhFor(trader.pubkeyHash);

  // Build intent_msg + sign.
  const intentMsg = buildIntentMsg({
    poolId: pool.pool_id, direction,
    inputUtxos: [{ txid: inputUtxo.txid, vout: inputUtxo.vout }],
    cInSecp: pointToBytes(inputUtxo.commitment), cInBjj: packPoint(C_in_BJJ_pt),
    xcurveSigma: xres.proof,
    receiveScriptPubKey: receiveSpk,
    minOut, tipAmount, tipAsset: direction,
    expiryHeight, traderPubkey: trader.pubkey,
  });
  const intentSig = signIntent(intentMsg, trader.privkey);
  const intentId = deriveIntentId(intentMsg);

  return {
    intentId, intentMsg, intentSig,
    direction, traderPubkey: trader.pubkey,
    inputUtxo, totalIn, amountInSwap: amountIn, tipAmount,
    r_in_BJJ, r_in_secp: inputUtxo.blinding,
    C_in_secp: inputUtxo.commitment,
    C_in_BJJ: C_in_BJJ_pt,
    xcurveSigma: xres.proof,
    receiveScriptPubKey: receiveSpk,
    minOut, expiryHeight,
    trader,
  };
}

// Settler bundles intents into a T_SWAP_BATCH and broadcasts.
export function settlerBuildAndSubmit({ chain, indexer, settler, pool, intents }) {
  // Sort intents by intent_id ascending.
  intents = intents.slice().sort((a, b) => {
    const A = a.intentId, B = b.intentId;
    for (let i = 0; i < 32; i++) {
      if (A[i] < B[i]) return -1;
      if (A[i] > B[i]) return 1;
    }
    return 0;
  });

  // Deterministic clearing iteration: solve, drop min_out failures, re-solve
  // until stable. This is the qualifying-fixed-point algorithm from AMM.md
  // §5 of Implementation specification. The chain-side aggregate Pedersen
  // identity only balances exactly when the solve corresponds to the actual
  // included intent set.
  let working = intents.slice();
  let solve = null;
  for (let iter = 0; iter <= intents.length; iter++) {
    if (working.length === 0) return null;
    let X = 0n, Y = 0n;
    for (const it of working) {
      if (it.direction === 0) X += it.amountInSwap;
      else Y += it.amountInSwap;
    }
    solve = (X === 0n && Y === 0n)
      ? { direction: 'empty', delta_a_net: 0n, delta_b_net: 0n,
          P_clear_num: pool.reserve_A, P_clear_den: pool.reserve_B }
      : solveClearing(X, Y, pool.reserve_A, pool.reserve_B, BigInt(pool.fee_bps));

    const survivors = working.filter(it => {
      const out = amountOutForTrader(it.amountInSwap, it.direction, solve.P_clear_num, solve.P_clear_den);
      return out >= it.minOut;
    });
    if (survivors.length === working.length) break;       // converged
    working = survivors;
  }
  const accepted = working;
  if (accepted.length === 0) return null;

  // Per-trader fills + per-receipt blindings.
  const filled = accepted.map(it => {
    const aOut = amountOutForTrader(it.amountInSwap, it.direction, solve.P_clear_num, solve.P_clear_den);
    const outAssetId = it.direction === 0 ? pool.asset_B : pool.asset_A;
    const traderInputOp = canonicalOutpoint(it.inputUtxo.txid, it.inputUtxo.vout);
    const { r_secp: r_out_secp, r_BJJ: r_out_BJJ } = deriveSwapReceiptBlinding({
      recipientPrivkey: it.trader.privkey,
      poolId: pool.pool_id,
      traderInputOutpoint: traderInputOp,
      outputAssetId: outAssetId,
    });
    const C_out_secp = pedersenCommit(aOut, r_out_secp);
    const C_out_BJJ_pt = pedersenBJJ(aOut, r_out_BJJ);
    const xresOut = proveXCurve({
      a: aOut, r_secp: r_out_secp, r_BJJ: r_out_BJJ, C_secp: C_out_secp, C_BJJ: C_out_BJJ_pt,
    });
    return { ...it, amountOut: aOut, r_out_secp, r_out_BJJ, C_out_secp, C_out_BJJ: C_out_BJJ_pt, xcurveSigmaOut: xresOut.proof, outAssetId };
  });

  // Tip aggregates.
  let tipA = 0n, tipB = 0n;
  for (const it of filled) {
    if (it.direction === 0) tipA += it.tipAmount;
    else tipB += it.tipAmount;
  }
  // Random tip blindings so tip commitments aren't identity.
  const r_tip_A = tipA === 0n ? randomScalar() : randomScalar();
  const r_tip_B = tipB === 0n ? randomScalar() : randomScalar();
  const tip_A_C_secp = pedersenCommit(tipA, r_tip_A);
  const tip_B_C_secp = pedersenCommit(tipB, r_tip_B);

  // Chain-side aggregate residue (one per asset).
  // For asset X: Σ_{X-side inputs} C_in_secp − Σ_{X-side outputs} C_out_secp − tip_X_C − Δx_signed·H = R_net_X · G
  // Solve for R_net_X by computing the LHS's G-coefficient.
  function computeRnet(assetXIsA) {
    let sum = ZERO;
    for (const it of filled) {
      const isInputSide = (assetXIsA && it.direction === 0) || (!assetXIsA && it.direction === 1);
      const isOutputSide = (assetXIsA && it.direction === 1) || (!assetXIsA && it.direction === 0);
      if (isInputSide)       sum = sum.add(it.C_in_secp);
      else if (isOutputSide) sum = sum.add(it.C_out_secp.negate());
    }
    sum = sum.add(assetXIsA ? tip_A_C_secp.negate() : tip_B_C_secp.negate());
    // Subtract delta·H. Δa_signed > 0 for A-dom (asset-A flowing into pool).
    let deltaSigned;
    if (assetXIsA) {
      deltaSigned = solve.direction === 'A→B' ? solve.delta_a_net
                  : solve.direction === 'B→A' ? -solve.delta_a_net : 0n;
    } else {
      deltaSigned = solve.direction === 'A→B' ? -solve.delta_b_net
                  : solve.direction === 'B→A' ? solve.delta_b_net : 0n;
    }
    if (deltaSigned !== 0n) {
      const mag = deltaSigned < 0n ? -deltaSigned : deltaSigned;
      const dH = H.multiply(mag);
      sum = sum.add(deltaSigned > 0n ? dH.negate() : dH);
    }
    // sum should equal R_net·G. Recover R_net via DLP — but here we control the
    // construction, so r_net = Σ (input blindings of X side) − Σ (output blindings) − r_tip_X − (sign-adjusted 0).
    let r = 0n;
    for (const it of filled) {
      const isInputSide = (assetXIsA && it.direction === 0) || (!assetXIsA && it.direction === 1);
      const isOutputSide = (assetXIsA && it.direction === 1) || (!assetXIsA && it.direction === 0);
      if (isInputSide) r = modN(r + it.r_in_secp);
      else if (isOutputSide) r = modN(r - it.r_out_secp);
    }
    r = modN(r - (assetXIsA ? r_tip_A : r_tip_B));
    return r;
  }
  const r_net_A = computeRnet(true);
  const r_net_B = computeRnet(false);

  // Direction signs.
  let dA_sign = 0, dB_sign = 0;
  if (solve.direction === 'A→B') { dA_sign = 0; dB_sign = 1; }
  else if (solve.direction === 'B→A') { dA_sign = 1; dB_sign = 0; }

  // Build envelope.
  const args = {
    assetA: pool.asset_A, assetB: pool.asset_B,
    nIntents: filled.length,
    deltaANetSigned: dA_sign === 0 ? solve.delta_a_net : -solve.delta_a_net,
    deltaBNetSigned: dB_sign === 0 ? solve.delta_b_net : -solve.delta_b_net,
    rNetA: bigintToBytes32(r_net_A), rNetB: bigintToBytes32(r_net_B),
    feeBpsAtSettle: pool.fee_bps,
    tipAAmount: tipA, tipBAmount: tipB,
    tipACSecp: pointToBytes(tip_A_C_secp), tipBCSecp: pointToBytes(tip_B_C_secp),
    rTipA: bigintToBytes32(r_tip_A), rTipB: bigintToBytes32(r_tip_B),
    arbiterBlock: null,
    intents: filled.map(it => ({
      direction: it.direction, traderPubkey: it.traderPubkey,
      cInSecp: pointToBytes(it.C_in_secp), cInBjj: packPoint(it.C_in_BJJ),
      inXcurveSigma: it.xcurveSigma,
      minOut: it.minOut, tipAmount: it.tipAmount, expiryHeight: it.expiryHeight,
      intentSig: it.intentSig,
    })),
    receipts: filled.map(it => ({
      cOutSecp: pointToBytes(it.C_out_secp), cOutBjj: packPoint(it.C_out_BJJ),
      outXcurveSigma: it.xcurveSigmaOut,
    })),
    proof: new Uint8Array(256),                            // Groth16 stub
  };
  const payload = encodeSwapBatch(args);
  const envelopeHash = computeEnvelopeHash(payload);

  // Build the Bitcoin tx layout.
  const txid = syntheticTxid(`swap-${chain.height}`);
  const tx = {
    vin: [
      { txid: 'envelope', vout: 0 },
      ...filled.map(it => ({ txid: it.inputUtxo.txid, vout: it.inputUtxo.vout })),
    ],
    vout: [
      // vout[0] = OP_RETURN(envelope_hash)
      { value: 0, scriptPubKey: concatBytes(new Uint8Array([0x6a, 0x20]), envelopeHash), txdata: null },
      // vout[1+i] = trader receipts
      ...filled.map(it => ({
        value: 546,
        scriptPubKey: it.receiveScriptPubKey,
        txdata: {
          type: 'SWAP_RECEIPT',
          assetId: it.outAssetId,
          amount: it.amountOut,
          blinding: it.r_out_secp,
          commitment: it.C_out_secp,
        },
      })),
    ],
    txid, envelope: payload,
  };
  chain.broadcast(tx);
  chain.confirm(3);

  // Indexer validation.
  const result = validateSwapBatch({
    payload, pool,
    opReturnData: envelopeHash,
    inputCommitmentsByIntent: filled.map(it => [it.C_in_secp]),
    intentInputUtxos: filled.map(it => [{ txid: it.inputUtxo.txid, vout: it.inputUtxo.vout }]),
    receiveScripts: filled.map(it => it.receiveScriptPubKey),
    currentHeight: chain.height,
    groth16Verify: SKIP_GROTH16_VERIFY_UNSAFE,
  });
  if (!result.valid) throw new Error(`SWAP_BATCH rejected: ${result.reason}`);
  indexer.updatePool(result.newPoolState);

  // Credit trader receipts.
  filled.forEach((it, i) => {
    it.trader.registerUtxo({
      txid, vout: 1 + i, assetId: it.outAssetId,
      amount: it.amountOut, blinding: it.r_out_secp, commitment: it.C_out_secp,
    });
  });

  return { filled, solve, payload, envelopeHash, txid };
}

// ---- Indexer wrapper ----

export class AMMIndexer {
  constructor() {
    this.pools = new Map();                                // poolId hex → pool state
    this.lpAssetIdToPool = new Map();                      // lpAssetId hex → pool state
  }
  registerPool(state) {
    const key = bytesToHex(state.pool_id);
    this.pools.set(key, state);
    this.lpAssetIdToPool.set(bytesToHex(state.lp_asset_id), state);
  }
  updatePool(state) {
    this.pools.set(bytesToHex(state.pool_id), state);
  }
  getPool(poolId) {
    const key = typeof poolId === 'string' ? poolId : bytesToHex(poolId);
    return this.pools.get(key) || null;
  }
}
