#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/otc_op.json — a single OP_OTC the box's exec-otc harness
// feeds to the guest (execute → prove). Maker gives 100 A for 50 B and spends a 150 A note (50
// change → has_change=1); taker gives 50 B exactly (has_change=0). One fixture exercises BOTH change
// branches. Fields are emitted in the guest's io::read order; `expected` carries the ν + leaves the
// guest must commit.
//
// Run: node tests/gen-confidential-otc-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialOtc } from '../dapp/confidential-otc.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const otcMod = makeConfidentialOtc({ keccak256, pool });

const ASSET_A = '0x' + 'aa'.repeat(32);
const ASSET_B = '0x' + 'bb'.repeat(32);
const MAKER = '0x' + '00'.repeat(31) + '01';
const TAKER = '0x' + '00'.repeat(31) + '02';
const CHAIN_BINDING = '0x' + '11'.repeat(32);

// deterministic blindings so the fixture is reproducible
const det = (tag) => BigInt('0x' + keccak256(new TextEncoder().encode('cotc-fixture-' + tag)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''));

const vA = 100, vB = 50, makerIn = 150, takerIn = 50; // maker has change (50), taker exact
const mInR = det('m-in'), tInR = det('t-in');
const mInC = pool.commitXY(BigInt(makerIn), mInR);
const tInC = pool.commitXY(BigInt(takerIn), tInR);
const tree = new pool.Tree();
const mIdx = tree.insert(pool.leaf(ASSET_A, mInC.cx, mInC.cy, MAKER));
const tIdx = tree.insert(pool.leaf(ASSET_B, tInC.cx, tInC.cy, TAKER));
const spendRoot = tree.rootAndPath(0).root;

const otc = otcMod.buildOtc({
  assetA: ASSET_A, assetB: ASSET_B, vA, vB, chainBinding: CHAIN_BINDING, spendRoot,
  maker: { owner: MAKER, inAmount: makerIn, inR: mInR, inLeafIndex: mIdx, inPath: tree.rootAndPath(mIdx).path,
           recvR: det('m-recv'), changeR: det('m-change') },
  taker: { owner: TAKER, inAmount: takerIn, inR: tInR, inLeafIndex: tIdx, inPath: tree.rootAndPath(tIdx).path,
           recvR: det('t-recv'), changeR: null },
  nonces: { maker: { in: det('m-in-n'), recv: det('m-recv-n'), change: det('m-change-n') },
            taker: { in: det('t-in-n'), recv: det('t-recv-n'), change: det('t-change-n') } },
});
const { nullifiers, leaves } = otcMod.verifyOtc(otc, { merkleRootFrom: pool.merkleRootFrom });

const leg = (l) => ({
  inCx: l.in.cx, inCy: l.in.cy, inLeafIndex: l.in.leafIndex, inPath: l.in.path,
  inAmount: Number(l.in.amount), inSigR: l.in.sig.R, inSigZ: l.in.sig.z,
  hasChange: l.change ? 1 : 0,
  ...(l.change ? { changeCx: l.change.cx, changeCy: l.change.cy, changeSigR: l.change.sig.R, changeSigZ: l.change.sig.z } : {}),
  recvCx: l.recv.cx, recvCy: l.recv.cy, recvSigR: l.recv.sig.R, recvSigZ: l.recv.sig.z,
});

const fixture = {
  chainBinding: CHAIN_BINDING, spendRoot,
  assetA: ASSET_A, assetB: ASSET_B, vA, vB,
  makerOwner: MAKER, takerOwner: TAKER,
  maker: leg(otc.maker), taker: leg(otc.taker),
  expected: { nullifiers, leaves },
};

const out = 'contracts/sp1/confidential/fixtures/otc_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, `— ${vA} A ↔ ${vB} B; maker change=${makerIn - vA}, taker exact; ${nullifiers.length} ν, ${leaves.length} leaves`);
