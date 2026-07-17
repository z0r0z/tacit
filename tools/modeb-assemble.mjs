import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { buildScanReflectionAttester } from '../worker/src/reflection-attest.js';
import { makeScanReflectionIndexer } from '../dapp/confidential-reflection-scan-indexer.js';
import { SWAP_BATCH_VK } from '../dapp/confidential-swapbatch-vk.js';
import { classifyConfidentialTx } from '../dapp/burn-deposit-bitcoin.js';
import { readFileSync, writeFileSync } from 'node:fs';

const sha256 = (b) => nobleSha256(b instanceof Uint8Array ? b : Uint8Array.from(b));
const deps = { secp, keccak256: keccak_256, sha256, swapBatchVk: SWAP_BATCH_VK };
const STATE_FILE = '/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad/modeb-kv.json';
const KEY = 'reflection:scan:mainnet';
const OUT = '/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad/reflection_input.json';
const ESPLORAS = (process.env.ESPLORA || 'https://blockstream.info/api').split(',');
async function tryFetch(path, bin) { let e; for (let a=0;a<6;a++){const base=ESPLORAS[a%ESPLORAS.length];try{const r=await fetch(base+path);if(!r.ok){e=new Error(base+path+' '+r.status);await new Promise(z=>setTimeout(z,800*(a+1)));continue;}return bin?new Uint8Array(await r.arrayBuffer()):await r.text();}catch(x){e=x;await new Promise(z=>setTimeout(z,800*(a+1)));}}throw e; }
async function api(_e,p){return tryFetch(p,false);} async function apiRawBytes(_e,p){return tryFetch(p,true);}

const fileKV = { get: async(k)=>{try{return (JSON.parse(readFileSync(STATE_FILE,'utf8')))[k]??null;}catch{return null;}}, put: async(k,v)=>{let o={};try{o=JSON.parse(readFileSync(STATE_FILE,'utf8'));}catch{} o[k]=v; writeFileSync(STATE_FILE,JSON.stringify(o));} };

// current state must be @958162 (from reconstruct)
const st = JSON.parse(await fileKV.get(KEY));
console.log('resuming from attestedHeight', st.attestedHeight, 'digest-of-state expected 0x7dc45a5c');
const MODEB_TO = st.attestedHeight + 1;  // minimal 1-block mode_b batch

// eth bundle from eth_set.json
const ethSet = JSON.parse(readFileSync('/Users/z/tacit-critical-backup/seed-rebuild/ethset-out/eth_set.json','utf8'));
const ethBundle = { ethPv: ethSet.ethPv, crossouts: ethSet.crossouts, consumeds: ethSet.consumeds };
const consumedSources = [{
  nu: '0xaf9445828765e1ce0405f98e7a2f55bf816e8b90487283b24a54ab5023afae0a',
  cx: '0x586530c01fab4e77776c89cd8da03ffd7ca48c0611be8b3bfd73b41502a1df71',
  cy: '0x994677c780bbb2595d6c44e1d5b5f1ea6ccc770a154412defa1159c9e820a2a8',
  srcTxid: '0x0717ac496a7f56cbd4c3ff7902470f0691e420a20f960edace331149a8fd572a',  // internal (reversed) byte order — matches the live-set outpoint keying
  srcVout: 1,
}];

const env = { REFLECTION_ATTEST:'1', REFLECTION_GENESIS_HEIGHT:String(958151), REGISTRY_KV: fileKV };
const ethBundleSource = async ({ from, to, blocks }) => { console.log(`ethBundleSource for ${from}..${to}`); return { ethBundle, consumedSources }; };
const att = buildScanReflectionAttester(env, { deps, api, apiRawBytes, network:'mainnet', classifyTx:({rawHex})=>classifyConfidentialTx(rawHex), ethBundleSource });

await att.setTip(MODEB_TO);
const job = await att.assembleJob();
if (!job) { console.log('no job (caught up?)'); process.exit(1); }
console.log('mode_b batch:', job.input.anchorHeight, '..', job.attestedTo, 'newDigest', job.input.newDigest);
console.log('modeB present:', !!job.input.modeB, ' ethPv match:', (job.input.ethPv||job.input.modeB?.ethPv||'').slice(0,20));
writeFileSync(OUT, JSON.stringify(job.input, null, 0));
console.log('WROTE', OUT, '(', JSON.stringify(job.input).length, 'bytes )');
// save the post-batch snapshot for ackJob after attest
writeFileSync(OUT + '.snapshot.json', JSON.stringify({ attestedTo: job.attestedTo, newSnapshot: job.newSnapshot }));
