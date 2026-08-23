// Validate the rebuilt seed: fold 957444->958007 from the seed, confirm note d680ba8c folds live (no conservation break).
import { buildScanReflectionAttester } from "/Users/z/tacit/worker/src/reflection-attest.js";
import { sha256 as nsha } from "/Users/z/tacit/node_modules/@noble/hashes/sha2.js";
import { keccak_256 } from "/Users/z/tacit/node_modules/@noble/hashes/sha3.js";
import * as secp from "/Users/z/tacit/node_modules/@noble/secp256k1/index.js";
import { classifyConfidentialTx } from "/Users/z/tacit/dapp/burn-deposit-bitcoin.js";
import { readFileSync, writeFileSync } from "node:fs";
const SRC=["https://mempool.space/api","https://mempool.emzy.de/api","https://blockstream.info/api"];
async function fetchTry(p,b){let e;for(let a=0;a<30;a++){const s=SRC[a%SRC.length];try{const r=await fetch(s+p);if(r.status===429||r.status>=500){await new Promise(z=>setTimeout(z,600+a*250));continue;}if(!r.ok){e=new Error(s+p+" "+r.status);await new Promise(z=>setTimeout(z,250));continue;}return b?new Uint8Array(await r.arrayBuffer()):await r.text();}catch(x){e=x;await new Promise(z=>setTimeout(z,350));}}throw e;}
const api=async(_e,p)=>fetchTry(p,false), apiRawBytes=async(_e,p)=>fetchTry(p,true);
const KVFILE="/tmp/seedrec/validate-kv.json";
writeFileSync(KVFILE, readFileSync("/tmp/seedrec/SEED-957443.json"));
let kv=JSON.parse(readFileSync(KVFILE,"utf8"));
const REGISTRY_KV={get:async k=>(k in kv?kv[k]:null),put:async(k,v)=>{kv[k]=v;writeFileSync(KVFILE,JSON.stringify(kv));}};
const TARGET=958007, NOTE="01937ae0aa74eb802dce0bd98592fee624d9782b1865be6783552d852d89b3d0";
const env={REFLECTION_ATTEST:"1",REFLECTION_GENESIS_HEIGHT:"957443",REFLECTION_BATCH_SIZE:"60",REGISTRY_KV};
const att=buildScanReflectionAttester(env,{deps:{secp,keccak256:keccak_256,sha256:nsha},api,apiRawBytes,network:"mainnet",classifyTx:({rawHex})=>classifyConfidentialTx(rawHex)});
const cur=()=>JSON.parse(kv["reflection:scan:mainnet"]).attestedHeight;
console.log("seed @",cur(),"-> fold to",TARGET);
for(let i=0;cur()<TARGET&&i<200;i++){
  await att.setTip(TARGET);
  let j; try{ j=await att.assembleJob(); }catch(e){ console.log("FOLD ERROR at",cur(),":",e.message); process.exit(2); }
  if(!j){console.log("caught up");break;}
  await att.ackJob(j.attestedTo,j.newSnapshot);
  if(j.attestedTo%60===0||j.attestedTo>=TARGET-6) console.log("  ->",j.attestedTo,"digest",j.input.newDigest,"unsup",(j.input.unsupportedEnvelopes||[]).length);
  if(j.attestedTo>=TARGET)break;
}
const rec=JSON.parse(kv["reflection:scan:mainnet"]);
const snap=typeof rec.snapshot==="string"?JSON.parse(rec.snapshot):rec.snapshot;
const hasNote=JSON.stringify(snap).toLowerCase().includes(NOTE);
console.log(`\nfinal @${rec.attestedHeight} noteLeaves ${(snap.noteLeaves||[]).length} live ${(snap.liveTriples||[]).length}`);
console.log(`NOTE ${NOTE.slice(0,16)}… present in reflected state: ${hasNote}`);
console.log(hasNote?"✓ SEED VALID — note d680ba8c folds live; this seed bridges the TAC note":"✗ note NOT in state — investigate");
