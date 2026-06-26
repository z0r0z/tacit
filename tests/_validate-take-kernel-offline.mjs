// Offline validation of the take-path kernel-conservation check (the logic added
// to takeAxferOffer) against a REAL settled T_AXFER offer recorded in a prior
// run's state (.local/axintent-signet-state.json.bak-prerun). Fetches the input
// commitment from mempool.space directly (NOT the rate-limited worker), so it
// runs even while the worker's Blockstream quota is exhausted. Asserts: ACCEPT
// the genuine offer, REJECT a tampered output. Run: node tests/_validate-take-kernel-offline.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator; globalThis.prompt = () => null;
globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
const d = await import('../dapp/tacit.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, '..', '.local', 'axintent-signet-state.json.bak-prerun');
const SIGNET = 'https://mempool.space/signet/api';
async function getTx(txid) {
  const r = await fetch(`${SIGNET}/tx/${txid}`);
  if (!r.ok) throw new Error(`mempool ${r.status} for ${txid}`);
  return r.json();
}
// Single defining hop, replicating getParentEnvelopeData for the opcodes that
// can define an asset outpoint (CETCH supply @vout0, or CXFER/AXFER outputs).
function definingCommitment(parentEnv, vout) {
  let p = d.decodeCEtchPayload(parentEnv.payload);
  if (p) { if (vout !== 0) throw new Error('CETCH supply @vout0 only'); return p.commitment; }
  p = d.decodeCXferPayload(parentEnv.payload);
  if (p) { if (vout >= p.outputs.length) throw new Error('CXFER vout oob'); return p.outputs[vout].commitment; }
  p = d.decodeAxferPayload(parentEnv.payload);
  if (p) { if (vout >= p.outputs.length) throw new Error('AXFER vout oob'); return p.outputs[vout].commitment; }
  throw new Error('parent envelope opcode not a recognized asset definer');
}

const state = JSON.parse(readFileSync(STATE, 'utf8'));
const pr = state.fulfil.response.fulfilment.partial_reveal;
console.log(`offer asset_id : ${state.intent.asset_id}`);
console.log(`asset_utxo     : ${pr.inputs[1].txid}:${pr.inputs[1].vout}`);

// Decode the offer envelope (the T_AXFER the maker built) → C_out, kernelSig.
const offEnv = d.decodeEnvelopeScript(d.hexToBytes(pr.inputs[0].witness[1]));
const dec = d.decodeAxferPayload(offEnv.payload);
if (!dec) throw new Error('offer envelope is not T_AXFER');
console.log(`envelope       : T_AXFER, outputs=${dec.outputs.length}, asset_id=${d.bytesToHex(dec.assetId)}`);

// Fetch the input's defining commitment from chain (mempool.space, not worker).
const inTxid = pr.inputs[1].txid, inVout = pr.inputs[1].vout;
const parentTx = await getTx(inTxid);
const pEnv = d.decodeEnvelopeScript(d.hexToBytes(parentTx.vin[0].witness[1]));
const cInBytes = definingCommitment(pEnv, inVout);
console.log(`C_in (chain)   : ${d.bytesToHex(cInBytes).slice(0, 24)}…`);

// --- Replica of the takeAxferOffer kernel-conservation check ---
function kernelOk(coutBytes) {
  const EPrime = d.bytesToPoint(coutBytes).add(d.bytesToPoint(cInBytes).negate());
  if (EPrime.equals(d.ZERO)) return false;
  const kmsg = d.computeKernelMsg(dec.assetId, [{ txid: inTxid, vout: inVout }], [coutBytes]);
  return d.verifySchnorr(dec.kernelSig, kmsg, EPrime.toRawBytes(true).slice(1));
}

const genuine = kernelOk(dec.outputs[0].commitment);
const tampered = Uint8Array.from(dec.outputs[0].commitment);
tampered[tampered.length - 1] ^= 0x01;            // flip one byte of C_out
let tamperedOk;
try { tamperedOk = kernelOk(tampered); } catch { tamperedOk = false; } // invalid point ⇒ reject

console.log(`\nACCEPT genuine offer : ${genuine}`);
console.log(`REJECT tampered C_out: ${!tamperedOk}`);
if (genuine && !tamperedOk) {
  console.log('\n✓ PASS — take-path kernel check accepts the real settled offer and rejects tampering.');
  process.exit(0);
}
console.log('\n✗ FAIL — unexpected verdict.');
process.exit(1);
