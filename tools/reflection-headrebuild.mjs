// Rebuild + VERIFY the reflection head snapshot (c54cebed) box-free, resuming from the
// reconstructed 958162 state (modeb-kv.json, digest 7dc45a5c). Applies the 20-TAC crossout
// Mode-B bundle at EXACTLY height 958163, forward-folds the rest one block at a time, and stops
// the instant a batch's newDigest equals the on-chain head. Writes the seed candidate ONLY on match.
//   in:  scratchpad/modeb-kv.json  (state @958162, from modeb-reconstruct.mjs)
//   out: scratchpad/head-snapshot.json  (KV value to seed) — only if digest matches c54cebed

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { buildScanReflectionAttester } from '../worker/src/reflection-attest.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { readFileSync, writeFileSync } from 'node:fs';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const deps = { secp, keccak256: keccak_256, sha256, swapBatchVk: SWAP_BATCH_VK };

const SCRATCH = '/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad';
const STATE_FILE = `${SCRATCH}/modeb-kv.json`;
const KEY = 'reflection:scan:mainnet';
const MODEB_HEIGHT = 958163;
const TARGET_DIGEST = (process.env.TARGET_DIGEST || '0xc54cebeda7022277bb405288308e6f81f83f2add96ec2052f9a8ca75bdc96ebb').toLowerCase();
const MAX_HEIGHT = parseInt(process.env.MAX_HEIGHT || '958420', 10);
const ESPLORAS = (process.env.ESPLORA || 'https://blockstream.info/api,https://mempool.space/api').split(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tryFetch(path, bin) {
  let e;
  for (let a = 0; a < 8; a++) {
    const base = ESPLORAS[a % ESPLORAS.length];
    try { const r = await fetch(base + path); if (!r.ok) throw new Error(`${base}${path} ${r.status}`); return bin ? new Uint8Array(await r.arrayBuffer()) : await r.text(); }
    catch (x) { e = x; await sleep(600 * (a + 1)); }
  }
  throw e;
}
async function api(_e, p) { const t = await tryFetch(p, false); await sleep(15); return t; }
async function apiRawBytes(_e, p) { const b = await tryFetch(p, true); await sleep(15); return b; }

const fileKV = {
  get: async (k) => { try { return (JSON.parse(readFileSync(STATE_FILE, 'utf8')))[k] ?? null; } catch { return null; } },
  put: async (k, v) => { let o = {}; try { o = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {} o[k] = v; writeFileSync(STATE_FILE, JSON.stringify(o)); },
};

// The 20-TAC crossout Mode-B bundle — applied ONLY at height 958163.
const ethSet = JSON.parse(readFileSync('/Users/z/tacit-critical-backup/seed-rebuild/ethset-out/eth_set.json', 'utf8'));
const ethBundle = { ethPv: ethSet.ethPv, crossouts: ethSet.crossouts, consumeds: ethSet.consumeds };
const consumedSources = [{
  nu: '0xaf9445828765e1ce0405f98e7a2f55bf816e8b90487283b24a54ab5023afae0a',
  cx: '0x586530c01fab4e77776c89cd8da03ffd7ca48c0611be8b3bfd73b41502a1df71',
  cy: '0x994677c780bbb2595d6c44e1d5b5f1ea6ccc770a154412defa1159c9e820a2a8',
  srcTxid: '0x0717ac496a7f56cbd4c3ff7902470f0691e420a20f960edace331149a8fd572a',
  srcVout: 1,
}];
// 958163 carries the consumed-ν (source consumption) with consumedSources. Every forward batch
// carries a bundle with the crossouts (→ crossoutImt for foldCrossout to match the mint cxfer)
// but EMPTY consumeds (that consumption already happened at 958163, so no source to re-resolve).
const ethBundleFwd = { ethPv: ethSet.ethPv, crossouts: ethSet.crossouts, consumeds: [] };
const ethBundleSource = async ({ from, to }) =>
  (from <= MODEB_HEIGHT && to >= MODEB_HEIGHT) ? { ethBundle, consumedSources } : { ethBundle: ethBundleFwd };

async function main() {
  const st = JSON.parse(await fileKV.get(KEY));
  console.log(`resuming @${st.attestedHeight} (expect 958162 / 7dc45a5c)`);
  const env = { REFLECTION_ATTEST: '1', REFLECTION_GENESIS_HEIGHT: '958151', REFLECTION_BATCH_SIZE: '1', REGISTRY_KV: fileKV };
  let envThisBlock = [];
  const classifyTx = ({ rawHex }) => { const d = classifyConfidentialTx(rawHex); if (d) envThisBlock.push(d.type || d.kind || 'env'); return d; };
  const att = buildScanReflectionAttester(env, { deps, api, apiRawBytes, network: 'mainnet', classifyTx, ethBundleSource });
  await att.setTip(MAX_HEIGHT);

  let last = null, matched = false;
  for (let i = 0; i < (MAX_HEIGHT - st.attestedHeight) + 2; i++) {
    envThisBlock = [];
    const job = await att.assembleJob();
    if (!job) { console.log('caught up to tip, no match'); break; }
    const nd = String(job.input.newDigest).toLowerCase();
    const mb = job.input.modeB ? ' [MODE-B]' : '';
    const envs = envThisBlock.length ? `  ***ENVELOPES: ${JSON.stringify(envThisBlock)}` : '';
    console.log(`  h=${job.attestedTo} newDigest=${nd}${mb}${envs}`);
    await att.ackJob(job.attestedTo, job.newSnapshot);
    last = { height: job.attestedTo, snapshot: job.newSnapshot };
    if (nd === TARGET_DIGEST) { matched = true; break; }
  }

  if (!matched) { console.log(`\n❌ NO MATCH up to ${last?.height}. Extra Mode-B point between 958164..${last?.height}, or a lineage gap. Do NOT seed.`); process.exit(2); }
  const kvState = { attestedHeight: last.height, tipHeight: last.height, snapshot: last.snapshot };
  writeFileSync(`${SCRATCH}/head-snapshot.json`, JSON.stringify({ 'reflection:scan:mainnet': kvState }, null, 0));
  console.log(`\n✅ HEAD MATCH at h=${last.height} == ${TARGET_DIGEST}`);
  console.log(`   seed candidate: ${SCRATCH}/head-snapshot.json`);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
