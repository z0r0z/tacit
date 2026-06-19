// Build execute-mode fixtures for the cBTC-mint + CDP settle ops, so reflect-exec can run the settle guest
// (RISC-V emulator, no GPU/proof) and validate the witness serialization + guest-acceptance end-to-end —
// the same coverage swap/lp/otc/route/bid already have. Uses the dapp's confidential-pool + confidential-cdp
// helpers (the real crypto), so a clean execute proves the dispatch arm AND its byte serialization.
// Run: node scripts/build-cdp-cbtc-exec-fixtures.mjs
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const cdp = makeConfidentialCdp({ keccak256: keccak_256, pool });

const CBTC = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
const chainBinding = '0x' + '11'.repeat(32);
const ZERO = '0x' + '00'.repeat(32);
const dir = new URL('../contracts/sp1/confidential/fixtures/', import.meta.url);

// Keccak incremental-Merkle helpers (match the on-chain tree + cxfer-core).
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const kc = (...parts) => hx(keccak_256(_cat(parts.map(b32))));
const zeros = [ZERO];
for (let i = 0; i < 32; i++) zeros.push(kc(zeros[i], zeros[i]));
// Single-leaf (index 0) root + zero-sibling path — the membership a 1-element tree proves.
const singleLeafRootPath = (leafHex) => {
  let h = leafHex;
  for (let i = 0; i < 32; i++) h = kc(h, zeros[i]);
  return { root: h, path: zeros.slice(0, 32) };
};
const noteLeaf = (asset, cx, cy, owner) => kc(asset, cx, cy, owner);

// ───────────────────────── OP_CBTC_MINT (op 18) ─────────────────────────
// A bearer cBTC note opens to exactly v_btc; the guest checks only the opening sigma (the lock-registry +
// escrow gate is the contract's). Serialized in the guest's io::read order: outpoint, v_btc, cx, cy, sigR, sigZ.
{
  const outpoint = '0x' + '33'.repeat(32);
  const vBtc = 100000n;
  const r = '0x' + '0'.repeat(63) + '7'; // a fixed non-zero blinding
  const { cx, cy } = pool.commitXY(vBtc, r);
  const note = { cx, cy, owner: ZERO, value: vBtc, blinding: r };
  const sig = cdp.cbtcMintSigma({ chainBinding, cbtcAssetId: CBTC, outpoint, note });
  const fx = { chainBinding, outpoint, vBtc: Number(vBtc), cx, cy, sigR: sig.sigR, sigZ: sig.sigZ, expected: { leaves: 1, cbtcMints: 1 } };
  writeFileSync(new URL('cbtc_mint_op.json', dir), JSON.stringify(fx, null, 2));
  console.log('wrote cbtc_mint_op.json  (cx=' + cx.slice(0, 12) + '… sigR=' + sig.sigR.slice(0, 12) + '…)');
}

// ───────────────────────── OP_CDP_MINT (op 15) ─────────────────────────
// Lock a 1-leg cBTC collateral basket (membership + opening sigma) and mint a controller-derived debt note
// (opening sigma). The guest checks structure + the sigmas; the controller ratio gate is the contract's (not
// in execute). Single-leaf note tree → spendRoot + the zero-sibling path at index 0.
{
  const controller = '0x' + 'c1'.repeat(20);
  const owner = '0x' + 'a0'.repeat(32);
  const nonce = '0x' + 'b0'.repeat(32);
  const debtValue = 40000n;

  // collateral leg: a cBTC note, member of the note tree at index 0.
  const cv = 100000n;
  const cr = '0x' + '0'.repeat(63) + '3';
  const { cx, cy } = pool.commitXY(cv, cr);
  const legLeaf = noteLeaf(CBTC, cx, cy, owner);
  const { root: spendRoot, path } = singleLeafRootPath(legLeaf);
  const legNote = { cx, cy, owner, value: cv, blinding: cr };
  const legSig = cdp.cdpMintCollateralSigma({ chainBinding, controller, nonce, owner, asset: CBTC, note: legNote, debtValue, index: 0 });

  // debt note: the controller-derived asset, opening to debtValue.
  const dr = '0x' + '0'.repeat(63) + '5';
  const debtAsset = cdp.debtAssetId(controller);
  const { cx: dcx, cy: dcy } = pool.commitXY(debtValue, dr);
  const debtNote = { cx: dcx, cy: dcy, owner, value: debtValue, blinding: dr };
  const debtSig = cdp.cdpMintDebtSigma({ chainBinding, controller, nonce, owner, note: debtNote });

  const fx = {
    chainBinding, spendRoot, controller, owner, nonce, debtValue: Number(debtValue),
    legs: [{ asset: CBTC, cx, cy, value: Number(cv), index: 0, path, sigR: legSig.sigR, sigZ: legSig.sigZ }],
    debt: { cx: dcx, cy: dcy, sigR: debtSig.sigR, sigZ: debtSig.sigZ },
    expected: { nullifiers: 1, leaves: 1, cdpMints: 1 },
  };
  writeFileSync(new URL('cdp_mint_op.json', dir), JSON.stringify(fx, null, 2));
  console.log('wrote cdp_mint_op.json  (debtAsset=' + debtAsset.slice(0, 12) + '… spendRoot=' + spendRoot.slice(0, 12) + '…)');
}

// ───────────────────────── OP_CDP_LIQUIDATE (op 17) ─────────────────────────
// Reproduce a position from its legs + fields, prove it ∈ cdpPositionRoot, seize the basket as withdrawals.
// No sigmas/notes — just the position membership. The controller health-veto is the contract's (not execute).
{
  const controller = '0x' + 'c2'.repeat(20);
  const owner = '0x' + 'a2'.repeat(32);
  const nonce = '0x' + 'b2'.repeat(32);
  const debtValue = 30000n;
  const legs = [{ asset: CBTC, value: 90000n }];
  const basketRoot = cdp.basketRoot(legs.map((l) => cdp.basketLeg(l.asset, l.value)));
  const debtAsset = cdp.debtAssetId(controller);
  const positionLeaf = cdp.positionLeaf(controller, debtAsset, basketRoot, debtValue, owner, nonce);
  const { root: cdpPositionRoot, path: positionPath } = singleLeafRootPath(positionLeaf);
  const fx = {
    chainBinding, cdpPositionRoot, controller, owner, nonce, debtValue: Number(debtValue),
    positionIndex: 0, positionPath,
    legs: legs.map((l) => ({ asset: l.asset, value: Number(l.value) })),
    expected: { withdrawals: 1, cdpLiquidations: 1 },
  };
  writeFileSync(new URL('cdp_liquidate_op.json', dir), JSON.stringify(fx, null, 2));
  console.log('wrote cdp_liquidate_op.json  (positionLeaf=' + positionLeaf.slice(0, 12) + '…)');
}

// ───────────────────────── OP_CDP_TOPUP (op 19) ─────────────────────────
// Prove the OLD position ∈ cdpPositionRoot, spend a FRESH added-collateral note (∈ spendRoot, opening sigma
// bound to the old position leaf + new nonce); the guest merges old+added → the new position leaf.
{
  const controller = '0x' + 'c3'.repeat(20);
  const owner = '0x' + 'a3'.repeat(32);
  const oldNonce = '0x' + 'b3'.repeat(32);
  const newNonce = '0x' + 'b4'.repeat(32);
  const debtValue = 30000n;
  const oldLegs = [{ asset: CBTC, value: 90000n }];
  const oldBasketRoot = cdp.basketRoot(oldLegs.map((l) => cdp.basketLeg(l.asset, l.value)));
  const debtAsset = cdp.debtAssetId(controller);
  const oldPositionLeaf = cdp.positionLeaf(controller, debtAsset, oldBasketRoot, debtValue, owner, oldNonce);
  const { root: cdpPositionRoot, path: positionPath } = singleLeafRootPath(oldPositionLeaf);
  // added collateral: a fresh note of a DISTINCT asset (no merge-dup), member of the note tree at index 0.
  const ASSET2 = '0x' + 'aa'.repeat(32);
  const av = 50000n, ar = '0x' + '0'.repeat(63) + '9';
  const { cx, cy } = pool.commitXY(av, ar);
  const { root: spendRoot, path: addPath } = singleLeafRootPath(noteLeaf(ASSET2, cx, cy, owner));
  const addNote = { cx, cy, owner, value: av, blinding: ar };
  const addSig = cdp.cdpTopupCollateralSigma({ chainBinding, oldPositionLeaf, controller, newNonce, owner, asset: ASSET2, note: addNote, debtValue, index: 0 });
  const fx = {
    chainBinding, spendRoot, cdpPositionRoot, controller, owner, oldNonce, newNonce, debtValue: Number(debtValue),
    positionIndex: 0, positionPath,
    oldLegs: oldLegs.map((l) => ({ asset: l.asset, value: Number(l.value) })),
    addedLegs: [{ asset: ASSET2, cx, cy, value: Number(av), index: 0, path: addPath, sigR: addSig.sigR, sigZ: addSig.sigZ }],
    expected: { nullifiers: 1, cdpTopups: 1 },
  };
  writeFileSync(new URL('cdp_topup_op.json', dir), JSON.stringify(fx, null, 2));
  console.log('wrote cdp_topup_op.json  (oldPositionLeaf=' + oldPositionLeaf.slice(0, 12) + '…)');
}

// ───────────────────────── OP_CDP_CLOSE (op 16) ─────────────────────────
// Prove the position ∈ cdpPositionRoot, re-mint each collateral leg as a FRESH note (release sigma), and burn
// debt notes (∈ spendRoot, debt sigma) summing to EXACTLY the position debt. Two trees: position + note.
{
  const controller = '0x' + 'c4'.repeat(20);
  const owner = '0x' + 'a4'.repeat(32);
  const nonce = '0x' + 'b5'.repeat(32);
  const debtValue = 30000n;
  const legs = [{ asset: CBTC, value: 90000n }];
  const debtAsset = cdp.debtAssetId(controller);
  const basketRoot = cdp.basketRoot(legs.map((l) => cdp.basketLeg(l.asset, l.value)));
  const positionLeaf = cdp.positionLeaf(controller, debtAsset, basketRoot, debtValue, owner, nonce);
  const { root: cdpPositionRoot, path: positionPath } = singleLeafRootPath(positionLeaf);
  // released collateral: a FRESH note re-minted to the owner, opening to the leg value (release sigma).
  const rr = '0x' + '0'.repeat(63) + '4';
  const { cx, cy } = pool.commitXY(legs[0].value, rr);
  const relNote = { cx, cy, owner, value: legs[0].value, blinding: rr };
  const relSig = cdp.cdpCloseReleaseSigma({ chainBinding, positionLeaf, asset: CBTC, note: relNote });
  // burned debt note: a debt-asset note (∈ spendRoot) opening to EXACTLY debtValue (debt sigma).
  const dr = '0x' + '0'.repeat(63) + '6';
  const { cx: dcx, cy: dcy } = pool.commitXY(debtValue, dr);
  const { root: spendRoot, path: debtPath } = singleLeafRootPath(noteLeaf(debtAsset, dcx, dcy, owner));
  const debtNote = { cx: dcx, cy: dcy, owner, value: debtValue, blinding: dr };
  const debtSig = cdp.cdpCloseDebtSigma({ chainBinding, positionLeaf, debtAsset, debtValue, index: 0, note: debtNote });
  const fx = {
    chainBinding, spendRoot, cdpPositionRoot, controller, owner, nonce, debtValue: Number(debtValue),
    positionIndex: 0, positionPath,
    legs: [{ asset: CBTC, value: Number(legs[0].value), cx, cy, sigR: relSig.sigR, sigZ: relSig.sigZ }],
    debt: [{ cx: dcx, cy: dcy, owner, value: Number(debtValue), index: 0, path: debtPath, sigR: debtSig.sigR, sigZ: debtSig.sigZ }],
    expected: { nullifiers: 1, leaves: 1, cdpCloses: 1 },
  };
  writeFileSync(new URL('cdp_close_op.json', dir), JSON.stringify(fx, null, 2));
  console.log('wrote cdp_close_op.json  (positionLeaf=' + positionLeaf.slice(0, 12) + '…)');
}

console.log('OK');
