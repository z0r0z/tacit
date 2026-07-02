import { classifyConfidentialTx, extractInputs, extractTaprootEnvelope, parseCetch } from '../dapp/burn-deposit-bitcoin.js';
import { makeBurnDepositTracer } from '../dapp/burn-deposit-tracer.js';
import { makeBurnDepositProvenance } from '../dapp/burn-deposit-provenance.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
const BS='https://blockstream.info/api', cache=new Map();
const rev=h=>h.replace(/^0x/,'').match(/../g).reverse().join('');
const opk=(t,v)=>`${t}:${v}`;
async function raw(t){ if(cache.has(t))return cache.get(t); let h; for(let a=0;a<5;a++){ try{ h=await fetch(`${BS}/tx/${t}/hex`).then(r=>r.text()); if(h&&h.length>20)break; }catch(e){ await new Promise(r=>setTimeout(r,600)); } } cache.set(t,h); return h; }
async function kind(txid){ const h=await raw(txid); if(!h||h.length<20)return 'bad'; const e=extractTaprootEnvelope(h); if(e&&parseCetch(e))return 'cetch'; const c=classifyConfidentialTx(h); return c?c.type:'plain'; }
const pool=makeConfidentialPool({secp,keccak256:keccak_256,sha256});
const chash=(cHex)=>{ const {cx,cy}=pool.decompressCommitment(cHex); return pool.commitmentHash(cx,cy); };
// getCxferByOutput (tracer object shape)
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
const NOTE=opk('3e5eaac0865c29f094bc48fcde830d80cff78eba1b119c12a64168f8d02f2c15',0);
const C0=opk('e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e',0);
// getCxferByOutput is async; tracer is sync → pre-build the graph by BFS
const graph=new Map(); const q=[NOTE];
while(q.length){ const op=q.shift(); if(op===C0||graph.has(op))continue; const cx=await getCxferByOutput(op); if(!cx){console.log('null cxfer @',op); break;} graph.set(op,cx); for(const i of cx.inputs) q.push(opk(i.prevTxid,i.prevVout)); }
const cxfers=await tracer.trace({getCxferByOutput:(op)=>graph.get(op), noteOutpoint:NOTE, c0Outpoint:C0});
console.log('traced cxfers:',cxfers.length);
// map to verify shape (hashes)
const vcx=cxfers.map(cx=>({txid:cx.txid, outputs:cx.outputs.map(o=>[o.vout,chash(o.commitment)]), inputs:cx.inputs.map(i=>[i.prevTxid,i.prevVout,chash(i.commitment)])}));
// C_0 + burned commitment hashes
const c0h=await raw(C0.split(':')[0]); const c0cm=parseCetch(extractTaprootEnvelope(c0h)).c0Compressed; const c0Hash=chash(c0cm);
const noteH=await raw(NOTE.split(':')[0]); const noteCls=classifyConfidentialTx(noteH); const noteCm=noteCls.commitments[noteCls.vouts.indexOf(0)]; const burnedHash=chash(noteCm);
const mirror=makeBurnDepositProvenance({outpointKey:opk, sha256, commitmentHashCompressed:chash, verifyMerklePath:()=>'', verifyCxferConservation:()=>true, verifyRange:()=>true, bip340Verify:()=>true, decompress:()=>null});
const ok=mirror.verifyProvenanceDag(C0, c0Hash, NOTE, burnedHash, vcx);
console.log('verifyProvenanceDag:', ok ? 'PASS ✓ (DAG structurally valid, roots at C_0, burned note produced-not-consumed)' : 'FAIL');
