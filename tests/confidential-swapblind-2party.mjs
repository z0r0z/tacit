// OP_SWAP_BLIND (31) two-party protocol test. Two independent trader closures (X: A→B, Y: B→A,
// mismatched amounts) and a coordinator closure exchange only plain-data "wire" messages — every
// object crossing a closure boundary is stripped of its `_`-prefixed fields first (toWire), so a
// leaked secret (a trader's own note blinding, `_rInSecp` / `_rOutSecp`) would surface as `undefined`
// in the coordinator's math rather than silently working. This is the interactive round protocol
// described in dapp/confidential-swapblind.js's kernel-cosigning comment, run for real:
//
//   1. X and Y each build their own input leg (prepareInputLeg) — no counterparty needed.
//   2. The coordinator solves the batch's clearing price from directions/amounts alone
//      (solveBatchClearing — no blinding needed) and tells each trader its own amountOut.
//   3. X and Y each build their own output leg (prepareOutputLeg) from that amountOut.
//   4. The coordinator computes the public aggregate point X_A/X_B for each kernel
//      (kernelAggregatePointFromLegs) and every co-signer (X, Y, the coordinator for the tip)
//      round-trips a nonce commitment, then a partial response, per kernel.
//   5. The coordinator assembles the final envelope (assembleSwapBlindFromLegs) from the traders'
//      public legs plus the two combined kernels.
//
// Verifies every guest-mirroring check the single-shot builder's own test exercises (xcurve sigmas,
// blind opening PoKs, the inner Groth16 proof, the per-asset conservation kernels) against the
// result, so a mirror-accepted split-path envelope is guest-accepted exactly like the monolithic one.
//
// Run: node tests/confidential-swapblind-2party.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import assert from 'node:assert';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import {
  makeConfidentialSwapblind, verifyAggregateKernel,
  solveBatchClearing, kernelAggregatePointFromLegs,
  kernelNonceCommit, kernelChallenge, kernelPartialResponse, combineKernelResponses,
} from '../dapp/confidential-swapblind.js';
import { swapBatchGroth16Prove } from '../dapp/confidential-swapbatch.js';
import { verifyXCurve } from '../dapp/amm-sigma.js';
import { pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const N = secp.CURVE.n;
const randScalar = () => { while (true) { const b = createHash('sha256').update(crypto.getRandomValues(new Uint8Array(32))).digest(); let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); if (x > 0n && x < N) return x; } };
const hexToBytes = (h) => { h = String(h).replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };

let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// Strip every `_`-prefixed (secret) field before a message crosses a closure boundary.
const toWire = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : (typeof v === 'bigint' ? v.toString() : v))));

const ZERO33 = '0x' + '00'.repeat(33);
const assetA = '0x' + '11'.repeat(32);
const assetB = '0x' + '22'.repeat(32);
const feeBps = 30;
const reserveAPre = 1_000_000n, reserveBPre = 1_000_000n;
const chainBinding = '0x' + 'ab'.repeat(32);
const ammDerivePoolIdV1 = (a, b, f) => pool.ammDerivePoolIdFull(a, b, f, 0, ZERO33, 0);
const circuitPoolId = ammDerivePoolIdV1(assetA, assetB, feeBps);
const ZKEY = new URL('../dapp/circuits/ceremony-genesis-amm/amm_swap_batch_0000.zkey', import.meta.url).pathname;
const WASM = new URL('../dapp/vendor/amm_swap_batch.wasm', import.meta.url).pathname;
const proveGroth16 = async ({ input }) => (await swapBatchGroth16Prove(input, WASM, ZKEY)).proofBytes;
const swapblind = makeConfidentialSwapblind({ pool, proveGroth16, ammDerivePoolIdV1 });

// ── Two real spent notes, one tree, mismatched amounts (X: 1000 A, Y: 1500 B) ──────────────────
const tree = new pool.Tree();
function makeNote(assetHex, amount, leafIndex) {
  const rSecp = randScalar();
  const xy = pool.commitXY(amount, rSecp);
  const nk = '0x' + (leafIndex + 1).toString(16).padStart(2, '0').repeat(32);
  const owner = pool.nkToOwner(nk);
  const lf = pool.leaf(assetHex, xy.cx, xy.cy, owner);
  tree.insert(lf);
  return { cx: xy.cx, cy: xy.cy, owner, rSecp, nk, leafIndex };
}
const xTip = 10n, yTip = 10n;
const xInNote = makeNote(assetA, 1000n + xTip, 0);
const yInNote = makeNote(assetB, 1500n + yTip, 1);
xInNote.path = tree.rootAndPath(0).path;
yInNote.path = tree.rootAndPath(1).path;
const spendRoot = tree.rootAndPath(0).root;

// ── X's own closure: only X ever sees xInNote.rSecp or its own output blinding ──────────────────
const traderX = (() => {
  let inputLeg = null, outputLeg = null;
  return {
    round1: () => { inputLeg = swapblind.prepareInputLeg({ chainBinding, direction: 0, amountIn: 1000n, tip: xTip, inNote: xInNote }); return toWire(inputLeg); },
    round2: (amountOut) => { outputLeg = swapblind.prepareOutputLeg({ chainBinding, assetA, assetB, inputLeg, amountOut, minOut: 0n, deadline: 0n, outOwner: '0x' + '0a'.repeat(32) }); return toWire(outputLeg); },
    // kernelA share: X is the INPUT contributor (+r_in_secp). kernelB share: X is the OUTPUT contributor (−r_out_secp).
    kernelANonce: () => { const c = kernelNonceCommit(); traderX._kA = c.k; return c.R; },
    kernelBNonce: () => { const c = kernelNonceCommit(); traderX._kB = c.k; return c.R; },
    kernelAResponse: (eA) => kernelPartialResponse({ k: traderX._kA, share: inputLeg._rInSecp, e: eA }),
    kernelBResponse: (eB) => kernelPartialResponse({ k: traderX._kB, share: -outputLeg._rOutSecp, e: eB }),
  };
})();

// ── Y's own closure: only Y ever sees yInNote.rSecp or its own output blinding ──────────────────
const traderY = (() => {
  let inputLeg = null, outputLeg = null;
  return {
    round1: () => { inputLeg = swapblind.prepareInputLeg({ chainBinding, direction: 1, amountIn: 1500n, tip: yTip, inNote: yInNote }); return toWire(inputLeg); },
    round2: (amountOut) => { outputLeg = swapblind.prepareOutputLeg({ chainBinding, assetA, assetB, inputLeg, amountOut, minOut: 0n, deadline: 0n, outOwner: '0x' + '0b'.repeat(32) }); return toWire(outputLeg); },
    // kernelB share: Y is the INPUT contributor. kernelA share: Y is the OUTPUT contributor.
    kernelBNonce: () => { const c = kernelNonceCommit(); traderY._kB = c.k; return c.R; },
    kernelANonce: () => { const c = kernelNonceCommit(); traderY._kA = c.k; return c.R; },
    kernelBResponse: (eB) => kernelPartialResponse({ k: traderY._kB, share: inputLeg._rInSecp, e: eB }),
    kernelAResponse: (eA) => kernelPartialResponse({ k: traderY._kA, share: -outputLeg._rOutSecp, e: eA }),
  };
})();

// ── The coordinator: never touches an `_`-prefixed field (toWire already stripped them) ─────────
const xLegWire1 = traderX.round1();
const yLegWire1 = traderY.round1();
assert(xLegWire1._rInSecp === undefined && yLegWire1._rInSecp === undefined, 'round-1 wire messages carry no secret blinding');
ok('round 1: each trader built its input leg with no counterparty involved');

const { amountOuts, deltas } = solveBatchClearing({
  reserveAPre, reserveBPre, feeBps,
  traders: [{ direction: xLegWire1.direction, amountIn: xLegWire1.amountIn, tip: xLegWire1.tip },
            { direction: yLegWire1.direction, amountIn: yLegWire1.amountIn, tip: yLegWire1.tip }],
});
ok('coordinator solved the clearing price from directions/amounts alone (no blinding needed)');

const xLegWire2 = traderX.round2(amountOuts[0]);
const yLegWire2 = traderY.round2(amountOuts[1]);
assert(xLegWire2._rOutSecp === undefined && yLegWire2._rOutSecp === undefined, 'round-2 wire messages carry no secret blinding');
ok('round 2: each trader built its output leg from its own told amountOut, still with no counterparty secret');

const legs = [{ input: xLegWire1, output: xLegWire2 }, { input: yLegWire1, output: yLegWire2 }];
const rTipA = randScalar(), rTipB = randScalar(); // coordinator's own — later OPENED in the envelope, never secret from the guest
const tipAAmount = xTip, tipBAmount = yTip;
const tipACSecp = pointToBytes(pedersenCommit(tipAAmount, rTipA));
const tipBCSecp = pointToBytes(pedersenCommit(tipBAmount, rTipB));

const X_A = kernelAggregatePointFromLegs({ legs, assetXIsA: true, deltaSign: deltas.deltaANetSign, deltaMag: deltas.deltaANetMag, tipCSecp: tipACSecp });
const X_B = kernelAggregatePointFromLegs({ legs, assetXIsA: false, deltaSign: deltas.deltaBNetSign, deltaMag: deltas.deltaBNetMag, tipCSecp: tipBCSecp });

// Kernel A: X is the input contributor, Y is the output contributor, coordinator holds the tip share.
const RXA = traderX.kernelANonce(), RYA = traderY.kernelANonce();
const tCA = kernelNonceCommit();
const { R: RA, e: eA } = kernelChallenge({ chainBinding, poolId: circuitPoolId, assetXIsA: true, X: X_A, partialRs: [RXA, RYA, tCA.R] });
const zXA = traderX.kernelAResponse(eA), zYA = traderY.kernelAResponse(eA);
const zTA = kernelPartialResponse({ k: tCA.k, share: -rTipA, e: eA });
const kernelA = combineKernelResponses({ R: RA, partialZs: [zXA, zYA, zTA] });

// Kernel B: Y is the input contributor, X is the output contributor, coordinator holds the tip share.
const RYB = traderY.kernelBNonce(), RXB = traderX.kernelBNonce();
const tCB = kernelNonceCommit();
const { R: RB, e: eB } = kernelChallenge({ chainBinding, poolId: circuitPoolId, assetXIsA: false, X: X_B, partialRs: [RYB, RXB, tCB.R] });
const zYB = traderY.kernelBResponse(eB), zXB = traderX.kernelBResponse(eB);
const zTB = kernelPartialResponse({ k: tCB.k, share: -rTipB, e: eB });
const kernelB = combineKernelResponses({ R: RB, partialZs: [zYB, zXB, zTB] });
ok('kernel co-sign: 2 rounds per kernel, each co-signer using only its own secret share');

const { envelope, fixtureIntents, evmPoolId, reserveAPost, reserveBPost } = await swapblind.assembleSwapBlindFromLegs({
  chainBinding, assetA, assetB, feeBps, reserveAPre, reserveBPre, spendRoot, legs, kernelA, kernelB, rTipA, rTipB,
});
ok('coordinator assembled the envelope from public legs + the combined kernels (never a trader secret)');

// ── Verify exactly what the guest checks, same as the single-shot builder's own test ────────────
for (let i = 0; i < 2; i++) {
  const it = fixtureIntents[i];
  const inSig = hexToBytes(it.inXcurveSigma), outSig = hexToBytes(it.outXcurveSigma);
  assert(verifyXCurve(inSig, envelope.intents[i].cInSecp, envelope.intents[i].cInBjj), `leg ${i} input xcurve sigma verifies`);
  assert(verifyXCurve(outSig, envelope.receipts[i].cOutSecp, envelope.receipts[i].cOutBjj), `leg ${i} output xcurve sigma verifies`);
  const ctx = pool.intentContext(
    'tacit-swap-blind-intent-v1', chainBinding, assetA, assetB,
    [[it.inCx, it.inCy, it.inOwner], [it.outCx, it.outCy, it.outOwner]],
    [BigInt(it.direction), BigInt(it.minOut), BigInt(it.deadline), BigInt(it.tip)],
  );
  assert(pool.verifyOpeningPokBlind(it.inCx, it.inCy, it.pokR, it.pokZv, it.pokZr, ctx), `leg ${i} blind opening PoK verifies`);
}
ok('both legs\' cross-curve sigmas and blind opening PoKs verify');

const kPoolId = ammDerivePoolIdV1(assetA, assetB, feeBps);
const kIntents = envelope.intents.map((i) => ({ direction: i.direction, cInSecp: '0x' + Buffer.from(i.cInSecp).toString('hex') }));
const kReceipts = envelope.receipts.map((r) => ({ cOutSecp: '0x' + Buffer.from(r.cOutSecp).toString('hex') }));
const kArgs = (assetXIsA) => ({
  intents: kIntents, receipts: kReceipts, assetXIsA,
  deltaSign: assetXIsA ? envelope.deltaANetSign : envelope.deltaBNetSign,
  deltaMag: assetXIsA ? envelope.deltaANetMag : envelope.deltaBNetMag,
  tipCSecp: assetXIsA ? envelope.tipACSecp : envelope.tipBCSecp,
  chainBinding, poolId: kPoolId, kernel: assetXIsA ? envelope.kernelA : envelope.kernelB,
});
assert(verifyAggregateKernel(kArgs(true)), 'asset-A conservation kernel verifies (co-signed by X, Y and the coordinator)');
assert(verifyAggregateKernel(kArgs(false)), 'asset-B conservation kernel verifies (co-signed by Y, X and the coordinator)');
ok('both per-asset conservation kernels verify — neither trader ever revealed a note-spending secret');

assert(typeof envelope.proof === 'string' && hexToBytes(envelope.proof).length === 256, 'inner Groth16 proof is 256 bytes');
assert(typeof evmPoolId === 'string' && evmPoolId.startsWith('0x'), 'coordinator derived the EVM pool id');
assert(typeof reserveAPost === 'bigint' && typeof reserveBPost === 'bigint', 'coordinator computed post-reserves');
assert.strictEqual(reserveAPost, reserveAPre + 1000n - amountOuts[1], 'reserveA post matches X in minus Y out');
assert.strictEqual(reserveBPost, reserveBPre + 1500n - amountOuts[0], 'reserveB post matches Y in minus X out');
ok('coordinator produced a 256-byte inner Groth16 proof and correct post-reserves');

console.log(`\nconfidential-swapblind-2party: ${n} checks passed`);
