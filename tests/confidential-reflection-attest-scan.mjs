#!/usr/bin/env node
// Full-scan reflection attester (worker orchestration): makeScanReflectionAttester assembles the
// un-attested block range, advances only on ack (so a failed prove/submit is a safe retry), is
// idempotent on a duplicate ack, and resumes from the persisted snapshot. Block fetching is mocked
// (the real getBlockTxs/getHeaders hit esplora); this exercises the cursor/snapshot discipline.
//
// Run: node tests/confidential-reflection-attest-scan.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeScanReflectionAttester } from '../worker/src/reflection-attest.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };

let failures = 0;
const eq = (a, b, msg) => { if (a !== b) { console.error(`FAIL ${msg}\n  got ${a}\n  exp ${b}`); failures++; } else console.log(`ok   ${msg}`); };
const ne = (a, b, msg) => { if (a === b) { console.error(`FAIL ${msg} (should differ)`); failures++; } else console.log(`ok   ${msg}`); };
const ok = (c, msg) => { if (!c) { console.error(`FAIL ${msg}`); failures++; } else console.log(`ok   ${msg}`); };

const commit = (k) => '0x' + Buffer.from(secp.ProjectivePoint.BASE.multiply(BigInt(k)).toRawBytes(true)).toString('hex');
const v = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const dtx = (b) => '0x' + b.toString(16).padStart(2, '0') + 'ff'.repeat(31);
const assetId = v(0xa55e7);

// Mock block data: height 500 = a 2-output CXFER; 501 = a plain spend of output 0; 502 = empty.
const BLOCKS = {
  500: { txs: [{ txidDisplay: dtx(0x10), rawHex: 'aa'.repeat(60), vins: [{ prevTxidDisplay: dtx(0xee), vout: 3 }], decode: { type: 'cxfer', assetId, commitments: [commit(11), commit(22)] } }] },
  501: { txs: [{ txidDisplay: dtx(0x20), rawHex: 'bb'.repeat(40), vins: [{ prevTxidDisplay: dtx(0x10), vout: 0 }], decode: null }] },
  502: { txs: [] },
};
const getBlockTxs = async (h) => BLOCKS[h] || { txs: [] };
const getHeaders = async (heights) => heights.map((h) => '0x' + h.toString(16).padStart(2, '0').repeat(40));

// In-memory KV.
let store = null;
const storage = { load: async () => store, save: async (s) => { store = JSON.parse(JSON.stringify(s)); } };

let proveCalls = 0, submitCalls = 0;
const prove = async (input) => { proveCalls++; return { vkey: '0xvk', publicValues: '0xpv', proofBytes: '0xpf:' + input.newDigest }; };
const submit = async () => { submitCalls++; return '0xtxhash'; };

const att = makeScanReflectionAttester({ deps, storage, prove, submit, getBlockTxs, getHeaders, genesisHeight: 500 });

const run = async () => {
  // nothing confirmed yet → no job
  eq(await att.assembleJob(), null, 'no tip → no job');

  // confirm up to height 501
  await att.setTip(501);
  const job = await att.assembleJob();
  ok(job && job.blocks === 2, 'assembleJob covers blocks 500..501');
  eq(job.input.anchorHeight, 500, 'anchorHeight = first un-attested height');
  ok(job.input.blocks[1].txs[0].openings.length === 1, 'block 501 plain spend detected in the job');

  // assembleJob did NOT advance the persisted anchor (still pre-genesis) — only ack does.
  eq((await att.loadState()).attestedHeight, 499, 'anchor not advanced before ack');
  // re-assembling yields the same job (idempotent until ack) — same newDigest.
  const job2 = await att.assembleJob();
  eq(job2.input.newDigest, job.input.newDigest, 'pre-ack re-assemble is deterministic');

  // ack advances the snapshot + cursor.
  await att.ackJob(job.attestedTo, job.newSnapshot);
  eq((await att.loadState()).attestedHeight, 501, 'ack advanced the anchor to 501');
  // a stale/duplicate ack is a no-op.
  await att.ackJob(400, job.newSnapshot);
  eq((await att.loadState()).attestedHeight, 501, 'stale ack is a no-op');

  // next cycle: tip still 501 → caught up.
  eq(await att.assembleJob(), null, 'caught up → no job');

  // a new block 502 (empty) advances the tip; the job resumes from the persisted snapshot (prior
  // == the attested digest), proving the snapshot anchor survives a restart-shaped reload.
  await att.setTip(502);
  const job3 = await att.assembleJob();
  ok(job3 && job3.input.anchorHeight === 502, 'next job resumes at 502');
  eq(job3.input.prior.liveCount, 1, 'prior reflects the post-501 state (output1 still live)');

  // runCycle: prove + submit + ack in one shot.
  const res = await att.runCycle();
  ok(res && res.attestedTo === 502, 'runCycle attested through 502');
  eq(proveCalls, 1, 'runCycle proved once');
  eq(submitCalls, 1, 'runCycle submitted once');
  eq((await att.loadState()).attestedHeight, 502, 'runCycle advanced the anchor');
  eq(await att.runCycle(), null, 'runCycle no-op when caught up');

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nall full-scan attester checks passed');
};
run();
