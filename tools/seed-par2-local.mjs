import * as secp from "/Users/z/tacit/node_modules/@noble/secp256k1/index.js";
import { sha256 } from "/Users/z/tacit/node_modules/@noble/hashes/sha2.js";
import { keccak_256 } from "/Users/z/tacit/node_modules/@noble/hashes/sha3.js";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
const hexToBytes=h=>Uint8Array.from(String(h).replace(/^0x/,"").match(/../g).map(x=>parseInt(x,16)));
const bytesToHex=b=>[...b].map(x=>x.toString(16).padStart(2,"0")).join("");
const store=new Map();globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),clear:()=>store.clear(),key:i=>[...store.keys()][i],get length(){return store.size;}};
if(!globalThis.crypto)globalThis.crypto=(await import("node:crypto")).webcrypto;globalThis.window=globalThis;globalThis.addEventListener=()=>{};globalThis.matchMedia=()=>({matches:false});globalThis.document={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({style:{}}),body:{},addEventListener(){}};globalThis.navigator={userAgent:"node"};globalThis.location={href:"x",search:"",hash:""};
globalThis.__TACIT_NO_INIT__=true;globalThis.__TACIT_WORKER_BASE__="https://api.tacit.finance";globalThis.localStorage.setItem("tacit-network-v1","mainnet");
const { makeConfidentialPool } = await import("/Users/z/tacit/dapp/confidential-pool.js");
const { makeScanReflectionIndexer } = await import("/Users/z/tacit/dapp/confidential-reflection-scan-indexer.js");
const bd = await import("/Users/z/tacit/dapp/burn-deposit-bitcoin.js");
const K=b=>keccak_256(b), S=b=>sha256(b);
const pool = makeConfidentialPool({ secp, keccak256:K, sha256:S });
async function raw(t){for(let a=0;a<8;a++){try{const r=await fetch("https://blockstream.info/api/tx/"+t+"/hex");if(r.ok)return (await r.text()).trim();}catch{await new Promise(s=>setTimeout(s,400));}}throw new Error("raw "+t);}
const compOf=c=>(typeof c==="string"?c:bytesToHex(c)).replace(/^0x/,"");
const xy=comp=>{const P=secp.ProjectivePoint.fromHex(comp.replace(/^0x/,""));const a=P.toAffine();return["0x"+a.x.toString(16).padStart(64,"0"),"0x"+a.y.toString(16).padStart(64,"0")];};
const A="0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b"; const O="0x"+"0".repeat(64); const CUTOFF=956760;
const norm=x=>("0x"+bytesToHex(hexToBytes(x))).toLowerCase();
const intl=disp=>bytesToHex(hexToBytes(disp).reverse());
const SHARD=process.env.SHARD!==undefined?parseInt(process.env.SHARD):null; const NSH=parseInt(process.env.NSH||"64");
const etchTx="e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e";
const cetch=bd.parseCetch(bd.extractTaprootEnvelope(readFileSync('/tmp/seedrec/etch.hex','utf8').trim()));
const [c0cx,c0cy]=xy(compOf(cetch.c0Compressed));
const c0op=pool.outpointKey(intl(etchTx),0);
const cache=JSON.parse(readFileSync("/tmp/seedrec/txmap760.json","utf8"));
const txmap=new Map();
for(const [txid,v] of Object.entries(cache)){ if(v.height>CUTOFF) continue; const cls=bd.classifyConfidentialTx(v.raw); if(!cls||cls.type!=="cxfer"||compOf(cls.assetId)!==A.slice(2)) continue; txmap.set(txid,{txid,height:v.height,raw:v.raw,cls}); }
const outMap=new Map(); outMap.set(norm(c0op),{cx:c0cx,cy:c0cy});
for(const [txid,v] of txmap){ v.cls.commitments.forEach((c,i)=>{const comp=compOf(c);const[cx,cy]=xy(comp);outMap.set(norm(pool.outpointKey(intl(txid),v.cls.vouts[i])),{cx,cy});}); }
for(const [txid,v] of txmap){ v.noteIns=bd.extractInputs(v.raw).map(inp=>({txid:inp.prevTxid.replace(/^0x/,""),vout:inp.prevVout,key:norm(pool.outpointKey(inp.prevTxid.replace(/^0x/,""),inp.prevVout))})).filter(x=>outMap.has(x.key)); }
const ids=[...txmap.keys()].sort();
if(SHARD!==null){
  const ok={}; for(let i=0;i<ids.length;i++){ if(i%NSH!==SHARD) continue; const txid=ids[i]; const v=txmap.get(txid);
    if(!v.noteIns.length){ ok[txid]=false; continue; }
    const inPts=v.noteIns.map(x=>{const co=outMap.get(x.key);return secp.ProjectivePoint.fromAffine({x:BigInt(co.cx),y:BigInt(co.cy)});});
    ok[txid]=pool.verifyCxferConservation({asset:A,inputOutpoints:v.noteIns.map(x=>[x.txid,x.vout]),inputPoints:inPts,outsCompressed:v.cls.commitments.map(c=>compOf(c)),rangeProof:compOf(v.cls.rangeProof),kernelSig:compOf(v.cls.kernelSig)}); }
  writeFileSync(`/tmp/seedrec/ok760shard-${SHARD}.json`,JSON.stringify(ok)); console.log(`SHARD ${SHARD} DONE`);
} else {
  const okMap={}; for(const f of readdirSync("/tmp/seedrec")){ if(/^ok760shard-\d+\.json$/.test(f)) Object.assign(okMap,JSON.parse(readFileSync("/tmp/seedrec/"+f,"utf8"))); }
  console.log("okMap conserving:",Object.values(okMap).filter(Boolean).length);
  const idx=makeScanReflectionIndexer({ secp, keccak256:K, sha256:S }); const st=idx.state(); const co=idx.coords();
  st.foldOutput(pool.leaf(A,c0cx,c0cy,O),c0op,pool.commitmentHash(c0cx,c0cy),A); co.set(norm(c0op),{cx:c0cx,cy:c0cy});
  let pending=[...txmap.values()].sort((a,b)=> (a.height-b.height) || (a.txid<b.txid?-1:a.txid>b.txid?1:0));
  let folded=0,nonc=0;
  for(;;){ let progress=false; const next=[];
    for(const tx of pending){
      if(!tx.noteIns.length){ next.push(tx); continue; }
      if(!tx.noteIns.every(x=>co.has(x.key))){ next.push(tx); continue; }
      for(const x of tx.noteIns){const c=co.get(x.key);st.foldSpent(pool.nullifier(c.cx,c.cy));st.live.remove(x.key.replace(/^0x/,""));co.delete(x.key);}
      if(okMap[tx.txid]){for(let i=0;i<tx.cls.commitments.length;i++){const comp=compOf(tx.cls.commitments[i]);const[cx,cy]=xy(comp);const op=pool.outpointKey(intl(tx.txid),tx.cls.vouts[i]);st.foldOutput(pool.leaf(A,cx,cy,O),op,pool.commitmentHash(cx,cy),A);co.set(norm(op),{cx,cy});}folded++;}else nonc++;
      progress=true;
    }
    pending=next; if(!progress)break;
  }
  st.setHeight(956760);
  const d956=st.digest(); const snap=idx.snapshot();
  console.log("DIGEST_H956223",d956,"folded",folded,"nonc",nonc,"live",snap.liveTriples.length);
  console.log("MATCH_D956", d956==="0x50d9ec57e31abb49bf9b2d372e66f1d431b78134e9799ab5dca63008fe1dc2c8");
  writeFileSync("/tmp/seedrec/seed-snapshot760.json",JSON.stringify(snap));
  const kv={}; kv["reflection:scan:mainnet"]=JSON.stringify({snapshot:snap,attestedHeight:956760,tipHeight:956760});
  writeFileSync("/tmp/seedrec/relayer_kv_launch760.json",JSON.stringify(kv));
  console.log("WROTE snapshot + KV");
}
