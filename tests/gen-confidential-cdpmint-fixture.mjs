#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/cdp_mint_op.json — a single OP_CDP_MINT for the box's
// exec-cdpmint harness: lock one collateral note into a controller-bound position and mint the debt note.
//
// SECURITY (F-2): the collateral authorization now BINDS the exact debt-note commitment AND the relay fee,
// so `fee` + the debt commitment are read BEFORE the legs. Without that binding a relayer could honour every
// value the borrower signed, substitute a debt commitment whose blinding IT knows, and take almost the whole
// loan as "fee" — the borrower's collateral encumbered for the gross debt while the relayer keeps the
// proceeds. The debt note's own sigma does not help: it is produced by whoever CHOSE that commitment, and
// the `owner` LABEL on the minted leaf is not spend authority (notes are bearer).
//
// Run: node tests/gen-confidential-cdpmint-fixture.mjs   [FEE=<u64 on the coarse ladder>]

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { signSchnorr } from '../dapp/bulletproofs.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialCdp } from '../dapp/confidential-cdp.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const _cat = (a) => { const t = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { t.set(x, o); o += x.length; } return t; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m)); // signSchnorr nonces
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const cdp = makeConfidentialCdp({ keccak256, pool, signSchnorr });

const CONTROLLER = '0x' + '11'.repeat(20);
const COLL_ASSET = '0x' + 'cc'.repeat(32);
const CHAIN_BINDING = '0x' + '11'.repeat(32);
const ZERO32 = '0x' + '00'.repeat(32);

const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('ccdp-fixture-' + tag))
  .reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

// The position owner is a FRESH per-position key (published so keepers can liquidate; not a spend key).
const ownerPriv = det('owner') % (2n ** 250n);
const OWNER = '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(ownerPriv).toRawBytes(true).slice(1)).toString('hex');

const COLL_VALUE = 100n;
const DEBT_VALUE = 50n;
const FEE = BigInt(process.env.FEE || 0); // must sit on the guest's coarse ladder (<= 2 significant digits)
const RATE_SNAPSHOT = ZERO32;             // dormant accumulator (fee-free controller)

const collBlind = det('coll');
const debtBlind = det('debt');

// Place the collateral note in a tree so the leg carries a real membership witness.
const coll = pool.commitXY(COLL_VALUE, collBlind);
const tree = new pool.Tree();
const index = tree.insert(pool.leaf(COLL_ASSET, coll.cx, coll.cy, OWNER));
const { root: spendRoot, path } = tree.rootAndPath(index);

const op = cdp.buildCdpMintOp({
  chainBinding: CHAIN_BINDING,
  controller: CONTROLLER,
  owner: OWNER,
  debtValue: DEBT_VALUE,
  nonce: ZERO32,
  rateSnapshot: RATE_SNAPSHOT,
  fee: FEE,
  collateral: [{ asset: COLL_ASSET, cx: coll.cx, cy: coll.cy, value: COLL_VALUE, blinding: collBlind, leafIndex: index, path }],
  spendRoot,
  debtBlinding: debtBlind,
});

const fixture = {
  chainBinding: CHAIN_BINDING,
  spendRoot,
  op: 15, // OP_CDP_MINT
  controller: CONTROLLER,
  owner: OWNER,
  debtValue: Number(DEBT_VALUE),
  nonce: ZERO32,
  rateSnapshot: RATE_SNAPSHOT,
  // Read BEFORE the legs — each collateral sigma binds both (F-2).
  fee: Number(FEE),
  debt: op.debt,
  legs: op.legs,
  expected: { debtValue: Number(DEBT_VALUE), fee: Number(FEE), legs: op.legs.length },
};

const out = 'contracts/sp1/confidential/fixtures/cdp_mint_op.json';
writeFileSync(out, JSON.stringify(fixture, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) + '\n');
console.log('wrote', out, `— ${COLL_VALUE} collateral → ${DEBT_VALUE} debt (fee ${FEE}); collateral sigma binds the debt commitment + fee`);
