#!/usr/bin/env node
// Full-scan reflection attester ↔ burn-deposit injection seam: makeScanReflectionAttester threads a
// burnDepositKit into the scan indexer and looks up holder-submitted provenance bundles (by the burn's
// display txid) for the batch, so a 0x2B burn of a PRE-existing (never-reflected) TAC note is assembled
// into the prover input. The kit's real crypto is covered by tests/burn-deposit-provenance.mjs + the
// in-zkVM native-exec (tests/gen-reflection-burn-deposit.mjs) + the indexer wiring by
// tests/confidential-burn-deposit-wiring.mjs; THIS test exercises the attester-level plumbing:
//   1. kit + bundle wired  → the burn-deposit witness flows through assembleJob into job.input.
//   2. no kit (gate)       → getBurnDeposits is never consulted, so the indexer never sees a bundle
//                            without its verifier (which would throw); the burn carries no witness.
//   4. unregistered burn   → recorded pending, never blocks the batch.
//   5. late registration   → the next batch completes the pending deposit.
//
// Run: node tests/confidential-reflection-attest-burndeposit.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeScanReflectionAttester } from '../worker/src/reflection-attest.js';
import { makeBurnDepositAssembler } from '../dapp/burn-deposit-assembler.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const dsha256 = (b) => sha256(sha256(b));
const cat = (arrs) => { const t = arrs.reduce((n, a) => n + a.length, 0); const o = new Uint8Array(t); let off = 0; for (const a of arrs) { o.set(a, off); off += a.length; } return o; };
const bytesToHex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const deps = { secp, keccak256: keccak_256, sha256 };

let failures = 0;
const ok = (c, msg) => { if (!c) { console.error(`FAIL ${msg}`); failures++; } else console.log(`ok   ${msg}`); };
const eq = (a, b, msg) => ok(a === b, `${msg}${a === b ? '' : ` (got ${a} exp ${b})`}`);

const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const dtx = (b) => '0x' + b.toString(16).padStart(2, '0') + 'ff'.repeat(31); // display-order txid
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

// A holder-traced provenance bundle (synthetic; the stub mirror makes the lineage content opaque here).
const mkBundle = () => ({
  assetId,
  nu: v(0x17ad),
  dest: v(0xde57),
  target: v(0x7c7c7c),
  burned,
  burnedInput: { prevTxid: v(0xb117), prevVout: 0 },
  etch: { tx: 'aa'.repeat(40), ...mined(0xe7) },
  provHeaders: ['0x' + '00'.repeat(80)],
  cxfers: [{ txid: dtx(0x0a), tx: '0x' + 'cc'.repeat(60), inputs: [{ prevTxid: dtx(0x0b), prevVout: 0, commitment: G }], outputs: [{ commitment: G, vout: 0 }], rangeProof: '0x', kernelSig: '0x' + '11'.repeat(64), ...mined(0x0a) }],
  cmints: [],
});

// A burnDepositKit whose admission returns a fixed verdict (the real admission: tests/burn-deposit-admission.mjs).
const makeKit = (verdict) => ({
  assembler: makeBurnDepositAssembler({ dsha256, cat, bytesToHex }),
  admitBurnDeposit: () => ({ admitted: verdict, reason: 'stub', burnedTxid: null, burnedVout: 0, burnedNoteLeaf: v(0x1eaf) }),
});
const TARGET = v(0x7c7c7c);

// A scanned block at the genesis height with a single 0x2B burn of a note NOT in the live set
// (→ the burn-deposit branch). The bundle is keyed by this tx's display txid.
const BURN_TXID = dtx(0x20);
const burnBlock = { txs: [
  { txidDisplay: dtx(0x01), rawHex: coinbase, vins: [], decode: null },
  { txidDisplay: BURN_TXID, rawHex: 'bb'.repeat(40), vins: [{ prevTxidDisplay: dtx(0xb1), vout: 0 }], decode: { type: 'burn', assetId, nullifier: v(0x17ad), dest: v(0xde57), target: TARGET } },
] };

// A plain (non-burn) tx block — exercises the safety gate without tripping the pre-existing burn-of-
// non-live-note panic (see test 4): no kit ⇒ getBurnDeposits must not be consulted, assembly still works.
const plainBlock = { txs: [{ txidDisplay: dtx(0x77), rawHex: 'cc'.repeat(40), vins: [{ prevTxidDisplay: dtx(0x88), vout: 0 }], decode: null }] };

const getHeaders = async (heights) => heights.map((h) => '0x' + h.toString(16).padStart(2, '0').repeat(40));
const GENESIS = 700;

// getBurnDeposits keyed by the burn's display txid (mirrors the worker's KV lookup).
let bundleLookups = 0;
const getBurnDeposits = async (txids) => {
  bundleLookups++;
  const map = new Map();
  for (const t of txids) if (t === BURN_TXID) map.set(t, mkBundle());
  return map;
};

const freshStore = () => { let store = null; return { load: async () => store, save: async (s) => { store = JSON.parse(JSON.stringify(s)); } }; };

const run = async () => {
  // ── 1. kit + bundle wired → the burn-deposit witness flows through assembleJob ──
  {
    bundleLookups = 0;
    const att = makeScanReflectionAttester({
      deps, storage: freshStore(), prove: async () => ({}), submit: async () => '0x',
      getBlockTxs: async () => burnBlock, getHeaders, genesisHeight: GENESIS, burnDepositKit: makeKit(true), getBurnDeposits,
    });
    await att.setTip(GENESIS + 1);
    const job = await att.assembleJob();
    ok(job != null, 'wired: a job is assembled for the genesis block');
    ok(bundleLookups === 1, 'wired: holder bundles looked up once for the batch txids');
    const bd = job.input.blocks[0].txs[1].burnDeposit;
    ok(bd != null, 'wired: the burn-deposit witness is emitted into the prover input');
    ok(bd && bd.spentInsert && bd.spentInsert.sLowPath.length === 32, 'wired: real spent-insert witness (valid → folds)');
    eq(job.newSnapshot.noteLeaves.length, 1, 'wired: the admitted burned note is appended to the note tree');
    ok(bd && Array.isArray(bd.notePath) && bd.notePath.length === 32, 'wired: note-append path witnessed');
    ok(bd && bd.burnInsert && bd.burnInsert.bLowPath.length === 32, 'wired: real burn-insert witness');
  }

  // ── 2. invalid provenance → witness still emitted (stream sync) but the zero placeholder (folds nothing) ──
  {
    const att = makeScanReflectionAttester({
      deps, storage: freshStore(), prove: async () => ({}), submit: async () => '0x',
      getBlockTxs: async () => burnBlock, getHeaders, genesisHeight: GENESIS, burnDepositKit: makeKit(false), getBurnDeposits,
    });
    await att.setTip(GENESIS + 1);
    const job = await att.assembleJob();
    const bd = job.input.blocks[0].txs[1].burnDeposit;
    ok(bd != null, 'invalid: a witness is STILL emitted (guest reads then skips)');
    eq(bd.spentInsert.sLowValue, '0x' + '00'.repeat(32), 'invalid: spent-insert is the zero placeholder (no fold)');
  }

  // ── 3. SAFETY GATE: no kit → getBurnDeposits is never consulted, normal assembly is unaffected. ──
  {
    bundleLookups = 0;
    const att = makeScanReflectionAttester({
      deps, storage: freshStore(), prove: async () => ({}), submit: async () => '0x',
      getBlockTxs: async () => plainBlock, getHeaders, genesisHeight: GENESIS, /* no burnDepositKit */ getBurnDeposits,
    });
    await att.setTip(GENESIS + 1);
    let job, threw = false;
    try { job = await att.assembleJob(); } catch { threw = true; }
    ok(!threw, 'no-kit: a plain-tx batch assembles without consulting the kit');
    eq(bundleLookups, 0, 'no-kit: getBurnDeposits is never consulted (kit-gated)');
  }

  // ── 4. An unregistered 0x2B burn of a non-live note never blocks the batch (anyone can broadcast a junk 161-byte
  //      0x2B): the guest records it in the pending set, and so does the assembler. It is reported for alerting. ──
  const noBundle = async () => new Map();
  {
    const att = makeScanReflectionAttester({
      deps, storage: freshStore(), prove: async () => ({}), submit: async () => '0x',
      getBlockTxs: async () => burnBlock, getHeaders, genesisHeight: GENESIS,
      burnDepositKit: makeKit(true), getBurnDeposits: noBundle,
    });
    await att.setTip(GENESIS + 1);
    let job, threw = false;
    try { job = await att.assembleJob(); } catch { threw = true; }
    ok(!threw, 'unregistered burn: the batch is not refused');
    ok(job && job.pendingBurnDeposits.length === 1 && job.pendingBurnDeposits[0].height === GENESIS + 1, 'unregistered burn: reported with its height');
    const bd = job && job.input.blocks[0].txs[1].burnDeposit;
    eq(bd && bd.blob, '0x', 'unregistered burn: empty blob (the guest does not verify it)');
    ok(bd && bd.pendingInsert && bd.pendingInsert.pLowPath.length === 32 && bd.pendingInsert.pNewPath.length === 32, 'unregistered burn: a real pending-insert witness is emitted');
    eq(job && job.newSnapshot.pendingDepositNodes.length, 2, 'unregistered burn: the pending set holds it (count 2)');
    eq(job && job.newSnapshot.noteLeaves.length, 0, 'unregistered burn: nothing is onboarded');
  }

  // ── 5. A bundle registered after the burn's block was attested completes the pending deposit in the next batch. ──
  {
    let registered = false;
    const lookups = [];
    const lateBundles = async (txids) => {
      lookups.push(txids);
      const map = new Map();
      if (registered) for (const t of txids) if (t === BURN_TXID) map.set(t, mkBundle());
      return map;
    };
    const att = makeScanReflectionAttester({
      deps, storage: freshStore(), prove: async () => ({}), submit: async () => '0x',
      getBlockTxs: async (h) => (h === GENESIS + 1 ? burnBlock : plainBlock), getHeaders, genesisHeight: GENESIS, batchSize: 1,
      burnDepositKit: makeKit(true), getBurnDeposits: lateBundles,
    });
    await att.setTip(GENESIS + 3);
    const j1 = await att.assembleJob();
    eq(j1.input.depositCompletions.length, 0, 'late bundle: nothing to complete while unregistered');
    await att.ackJob(j1.attestedTo, j1.newSnapshot);
    registered = true;
    const j2 = await att.assembleJob();
    ok(lookups[lookups.length - 1].includes(BURN_TXID), 'late bundle: the pending burn txid is looked up with the next batch');
    eq(j2.input.depositCompletions.length, 1, 'late bundle: the next batch emits one completion');
    const c = j2.input.depositCompletions[0];
    ok(c && c.pendingPath.length === 32 && c.deposit.spentInsert.sLowPath.length === 32 && c.deposit.burnInsert.bLowPath.length === 32, 'late bundle: membership + deposit witnesses');
    ok(c && c.deposit.blob && c.deposit.blob !== '0x' && c.deposit.burnWtxidSiblings === undefined, 'late bundle: the completion carries the blob and no burn-tx witness siblings');
    eq(j2.newSnapshot.noteLeaves.length, 1, 'late bundle: the burned note is onboarded');
    eq(j2.completedBurnDeposits.length, 1, 'late bundle: reported as completed');
    ok(j2.input.newDigest !== j1.input.newDigest, 'late bundle: the digest moves');
    await att.ackJob(j2.attestedTo, j2.newSnapshot);
    const j3 = await att.assembleJob();
    eq(j3.input.depositCompletions.length, 0, 'late bundle: a completed deposit is not completed again');
  }

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nall reflection-attest burn-deposit injection checks passed');
};
run();
