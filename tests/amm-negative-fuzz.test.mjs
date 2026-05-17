// Adversarial / negative fuzz: payloads the worker MUST reject.
//
// Tests the validator's defense against:
//   1. Corrupted XCurve sigma (single bit flip)
//   2. Wrong asset_id in kernel sig (cross-asset sig replay)
//   3. Tampered shareAmount (try to mint more shares than allowed)
//   4. Tampered deltaA (try to reduce input)
//   5. Sigma proof on wrong commitments (cross-commit replay)
//   6. Kernel sig on wrong asset side (swap A and B sigs)
//   7. Wrong pool_id in kernel msg (cross-pool replay)
//
// Each must produce a payload that decodes structurally but fails the
// cryptographic validator — proving the validator catches each class
// of attack.

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

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

const lpSk = secp.utils.randomPrivateKey();
const seedKey = hmac(sha256, lpSk, new TextEncoder().encode('tacit-amm-xcurve-seed-v1'));

// Build a known-good POOL_INIT setup (shared across negative tests)
function buildGoodSetup() {
  const assetA = new Uint8Array(32); for (let i = 0; i < 32; i++) assetA[i] = i + 100;
  const assetB = new Uint8Array(32); for (let i = 0; i < 32; i++) assetB[i] = i + 200;
  const [canonA, canonB] = dappAsset.canonicalAssetPair(assetA, assetB);
  const dA = 100_000n, dB = 100_000n;
  const feeBps = 30, capabilityFlags = 0;
  const poolIdBytes = dappAsset.derivePoolId(canonA, canonB, feeBps, capabilityFlags);
  const lpAssetIdBytes = dappAsset.deriveLpAssetId(poolIdBytes);
  const init = dappMinLiq.lpInitShares(dA, dB);

  const blindA = 0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0n;
  const blindB = 0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321n;
  const cinA = dappBp.pedersenCommit(dA, blindA);
  const cinB = dappBp.pedersenCommit(dB, blindB);

  const inputAOp = dappReceipt.canonicalOutpoint('aa'.repeat(32), 0);
  const { r_secp, r_BJJ } = dappReceipt.deriveLpAddShareBlinding({
    recipientPrivkey: lpSk, poolId: poolIdBytes, lpInputAOutpoint: inputAOp, lpAssetId: lpAssetIdBytes,
  });
  const shareCSecpPt = dappBp.pedersenCommit(init.founder_shares, r_secp);
  const shareCBJJPt = dappBjj.pedersenBJJ(init.founder_shares, r_BJJ);
  const { proof: xcurveSigma } = dappSigma.proveXCurveDeterministic({
    a: init.founder_shares, r_secp, r_BJJ, seedKey,
    C_secp: shareCSecpPt, C_BJJ: shareCBJJPt,
  });

  const sigA = dappKernel.lpAddKernelSign({
    variant: 1, poolId: poolIdBytes, assetX: canonA, deltaX: dA,
    shareAmount: init.founder_shares, shareCSecpBytes: shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
    inputCommitments: [cinA], excessX: blindA,
  });
  const sigB = dappKernel.lpAddKernelSign({
    variant: 1, poolId: poolIdBytes, assetX: canonB, deltaX: dB,
    shareAmount: init.founder_shares, shareCSecpBytes: shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'bb'.repeat(32), vout: 0 }],
    inputCommitments: [cinB], excessX: blindB,
  });

  return {
    canonA, canonB, dA, dB, feeBps, capabilityFlags, poolIdBytes, init,
    shareCSecpPt, shareCBJJPt, xcurveSigma, sigA, sigB,
    cinA, cinB, blindA, blindB, r_secp, r_BJJ,
  };
}

const g = buildGoodSetup();

// Sanity: the good setup actually validates
group('baseline — good setup validates');
{
  const xOk = worker.verifyXCurve(g.xcurveSigma, g.shareCSecpPt.toRawBytes(true), dappBjj.packPoint(g.shareCBJJPt));
  const kA = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: g.canonA, deltaX: g.dA,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
    inputCommitments: [g.cinA.toRawBytes(true)], sig64: g.sigA,
  });
  const kB = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: g.canonB, deltaX: g.dB,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'bb'.repeat(32), vout: 0 }],
    inputCommitments: [g.cinB.toRawBytes(true)], sig64: g.sigB,
  });
  ok('baseline xcurve verify accepts', xOk);
  ok('baseline kernel sig A accepts', kA);
  ok('baseline kernel sig B accepts', kB);
}

// ============== Attack 1: corrupted XCurve sigma (single bit flip) ==============
group('attack 1 — corrupted sigma rejected');
{
  for (let pos of [0, 33, 65, 100, 168]) {
    const tampered = new Uint8Array(g.xcurveSigma);
    tampered[pos] ^= 0x01;
    const ok2 = worker.verifyXCurve(tampered, g.shareCSecpPt.toRawBytes(true), dappBjj.packPoint(g.shareCBJJPt));
    ok(`sigma byte[${pos}] bit-flip rejected`, ok2 === false);
  }
}

// ============== Attack 2: sigma binds different commits ==============
group('attack 2 — sigma swapped onto different commits');
{
  // Build a SECOND valid sigma binding different commits, then try to use
  // it against the first commits.
  const altRSecp = (g.r_secp + 1n) % dappBp.SECP_N;
  const altRBJJ = (g.r_BJJ + 1n) % dappBjj.N_BJJ;
  const altCS = dappBp.pedersenCommit(g.init.founder_shares, altRSecp);
  const altCB = dappBjj.pedersenBJJ(g.init.founder_shares, altRBJJ);
  const { proof: altSigma } = dappSigma.proveXCurveDeterministic({
    a: g.init.founder_shares, r_secp: altRSecp, r_BJJ: altRBJJ, seedKey,
    C_secp: altCS, C_BJJ: altCB,
  });
  // Try alt sigma against ORIGINAL commits — must reject
  const ok2 = worker.verifyXCurve(altSigma, g.shareCSecpPt.toRawBytes(true), dappBjj.packPoint(g.shareCBJJPt));
  ok('sigma bound to alt commits rejected against original commits', ok2 === false);
  // Alt sigma WITH alt commits — must accept
  const ok3 = worker.verifyXCurve(altSigma, altCS.toRawBytes(true), dappBjj.packPoint(altCB));
  ok('alt sigma w/ alt commits self-validates', ok3 === true);
}

// ============== Attack 3: kernel sig A used for side B ==============
group('attack 3 — kernel sig side-swap rejected');
{
  // Try to use sigA against assetX=canonB params (sig was signed under (canonA, dA, cinA))
  const ok2 = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: g.canonB, deltaX: g.dB,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'bb'.repeat(32), vout: 0 }],
    inputCommitments: [g.cinB.toRawBytes(true)], sig64: g.sigA,  // sigA instead of sigB
  });
  ok('sigA against side-B params rejected', ok2 === false);
}

// ============== Attack 4: tampered shareAmount ==============
group('attack 4 — shareAmount inflation rejected');
{
  // Signer signed for shareAmount = founder_shares. Try verify with 2x.
  const ok2 = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: g.canonA, deltaX: g.dA,
    shareAmount: g.init.founder_shares * 2n,  // INFLATED
    shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
    inputCommitments: [g.cinA.toRawBytes(true)], sig64: g.sigA,
  });
  ok('shareAmount 2x inflation rejected', ok2 === false);
}

// ============== Attack 5: tampered deltaX ==============
group('attack 5 — deltaX tampering rejected');
{
  // Signer signed for deltaX = dA. Try verify with dA/2 (claim half input
  // but still trying to mint full founder_shares).
  const ok2 = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: g.canonA, deltaX: g.dA / 2n,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
    inputCommitments: [g.cinA.toRawBytes(true)], sig64: g.sigA,
  });
  ok('deltaX half-value rejected', ok2 === false);
}

// ============== Attack 6: wrong asset_id (cross-asset sig replay) ==============
group('attack 6 — cross-asset sig replay rejected');
{
  // Sign for canonA but try verify with a third asset (canonA' = canonA bit-flipped)
  const evilAsset = new Uint8Array(g.canonA); evilAsset[0] ^= 0xff;
  const ok2 = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: evilAsset, deltaX: g.dA,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
    inputCommitments: [g.cinA.toRawBytes(true)], sig64: g.sigA,
  });
  ok('sig against wrong asset_id rejected', ok2 === false);
}

// ============== Attack 7: wrong pool_id (cross-pool replay) ==============
group('attack 7 — cross-pool sig replay rejected');
{
  // Signed for our pool; try verify with a different pool
  const evilPool = new Uint8Array(g.poolIdBytes); evilPool[31] ^= 0x01;
  const ok2 = worker.ammLpAddKernelVerify({
    variant: 1, poolId: evilPool, assetX: g.canonA, deltaX: g.dA,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
    inputCommitments: [g.cinA.toRawBytes(true)], sig64: g.sigA,
  });
  ok('sig against wrong pool_id rejected', ok2 === false);
}

// ============== Attack 8: wrong input outpoint ==============
group('attack 8 — input outpoint substitution rejected');
{
  // Same asset + delta but different input txid
  const ok2 = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: g.canonA, deltaX: g.dA,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'cc'.repeat(32), vout: 0 }],  // different txid
    inputCommitments: [g.cinA.toRawBytes(true)], sig64: g.sigA,
  });
  ok('sig against substituted input outpoint rejected', ok2 === false);
}

// ============== Attack 9: wrong input commitment ==============
group('attack 9 — input commit substitution rejected');
{
  // Same outpoint but different commit (alt blinding)
  const altCin = dappBp.pedersenCommit(g.dA, g.blindA + 1n).toRawBytes(true);
  const ok2 = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: g.canonA, deltaX: g.dA,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
    inputCommitments: [altCin],  // wrong commit
    sig64: g.sigA,
  });
  ok('sig against wrong input commit rejected', ok2 === false);
}

// ============== Attack 10: malformed sig (all zeros) ==============
group('attack 10 — malformed sig rejected');
{
  const ok2 = worker.ammLpAddKernelVerify({
    variant: 1, poolId: g.poolIdBytes, assetX: g.canonA, deltaX: g.dA,
    shareAmount: g.init.founder_shares, shareCSecpBytes: g.shareCSecpPt.toRawBytes(true),
    inputsX: [{ txid: 'aa'.repeat(32), vout: 0 }],
    inputCommitments: [g.cinA.toRawBytes(true)],
    sig64: new Uint8Array(64),  // all zeros
  });
  ok('all-zero sig rejected', ok2 === false);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
