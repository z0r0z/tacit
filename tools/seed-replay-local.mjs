// Local seed reconstruction: fold the recovered KV (@956767) forward to 957443 and verify digest == c520d2d4.
// Pure off-chain state advance (no prove/attest) using the worker attester's replay path.
import { buildScanReflectionAttester } from "/Users/z/tacit/worker/src/reflection-attest.js";
import { sha256 as nsha } from "/Users/z/tacit/node_modules/@noble/hashes/sha2.js";
import { keccak_256 } from "/Users/z/tacit/node_modules/@noble/hashes/sha3.js";
import * as secp from "/Users/z/tacit/node_modules/@noble/secp256k1/index.js";
import { classifyConfidentialTx } from "/Users/z/tacit/dapp/burn-deposit-bitcoin.js";
import { makeScanReflectionIndexer } from "/Users/z/tacit/dapp/confidential-reflection-scan-indexer.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const SRC=["https://mempool.space/api","https://mempool.emzy.de/api","https://blockstream.info/api"];
async function fetchTry(path,asBytes){let e;for(let a=0;a<30;a++){const b=SRC[a%SRC.length];try{const r=await fetch(b+path);if(r.status===429||r.status>=500){await new Promise(s=>setTimeout(s,700+a*300));continue;}if(!r.ok){e=new Error(b+path+" "+r.status);await new Promise(s=>setTimeout(s,300));continue;}return asBytes?new Uint8Array(await r.arrayBuffer()):await r.text();}catch(x){e=x;await new Promise(s=>setTimeout(s,400+a*180));}}throw (e||new Error("fetch failed: "+path));}
const api=async(_e,p)=>fetchTry(p,false), apiRawBytes=async(_e,p)=>fetchTry(p,true);

const KVFILE="/tmp/seedrec/relayer_kv_launch760.json";
const TARGET=957443;
const SEED_DIGEST="0xc520d2d4a7cbd4502c8694033479acc0686a58ef9be5807e6e995604151bd108";

let kv=JSON.parse(readFileSync(KVFILE,"utf8"));
const REGISTRY_KV={get:async k=>(k in kv?kv[k]:null),put:async(k,v)=>{kv[k]=v;}};
const save=()=>writeFileSync(KVFILE,JSON.stringify(kv));
const GEN=956760;
const env={REFLECTION_ATTEST:"1",REFLECTION_GENESIS_HEIGHT:String(GEN),REFLECTION_BATCH_SIZE:"60",REGISTRY_KV};
const deps={secp,keccak256:keccak_256,sha256:nsha};
const att=buildScanReflectionAttester(env,{deps,api,apiRawBytes,network:"mainnet",classifyTx:({rawHex})=>classifyConfidentialTx(rawHex)});

function curHeight(){ const r=JSON.parse(kv["reflection:scan:mainnet"]); return r.attestedHeight; }
console.log("start attestedHeight", curHeight(), "-> target", TARGET);

// Fold forward in batches (batchSize 60) until attested == TARGET.
for(let i=0; curHeight()<TARGET && i<200; i++){
  await att.setTip(TARGET);
  const j=await att.assembleJob();
  if(!j){ console.log("caught up early at", curHeight()); break; }
  await att.ackJob(j.attestedTo, j.newSnapshot);
  save();
  console.log(`  folded -> ${j.attestedTo}  newDigest ${j.input.newDigest}  (unsupported ${ (j.input.unsupportedEnvelopes||[]).length })`);
  if(j.attestedTo>=TARGET) break;
}

// Verify the reconstructed digest matches the deployed seed, extract the snapshot.
const rec=JSON.parse(kv["reflection:scan:mainnet"]);
const snap=typeof rec.snapshot==="string"?JSON.parse(rec.snapshot):rec.snapshot;
const idx=makeScanReflectionIndexer({...deps});
idx.load(snap);
const dig=idx.state().digest();
console.log(`\nfinal attestedHeight ${rec.attestedHeight}  snap.height ${snap.height}  noteLeaves ${(snap.noteLeaves||[]).length}`);
console.log(`reconstructed digest: ${dig}`);
console.log(`deployed seed digest: ${SEED_DIGEST}`);
if(dig.toLowerCase()===SEED_DIGEST.toLowerCase()){
  writeFileSync("/tmp/seedrec/seed-snapshot-957443.json", JSON.stringify(snap));
  console.log("✓ MATCH — wrote /tmp/seedrec/seed-snapshot-957443.json (this is the fold prior for the bridge)");
} else {
  console.log("✗ MISMATCH — do NOT use; investigate the fold");
  process.exit(1);
}
