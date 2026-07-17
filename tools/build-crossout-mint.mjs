// T_CROSSOUT_MINT (0x65) Bitcoin envelope broadcast — mints the 20-TAC crossout note on Bitcoin.
// Adapts the burn commit/reveal envelope pattern (tacit.js), but the reveal has NO note input (the note
// is MINTED by the envelope, not spent). The reflection onboards it once the crossout is in crossOutSet
// (done: attest 0x874b6a90).
import { webcrypto } from 'node:crypto';
const makeEl=()=>new Proxy(function(){},{get(_t,p){if(p==='style')return new Proxy({},{get:()=>'' ,set:()=>true});if(p==='classList')return{add(){},remove(){},toggle(){},contains(){return false;}};if(p==='dataset')return{};if(p==='children'||p==='childNodes')return[];if(p==='value'||p==='textContent'||p==='innerHTML'||p==='id')return'';if(p==='parentNode'||p==='firstChild'||p==='nextSibling')return null;if(typeof p==='symbol')return undefined;return makeEl();},set(){return true;},apply(){return makeEl();}});
const store=new Map();
globalThis.localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k),clear:()=>store.clear(),key:()=>null,length:0};
globalThis.document=new Proxy({},{get(_t,p){if(p==='getElementById'||p==='querySelector'||p==='createElement'||p==='getElementsByClassName'||p==='getElementsByTagName')return()=>makeEl();if(p==='querySelectorAll')return()=>[];if(p==='addEventListener'||p==='removeEventListener'||p==='write'||p==='createTextNode')return()=>makeEl();if(p==='body'||p==='documentElement'||p==='head')return makeEl();if(p==='cookie')return'';if(p==='readyState')return'complete';return()=>makeEl();}});
globalThis.window=new Proxy({localStorage:globalThis.localStorage,document:globalThis.document},{get(t,p){if(p in t)return t[p];if(p==='location')return{href:'http://localhost/',search:'',hash:'',pathname:'/',origin:'http://localhost'};if(p==='navigator')return{userAgent:'node',language:'en'};if(p==='addEventListener'||p==='removeEventListener'||p==='setTimeout'||p==='clearTimeout')return globalThis[p]||(()=>{});if(p==='matchMedia')return()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});if(p==='crypto')return webcrypto;if(typeof p==='symbol')return undefined;return()=>{};}});
globalThis.location=globalThis.window.location;globalThis.navigator=globalThis.window.navigator;
if(!globalThis.crypto)globalThis.crypto=webcrypto;
globalThis.__TACIT_NO_INIT__=true;
globalThis.localStorage.setItem('tacit-network-v1','mainnet');
import { readFileSync, writeFileSync } from 'node:fs';
import * as secp from '/Users/z/tacit/node_modules/@noble/secp256k1/index.js';
import { encodeCrossoutMint } from '/Users/z/tacit/dapp/confidential-crossout-consumer.js';

const d = await import('/Users/z/tacit/dapp/tacit.js');
const w = JSON.parse(readFileSync('/Users/z/tacit-critical-backup/mainnet-tac-wallet.json','utf8'));
const priv = d.hexToBytes(w.priv_hex.replace(/^0x/,''));
d.wallet.priv = priv; d.wallet.pub = secp.getPublicKey(priv, true);
console.log('wallet addr:', d.wallet.address());

// payload (0x65, 161 bytes): the ON-CHAIN claimId (folded into crossOutSet), dest cx/cy, owner=ZERO
const ZERO = '0x'+'00'.repeat(32);
const payload = encodeCrossoutMint({
  assetId: '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b',
  claimId: '0x22a5a8e5108541a988661085c327067c9e2ef14ec8a51c46e7ec1d638ea5e732',
  cx: '0xf252548e8a05ae83aadab9de453c3d1331f08d9a18c5691ecff7188fadd69292',
  cy: '0x35a6a9efd5e8722753cf12e97ff25318d98d717ac4adfc06cdce15246001a162',
  owner: ZERO,
});
if (payload.length !== 161) throw new Error('payload len '+payload.length);
console.log('payload 0x65 len', payload.length);

const envelopeScript = d.encodeEnvelopeScript(d.wallet.xonly(), payload);
const leaf = d.tapLeafHash(envelopeScript);
const { Q_xonly, parity } = d.tweakedOutputKey(d.TAP_NUMS, leaf);
const p2trSpk = d.p2trScript(Q_xonly);
const cb = d.controlBlock(d.TAP_NUMS, parity);
const senderP2wpkh = d.p2wpkhScript(d.wallet.hash160 ? d.wallet.hash160() : d.hash160(d.wallet.pub));

let feeRate = 3; try { feeRate = await d.getFeeRate(); } catch {}
if (!feeRate || feeRate < 1) feeRate = 3;
const DUST = d.DUST || 546;

// fee UTXO
const feeU = { txid: 'bb9031cdb1c6c9aed083be16084b3b239a467ed21dd37ff86f4dd290e3cabebc', vout: 1, value: 4169 };
const revealVb = 180, revealFee = Math.ceil(revealVb*feeRate);
const commitValue = revealFee + DUST;
const commitVb = 110, commitFee = Math.ceil(commitVb*feeRate);
const commitChange = feeU.value - commitValue - commitFee;
if (commitChange < 0) throw new Error('fee UTXO too small: need '+(commitValue+commitFee)+' have '+feeU.value);
const commitOutputs = [{ value: commitValue, script: p2trSpk }];
if (commitChange >= DUST) commitOutputs.push({ value: commitChange, script: senderP2wpkh });

const commitTx = { version:2, locktime:0, inputs:[{ txid: feeU.txid, vout: feeU.vout, sequence:0xfffffffd, witness:[] }], outputs: commitOutputs };
commitTx.inputs[0].witness = d.signP2wpkhInput(commitTx, 0, feeU.value);
const commitHex = d.bytesToHex(d.serializeTx(commitTx));
const commitTxid = d.txid(commitTx);

const revealTx = { version:2, locktime:0, inputs:[{ txid: commitTxid, vout:0, sequence:0xfffffffd, witness:[] }], outputs:[{ value: DUST, script: senderP2wpkh }] };
const prevouts = [{ value: commitValue, script: p2trSpk }];
revealTx.inputs[0].witness = d.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
const revealHex = d.bytesToHex(d.serializeTx(revealTx));
const revealTxid = d.txid(revealTx);

console.log('feeRate', feeRate, 'commitValue', commitValue, 'commitFee', commitFee, 'commitChange', commitChange, 'revealFee', revealFee);
console.log('commitTxid', commitTxid);
console.log('revealTxid', revealTxid);
writeFileSync('/private/tmp/claude-501/-Users-z-tacit/218e951b-c019-470f-a2bb-2d938e3c5ef4/scratchpad/crossout-mint-txs.json', JSON.stringify({commitHex,commitTxid,revealHex,revealTxid},null,1));
console.log('WROTE crossout-mint-txs.json (NOT broadcast — review then broadcast)');
