// T_SWAP_BATCH (0x2F) reflection fold — the BabyJubJub + Groth16 half. (The secp aggregate Pedersen identity
// lives in confidential-pool.js as swapBatchAggregateIdentity; the envelope parser in burn-deposit-bitcoin.js
// as parseSwapBatchEnvelope.) Mirrors cxfer-core swap_batch.rs. Kept OUT of confidential-pool.js so the other
// folds don't pull in the BabyJubJub / snarkjs deps; reuses the dapp's amm-bjj.js (BabyJubJub) — the guest's
// babyjubjub.rs mirrors it byte-for-byte — and (for the Groth16 step, wired next) snarkjs + the inline ceremony vk.

import { unpackPoint, P_FR, mod } from './amm-bjj.js';
import { verifyXCurve } from './amm-sigma.js';
import { sha256 } from './vendor/tacit-deps.min.js';
import { verifySchnorr } from './bulletproofs.js';

const N_MAX = 16;
const AMM_INTENT_DOM = new TextEncoder().encode('tacit-amm-intent-v1');
const u16leB = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Number(n) & 0xffff, true); return b; };
const u32leB = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64leB = (n) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Number(BigInt(n) & 0xffffffffn), true); v.setUint32(4, Number((BigInt(n) >> 32n) & 0xffffffffn), true); return b; };
const catB = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
const spkB = (spk) => (!spk ? new Uint8Array(0) : (typeof spk === 'string' ? hu8(spk) : spk));
// Per-intent authorization message (mirror cxfer-core swap_batch_intent_msg, KAT-pinned): sha256 of the
// concatenated fields; the input outpoint's txid is the internal (little-endian) tx-serialization byte order.
export function swapBatchIntentMsg(a) {
  return sha256(catB([
    AMM_INTENT_DOM, hu8(a.poolId), Uint8Array.of(a.direction & 0xff), Uint8Array.of(a.inputOutpoints.length & 0xff),
    ...a.inputOutpoints.flatMap(([txid, vout]) => [hu8(txid), u32leB(vout)]),
    hu8(a.cInSecp), hu8(a.cInBjj), hu8(a.inXcurveSigma), u16leB(spkB(a.receiveSpk).length), spkB(a.receiveSpk),
    u64leB(a.minOut), u64leB(a.tipAmount), Uint8Array.of(a.tipAsset & 0xff), u32leB(a.expiryHeight),
    hu8(a.traderPubkey), u16leB(spkB(a.refundSpk).length), spkB(a.refundSpk),
  ]));
}
const batchIntentSigOk = (sigHex, msg32, traderPubkeyHex) => {
  const pk = hu8(traderPubkeyHex); if (pk.length !== 33) return false;
  try { return verifySchnorr(hu8(sigHex), msg32, pk.slice(1, 33)); } catch { return false; }
};
const ZERO_ADDR33 = '0x' + '00'.repeat(33);
const ZERO_OWNER = '0x' + '00'.repeat(32);
const U64_MAX = (1n << 64n) - 1n;
const norm = (x) => String(x).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hu8 = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };
// reserve ± mag with u64 bounds (mirror apply_signed): sign 0 grows, 1 shrinks; null on overflow/underflow.
function applySigned(reserve, sign, mag) {
  if (Number(sign) === 0) { const v = reserve + mag; return v > U64_MAX ? null : v; }
  return reserve < mag ? null : reserve - mag;
}
const bytesToBig = (b) => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const hb32 = (h) => { const s = String(h).replace(/^0x/, '').padStart(64, '0'); const o = new Uint8Array(32); for (let i = 0; i < 32; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

// Re-derive the swap_batch circuit's 123 public signals from the on-chain envelope + the pool's tracked
// reserves, in the EXACT order the circom `main` declares: 11 globals then seven N_MAX=16 arrays
// [direction, C_in_BJJ_u, C_in_BJJ_v, min_out, tip_amount, C_out_BJJ_u, C_out_BJJ_v]. Mirrors
// swap_batch_public_signals: a prover can't forge these — R_*_pre come from the registry, pool_id_fr =
// SHA256(pool_id) mod r, and each BJJ (u,v) is recovered by the validated unpackPoint (unused slots padded with
// the BJJ identity (0,1), like the circuit). Returns BigInt[123] field values (the guest's [u8;32] BE encode the
// same), or null on a bad point / out-of-range count. Feed to snarkjs.groth16.verify as decimal strings.
export function swapBatchPublicSignals(env, poolIdHex, reserveA, reserveB) {
  const ni = env.nIntents;
  if (ni < 1 || ni > N_MAX || env.intents.length !== ni || env.receipts.length !== ni) return null;
  const s = [
    mod(bytesToBig(sha256(hb32(poolIdHex))), P_FR), // pool_id_fr = SHA256(pool_id) mod r
    BigInt(reserveA), BigInt(reserveB),
    BigInt(env.deltaANetSign), BigInt(env.deltaANetMag),
    BigInt(env.deltaBNetSign), BigInt(env.deltaBNetMag),
    BigInt(env.tipAAmount), BigInt(env.tipBAmount),
    BigInt(env.feeBps), BigInt(ni),
  ];
  const direction = Array(N_MAX).fill(0n);
  const cInU = Array(N_MAX).fill(0n), cInV = Array(N_MAX).fill(1n);   // pad: BJJ identity (0,1)
  const minOut = Array(N_MAX).fill(0n), tip = Array(N_MAX).fill(0n);
  const cOutU = Array(N_MAX).fill(0n), cOutV = Array(N_MAX).fill(1n);
  for (let i = 0; i < ni; i++) {
    const it = env.intents[i];
    direction[i] = BigInt(it.direction);
    const cin = unpackPoint(hb32(it.cInBjj)); if (!cin) return null;
    cInU[i] = cin[0]; cInV[i] = cin[1];
    minOut[i] = BigInt(it.minOut); tip[i] = BigInt(it.tipAmount);
    const cout = unpackPoint(hb32(env.receipts[i].cOutBjj)); if (!cout) return null;
    cOutU[i] = cout[0]; cOutV[i] = cout[1];
  }
  for (const arr of [direction, cInU, cInV, minOut, tip, cOutU, cOutV]) for (const x of arr) s.push(x);
  return s.length === 123 ? s : null;
}

// Parse a 256-byte Groth16 proof (the guest's G16Proof layout: A(G1 64) ‖ B(G2 128: x_c0 x_c1 y_c0 y_c1) ‖
// C(G1 64), big-endian field bytes) → a snarkjs proof object. Byte-identical to the dapp's _parseGroth16Proof
// (and parse_g16_proof in the guest); pi_b limbs in snarkjs [c0, c1] order. Accepts a Uint8Array or 0x-hex.
const be32dec = (b, o) => { let v = 0n; for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[o + i]); return v.toString(); };
export function parseGroth16Proof256(proofBytes) {
  const b = proofBytes instanceof Uint8Array ? proofBytes : hb32Var(proofBytes);
  if (!(b instanceof Uint8Array) || b.length !== 256) return null;
  return {
    pi_a: [be32dec(b, 0), be32dec(b, 32), '1'],
    pi_b: [[be32dec(b, 64), be32dec(b, 96)], [be32dec(b, 128), be32dec(b, 160)], ['1', '0']],
    pi_c: [be32dec(b, 192), be32dec(b, 224), '1'],
    protocol: 'groth16',
    curve: 'bn128',
  };
}
const hb32Var = (h) => { const s = String(h).replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };

// Serialize a snarkjs Groth16 proof object → the guest's 256-byte G16Proof layout (A(G1 64) ‖
// B(G2 128: x_c0 x_c1 y_c0 y_c1) ‖ C(G1 64), big-endian field bytes). Exact inverse of
// parseGroth16Proof256 (and of parse_g16_proof in the guest): a round-trip serialize→parse is the
// identity, so a proof snarkjs.groth16.verify accepts, the guest's groth16 verifier accepts too. The
// pi_b limbs stay in snarkjs [c0, c1] order. Returns Uint8Array(256).
const be32enc = (dec) => { let v = BigInt(dec); const o = new Uint8Array(32); for (let i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } if (v !== 0n) throw new Error('field element overflows 32 bytes'); return o; };
export function serializeGroth16Proof256(proof) {
  if (!proof || proof.protocol !== 'groth16') throw new Error('not a groth16 proof');
  const out = new Uint8Array(256);
  out.set(be32enc(proof.pi_a[0]), 0);
  out.set(be32enc(proof.pi_a[1]), 32);
  out.set(be32enc(proof.pi_b[0][0]), 64);
  out.set(be32enc(proof.pi_b[0][1]), 96);
  out.set(be32enc(proof.pi_b[1][0]), 128);
  out.set(be32enc(proof.pi_b[1][1]), 160);
  out.set(be32enc(proof.pi_c[0]), 192);
  out.set(be32enc(proof.pi_c[1]), 224);
  return out;
}

// PROVE side of the swap_batch BN254 Groth16: snarkjs.groth16.fullProve over the circuit `input`
// (swapBatchCircuitInput / buildSwapInput), then serialize to the guest's 256-byte layout. `wasm` and
// `zkey` are the ceremony artifacts (dapp/vendor/amm_swap_batch.wasm + the FINALIZED ceremony zkey
// whose VK == the guest's baked batch_vk). Returns { proofBytes: Uint8Array(256), publicSignals }.
export async function swapBatchGroth16Prove(input, wasm, zkey) {
  const sjs = await import('snarkjs');
  const groth16 = sjs.groth16 || (sjs.default && sjs.default.groth16);
  if (!groth16 || typeof groth16.fullProve !== 'function') throw new Error('snarkjs.groth16.fullProve unavailable');
  const { proof, publicSignals } = await groth16.fullProve(input, wasm, zkey);
  return { proofBytes: serializeGroth16Proof256(proof), publicSignals };
}

// Verify the swap_batch BN254 Groth16 (per-receipt clearing split) against the CID-verified ceremony vk
// (_CANONICAL_AMM_VK_INLINE.swap_batch in the dapp = batch_vk.bin in the guest), supplied by the caller so this
// module stays vk-agnostic (no drift). `publicsBigInt` = swapBatchPublicSignals(...) (123 field values). The
// proof is the envelope's 256 bytes. Returns a Promise<bool>; fail-closed on a malformed proof.
export async function swapBatchGroth16Verify(vk, publicsBigInt, proofBytes) {
  const proof = parseGroth16Proof256(proofBytes);
  if (!proof || !Array.isArray(publicsBigInt)) return false;
  const publics = publicsBigInt.map((x) => BigInt(x).toString());
  const sjs = await import('snarkjs');
  const groth16 = sjs.groth16 || (sjs.default && sjs.default.groth16);
  if (!groth16 || typeof groth16.verify !== 'function') throw new Error('snarkjs.groth16.verify unavailable');
  return groth16.verify(vk, publics, proof);
}

// Fold a confirmed T_SWAP_BATCH (0x2F) — mirror cxfer-core swap_batch.rs fold_swap_batch. All-or-nothing:
// every gate runs (and the post-reserves are computed) BEFORE any state mutation, then each receipt is onboarded
// as a real bridgeable note + the reserves advance by the public net deltas. ASYNC: the BN254 Groth16 verify
// (swapBatchGroth16Verify over swapBatchPublicSignals + the injected ceremony `vk`) runs against the pool's
// FOLD-POINT reserves p.reserveA/B — so a prior same-block op that moved them is reflected (the settler proved
// against exactly these), and a bad/forged proof yields a skip (null), exactly the guest's skip-not-panic
// (liveness, not soundness — the guest re-verifies). `pool` = makeConfidentialPool (crypto helpers), `state` =
// its scan state (foldOutput / pools), `spends` = the detected pool-UTXO spends (the traders' c_in_secp inputs),
// `vk` = the inline ceremony vk (== the guest's batch_vk.bin). Returns { receiptPaths } (the n onboarded
// note-paths, for the witness), or null (skip) on any gate. `verify(vk, env, poolId, rA, rB)` is the Groth16
// step (defaults to defaultSwapBatchVerify — re-derive publics + snarkjs-verify); unit tests inject a mock to
// exercise the non-Groth16 gates without a real proof. The publics-building lives INSIDE verify so the mock
// fully bypasses it.
async function defaultSwapBatchVerify(vk, env, poolIdHex, reserveA, reserveB) {
  const publics = swapBatchPublicSignals(env, poolIdHex, reserveA, reserveB);
  if (!publics) return false;
  return swapBatchGroth16Verify(vk, publics, env.proof);
}
// Exact fee-clearing floor for a ONE-SIDED net move (mirror cxfer-core fee_clearing_floor_ok): the pool must
// keep the fee-fair output — new_out·(R_in·10000 + in·(10000−fee_bps)) ≥ k_pre·10000. BigInt exact, no slack.
function feeClearingFloorOk(rIn, inAmt, newOut, kPre, feeBps) {
  return newOut * (rIn * 10000n + inAmt * (10000n - BigInt(feeBps))) >= kPre * 10000n;
}
const authZeroBatch = (a) => !a || norm(a) === norm(ZERO_OWNER);

export async function foldSwapBatch(pool, state, env, txidHex, spends, { vk, verify = defaultSwapBatchVerify, receiptSpks = [], refundSpks = [], height = 0n } = {}) {
  const ni = env.nIntents;
  if (env.intents.length !== ni || env.receipts.length !== ni) return null;
  // Each note's spend authority = the x-only key of its output (P2TR); the intent binds the FULL output script.
  const receiptAuths = receiptSpks.map((s) => pool.p2trXonly(s));
  const refundAuths = refundSpks.map((s) => pool.p2trXonly(s));
  const peekN = () => Array.from({ length: ni }, () => state.notePathPeek());
  // 1. resolve the pool (canonical pair → v1 pool_id) + tracked reserves; c0-backed + canonically oriented.
  const [aLo, aHi] = pool.ammCanonicalPair(env.assetA, env.assetB);
  if (!aLo) return null;
  if (Number(env.feeBps) > 1000) return null; // MAX_POOL_FEE_BPS
  const poolId = pool.ammDerivePoolIdFull(aLo, aHi, env.feeBps, 0, ZERO_ADDR33, 0);
  if (!poolId) return null;
  const p = state.pools.get(poolId);
  if (!p || !p.c0Backed) return null;
  if (norm(env.assetA) !== norm(p.assetA) || norm(env.assetB) !== norm(p.assetB)) return null;

  // ---- STATE-INDEPENDENT VALIDATION FIRST (reordered for the refund floor, mirror the guest): a refund may
  //      only be minted against an input PROVEN a real, distinct, authorized spend, or the refund itself would
  //      be an inflation path. So the one-to-one spend matching + destination guards run BEFORE the clearing. ----
  const intentInAssets = [];
  const used = new Array(spends.length).fill(false);
  let anyExpired = false;
  for (let i = 0; i < ni; i++) {
    const it = env.intents[i];
    if (Number(it.direction) > 1) return null;
    const expectedAsset = Number(it.direction) === 0 ? p.assetA : p.assetB; // input side (A→B inputs A)
    let cin; try { cin = pool.decompressCommitment(it.cInSecp); } catch { return null; }
    let matched = -1;
    for (let j = 0; j < spends.length; j++) {
      if (used[j]) continue;
      if (norm(spends[j].asset || ZERO_OWNER) !== norm(expectedAsset)) continue;
      if (norm(spends[j].cx) === norm(cin.cx) && norm(spends[j].cy) === norm(cin.cy)) { matched = j; break; }
    }
    if (matched < 0) return null;              // no distinct real spend of the intent's input asset
    used[matched] = true;
    intentInAssets.push(expectedAsset);        // the asset intent i's refund note rides if the batch is stale
    // INTENT AUTHORIZATION (H-01, mirror guest): the trader's per-intent BIP-340 intent_sig binds the pool,
    // direction, the matched spent outpoint, c_in (secp + bjj) + its cross-curve, the receipt destination
    // (vout i+1), min_out, tip, expiry, and the refund destination (vout n+1+i). A bad sig SKIPS the batch (the
    // guest skips it too), so onboarding here would desync the digest chain. tip_asset == direction.
    const msg = swapBatchIntentMsg({
      poolId, direction: it.direction, inputOutpoints: [spends[matched].outpoint], cInSecp: it.cInSecp,
      cInBjj: it.cInBjj, inXcurveSigma: it.inXcurveSigma, receiveSpk: receiptSpks[i], minOut: it.minOut,
      tipAmount: it.tipAmount, tipAsset: it.direction, expiryHeight: it.expiryHeight, traderPubkey: it.traderPubkey,
      refundSpk: refundSpks[i],
    });
    if (!batchIntentSigOk(it.intentSig, msg, it.traderPubkey)) return null;
    // EXPIRY → whole-batch refund (mirror guest): recorded, acted on after the loop.
    if (BigInt(it.expiryHeight || 0) === 0n || BigInt(it.expiryHeight) < BigInt(height)) anyExpired = true;
    // per-receipt cross-curve sigma: C_out_secp ↔ C_out_BJJ (secp note value == the Groth16-proven cleared amount).
    if (!verifyXCurve(hu8(env.receipts[i].outXcurveSigma), hu8(env.receipts[i].cOutSecp), hu8(env.receipts[i].cOutBjj))) return null;
    // Both destinations must be spendable P2TR — checked up front (the branch is decided by pool state).
    if (authZeroBatch(receiptAuths[i])) return null;
    if (authZeroBatch(refundAuths[i])) return null;
  }
  if (used.some((u) => !u)) return null;        // every detected spend must back exactly one intent (no unaccounted spend)

  // Onboard one REFUND note per intent (intent i at vout n+1+i), committing its input commitment verbatim on its
  // input asset. Reserves untouched. Mirror onboard_batch_refunds.
  const onboardRefunds = () => {
    const refundPaths = [];
    for (let i = 0; i < ni; i++) {
      const asset = intentInAssets[i];
      const { cx, cy } = pool.decompressCommitment(env.intents[i].cInSecp);
      const w = state.foldOutput(pool.btcNoteLeaf(asset, cx, cy, refundAuths[i]), pool.outpointKey(txidHex, ni + 1 + i), pool.commitmentHash(cx, cy), asset, refundAuths[i]);
      refundPaths.push(w.notePath);
    }
    return { receiptPaths: peekN(), refundPaths };
  };
  if (anyExpired) return onboardRefunds();

  // ---- STATE-DEPENDENT CLEARING. Every failure here means the batch lost a race with a concurrent op; its
  //      Groth16 proof is pinned to the reserves it was generated against, so it cannot be re-cleared in-guest —
  //      each trader's exact input is refunded instead of the whole batch being skipped. ----
  const newA = applySigned(BigInt(p.reserveA), env.deltaANetSign, BigInt(env.deltaANetMag));
  const newB = applySigned(BigInt(p.reserveB), env.deltaBNetSign, BigInt(env.deltaBNetMag));
  if (newA === null || newB === null) return onboardRefunds();
  if (newA === 0n || newB === 0n) return onboardRefunds();
  const kPre = BigInt(p.reserveA) * BigInt(p.reserveB);
  if (newA * newB < kPre) return onboardRefunds();
  // FEE FLOOR on a one-sided net move (mirror the guest): a two-sided/tip-inflated net falls through to the k-floor.
  let oneSided = null;
  if (Number(env.deltaANetSign) === 0 && Number(env.deltaBNetSign) === 1) oneSided = [BigInt(p.reserveA), BigInt(env.deltaANetMag), newB];
  else if (Number(env.deltaBNetSign) === 0 && Number(env.deltaANetSign) === 1) oneSided = [BigInt(p.reserveB), BigInt(env.deltaBNetMag), newA];
  if (oneSided && !feeClearingFloorOk(oneSided[0], oneSided[1], oneSided[2], kPre, env.feeBps)) return onboardRefunds();
  // Groth16 (per-receipt clearing split) against the fold-point reserves. A forged/stale proof → refund.
  let groth16Ok = false;
  try { groth16Ok = await verify(vk, env, poolId, p.reserveA, p.reserveB); } catch { return onboardRefunds(); }
  if (!groth16Ok) return onboardRefunds();
  // aggregate Pedersen identity per asset A + B (binds the receipts' total to real inputs + reserve).
  const intentsSecp = env.intents.map((it) => ({ direction: Number(it.direction), cInSecp: it.cInSecp }));
  const receiptsSecp = env.receipts.map((r) => r.cOutSecp);
  if (!pool.swapBatchAggregateIdentity(intentsSecp, receiptsSecp, true, env.deltaANetSign, BigInt(env.deltaANetMag), env.tipACSecp, env.rNetA)) return onboardRefunds();
  if (!pool.swapBatchAggregateIdentity(intentsSecp, receiptsSecp, false, env.deltaBNetSign, BigInt(env.deltaBNetMag), env.tipBCSecp, env.rNetB)) return onboardRefunds();

  // ---- all validation passed; COMMIT: onboard each receipt under its vout x-only key, then advance reserves. ----
  const receiptPaths = [];
  for (let i = 0; i < ni; i++) {
    const outAsset = Number(env.intents[i].direction) === 0 ? p.assetB : p.assetA;
    const { cx, cy } = pool.decompressCommitment(env.receipts[i].cOutSecp);
    const w = state.foldOutput(pool.btcNoteLeaf(outAsset, cx, cy, receiptAuths[i]), pool.outpointKey(txidHex, i + 1), pool.commitmentHash(cx, cy), outAsset, receiptAuths[i]);
    receiptPaths.push(w.notePath);
  }
  state.pools.set(poolId, { ...p, reserveA: newA, reserveB: newB });
  return { receiptPaths, refundPaths: peekN() };
}
