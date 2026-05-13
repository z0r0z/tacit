// Indexer validator tests: golden flows + adversarial inputs.
//
// Exercises the full pipeline of {encode → validate} for each opcode, with
// canned witness data + injected proof stubs. Validates the validator
// catches the categories of cheat AMM.md flags.

import * as secp from '@noble/secp256k1';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes, randomScalar, bigintToBytes32,
} from './bulletproofs.mjs';
import { signSchnorr } from './composition.mjs';

import { encodeLpAdd, encodeLpRemove, encodeSwapBatch } from './amm-envelope.mjs';
import { derivePoolId, deriveAssetIdFromReveal, deriveLpAssetId } from './amm-asset.mjs';
import { proveXCurve } from './amm-sigma-xcurve.mjs';
import { N_BJJ, pedersenBJJ, packPoint } from './amm-bjj.mjs';
import { lpAddKernelSign, lpRemoveKernelSign } from './amm-kernel.mjs';
import { buildIntentMsg, signIntent, deriveIntentId, computeEnvelopeHash } from './amm-intent.mjs';
import { solveClearing, lpInitShares } from './amm-clearing.mjs';
import { validateLpAdd, validateLpRemove, validateSwapBatch } from './amm-validator.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

function fill(n, b) { const x = new Uint8Array(n); x.fill(b); return x; }

// Build canonical asset_ids (smaller first).
const ASSET_A = deriveAssetIdFromReveal('00'.repeat(31) + '01');
const ASSET_B = deriveAssetIdFromReveal('00'.repeat(31) + '02');
const [assetA, assetB] = ASSET_A[0] < ASSET_B[0]
  ? [ASSET_A, ASSET_B]
  : (ASSET_A[0] > ASSET_B[0] ? [ASSET_B, ASSET_A] : (() => {
      for (let i = 0; i < 32; i++) {
        if (ASSET_A[i] < ASSET_B[i]) return [ASSET_A, ASSET_B];
        if (ASSET_A[i] > ASSET_B[i]) return [ASSET_B, ASSET_A];
      }
      throw new Error('same');
    })());
const POOL_ID = derivePoolId(assetA, assetB);
const LP_ASSET_ID = deriveLpAssetId(POOL_ID);

// ---- Build a valid POOL_INIT ----
function buildPoolInitArgs(deltaA, deltaB) {
  const shareInit = lpInitShares(deltaA, deltaB, 1000n);
  const founderShares = shareInit.founder_shares;

  // Per-asset input setup: one UTXO per side, blinding sum known.
  const r_inA = randomScalar();
  const r_inB = randomScalar();
  const C_inA = pedersenCommit(deltaA, r_inA);
  const C_inB = pedersenCommit(deltaB, r_inB);
  const inputsA = [{ txid: 'aa'.repeat(32), vout: 0 }];
  const inputsB = [{ txid: 'bb'.repeat(32), vout: 0 }];

  // LP-share output commitment
  const r_share = randomScalar();
  const r_share_BJJ = (() => {
    while (true) {
      const buf = crypto.getRandomValues(new Uint8Array(32));
      let n = 0n;
      for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
      if (n > 0n && n < N_BJJ) return n;
    }
  })();
  const shareCSecp = pointToBytes(pedersenCommit(founderShares, r_share));
  const shareCBJJ = packPoint(pedersenBJJ(founderShares, r_share_BJJ));

  // Cross-curve binding proof for the share output
  const xres = proveXCurve({
    a: founderShares, r_secp: r_share, r_BJJ: r_share_BJJ,
    C_secp: pedersenCommit(founderShares, r_share),
    C_BJJ: pedersenBJJ(founderShares, r_share_BJJ),
  });

  // Kernel sigs under (sum_C_in - delta · H).x_only()
  const kSigA = lpAddKernelSign({
    variant: 1, poolId: POOL_ID, assetX: assetA, deltaX: deltaA,
    shareAmount: founderShares, shareCSecpBytes: shareCSecp,
    inputsX: inputsA, inputCommitments: [C_inA], excessX: r_inA,
  });
  const kSigB = lpAddKernelSign({
    variant: 1, poolId: POOL_ID, assetX: assetB, deltaX: deltaB,
    shareAmount: founderShares, shareCSecpBytes: shareCSecp,
    inputsX: inputsB, inputCommitments: [C_inB], excessX: r_inB,
  });

  return {
    variant: 1,
    assetA, assetB,
    deltaA, deltaB,
    shareAmount: founderShares,
    shareCSecp, shareCBJJ,
    shareXcurveSigma: xres.proof,
    kernelSigA: kSigA, kernelSigB: kSigB,
    feeBps: 30,
    vkCid: 'bafybeicbpoolinitvkcid',
    ceremonyCid: 'bafybeicbpoolinitceremony',
    arbiterPubkeys: [],
    launcherSigs: [],
    proof: new Uint8Array(256),
    // exported for the validator test:
    _ctx: {
      inputCommitmentsA: [C_inA], inputCommitmentsB: [C_inB],
      inputsA, inputsB,
      founderShares, totalShares: shareInit.total_shares,
    },
  };
}

console.log('T_LP_ADD validator — POOL_INIT golden path');
{
  const args = buildPoolInitArgs(1_000_000n, 2_000_000n);
  const payload = encodeLpAdd(args);
  const r = validateLpAdd({
    payload, pool: null,
    inputCommitmentsA: args._ctx.inputCommitmentsA,
    inputCommitmentsB: args._ctx.inputCommitmentsB,
    inputsA: args._ctx.inputsA,
    inputsB: args._ctx.inputsB,
  });
  test('POOL_INIT validates', () => r.valid === true);
  test('POOL_INIT initial reserve_A == deltaA', () => r.valid && r.newPoolState.reserve_A === 1_000_000n);
  test('POOL_INIT lp_asset_id matches derived', () => {
    if (!r.valid) return false;
    for (let i = 0; i < 32; i++) if (r.newPoolState.lp_asset_id[i] !== LP_ASSET_ID[i]) return false;
    return true;
  });
  test('POOL_INIT yields two receipts (founder + locked)', () => r.valid && r.receipts.length === 2);

  console.log('\nT_LP_ADD validator — POOL_INIT adversarial');
  test('POOL_INIT against existing pool ⇒ rejected', () => {
    const r2 = validateLpAdd({
      payload, pool: { pool_id: POOL_ID, reserve_A: 1n, reserve_B: 1n, lp_total_shares: 1n, fee_bps: 30 },
      inputCommitmentsA: args._ctx.inputCommitmentsA,
      inputCommitmentsB: args._ctx.inputCommitmentsB,
      inputsA: args._ctx.inputsA, inputsB: args._ctx.inputsB,
    });
    return !r2.valid && /already exists/.test(r2.reason);
  });
  test('non-canonical asset ordering ⇒ rejected', () => {
    const flipped = { ...args, assetA: assetB, assetB: assetA };
    const p2 = encodeLpAdd(flipped);
    const r2 = validateLpAdd({
      payload: p2, pool: null,
      inputCommitmentsA: args._ctx.inputCommitmentsA, inputCommitmentsB: args._ctx.inputCommitmentsB,
      inputsA: args._ctx.inputsA, inputsB: args._ctx.inputsB,
    });
    return !r2.valid && /lexicographically/.test(r2.reason);
  });
  test('forged kernel sig (wrong excess) ⇒ rejected', () => {
    // Swap kernel_sig_A with kernel_sig_B (which signs different fields)
    const bad = { ...args, kernelSigA: args.kernelSigB };
    const p2 = encodeLpAdd(bad);
    const r2 = validateLpAdd({
      payload: p2, pool: null,
      inputCommitmentsA: args._ctx.inputCommitmentsA, inputCommitmentsB: args._ctx.inputCommitmentsB,
      inputsA: args._ctx.inputsA, inputsB: args._ctx.inputsB,
    });
    return !r2.valid && /kernel/.test(r2.reason);
  });
}

console.log('\nT_LP_ADD validator — standard variant 0 against an active pool');
{
  // Establish pool from POOL_INIT, then add liquidity at the ratio.
  const init = buildPoolInitArgs(1_000_000n, 2_000_000n);
  const initRes = validateLpAdd({
    payload: encodeLpAdd(init), pool: null,
    inputCommitmentsA: init._ctx.inputCommitmentsA,
    inputCommitmentsB: init._ctx.inputCommitmentsB,
    inputsA: init._ctx.inputsA, inputsB: init._ctx.inputsB,
  });
  if (!initRes.valid) throw new Error(`POOL_INIT precondition failed: ${initRes.reason}`);
  const pool = initRes.newPoolState;

  // Add at the ratio: deltaA = 500, deltaB = 1000 (1:2)
  const deltaA = 500n, deltaB = 1000n;
  // Expected share = floor(min(500·total/1M, 1000·total/2M))
  const total = pool.lp_total_shares;
  const expShares = (500n * total) / 1_000_000n; // both formulas equal at the ratio

  const r_inA = randomScalar(), r_inB = randomScalar();
  const C_inA = pedersenCommit(deltaA, r_inA);
  const C_inB = pedersenCommit(deltaB, r_inB);
  const r_share = randomScalar();
  const r_share_BJJ = randomScalar() % N_BJJ;
  const shareCSecp = pointToBytes(pedersenCommit(expShares, r_share));
  const shareCBJJ = packPoint(pedersenBJJ(expShares, r_share_BJJ));
  const xres = proveXCurve({
    a: expShares, r_secp: r_share, r_BJJ: r_share_BJJ,
    C_secp: pedersenCommit(expShares, r_share),
    C_BJJ: pedersenBJJ(expShares, r_share_BJJ),
  });
  const inputsA = [{ txid: 'cc'.repeat(32), vout: 0 }];
  const inputsB = [{ txid: 'dd'.repeat(32), vout: 0 }];
  const kSigA = lpAddKernelSign({
    variant: 0, poolId: POOL_ID, assetX: assetA, deltaX: deltaA,
    shareAmount: expShares, shareCSecpBytes: shareCSecp,
    inputsX: inputsA, inputCommitments: [C_inA], excessX: r_inA,
  });
  const kSigB = lpAddKernelSign({
    variant: 0, poolId: POOL_ID, assetX: assetB, deltaX: deltaB,
    shareAmount: expShares, shareCSecpBytes: shareCSecp,
    inputsX: inputsB, inputCommitments: [C_inB], excessX: r_inB,
  });
  const args = {
    variant: 0, assetA, assetB, deltaA, deltaB, shareAmount: expShares,
    shareCSecp, shareCBJJ, shareXcurveSigma: xres.proof,
    kernelSigA: kSigA, kernelSigB: kSigB,
    proof: new Uint8Array(256),
  };
  const payload = encodeLpAdd(args);
  const r = validateLpAdd({
    payload, pool,
    inputCommitmentsA: [C_inA], inputCommitmentsB: [C_inB],
    inputsA, inputsB,
  });

  test('valid LP_ADD validates', () => r.valid === true);
  test('post-add reserve_A = 1.0005M', () => r.valid && r.newPoolState.reserve_A === 1_000_500n);
  test('post-add reserve_B = 2.001M', () => r.valid && r.newPoolState.reserve_B === 2_001_000n);
  test('lp_total_shares grew by expShares', () => r.valid && r.newPoolState.lp_total_shares === pool.lp_total_shares + expShares);

  test('LP_ADD with wrong shareAmount ⇒ rejected', () => {
    const bad = { ...args, shareAmount: expShares + 1n };
    // We'd need to re-sign with the new shareAmount in the kernel msg for the
    // kernel sig itself to pass — and then the validator catches the at-the-
    // ratio share-formula mismatch. So build a properly-signed bad envelope.
    const badShareCSecp = pointToBytes(pedersenCommit(expShares + 1n, r_share));
    const badShareCBJJ = packPoint(pedersenBJJ(expShares + 1n, r_share_BJJ));
    const badXres = proveXCurve({
      a: expShares + 1n, r_secp: r_share, r_BJJ: r_share_BJJ,
      C_secp: pedersenCommit(expShares + 1n, r_share),
      C_BJJ: pedersenBJJ(expShares + 1n, r_share_BJJ),
    });
    const badKSigA = lpAddKernelSign({
      variant: 0, poolId: POOL_ID, assetX: assetA, deltaX: deltaA,
      shareAmount: expShares + 1n, shareCSecpBytes: badShareCSecp,
      inputsX: inputsA, inputCommitments: [C_inA], excessX: r_inA,
    });
    const badKSigB = lpAddKernelSign({
      variant: 0, poolId: POOL_ID, assetX: assetB, deltaX: deltaB,
      shareAmount: expShares + 1n, shareCSecpBytes: badShareCSecp,
      inputsX: inputsB, inputCommitments: [C_inB], excessX: r_inB,
    });
    const badArgs = {
      ...args, shareAmount: expShares + 1n,
      shareCSecp: badShareCSecp, shareCBJJ: badShareCBJJ,
      shareXcurveSigma: badXres.proof,
      kernelSigA: badKSigA, kernelSigB: badKSigB,
    };
    const r2 = validateLpAdd({
      payload: encodeLpAdd(badArgs), pool,
      inputCommitmentsA: [C_inA], inputCommitmentsB: [C_inB],
      inputsA, inputsB,
    });
    return !r2.valid && /shareAmount/.test(r2.reason);
  });
}

console.log('\nT_SWAP_BATCH validator — envelope_hash binding');
{
  // Minimal smoke test: an envelope decoded with the right OP_RETURN binds.
  // Construct a fake pool + payload with a single intent. The aggregate
  // Pedersen check is exercised; clearing constraints are exercised.
  const pool = {
    pool_id: POOL_ID, asset_A: assetA, asset_B: assetB,
    fee_bps: 30, reserve_A: 1_000_000n, reserve_B: 2_000_000n,
    lp_total_shares: 1_414_213n,
    inclusion_arbiter_pubkeys: [],
  };

  // Single A→B intent: amount_in = 1000n, full input goes in (no tip for simplicity in this test).
  const sk = new Uint8Array(32); for (let i = 0; i < 32; i++) sk[i] = i + 1;
  const traderPub = secp.ProjectivePoint.fromPrivateKey(sk).toRawBytes(true);
  const amountIn = 1000n;
  const r_in = randomScalar();
  const r_in_BJJ = randomScalar() % N_BJJ;
  const C_in_secp = pedersenCommit(amountIn, r_in);
  const C_in_BJJ = pedersenBJJ(amountIn, r_in_BJJ);
  const xres = proveXCurve({
    a: amountIn, r_secp: r_in, r_BJJ: r_in_BJJ, C_secp: C_in_secp, C_BJJ: C_in_BJJ,
  });

  const recvSpk = new Uint8Array([0x00, 0x14, ...fill(20, 0xab)]);
  const inputUtxos = [{ txid: 'ee'.repeat(32), vout: 0 }];

  // Solve: with X=1000, Y=0, R_A=1M, R_B=2M, fee=30
  const sol = solveClearing(amountIn, 0n, pool.reserve_A, pool.reserve_B, BigInt(pool.fee_bps));
  // Receipt: amount_out = 1000 · delta_B_net / delta_A_net (A→B trader)
  const amountOut = (amountIn * sol.P_clear_den) / sol.P_clear_num;
  // For the chain-side Pedersen check to balance, r_out + tip = r_in - delta_a · 1 (kind of)
  // The simplest: trader's r_out_secp is deterministic from privkey + anchor.
  // We just need: Σ C_in - Σ C_out - tip_C - delta_signed·H == r_net · G
  // With one A→B trader: Σ C_in_A = C_in, Σ C_out_A = 0 (output is asset B).
  // For asset A side: C_in - 0 - tip_A_C - delta_A·H == r_net_A · G
  // We have no tip in this test ⇒ tip_A_C = pedersenCommit(0, r_tip) = r_tip · G
  // So: C_in - r_tip·G - amountIn·H == r_net_A · G
  // ⇒ r_net_A = r_in - r_tip  (mod n_secp)
  // Use a non-zero blinding (identity point can't be serialized as compressed).
  const r_tip_A = randomScalar();
  const r_tip_B = randomScalar();
  const tip_A_C_secp = pointToBytes(pedersenCommit(0n, r_tip_A));
  const tip_B_C_secp = pointToBytes(pedersenCommit(0n, r_tip_B));
  const r_net_A = modN(r_in - r_tip_A);

  // Asset B side: 0 inputs, 1 output (the trader's receipt) + tip output.
  // Aggregate: 0 - C_out_B - tip_B_C - (-amount_out)·H == r_net_B · G
  // ⇒ -C_out_B - tip_B_C + amount_out·H = r_net_B · G
  // ⇒ -(amount_out·H + r_out·G) - r_tip_B·G + amount_out·H = r_net_B · G
  // ⇒ -(r_out + r_tip_B) · G = r_net_B · G
  // ⇒ r_net_B = -(r_out + r_tip_B) mod n_secp
  const r_out_secp = randomScalar();
  const r_out_BJJ = randomScalar() % N_BJJ;
  const C_out_secp = pedersenCommit(amountOut, r_out_secp);
  const C_out_BJJ = pedersenBJJ(amountOut, r_out_BJJ);
  const xresOut = proveXCurve({
    a: amountOut, r_secp: r_out_secp, r_BJJ: r_out_BJJ, C_secp: C_out_secp, C_BJJ: C_out_BJJ,
  });
  const r_net_B = modN(SECP_N - (r_out_secp + r_tip_B));

  const intent = {
    direction: 0,
    traderPubkey: traderPub,
    cInSecp: pointToBytes(C_in_secp), cInBjj: packPoint(C_in_BJJ),
    inXcurveSigma: xres.proof,
    minOut: 0n, tipAmount: 0n,
    expiryHeight: 999999, intentSig: new Uint8Array(64), // will fill below
  };

  const intentMsg = buildIntentMsg({
    poolId: POOL_ID, direction: 0, inputUtxos,
    cInSecp: intent.cInSecp, cInBjj: intent.cInBjj, xcurveSigma: intent.inXcurveSigma,
    receiveScriptPubKey: recvSpk,
    minOut: 0n, tipAmount: 0n, tipAsset: 0,
    expiryHeight: 999999, traderPubkey: traderPub,
  });
  intent.intentSig = signIntent(intentMsg, sk);

  const args = {
    assetA, assetB, nIntents: 1,
    deltaANetSigned: sol.delta_a_net,           // > 0 (A→B-dom)
    deltaBNetSigned: -sol.delta_b_net,          // < 0
    rNetA: bigintToBytes32(r_net_A), rNetB: bigintToBytes32(r_net_B),
    feeBpsAtSettle: 30,
    tipAAmount: 0n, tipBAmount: 0n,
    tipACSecp: tip_A_C_secp, tipBCSecp: tip_B_C_secp,
    rTipA: bigintToBytes32(r_tip_A), rTipB: bigintToBytes32(r_tip_B),
    arbiterBlock: null,
    intents: [intent],
    receipts: [{
      cOutSecp: pointToBytes(C_out_secp),
      cOutBjj: packPoint(C_out_BJJ),
      outXcurveSigma: xresOut.proof,
    }],
    proof: new Uint8Array(256),
  };
  const payload = encodeSwapBatch(args);
  const opReturn = computeEnvelopeHash(payload);
  const r = validateSwapBatch({
    payload, pool,
    opReturnData: opReturn,
    inputCommitmentsByIntent: [[C_in_secp]],
    intentInputUtxos: [inputUtxos],
    receiveScripts: [recvSpk],
    currentHeight: 800000,
  });
  test('honest swap batch validates', () => {
    if (!r.valid) console.log(`     reason: ${r.reason}`);
    return r.valid === true;
  });
  test('post-swap reserve_A grew', () => r.valid && r.newPoolState.reserve_A === pool.reserve_A + sol.delta_a_net);
  test('post-swap reserve_B shrank', () => r.valid && r.newPoolState.reserve_B === pool.reserve_B - sol.delta_b_net);

  test('wrong OP_RETURN data ⇒ rejected', () => {
    const bad = new Uint8Array(opReturn); bad[0] ^= 0x01;
    const r2 = validateSwapBatch({
      payload, pool, opReturnData: bad,
      inputCommitmentsByIntent: [[C_in_secp]],
      intentInputUtxos: [inputUtxos],
      receiveScripts: [recvSpk],
      currentHeight: 800000,
    });
    return !r2.valid && /OP_RETURN/.test(r2.reason);
  });
  test('missing OP_RETURN ⇒ rejected', () => {
    const r2 = validateSwapBatch({
      payload, pool, opReturnData: null,
      inputCommitmentsByIntent: [[C_in_secp]],
      intentInputUtxos: [inputUtxos],
      receiveScripts: [recvSpk],
      currentHeight: 800000,
    });
    return !r2.valid && /OP_RETURN/.test(r2.reason);
  });
  test('expired intent ⇒ rejected', () => {
    // Run validator at a height past the intent's expiry.
    const r2 = validateSwapBatch({
      payload, pool, opReturnData: opReturn,
      inputCommitmentsByIntent: [[C_in_secp]],
      intentInputUtxos: [inputUtxos],
      receiveScripts: [recvSpk],
      currentHeight: 1_000_000,
    });
    return !r2.valid && /expired/.test(r2.reason);
  });
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
