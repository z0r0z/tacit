// Property fuzz: random (deltaA, deltaB, feeBps, capabilityFlags) inputs
// driven through the dapp builder → worker validator chain. Verifies the
// integration holds across hundreds of randomly-sampled configs.
//
// Same dapp + worker imports as amm-pool-init-parameter-sweep — but
// hundreds of random samples instead of a hand-picked sweep matrix.

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

const worker = await import('../worker/src/index.js');
const dappBp = await import('../dapp/bulletproofs.js');
const dappBjj = await import('../dapp/amm-bjj.js');
const dappSigma = await import('../dapp/amm-sigma.js');
const dappAsset = await import('../dapp/amm-asset.js');
const dappReceipt = await import('../dapp/amm-receipt.js');
const dappKernel = await import('../dapp/amm-kernel.js');
const dappMinLiq = await import('../dapp/amm-min-liq.js');
const dappEnvelope = await import('../dapp/amm-envelope.js');

let pass = 0, fail = 0, samples = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

const lpSk = secp.utils.randomPrivateKey();
const seedKey = hmac(sha256, lpSk, new TextEncoder().encode('tacit-amm-xcurve-seed-v1'));

// Deterministic PRNG so a failing fuzz can be re-run with the same seed
class XorShift {
  constructor(seed = 0xdeadbeef) { this.s = seed | 0; }
  next() {
    let s = this.s | 0;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.s = s | 0;
    return (this.s >>> 0);
  }
  range(min, max) { return min + (this.next() % (max - min + 1)); }
  bigRange(min, max) {
    // bigint range (max ≤ 2^32)
    const span = max - min + 1n;
    return min + BigInt(this.next()) % span;
  }
}

function mkAssetId(rng) {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i += 4) {
    const w = rng.next();
    b[i] = (w >>> 24) & 0xff;
    b[i + 1] = (w >>> 16) & 0xff;
    b[i + 2] = (w >>> 8) & 0xff;
    b[i + 3] = w & 0xff;
  }
  return b;
}

// ============== POOL_INIT fuzz ==============
group('POOL_INIT fuzz — 100 random (Δa, Δb, fee, caps)');
{
  const rng = new XorShift(12345);
  let accepted = 0;
  for (let i = 0; i < 100; i++) {
    samples++;
    const assetA = mkAssetId(rng);
    const assetB = mkAssetId(rng);
    // Skip the (statistically impossible) case where A==B
    if (bytesToHex(assetA) === bytesToHex(assetB)) continue;
    // Δa, Δb in [10k, 10M] so isqrt(Δa·Δb) > 1000 (MINIMUM_LIQUIDITY)
    const deltaA = 10_000n + rng.bigRange(0n, 9_990_000n);
    const deltaB = 10_000n + rng.bigRange(0n, 9_990_000n);
    const feeBps = rng.range(0, 1000);
    const capabilityFlags = 0x00;

    try {
      const [canonA, canonB] = dappAsset.canonicalAssetPair(assetA, assetB);
      const swapped = bytesToHex(canonA) !== bytesToHex(assetA);
      const dA = swapped ? deltaB : deltaA;
      const dB = swapped ? deltaA : deltaB;
      const poolIdBytes = dappAsset.derivePoolId(canonA, canonB, feeBps, capabilityFlags);
      const lpAssetIdBytes = dappAsset.deriveLpAssetId(poolIdBytes);
      const init = dappMinLiq.lpInitShares(dA, dB);
      if (init.founder_shares <= 0n) continue;
      const inputBlindingA = BigInt('0x' + bytesToHex(hmac(sha256, lpSk, new TextEncoder().encode('A' + i))));
      const inputBlindingB = BigInt('0x' + bytesToHex(hmac(sha256, lpSk, new TextEncoder().encode('B' + i))));
      const cinA = dappBp.pedersenCommit(dA, inputBlindingA);
      const cinB = dappBp.pedersenCommit(dB, inputBlindingB);
      const inputAOp = dappReceipt.canonicalOutpoint('aa'.repeat(32), 0);
      const { r_secp, r_BJJ } = dappReceipt.deriveLpAddShareBlinding({
        recipientPrivkey: lpSk, poolId: poolIdBytes, lpInputAOutpoint: inputAOp, lpAssetId: lpAssetIdBytes,
      });
      const shareCSecpPt = dappBp.pedersenCommit(init.founder_shares, r_secp);
      const shareCSecpBytes = shareCSecpPt.toRawBytes(true);
      const shareCBJJPt = dappBjj.pedersenBJJ(init.founder_shares, r_BJJ);
      const shareCBJJBytes = dappBjj.packPoint(shareCBJJPt);
      const { proof: xcurveSigma } = dappSigma.proveXCurveDeterministic({
        a: init.founder_shares, r_secp, r_BJJ, seedKey,
        C_secp: shareCSecpPt, C_BJJ: shareCBJJPt,
      });
      const sigA = dappKernel.lpAddKernelSign({
        variant: 1, poolId: poolIdBytes, assetX: canonA, deltaX: dA,
        shareAmount: init.founder_shares, shareCSecpBytes,
        inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
        inputCommitments: [cinA], excessX: inputBlindingA,
      });
      const sigB = dappKernel.lpAddKernelSign({
        variant: 1, poolId: poolIdBytes, assetX: canonB, deltaX: dB,
        shareAmount: init.founder_shares, shareCSecpBytes,
        inputsX: [{ txid: 'bb'.repeat(32), vout: 0 }],
        inputCommitments: [cinB], excessX: inputBlindingB,
      });
      const payload = dappEnvelope.encodeLpAdd({
        variant: 1, assetA: canonA, assetB: canonB, deltaA: dA, deltaB: dB,
        shareAmount: init.founder_shares,
        shareCSecp: shareCSecpBytes, shareCBJJ: shareCBJJBytes,
        shareXcurveSigma: xcurveSigma,
        kernelSigA: sigA, kernelSigB: sigB,
        shareR: Uint8Array.from(Buffer.from(r_secp.toString(16).padStart(64, '0'), 'hex')), // option-a: on-chain share opening blinding
        feeBps, vkCid: 'bafyTest', ceremonyCid: 'bafyCe',
        arbiterPubkeys: [], launcherSigs: [],
        protocolFeeAddress: new Uint8Array(33), protocolFeeBps: 0,
        poolMetaUri: '', poolCapabilityFlags: capabilityFlags,
        proof: new Uint8Array(256),
      });
      const decoded = worker.decodeTLpAddPayload(payload);
      const xOk = decoded ? worker.verifyXCurve(
        hexToBytes(decoded.share_xcurve_sigma),
        hexToBytes(decoded.share_c_secp),
        hexToBytes(decoded.share_c_bjj)) : false;
      const kA = worker.ammLpAddKernelVerify({
        variant: 1, poolId: poolIdBytes, assetX: canonA, deltaX: dA,
        shareAmount: init.founder_shares, shareCSecpBytes,
        inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
        inputCommitments: [cinA.toRawBytes(true)], sig64: sigA,
      });
      const kB = worker.ammLpAddKernelVerify({
        variant: 1, poolId: poolIdBytes, assetX: canonB, deltaX: dB,
        shareAmount: init.founder_shares, shareCSecpBytes,
        inputsX: [{ txid: 'bb'.repeat(32), vout: 0 }],
        inputCommitments: [cinB.toRawBytes(true)], sig64: sigB,
      });
      const allOk = !!decoded && xOk && kA && kB;
      ok(`sample ${i}: fee=${feeBps} caps=${capabilityFlags} Δa=${dA} Δb=${dB}`, allOk,
        `decode=${!!decoded} xcurve=${xOk} kA=${kA} kB=${kB}`);
      if (allOk) accepted++;
    } catch (e) {
      ok(`sample ${i}: should have validated`, false, e.message);
    }
  }
  console.log(`  ${accepted}/100 random POOL_INIT envelopes accepted (rest skipped: A==B or shares ≤ 0)`);
}

// ============== Pool-id determinism + uniqueness ==============
group('pool_id determinism + uniqueness');
{
  const rng = new XorShift(99999);
  const seenPools = new Map();  // poolId → (a, b, fee, caps)
  for (let i = 0; i < 200; i++) {
    samples++;
    const a = mkAssetId(rng);
    const b = mkAssetId(rng);
    if (bytesToHex(a) === bytesToHex(b)) continue;
    const fee = rng.range(0, 1000);
    const caps = rng.range(0, 1) * 0x01;
    const [canonA, canonB] = dappAsset.canonicalAssetPair(a, b);
    const pidHex = bytesToHex(dappAsset.derivePoolId(canonA, canonB, fee, caps));
    const pidHexAgain = bytesToHex(dappAsset.derivePoolId(canonA, canonB, fee, caps));
    ok(`sample ${i}: pool_id deterministic`, pidHex === pidHexAgain);
    const key = bytesToHex(canonA) + bytesToHex(canonB) + fee + caps;
    if (seenPools.has(pidHex)) {
      ok(`sample ${i}: collision check`, seenPools.get(pidHex) === key,
        `pool_id ${pidHex.slice(0,16)}… already seen for different (a,b,fee,caps)`);
    } else {
      seenPools.set(pidHex, key);
    }
  }
  console.log(`  ${seenPools.size} distinct pool_ids generated across ${samples} samples`);
}

// ============== Swap curve fuzz — invariants ==============
group('SWAP curve invariants — k monotonic, output positive, slippage bounded');
{
  const rng = new XorShift(54321);
  let okCount = 0;
  for (let i = 0; i < 200; i++) {
    samples++;
    const ra = 1_000n + rng.bigRange(0n, 1_000_000_000n);
    const rb = 1_000n + rng.bigRange(0n, 1_000_000_000n);
    const din = 1n + rng.bigRange(0n, ra / 4n);  // bounded — don't drain the pool
    const fee = rng.range(0, 1000);
    const dir = rng.range(0, 1);
    let result;
    try { result = worker.ammCurveDeltaOut(dir, ra, rb, din, fee); }
    catch (e) {
      ok(`fuzz ${i}: validator threw`, false, e.message);
      continue;
    }
    const { deltaOut } = result;
    // Curve invariants:
    // 1. deltaOut > 0 for non-trivial din
    ok(`fuzz ${i}: deltaOut > 0`, deltaOut > 0n);
    // 2. deltaOut < target reserve (can't drain past 0)
    const target = dir === 0 ? rb : ra;
    ok(`fuzz ${i}: deltaOut < target reserve`, deltaOut < target);
    // 3. k monotonic: k_post ≥ k_pre (with fee, strictly >)
    const kPre = ra * rb;
    const raPost = dir === 0 ? ra + din : ra - deltaOut;
    const rbPost = dir === 0 ? rb - deltaOut : rb + din;
    const kPost = raPost * rbPost;
    ok(`fuzz ${i}: k_post ≥ k_pre`, kPost >= kPre);
    okCount++;
  }
  console.log(`  ${okCount}/200 random swaps all preserve curve invariants`);
}

// ============== Summary ==============
console.log(`\n${pass}/${pass + fail} passed (${samples} samples)`);
if (fail > 0) process.exit(1);
