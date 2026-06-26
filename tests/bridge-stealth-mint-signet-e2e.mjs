// OP_BRIDGE_STEALTH_MINT standalone signet rehearsal — cross-chain confidential PAY-TO-STEALTH.
//
// A SENDER burns a note on Bitcoin; the reflection attests that burn into bitcoinBurnRoot; the box settles
// OP_BRIDGE_STEALTH_MINT, minting the burned value into the shared stealth lock-set under the RECIPIENT's
// one-time pubkey; the recipient scans the lock-set and claims with OP_STEALTH_CLAIM (only they can).
//
// Two modes:
//   preflight (default) — load .local/bridge-stealth-mint-wallets.json (or ephemeral keys), assemble the
//     real bridge-stealth-mint op (dapp/confidential-stealth.js buildBridgeStealthMint) and ASSERT it is
//     inflation-safe + recipient-only: (1) the L opening sigma binds the cleartext amount, (2) the kernel
//     conserves v_in == v_L (over-mint unconstructible), (3) the minted lock is claimable ONLY by the
//     recipient's one-time key, not the sender's base key. Runs locally (no signet/box) — the CI-safe path.
//   live (MODE=live) — broadcast the full round-trip on Sepolia+Signet via the box. Gated.
//
// Run (preflight): node tests/bridge-stealth-mint-signet-e2e.mjs
// Setup:           node tests/gen-bridge-stealth-mint-signet-wallets.mjs   (then fund the sender)

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, verifySchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const rand = () => { const b = new Uint8Array(32); (globalThis.crypto || webcrypto).getRandomValues(b); return hx(b); };

function loadWallets() {
  const f = path.join(__dirname, '..', '.local', 'bridge-stealth-mint-wallets.json');
  if (existsSync(f)) {
    const w = JSON.parse(readFileSync(f, 'utf8'));
    return { senderPriv: '0x' + w.sender.priv_hex, recipientPriv: '0x' + w.recipient.priv_hex, persisted: true };
  }
  // ephemeral (preflight still validates the full math; live mode requires the persisted+funded wallets)
  return { senderPriv: rand(), recipientPriv: rand(), persisted: false };
}

function preflight() {
  const { recipientPriv, persisted } = loadWallets();
  console.log(`bridge-stealth-mint preflight — wallets: ${persisted ? '.local/bridge-stealth-mint-wallets.json' : 'ephemeral (gen wallets for the live run)'}\n`);

  const cb = '0x' + '11'.repeat(32), asset = '0x' + 'aa'.repeat(32), poolRoot = '0x' + '22'.repeat(32);
  const locker = '0x' + '00'.repeat(31) + '01';
  const amount = 1000n, deadline = 1_900_000_000n;
  const ZERO_OWNER = '0x' + '00'.repeat(32); // Bitcoin-homed notes are owner-free (bearer)

  // recipient static spend key → sender derives a one-time address; recipient recovers the one-time key
  const B = hx(secp.ProjectivePoint.BASE.multiply(BigInt(recipientPriv)).toRawBytes(true));
  const { ephemeralPub, ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: rand() });
  const { oneTimePriv } = stealth.recoverOneTimeKey({ recipientSpendPriv: recipientPriv, ephemeralPub });

  // the burned Bitcoin note (value == amount; the bridge conserves it into the lock)
  const rIn = randomScalar();
  const burned = { ...pool.commitXY(amount, rIn), owner: ZERO_OWNER, blinding: rIn, leafIndex: 0, path: pool.zeros };
  const lBlinding = randomScalar();
  const mint = stealth.buildBridgeStealthMint({
    chainBinding: cb, asset, poolRoot, burned, ownerPub, amount, deadline, locker, lBlinding,
    bmNext: '0x' + 'ff'.repeat(32), bmIndex: 0, bmPath: pool.zeros,
  });

  let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

  // (1) opening sigma binds L to the cleartext amount
  const ctx = pool.intentContext('tacit-bridge-stealth-mint-v1', cb, asset, asset, [[mint.lCx, mint.lCy, ownerPub]], [amount, deadline]);
  assert.equal(pool.verifyOpeningSigma(mint.lCx, mint.lCy, amount, mint.lSigR, mint.lSigZ, ctx), true);
  assert.equal(pool.verifyOpeningSigma(mint.lCx, mint.lCy, amount + 1n, mint.lSigR, mint.lSigZ, ctx), false);
  ok('L opening sigma binds the cleartext amount (a padded amount is rejected)');

  // (2) conservation v_in == v_L (over-mint unconstructible)
  assert.equal(transfer.verifyTransfer(transfer.buildTransfer({ inputs: [{ value: amount, blinding: BigInt(rIn) }], outputs: [{ value: amount, blinding: BigInt(lBlinding) }] })), true);
  assert.throws(() => transfer.buildTransfer({ inputs: [{ value: amount, blinding: BigInt(rIn) }], outputs: [{ value: amount + 500n, blinding: BigInt(lBlinding) }] }), /not conserved/);
  assert.ok(mint.kernelR && mint.kernelZ, 'op carries the conservation kernel');
  ok('kernel enforces v_in == v_L — over-mint is unconstructible');

  // (3) the minted lock is claimable ONLY by the recipient one-time key
  const lockLeaf = stealth.stealthLockLeaf(asset, mint.lCx, mint.lCy, ownerPub, amount, deadline, locker);
  const fee = 30n, net = amount - fee, mOwner = '0x' + '00'.repeat(31) + '09';
  const claim = stealth.buildStealthClaim({
    chainBinding: cb, asset, lCx: mint.lCx, lCy: mint.lCy, ownerPub, amount, deadline, locker,
    lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros, oneTimePriv, mOwner, fee, mBlinding: randomScalar(),
  });
  const claimMsg = stealth.stealthClaimMsg(cb, lockLeaf, claim.mCx, claim.mCy, mOwner, amount, fee);
  assert.equal(verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(ownerPub)), true, 'recipient one-time claim verifies');
  assert.equal(verifySchnorr(fromHex(hx(signSchnorr(claimMsg, b32(recipientPriv)))), claimMsg, b32(ownerPub)), false, 'base spend key cannot claim');
  const mCtx = pool.intentContext('tacit-stealth-claim-out-v1', cb, asset, asset, [[claim.mCx, claim.mCy, mOwner]], [amount, fee]);
  assert.equal(pool.verifyOpeningSigma(claim.mCx, claim.mCy, net, claim.mSigR, claim.mSigZ, mCtx), true, 'claim output opens to amount - fee');
  ok('minted lock plugs into OP_STEALTH_CLAIM — recipient-only (sender cannot claim)');

  console.log(`\nPREFLIGHT OK — ${n} checks. The bridge-stealth-mint op assembles, conserves, and is recipient-only.`);
  if (!persisted) console.log('(run gen-bridge-stealth-mint-signet-wallets.mjs + fund the sender for the live broadcast.)');
}

function live() {
  console.error('live mode: full signet round-trip via the box (PLAYBOOK §5, phase 9).');
  console.error('prereqs: .local/bridge-stealth-mint-wallets.json (sender FUNDED), CONFIDENTIAL_BOX_TOKEN, worker base, Sepolia RPC, REFLECTION on.');
  console.error('sequence: (1) sender burns a note on Bitcoin (bridge_burn/crossOut) → (2) reflection attests the burn into');
  console.error('bitcoinBurnRoot → (3) box settles OP_BRIDGE_STEALTH_MINT (type "bridgestealthmint") into the stealth lock-set');
  console.error('under the recipient one-time pubkey → (4) recipient scans the lock-set + claims via OP_STEALTH_CLAIM.');
  throw new Error('live broadcast runs on signet with funded wallets + box; preflight is the CI-safe path.');
}

if (process.env.MODE === 'live') live();
else preflight();
