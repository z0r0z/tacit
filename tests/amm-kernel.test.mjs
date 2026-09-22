// LP envelope kernel-msg + kernel-sig tests.
//
// Asserts:
//   • LP_ADD: kernel sig on side X verifies iff Σ C_in_X − delta_X·H opens with
//     known excess; tampering with delta / pool_id / share_amount breaks the sig
//   • LP_REMOVE: kernel sig on lp_share input verifies iff share_amount matches
//     the consumed Pedersen value
//   • Mimblewimble balance check: wrong delta ⇒ verification key differs ⇒ rejection
//   • Domain separation: LP_ADD and LP_REMOVE kernel_msgs are distinguishable
//   • The refund tail is required and signed; the mirror is byte-identical to dapp/amm-kernel.js and the worker

import {
  lpAddKernelMsg, lpAddKernelKey, lpAddKernelSign, lpAddKernelVerify,
  lpRemoveKernelMsg, lpRemoveKernelKey, lpRemoveKernelSign, lpRemoveKernelVerify,
  lpBondKernelMsg, lpBondKernelSign, lpBondKernelVerify,
} from './amm-kernel.mjs';
import * as dappKernel from '../dapp/amm-kernel.js';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, hexToBytes } from '@noble/hashes/utils';
import {
  G, H, SECP_N, modN,
  pedersenCommit, pointToBytes, randomScalar, bigintToBytes32,
} from './bulletproofs.mjs';
import {
  TEST_LP_ADD_KERNEL_TAIL_A, TEST_LP_ADD_KERNEL_TAIL_B, TEST_REFUND_TAIL,
} from './helpers/amm-refund-tail.mjs';

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
    inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
    inputCommitments: sideA.commitments,
    excessX: sideA.excess,
  });
  const sigB = lpAddKernelSign({
    variant: 0,
    poolId: POOL_ID, assetX: ASSET_B, deltaX: deltaB, shareAmount,
    shareCSecpBytes: shareC,
    inputsX: sideB.inputs, ...TEST_LP_ADD_KERNEL_TAIL_B,
    inputCommitments: sideB.commitments,
    excessX: sideB.excess,
  });

  test('asset-A kernel sig verifies (honest)', () => {
    return lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('asset-B kernel sig verifies (honest)', () => {
    return lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_B, deltaX: deltaB, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideB.inputs, ...TEST_LP_ADD_KERNEL_TAIL_B,
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
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
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
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('wrong share_amount ⇒ verify rejects', () => {
    return !lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount: shareAmount + 1n,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('wrong variant (0 vs 1) ⇒ verify rejects', () => {
    return !lpAddKernelVerify({
      variant: 1,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('wrong input ordering ⇒ verify rejects', () => {
    return !lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs.slice().reverse(), ...TEST_LP_ADD_KERNEL_TAIL_A,
      inputCommitments: sideA.commitments,
      sig64: sigA,
    });
  });
  test('forged sig (wrong excess) ⇒ verify rejects', () => {
    const forgedSig = lpAddKernelSign({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
      inputCommitments: sideA.commitments,
      excessX: modN(sideA.excess + 1n), // wrong
    });
    return !lpAddKernelVerify({
      variant: 0,
      poolId: POOL_ID, assetX: ASSET_A, deltaX: deltaA, shareAmount,
      shareCSecpBytes: shareC,
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
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
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
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
      inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
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
    lpInputs: setup.inputs, refundDestXonly: TEST_REFUND_TAIL.refundDestXonly,
    lpInputCommitments: setup.commitments,
    excessLP: setup.excess,
  });

  test('LP_REMOVE kernel sig verifies (honest)', () => {
    return lpRemoveKernelVerify({
      poolId: POOL_ID, shareAmount, deltaA, deltaB,
      recvACSecpBytes: recvA_C, recvBCSecpBytes: recvB_C,
      lpInputs: setup.inputs, refundDestXonly: TEST_REFUND_TAIL.refundDestXonly,
      lpInputCommitments: setup.commitments,
      sig64: sig,
    });
  });
  test('LP_REMOVE — wrong share_amount ⇒ reject', () => {
    return !lpRemoveKernelVerify({
      poolId: POOL_ID, shareAmount: shareAmount + 1n, deltaA, deltaB,
      recvACSecpBytes: recvA_C, recvBCSecpBytes: recvB_C,
      lpInputs: setup.inputs, refundDestXonly: TEST_REFUND_TAIL.refundDestXonly,
      lpInputCommitments: setup.commitments,
      sig64: sig,
    });
  });
  test('LP_REMOVE — wrong receipt commitment ⇒ reject', () => {
    const wrong = pointToBytes(pedersenCommit(deltaA + 1n, r_recvA));
    return !lpRemoveKernelVerify({
      poolId: POOL_ID, shareAmount, deltaA, deltaB,
      recvACSecpBytes: wrong, recvBCSecpBytes: recvB_C,
      lpInputs: setup.inputs, refundDestXonly: TEST_REFUND_TAIL.refundDestXonly,
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
    ...TEST_LP_ADD_KERNEL_TAIL_A,
  });
  const removeMsg = lpRemoveKernelMsg({
    poolId: POOL_ID, shareAmount: 1n, deltaA: 10n, deltaB: 10n,
    recvACSecpBytes: cs, recvBCSecpBytes: cs, lpInputs: setup.inputs,
    refundDestXonly: TEST_REFUND_TAIL.refundDestXonly,
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
      inputsX: [], ...TEST_LP_ADD_KERNEL_TAIL_A,
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
      inputsX: [{ txid: TXID1, vout: 0 }], ...TEST_LP_ADD_KERNEL_TAIL_A,
    });
    return false;
  } catch (e) { return /variant/.test(e.message); }
});

console.log('\nRefund tail — required and signed');
{
  const sideA = buildSideX({ amounts: [7_000n, 3_000n], prefix: 'a' });
  const shareC = pointToBytes(pedersenCommit(5_000n, randomScalar()));
  const addArgs = {
    variant: 0, poolId: POOL_ID, assetX: ASSET_A, deltaX: 10_000n, shareAmount: 5_000n,
    shareCSecpBytes: shareC, inputsX: sideA.inputs, inputCommitments: sideA.commitments,
    ...TEST_LP_ADD_KERNEL_TAIL_A,
  };
  const sig = lpAddKernelSign({ ...addArgs, excessX: sideA.excess });
  test('LP_ADD verifies under the signed tail', () => lpAddKernelVerify({ ...addArgs, sig64: sig }));
  test('LP_ADD — different expiry ⇒ reject', () =>
    !lpAddKernelVerify({ ...addArgs, expiryHeight: addArgs.expiryHeight + 1, sig64: sig }));
  test('LP_ADD — different refund dest ⇒ reject', () =>
    !lpAddKernelVerify({ ...addArgs, refundDestXonly: TEST_LP_ADD_KERNEL_TAIL_B.refundDestXonly, sig64: sig }));
  test('LP_ADD — different refund blinding ⇒ reject', () =>
    !lpAddKernelVerify({ ...addArgs, refundBlinding: TEST_LP_ADD_KERNEL_TAIL_B.refundBlinding, sig64: sig }));
  for (const field of ['refundDestXonly', 'refundBlinding']) {
    test(`lpAddKernelMsg without ${field} throws`, () => {
      try { lpAddKernelMsg({ ...addArgs, [field]: undefined }); return false; }
      catch { return true; }
    });
    test(`lpAddKernelMsg with a 31-byte ${field} throws`, () => {
      try { lpAddKernelMsg({ ...addArgs, [field]: new Uint8Array(31) }); return false; }
      catch (e) { return new RegExp(`${field} must be 32 bytes`).test(e.message); }
    });
  }

  const recvA = pointToBytes(pedersenCommit(4_000n, randomScalar()));
  const recvB = pointToBytes(pedersenCommit(6_000n, randomScalar()));
  const rmArgs = {
    poolId: POOL_ID, shareAmount: 10_000n, deltaA: 4_000n, deltaB: 6_000n,
    recvACSecpBytes: recvA, recvBCSecpBytes: recvB, lpInputs: sideA.inputs,
    lpInputCommitments: sideA.commitments, refundDestXonly: TEST_REFUND_TAIL.refundDestXonly,
  };
  const rmSig = lpRemoveKernelSign({ ...rmArgs, excessLP: sideA.excess });
  test('LP_REMOVE verifies under the signed refund dest', () => lpRemoveKernelVerify({ ...rmArgs, sig64: rmSig }));
  test('LP_REMOVE — different refund dest ⇒ reject', () =>
    !lpRemoveKernelVerify({ ...rmArgs, refundDestXonly: TEST_LP_ADD_KERNEL_TAIL_B.refundDestXonly, sig64: rmSig }));
  test('lpRemoveKernelMsg without refundDestXonly throws', () => {
    try { lpRemoveKernelMsg({ ...rmArgs, refundDestXonly: undefined }); return false; }
    catch { return true; }
  });
}

console.log('\nLP_BOND kernel sig');
{
  const FARM_ID = new Uint8Array(32).fill(0x33);
  const LP_ASSET = new Uint8Array(32).fill(0x44);
  const setup = buildSideX({ amounts: [800n, 200n], prefix: 'b' });
  const args = { farmId: FARM_ID, lpAsset: LP_ASSET, bondAmount: 1_000n, lpInputs: setup.inputs, lpInputCommitments: setup.commitments };
  const sig = lpBondKernelSign({ ...args, excessLP: setup.excess });
  test('LP_BOND kernel sig verifies (honest)', () => lpBondKernelVerify({ ...args, sig64: sig }));
  test('LP_BOND — wrong bond amount ⇒ reject', () => !lpBondKernelVerify({ ...args, bondAmount: 1_001n, sig64: sig }));
  test('LP_BOND — wrong farm id ⇒ reject', () => !lpBondKernelVerify({ ...args, farmId: POOL_ID, sig64: sig }));
}

console.log('\nParity with dapp/amm-kernel.js and the worker');
{
  const worker = await import('../worker/src/index.js');
  const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const u64 = (n) => { const b = new Uint8Array(8); let x = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const op = ({ txid, vout }) => concatBytes(hexToBytes(txid).reverse(), u32(vout));

  const sideA = buildSideX({ amounts: [123_456n, 654_321n], prefix: 'a' });
  const commitBytes = sideA.commitments.map(pointToBytes);
  const shareC = pointToBytes(pedersenCommit(42_000n, randomScalar()));
  for (const variant of [0, 1]) {
    const args = {
      variant, poolId: POOL_ID, assetX: ASSET_A, deltaX: 777_777n, shareAmount: 42_000n,
      shareCSecpBytes: shareC, inputsX: sideA.inputs, ...TEST_LP_ADD_KERNEL_TAIL_A,
    };
    const m = lpAddKernelMsg(args);
    const layout = sha256(concatBytes(
      new TextEncoder().encode('tacit-amm-lp-add-v1'), new Uint8Array([variant]), POOL_ID, ASSET_A,
      u64(777_777n), u64(42_000n), shareC, new Uint8Array([sideA.inputs.length]), ...sideA.inputs.map(op),
      u32(TEST_LP_ADD_KERNEL_TAIL_A.expiryHeight), TEST_LP_ADD_KERNEL_TAIL_A.refundDestXonly,
      TEST_LP_ADD_KERNEL_TAIL_A.refundBlinding,
    ));
    test(`lpAddKernelMsg v${variant} matches the guest layout`, () => eq(m, layout));
    test(`lpAddKernelMsg v${variant} mirror == dapp`, () => eq(m, dappKernel.lpAddKernelMsg(args)));
    test(`lpAddKernelMsg v${variant} mirror == worker`, () => eq(m, worker.ammLpAddKernelMsg(args)));
    const sig = lpAddKernelSign({ ...args, inputCommitments: sideA.commitments, excessX: sideA.excess });
    test(`lpAddKernelSign v${variant} verifies under dapp + worker`, () =>
      dappKernel.lpAddKernelVerify({ ...args, inputCommitments: commitBytes, sig64: sig })
      && worker.ammLpAddKernelVerify({ ...args, inputCommitments: commitBytes, sig64: sig }));
  }

  const recvA = pointToBytes(pedersenCommit(11n, randomScalar()));
  const recvB = pointToBytes(pedersenCommit(22n, randomScalar()));
  const rmArgs = {
    poolId: POOL_ID, shareAmount: sideA.totalAmount, deltaA: 11n, deltaB: 22n,
    recvACSecpBytes: recvA, recvBCSecpBytes: recvB, lpInputs: sideA.inputs,
    refundDestXonly: TEST_REFUND_TAIL.refundDestXonly,
  };
  const rm = lpRemoveKernelMsg(rmArgs);
  test('lpRemoveKernelMsg mirror == dapp', () => eq(rm, dappKernel.lpRemoveKernelMsg(rmArgs)));
  test('lpRemoveKernelMsg mirror == worker', () => eq(rm, worker.ammLpRemoveKernelMsg(rmArgs)));
  const rmSig = lpRemoveKernelSign({ ...rmArgs, lpInputCommitments: sideA.commitments, excessLP: sideA.excess });
  test('lpRemoveKernelSign verifies under dapp + worker', () =>
    dappKernel.lpRemoveKernelVerify({ ...rmArgs, lpInputCommitments: commitBytes, sig64: rmSig })
    && worker.ammLpRemoveKernelVerify({ ...rmArgs, lpInputCommitments: commitBytes, sig64: rmSig }));

  const bondArgs = { farmId: POOL_ID, lpAsset: ASSET_B, bondAmount: 777_777n, lpInputs: sideA.inputs };
  const bm = lpBondKernelMsg(bondArgs);
  test('lpBondKernelMsg mirror == dapp', () => eq(bm, dappKernel.lpBondKernelMsg(bondArgs)));
  test('lpBondKernelMsg mirror == worker', () => eq(bm, worker.ammLpBondKernelMsg(bondArgs)));
  const bondSig = lpBondKernelSign({ ...bondArgs, lpInputCommitments: sideA.commitments, excessLP: sideA.excess });
  test('lpBondKernelSign verifies under dapp + worker', () =>
    dappKernel.lpBondKernelVerify({ ...bondArgs, lpInputCommitments: commitBytes, sig64: bondSig })
    && worker.ammLpBondKernelVerify({ ...bondArgs, lpInputCommitments: commitBytes, sig64: bondSig }));

  test('dapp rejects a tail-less LP_ADD message the same way', () => {
    let mirrorThrew = false, dappThrew = false;
    const bare = { variant: 0, poolId: POOL_ID, assetX: ASSET_A, deltaX: 1n, shareAmount: 1n, shareCSecpBytes: shareC, inputsX: sideA.inputs };
    try { lpAddKernelMsg(bare); } catch { mirrorThrew = true; }
    try { dappKernel.lpAddKernelMsg(bare); } catch { dappThrew = true; }
    return mirrorThrew && dappThrew;
  });
}

console.log(`\n${pass}/${pass + fail} passed`);
// Exit on the computed verdict rather than only on failure: imported browser modules can leave the
// event loop alive, and a run that passes every assertion then never exits reads as a hang.
process.exit(fail > 0 ? 1 : 0);
