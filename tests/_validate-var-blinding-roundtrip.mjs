// Offline round-trip test of the var-take recipient-blinding fix.
// Mirrors fulfilAxferVarIntent (maker) → finalizeAxferVarTake Step 6b (taker):
// the maker derives rRecip with the AXINTENT_BLINDING_DOMAIN keystream and now
// transports it encrypted with the independent ONCHAIN blinding keystream; the
// taker recovers it with the same onchain keystream. Asserts: FIXED recovery
// opens C_recip, the OLD (derivation-keystream) recovery does NOT, and enc is
// not rRecip in the clear (no leak). Run: node tests/_validate-var-blinding-roundtrip.mjs
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
const b2big = (b) => BigInt('0x' + d.bytesToHex(b));

const makerPriv = secp.utils.randomPrivateKey(), makerPub = secp.getPublicKey(makerPriv, true);
const takerPriv = secp.utils.randomPrivateKey(), takerPub = secp.getPublicKey(takerPriv, true);
const intentId = secp.utils.randomPrivateKey().slice(0, 16);  // 16-byte intent_id
const assetId  = secp.utils.randomPrivateKey();               // 32-byte asset_id
const rBytes   = secp.utils.randomPrivateKey();               // per-intent secret
const requested = 300n;

// --- Maker (fulfilAxferVarIntent) ---
const blindingKs  = d.deriveAxintentBlindingKeystream(makerPriv, takerPub, intentId, assetId);
const rRecipBytes = d.xor32(rBytes, blindingKs);                 // rRecip independent of rListed
const rRecip      = b2big(rRecipBytes) % d.SECP_N;
const cRecip      = d.pedersenCommit(requested, rRecip);
const takerKs     = d.deriveAxintentOnchainKeystreams(makerPriv, takerPub, intentId, assetId, 0);
const enc         = d.xor32(rRecipBytes, takerKs.blindingKs);   // NEW transport (independent keystream)

// --- Taker FIXED recovery (Step 6b) ---
const onKs        = d.deriveAxintentOnchainKeystreams(takerPriv, makerPub, intentId, assetId, 0).blindingKs;
const recovered   = b2big(d.xor32(enc, onKs));
const fixedOpens  = d.pedersenCommit(requested, recovered).equals(cRecip);

// --- Taker OLD recovery (the bug: derivation keystream) ---
const oldKs       = d.deriveAxintentBlindingKeystream(takerPriv, makerPub, intentId, assetId);
const oldRec      = b2big(d.xor32(enc, oldKs));
let oldOpens; try { oldOpens = d.pedersenCommit(requested, oldRec).equals(cRecip); } catch { oldOpens = false; }

// --- Leak check: enc must NOT be rRecip in the clear ---
const leaksRecip  = d.bytesToHex(enc) === d.bytesToHex(rRecipBytes);

console.log(`FIXED recovery opens C_recip : ${fixedOpens}`);
console.log(`OLD recovery opens C_recip   : ${oldOpens}   (expect false — that was the bug)`);
console.log(`enc leaks rRecip in clear    : ${leaksRecip}  (expect false)`);
if (fixedOpens && !oldOpens && !leaksRecip) {
  console.log('\n✓ PASS — fixed transport recovers the recipient blinding, old path fails, no plaintext leak.');
  process.exit(0);
}
console.log('\n✗ FAIL'); process.exit(1);
