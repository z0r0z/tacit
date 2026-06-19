#!/usr/bin/env node
// Worker wiring for the TAC / cmint-deposit bridge onboarding: makeScanReflectionIndexer routes a 0x2B burn
// of a PRE-EXISTING (never-reflected) note through the realness mirror (verifyProvenanceLeaves over
// valid_leaves = C_0 ∪ authorized cmints) and the canonical scan's foldBurnDepositTx — which, when the
// provenance verifies, folds fold_spent → fold_note_append → fold_burn (onboarding the proven-real note as a
// pool member so the Ethereum OP_BRIDGE_MINT binds v_mint == v_burn), and otherwise folds nothing.
//
// This exercises the WIRING (indexer → canonical fold) with a controllable mirror; the mirror's real crypto
// is covered by tests/burn-deposit-provenance.mjs + the in-zkVM native-exec (tests/gen-reflection-burn-deposit.mjs).
//
// Run: node tests/confidential-burn-deposit-wiring.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { makeBurnDepositAssembler } from '../dapp/burn-deposit-assembler.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const dsha256 = (b) => sha256(sha256(b));
const cat = (arrs) => { const t = arrs.reduce((n, a) => n + a.length, 0); const o = new Uint8Array(t); let off = 0; for (const a of arrs) { o.set(a, off); off += a.length; } return o; };
const bytesToHex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const deps = { secp, keccak256: keccak_256, sha256 };

let failures = 0;
const ok = (c, msg) => { if (c) console.log(`ok   ${msg}`); else { console.error(`FAIL ${msg}`); failures++; } };
const eq = (a, b, msg) => ok(a === b, `${msg}${a === b ? '' : ` (got ${a} exp ${b})`}`);

const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const dtx = (b) => '0x' + b.toString(16).padStart(2, '0') + 'ff'.repeat(31); // display-order txid
const reverseHex = (h) => h.replace(/^0x/, '').match(/../g).reverse().join('');
const internalTxid = (display) => '0x' + reverseHex(display);
const ZERO_OWNER = '0x' + '00'.repeat(32);
const hx32 = (x) => '0x' + BigInt(x).toString(16).padStart(64, '0');
const affine = (p) => { const a = p.toAffine(); return { cx: hx32(a.x), cy: hx32(a.y) }; };
const P1 = affine(secp.ProjectivePoint.BASE);
const P2 = affine(secp.ProjectivePoint.BASE.multiply(2n));
const G = '0x' + Buffer.from(secp.ProjectivePoint.BASE.toRawBytes(true)).toString('hex'); // a real compressed point
const coinbase = '0x' + '00'.repeat(120);
const mined = (b) => ({
  blockTxids: [Buffer.alloc(32, 0), Buffer.alloc(32, b)],
  blockWtxids: [Buffer.alloc(32, 0), Buffer.alloc(32, b ^ 0xff)],
  coinbase,
  index: 1,
});

const assetId = v(0xa55e7);
const burned = { cx: v(0xb1), cy: v(0xb2) };
const ETCH_TXID_INT = v(0xe7c4);
const MINT_AUTH = v(0xa17ce);
const CMINT_LEAF = [v(0xc31), v(0xc32)]; // [outpoint, commitmentHash] the cmint mirror returns

// A holder-traced provenance bundle (synthetic; the mirror is stubbed so the lineage content is opaque here).
const mkBundle = (cmints = []) => ({
  assetId,
  nu: v(0x17ad),
  dest: v(0xde57),
  burned,
  burnedInput: { prevTxid: v(0xb117), prevVout: 0 },
  etch: { tx: 'aa'.repeat(40), ...mined(0xe7) },
  provHeaders: ['0x' + '00'.repeat(80)],
  cxfers: [{ txid: dtx(0x0a), inputs: [{ prevTxid: dtx(0x0b), prevVout: 0, commitment: G }], outputs: [{ commitment: G, vout: 0 }], rangeProof: '0x', kernelSig: '0x' + '11'.repeat(64), ...mined(0x0a) }],
  cmints,
});

// A burnDepositKit whose mirror returns a fixed verdict + records the valid_leaves it was handed.
function makeKit(verdict) {
  const seen = { leaves: null, cmintCalls: 0 };
  return {
    seen,
    kit: {
      assembler: makeBurnDepositAssembler({ dsha256, cat, bytesToHex }),
      parseEtchAnchor: () => ({ c0Compressed: G, mintAuthority: MINT_AUTH }),
      computeTxidInternal: () => ETCH_TXID_INT,
      mirror: {
        verifyCmintAuthorized: () => { seen.cmintCalls++; return [...CMINT_LEAF]; },
        verifyProvenanceLeaves: (asset, leaves) => { seen.leaves = leaves; return verdict; },
      },
    },
  };
}

// A scanned block with a single 0x2B burn of a note NOT in the live set (→ the burn-deposit branch).
const burnBlock = (txidDisplay) => ({ txs: [{ txidDisplay, rawHex: 'bb'.repeat(40), vins: [{ prevTxidDisplay: dtx(0xb1), vout: 0 }], decode: { type: 'burn', assetId, nullifier: v(0x17ad), dest: v(0xde57) } }] });

// ── 1. A VALID burn-deposit folds: note onboarded (poolRoot/noteCount advance), ν spent, burn recorded. ──
{
  const { kit, seen } = makeKit(true);
  const idx = makeScanReflectionIndexer({ ...deps, burnDepositKit: kit });
  const before = idx.state().counts();
  const tx0 = dtx(0x20);
  const input = await idx.assembleBlocks([burnBlock(tx0)], { headers: ['0x' + '00'.repeat(80)], anchorHeight: 700, burnDeposits: new Map([[tx0, mkBundle()]]) });
  const after = idx.state().counts();
  const bd = input.blocks[0].txs[0].burnDeposit;
  ok(bd != null, 'valid: a burnDeposit witness is emitted');
  ok(bd && bd.spentInsert && bd.spentInsert.sLowPath.length === 32, 'valid: real spent-insert witness');
  ok(bd && Array.isArray(bd.notePath) && bd.notePath.length === 32, 'valid: note-append path witnessed');
  ok(bd && bd.burnInsert && bd.burnInsert.bLowPath.length === 32, 'valid: real burn-insert witness');
  eq(after.note, before.note + 1, 'valid: the burned note is appended to the pool tree (noteCount +1)');
  eq(after.spent, before.spent + 1, 'valid: ν nullified in the shared spent set');
  eq(after.burn, before.burn + 1, 'valid: bridge-out ν → dest recorded in the burn set');
  eq(seen.leaves.length, 1, 'fixed-supply: valid_leaves = [C_0] only (no cmints)');
}

// ── 2. An INVALID burn-deposit folds NOTHING: witness present (stream sync), state unchanged. ──
{
  const { kit } = makeKit(false);
  const idx = makeScanReflectionIndexer({ ...deps, burnDepositKit: kit });
  const before = idx.state().counts();
  const rootsBefore = idx.roots(); // { poolRoot, spentRoot, burnRoot, height } — only height should move
  const tx0 = dtx(0x30);
  const input = await idx.assembleBlocks([burnBlock(tx0)], { headers: ['0x' + '00'.repeat(80)], anchorHeight: 701, burnDeposits: new Map([[tx0, mkBundle()]]) });
  const after = idx.state().counts();
  const rootsAfter = idx.roots();
  const bd = input.blocks[0].txs[0].burnDeposit;
  ok(bd != null, 'invalid: a burnDeposit witness is STILL emitted (the guest reads it then skips)');
  eq(bd.spentInsert.sLowValue, '0x' + '00'.repeat(32), 'invalid: spent-insert is the zero placeholder');
  eq(after.note, before.note, 'invalid: no note appended');
  eq(after.spent, before.spent, 'invalid: no ν nullified');
  eq(after.burn, before.burn, 'invalid: no burn recorded');
  eq(rootsAfter.poolRoot, rootsBefore.poolRoot, 'invalid: poolRoot unchanged (no note folded)');
  eq(rootsAfter.spentRoot, rootsBefore.spentRoot, 'invalid: spentRoot unchanged');
  eq(rootsAfter.burnRoot, rootsBefore.burnRoot, 'invalid: burnRoot unchanged');
}

// ── 3. MINTABLE: a cmint in the bundle is authorized into valid_leaves = C_0 ∪ {cmint}. ──
{
  const { kit, seen } = makeKit(true);
  const idx = makeScanReflectionIndexer({ ...deps, burnDepositKit: kit });
  const tx0 = dtx(0x40);
  const cmints = [{ revealTx: 'cc'.repeat(60), commitTx: 'dd'.repeat(30), ...mined(0xcc) }];
  await idx.assembleBlocks([burnBlock(tx0)], { headers: ['0x' + '00'.repeat(80)], anchorHeight: 702, burnDeposits: new Map([[tx0, mkBundle(cmints)]]) });
  eq(seen.cmintCalls, 1, 'mintable: verifyCmintAuthorized called once for the cmint');
  eq(seen.leaves.length, 2, 'mintable: valid_leaves = [C_0, authorized cmint]');
  eq(seen.leaves[1][0], CMINT_LEAF[0], 'mintable: the cmint leaf outpoint is admitted');
}

// ── 4. Restart durability: after a valid burn-deposit fold, a snapshot round-trip reconstructs the digest. ──
{
  const { kit } = makeKit(true);
  const idx = makeScanReflectionIndexer({ ...deps, burnDepositKit: kit });
  const tx0 = dtx(0x50);
  await idx.assembleBlocks([burnBlock(tx0)], { headers: ['0x' + '00'.repeat(80)], anchorHeight: 703, burnDeposits: new Map([[tx0, mkBundle()]]) });
  const digest = idx.digest();
  const restored = makeScanReflectionIndexer({ ...deps, burnDepositKit: kit });
  restored.load(idx.snapshot());
  eq(restored.digest(), digest, 'snapshot round-trip reconstructs the post-burn-deposit digest');
}

// ── 5. A 0x2B burn of a non-live note with NO bundle: no throw, an empty-provenance skip witness is
//      emitted (the guest reads + folds nothing), state advances only height. Closes the liveness hazard
//      where a bundle-less burn would otherwise wedge the attestation cycle. ──
{
  const { kit } = makeKit(true);
  const idx = makeScanReflectionIndexer({ ...deps, burnDepositKit: kit });
  const before = idx.state().counts();
  const rootsBefore = idx.roots();
  const tx0 = dtx(0x60);
  let input, threw = false;
  try { input = await idx.assembleBlocks([burnBlock(tx0)], { headers: ['0x' + '00'.repeat(80)], anchorHeight: 704 /* no burnDeposits */ }); }
  catch { threw = true; }
  ok(!threw, 'no-bundle: assembleBlocks does not throw on a bundle-less burn-deposit');
  const bd = input && input.blocks[0].txs[0].burnDeposit;
  ok(bd != null, 'no-bundle: an empty-provenance skip witness is emitted');
  eq((bd && bd.provHeaders.length) ?? -1, 0, 'no-bundle: skip witness carries empty provenance');
  const after = idx.state().counts();
  eq(after.note, before.note, 'no-bundle: no note appended');
  eq(after.spent, before.spent, 'no-bundle: no ν nullified');
  eq(after.burn, before.burn, 'no-bundle: no burn recorded');
  eq(idx.roots().poolRoot, rootsBefore.poolRoot, 'no-bundle: poolRoot unchanged (folds nothing)');
}

// ── 6. A burn envelope with MULTIPLE live-note spends is skip-not-panic: those spends are still
//      nullified, but no bridge-out burn witness and no burn-deposit witness are emitted. ──
{
  const idx = makeScanReflectionIndexer(deps);
  const pool = idx.pool;
  const seedLive = (displayTxid, vout, point) => {
    const outpoint = pool.outpointKey(internalTxid(displayTxid), vout);
    idx.state().foldOutput(pool.leaf(assetId, point.cx, point.cy, ZERO_OWNER), outpoint, pool.commitmentHash(point.cx, point.cy), assetId);
    idx.coords().set(outpoint.toLowerCase(), point);
  };
  const ptx1 = dtx(0x71), ptx2 = dtx(0x72);
  seedLive(ptx1, 0, P1);
  seedLive(ptx2, 0, P2);
  const before = idx.state().counts();
  const tx0 = dtx(0x73);
  let input, threw = false;
  try {
    input = await idx.assembleBlocks([{ txs: [{
      txidDisplay: tx0,
      rawHex: 'ee'.repeat(40),
      vins: [{ prevTxidDisplay: ptx1, vout: 0 }, { prevTxidDisplay: ptx2, vout: 0 }],
      decode: { type: 'burn', assetId, nullifier: pool.nullifier(P1.cx, P1.cy), dest: v(0xde57) },
    }] }], { headers: ['0x' + '00'.repeat(80)], anchorHeight: 705 });
  } catch { threw = true; }
  ok(!threw, 'multi-live burn: assembleBlocks does not throw');
  const tx = (input && input.blocks[0].txs[0]) || { openings: [], spentInserts: [], burnInsert: 'missing', burnDeposit: 'missing' };
  eq(tx.openings.length, 2, 'multi-live burn: both live spends are detected');
  eq(tx.spentInserts.length, 2, 'multi-live burn: both live spends get spent-set witnesses');
  eq(tx.burnInsert, null, 'multi-live burn: no burn-set insert is emitted');
  eq(tx.burnDeposit, null, 'multi-live burn: no burn-deposit witness is emitted');
  const after = idx.state().counts();
  eq(after.live, before.live - 2, 'multi-live burn: live set drops both notes');
  eq(after.spent, before.spent + 2, 'multi-live burn: spent set records both νs');
  eq(after.burn, before.burn, 'multi-live burn: burn set unchanged');
}

// ── 7. A single live spend whose ν does NOT match the burn envelope is also skip-not-panic:
//      the spend is nullified, but there is no ν → dest bridge-out record. ──
{
  const idx = makeScanReflectionIndexer(deps);
  const pool = idx.pool;
  const ptx = dtx(0x81);
  const outpoint = pool.outpointKey(internalTxid(ptx), 0);
  idx.state().foldOutput(pool.leaf(assetId, P1.cx, P1.cy, ZERO_OWNER), outpoint, pool.commitmentHash(P1.cx, P1.cy), assetId);
  idx.coords().set(outpoint.toLowerCase(), P1);
  const before = idx.state().counts();
  const input = await idx.assembleBlocks([{ txs: [{
    txidDisplay: dtx(0x82),
    rawHex: 'ef'.repeat(40),
    vins: [{ prevTxidDisplay: ptx, vout: 0 }],
    decode: { type: 'burn', assetId, nullifier: v(0xbad), dest: v(0xde57) },
  }] }], { headers: ['0x' + '00'.repeat(80)], anchorHeight: 706 });
  const tx = input.blocks[0].txs[0];
  eq(tx.openings.length, 1, 'mismatched burn: one live spend is detected');
  eq(tx.spentInserts.length, 1, 'mismatched burn: the live spend gets a spent-set witness');
  eq(tx.burnInsert, null, 'mismatched burn: no burn-set insert is emitted');
  eq(tx.burnDeposit, null, 'mismatched burn: no burn-deposit witness is emitted');
  const after = idx.state().counts();
  eq(after.live, before.live - 1, 'mismatched burn: live set drops the spent note');
  eq(after.spent, before.spent + 1, 'mismatched burn: spent set records the ν');
  eq(after.burn, before.burn, 'mismatched burn: burn set unchanged');
}

console.log(failures ? `\n${failures} FAILURES` : '\nall burn-deposit wiring checks passed');
process.exit(failures ? 1 : 0);
