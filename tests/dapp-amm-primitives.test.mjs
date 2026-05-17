// Parity tests: dapp/amm-bjj.js + dapp/amm-sigma.js MUST produce byte-identical
// output to tests/amm-bjj.mjs + tests/amm-sigma-xcurve.mjs.
//
// Why this matters: the dapp will construct T_LP_ADD POOL_INIT payloads with
// (shareCSecp, shareCBJJ, shareXcurveSigma). The worker verifier deserializes
// those bytes and re-runs verifyXCurve. If the dapp's BJJ pedersen produces
// a different packed-point than the test reference, the worker rejects every
// pool-init the dapp tries to broadcast.
//
// Coverage:
//   1. BJJ generator parity (H_BJJ, G_BJJ) — packed-point bytes match
//   2. BJJ pedersen commit parity for representative (amount, blinding) pairs
//   3. XCurve sigma proof+verify parity (dapp prove → worker verify, vice versa)
//   4. XCurve domain string consistency (challenge matches)

import { JSDOM } from 'jsdom';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }

const dappBJJ = await import('../dapp/amm-bjj.js');
const dappSigma = await import('../dapp/amm-sigma.js');
const dappAsset = await import('../dapp/amm-asset.js');
const dappReceipt = await import('../dapp/amm-receipt.js');
const dappKernel = await import('../dapp/amm-kernel.js');
const dappMinLiq = await import('../dapp/amm-min-liq.js');
const dappEnvelope = await import('../dapp/amm-envelope.js');
const refBJJ = await import('./amm-bjj.mjs');
const refSigma = await import('./amm-sigma-xcurve.mjs');
const refAsset = await import('./amm-asset.mjs');
const refReceipt = await import('./amm-receipt.mjs');
const refKernel = await import('./amm-kernel.mjs');
const refMinLiq = await import('./amm-min-liq.mjs');
const refEnvelope = await import('./amm-envelope.mjs');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

function bytesEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ============== BJJ generator parity ==============
group('BJJ generator parity');
{
  const dappH = dappBJJ.packPoint(dappBJJ.H_BJJ());
  const refH = refBJJ.packPoint(refBJJ.H_BJJ());
  ok('H_BJJ packed bytes match', bytesEq(dappH, refH));
  const dappG = dappBJJ.packPoint(dappBJJ.G_BJJ());
  const refG = refBJJ.packPoint(refBJJ.G_BJJ());
  ok('G_BJJ packed bytes match', bytesEq(dappG, refG));
}

// ============== BJJ pedersen parity ==============
group('pedersenBJJ commit parity');
{
  const cases = [
    [0n, 0n],                  // padded-slot identity
    [1n, 1n],                  // smallest non-trivial
    [10_000n, 0xdeadbeefn],    // realistic
    [(1n << 63n) - 1n, (1n << 200n) | 7n],  // near-bounds
    [100_000_000n, 0n],        // 1 BTC, zero blinding (note: legal in non-strict)
  ];
  for (const [a, r] of cases) {
    const dC = dappBJJ.packPoint(dappBJJ.pedersenBJJ(a, r));
    const rC = refBJJ.packPoint(refBJJ.pedersenBJJ(a, r));
    ok(`pedersenBJJ(${a}, ${r}) packed-byte parity`, bytesEq(dC, rC));
  }
}

// ============== XCurve sigma — dapp prove → ref verify ==============
group('XCurve sigma: dapp prove → ref verify');
{
  // Use a deterministic RNG seed so the test is reproducible.
  let i = 0;
  const seed = new Uint8Array(40 * 8 + 32 * 16).fill(0);
  for (let j = 0; j < seed.length; j++) seed[j] = (j * 17 + 3) & 0xff;
  const detRng = (len) => seed.subarray(i, (i += len));
  const a = 12_345_678n;
  const r_secp = 0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789n;
  const r_BJJ  = 0x123456789abcdef123456789abcdef123456789abcdef123456789abcdef1234n;
  const { proof, C_secp_bytes, C_BJJ_bytes } = dappSigma.proveXCurveRaw({ a, r_secp, r_BJJ, rng: detRng });
  ok('dapp proof length is 169', proof.length === 169);
  ok('C_secp_bytes is 33', C_secp_bytes.length === 33);
  ok('C_BJJ_bytes is 32', C_BJJ_bytes.length === 32);
  ok('ref verifyXCurve accepts dapp proof',
    refSigma.verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes) === true);
  ok('dapp verifyXCurve accepts dapp proof',
    dappSigma.verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes) === true);
}

// ============== XCurve sigma — ref prove → dapp verify ==============
group('XCurve sigma: ref prove → dapp verify');
{
  let i = 0;
  const seed = new Uint8Array(40 * 8 + 32 * 16).fill(0);
  for (let j = 0; j < seed.length; j++) seed[j] = (j * 31 + 5) & 0xff;
  const detRng = (len) => seed.subarray(i, (i += len));
  const a = 999n;
  const r_secp = 0x111111111111111111111111111111111111111111111111111111111111111fn;
  const r_BJJ  = 0x2222222222222222222222222222222222222222222222222222222222222222n;
  const { proof, C_secp_bytes, C_BJJ_bytes } = refSigma.proveXCurve({ a, r_secp, r_BJJ, rng: detRng });
  ok('dapp verifyXCurve accepts ref proof',
    dappSigma.verifyXCurve(proof, C_secp_bytes, C_BJJ_bytes) === true);
}

// ============== amm-asset parity ==============
group('amm-asset: derivePoolId / deriveLpAssetId / deriveAssetIdFromReveal');
{
  const a = new Uint8Array(32); for (let i = 0; i < 32; i++) a[i] = i;
  const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = 64 + i;
  ok('derivePoolId(a, b, 30, 0) matches', bytesEq(dappAsset.derivePoolId(a, b, 30, 0), refAsset.derivePoolId(a, b, 30, 0)));
  ok('derivePoolId(a, b, 300, 1) matches', bytesEq(dappAsset.derivePoolId(a, b, 300, 1), refAsset.derivePoolId(a, b, 300, 1)));
  // Symmetric (canonical ordering)
  ok('derivePoolId(b, a) == derivePoolId(a, b)', bytesEq(dappAsset.derivePoolId(b, a, 30, 0), dappAsset.derivePoolId(a, b, 30, 0)));
  const pid = dappAsset.derivePoolId(a, b, 30, 0);
  ok('deriveLpAssetId matches', bytesEq(dappAsset.deriveLpAssetId(pid), refAsset.deriveLpAssetId(pid)));
  // CETCH-style asset id
  const txid = 'a'.repeat(64);
  ok('deriveAssetIdFromReveal matches', bytesEq(dappAsset.deriveAssetIdFromReveal(txid), refAsset.deriveAssetIdFromReveal(txid)));
}

// ============== amm-receipt parity ==============
group('amm-receipt: deriveReceiptBlinding');
{
  const sk = new Uint8Array(32); for (let i = 0; i < 32; i++) sk[i] = 17 + i;
  const pid = new Uint8Array(32); for (let i = 0; i < 32; i++) pid[i] = 200 + (i % 56);
  const aid = new Uint8Array(32); for (let i = 0; i < 32; i++) aid[i] = 50 + i;
  const op = dappReceipt.canonicalOutpoint('b'.repeat(64), 3);
  const opRef = refReceipt.canonicalOutpoint('b'.repeat(64), 3);
  ok('canonicalOutpoint matches', bytesEq(op, opRef));
  const dResult = dappReceipt.deriveReceiptBlinding({
    recipientPrivkey: sk, poolId: pid, anchorOutpoint: op, assetId: aid,
  });
  const rResult = refReceipt.deriveReceiptBlinding({
    recipientPrivkey: sk, poolId: pid, anchorOutpoint: opRef, assetId: aid,
  });
  ok('r_secp parity', dResult.r_secp === rResult.r_secp);
  ok('r_BJJ parity', dResult.r_BJJ === rResult.r_BJJ);
}

// ============== amm-kernel parity ==============
group('amm-kernel: lpAddKernelMsg + lpAddKernelSign');
{
  const pid = new Uint8Array(32); for (let i = 0; i < 32; i++) pid[i] = i;
  const aid = new Uint8Array(32); for (let i = 0; i < 32; i++) aid[i] = 100 + i;
  const cscBytes = new Uint8Array(33); cscBytes[0] = 0x02; for (let i = 1; i < 33; i++) cscBytes[i] = i;
  const inputs = [{ txid: 'c'.repeat(64), vout: 0 }, { txid: 'd'.repeat(64), vout: 1 }];
  const dMsg = dappKernel.lpAddKernelMsg({
    variant: 1, poolId: pid, assetX: aid, deltaX: 1_000n, shareAmount: 500n,
    shareCSecpBytes: cscBytes, inputsX: inputs,
  });
  const rMsg = refKernel.lpAddKernelMsg({
    variant: 1, poolId: pid, assetX: aid, deltaX: 1_000n, shareAmount: 500n,
    shareCSecpBytes: cscBytes, inputsX: inputs,
  });
  ok('lpAddKernelMsg byte-parity', bytesEq(dMsg, rMsg));
}

// ============== amm-min-liq parity ==============
group('amm-min-liq: MINIMUM_LIQUIDITY constants + derivations');
{
  ok('MINIMUM_LIQUIDITY === 1000n on both sides',
    dappMinLiq.MINIMUM_LIQUIDITY === 1000n && refMinLiq.MINIMUM_LIQUIDITY === 1000n);
  const pid = new Uint8Array(32); for (let i = 0; i < 32; i++) pid[i] = i * 3 + 7;
  ok('deriveMinLiqBlinding parity',
    dappMinLiq.deriveMinLiqBlinding(pid) === refMinLiq.deriveMinLiqBlinding(pid));
  const dC = dappMinLiq.deriveMinLiqCommitment(pid);
  const rC = refMinLiq.deriveMinLiqCommitment(pid);
  ok('deriveMinLiqCommitment parity', bytesEq(dC.toRawBytes(true), rC.toRawBytes(true)));
  ok('deriveMinLiqAmountCt parity',
    bytesEq(dappMinLiq.deriveMinLiqAmountCt(pid), refMinLiq.deriveMinLiqAmountCt(pid)));
  const dN = dappMinLiq.deriveMinLiqNumsRecipient(pid);
  const rN = refMinLiq.deriveMinLiqNumsRecipient(pid);
  ok('deriveMinLiqNumsRecipient.xOnly parity', bytesEq(dN.xOnly, rN.xOnly));
  ok('deriveMinLiqNumsRecipient.p2wpkh parity', bytesEq(dN.p2wpkh, rN.p2wpkh));
  // isqrt + founder shares
  const dInit = dappMinLiq.lpInitShares(1_000_000n, 2_000_000n);
  ok('lpInitShares.total_shares = isqrt(2e12) = 1414213', dInit.total_shares === 1414213n);
  ok('lpInitShares.founder_shares = total - 1000', dInit.founder_shares === 1414213n - 1000n);
}

// ============== amm-envelope parity ==============
group('amm-envelope: encodeLpAdd (variant 0 + variant 1)');
{
  const assetA = new Uint8Array(32); for (let i = 0; i < 32; i++) assetA[i] = i;
  const assetB = new Uint8Array(32); for (let i = 0; i < 32; i++) assetB[i] = 32 + i;
  const shareCSecp = new Uint8Array(33); shareCSecp[0] = 0x02; for (let i = 1; i < 33; i++) shareCSecp[i] = i;
  const shareCBJJ = new Uint8Array(32); for (let i = 0; i < 32; i++) shareCBJJ[i] = 200 + i;
  const sigma = new Uint8Array(169);
  const kernelSigA = new Uint8Array(64); kernelSigA.fill(0xaa);
  const kernelSigB = new Uint8Array(64); kernelSigB.fill(0xbb);
  const proof = new Uint8Array(8); proof.fill(0xcc);
  const args0 = {
    variant: 0, assetA, assetB, deltaA: 1_000n, deltaB: 2_000n, shareAmount: 1414n,
    shareCSecp, shareCBJJ, shareXcurveSigma: sigma,
    kernelSigA, kernelSigB, proof,
  };
  ok('encodeLpAdd(variant 0) byte-parity', bytesEq(dappEnvelope.encodeLpAdd(args0), refEnvelope.encodeLpAdd(args0)));
  const args1 = {
    ...args0, variant: 1,
    feeBps: 30, vkCid: 'bafyTest1', ceremonyCid: 'bafyCe1',
    arbiterPubkeys: [], launcherSigs: [],
    protocolFeeAddress: new Uint8Array(33), protocolFeeBps: 0,
    poolMetaUri: '', poolCapabilityFlags: 0,
  };
  ok('encodeLpAdd(variant 1) byte-parity', bytesEq(dappEnvelope.encodeLpAdd(args1), refEnvelope.encodeLpAdd(args1)));
}

// ============== Domain tag pinning ==============
group('Domain tag pinning');
{
  // Both sides MUST hash with 'tacit-amm-xcurve-v1'. If either drifts, the
  // FS challenge will differ and proofs round-trip-fail. Indirect check:
  // dapp's challenge() and ref's challenge() must produce identical results.
  const Cs = new Uint8Array(33).fill(0x02);
  const Cb = new Uint8Array(32).fill(0x42);
  const As = new Uint8Array(33).fill(0x02);
  const Ab = new Uint8Array(32).fill(0x55);
  const dE = dappSigma.challenge(Cs, Cb, As, Ab);
  const rE = refSigma.challenge(Cs, Cb, As, Ab);
  ok('FS challenge parity (domain tag agreement)', dE === rE);
}

// ============== summary ==============
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
