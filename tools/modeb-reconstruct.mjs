import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { buildScanReflectionAttester } from '../worker/src/reflection-attest.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const deps = { secp, keccak256: keccak_256, sha256, swapBatchVk: SWAP_BATCH_VK };
const ESPLORA = process.env.ESPLORA || 'https://mempool.space/api';
const SEED_H = 958151, ONCHAIN_H = 958162;
const ONCHAIN_DIGEST = '0x7dc45a5c2b95ad15bc56a7eccf372a8d4d455dd7716dda4d57947962473ee887';
const STATE_FILE = '/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad/modeb-kv.json';
const KEY = 'reflection:scan:mainnet';

const ESPLORAS = (process.env.ESPLORA || 'https://blockstream.info/api').split(',');
async function tryFetch(path, bin) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const base = ESPLORAS[attempt % ESPLORAS.length];
    try {
      const r = await fetch(base + path);
      if (!r.ok) { lastErr = new Error(`${base}${path} ${r.status}`); await new Promise(z=>setTimeout(z, 800*(attempt+1))); continue; }
      return bin ? new Uint8Array(await r.arrayBuffer()) : await r.text();
    } catch (e) { lastErr = e; await new Promise(z=>setTimeout(z, 800*(attempt+1))); }
  }
  throw lastErr;
}
async function api(_e, path) { return tryFetch(path, false); }
async function apiRawBytes(_e, path) { return tryFetch(path, true); }

const fileKV = {
  get: async (k) => { try { return (JSON.parse(readFileSync(STATE_FILE,'utf8')))[k] ?? null; } catch { return null; } },
  put: async (k,v) => { let o={}; try{o=JSON.parse(readFileSync(STATE_FILE,'utf8'));}catch{} o[k]=v; writeFileSync(STATE_FILE, JSON.stringify(o)); },
};

if (!existsSync(STATE_FILE) || process.env.RESEED) {
  const seed = JSON.parse(readFileSync('/Users/z/tacit-critical-backup/seed-rebuild/newseed-kv.json','utf8'));
  const seedVal = JSON.parse(seed[KEY]);
  const state = { snapshot: seedVal.snapshot, attestedHeight: SEED_H, tipHeight: ONCHAIN_H };
  writeFileSync(STATE_FILE, JSON.stringify({ [KEY]: JSON.stringify(state) }));
  console.log('seeded state @', SEED_H, 'target', ONCHAIN_H);
}

const env = { REFLECTION_ATTEST:'1', REFLECTION_GENESIS_HEIGHT:String(SEED_H), REGISTRY_KV: fileKV };
const att = buildScanReflectionAttester(env, { deps, api, apiRawBytes, network:'mainnet', classifyTx: ({ rawHex }) => classifyConfidentialTx(rawHex) });

await att.setTip(ONCHAIN_H);
let cur = SEED_H;
while (cur < ONCHAIN_H) {
  const job = await att.assembleJob();
  if (!job) { console.log('caught up early at', cur); break; }
  console.log(`folded ${job.input.anchorHeight}..${job.attestedTo} (${job.blocks} blks) newDigest ${job.input.newDigest}`);
  await att.ackJob(job.attestedTo, job.newSnapshot);
  cur = job.attestedTo;
}
// verify final digest
const st = JSON.parse(await fileKV.get(KEY));
const idx = makeScanReflectionIndexer(deps);
idx.load(st.snapshot);
const d = idx.digest(); const got = (d.startsWith('0x')?d:'0x'+d).toLowerCase();
console.log('reconstructed digest @'+st.attestedHeight+':', got);
console.log('on-chain digest        :', ONCHAIN_DIGEST);
console.log(got === ONCHAIN_DIGEST ? 'RECONSTRUCT MATCH ✓ — local state == on-chain @958162' : 'MISMATCH ✗');
