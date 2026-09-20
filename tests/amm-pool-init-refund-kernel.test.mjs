// POOL_INIT founder-refund kernel binding: the worker must verify a dapp-signed kernel with the refund tail.
//
// The dapp signs both POOL_INIT kernels over (variant, pool_id, asset, delta, share, inputs) PLUS the founder-refund
// tail expiry_height(4 LE) || refund_dest_xonly(32) || refund_blinding(32). The worker's message builder refuses to
// run without that tail, so verifying a dapp-signed kernel without it can only return false. This test pins:
//   1. the OLD call shape (no refund args) rejects a genuine dapp-signed POOL_INIT kernel      -> the bug
//   2. ammPoolInitRefunds() supplies the tail and the same signature verifies                  -> the fix
//   3. wire order (refund A @ vout 2, refund B @ vout 3) is mapped to canonical order under a swap
//   4. a refund vout that is not P2TR reads as zero, which the founder never signed            -> rejected
//   5. a tampered expiry or blinding is rejected
//
// Runs offline, no DOM: node tests/amm-pool-init-refund-kernel.test.mjs

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

const worker = await import('../worker/src/index.js');
const dappBp = await import('../dapp/bulletproofs.js');
const dappKernel = await import('../dapp/amm-kernel.js');
const dappAsset = await import('../dapp/amm-asset.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; } else { console.log(`  FAIL  ${name}${detail ? ' - ' + detail : ''}`); fail++; }
}

const sk = secp.utils.randomPrivateKey();
const detBytes = (tag) => hmac(sha256, sk, new TextEncoder().encode(tag));
const xonlyOf = (tag) => secp.getPublicKey(detBytes(tag), true).slice(1);
const asset = (seed) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (seed * 31 + i * 17 + 3) & 0xff; return b; };

const [canonA, canonB] = dappAsset.canonicalAssetPair(asset(1), asset(2));
const poolId = dappAsset.derivePoolId(canonA, canonB, 30, 0);
const deltaA = 1_000_000n, deltaB = 2_000_000n, shareAmount = 1_414_213n;
const blindA = BigInt('0x' + bytesToHex(detBytes('blind-A'))), blindB = BigInt('0x' + bytesToHex(detBytes('blind-B')));
const commitA = dappBp.pedersenCommit(deltaA, blindA), commitB = dappBp.pedersenCommit(deltaB, blindB);
const shareC = dappBp.pedersenCommit(shareAmount, BigInt('0x' + bytesToHex(detBytes('share')))).toRawBytes(true);
const inputsA = [{ txid: 'aa'.repeat(32), vout: 0 }], inputsB = [{ txid: 'bb'.repeat(32), vout: 0 }];

// what the dapp builder signs: one x-only refund key for both sides, per-side blindings, an expiry height
const refundKey = xonlyOf('refund-key');
const refundABlinding = detBytes('refund-a'), refundBBlinding = detBytes('refund-b');
const expiryHeight = 967_900;

const sigA = dappKernel.lpAddKernelSign({ variant: 1, poolId, assetX: canonA, deltaX: deltaA, shareAmount, shareCSecpBytes: shareC,
  inputsX: inputsA, inputCommitments: [commitA], excessX: blindA, expiryHeight, refundDestXonly: refundKey, refundBlinding: refundABlinding });
const sigB = dappKernel.lpAddKernelSign({ variant: 1, poolId, assetX: canonB, deltaX: deltaB, shareAmount, shareCSecpBytes: shareC,
  inputsX: inputsB, inputCommitments: [commitB], excessX: blindB, expiryHeight, refundDestXonly: refundKey, refundBlinding: refundBBlinding });

const sideA = { variant: 1, poolId, assetX: canonA, deltaX: deltaA, shareAmount, shareCSecpBytes: shareC, inputsX: inputsA, inputCommitments: [commitA.toRawBytes(true)], sig64: sigA };
const sideB = { variant: 1, poolId, assetX: canonB, deltaX: deltaB, shareAmount, shareCSecpBytes: shareC, inputsX: inputsB, inputCommitments: [commitB.toRawBytes(true)], sig64: sigB };

const p2tr = (x) => '5120' + bytesToHex(x);
const tx = { vout: [{ scriptpubkey: '0014' + '00'.repeat(20) }, { scriptpubkey: '0014' + '11'.repeat(20) }, { scriptpubkey: p2tr(refundKey) }, { scriptpubkey: p2tr(refundKey) }] };
const lp = { expiry_height: expiryHeight, refund_a_blinding: bytesToHex(refundABlinding), refund_b_blinding: bytesToHex(refundBBlinding) };

console.log('\n1. the old call shape (no refund tail) rejects a genuine dapp-signed POOL_INIT kernel:');
ok('worker verify without refund args, side A', worker.ammLpAddKernelVerify(sideA) === false);
ok('worker verify without refund args, side B', worker.ammLpAddKernelVerify(sideB) === false);

console.log('\n2. ammPoolInitRefunds supplies the tail and the same signatures verify:');
{
  const r = worker.ammPoolInitRefunds(tx, lp, false);
  ok('side A verifies', worker.ammLpAddKernelVerify({ ...sideA, expiryHeight: r.expiryHeight, refundDestXonly: r.refundXonlyA, refundBlinding: r.refundBlindingA }) === true);
  ok('side B verifies', worker.ammLpAddKernelVerify({ ...sideB, expiryHeight: r.expiryHeight, refundDestXonly: r.refundXonlyB, refundBlinding: r.refundBlindingB }) === true);
}

console.log('\n3. wire order is mapped to canonical order under a swap:');
{
  const kA = xonlyOf('wire-a'), kB = xonlyOf('wire-b');
  const t2 = { vout: [{}, {}, { scriptpubkey: p2tr(kA) }, { scriptpubkey: p2tr(kB) }] };
  const l2 = { expiry_height: 7, refund_a_blinding: '01'.repeat(32), refund_b_blinding: '02'.repeat(32) };
  const straight = worker.ammPoolInitRefunds(t2, l2, false), swapped = worker.ammPoolInitRefunds(t2, l2, true);
  ok('unswapped: canonical A = wire A (vout 2, blinding a)', bytesToHex(straight.refundXonlyA) === bytesToHex(kA) && bytesToHex(straight.refundBlindingA) === '01'.repeat(32));
  ok('unswapped: canonical B = wire B (vout 3, blinding b)', bytesToHex(straight.refundXonlyB) === bytesToHex(kB) && bytesToHex(straight.refundBlindingB) === '02'.repeat(32));
  ok('swapped: canonical A = wire B (vout 3, blinding b)', bytesToHex(swapped.refundXonlyA) === bytesToHex(kB) && bytesToHex(swapped.refundBlindingA) === '02'.repeat(32));
  ok('swapped: canonical B = wire A (vout 2, blinding a)', bytesToHex(swapped.refundXonlyB) === bytesToHex(kA) && bytesToHex(swapped.refundBlindingB) === '01'.repeat(32));
  ok('expiry is read unsigned', worker.ammPoolInitRefunds(t2, { ...l2, expiry_height: 0xffffffff }, false).expiryHeight === 0xffffffff);
}

console.log('\n4. a non-P2TR refund vout reads as zero, which the founder never signed:');
{
  const bad = { vout: [{}, {}, { scriptpubkey: '0014' + '22'.repeat(20) }, { scriptpubkey: p2tr(refundKey) }] };
  const r = worker.ammPoolInitRefunds(bad, lp, false);
  ok('refund A key reads as zero', r.refundXonlyA.every((b) => b === 0));
  ok('side A is rejected', worker.ammLpAddKernelVerify({ ...sideA, expiryHeight: r.expiryHeight, refundDestXonly: r.refundXonlyA, refundBlinding: r.refundBlindingA }) === false);
  ok('a missing vout also reads as zero', worker.ammPoolInitRefunds({ vout: [] }, lp, false).refundXonlyA.every((b) => b === 0));
}

console.log('\n5. a tampered tail is rejected:');
{
  const r = worker.ammPoolInitRefunds(tx, lp, false);
  ok('wrong expiry', worker.ammLpAddKernelVerify({ ...sideA, expiryHeight: r.expiryHeight + 1, refundDestXonly: r.refundXonlyA, refundBlinding: r.refundBlindingA }) === false);
  ok('wrong blinding', worker.ammLpAddKernelVerify({ ...sideA, expiryHeight: r.expiryHeight, refundDestXonly: r.refundXonlyA, refundBlinding: r.refundBlindingB }) === false);
  ok('wrong refund key', worker.ammLpAddKernelVerify({ ...sideA, expiryHeight: r.expiryHeight, refundDestXonly: xonlyOf('other'), refundBlinding: r.refundBlindingA }) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
