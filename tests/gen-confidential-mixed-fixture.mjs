#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/mixed_op.json — a HETEROGENEOUS multi-op settle: ONE
// OP_TRANSFER (op 1) followed by ONE OP_UNWRAP (op 2), both spending notes from the SAME shared
// spendRoot note tree under ONE batch header. No fixture else exercises >1 op TYPE in a single proof.
//
// This validates cross-op PublicValues aggregation that single-op fixtures never reach:
//   - the min_deadline fold across op types (the unwrap carries a per-op deadline; the transfer none),
//   - the COMBINED nullifiers[]/leaves[]/withdrawals[]/fees[] vectors over two distinct op arms.
//
// One shared Keccak Merkle tree holds BOTH the transfer's input note(s) AND the unwrap's input note,
// giving a single spendRoot + per-note membership paths. The transfer is assembled by the dapp's own
// buildTransferOp (REAL BP+ range proof + kernel, self-verified) and the unwrap by buildUnwrap (real
// opening sigma over `value`, with a fixed reproducible deadline). Every input note's membership in the
// shared root is re-checked here, and both the transfer's range proof and the unwrap's sigma are
// self-verified. Throws on any mismatch. The box's exec-mixed.rs harness feeds this to the guest.
//
// Run: node tests/gen-confidential-mixed-fixture.mjs   (NO zkVM prover; membership+sigma+range = the gate)

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

// secp.sign (RFC 6979) needs the sync HMAC set (the buildTransferOp memo-seal path signs).
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const deps = { secp, keccak256, sha256 };
const pool = makeConfidentialPool(deps);
const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });

// cETH on the signet/Sepolia pilot pool — buildUnwrap derives the relay-fee ticker from this assetId.
const ASSET = getConfidentialDeployment('signet').assets.find((a) => a.ticker === 'cETH').assetId;
const CHAIN_BINDING = ux.chainBindingHex(); // keccak(chainid‖pool) — what buildTransferOp/buildUnwrap stamp
const DEADLINE_TTL = 3600; // buildUnwrap takes a TTL; we override its deadline below to a fixed value
const FIXED_DEADLINE = 2_000_000_000n; // reproducible across re-proves; bound in the unwrap opening sigma

// Two wallets: a sender (transfer inputs + unwrap note) and a recipient (transfer output owner).
const SENDER_PRIV = '0x' + '7a'.repeat(32);
const RECIP_PRIV = '0x' + '7b'.repeat(32);
const senderId = ux.identity(SENDER_PRIV);
const recipId = ux.identity(RECIP_PRIV);

// Deterministic blindings (no RNG) so the fixture is byte-reproducible.
const det = (tag) => (BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cmixed-fixture-' + tag))).toString('hex')) % secp.CURVE.n) || 1n;

// --- Build the three input notes (transfer in #0, transfer in #1, unwrap note) ---------------------
// owner MUST be the spender's identity owner: buildTransferOp stamps inMeta.owner = id.owner, and the
// unwrap note opens under (cx,cy,owner). Each note's commitment is C = value·H + r·G; the leaf is
// leaf(asset, cx, cy, owner) — the SAME bytes the contract/guest hash.
function mkNote(ownerHex, secretHex, value, tag) {
  const blinding = det(tag);
  const { cx, cy } = pool.commitXY(value, blinding);
  return { asset: ASSET, value, blinding, secret: secretHex, owner: ownerHex, cx, cy };
}

const tIn0 = mkNote(senderId.owner, senderId.secret, 1000n, 'transfer-in-0');
const tIn1 = mkNote(senderId.owner, senderId.secret, 700n, 'transfer-in-1');
const uNote = mkNote(senderId.owner, senderId.secret, 1500n, 'unwrap-note');

// --- One shared note tree → one spendRoot + per-note membership paths ------------------------------
const tree = new pool.Tree();
const all = [tIn0, tIn1, uNote];
for (const n of all) n.leafIndex = tree.insert(pool.leaf(n.asset, n.cx, n.cy, n.owner));
const sharedRoot = tree.rootAndPath(0).root;
for (const n of all) {
  const { root, path } = tree.rootAndPath(n.leafIndex);
  if (root !== sharedRoot) throw new Error('shared-root mismatch across notes');
  n.root = sharedRoot;
  n.path = path;
  const lf = pool.leaf(n.asset, n.cx, n.cy, n.owner);
  if (!pool.verifyPath(lf, n.leafIndex, path, sharedRoot)) throw new Error('input note membership self-check failed @' + n.leafIndex);
}

// --- OP_TRANSFER: 2-in → recipient + change, REAL BP+ range proof + kernel (self-verified inside) --
const TRANSFER_AMOUNT = 1200n; // to the recipient; change = 1700 − 1200 − fee
const TRANSFER_FEE = 0n;       // self-settle leg (fee=0 ⇒ no FeePayment for the transfer)
const tb = ux.buildTransferOp({
  walletPriv: SENDER_PRIV,
  notes: [tIn0, tIn1],
  recipientPubHex: recipId.pubHex,
  amount: TRANSFER_AMOUNT,
  fee: TRANSFER_FEE,
});
const transferOp = tb.op;
if (transferOp.spendRoot !== sharedRoot) throw new Error('transfer spendRoot != shared root');
if (transferOp.chainBinding !== CHAIN_BINDING) throw new Error('transfer chainBinding mismatch');
if (transferOp.inputs.length !== 2) throw new Error('expected 2 transfer inputs');
// Re-verify the transfer inputs are members of the shared root using the builder's emitted cx/cy.
for (const inp of transferOp.inputs) {
  const lf = pool.leaf(transferOp.asset, inp.cx, inp.cy, inp.owner);
  if (!pool.verifyPath(lf, inp.leafIndex, inp.path, sharedRoot)) throw new Error('transfer input not in shared root');
}
// Real range-proof + kernel self-verify (buildTransferOp throws on failure; re-assert it produced both).
if (!/^0x[0-9a-f]+$/.test(transferOp.rangeProof) || transferOp.rangeProof.length < 200) throw new Error('transfer range proof missing/placeholder');
if (!transferOp.kernel?.R || !transferOp.kernel?.z) throw new Error('transfer kernel missing');

// --- OP_UNWRAP: spend the shared-tree note to a public recipient, real opening sigma + deadline -----
// minFee 100 keeps the relay fee small (the default cETH floor is 1e14, dwarfing this fixture's value)
// while still firing BOTH legs: net = 1400 (Withdrawal) + fee = 100 (FeePayment).
const ub = ux.buildUnwrap({ note: uNote, walletPriv: SENDER_PRIV, ttlSecs: DEADLINE_TTL, feeOpts: { minFee: 100n } });
const unwrapOp = ub.op;
// Pin the deadline to a fixed reproducible value, then RE-DERIVE the sigma over it (the deadline is
// bound in the opening-sigma context, so it can't just be edited in the JSON — re-sign it).
{
  const to = unwrapOp.recipient;
  const recip32 = '0x' + '0'.repeat(24) + to.replace(/^0x/, '');
  const value = BigInt(uNote.value);
  const fee = BigInt(unwrapOp.fee);
  const ctx = pool.intentContext('tacit-unwrap-intent-v1', CHAIN_BINDING, uNote.asset, recip32,
    [[uNote.cx, uNote.cy, uNote.owner]], [value, fee, FIXED_DEADLINE]);
  const nonce = pool.deriveOpeningNonce(uNote.blinding, ctx, 'unwrap');
  const sig = pool.openingSigma(value, uNote.blinding, ctx, nonce);
  if (!pool.verifyOpeningSigma(uNote.cx, uNote.cy, value, sig.R, sig.z, ctx)) throw new Error('unwrap opening-sigma self-verify failed');
  unwrapOp.deadline = FIXED_DEADLINE.toString();
  unwrapOp.sigR = sig.R;
  unwrapOp.sigZ = sig.z;
}
if (unwrapOp.spendRoot !== sharedRoot) throw new Error('unwrap spendRoot != shared root');
if (unwrapOp.chainBinding !== CHAIN_BINDING) throw new Error('unwrap chainBinding mismatch');
if (BigInt(unwrapOp.fee) > BigInt(unwrapOp.value)) throw new Error('unwrap fee exceeds value');
{
  const lf = pool.leaf(unwrapOp.asset, unwrapOp.cx, unwrapOp.cy, unwrapOp.owner);
  if (!pool.verifyPath(lf, unwrapOp.leafIndex, unwrapOp.path, sharedRoot)) throw new Error('unwrap note not in shared root');
}

// --- Assemble the mixed fixture (header shared once; transfer block; unwrap block) -----------------
const fixture = {
  note: 'MIXED-OP settle: 1×OP_TRANSFER (2-in→recip+change) then 1×OP_UNWRAP, one shared spendRoot, one header. Validates cross-op PublicValues aggregation (min_deadline fold + combined nullifiers/leaves/withdrawals/fees).',
  chainBinding: CHAIN_BINDING,
  spendRoot: sharedRoot,
  numOps: 2,
  transfer: {
    asset: transferOp.asset,
    inputs: transferOp.inputs.map((i) => ({ cx: i.cx, cy: i.cy, owner: i.owner, leafIndex: i.leafIndex, path: i.path, secret: i.secret })),
    outputs: transferOp.outputs.map((o) => ({ cx: o.cx, cy: o.cy, owner: o.owner })),
    rangeProof: transferOp.rangeProof,
    fee: String(transferOp.fee),
    kernel: { R: transferOp.kernel.R, z: transferOp.kernel.z },
  },
  unwrap: {
    asset: unwrapOp.asset,
    cx: unwrapOp.cx, cy: unwrapOp.cy, owner: unwrapOp.owner,
    leafIndex: unwrapOp.leafIndex,
    path: unwrapOp.path,
    secret: unwrapOp.secret,
    value: unwrapOp.value,
    recipient: unwrapOp.recipient,
    fee: unwrapOp.fee,
    deadline: unwrapOp.deadline,
    sigR: unwrapOp.sigR,
    sigZ: unwrapOp.sigZ,
  },
  expected: {
    transferNullifiers: transferOp.inputs.map((i) => pool.nullifier(i.cx, i.cy)),
    unwrapNullifier: pool.nullifier(unwrapOp.cx, unwrapOp.cy),
    unwrapWithdrawalValue: (BigInt(unwrapOp.value) - BigInt(unwrapOp.fee)).toString(),
    unwrapFeeValue: unwrapOp.fee,
    minDeadline: FIXED_DEADLINE.toString(), // only the unwrap carries one ⇒ batch min_deadline = it
  },
};

const out = 'contracts/sp1/confidential/fixtures/mixed_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out);
console.log('  op0 OP_TRANSFER: 2-in →', TRANSFER_AMOUNT.toString(), '+ change', tb.change.toString(), 'fee', TRANSFER_FEE.toString(), '(real BP+ range proof + kernel)');
console.log('  op1 OP_UNWRAP  :', unwrapOp.value, '→ withdraw', fixture.expected.unwrapWithdrawalValue, '+ fee', unwrapOp.fee, 'to', unwrapOp.recipient, 'deadline', unwrapOp.deadline);
console.log('  shared spendRoot', sharedRoot);
console.log('  min_deadline (cross-op fold) =', fixture.expected.minDeadline);
