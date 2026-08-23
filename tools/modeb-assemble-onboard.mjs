import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { buildScanReflectionAttester } from '../worker/src/reflection-attest-bigbatch.mjs';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { readFileSync, writeFileSync } from 'node:fs';
const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const deps = { secp, keccak256: keccak_256, sha256, swapBatchVk: SWAP_BATCH_VK };
const STATE_FILE = '/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad/modeb-kv.json';
const KEY = 'reflection:scan:mainnet';
const OUT = '/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad/reflection_input_onboard.json';
const TARGET = 958344;   // fold through the 0x65 mint block
const ESPLORAS = (process.env.ESPLORA || 'https://mempool.space/api,https://blockstream.info/api').split(',');
async function tryFetch(path, bin){let e;for(let a=0;a<8;a++){const base=ESPLORAS[a%ESPLORAS.length];try{const r=await fetch(base+path);if(!r.ok){e=new Error(base+path+' '+r.status);await new Promise(z=>setTimeout(z,700*(a+1)));continue;}return bin?new Uint8Array(await r.arrayBuffer()):await r.text();}catch(x){e=x;await new Promise(z=>setTimeout(z,700*(a+1)));}}throw e;}
async function api(_e,p){return tryFetch(p,false);} async function apiRawBytes(_e,p){return tryFetch(p,true);}
const fileKV = { get: async(k)=>{try{return (JSON.parse(readFileSync(STATE_FILE,'utf8')))[k]??null;}catch{return null;}}, put: async(k,v)=>{let o={};try{o=JSON.parse(readFileSync(STATE_FILE,'utf8'));}catch{} o[k]=v; writeFileSync(STATE_FILE,JSON.stringify(o));} };
const st = JSON.parse(await fileKV.get(KEY));
console.log('resume attestedHeight', st.attestedHeight, '-> target', TARGET);
const idx0=makeScanReflectionIndexer(deps); idx0.load(st.snapshot);
console.log('resume digest', idx0.digest(), '(expect 0x2e0d7a4b...)');
const ethSet = JSON.parse(readFileSync('/Users/z/tacit-critical-backup/seed-rebuild/ethset-out/eth_set.json','utf8'));
const ethBundle = { ethPv: ethSet.ethPv, crossouts: ethSet.crossouts, consumeds: ethSet.consumeds };
// consumed-ν already folded at 958163 (resume state has consumedCount=1); no NEW consumes in this range.
const consumedSources = [];
const env = { REFLECTION_ATTEST:'1', REFLECTION_GENESIS_HEIGHT:'958151', REFLECTION_BATCH_SIZE:'400', REGISTRY_KV: fileKV };
const ethBundleSource = async ({ from, to }) => { console.log('ethBundleSource '+from+'..'+to); return { ethBundle, consumedSources }; };
const att = buildScanReflectionAttester(env, { deps, api, apiRawBytes, network:'mainnet', classifyTx:({rawHex})=>classifyConfidentialTx(rawHex), ethBundleSource });
await att.setTip(TARGET);
const job = await att.assembleJob();
if (!job){ console.log('NO JOB'); process.exit(1); }
console.log('batch', job.input.anchorHeight, '..', job.attestedTo, '('+job.blocks+' blks)');
console.log('priorDigest', job.input.priorDigest || job.input.prior?.digest);
console.log('newDigest  ', job.input.newDigest);
console.log('modeB', !!job.input.modeB, 'foldedCrossoutCount', job.newSnapshot.foldedCrossoutCount);
writeFileSync(OUT, JSON.stringify(job.input));
writeFileSync(OUT+'.snapshot.json', JSON.stringify({ attestedTo: job.attestedTo, newSnapshot: job.newSnapshot }));
console.log('WROTE', OUT, JSON.stringify(job.input).length, 'bytes');
