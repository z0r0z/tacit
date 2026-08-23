// OP_SWAP_BLIND (31 / 0x1F) settle-side emitter — the prover-blind confidential AMM batch.
//
// This is the EVM settle twin of the reflection T_SWAP_BATCH fold. It assembles the exact envelope
// the guest's OP_SWAP_BLIND arm reads (src/main.rs:1665..1865) and computed via swap_blind.rs
// verify_clearing: a REAL amm_swap_batch Groth16 proof over the 123 public signals, per-asset
// aggregate Pedersen blindings, per-receipt cross-curve sigmas, and per-intent blind opening PoKs.
//
// The op ships DORMANT in the guest (no live emitter); this module is the reviewable settle-side
// builder for arming it post-launch. It DOES NOT reimplement any crypto: every primitive is imported
// from the same modules the reflection fold + OP_SWAP emitter use, so the guest agrees byte-for-byte.
//
// Reuses:
//   - solveClearing            (./confidential-swap.js)   — the batch-auction uniform clearing solver
//   - pedersenBJJ, packPoint,
//     N_BJJ                     (./amm-bjj.js)             — BJJ commitments (== guest babyjubjub.rs)
//   - proveXCurveDeterministic  (./amm-sigma.js)          — C_secp ↔ C_BJJ cross-curve sigma (169 B)
//   - pedersenCommit, pointToBytes,
//     SECP_N, modN              (./bulletproofs.js)        — secp Pedersen commit + tip/aggregate math
//   - pool.{commitXY,leaf,nullifier,openingPokBlind,intentContext}
//                               (makeConfidentialPool)     — note leaf + blind intent authorization
//
// buildSwapInput mirrors dapp/circuits/amm/dev-zkey/demo_swap_batch.mjs (which mirrors
// dapp/circuits/amm/witness-test.mjs); kept inline so this module is self-contained.

import { solveClearing } from './confidential-swap.js';
import { pedersenBJJ, packPoint, N_BJJ, P_FR, mod as modField } from './amm-bjj.js';
import { proveXCurveDeterministic } from './amm-sigma.js';
import { SECP_N, modN, pedersenCommit, pointToBytes } from './bulletproofs.js';
import { sha256 } from './vendor/tacit-deps.min.js';

const N_MAX = 16;
const SWAP_DIR_A_TO_B = 0;
const SWAP_DIR_B_TO_A = 1;
// Guest intent-context domain (src/main.rs:1790). MUST match exactly or verify_opening_pok_blind fails.
const SWAP_BLIND_INTENT_TAG = 'tacit-swap-blind-intent-v1';

const hexToBytes = (h) => { h = String(h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const be32 = (n) => { const o = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const be32hex = (n) => bytesToHex(be32(n));

function randScalar(mod) {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n; for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < mod) return n;
  }
}

// amount_out for one trader under the uniform clearing price (B per A), floored, with the remainder.
// Mirror of buildSwapInput's per-trader fill (demo_swap_batch.mjs) + the guest's clearing_price check.
function fillTrader(direction, amountIn, P_clear_num, P_clear_den) {
  const [mult, div] = direction === SWAP_DIR_A_TO_B
    ? [BigInt(P_clear_den), BigInt(P_clear_num)]
    : [BigInt(P_clear_num), BigInt(P_clear_den)];
  const num = BigInt(amountIn) * mult;
  const amountOut = num / div;
  return { amountOut, rem: num - amountOut * div };
}

// Build the 123-signal amm_swap_batch circuit input from the batch. Mirrors buildSwapInput in
// demo_swap_batch.mjs: per-intent tips are 0 (OP_SWAP_BLIND forces global tips to 0), so tip_amount
// and tip_A/B_amount are all 0. Returns { input, filled, deltas } where `filled` carries the per-intent
// amount/out/blindings the envelope + sigmas reuse (so the proof and the Pedersen bindings agree).
export function buildSwapInput({ poolIdFr, R_A, R_B, fee_bps, traders }) {
  const X = traders.filter(t => t.direction === SWAP_DIR_A_TO_B).reduce((s, t) => s + BigInt(t.amountIn), 0n);
  const Y = traders.filter(t => t.direction === SWAP_DIR_B_TO_A).reduce((s, t) => s + BigInt(t.amountIn), 0n);
  const solve = solveClearing(X, Y, BigInt(R_A), BigInt(R_B), BigInt(fee_bps));

  const direction   = new Array(N_MAX).fill('0');
  const min_out     = new Array(N_MAX).fill('0');
  const tip_amount  = new Array(N_MAX).fill('0');
  const amount_in_swap     = new Array(N_MAX).fill('0');
  const tip_amount_witness = new Array(N_MAX).fill('0');
  const r_in_BJJ    = new Array(N_MAX).fill('0');
  const amount_out  = new Array(N_MAX).fill('0');
  const rem         = new Array(N_MAX).fill('0');
  const r_out_BJJ   = new Array(N_MAX).fill('0');
  const C_in_BJJ_u  = new Array(N_MAX).fill('0');
  const C_in_BJJ_v  = new Array(N_MAX).fill('1'); // BJJ identity (0,1)
  const C_out_BJJ_u = new Array(N_MAX).fill('0');
  const C_out_BJJ_v = new Array(N_MAX).fill('1');

  const filled = [];
  for (let i = 0; i < traders.length; i++) {
    const t = traders[i];
    const { amountOut, rem: r } = fillTrader(t.direction, t.amountIn, solve.P_clear_num, solve.P_clear_den);
    // tip == 0 ⇒ the circuit's inTotal == amount_in_swap.
    const rInBJJ = randScalar(N_BJJ);
    const rOutBJJ = randScalar(N_BJJ);
    const Cin = pedersenBJJ(BigInt(t.amountIn), rInBJJ);
    const Cout = pedersenBJJ(amountOut, rOutBJJ);

    direction[i]          = String(t.direction);
    min_out[i]            = BigInt(t.minOut).toString();
    amount_in_swap[i]     = BigInt(t.amountIn).toString();
    r_in_BJJ[i]           = rInBJJ.toString();
    amount_out[i]         = amountOut.toString();
    rem[i]                = r.toString();
    r_out_BJJ[i]          = rOutBJJ.toString();
    C_in_BJJ_u[i]         = Cin[0].toString();
    C_in_BJJ_v[i]         = Cin[1].toString();
    C_out_BJJ_u[i]        = Cout[0].toString();
    C_out_BJJ_v[i]        = Cout[1].toString();

    filled.push({ ...t, amountOut, rem: r, rInBJJ, rOutBJJ, cInBjj: packPoint(Cin), cOutBjj: packPoint(Cout) });
  }

  // Net reserve move from the actual fills (the value part of the aggregate Pedersen identity): the
  // pool gains each A→B trader's asset-A input and pays each B→A trader's asset-A output (mirror for B).
  // delta_X = Σ_{X in} input − Σ_{X out} output; sign 0 = pool grows X, 1 = pool loses X. These are the
  // circuit's declared net deltas — the in-circuit P_clear (X_sum + |Δa|, Y_sum + |Δb|) re-derives from
  // exactly these, so the Groth16 fills and the chain-side identity agree.
  let netA = 0n, netB = 0n;
  for (const t of filled) {
    if (t.direction === SWAP_DIR_A_TO_B) { netA += BigInt(t.amountIn); netB -= t.amountOut; }
    else                                 { netB += BigInt(t.amountIn); netA -= t.amountOut; }
  }
  const deltaA_sign = netA < 0n ? 1 : 0, deltaA_mag = netA < 0n ? -netA : netA;
  const deltaB_sign = netB < 0n ? 1 : 0, deltaB_mag = netB < 0n ? -netB : netB;

  const input = {
    pool_id_fr           : String(poolIdFr),
    R_A_pre              : BigInt(R_A).toString(),
    R_B_pre              : BigInt(R_B).toString(),
    delta_A_net_sign     : String(deltaA_sign),
    delta_A_net_magnitude: deltaA_mag.toString(),
    delta_B_net_sign     : String(deltaB_sign),
    delta_B_net_magnitude: deltaB_mag.toString(),
    tip_A_amount         : '0',
    tip_B_amount         : '0',
    fee_bps              : String(fee_bps),
    n_intents            : String(traders.length),
    direction, C_in_BJJ_u, C_in_BJJ_v, min_out, tip_amount,
    C_out_BJJ_u, C_out_BJJ_v,
    amount_in_swap, tip_amount_witness, r_in_BJJ,
    amount_out, rem, r_out_BJJ,
  };
  const deltas = {
    deltaANetSign: deltaA_sign, deltaANetMag: deltaA_mag,
    deltaBNetSign: deltaB_sign, deltaBNetMag: deltaB_mag,
  };
  return { input, filled, deltas };
}

// pool_id_fr = SHA256(pool_id) mod P_FR (BN254 scalar field) — the exact value swap_batch.rs
// swap_batch_public_signals pushes as signal[0] (SHA256(pool_id) mod r). `poolIdHex` is the
// Bitcoin-canonical circuit pool id: amm_derive_pool_id_v1(assetA, assetB, feeBps).
function poolIdFr(poolIdHex) {
  const d = sha256(hexToBytes(poolIdHex));
  let n = 0n; for (const x of d) n = (n << 8n) | BigInt(x);
  return modField(n, P_FR);
}

// The factory. Injected deps keep this module free of tacit.js internals:
//   pool          — makeConfidentialPool(...) (commitXY/leaf/nullifier/openingPokBlind/intentContext)
//   proveGroth16  — async ({ input }) => Uint8Array(256): fetch amm_swap_batch.wasm + the FINALIZED
//                   ceremony zkey (tacit.js _fetchAmmZkey('swap_batch') → ceremonyFetchHeadZkeyBytes),
//                   snarkjs.groth16.fullProve(input, wasm, zkey), then _serializeGroth16Proof(proof).
//                   See TODO[proveGroth16] below for the exact wiring.
//   ammDerivePoolIdV1 — (assetA, assetB, feeBps) => hex: the Bitcoin-canonical circuit pool id
//                   (pool.ammDerivePoolIdFull(lo, hi, feeBps, 0, ZERO33, 0) with pf==0), == the guest's
//                   amm_derive_pool_id_v1.
export function makeConfidentialSwapblind({ pool, proveGroth16, ammDerivePoolIdV1 }) {
  const { commitXY, leaf, nullifier, openingPokBlind, deriveOpeningNonce, intentContext, decompressCommitment, poolIdWithProtocolFee } = pool;

  // reserve ± mag, sign 0 grows / 1 shrinks (mirror apply_signed), as a BigInt.
  const applySigned = (reserve, sign, mag) => (Number(sign) === 0 ? BigInt(reserve) + BigInt(mag) : BigInt(reserve) - BigInt(mag));

  // Build the OP_SWAP_BLIND settle envelope for one prover-blind batch.
  //
  // traders[]: each { direction (0=A→B,1=B→A), amountIn, minOut, deadline,
  //   inNote:  { cx, cy, owner, rSecp, leafIndex, path[32] } — a REAL spent pool note of the INPUT
  //            asset (direction 0 ⇒ asset A, 1 ⇒ asset B); rSecp is its secp Pedersen blinding, path
  //            its membership branch under `spendRoot`.
  //   outOwner:      the receipt note's fresh owner (bearer),
  //   rOutSecp:      the receipt note's secp blinding (settler-chosen).
  // }
  //
  // Returns { envelope, fixture } — `envelope` in the guest read order; `fixture` is the
  // fixtures/swapblind_op.json shape exec-swapblind.rs consumes.
  async function buildSwapBlindOp({ chainBinding, assetA, assetB, feeBps, reserveAPre, reserveBPre, traders, spendRoot = null }) {
    if (traders.length < 1 || traders.length > N_MAX) throw new Error('swap-blind: 1..16 intents');
    // Canonical orientation (asset_a < asset_b), as the guest asserts (main.rs:1685).
    if (!(BigInt(assetA) < BigInt(assetB))) throw new Error('swap-blind: assets must be canonically ordered A<B');

    const circuitPoolId = ammDerivePoolIdV1(assetA, assetB, feeBps);
    const { input, filled, deltas } = buildSwapInput({
      poolIdFr: poolIdFr(circuitPoolId),
      R_A: reserveAPre, R_B: reserveBPre, fee_bps: feeBps, traders,
    });

    // 1. REAL Groth16 proof over the 123 signals (the finalized ceremony zkey). 256-byte serialized.
    const proof = await proveGroth16({ input }); // TODO[proveGroth16]: see factory doc.
    if (!(proof instanceof Uint8Array) || proof.length !== 256) throw new Error('swap-blind: proof must be 256 bytes');

    // 2. Per-intent secp commitments, cross-curve sigmas, and blind opening PoKs.
    const intents = [];
    const receipts = [];
    const fixtureIntents = [];
    for (let i = 0; i < filled.length; i++) {
      const t = filled[i];
      const inAsset = t.direction === SWAP_DIR_A_TO_B ? assetA : assetB;

      // Input secp commitment MUST equal the real note's commitment (its leaf is proven a member of
      // spendRoot). C_in_secp = pedersenCommit(amountIn, rSecp) — the guest re-derives it from the
      // witnessed (cx,cy) via compress(), and the aggregate identity reuses it.
      const rInSecp = modN(BigInt(t.inNote.rSecp));
      const CinSecp = pedersenCommit(BigInt(t.amountIn), rInSecp);
      const cInSecpBytes = pointToBytes(CinSecp);
      const inXY = commitXY(BigInt(t.amountIn), rInSecp); // { cx, cy } affine, for the leaf + witness
      // Input cross-curve sigma: binds C_in_secp ↔ C_in_BJJ for amount = amountIn.
      const inXcurve = proveXCurveDeterministic({
        a: BigInt(t.amountIn), r_secp: rInSecp, r_BJJ: BigInt(t.rInBJJ),
        C_secp: CinSecp, C_BJJ: pedersenBJJ(BigInt(t.amountIn), BigInt(t.rInBJJ)),
        seedKey: hexToBytes(chainBinding),
      }).proof;

      // Output receipt secp commitment + cross-curve sigma for amount = amountOut.
      const rOutSecp = modN(BigInt(t.rOutSecp));
      const outXY = commitXY(t.amountOut, rOutSecp);
      const CoutSecp = pedersenCommit(t.amountOut, rOutSecp);
      const cOutSecpBytes = pointToBytes(CoutSecp);
      const outXcurve = proveXCurveDeterministic({
        a: t.amountOut, r_secp: rOutSecp, r_BJJ: BigInt(t.rOutBJJ),
        C_secp: CoutSecp, C_BJJ: pedersenBJJ(t.amountOut, BigInt(t.rOutBJJ)),
        seedKey: hexToBytes(chainBinding),
      }).proof;

      // Blind opening PoK over the guest's intent context (main.rs:1789..1800). Anti-redirect: binds
      // out_owner / min_out / direction / deadline WITHOUT revealing the amount.
      const ctx = intentContext(
        SWAP_BLIND_INTENT_TAG, chainBinding, assetA, assetB,
        [[inXY.cx, inXY.cy, t.inNote.owner], [outXY.cx, outXY.cy, t.outOwner]],
        [BigInt(t.direction), BigInt(t.minOut), BigInt(t.deadline ?? 0)],
      );
      // openingPokBlind requires explicit nonces; derive them per (blinding, ctx) like confidential-lp.js.
      const pok = openingPokBlind(
        BigInt(t.amountIn), rInSecp, ctx,
        deriveOpeningNonce(rInSecp, ctx, `swapblind-${i}-v`),
        deriveOpeningNonce(rInSecp, ctx, `swapblind-${i}-r`),
      );

      intents.push({
        direction: t.direction,
        cInSecp: cInSecpBytes,
        cInBjj: t.cInBjj,
        minOut: BigInt(t.minOut),
        tipAmount: 0n, // guest hardcodes 0 (main.rs:1808)
        rInSecp,
      });
      receipts.push({
        cOutSecp: cOutSecpBytes,
        cOutBjj: t.cOutBjj,
        outXcurveSigma: outXcurve,
        rOutSecp,
      });
      // commitXY / openingPokBlind already return 0x-hex strings; the xcurve sigmas are Uint8Array(169).
      fixtureIntents.push({
        direction: t.direction,
        inCx: inXY.cx, inCy: inXY.cy,
        inOwner: t.inNote.owner,
        inLeafIndex: Number(t.inNote.leafIndex),
        inPath: t.inNote.path,
        cInBjj: bytesToHex(t.cInBjj),
        inXcurveSigma: bytesToHex(inXcurve),
        minOut: Number(t.minOut),
        deadline: Number(t.deadline ?? 0),
        outCx: outXY.cx, outCy: outXY.cy,
        outOwner: t.outOwner,
        cOutBjj: bytesToHex(t.cOutBjj),
        outXcurveSigma: bytesToHex(outXcurve),
        pokR: pok.R, pokZv: pok.zV, pokZr: pok.zR,
      });
    }

    // 3. Tips are 0. tip_X_C_secp = pedersenCommit(0, rTipX); the guest verifies verify_pedersen_opening
    //    before rTipX enters the aggregate identity.
    const rTipA = randScalar(SECP_N), rTipB = randScalar(SECP_N);
    const tipACSecp = pointToBytes(pedersenCommit(0n, rTipA));
    const tipBCSecp = pointToBytes(pedersenCommit(0n, rTipB));

    // 4. Per-asset aggregate Pedersen blindings r_net_a / r_net_b. From the worker's
    //    ammCheckAggregatePedersen identity (worker/src/index.js:3477): for asset X,
    //      Σ_{input-side} C_in_secp − Σ_{output-side} C_out_secp − tip_X − delta_X·H  ==  r_net_X · G.
    //    Value (H) terms cancel by clearing conservation (tip amount 0), leaving the blinding sum:
    //      r_net_X = ( Σ_{input-side} r_in_secp − Σ_{output-side} r_out_secp − r_tip_X ) mod SECP_N.
    //    Input side for asset A = direction 0 (A→B); output side = direction 1 (B→A). Mirror for B.
    const rNetFor = (assetXIsA, rTipX) => {
      let acc = 0n;
      for (let i = 0; i < filled.length; i++) {
        const dir = filled[i].direction;
        const isInput  = (assetXIsA && dir === SWAP_DIR_A_TO_B) || (!assetXIsA && dir === SWAP_DIR_B_TO_A);
        const isOutput = (assetXIsA && dir === SWAP_DIR_B_TO_A) || (!assetXIsA && dir === SWAP_DIR_A_TO_B);
        if (isInput)  acc = modN(acc + intents[i].rInSecp);
        if (isOutput) acc = modN(acc - receipts[i].rOutSecp);
      }
      return modN(acc - rTipX);
    };
    const rNetA = rNetFor(true, rTipA);
    const rNetB = rNetFor(false, rTipB);

    // EVM pool id the contract gates pre==live + sets post (pf==0 ⇒ no-skim id). Callers pass the same
    // recipient-less derivation; protocolFeeRecipient defaults to all-zero (33B) as the guest reads r33.
    const envelope = {
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: '0x' + '00'.repeat(33),
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre),
      ...deltas,
      rNetA: be32hex(rNetA), rNetB: be32hex(rNetB),
      tipAAmount: 0n, tipACSecp: bytesToHex(tipACSecp), rTipA: be32hex(rTipA),
      tipBAmount: 0n, tipBCSecp: bytesToHex(tipBCSecp), rTipB: be32hex(rTipB),
      nIntents: filled.length,
      proof: bytesToHex(proof),
      intents, receipts,
    };

    const reserveAPost = applySigned(reserveAPre, deltas.deltaANetSign, deltas.deltaANetMag);
    const reserveBPost = applySigned(reserveBPre, deltas.deltaBNetSign, deltas.deltaBNetMag);
    const evmPoolId = poolIdWithProtocolFee
      ? poolIdWithProtocolFee(assetA, assetB, feeBps, envelope.protocolFeeRecipient, 0)
      : null;

    const fixture = {
      note: 'OP_SWAP_BLIND prover-blind confidential AMM batch. Fields in exec-swapblind.rs read order.',
      chainBinding,
      spendRoot, // the settle spend-set root the inNote.path proves membership against (caller-supplied).
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: envelope.protocolFeeRecipient,
      reserveAPre: Number(reserveAPre), reserveBPre: Number(reserveBPre),
      deltaANetSign: deltas.deltaANetSign, deltaANetMag: Number(deltas.deltaANetMag),
      deltaBNetSign: deltas.deltaBNetSign, deltaBNetMag: Number(deltas.deltaBNetMag),
      rNetA: envelope.rNetA, rNetB: envelope.rNetB,
      tipAAmount: 0, tipACSecp: envelope.tipACSecp, rTipA: envelope.rTipA,
      tipBAmount: 0, tipBCSecp: envelope.tipBCSecp, rTipB: envelope.rTipB,
      proof: envelope.proof,
      intents: fixtureIntents,
      expected: {
        // poolId = pool_id_with_protocol_fee(assetA,assetB,feeBps,recipient,0) (the EVM slot id the
        // contract gates); post-reserves from applying the net deltas to the pre-reserves.
        poolId: evmPoolId,
        reserveAPost: Number(reserveAPost),
        reserveBPost: Number(reserveBPost),
      },
    };

    return { envelope, fixture };
  }

  return { buildSwapBlindOp, buildSwapInput };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Injected dependencies (this module stays free of tacit.js internals):
//
// [proveGroth16] — async ({ input }) => Uint8Array(256). swapBatchGroth16Prove (confidential-swapbatch.js)
//   is the ready wrapper: snarkjs.groth16.fullProve(input, amm_swap_batch.wasm, zkey) then
//   serializeGroth16Proof256. The zkey MUST be the FINALIZED ceremony zkey whose VK == the guest's baked
//   batch_vk (fixtures/swap_batch_vk.json, ceremony hash 2d9db81d…). The genesis
//   dapp/circuits/ceremony-genesis-amm/amm_swap_batch_0000.zkey has a DIFFERENT VK, so a proof under it
//   is guest-rejected — the tests prove the byte/signal/sigma/PoK/identity parity under whatever zkey is
//   supplied, but live arming needs the finalized artifact (_fetchAmmZkey('swap_batch')).
//
// [ammDerivePoolIdV1] — inject pool.ammDerivePoolIdFull(a, b, feeBps, 0, ZERO_ADDR33, 0) (the
//   Bitcoin-canonical circuit id, == guest amm_derive_pool_id_v1). Distinct from the EVM slot id
//   poolIdWithProtocolFee used for expected.poolId.
//
// [inNote provenance] — traders[].inNote must be a REAL note the settler can prove spent (membership
//   under `spendRoot` + the note's secp blinding rSecp). This module does not scan/select notes; the
//   wallet layer supplies { cx, cy, owner, rSecp, leafIndex, path[32] } and the batch `spendRoot`. The
//   receipt blindings rOutSecp/rOutBJJ are settler-chosen fresh randomness.
//
// UNSURE / to confirm on the prover box:
//   - openingPokBlind(amount, rSecp, ctx) argument order + return shape { R, zV, zR } is taken from
//     confidential-lp.js usage; confirm it matches this pool build's signature.
//   - proveXCurveDeterministic seedKey: any 32-byte domain separator is fine (determinism only); the
//     guest verifies the sigma, not its nonce derivation.
// ─────────────────────────────────────────────────────────────────────────────────────────────
