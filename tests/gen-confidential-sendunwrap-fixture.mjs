#!/usr/bin/env node
// Build a full OP_SEND_AND_UNWRAP witness for the SP1 guest: spend ONE hidden note → a PUBLIC withdrawal
// of `payout` to an EVM recipient + HIDDEN change note(s) back to the sender. The note value stays PRIVATE
// (only payout + fee are public). A value-hiding opening PoK (openingPokBlind) proves spend authority AND
// binds (recipient, payout, fee, deadline) WITHOUT the value entering the transcript, so a relay box can't
// redirect/skim; the conservation kernel proves value == Σchange + payout + fee; the range proof bounds the
// hidden change.
//
//   FEE=0 (default) → self-settle (user pays gas); FEE=<n> → relayed exit (relay paid `fee`).
// Run: node tests/gen-confidential-sendunwrap-fixture.mjs > contracts/sp1/confidential/fixtures/sendunwrap_op.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar, G as bpG } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const transfer = makeConfidentialTransfer({ keccak256 });
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });

const PtT = bpG.constructor;
const ptHexT = (h) => PtT.fromHex(String(h).replace(/^0x/, ''));
const Cm = (v, r) => transfer.commit(BigInt(v), BigInt(r));

const ASSET = '0x' + 'a5'.repeat(32);
const OWNER = '0x' + Buffer.from('owner-stealth'.padEnd(32, '\0')).toString('hex');
const RECIPIENT = '0x' + '1234567890abcdef1234567890abcdef12345678'; // 20-byte EVM address
const CHAIN_BINDING = '0x' + '00'.repeat(32);
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');

const FEE = BigInt(process.env.FEE || '0');
const VALUE = 1500n;       // PRIVATE note value (never read by the guest)
const PAYOUT = 900n;       // public withdrawal to the recipient
const changeValue = VALUE - PAYOUT - FEE;
if (changeValue < 0n) throw new Error('payout + fee exceeds value');
const noteBlinding = beHex(randomScalar());
const changeBlinding = beHex(randomScalar());

// Input note commitment + membership.
const { cx, cy } = pool.commitXY(VALUE, noteBlinding);
const inLeaf = pool.leaf(ASSET, cx, cy, OWNER);
const tree = new pool.Tree();
tree.insert(inLeaf);
const spendRoot = tree.root();
const { path } = tree.rootAndPath(0);

const OP_DEADLINE = 0n; // 0 = no expiry (self-settle); a relayed exit would pin a real deadline

const sendu = stealth.buildSendUnwrap({
  chainBinding: CHAIN_BINDING, asset: ASSET,
  note: { cx, cy, owner: OWNER, blinding: noteBlinding, value: VALUE, leafIndex: 0, path, secret: '0x' + '11'.repeat(32) },
  recipient: RECIPIENT, payout: PAYOUT, fee: FEE, opDeadline: OP_DEADLINE,
  change: [{ value: changeValue, blinding: changeBlinding, owner: OWNER }],
  spendRoot,
});

// Self-verify the value-hiding PoK + the conservation kernel + change range exactly as the guest re-checks them.
if (!pool.verifyOpeningPokBlind(cx, cy, sendu.pokR, sendu.pokZv, sendu.pokZr, sendu._ctx))
  throw new Error('send-unwrap blind PoK self-verify failed');
const changeLeaf = pool.leaf(ASSET, sendu.change[0].cx, sendu.change[0].cy, OWNER);
const kern = { R: ptHexT(sendu.kernelR), z: BigInt(sendu.kernelZ) };
const rangeBytes = Uint8Array.from(sendu.rangeProof.replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
if (!transfer.verifyTransfer({ inC: [Cm(VALUE, noteBlinding)], outC: [Cm(changeValue, changeBlinding)], rangeProof: rangeBytes, kernel: kern, fee: PAYOUT + FEE, outLeaves: [changeLeaf] }))
  throw new Error('send-unwrap kernel + change range self-verify failed');

process.stdout.write(JSON.stringify({
  note: 'OP_SEND_AND_UNWRAP: spend one hidden note → public payout + hidden change (value stays private via openingPokBlind)',
  op: 'sendunwrap',
  chainBinding: CHAIN_BINDING,
  spendRoot,
  asset: ASSET,
  input: { cx, cy, owner: OWNER, leafIndex: 0, path, secret: '0x' + '11'.repeat(32) },
  recipient: RECIPIENT,
  payout: Number(PAYOUT),
  fee: Number(FEE),
  opDeadline: Number(OP_DEADLINE),
  pokR: sendu.pokR,
  pokZv: sendu.pokZv,
  pokZr: sendu.pokZr,
  change: sendu.change.map((m) => ({ cx: m.cx, cy: m.cy, owner: m.owner })),
  rangeProof: sendu.rangeProof,
  kernel: { R: sendu.kernelR, z: sendu.kernelZ },
}, null, 2) + '\n');
