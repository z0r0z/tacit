// OP_SWAP_BLIND (31 / 0x1F) settle-side emitter — the prover-blind confidential AMM batch.
//
// This is the EVM settle twin of the reflection T_SWAP_BATCH fold. It assembles the exact envelope
// the guest's OP_SWAP_BLIND arm reads (src/main.rs) and computed via swap_blind.rs
// verify_clearing: a REAL amm_swap_batch Groth16 proof over the 123 public signals, per-asset
// conservation kernels (Schnorr signatures over the blinding excess — never the blinding itself, which on a
// one-way side is the inputs' combined blinding and would let a delegated prover spend them), per-receipt
// cross-curve sigmas, and per-intent blind opening PoKs.
//
// The op is enabled in the deployed guest; this module is the settle-side builder (there is no
// production emitter or relay path for it yet). It DOES NOT reimplement any crypto: every primitive is imported
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
import { SECP_N, modN, pedersenCommit, pointToBytes, G, H, ZERO } from './bulletproofs.js';
import { bppRangeProve } from './bulletproofs-plus.js';
import { sha256, keccak_256 } from './vendor/tacit-deps.min.js';

const N_MAX = 16;
const SWAP_DIR_A_TO_B = 0;
const SWAP_DIR_B_TO_A = 1;
// Guest intent-context domain (src/main.rs:1790). MUST match exactly or verify_opening_pok_blind fails.
const SWAP_BLIND_INTENT_TAG = 'tacit-swap-blind-intent-v1';
// Guest conservation-kernel domain (cxfer-core SWAP_BLIND_KERNEL_DOMAIN).
const SWAP_BLIND_KERNEL_DOMAIN = new TextEncoder().encode('tacit-swap-blind-kernel-v1');

const hexToBytes = (h) => { h = String(h || '').replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const be32 = (n) => { const o = new Uint8Array(32); let v = BigInt(n); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const be32hex = (n) => bytesToHex(be32(n));

const catBytes = (parts) => { const t = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(t); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };

// keccak(domain ‖ chainBinding ‖ poolId ‖ side ‖ X ‖ R) mod n — cxfer-core swap_blind_kernel_challenge.
function aggregateKernelChallenge(chainBinding, poolId, assetXIsA, X, R) {
  const msg = catBytes([SWAP_BLIND_KERNEL_DOMAIN, hexToBytes(chainBinding), hexToBytes(poolId), Uint8Array.of(assetXIsA ? 0 : 1), X.toRawBytes(true), R.toRawBytes(true)]);
  return modN(BigInt(bytesToHex(keccak_256(msg))));
}

// Σ_{input-side} C_in − Σ_{output-side} C_out − C_tip ∓ δ·H for asset X (cxfer-core swap_batch_aggregate_point).
function aggregatePoint({ intents, receipts, assetXIsA, deltaSign, deltaMag, tipCSecp }) {
  const pt = (v) => G.constructor.fromHex(typeof v === 'string' ? v.replace(/^0x/, '') : v);
  let sum = ZERO;
  intents.forEach((it, i) => {
    const isInput = (assetXIsA && it.direction === SWAP_DIR_A_TO_B) || (!assetXIsA && it.direction === SWAP_DIR_B_TO_A);
    const isOutput = (assetXIsA && it.direction === SWAP_DIR_B_TO_A) || (!assetXIsA && it.direction === SWAP_DIR_A_TO_B);
    if (isInput) sum = sum.add(pt(it.cInSecp));
    else if (isOutput) sum = sum.add(pt(receipts[i].cOutSecp).negate());
  });
  sum = sum.add(pt(tipCSecp).negate());
  const mag = BigInt(deltaMag);
  if (mag !== 0n) sum = deltaSign === 0 ? sum.add(H.multiply(mag).negate()) : sum.add(H.multiply(mag));
  return sum;
}

// Sign the conservation kernel for one asset side, given the blinding excess. Whoever calls this learns the excess,
// so it belongs with the party that already holds the traders' blindings (a self-batch, or a trusted coordinator) —
// never with the prover, which receives only (R, z).
export function signAggregateKernel({ excess, chainBinding, poolId, assetXIsA }) {
  const x = modN(BigInt(excess));
  if (x === 0n) throw new Error('swap-blind: zero blinding excess (resample a blinding)');
  const X = G.multiply(x);
  const k = randScalar(SECP_N);
  const R = G.multiply(k);
  const e = aggregateKernelChallenge(chainBinding, poolId, assetXIsA, X, R);
  return { R: bytesToHex(R.toRawBytes(true)), z: be32hex(modN(k + e * x)) };
}

// Verify a conservation kernel exactly as cxfer-core swap_blind_aggregate_kernel does.
export function verifyAggregateKernel({ intents, receipts, assetXIsA, deltaSign, deltaMag, tipCSecp, chainBinding, poolId, kernel }) {
  let X, R;
  try { X = aggregatePoint({ intents, receipts, assetXIsA, deltaSign, deltaMag, tipCSecp }); R = G.constructor.fromHex(String(kernel.R).replace(/^0x/, '')); } catch { return false; }
  if (X.equals(ZERO)) return false;
  const z = BigInt(kernel.z);
  if (z >= SECP_N) return false;
  const e = aggregateKernelChallenge(chainBinding, poolId, assetXIsA, X, R);
  const lhs = z === 0n ? ZERO : G.multiply(z);
  return lhs.equals(R.add(e === 0n ? ZERO : X.multiply(e)));
}

function randScalar(mod) {
  while (true) {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    let n = 0n; for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt(buf[i]);
    if (n > 0n && n < mod) return n;
  }
}

// ---- Multi-party kernel co-signing (2-of-2, or 2-of-2-plus-tip) ----
//
// A kernel's excess is additive across contributors: an input trader's +r_in_secp, an output
// trader's -r_out_secp, the settler's -r_tip. No contributor needs another's secret share — only
// the combined public aggregate point X (built from already-public commitments, see aggregatePoint)
// and, once every contributor's nonce commitment R_i is known, the shared challenge
// e = H(chainBinding, poolId, side, X, ΣR_i). Standard additive Schnorr: (ΣR_i, Σz_i) verifies
// against X exactly like a single-signer signAggregateKernel/verifyAggregateKernel pair.
//
// X is single-use per batch (built from that batch's own one-time commitments, never reused across
// batches), so this plain 2-round scheme needs none of MuSig2's extra nonce-binding — that defends a
// long-lived shared key signing many messages, not a fresh aggregate key used exactly once.
export { aggregatePoint as aggregateKernelPoint };

export function kernelNonceCommit() {
  const k = randScalar(SECP_N);
  return { k, R: bytesToHex(G.multiply(k).toRawBytes(true)) };
}

// Once every co-signer's R is public, anyone derives the shared (R, e) from the public X.
export function kernelChallenge({ chainBinding, poolId, assetXIsA, X, partialRs }) {
  let R = ZERO;
  for (const r of partialRs) R = R.add(G.constructor.fromHex(String(r).replace(/^0x/, '')));
  const e = aggregateKernelChallenge(chainBinding, poolId, assetXIsA, X, R);
  return { R: bytesToHex(R.toRawBytes(true)), e: be32hex(e) };
}

// A co-signer's response for its own secret share, given the shared (e) from kernelChallenge.
// `share` is this contributor's signed term (+r_in_secp for an input leg, −r_out_secp for an output
// leg, −r_tip for the settler) — z reveals nothing about it beyond what a full signature already does.
export function kernelPartialResponse({ k, share, e }) {
  return be32hex(modN(BigInt(k) + modN(BigInt(e)) * modN(BigInt(share))));
}

// Sum every partial response into the final kernel signature.
export function combineKernelResponses({ R, partialZs }) {
  let z = 0n;
  for (const pz of partialZs) z = modN(z + BigInt(pz));
  return { R, z: be32hex(z) };
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
    // The spent note is worth inTotal = amount_in_swap + tip (tip_asset == direction); only amount_in_swap
    // clears against the curve, the tip is paid to the settler. C_in commits to inTotal.
    const tip = BigInt(t.tip ?? 0);
    const inTotal = BigInt(t.amountIn) + tip;
    // A 2-party leg (prepareInputLeg/prepareOutputLeg) already picked these; a self-batch caller
    // (buildSwapBlindOp) leaves them unset and gets fresh randomness, as before.
    const rInBJJ = t.rInBJJ != null ? modField(BigInt(t.rInBJJ), N_BJJ) : randScalar(N_BJJ);
    const rOutBJJ = t.rOutBJJ != null ? modField(BigInt(t.rOutBJJ), N_BJJ) : randScalar(N_BJJ);
    const Cin = pedersenBJJ(inTotal, rInBJJ);
    const Cout = pedersenBJJ(amountOut, rOutBJJ);

    direction[i]          = String(t.direction);
    min_out[i]            = BigInt(t.minOut).toString();
    amount_in_swap[i]     = BigInt(t.amountIn).toString();
    tip_amount[i]         = tip.toString();
    tip_amount_witness[i] = tip.toString();
    r_in_BJJ[i]           = rInBJJ.toString();
    amount_out[i]         = amountOut.toString();
    rem[i]                = r.toString();
    r_out_BJJ[i]          = rOutBJJ.toString();
    C_in_BJJ_u[i]         = Cin[0].toString();
    C_in_BJJ_v[i]         = Cin[1].toString();
    C_out_BJJ_u[i]        = Cout[0].toString();
    C_out_BJJ_v[i]        = Cout[1].toString();

    filled.push({ ...t, tip, inTotal, amountOut, rem: r, rInBJJ, rOutBJJ, cInBjj: packPoint(Cin), cOutBjj: packPoint(Cout) });
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
    // Global per-asset tip = Σ per-intent tips on that side (tip_asset == direction). The circuit
    // constrains tipSumA/B === tip_A/B_amount; the settle arm pays these to msg.sender.
    tip_A_amount         : filled.filter(t => t.direction === SWAP_DIR_A_TO_B).reduce((s, t) => s + t.tip, 0n).toString(),
    tip_B_amount         : filled.filter(t => t.direction === SWAP_DIR_B_TO_A).reduce((s, t) => s + t.tip, 0n).toString(),
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

// Coordinator step, before any leg exists: the clearing price and each trader's amountOut depend
// only on directions/amounts (not on any blinding), so this can run before the traders build their
// output legs. `traders` here is just [{ direction, amountIn, tip }] — no notes, no blindings.
export function solveBatchClearing({ reserveAPre, reserveBPre, feeBps, traders }) {
  const { filled, deltas } = buildSwapInput({
    poolIdFr: 0n, R_A: reserveAPre, R_B: reserveBPre, fee_bps: feeBps,
    traders: traders.map((t) => ({ ...t, minOut: 0, deadline: 0 })),
  });
  return { amountOuts: filled.map((f) => f.amountOut), deltas };
}

// Coordinator step, once every trader's real legs exist: build the per-asset aggregate point X from
// the batch's own public commitments (no secret needed) so the kernel round's challenge can be
// derived. `tipCSecp` is this asset's Pedersen commitment to its total tip, from a settler-chosen
// rTip the settler keeps for its own kernel partial (kernelPartialResponse({..., share: -rTip})).
export function kernelAggregatePointFromLegs({ legs, assetXIsA, deltaSign, deltaMag, tipCSecp }) {
  const intents = legs.map((l) => ({ direction: l.input.direction, cInSecp: l.input.cInSecp }));
  const receipts = legs.map((l) => ({ cOutSecp: l.output.cOutSecp }));
  return aggregatePoint({ intents, receipts, assetXIsA, deltaSign, deltaMag, tipCSecp });
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
    // Canonical orientation (asset_a < asset_b), as the guest asserts.
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
      // spendRoot). C_in_secp = pedersenCommit(inTotal, rSecp) where inTotal = amount_in_swap + tip — the
      // guest re-derives it from the witnessed (cx,cy) via compress(), and the aggregate identity reuses it.
      const rInSecp = modN(BigInt(t.inNote.rSecp));
      const CinSecp = pedersenCommit(t.inTotal, rInSecp);
      const cInSecpBytes = pointToBytes(CinSecp);
      const inXY = commitXY(t.inTotal, rInSecp); // { cx, cy } affine, for the leaf + witness
      // Input cross-curve sigma: binds C_in_secp ↔ C_in_BJJ for amount = inTotal.
      const inXcurve = proveXCurveDeterministic({
        a: t.inTotal, r_secp: rInSecp, r_BJJ: BigInt(t.rInBJJ),
        C_secp: CinSecp, C_BJJ: pedersenBJJ(t.inTotal, BigInt(t.rInBJJ)),
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
      // The receipt's own m=1 BP+ range proof over C_out_secp: the cross-curve sigma only binds the two
      // curves' residues, so the guest requires this to bound the onboarded note's real value (main.rs reads
      // it right after the output sigma; swap_blind::verify_clearing checks it).
      const outRangeProof = bppRangeProve([t.amountOut], [rOutSecp]).proof;

      // Blind opening PoK over the guest's intent context. Anti-redirect: binds out_owner / min_out /
      // direction / deadline / tip WITHOUT revealing the amount, so the settler can neither relabel the
      // trade, redirect the output, nor draw a tip the trader didn't authorize. The opening is over inTotal
      // (the note's real value); the tip is carried in the ctx, not in the revealed amount.
      const ctx = intentContext(
        SWAP_BLIND_INTENT_TAG, chainBinding, assetA, assetB,
        [[inXY.cx, inXY.cy, t.inNote.owner], [outXY.cx, outXY.cy, t.outOwner]],
        [BigInt(t.direction), BigInt(t.minOut), BigInt(t.deadline ?? 0), t.tip],
      );
      // openingPokBlind requires explicit nonces; derive them per (blinding, ctx) like confidential-lp.js.
      const pok = openingPokBlind(
        t.inTotal, rInSecp, ctx,
        deriveOpeningNonce(rInSecp, ctx, `swapblind-${i}-v`),
        deriveOpeningNonce(rInSecp, ctx, `swapblind-${i}-r`),
      );

      intents.push({
        direction: t.direction,
        cInSecp: cInSecpBytes,
        cInBjj: t.cInBjj,
        minOut: BigInt(t.minOut),
        tipAmount: t.tip,
        rInSecp,
      });
      receipts.push({
        cOutSecp: cOutSecpBytes,
        cOutBjj: t.cOutBjj,
        outXcurveSigma: outXcurve,
        rangeProof: outRangeProof,
        rOutSecp,
      });
      // commitXY / openingPokBlind already return 0x-hex strings; the xcurve sigmas are Uint8Array(169).
      fixtureIntents.push({
        direction: t.direction,
        inCx: inXY.cx, inCy: inXY.cy,
        inOwner: t.inNote.owner,
        inNk: t.inNote.nk,
        inLeafIndex: Number(t.inNote.leafIndex),
        inPath: t.inNote.path,
        cInBjj: bytesToHex(t.cInBjj),
        inXcurveSigma: bytesToHex(inXcurve),
        minOut: Number(t.minOut),
        deadline: Number(t.deadline ?? 0),
        tip: Number(t.tip),
        outCx: outXY.cx, outCy: outXY.cy,
        outOwner: t.outOwner,
        cOutBjj: bytesToHex(t.cOutBjj),
        outXcurveSigma: bytesToHex(outXcurve),
        outRangeProof: bytesToHex(outRangeProof),
        pokR: pok.R, pokZv: pok.zV, pokZr: pok.zR,
      });
    }

    // 3. Global per-asset tip commitments. tip_X_C_secp = pedersenCommit(tip_X, rTipX); the guest verifies
    //    verify_pedersen_opening (amount == the Groth16-public global tip) before rTipX enters the aggregate
    //    identity, and pays tip_X to msg.sender.
    const tipAAmount = filled.filter(t => t.direction === SWAP_DIR_A_TO_B).reduce((s, t) => s + t.tip, 0n);
    const tipBAmount = filled.filter(t => t.direction === SWAP_DIR_B_TO_A).reduce((s, t) => s + t.tip, 0n);
    const rTipA = randScalar(SECP_N), rTipB = randScalar(SECP_N);
    const tipACSecp = pointToBytes(pedersenCommit(tipAAmount, rTipA));
    const tipBCSecp = pointToBytes(pedersenCommit(tipBAmount, rTipB));

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
    // The prover receives only the kernels (R, z) — never the excess itself (see signAggregateKernel).
    const kernelA = signAggregateKernel({ excess: rNetFor(true, rTipA), chainBinding, poolId: circuitPoolId, assetXIsA: true });
    const kernelB = signAggregateKernel({ excess: rNetFor(false, rTipB), chainBinding, poolId: circuitPoolId, assetXIsA: false });

    // EVM pool id the contract gates pre==live + sets post (pf==0 ⇒ no-skim id). Callers pass the same
    // recipient-less derivation; protocolFeeRecipient defaults to all-zero (33B) as the guest reads r33.
    const envelope = {
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: '0x' + '00'.repeat(33),
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre),
      ...deltas,
      kernelA, kernelB,
      tipAAmount, tipACSecp: bytesToHex(tipACSecp), rTipA: be32hex(rTipA),
      tipBAmount, tipBCSecp: bytesToHex(tipBCSecp), rTipB: be32hex(rTipB),
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
      kernelA: envelope.kernelA, kernelB: envelope.kernelB,
      tipAAmount: Number(tipAAmount), tipACSecp: envelope.tipACSecp, rTipA: envelope.rTipA,
      tipBAmount: Number(tipBAmount), tipBCSecp: envelope.tipBCSecp, rTipB: envelope.rTipB,
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

  // ---- Per-trader leg builders (2-party path) ----
  //
  // A trader's own wallet runs these, never a coordinator. `prepareInputLeg` needs only the
  // trader's own real spent note and produces its public commitments plus the r_in_BJJ circuit
  // witness (a throwaway scalar with no note-spending power — never the note's own blinding, which
  // stays in the returned `_rInSecp` field for that same trader's later kernel partial and is never
  // sent anywhere). `prepareOutputLeg` needs the trader's own amountOut, told by the coordinator
  // after it solves the batch's clearing price; the coordinator needs no secret to compute that.
  //
  // Sending a leg's returned object to the coordinator is safe except for its `_`-prefixed fields,
  // which the trader keeps for its own kernel partial (kernelPartialResponse) and never transmits.
  function prepareInputLeg({ chainBinding, direction, amountIn, tip, inNote }) {
    const rInSecp = modN(BigInt(inNote.rSecp));
    const inTotal = BigInt(amountIn) + BigInt(tip ?? 0);
    const rInBJJ = randScalar(N_BJJ);
    const CinSecp = pedersenCommit(inTotal, rInSecp);
    const inXY = commitXY(inTotal, rInSecp);
    const CinBjj = pedersenBJJ(inTotal, rInBJJ);
    const inXcurve = proveXCurveDeterministic({
      a: inTotal, r_secp: rInSecp, r_BJJ: rInBJJ,
      C_secp: CinSecp, C_BJJ: CinBjj, seedKey: hexToBytes(chainBinding),
    }).proof;
    // Byte fields are hex strings, like every other wire shape in this module (fixtureIntents) —
    // this leg is meant to travel as JSON between a trader and the coordinator.
    return {
      direction, amountIn: BigInt(amountIn), tip: BigInt(tip ?? 0), inTotal, rInBJJ,
      cInSecp: bytesToHex(pointToBytes(CinSecp)), cInBjj: bytesToHex(packPoint(CinBjj)),
      inXcurveSigma: bytesToHex(inXcurve),
      inCx: inXY.cx, inCy: inXY.cy, inOwner: inNote.owner, inNk: inNote.nk,
      inLeafIndex: Number(inNote.leafIndex), inPath: inNote.path,
      _rInSecp: rInSecp, // kept by this same trader for its kernel partial; never sent
    };
  }

  // `inputLeg` is this same trader's own prepareInputLeg() result (its PoK binds both legs).
  // `amountOut` is the coordinator's clearing-price result for this trader; `rOutSecp` is optional
  // (self-chosen or wallet-derived) — omit to get a fresh random one.
  function prepareOutputLeg({ chainBinding, assetA, assetB, inputLeg, amountOut, minOut, deadline, outOwner, rOutSecp = null }) {
    rOutSecp = rOutSecp != null ? modN(BigInt(rOutSecp)) : randScalar(SECP_N);
    const rOutBJJ = randScalar(N_BJJ);
    const CoutSecp = pedersenCommit(amountOut, rOutSecp);
    const outXY = commitXY(amountOut, rOutSecp);
    const CoutBjj = pedersenBJJ(amountOut, rOutBJJ);
    const outXcurve = proveXCurveDeterministic({
      a: amountOut, r_secp: rOutSecp, r_BJJ: rOutBJJ,
      C_secp: CoutSecp, C_BJJ: CoutBjj, seedKey: hexToBytes(chainBinding),
    }).proof;
    const outRangeProof = bppRangeProve([BigInt(amountOut)], [rOutSecp]).proof;
    // Same context shape as buildSwapBlindOp's per-intent loop: binds both legs' owners/commitments
    // plus direction/minOut/deadline/tip, so neither leg can be relabeled or redirected after signing.
    const ctx = intentContext(
      SWAP_BLIND_INTENT_TAG, chainBinding, assetA, assetB,
      [[inputLeg.inCx, inputLeg.inCy, inputLeg.inOwner], [outXY.cx, outXY.cy, outOwner]],
      [BigInt(inputLeg.direction), BigInt(minOut), BigInt(deadline ?? 0), inputLeg.tip],
    );
    const pok = openingPokBlind(
      inputLeg.inTotal, inputLeg._rInSecp, ctx,
      deriveOpeningNonce(inputLeg._rInSecp, ctx, 'swapblind-leg-v'),
      deriveOpeningNonce(inputLeg._rInSecp, ctx, 'swapblind-leg-r'),
    );
    return {
      amountOut: BigInt(amountOut), minOut: BigInt(minOut), deadline: BigInt(deadline ?? 0), rOutBJJ,
      cOutSecp: bytesToHex(pointToBytes(CoutSecp)), cOutBjj: bytesToHex(packPoint(CoutBjj)),
      outXcurveSigma: bytesToHex(outXcurve), outRangeProof: bytesToHex(outRangeProof),
      outCx: outXY.cx, outCy: outXY.cy, outOwner,
      pokR: pok.R, pokZv: pok.zV, pokZr: pok.zR,
      _rOutSecp: rOutSecp, // kept by this same trader for its kernel partial; never sent
    };
  }

  // The coordinator's assembly step: combine every trader's already-computed legs plus the two
  // kernels' already-combined signatures (combineKernelResponses, run over the 2-round exchange
  // described above) into the settle envelope. The coordinator needs each leg's amounts and BJJ
  // witness scalars to build the joint Groth16 witness (this is what "prover-blind" blinds from the
  // chain and the SP1 prover, not from the coordinator that assembles the batch) but never touches
  // any trader's `_`-prefixed secp blinding — those only ever produce that trader's own kernel partial.
  async function assembleSwapBlindFromLegs({ chainBinding, assetA, assetB, feeBps, reserveAPre, reserveBPre, spendRoot = null, legs, kernelA, kernelB, rTipA, rTipB }) {
    if (legs.length < 1 || legs.length > N_MAX) throw new Error('swap-blind: 1..16 intents');
    if (!(BigInt(assetA) < BigInt(assetB))) throw new Error('swap-blind: assets must be canonically ordered A<B');

    const circuitPoolId = ammDerivePoolIdV1(assetA, assetB, feeBps);
    const traders = legs.map((l) => ({
      direction: l.input.direction, amountIn: l.input.amountIn, tip: l.input.tip,
      minOut: l.output.minOut, deadline: l.output.deadline,
      rInBJJ: l.input.rInBJJ, rOutBJJ: l.output.rOutBJJ,
    }));
    const { input, filled, deltas } = buildSwapInput({
      poolIdFr: poolIdFr(circuitPoolId), R_A: reserveAPre, R_B: reserveBPre, fee_bps: feeBps, traders,
    });
    for (let i = 0; i < filled.length; i++) {
      if (filled[i].amountOut !== BigInt(legs[i].output.amountOut)) {
        throw new Error(`swap-blind: leg ${i} amountOut disagrees with the batch clearing price`);
      }
    }

    const proof = await proveGroth16({ input });
    if (!(proof instanceof Uint8Array) || proof.length !== 256) throw new Error('swap-blind: proof must be 256 bytes');

    // Every leg field crossed the wire as hex (prepareInputLeg/prepareOutputLeg), like fixtureIntents
    // below; decode back to bytes only where the envelope shape needs it (matching buildSwapBlindOp's
    // envelope.intents[i].cInSecp etc., which downstream code expects as Uint8Array).
    const intents = legs.map((l) => ({
      direction: l.input.direction, cInSecp: hexToBytes(l.input.cInSecp), cInBjj: hexToBytes(l.input.cInBjj),
      minOut: BigInt(l.output.minOut), tipAmount: BigInt(l.input.tip),
    }));
    const receipts = legs.map((l) => ({
      cOutSecp: hexToBytes(l.output.cOutSecp), cOutBjj: hexToBytes(l.output.cOutBjj),
      outXcurveSigma: hexToBytes(l.output.outXcurveSigma), rangeProof: hexToBytes(l.output.outRangeProof),
    }));
    const fixtureIntents = legs.map((l) => ({
      direction: l.input.direction,
      inCx: l.input.inCx, inCy: l.input.inCy, inOwner: l.input.inOwner, inNk: l.input.inNk,
      inLeafIndex: l.input.inLeafIndex, inPath: l.input.inPath,
      cInBjj: l.input.cInBjj, inXcurveSigma: l.input.inXcurveSigma,
      minOut: Number(l.output.minOut), deadline: Number(l.output.deadline), tip: Number(l.input.tip),
      outCx: l.output.outCx, outCy: l.output.outCy, outOwner: l.output.outOwner,
      cOutBjj: l.output.cOutBjj, outXcurveSigma: l.output.outXcurveSigma,
      outRangeProof: l.output.outRangeProof,
      pokR: l.output.pokR, pokZv: l.output.pokZv, pokZr: l.output.pokZr,
    }));

    const tipAAmount = legs.filter((l) => l.input.direction === SWAP_DIR_A_TO_B).reduce((s, l) => s + BigInt(l.input.tip), 0n);
    const tipBAmount = legs.filter((l) => l.input.direction === SWAP_DIR_B_TO_A).reduce((s, l) => s + BigInt(l.input.tip), 0n);
    const rTipA_ = modN(BigInt(rTipA)), rTipB_ = modN(BigInt(rTipB));
    const tipACSecp = pointToBytes(pedersenCommit(tipAAmount, rTipA_));
    const tipBCSecp = pointToBytes(pedersenCommit(tipBAmount, rTipB_));

    const envelope = {
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: '0x' + '00'.repeat(33),
      reserveAPre: BigInt(reserveAPre), reserveBPre: BigInt(reserveBPre),
      ...deltas,
      kernelA, kernelB,
      tipAAmount, tipACSecp: bytesToHex(tipACSecp), rTipA: be32hex(rTipA_),
      tipBAmount, tipBCSecp: bytesToHex(tipBCSecp), rTipB: be32hex(rTipB_),
      nIntents: legs.length,
      proof: bytesToHex(proof),
      intents, receipts,
    };
    const reserveAPost = applySigned(reserveAPre, deltas.deltaANetSign, deltas.deltaANetMag);
    const reserveBPost = applySigned(reserveBPre, deltas.deltaBNetSign, deltas.deltaBNetMag);
    const evmPoolId = poolIdWithProtocolFee
      ? poolIdWithProtocolFee(assetA, assetB, feeBps, envelope.protocolFeeRecipient, 0)
      : null;

    // Same shape as buildSwapBlindOp's fixture — fixtures/swapblind_op.json / exec-swapblind.rs read
    // either path's output identically.
    const fixture = {
      note: 'OP_SWAP_BLIND prover-blind confidential AMM batch (2-party leg path). Fields in exec-swapblind.rs read order.',
      chainBinding, spendRoot,
      assetA, assetB, feeBps,
      protocolFeeBps: 0,
      protocolFeeRecipient: envelope.protocolFeeRecipient,
      reserveAPre: Number(reserveAPre), reserveBPre: Number(reserveBPre),
      deltaANetSign: deltas.deltaANetSign, deltaANetMag: Number(deltas.deltaANetMag),
      deltaBNetSign: deltas.deltaBNetSign, deltaBNetMag: Number(deltas.deltaBNetMag),
      kernelA: envelope.kernelA, kernelB: envelope.kernelB,
      tipAAmount: Number(tipAAmount), tipACSecp: envelope.tipACSecp, rTipA: envelope.rTipA,
      tipBAmount: Number(tipBAmount), tipBCSecp: envelope.tipBCSecp, rTipB: envelope.rTipB,
      proof: envelope.proof,
      intents: fixtureIntents,
      expected: { poolId: evmPoolId, reserveAPost: Number(reserveAPost), reserveBPost: Number(reserveBPost) },
    };

    return {
      envelope, fixture, deltas, tipAAmount, tipBAmount, circuitPoolId,
      fixtureIntents, evmPoolId, reserveAPost, reserveBPost,
    };
  }

  return {
    buildSwapBlindOp, buildSwapInput,
    prepareInputLeg, prepareOutputLeg, assembleSwapBlindFromLegs,
  };
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
