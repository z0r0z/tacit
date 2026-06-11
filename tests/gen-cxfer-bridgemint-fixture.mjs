#!/usr/bin/env node
// Build an OP_BRIDGE_MINT witness (BTC → ETH) for the SP1 guest: the burn is proven by
// MEMBERSHIP of the burned note's ν in the relay-attested Bitcoin bridge-BURN set (key=ν,
// value=destCommitment), bound to the minted dest_leaf — so an ordinary spend's ν is absent
// (not mintable) and the destination is pinned at burn time. Carries the burned note's
// Bitcoin-pool membership, the ν burn-set membership witness, and the dest note + its
// aggregated BP+ range proof + conservation kernel.
//
// Run: node tests/gen-cxfer-bridgemint-fixture.mjs > contracts/sp1/confidential/fixtures/bridgemint_op.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const ct = makeConfidentialTransfer({ keccak256 });
const pool = makeConfidentialPool({ secp, keccak256, sha256 });

const ASSET = '0x' + 'a5'.repeat(32);
const OWNER_BTC = '0x' + '00'.repeat(31) + 'b7'; // burned note's owner on Bitcoin
const OWNER_ETH = '0x' + '00'.repeat(31) + 'e7'; // dest note's owner on Ethereum
const ETHEREUM = 2;
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex'); // 33B compressed

// The burn: one Bitcoin note (1500) → one Ethereum dest note (1500), conserved. We reuse
// buildBridgeBurn only for the (range proof + kernel + commitments); the new bridge_mint
// neither reads an envelope nor binds a claimId, so bindNullifier is unused here.
const burned = { value: 1500n, blinding: randomScalar() };
const dest = { value: 1500n, blinding: randomScalar(), owner: OWNER_ETH };

const burn = ct.buildBridgeBurn({
  inputs: [{ value: burned.value, blinding: burned.blinding }],
  outputs: [dest], assetId: ASSET, destChain: ETHEREUM, bindNullifier: '0x' + '00'.repeat(32),
});
if (!ct.verifyBridgeBurn(burn)) throw new Error('JS bridge-burn self-verify failed');
const inXY = xy(burn.inC[0]);
const co = burn.crossOuts[0]; // { destCommitment (= ETH leaf), cx, cy, owner: OWNER_ETH }

// B3: ν is note-bound (keccak(Cx ‖ Cy ‖ "spent")), not secret-derived.
const nu = pool.nullifier(inXY.cx, inXY.cy);

// Bitcoin pool tree: insert the burned note's leaf, take root + membership path.
const tree = new pool.Tree();
const inLeaf = pool.leaf(ASSET, inXY.cx, inXY.cy, OWNER_BTC);
tree.insert(inLeaf);
const poolRoot = tree.root();
const { path: poolPath } = tree.rootAndPath(0);

// Bitcoin bridge-burn set: ν is a MEMBER bound to its destCommitment (= the ETH dest leaf).
// Seed an unrelated prior burn so ν isn't the sentinel-adjacent edge, then take the burn
// root + ν's membership witness. The guest rebuilds utxo_leaf(ν, next, dest_leaf), so a
// witness whose value ≠ the minted dest_leaf fails the membership check.
const burnAcc = pool.makeUtxoAccumulator();
burnAcc.insert('0x' + '00'.repeat(31) + '07', '0x' + '00'.repeat(31) + '99'); // an unrelated prior burn
burnAcc.insert(nu, co.destCommitment);     // the burn we are minting against → its dest
const bitcoinBurnRoot = burnAcc.root();
const bm = burnAcc.membershipWitness(nu);  // { next, value (= dest_leaf), index, path }

process.stdout.write(JSON.stringify({
  note: 'OP_BRIDGE_MINT witness (BTC→ETH), bridge-burn-set-membership form',
  chainBinding: '0x' + '00'.repeat(32),
  bitcoinBurnRoot, // the batch's reflected Bitcoin bridge-burn root (ν → destCommitment is a member of it)
  asset: ASSET,
  poolRoot, // the Bitcoin pool root the burned note is a member of (contract: knownBitcoinRoot)
  input: { cx: inXY.cx, cy: inXY.cy, owner: OWNER_BTC, leafIndex: 0, path: poolPath },
  output: { cx: co.cx, cy: co.cy, owner: OWNER_ETH },
  burnMembership: { next: bm.next, value: bm.value, index: bm.index, path: bm.path },
  rangeProof: '0x' + Buffer.from(burn.rangeProof).toString('hex'),
  kernel: { R: ptHex(burn.kernel.R), z: beHex(burn.kernel.z) },
  expect: { destLeaf: co.destCommitment, nullifier: nu },
}, null, 2) + '\n');
