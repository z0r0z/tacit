#!/usr/bin/env node
// Build an OP_BRIDGE_STEALTH_MINT witness for the SP1 guest: a note burned on Bitcoin (ν in the relay-
// attested bridge-burn set, value = dest_leaf = stealth_lock_leaf) is minted into the shared stealth
// lock-set under the recipient's one-time pubkey. Mirrors gen-cxfer-bridgemint-fixture.mjs but the dest is
// a stealth lock (claimed via OP_STEALTH_CLAIM), built with confidential-stealth.buildBridgeStealthMint.
//
// Run: node tests/gen-bridgestealthmint-fixture.mjs > contracts/sp1/confidential/fixtures/bridgestealthmint_op.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash, webcrypto } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const rand = () => { const b = new Uint8Array(32); (globalThis.crypto || webcrypto).getRandomValues(b); return hx(b); };

const CHAINB = '0x' + '11'.repeat(32);
const ASSET = '0x' + 'a5'.repeat(32);
const ZERO_OWNER = '0x' + '00'.repeat(32);       // Bitcoin-homed burned note is owner-free (bearer)
const AMOUNT = 1500n, DEADLINE = 1_900_000_000n;
const FEE = BigInt(process.env.FEE || '0');
// `locker` is the burner's x-only refund pubkey (the blind refund signs under it); derive a real key.
const lockerPriv = randomScalar();
const LOCKER = '0x' + secp.ProjectivePoint.BASE.multiply(lockerPriv).toRawBytes(true).slice(1).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');

// recipient static spend key → sender-derived one-time stealth address
const recipientPriv = rand();
const B = hx(secp.ProjectivePoint.BASE.multiply(BigInt(recipientPriv)).toRawBytes(true));
const { ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: rand() });

// burned Bitcoin note (value == AMOUNT) + its Bitcoin-pool membership
const rIn = randomScalar();
const inC = pool.commitXY(AMOUNT, rIn);
const tree = new pool.Tree();
const inLeaf = pool.leaf(ASSET, inC.cx, inC.cy, ZERO_OWNER);
tree.insert(inLeaf);
const poolRoot = tree.root();
const { path: inPath } = tree.rootAndPath(0);
const nu = pool.nullifier(inC.cx, inC.cy);

// the lock L the value is minted into + the opening sigma + conservation kernel (echoes bm* into the witness)
const lBlinding = randomScalar();
const burned = { cx: inC.cx, cy: inC.cy, owner: ZERO_OWNER, blinding: rIn, leafIndex: 0, path: inPath };
const mint = stealth.buildBridgeStealthMint({
  chainBinding: CHAINB, asset: ASSET, poolRoot, burned, ownerPub, amount: AMOUNT, deadline: DEADLINE,
  locker: LOCKER, lBlinding, bmNext: '0x' + 'ff'.repeat(32), bmIndex: 0, bmPath: pool.zeros, fee: FEE,
});

// bridge-burn set: ν is a MEMBER bound to dest_leaf = stealth_lock_leaf_blind(...) (the guest rebuilds utxo_leaf).
const destLeaf = stealth.stealthLockLeafBlind(ASSET, mint.lCx, mint.lCy, ownerPub, DEADLINE, LOCKER);
const burnAcc = pool.makeUtxoAccumulator();
burnAcc.insert('0x' + '00'.repeat(31) + '07', '0x' + '00'.repeat(31) + '99'); // unrelated prior burn
burnAcc.insert(nu, destLeaf);                                                  // this burn → its stealth dest
const bitcoinBurnRoot = burnAcc.root();
const bm = burnAcc.membershipWitness(nu); // { next, value (= destLeaf), index, path }

process.stdout.write(JSON.stringify({
  note: 'OP_BRIDGE_STEALTH_MINT witness (cross-chain confidential pay-to-stealth)',
  chainBinding: CHAINB,
  bitcoinBurnRoot,
  asset: ASSET,
  poolRoot,
  inCx: inC.cx, inCy: inC.cy, inOwner: ZERO_OWNER, inIndex: 0, inPath,
  ownerPub,
  amount: Number(AMOUNT), deadline: Number(DEADLINE),
  locker: LOCKER,
  lCx: mint.lCx, lCy: mint.lCy,
  bmNext: bm.next, bmIndex: bm.index, bmPath: bm.path,
  fee: Number(FEE),
  kernelR: mint.kernelR, kernelZ: mint.kernelZ,
  lRange: '0x' + Buffer.from(mint.lRange).toString('hex'),
  expect: { destLeaf, nullifier: nu },
}, null, 2) + '\n');
