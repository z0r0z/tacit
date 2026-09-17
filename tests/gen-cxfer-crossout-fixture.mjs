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
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex');

// 2 EVM notes burned → ONE Bitcoin destination note (Σin == Σout). The guest accepts exactly one destination per
// burn: every destination carries the same bound nullifier, and the pool records one cross-out per nullifier.
// Native inputs: each owner is H(nk), and the guest reads nk right after the membership path.
const IN_NK = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)];
const inputs = [
  { value: 1000n, blinding: randomScalar(), nk: IN_NK[0], owner: pool.nkToOwner(IN_NK[0]) },
  { value: 500n, blinding: randomScalar(), nk: IN_NK[1], owner: pool.nkToOwner(IN_NK[1]) },
];
// The Bitcoin destination names the recipient's x-only Taproot key (the key reflection reads from the mint's
// vout-0 P2TR output); the guest rejects a zero key.
const DEST_PRIV = 0x5eedn;
const DEST_XONLY = '0x' + Buffer.from(secp.getPublicKey(beHex(DEST_PRIV).slice(2), true).slice(1)).toString('hex');
const outputs = [{ value: 1500n, blinding: randomScalar(), owner: DEST_XONLY }];

// Pool tree (input membership) → spendRoot (EVM-homed) + paths.
const tree = new pool.Tree();
const inMeta = inputs.map((inp) => {
  const { cx, cy } = xy(ct.commit(inp.value, inp.blinding));
  const leaf = pool.leaf(ASSET, cx, cy, inp.owner);
  tree.insert(leaf);
  return { cx, cy, owner: inp.owner, nk: inp.nk, leaf };
});
const spendRoot = tree.root();
inMeta.forEach((m, i) => { m.path = tree.rootAndPath(i).path; m.leafIndex = i; });

// bindNullifier = the FIRST input's native nullifier (the guest binds every claimId of the burn to it).
const bindNullifier = pool.nativeNullifier(inMeta[0].nk, inMeta[0].leaf);

const t = ct.buildBridgeBurn({
  inputs: inputs.map((i) => ({ value: i.value, blinding: i.blinding })),
  outputs, assetId: ASSET, destChain: 1, bindNullifier,
});
if (!ct.verifyBridgeBurn(t)) throw new Error('JS self-verify (verifyBridgeBurn) failed');

const fixture = {
  note: 'crossOut (OP_BRIDGE_BURN) settle witness — EVM notes burned → Bitcoin dest notes (crossOuts); round-trip step 1',
  chainBinding: '0x' + '00'.repeat(32),
  spendRoot,
  asset: ASSET,
  destChain: 1, // BITCOIN
  inputs: inMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: m.owner, leafIndex: m.leafIndex, path: m.path, nk: m.nk })),
  outputs: t.outC.map((P, j) => { const { cx, cy } = xy(P); return { cx, cy, owner: outputs[j].owner }; }),
  rangeProof: '0x' + Buffer.from(t.rangeProof).toString('hex'),
  kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
  expected: {
    crossOuts: t.crossOuts.map((c) => ({ destChain: c.destChain, destCommitment: c.destCommitment, nullifier: c.nullifier, assetId: c.assetId, claimId: c.claimId })),
  },
};

const out = 'contracts/sp1/confidential/fixtures/crossout_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '—', t.crossOuts.length, 'crossOut; bind', bindNullifier.slice(0, 12), '; Σ 1500 burned → one dest', DEST_XONLY.slice(0, 12));
