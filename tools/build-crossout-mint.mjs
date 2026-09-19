// T_CROSSOUT_MINT (0x65) Bitcoin envelope builder — mints a recorded ETH->BTC cross-out as a Bitcoin note.
// Adapts the burn commit/reveal envelope pattern (tacit.js), but the reveal has NO note input (the note is
// MINTED by the envelope, not spent). BUILD-ONLY: writes the two signed transactions to a file and prints
// them; it never broadcasts. Review, then broadcast the commit followed by the reveal.
//
// THE REVEAL'S vout 0 MUST BE A P2TR OUTPUT PAYING THE EXACT x-only KEY NAMED AT BURN TIME (DEST_XONLY).
// The reflection guest reads the destination authority from that output (`output_p2tr_xonly(tx, 0)`) and
// reconstructs btc_note_leaf(asset, Cx, Cy, key) to match the recorded cross-out. A mint whose vout 0 is not
// P2TR(DEST_XONLY) folds nothing and consumes no claim; the reflection scan does not surface that as an
// error, so verify the parameters below before broadcasting.
//
// Usage (all via env, nothing hardcoded):
//   WALLET_JSON=/path/wallet.json  file with { "priv_hex": "0x.." } — the key signing the envelope + fee input
//   CLAIM_ID=0x..     the claimId from the CrossOutRecorded EVENT (not a client-side prediction)
//   CX=0x.. CY=0x..   the destination note's commitment coordinates (from the burn's returned crossOuts)
//   DEST_XONLY=0x..   the x-only P2TR output key named at burn time (destOwner); vout 0 pays this
//   FEE_TXID=.. FEE_VOUT=N FEE_VALUE=sats   one plain P2WPKH UTXO owned by WALLET_JSON to fund both txs
//   ASSET_ID=0x..     defaults to native TAC
//   FEE_RATE=N        sat/vB; unset = ask the fee estimator (falls back to 3)
//   OUT_FILE=path     defaults to ./crossout-mint-txs.json
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
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const secp = await import(pathToFileURL(resolve(ROOT, 'node_modules/@noble/secp256k1/index.js')).href);
const { encodeCrossoutMint } = await import(pathToFileURL(resolve(ROOT, 'dapp/confidential-crossout-consumer.js')).href);

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(2); } return v; };
const hex32 = (k, v) => { const h = String(v).replace(/^0x/, '').toLowerCase(); if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${k}: expected 32 bytes of hex`); return h; };

const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const assetId = '0x' + hex32('ASSET_ID', process.env.ASSET_ID || TAC);
const claimId = '0x' + hex32('CLAIM_ID', need('CLAIM_ID'));
const cx = '0x' + hex32('CX', need('CX'));
const cy = '0x' + hex32('CY', need('CY'));
const destHex = hex32('DEST_XONLY', need('DEST_XONLY'));
if (/^0{64}$/.test(destHex)) throw new Error('DEST_XONLY is zero — a zero key can never be an authorized destination');
// The key must be a real curve x-coordinate, else the output is unspendable.
try { secp.ProjectivePoint.fromHex('02' + destHex); } catch { throw new Error('DEST_XONLY is not a valid secp256k1 x-coordinate'); }
const feeU = { txid: need('FEE_TXID'), vout: Number(need('FEE_VOUT')), value: Number(need('FEE_VALUE')) };
if (!/^[0-9a-fA-F]{64}$/.test(feeU.txid) || !Number.isInteger(feeU.vout) || !(feeU.value > 0)) throw new Error('FEE_TXID/FEE_VOUT/FEE_VALUE malformed');
const OUT_FILE = process.env.OUT_FILE || './crossout-mint-txs.json';

const d = await import(pathToFileURL(resolve(ROOT, 'dapp/tacit.js')).href);
const w = JSON.parse(readFileSync(need('WALLET_JSON'), 'utf8'));
const priv = d.hexToBytes(w.priv_hex.replace(/^0x/, ''));
d.wallet.priv = priv; d.wallet.pub = secp.getPublicKey(priv, true);
console.log('wallet addr:', d.wallet.address());

// Payload (0x65, 161 bytes). `owner` is carried for wire compatibility but the guest does NOT read it — the
// destination authority comes from vout 0's P2TR key, below.
const ZERO = '0x' + '00'.repeat(32);
const payload = encodeCrossoutMint({ assetId, claimId, cx, cy, owner: ZERO });
if (payload.length !== 161) throw new Error('payload len ' + payload.length);

const envelopeScript = d.encodeEnvelopeScript(d.wallet.xonly(), payload);
const leaf = d.tapLeafHash(envelopeScript);
const { Q_xonly, parity } = d.tweakedOutputKey(d.TAP_NUMS, leaf);
const p2trSpk = d.p2trScript(Q_xonly);
const cb = d.controlBlock(d.TAP_NUMS, parity);
const senderP2wpkh = d.p2wpkhScript(d.wallet.hash160 ? d.wallet.hash160() : d.hash160(d.wallet.pub));
// vout 0 of the reveal: P2TR paying the burner-named key. OP_1 <32-byte key>.
const destSpk = d.hexToBytes('5120' + destHex);

// FEE_RATE (sat/vB) pins the rate and skips the network lookup; unset, it asks the fee estimator.
let feeRate = Number(process.env.FEE_RATE) || 0;
if (!feeRate) { try { feeRate = await d.getFeeRate(); } catch {} }
if (!feeRate || feeRate < 1) feeRate = 3;
const DUST = 330; // P2TR dust floor; vout 0 is a P2TR output

const revealVb = 180, revealFee = Math.ceil(revealVb * feeRate);
const commitValue = revealFee + DUST;
const commitVb = 110, commitFee = Math.ceil(commitVb * feeRate);
const commitChange = feeU.value - commitValue - commitFee;
if (commitChange < 0) throw new Error('fee UTXO too small: need ' + (commitValue + commitFee) + ' have ' + feeU.value);
const commitOutputs = [{ value: commitValue, script: p2trSpk }];
if (commitChange >= 294) commitOutputs.push({ value: commitChange, script: senderP2wpkh });

const commitTx = { version: 2, locktime: 0, inputs: [{ txid: feeU.txid, vout: feeU.vout, sequence: 0xfffffffd, witness: [] }], outputs: commitOutputs };
commitTx.inputs[0].witness = d.signP2wpkhInput(commitTx, 0, feeU.value);
const commitHex = d.bytesToHex(d.serializeTx(commitTx));
const commitTxid = d.txid(commitTx);

const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: DUST, script: destSpk }] };
const prevouts = [{ value: commitValue, script: p2trSpk }];
revealTx.inputs[0].witness = d.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
const revealHex = d.bytesToHex(d.serializeTx(revealTx));
const revealTxid = d.txid(revealTx);

// Self-check on the SERIALIZED bytes: the reveal must carry exactly one output, and it must be the P2TR
// script for DEST_XONLY (0x22 = 34-byte script length, 0x51 0x20 = OP_1 PUSH32). Cheap, and it is the one
// property whose violation is invisible on-chain.
if (!revealHex.includes('225120' + destHex)) throw new Error('self-check failed: reveal vout 0 is not P2TR(DEST_XONLY)');
if (revealTx.outputs.length !== 1) throw new Error('self-check failed: reveal must have exactly one output');

console.log('--- PARAMETERS (verify each against the CrossOutRecorded event + your burn record) ---');
console.log('claimId   ', claimId);
console.log('assetId   ', assetId);
console.log('cx        ', cx);
console.log('cy        ', cy);
console.log('destXonly ', '0x' + destHex, '  <- reveal vout 0 pays P2TR of this key');
console.log('feeRate', feeRate, 'commitValue', commitValue, 'commitFee', commitFee, 'commitChange', commitChange, 'revealFee', revealFee);
console.log('commitTxid', commitTxid);
console.log('revealTxid', revealTxid);
writeFileSync(OUT_FILE, JSON.stringify({ commitHex, commitTxid, revealHex, revealTxid, claimId, destXonly: '0x' + destHex }, null, 1));
console.log('WROTE', OUT_FILE, '(NOT broadcast — review, then broadcast commit then reveal)');
