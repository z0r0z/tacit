#!/usr/bin/env node
// OP_WRAP_CDP_MINT witness (1-click cUSD): consume a pending PUBLIC deposit as collateral and mint a
// confidential CDP debt note (cUSD) in one settle. The collateral leg is bound by the SAME wrap opening
// sigma + deposit_id the contract created at wrap (owner-pinned by the deposit commit); the debt note opens
// to debt_value − fee. Debt-mint/position/CdpMint identical to OP_CDP_MINT.
// Run: node tests/gen-confidential-wrapcdpmint-fixture.mjs > contracts/sp1/confidential/fixtures/wrapcdpmint_op.json
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const hexToBytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));

const COLL_ASSET = '0x' + 'e7'.repeat(32);            // collateral asset (e.g. tETH)
const OWNER = '0x' + Buffer.from('cdp-owner-stlth'.padEnd(32, '\0')).toString('hex');
const CONTROLLER = 'cafe00000000000000000000000000000000d00d'; // 20-byte CollateralEngine
const CONTROLLER32 = '0x' + '00'.repeat(12) + CONTROLLER;
const CHAIN_BINDING = '0x' + '00'.repeat(32);
const NONCE32 = '0x' + '00'.repeat(32);               // position nonce MUST be 0 (keeper-liquidatable)
const RAY = 10n ** 27n;                               // rate_snapshot ∈ [RAY, rate]; guest carries it
const FEE = BigInt(process.env.FEE || '0');

const COLL_VALUE = 2000n;     // public collateral deposit
const DEBT_VALUE = 1000n;     // cUSD minted (the controller prices the ratio at settle)
const collBlind = randomScalar();
const debtBlind = randomScalar();

// Collateral leg = a pending deposit. The opening sigma MUST be op- and CDP-intent-specific (NOT the plain
// `tacit-wrap-intent-v1`, or a depositor's plain-wrap sigma could be replayed to lock their deposit into an
// attacker-chosen CDP). Bind controller + position nonce + debt_value, matching the guest.
const coll = pool.commitXY(COLL_VALUE, beHex(collBlind));
const depId = pool.depositId(COLL_ASSET, COLL_VALUE, coll.cx, coll.cy, OWNER);
const collCtx = pool.intentContext('tacit-wrap-cdp-mint-collateral-v1', CHAIN_BINDING, COLL_ASSET, depId,
  [[coll.cx, coll.cy, OWNER], [CONTROLLER32, NONCE32, OWNER]], [COLL_VALUE, DEBT_VALUE]);
const collSig = pool.openingSigma(COLL_VALUE, beHex(collBlind), collCtx,
  pool.deriveOpeningNonce(beHex(collBlind), collCtx, 'wrap'));
if (!pool.verifyOpeningSigma(coll.cx, coll.cy, COLL_VALUE, collSig.R, collSig.z, collCtx))
  throw new Error('collateral sigma self-verify failed');

// Debt (cUSD) note: asset = keccak256("tacit-cdp-debt-v1" ‖ controller); opens to debt_value − fee.
const debtAsset = hx(keccak_256(Uint8Array.from([...new TextEncoder().encode('tacit-cdp-debt-v1'), ...hexToBytes('0x' + CONTROLLER)])));
const debt = pool.commitXY(DEBT_VALUE - FEE, beHex(debtBlind));
const debtCtx = pool.intentContext('tacit-cdp-mint-debt-v1', CHAIN_BINDING, debtAsset, NONCE32,
  [[debt.cx, debt.cy, OWNER], [CONTROLLER32, NONCE32, OWNER]], [DEBT_VALUE, FEE]);
const debtSig = pool.openingSigma(DEBT_VALUE - FEE, beHex(debtBlind), debtCtx,
  pool.deriveOpeningNonce(beHex(debtBlind), debtCtx, 'cdp-debt'));
if (!pool.verifyOpeningSigma(debt.cx, debt.cy, DEBT_VALUE - FEE, debtSig.R, debtSig.z, debtCtx))
  throw new Error('debt sigma self-verify failed');

process.stdout.write(JSON.stringify({
  note: 'OP_WRAP_CDP_MINT: consume a pending deposit as collateral → mint confidential cUSD in one settle',
  op: 'wrapcdpmint',
  chainBinding: CHAIN_BINDING,
  controller: CONTROLLER, owner: OWNER,
  debtValue: Number(DEBT_VALUE),
  nonce: NONCE32,
  rateSnapshot: '0x' + RAY.toString(16).padStart(64, '0'),
  legs: [{ asset: COLL_ASSET, value: Number(COLL_VALUE), cx: coll.cx, cy: coll.cy, sigR: collSig.R, sigZ: collSig.z }],
  fee: Number(FEE),
  debt: { cx: debt.cx, cy: debt.cy, sigR: debtSig.R, sigZ: debtSig.z },
}, null, 2) + '\n');
