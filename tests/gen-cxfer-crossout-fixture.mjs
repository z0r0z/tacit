#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/crossout_op.json — the acceptance witness for a crossOut
// SETTLE (ETH→BTC, OP_BRIDGE_BURN): EVM-homed notes burned on Ethereum, emitting per-output crossOuts
// the contract records in crossOutCommitment[claimId] (round-trip step 1, the reverse-bridge / fast-lane
// round-trip entry). It is the transfer crosslane witness (gen-cxfer-crosslane-fixture.mjs) with
// buildTransfer -> buildBridgeBurn: same membership + range + kernel conservation, but the outputs are
// Bitcoin destination notes (crossOuts), not Ethereum leaves.
//
// The burned input is EVM-homed (spendRoot is the pool's own EVM tree root, NOT a knownBitcoinRoot), so
// bitcoinSpentRoot = 0 (no cross-lane non-membership — a btcHomed crossOut is barred by construction). The
// guest binds every crossOut's claimId to the FIRST input's nullifier; we compute that bind here.
//
// Run: node tests/gen-cxfer-crossout-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const ASSET = '0x' + 'a5'.repeat(32);
const OWNER = '0x' + Buffer.from('owner-stealth'.padEnd(32, '\0')).toString('hex');      // EVM note owner
const BTC_OWNER = '0x' + '00'.repeat(32); // Bitcoin-homed pool notes are owner-free (ZERO_OWNER bearer convention; reflection fold_crossout mints leaf(asset,cx,cy,0), so a non-zero dest owner records an UNFOLDABLE destCommitment = burned value that can never be minted on Bitcoin)
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex');

// 2 EVM notes burned → 2 Bitcoin dest notes (Σin == Σout).
const inputs = [
  { value: 1000n, blinding: randomScalar(), secret: '0x' + '11'.repeat(32) },
  { value: 500n, blinding: randomScalar(), secret: '0x' + '22'.repeat(32) },
];
const outputs = [
  { value: 900n, blinding: randomScalar(), owner: BTC_OWNER },
  { value: 600n, blinding: randomScalar(), owner: BTC_OWNER },
];

// bindNullifier = nullifier of the FIRST input's commitment (the guest re-derives the same bind).
const in0 = ct.commit(inputs[0].value, inputs[0].blinding);
const { cx: cx0, cy: cy0 } = xy(in0);
const bindNullifier = pool.nullifier(cx0, cy0);

const t = ct.buildBridgeBurn({
  inputs: inputs.map((i) => ({ value: i.value, blinding: i.blinding })),
  outputs, assetId: ASSET, destChain: 1, bindNullifier,
});
if (!ct.verifyBridgeBurn(t)) throw new Error('JS self-verify (verifyBridgeBurn) failed');

// Pool tree (input membership) → spendRoot (EVM-homed) + paths.
const tree = new pool.Tree();
const inMeta = inputs.map((inp, i) => { const { cx, cy } = xy(t.inC[i]); tree.insert(pool.leaf(ASSET, cx, cy, OWNER)); return { cx, cy, secret: inp.secret }; });
const spendRoot = tree.root();
inMeta.forEach((m, i) => { m.path = tree.rootAndPath(i).path; m.leafIndex = i; });

const fixture = {
  note: 'crossOut (OP_BRIDGE_BURN) settle witness — EVM notes burned → Bitcoin dest notes (crossOuts); round-trip step 1',
  chainBinding: '0x' + '00'.repeat(32),
  spendRoot,
  asset: ASSET, owner: OWNER,
  destChain: 1, // BITCOIN
  inputs: inMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: OWNER, leafIndex: m.leafIndex, path: m.path, secret: m.secret })),
  outputs: t.outC.map((P, j) => { const { cx, cy } = xy(P); return { cx, cy, owner: outputs[j].owner }; }),
  rangeProof: '0x' + Buffer.from(t.rangeProof).toString('hex'),
  kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
  expected: {
    crossOuts: t.crossOuts.map((c) => ({ destChain: c.destChain, destCommitment: c.destCommitment, nullifier: c.nullifier, assetId: c.assetId, claimId: c.claimId })),
  },
};

const out = 'contracts/sp1/confidential/fixtures/crossout_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '—', t.crossOuts.length, 'crossOuts; bind', bindNullifier.slice(0, 12), '; Σ 1500 burned → dest', outputs.map((o) => Number(o.value)).join('+'));
