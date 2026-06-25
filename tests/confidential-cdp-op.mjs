// OP_CDP_MINT op-assembler validation (dapp/confidential-cdp.js buildCdpMintOp). Builds the open-CDP witness as
// the box harness (exec-cdpmint.rs) feeds the guest, and checks it is internally consistent: the basket is
// canonicalized strictly asset-sorted, each collateral leg's opening sigma verifies against the reconstructed
// collateral context, and the debt note opens to debtValue − fee against the debt context. Box parity (the exact
// witness order) is the harness run; this catches assembler bugs before the re-prove. Run: node tests/confidential-cdp-op.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const cdp = makeConfidentialCdp({ keccak256, pool });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const chainBinding = '0x' + '11'.repeat(32);
const controller = '0x' + 'c1'.repeat(20);
const controllerWord = '0x' + '00'.repeat(12) + controller.slice(2);
const owner = '0x' + '07'.repeat(32);
const nonce = '0x' + '81'.repeat(32);
const rateSnapshot = '0x' + '00'.repeat(32);
const assetA = '0x' + 'aa'.repeat(32), assetB = '0x' + 'bb'.repeat(32);
const note = (asset, value, leafIndex) => { const blinding = randomScalar(); return { asset, ...pool.commitXY(value, blinding), value, blinding, leafIndex, path: pool.zeros }; };

// ── a normal CDP open: 2 collateral legs (passed UNSORTED) + a debt note net of a relay fee ──
{
  const debtValue = 1000n, fee = 30n, net = debtValue - fee;
  const legB = note(assetB, 800n, 1), legA = note(assetA, 600n, 0);
  const debtBlinding = randomScalar();
  const op = cdp.buildCdpMintOp({ chainBinding, controller, owner, debtValue, nonce, rateSnapshot, fee, collateral: [legB, legA], spendRoot: '0x' + '22'.repeat(32), debtBlinding });

  assert.equal(op.legs.length, 2, 'two legs');
  assert.ok(BigInt(op.legs[0].asset) < BigInt(op.legs[1].asset), 'basket canonicalized strictly asset-sorted (A before B)');
  for (const leg of op.legs) {
    const ctx = pool.intentContext('tacit-cdp-mint-collateral-v1', chainBinding, leg.asset, nonce,
      [[leg.cx, leg.cy, owner], [controllerWord, nonce, owner]], [BigInt(leg.value), debtValue, BigInt(leg.index)]);
    assert.equal(pool.verifyOpeningSigma(leg.cx, leg.cy, BigInt(leg.value), leg.sigR, leg.sigZ, ctx), true, `collateral leg ${leg.asset.slice(0, 6)} opening verifies`);
  }
  const debtAsset = cdp.debtAssetId(controller);
  const debtCtx = pool.intentContext('tacit-cdp-mint-debt-v1', chainBinding, debtAsset, nonce,
    [[op.debt.cx, op.debt.cy, owner], [controllerWord, nonce, owner]], [debtValue, fee]);
  assert.equal(pool.verifyOpeningSigma(op.debt.cx, op.debt.cy, net, op.debt.sigR, op.debt.sigZ, debtCtx), true, 'debt note opens to debtValue − fee');
  assert.equal(pool.verifyOpeningSigma(op.debt.cx, op.debt.cy, debtValue, op.debt.sigR, op.debt.sigZ, debtCtx), false, 'debt note does NOT open to the gross debt');
  assert.equal(op.fee, Number(fee), 'fee leg = the carved fee');
  ok('buildCdpMintOp: sorted basket, collateral + debt openings verify, debt opens to net');
}

// ── a BOND (debtValue = 0): basket locked, no debt note ──
{
  const op = cdp.buildCdpMintOp({ chainBinding, controller, owner, debtValue: 0n, nonce, rateSnapshot, fee: 0n, collateral: [note(assetA, 500n, 3)], spendRoot: '0x' + '22'.repeat(32) });
  assert.equal(op.debt, undefined, 'a bond mints no debt note');
  assert.equal(op.legs.length, 1, 'bond locks the basket');
  const leg = op.legs[0];
  const ctx = pool.intentContext('tacit-cdp-mint-collateral-v1', chainBinding, leg.asset, nonce,
    [[leg.cx, leg.cy, owner], [controllerWord, nonce, owner]], [BigInt(leg.value), 0n, BigInt(leg.index)]);
  assert.equal(pool.verifyOpeningSigma(leg.cx, leg.cy, BigInt(leg.value), leg.sigR, leg.sigZ, ctx), true, 'bond collateral opening verifies (debtValue = 0 bound)');
  ok('buildCdpMintOp: bond (debtValue = 0) locks the basket with no debt note');
}

// ── a CDP close: release the basket (first leg net of fee) + burn the debt note ──
{
  const debtValue = 1000n, fee = 30n;
  const basket = [{ asset: assetB, value: 800n }, { asset: assetA, value: 600n }]; // passed unsorted
  const releaseBlindings = [randomScalar(), randomScalar()];
  const debtBlinding = randomScalar();
  const debtNote = { ...pool.commitXY(debtValue, debtBlinding), value: debtValue, blinding: debtBlinding, owner, leafIndex: 7, path: pool.zeros };
  const op = cdp.buildCdpCloseOp({ chainBinding, controller, owner, debtValue, nonce, rateSnapshot, basket, positionIndex: 2, positionPath: pool.zeros, spendRoot: '0x' + '22'.repeat(32), cdpPositionRoot: '0x' + '44'.repeat(32), fee, releaseBlindings, debtNotes: [debtNote] });

  const debtAsset = cdp.debtAssetId(controller);
  const sorted = [...basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : 1));
  const basketRootHex = cdp.basketRoot(sorted.map((leg) => cdp.basketLeg(leg.asset, leg.value)));
  const position = cdp.positionLeaf(controller, debtAsset, basketRootHex, debtValue, rateSnapshot, owner, nonce);

  assert.ok(BigInt(op.legs[0].asset) < BigInt(op.legs[1].asset), 'released legs canonical asset-sorted');
  op.legs.forEach((leg, i) => {
    const legFee = i === 0 ? fee : 0n;
    const net = BigInt(leg.value) - legFee;
    const ctx = pool.intentContext('tacit-cdp-close-release-v1', chainBinding, leg.asset, position, [[leg.cx, leg.cy, owner]], [BigInt(leg.value), legFee]);
    assert.equal(pool.verifyOpeningSigma(leg.cx, leg.cy, net, leg.sigR, leg.sigZ, ctx), true, `released leg ${i} opens to value − fee (${net})`);
  });
  const d = op.debts[0];
  const debtCtx = pool.intentContext('tacit-cdp-close-debt-v1', chainBinding, debtAsset, position, [[d.cx, d.cy, d.owner]], [BigInt(d.value), debtValue, BigInt(d.index)]);
  assert.equal(pool.verifyOpeningSigma(d.cx, d.cy, BigInt(d.value), d.sigR, d.sigZ, debtCtx), true, 'burned debt note opening verifies');
  assert.equal(op.fee, Number(fee), 'fee carried on the close');
  ok('buildCdpCloseOp: sorted basket release (first leg net of fee), debt burn opening verifies');
}

// ── cBTC mint: an owner-free bearer note opening to exactly v_btc (the 1:1 peg), fee-less ──
{
  const outpoint = '0x' + '5a'.repeat(32), vBtc = 100000n, blinding = randomScalar();
  const op = cdp.buildCbtcMintOp({ chainBinding, outpoint, vBtc, blinding });
  const ZERO = '0x' + '00'.repeat(32);
  const ctx = pool.intentContext('tacit-cbtc-mint-intent-v1', chainBinding, pool.CBTC_ZK_ASSET_ID, outpoint, [[op.cx, op.cy, ZERO]], [vBtc]);
  assert.equal(pool.verifyOpeningSigma(op.cx, op.cy, vBtc, op.sigR, op.sigZ, ctx), true, 'cBTC note opens to exactly v_btc');
  assert.equal(pool.verifyOpeningSigma(op.cx, op.cy, vBtc + 1n, op.sigR, op.sigZ, ctx), false, 'cBTC note does NOT open to v_btc + 1 (peg)');
  ok('buildCbtcMintOp: owner-free bearer note opens to exactly v_btc');
}

// ── CDP top-up: add collateral to a live position; the added-leg openings bind the OLD position + newNonce ──
{
  const debtValue = 1000n, oldNonce = '0x' + '81'.repeat(32), newNonce = '0x' + '82'.repeat(32);
  const oldBasket = [{ asset: assetA, value: 600n }];
  const added = note(assetB, 400n, 4);
  const op = cdp.buildCdpTopupOp({ chainBinding, controller, owner, debtValue, oldNonce, newNonce, rateSnapshot, oldBasket, addedCollateral: [added], positionIndex: 2, positionPath: pool.zeros, spendRoot: '0x' + '22'.repeat(32), cdpPositionRoot: '0x' + '44'.repeat(32) });

  const debtAsset = cdp.debtAssetId(controller);
  const oldBasketRoot = cdp.basketRoot([cdp.basketLeg(assetA, 600n)]);
  const oldPosition = cdp.positionLeaf(controller, debtAsset, oldBasketRoot, debtValue, rateSnapshot, owner, oldNonce);
  const controllerWord = '0x' + '00'.repeat(12) + controller.slice(2);
  const leg = op.addedLegs[0];
  const ctx = pool.intentContext('tacit-cdp-topup-collateral-v1', chainBinding, leg.asset, oldPosition,
    [[leg.cx, leg.cy, owner], [controllerWord, newNonce, owner]], [BigInt(leg.value), debtValue, BigInt(leg.index)]);
  assert.equal(pool.verifyOpeningSigma(leg.cx, leg.cy, BigInt(leg.value), leg.sigR, leg.sigZ, ctx), true, 'added collateral opening binds the old position + newNonce');
  assert.equal(op.oldLegs.length, 1, 'old basket carried for membership');
  ok('buildCdpTopupOp: added collateral opening verifies against the old-position context');
}

console.log(`confidential-cdp-op: all ${n} checks passed`);
