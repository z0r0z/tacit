// Conclusive offline unit test of the VAR take kernel check (Step 6c in
// finalizeAxferVarTake). Builds a VALID T_AXFER_VAR kernel exactly as the
// maker (fulfilAxferVarIntent) does — excess = r_recip + r_change - r_listed,
// closing C_recip + C_change - C_listed = excess·G — then asserts the Step 6c
// replica ACCEPTS it and REJECTS tampered outputs / a wrong input commitment.
// Pure math, no network. Run: node tests/_validate-vartake-kernel-synth.mjs
import { JSDOM } from 'jsdom';
import * as secp from '@noble/secp256k1';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator; globalThis.prompt = () => null;
globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
const d = await import('../dapp/tacit.js');

const randScalar = () => { let v = 0n; do { v = BigInt('0x' + d.bytesToHex(secp.utils.randomPrivateKey())) % d.SECP_N; } while (v === 0n); return v; };
const b32 = (x) => { const b = new Uint8Array(32); let v = x; for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };

// --- Maker-side construction (mirror of fulfilAxferVarIntent) ---
const assetId  = secp.utils.randomPrivateKey();          // 32 random bytes as asset_id
const amount   = 1000n, requested = 600n, change = 400n; // requested + change == amount
const rListed  = randScalar();                            // parent (asset_utxo) blinding
const rRecip   = randScalar(), rChange = randScalar();
const cListed  = d.pedersenCommit(amount, rListed);       // == the on-chain C_in
const cRecip   = d.pointToBytes(d.pedersenCommit(requested, rRecip));
const cChange  = d.pointToBytes(d.pedersenCommit(change,   rChange));
const excess   = d.modN(rRecip + rChange - rListed);
const inOutpoint = { txid: d.bytesToHex(secp.utils.randomPrivateKey()), vout: 0 };
const kmsg     = d.computeKernelMsg(assetId, [inOutpoint], [cRecip, cChange]);
const kernelSig = d.signSchnorr(kmsg, b32(excess));

// --- Step 6c replica (mirror of finalizeAxferVarTake) ---
const cInBytes = d.pointToBytes(cListed);
function kernelOk(outCommitments, cIn = cInBytes, outpoint = inOutpoint) {
  let EPrime = d.ZERO;
  for (const c of outCommitments) EPrime = EPrime.add(d.bytesToPoint(c));
  EPrime = EPrime.add(d.bytesToPoint(cIn).negate());
  if (EPrime.equals(d.ZERO)) return false;
  const m = d.computeKernelMsg(assetId, [outpoint], outCommitments);
  return d.verifySchnorr(kernelSig, m, EPrime.toRawBytes(true).slice(1));
}

const genuine = kernelOk([cRecip, cChange]);

const tRecip = Uint8Array.from(cRecip); tRecip[tRecip.length - 1] ^= 0x01;
let tamperRecip; try { tamperRecip = kernelOk([tRecip, cChange]); } catch { tamperRecip = false; }

// Wrong input commitment (attacker claims a different/under-valued input).
const wrongIn = d.pointToBytes(d.pedersenCommit(amount, randScalar()));
let wrongInput; try { wrongInput = kernelOk([cRecip, cChange], wrongIn); } catch { wrongInput = false; }

// Inflated outputs that don't conserve (requested'+change' > amount).
const cBad = d.pointToBytes(d.pedersenCommit(900n, rChange));
let inflated; try { inflated = kernelOk([cRecip, cBad]); } catch { inflated = false; }

console.log(`ACCEPT genuine VAR kernel : ${genuine}`);
console.log(`REJECT tampered C_recip   : ${!tamperRecip}`);
console.log(`REJECT wrong C_in         : ${!wrongInput}`);
console.log(`REJECT non-conserving out : ${!inflated}`);
if (genuine && !tamperRecip && !wrongInput && !inflated) {
  console.log('\n✓ PASS — VAR take Step 6c accepts a valid kernel and rejects tampering / wrong input / inflation.');
  process.exit(0);
}
console.log('\n✗ FAIL'); process.exit(1);
