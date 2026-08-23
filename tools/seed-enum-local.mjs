import * as secp from "/Users/z/tacit/node_modules/@noble/secp256k1/index.js";
import { sha256 } from "/Users/z/tacit/node_modules/@noble/hashes/sha2.js";
import { keccak_256 } from "/Users/z/tacit/node_modules/@noble/hashes/sha3.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const bytesToHex=b=>[...b].map(x=>x.toString(16).padStart(2,"0")).join("");
const store=new Map();globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),clear:()=>store.clear(),key:i=>[...store.keys()][i],get length(){return store.size;}};
if(!globalThis.crypto)globalThis.crypto=(await import("node:crypto")).webcrypto;globalThis.window=globalThis;globalThis.addEventListener=()=>{};globalThis.matchMedia=()=>({matches:false});globalThis.document={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({style:{}}),body:{},addEventListener(){}};globalThis.navigator={userAgent:"node"};globalThis.location={href:"x",search:"",hash:""};
globalThis.__TACIT_NO_INIT__=true;globalThis.__TACIT_WORKER_BASE__="https://api.tacit.finance";globalThis.localStorage.setItem("tacit-network-v1","mainnet");
const bd = await import("/Users/z/tacit/dapp/burn-deposit-bitcoin.js");
const compOf=c=>(typeof c==="string"?c:bytesToHex(c)).replace(/^0x/,"");
const A="f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b";
const CUTOFF=parseInt(process.env.CUTOFF||"957443",10);
const SRC=["https://mempool.space/api","https://mempool.emzy.de/api","https://blockstream.info/api"];
async function j(p){for(let a=0;a<30;a++){const b=SRC[a%SRC.length];try{const r=await fetch(b+p);if(r.status===429||r.status>=500){await new Promise(s=>setTimeout(s,600+a*250));continue;}if(r.ok)return await r.json();await new Promise(s=>setTimeout(s,250));}catch{await new Promise(s=>setTimeout(s,350));}}throw new Error("j "+p);}
async function raw(t){for(let a=0;a<30;a++){const b=SRC[a%SRC.length];try{const r=await fetch(b+"/tx/"+t+"/hex");if(r.status===429||r.status>=500){await new Promise(s=>setTimeout(s,600+a*250));continue;}if(r.ok)return (await r.text()).trim();await new Promise(s=>setTimeout(s,250));}catch{await new Promise(s=>setTimeout(s,350));}}throw new Error("raw "+t);}
const isTac=(sr)=>{const env=bd.extractTaprootEnvelope(sr);if(!env)return false;const cls=bd.classifyConfidentialTx(sr);return cls&&cls.type==="cxfer"&&compOf(cls.assetId)===A;};
const etchTx="e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e";
console.log("etch",etchTx,"CUTOFF",CUTOFF,"(pruned: TAC-cxfer chain only)");
const txmap=existsSync("/tmp/seedrec/txmap.json")?new Map(Object.entries(JSON.parse(readFileSync("/tmp/seedrec/txmap.json","utf8")))):new Map();
const seen=new Set(); let frontier=[etchTx]; let n=txmap.size,exp=0; const t0=Date.now();
async function expand(t){ if(seen.has(t))return; seen.add(t); let os; try{os=await j("/tx/"+t+"/outspends");}catch{return;}
  exp++; if(exp%100===0){console.error("expanded",exp,"txmap",txmap.size,"frontier",frontier.length,((Date.now()-t0)/1000|0)+"s");writeFileSync("/tmp/seedrec/txmap.json",JSON.stringify(Object.fromEntries(txmap)));}
  for(const o of os){ if(o.spent&&o.txid&&o.status?.block_height<=CUTOFF&&!seen.has(o.txid)){ let sr; try{sr=await raw(o.txid);}catch{continue;} if(isTac(sr)){ if(!txmap.has(o.txid))txmap.set(o.txid,{height:o.status.block_height,raw:sr}); frontier.push(o.txid); } } } }
const CONC=6; while(frontier.length){ const c=frontier.splice(0,CONC).filter(x=>typeof x==="string"&&!seen.has(x)); if(!c.length)continue; await Promise.all(c.map(expand)); }
writeFileSync("/tmp/seedrec/txmap.json",JSON.stringify(Object.fromEntries(txmap)));
console.log("ENUM_DONE txmap size",txmap.size,"expanded",exp);
