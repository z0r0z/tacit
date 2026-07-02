import { classifyConfidentialTx, extractInputs, extractTaprootEnvelope, parseCetch, makeBurnDepositKit } from '../dapp/burn-deposit-bitcoin.js';
import { makeBurnDepositTracer } from '../dapp/burn-deposit-tracer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
const BS='https://blockstream.info/api', cache=new Map();
const rev=h=>h.replace(/^0x/,'').match(/../g).reverse().join(''); const opk=(t,v)=>`${t}:${v}`; const ib=t=>Uint8Array.from(rev(t).match(/../g).map(x=>parseInt(x,16)));
async function F(path){ for(let a=0;a<6;a++){ try{ const r=await fetch(`${BS}${path}`); if(r.ok)return r; }catch(e){} await new Promise(r=>setTimeout(r,700)); } throw new Error('fetch '+path); }
async function raw(t){ if(cache.has('r'+t))return cache.get('r'+t); const h=await(await F(`/tx/${t}/hex`)).text(); cache.set('r'+t,h); return h; }
async function txBlock(t){ const s=await(await F(`/tx/${t}`)).json(); return s.status.block_hash; }
async function blockTxids(hash){ if(cache.has('b'+hash))return cache.get('b'+hash); const ids=await(await F(`/block/${hash}/txids`)).json(); cache.set('b'+hash,ids); return ids; }
async function kind(txid){ const h=await raw(txid); if(!h||h.length<20)return 'bad'; const e=extractTaprootEnvelope(h); if(e&&parseCetch(e))return 'cetch'; const c=classifyConfidentialTx(h); return c?c.type:'plain'; }
const pool=makeConfidentialPool({secp,keccak256:keccak_256,sha256});
const chash=c=>{const{cx,cy}=pool.decompressCommitment(c);return pool.commitmentHash(cx,cy);};
async function getCx(op){ const [txid]=op.split(':'); const h=await raw(txid); const cls=classifyConfidentialTx(h); if(!cls||cls.type!=='cxfer')return null;
  const outputs=cls.commitments.map((c,i)=>({commitment:c,vout:cls.vouts[i]})); const ins=extractInputs(h); const inputs=[];
  for(const inp of ins){ const pt=rev(inp.prevTxid); const k=await kind(pt);
    if(k==='cxfer'){ const pc=classifyConfidentialTx(await raw(pt)); const idx=pc.vouts.indexOf(inp.prevVout); if(idx>=0)inputs.push({prevTxid:pt,prevVout:inp.prevVout,commitment:pc.commitments[idx]});}
    else if(k==='cetch'){ const cet=parseCetch(extractTaprootEnvelope(await raw(pt))); inputs.push({prevTxid:pt,prevVout:inp.prevVout,commitment:cet.c0Compressed});}}
  return {txid,inputs,outputs,kernelSig:cls.kernelSig,rangeProof:cls.rangeProof}; }
const NOTE=opk('3e5eaac0865c29f094bc48fcde830d80cff78eba1b119c12a64168f8d02f2c15',0);
const C0=opk('e2d10be19c2b73b86e14be99dc237a3d999ba3dfbe6f3e3714590acee2ca481e',0);
// BFS the graph
const graph=new Map(); const q=[NOTE];
while(q.length){ const op=q.shift(); if(op===C0||graph.has(op))continue; const cx=await getCx(op); if(!cx){console.log('null @',op);break;} graph.set(op,cx); for(const i of cx.inputs)q.push(opk(i.prevTxid,i.prevVout)); }
const tracer=makeBurnDepositTracer({outpointKey:opk});
const cxfers=await tracer.trace({getCxferByOutput:op=>graph.get(op),noteOutpoint:NOTE,c0Outpoint:C0});
console.log('cxfers:',cxfers.length,'— attaching per-block txids + index...');
const kit=makeBurnDepositKit({secp,keccak256:keccak_256,sha256});
// build cxfersForMirror shape
const cfm=[];
for(const cx of cxfers){ const bh=await txBlock(cx.txid); const bt=await blockTxids(bh); const index=bt.indexOf(cx.txid); const bti=bt.map(ib);
  cfm.push({ txid:rev(cx.txid), inputOutpoints:cx.inputs.map(i=>[rev(i.prevTxid),i.prevVout]), inputCommitments:cx.inputs.map(i=>i.commitment),
    outputCommitments:cx.outputs.map(o=>o.commitment), outputVouts:cx.outputs.map(o=>o.vout), burnedAmount:0,
    rangeProof:cx.rangeProof, kernelSig:cx.kernelSig, merkleSiblings:kit.assembler.merkleSiblings(bti,index), merkleIndex:index, confirmedBlockRoot:kit.assembler.merkleRoot(bti) }); }
// leaves + burned
const c0tx=await raw(C0.split(':')[0]); const c0cm=parseCetch(extractTaprootEnvelope(c0tx)).c0Compressed;
const validLeaves=[[opk(rev(C0.split(':')[0]),0), chash(c0cm)]];
const noteCls=classifyConfidentialTx(await raw(NOTE.split(':')[0])); const burnedCm=noteCls.commitments[noteCls.vouts.indexOf(0)];
const ok=kit.mirror.verifyProvenanceLeaves('0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b', validLeaves, opk(rev(NOTE.split(':')[0]),0), chash(burnedCm), cfm);
console.log('verifyProvenanceLeaves (FULL: DAG + inclusion + conservation):', ok?'PASS ✓✓ — bundle provably correct, burn safe':'FAIL');
