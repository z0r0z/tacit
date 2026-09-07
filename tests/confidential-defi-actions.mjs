// Validates the confidential CDP/cBTC ACTION LAYER (dapp/confidential-defi-actions.js) against the REAL
// recovery guard (dapp/confidential-recovery-guard.js) via a mock relay — so every minted leaf gets exactly
// one recovery descriptor that passes the submit-time tripwire (no unrecoverable note). This is the
// lost-funds-critical contract; the on-chain settle + signet are the box's job. Run: node tests/confidential-defi-actions.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { makeConfidentialFarm } from '../dapp/confidential-farm.js';
import { makeConfidentialIndexer } from '../dapp/confidential-indexer.js';
import { makeRecoveryGuard } from '../dapp/confidential-recovery-guard.js';
import { makeConfidentialDefiActions } from '../dapp/confidential-defi-actions.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const cdp = makeConfidentialCdp({ keccak256, pool, signSchnorr });
const farm = makeConfidentialFarm({ keccak256, pool });
const indexer = makeConfidentialIndexer({ secp, keccak256, sha256 });
const memo = indexer._memo;
const guard = makeRecoveryGuard({ memo });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// Mock relay: run the REAL guard's seal + submit-time tripwire (throws on an unrecoverable leaf), capture shape.
const submits = [];
const relay = {
  settle: async ({ type, op, leaves = [], outputs = [], ephRand }) => {
    const memos = guard.sealMemosForOutputs({ outputs, ephRand });
    guard.assertOutputsRecoverable({ leaves, outputs, memos }); // ← the lost-funds tripwire
    submits.push({ type, leaves: leaves.length, outputs: outputs.length, memos: memos.length });
    return { jobId: 'mock', status: 'settled' };
  },
};

const priv = (BigInt(randomScalar()) % secp.CURVE.n) || 1n;
const pubHex = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(priv).toRawBytes(true)).toString('hex');
const id = { owner: '0x' + '07'.repeat(32), pubHex, secret: randomScalar() };
const chainBindingHex = () => '0x' + '11'.repeat(32);
const actions = makeConfidentialDefiActions({ pool, cdp, farm, relay, id, chainBindingHex, secp });

const controller = '0x' + 'c1'.repeat(20), nonce = '0x' + '81'.repeat(32), rateSnapshot = '0x' + '00'.repeat(32);
const assetA = '0x' + 'aa'.repeat(32), assetB = '0x' + 'bb'.repeat(32);
const coll = (asset, value, leafIndex) => { const blinding = randomScalar(); return { asset, ...pool.commitXY(value, blinding), value, blinding, leafIndex, path: pool.zeros }; };

const freshPositionKey = () => {
  const priv = (BigInt(randomScalar()) % secp.CURVE.n) || 1n;
  const owner = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(priv).toRawBytes(true).slice(1)).toString('hex');
  return { priv: '0x' + priv.toString(16).padStart(64, '0'), owner };
};
const freshPositionOwner = () => freshPositionKey().owner;

// openCdp — one debt note leaf ⇒ one memo-sealed descriptor (recoverable)
{
  await actions.openCdp({ controller, debtValue: 1000n, nonce, rateSnapshot, fee: 30n, collateral: [coll(assetA, 600n, 0)], spendRoot: '0x' + '22'.repeat(32), debtBlinding: randomScalar(), positionOwner: freshPositionOwner(), debtNk: randomScalar() });
  const s = submits.at(-1);
  assert.equal(s.type, 'cdpmint'); assert.equal(s.leaves, 1); assert.equal(s.outputs, 1);
  ok('openCdp: debt note leaf has a recoverable memo descriptor (tripwire passes)');
}
// openCdp — debtNk required whenever debtValue > 0 (else the leaf the assembler computes locally would
// diverge from the guest's actual debt_owner-keyed leaf — the exact bug this test guards against)
{
  let threw = false;
  try {
    await actions.openCdp({ controller, debtValue: 1000n, nonce, rateSnapshot, fee: 30n, collateral: [coll(assetA, 600n, 0)], spendRoot: '0x' + '22'.repeat(32), debtBlinding: randomScalar(), positionOwner: freshPositionOwner() });
  } catch { threw = true; }
  assert.ok(threw, 'openCdp must reject a real (debtValue > 0) mint with no debtNk');
  ok('openCdp: missing debtNk on a real mint is rejected, not silently mis-keyed');
}
// openCdp bond (debtValue=0) — no minted note ⇒ no descriptor, no debtNk needed
{
  await actions.openCdp({ controller, debtValue: 0n, nonce, rateSnapshot, collateral: [coll(assetA, 500n, 1)], spendRoot: '0x' + '22'.repeat(32), positionOwner: freshPositionOwner() });
  const s = submits.at(-1);
  assert.equal(s.leaves, 0); assert.equal(s.outputs, 0);
  ok('openCdp bond: no minted note ⇒ empty leaves/outputs (no strand)');
}
// closeCdp — one descriptor per released leg
{
  const posKey = freshPositionKey();
  await actions.closeCdp({ controller, debtValue: 1000n, nonce, rateSnapshot, basket: [{ asset: assetB, value: 800n }, { asset: assetA, value: 600n }], positionIndex: 2, positionPath: pool.zeros, spendRoot: '0x' + '22'.repeat(32), cdpPositionRoot: '0x' + '44'.repeat(32), fee: 30n, releaseBlindings: [randomScalar(), randomScalar()], releaseNks: [randomScalar(), randomScalar()], debtNotes: [{ ...pool.commitXY(1000n, randomScalar()), value: 1000n, blinding: randomScalar(), owner: id.owner, leafIndex: 7, path: pool.zeros }], positionOwner: posKey.owner, positionOwnerPriv: posKey.priv });
  const s = submits.at(-1);
  assert.equal(s.type, 'cdpclose'); assert.equal(s.leaves, 2); assert.equal(s.outputs, 2);
  ok('closeCdp: each released leg has a recoverable descriptor; burned debt notes carry none');
}
// mintCbtc — bearer note ⇒ SEED-DERIVED descriptor (empty memo, still passes the tripwire)
{
  await actions.mintCbtc({ outpoint: '0x' + '5a'.repeat(32), vBtc: 100000n, blinding: randomScalar() });
  const s = submits.at(-1);
  assert.equal(s.type, 'cbtcmint'); assert.equal(s.leaves, 1); assert.equal(s.outputs, 1);
  ok('mintCbtc: bearer cBTC note is seed-derived (recovery scan re-derives the blinding) — tripwire passes');
}
// topupCdp — appends a position, no minted note
{
  const topupKey = freshPositionKey();
  await actions.topupCdp({ controller, debtValue: 1000n, oldNonce: nonce, newNonce: '0x' + '82'.repeat(32), rateSnapshot, oldBasket: [{ asset: assetA, value: 600n }], addedCollateral: [coll(assetB, 400n, 4)], positionIndex: 2, positionPath: pool.zeros, spendRoot: '0x' + '22'.repeat(32), cdpPositionRoot: '0x' + '44'.repeat(32), positionOwner: topupKey.owner, positionOwnerPriv: topupKey.priv });
  const s = submits.at(-1);
  assert.equal(s.type, 'cdptopup'); assert.equal(s.leaves, 0); assert.equal(s.outputs, 0);
  ok('topupCdp: no minted note ⇒ empty leaves/outputs');
}

// bondFarm — receipt note is owner-blinded ⇒ seed-derived (recovered by the receipt scan), legs spent
{
  const lpAsset = '0x' + 'dd'.repeat(32);
  const lb = randomScalar();
  const legs = [{ asset: lpAsset, ...pool.commitXY(100n, lb), value: 100n, blinding: lb, index: 0, path: pool.zeros }];
  const bondKey = freshPositionKey();
  await actions.bondFarm({ controller, nonce, lpAsset, legs, spendRoot: '0x' + '22'.repeat(32), receiptOwner: bondKey.owner });
  const s = submits.at(-1);
  assert.equal(s.type, 'farmbond'); assert.equal(s.leaves, 1); assert.equal(s.outputs, 1);
  ok('bondFarm: receipt seed-derived (recovered by the receipt scan); bonded legs spent');
}
// harvestFarm — receipt is STABLE (neither consumed nor re-minted), so the guest emits ONE leaf: the reward note
{
  const rewardAsset = '0x' + 'ee'.repeat(32), reward = 50n, fee = 5n, rb = randomScalar();
  const rewardNote = { ...pool.commitXY(reward - fee, rb), blinding: rb };
  const harvKey = freshPositionKey();
  await actions.harvestFarm({ controller, shares: 100n, nonce, harvestNonce: '0x' + '82'.repeat(32), reward, oldIndex: 1, oldPath: pool.zeros, lpAsset: '0x' + 'dd'.repeat(32), rewardAsset, rewardNote, rewardNk: randomScalar(), fee, spendRoot: '0x' + '22'.repeat(32), receiptOwner: harvKey.owner, receiptOwnerPriv: harvKey.priv });
  const s = submits.at(-1);
  assert.equal(s.type, 'farmharvest'); assert.equal(s.leaves, 1); assert.equal(s.outputs, 1);
  ok('harvestFarm: reward note memo-sealed; the stable receipt mints no leaf');
}
// unbondFarm — released LP-share note is owned ⇒ memo-sealed
{
  const lpAsset = '0x' + 'dd'.repeat(32), rb = randomScalar();
  const releaseNote = { ...pool.commitXY(100n, rb), blinding: rb };
  const unbondKey = freshPositionKey();
  await actions.unbondFarm({ controller, shares: 100n, nonce, lpAsset, oldIndex: 1, oldPath: pool.zeros, releaseNote, lpNk: randomScalar(), fee: 0n, spendRoot: '0x' + '22'.repeat(32), receiptOwner: unbondKey.owner, receiptOwnerPriv: unbondKey.priv });
  const s = submits.at(-1);
  assert.equal(s.type, 'farmunbond'); assert.equal(s.leaves, 1); assert.equal(s.outputs, 1);
  ok('unbondFarm / withdrawSavings: released LP-share note memo-sealed');
}

console.log(`confidential-defi-actions: all ${n} checks passed`);
