#!/usr/bin/env node
// Build a full OP_WRAP_TRANSFER witness for the SP1 guest (contracts/sp1/confidential): an atomic
// wrap-and-send. A pending PUBLIC deposit (value known, opening sigma proves the depositor knows its
// blinding — exactly OP_WRAP's binding) is consumed and spent into HIDDEN recipient (+ change) notes
// under the transfer conservation kernel + aggregated BP+ range proof — all in one settle. The deposit
// is NOT emitted as a self-note leaf; it is spent into the outputs.
//
//   FEE=0 (default)         → user-sent router.wrapAndSettleETH path (fee-free; the router gate requires it)
//   FEE=<n>                 → relayed wrap-and-send (the relay is paid `fee` in the wrapped asset; bound
//                             in the kernel so it can't be padded — same as OP_TRANSFER's relay fee)
//
// Run: node tests/gen-confidential-wraptransfer-fixture.mjs > contracts/sp1/confidential/fixtures/wraptransfer_op.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const ASSET = '0x' + 'a5'.repeat(32);
const OWNER = '0x' + Buffer.from('owner-stealth'.padEnd(32, '\0')).toString('hex');     // depositor (deposit-commit binding)
const RECIP = '0x' + Buffer.from('recipient-pubky'.padEnd(32, '\0')).toString('hex');   // hidden recipient
const CHAIN_BINDING = '0x' + '00'.repeat(32);
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex');

const FEE = BigInt(process.env.FEE || '0');
const DEPOSIT_VALUE = 1500n;               // public deposit value (= escrowed_amount / unitScale)
const depositBlinding = randomScalar();

// Outputs: recipient + change, summing to DEPOSIT_VALUE - FEE (conservation Σin = Σout + fee).
const recipientValue = 900n;
const changeValue = DEPOSIT_VALUE - FEE - recipientValue;
if (changeValue < 0n) throw new Error('fee too large for the demo deposit');
const outputs = [
  { value: recipientValue, blinding: randomScalar(), owner: RECIP },
  { value: changeValue, blinding: randomScalar(), owner: OWNER },
];

// Conservation kernel + BP+ range over the outputs; the single input is the deposit commitment.
const t = ct.buildTransfer({
  inputs: [{ value: DEPOSIT_VALUE, blinding: depositBlinding }],
  outputs: outputs.map((o) => ({ value: o.value, blinding: o.blinding, owner: o.owner })),
  fee: FEE,
  assetId: ASSET, // bind output leaves (owner) into the kernel
});
if (!ct.verifyTransfer({ ...t, fee: FEE })) throw new Error('JS self-verify failed (conservation/range)');

// Deposit commitment + opening sigma — identical binding to confidential-pool-ux.buildWrap so the guest's
// OP_WRAP/OP_WRAP_TRANSFER verify_opening_sigma + deposit_id match.
const { cx: dcx, cy: dcy } = pool.commitXY(DEPOSIT_VALUE, beHex(depositBlinding));
const depId = pool.depositId(ASSET, DEPOSIT_VALUE, dcx, dcy, OWNER);
const ctx = pool.intentContext('tacit-wrap-intent-v1', CHAIN_BINDING, ASSET, depId, [[dcx, dcy, OWNER]], [DEPOSIT_VALUE]);
const nonce = pool.deriveOpeningNonce(beHex(depositBlinding), ctx, 'wrap');
const sig = pool.openingSigma(DEPOSIT_VALUE, beHex(depositBlinding), ctx, nonce);

const outMeta = outputs.map((o, j) => ({ ...xy(t.outC[j]), owner: o.owner }));

process.stdout.write(JSON.stringify({
  note: 'atomic wrap-and-send (OP_WRAP_TRANSFER): consume a pending public deposit → hidden recipient (+ change) notes',
  op: 'wraptransfer',
  chainBinding: CHAIN_BINDING,
  asset: ASSET,
  value: Number(DEPOSIT_VALUE),
  deposit: { cx: dcx, cy: dcy, owner: OWNER, sigR: sig.R, sigZ: sig.z },
  outputs: outMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: m.owner })),
  rangeProof: '0x' + Buffer.from(t.rangeProof).toString('hex'),
  fee: Number(FEE),
  kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
}, null, 2) + '\n');
