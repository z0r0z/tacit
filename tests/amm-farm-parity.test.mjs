// Cross-impl byte-parity sanity check: verifies the reference encoder
// produces payloads of the exact byte counts the worker + dapp decoders
// expect. Catches drift between the three implementations of the wire
// format (tests/amm-farm.mjs, worker/src/index.js decodeTFarmInitPayload
// et al., dapp/amm-envelope.js decodeFarmInit et al.).

import * as secp from '@noble/secp256k1';
import {
  encodeFarmInit, decodeFarmInit,
  encodeLpBond, decodeLpBond,
  encodeLpUnbond, decodeLpUnbond,
  deriveFarmId,
} from './amm-farm.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const r = fn();
    if (r === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${r}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

const launcherPub = secp.getPublicKey(new Uint8Array(32).fill(0x11), true);
const bonderPub   = secp.getPublicKey(new Uint8Array(32).fill(0x22), true);

const sampleFI = {
  poolId: new Uint8Array(32).fill(0x01),
  farmNonce: new Uint8Array(32).fill(0x02),
  launcherPubkey: launcherPub,
  rewardAssetId: new Uint8Array(32).fill(0x03),
  rewardTotal: 1_000_000_000n,
  rewardPerBlock: 10_000n,
  startHeight: 200,
  endHeight: 200 + Number(1_000_000_000n / 10_000n),
  cChangeOrSentinel: new Uint8Array(33),
  rangeProof: new Uint8Array([0xa1, 0xa2, 0xa3]),
  kernelSig: new Uint8Array(64).fill(0xaa),
  launcherSig: new Uint8Array(64).fill(0xbb),
};

test('T_FARM_INIT: 315 B fixed + 2 B rpLen + rangeProof', () => {
  const p = encodeFarmInit(sampleFI);
  return p.length === 315 + 2 + sampleFI.rangeProof.length || `got ${p.length}`;
});
test('T_FARM_INIT: ref decoder roundtrips', () => {
  const p = encodeFarmInit(sampleFI);
  const d = decodeFarmInit(p);
  return d !== null;
});

const farmId = deriveFarmId({
  poolId: sampleFI.poolId, launcherPubkey: launcherPub,
  rewardAssetId: sampleFI.rewardAssetId, farmNonce: sampleFI.farmNonce,
});

const sampleLB = {
  farmId,
  bonderPubkey: bonderPub,
  bondAmount: 50_000n,
  entryAccPerShare: (1n << 80n) + 12345n,
  bondViewHeight: 250,
  cChangeOrSentinel: new Uint8Array(33),
  rangeProof: new Uint8Array([0xb1, 0xb2, 0xb3, 0xb4]),
  kernelSig: new Uint8Array(64).fill(0xcc),
  bonderSig: new Uint8Array(64).fill(0xdd),
};

test('T_LP_BOND: 255 B fixed + 2 B rpLen + rangeProof', () => {
  const p = encodeLpBond(sampleLB);
  return p.length === 255 + 2 + sampleLB.rangeProof.length || `got ${p.length}`;
});
test('T_LP_BOND: u128 entry_acc roundtrip', () => {
  const p = encodeLpBond(sampleLB);
  const d = decodeLpBond(p);
  return d !== null && d.entryAccPerShare === sampleLB.entryAccPerShare;
});

const sampleLU = {
  farmId,
  bondId: new Uint8Array(36).fill(0xab),
  unbonderPubkey: bonderPub,
  exitAccPerShare: sampleLB.entryAccPerShare + (1n << 50n),
  exitViewHeight: 500,
  rewardAmount: 12_345_678n,
  lpReturnR: new Uint8Array(32).fill(0x11),
  rewardR: new Uint8Array(32).fill(0x22),
  unbonderSig: new Uint8Array(64).fill(0xee),
};

test('T_LP_UNBOND: exactly 258 B', () => {
  const p = encodeLpUnbond(sampleLU);
  return p.length === 258 || `got ${p.length}`;
});
test('T_LP_UNBOND: ref decoder roundtrips', () => {
  const p = encodeLpUnbond(sampleLU);
  const d = decodeLpUnbond(p);
  return d !== null && d.rewardAmount === sampleLU.rewardAmount;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
