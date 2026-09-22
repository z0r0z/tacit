// Build an OP_SWAP_BLIND fixture via the 2-party leg-split protocol (prepareInputLeg/
// prepareOutputLeg/assembleSwapBlindFromLegs in dapp/confidential-swapblind.js), with the SAME
// interactive round structure tests/confidential-swapblind-2party.mjs exercises, but using the real
// finalized ceremony zkey so the result is guest-acceptable — for exec-swapblind.rs (harnesses/) to
// confirm on the pinned mainnet guest.
//
//   ZKEY=<finalized amm_swap_batch zkey> OUT=swapblind_2party.json node tests/gen-swapblind-2party-fixture.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import {
  makeConfidentialSwapblind, solveBatchClearing, kernelAggregatePointFromLegs,
  kernelNonceCommit, kernelChallenge, kernelPartialResponse, combineKernelResponses,
} from '../dapp/confidential-swapblind.js';
import { swapBatchGroth16Prove } from '../dapp/confidential-swapbatch.js';
import { pedersenCommit, pointToBytes } from '../dapp/bulletproofs.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const N = secp.CURVE.n;
const randScalar = () => { for (;;) { const b = createHash('sha256').update(crypto.getRandomValues(new Uint8Array(32))).digest(); let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); if (x > 0n && x < N) return x; } };

const zkey = process.env.ZKEY;
if (!zkey) { console.error('set ZKEY to the finalized amm_swap_batch zkey path'); process.exit(2); }
const out = process.env.OUT || 'swapblind_2party.json';

const WASM = new URL('../dapp/vendor/amm_swap_batch.wasm', import.meta.url).pathname;
const ZERO33 = '0x' + '00'.repeat(33);
const assetA = '0x' + '11'.repeat(32);
const assetB = '0x' + '22'.repeat(32);
const feeBps = 30;
const reserveAPre = 1_000_000_000n, reserveBPre = 1_000_000_000n;
const chainBinding = '0x' + 'ab'.repeat(32);
const ammDerivePoolIdV1 = (a, b, f) => pool.ammDerivePoolIdFull(a, b, f, 0, ZERO33, 0);
const circuitPoolId = ammDerivePoolIdV1(assetA, assetB, feeBps);
const proveGroth16 = async ({ input }) => (await swapBatchGroth16Prove(input, WASM, zkey)).proofBytes;
const swapblind = makeConfidentialSwapblind({ pool, proveGroth16, ammDerivePoolIdV1 });

const tree = new pool.Tree();
function makeNote(assetHex, amount, leafIndex) {
  const rSecp = randScalar();
  const xy = pool.commitXY(amount, rSecp);
  const nk = '0x' + (leafIndex + 1).toString(16).padStart(2, '0').repeat(32);
  const owner = pool.nkToOwner(nk);
  tree.insert(pool.leaf(assetHex, xy.cx, xy.cy, owner));
  return { cx: xy.cx, cy: xy.cy, owner, rSecp, nk, leafIndex };
}
const xTip = 10n, yTip = 10n;
const xInNote = makeNote(assetA, 1000n + xTip, 0);
const yInNote = makeNote(assetB, 1037n + yTip, 1);
xInNote.path = tree.rootAndPath(0).path;
yInNote.path = tree.rootAndPath(1).path;
const spendRoot = tree.rootAndPath(0).root;

const toWire = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : (typeof v === 'bigint' ? v.toString() : v))));

const traderX = (() => {
  let inputLeg = null, outputLeg = null;
  return {
    round1: () => { inputLeg = swapblind.prepareInputLeg({ chainBinding, direction: 0, amountIn: 1000n, tip: xTip, inNote: xInNote }); return toWire(inputLeg); },
    round2: (amountOut) => { outputLeg = swapblind.prepareOutputLeg({ chainBinding, assetA, assetB, inputLeg, amountOut, minOut: 0n, deadline: 0n, outOwner: '0x' + '0a'.repeat(32) }); return toWire(outputLeg); },
    kernelANonce: () => { const c = kernelNonceCommit(); traderX._kA = c.k; return c.R; },
    kernelBNonce: () => { const c = kernelNonceCommit(); traderX._kB = c.k; return c.R; },
    kernelAResponse: (eA) => kernelPartialResponse({ k: traderX._kA, share: inputLeg._rInSecp, e: eA }),
    kernelBResponse: (eB) => kernelPartialResponse({ k: traderX._kB, share: -outputLeg._rOutSecp, e: eB }),
  };
})();
const traderY = (() => {
  let inputLeg = null, outputLeg = null;
  return {
    round1: () => { inputLeg = swapblind.prepareInputLeg({ chainBinding, direction: 1, amountIn: 1037n, tip: yTip, inNote: yInNote }); return toWire(inputLeg); },
    round2: (amountOut) => { outputLeg = swapblind.prepareOutputLeg({ chainBinding, assetA, assetB, inputLeg, amountOut, minOut: 0n, deadline: 0n, outOwner: '0x' + '0b'.repeat(32) }); return toWire(outputLeg); },
    kernelBNonce: () => { const c = kernelNonceCommit(); traderY._kB = c.k; return c.R; },
    kernelANonce: () => { const c = kernelNonceCommit(); traderY._kA = c.k; return c.R; },
    kernelBResponse: (eB) => kernelPartialResponse({ k: traderY._kB, share: inputLeg._rInSecp, e: eB }),
    kernelAResponse: (eA) => kernelPartialResponse({ k: traderY._kA, share: -outputLeg._rOutSecp, e: eA }),
  };
})();

const xLegWire1 = traderX.round1();
const yLegWire1 = traderY.round1();
const { amountOuts, deltas } = solveBatchClearing({
  reserveAPre, reserveBPre, feeBps,
  traders: [{ direction: xLegWire1.direction, amountIn: xLegWire1.amountIn, tip: xLegWire1.tip },
            { direction: yLegWire1.direction, amountIn: yLegWire1.amountIn, tip: yLegWire1.tip }],
});
const xLegWire2 = traderX.round2(amountOuts[0]);
const yLegWire2 = traderY.round2(amountOuts[1]);
const legs = [{ input: xLegWire1, output: xLegWire2 }, { input: yLegWire1, output: yLegWire2 }];

const rTipA = randScalar(), rTipB = randScalar();
const tipACSecp = pointToBytes(pedersenCommit(xTip, rTipA));
const tipBCSecp = pointToBytes(pedersenCommit(yTip, rTipB));
const X_A = kernelAggregatePointFromLegs({ legs, assetXIsA: true, deltaSign: deltas.deltaANetSign, deltaMag: deltas.deltaANetMag, tipCSecp: tipACSecp });
const X_B = kernelAggregatePointFromLegs({ legs, assetXIsA: false, deltaSign: deltas.deltaBNetSign, deltaMag: deltas.deltaBNetMag, tipCSecp: tipBCSecp });

const RXA = traderX.kernelANonce(), RYA = traderY.kernelANonce();
const tCA = kernelNonceCommit();
const { R: RA, e: eA } = kernelChallenge({ chainBinding, poolId: circuitPoolId, assetXIsA: true, X: X_A, partialRs: [RXA, RYA, tCA.R] });
const zXA = traderX.kernelAResponse(eA), zYA = traderY.kernelAResponse(eA);
const zTA = kernelPartialResponse({ k: tCA.k, share: -rTipA, e: eA });
const kernelA = combineKernelResponses({ R: RA, partialZs: [zXA, zYA, zTA] });

const RYB = traderY.kernelBNonce(), RXB = traderX.kernelBNonce();
const tCB = kernelNonceCommit();
const { R: RB, e: eB } = kernelChallenge({ chainBinding, poolId: circuitPoolId, assetXIsA: false, X: X_B, partialRs: [RYB, RXB, tCB.R] });
const zYB = traderY.kernelBResponse(eB), zXB = traderX.kernelBResponse(eB);
const zTB = kernelPartialResponse({ k: tCB.k, share: -rTipB, e: eB });
const kernelB = combineKernelResponses({ R: RB, partialZs: [zYB, zXB, zTB] });

const t0 = Date.now();
const { fixture } = await swapblind.assembleSwapBlindFromLegs({
  chainBinding, assetA, assetB, feeBps, reserveAPre, reserveBPre, spendRoot, legs, kernelA, kernelB, rTipA, rTipB,
});
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`wrote ${out}: 2-party split path, Groth16 proved in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
