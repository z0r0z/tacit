// Regenerate + VERIFY the head reflection snapshot for the live pool, with NO prove/attest and
// NO on-chain or KV writes. Folds forward from the saved 958163 snapshot one block at a time using
// the worker's own indexer, and stops the instant a batch's newDigest equals the pool's on-chain
// reflection digest. That both (a) reconstructs the head snapshot the Render worker must be seeded
// with, and (b) proves it is correct (digest match) before anything is ever written.
//
//   TARGET_DIGEST  — the pool's on-chain knownReflectionDigest (slot 80)
//   FROM_SNAPSHOT  — reflected-state-958163-CORRECTED.json (KV dump {reflection:scan:mainnet: {...}})
//   out: writes tools/.regen/head-snapshot.json (the seed candidate) ONLY on digest match.

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { buildScanReflectionAttester } from '../worker/src/reflection-attest.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const deps = { secp, keccak256: keccak_256, sha256 };

const ESPLORA = process.env.ESPLORA || 'https://mempool.space/api';
const TARGET_DIGEST = (process.env.TARGET_DIGEST || '0xc54cebeda7022277bb405288308e6f81f83f2add96ec2052f9a8ca75bdc96ebb').toLowerCase();
const GENESIS_HEIGHT = parseInt(process.env.GENESIS_HEIGHT || '957443', 10); // only used to build the attester; fold starts from the persisted snapshot
const FROM_FILE = process.env.FROM_FILE || '/Users/z/tacit-critical-backup/seed-rebuild/reflected-state-958163-CORRECTED.json';
const MAX_HEIGHT = parseInt(process.env.MAX_HEIGHT || '958800', 10); // safety ceiling for the forward walk
const OUT_DIR = new URL('./.regen/', import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(path, kind) {
  let err;
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(ESPLORA + path);
      if (!r.ok) throw new Error(`esplora ${path} -> ${r.status}`);
      return kind === 'raw' ? new Uint8Array(await r.arrayBuffer()) : await r.text();
    } catch (e) { err = e; await sleep(500 * (a + 1) + Math.floor(300 * (a + 1))); } // backoff on terminated/429
  }
  throw err;
}
async function api(_env, path) { const t = await fetchRetry(path, 'text'); await sleep(120); return t; }
async function apiRawBytes(_env, path) { const b = await fetchRetry(path, 'raw'); await sleep(120); return b; }

// in-memory KV shim (storage.load JSON.parses the value, so values are JSON strings)
function memKV(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); }, _dump: () => Object.fromEntries(m) };
}

function loadSeed() {
  const dump = JSON.parse(readFileSync(FROM_FILE, 'utf8'));
  const v = dump['reflection:scan:mainnet'];
  const value = typeof v === 'string' ? v : JSON.stringify(v);      // storage.load does JSON.parse → must be a string
  const parsed = JSON.parse(value);
  return { value, attestedHeight: parsed.attestedHeight, tipHeight: parsed.tipHeight };
}

async function main() {
  const seed = loadSeed();
  console.log(`from snapshot: attestedHeight=${seed.attestedHeight} tipHeight=${seed.tipHeight}`);
  console.log(`target on-chain digest: ${TARGET_DIGEST}`);

  const kv = memKV({ 'reflection:scan:mainnet': seed.value });
  const env = {
    REFLECTION_ATTEST: '1',
    REFLECTION_GENESIS_HEIGHT: String(GENESIS_HEIGHT),
    REFLECTION_BATCH_SIZE: '1',        // one block per fold so we land EXACTLY on the head height
    REGISTRY_KV: kv,
    REFLECTION_PROVE_URL: 'http://unused.local',
  };
  const att = buildScanReflectionAttester(env, { deps, api, apiRawBytes, network: 'mainnet', classifyTx: ({ rawHex }) => classifyConfidentialTx(rawHex) });
  if (!att) throw new Error('attester build returned null');

  await att.setTip(MAX_HEIGHT);

  let last = null, matched = false;
  for (let i = 0; i < (MAX_HEIGHT - seed.attestedHeight) + 2; i++) {
    const job = await att.assembleJob();
    if (!job) { console.log('caught up to tip without a digest match'); break; }
    const nd = String(job.input.newDigest).toLowerCase();
    const unsup = job.input.unsupportedEnvelopes || [];
    console.log(`  h=${job.attestedTo} newDigest=${nd}${unsup.length ? ` UNSUPPORTED:${unsup.length}` : ''}`);
    await att.ackJob(job.attestedTo, job.newSnapshot);
    last = { height: job.attestedTo, newDigest: nd, snapshot: job.newSnapshot };
    if (nd === TARGET_DIGEST) { matched = true; break; }
  }

  if (!matched) {
    console.log(`\n❌ NO MATCH up to height ${last?.height ?? seed.attestedHeight}. The on-chain head was NOT reached by a pure forward fold — it likely involved a Mode-B (0x65) batch, which needs the reverse assembler. Do NOT seed.`);
    process.exit(2);
  }

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const kvState = { attestedHeight: last.height, tipHeight: last.height, snapshot: last.snapshot };
  writeFileSync(OUT_DIR + 'head-snapshot.json', JSON.stringify({ 'reflection:scan:mainnet': kvState }, null, 0));
  console.log(`\n✅ DIGEST MATCH at height ${last.height} == ${TARGET_DIGEST}`);
  console.log(`   head snapshot written: ${OUT_DIR}head-snapshot.json`);
  console.log(`   seed value = {attestedHeight:${last.height}, tipHeight:${last.height}, snapshot:<...>}`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
