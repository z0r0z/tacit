import { classifyConfidentialTx, extractInputs, extractTaprootEnvelope, parseCetch } from '../dapp/burn-deposit-bitcoin.js';
import { makeBurnDepositTracer } from '../dapp/burn-deposit-tracer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { writeFileSync } from 'node:fs';
const BS='https://blockstream.info/api', cache=new Map();
const rev=h=>h.replace(/^0x/,'').match(/../g).reverse().join('');
const opk=(t,v)=>`${t}:${v}`;
async function raw(t){ if(cache.has(t))return cache.get(t); let h; for(let a=0;a<5;a++){ try{ h=await fetch(`${BS}/tx/${t}/hex`).then(r=>r.text()); if(h&&h.length>20)break; }catch(e){ await new Promise(r=>setTimeout(r,600)); } } cache.set(t,h); return h; }
async function status(t){ return fetch(`${BS}/tx/${t}/status`).then(r=>r.json()); }
async function kind(txid){ const h=await raw(txid); if(!h||h.length<20)return 'bad'; const e=extractTaprootEnvelope(h); if(e&&parseCetch(e))return 'cetch'; const c=classifyConfidentialTx(h); return c?c.type:'plain'; }
const pool=makeConfidentialPool({secp,keccak256:keccak_256,sha256});
const chash=(cHex)=>{ const {cx,cy}=pool.decompressCommitment(cHex); return pool.commitmentHash(cx,cy); };
async function getCxferByOutput(op){
  const [txid]=op.split(':'); const h=await raw(txid); const cls=classifyConfidentialTx(h);
  if(!cls||cls.type!=='cxfer')return null;
  const outputs=cls.commitments.map((c,i)=>({commitment:c,vout:cls.vouts[i]}));
  const ins=extractInputs(h); const inputs=[];
  for(const inp of ins){ const pt=rev(inp.prevTxid); const k=await kind(pt);
    if(k==='cxfer'){ const ph=await raw(pt); const pc=classifyConfidentialTx(ph); const idx=pc.vouts.indexOf(inp.prevVout);
      if(idx>=0) inputs.push({prevTxid:pt,prevVout:inp.prevVout,commitment:pc.commitments[idx]}); }
    else if(k==='cetch'){ const ph=await raw(pt); const cet=parseCetch(extractTaprootEnvelope(ph));
      inputs.push({prevTxid:pt,prevVout:inp.prevVout,commitment:cet.c0Compressed}); } }
  return {txid,inputs,outputs};
}
const tracer=makeBurnDepositTracer({outpointKey:opk});
const NOTE=opk('61df4e6f39dd275d8f7d3eb6bf6d6131b269d2c1c771686d28036fc71acea4fb',0);
const C0=opk('e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e',0);
const graph=new Map(); const q=[NOTE];
while(q.length){ const op=q.shift(); if(op===C0||graph.has(op))continue; const cx=await getCxferByOutput(op); if(!cx){console.log('null cxfer @',op); break;} graph.set(op,cx); for(const i of cx.inputs) q.push(opk(i.prevTxid,i.prevVout)); }
const cxfers=await tracer.trace({getCxferByOutput:(op)=>graph.get(op), noteOutpoint:NOTE, c0Outpoint:C0});
console.log('traced cxfers:',cxfers.length);

// Now fetch confirming block height for each cxfer txid + the etch txid, for the downstream block-fetch pass.
const etchTxid = C0.split(':')[0];
const allTxids = [etchTxid, ...cxfers.map(c=>c.txid)];
const heights = {};
for (const t of allTxids) {
  const s = await status(t);
  heights[t] = s.block_height;
  await new Promise(r=>setTimeout(r,150));
}
console.log('heights:', JSON.stringify(heights));
writeFileSync('/Users/z/.tacit-seed-note/tac-dag-trace.json', JSON.stringify({ note: NOTE, c0: C0, etchTxid, cxfers: cxfers.map(c=>c.txid), heights }, null, 2));
console.log('wrote /Users/z/.tacit-seed-note/tac-dag-trace.json');
