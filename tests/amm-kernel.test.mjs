// LP envelope kernel-msg + kernel-sig tests.
//
// Asserts:
//   • LP_ADD: kernel sig on side X verifies iff Σ C_in_X − delta_X·H opens with
//     known excess; tampering with delta / pool_id / share_amount breaks the sig
//   • LP_REMOVE: kernel sig on lp_share input verifies iff share_amount matches
//     the consumed Pedersen value
//   • Mimblewimble balance check: wrong delta ⇒ verification key differs ⇒ rejection
//   • Domain separation: LP_ADD and LP_REMOVE kernel_msgs are distinguishable

import {
  lpAddKernelMsg, lpAddKernelKey, lpAddKernelSign, lpAddKernelVerify,
  lpRemoveKernelMsg, lpRemoveKernelKey, lpRemoveKernelSign, lpRemoveKernelVerify,
} from './amm-kernel.mjs';
import {
  G, H, SECP_N, modN,
  pedersenCommit, pointToBytes, randomScalar, bigintToBytes32,
} from './bulletproofs.mjs';

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

const POOL_ID = new Uint8Array(32).fill(0x77);
const ASSET_A = new Uint8Array(32).fill(0xaa);
const ASSET_B = new Uint8Array(32).fill(0xbb);
const TXID1 = 'deadbeefcafef00d0123456789abcdef0123456789abcdef0123456789abcdef';
const TXID2 = '1111111111111111111111111111111111111111111111111111111111111111';

// Build a 2-input setup on side A with known excess.
function buildSideX({ amounts, prefix = 'a' }) {
  // returns { commitments, excess, inputs }
  const blindings = amounts.map(() => randomScalar());
  const commitments = amounts.map((a, i) => pedersenCommit(BigInt(a), blindings[i]));
  const excess = blindings.reduce((s, x) => modN(s + x), 0n);
  const inputs = amounts.map((_, i) => ({
    txid: (prefix === 'a' ? TXID1 : TXID2),
    vout: i,
  }));
  return { commitments, excess, inputs, totalAmount: amounts.reduce((s, x) => s + BigInt(x), 0n) };
}

console.log('LP_ADD kernel sig — honest round-trip');
{
  const deltaA = 1_000_000n, deltaB = 2_000_000n, shareAmount = 1_414_213n;
  const r_share = randomScalar();
  const shareC = pointToBytes(pedersenCommit(shareAmount, r_share));

  const sideA = buildSideX({ amounts: [600_000n, 400_000n], prefix: 'a' });
  const sideB = buildSideX({ amounts: [1_500_000n, 500_000n], prefix: 'b' });

  const sigA = lpAddKernelSign({
    variant: 0,
    poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
    shareCSecpBytes: shareC,
    inputsX: sideA.inputs,
    inputCommitments: sideA.commitments,
    excessX: sideA.excess,
  });
  const sigB = lpAddKernelSign({
    variant: 0,
    poolId: POOL_ID, assetX: ASSET_B, deltaX: deltaB, shareAmount,
    shareCSecpBytes: shareC,
    inputsX: sideB.inputs,
    inputCommitments: sideB.commitments,
    excessX: sideB.excess,
  });

  test('asset-A kernel sig verifies (honest)', () => {
    return lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('asset-B kernel sig verifies (honest)', () => {
    return lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_B, deltaX: deltaB, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideB.inputs,
      inputCommitments: sideB.commitments,
      sig64: sigB,
    });
  });

  console.log('\nLP_ADD soundness — Mimblewimble balance');
  test('wrong delta (mismatched amount) ⇒ verify rejects', () => {
    return !lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA + 1n, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('wrong pool_id ⇒ verify rejects', () => {
    const wrong = new Uint8Array(32).fill(0xff);
    return !lpAddKernelVerify({
      variant: 0,
      poolId: wrong, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('wrong share_amount ⇒ verify rejects', () => {
    return !lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount: shareAmount + 1n,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('wrong variant (0 vs 1) ⇒ verify rejects', () => {
    return !lpAddKernelVerify({
      variant: 1,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('wrong input ordering ⇒ verify rejects', () => {
    return !lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs.slice().reverse(),
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('forged sig (wrong excess) ⇒ verify rejects', () => {
    const forgedSig = lpAddKernelSign({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      excessX: modN(sideA.excess + 1n), // wrong
    });
    return !lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      sig64: forgedSig,
    });
  });

  console.log('\nLP_ADD inflation attack — wrong amount, right blinding sum');
  test('caller provides delta != sum(amounts) ⇒ signing key collapses elsewhere ⇒ verify fails', () => {
    // The Mimblewimble argument: if delta != sum, then Σ C - delta·H = (sum-delta)·H + excess·G,
    // which has unknown discrete log under H_secp without knowing excess+something. A naive sig
    // attempt under excess alone won't verify against the wrong-key.
    const forgedSig = lpAddKernelSign({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA + 1n, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      excessX: sideA.excess,
    });
    // Verify with the (wrong, claimed) delta — same delta we signed under.
    // The signing key is (Σ C - (delta+1)·H), under unknown discrete log;
    // signSchnorr is deterministic on (msg, d) but d was excess, not log of the key.
    // So this sig won't verify against the wrong-key.
    return !lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA + 1n, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs,
      inputCommitments: sideA.commitments,
      sig64: forgedSig,
    });
  });
}

console.log('\nLP_REMOVE kernel sig — honest round-trip');
{
  const shareAmount = 100_000n;
  const deltaA = 50_000n, deltaB = 100_000n;
  const r_recvA = randomScalar(), r_recvB = randomScalar();
  const recvA_C = pointToBytes(pedersenCommit(deltaA, r_recvA));
  const recvB_C = pointToBytes(pedersenCommit(deltaB, r_recvB));

  // LP holds 2 lp_asset_id UTXOs totaling 100k shares.
  const setup = buildSideX({ amounts: [60_000n, 40_000n], prefix: 'a' });
  const sig = lpRemoveKernelSign({
    poolId: POOL_ID, shareAmount, deltaA, deltaB,
    recvACSecpBytes: recvA_C, recvBCSecpBytes: recvB_C,
    lpInputs: setup.inputs,
    lpInputCommitments: setup.commitments,
    excessLP: setup.excess,
  });

  test('LP_REMOVE kernel sig verifies (honest)', () => {
    return lpRemoveKernelVerify({
      poolId: POOL_ID, shareAmount, deltaA, deltaB,
      recvACSecpBytes: recvA_C, recvBCSecpBytes: recvB_C,
      lpInputs: setup.inputs,
      lpInputCommitments: setup.commitments,
      sig64: sig,
    });
  });
  test('LP_REMOVE — wrong share_amount ⇒ reject', () => {
    return !lpRemoveKernelVerify({
      poolId: POOL_ID, shareAmount: shareAmount + 1n, deltaA, deltaB,
      recvACSecpBytes: recvA_C, recvBCSecpBytes: recvB_C,
      lpInputs: setup.inputs,
      lpInputCommitments: setup.commitments,
      sig64: sig,
    });
  });
  test('LP_REMOVE — wrong receipt commitment ⇒ reject', () => {
    const wrong = pointToBytes(pedersenCommit(deltaA + 1n, r_recvA));
    return !lpRemoveKernelVerify({
      poolId: POOL_ID, shareAmount, deltaA, deltaB,
      recvACSecpBytes: wrong, recvBCSecpBytes: recvB_C,
      lpInputs: setup.inputs,
      lpInputCommitments: setup.commitments,
      sig64: sig,
    });
  });
}

console.log('\nDomain separation');
test('LP_ADD and LP_REMOVE kernel msgs are distinguishable for identical inputs', () => {
  const setup = buildSideX({ amounts: [10n], prefix: 'a' });
  const cs = pointToBytes(pedersenCommit(1n, randomScalar()));
  const addMsg = lpAddKernelMsg({
    variant: 0, poolId: POOL_ID, assetX: ASSET_A,
    deltaX: 10n, shareAmount: 1n, shareCSecpBytes: cs, inputsX: setup.inputs,
  });
  const removeMsg = lpRemoveKernelMsg({
    poolId: POOL_ID, shareAmount: 1n, deltaA: 10n, deltaB: 10n,
    recvACSecpBytes: cs, recvBCSecpBytes: cs, lpInputs: setup.inputs,
  });
  // Different domain tags ⇒ different SHA256.
  for (let i = 0; i < 32; i++) if (addMsg[i] !== removeMsg[i]) return true;
  return false;
});

console.log('\nInput validation');
test('empty inputsX rejected', () => {
  try {
    lpAddKernelMsg({
      variant: 0, poolId: POOL_ID, assetX: ASSET_A,
      deltaX: 1n, shareAmount: 1n,
      shareCSecpBytes: pointToBytes(pedersenCommit(1n, randomScalar())),
      inputsX: [],
    });
    return false;
  } catch (e) { return /non-empty/.test(e.message); }
});
test('rejects invalid variant', () => {
  try {
    lpAddKernelMsg({
      variant: 2, poolId: POOL_ID, assetX: ASSET_A,
      deltaX: 1n, shareAmount: 1n,
      shareCSecpBytes: pointToBytes(pedersenCommit(1n, randomScalar())),
      inputsX: [{ txid: TXID1, vout: 0 }],
    });
    return false;
  } catch (e) { return /variant/.test(e.message); }
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
