// ============================================================================
// All third-party JS is vendored: ./vendor/tacit-deps.min.js contains a
// minified bundle of @noble/secp256k1 + @noble/hashes + @scure/base + the
// sats-connect provider abstraction (Xverse / Leather / OKX), produced by
// `cd ../build && npm run build`. Pin the entire dapp/ directory to IPFS to
// get a single CID covering both the HTML and every byte of dependency code.
// The runtime KAT (runStartupKAT, below) is independent defense: known-answer
// tests against published reference vectors that fail closed if any primitive
// returns the wrong output for known input.
//
// No remote scripts are fetched at runtime: anything imported here shares the
// JS realm with `wallet.priv`, so loading even a "wallet-only" library from a
// CDN would expand the wallet's TCB to whoever serves that CDN.
// ============================================================================
import { secp } from './vendor/tacit-deps.min.js';
import { sha256 } from './vendor/tacit-deps.min.js';
import { ripemd160 } from './vendor/tacit-deps.min.js';
import { keccak_256 } from './vendor/tacit-deps.min.js';
import { hmac } from './vendor/tacit-deps.min.js';
import { hexToBytes, bytesToHex, concatBytes } from './vendor/tacit-deps.min.js';
import { bech32 } from './vendor/tacit-deps.min.js';
import { satsConnect as SatsConnect } from './vendor/tacit-deps.min.js';
import { prfRegister, prfLogin, loadPrfMap, savePrfMap, clearPrfMap, isPasskeyAvailable, prfTryRestore } from './prf-wallet.js';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

// Hide broken images globally instead of inlining `onerror="..."` in every
// dynamic <img> template. Inline event-handler attributes count as inline
// scripts and require CSP `script-src 'unsafe-inline'`; a single capture-
// phase listener at the document level achieves the same UX without forcing
// the CSP loose. Image errors don't bubble, hence `useCapture: true`.
document.addEventListener('error', e => {
  if (e.target && e.target.tagName === 'IMG') e.target.style.display = 'none';
}, true);

// ============== NETWORK ==============
// Same local privkey derives a tb1… address on signet and a bc1… address on
// mainnet — flipping `NET` re-renders all addresses without touching the key.
//
// CSP COUPLING: every host below must also appear in the `connect-src`
// allow-list of the meta-CSP in index.html. The strict policy
// (`script-src 'self'`, no wildcards) means changing a host here without
// updating the CSP causes the browser to silently drop fetches with a
// console warning — the dApp will look broken in subtle ways (loading
// spinner forever on the wallet/discover tabs). Same coupling applies to
// `WORKER_BASE`, `IPFS_GATEWAY`, and the `<link href="https://fonts...">`
// tags in index.html.
// `api`  is the primary Esplora endpoint for chain reads.
// `api2` is an OPTIONAL secondary used by the chain-divergence watchdog —
//        every ~5 min the dApp fetches /blocks/tip/height from both and shows
//        a banner if they disagree by more than `CHAIN_DIVERGE_TOLERANCE`
//        blocks. Crypto checks already protect against fabricated data, but
//        a single endpoint can still hide blocks or serve stale tips. Two
//        independent Esplora-compatible endpoints catch that without
//        doubling load on every read. Set `api2: null` to disable the
//        watchdog entirely.
const NETWORKS = {
  signet:  { name: 'signet',  hrp: 'tb', api: 'https://mempool.space/signet/api', api2: 'https://blockstream.info/signet/api', explorer: 'https://mempool.space/signet' },
  mainnet: { name: 'mainnet', hrp: 'bc', api: 'https://mempool.space/api',        api2: 'https://blockstream.info/api',        explorer: 'https://mempool.space' },
};
// How many blocks of disagreement is acceptable before we flag divergence.
// Chain tip propagation usually takes seconds, so 1-2 block lag is normal;
// 3+ blocks of disagreement means one endpoint is meaningfully behind or
// reporting a different chain.
const CHAIN_DIVERGE_TOLERANCE = 3;
// How often the watchdog re-checks. 5 min keeps it cheap (one extra request
// per network per 300s) and is short enough to surface a real outage within
// a useful window.
const CHAIN_DIVERGE_INTERVAL_MS = 5 * 60 * 1000;
const NET_KEY = 'tacit-network-v1';
// Default to mainnet for new visitors. Existing users who previously chose
// signet keep their preference via localStorage. The persistent mainnet
// banner + backup-acknowledgement gates (ensureBurnerBackedUp, the export
// flow on first value-creating op) are the safety nets — there is no
// consent dialog on first load since landing on mainnet is the expected
// behavior of a Bitcoin token dapp.
function currentNetworkName() {
  const v = localStorage.getItem(NET_KEY);
  return v === 'signet' ? 'signet' : 'mainnet';
}
let NET = NETWORKS[currentNetworkName()];
const DUST = 546; // P2WPKH dust limit, conservative

// ============== MAINNET BETA GUARDRAILS ==============
// Mintable etches: allowed on mainnet from day one. Single-key mint authority
// is the local burner key — compromise of the burner = uncapped inflation, so
// the existing `mintable-key-warning` UI surfaces the export-the-key gate
// whenever the user checks the Mintable box. Multisig (MuSig2/FROST) mint
// authority is the safer long-term answer for institutional issuers; the wire
// format already supports any 32-byte x-only pubkey there, so swapping in an
// aggregate key when multisig ships is non-breaking. Flip to false to gate
// mintable etches behind multisig.
const MAINNET_ALLOW_MINTABLE = true;

// Convenience Worker (image upload, demo faucet, asset directory).
// Trust-bearing logic stays in this file; the Worker is purely cache + UX.
// Set BASE to '' to disable all Worker-backed features (upload + auto-faucet + discover).
const WORKER_BASE = 'https://tacit-pin.rosscampbell9.workers.dev';
const PIN_URL      = WORKER_BASE ? WORKER_BASE + '/pin'      : '';
const PIN_JSON_URL = WORKER_BASE ? WORKER_BASE + '/pin-json' : '';
const FAUCET_URL   = WORKER_BASE ? WORKER_BASE + '/drip'     : '';
const REGISTRY_URL = WORKER_BASE ? WORKER_BASE + '/assets'   : '';
// Worker-aggregated marketplace endpoint. Returns { assets, listings: [...] }
// pre-joined with kind + _asset reference, so the Market tab pays one
// round-trip instead of N×3 per-asset fetches.
const MARKET_URL   = WORKER_BASE ? WORKER_BASE + '/market'    : '';
// Worker-aggregated per-user holdings endpoint. POST { owner_pubkey,
// asset_ids } → { openings, listings, range_listings } keyed by asset_id.
// Listings are server-filtered to owner_pubkey so the Holdings tab pays
// one round-trip + a small payload instead of N×3 per-asset fetches.
const HOLDINGS_URL = WORKER_BASE ? WORKER_BASE + '/holdings'  : '';
const HINT_URL     = WORKER_BASE ? WORKER_BASE + '/assets/hint' : '';
const ATTEST_URL   = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/attest` : '';
const MINT_ATTEST_URL = (assetIdHex, mintTxidHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/mints/${mintTxidHex}/attest` : '';
const UTXO_OPENING_URL = (txidHex, vout) => WORKER_BASE ? `${WORKER_BASE}/utxos/${txidHex}/${vout}/opening` : '';
const DISCLOSURES_URL = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/disclosures` : '';
const LISTINGS_URL = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/listings` : '';
const LISTING_DELETE_URL = (assetIdHex, txidHex, vout) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/listings/${txidHex}/${vout}` : '';
const LISTING_CLAIM_URL = (assetIdHex, txidHex, vout) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/listings/${txidHex}/${vout}/claim` : '';
const RANGE_LISTINGS_URL = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/listings-range` : '';
const RANGE_LISTING_DELETE_URL = (assetIdHex, ownerPubHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/listings-range/${ownerPubHex}` : '';
const RANGE_LISTING_CLAIM_URL = (assetIdHex, ownerPubHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/listings-range/${ownerPubHex}/claim` : '';
const ATOMIC_INTENTS_URL = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/atomic-intents` : '';
const ATOMIC_INTENT_DELETE_URL = (assetIdHex, intentIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/atomic-intents/${intentIdHex}` : '';
const ATOMIC_INTENT_CLAIM_URL = (assetIdHex, intentIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/atomic-intents/${intentIdHex}/claim` : '';
const ATOMIC_INTENT_FULFILMENT_URL = (assetIdHex, intentIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/atomic-intents/${intentIdHex}/fulfilment` : '';
const PETCH_REGISTRY_URL = WORKER_BASE ? WORKER_BASE + '/petch-assets' : '';
const PETCH_ASSET_URL = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/petch-assets/${assetIdHex}` : '';
const PMINTS_URL = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/pmints` : '';
const DROPS_URL = WORKER_BASE ? WORKER_BASE + '/drops' : '';
const DROP_URL  = (rootHex) => WORKER_BASE ? `${WORKER_BASE}/drops/${rootHex}` : '';
// Append the active network as a query param. The worker's registry endpoints
// are network-scoped. The dapp defaults to mainnet; users opt into signet
// via the network selector.
function withNet(url, extra = '') {
  if (!url) return '';
  const sep = url.includes('?') ? '&' : '?';
  const params = `network=${encodeURIComponent(NET.name)}${extra ? '&' + extra : ''}`;
  return `${url}${sep}${params}`;
}

// External wallets report their network with their own vocabulary
// (UniSat: 'livenet'/'testnet'/'signet'; sats-connect: 'Mainnet'/'Signet'/...).
// Normalize to our two-network vocabulary. Returns null for unsupported nets
// (testnet3/4, regtest) so the connect flow can warn and bail.
function normalizeWalletNetwork(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'mainnet' || v === 'livenet') return 'mainnet';
  if (v === 'signet') return 'signet';
  return null;
}

// Reconcile the dApp's network with the connected wallet's. Standard
// Bitcoin-dApp behavior: the wallet drives. We don't add a redundant "are
// you sure?" gate here — the wallet's own send popup is the per-tx consent
// for real funds. The manual selector flip (burner mode) keeps its consent
// gate because there's no wallet popup in that path.
//
// Returns:
//   'ok'          — networks match, caller proceeds
//   'reload'      — switching net + reloading; caller must bail
//   'unsupported' — wallet on testnet/regtest; we disconnected; caller bails
function reconcileWalletNetwork(state) {
  if (!state) return 'ok';
  const norm = normalizeWalletNetwork(state.network);
  if (!norm) {
    toast(`Wallet network "${state.network}" is not supported. Tacit runs on signet + mainnet only — switch your wallet's network and reconnect.`, 'error');
    extWallet.disconnect();
    wallet.ext = null;
    return 'unsupported';
  }
  if (norm === NET.name) return 'ok';
  // Wallet is on a supported network we're not yet on. The user actively
  // chose that network in their wallet UI, so treat that as consent — also
  // record it in MAINNET_OK_KEY so a later disconnect to burner mode doesn't
  // re-prompt for something they already opted into.
  if (norm === 'mainnet') localStorage.setItem('tacit-mainnet-consented-v1', '1');
  localStorage.setItem(NET_KEY, norm);
  toast(`Switching to ${norm} to match your wallet…`, 'success');
  // Brief delay so the toast renders before reload nukes the page.
  setTimeout(() => location.reload(), 600);
  return 'reload';
}
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

// IPFS gateway used to render images and dereference metadata blobs. Trailing slash required.
const IPFS_GATEWAY = 'https://content.wrappr.wtf/ipfs/';

// ============== HASH HELPERS ==============
const hash256 = b => sha256(sha256(b));
const hash160 = b => ripemd160(sha256(b));
const reverseBytes = b => { const r = new Uint8Array(b); r.reverse(); return r; };

// ============== BYTE WRITER ==============
class W {
  constructor() { this.parts = []; }
  push(b) { this.parts.push(b); return this; }
  u8(n)   { this.parts.push(new Uint8Array([n & 0xff])); return this; }
  u32(n)  { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return this.push(b); }
  u64(n)  { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return this.push(b); }
  varint(n) {
    if (n < 0xfd)        return this.u8(n);
    if (n < 0x10000)     { this.u8(0xfd); const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return this.push(b); }
    if (n < 0x100000000) { this.u8(0xfe); const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return this.push(b); }
    this.u8(0xff); return this.u64(n);
  }
  out() { return concatBytes(...this.parts); }
}

const p2wpkhScript = pubkey => concatBytes(new Uint8Array([0x00, 0x14]), hash160(pubkey));
const p2wpkhAddress = pubkey => bech32.encode(NET.hrp, [0, ...bech32.toWords(hash160(pubkey))]);

// ============== BIP143 SIGHASH ==============
function sighashV0(tx, idx, scriptCode, value) {
  const w = new W();
  w.u32(tx.version);
  const wp = new W();
  for (const i of tx.inputs) { wp.push(reverseBytes(hexToBytes(i.txid))); wp.u32(i.vout); }
  w.push(hash256(wp.out()));
  const ws = new W();
  for (const i of tx.inputs) ws.u32(i.sequence);
  w.push(hash256(ws.out()));
  const inp = tx.inputs[idx];
  w.push(reverseBytes(hexToBytes(inp.txid)));
  w.u32(inp.vout);
  w.varint(scriptCode.length).push(scriptCode);
  w.u64(value);
  w.u32(inp.sequence);
  const wo = new W();
  for (const o of tx.outputs) { wo.u64(o.value); wo.varint(o.script.length).push(o.script); }
  w.push(hash256(wo.out()));
  w.u32(tx.locktime);
  w.u32(0x01); // SIGHASH_ALL
  return hash256(w.out());
}

// BIP-143 sighash with a chosen hashType. Used by the atomic-listing maker
// to sign with SIGHASH_SINGLE | ANYONECANPAY (= 0x83), which binds only this
// input + its same-index output. The taker can then append BTC inputs and
// outputs without invalidating the maker's sigs.
function sighashV0WithType(tx, idx, scriptCode, value, hashType) {
  const w = new W();
  w.u32(tx.version);
  const ZERO32 = new Uint8Array(32);
  const acp = (hashType & 0x80) === 0x80;
  const baseHt = hashType & 0x1f;
  // hashPrevouts: zero if ANYONECANPAY; else hash all prevouts.
  if (acp) w.push(ZERO32);
  else {
    const wp = new W();
    for (const i of tx.inputs) { wp.push(reverseBytes(hexToBytes(i.txid))); wp.u32(i.vout); }
    w.push(hash256(wp.out()));
  }
  // hashSequence: zero unless ALL (and not ANYONECANPAY).
  if (!acp && baseHt === 0x01) {
    const ws = new W();
    for (const i of tx.inputs) ws.u32(i.sequence);
    w.push(hash256(ws.out()));
  } else {
    w.push(ZERO32);
  }
  // This input.
  const inp = tx.inputs[idx];
  w.push(reverseBytes(hexToBytes(inp.txid)));
  w.u32(inp.vout);
  w.varint(scriptCode.length).push(scriptCode);
  w.u64(value);
  w.u32(inp.sequence);
  // hashOutputs: depends on baseHt.
  if (baseHt === 0x01) {
    const wo = new W();
    for (const o of tx.outputs) { wo.u64(o.value); wo.varint(o.script.length).push(o.script); }
    w.push(hash256(wo.out()));
  } else if (baseHt === 0x03) {
    // SINGLE: hash the output at this input's index. If no such output, BIP-143
    // says use 32 zero bytes. The atomic-listing flow always provides a
    // matching output, but we follow the spec to be safe.
    if (idx < tx.outputs.length) {
      const o = tx.outputs[idx];
      const wo = new W();
      wo.u64(o.value); wo.varint(o.script.length).push(o.script);
      w.push(hash256(wo.out()));
    } else {
      w.push(ZERO32);
    }
  } else {
    // NONE: zero.
    w.push(ZERO32);
  }
  w.u32(tx.locktime);
  w.u32(hashType & 0xffffffff);
  return hash256(w.out());
}

function serializeTx(tx, withWitness = true) {
  const hasWit = withWitness && tx.inputs.some(i => i.witness && i.witness.length);
  const w = new W();
  w.u32(tx.version);
  if (hasWit) w.push(new Uint8Array([0x00, 0x01]));
  w.varint(tx.inputs.length);
  for (const i of tx.inputs) {
    w.push(reverseBytes(hexToBytes(i.txid)));
    w.u32(i.vout);
    const ss = i.scriptSig || new Uint8Array(0);
    w.varint(ss.length).push(ss);
    w.u32(i.sequence);
  }
  w.varint(tx.outputs.length);
  for (const o of tx.outputs) { w.u64(o.value); w.varint(o.script.length).push(o.script); }
  if (hasWit) {
    for (const i of tx.inputs) {
      const wit = i.witness || [];
      w.varint(wit.length);
      for (const item of wit) w.varint(item.length).push(item);
    }
  }
  w.u32(tx.locktime);
  return w.out();
}
const txid = tx => bytesToHex(reverseBytes(hash256(serializeTx(tx, false))));

function derEncodeFromCompact(rs) {
  const trim = (x) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let t = x.slice(i);
    if (t[0] & 0x80) t = concatBytes(new Uint8Array([0]), t);
    return t;
  };
  const r = trim(rs.slice(0, 32));
  const s = trim(rs.slice(32, 64));
  return concatBytes(
    new Uint8Array([0x30, 4 + r.length + s.length]),
    new Uint8Array([0x02, r.length]), r,
    new Uint8Array([0x02, s.length]), s
  );
}
function sign(hash, priv) {
  const sig = secp.sign(hash, priv, { lowS: true });
  return concatBytes(derEncodeFromCompact(sig.toCompactRawBytes()), new Uint8Array([0x01]));
}

// ============== WALLET ==============
// Storage keys are namespaced by network so signet and mainnet have disjoint
// wallets. A compromised dev/test environment on signet does NOT leak the
// mainnet identity, and the user can run both networks side-by-side without
// the same key signing real-money operations after testing on signet.
//
// Layout:
//   tacit-wallet-v1:signet                  ← local signet identity
//   tacit-wallet-v1:mainnet                 ← local mainnet identity
//   tacit-wallet-v1:signet:by:tb1q…         ← signet, bound to ext-wallet addr
//   tacit-wallet-v1:mainnet:by:bc1q…        ← mainnet, bound to ext-wallet addr
//
// (Older builds used the un-namespaced key `tacit-wallet-v1` for both
// networks. We don't auto-migrate it: the user can manually Import key if
// they want to bring an older identity onto a specific network.)
const WALLET_KEY_BASE = 'tacit-wallet-v1';
function walletStorageKey(boundExtAddr = null) {
  return boundExtAddr
    ? `${WALLET_KEY_BASE}:${NET.name}:by:${boundExtAddr.toLowerCase()}`
    : `${WALLET_KEY_BASE}:${NET.name}`;
}
const EXT_MODE_KEY = 'tacit-ext-mode-v1';   // 'sats-connect' | 'unisat' | null
// Tab-session ext-wallet state cache. The `{provider, address, pubkey, network}`
// blob is non-secret (all addresses/pubkeys go on chain), so caching it in
// sessionStorage lets refresh skip the wallet's getAccounts/requestAccounts
// round-trip — which on some wallets surfaces a "reconnect?" popup even when
// the origin is already authorized. Cleared on disconnect; tab-scoped so a new
// tab still gets the official authorization flow.
const EXT_STATE_KEY = 'tacit-ext-state-v1';
function _cacheExtState(state) {
  try {
    if (state && state.provider && state.address) {
      sessionStorage.setItem(EXT_STATE_KEY, JSON.stringify(state));
    }
  } catch { /* sessionStorage may be unavailable */ }
}
function _readCachedExtState() {
  try {
    const raw = sessionStorage.getItem(EXT_STATE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || !j.provider || !j.address) return null;
    return j;
  } catch {
    try { sessionStorage.removeItem(EXT_STATE_KEY); } catch {}
    return null;
  }
}
function _clearCachedExtState() {
  try { sessionStorage.removeItem(EXT_STATE_KEY); } catch {}
}

// ============== ENCRYPTED-AT-REST PRIVKEY ==============
// AES-GCM ciphertext of the privkey, key derived via PBKDF2-SHA256 at OWASP
// 2023's 600k iterations. Defense against localStorage exfiltration: malicious
// browser extensions, stolen unlocked devices, XSS that reads localStorage.
// NOT a defense against forgotten passphrase — for that, the user must
// independently back up the raw privkey via the Export Key flow.
const PBKDF2_ITER = 600000;
const STORAGE_FORMAT_VERSION = 1;

async function _deriveKDFKey(passphrase, salt, iterations) {
  const pwBytes = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey, 256,
  );
  return new Uint8Array(bits);
}

async function encryptPrivkey(privBytes, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = await _deriveKDFKey(passphrase, salt, PBKDF2_ITER);
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, privBytes);
  return JSON.stringify({
    v: STORAGE_FORMAT_VERSION, kdf: 'pbkdf2', iter: PBKDF2_ITER,
    salt: bytesToHex(salt), iv: bytesToHex(iv),
    ct: bytesToHex(new Uint8Array(ct)),
  });
}

async function decryptPrivkey(blobJson, passphrase) {
  let blob;
  try { blob = JSON.parse(blobJson); } catch { throw new Error('storage blob is malformed JSON'); }
  if (blob.v !== STORAGE_FORMAT_VERSION) throw new Error(`unsupported wallet format v${blob.v}`);
  if (blob.kdf !== 'pbkdf2') throw new Error(`unsupported kdf: ${blob.kdf}`);
  // Cap PBKDF2 iterations at 5M so a tampered blob (malicious extension, XSS)
  // can't DoS the unlock thread by setting iter to billions. Floor at 100k for
  // back-compat with older blobs.
  const PBKDF2_ITER_MAX = 5_000_000;
  const iter = Number.isInteger(blob.iter) && blob.iter >= 100000
    ? Math.min(blob.iter, PBKDF2_ITER_MAX)
    : PBKDF2_ITER;
  const salt = hexToBytes(blob.salt);
  const iv   = hexToBytes(blob.iv);
  const ct   = hexToBytes(blob.ct);
  const keyBytes = await _deriveKDFKey(passphrase, salt, iter);
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  let ptBuf;
  try { ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct); }
  catch { throw new Error('wrong passphrase or corrupted wallet data'); }
  const priv = new Uint8Array(ptBuf);
  if (priv.length !== 32) throw new Error('decrypted blob is not a 32-byte privkey');
  return priv;
}

// Storage shape detection: legacy 64-hex plaintext (pre-encryption) vs
// JSON-encoded encrypted blob.
function _storageShape(raw) {
  if (!raw) return 'empty';
  if (/^[0-9a-f]{64}$/.test(raw)) return 'plaintext';
  if (raw.startsWith('{')) return 'encrypted';
  return 'unknown';
}

// 12-char minimum follows OWASP/NIST guidance for password-derived keys subject
// to offline attack — 8 chars at 600k PBKDF2 is brute-forceable in hours on a
// GPU farm if the localStorage blob is exfiltrated. A password manager is
// recommended; this is the floor.
const PASSPHRASE_MIN_LEN = 12;

// DOM-based passphrase modal — replaces native prompt() for two reasons:
// (1) Chrome silently suppresses prompt() right after a wallet-extension popup
// closes (user-activation expires), which is exactly when we need to ask for a
// passphrase; (2) inline char-count + match validation gives the user a hint
// before they submit instead of after. Resolves to the entered string or
// rejects with Error('cancelled').
function _passphraseModal({ mode, title, reason, errorHint }) {
  return new Promise((resolve, reject) => {
    const modal   = document.getElementById('pass-modal');
    const titleEl = document.getElementById('pass-title');
    const reasonEl= document.getElementById('pass-reason');
    const form    = document.getElementById('pass-form');
    const input1  = document.getElementById('pass-input-1');
    const input2  = document.getElementById('pass-input-2');
    const label1  = document.getElementById('pass-label-1');
    const hint1   = document.getElementById('pass-hint-1');
    const hint2   = document.getElementById('pass-hint-2');
    const field2  = document.getElementById('pass-field-2');
    const warn    = document.getElementById('pass-warn');
    const submit  = document.getElementById('pass-submit');
    const cancelBtn = document.getElementById('pass-cancel');
    if (!modal || !form || !input1) {
      reject(new Error('passphrase modal not in DOM'));
      return;
    }
    const isNew = mode === 'new';
    titleEl.textContent = title;
    reasonEl.textContent = reason;
    input1.value = ''; input2.value = '';
    label1.textContent = isNew ? `new passphrase (≥ ${PASSPHRASE_MIN_LEN} chars)` : 'passphrase';
    input1.autocomplete = isNew ? 'new-password' : 'current-password';
    input2.autocomplete = 'new-password';
    field2.style.display = isNew ? '' : 'none';
    warn.style.display   = isNew ? '' : 'none';
    submit.textContent   = isNew ? 'set passphrase' : 'unlock';
    submit.disabled = true;

    if (errorHint) {
      hint1.textContent = errorHint;
      hint1.className = 'pass-hint error';
    } else {
      hint1.textContent = ''; hint1.className = 'pass-hint';
    }
    hint2.textContent = ''; hint2.className = 'pass-hint';

    const validate = () => {
      const v1 = input1.value, v2 = input2.value;
      if (isNew) {
        if (v1.length === 0) {
          if (!errorHint) { hint1.textContent = ''; hint1.className = 'pass-hint'; }
        } else if (v1.length < PASSPHRASE_MIN_LEN) {
          hint1.textContent = `${v1.length} / ${PASSPHRASE_MIN_LEN} chars`;
          hint1.className = 'pass-hint error';
        } else {
          hint1.textContent = `${v1.length} chars · ok`;
          hint1.className = 'pass-hint ok';
        }
        if (v2.length === 0) {
          hint2.textContent = ''; hint2.className = 'pass-hint';
        } else if (v1 === v2) {
          hint2.textContent = 'matches';
          hint2.className = 'pass-hint ok';
        } else {
          hint2.textContent = "doesn't match";
          hint2.className = 'pass-hint error';
        }
        submit.disabled = !(v1.length >= PASSPHRASE_MIN_LEN && v1 === v2);
      } else {
        submit.disabled = v1.length === 0;
      }
    };

    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); } };
    const cleanup = () => {
      input1.removeEventListener('input', validate);
      input2.removeEventListener('input', validate);
      document.removeEventListener('keydown', onKey, true);
      form.onsubmit = null;
      cancelBtn.onclick = null;
      modal.style.display = 'none';
      input1.value = ''; input2.value = '';
    };

    input1.addEventListener('input', validate);
    input2.addEventListener('input', validate);
    document.addEventListener('keydown', onKey, true);
    form.onsubmit = (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      const v = input1.value;
      cleanup();
      resolve(v);
    };
    cancelBtn.onclick = () => { cleanup(); reject(new Error('cancelled')); };
    modal.style.display = 'grid';
    // requestAnimationFrame so the modal is painted before focus moves;
    // otherwise some browsers skip the focus when display flips from none.
    requestAnimationFrame(() => input1.focus());
  });
}

// The unlocked privkey lives only in `wallet.priv` (JS module memory). A page
// reload prompts for the passphrase again — there is no persistent cache that
// a post-unlock XSS could read without standing up its own passphrase prompt.

async function _promptNewPassphrase(reason) {
  return _passphraseModal({ mode: 'new', title: 'set passphrase', reason });
}

async function _promptUnlockPassphrase(errorHint) {
  return _passphraseModal({
    mode: 'unlock',
    title: 'unlock tacit wallet',
    reason: 'enter the passphrase you set when creating this wallet to unlock the in-browser tacit signing key.',
    errorHint,
  });
}

const wallet = {
  priv: null, pub: null,
  // External-wallet session info — single source of truth lives in
  // extWallet.state. These accessors are sugar so call sites that pre-date
  // the extWallet abstraction can stay as `wallet.ext`. Both names point at
  // the same { provider, address, pubkey, network } object (or null when
  // disconnected). Forward reference to extWallet (defined below) is fine
  // because getters/setters resolve at access time, not declaration time.
  get ext()  { return extWallet.state; },
  set ext(v) { extWallet.state = v; },

  async load(boundExtAddr = null) {
    const key = walletStorageKey(boundExtAddr);
    const raw = localStorage.getItem(key);
    const shape = _storageShape(raw);
    if (shape === 'empty') {
      // Reason copy varies with binding: when the burner is being created
      // alongside an external-wallet connect, name the relationship explicitly
      // so the user understands the ext wallet isn't being skipped or replaced.
      const reason = boundExtAddr
        ? `Set a passphrase to encrypt the in-browser tacit signing key linked to ${shorten(boundExtAddr, 8)}. Your connected wallet funds this key but does not sign envelopes.`
        : 'Set a passphrase to encrypt your in-browser tacit signing key. This key signs every confidential envelope you create.';
      const passphrase = await _promptNewPassphrase(reason);
      this.priv = secp.utils.randomPrivateKey();
      localStorage.setItem(key, await encryptPrivkey(this.priv, passphrase));
    } else if (shape === 'plaintext') {
      // One-time migration from the pre-encryption format. Adopt the existing
      // privkey, prompt for a passphrase, re-encrypt. User's tokens unchanged.
      // Validate the legacy bytes are a usable secp256k1 scalar BEFORE encrypting:
      // a malformed legacy entry (zero, ≥ N) would otherwise produce an encrypted
      // blob of an invalid privkey, then throw at getPublicKey, leaving the user
      // wedged with a blob they can't decrypt or replace without manual cleanup.
      const candidate = hexToBytes(raw);
      secp.getPublicKey(candidate, true); // throws on out-of-range scalar
      const passphrase = await _promptNewPassphrase(
        'Encrypting your existing tacit wallet at rest. Your privkey and tokens are unchanged — this only adds passphrase protection.',
      );
      this.priv = candidate;
      localStorage.setItem(key, await encryptPrivkey(this.priv, passphrase));
    } else if (shape === 'encrypted') {
      let priv = null, lastErr = null, errorHint = '';
      for (let attempt = 0; attempt < 3 && !priv; attempt++) {
        try {
          const passphrase = await _promptUnlockPassphrase(errorHint);
          priv = await decryptPrivkey(raw, passphrase);
        } catch (e) {
          lastErr = e;
          if (e.message === 'cancelled') break;
          // Surface the decrypt error inline on the next modal display rather
          // than via alert(), which has the same suppression problem prompt()
          // does.
          const left = 2 - attempt;
          errorHint = `${e.message}${left > 0 ? ` · ${left} attempt${left === 1 ? '' : 's'} left` : ''}`;
        }
      }
      if (!priv) throw lastErr || new Error('unlock failed');
      this.priv = priv;
    } else {
      throw new Error(`unknown wallet storage format at ${key}`);
    }
    this.pub = secp.getPublicKey(this.priv, true);
  },

  async setPriv(hex, boundExtAddr = null) {
    const clean = hex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error('private key must be 64 hex chars');
    const b = hexToBytes(clean);
    secp.getPublicKey(b, true);
    const passphrase = await _promptNewPassphrase('Set a passphrase to encrypt the imported privkey at rest.');
    this.priv = b;
    this.pub = secp.getPublicKey(b, true);
    const key = walletStorageKey(boundExtAddr);
    localStorage.setItem(key, await encryptPrivkey(b, passphrase));
  },

  async regenerate(boundExtAddr = null) {
    const passphrase = await _promptNewPassphrase('Set a passphrase for the new wallet.');
    this.priv = secp.utils.randomPrivateKey();
    this.pub = secp.getPublicKey(this.priv, true);
    const key = walletStorageKey(boundExtAddr);
    localStorage.setItem(key, await encryptPrivkey(this.priv, passphrase));
  },
  address() { return p2wpkhAddress(this.pub); },
  pubHex()  { return bytesToHex(this.pub); },
  xonly()   { return this.pub.slice(1); }
};
wallet.mode = null; // null = password/burner · 'passkey' = passkey PRF

// ============== BURNER BACKUP GATE ==============
// The local "burner" privkey is the trust root for every tacit asset the user
// holds — losing it means losing those assets, regardless of whether an
// external wallet (Xverse / UniSat / Leather) is connected to fund operations.
// Most users won't intuit this: they'll think "my Xverse is backed up so I'm
// safe" while their tacit identity lives only in this browser's localStorage.
//
// We require an *explicit* per-key backup acknowledgement before any operation
// that would cause the burner to take custody of asset value. Acknowledgement
// is recorded under the key's own pubkey hash so importing/regenerating a key
// resets the gate — there's no way to inherit another key's "backed up" flag.
//
// On mainnet the gate is mandatory. On signet it's a soft warning (signet sats
// have no value); we keep the ack so that flipping signet→mainnet later
// doesn't surprise the user.
const BACKUP_ACK_PREFIX = 'tacit-backup-ack-v1:';
function _burnerAckKey() {
  // Per-pubkey: re-import or regen invalidates the ack automatically.
  return BACKUP_ACK_PREFIX + (wallet.pub ? bytesToHex(wallet.pub) : 'null');
}
function isBurnerBackedUp() {
  if (!wallet.pub) return false;
  return localStorage.getItem(_burnerAckKey()) === '1';
}
function markBurnerBackedUp() {
  localStorage.setItem(_burnerAckKey(), '1');
  if (typeof markOnboarded === 'function') markOnboarded();
}
// Surface the export modal, then record an ack on success. Returns true if
// the user acknowledges, false if they cancel. Caller should refuse the
// pending op on `false`.
function ensureBurnerBackedUp(opLabel) {
  // Passkey credential is the backup — skip export/ack gate.
  if (wallet.mode === 'passkey') return true;
  if (isBurnerBackedUp()) return true;
  const onMainnet = NET.name === 'mainnet';
  const tier = onMainnet ? '⚠ MAINNET' : 'signet';
  const body =
    `[${tier}] ${opLabel}\n\n` +
    'The privkey in your browser (the one shown on the Wallet tab) is what controls every tacit asset UTXO you create. ' +
    'If you lose this browser\'s localStorage — cache clear, device loss, switching browsers — those assets are unrecoverable.\n\n' +
    'Click OK to view the key now and save it somewhere safe (password manager, paper backup, hardware-wallet seed slip). Click Cancel to abort.';
  if (!confirm(body)) return false;
  // Show the key. We use prompt() because it's the only built-in modal that
  // also lets the user select+copy the value; the broader UX cleanup (replace
  // with a styled modal) is tracked separately in the production-readiness
  // notes (see B17).
  prompt('Your private key (hex). Save somewhere safe — there is no recovery:', bytesToHex(wallet.priv));
  // Second confirm so a single "OK" click can't ack-and-proceed; the user has
  // to actively assert they wrote it down.
  if (!confirm('Did you save the private key somewhere you can recover it from?\n\nOK = yes, save the acknowledgement and proceed. Cancel = stop.')) return false;
  markBurnerBackedUp();
  return true;
}

// ============== PASSKEY / PRF ==============
// Bridges WebAuthn PRF key derivation into the existing wallet object: the
// PRF output becomes wallet.priv directly so every signing path (ECDSA,
// Schnorr, blinding derivation) is identical to passphrase mode. No
// localStorage blob — the passkey itself is the persistent backing store.
const prfWallet = {
  state: null, // { label, credentialId, pubkey }

  available() { return isPasskeyAvailable(); },

  async register(label) {
    const { credentialId, priv, pub, pubHex } = await prfRegister(label);
    return this._setupSession({ credentialId, priv, pub, pubHex, label });
  },

  // Authenticate with saved passkey. Resolves label → credentialId from
  // the PRF map so reload auto-login targets the specific credential.
  async login(opts = {}) {
    let { credentialId, label } = opts;
    if (!credentialId && label) {
      const map = loadPrfMap();
      credentialId = map[label]?.credentialId;
    }
    const result = await prfLogin({ credentialId });
    return this._setupSession({ ...result, label });
  },

  // Hand the PRF-derived priv directly to wallet.priv. The previous
  // implementation wrote the priv into a localStorage blob keyed by a
  // throw-away random "session password" and immediately re-decrypted it —
  // the password was never persisted, so the blob was unreadable next
  // session and contributed nothing but a stale entry under WALLET_KEY_BASE.
  // Skipping the round-trip eliminates that orphan and the failure modes it
  // created (e.g. a later password-mode unlock seeing the blob via
  // _hasAnyExistingWallet and prompting for an unguessable passphrase).
  async _setupSession({ credentialId, priv, pub, pubHex, label }) {
    // Welcome-flow exclusivity: ext / passkey / local are alternative auth
    // paths, never combined. If the caller is mid-session in ext mode (e.g.
    // a saved-passkey panel row clicked while wallet.ext is bound, or any
    // future code path that lets ext + passkey overlap) drop the ext
    // binding first so the resulting state is single-mode and the badges,
    // mainnet hints, and backup gate all see one consistent identity.
    if (wallet.ext) extWallet.disconnect();
    wallet.priv = new Uint8Array(priv); // copy: caller zeroes `priv` below
    wallet.pub = pub;
    wallet.mode = 'passkey';
    const map = loadPrfMap();
    const entryLabel = label || `passkey-${pubHex.slice(0, 6)}`;
    // Don't store address — same passkey produces the same priv on every
    // network, but the bech32 address is HRP-dependent. Storing a frozen
    // address means renderPasskeyPanel would show a stale tb1…/bc1… prefix
    // after a network switch. Compute at render time from `pubkey`.
    const prev = map[entryLabel] || {};
    map[entryLabel] = {
      credentialId,
      pubkey: pubHex,
      createdAt: prev.createdAt || Date.now(),
      lastUsed: Date.now(),
    };
    savePrfMap(map);
    this.state = { label: entryLabel, credentialId, pubkey: pubHex };
    priv.fill(0);
    setActiveWalletMode('passkey');
    return this.state;
  },

  // Lock: clear in-memory wallet state. The PRF map persists so next reload
  // auto-logs in via tryRestore — the passkey itself is the source of truth.
  lock() {
    this.state = null;
    wallet.mode = null;
    wallet.pub = null;
    wallet.priv = null;
  },

  tryRestore() {
    const result = prfTryRestore();
    if (result) this.state = result;
    return result;
  },
};

// Tracks which wallet path was last used so init() can prefer it on reload
// instead of always running the passkey path first. Without this, a user
// with both an external wallet AND a passkey gets a passkey OS prompt every
// reload, and the only way back to ext-wallet flow is to cancel — which
// previously also wiped their passkey map.
const ACTIVE_MODE_KEY = 'tacit-active-mode-v1';
function getActiveWalletMode() {
  const v = localStorage.getItem(ACTIVE_MODE_KEY);
  return v === 'passkey' || v === 'ext' || v === 'local' ? v : null;
}
function setActiveWalletMode(mode) {
  if (mode === 'passkey' || mode === 'ext' || mode === 'local') {
    localStorage.setItem(ACTIVE_MODE_KEY, mode);
  }
}

// Render saved passkey list in Manage Wallet drawer. Each entry is a clickable
// row that re-authenticates with that specific credential. Active entry
// highlighted in orange. Hidden when no passkeys are saved.
function renderPasskeyPanel() {
  const info = document.getElementById('passkey-wallet-info');
  const list = document.getElementById('passkey-wallet-list');
  if (!info || !list) return;
  const map = loadPrfMap();
  const labels = Object.keys(map);
  if (!labels.length) { info.style.display = 'none'; return; }
  info.style.display = '';
  list.innerHTML = '';
  for (const lbl of labels) {
    const e = map[lbl];
    const active = prfWallet.state && prfWallet.state.label === lbl;
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = `text-align:left;padding:6px 10px;border:1px solid ${active ? 'var(--orange)' : 'var(--ink-faint)'};background:${active ? 'var(--bg-warm)' : 'var(--bg)'};cursor:pointer;font-size:11px;font-family:inherit;display:flex;justify-content:space-between;width:100%;`;
    const span = document.createElement('span');
    span.textContent = lbl;
    const meta = document.createElement('span');
    meta.style.cssText = 'color:var(--ink-mid);font-size:10px;text-transform:none;letter-spacing:0;';
    // Compute address at render time so the bech32 HRP matches the active
    // network (same passkey → same priv on signet/mainnet, different addr).
    let addrPreview = '-';
    if (e.pubkey) {
      try { addrPreview = p2wpkhAddress(hexToBytes(e.pubkey)).slice(0, 10) + '...'; }
      catch { addrPreview = '-'; }
    }
    meta.textContent = `${addrPreview}${active ? ' ✓' : ''}`;
    row.append(span, meta);
    row.onclick = async () => {
      if (active) return;
      try {
        await prfWallet.login({ label: lbl });
        wallet.mode = 'passkey';
        renderPasskeyPanel();
        refreshWallet();
      } catch (e) { toast('Passkey: ' + e.message, 'error'); }
    };
    list.appendChild(row);
  }
}

// Register/login modal: label input + Register/Login/Cancel buttons.
// Register creates a new passkey credential; Login authenticates with
// existing one (targets saved credential when label matches the PRF map).
//
// Single `inflight` guard so a slow Register can't have its in-flight
// navigator.credentials.create() raced by a Login click — most authenticators
// reject the parallel call but the modal would be left in a half-disabled
// state.
async function _showPasskeyModal() {
  const modal = document.getElementById('passkey-modal');
  const registerBtn = document.getElementById('passkey-register');
  const loginBtn = document.getElementById('passkey-login');
  const cancelBtn = document.getElementById('passkey-cancel');
  const labelInput = document.getElementById('passkey-label-input');
  if (!modal || !registerBtn || !loginBtn || !cancelBtn || !labelInput) return;
  let inflight = false;
  const setInflight = (v) => {
    inflight = v;
    registerBtn.disabled = v;
    loginBtn.disabled = v;
  };
  const close = () => {
    registerBtn.onclick = loginBtn.onclick = cancelBtn.onclick = null;
    setInflight(false);
    modal.style.display = 'none';
  };
  const label = () => { const v = labelInput.value.trim(); return v || null; };
  return new Promise((resolve) => {
    cancelBtn.onclick = () => { if (inflight) return; close(); resolve(false); };
    registerBtn.onclick = async () => {
      if (inflight) return;
      if (!label()) { toast('Label is required.', 'error'); return; }
      setInflight(true);
      try {
        await prfWallet.register(label());
        close();
        resolve(true);
      } catch (e) { toast('Passkey: ' + e.message, 'error'); setInflight(false); }
    };
    loginBtn.onclick = async () => {
      if (inflight) return;
      setInflight(true);
      try {
        await prfWallet.login({ label: label() });
        close();
        resolve(true);
      } catch (e) { toast('Passkey: ' + e.message, 'error'); setInflight(false); }
    };
    modal.style.display = 'grid';
    labelInput.focus();
  });
}

// ============== JUST-IN-TIME FUNDING ==============
// Magic Eden / Phoenix-style flow: don't ask the user to fund the wallet as a
// separate setup step. Instead, when they click Etch / Transfer / Mint / Burn,
// check whether the wallet has enough sats to cover the action; if not, pop
// the most appropriate funding flow inline (external-wallet sendBitcoin →
// faucet drip on signet → manual address copy on mainnet without ext wallet)
// and wait for the funding tx to land before letting the action proceed.
//
// Returns true if the wallet has (or now has) sufficient sats; false if the
// user cancelled or funding failed. Callers should bail on `false`.
async function ensureSatsFunded(targetSats, opLabel) {
  const fmt = n => Number(n).toLocaleString('en-US');
  const onSignet = NET.name === 'signet';

  let utxos;
  try { utxos = await getUtxos(wallet.address()); }
  catch (e) { toast(`Balance check failed: ${e.message}`, 'error'); return false; }
  let balance = utxos.reduce((a, u) => a + u.value, 0);
  if (balance >= targetSats) return true;

  const needed = targetSats - balance;
  const padded = Math.max(needed + 1000, 5000);   // pad so the next action also fits

  // Path 1: ext wallet connected → one popup, sendBitcoin, then poll for indexing.
  if (wallet.ext) {
    const provLabel = wallet.ext.provider === 'sats-connect' ? 'Xverse / Leather' : wallet.ext.provider;
    const ok = confirm(
      `${opLabel} needs ~${fmt(targetSats)} sats for fees (you have ${fmt(balance)}).\n\n` +
      `Send ${fmt(padded)} sats from your ${provLabel} wallet to your tacit address now?`,
    );
    if (!ok) return false;
    let txid;
    try { txid = await extWallet.sendSats(wallet.address(), padded); }
    catch (e) { toast(`Funding failed: ${e.message}`, 'error'); return false; }
    toast(`Funding broadcast${txid ? ' · tx ' + shorten(txid, 8) : ''} · waiting for mempool…`, 'success');
    // Poll mempool.space for indexing. Signet/mainnet typically index in 1–10s.
    const start = Date.now();
    while (Date.now() - start < 45000) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        utxos = await getUtxos(wallet.address());
        balance = utxos.reduce((a, u) => a + u.value, 0);
        if (balance >= targetSats) {
          toast(`Tacit funded · ${fmt(balance)} sats`, 'success');
          refreshWallet().catch(() => {});
          return true;
        }
      } catch {}
    }
    toast('Funding tx broadcast but not yet visible — try the action again in a moment.', 'error');
    return false;
  }

  // Path 2: signet, no ext wallet → faucet drip (if configured + ready).
  if (onSignet && FAUCET_URL) {
    const ok = confirm(
      `${opLabel} needs ~${fmt(targetSats)} sats for fees (you have ${fmt(balance)}).\n\n` +
      `Pull a faucet drip (~20,000 signet sats) to your tacit address now?`,
    );
    if (!ok) return false;
    try {
      const resp = await fetch(FAUCET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: wallet.address() }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
      toast(`Drip sent: ${j.amount_sats} sats${j.txid ? ' · tx ' + j.txid.slice(0, 10) + '…' : ''} · waiting for mempool…`, 'success');
    } catch (e) { toast(`Drip failed: ${e.message}`, 'error'); return false; }
    const start = Date.now();
    while (Date.now() - start < 45000) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        utxos = await getUtxos(wallet.address());
        balance = utxos.reduce((a, u) => a + u.value, 0);
        if (balance >= targetSats) {
          toast(`Tacit funded · ${fmt(balance)} sats`, 'success');
          refreshWallet().catch(() => {});
          return true;
        }
      } catch {}
    }
    toast('Drip broadcast but not yet visible — try the action again in a moment.', 'error');
    return false;
  }

  // Path 3: mainnet, no ext wallet, no faucet → tell the user the address and bail.
  alert(
    `${opLabel} needs ~${fmt(targetSats)} sats for fees (you have ${fmt(balance)}).\n\n` +
    `Send at least ${fmt(needed)} sats to your tacit address from any Bitcoin wallet:\n\n${wallet.address()}\n\n` +
    `Then retry the action. Tip: clicking "Connect Xverse / Leather / UniSat" on the Wallet tab makes this a one-click flow next time.`,
  );
  return false;
}

// Heuristic upper-bound on sats needed to broadcast one tacit op (commit + reveal).
// CXFER/BURN may pull existing asset UTXOs, so the actual need is lower; this is
// the worst case where the user has zero asset UTXOs and a single sats input
// covers everything. Constants must stay aligned with the actual revealVb in
// each buildAndBroadcastC* function or the JIT helper will under- or over-fund.
async function estimateSatsForOp(kind /* 'etch' | 'cxfer' | 'mint' | 'burn' */) {
  const feeRate = await getFeeRate();
  // Worst-case reveal vbytes per op. The helpers compute exact values; we
  // pass conservative inputs (max ticker/image, m=2 cxfer, m=2 burn change)
  // so the funding gate over-asks rather than under-asks.
  const revealVb = (kind === 'etch')  ? estCEtchRevealVb({ tickerLen: 16, imageUriLen: 256 })
                 : (kind === 'mint')  ? estCMintRevealVb()
                 // Worst-realistic numAssetIn=4 covers users consolidating multi-UTXO
                 // holdings; under-asking here would surface as "insufficient sats" at
                 // build time, which is hostile UX even though the build itself sizes
                 // its actual fee correctly from pickedAssetUtxos.length.
                 : (kind === 'cxfer') ? estCXferRevealVb({ m: 2, numAssetIn: 4, hasSatsChange: true })
                 : (kind === 'burn')  ? estCBurnRevealVb({ numChangeOuts: 2, numAssetIn: 4 })
                 : 500;
  const revealFee = feeFor(revealVb, feeRate);
  const commitFee = feeFor(estCommitVb(1), feeRate);
  return DUST + revealFee + commitFee + DUST + 1000;  // +1000 buffer for chain change
}

// ============== EXTERNAL WALLET ADAPTER ==============
// Thin shim over Sats-Connect (Xverse/Leather) and window.unisat. Surfaces
// only what the dApp needs: connect, disconnect, balance, send sats. Tacit
// crypto stays local — the external wallet's job is just to fund tacit ops.
const extWallet = {
  state: null, // null | { provider, address, pubkey, network }

  available() {
    return {
      satsConnect: SatsConnect && typeof SatsConnect.request === 'function',
      unisat: !!window.unisat,
    };
  },

  async connectSatsConnect() {
    if (!SatsConnect || typeof SatsConnect.request !== 'function') {
      throw new Error('sats-connect not loaded');
    }
    const resp = await SatsConnect.request('getAccounts', {
      purposes: ['payment', 'ordinals'],
      message: 'tacit needs your wallet address to fund confidential token operations',
    });
    if (resp?.status !== 'success' || !Array.isArray(resp.result) || !resp.result.length) {
      throw new Error('sats-connect getAccounts: ' + JSON.stringify(resp));
    }
    // Prefer the "payment" account (BIP-84 P2WPKH) for funding sats; ordinals
    // (Taproot) accounts also work but their P2TR address requires schnorr-only
    // sigs that some wallets handle differently.
    const acct = resp.result.find(a => a.purpose === 'payment') || resp.result[0];
    // sats-connect v3 (Xverse) dropped per-account `network`; the wallet
    // exposes it via `wallet_getNetwork` instead. Fall through to that, then
    // sniff the address HRP — `bc1*` is mainnet-only. (`tb1*` is shared
    // across testnet + signet so we can't disambiguate from the address
    // alone, and reconcileWalletNetwork will surface that.)
    let network = acct.network || resp.result[0].network || null;
    if (!network) {
      try {
        const nresp = await SatsConnect.request('wallet_getNetwork', null);
        const name = nresp?.result?.bitcoin?.name ?? nresp?.result?.name ?? nresp?.result;
        if (typeof name === 'string') network = name;
      } catch (e) { console.warn('wallet_getNetwork failed', e); }
    }
    if (!network && typeof acct.address === 'string' && acct.address.toLowerCase().startsWith('bc1')) {
      network = 'mainnet';
    }
    this.state = {
      provider: 'sats-connect',
      address: acct.address,
      pubkey:  acct.publicKey,
      network,
    };
    localStorage.setItem(EXT_MODE_KEY, 'sats-connect');
    _cacheExtState(this.state);
    return this.state;
  },

  async connectUnisat() {
    if (!window.unisat) throw new Error('window.unisat not present (UniSat not installed?)');
    const accounts = await window.unisat.requestAccounts();
    if (!accounts?.length) throw new Error('UniSat returned no accounts');
    const pubkey  = await window.unisat.getPublicKey();
    const network = await window.unisat.getNetwork();
    this.state = { provider: 'unisat', address: accounts[0], pubkey, network };
    localStorage.setItem(EXT_MODE_KEY, 'unisat');
    _cacheExtState(this.state);
    return this.state;
  },

  // Silent reconnect on page reload. Tab-session cache is checked first so a
  // refresh skips the wallet API call (and any "reconnect?" popup it may
  // surface) entirely. On a fresh tab the cache is empty and we fall through
  // to the wallet-side reconnect path; that may still prompt depending on the
  // wallet's authorization model, but a successful call repopulates the cache.
  async tryRestore() {
    const cached = _readCachedExtState();
    if (cached) {
      this.state = cached;
      return cached;
    }
    const mode = localStorage.getItem(EXT_MODE_KEY);
    if (!mode) return null;
    try {
      if (mode === 'sats-connect' && SatsConnect?.request) return await this.connectSatsConnect();
      if (mode === 'unisat' && window.unisat)               return await this.connectUnisat();
    } catch (e) { console.warn('extWallet restore failed', e); }
    return null;
  },

  disconnect() {
    this.state = null;
    localStorage.removeItem(EXT_MODE_KEY);
    _clearCachedExtState();
  },

  // Trigger the wallet's send-sats UI (one popup, user approves, returns txid).
  // No PSBT machinery required — both wallets expose a high-level "send X to Y"
  // method, which is enough to fund the in-browser tacit identity.
  async sendSats(toAddress, sats) {
    if (!this.state) throw new Error('no external wallet connected');
    if (this.state.provider === 'unisat') {
      return await window.unisat.sendBitcoin(toAddress, Number(sats));
    }
    if (this.state.provider === 'sats-connect') {
      const resp = await SatsConnect.request('sendTransfer', {
        recipients: [{ address: toAddress, amount: Number(sats) }],
      });
      if (resp?.status !== 'success') throw new Error('sendTransfer: ' + JSON.stringify(resp));
      return resp.result.txid;
    }
    throw new Error('unknown provider: ' + this.state.provider);
  },
};

// ============== mempool.space API ==============
async function api(path, opts = {}) {
  const r = await fetch(NET.api + path, opts);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`API ${r.status}: ${t.slice(0, 240)}`);
  }
  return r;
}
const apiText = (p, o) => api(p, o).then(r => r.text());
const apiJson = (p, o) => api(p, o).then(r => r.json());
const getUtxos = a => apiJson(`/address/${a}/utxo`);
const getTip = () => apiText('/blocks/tip/height').then(t => parseInt(t, 10) || 0);

// ============== CHAIN-DIVERGENCE WATCHDOG ==============
// Read-only safeguard: every CHAIN_DIVERGE_INTERVAL_MS we fetch the chain
// tip height from both NET.api (primary) and NET.api2 (secondary, if
// configured) and compare. If they disagree by more than
// CHAIN_DIVERGE_TOLERANCE blocks, surface a banner so the user knows one of
// the endpoints may be lagging or misbehaving.
//
// This does NOT block transactions — the dApp's crypto checks (Pedersen,
// kernel sig, range proofs) already prevent acceptance of fabricated data.
// What this catches is the class of attacks the crypto can't see: txs
// hidden by the primary endpoint, stale tips, infrastructure outage. Two
// independent Esplora-compatible endpoints make those visible at near-zero
// cost (one extra HTTP request per network per 5 min).
let _chainDivergence = null;       // null | { primary, secondary, diverged: bool, ts }
let _chainDivergeTimer = null;
async function checkChainAgreement() {
  if (!NET.api2) { _chainDivergence = null; renderChainDivergenceBanner(); return null; }
  let primary, secondary;
  try {
    [primary, secondary] = await Promise.all([
      fetch(NET.api  + '/blocks/tip/height').then(r => r.ok ? r.text() : null).then(t => parseInt(t, 10)),
      fetch(NET.api2 + '/blocks/tip/height').then(r => r.ok ? r.text() : null).then(t => parseInt(t, 10)),
    ]);
  } catch {
    // Network failure on either side — don't claim divergence on a transient
    // outage; just retry next tick.
    return null;
  }
  if (!Number.isFinite(primary) || !Number.isFinite(secondary)) return null;
  const diverged = Math.abs(primary - secondary) > CHAIN_DIVERGE_TOLERANCE;
  _chainDivergence = { primary, secondary, diverged, ts: Date.now() };
  renderChainDivergenceBanner();
  return _chainDivergence;
}
function startChainDivergenceWatchdog() {
  if (_chainDivergeTimer) clearInterval(_chainDivergeTimer);
  checkChainAgreement().catch(() => {});
  _chainDivergeTimer = setInterval(() => {
    checkChainAgreement().catch(() => {});
  }, CHAIN_DIVERGE_INTERVAL_MS);
}
function renderChainDivergenceBanner() {
  const el = (typeof document !== 'undefined') ? document.getElementById('chain-divergence-banner') : null;
  if (!el) return;
  if (!_chainDivergence || !_chainDivergence.diverged) { el.style.display = 'none'; return; }
  const { primary, secondary } = _chainDivergence;
  const primaryHost   = (() => { try { return new URL(NET.api ).host; } catch { return 'primary';  } })();
  const secondaryHost = (() => { try { return new URL(NET.api2).host; } catch { return 'secondary'; } })();
  el.style.display = 'block';
  el.textContent = `⚠ Chain-data divergence: ${primaryHost} reports tip ${primary}, ${secondaryHost} reports tip ${secondary} (Δ${Math.abs(primary - secondary)}). Treat balances as stale until this resolves; one of the endpoints may be lagging or compromised.`;
}

// mempool.space /tx/:txid/outspend/:vout returns { spent: bool, txid?, vin? }.
// Fails closed: errors propagate so callers can surface "couldn't verify
// liveness" rather than silently treating an unreachable API as "not spent"
// — that default made stale listings exploitable during mempool downtime.
// Outspend cache: only stores SPENT results (once spent, always spent; the
// answer never changes). Unspent results vary over time and aren't cached so
// fresh checks (e.g., before broadcast) still hit the chain. In-flight Map
// dedups concurrent callers — saves N×M hits when the market liveness prune
// runs while a Verify click hits the same UTXO.
//
// Persistence: confirmed spends are bound to immutable chain history so we
// persist them across reloads. Unconfirmed spends are explicitly skipped —
// an RBF or mempool drop can flip them back to unspent. Per-network keyed.
const _outspendSpentCache = new Map();
const _outspendInFlight = new Map();
const OUTSPEND_PERSIST_KEY = 'tacit-outspend-v1';
const OUTSPEND_PERSIST_MAX = 5000;
function _outspendCacheStorageKey() { return `${OUTSPEND_PERSIST_KEY}:${NET.name}`; }
let _outspendCacheHydrated = false;
let _outspendCacheDirty = false;
let _outspendCacheFlushTimer = null;
function _ensureOutspendCacheHydrated() {
  if (_outspendCacheHydrated) return;
  _outspendCacheHydrated = true;
  try {
    const raw = localStorage.getItem(_outspendCacheStorageKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || !parsed.entries) return;
    for (const [k, v] of Object.entries(parsed.entries)) _outspendSpentCache.set(k, v);
  } catch { /* corrupt blob → start fresh */ }
}
function _writeOutspendCacheNow() {
  if (!_outspendCacheDirty) return;
  _outspendCacheDirty = false;
  // Map preserves insertion order, so trimming to the last N gives a recency-
  // ordered LRU without explicit timestamps.
  const items = [..._outspendSpentCache.entries()];
  const start = Math.max(0, items.length - OUTSPEND_PERSIST_MAX);
  const entries = {};
  for (let i = start; i < items.length; i++) entries[items[i][0]] = items[i][1];
  try { localStorage.setItem(_outspendCacheStorageKey(), JSON.stringify({ v: 1, entries })); }
  catch { /* quota exceeded → in-memory cache still works */ }
}
function _scheduleOutspendCacheFlush() {
  _outspendCacheDirty = true;
  if (_outspendCacheFlushTimer) return;
  _outspendCacheFlushTimer = setTimeout(() => {
    _outspendCacheFlushTimer = null;
    _writeOutspendCacheNow();
  }, 500);
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _outspendCacheFlushTimer) {
      clearTimeout(_outspendCacheFlushTimer); _outspendCacheFlushTimer = null;
      _writeOutspendCacheNow();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (_outspendCacheFlushTimer) {
      clearTimeout(_outspendCacheFlushTimer); _outspendCacheFlushTimer = null;
      _writeOutspendCacheNow();
    }
  });
}
const getOutspend = (txid, vout) => {
  _ensureOutspendCacheHydrated();
  const key = `${txid}:${vout}`;
  if (_outspendSpentCache.has(key)) return Promise.resolve(_outspendSpentCache.get(key));
  const existing = _outspendInFlight.get(key);
  if (existing) return existing;
  const p = apiJson(`/tx/${txid}/outspend/${vout}`)
    .then((res) => {
      if (res && res.spent) {
        _outspendSpentCache.set(key, res);
        // Only persist confirmed spends — an unconfirmed spend can RBF or drop
        // and revert to unspent, which would leave a stale "spent" entry.
        if (res.status && res.status.confirmed === true) _scheduleOutspendCacheFlush();
      }
      return res;
    })
    .finally(() => { _outspendInFlight.delete(key); });
  _outspendInFlight.set(key, p);
  return p;
};
const broadcast = hex => apiText('/tx', { method: 'POST', body: hex });
// Retry broadcast a few times on transient errors. The most common failure
// is broadcasting a child tx (reveal) before the parent (commit) has been
// indexed by mempool.space — the API rejects with a "missing inputs" /
// "txn-mempool-conflict" error, but the commit usually catches up in 1–3s.
async function broadcastWithRetry(hex, attempts = 4, baseDelayMs = 1000) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, baseDelayMs * i));
    try { return await broadcast(hex); }
    catch (e) {
      lastErr = e;
      const msg = (e && e.message) || '';
      // `already known` / `already in block` mean the broadcast already
      // succeeded (mempool / mined). Treat as success — retrying just re-fails
      // the same way and surfaces a fake error to a user whose tx is fine.
      if (/already in block|already known/i.test(msg)) return null;
      // Only retry on errors that suggest propagation/indexing delay. Notably we
      // do NOT retry on `non-mandatory-script-verify-flag` (the tx is invalid
      // under mainnet policy — retry just hides the real bug) or
      // `bad-txns-inputs-missingorspent` (already covered by `missing inputs`
      // and otherwise indicates a permanent double-spend, not a race).
      if (!/missing inputs|mempool-conflict|too-long-mempool-chain/i.test(msg)) {
        throw e;
      }
    }
  }
  throw lastErr || new Error('broadcast failed');
}
// Persistent per-txid cache for `getTx`. Confirmed Bitcoin txs are immutable
// (a sufficiently-buried block header can't change without breaking PoW), so a
// hit is permanently valid — every refresh, tab switch, and subsequent
// scanHoldings call now skips the round-trip to mempool.space for any ancestor
// it has seen before. First scan still pays the network cost; subsequent scans
// are dominated by local crypto only (rangeproof batch verify is sub-linear).
//
// Cache scope: per-network, per-txid (so signet and mainnet don't pollute each
// other). Mempool txs are intentionally NOT cached — they can RBF or drop out,
// so we always re-fetch them. Quota-exceeded errors on setItem are swallowed:
// the scan still works, just falls back to per-tx network fetches.
const TX_CACHE_PREFIX = 'tacit-tx-v1';
const TX_CACHE_INDEX_PREFIX = 'tacit-tx-v1-idx';
const TX_CACHE_MAX = 2000;          // hard cap on confirmed tx entries per network
const TX_CACHE_EVICT_BATCH = 200;   // drop this many oldest entries when cap is hit
function _txCacheKey(id) { return `${TX_CACHE_PREFIX}:${NET.name}:${id}`; }
function _txCacheIdxKey() { return `${TX_CACHE_INDEX_PREFIX}:${NET.name}`; }
// Read the FIFO index of cached txids for the current network. Returns []
// on parse errors so a corrupt index doesn't brick gets/sets.
function _loadTxCacheIndex() {
  try {
    const raw = localStorage.getItem(_txCacheIdxKey());
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
// Append to the index; evict oldest entries (and their cached txs) when the
// cap is exceeded. Best-effort: any localStorage failure is swallowed because
// the cache is purely an optimisation.
function _appendTxCacheIndex(id) {
  try {
    let idx = _loadTxCacheIndex();
    // Skip duplicates so a re-fetched tx doesn't push the index past its cap
    // without an actual new entry.
    if (idx.includes(id)) return;
    idx.push(id);
    if (idx.length > TX_CACHE_MAX) {
      const dropCount = Math.min(idx.length - TX_CACHE_MAX + TX_CACHE_EVICT_BATCH, idx.length);
      const drop = idx.splice(0, dropCount);
      for (const oldId of drop) {
        try { localStorage.removeItem(_txCacheKey(oldId)); } catch {}
      }
    }
    localStorage.setItem(_txCacheIdxKey(), JSON.stringify(idx));
  } catch {}
}
// In-flight dedup: concurrent callers asking for the same txid share a single
// network request instead of each firing their own. Crucial during cold-cache
// loads where Discover + Holdings + Market hit shared ancestry simultaneously.
const _txInFlight = new Map();
const getTx = async (rawId) => {
  if (typeof rawId !== 'string') return null;
  const id = rawId.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) return null;
  try {
    const cached = localStorage.getItem(_txCacheKey(id));
    if (cached) return JSON.parse(cached);
  } catch { /* corrupted entry — fall through to network and overwrite */ }
  const inflight = _txInFlight.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    let tx = null;
    try { tx = await apiJson(`/tx/${id}`); } catch { return null; }
    if (!tx) return null;
    if (tx.status && tx.status.confirmed === true) {
      try { localStorage.setItem(_txCacheKey(id), JSON.stringify(tx)); _appendTxCacheIndex(id); }
      catch { /* quota exceeded → silently skip; cache is best-effort */ }
    }
    return tx;
  })().finally(() => { _txInFlight.delete(id); });
  _txInFlight.set(id, p);
  return p;
};

// Per-network fee-rate cache. Today the only path that mutates `NET` is
// `setupNetworkSelect → location.reload()`, so a single global would be safe;
// keying by network is defense-in-depth against future code paths that flip
// NET in-place.
const _cachedRate = new Map();   // net.name → sat/vB
const _cachedRateAt = new Map(); // net.name → ts
async function getFeeRate() {
  const net = NET.name;
  if (_cachedRate.has(net) && Date.now() - (_cachedRateAt.get(net) || 0) < 60000) return _cachedRate.get(net);
  let apiOk = false;
  // Fallback floors when the fee API is unreachable: signet has no fee market,
  // so a low rate is fine. Mainnet must NOT silently fall back to 2-3 sat/vB —
  // any intra-day fee spike would leave the broadcast below min-relay and the
  // commit/reveal pair stuck. 15 sat/vB clears typical mainnet floors with
  // headroom; if the user is in a real fee crunch they should retry once the
  // API is reachable.
  let base = net === 'mainnet' ? 15 : 2;
  try {
    const r = await fetch(`${NET.api}/v1/fees/recommended`);
    if (!r.ok) throw new Error();
    const j = await r.json();
    base = Math.max(1, j.halfHourFee || j.hourFee || base);
    apiOk = true;
  } catch {
    if (net === 'mainnet') {
      // Surface the fact that we're on a fallback rate so the user understands
      // why their tx might be slower than current mempool conditions.
      try { toast(`Fee API unreachable — using fallback rate ${base} sat/vB on mainnet`, ''); } catch {}
    }
  }
  // 10% safety margin on mainnet so a small intra-block fee spike between the
  // cache write and the broadcast doesn't push the tx below the min-relay
  // threshold and stall it. Signet has no fee market, so no margin needed.
  const rate = net === 'mainnet' ? Math.ceil(base * 1.1) : base;
  _cachedRate.set(net, rate);
  // Shorter TTL on the fallback rate so a recovered API drives a fresh quote
  // without waiting the full minute.
  _cachedRateAt.set(net, apiOk ? Date.now() : Date.now() - 50_000);
  return rate;
}

// ============== TACIT PROTOCOL ==============
// Confidential single-asset token protocol on Bitcoin.
// Pedersen commitments hide amounts; aggregated bulletproofs prevent negative-amount inflation;
// kernel signatures (Mimblewimble) prevent unbalanced-amount inflation;
// asset_id consistency checks prevent cross-asset substitution.
// Each operation = 2 txs (commit + reveal). Indexer scans witness data, not OP_RETURN.

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N_BITS = 64; // amount range: [0, 2^64) — enforced by the bulletproofs rangeproof.
const BLIND_DOMAIN = new TextEncoder().encode('tacit-blind-v1');

// ---- Asset ID: 32-byte sha256 derived from etch outpoint ----
function assetIdFor(etchTxidHex, etchVout) {
  const txidBE = reverseBytes(hexToBytes(etchTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, etchVout >>> 0, true);
  return sha256(concatBytes(txidBE, voutLE)); // 32 bytes
}

// ---- NUMS generator H (try-and-increment) for Pedersen amount basis ----
function deriveH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let counter = 0; counter < 256; counter++) {
    const x = sha256(concatBytes(seed, new Uint8Array([counter])));
    const candidate = concatBytes(new Uint8Array([0x02]), x);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(secp.ProjectivePoint.ZERO)) return p;
    } catch {}
  }
  throw new Error('failed to derive NUMS generator H');
}
const H = deriveH();
const G = secp.ProjectivePoint.BASE;
const ZERO = secp.ProjectivePoint.ZERO;

// ---- Pedersen commitment ----
const modN = x => ((x % SECP_N) + SECP_N) % SECP_N;
function pedersenCommit(amount, blinding) {
  const a = modN(BigInt(amount));
  const r = modN(BigInt(blinding));
  const aH = a === 0n ? ZERO : H.multiply(a);
  const rG = r === 0n ? ZERO : G.multiply(r);
  return aH.add(rG);
}
const pointToBytes = P => P.toRawBytes(true);
// Explicit defense-in-depth: every commitment / pubkey we parse from chain or
// envelope data must be a 33-byte compressed point with a 0x02 / 0x03 prefix.
// noble validates on-curve and rejects identity in fromHex, but pinning the
// length and prefix here means a future noble update can't accidentally accept
// 32-byte x-only or 65-byte uncompressed forms — both would silently change
// the meaning of envelope payloads and validator inputs.
const bytesToPoint = b => {
  if (!b || b.length !== 33) throw new Error('point must be 33 bytes (compressed)');
  if (b[0] !== 0x02 && b[0] !== 0x03) throw new Error('point prefix must be 0x02/0x03');
  return secp.ProjectivePoint.fromHex(bytesToHex(b));
};
function bigintToBytes32(n) { const m = modN(n); return hexToBytes(m.toString(16).padStart(64, '0')); }
const bytes32ToBigint = b => BigInt('0x' + bytesToHex(b));

// ---- ECDH-derived blinding factor ----
// Including anchorBytes prevents cross-tx commitment correlation: two transfers
// from the same sender to the same recipient at the same vout would otherwise produce
// identical blindings, allowing an observer to compute (C1 − C2) = (a1 − a2)·H and
// learn the *difference* of the two amounts. With per-tx entropy, blindings are unlinkable.
//
// We use the first asset input's outpoint (txid_BE || vout_LE) as the anchor. Both
// sender (from picked UTXOs) and recipient (from tx.vin[1] of the reveal tx) can
// derive it identically.
function deriveBlinding(myPriv, theirPubBytes, anchorBytes, voutIdx) {
  // Defensive: validate the peer pubkey is a parseable on-curve compressed
  // point before handing it to noble's ECDH. With cofactor 1 there are no
  // small-subgroup attacks on secp256k1, but this catches malformed/garbage
  // input loud rather than relying on noble's internal checks (which could
  // change behavior across versions).
  bytesToPoint(theirPubBytes);
  const shared = secp.getSharedSecret(myPriv, theirPubBytes);
  const sharedX = shared.slice(1);
  const seed = sha256(sharedX);
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  const out = hmac(sha256, seed, concatBytes(BLIND_DOMAIN, anchorBytes, voutLE));
  return bytes32ToBigint(out) % SECP_N;
}

// ---- Deterministic change blinding (recoverable from chain + wallet key) ----
// Sender's change blinding for their own UTXO. Derived from sender's privkey, not from
// ECDH (no peer to share with). Recoverable from chain alone given the wallet privkey:
// the wallet can scan its own CXFER outputs and re-derive each change blinding.
const CHANGE_DOMAIN = new TextEncoder().encode('tacit-change-v1');
function deriveChangeBlinding(myPriv, anchorBytes, voutIdx) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  const out = hmac(sha256, myPriv, concatBytes(CHANGE_DOMAIN, anchorBytes, voutLE));
  return bytes32ToBigint(out) % SECP_N;
}

// ---- Deterministic CETCH supply blinding + amount keystream ----
// Etcher's supply blinding for their own CETCH UTXO. Anchored to the first input
// outpoint of the *commit* tx (a pre-existing UTXO, so anchor is independent of the
// envelope/commitment cycle). Both etcher (at build time) and a chain scanner
// (via reveal_tx.vin[0] → commit_tx → commit_tx.vin[0]) can derive it identically.
// Recoverable from chain + wallet privkey alone — no localStorage required.
const ETCH_BLIND_DOMAIN = new TextEncoder().encode('tacit-etch-v1');
const ETCH_AMOUNT_DOMAIN = new TextEncoder().encode('tacit-etch-amount-v1');
function deriveEtchBlinding(myPriv, anchorBytes) {
  const out = hmac(sha256, myPriv, concatBytes(ETCH_BLIND_DOMAIN, anchorBytes));
  return bytes32ToBigint(out) % SECP_N;
}
function deriveEtchAmountKeystream(myPriv, anchorBytes) {
  return hmac(sha256, myPriv, concatBytes(ETCH_AMOUNT_DOMAIN, anchorBytes)).slice(0, 8);
}

// MINT deterministic blinding + amount keystream. Derived from the mint reveal
// tx's commit-input anchor (same recoverability story as etch). The anchor
// guarantees per-mint entropy so two mints of the same amount don't collide.
const MINT_BLIND_DOMAIN  = new TextEncoder().encode('tacit-mint-blind-v1');
const MINT_AMOUNT_DOMAIN = new TextEncoder().encode('tacit-mint-amount-v1');
function deriveMintBlinding(myPriv, anchorBytes) {
  const out = hmac(sha256, myPriv, concatBytes(MINT_BLIND_DOMAIN, anchorBytes));
  return bytes32ToBigint(out) % SECP_N;
}
function deriveMintAmountKeystream(myPriv, anchorBytes) {
  return hmac(sha256, myPriv, concatBytes(MINT_AMOUNT_DOMAIN, anchorBytes)).slice(0, 8);
}

// ---- Amount encryption (one-time-pad over HMAC keystream) ----
// Each commitment in a CXFER carries an 8-byte ciphertext of the amount, encrypted to
// either the recipient (for output 0, ECDH-derived key) or the sender themselves (for
// change outputs, privkey-derived key). This lets either party recover their amount
// from chain alone — no share-link required for receivers, no localStorage required
// for senders. Tampering fails the commitment-equals-amount·H+r·G verification.
const AMOUNT_DOMAIN = new TextEncoder().encode('tacit-amount-v1');
const AMOUNT_SELF_DOMAIN = new TextEncoder().encode('tacit-amount-self-v1');

// Compute 8-byte keystream for output `voutIdx` using the same ECDH path as recipient blinding.
function deriveAmountKeystreamECDH(myPriv, theirPubBytes, anchorBytes, voutIdx) {
  bytesToPoint(theirPubBytes); // validate peer pubkey before ECDH
  const shared = secp.getSharedSecret(myPriv, theirPubBytes);
  const seed = sha256(shared.slice(1));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  return hmac(sha256, seed, concatBytes(AMOUNT_DOMAIN, anchorBytes, voutLE)).slice(0, 8);
}
// Compute 8-byte keystream for self (change-output) using sender's own priv.
function deriveAmountKeystreamSelf(myPriv, anchorBytes, voutIdx) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, voutIdx >>> 0, true);
  return hmac(sha256, myPriv, concatBytes(AMOUNT_SELF_DOMAIN, anchorBytes, voutLE)).slice(0, 8);
}

// 32-byte ECDH keystream used to encrypt the maker's recipient_blinding to the
// claimant at atomic-intent fulfilment time. Symmetric: maker derives with
// (maker.priv, taker.pub); taker derives with (taker.priv, maker.pub) — both
// land on the same shared secret. Domain-separated and bound to (intent_id,
// asset_id) so a keystream from one intent cannot decrypt another.
const AXINTENT_BLINDING_DOMAIN = new TextEncoder().encode('tacit-axintent-blinding-v1');
function deriveAxintentBlindingKeystream(myPriv, theirPubBytes, intentIdBytes, assetIdBytes) {
  bytesToPoint(theirPubBytes); // validate peer pubkey before ECDH
  const shared = secp.getSharedSecret(myPriv, theirPubBytes);
  const seed = sha256(shared.slice(1));
  return hmac(sha256, seed, concatBytes(AXINTENT_BLINDING_DOMAIN, intentIdBytes, assetIdBytes));
}
function xor32(a, b) {
  if (a.length !== 32 || b.length !== 32) throw new Error('xor32 requires 32-byte inputs');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = a[i] ^ b[i];
  return out;
}

// Encrypt a non-negative BigInt amount (must fit in u64) to 8-byte ciphertext.
function encryptAmount(amountBigint, keystream8) {
  const a = BigInt(amountBigint);
  if (a < 0n || a >= (1n << 64n)) throw new Error('amount out of u64 range');
  const ct = new Uint8Array(8);
  let n = a;
  for (let i = 0; i < 8; i++) {
    ct[i] = (Number(n & 0xffn)) ^ keystream8[i];
    n >>= 8n;
  }
  return ct;
}
// Decrypt: returns a BigInt amount; caller must verify against the commitment.
function decryptAmount(ciphertext8, keystream8) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) {
    n = (n << 8n) | BigInt(ciphertext8[i] ^ keystream8[i]);
  }
  return n;
}

// ---- Random scalar (rejection sampling) ----
function randomScalar() {
  while (true) {
    const x = bytes32ToBigint(crypto.getRandomValues(new Uint8Array(32)));
    if (x !== 0n && x < SECP_N) return x;
  }
}

// ============== BULLETPROOFS (aggregated range proof) ==============
// Proves m commitments V_j = v_j·H + γ_j·G each commit to v_j ∈ [0, 2^n).
// Witness size: O(log(n·m)) — for n=64, m=1: 688 B; m=2: 754 B; m=4: 820 B.
// (Compare: prior bit-decomposition proof was 5152 B per output, no aggregation.)
//
// Construction follows Bünz et al. (2017) §4.3 with the inner-product argument
// from §3. The verifier replays the Fiat–Shamir transcript to derive challenges
// y, z, x, w and the IPA halving challenges u_k.

// Modular inverse via Fermat (SECP_N is prime).
function modInv(a) {
  let x = modN(a); if (x === 0n) throw new Error('modInv(0)');
  let res = 1n, base = x, exp = SECP_N - 2n;
  while (exp > 0n) {
    if (exp & 1n) res = (res * base) % SECP_N;
    base = (base * base) % SECP_N;
    exp >>= 1n;
  }
  return res;
}

// Vector ops over Z_N. All inputs are arrays of BigInt; output is array of BigInt.
function vecScalarMul(v, s) { const r = new Array(v.length); for (let i = 0; i < v.length; i++) r[i] = modN(v[i] * s); return r; }
function vecAdd(a, b) { const r = new Array(a.length); for (let i = 0; i < a.length; i++) r[i] = modN(a[i] + b[i]); return r; }
function vecHadamard(a, b) { const r = new Array(a.length); for (let i = 0; i < a.length; i++) r[i] = modN(a[i] * b[i]); return r; }
function vecInner(a, b) { let s = 0n; for (let i = 0; i < a.length; i++) s = modN(s + a[i] * b[i]); return s; }
function vecOnes(n) { return new Array(n).fill(1n); }
function vecPow(x, n) { const r = new Array(n); let p = 1n; for (let i = 0; i < n; i++) { r[i] = p; p = modN(p * x); } return r; }

// Safe scalar multiplication (handles 0 scalar without invoking secp's edge cases).
function safeMult(P, s) { const x = modN(s); return x === 0n ? ZERO : P.multiply(x); }

// Pippenger's bucket-method multi-scalar multiplication.
// For N points and 256-bit scalars with window c, work is roughly:
//   ⌈256/c⌉ windows × (N adds + 2·(2^c−1) bucket adds) + 256 inter-window doublings,
// versus N · ~256 point ops for naïve scalar mults. With N=270, c=4 this is ~50× faster
// than the naïve loop. We use the signed-digit Booth-style window that lets us treat
// the top half of each window as negation, halving the bucket count.
function msm(scalars, points) {
  const N = scalars.length;
  if (N === 0) return ZERO;
  // Reduce scalars mod N once and skip zeros; prep an aligned points array.
  const ss = new Array(N), ps = new Array(N); let live = 0;
  for (let i = 0; i < N; i++) {
    const r = modN(scalars[i]);
    if (r === 0n) continue;
    ss[live] = r; ps[live] = points[i]; live++;
  }
  if (live === 0) return ZERO;
  ss.length = live; ps.length = live;
  // Adaptive window: small N is faster with smaller windows (less bucket overhead).
  const c = live <= 32 ? 3 : live <= 128 ? 4 : 5;
  const W = 1 << c;
  const HALF = W >> 1;
  // Total bits we need to cover. SECP_N is just under 2^256, but window arithmetic
  // adds one bit on the high side (carry), so allocate an extra window's worth.
  const totalBits = 257;
  const numWindows = Math.ceil(totalBits / c);
  // Decompose each scalar into signed digits in [−HALF, HALF). Each window pulls c
  // bits; if the top bit is set, the digit becomes (digit − W) and we add a carry
  // to the next window's contribution. This halves bucket size at the cost of a
  // running carry per scalar.
  const digitsAll = new Array(live);
  for (let i = 0; i < live; i++) {
    const s = ss[i];
    const digs = new Array(numWindows);
    let carry = 0;
    for (let w = 0; w < numWindows; w++) {
      let d = Number((s >> BigInt(w * c)) & BigInt(W - 1)) + carry;
      if (d >= HALF) { d -= W; carry = 1; } else { carry = 0; }
      digs[w] = d;
    }
    digitsAll[i] = digs;
  }
  // Iterate windows from the top so we can shift the running accumulator down.
  let acc = ZERO;
  const buckets = new Array(HALF + 1); // indices 1..HALF used (|digit| can reach HALF)
  for (let w = numWindows - 1; w >= 0; w--) {
    if (w !== numWindows - 1) {
      // Shift acc up by c bits before adding this window's contribution.
      for (let s = 0; s < c; s++) acc = acc.double();
    }
    for (let k = 1; k <= HALF; k++) buckets[k] = ZERO;
    for (let i = 0; i < live; i++) {
      const d = digitsAll[i][w];
      if (d === 0) continue;
      if (d > 0) buckets[d] = buckets[d].add(ps[i]);
      else buckets[-d] = buckets[-d].add(ps[i].negate());
    }
    // Σ k · buckets[k]  computed as a running-tail accumulation:
    //   running = b[HALF]; sum = running
    //   for k from HALF−1 down to 1: running += b[k]; sum += running
    // Then sum equals  Σ_{k=1..HALF} k·b[k]  in (HALF−1) extra point-adds.
    let running = buckets[HALF];
    let windowSum = running;
    for (let k = HALF - 1; k >= 1; k--) {
      running = running.add(buckets[k]);
      windowSum = windowSum.add(running);
    }
    acc = acc.add(windowSum);
  }
  return acc;
}

// Try-and-increment hash-to-curve, parameterised by a domain seed and an index.
function _bpHashToCurve(domain, idx) {
  const idxLE = new Uint8Array(4); new DataView(idxLE.buffer).setUint32(0, idx >>> 0, true);
  for (let counter = 0; counter < 256; counter++) {
    const seed = sha256(concatBytes(
      new TextEncoder().encode(domain), idxLE, new Uint8Array([counter]),
    ));
    const candidate = concatBytes(new Uint8Array([0x02]), seed);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(secp.ProjectivePoint.ZERO)) return p;
    } catch {}
  }
  throw new Error(`bp generator derivation failed: ${domain}#${idx}`);
}

// Lazy-derived NUMS generator vectors. Done once per page load.
const BP_MAX_M = 8;
const BP_MAX_NM = N_BITS * BP_MAX_M;
let _BP_GVEC = null, _BP_HVEC = null, _BP_Q = null;
function _bpGens() {
  if (_BP_GVEC) return { Gvec: _BP_GVEC, Hvec: _BP_HVEC, Q: _BP_Q };
  _BP_GVEC = []; _BP_HVEC = [];
  for (let i = 0; i < BP_MAX_NM; i++) {
    _BP_GVEC.push(_bpHashToCurve('tacit-bp-G-v1', i));
    _BP_HVEC.push(_bpHashToCurve('tacit-bp-H-v1', i));
  }
  _BP_Q = _bpHashToCurve('tacit-bp-Q-v1', 0);
  return { Gvec: _BP_GVEC, Hvec: _BP_HVEC, Q: _BP_Q };
}

// Fiat–Shamir transcript: append labelled bytes, derive challenges as scalars.
// Each challenge re-hashes the running state and the new label so subsequent
// Length-prefixed Fiat-Shamir transcript (Merlin-style). Every (label, data)
// pair is prefixed with its length so the boundary is unambiguous regardless
// of what's appended. Today every call site uses fixed-size data (label='V'
// + 33 B point, etc.) so a non-prefixed concat would still be safe — the
// length-prefixing is hardening so future maintainers can add variable-length
// fields without accidentally introducing transcript-extension ambiguities.
function bpTranscript() {
  const parts = [];
  const _u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const _push = (labelBytes, dataBytes) => {
    parts.push(_u32(labelBytes.length));
    parts.push(labelBytes);
    parts.push(_u32(dataBytes.length));
    parts.push(dataBytes);
  };
  return {
    append(label, bytes) {
      _push(new TextEncoder().encode(label), bytes);
    },
    challenge(label) {
      // Append the challenge label without a placeholder data field, then
      // hash the running state. Bind the hash back into the transcript so
      // subsequent challenges depend on prior ones.
      const labelBytes = new TextEncoder().encode(label);
      parts.push(_u32(labelBytes.length));
      parts.push(labelBytes);
      const h = sha256(concatBytes(...parts));
      parts.push(_u32(h.length));
      parts.push(h);
      let c = modN(bytes32ToBigint(h));
      // Vanishingly unlikely, but guard against zero challenges (which break
      // multiplicative inverse paths in IPA).
      if (c === 0n) {
        const h2 = sha256(concatBytes(h, new Uint8Array([0x01])));
        c = modN(bytes32ToBigint(h2));
        if (c === 0n) throw new Error('bp transcript: 0 challenge');
      }
      return c;
    },
  };
}

// Inner product argument prover. Halves a, b each round; emits log(n) (L_k, R_k) pairs.
// Final witness: scalars a_final, b_final.
function bpIpaProve(G_init, H_init, Q, a_init, b_init, transcript) {
  let G = G_init.slice(), H = H_init.slice();
  let a = a_init.slice(), b = b_init.slice();
  const Lk = [], Rk = [];
  while (a.length > 1) {
    const n = a.length / 2;
    const a_lo = a.slice(0, n), a_hi = a.slice(n);
    const b_lo = b.slice(0, n), b_hi = b.slice(n);
    const G_lo = G.slice(0, n), G_hi = G.slice(n);
    const H_lo = H.slice(0, n), H_hi = H.slice(n);
    const c_L = vecInner(a_lo, b_hi);
    const c_R = vecInner(a_hi, b_lo);
    let L = msm(a_lo, G_hi).add(msm(b_hi, H_lo)).add(safeMult(Q, c_L));
    let R = msm(a_hi, G_lo).add(msm(b_lo, H_hi)).add(safeMult(Q, c_R));
    Lk.push(L); Rk.push(R);
    transcript.append('L', pointToBytes(L));
    transcript.append('R', pointToBytes(R));
    const u = transcript.challenge('u');
    const u_inv = modInv(u);
    const G_n = new Array(n), H_n = new Array(n), a_n = new Array(n), b_n = new Array(n);
    for (let i = 0; i < n; i++) {
      G_n[i] = G_lo[i].multiply(u_inv).add(G_hi[i].multiply(u));
      H_n[i] = H_lo[i].multiply(u).add(H_hi[i].multiply(u_inv));
      a_n[i] = modN(u * a_lo[i] + u_inv * a_hi[i]);
      b_n[i] = modN(u_inv * b_lo[i] + u * b_hi[i]);
    }
    G = G_n; H = H_n; a = a_n; b = b_n;
  }
  return { L: Lk, R: Rk, a_final: a[0], b_final: b[0] };
}

// Batch modular inverse (Montgomery's trick): converts n inversions into one
// inversion plus 3n multiplications. For n=128 that's ~256× faster than naïve
// Fermat per-element.
function batchInv(xs) {
  const n = xs.length;
  if (n === 0) return [];
  const partial = new Array(n);
  partial[0] = modN(xs[0]);
  for (let i = 1; i < n; i++) partial[i] = modN(partial[i - 1] * xs[i]);
  let inv = modInv(partial[n - 1]);
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = i === 0 ? inv : modN(inv * partial[i - 1]);
    inv = modN(inv * xs[i]);
  }
  return out;
}

// Aggregated range proof prover.
// Inputs: m values v_j ∈ [0, 2^n), m blindings γ_j. Returns the proof bytes
// and the commitments V_j = v_j·H + γ_j·G (for the caller to embed on chain).
function bpRangeAggProve(values, blindings, n_bits = N_BITS) {
  const m = values.length;
  if (m !== blindings.length) throw new Error('values/blindings length mismatch');
  if (![1, 2, 4, 8].includes(m)) throw new Error(`unsupported aggregation m=${m}; must be 1,2,4,8`);
  const nm = n_bits * m;
  const { Gvec: Gfull, Hvec: Hfull, Q } = _bpGens();
  const Gvec = Gfull.slice(0, nm), Hvec = Hfull.slice(0, nm);

  // Bit-decompose v_j into a_L; a_R = a_L − 1 component-wise.
  const V_pts = [], a_L = new Array(nm);
  for (let j = 0; j < m; j++) {
    const v = BigInt(values[j]);
    if (v < 0n || v >= (1n << BigInt(n_bits))) throw new Error(`value[${j}]=${v} out of range`);
    V_pts.push(pedersenCommit(v, blindings[j]));
    for (let i = 0; i < n_bits; i++) a_L[j * n_bits + i] = (v >> BigInt(i)) & 1n;
  }
  const a_R = a_L.map(x => modN(x - 1n));

  // Round 1: A, S
  const alpha = randomScalar();
  let A = G.multiply(alpha).add(msm(a_L, Gvec)).add(msm(a_R, Hvec));
  const s_L = new Array(nm), s_R = new Array(nm);
  for (let i = 0; i < nm; i++) { s_L[i] = randomScalar(); s_R[i] = randomScalar(); }
  const rho = randomScalar();
  let S = G.multiply(rho).add(msm(s_L, Gvec)).add(msm(s_R, Hvec));

  const transcript = bpTranscript();
  transcript.append('domain', new TextEncoder().encode('tacit-bp-v1'));
  transcript.append('n', new Uint8Array([n_bits & 0xff]));
  transcript.append('m', new Uint8Array([m & 0xff]));
  for (const V of V_pts) transcript.append('V', pointToBytes(V));
  transcript.append('A', pointToBytes(A));
  transcript.append('S', pointToBytes(S));
  const y = transcript.challenge('y');
  const z = transcript.challenge('z');

  // l(X) = (a_L − z·1^nm) + s_L·X
  // r(X) = y_nm ∘ (a_R + z·1^nm + s_R·X) + concat_j(z^(2+j)·2^n)
  const ones_nm = vecOnes(nm);
  const z_neg = modN(-z);
  const l_const = vecAdd(a_L, vecScalarMul(ones_nm, z_neg));
  const l_X = s_L;
  const y_nm = vecPow(y, nm);
  const r_const_part1 = vecHadamard(y_nm, vecAdd(a_R, vecScalarMul(ones_nm, z)));
  const z_sq = modN(z * z);
  const zpow_2j = new Array(m); { let p = z_sq; for (let j = 0; j < m; j++) { zpow_2j[j] = p; p = modN(p * z); } }
  const two_n = vecPow(2n, n_bits);
  const r_const_part2 = new Array(nm);
  for (let i = 0; i < nm; i++) {
    const j = (i / n_bits) | 0; const k = i % n_bits;
    r_const_part2[i] = modN(zpow_2j[j] * two_n[k]);
  }
  const r_const = vecAdd(r_const_part1, r_const_part2);
  const r_X = vecHadamard(y_nm, s_R);

  // t(X) = <l(X), r(X)> = t_0 + t_1·X + t_2·X^2
  const t_1 = modN(vecInner(l_const, r_X) + vecInner(l_X, r_const));
  const t_2 = vecInner(l_X, r_X);
  const tau_1 = randomScalar();
  const tau_2 = randomScalar();
  const T_1 = safeMult(H, t_1).add(G.multiply(tau_1));
  const T_2 = safeMult(H, t_2).add(G.multiply(tau_2));
  transcript.append('T1', pointToBytes(T_1));
  transcript.append('T2', pointToBytes(T_2));
  const x = transcript.challenge('x');
  const x2 = modN(x * x);

  // Evaluate l, r at x and compute t_hat.
  const l = vecAdd(l_const, vecScalarMul(l_X, x));
  const r = vecAdd(r_const, vecScalarMul(r_X, x));
  const t_hat = vecInner(l, r);

  // τ_x = τ_1·x + τ_2·x² + Σ z^(2+j)·γ_j  ; μ = α + ρ·x
  let tau_x = modN(tau_1 * x + tau_2 * x2);
  for (let j = 0; j < m; j++) tau_x = modN(tau_x + zpow_2j[j] * modN(BigInt(blindings[j])));
  const mu = modN(alpha + rho * x);

  transcript.append('t_hat', bigintToBytes32(t_hat));
  transcript.append('tau_x', bigintToBytes32(tau_x));
  transcript.append('mu', bigintToBytes32(mu));
  const w = transcript.challenge('w');

  // Hprime[i] = Hvec[i] · y^-i  ;  Q_ipa = w · Q
  const y_inv = modInv(y);
  const y_inv_pow = vecPow(y_inv, nm);
  const Hprime = Hvec.map((Hi, i) => Hi.multiply(modN(y_inv_pow[i])));
  const Q_ipa = Q.multiply(w);
  const ipa = bpIpaProve(Gvec, Hprime, Q_ipa, l, r, transcript);

  // Wire format:
  //   A(33) S(33) T1(33) T2(33) t_hat(32) tau_x(32) mu(32)
  //   { L_k(33) R_k(33) }^log2(nm)
  //   a_final(32) b_final(32)
  const buf = [
    pointToBytes(A), pointToBytes(S), pointToBytes(T_1), pointToBytes(T_2),
    bigintToBytes32(t_hat), bigintToBytes32(tau_x), bigintToBytes32(mu),
  ];
  for (let k = 0; k < ipa.L.length; k++) { buf.push(pointToBytes(ipa.L[k])); buf.push(pointToBytes(ipa.R[k])); }
  buf.push(bigintToBytes32(ipa.a_final));
  buf.push(bigintToBytes32(ipa.b_final));
  return { proof: concatBytes(...buf), commitments: V_pts };
}

// Single-proof verify is just batch verify with one item.
function bpRangeAggVerify(V_pts, proofBytes, n_bits = N_BITS) {
  return bpRangeAggBatchVerify([{ commitments: V_pts, proof: proofBytes }], n_bits);
}

// Batch verifier. Combines N range proofs into ONE multi-scalar multiplication
// using random coefficients α_i (for the t_hat equation) and β_i (for the IPA
// equation) per proof. Soundness: if any individual equation is non-zero, the
// random combination is non-zero with probability ≥ 1 − 2/order ≈ 1 − 2⁻²⁵⁵.
//
// Items: [{ commitments: Point[], proof: Uint8Array }, ...].
// Shared generators (Gvec, Hvec, G, H, Q) get scalars accumulated across all
// proofs; per-proof points (A, S, T1, T2, V_j, L_k, R_k) get their own scalars.
function bpRangeAggBatchVerify(items, n_bits = N_BITS) {
  if (items.length === 0) return true;
  // Pre-validate shapes and compute the largest nm (so we know how many shared
  // Gvec/Hvec slots to aggregate over).
  let maxNm = 0;
  const meta = [];
  for (const it of items) {
    const m = it.commitments.length;
    if (![1, 2, 4, 8].includes(m)) return false;
    const nm = n_bits * m;
    const log_nm = Math.log2(nm);
    if (!Number.isInteger(log_nm)) return false;
    const expectedLen = 33 * 4 + 32 * 3 + log_nm * 33 * 2 + 32 * 2;
    if (it.proof.length !== expectedLen) return false;
    if (nm > maxNm) maxNm = nm;
    meta.push({ m, nm, log_nm });
  }

  const { Gvec: Gfull, Hvec: Hfull, Q } = _bpGens();
  const Gvec = Gfull.slice(0, maxNm);
  const Hvec = Hfull.slice(0, maxNm);

  // Aggregated scalars on shared generators.
  const aggG = new Array(maxNm).fill(0n);     // for Gvec[k]
  const aggH = new Array(maxNm).fill(0n);     // for Hvec[k]
  let aggQ = 0n;                              // for Q
  let aggGcurve = 0n;                         // for G (curve base, used for blinding)
  let aggHvalue = 0n;                         // for H (Pedersen value generator)

  // Per-proof points get unique scalars; collect into one big multi-exp at the end.
  const extraScalars = [], extraPoints = [];

  for (let pIdx = 0; pIdx < items.length; pIdx++) {
    const it = items[pIdx];
    const { m, nm, log_nm } = meta[pIdx];
    const proofBytes = it.proof;
    const V_pts = it.commitments;

    // Parse proof
    let off = 0;
    let A, S, T_1, T_2;
    try {
      A   = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
      S   = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
      T_1 = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
      T_2 = bytesToPoint(proofBytes.slice(off, off + 33)); off += 33;
    } catch { return false; }
    const t_hat = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
    const tau_x = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
    const mu    = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
    const Lk = [], Rk = [];
    try {
      for (let k = 0; k < log_nm; k++) {
        Lk.push(bytesToPoint(proofBytes.slice(off, off + 33))); off += 33;
        Rk.push(bytesToPoint(proofBytes.slice(off, off + 33))); off += 33;
      }
    } catch { return false; }
    const a_final = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;
    const b_final = bytes32ToBigint(proofBytes.slice(off, off + 32)); off += 32;

    // Replay transcript → y, z, x, w, u_k
    const transcript = bpTranscript();
    transcript.append('domain', new TextEncoder().encode('tacit-bp-v1'));
    transcript.append('n', new Uint8Array([n_bits & 0xff]));
    transcript.append('m', new Uint8Array([m & 0xff]));
    for (const V of V_pts) transcript.append('V', pointToBytes(V));
    transcript.append('A', pointToBytes(A));
    transcript.append('S', pointToBytes(S));
    const y = transcript.challenge('y');
    const z = transcript.challenge('z');
    transcript.append('T1', pointToBytes(T_1));
    transcript.append('T2', pointToBytes(T_2));
    const x = transcript.challenge('x');
    transcript.append('t_hat', bigintToBytes32(t_hat));
    transcript.append('tau_x', bigintToBytes32(tau_x));
    transcript.append('mu', bigintToBytes32(mu));
    const w = transcript.challenge('w');
    const u = new Array(log_nm);
    for (let j = 0; j < log_nm; j++) {
      transcript.append('L', pointToBytes(Lk[j]));
      transcript.append('R', pointToBytes(Rk[j]));
      u[j] = transcript.challenge('u');
    }
    const u_inv = batchInv(u);
    const u_sq = u.map(uu => modN(uu * uu));
    const u_inv_sq = u_inv.map(uu => modN(uu * uu));

    // s[i] / s_inv[i] for the IPA collapse
    const s = new Array(nm);
    s[0] = u_inv.reduce((acc, v) => modN(acc * v), 1n);
    for (let i = 1; i < nm; i++) {
      const lsb = i & -i;
      const j_lsb = Math.log2(lsb) | 0;
      const j = log_nm - 1 - j_lsb;
      s[i] = modN(s[i ^ lsb] * u_sq[j]);
    }
    const s_inv = batchInv(s);

    // δ(y, z) = (z − z²)·<1^nm, y^nm> − Σ_{j=1..m} z^(2+j)·<1^n, 2^n>
    const ones_nm = vecOnes(nm);
    const y_nm = vecPow(y, nm);
    const sum_y_nm = vecInner(ones_nm, y_nm);
    const sum_two_n = (1n << BigInt(n_bits)) - 1n;
    const z_sq = modN(z * z);
    const z_minus_z2 = modN(z - z_sq);
    let zp = modN(z_sq * z); // z^3
    let delta = modN(z_minus_z2 * sum_y_nm);
    for (let j = 0; j < m; j++) {
      delta = modN(delta - zp * sum_two_n);
      zp = modN(zp * z);
    }

    const y_inv = modInv(y);
    const y_inv_pow = vecPow(y_inv, nm);
    const zpow_2j = new Array(m); { let p = z_sq; for (let j = 0; j < m; j++) { zpow_2j[j] = p; p = modN(p * z); } }
    const two_n = vecPow(2n, n_bits);

    // Random batching scalars. Honest randomness in the browser means the prover
    // cannot have engineered Eq1 = -Eq2 in advance.
    const alpha = randomScalar(); // weight on the t_hat equation
    const beta  = randomScalar(); // weight on the IPA equation
    const x2 = modN(x * x);

    // ---- Eq1 (the t_hat check) contributes (multiplied by α):
    // 0 = t_hat·H + tau_x·G − Σ z^(2+j)·V_j − δ·H − x·T_1 − x²·T_2
    aggHvalue = modN(aggHvalue + alpha * modN(t_hat - delta));
    aggGcurve = modN(aggGcurve + alpha * tau_x);
    extraScalars.push(modN(-alpha * x));    extraPoints.push(T_1);
    extraScalars.push(modN(-alpha * x2));   extraPoints.push(T_2);
    let zj = z_sq;
    for (let j = 0; j < m; j++) {
      extraScalars.push(modN(-alpha * zj));
      extraPoints.push(V_pts[j]);
      zj = modN(zj * z);
    }

    // ---- Eq2 (the IPA equation, fully expanded) contributes (multiplied by β):
    // 0 = A + x·S − μ·G + Σ s_G[i]·Gvec[i] + Σ s_H[i]·Hvec[i] + t_hat·(w·Q)
    //     + Σ u²·L + Σ u⁻²·R − a·Σs[i]·Gvec[i] − b·Σs⁻¹[i]·Hvec[i] − a·b·(w·Q)
    extraScalars.push(beta);                 extraPoints.push(A);
    extraScalars.push(modN(beta * x));       extraPoints.push(S);
    aggGcurve = modN(aggGcurve + beta * modN(-mu));
    aggQ = modN(aggQ + beta * modN(w * modN(t_hat - a_final * b_final)));
    for (let k = 0; k < log_nm; k++) {
      extraScalars.push(modN(beta * u_sq[k]));     extraPoints.push(Lk[k]);
      extraScalars.push(modN(beta * u_inv_sq[k])); extraPoints.push(Rk[k]);
    }
    const minus_z = modN(-z);
    for (let i = 0; i < nm; i++) {
      const j = (i / n_bits) | 0; const k = i % n_bits;
      const s_G_i = minus_z;
      const s_H_i = modN(z + modN(zpow_2j[j] * two_n[k]) * y_inv_pow[i]);
      const G_total = modN(s_G_i - a_final * s[i]);
      // H_final lives in the H' basis (H'[i] = Hvec[i]·y^-i), so when expressed
      // back in plain Hvec[i], the coefficient picks up that y^-i factor.
      const H_total = modN(s_H_i - b_final * modN(s_inv[i] * y_inv_pow[i]));
      aggG[i] = modN(aggG[i] + beta * G_total);
      aggH[i] = modN(aggH[i] + beta * H_total);
    }
  }

  // One giant multi-exp combining all per-proof and shared contributions.
  const allScalars = [...aggG, ...aggH, aggQ, aggGcurve, aggHvalue, ...extraScalars];
  const allPoints  = [...Gvec, ...Hvec, Q, G, H, ...extraPoints];
  return msm(allScalars, allPoints).equals(ZERO);
}

// Implementation was verified offline (worker/bp-test.mjs against a node harness
// using the same primitives) — runtime self-tests would burn 5–30s on every page
// load. The math is deterministic; if it works once, it works.

// ============== BIP-340 SCHNORR ==============
function _taggedHash(tag, ...msgs) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concatBytes(tagHash, tagHash, ...msgs));
}
function _xor32(a, b) { const r = new Uint8Array(32); for (let i = 0; i < 32; i++) r[i] = a[i] ^ b[i]; return r; }
function signSchnorr(msgHash, priv32) {
  const dPrime = bytes32ToBigint(priv32);
  if (dPrime <= 0n || dPrime >= SECP_N) throw new Error('schnorr: invalid private key');
  const P = G.multiply(dPrime);
  const Pbytes = P.toRawBytes(true);
  const Px = Pbytes.slice(1);
  const d = (Pbytes[0] === 0x02) ? dPrime : (SECP_N - dPrime);
  const aux = crypto.getRandomValues(new Uint8Array(32));
  const t = _xor32(bigintToBytes32(d), _taggedHash('BIP0340/aux', aux));
  const rand = _taggedHash('BIP0340/nonce', t, Px, msgHash);
  let kPrime = bytes32ToBigint(rand) % SECP_N;
  if (kPrime === 0n) throw new Error('schnorr: nonce was zero');
  const R = G.multiply(kPrime);
  const Rbytes = R.toRawBytes(true);
  const Rx = Rbytes.slice(1);
  const k = (Rbytes[0] === 0x02) ? kPrime : (SECP_N - kPrime);
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, Px, msgHash)) % SECP_N;
  const s = (k + e * d) % SECP_N;
  return concatBytes(Rx, bigintToBytes32(s));
}
function verifySchnorr(sig64, msgHash, pubXonly32) {
  if (sig64.length !== 64 || pubXonly32.length !== 32 || msgHash.length !== 32) return false;
  const Rx = sig64.slice(0, 32);
  const sBig = bytes32ToBigint(sig64.slice(32, 64));
  if (sBig >= SECP_N) return false;
  if (bytes32ToBigint(pubXonly32) >= SECP_P) return false;
  let P; try { P = secp.ProjectivePoint.fromHex('02' + bytesToHex(pubXonly32)); } catch { return false; }
  const e = bytes32ToBigint(_taggedHash('BIP0340/challenge', Rx, pubXonly32, msgHash)) % SECP_N;
  const R = G.multiply(sBig).add(P.multiply(e).negate());
  // BIP-340 mandates rejecting infinite R. Without this guard, a sig with
  // Rx = 32 zero bytes would verify against the identity point: noble encodes
  // the identity as 02 || 00…00, which slips past the parity + Rx checks.
  if (R.equals(ZERO)) return false;
  const Rb = R.toRawBytes(true);
  if (Rb[0] !== 0x02) return false;
  return bytesToHex(Rb.slice(1)) === bytesToHex(Rx);
}

// ============== STARTUP KAT (known-answer tests) ==============
// All third-party JS is vendored (./vendor/tacit-deps.min.js), so the deps
// can't drift between page loads — but they CAN drift between releases if a
// rebuild upgrades a noble/scure version. This KAT is independent defense:
// runtime checks that every primitive returns the right output for known
// reference vectors. If any check fails, init() refuses to mount the UI and
// the user sees a hard error instead of using a wallet whose math may be
// subtly broken.
//
// The vectors are RFC / BIP-published reference values — independently
// reproducible, no chance of "tested itself into agreement". Intentionally
// fast (<10 ms total); we run on every page load.
function _kat_assertEq(actual, expected, label) {
  const a = actual instanceof Uint8Array ? bytesToHex(actual) : String(actual);
  const e = String(expected).toLowerCase();
  if (a.toLowerCase() !== e) throw new Error(`KAT failed: ${label}\n  expected ${e}\n  actual   ${a}`);
}
function runStartupKAT() {
  // SHA-256("abc") — NIST FIPS 180-2 reference vector.
  _kat_assertEq(
    sha256(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'sha256("abc")',
  );
  // RIPEMD-160("abc") — original Dobbertin et al. reference vector.
  _kat_assertEq(
    ripemd160(new TextEncoder().encode('abc')),
    '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc',
    'ripemd160("abc")',
  );
  // HMAC-SHA-256 — RFC 4231 test case 1.
  _kat_assertEq(
    hmac(sha256, hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'), new TextEncoder().encode('Hi There')),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    'hmac-sha256 RFC4231/1',
  );
  // secp256k1 base point: G·1 must equal G's compressed encoding.
  _kat_assertEq(
    G.toRawBytes(true),
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'secp256k1 G',
  );
  // BIP-340 Schnorr verify — test vector 0 from the BIP-340 reference suite.
  // (sig, msg, pubkey) is a known-good triple; verify must accept.
  const bip340_pub = hexToBytes('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');
  const bip340_msg = hexToBytes('0000000000000000000000000000000000000000000000000000000000000000');
  const bip340_sig = hexToBytes(
    'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca8215' +
    '25f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0',
  );
  if (!verifySchnorr(bip340_sig, bip340_msg, bip340_pub)) {
    throw new Error('KAT failed: BIP-340 verify (vector 0) rejected a valid signature');
  }
  // bech32 round-trip — encoding the empty witness program must be the canonical
  // testnet/mainnet HRP form. Use a known address from BIP-173.
  const bech_words = bech32.toWords(hexToBytes('751e76e8199196d454941c45d1b3a323f1433bd6'));
  const bech_out = bech32.encode('bc', [0, ...bech_words]);
  _kat_assertEq(bech_out, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'bech32 BIP-173 vector');
  // secp256k1 scalar multiplication — G·2 has a published compressed encoding
  // (the doubled base point). Tests noble's point arithmetic against a value
  // that's independently verifiable from any secp256k1 reference.
  _kat_assertEq(
    G.multiply(2n).toRawBytes(true),
    '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
    'secp256k1 G·2',
  );
  // G·N must equal identity (point at infinity). Catches any modular-reduction
  // bug where SECP_N is treated incorrectly.
  if (!G.multiply(SECP_N - 1n).add(G).equals(secp.ProjectivePoint.ZERO)) {
    throw new Error('KAT failed: G·(N-1) + G != identity');
  }
  // Pedersen consistency: pedersenCommit(0, 0) must equal identity, and
  // pedersenCommit(a, r) must be additively homomorphic. These are protocol
  // invariants — if they break, every kernel-sig argument breaks too.
  if (!pedersenCommit(0n, 0n).equals(secp.ProjectivePoint.ZERO)) {
    throw new Error('KAT failed: pedersenCommit(0,0) != identity');
  }
  const _C1 = pedersenCommit(3n, 5n), _C2 = pedersenCommit(7n, 11n);
  if (!_C1.add(_C2).equals(pedersenCommit(10n, 16n))) {
    throw new Error('KAT failed: pedersen homomorphism broken');
  }
  // Cross-implementation generator vectors (SPEC.md §3.1). A typo in any of
  // the bp domain seeds (`tacit-bp-G-v1`, `tacit-bp-H-v1`, `tacit-bp-Q-v1`)
  // or in the NUMS-H seed (`tacit-generator-H-v1`) silently shifts every
  // generator and produces proofs that no other implementation verifies.
  // Pedersen-homomorphism KAT above doesn't catch this because the seeds
  // are consistent with themselves; only the published reference vectors do.
  _kat_assertEq(H.toRawBytes(true), '02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56', 'NUMS H');
  const { Gvec: _Gvec_kat, Hvec: _Hvec_kat, Q: _Q_kat } = _bpGens();
  _kat_assertEq(_Q_kat.toRawBytes(true),       '0279b66e857697b21949facaa998d6c31e4636f81f442c63f84bea33e83baafda4', 'BP Q');
  _kat_assertEq(_Gvec_kat[0].toRawBytes(true), '025cfa02a4913b0b122c4f275ae566e6ba52627d80036e25a43a3fd5d2062f28d4', 'BP G_vec[0]');
  _kat_assertEq(_Gvec_kat[1].toRawBytes(true), '027608f5161dd88146ab22635ad357622a7e3fd9a293efd6fc21d18b50efab7c4e', 'BP G_vec[1]');
  _kat_assertEq(_Gvec_kat[2].toRawBytes(true), '022f8c08dda9ade0264065a6770b219a5ee82c872f627d4503c4c3292472f1fb23', 'BP G_vec[2]');
  _kat_assertEq(_Gvec_kat[3].toRawBytes(true), '02add28339b32e0e27075cb6cdee409acf07860ba5bf7cdca07cabf50947ed5a55', 'BP G_vec[3]');
  _kat_assertEq(_Hvec_kat[0].toRawBytes(true), '02b78ed462f5c137b05d1e99daeb2619eb890ec4781acf098018628ca0ec0d20e2', 'BP H_vec[0]');
  _kat_assertEq(_Hvec_kat[1].toRawBytes(true), '02ac4ee8f1ded833bf18be0815b9602b4fe0d586ade57923b35ef22e3e7c1e6ce2', 'BP H_vec[1]');
  _kat_assertEq(_Hvec_kat[2].toRawBytes(true), '02795d359afdced0c4c7735bf61f24cdab214d43301f5210eefd46b96657a708a8', 'BP H_vec[2]');
  _kat_assertEq(_Hvec_kat[3].toRawBytes(true), '02b65a170dfd727dd403cda635ddd2419882da910f6f79e10b24c4e5f3d171c76c', 'BP H_vec[3]');
}

// ============== TAPROOT (BIP-341) ==============
const TAP_NUMS = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');

function _compactSize(n) {
  if (n < 0xfd) return new Uint8Array([n]);
  if (n <= 0xffff) {
    const b = new Uint8Array(3); b[0] = 0xfd;
    new DataView(b.buffer).setUint16(1, n, true); return b;
  }
  if (n <= 0xffffffff) {
    const b = new Uint8Array(5); b[0] = 0xfe;
    new DataView(b.buffer).setUint32(1, n, true); return b;
  }
  throw new Error('compactSize too big');
}
function tapLeafHash(script, leafVersion = 0xc0) {
  return _taggedHash('TapLeaf', new Uint8Array([leafVersion]), _compactSize(script.length), script);
}
function tweakedOutputKey(internalXonly, merkleRoot) {
  const P = secp.ProjectivePoint.fromHex('02' + bytesToHex(internalXonly));
  const t = _taggedHash('TapTweak', internalXonly, merkleRoot);
  const tBig = bytes32ToBigint(t);
  if (tBig >= SECP_N) throw new Error('tap tweak ≥ N');
  const Q = P.add(G.multiply(tBig));
  const Qbytes = Q.toRawBytes(true);
  return { Q_xonly: Qbytes.slice(1), parity: Qbytes[0] === 0x03 ? 1 : 0 };
}
function p2trScript(Q_xonly) {
  return concatBytes(new Uint8Array([0x51, 0x20]), Q_xonly);
}
function controlBlock(internalXonly, parity, leafVersion = 0xc0) {
  return concatBytes(new Uint8Array([leafVersion | (parity & 1)]), internalXonly);
}
function tapSighash(tx, inputIdx, prevouts, leafHash, hashType = 0x00) {
  if (prevouts.length !== tx.inputs.length) throw new Error('prevouts length mismatch');
  const u8 = v => new Uint8Array([v & 0xff]);
  const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
  const u64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
  const parts = [];
  parts.push(u8(0x00)); // epoch
  parts.push(u8(hashType));
  parts.push(u32(tx.version));
  parts.push(u32(tx.locktime));
  if ((hashType & 0x80) !== 0x80) {
    const buf = [];
    for (const inp of tx.inputs) {
      buf.push(reverseBytes(hexToBytes(inp.txid)));
      buf.push(u32(inp.vout));
    }
    parts.push(sha256(concatBytes(...buf)));
    const amts = []; for (const po of prevouts) amts.push(u64(po.value));
    parts.push(sha256(concatBytes(...amts)));
    const spks = [];
    for (const po of prevouts) { spks.push(_compactSize(po.script.length)); spks.push(po.script); }
    parts.push(sha256(concatBytes(...spks)));
    const seqs = []; for (const inp of tx.inputs) seqs.push(u32(inp.sequence ?? 0xffffffff));
    parts.push(sha256(concatBytes(...seqs)));
  }
  const baseHt = hashType & 0x03;
  // BIP-341 sha_outputs is included for ALL/DEFAULT (0x00, 0x01) but NOT for
  // NONE (0x02) or SINGLE (0x03). SINGLE has its own sha_single_output appended
  // later (after the spend_type / outpoint section). DEFAULT (hashType=0x00)
  // is treated as ALL per BIP-341.
  if (baseHt === 0x00 || baseHt === 0x01) {
    const outs = [];
    for (const out of tx.outputs) {
      outs.push(u64(out.value));
      outs.push(_compactSize(out.script.length));
      outs.push(out.script);
    }
    parts.push(sha256(concatBytes(...outs)));
  }
  const ext_flag = 1; // tapscript path
  parts.push(u8((ext_flag << 1) | 0));
  if ((hashType & 0x80) === 0x80) {
    const inp = tx.inputs[inputIdx]; const po = prevouts[inputIdx];
    parts.push(reverseBytes(hexToBytes(inp.txid)));
    parts.push(u32(inp.vout));
    parts.push(u64(po.value));
    parts.push(_compactSize(po.script.length));
    parts.push(po.script);
    parts.push(u32(inp.sequence ?? 0xffffffff));
  } else {
    parts.push(u32(inputIdx));
  }
  // BIP-341 sha_single_output: only when hash_type & 3 == SINGLE (0x03). Goes
  // after the input section (outpoint or input_index) and before the
  // tapscript-specific tapleaf_hash. We don't support annex, so no annex_hash.
  if (baseHt === 0x03) {
    if (inputIdx >= tx.outputs.length) throw new Error('SIGHASH_SINGLE: no output at input index');
    const out = tx.outputs[inputIdx];
    parts.push(sha256(concatBytes(u64(out.value), _compactSize(out.script.length), out.script)));
  }
  parts.push(leafHash);
  parts.push(u8(0x00)); // key_version
  parts.push(u32(0xffffffff)); // codesep_pos
  return _taggedHash('TapSighash', concatBytes(...parts));
}

// ============== ENVELOPE ==============
const ENVELOPE_MAGIC = new TextEncoder().encode('TACIT');
const ENVELOPE_VERSION = 0x01;
const T_CETCH    = 0x21;
const T_CXFER    = 0x23;
const T_MINT     = 0x24; // issue more supply on a mintable asset (signed by mint_authority)
const T_BURN     = 0x25; // destroy supply (any holder; emits a public burned_amount)
const T_AXFER = 0x26; // CXFER variant allowing aux non-tacit inputs (atomic OTC settlement, SPEC §5.7)
const T_PETCH    = 0x27; // permissionless-mint deployment record (SPEC §5.8)
const T_PMINT    = 0x28; // permissionless mint event against a T_PETCH ancestor (SPEC §5.9)
const MAX_SCRIPT_PUSH = 520;
const OP_FALSE = 0x00, OP_PUSHDATA1 = 0x4c, OP_PUSHDATA2 = 0x4d;
const OP_IF = 0x63, OP_ENDIF = 0x68, OP_CHECKSIG = 0xac;

function _encodePush(data) {
  if (data.length === 0) return new Uint8Array([OP_FALSE]);
  if (data.length <= 75) return concatBytes(new Uint8Array([data.length]), data);
  if (data.length <= 255) return concatBytes(new Uint8Array([OP_PUSHDATA1, data.length]), data);
  if (data.length <= 65535) {
    const lenLE = new Uint8Array(2); new DataView(lenLE.buffer).setUint16(0, data.length, true);
    return concatBytes(new Uint8Array([OP_PUSHDATA2]), lenLE, data);
  }
  throw new Error('push data too large');
}
function encodeEnvelopeScript(signingPubXonly, payload) {
  if (signingPubXonly.length !== 32) throw new Error('signing pubkey must be 32 bytes (x-only)');
  const chunks = [ENVELOPE_MAGIC, new Uint8Array([ENVELOPE_VERSION])];
  for (let i = 0; i < payload.length; i += MAX_SCRIPT_PUSH) {
    chunks.push(payload.slice(i, Math.min(i + MAX_SCRIPT_PUSH, payload.length)));
  }
  const pieces = [
    _encodePush(signingPubXonly),
    new Uint8Array([OP_CHECKSIG]),
    new Uint8Array([OP_FALSE, OP_IF]),
  ];
  for (const c of chunks) pieces.push(_encodePush(c));
  pieces.push(new Uint8Array([OP_ENDIF]));
  return concatBytes(...pieces);
}
function decodeEnvelopeScript(script) {
  if (!script || script.length < 36) return null;
  let p = 0;
  if (script[p] !== 32) return null; p += 1;
  if (p + 32 > script.length) return null;
  const signingPubXonly = script.slice(p, p + 32); p += 32;
  if (p + 1 > script.length || script[p] !== OP_CHECKSIG) return null; p += 1;
  if (p + 2 > script.length || script[p] !== OP_FALSE || script[p + 1] !== OP_IF) return null; p += 2;
  const pushes = [];
  let sawEndif = false;
  while (p < script.length) {
    if (script[p] === OP_ENDIF) { p += 1; sawEndif = true; break; }
    const op = script[p]; p += 1;
    let data;
    if (op >= 1 && op <= 75) {
      if (p + op > script.length) return null;
      data = script.slice(p, p + op); p += op;
    }
    else if (op === OP_PUSHDATA1) {
      if (p + 1 > script.length) return null;
      const ln = script[p]; p += 1;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    }
    else if (op === OP_PUSHDATA2) {
      if (p + 2 > script.length) return null;
      const ln = script[p] | (script[p + 1] << 8); p += 2;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    }
    else if (op === OP_FALSE) { data = new Uint8Array(0); }
    else { return null; }
    pushes.push(data);
  }
  if (!sawEndif) return null; // OP_ENDIF must be present
  if (p !== script.length) return null; // canonical: no trailing bytes after OP_ENDIF
  if (pushes.length < 3) return null;
  if (pushes[0].length !== ENVELOPE_MAGIC.length) return null;
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) if (pushes[0][i] !== ENVELOPE_MAGIC[i]) return null;
  if (pushes[1].length !== 1 || pushes[1][0] !== ENVELOPE_VERSION) return null;
  const payload = concatBytes(...pushes.slice(2));
  if (payload.length < 1) return null;
  return { signingPubXonly, opcode: payload[0], payload };
}

// ---- CETCH typed payload ----
// amount_ct is u64 LE plaintext supply XOR'd with an HMAC keystream derived from
// (etcher_priv, ETCH_AMOUNT_DOMAIN, commit_input_anchor). Self-encrypted — only the
// etcher can decrypt; observers see opaque bytes. Tampering fails the commitment check.
// image_len is 2-byte little-endian (0..256). image_uri is opaque UTF-8.
// The protocol does NOT constrain the URI scheme — renderers MUST validate before display
// (the dApp uses normalizeImageUri() for this; see also validateImageUriForEtch() at write time).
// CETCH wire format (m=1 aggregated bulletproof, 64-bit range, mint_authority appended):
//   T_CETCH(1) || tlen(1) || ticker(tlen) || decimals(1) ||
//   commitment(33) || amount_ct(8) || rp_len(2 LE) || rangeproof(rp_len) ||
//   mint_authority(32) || img_len(2 LE) || image_uri(img_len)
//
// mint_authority: x-only Schnorr pubkey (32 B). All-zero (0x00..00) ⇒ supply is
// fixed and cannot be increased. Otherwise the holder of the corresponding
// secret key can sign T_MINT envelopes for this asset_id, creating new supply
// commitments. This field is permanent — there's no way to make a fixed-supply
// asset mintable later, and no way to demote a mintable asset's authority
// short of a fork.
const MINT_AUTH_NONE = new Uint8Array(32); // all-zero, the "non-mintable" sentinel
const _isZeroAuth = b => { for (let i = 0; i < 32; i++) if (b[i] !== 0) return false; return true; };

function encodeCEtchPayload({ ticker, decimals, commitment, rangeproof, encryptedAmount, mintAuthority = null, imageUri = null }) {
  const tk = new TextEncoder().encode(ticker);
  if (tk.length === 0 || tk.length > 16) throw new Error('ticker 1–16 bytes');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('decimals must be an integer 0–8');
  if (commitment.length !== 33) throw new Error('commitment 33 bytes');
  if (!encryptedAmount || encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  const auth = mintAuthority || MINT_AUTH_NONE;
  if (auth.length !== 32) throw new Error('mint_authority must be 32 bytes (x-only pubkey or zero)');
  const imgBytes = imageUri ? new TextEncoder().encode(imageUri) : new Uint8Array(0);
  if (imgBytes.length > 256) throw new Error('image_uri must be ≤256 bytes');
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  const imgLen = new Uint8Array(2); new DataView(imgLen.buffer).setUint16(0, imgBytes.length, true);
  return concatBytes(
    new Uint8Array([T_CETCH]), new Uint8Array([tk.length]), tk,
    new Uint8Array([decimals]), commitment, encryptedAmount, rpLen, rangeproof, auth, imgLen, imgBytes,
  );
}

function decodeCEtchPayload(payload) {
  if (!payload) return null;
  // Minimum: opcode(1) + tlen(1) + ticker(≥1) + decimals(1) + commitment(33) + amount_ct(8) + rp_len(2) + auth(32) + img_len(2)
  if (payload.length < 1 + 1 + 1 + 1 + 33 + 8 + 2 + 32 + 2) return null;
  if (payload[0] !== T_CETCH) return null;
  let p = 1;
  const tlen = payload[p]; p += 1;
  if (tlen < 1 || tlen > 16) return null;
  if (p + tlen > payload.length) return null;
  let ticker;
  try { ticker = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + tlen)); } catch { return null; }
  p += tlen;
  const decimals = payload[p]; p += 1;
  if (decimals > 8) return null;
  if (p + 33 + 8 + 2 > payload.length) return null;
  const commitment = payload.slice(p, p + 33); p += 33;
  const encryptedAmount = payload.slice(p, p + 8); p += 8;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen + 32 + 2 > payload.length) return null;
  const rangeproof = payload.slice(p, p + rpLen); p += rpLen;
  const mintAuthority = payload.slice(p, p + 32); p += 32;
  const imgLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (imgLen > 256) return null;
  if (p + imgLen !== payload.length) return null; // canonical: no trailing bytes
  let imageUri = null;
  if (imgLen > 0) {
    try { imageUri = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + imgLen)); } catch { return null; }
  }
  const mintable = !_isZeroAuth(mintAuthority);
  return { kind: 'cetch', ticker, decimals, commitment, rangeproof, encryptedAmount, mintAuthority, mintable, imageUri };
}

// CXFER (aggregated bulletproof):
//   T_CXFER(1) || asset_id(32) || kernel_sig(64) || N(1) ||
//   (commitment(33) || amount_ct(8)) * N ||
//   rp_len(2 LE) || agg_rangeproof(rp_len)
// One aggregated rangeproof covers all N output commitments. m must be in {1,2,4,8}.
function encodeCXferPayload({ assetId, kernelSig, outputs, rangeproof }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (!kernelSig || kernelSig.length !== 64) throw new Error('kernel_sig must be 64 bytes');
  if (![1, 2, 4, 8].includes(outputs.length)) throw new Error('outputs must be in {1,2,4,8}');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  const parts = [new Uint8Array([T_CXFER]), assetId, kernelSig, new Uint8Array([outputs.length])];
  for (const o of outputs) {
    if (o.commitment.length !== 33) throw new Error('commitment 33 bytes');
    if (!o.encryptedAmount || o.encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
    parts.push(o.commitment, o.encryptedAmount);
  }
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  parts.push(rpLen, rangeproof);
  return concatBytes(...parts);
}

function decodeCXferPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 64 + 1 + (33 + 8) + 2) return null;
  if (payload[0] !== T_CXFER) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const kernelSig = payload.slice(p, p + 64); p += 64;
  const n = payload[p]; p += 1;
  if (![1, 2, 4, 8].includes(n)) return null;
  const outputs = [];
  for (let i = 0; i < n; i++) {
    if (p + 33 + 8 > payload.length) return null;
    const commitment = payload.slice(p, p + 33); p += 33;
    const encryptedAmount = payload.slice(p, p + 8); p += 8;
    outputs.push({ commitment, encryptedAmount });
  }
  if (p + 2 > payload.length) return null;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen !== payload.length) return null;
  const rangeproof = payload.slice(p, p + rpLen);
  return { kind: 'cxfer', assetId, kernelSig, outputs, rangeproof };
}

// T_AXFER (SPEC §5.7) — same shape as CXFER plus an asset_input_count byte
// after asset_id. The validator uses asset_input_count to know how many of
// vin[1..] are tacit asset inputs (governed by the kernel sig); the rest are
// aux BTC inputs, ungoverned. Used for atomic OTC settlement.
function encodeAxferPayload({ assetId, assetInputCount, kernelSig, outputs, rangeproof }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (!Number.isInteger(assetInputCount) || assetInputCount < 1 || assetInputCount > 255) {
    throw new Error('asset_input_count must be integer in [1, 255]');
  }
  if (!kernelSig || kernelSig.length !== 64) throw new Error('kernel_sig must be 64 bytes');
  if (![1, 2, 4, 8].includes(outputs.length)) throw new Error('outputs must be in {1,2,4,8}');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  const parts = [new Uint8Array([T_AXFER]), assetId, new Uint8Array([assetInputCount]), kernelSig, new Uint8Array([outputs.length])];
  for (const o of outputs) {
    if (o.commitment.length !== 33) throw new Error('commitment 33 bytes');
    if (!o.encryptedAmount || o.encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
    parts.push(o.commitment, o.encryptedAmount);
  }
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  parts.push(rpLen, rangeproof);
  return concatBytes(...parts);
}

function decodeAxferPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 1 + 64 + 1 + (33 + 8) + 2) return null;
  if (payload[0] !== T_AXFER) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const assetInputCount = payload[p]; p += 1;
  if (assetInputCount < 1) return null;
  const kernelSig = payload.slice(p, p + 64); p += 64;
  const n = payload[p]; p += 1;
  if (![1, 2, 4, 8].includes(n)) return null;
  const outputs = [];
  for (let i = 0; i < n; i++) {
    if (p + 33 + 8 > payload.length) return null;
    const commitment = payload.slice(p, p + 33); p += 33;
    const encryptedAmount = payload.slice(p, p + 8); p += 8;
    outputs.push({ commitment, encryptedAmount });
  }
  if (p + 2 > payload.length) return null;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen !== payload.length) return null;
  const rangeproof = payload.slice(p, p + rpLen);
  return { kind: 'axfer', assetId, assetInputCount, kernelSig, outputs, rangeproof };
}

// ---- Kernel message: binds the sig to (asset_id, input outpoints, output commitments) ----
// Anyone replaying this sig in a different tx (different inputs or outputs) gets a different msg
// and cannot produce a valid kernel.
function computeKernelMsg(assetId, inputOutpoints, outputCommitments, burnedAmount = 0n) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  // The wire format encodes counts as a single byte (SPEC §5.2 / §5.4). With
  // a hard reject above 255 we keep the spec literally true and close the
  // count-truncation hardening gap: silently truncating with `& 0xff` would
  // let two distinct input lists (length L and L+256) share a kernel msg.
  // In practice the dApp never builds more than 8 outputs and a handful of
  // inputs, but the encoder + validator should refuse the boundary case
  // explicitly rather than rely on length disambiguation in the hash.
  if (inputOutpoints.length > 255) throw new Error('kernel msg: input count > 255');
  if (outputCommitments.length > 255) throw new Error('kernel msg: output count > 255');
  const parts = [new TextEncoder().encode('tacit-kernel-v1'), assetId, new Uint8Array([inputOutpoints.length])];
  for (const op of inputOutpoints) {
    parts.push(reverseBytes(hexToBytes(op.txid)));
    const voutLE = new Uint8Array(4);
    new DataView(voutLE.buffer).setUint32(0, op.vout >>> 0, true);
    parts.push(voutLE);
  }
  parts.push(new Uint8Array([outputCommitments.length]));
  for (const c of outputCommitments) parts.push(c);
  // Backwards-compatible: pure CXFER (no burn) sets burnedAmount=0 and the burn
  // bytes are still appended but their content is zero. This keeps kernel
  // verification consistent across CXFER and BURN paths.
  const burnLE = new Uint8Array(8);
  const view = new DataView(burnLE.buffer);
  view.setUint32(0, Number(burnedAmount & 0xffffffffn), true);
  view.setUint32(4, Number((burnedAmount >> 32n) & 0xffffffffn), true);
  parts.push(burnLE);
  return sha256(concatBytes(...parts));
}

// MINT (issue more supply on a mintable asset):
//   T_MINT(1) || asset_id(32) || etch_txid(32) ||
//   mint_commitment(33) || mint_amount_ct(8) ||
//   rp_len(2 LE) || rangeproof(rp_len) || issuer_sig(64)
//
// etch_txid is included so the validator can fetch the CETCH envelope by txid
// and verify (a) mint_authority is non-zero (asset is mintable), (b) sig was
// signed by mint_authority. asset_id must equal sha256(etch_txid_BE || vout=0).
//
// issuer_sig is a BIP-340 Schnorr signature over
//   sha256("tacit-mint-v1" || asset_id || commit_anchor(36B) || mint_commitment || mint_amount_ct)
// signed by the mint_authority private key. New mint output goes to vout=0 of
// the reveal tx (P2WPKH to issuer wallet), holding mint_commitment. The
// commit_anchor field binds the signature to a specific commit/reveal pair —
// without it, an attacker could rewrap the on-chain envelope into their own
// commit/reveal flow at their own address (see computeMintMsg below).
function encodeCMintPayload({ assetId, etchTxid, commitment, encryptedAmount, rangeproof, issuerSig }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (etchTxid.length !== 32) throw new Error('etch_txid 32 bytes');
  if (commitment.length !== 33) throw new Error('commitment 33 bytes');
  if (!encryptedAmount || encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  if (!issuerSig || issuerSig.length !== 64) throw new Error('issuer_sig must be 64 bytes');
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  return concatBytes(
    new Uint8Array([T_MINT]), assetId, etchTxid,
    commitment, encryptedAmount, rpLen, rangeproof, issuerSig,
  );
}

function decodeCMintPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 32 + 33 + 8 + 2 + 64) return null;
  if (payload[0] !== T_MINT) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const etchTxid = payload.slice(p, p + 32); p += 32;
  const commitment = payload.slice(p, p + 33); p += 33;
  const encryptedAmount = payload.slice(p, p + 8); p += 8;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen + 64 > payload.length) return null;
  const rangeproof = payload.slice(p, p + rpLen); p += rpLen;
  const issuerSig = payload.slice(p, p + 64); p += 64;
  if (p !== payload.length) return null;
  return { kind: 'cmint', assetId, etchTxid, commitment, encryptedAmount, rangeproof, issuerSig };
}

// Mint message must bind the *transaction-specific* commit-input anchor so a
// witnessed mint envelope can't be replayed into a different commit/reveal pair
// at an attacker's address. Without anchor binding, the validator only checks
// (asset_id, commitment, amount_ct) — all observable on chain — and an attacker
// who reads any past T_MINT can clone the envelope into their own UTXO. With
// anchor binding the issuer's signature is tied to the specific commit_tx.vin[0]
// outpoint that funds the reveal, which the attacker cannot reproduce.
//
// commit_anchor = commit_tx.vin[0].txid_BE(32) || commit_tx.vin[0].vout_LE(4)
// (same anchor the issuer already uses for the mint blinding/keystream HMAC).
function computeMintMsg(assetId, commitAnchor, commitment, encryptedAmount) {
  if (!commitAnchor || commitAnchor.length !== 36) throw new Error('commit_anchor must be 36 bytes');
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-mint-v1'),
    assetId, commitAnchor, commitment, encryptedAmount,
  ));
}

// BURN (destroy supply, emit a public burned_amount):
//   T_BURN(1) || asset_id(32) || burned_amount(8 LE u64) ||
//   kernel_sig(64) || N(1) ||
//   (commitment(33) || amount_ct(8)) * N ||
//   rp_len(2 LE) || rangeproof(rp_len)
//
// Validator equation: Σ C_in == burned_amount·H + Σ C_out (in commitment space).
// Kernel sig binds (asset_id, inputs, outputs, burned_amount) — replay-safe.
// N ∈ {0, 1, 2, 4, 8}: zero outputs allowed (burn everything to nothing).
function encodeCBurnPayload({ assetId, burnedAmount, kernelSig, outputs, rangeproof }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (burnedAmount < 0n || burnedAmount >= (1n << BigInt(N_BITS))) throw new Error('burned_amount out of range');
  if (!kernelSig || kernelSig.length !== 64) throw new Error('kernel_sig must be 64 bytes');
  if (![0, 1, 2, 4, 8].includes(outputs.length)) throw new Error('outputs.length must be in {0,1,2,4,8}');
  if (outputs.length > 0 && rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  if (outputs.length === 0 && rangeproof && rangeproof.length > 0) throw new Error('rangeproof must be empty when outputs.length === 0');
  const burnLE = new Uint8Array(8);
  {
    const view = new DataView(burnLE.buffer);
    view.setUint32(0, Number(burnedAmount & 0xffffffffn), true);
    view.setUint32(4, Number((burnedAmount >> 32n) & 0xffffffffn), true);
  }
  const parts = [new Uint8Array([T_BURN]), assetId, burnLE, kernelSig, new Uint8Array([outputs.length])];
  for (const o of outputs) {
    if (o.commitment.length !== 33) throw new Error('commitment 33 bytes');
    if (!o.encryptedAmount || o.encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
    parts.push(o.commitment, o.encryptedAmount);
  }
  if (outputs.length > 0) {
    const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
    parts.push(rpLen, rangeproof);
  }
  return concatBytes(...parts);
}

function decodeCBurnPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 32 + 8 + 64 + 1) return null;
  if (payload[0] !== T_BURN) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const burnedLE = payload.slice(p, p + 8); p += 8;
  const view = new DataView(burnedLE.buffer, burnedLE.byteOffset, 8);
  const burnedAmount = (BigInt(view.getUint32(4, true)) << 32n) | BigInt(view.getUint32(0, true));
  const kernelSig = payload.slice(p, p + 64); p += 64;
  const n = payload[p]; p += 1;
  if (![0, 1, 2, 4, 8].includes(n)) return null;
  const outputs = [];
  for (let i = 0; i < n; i++) {
    if (p + 33 + 8 > payload.length) return null;
    const commitment = payload.slice(p, p + 33); p += 33;
    const encryptedAmount = payload.slice(p, p + 8); p += 8;
    outputs.push({ commitment, encryptedAmount });
  }
  let rangeproof = new Uint8Array(0);
  if (n > 0) {
    if (p + 2 > payload.length) return null;
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen !== payload.length) return null;
    rangeproof = payload.slice(p, p + rpLen);
  } else {
    if (p !== payload.length) return null;
  }
  return { kind: 'cburn', assetId, burnedAmount, kernelSig, outputs, rangeproof };
}

// ============== PERMISSIONLESS MINT (T_PETCH / T_PMINT) ==============
// SPEC §5.8 / §5.9. Permissionless fair-launch issuance:
//   - T_PETCH (0x27): deployment record. Declares ticker, decimals, lifetime
//     cap, fixed per-mint amount, and a height window. NO supply UTXO is
//     produced — the deployer receives zero tokens; to hold any, they (or
//     anyone else) must broadcast T_PMINT.
//   - T_PMINT (0x28): permissionless mint event. Anyone may broadcast.
//     Reveals (amount, blinding) so any chain reader can audit the cap; cap
//     is enforced by indexers summing canonically-ordered T_PMINTs at
//     confirmation depth ≥ 3 (SPEC §5.9 *Confirmation depth*).
//
// Wire format kept verbatim parity with worker/src/index.js's
// decodeCPetchPayload / decodeCPmintPayload — any drift here breaks
// indexer interop. The worker-decoder.test.mjs / dapp-parity.test.mjs
// pair pins this contract on every push.

// T_PETCH(1) || tlen(1) || ticker(tlen) || decimals(1) ||
//   cap_amount(8 LE) || mint_limit(8 LE) || mint_start_height(4 LE) ||
//   mint_end_height(4 LE) || img_len(2 LE) || image_uri(img_len)
function encodeCPetchPayload({ ticker, decimals, capAmount, mintLimit, mintStartHeight = 0, mintEndHeight = 0, imageUri = null }) {
  const tk = new TextEncoder().encode(ticker);
  if (tk.length < 1 || tk.length > 16) throw new Error('ticker length must be 1..16');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('decimals must be 0..8');
  const cap = BigInt(capAmount);
  const lim = BigInt(mintLimit);
  if (cap <= 0n || cap >= (1n << BigInt(N_BITS))) throw new Error('cap_amount out of range');
  if (lim <= 0n || lim > cap) throw new Error('mint_limit out of range');
  if (cap % lim !== 0n) throw new Error('cap_amount must be evenly divisible by mint_limit');
  if (!Number.isInteger(mintStartHeight) || mintStartHeight < 0 || mintStartHeight > 0xffffffff) throw new Error('mint_start_height out of range');
  if (!Number.isInteger(mintEndHeight) || mintEndHeight < 0 || mintEndHeight > 0xffffffff) throw new Error('mint_end_height out of range');
  if (mintStartHeight !== 0 && mintEndHeight !== 0 && mintEndHeight <= mintStartHeight) {
    throw new Error('mint_end_height must exceed mint_start_height when both nonzero');
  }
  const img = imageUri ? new TextEncoder().encode(imageUri) : new Uint8Array(0);
  if (img.length > 256) throw new Error('image_uri too long');
  const capLE = new Uint8Array(8);
  const limLE = new Uint8Array(8);
  {
    const cv = new DataView(capLE.buffer);
    cv.setUint32(0, Number(cap & 0xffffffffn), true);
    cv.setUint32(4, Number((cap >> 32n) & 0xffffffffn), true);
    const lv = new DataView(limLE.buffer);
    lv.setUint32(0, Number(lim & 0xffffffffn), true);
    lv.setUint32(4, Number((lim >> 32n) & 0xffffffffn), true);
  }
  const startLE = new Uint8Array(4); new DataView(startLE.buffer).setUint32(0, mintStartHeight >>> 0, true);
  const endLE = new Uint8Array(4); new DataView(endLE.buffer).setUint32(0, mintEndHeight >>> 0, true);
  const imgLen = new Uint8Array(2); new DataView(imgLen.buffer).setUint16(0, img.length, true);
  return concatBytes(
    new Uint8Array([T_PETCH]), new Uint8Array([tk.length]), tk,
    new Uint8Array([decimals]), capLE, limLE, startLE, endLE, imgLen, img,
  );
}

function decodeCPetchPayload(payload) {
  if (!payload) return null;
  if (payload.length < 1 + 1 + 1 + 1 + 8 + 8 + 4 + 4 + 2) return null;
  if (payload[0] !== T_PETCH) return null;
  let p = 1;
  const tlen = payload[p]; p += 1;
  if (tlen < 1 || tlen > 16) return null;
  if (p + tlen > payload.length) return null;
  let ticker;
  try { ticker = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + tlen)); } catch { return null; }
  p += tlen;
  const decimals = payload[p]; p += 1;
  if (decimals > 8) return null;
  if (p + 8 + 8 + 4 + 4 + 2 > payload.length) return null;
  const capView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const capAmount = (BigInt(capView.getUint32(4, true)) << 32n) | BigInt(capView.getUint32(0, true));
  p += 8;
  const limView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const mintLimit = (BigInt(limView.getUint32(4, true)) << 32n) | BigInt(limView.getUint32(0, true));
  p += 8;
  if (capAmount <= 0n) return null;
  if (mintLimit <= 0n) return null;
  if (mintLimit > capAmount) return null;
  if (capAmount % mintLimit !== 0n) return null;
  const startView = new DataView(payload.buffer, payload.byteOffset + p, 4);
  const mintStartHeight = startView.getUint32(0, true); p += 4;
  const endView = new DataView(payload.buffer, payload.byteOffset + p, 4);
  const mintEndHeight = endView.getUint32(0, true); p += 4;
  if (mintStartHeight !== 0 && mintEndHeight !== 0 && mintEndHeight <= mintStartHeight) return null;
  const imgLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (imgLen > 256) return null;
  if (p + imgLen !== payload.length) return null;
  let imageUri = null;
  if (imgLen > 0) {
    try { imageUri = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(p, p + imgLen)); } catch { return null; }
  }
  return { kind: 'cpetch', ticker, decimals, capAmount, mintLimit, mintStartHeight, mintEndHeight, imageUri };
}

// T_PMINT(1) || asset_id(32) || etch_txid(32) || commitment(33) ||
//   amount(8 LE) || blinding(32). Total: 138 bytes exactly.
function encodeCPmintPayload({ assetId, etchTxid, commitment, amount, blinding }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (etchTxid.length !== 32) throw new Error('etch_txid 32 bytes');
  if (commitment.length !== 33) throw new Error('commitment 33 bytes');
  const amt = BigInt(amount);
  if (amt <= 0n || amt >= (1n << BigInt(N_BITS))) throw new Error('amount out of range');
  if (!blinding || blinding.length !== 32) throw new Error('blinding must be 32 bytes');
  let blindingNonZero = false;
  for (let i = 0; i < 32; i++) if (blinding[i] !== 0) { blindingNonZero = true; break; }
  if (!blindingNonZero) throw new Error('blinding must be non-zero');
  const amtLE = new Uint8Array(8);
  {
    const v = new DataView(amtLE.buffer);
    v.setUint32(0, Number(amt & 0xffffffffn), true);
    v.setUint32(4, Number((amt >> 32n) & 0xffffffffn), true);
  }
  return concatBytes(
    new Uint8Array([T_PMINT]), assetId, etchTxid, commitment, amtLE, blinding,
  );
}

function decodeCPmintPayload(payload) {
  if (!payload) return null;
  if (payload.length !== 1 + 32 + 32 + 33 + 8 + 32) return null;
  if (payload[0] !== T_PMINT) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const etchTxid = payload.slice(p, p + 32); p += 32;
  const commitment = payload.slice(p, p + 33); p += 33;
  const amtView = new DataView(payload.buffer, payload.byteOffset + p, 8);
  const amount = (BigInt(amtView.getUint32(4, true)) << 32n) | BigInt(amtView.getUint32(0, true));
  p += 8;
  if (amount <= 0n || amount >= (1n << BigInt(N_BITS))) return null;
  const blinding = payload.slice(p, p + 32); p += 32;
  let blindingNonZero = false;
  for (let i = 0; i < 32; i++) if (blinding[i] !== 0) { blindingNonZero = true; break; }
  if (!blindingNonZero) return null;
  if (p !== payload.length) return null;
  return { kind: 'cpmint', assetId, etchTxid, commitment, amount, blinding };
}

// ============== STORAGE ==============
// Both the asset-metadata registry and the per-UTXO opening cache are
// network-namespaced. asset_ids and txids can't collide cross-network
// (asset_id derives from a chain-specific txid), so this is a UX cleanup
// rather than a security boundary — but with per-network wallet keys, it
// keeps the dApp's view consistent: switching to mainnet doesn't surface
// stale signet entries.
//
// Crash-safe: a corrupt blob (manual edit, partial write, future schema
// bump) must not brick init(). Fall back to empty and log so the user can
// recover by re-scanning, rather than throwing during module load.
const REG_KEY_BASE  = 'tacit-registry-v1';
const OPEN_KEY_BASE = 'tacit-openings-v1';
function regKey()  { return `${REG_KEY_BASE}:${NET.name}`; }
function openKey() { return `${OPEN_KEY_BASE}:${NET.name}`; }
// In-memory write-through caches for the registry (asset_id → meta) and the
// openings (txid:vout → { amount, blinding, assetIdHex }). Without these,
// every getAssetMeta / getOpening call did a JSON.parse over localStorage;
// scanHoldings hits getAssetMeta ~7×/UTXO + getOpening once, so a 100-UTXO
// scan was paying ~700 redundant parses. The caches live on the JS module;
// a network flip (which changes the storage key) does location.reload() so
// stale state from one network can never be read against another's key.
let _registryCache = null;
let _openingsCache = null;

// Discover tab badge inputs. Both lists render in parallel (CETCH +
// public-mint), each one calling _bumpDiscoverBadge() once it knows its own
// count. The badge shows the sum. Tracked separately so a slow load on one
// side doesn't reset the other side's already-shown contribution.
let _lastDiscoverCetchCount = 0;
let _lastDiscoverPetchCount = 0;
function _bumpDiscoverBadge() {
  if (typeof setTabBadge !== 'function') return;
  setTabBadge('discover', _lastDiscoverCetchCount + _lastDiscoverPetchCount);
}
const loadRegistry = () => {
  if (_registryCache) return _registryCache;
  try { _registryCache = JSON.parse(localStorage.getItem(regKey()) || '{}') || {}; }
  catch (e) { console.warn('registry parse failed; resetting to empty', e); _registryCache = {}; }
  return _registryCache;
};
const saveRegistry = r => {
  _registryCache = r;
  try { localStorage.setItem(regKey(), JSON.stringify(r)); } catch {}
};
function registerAsset(meta) {
  const r = loadRegistry();
  r[meta.assetIdHex] = { ...r[meta.assetIdHex], ...meta };
  saveRegistry(r);
}
function getAssetMeta(assetIdHex) {
  const r = loadRegistry();
  return r[assetIdHex] || null;
}
// Per-UTXO openings: "txid:vout" -> { assetIdHex, amount: string, blinding: hex }
const loadOpenings = () => {
  if (_openingsCache) return _openingsCache;
  try { _openingsCache = JSON.parse(localStorage.getItem(openKey()) || '{}') || {}; }
  catch (e) { console.warn('openings parse failed; resetting to empty', e); _openingsCache = {}; }
  return _openingsCache;
};
// Persist the cache to localStorage. Used by both immediate-write paths
// (broadcast handlers calling recordOpening once) and the debounced flush
// path (scanHoldings discovering many openings in a tight loop).
function _writeOpeningsNow() {
  if (!_openingsCache) return;
  try { localStorage.setItem(openKey(), JSON.stringify(_openingsCache)); } catch {}
}
// Debounced flush: when a burst of recordOpening calls happens (e.g., a fresh
// scan recovering N openings sequentially), settle to one localStorage write
// after 50ms of quiet. Each write is O(N) JSON serialization of a growing
// blob — without debounce that's quadratic on first scan.
let _openingsFlushTimer = null;
function _scheduleOpeningsFlush() {
  if (_openingsFlushTimer) clearTimeout(_openingsFlushTimer);
  _openingsFlushTimer = setTimeout(() => {
    _openingsFlushTimer = null;
    _writeOpeningsNow();
  }, 50);
}
// Belt-and-braces: flush early if the tab is being hidden or closed so a
// debounce in-flight isn't lost.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _openingsFlushTimer) {
      clearTimeout(_openingsFlushTimer); _openingsFlushTimer = null;
      _writeOpeningsNow();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (_openingsFlushTimer) {
      clearTimeout(_openingsFlushTimer); _openingsFlushTimer = null;
      _writeOpeningsNow();
    }
  });
}
function recordOpening(txidHex, vout, assetIdHex, amount, blinding) {
  const o = loadOpenings();
  o[`${txidHex}:${vout}`] = {
    assetIdHex,
    amount: amount.toString(),
    blinding: bytesToHex(bigintToBytes32(blinding)),
  };
  _openingsCache = o;
  _scheduleOpeningsFlush();
}
function getOpening(txidHex, vout) {
  const o = loadOpenings();
  const e = o[`${txidHex}:${vout}`];
  if (!e) return null;
  return {
    assetIdHex: e.assetIdHex,
    amount: BigInt(e.amount),
    blinding: BigInt('0x' + e.blinding),
  };
}

// ============== ACTIVITY LOG ==============
// Local, network-scoped log of broadcasts the wallet has signed (etch /
// transfer-out / mint / burn). Renders in the Holdings tab so the user can
// see "what did I just do?" without rebuilding state from chain.
//
// Storage: tacit-activity-v1:<network> → [{ kind, ticker, amount, decimals,
// assetId, txid, ts }]. Cap at ACTIVITY_MAX entries to keep localStorage
// bounded; oldest entries fall off when full.
//
// Pure UX surface — no protocol invariant rides on this. A user who clears
// localStorage simply loses their history; chain state is unaffected.
const ACTIVITY_KEY_BASE = 'tacit-activity-v1';
const ACTIVITY_MAX = 200;
function activityKey() { return `${ACTIVITY_KEY_BASE}:${NET.name}`; }
function loadActivity() {
  try {
    const raw = localStorage.getItem(activityKey());
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.warn('activity-log parse failed; resetting', e); return []; }
}
function recordActivity(entry) {
  if (!entry || !entry.kind) return;
  // Any broadcast we record changes wallet state — kill the cached scan so
  // the next renderHoldings / Preview / sats-send re-scans from chain. Cheap
  // (cache is a single object reference); avoids stale balances after a send.
  invalidateHoldingsCache();
  // Market state often changes too (listings get taken, intents fulfilled,
  // etc.) — invalidate so the next Market render hits the worker for fresh
  // listings. Cheap; just resets the TTL timestamp.
  if (typeof invalidateMarketCache === 'function') invalidateMarketCache();
  const arr = loadActivity();
  arr.unshift({
    kind:     String(entry.kind),
    ticker:   typeof entry.ticker === 'string' ? entry.ticker : '',
    amount:   entry.amount != null ? entry.amount.toString() : '',
    decimals: Number.isInteger(entry.decimals) ? entry.decimals : 0,
    assetId:  /^[0-9a-f]{64}$/.test(entry.assetId || '') ? entry.assetId : '',
    txid:     /^[0-9a-f]{64}$/.test(entry.txid || '') ? entry.txid : '',
    ts:       Number(entry.ts) || Date.now(),
  });
  if (arr.length > ACTIVITY_MAX) arr.length = ACTIVITY_MAX;
  try { localStorage.setItem(activityKey(), JSON.stringify(arr)); } catch {}
  _invalidateLocalActivityCaches();  // any pill might be affected by a new entry
}

// Cached per-pill Sets of asset_ids the user has locally interacted with.
// Invalidated by recordActivity (for activity-derived pills) and by
// recordOpenOffer / forgetOpenOffer (for the offers pill). Hot-path for
// renderDiscoverCard, which runs once per asset on every Discover refresh —
// without the cache, each card would re-load and re-parse localStorage for
// each of the four pills. Lazy-built on first read so we don't pay the
// parse cost during init().
let _localXferIdsCache = null;
let _localMintIdsCache = null;
let _localBurnIdsCache = null;
let _localOfferIdsCache = null;
let _localAtomicIdsCache = null;
function _invalidateLocalActivityCaches() {
  _localXferIdsCache = null;
  _localMintIdsCache = null;
  _localBurnIdsCache = null;
  _localOfferIdsCache = null;
  _localAtomicIdsCache = null;
}
function _buildLocalActivitySet(kindFilter) {
  try {
    return new Set(
      loadActivity()
        .filter(kindFilter)
        .map(e => e.assetId)
        .filter(id => /^[0-9a-f]{64}$/.test(id || ''))
    );
  } catch { return new Set(); }
}
function _localTransferAssetIds() {
  if (!_localXferIdsCache) _localXferIdsCache = _buildLocalActivitySet(e => e.kind === 'transfer-out' || e.kind === 'transfer-in');
  return _localXferIdsCache;
}
function _localMintAssetIds() {
  if (!_localMintIdsCache) _localMintIdsCache = _buildLocalActivitySet(e => e.kind === 'mint' || e.kind === 'etch');
  return _localMintIdsCache;
}
function _localBurnAssetIds() {
  if (!_localBurnIdsCache) _localBurnIdsCache = _buildLocalActivitySet(e => e.kind === 'burn');
  return _localBurnIdsCache;
}
function _localOfferAssetIds() {
  if (_localOfferIdsCache) return _localOfferIdsCache;
  try {
    // 'list-atomic' kinds in the activity log + any persisted open offer for
    // this network. The latter catches offers a user published in a prior
    // session whose activity entry has aged out of the 200-entry log.
    const ids = new Set();
    for (const e of loadActivity()) {
      if (e.kind === 'list-atomic' && /^[0-9a-f]{64}$/.test(e.assetId || '')) ids.add(e.assetId);
    }
    for (const o of loadOpenOffers()) {
      if (/^[0-9a-f]{64}$/.test(o.asset_id || '')) ids.add(o.asset_id);
    }
    _localOfferIdsCache = ids;
  } catch { _localOfferIdsCache = new Set(); }
  return _localOfferIdsCache;
}
// Atomic-intent-only set, used by the ⚡ pill. Today this is identical to
// `_localOfferAssetIds` because per-UTXO and range listings aren't persisted
// to localStorage (only atomics are via `recordOpenOffer`). Kept as a
// separate helper so future expansion (e.g. local listings persistence) can
// distinguish atomic from non-atomic offers without rewriting the pill
// predicate.
function _localAtomicAssetIds() {
  if (_localAtomicIdsCache) return _localAtomicIdsCache;
  try {
    const ids = new Set();
    for (const e of loadActivity()) {
      if (e.kind === 'list-atomic' && /^[0-9a-f]{64}$/.test(e.assetId || '')) ids.add(e.assetId);
    }
    for (const o of loadOpenOffers()) {
      if (/^[0-9a-f]{64}$/.test(o.asset_id || '')) ids.add(o.asset_id);
    }
    _localAtomicIdsCache = ids;
  } catch { _localAtomicIdsCache = new Set(); }
  return _localAtomicIdsCache;
}

// ============== OPEN ATOMIC OFFERS ==============
// Local, network-scoped record of T_AXFER offers the maker has created and
// shared. Survives page reloads so the maker can see "what's still pending"
// without keeping the JSON in their head. Status is recomputed from chain on
// render — this storage is purely a list of offers we want to track.
//
// Storage: tacit-offers-v1:<network> → [{ commit_txid, asset_id, ticker,
// decimals, amount, price_sats, recipient_pubkey, expiry, asset_utxo, json,
// ts }]. Capped at OFFERS_MAX; oldest entries drop when full.
const OFFERS_KEY_BASE = 'tacit-offers-v1';
const OFFERS_MAX = 50;
function offersKey() { return `${OFFERS_KEY_BASE}:${NET.name}`; }
function loadOpenOffers() {
  try {
    const raw = localStorage.getItem(offersKey());
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.warn('offers parse failed; resetting', e); return []; }
}
function saveOpenOffers(arr) {
  try { localStorage.setItem(offersKey(), JSON.stringify(arr)); } catch {}
  // The Has-offers pill on Discover reads from this list; invalidate so
  // the next render reflects the updated set without re-parsing per card.
  _localOfferIdsCache = null;
}
function recordOpenOffer(offer) {
  if (!offer || !/^[0-9a-f]{64}$/.test(String(offer.commit_txid || ''))) return;
  const arr = loadOpenOffers();
  // Replace any existing entry with the same commit_txid (e.g. user re-broadcasts).
  const filtered = arr.filter(o => o.commit_txid !== offer.commit_txid);
  filtered.unshift({
    commit_txid:      offer.commit_txid,
    asset_id:         offer.asset_id,
    ticker:           offer.ticker || '',
    decimals:         Number.isInteger(offer.decimals) ? offer.decimals : 0,
    amount:           String(offer.amount || ''),
    price_sats:       Number(offer.price_sats) || 0,
    recipient_pubkey: offer.recipient_pubkey || '',
    expiry:           Number(offer.expiry) || 0,
    asset_utxo:       offer.asset_utxo || null,
    json:             JSON.stringify(offer),
    ts:               Date.now(),
  });
  if (filtered.length > OFFERS_MAX) filtered.length = OFFERS_MAX;
  saveOpenOffers(filtered);
  // Pill caches (_localOfferIdsCache, _localAtomicIdsCache) read from
  // loadOpenOffers — invalidate so a freshly-published offer surfaces on
  // the next render without waiting for an unrelated activity-log mutation.
  _invalidateLocalActivityCaches();
}
function forgetOpenOffer(commitTxid) {
  const arr = loadOpenOffers().filter(o => o.commit_txid !== commitTxid);
  saveOpenOffers(arr);
  _invalidateLocalActivityCaches();
}

// Build a Map<"txid:vout", { kind, label }> of asset UTXOs that are already
// referenced by an active listing/intent for this asset, so the picker UI can
// flag (and disable) UTXOs the maker has already committed elsewhere. Sources:
//   • local atomic offers (loadOpenOffers — targeted offers made on this device)
//   • worker openings (LISTINGS_URL — opening listings)
//   • worker atomic intents (ATOMIC_INTENTS_URL — open/intent listings)
// Range listings cover an aggregate balance, not specific UTXOs, so they're
// intentionally not flagged here. Best-effort: any source that errors is
// skipped — partial knowledge is still useful in the dropdown.
async function fetchListedUtxoTags(assetIdHex) {
  const tags = new Map();
  const set = (key, kind, label) => { if (!tags.has(key)) tags.set(key, { kind, label }); };
  for (const o of loadOpenOffers()) {
    if (o.asset_id !== assetIdHex) continue;
    const u = o.asset_utxo;
    if (!u || !/^[0-9a-f]{64}$/.test(String(u.txid || ''))) continue;
    set(`${u.txid}:${u.vout | 0}`, 'atomic-offer', 'atomic offer');
  }
  if (!WORKER_BASE) return tags;
  const [openingsRes, intentsRes] = await Promise.allSettled([
    fetch(withNet(LISTINGS_URL(assetIdHex))).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(withNet(ATOMIC_INTENTS_URL(assetIdHex))).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (openingsRes.status === 'fulfilled' && Array.isArray(openingsRes.value?.listings)) {
    for (const l of openingsRes.value.listings) {
      if (l.expired) continue;
      if (!/^[0-9a-f]{64}$/.test(String(l.txid || ''))) continue;
      set(`${l.txid}:${l.vout | 0}`, 'opening', 'opening listing');
    }
  }
  if (intentsRes.status === 'fulfilled' && Array.isArray(intentsRes.value?.intents)) {
    for (const i of intentsRes.value.intents) {
      if (i.expired) continue;
      const u = i.asset_utxo;
      if (!u || !/^[0-9a-f]{64}$/.test(String(u.txid || ''))) continue;
      set(`${u.txid}:${u.vout | 0}`, 'atomic-intent', 'atomic intent');
    }
  }
  return tags;
}

// ============== ATOMIC-INTENT MAKER SECRETS ==============
// Per-intent random recipient blinding `r`. Picked at publish time, used at
// fulfilment time to encrypt to the claimant. Cleared on intent
// cancellation / settlement / expiry. Persisting locally is essential —
// without `r` the maker can't tell the claimant what amount the on-chain
// commitment opens to, so the trade can't complete. We don't share `r`
// outside this device unless via the encrypted fulfilment payload.
//
// Storage: tacit-axintent-secrets-v1:<network> → { [intent_id]: r_hex }.
const AXINTENT_SECRETS_KEY_BASE = 'tacit-axintent-secrets-v1';
function axintentSecretsKey() { return `${AXINTENT_SECRETS_KEY_BASE}:${NET.name}`; }
function loadAxintentSecrets() {
  try {
    const raw = localStorage.getItem(axintentSecretsKey());
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}
function recordAxintentSecret(intentIdHex, rHex) {
  if (!/^[0-9a-f]{32}$/.test(intentIdHex || '')) return;
  if (!/^[0-9a-f]{64}$/.test(rHex || '')) return;
  const obj = loadAxintentSecrets();
  obj[intentIdHex] = rHex;
  try { localStorage.setItem(axintentSecretsKey(), JSON.stringify(obj)); } catch {}
}
function loadAxintentSecret(intentIdHex) {
  return loadAxintentSecrets()[intentIdHex] || null;
}
function forgetAxintentSecret(intentIdHex) {
  const obj = loadAxintentSecrets();
  if (intentIdHex in obj) {
    delete obj[intentIdHex];
    try { localStorage.setItem(axintentSecretsKey(), JSON.stringify(obj)); } catch {}
  }
}

// ============== ATOMIC-INTENT PENDING POSTS ==============
// Per-intent body captured AFTER the commit tx has successfully broadcast
// but BEFORE the POST to the worker has succeeded. Without local
// persistence, a worker failure (indexer race, transient outage, anything)
// AFTER the maker has paid Bitcoin fees on the commit tx leaves the user
// with a confirmed on-chain commit but no marketplace listing. Saving the
// body lets us retry the POST verbatim — no second commit, no extra fees,
// same intent_id (which derives from commit_txid + maker_pub so it's stable).
// The body carries intent_sig already; combined with `r` from
// axintent-secrets, a captured pending entry is everything needed to
// publish. Cleared on successful POST or explicit user discard.
//
// Storage: tacit-axintent-pending-v1:<network> → { [intent_id]: { asset_id, body, savedAt } }
const AXINTENT_PENDING_KEY_BASE = 'tacit-axintent-pending-v1';
function axintentPendingKey() { return `${AXINTENT_PENDING_KEY_BASE}:${NET.name}`; }
function loadAxintentPendings() {
  try {
    const raw = localStorage.getItem(axintentPendingKey());
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch { return {}; }
}
function recordAxintentPending(intentIdHex, assetIdHex, body) {
  if (!/^[0-9a-f]{32}$/.test(intentIdHex || '')) return;
  if (!/^[0-9a-f]{64}$/.test(assetIdHex || '')) return;
  if (!body || typeof body !== 'object') return;
  const obj = loadAxintentPendings();
  obj[intentIdHex] = { asset_id: assetIdHex, body, savedAt: Math.floor(Date.now() / 1000) };
  try { localStorage.setItem(axintentPendingKey(), JSON.stringify(obj)); } catch {}
}
function loadAxintentPending(intentIdHex) {
  return loadAxintentPendings()[intentIdHex] || null;
}
function forgetAxintentPending(intentIdHex) {
  const obj = loadAxintentPendings();
  if (intentIdHex in obj) {
    delete obj[intentIdHex];
    try { localStorage.setItem(axintentPendingKey(), JSON.stringify(obj)); } catch {}
  }
}
function listAxintentPendings() {
  const obj = loadAxintentPendings();
  return Object.entries(obj).map(([intentIdHex, v]) => ({ intentIdHex, ...v }));
}

// Wait for the chain API to see a freshly-broadcast tx. The worker has its
// own 7s retry backstop in fetchFreshTxJson, but doing the wait here lets
// us (a) give the user explicit progress feedback, (b) wait longer than
// the worker's window before declaring "post failed", and (c) ensure the
// POST never reaches the worker when the chain API is going to 404 — which
// would burn worker subrequests + hold a long-lived connection unnecessarily.
async function waitForTxVisible(commitTxidHex, { maxMs = 60000, initialMs = 1500, onProgress = null } = {}) {
  let delay = initialMs;
  const deadline = Date.now() + maxMs;
  let attempts = 0;
  while (true) {
    attempts++;
    if (onProgress) try { onProgress(attempts); } catch {}
    try {
      const r = await fetch(`${NET.api}/tx/${commitTxidHex}`);
      if (r.ok) return await r.json();
      if (r.status !== 404) {
        const t = await r.text().catch(() => '');
        throw new Error(`tx visibility check failed: ${r.status} ${t.slice(0, 80)}`);
      }
    } catch (e) {
      if (Date.now() > deadline) throw e;
      // transient network / DNS / fetch failure — fall through to backoff
    }
    if (Date.now() + delay > deadline) {
      throw new Error(
        `commit tx ${commitTxidHex.slice(0, 8)}… not visible to ${NET.name} chain API after ${Math.round(maxMs/1000)}s. ` +
        `The Bitcoin tx may still be propagating; the marketplace listing is saved locally and will retry on next page load.`
      );
    }
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, 8000);
  }
}

// ============== INDEXER (witness-based) ==============
// Verify a CXFER's kernel signature and asset_id consistency.
// Recursively validate a tacit outpoint (txid, vout). Returns true iff:
//   - the outpoint's parent tx has a valid tacit envelope at vin[0].witness[1]
//   - all rangeproofs in that envelope verify
//   - if it's a CXFER: all of ITS input outpoints recursively validate, and the asset_id
//     matches across them, and the kernel sig verifies
// Memoized via validatedSet to avoid O(N²) re-validation on long chains.
// This is what makes tacit a soundly client-side-validated protocol: a malformed CXFER
// anywhere in an UTXO's ancestry invalidates everything downstream of it.
// At each CETCH leaf encountered during validation, record the canonical (ticker, decimals, etchTxid)
// in the optional metadataOut map keyed by asset_id hex. This is how share-link import obtains
// trustworthy metadata for unknown assets (don't trust the sender's link for ticker/decimals).
// Per-asset cache of credited T_PMINT txids, populated on first encounter
// during a scan and reused for subsequent ancestry walks within the same
// scan session. SPEC §5.9 *Confirmation depth* requires the indexer to
// canonical-order T_PMINT events at depth ≥ 3 before crediting them
// against the cap; the dapp delegates that ordering to the worker for v1
// and just checks set membership here. If the worker is unreachable we
// degrade to optimistic acceptance (structural invariants only) — this
// matches the spec's posture that the worker is operational, not trust-
// bearing for non-cap-bound envelopes, while flagging a v1 limitation:
// without the worker the dapp cannot enforce cap-overflow rejection on
// T_PMINT inputs to ancestry walks. SPEC §10 documents this.
const _pmintCreditedCache = new Map();
const PMINT_CREDITED_TTL_MS = 30 * 1000;
function invalidatePmintCreditedCache() { _pmintCreditedCache.clear(); }
async function _fetchPmintCredited(assetIdHex) {
  const c = _pmintCreditedCache.get(assetIdHex);
  if (c && (Date.now() - c.fetchedAt) < PMINT_CREDITED_TTL_MS) return c;
  if (!WORKER_BASE) {
    const fallback = { credited: null, capOverflow: null, workerAvailable: false, fetchedAt: Date.now() };
    _pmintCreditedCache.set(assetIdHex, fallback);
    return fallback;
  }
  try {
    // ?credited=1 short-circuit: worker returns just credited_txids, skipping
    // the per-event annotation that bloats the response by ~200-500 bytes per
    // pmint. Every cold scanHoldings walk hits one of these per unique petch
    // asset in the wallet, so wire-payload weight matters here.
    const r = await fetch(withNet(PMINTS_URL(assetIdHex), 'credited=1'));
    if (!r.ok) {
      const fallback = { credited: null, capOverflow: null, workerAvailable: false, fetchedAt: Date.now() };
      _pmintCreditedCache.set(assetIdHex, fallback);
      return fallback;
    }
    const j = await r.json();
    const credited = new Set();
    for (const t of (j.credited_txids || [])) {
      if (/^[0-9a-f]{64}$/.test(String(t))) credited.add(t);
    }
    const capOverflow = new Set();
    for (const t of (j.cap_overflow_txids || [])) {
      if (/^[0-9a-f]{64}$/.test(String(t))) capOverflow.add(t);
    }
    const entry = { credited, capOverflow, workerAvailable: true, fetchedAt: Date.now() };
    _pmintCreditedCache.set(assetIdHex, entry);
    return entry;
  } catch {
    const fallback = { credited: null, capOverflow: null, workerAvailable: false, fetchedAt: Date.now() };
    _pmintCreditedCache.set(assetIdHex, fallback);
    return fallback;
  }
}

// pmintStatusOut (optional, last positional) is a Map<"txid:vout", 'pending' | 'invalid'>
// scanHoldings populates so it can distinguish T_PMINT failures that may
// promote later (mempool, depth < 3, worker says not credited yet) from
// permanently-invalid ones (forged commitment, asset_id mismatch, height
// window violation, cap_overflow, parent not T_PETCH). Without this, every
// T_PMINT failure mode rendered as "Inflation attempt detected" in the
// holdings UI — a user who just successfully clicked Mint saw a scary
// warning on their own legitimate mint until cron + 3 confs caught up.
// Audit fix #1: pending mints render as a separate, accurate UI tier.
async function validateOutpoint(txidHex, vout, validatedSet, fetchTx, depth = 0, metadataOut = null, rpBatch = null, pmintStatusOut = null) {
  const key = `${txidHex}:${vout}`;
  if (validatedSet.has(key)) return validatedSet.get(key);
  if (depth > 200) { validatedSet.set(key, false); return false; } // depth bound

  const tx = await fetchTx(txidHex);
  if (!tx || !tx.vin || !tx.vin[0]) { validatedSet.set(key, false); return false; }
  const wit = tx.vin[0].witness;
  if (!wit || wit.length < 3) { validatedSet.set(key, false); return false; }
  let env;
  try { env = decodeEnvelopeScript(hexToBytes(wit[1])); } catch { env = null; }
  if (!env) { validatedSet.set(key, false); return false; }

  // Helper: mark all sibling outputs of this tx with a result
  const markAll = (n, ok) => { for (let j = 0; j < n; j++) validatedSet.set(`${txidHex}:${j}`, ok); };

  // When rpBatch is provided we defer rangeproof verification — push to the batch
  // and accept tentatively. The caller resolves the batch once the whole walk
  // completes (one big multi-exp instead of N small ones). If the batch fails,
  // the caller re-runs in strict mode (rpBatch=null) to identify the bad one.
  if (env.opcode === T_CETCH) {
    if (vout !== 0) { validatedSet.set(key, false); return false; }
    const dec = decodeCEtchPayload(env.payload);
    if (!dec) { validatedSet.set(key, false); return false; }
    let Cpt; try { Cpt = bytesToPoint(dec.commitment); } catch { validatedSet.set(key, false); return false; }
    if (rpBatch) {
      rpBatch.push({ commitments: [Cpt], proof: dec.rangeproof });
      validatedSet.set(key, true);
    } else {
      const ok = bpRangeAggVerify([Cpt], dec.rangeproof);
      validatedSet.set(key, ok);
      if (!ok) return false;
    }
    if (metadataOut) {
      const aidHex = bytesToHex(assetIdFor(txidHex, 0));
      if (!metadataOut.has(aidHex)) {
        metadataOut.set(aidHex, {
          ticker: dec.ticker, decimals: dec.decimals, etchTxid: txidHex,
          imageUri: dec.imageUri || null,
          mintable: dec.mintable, mintAuthorityHex: bytesToHex(dec.mintAuthority),
        });
      }
    }
    return true;
  }

  if (env.opcode === T_MINT) {
    // MINT: new supply for a mintable asset_id, signed by mint_authority.
    if (vout !== 0) { validatedSet.set(key, false); return false; }
    const dec = decodeCMintPayload(env.payload);
    if (!dec) { validatedSet.set(key, false); return false; }
    // Verify asset_id == sha256(etch_txid_BE || vout=0). Stops anyone from
    // claiming an arbitrary etch is the mintable parent.
    const aidFromEtch = assetIdFor(bytesToHex(dec.etchTxid), 0);
    for (let i = 0; i < 32; i++) if (aidFromEtch[i] !== dec.assetId[i]) { validatedSet.set(key, false); return false; }
    // Fetch CETCH ancestor, confirm mintable, get mint_authority pubkey.
    const etchTxidHex = bytesToHex(dec.etchTxid);
    const etchTx = await fetchTx(etchTxidHex);
    if (!etchTx?.vin?.[0]?.witness || etchTx.vin[0].witness.length < 3) { validatedSet.set(key, false); return false; }
    let etchEnv;
    try { etchEnv = decodeEnvelopeScript(hexToBytes(etchTx.vin[0].witness[1])); } catch { etchEnv = null; }
    if (!etchEnv || etchEnv.opcode !== T_CETCH) { validatedSet.set(key, false); return false; }
    const etchDec = decodeCEtchPayload(etchEnv.payload);
    if (!etchDec || !etchDec.mintable) { validatedSet.set(key, false); return false; }
    // Recursively validate the CETCH ancestor itself. T_MINT's soundness
    // doesn't depend on the etch's range proof (mint commits fresh supply
    // gated only by the issuer's mint-authority signature), but accepting a
    // mint whose parent etch fails validation would be inconsistent with the
    // CXFER/BURN ancestry rule and surprising to anyone reading the spec.
    // The recursive call is memoized via validatedSet so repeated mints under
    // the same etch only walk the etch once per scan.
    const etchValid = await validateOutpoint(etchTxidHex, 0, validatedSet, fetchTx, depth + 1, metadataOut, rpBatch);
    if (!etchValid) { validatedSet.set(key, false); return false; }
    // Re-derive the commit-input anchor from the reveal tx's parent commit tx.
    // The issuer signs over this anchor; without it, replay of the envelope into
    // a different (commit, reveal) pair would still verify and let an attacker
    // plant a "valid" supply UTXO at any address.
    const mintCommitTx = await fetchTx(tx.vin[0].txid);
    if (!mintCommitTx?.vin?.[0]) { validatedSet.set(key, false); return false; }
    const ci = mintCommitTx.vin[0];
    const mintAnchor = concatBytes(
      reverseBytes(hexToBytes(ci.txid)),
      (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, ci.vout >>> 0, true); return b; })(),
    );
    // Issuer signature
    const mintMsg = computeMintMsg(dec.assetId, mintAnchor, dec.commitment, dec.encryptedAmount);
    if (!verifySchnorr(dec.issuerSig, mintMsg, etchDec.mintAuthority)) { validatedSet.set(key, false); return false; }
    // Rangeproof for the new supply commitment (m=1, n=64)
    let Cpt; try { Cpt = bytesToPoint(dec.commitment); } catch { validatedSet.set(key, false); return false; }
    if (rpBatch) {
      rpBatch.push({ commitments: [Cpt], proof: dec.rangeproof });
      validatedSet.set(key, true);
    } else {
      const ok = bpRangeAggVerify([Cpt], dec.rangeproof);
      validatedSet.set(key, ok);
      if (!ok) return false;
    }
    if (metadataOut) {
      const aidHex = bytesToHex(dec.assetId);
      if (!metadataOut.has(aidHex)) {
        metadataOut.set(aidHex, {
          ticker: etchDec.ticker, decimals: etchDec.decimals, etchTxid: etchTxidHex,
          imageUri: etchDec.imageUri || null,
          mintable: etchDec.mintable, mintAuthorityHex: bytesToHex(etchDec.mintAuthority),
        });
      }
    }
    return true;
  }

  if (env.opcode === T_CXFER || env.opcode === T_BURN) {
    const isBurn = env.opcode === T_BURN;
    const dec = isBurn ? decodeCBurnPayload(env.payload) : decodeCXferPayload(env.payload);
    if (!dec) { validatedSet.set(key, false); return false; }
    const N = dec.outputs.length;
    // CXFER requires vout < N. BURN may have N=0 (full burn, no change) — in
    // which case the tx has no tacit asset outputs at all, so any vout (incl. 0)
    // must be rejected. `vout >= N` covers both cases including N=0.
    if (vout >= N) { validatedSet.set(key, false); return false; }

    // Step 1: every input outpoint must itself be valid (recursive client-side validation)
    if (tx.vin.length < 2) { markAll(Math.max(N, 1), false); return false; }
    // Hard cap: the kernel msg encodes input count in 1 byte (see
    // computeKernelMsg). Any tx with >256 asset inputs would have been signed
    // under a truncated count and is rejected here so encoder and validator
    // agree literally on the SPEC §5.2 / §5.4 wire constraint.
    if (tx.vin.length - 1 > 255) { markAll(Math.max(N, 1), false); return false; }
    for (let i = 1; i < tx.vin.length; i++) {
      const inp = tx.vin[i];
      const parentValid = await validateOutpoint(inp.txid, inp.vout, validatedSet, fetchTx, depth + 1, metadataOut, rpBatch);
      if (!parentValid) { markAll(Math.max(N, 1), false); return false; }
    }

    // Step 2: aggregated bulletproof verifies all output commitments. Skipped
    // if BURN with N=0 (no output commitments to range-prove).
    let Cpts;
    if (N > 0) {
      try { Cpts = dec.outputs.map(o => bytesToPoint(o.commitment)); }
      catch { markAll(Math.max(N, 1), false); return false; }
      if (rpBatch) {
        rpBatch.push({ commitments: Cpts, proof: dec.rangeproof });
      } else {
        if (!bpRangeAggVerify(Cpts, dec.rangeproof)) { markAll(Math.max(N, 1), false); return false; }
      }
    } else {
      Cpts = [];
    }

    // Step 3: asset_id consistency + kernel signature.
    const ourAssetIdHex = bytesToHex(dec.assetId);
    const inputCommitments = [];
    for (let i = 1; i < tx.vin.length; i++) {
      const inp = tx.vin[i];
      const parent = await fetchTx(inp.txid);
      const pwit = parent?.vin?.[0]?.witness;
      if (!pwit || pwit.length < 3) { markAll(Math.max(N, 1), false); return false; }
      let parentEnv;
      try { parentEnv = decodeEnvelopeScript(hexToBytes(pwit[1])); } catch { parentEnv = null; }
      if (!parentEnv) { markAll(Math.max(N, 1), false); return false; }
      const pd = getParentEnvelopeData(parentEnv, inp.vout, inp.txid);
      if (!pd) { markAll(Math.max(N, 1), false); return false; }
      if (pd.assetIdHex !== ourAssetIdHex) { markAll(Math.max(N, 1), false); return false; }
      inputCommitments.push(pd.commitment);
    }

    // E' = Σ C_out + (burned_amount · H if burn else 0) − Σ C_in
    let EPrime = secp.ProjectivePoint.ZERO;
    try {
      for (const o of dec.outputs) EPrime = EPrime.add(bytesToPoint(o.commitment));
      if (isBurn && dec.burnedAmount > 0n) EPrime = EPrime.add(safeMult(H, dec.burnedAmount));
      for (const c of inputCommitments) EPrime = EPrime.add(bytesToPoint(c).negate());
    } catch { markAll(Math.max(N, 1), false); return false; }
    if (EPrime.equals(secp.ProjectivePoint.ZERO)) { markAll(Math.max(N, 1), false); return false; }

    const ExBytes = EPrime.toRawBytes(true).slice(1);
    const inputOutpoints = tx.vin.slice(1).map(v => ({ txid: v.txid, vout: v.vout }));
    const outputCommitments = dec.outputs.map(o => o.commitment);
    const burnedAmount = isBurn ? dec.burnedAmount : 0n;
    const msg = computeKernelMsg(dec.assetId, inputOutpoints, outputCommitments, burnedAmount);
    const kernelOk = verifySchnorr(dec.kernelSig, msg, ExBytes);

    markAll(Math.max(N, 1), kernelOk);
    return kernelOk;
  }

  if (env.opcode === T_AXFER) {
    // SPEC §5.7. Same flow as CXFER but with declared asset_input_count:
    // vin[1..1+aic] are tacit asset inputs (recursively validated, contribute
    // to kernel msg + E'); vin[1+aic..] are aux BTC inputs the kernel sig
    // deliberately doesn't bind. Used for atomic OTC settlement where a
    // buyer's BTC payment shares the same Bitcoin tx as the maker's reveal.
    const dec = decodeAxferPayload(env.payload);
    if (!dec) { validatedSet.set(key, false); return false; }
    const N = dec.outputs.length;
    if (vout >= N) { validatedSet.set(key, false); return false; }
    const aic = dec.assetInputCount;
    if (aic < 1 || aic > 255) { markAll(N, false); return false; }
    if (tx.vin.length < 1 + aic) { markAll(N, false); return false; }
    for (let i = 1; i < 1 + aic; i++) {
      const inp = tx.vin[i];
      const parentValid = await validateOutpoint(inp.txid, inp.vout, validatedSet, fetchTx, depth + 1, metadataOut, rpBatch);
      if (!parentValid) { markAll(N, false); return false; }
    }
    let Cpts;
    try { Cpts = dec.outputs.map(o => bytesToPoint(o.commitment)); }
    catch { markAll(N, false); return false; }
    if (rpBatch) {
      rpBatch.push({ commitments: Cpts, proof: dec.rangeproof });
    } else if (!bpRangeAggVerify(Cpts, dec.rangeproof)) {
      markAll(N, false); return false;
    }
    const ourAssetIdHex = bytesToHex(dec.assetId);
    const inputCommitments = [];
    for (let i = 1; i < 1 + aic; i++) {
      const inp = tx.vin[i];
      const parent = await fetchTx(inp.txid);
      const pwit = parent?.vin?.[0]?.witness;
      if (!pwit || pwit.length < 3) { markAll(N, false); return false; }
      let parentEnv;
      try { parentEnv = decodeEnvelopeScript(hexToBytes(pwit[1])); } catch { parentEnv = null; }
      if (!parentEnv) { markAll(N, false); return false; }
      const pd = getParentEnvelopeData(parentEnv, inp.vout, inp.txid);
      if (!pd) { markAll(N, false); return false; }
      if (pd.assetIdHex !== ourAssetIdHex) { markAll(N, false); return false; }
      inputCommitments.push(pd.commitment);
    }
    let EPrimeV2 = secp.ProjectivePoint.ZERO;
    try {
      for (const o of dec.outputs) EPrimeV2 = EPrimeV2.add(bytesToPoint(o.commitment));
      for (const c of inputCommitments) EPrimeV2 = EPrimeV2.add(bytesToPoint(c).negate());
    } catch { markAll(N, false); return false; }
    if (EPrimeV2.equals(secp.ProjectivePoint.ZERO)) { markAll(N, false); return false; }
    const ExBytesV2 = EPrimeV2.toRawBytes(true).slice(1);
    const inputOutpointsV2 = tx.vin.slice(1, 1 + aic).map(v => ({ txid: v.txid, vout: v.vout }));
    const outputCommitmentsV2 = dec.outputs.map(o => o.commitment);
    const msgV2 = computeKernelMsg(dec.assetId, inputOutpointsV2, outputCommitmentsV2, 0n);
    const kernelOkV2 = verifySchnorr(dec.kernelSig, msgV2, ExBytesV2);
    markAll(N, kernelOkV2);
    return kernelOkV2;
  }

  if (env.opcode === T_PETCH) {
    // SPEC §5.8: T_PETCH is a deployment record only. It produces NO tacit
    // UTXO at any vout — the reveal tx's outputs are regular Bitcoin outputs
    // (typically change). Reject any ancestry walk that lands on this
    // envelope. Metadata is registered out-of-band by the cron / Discover
    // path, not through this validator.
    validatedSet.set(key, false);
    return false;
  }

  if (env.opcode === T_PMINT) {
    // SPEC §5.9: permissionless mint event. Validation is a fixed checklist —
    //   1. asset_id matches sha256(etch_txid_BE || 0_LE)
    //   2. parent envelope at etch_txid is T_PETCH (NOT CETCH — modes are
    //      non-substitutable; the cross-mode reference rejection here is what
    //      keeps T_PMINT from claiming a CETCH ancestor)
    //   3. amount equals petch.mint_limit
    //   4. confirmed_height is in [effective_start, effective_end]
    //   5. pedersenCommit(amount, blinding) == declared commitment
    //   6. cap-credit: this T_PMINT must appear in the worker's credited set
    //      at depth ≥ 3 (degraded to optimistic if worker unavailable —
    //      v1 limitation, see _fetchPmintCredited)
    //   7. vout must be 0
    //
    // Failure-mode classification (audit fix #1): every false-return tags
    // pmintStatusOut with either 'pending' (transient — may promote on
    // re-scan) or 'invalid' (permanent — forged or out-of-window). Callers
    // (scanHoldings) use this tag to render pending mints distinct from
    // genuine inflation attempts.
    const tagInvalid = () => { if (pmintStatusOut) pmintStatusOut.set(key, 'invalid'); };
    const tagPending = () => { if (pmintStatusOut) pmintStatusOut.set(key, 'pending'); };
    if (vout !== 0) { tagInvalid(); validatedSet.set(key, false); return false; }
    const dec = decodeCPmintPayload(env.payload);
    if (!dec) { tagInvalid(); validatedSet.set(key, false); return false; }
    const aidFromEtch = assetIdFor(bytesToHex(dec.etchTxid), 0);
    for (let i = 0; i < 32; i++) if (aidFromEtch[i] !== dec.assetId[i]) { tagInvalid(); validatedSet.set(key, false); return false; }
    // Parent must be a T_PETCH envelope. Look up + decode without recursing
    // through validateOutpoint (T_PETCH always returns false in the recursive
    // path since no UTXO is produced). The lookup IS the recursion endpoint.
    const etchTxidHex = bytesToHex(dec.etchTxid);
    const etchTx = await fetchTx(etchTxidHex);
    if (!etchTx?.vin?.[0]?.witness || etchTx.vin[0].witness.length < 3) { tagInvalid(); validatedSet.set(key, false); return false; }
    let petchEnv;
    try { petchEnv = decodeEnvelopeScript(hexToBytes(etchTx.vin[0].witness[1])); } catch { petchEnv = null; }
    if (!petchEnv || petchEnv.opcode !== T_PETCH) { tagInvalid(); validatedSet.set(key, false); return false; }
    const petchDec = decodeCPetchPayload(petchEnv.payload);
    if (!petchDec) { tagInvalid(); validatedSet.set(key, false); return false; }
    if (dec.amount !== petchDec.mintLimit) { tagInvalid(); validatedSet.set(key, false); return false; }
    // Height window. effective_start = mint_start_height || (etch_height + 1).
    // Fetch petch's confirmed height from the etch tx. effective_end = ∞ when 0.
    const etchHeight = etchTx.status?.confirmed ? Number(etchTx.status.block_height) : null;
    const pmintHeight = tx.status?.confirmed ? Number(tx.status.block_height) : null;
    if (!Number.isFinite(etchHeight) || !Number.isFinite(pmintHeight)) {
      // One or both sides unconfirmed — heights are unknown, but the mint
      // may yet confirm validly. Pending, not invalid. The mempool case
      // (just-broadcast T_PMINT seen by getUtxos before status.confirmed
      // flips true) lands here, and the scanHoldings recovery path picks
      // it up so the user sees their fresh mint immediately.
      tagPending(); validatedSet.set(key, false); return false;
    }
    // SPEC §5.8: a non-zero mint_start_height MUST be ≥ etch_height + 1.
    // The decoder defers this (it doesn't see etch_height); enforce here so
    // a malformed T_PETCH whose deployer set mint_start_height = etch_height
    // (to bypass the same-block premine defense) doesn't admit a credit.
    // Permanent — the petch envelope can never produce a valid mint.
    if (petchDec.mintStartHeight !== 0 && petchDec.mintStartHeight < etchHeight + 1) {
      tagInvalid(); validatedSet.set(key, false); return false;
    }
    const effectiveStart = petchDec.mintStartHeight !== 0 ? petchDec.mintStartHeight : etchHeight + 1;
    // Window violations are permanent: the mint confirmed at a height that
    // can never satisfy the petch's declared window. Tagging invalid stops
    // the recovery path from showing it as pending forever.
    if (pmintHeight < effectiveStart) { tagInvalid(); validatedSet.set(key, false); return false; }
    if (petchDec.mintEndHeight !== 0 && pmintHeight > petchDec.mintEndHeight) { tagInvalid(); validatedSet.set(key, false); return false; }
    // Pedersen open: amount/blinding must reproduce the declared commitment.
    let claimed, onchain;
    try {
      claimed = pedersenCommit(dec.amount, BigInt('0x' + bytesToHex(dec.blinding)));
      onchain = bytesToPoint(dec.commitment);
    } catch { tagInvalid(); validatedSet.set(key, false); return false; }
    if (!claimed.equals(onchain)) { tagInvalid(); validatedSet.set(key, false); return false; }
    // Cap-credit check (worker-aided; degrades to optimistic when worker is
    // unreachable). This is the v1 trade documented in SPEC §10 for T_PMINT
    // reorg sensitivity — the worker provides canonically-ordered credit at
    // depth ≥ 3; trustless local cap computation is a v2 enhancement.
    //
    // The worker's slim creditedOnly response now ships BOTH credited_txids
    // AND cap_overflow_txids. Membership in the latter is permanent (the
    // mint confirmed but the cap was already full at its canonical position
    // — the minter forfeits their fees). Membership in neither is pending
    // (depth < 3 OR worker hasn't indexed this mint yet OR tip lookup
    // failed). Distinguishing these is the difference between "your mint
    // is on its way, refresh in a few minutes" and "your mint failed,
    // these tokens never existed."
    const credit = await _fetchPmintCredited(bytesToHex(dec.assetId));
    if (credit.workerAvailable) {
      if (credit.capOverflow && credit.capOverflow.has(txidHex)) {
        tagInvalid(); validatedSet.set(key, false); return false;
      }
      if (credit.credited && !credit.credited.has(txidHex)) {
        tagPending(); validatedSet.set(key, false); return false;
      }
    }
    // Worker unavailable: degrade optimistically. We can't enforce cap
    // correctness without canonical chain ordering, so accept the mint on
    // structural invariants alone. SPEC §10 documents this as a v1
    // limitation: a deployment running without the worker has weaker cap-
    // overflow guarantees than one with it.
    if (metadataOut) {
      const aidHex = bytesToHex(dec.assetId);
      if (!metadataOut.has(aidHex)) {
        metadataOut.set(aidHex, {
          ticker: petchDec.ticker, decimals: petchDec.decimals, etchTxid: etchTxidHex,
          imageUri: petchDec.imageUri || null,
          // T_PETCH-rooted assets are never `mintable` in the CETCH+T_MINT
          // sense — there is no mint_authority. Setting these to false/null
          // ensures the etch-mode check downstream (renderHoldings, etc.)
          // doesn't surface a "mint more" issuer button on these.
          mintable: false, mintAuthorityHex: null,
          // Carry the kind so consumers can render T_PETCH-rooted assets
          // with their own UI variant (cap progress, mint button, etc.).
          kind: 'petch',
          capAmount: petchDec.capAmount.toString(),
          mintLimit: petchDec.mintLimit.toString(),
        });
      }
    }
    validatedSet.set(key, true);
    return true;
  }

  validatedSet.set(key, false);
  return false;
}

// Resolve an input outpoint's parent (CETCH | MINT | CXFER | BURN) into its
// declared asset_id and the commitment at the requested vout. Used by the
// recursive validator + holdings recovery to walk arbitrary ancestry.
function getParentEnvelopeData(parentEnv, vout, parentTxid) {
  if (parentEnv.opcode === T_CETCH) {
    if (vout !== 0) return null;
    const d = decodeCEtchPayload(parentEnv.payload);
    if (!d) return null;
    return { assetIdHex: bytesToHex(assetIdFor(parentTxid, 0)), commitment: d.commitment };
  }
  if (parentEnv.opcode === T_MINT) {
    if (vout !== 0) return null;
    const d = decodeCMintPayload(parentEnv.payload);
    if (!d) return null;
    return { assetIdHex: bytesToHex(d.assetId), commitment: d.commitment };
  }
  if (parentEnv.opcode === T_CXFER) {
    const d = decodeCXferPayload(parentEnv.payload);
    if (!d || vout >= d.outputs.length) return null;
    return { assetIdHex: bytesToHex(d.assetId), commitment: d.outputs[vout].commitment };
  }
  if (parentEnv.opcode === T_AXFER) {
    // Same shape as CXFER for indexing — vouts >= N are aux BTC outputs not
    // governed by the tacit kernel sig, treated as non-tacit (null).
    const d = decodeAxferPayload(parentEnv.payload);
    if (!d || vout >= d.outputs.length) return null;
    return { assetIdHex: bytesToHex(d.assetId), commitment: d.outputs[vout].commitment };
  }
  if (parentEnv.opcode === T_BURN) {
    const d = decodeCBurnPayload(parentEnv.payload);
    if (!d || vout >= d.outputs.length) return null;
    return { assetIdHex: bytesToHex(d.assetId), commitment: d.outputs[vout].commitment };
  }
  if (parentEnv.opcode === T_PMINT) {
    // SPEC §5.9: T_PMINT produces exactly one tacit UTXO at vout 0, holding
    // the publicly-revealed (amount, blinding) commitment. Treated as a v1
    // valid ancestor for downstream CXFER/BURN consumers.
    if (vout !== 0) return null;
    const d = decodeCPmintPayload(parentEnv.payload);
    if (!d) return null;
    return { assetIdHex: bytesToHex(d.assetId), commitment: d.commitment };
  }
  // T_PETCH (0x27) intentionally falls through to null — it never produces a
  // tacit UTXO at any vout (SPEC §5.8). A wallet treating its reveal-tx
  // vout 0 as a tacit balance is a programming error; explicit reject here.
  return null;
}

// For each wallet UTXO, look at its parent tx's input[0].witness[1] for a tacit envelope.
// Decode envelope, identify which envelope output corresponds to this UTXO,
// match against local openings, verify rangeproofs.
// Cached scanHoldings result. The full chain walk (getUtxos + per-UTXO
// recursive validation + bulletproof batch-verify) is the slowest part of
// the dApp. Memoize for a short TTL so Preview-button clicks, tab-switch
// re-renders, and other balance peeks within the window don't re-pay it.
// Broadcast handlers explicitly invalidate so the next scan picks up the
// new state immediately. force=true bypasses the cache (Refresh button).
let _holdingsCache = null;
const HOLDINGS_CACHE_TTL_MS = 30 * 1000;
function invalidateHoldingsCache() { _holdingsCache = null; }
let _holdingsInFlight = null;
async function scanHoldings(force = false) {
  if (!force && _holdingsCache && (Date.now() - _holdingsCache.fetchedAt) < HOLDINGS_CACHE_TTL_MS) {
    return _holdingsCache.holdings;
  }
  if (_holdingsInFlight) return _holdingsInFlight;
  _holdingsInFlight = (async () => {
    try {
      const holdings = await _scanHoldingsImpl();
      _holdingsCache = { fetchedAt: Date.now(), holdings };
      return holdings;
    } finally {
      _holdingsInFlight = null;
    }
  })();
  return _holdingsInFlight;
}
async function _scanHoldingsImpl() {
  const utxos = await getUtxos(wallet.address());
  const holdings = new Map();
  const txCache = new Map();
  // Canonical CETCH metadata discovered during recursive validation. Lets a fresh
  // wallet learn ticker/decimals/imageUri for assets it's never seen before
  // (e.g. an incoming CXFER for a token whose CETCH ancestor isn't in localStorage).
  const metadataOut = new Map();
  const fetchTx = async id => {
    if (txCache.has(id)) return txCache.get(id);
    const t = await getTx(id);
    txCache.set(id, t);
    return t;
  };

  // Optimistic batch-verification path:
  //   1) Walk the ancestry of every wallet UTXO with a deferred rangeproof queue.
  //      Other checks (envelope decode, asset_id consistency, kernel sig) run
  //      eagerly so any non-rangeproof anomaly still short-circuits.
  //   2) Resolve all queued rangeproofs in a single multi-scalar multiplication
  //      via bpRangeAggBatchVerify. Sub-linear in number of proofs.
  //   3) If the batch fails, the wallet has at least one bad UTXO. Re-walk in
  //      strict mode (one rangeproof verify each) so we can mark exactly which
  //      ones are ghosts/inflated. Slow path, but only hit for actual problems.
  let validatedSet = new Map();
  let rpBatch = [];
  // Scan-scoped T_PMINT failure-mode map. Lives across the optimistic and
  // strict walks below so a pmint that gets tagged 'pending' in the first
  // walk (which records validatedSet[key]=false but, until this hoist, used
  // a per-call pmintStatusOut that was discarded) doesn't get re-classified
  // as 'invalid' by the second walk falling through validatedSet's cached
  // false without seeing the tag. Without this, a freshly-broadcast pmint
  // sits as h.inflated with the misleading "invalid rangeproofs" warning.
  const pmintStatusOut = new Map();
  // Chunked-parallel ancestor walk. Sequential here serialised N independent
  // /tx fetches on cold-cache scans (the slowest path). Concurrency=8 fans
  // network out without bursting hard against mempool.space rate limits.
  // Safe under concurrency: validatedSet is JS-single-threaded so first-write-
  // wins memoization is preserved, getTx already dedups in-flight requests
  // (_txInFlight), and rpBatch duplicate proofs from racing walks are harmless
  // to bpRangeAggBatchVerify (random linear combination handles dups).
  const SCAN_CONCURRENCY = 8;
  for (let i = 0; i < utxos.length; i += SCAN_CONCURRENCY) {
    const chunk = utxos.slice(i, i + SCAN_CONCURRENCY);
    await Promise.all(chunk.map(u =>
      validateOutpoint(u.txid, u.vout, validatedSet, fetchTx, 0, metadataOut, rpBatch, pmintStatusOut)
        .catch(e => { console.warn('validateOutpoint threw for', u.txid + ':' + u.vout, e); return false; })
    ));
  }
  if (rpBatch.length > 0 && !bpRangeAggBatchVerify(rpBatch)) {
    // Strict re-validation: at least one rangeproof is bad. Clear the optimistic
    // cache so the main loop below re-walks each UTXO in single-proof mode and
    // records ghost/inflated state precisely. Also clear `metadataOut` — entries
    // recorded during the optimistic walk may have come from envelopes whose
    // rangeproofs would have failed individually, so re-derive from the strict
    // walk to avoid attacker-chosen ticker/imageUri leaking into the registry.
    // pmintStatusOut also clears: a strict re-walk re-classifies T_PMINT failures
    // from scratch.
    validatedSet = new Map();
    rpBatch = null;
    metadataOut.clear();
    pmintStatusOut.clear();
  }

  for (const u of utxos) {
    const tx = await fetchTx(u.txid);
    if (!tx || !tx.vin || !tx.vin[0]) continue;
    const witness = tx.vin[0].witness;
    if (!witness || witness.length < 3) continue;
    let envelopeBytes;
    try { envelopeBytes = hexToBytes(witness[1]); } catch { continue; }
    const env = decodeEnvelopeScript(envelopeBytes);
    if (!env) continue;

    let assetIdHex = null, ticker = '???', decimals = 0, onChainCommitment = null;

    if (env.opcode === T_CETCH) {
      const dec = decodeCEtchPayload(env.payload);
      if (!dec) continue;
      // Only vout 0 is the supply commitment
      if (u.vout !== 0) continue;
      const aid = assetIdFor(u.txid, 0);
      assetIdHex = bytesToHex(aid);
      ticker = dec.ticker; decimals = dec.decimals;
      onChainCommitment = dec.commitment;
      if (!getAssetMeta(assetIdHex)) {
        registerAsset({
          assetIdHex, ticker, decimals, etchTxid: u.txid, etchVout: 0,
          imageUri: dec.imageUri || null,
          mintable: dec.mintable, mintAuthorityHex: bytesToHex(dec.mintAuthority),
        });
      }
    } else if (env.opcode === T_MINT) {
      const dec = decodeCMintPayload(env.payload);
      if (!dec) continue;
      if (u.vout !== 0) continue;
      assetIdHex = bytesToHex(dec.assetId);
      const meta = getAssetMeta(assetIdHex);
      if (meta) { ticker = meta.ticker; decimals = meta.decimals; }
      onChainCommitment = dec.commitment;
    } else if (env.opcode === T_PMINT) {
      // SPEC §5.9: T_PMINT-rooted UTXOs sit at vout 0. Like T_MINT, the
      // commitment lives in the envelope and the asset is identified by
      // dec.assetId. Unlike T_MINT, (amount, blinding) are public — the
      // recovery path below reads them directly from the envelope without
      // any HMAC/keystream/ECDH derivation.
      const dec = decodeCPmintPayload(env.payload);
      if (!dec) continue;
      if (u.vout !== 0) continue;
      assetIdHex = bytesToHex(dec.assetId);
      const meta = getAssetMeta(assetIdHex);
      if (meta) { ticker = meta.ticker; decimals = meta.decimals; }
      onChainCommitment = dec.commitment;
    } else if (env.opcode === T_CXFER || env.opcode === T_AXFER || env.opcode === T_BURN) {
      const dec = env.opcode === T_CXFER       ? decodeCXferPayload(env.payload)
                : env.opcode === T_AXFER    ? decodeAxferPayload(env.payload)
                                                : decodeCBurnPayload(env.payload);
      if (!dec) continue;
      assetIdHex = bytesToHex(dec.assetId);
      const meta = getAssetMeta(assetIdHex);
      if (meta) { ticker = meta.ticker; decimals = meta.decimals; }
      if (u.vout >= dec.outputs.length) continue;
      onChainCommitment = dec.outputs[u.vout].commitment;
    } else continue;

    if (!holdings.has(assetIdHex)) {
      holdings.set(assetIdHex, {
        assetIdHex, ticker, decimals,
        balance: 0n, utxos: [], ghosts: [], inflated: [], pending: [],
        unknownAsset: !getAssetMeta(assetIdHex),
      });
    }
    const h = holdings.get(assetIdHex);

    // Recursive validation: this UTXO and ALL its ancestors must be valid.
    // A bad CXFER anywhere in the ancestry invalidates everything downstream.
    // Pass metadataOut so the validator records canonical CETCH metadata for any
    // ancestor it walks; we use that below to register tickers/decimals/imageUri
    // for assets that aren't yet in our local registry. The scan-scoped
    // pmintStatusOut Map (declared above) captures whether T_PMINT failures
    // are pending (transient) or invalid (permanent) so we route the UTXO
    // to the right h.* bucket below. It MUST be the same Map the optimistic
    // walk used — see audit fix #1, plus the comment at its declaration for
    // why a per-UTXO Map here mis-classified pending pmints as inflated.
    const valid = await validateOutpoint(u.txid, u.vout, validatedSet, fetchTx, 0, metadataOut, null, pmintStatusOut);

    // Register any newly-discovered canonical metadata. Honors first-seen wins;
    // the registry is keyed by asset_id which is itself derived from the CETCH
    // reveal txid, so there's no risk of metadata mismatch.
    for (const [aid, meta] of metadataOut.entries()) {
      if (!getAssetMeta(aid)) {
        registerAsset({
          assetIdHex: aid,
          ticker: meta.ticker,
          decimals: meta.decimals,
          etchTxid: meta.etchTxid,
          etchVout: 0,
          imageUri: meta.imageUri || null,
          mintable: !!meta.mintable,
          mintAuthorityHex: meta.mintAuthorityHex || null,
        });
      }
    }
    // If this holdings entry was created as 'unknown', re-resolve now that
    // recursive validation may have populated the registry.
    if (h.unknownAsset) {
      const m = getAssetMeta(assetIdHex);
      if (m) {
        h.ticker = m.ticker;
        h.decimals = m.decimals;
        h.unknownAsset = false;
      }
    }

    if (!valid) {
      // Pending T_PMINT branch (audit fix #1): if the failure was a transient
      // condition (mempool / depth < 3 / worker hasn't credited yet),
      // recover the opening directly from the envelope's public (amount,
      // blinding) and surface it as h.pending — distinct from h.inflated,
      // which is reserved for genuinely-broken UTXOs. The "Inflation
      // attempt detected" copy in the holdings card only fires for
      // h.inflated; pending mints get their own informative label.
      const pmintKey = `${u.txid}:${u.vout}`;
      if (env.opcode === T_PMINT && pmintStatusOut.get(pmintKey) === 'pending') {
        const dec = decodeCPmintPayload(env.payload);
        if (dec) {
          const candidate = dec.amount;
          const r = BigInt('0x' + bytesToHex(dec.blinding));
          try {
            if (pedersenCommit(candidate, r).equals(bytesToPoint(onChainCommitment))) {
              recordOpening(u.txid, u.vout, assetIdHex, candidate, r);
              h.pending.push({ utxo: u, amount: candidate, blinding: r, commitment: onChainCommitment });
              continue;
            }
          } catch {}
        }
      }
      h.inflated.push({ utxo: u, commitment: onChainCommitment });
      continue;
    }

    const opening = getOpening(u.txid, u.vout);
    if (opening && opening.assetIdHex === assetIdHex) {
      const verifyC = pedersenCommit(opening.amount, opening.blinding);
      try {
        const onChainPoint = bytesToPoint(onChainCommitment);
        if (verifyC.equals(onChainPoint)) {
          h.balance += opening.amount;
          h.utxos.push({ utxo: u, amount: opening.amount, blinding: opening.blinding, commitment: onChainCommitment });
          continue;
        }
      } catch {}
    }

    // Auto-discovery: try to recover (amount, blinding) from chain alone using the
    // encrypted-amount field on the envelope. This is what makes share-link import
    // optional and lets a freshly-installed wallet recover its full state from chain
    // + privkey alone, with no localStorage dependency.
    if (env.opcode === T_CETCH) {
      const dec = decodeCEtchPayload(env.payload);
      // Re-derive the etcher's anchor: first input outpoint of the commit tx
      // (= reveal_tx.vin[0].txid → commit tx → commit_tx.vin[0]).
      if (dec) {
        const commitTxid = tx.vin[0].txid;
        const commitTx = await fetchTx(commitTxid);
        if (commitTx && commitTx.vin && commitTx.vin[0]) {
          const ci = commitTx.vin[0];
          const anchorBytes = concatBytes(
            reverseBytes(hexToBytes(ci.txid)),
            (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, ci.vout >>> 0, true); return b; })(),
          );
          const r = deriveEtchBlinding(wallet.priv, anchorBytes);
          const ks = deriveEtchAmountKeystream(wallet.priv, anchorBytes);
          const candidate = decryptAmount(dec.encryptedAmount, ks);
          if (candidate >= 0n && candidate < (1n << BigInt(N_BITS))) {
            try {
              if (pedersenCommit(candidate, r).equals(bytesToPoint(onChainCommitment))) {
                recordOpening(u.txid, u.vout, assetIdHex, candidate, r);
                h.balance += candidate;
                h.utxos.push({ utxo: u, amount: candidate, blinding: r, commitment: onChainCommitment });
                // Mark as etcher and stash the opening so the holdings UI can offer
                // "Reveal supply" — the etcher publishing (supply, r) so anyone can
                // verify C == supply·H + r·G. Survives later transfers (this doesn't
                // depend on still holding the original CETCH UTXO).
                h.isEtcher = true;
                h.etchOpening = { supply: candidate, blinding: r };
                continue;
              }
            } catch {}
          }
        }
      }
    }

    if (env.opcode === T_MINT) {
      // Recovery path for the issuer of a mint: same anchor pattern as etch
      // (commit tx's first input outpoint), different domain string.
      const dec = decodeCMintPayload(env.payload);
      if (dec) {
        const commitTxid = tx.vin[0].txid;
        const commitTx = await fetchTx(commitTxid);
        if (commitTx?.vin?.[0]) {
          const ci = commitTx.vin[0];
          const anchorBytes = concatBytes(
            reverseBytes(hexToBytes(ci.txid)),
            (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, ci.vout >>> 0, true); return b; })(),
          );
          const r = deriveMintBlinding(wallet.priv, anchorBytes);
          const ks = deriveMintAmountKeystream(wallet.priv, anchorBytes);
          const candidate = decryptAmount(dec.encryptedAmount, ks);
          if (candidate >= 0n && candidate < (1n << BigInt(N_BITS))) {
            try {
              if (pedersenCommit(candidate, r).equals(bytesToPoint(onChainCommitment))) {
                recordOpening(u.txid, u.vout, assetIdHex, candidate, r);
                h.balance += candidate;
                h.utxos.push({ utxo: u, amount: candidate, blinding: r, commitment: onChainCommitment });
                // Track our own mint events so the UI can offer per-mint reveal.
                // (We only ever recover a T_MINT opening if WE'RE the issuer.)
                h.myMints = h.myMints || [];
                h.myMints.push({ mintTxid: u.txid, amount: candidate, blinding: r });
                continue;
              }
            } catch {}
          }
        }
      }
    }

    if (env.opcode === T_PMINT) {
      // SPEC §5.9 *Recovery semantics*: T_PMINT envelopes carry (amount,
      // blinding) in cleartext, so recovery is a direct read — no HMAC/ECDH
      // derivation, no keystream decrypt. Authenticity falls out of the
      // pedersenCommit equality check below (the envelope's commitment field
      // and the on-chain commitment we already extracted are the same field).
      const dec = decodeCPmintPayload(env.payload);
      if (dec) {
        const candidate = dec.amount;
        const r = BigInt('0x' + bytesToHex(dec.blinding));
        try {
          if (pedersenCommit(candidate, r).equals(bytesToPoint(onChainCommitment))) {
            recordOpening(u.txid, u.vout, assetIdHex, candidate, r);
            h.balance += candidate;
            h.utxos.push({ utxo: u, amount: candidate, blinding: r, commitment: onChainCommitment });
            // Track our own pmints so the UI can surface "you minted X tokens
            // of FAIR" history without re-fetching from the worker.
            h.myPmints = h.myPmints || [];
            h.myPmints.push({ mintTxid: u.txid, amount: candidate });
            continue;
          }
        } catch {}
      }
    }

    if (env.opcode === T_CXFER || env.opcode === T_AXFER || env.opcode === T_BURN) {
      const dec = env.opcode === T_CXFER       ? decodeCXferPayload(env.payload)
                : env.opcode === T_AXFER    ? decodeAxferPayload(env.payload)
                                                : decodeCBurnPayload(env.payload);
      if (dec && tx.vin.length >= 2) {
        // Recovery anchor: for v1 CXFER/BURN, vin[1] is the first asset input
        // by definition. For v2, vin[1] is also the first asset input (asset
        // inputs come immediately after vin[0]; aux BTC inputs are appended
        // at the tail), so the same anchor extraction is correct.
        const firstIn = tx.vin[1];
        const anchorBytes = concatBytes(
          reverseBytes(hexToBytes(firstIn.txid)),
          (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, firstIn.vout >>> 0, true); return b; })(),
        );
        // Try as recipient first: ECDH against sender's pub from vin[1].witness[1]
        const senderPubHex = (firstIn.witness && firstIn.witness.length === 2 && firstIn.witness[1].length === 66)
          ? firstIn.witness[1] : null;
        const ct = dec.outputs[u.vout].encryptedAmount;
        let recovered = null;
        if (senderPubHex) {
          const senderPub = hexToBytes(senderPubHex);
          const ks = deriveAmountKeystreamECDH(wallet.priv, senderPub, anchorBytes, u.vout);
          const candidate = decryptAmount(ct, ks);
          if (candidate >= 0n && candidate < (1n << 64n)) {
            const r = deriveBlinding(wallet.priv, senderPub, anchorBytes, u.vout);
            try {
              if (pedersenCommit(candidate, r).equals(bytesToPoint(onChainCommitment))) {
                recovered = { amount: candidate, blinding: r };
              }
            } catch {}
          }
        }
        // Try as sender's own change: self-derived keystream + change blinding
        if (!recovered) {
          const ks = deriveAmountKeystreamSelf(wallet.priv, anchorBytes, u.vout);
          const candidate = decryptAmount(ct, ks);
          if (candidate >= 0n && candidate < (1n << 64n)) {
            const r = deriveChangeBlinding(wallet.priv, anchorBytes, u.vout);
            try {
              if (pedersenCommit(candidate, r).equals(bytesToPoint(onChainCommitment))) {
                recovered = { amount: candidate, blinding: r };
              }
            } catch {}
          }
        }
        if (recovered) {
          // Persist for future scans (cheap)
          recordOpening(u.txid, u.vout, assetIdHex, recovered.amount, recovered.blinding);
          h.balance += recovered.amount;
          h.utxos.push({ utxo: u, amount: recovered.amount, blinding: recovered.blinding, commitment: onChainCommitment });
          continue;
        }
      }
    }

    h.ghosts.push({ utxo: u, commitment: onChainCommitment });
  }
  return holdings;
}

// ============== FEE EST ==============
const inputVbytes = 68;
const p2wpkhOutVbytes = 31;
const p2trOutVbytes = 43;
function estCommitVb(numInputs) { return 11 + numInputs * inputVbytes + p2trOutVbytes + p2wpkhOutVbytes; }
const feeFor = (vb, rate) => Math.max(500, Math.ceil(vb * rate));

// Exact reveal-vbytes calculators. Both build and preview sites call these so
// the user sees the same fee they end up paying. Earlier hardcoded constants
// (etch=600, cxfer=120+380+…) had >50% margin from the bit-decomposition era;
// the protocol's bulletproof sizes are now fixed at 688/754/820/886 bytes for
// m∈{1,2,4,8} and the envelope/witness shapes are fully deterministic.
//
// CETCH payload = T_CETCH(1) + tlen(1) + ticker(L) + decimals(1) + commitment(33)
//   + amount_ct(8) + rp_len(2) + rangeproof(688) + mint_authority(32) + img_len(2)
//   + image_uri(I) = 768 + L + I bytes.
// Envelope script = 33 (sigpubkey push) + 1 (CHECKSIG) + 2 (FALSE IF) + 6 (TACIT
//   push) + 2 (version push) + payload (split into ≤520-byte chunks, each with a
//   3-byte PUSHDATA2 prefix) + 1 (ENDIF).
// Witness for taproot script-path input: count(1) + sig(1+64) + envelope(3+E) +
//   ctrl(1+33). Plus marker+flag (2) at tx level.
// 1 P2TR input + 1 P2WPKH output (DUST commitment) → 82-byte tx base.
function estCEtchRevealVb({ tickerLen = 8, imageUriLen = 0 } = {}) {
  const payloadLen = 768 + tickerLen + imageUriLen;
  const numChunks = Math.max(1, Math.ceil(payloadLen / MAX_SCRIPT_PUSH));
  const envelopeLen = 45 + payloadLen + numChunks * 3;
  const witnessLen = 1 + 65 + 3 + envelopeLen + 34;
  const baseLen = 82; // 1 P2TR in, 1 P2WPKH out
  // Weight = base*4 + (marker+flag) + witness; vb = ceil(weight/4). +5 vb safety
  // for ECDSA-sig length variance and any minor framing difference.
  return Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5;
}

// CXFER payload = T_CXFER(1) + asset_id(32) + kernel_sig(64) + N(1)
//   + m*(commitment(33) + amount_ct(8)) + rp_len(2) + rangeproof.
// Bulletproof byte counts at n=64: m=1→688, m=2→754, m=4→820, m=8→886.
// Reveal tx: 1 P2TR script-path input + numAssetIn P2WPKH inputs;
// outputs: m P2WPKH commitments (DUST) + optional 1 P2WPKH sats-change.
function estCXferRevealVb({ m, numAssetIn = 1, hasSatsChange = false } = {}) {
  const bpLen = m === 1 ? 688 : m === 2 ? 754 : m === 4 ? 820 : 886;
  const payloadLen = 1 + 32 + 64 + 1 + m * 41 + 2 + bpLen;
  const numChunks = Math.max(1, Math.ceil(payloadLen / MAX_SCRIPT_PUSH));
  const envelopeLen = 45 + payloadLen + numChunks * 3;
  const p2trWitnessLen = 1 + 65 + 3 + envelopeLen + 34;
  const p2wpkhWitnessLen = 108; // 1 + (1+72 sig) + (1+33 pub)
  const witnessLen = p2trWitnessLen + numAssetIn * p2wpkhWitnessLen;
  const numOuts = m + (hasSatsChange ? 1 : 0);
  const baseLen = 4 + 1 + 41 * (1 + numAssetIn) + 1 + 31 * numOuts + 4;
  return Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5 + 2 * numAssetIn;
}

// MINT payload = T_MINT(1) + asset_id(32) + etch_txid(32) + commitment(33)
//   + amount_ct(8) + rp_len(2) + rangeproof(688) + issuer_sig(64) = 860 bytes.
// Reveal: 1 P2TR in, 1 P2WPKH out.
function estCMintRevealVb() {
  const payloadLen = 860;
  const numChunks = Math.max(1, Math.ceil(payloadLen / MAX_SCRIPT_PUSH));
  const envelopeLen = 45 + payloadLen + numChunks * 3;
  const witnessLen = 1 + 65 + 3 + envelopeLen + 34;
  const baseLen = 82;
  return Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5;
}

// AXFER payload = T_CXFER payload + 1 byte (asset_input_count). Used for
// atomic OTC settlement: the maker drafts the reveal, the taker fills aux
// (non-tacit) BTC inputs to fund their side. The maker doesn't know the
// taker's exact aux input count when building the offer, so default to 2 for
// conservative sizing — over-estimation only over-funds the commit output.
function estCAxferRevealVb({ m, numAssetIn = 1, numAuxIn = 2, numAuxOuts = 2 } = {}) {
  const bpLen = m === 1 ? 688 : m === 2 ? 754 : m === 4 ? 820 : 886;
  const payloadLen = 1 + 32 + 1 + 64 + 1 + m * 41 + 2 + bpLen;
  const numChunks = Math.max(1, Math.ceil(payloadLen / MAX_SCRIPT_PUSH));
  const envelopeLen = 45 + payloadLen + numChunks * 3;
  const p2trWitnessLen = 1 + 65 + 3 + envelopeLen + 34;
  const witnessLen = p2trWitnessLen + (numAssetIn + numAuxIn) * 108;
  const numOuts = m + numAuxOuts;
  const baseLen = 4 + 1 + 41 * (1 + numAssetIn + numAuxIn) + 1 + 31 * numOuts + 4;
  return Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5 + 2 * (numAssetIn + numAuxIn);
}

// BURN payload = T_BURN(1) + asset_id(32) + burned_amount(8) + kernel_sig(64)
//   + N(1) + N*(33+8) + (rp_len(2) + rangeproof if N>0). N=0 → no rp, no outs.
function estCBurnRevealVb({ numChangeOuts = 0, numAssetIn = 1 } = {}) {
  const m = numChangeOuts;
  let payloadLen = 1 + 32 + 8 + 64 + 1 + m * 41;
  if (m > 0) {
    const bpLen = m === 1 ? 688 : m === 2 ? 754 : m === 4 ? 820 : 886;
    payloadLen += 2 + bpLen;
  }
  const numChunks = Math.max(1, Math.ceil(payloadLen / MAX_SCRIPT_PUSH));
  const envelopeLen = 45 + payloadLen + numChunks * 3;
  const p2trWitnessLen = 1 + 65 + 3 + envelopeLen + 34;
  const p2wpkhWitnessLen = 108;
  const witnessLen = p2trWitnessLen + numAssetIn * p2wpkhWitnessLen;
  const numOuts = m; // burns have no sats-change output
  const baseLen = 4 + 1 + 41 * (1 + numAssetIn) + 1 + 31 * numOuts + 4;
  return Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5 + 2 * numAssetIn;
}

// ============== TX SERIALIZATION HELPERS ==============
// Build a tx that includes witnesses for ALL inputs (P2WPKH or P2TR script-path).
// tx: { version, locktime, inputs:[{txid, vout, sequence, witness}], outputs:[{value, script}] }
// serializeTx (defined above) handles witness arrays correctly.

// Build a P2WPKH BIP-143 sighash and signed witness for input idx of tx
function signP2wpkhInput(tx, idx, prevValue) {
  const scriptCode = concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hash160(wallet.pub), new Uint8Array([0x88, 0xac]));
  const sh = sighashV0(tx, idx, scriptCode, prevValue);
  const sig = sign(sh, wallet.priv); // ECDSA DER + SIGHASH_ALL
  return [sig, wallet.pub];
}

// Build a Taproot script-path BIP-341 sighash and signed witness for input 0 of tx
function signTaprootScriptPathInput(tx, prevouts, envelopeScript, controlBlockBytes) {
  const leaf = tapLeafHash(envelopeScript);
  const sh = tapSighash(tx, 0, prevouts, leaf, 0x00);
  const sig = signSchnorr(sh, wallet.priv);
  return [sig, envelopeScript, controlBlockBytes];
}

// SIGHASH-flexible variants. Used by the atomic-listing flow (SPEC §5.7) where
// the maker signs with SIGHASH_SINGLE | ANYONECANPAY (0x83) so the taker can
// append BTC inputs and outputs without invalidating the maker's sigs.
function signP2wpkhInputWithSighash(tx, idx, prevValue, hashType) {
  const scriptCode = concatBytes(new Uint8Array([0x76, 0xa9, 0x14]), hash160(wallet.pub), new Uint8Array([0x88, 0xac]));
  const sh = sighashV0WithType(tx, idx, scriptCode, prevValue, hashType);
  // BIP-66 DER + 1-byte sighash flag.
  const sigBare = sign(sh, wallet.priv);
  // The existing `sign()` helper appends 0x01 (SIGHASH_ALL). Strip and replace.
  const der = sigBare.slice(0, sigBare.length - 1);
  const sigWithType = concatBytes(der, new Uint8Array([hashType & 0xff]));
  return [sigWithType, wallet.pub];
}

function signTaprootScriptPathInputWithSighash(tx, prevouts, envelopeScript, controlBlockBytes, hashType) {
  const leaf = tapLeafHash(envelopeScript);
  const sh = tapSighash(tx, 0, prevouts, leaf, hashType);
  const sigBare = signSchnorr(sh, wallet.priv);
  // BIP-341: when hashType != 0x00 (DEFAULT), the schnorr sig is suffixed with
  // a 1-byte sighash flag. DEFAULT means "treat ALL as bare 64-byte sig."
  const sig = (hashType === 0x00) ? sigBare : concatBytes(sigBare, new Uint8Array([hashType & 0xff]));
  return [sig, envelopeScript, controlBlockBytes];
}

// ============== CETCH (commit-reveal) ==============
// Takes supplyBase (already in base units, already validated to be < 2^N_BITS).
// `metadataBuilder({ supply, blinding, commitment })` is an optional async hook
// invoked AFTER the opening is derived (so `tacit_attest` can be embedded in
// IPFS metadata) but BEFORE the envelope is built (so the metadata CID can be
// the envelope's image_uri). Return value: the final image_uri to embed in
// the on-chain envelope, or null/undefined to keep `imageUri` unchanged.
async function buildAndBroadcastCEtch({ ticker, supplyBase, decimals, imageUri = null, mintable = false, metadataBuilder = null, onProgress = null }) {
  // onProgress(stage) is invoked at the major checkpoints inside this
  // function so the caller can drive a UI strip without re-implementing
  // the orchestration. Stages: 'commit-broadcast', 'reveal-broadcast'.
  // metadataBuilder fires its own pin-time UI; rangeproof prove and the
  // post-broadcast index step are owned by the caller's bookends. Errors
  // thrown anywhere here propagate normally — caller updates the strip.
  const _progress = (stage) => { try { onProgress && onProgress(stage); } catch {} };
  const supplyBig = BigInt(supplyBase);
  if (supplyBig <= 0n || supplyBig >= (1n << BigInt(N_BITS))) {
    throw new Error(`supplyBase ${supplyBig} out of range [1, 2^${N_BITS})`);
  }

  // Estimate fees (independent of blinding) so we can pick commit inputs before
  // deriving the supply blinding from the first input's outpoint. We don't yet
  // know the final image_uri (a metadataBuilder hook may replace it with an
  // ipfs://<CID> at broadcast time, which is ~58 bytes); estimate at the
  // user's input length capped to that floor so we never under-fund.
  const feeRate = await getFeeRate();
  const tkLen = new TextEncoder().encode(ticker).length;
  const rawImgLen = imageUri ? new TextEncoder().encode(imageUri).length : 0;
  const expectedImgLen = metadataBuilder ? Math.max(rawImgLen, 70) : rawImgLen;
  const revealVb = estCEtchRevealVb({ tickerLen: tkLen, imageUriLen: expectedImgLen });
  const revealFee = feeFor(revealVb, feeRate);
  const commitValue = DUST + revealFee;

  // Pick commit inputs first; their order determines the anchor.
  const allUtxos = await getUtxos(wallet.address());
  const sats = allUtxos.filter(u => u.value > DUST).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0;
  let commitFee = 500;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = feeFor(estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + DUST) break;
  }
  if (total < commitValue + commitFee) throw new Error(`insufficient sats (need ~${commitValue + commitFee}, have ${total}). Use the faucet.`);

  // Anchor the supply blinding to the first commit input's outpoint. This breaks the
  // envelope/commitment cycle (anchor predates the tx being built) and lets a chain-only
  // scanner re-derive the same blinding via reveal_tx.vin[0] → commit_tx → commit_tx.vin[0].
  const firstIn = picked[0];
  const anchorBytes = concatBytes(
    reverseBytes(hexToBytes(firstIn.txid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, firstIn.vout >>> 0, true); return b; })(),
  );
  const blinding = deriveEtchBlinding(wallet.priv, anchorBytes);
  const amountKs = deriveEtchAmountKeystream(wallet.priv, anchorBytes);
  const encryptedAmount = encryptAmount(supplyBig, amountKs);

  // Aggregated bulletproof for the (single) supply commitment.
  const { proof, commitments } = bpRangeAggProve([supplyBig], [blinding]);
  const commitment = pointToBytes(commitments[0]);
  const mintAuthority = mintable ? wallet.xonly() : MINT_AUTH_NONE;
  // Give the caller a chance to construct + pin metadata that contains the
  // (supply, blinding) opening before the envelope's image_uri is finalized.
  // This is what makes the IPFS-attestation path possible: the metadata blob
  // is content-addressed and embeds tacit_attest in the same CID the envelope
  // points at, so verifiers reach attestation through chain → IPFS, with no
  // worker required.
  let finalImageUri = imageUri;
  // null = no builder supplied; true = pin succeeded and image_uri was replaced;
  // false = builder ran but failed (no tacit_attest landed on IPFS).
  let metadataPinned = null;
  if (typeof metadataBuilder === 'function') {
    metadataPinned = false;
    try {
      const built = await metadataBuilder({ supply: supplyBig, blinding, commitment });
      if (typeof built === 'string' && built.length > 0) {
        finalImageUri = built;
        metadataPinned = true;
      }
    } catch (e) {
      // Metadata pinning failure is non-fatal for the etch itself — the asset
      // still validates without a metadata blob. Surface the error so the
      // caller can decide whether to fall back (worker /attest, manual pin).
      console.warn('metadataBuilder failed; etching with original imageUri', e);
    }
  }
  const payload = encodeCEtchPayload({ ticker, decimals, commitment, rangeproof: proof, encryptedAmount, mintAuthority, imageUri: finalImageUri });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);

  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const change = total - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (change >= DUST) commitOutputs.push({ value: change, script: p2wpkhScript(wallet.pub) });

  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxid = txid(commitTx);

  _progress('commit-start');
  await broadcast(commitHex);

  // Build reveal tx (spend the commit P2TR via script-path)
  // input 0: commit tx output 0 (the P2TR)
  // output 0: P2WPKH to etcher (DUST = supply commitment carrier)
  const revealTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: DUST, script: p2wpkhScript(wallet.pub) }],
  };
  const prevouts = [{ value: commitValue, script: p2trSpk }];
  revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxid = txid(revealTx);

  // Brief delay so the commit propagates into mempool.space's view before we
  // broadcast the reveal that spends it. Without this, the reveal can be
  // rejected with "missing inputs" because the API hasn't indexed the commit yet.
  _progress('reveal-start');
  await broadcastWithRetry(revealHex);

  // Save opening locally
  const aid = assetIdFor(revealTxid, 0);
  recordOpening(revealTxid, 0, bytesToHex(aid), supplyBig, blinding);
  // Persist the URI that actually landed in the on-chain envelope (not the
  // raw user input) so the etcher's local registry matches what every other
  // wallet derives from chain. Otherwise the etcher's Holdings card misses
  // the pinned metadata's name / description / external_url.
  registerAsset({
    assetIdHex: bytesToHex(aid), ticker, decimals,
    etchTxid: revealTxid, etchVout: 0, imageUri: finalImageUri,
    mintable, mintAuthorityHex: mintable ? bytesToHex(wallet.xonly()) : null,
  });
  recordActivity({
    kind: 'etch', ticker, amount: supplyBig, decimals,
    assetId: bytesToHex(aid), txid: revealTxid,
  });

  return {
    commitTxid, revealTxid,
    commitHex, revealHex,
    assetIdHex: bytesToHex(aid),
    imageUri: finalImageUri,
    metadataPinned,
    commitVb: 11 + picked.length * inputVbytes + commitOutputs.length * p2wpkhOutVbytes,
    revealVb,
    commitFee, revealFee,
  };
}

// ============== T_PETCH (commit-reveal) ==============
// SPEC §5.8 — permissionless-mint deployment record. Wire layout:
//   T_PETCH(1) + tlen(1) + ticker(L) + decimals(1) + cap_amount(8) +
//   mint_limit(8) + mint_start_height(4) + mint_end_height(4) + img_len(2) +
//   image_uri(I) = 29 + L + I bytes.
// No commitment, no rangeproof, no signature. The reveal tx's vout 0 is
// regular Bitcoin change (P2WPKH back to deployer); T_PETCH never produces
// a tacit UTXO. asset_id derives from reveal_txid same as CETCH so all
// downstream tooling identifies the asset identically.
function estPetchRevealVb({ tickerLen = 8, imageUriLen = 0 } = {}) {
  const payloadLen = 29 + tickerLen + imageUriLen;
  const numChunks = Math.max(1, Math.ceil(payloadLen / MAX_SCRIPT_PUSH));
  const envelopeLen = 45 + payloadLen + numChunks * 3;
  const witnessLen = 1 + 65 + 3 + envelopeLen + 34;
  const baseLen = 82;
  return Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5;
}

async function buildAndBroadcastPetch({ ticker, decimals, capAmount, mintLimit, mintStartHeight = 0, mintEndHeight = 0, imageUri = null, metadataBuilder = null, onProgress = null }) {
  // onProgress(stage) parity with buildAndBroadcastCEtch: 'commit-start'
  // and 'reveal-start' fire right before each broadcast so the caller's
  // progress strip's active step matches what's in flight.
  const _progress = (stage) => { try { onProgress && onProgress(stage); } catch {} };
  const cap = BigInt(capAmount);
  const lim = BigInt(mintLimit);
  if (cap <= 0n || cap >= (1n << BigInt(N_BITS))) throw new Error(`cap_amount out of range`);
  if (lim <= 0n || lim > cap) throw new Error(`mint_limit out of range`);
  if (cap % lim !== 0n) throw new Error('cap_amount must be evenly divisible by mint_limit');

  const feeRate = await getFeeRate();
  const tkLen = new TextEncoder().encode(ticker).length;
  const rawImgLen = imageUri ? new TextEncoder().encode(imageUri).length : 0;
  const expectedImgLen = metadataBuilder ? Math.max(rawImgLen, 70) : rawImgLen;
  const revealVb = estPetchRevealVb({ tickerLen: tkLen, imageUriLen: expectedImgLen });
  const revealFee = feeFor(revealVb, feeRate);
  const commitValue = DUST + revealFee;

  const allUtxos = await getUtxos(wallet.address());
  const sats = allUtxos.filter(u => u.value > DUST).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0;
  let commitFee = 500;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = feeFor(estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + DUST) break;
  }
  if (total < commitValue + commitFee) throw new Error(`insufficient sats (need ~${commitValue + commitFee}, have ${total}). Use the faucet.`);

  // Optional metadata builder — same hook shape as CEtch so the dapp can pin
  // a richer JSON blob to IPFS and replace the on-chain image_uri with the
  // resulting CID. T_PETCH metadata typically carries name/description/icon
  // (no tacit_attest, since there's no supply opening to attest at deploy).
  let finalImageUri = imageUri;
  let metadataPinned = null;
  if (typeof metadataBuilder === 'function') {
    metadataPinned = false;
    try {
      const built = await metadataBuilder({});
      if (typeof built === 'string' && built.length > 0) {
        finalImageUri = built;
        metadataPinned = true;
      }
    } catch (e) {
      console.warn('metadataBuilder failed; etching with original imageUri', e);
    }
  }

  const payload = encodeCPetchPayload({
    ticker, decimals, capAmount: cap, mintLimit: lim,
    mintStartHeight, mintEndHeight, imageUri: finalImageUri,
  });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const change = total - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (change >= DUST) commitOutputs.push({ value: change, script: p2wpkhScript(wallet.pub) });

  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxid = txid(commitTx);
  _progress('commit-start');
  await broadcast(commitHex);

  // Reveal tx: vout 0 is regular sat change (DUST P2WPKH to deployer). It is
  // NOT a tacit UTXO — T_PETCH creates none. The deployer eats the DUST as
  // recoverable sats and otherwise gets nothing for free.
  const revealTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: DUST, script: p2wpkhScript(wallet.pub) }],
  };
  const prevouts = [{ value: commitValue, script: p2trSpk }];
  revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxid = txid(revealTx);
  _progress('reveal-start');
  await broadcastWithRetry(revealHex);

  const aid = assetIdFor(revealTxid, 0);
  registerAsset({
    assetIdHex: bytesToHex(aid), ticker, decimals,
    etchTxid: revealTxid, etchVout: 0, imageUri: finalImageUri,
    mintable: false, mintAuthorityHex: null,
    kind: 'petch',
    capAmount: cap.toString(), mintLimit: lim.toString(),
    mintStartHeight, mintEndHeight,
  });
  recordActivity({
    kind: 'petch', ticker, amount: cap, decimals,
    assetId: bytesToHex(aid), txid: revealTxid,
  });
  // Mainnet's worker scanner is forward-only (backfillBlocks=0); without a
  // hint, a T_PETCH can be silently skipped if its block was scanned before
  // the petch-aware code went live. The hint endpoint's T_PETCH branch writes
  // the registry entry directly, so /petch-assets surfaces it within seconds.
  postHint(revealTxid, 0);

  return {
    commitTxid, revealTxid, commitHex, revealHex,
    assetIdHex: bytesToHex(aid),
    imageUri: finalImageUri,
    metadataPinned,
    commitVb: 11 + picked.length * inputVbytes + commitOutputs.length * p2wpkhOutVbytes,
    revealVb,
    commitFee, revealFee,
  };
}

// ============== T_PMINT (commit-reveal) ==============
// SPEC §5.9 — permissionless mint event. Wire payload is fixed at 138 bytes
// (asset_id + etch_txid + commitment + amount + blinding). No signature; no
// rangeproof; (amount, blinding) are public so any chain reader can audit
// the commitment. Reveal tx vout 0 holds the new supply UTXO at DUST sats.
function estPmintRevealVb() {
  const payloadLen = 138;
  const numChunks = Math.max(1, Math.ceil(payloadLen / MAX_SCRIPT_PUSH));
  const envelopeLen = 45 + payloadLen + numChunks * 3;
  const witnessLen = 1 + 65 + 3 + envelopeLen + 34;
  const baseLen = 82;
  return Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5;
}

async function buildAndBroadcastPmint({ etchTxidHex, onProgress = null }) {
  // onProgress(stage) parity with buildAndBroadcastCEtch: 'commit-start'
  // and 'reveal-start' fire right before each broadcast.
  const _progress = (stage) => { try { onProgress && onProgress(stage); } catch {} };
  if (!/^[0-9a-f]{64}$/.test(etchTxidHex)) throw new Error('invalid etch_txid');
  const etchTx = await getTx(etchTxidHex);
  if (!etchTx?.vin?.[0]?.witness || etchTx.vin[0].witness.length < 3) throw new Error('etch tx has no envelope');
  let petchEnv;
  try { petchEnv = decodeEnvelopeScript(hexToBytes(etchTx.vin[0].witness[1])); } catch { petchEnv = null; }
  if (!petchEnv || petchEnv.opcode !== T_PETCH) throw new Error('etch_txid is not a T_PETCH envelope');
  const petchDec = decodeCPetchPayload(petchEnv.payload);
  if (!petchDec) throw new Error('T_PETCH payload failed to decode');
  const aid = assetIdFor(etchTxidHex, 0);
  const aidHex = bytesToHex(aid);

  const blindingBig = randomScalar();
  const blinding = bigintToBytes32(blindingBig);
  const amount = petchDec.mintLimit;
  const commitmentPt = pedersenCommit(amount, blindingBig);
  const commitment = pointToBytes(commitmentPt);

  const feeRate = await getFeeRate();
  const revealVb = estPmintRevealVb();
  const revealFee = feeFor(revealVb, feeRate);
  const commitValue = DUST + revealFee;

  const allUtxos = await getUtxos(wallet.address());
  const sats = allUtxos.filter(u => u.value > DUST).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0;
  let commitFee = 500;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = feeFor(estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + DUST) break;
  }
  if (total < commitValue + commitFee) throw new Error(`insufficient sats (need ~${commitValue + commitFee}, have ${total}). Use the faucet.`);

  const payload = encodeCPmintPayload({
    assetId: aid, etchTxid: hexToBytes(etchTxidHex), commitment, amount, blinding,
  });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const change = total - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (change >= DUST) commitOutputs.push({ value: change, script: p2wpkhScript(wallet.pub) });

  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxid = txid(commitTx);
  _progress('commit-start');
  await broadcast(commitHex);

  const revealTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: DUST, script: p2wpkhScript(wallet.pub) }],
  };
  const prevouts = [{ value: commitValue, script: p2trSpk }];
  revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxid = txid(revealTx);
  _progress('reveal-start');
  await broadcastWithRetry(revealHex);

  // Register asset metadata locally so the freshly-minted UTXO renders with
  // the correct ticker/decimals on the holdings card immediately, instead of
  // showing as `???` until validateOutpoint succeeds (which won't until the
  // worker credits the mint at depth ≥ 3 — see audit fix #5). For a minter
  // who's also the deployer, registerAsset was already called by
  // buildAndBroadcastPetch; for a minter of someone else's T_PETCH this is
  // the only path that lands the parent's metadata in the local registry.
  if (!getAssetMeta(aidHex)) {
    registerAsset({
      assetIdHex: aidHex,
      ticker: petchDec.ticker,
      decimals: petchDec.decimals,
      etchTxid: etchTxidHex,
      etchVout: 0,
      imageUri: petchDec.imageUri || null,
      mintable: false,
      mintAuthorityHex: null,
      kind: 'petch',
      capAmount: petchDec.capAmount.toString(),
      mintLimit: petchDec.mintLimit.toString(),
      mintStartHeight: petchDec.mintStartHeight,
      mintEndHeight: petchDec.mintEndHeight,
    });
  }
  // Persist the opening locally. validateOutpoint refuses to credit the UTXO
  // as ancestry until the worker confirms cap-credit at depth ≥ 3, but
  // scanHoldings's pending-tier path (audit fix #1) recovers the opening
  // from the on-chain envelope and surfaces this UTXO under h.pending so
  // the user sees their fresh mint accounted for — distinct from h.utxos
  // (spendable) and h.inflated (genuinely-broken). Audit fix E: previous
  // comment incorrectly claimed the recovery path runs unconditionally;
  // the truth is that h.pending only catches T_PMINT failures whose
  // pmintStatusOut tag is 'pending', not 'invalid'.
  recordOpening(revealTxid, 0, aidHex, amount, blindingBig);
  recordActivity({
    kind: 'pmint', ticker: petchDec.ticker, amount, decimals: petchDec.decimals,
    assetId: aidHex, txid: revealTxid,
  });
  invalidatePmintCreditedCache();
  // Bust the petch list cache too so the next renderPetchDiscover sees the
  // new pending mint (cap progress + remaining-mints + pending counter move).
  invalidatePetchCache();
  // Hint the worker so /petch-assets's pending_pmint_count reflects this
  // mint immediately rather than waiting for the 5-min cron tick. The hint
  // endpoint validates §5.9 steps 1–4 the same way the cron does and writes
  // under the canonical (height, tx_index, txid) key — idempotent against
  // the cron's later scan.
  postHint(revealTxid, 0);

  return {
    commitTxid, revealTxid, commitHex, revealHex,
    assetIdHex: aidHex,
    amount, blinding: blindingBig,
    commitVb: 11 + picked.length * inputVbytes + commitOutputs.length * p2wpkhOutVbytes,
    revealVb,
    commitFee, revealFee,
  };
}

// ============== CXFER (commit-reveal) ==============
// forceUtxos (optional) lets callers pre-select the exact asset UTXO(s) to
// consume — used by the cancel-atomic-offer flow, which must spend the
// specific UTXO referenced by an outstanding T_AXFER partial reveal in order
// to invalidate it. Default is the greedy largest-first picker.
//
// Multi-recipient form. K = recipients.length (1..7). Reveal tx layout:
//   vouts 0..K-1   = recipients (ECDH-derived blinding + keystream per recipient)
//   vout  K        = sender's change (self-derived; real change amount, may be 0)
//   vouts K+1..m-1 = padding (self-derived; amount = 0) so total outputs m ∈ {2,4,8}
// Padding is needed because the aggregated bulletproof requires m to be a power
// of 2. Padding outputs are indistinguishable from change to outsiders; the
// wallet auto-recovers them as 0-amount UTXOs (DUST sats are returned).
async function buildAndBroadcastCXferMulti({ assetIdHex, recipients, forceUtxos = null, allowDuplicateRecipients = false, onProgress = null }) {
  // onProgress(stage) parity with buildAndBroadcastCEtch — fires
  // 'commit-start' / 'reveal-start' right before each broadcast.
  const _progress = (stage) => { try { onProgress && onProgress(stage); } catch {} };
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('recipients must be a non-empty array');
  }
  const K = recipients.length;
  if (K > 7) throw new Error('max 7 recipients per CXFER (m=8 with 1 change output)');

  const parsed = recipients.map((r, i) => {
    if (!r || typeof r.pubHex !== 'string') throw new Error(`recipients[${i}].pubHex required`);
    const pubHex = r.pubHex.trim().toLowerCase().replace(/\s/g, '');
    if (!/^0[23][0-9a-f]{64}$/.test(pubHex)) throw new Error(`recipients[${i}].pubHex invalid format`);
    try { secp.ProjectivePoint.fromHex(pubHex); } catch { throw new Error(`recipients[${i}].pubHex not on curve`); }
    const amt = BigInt(r.amount);
    if (amt < 0n || amt >= (1n << BigInt(N_BITS))) throw new Error(`recipients[${i}].amount out of range`);
    return { pubHex, pub: hexToBytes(pubHex), amount: amt };
  });
  const totalSendAmt = parsed.reduce((s, r) => s + r.amount, 0n);
  if (totalSendAmt <= 0n) throw new Error('total recipient amount must be > 0');

  // Two outputs to the same pubkey at distinct vouts is cryptographically
  // fine (per-vout keystream suffix disambiguates), but in the manual-send
  // UI it's almost always a typo — most snapshot UIs key on (eth_address →
  // tacit_pubkey), so two outputs to the same tacit_pubkey would surprise
  // the recipient. The airdrop-fulfilment path overrides this with
  // `allowDuplicateRecipients: true` because two distinct ETH addresses
  // can legitimately consolidate to the same tacit wallet.
  if (!allowDuplicateRecipients) {
    const seen = new Set();
    for (const r of parsed) {
      if (seen.has(r.pubHex)) throw new Error(`duplicate recipient pubkey ${r.pubHex.slice(0, 10)}…`);
      seen.add(r.pubHex);
    }
  }

  const holdings = await scanHoldings();
  const h = holdings.get(assetIdHex);
  if (!h) throw new Error(`no holdings for asset ${assetIdHex}`);
  if (h.balance < totalSendAmt) throw new Error(`insufficient balance: have ${h.balance}, need ${totalSendAmt}`);

  let pickedAssetUtxos, inAmt = 0n, inBlindingSum = 0n;
  if (forceUtxos && forceUtxos.length > 0) {
    pickedAssetUtxos = forceUtxos;
    for (const x of pickedAssetUtxos) {
      inAmt += x.amount; inBlindingSum = modN(inBlindingSum + BigInt(x.blinding));
    }
    if (inAmt < totalSendAmt) throw new Error(`forced utxos provide ${inAmt}, need ${totalSendAmt}`);
  } else {
    const sortedUtxos = [...h.utxos].sort((a, b) => Number(b.amount - a.amount));
    pickedAssetUtxos = [];
    for (const x of sortedUtxos) {
      pickedAssetUtxos.push(x); inAmt += x.amount; inBlindingSum = modN(inBlindingSum + BigInt(x.blinding));
      if (inAmt >= totalSendAmt) break;
    }
  }
  const changeAmt = inAmt - totalSendAmt;
  if (changeAmt < 0n) throw new Error('internal: change negative');

  // Smallest m ∈ {2,4,8} fitting K recipients + 1 change output. K ∈ {1,3,7}
  // are zero-padding (optimal); K ∈ {2,4,5,6} carry padding outputs.
  const totalOuts = K + 1;
  const m = totalOuts <= 2 ? 2 : totalOuts <= 4 ? 4 : 8;

  // Anchor: first asset input's outpoint. Unique per CXFER (spent UTXOs are
  // unique on Bitcoin). Known to both sender and every recipient (recipients
  // read it from tx.vin[1]). Per-vout suffix in the keystream domain ensures
  // distinct blinding/keystream per output even at the same anchor.
  const firstAssetIn = pickedAssetUtxos[0].utxo;
  const anchorBytes = concatBytes(
    reverseBytes(hexToBytes(firstAssetIn.txid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, firstAssetIn.vout >>> 0, true); return b; })(),
  );

  const amounts = [];
  const blindings = [];
  const keystreams = [];
  for (let i = 0; i < K; i++) {
    amounts.push(parsed[i].amount);
    blindings.push(deriveBlinding(wallet.priv, parsed[i].pub, anchorBytes, i));
    keystreams.push(deriveAmountKeystreamECDH(wallet.priv, parsed[i].pub, anchorBytes, i));
  }
  amounts.push(changeAmt);
  blindings.push(deriveChangeBlinding(wallet.priv, anchorBytes, K));
  keystreams.push(deriveAmountKeystreamSelf(wallet.priv, anchorBytes, K));
  for (let v = K + 1; v < m; v++) {
    amounts.push(0n);
    blindings.push(deriveChangeBlinding(wallet.priv, anchorBytes, v));
    keystreams.push(deriveAmountKeystreamSelf(wallet.priv, anchorBytes, v));
  }

  const { proof: aggProof, commitments } = bpRangeAggProve(amounts, blindings);
  const commitmentBytesList = commitments.map(pointToBytes);

  // Kernel signature. excess = Σ r_out − Σ r_in across ALL m outputs (including
  // padding); padding contributes 0·H to the H-component, so the balance
  // equation is unchanged. Verifier reconstructs E' = ΣC_out − ΣC_in.
  const blindingSum = blindings.reduce((s, b) => modN(s + b), 0n);
  const excess = modN(blindingSum - inBlindingSum);
  const inputOutpoints = pickedAssetUtxos.map(x => ({ txid: x.utxo.txid, vout: x.utxo.vout }));
  const assetIdBytes = hexToBytes(assetIdHex);
  const kernelMsg = computeKernelMsg(assetIdBytes, inputOutpoints, commitmentBytesList);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excess));

  const cts = amounts.map((a, i) => encryptAmount(a, keystreams[i]));

  const payload = encodeCXferPayload({
    assetId: assetIdBytes,
    kernelSig,
    outputs: amounts.map((_, i) => ({ commitment: commitmentBytesList[i], encryptedAmount: cts[i] })),
    rangeproof: aggProof,
  });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const feeRate = await getFeeRate();
  const numAssetIn = pickedAssetUtxos.length;
  const revealVb = estCXferRevealVb({ m, numAssetIn, hasSatsChange: true });
  const revealFee = feeFor(revealVb, feeRate);

  // Reveal tx outputs: m DUST P2WPKH (K to recipients, m-K to sender), then
  // optional sats change.
  const senderP2wpkh = p2wpkhScript(wallet.pub);
  const revealPkScripts = [];
  for (let i = 0; i < K; i++) {
    revealPkScripts.push(concatBytes(new Uint8Array([0x00, 0x14]), hash160(parsed[i].pub)));
  }
  for (let i = K; i < m; i++) revealPkScripts.push(senderP2wpkh);

  const totalOutputDust = DUST * m;
  const assetInputTotal = pickedAssetUtxos.reduce((s, u) => s + u.utxo.value, 0);

  let satsChange = 0;
  let commitValue = totalOutputDust + revealFee - assetInputTotal;
  if (commitValue < DUST) {
    commitValue = DUST + revealFee;
    satsChange = commitValue + assetInputTotal - totalOutputDust - revealFee;
  }
  if (satsChange < DUST) satsChange = 0;

  const allUtxos = await getUtxos(wallet.address());
  const assetUtxoKeys = new Set(pickedAssetUtxos.map(x => `${x.utxo.txid}:${x.utxo.vout}`));
  const sats = allUtxos
    .filter(u => !assetUtxoKeys.has(`${u.txid}:${u.vout}`))
    .filter(u => u.value > DUST)
    .sort((a, b) => b.value - a.value);
  const pickedSats = []; let totalSats = 0; let commitFee = 500;
  for (const u of sats) {
    pickedSats.push(u); totalSats += u.value;
    commitFee = feeFor(estCommitVb(pickedSats.length), feeRate);
    if (totalSats >= commitValue + commitFee + DUST) break;
  }
  if (totalSats < commitValue + commitFee) {
    throw new Error(`insufficient sats for commit (need ~${commitValue + commitFee}, have ${totalSats})`);
  }
  const commitChange = totalSats - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (commitChange >= DUST) commitOutputs.push({ value: commitChange, script: p2wpkhScript(wallet.pub) });

  const commitTx = {
    version: 2, locktime: 0,
    inputs: pickedSats.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, pickedSats[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxid = txid(commitTx);

  _progress('commit-start');
  await broadcast(commitHex);

  const revealOutputs = revealPkScripts.map(script => ({ value: DUST, script }));
  if (satsChange >= DUST) revealOutputs.push({ value: satsChange, script: senderP2wpkh });
  const revealTx = {
    version: 2, locktime: 0,
    inputs: [
      { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
      ...pickedAssetUtxos.map(x => ({ txid: x.utxo.txid, vout: x.utxo.vout, sequence: 0xfffffffd, witness: [] })),
    ],
    outputs: revealOutputs,
  };
  const prevouts = [
    { value: commitValue, script: p2trSpk },
    ...pickedAssetUtxos.map(x => ({ value: x.utxo.value, script: p2wpkhScript(wallet.pub) })),
  ];
  revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  for (let i = 1; i < revealTx.inputs.length; i++) {
    revealTx.inputs[i].witness = signP2wpkhInput(revealTx, i, prevouts[i].value);
  }
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxid = txid(revealTx);

  _progress('reveal-start');
  await broadcastWithRetry(revealHex);
  // Bump the worker's per-asset transfer_count immediately. Without this the
  // counter only ticks on the next cron block-scan (5+ min on mainnet) and
  // any tx in a block the cron hasn't reached is invisible to Discover.
  postHint(revealTxid, 0);

  // Save self-side openings: change (vout K) + any padding (vouts K+1..m-1).
  // Recipients recover their own openings from chain via ECDH.
  for (let v = K; v < m; v++) {
    recordOpening(revealTxid, v, assetIdHex, amounts[v], blindings[v]);
  }

  {
    const am = getAssetMeta(assetIdHex) || {};
    for (let i = 0; i < K; i++) {
      recordActivity({
        kind: 'transfer-out', ticker: am.ticker || '',
        amount: parsed[i].amount, decimals: am.decimals || 0,
        assetId: assetIdHex, txid: revealTxid,
      });
    }
  }

  return {
    commitTxid, revealTxid, assetIdHex, m,
    recipients: parsed.map((r, i) => ({
      pubHex: r.pubHex, amount: r.amount, vout: i,
      blinding: blindings[i], commitmentBytes: commitmentBytesList[i],
    })),
    changeAmount: changeAmt,
    changeVout: K,
    changeBlinding: blindings[K],
    paddingVouts: Array.from({ length: m - K - 1 }, (_, i) => K + 1 + i),
    commitFee, revealFee,
  };
}

// Backwards-compatible single-recipient wrapper. The send-form UI handler and
// other internal flows (cancel-axfer-offer, cancel-fulfilled-intent) call this
// with the legacy { assetIdHex, recipientPubHex, amount, forceUtxos } shape.
async function buildAndBroadcastCXfer({ assetIdHex, recipientPubHex, amount, forceUtxos = null, onProgress = null }) {
  const r = await buildAndBroadcastCXferMulti({
    assetIdHex,
    recipients: [{ pubHex: recipientPubHex, amount }],
    forceUtxos,
    onProgress,
  });
  return {
    commitTxid: r.commitTxid,
    revealTxid: r.revealTxid,
    assetIdHex: r.assetIdHex,
    sendAmount: r.recipients[0].amount,
    changeAmount: r.changeAmount,
    recipBlinding: r.recipients[0].blinding,
    changeBlinding: r.changeBlinding,
    commitFee: r.commitFee, revealFee: r.revealFee,
    revealCommitmentRecipient: r.recipients[0].commitmentBytes,
  };
}

// ============== ATOMIC-LISTING BUILDER (T_AXFER, SPEC §5.7) ==============
// Maker constructs a partial Bitcoin tx that, when finalized by the taker
// (appending BTC inputs + a payment-to-maker output), settles atomically in
// one Bitcoin tx. Maker's reveal-tx sigs use SIGHASH_SINGLE | ANYONECANPAY
// so the taker can append without invalidating the maker's commitments.
//
// v1 constraint: N=1 (single tacit output to recipient, no change). This
// requires the maker to list a UTXO whose entire value goes to the buyer.
// To sell a fractional amount, the maker should first Send Privately to
// themselves to split the UTXO, then list the resulting fixed-amount UTXO.
//
// Tx structure:
//   vin[0]   = commit P2TR     ← maker signs taproot script-path SINGLE_ACP, binds vout[0]
//   vin[1]   = single asset    ← maker signs P2WPKH SINGLE_ACP, binds vout[1]
//   vin[2..] = taker BTC funding (added by taker, signed SIGHASH_ALL)
//   vout[0]  = recipient tacit (DUST P2WPKH to recipient)
//   vout[1]  = BTC payment to maker (price_sats P2WPKH to maker_address)
//   vout[2..] = taker BTC change / fees (added by taker)

const AXFER_OFFER_VERSION = 1;
const SIGHASH_SINGLE_ACP = 0x83;

async function buildAxferOffer({ utxoTxid, utxoVout, recipientPubHex, priceSats, expiry }) {
  if (!Number.isInteger(priceSats) || priceSats < DUST) throw new Error(`price_sats must be ≥ ${DUST}`);
  if (!Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) {
    throw new Error('expiry must be a future unix-seconds timestamp');
  }
  const recipientPub = hexToBytes(recipientPubHex);
  if (recipientPub.length !== 33) throw new Error('recipient pubkey must be 33-byte compressed hex');

  // Locate the asset UTXO from holdings (we need its known opening + asset_id).
  const holdings = await scanHoldings();
  let target = null;
  let assetIdHex = null;
  for (const [aid, h] of holdings) {
    const u = h.utxos.find(x => x.utxo.txid === utxoTxid && x.utxo.vout === utxoVout);
    if (u) { target = { ...u, decimals: h.decimals, ticker: h.ticker }; assetIdHex = aid; break; }
  }
  if (!target) throw new Error(`UTXO ${utxoTxid}:${utxoVout} not found in holdings`);
  const amt = target.amount;
  const inBlinding = BigInt(target.blinding);

  // Anchor for the recipient's blinding derivation: first asset input outpoint
  // = the listed UTXO. Same shape as CXFER §3.5.
  const anchorBytes = concatBytes(
    reverseBytes(hexToBytes(utxoTxid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, utxoVout >>> 0, true); return b; })(),
  );
  const recipBlinding = deriveBlinding(wallet.priv, recipientPub, anchorBytes, 0);

  // N=1 bulletproof on the recipient commitment.
  const { proof: rangeproof, commitments } = bpRangeAggProve([amt], [recipBlinding]);
  const recipCommitmentBytes = pointToBytes(commitments[0]);

  // Kernel sig. excess = recip_blinding - in_blinding (no change). E' = recip - input. Sign with excess.
  const excess = modN(recipBlinding - inBlinding);
  const assetIdBytes = hexToBytes(assetIdHex);
  const inputOutpoints = [{ txid: utxoTxid, vout: utxoVout }];
  const outputCommitments = [recipCommitmentBytes];
  const kernelMsg = computeKernelMsg(assetIdBytes, inputOutpoints, outputCommitments);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excess));

  // Recipient's encrypted-amount keystream (recoverable via ECDH).
  const recipKs = deriveAmountKeystreamECDH(wallet.priv, recipientPub, anchorBytes, 0);
  const recipCt = encryptAmount(amt, recipKs);

  const payload = encodeAxferPayload({
    assetId: assetIdBytes,
    assetInputCount: 1,
    kernelSig,
    outputs: [{ commitment: recipCommitmentBytes, encryptedAmount: recipCt }],
    rangeproof,
  });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  // Build commit tx (broadcast immediately — commits the P2TR output the
  // partial reveal will spend). The commit tx itself is a normal Bitcoin tx
  // and doesn't need atomicity with the take; it just funds the reveal.
  const feeRate = await getFeeRate();
  // AXFER reveal: 1 tacit commitment output (recipient gets the asset) +
  // 2 BTC outputs (payment to maker + taker change). Taker brings ~2 aux
  // inputs to fund their side — assume 2 for safety; over-funds slightly
  // if taker uses 1, which is recoverable when the deal completes.
  const revealVbEst = estCAxferRevealVb({ m: 1, numAssetIn: 1, numAuxIn: 2, numAuxOuts: 2 });
  const revealFee = feeFor(revealVbEst, feeRate);
  // Reveal needs commitValue + asset.value worth of BTC to cover dust outputs +
  // fee. With aux taker funding, the maker only needs to fund the COMMIT cost
  // and the reveal's tacit DUST + their share of fee. Keep it simple: maker
  // funds commit such that the reveal can pay 1 DUST tacit + price_sats BTC
  // payment + reveal fee, with the asset UTXO's sat value covering the rest.
  const commitValue = DUST + revealFee; // padding; taker will provide additional inputs to cover BTC payment and any deficit
  const allUtxos = await getUtxos(wallet.address());
  const exclude = new Set([`${utxoTxid}:${utxoVout}`]);
  const sats = allUtxos.filter(u => !exclude.has(`${u.txid}:${u.vout}`)).filter(u => u.value > DUST).sort((a, b) => b.value - a.value);
  const pickedSats = []; let totalSats = 0; let commitFee = 500;
  for (const u of sats) {
    pickedSats.push(u); totalSats += u.value;
    commitFee = feeFor(estCommitVb(pickedSats.length), feeRate);
    if (totalSats >= commitValue + commitFee + DUST) break;
  }
  if (totalSats < commitValue + commitFee) {
    throw new Error(`insufficient sats for commit (need ~${commitValue + commitFee}, have ${totalSats}). Use the faucet or fund the wallet.`);
  }
  const commitChange = totalSats - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (commitChange >= DUST) commitOutputs.push({ value: commitChange, script: p2wpkhScript(wallet.pub) });
  const commitTx = {
    version: 2, locktime: 0,
    inputs: pickedSats.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, pickedSats[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxid = txid(commitTx);
  await broadcast(commitHex);

  // Build the partial reveal tx with maker's sigs (SIGHASH_SINGLE_ACP).
  // Outputs in fixed positions:
  //   vout[0] = recipient tacit commitment (DUST P2WPKH to recipient)
  //   vout[1] = BTC payment to maker (price_sats to maker's address)
  // The taker will append vin[2..] (their BTC) and vout[2..] (their change).
  const recipientP2wpkh = concatBytes(new Uint8Array([0x00, 0x14]), hash160(recipientPub));
  const makerP2wpkh = p2wpkhScript(wallet.pub);
  const partialTx = {
    version: 2, locktime: 0,
    inputs: [
      { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
      { txid: utxoTxid, vout: utxoVout, sequence: 0xfffffffd, witness: [] },
    ],
    outputs: [
      { value: DUST, script: recipientP2wpkh },
      { value: priceSats, script: makerP2wpkh },
    ],
  };
  const prevouts = [
    { value: commitValue, script: p2trSpk },
    { value: target.utxo.value, script: makerP2wpkh },
  ];
  partialTx.inputs[0].witness = signTaprootScriptPathInputWithSighash(partialTx, prevouts, envelopeScript, cb, SIGHASH_SINGLE_ACP);
  partialTx.inputs[1].witness = signP2wpkhInputWithSighash(partialTx, 1, target.utxo.value, SIGHASH_SINGLE_ACP);

  // Pass the partial tx as structured data (witness arrays + scripts as hex)
  // so the taker can append BTC inputs/outputs and re-serialize without
  // needing a Bitcoin-tx hex parser.
  const partial = {
    version: partialTx.version,
    locktime: partialTx.locktime,
    inputs: partialTx.inputs.map(i => ({
      txid: i.txid, vout: i.vout, sequence: i.sequence,
      witness: i.witness.map(w => bytesToHex(w)),
    })),
    outputs: partialTx.outputs.map(o => ({
      value: o.value, script_hex: bytesToHex(o.script),
    })),
  };

  const offerJson = {
    version: AXFER_OFFER_VERSION,
    network: NET.name,
    asset_id: assetIdHex,
    ticker: target.ticker,
    decimals: target.decimals,
    amount: amt.toString(),
    price_sats: priceSats,
    maker_pubkey: bytesToHex(wallet.pub),
    maker_address: wallet.address(),
    recipient_pubkey: recipientPubHex,
    expiry,
    commit_txid: commitTxid,
    commit_value: commitValue,
    asset_utxo: { txid: utxoTxid, vout: utxoVout, value: target.utxo.value },
    partial_reveal: partial,
  };

  // Maker-side activity. The asset hasn't moved on-chain yet (the partial
  // reveal isn't broadcast until the taker finalizes), but locally we record
  // the offer so the maker can see "I have an open atomic offer for X" in
  // their activity log. If the offer expires unaccepted, the asset UTXO is
  // still spendable; this entry is a record of intent, not a settlement.
  recordActivity({
    kind: 'list-atomic',
    ticker: target.ticker,
    amount: amt,
    decimals: target.decimals,
    assetId: assetIdHex,
    txid: commitTxid,
  });
  // Persist for the outstanding-offers panel so the maker can re-copy the
  // JSON or cancel later.
  recordOpenOffer(offerJson);

  return offerJson;
}

// Verify a maker's atomic-offer JSON cryptographically *before* the taker
// commits funds. Rejects offers where any of the following diverge from the
// claims in the JSON:
//
//   • partial_reveal structure (must be 2 inputs / 2 outputs at the v1 N=1 shape)
//   • inputs[0]/inputs[1] match offer.commit_txid:0 / offer.asset_utxo
//   • outputs[0] = (DUST, p2wpkh(wallet.pub))     — recipient gets the asset UTXO
//   • outputs[1] = (price_sats, p2wpkh(maker_pub)) — maker_address derived
//     from maker_pubkey, not trusted from the JSON
//   • envelope decodes as T_AXFER, asset_id matches offer.asset_id
//   • CRITICAL: pedersenCommit(offer.amount, recipBlinding) == on-chain
//     commitment. The kernel sig already enforces input_amt == recipient_amt,
//     but the maker controls input_amt — verifying the binding here is what
//     stops a malicious maker from claiming a larger amount than the on-chain
//     commitment actually opens to.
//   • Bulletproof rangeproof verifies on the recipient commitment
//
// Returns { recipBlinding, makerPub, anchorBytes } so the caller can record
// the opening without re-deriving. Throws on any failure.
function verifyAxferOffer(offer) {
  if (offer.version !== AXFER_OFFER_VERSION) throw new Error(`unsupported offer version: ${offer.version}`);
  if (offer.network !== NET.name) throw new Error(`offer is for ${offer.network}, current network is ${NET.name}`);
  if (!Number.isInteger(offer.expiry) || offer.expiry <= Math.floor(Date.now() / 1000)) {
    throw new Error('offer has expired');
  }
  if (offer.recipient_pubkey !== bytesToHex(wallet.pub)) {
    throw new Error('offer is targeted at a different recipient pubkey — only the named recipient can take it');
  }
  if (!/^[0-9a-f]{64}$/.test(String(offer.asset_id || ''))) throw new Error('invalid asset_id');
  if (!/^[0-9a-f]{64}$/.test(String(offer.commit_txid || ''))) throw new Error('invalid commit_txid');
  if (!/^0[23][0-9a-f]{64}$/.test(String(offer.maker_pubkey || ''))) throw new Error('invalid maker_pubkey');
  if (!Number.isInteger(offer.price_sats) || offer.price_sats < DUST) throw new Error(`price_sats must be ≥ ${DUST}`);
  if (!/^\d+$/.test(String(offer.amount || ''))) throw new Error('invalid amount');
  const amt = BigInt(offer.amount);
  if (amt < 0n || amt >= (1n << BigInt(N_BITS))) throw new Error('amount out of range');

  // Maker_address must derive from maker_pubkey on the current network so
  // the confirm dialog reflects what's actually being paid in vout[1].
  const makerPub = hexToBytes(offer.maker_pubkey);
  const expectedMakerAddr = p2wpkhAddress(makerPub);
  if (offer.maker_address !== expectedMakerAddr) {
    throw new Error(`maker_address (${offer.maker_address}) does not match maker_pubkey (expected ${expectedMakerAddr})`);
  }

  // Partial-reveal structure
  const pr = offer.partial_reveal;
  if (!pr || !Array.isArray(pr.inputs) || !Array.isArray(pr.outputs)) {
    throw new Error('partial_reveal missing or malformed');
  }
  if (pr.inputs.length !== 2) throw new Error(`partial_reveal must have exactly 2 inputs (got ${pr.inputs.length})`);
  if (pr.outputs.length !== 2) throw new Error(`partial_reveal must have exactly 2 outputs (got ${pr.outputs.length})`);

  const vin0 = pr.inputs[0];
  if (vin0.txid !== offer.commit_txid || vin0.vout !== 0) {
    throw new Error('partial_reveal.inputs[0] does not match offer.commit_txid:0');
  }
  if (!Array.isArray(vin0.witness) || vin0.witness.length !== 3) {
    throw new Error('partial_reveal.inputs[0].witness must have 3 items (sig, envelope, control_block)');
  }
  const vin1 = pr.inputs[1];
  if (!offer.asset_utxo || vin1.txid !== offer.asset_utxo.txid || vin1.vout !== offer.asset_utxo.vout) {
    throw new Error('partial_reveal.inputs[1] does not match offer.asset_utxo');
  }

  const vout0 = pr.outputs[0];
  if (vout0.value !== DUST) throw new Error(`partial_reveal.outputs[0].value must be ${DUST} (got ${vout0.value})`);
  const expectedRecipScript = bytesToHex(p2wpkhScript(wallet.pub));
  if (vout0.script_hex !== expectedRecipScript) {
    throw new Error('partial_reveal.outputs[0].script does not pay the recipient');
  }
  const vout1 = pr.outputs[1];
  if (vout1.value !== offer.price_sats) {
    throw new Error(`partial_reveal.outputs[1].value (${vout1.value}) != offer.price_sats (${offer.price_sats})`);
  }
  const expectedMakerScript = bytesToHex(p2wpkhScript(makerPub));
  if (vout1.script_hex !== expectedMakerScript) {
    throw new Error('partial_reveal.outputs[1].script does not pay the maker pubkey');
  }

  let envBytes;
  try { envBytes = hexToBytes(vin0.witness[1]); } catch { throw new Error('envelope hex decode failed'); }
  const env = decodeEnvelopeScript(envBytes);
  if (!env) throw new Error('envelope structurally invalid');
  if (env.opcode !== T_AXFER) throw new Error(`envelope opcode 0x${env.opcode.toString(16)} != T_AXFER`);
  const dec = decodeAxferPayload(env.payload);
  if (!dec) throw new Error('T_AXFER payload decode failed');
  if (dec.assetInputCount !== 1) throw new Error(`asset_input_count must be 1 (got ${dec.assetInputCount})`);
  if (dec.outputs.length !== 1) throw new Error(`expected 1 tacit output (got ${dec.outputs.length})`);
  if (bytesToHex(dec.assetId) !== offer.asset_id) {
    throw new Error('envelope.asset_id does not match offer.asset_id');
  }

  // CRITICAL: bind the offer's claimed amount to the on-chain commitment.
  // Without this, a malicious maker can claim any amount in the JSON while
  // the actual transfer carries the input UTXO's true (lower) amount.
  //
  // Two paths:
  //   • targeted T_AXFER (default): blinding derives from ECDH(taker.priv,
  //     maker.pub, anchor=asset_utxo, vout=0). Anchor must match what the
  //     maker used; we recompute it locally.
  //   • atomic intent: caller passes offer.recipient_blinding (32-byte hex
  //     scalar) — the value the maker decrypted-out to us via ECDH-keystream
  //     in the fulfilment. We use it directly. The Pedersen check below is
  //     identical for both paths; only the source of `r` differs.
  const anchorBytes = concatBytes(
    reverseBytes(hexToBytes(offer.asset_utxo.txid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, offer.asset_utxo.vout >>> 0, true); return b; })(),
  );
  let recipBlinding;
  if (offer.recipient_blinding != null) {
    if (!/^[0-9a-f]{64}$/.test(String(offer.recipient_blinding).toLowerCase())) {
      throw new Error('recipient_blinding must be 32-byte hex');
    }
    const rBig = BigInt('0x' + offer.recipient_blinding);
    if (rBig <= 0n || rBig >= SECP_N) {
      throw new Error('recipient_blinding scalar out of range [1, N)');
    }
    recipBlinding = rBig;
  } else {
    recipBlinding = deriveBlinding(wallet.priv, makerPub, anchorBytes, 0);
  }
  const expectedC = pedersenCommit(amt, recipBlinding);
  let onChainC;
  try { onChainC = bytesToPoint(dec.outputs[0].commitment); }
  catch { throw new Error('recipient commitment is not a valid curve point'); }
  if (!expectedC.equals(onChainC)) {
    throw new Error('commitment binding failed — offer.amount does not open the on-chain commitment. The maker is misrepresenting the amount being transferred.');
  }

  // Defense in depth: rangeproof check. validateOutpoint would catch this
  // post-broadcast, but we'd rather not broadcast at all.
  if (!bpRangeAggVerify([onChainC], dec.rangeproof)) {
    throw new Error('bulletproof rangeproof failed to verify');
  }

  return { recipBlinding, makerPub, anchorBytes };
}

// Taker side: finalize a partial atomic offer. Appends BTC funding inputs
// (signed SIGHASH_ALL — commits the whole tx, locking the maker's
// payment-to-maker output at vout[1]) plus an optional taker BTC change output.
// Broadcasts the result. Returns the broadcast txid.
async function takeAxferOffer(offer, { onProgress = null } = {}) {
  // onProgress(stage). Single-broadcast settlement (no commit/reveal pair),
  // so stages map to: 'verify-start' (cryptographic + on-chain verification
  // before touching funds) → 'sign-start' (assembling + signing the
  // settlement tx) → 'broadcast-start' (about to send the final tx).
  const _progress = (stage) => { try { onProgress && onProgress(stage); } catch {} };
  _progress('verify-start');
  // Cryptographic verification of the offer must happen BEFORE we touch funds.
  // verifyAxferOffer covers structure, output binding, envelope decode, and
  // the critical Pedersen binding that ties offer.amount to the on-chain
  // commitment.
  const { recipBlinding, makerPub, anchorBytes } = verifyAxferOffer(offer);

  // Fetch the commit tx and verify vout[0] actually pays the P2TR derived
  // from the partial reveal's envelope. Without this, the maker could put
  // any commit_txid in the JSON; the eventual broadcast would fail anyway
  // (Bitcoin checks the maker's vin[0] sig against the real prevout's spk),
  // but a clean pre-broadcast error is much better UX than a relay failure.
  let commitTx;
  try { commitTx = await apiJson(`/tx/${offer.commit_txid}`); }
  catch (e) {
    if (/^API 404/.test(e.message)) {
      throw new Error(`commit_txid ${shorten(offer.commit_txid, 8)} not found on ${NET.name} — the maker may have pointed at a fake commit, or it hasn't propagated yet. Try again in a moment.`);
    }
    throw new Error(`could not fetch commit tx (mempool API: ${e.message}). Try again in a moment.`);
  }
  const commitVout0 = commitTx?.vout?.[0];
  if (!commitVout0?.scriptpubkey) {
    throw new Error('commit tx vout[0] missing scriptpubkey');
  }
  // Re-derive the expected P2TR spk from the envelope script. Bitcoin already
  // enforces the taproot tweak when the eventual reveal broadcasts, but doing
  // it here means a fake commit fails fast with a precise error.
  const envBytesForCommit = hexToBytes(offer.partial_reveal.inputs[0].witness[1]);
  const leaf = tapLeafHash(envBytesForCommit);
  const { Q_xonly } = tweakedOutputKey(TAP_NUMS, leaf);
  const expectedSpkHex = bytesToHex(p2trScript(Q_xonly));
  if (commitVout0.scriptpubkey !== expectedSpkHex) {
    throw new Error('commit_txid vout[0] scriptpubkey does not match the partial reveal envelope — the maker is pointing at a fake commit.');
  }
  if (commitVout0.value !== offer.commit_value) {
    throw new Error(`commit_value mismatch (offer says ${offer.commit_value}, on-chain ${commitVout0.value})`);
  }

  // Liveness: maker's commit output must still be unspent. Surface network
  // errors distinctly from "really spent" so the user can tell whether to
  // retry (transient API failure) or abandon (offer settled / cancelled).
  let sp;
  try { sp = await getOutspend(offer.commit_txid, 0); }
  catch (e) {
    if (/^API 404/.test(e.message)) {
      throw new Error('commit outspend record not found — tx may not have confirmed yet. Wait a moment and retry.');
    }
    throw new Error(`could not check commit liveness (mempool API: ${e.message}). Try again in a moment.`);
  }
  if (sp?.spent) throw new Error('maker commit output already spent — offer is stale or already settled');

  const feeRate = await getFeeRate();
  const estVb = 200 + inputVbytes + p2wpkhOutVbytes;
  const fee = feeFor(estVb, feeRate);
  // Tx-level balance: outputs_total + fee = inputs_total
  // Known inputs from the offer: commit_value + asset_utxo.value
  // Known outputs from the offer: DUST (recipient tacit) + price_sats (BTC payment)
  // Taker contributes: fundingGap = (knownOut + fee) - knownIn
  const knownInValue = offer.commit_value + offer.asset_utxo.value;
  const knownOutValue = offer.partial_reveal.outputs.reduce((s, o) => s + o.value, 0);
  const fundingGap = knownOutValue + fee - knownInValue;
  if (fundingGap < 0) throw new Error('partial tx is over-funded; refusing to take');

  _progress('sign-start');
  const allUtxos = await getUtxos(wallet.address());
  const usable = allUtxos.filter(u => u.value > DUST).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0;
  for (const u of usable) {
    picked.push(u); total += u.value;
    if (total >= fundingGap + DUST) break; // need DUST for taker change
  }
  if (total < fundingGap) throw new Error(`insufficient sats: need ${fundingGap}, have ${total}`);
  const takerChange = total - fundingGap;

  const tx = {
    version: offer.partial_reveal.version,
    locktime: offer.partial_reveal.locktime,
    inputs: offer.partial_reveal.inputs.map(i => ({
      txid: i.txid, vout: i.vout, sequence: i.sequence,
      witness: i.witness.map(w => hexToBytes(w)),
    })),
    outputs: offer.partial_reveal.outputs.map(o => ({
      value: o.value, script: hexToBytes(o.script_hex),
    })),
  };
  for (const u of picked) {
    tx.inputs.push({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] });
  }
  if (takerChange >= DUST) {
    tx.outputs.push({ value: takerChange, script: p2wpkhScript(wallet.pub) });
  }
  for (let i = 0; i < picked.length; i++) {
    const idx = 2 + i;
    tx.inputs[idx].witness = signP2wpkhInput(tx, idx, picked[i].value);
  }

  const txHex = bytesToHex(serializeTx(tx));
  const finalTxid = txid(tx);
  _progress('broadcast-start');
  await broadcastWithRetry(txHex);
  // Bump the worker's per-asset transfer_count immediately for this T_AXFER
  // settlement; otherwise atomic-OTC fills don't surface in Discover until
  // the next cron tick. Pass price + amount so the worker also stamps the
  // last-traded price for this asset — the AXFER tx itself doesn't carry
  // those (they live in the off-chain intent record), so the dapp ferries
  // them over. Worker validates the tx is an AXFER for the asset before
  // recording. Best-effort; trade record is decorative, not security-critical.
  postHint(finalTxid, 0, {
    price_sats: Number(offer.price_sats) || 0,
    amount:     String(offer.amount || ''),
  });

  // Pre-stash the recipient opening so the taker's next holdings refresh sees
  // the new UTXO instantly (rather than waiting for ECDH-recovery to scan it).
  // Safe because verifyAxferOffer already verified pedersenCommit(amount,
  // recipBlinding) opens the on-chain commitment.
  recordOpening(finalTxid, 0, offer.asset_id, BigInt(offer.amount), recipBlinding);
  recordActivity({
    kind: 'transfer-in',
    ticker: offer.ticker || '',
    amount: BigInt(offer.amount),
    decimals: Number.isInteger(offer.decimals) ? offer.decimals : 0,
    assetId: offer.asset_id,
    txid: finalTxid,
  });

  return { txid: finalTxid, hex: txHex };
}

// Cancel an outstanding atomic offer by spending the listed asset UTXO via a
// CXFER self-send. Once the asset UTXO is consumed, the partial reveal is
// permanently invalid (no taker can broadcast it). Cost: a normal CXFER's
// commit/reveal fees; the original commit's value is forfeit (unrecoverable
// because the only spending path is the script-path that requires a valid
// asset input — which we've now spent).
//
// Pre-conditions verified here:
//   • asset UTXO from the offer is still in our holdings (not yet taken)
//   • we have the local opening so we can build the CXFER
async function cancelAxferOffer(commitTxid) {
  const stored = loadOpenOffers().find(o => o.commit_txid === commitTxid);
  if (!stored) throw new Error('offer not found in local storage (already forgotten?)');
  if (!stored.asset_utxo) throw new Error('stored offer is missing asset_utxo metadata');

  const holdings = await scanHoldings();
  const h = holdings.get(stored.asset_id);
  const u = h?.utxos.find(x =>
    x.utxo.txid === stored.asset_utxo.txid && x.utxo.vout === stored.asset_utxo.vout
  );
  if (!u) {
    // The asset UTXO is no longer in holdings — either the offer was already
    // taken or the maker spent it elsewhere. Forget the entry so the UI stops
    // showing it as cancellable.
    forgetOpenOffer(commitTxid);
    throw new Error('asset UTXO already spent — offer is settled or cancelled. Removed from local list.');
  }

  // Self-send the entire UTXO via CXFER, forcing the picker to consume the
  // exact UTXO referenced by the offer (rather than greedy-picking a larger
  // one of the same asset).
  const r = await buildAndBroadcastCXfer({
    assetIdHex:      stored.asset_id,
    recipientPubHex: bytesToHex(wallet.pub),
    amount:          u.amount,
    forceUtxos:      [u],
  });

  forgetOpenOffer(commitTxid);
  return r;
}

// ============== ATOMIC INTENTS (browse-and-take T_AXFER, two-step) ==============
// Trustless + discoverable atomic settlement. Maker publishes an intent
// without knowing the recipient — recipient blinding is published cleartext
// (deterministic-random per intent), so the on-chain output commitment is
// fixed at intent-publish time. Taker claims; maker observes claim and
// generates a targeted partial reveal binding the Bitcoin output script to
// the claimant's pubkey via SIGHASH_SINGLE_ACP. Taker finalizes by appending
// BTC funding signed SIGHASH_ALL → atomic single-tx settlement.

function _axintentMsg(assetIdBytes, intentIdBytes, makerPubBytes, amount, priceSats, expiry, commitTxidHex, assetUtxoTxidHex, assetUtxoVout) {
  const priceLE = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8); new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amount), true);
  const utxoVoutLE = new Uint8Array(4); new DataView(utxoVoutLE.buffer).setUint32(0, assetUtxoVout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-v1'),
    assetIdBytes, intentIdBytes, makerPubBytes,
    amountLE, priceLE, expiryLE,
    reverseBytes(hexToBytes(commitTxidHex)),
    reverseBytes(hexToBytes(assetUtxoTxidHex)), utxoVoutLE,
  ));
}
// v2: claim message binds a taker-controlled sat UTXO ≥ price_sats. Worker
// re-verifies the binding so any captured v1 sig can't be replayed against
// a different UTXO, and so a free-claim DoS (was possible in v1) can no
// longer lock intents without proof of funds.
function _axintentClaimMsg(assetIdBytes, intentIdBytes, takerPubBytes, takerUtxoTxidHex, takerUtxoVout) {
  const txidBE = reverseBytes(hexToBytes(takerUtxoTxidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, takerUtxoVout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-claim-v2'),
    assetIdBytes, intentIdBytes, takerPubBytes,
    txidBE, voutLE,
  ));
}
function _axintentFulfilMsg(assetIdBytes, intentIdBytes, takerPubBytes, partialJson) {
  const phash = sha256(new TextEncoder().encode(partialJson));
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-fulfilment-v1'),
    assetIdBytes, intentIdBytes, takerPubBytes, phash,
  ));
}
function _axintentCancelMsg(assetIdBytes, intentIdBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-cancel-v1'),
    assetIdBytes, intentIdBytes,
  ));
}

async function publishAxferIntent({ utxoTxid, utxoVout, priceSats, expiry, onProgress = null }) {
  // onProgress(stage). Stages, in order:
  //   'commit-start'  — about to broadcast the commit tx
  //   'wait-visible'  — commit broadcast resolved; waiting for chain API to index
  //   'publish-start' — about to POST the signed intent body to the worker
  // Different from the CETCH/CXFER shape: there's only one chain broadcast
  // (the commit) — the reveal happens later when a taker takes the intent.
  const _progress = (stage) => { try { onProgress && onProgress(stage); } catch {} };
  if (!WORKER_BASE) throw new Error('worker disabled');
  if (!Number.isInteger(priceSats) || priceSats < DUST) throw new Error(`price_sats must be ≥ ${DUST}`);
  if (!Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) throw new Error('expiry must be future unix-seconds');

  const holdings = await scanHoldings();
  let target = null, assetIdHex = null;
  for (const [aid, h] of holdings) {
    const u = h.utxos.find(x => x.utxo.txid === utxoTxid && x.utxo.vout === utxoVout);
    if (u) { target = { ...u, decimals: h.decimals, ticker: h.ticker }; assetIdHex = aid; break; }
  }
  if (!target) throw new Error(`UTXO ${utxoTxid}:${utxoVout} not found in holdings`);

  const amt = target.amount;
  const inBlinding = BigInt(target.blinding);
  const recipBlinding = randomScalar();
  const recipCommitment = pedersenCommit(amt, recipBlinding);
  const recipCommitmentBytes = pointToBytes(recipCommitment);

  const { proof: rangeproof } = bpRangeAggProve([amt], [recipBlinding]);
  const excess = modN(recipBlinding - inBlinding);
  const assetIdBytes = hexToBytes(assetIdHex);
  const inputOutpoints = [{ txid: utxoTxid, vout: utxoVout }];
  const outputCommitments = [recipCommitmentBytes];
  const kernelMsg = computeKernelMsg(assetIdBytes, inputOutpoints, outputCommitments);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excess));
  const recipCt = new Uint8Array(8);

  const payload = encodeAxferPayload({
    assetId: assetIdBytes,
    assetInputCount: 1,
    kernelSig,
    outputs: [{ commitment: recipCommitmentBytes, encryptedAmount: recipCt }],
    rangeproof,
  });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const feeRate = await getFeeRate();
  const revealVbEst = 120 + 380 + inputVbytes + 31 + 31 + 31;
  const revealFee = feeFor(revealVbEst, feeRate);
  const commitValue = DUST + revealFee;

  const allUtxos = await getUtxos(wallet.address());
  const exclude = new Set([`${utxoTxid}:${utxoVout}`]);
  const sats = allUtxos.filter(u => !exclude.has(`${u.txid}:${u.vout}`)).filter(u => u.value > DUST).sort((a, b) => b.value - a.value);
  const pickedSats = []; let totalSats = 0; let commitFee = 500;
  for (const u of sats) {
    pickedSats.push(u); totalSats += u.value;
    commitFee = feeFor(estCommitVb(pickedSats.length), feeRate);
    if (totalSats >= commitValue + commitFee + DUST) break;
  }
  if (totalSats < commitValue + commitFee) throw new Error(`insufficient sats for commit (need ~${commitValue + commitFee}, have ${totalSats})`);
  const commitChange = totalSats - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (commitChange >= DUST) commitOutputs.push({ value: commitChange, script: p2wpkhScript(wallet.pub) });
  const commitTx = {
    version: 2, locktime: 0,
    inputs: pickedSats.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, pickedSats[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxidHex = txid(commitTx);
  _progress('commit-start');
  await broadcast(commitHex);

  const intentIdBytes = sha256(concatBytes(reverseBytes(hexToBytes(commitTxidHex)), wallet.pub)).slice(0, 16);
  const intentIdHex = bytesToHex(intentIdBytes);
  const intentMsg = _axintentMsg(assetIdBytes, intentIdBytes, wallet.pub, amt, priceSats, expiry, commitTxidHex, utxoTxid, utxoVout);
  const intentSig = signSchnorr(intentMsg, wallet.priv);

  // recipient_blinding is NEVER published to the worker. Posting `r`
  // cleartext would let any observer recover the amount via baby-step-giant-
  // step on `a·H = onChainC - r·G` (a few seconds for 64-bit amounts, ms for
  // low-decimal assets). We hold it locally and re-encrypt it to the
  // claimant's pubkey at fulfilment time.
  const body = {
    intent_id: intentIdHex,
    maker_pubkey: bytesToHex(wallet.pub),
    maker_address: wallet.address(),
    amount: amt.toString(),
    price_sats: priceSats,
    expiry,
    commit_txid: commitTxidHex,
    commit_value: commitValue,
    p2tr_spk_hex: bytesToHex(p2trSpk),
    asset_utxo: { txid: utxoTxid, vout: utxoVout, value: target.utxo.value },
    ticker: target.ticker || '',
    decimals: target.decimals || 0,
    envelope_script_hex: bytesToHex(envelopeScript),
    control_block_hex: bytesToHex(cb),
    intent_sig: bytesToHex(intentSig),
  };
  // Persist BOTH the body and the recipient blinding `r` locally before
  // touching the worker. The commit tx is already on-chain (broadcast above),
  // so any subsequent failure in waitForTxVisible / POST must be recoverable
  // without re-broadcasting and re-paying fees. With these two persisted
  // records, the dapp can resume the publish on next page load using the
  // identical body — intent_id derives from commit_txid + maker_pub so it's
  // stable, and the intent_sig is already baked in.
  recordAxintentPending(intentIdHex, assetIdHex, body);
  recordAxintentSecret(intentIdHex, bytesToHex(bigintToBytes32(recipBlinding)));
  // Block the POST until the chain API has indexed the commit tx. This is
  // the primary defense against the propagation race; the worker also
  // retries on its side as a 7s backstop. By the time we POST, mempool.space
  // has acknowledged seeing the commit, so the worker's chain check
  // succeeds on its first attempt.
  _progress('wait-visible');
  await waitForTxVisible(commitTxidHex);
  _progress('publish-start');
  await postAxferIntentBody(assetIdHex, body);
  // POST succeeded — discard the pending record so we don't try to re-post
  // on next load. The secret + activity are kept (intent is now live).
  forgetAxintentPending(intentIdHex);
  recordActivity({
    kind: 'list-atomic',
    ticker: target.ticker || '',
    amount: amt,
    decimals: target.decimals || 0,
    assetId: assetIdHex,
    txid: commitTxidHex,
  });
  return { intent_id: intentIdHex, asset_id: assetIdHex };
}

// Verbatim re-POST of a captured intent body. Used both by the happy-path
// publishAxferIntent flow and by the post-load resumption logic for
// pending entries (commit tx broadcast OK but worker POST never landed).
async function postAxferIntentBody(assetIdHex, body) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const resp = await fetch(withNet(ATOMIC_INTENTS_URL(assetIdHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

// Best-effort recovery for pending intents whose POST never succeeded. Runs
// on dapp init: for each saved pending entry on this network, wait for the
// commit tx to be visible (the user could be reloading hours later, so the
// chain has had plenty of time) then re-POST. Successful entries clear; the
// rest stay in localStorage for a future retry. Failures here are logged
// but don't block init — the user can manually retry from a UI affordance.
async function resumePendingAxintents() {
  if (!WORKER_BASE) return;
  const pendings = listAxintentPendings();
  if (!pendings.length) return;
  for (const p of pendings) {
    if (!p.body || !p.asset_id) { forgetAxintentPending(p.intentIdHex); continue; }
    // Skip entries whose intent has already expired — re-posting would just
    // 400 with "expiry must be in the future" anyway.
    const now = Math.floor(Date.now() / 1000);
    if (Number.isInteger(p.body.expiry) && p.body.expiry <= now) {
      forgetAxintentPending(p.intentIdHex);
      continue;
    }
    try {
      await waitForTxVisible(p.body.commit_txid, { maxMs: 30000 });
      await postAxferIntentBody(p.asset_id, p.body);
      forgetAxintentPending(p.intentIdHex);
      console.info(`[axintent] resumed pending intent ${p.intentIdHex.slice(0, 8)}…`);
    } catch (e) {
      console.warn(`[axintent] could not resume ${p.intentIdHex.slice(0, 8)}…:`, e.message || e);
      // Leave the pending entry in place; user-visible retry surface (see
      // below) lets them try again manually after diagnosing.
    }
  }
}

async function claimAxferIntent({ assetIdHex, intentIdHex, priceSats }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  if (!Number.isInteger(priceSats) || priceSats < 1) {
    throw new Error('price_sats must be a positive integer to reserve');
  }
  // Pre-flight: pick a single P2WPKH sat UTXO of value ≥ price_sats. Worker
  // re-verifies on-chain so trolls can't free-claim and lock intents — and
  // surfacing the requirement client-side gives the user a clear error
  // instead of a worker rejection ("not enough sats in a single UTXO").
  let utxos;
  try { utxos = await getUtxos(wallet.address()); }
  catch (e) { throw new Error('could not load wallet UTXOs: ' + (e.message || e)); }
  const candidate = (utxos || []).filter(u => u.status?.confirmed !== false)
    .sort((a, b) => Number(a.value) - Number(b.value)) // smallest UTXO that fits, leave bigger ones for later
    .find(u => Number(u.value) >= priceSats);
  if (!candidate) {
    const total = (utxos || []).reduce((s, u) => s + Number(u.value || 0), 0);
    throw new Error(
      `no single confirmed UTXO at this address has ≥ ${priceSats} sats ` +
      `(total balance: ${total}). To reserve, consolidate into one UTXO or send sats to ${wallet.address()}.`
    );
  }
  const utxoTxid = String(candidate.txid).toLowerCase();
  const utxoVout = Number(candidate.vout) >>> 0;
  const cMsg = _axintentClaimMsg(hexToBytes(assetIdHex), hexToBytes(intentIdHex), wallet.pub, utxoTxid, utxoVout);
  const sig = signSchnorr(cMsg, wallet.priv);
  const resp = await fetch(withNet(ATOMIC_INTENT_CLAIM_URL(assetIdHex, intentIdHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taker_pubkey: bytesToHex(wallet.pub),
      taker_utxo: { txid: utxoTxid, vout: utxoVout },
      sig: bytesToHex(sig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (resp.status === 409) {
    const remain = j.claim?.expires_at ? Math.max(0, j.claim.expires_at - Math.floor(Date.now()/1000)) : null;
    const extra = remain != null ? ` (held ~${Math.ceil(remain/60)} more min)` : '';
    throw new Error('intent already claimed by another taker' + extra);
  }
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

async function fulfilAxferIntent({ assetIdHex, intentIdHex, intent, claim }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  if (intent.maker_pubkey !== bytesToHex(wallet.pub)) throw new Error('not your intent');
  if (!claim) throw new Error('no active claim to fulfil');
  const takerPubHex = claim.taker_pubkey;
  const takerPub = hexToBytes(takerPubHex);

  // Recover the random `r` we picked at intent-publish time. Without it, we
  // can't tell the claimant what amount opens the on-chain commitment, so
  // we abort rather than ship a partial reveal the taker can't verify.
  const rHex = loadAxintentSecret(intentIdHex);
  if (!rHex) {
    throw new Error('local intent secret missing — cannot fulfil. The blinding scalar `r` was generated on this device at publish time and is required to encrypt the opening to the claimant.');
  }

  const envelopeScript = hexToBytes(intent.envelope_script_hex);
  const cb = hexToBytes(intent.control_block_hex);
  const p2trSpk = hexToBytes(intent.p2tr_spk_hex);
  const recipientP2wpkh = concatBytes(new Uint8Array([0x00, 0x14]), hash160(takerPub));
  const makerP2wpkh = p2wpkhScript(wallet.pub);
  const partialTx = {
    version: 2, locktime: 0,
    inputs: [
      { txid: intent.commit_txid, vout: 0, sequence: 0xfffffffd, witness: [] },
      { txid: intent.asset_utxo.txid, vout: intent.asset_utxo.vout, sequence: 0xfffffffd, witness: [] },
    ],
    outputs: [
      { value: DUST, script: recipientP2wpkh },
      { value: intent.price_sats, script: makerP2wpkh },
    ],
  };
  const prevouts = [
    { value: intent.commit_value, script: p2trSpk },
    { value: intent.asset_utxo.value, script: makerP2wpkh },
  ];
  partialTx.inputs[0].witness = signTaprootScriptPathInputWithSighash(partialTx, prevouts, envelopeScript, cb, SIGHASH_SINGLE_ACP);
  partialTx.inputs[1].witness = signP2wpkhInputWithSighash(partialTx, 1, intent.asset_utxo.value, SIGHASH_SINGLE_ACP);

  const partial = {
    version: partialTx.version,
    locktime: partialTx.locktime,
    inputs: partialTx.inputs.map(i => ({
      txid: i.txid, vout: i.vout, sequence: i.sequence,
      witness: i.witness.map(w => bytesToHex(w)),
    })),
    outputs: partialTx.outputs.map(o => ({
      value: o.value, script_hex: bytesToHex(o.script),
    })),
  };
  const partialJson = JSON.stringify(partial);
  const fMsg = _axintentFulfilMsg(hexToBytes(assetIdHex), hexToBytes(intentIdHex), takerPub, partialJson);
  const fSig = signSchnorr(fMsg, wallet.priv);

  // Encrypt `r` to the claimant via ECDH. Worker stores the ciphertext
  // opaquely; only the claimant (with the matching priv) can decrypt.
  const intentIdBytes = hexToBytes(intentIdHex);
  const assetIdBytesF = hexToBytes(assetIdHex);
  const keystream = deriveAxintentBlindingKeystream(wallet.priv, takerPub, intentIdBytes, assetIdBytesF);
  const encRecipBlinding = xor32(hexToBytes(rHex), keystream);

  const resp = await fetch(withNet(ATOMIC_INTENT_FULFILMENT_URL(assetIdHex, intentIdHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taker_pubkey: takerPubHex,
      partial_reveal: partial,
      fulfilment_sig: bytesToHex(fSig),
      enc_recipient_blinding: bytesToHex(encRecipBlinding),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

async function fetchAxferFulfilment({ assetIdHex, intentIdHex }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const resp = await fetch(withNet(ATOMIC_INTENT_FULFILMENT_URL(assetIdHex, intentIdHex)));
  if (resp.status === 404) return null;
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

async function takeAxferIntent({ intent, fulfilment, onProgress = null }) {
  if (!intent || !fulfilment) throw new Error('intent + fulfilment required');
  // Decrypt the recipient blinding the maker shipped at fulfilment. The
  // ciphertext is symmetric ECDH between (maker, taker), so deriving the
  // keystream with our own priv against maker.pub yields the same scalar.
  const encHex = String(fulfilment.enc_recipient_blinding || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(encHex)) {
    throw new Error('fulfilment is missing enc_recipient_blinding (32-byte hex) — maker fulfilled with an outdated client');
  }
  const intentIdBytes = hexToBytes(intent.intent_id);
  const assetIdBytes = hexToBytes(intent.asset_id);
  const makerPub = hexToBytes(intent.maker_pubkey);
  const keystream = deriveAxintentBlindingKeystream(wallet.priv, makerPub, intentIdBytes, assetIdBytes);
  const rBytes = xor32(hexToBytes(encHex), keystream);
  const rBig = bytes32ToBigint(rBytes);
  if (rBig <= 0n || rBig >= SECP_N) {
    throw new Error('decrypted blinding is out of scalar range — fulfilment ciphertext invalid');
  }
  const rHexClear = bytesToHex(rBytes);

  // Reuse takeAxferOffer's append-and-broadcast logic. recipient_blinding
  // tells verifyAxferOffer to skip ECDH derivation and verify the on-chain
  // commitment against this explicit scalar instead.
  const offer = {
    version: AXFER_OFFER_VERSION,
    network: NET.name,
    asset_id: intent.asset_id,
    ticker: intent.ticker,
    decimals: intent.decimals,
    amount: intent.amount,
    price_sats: intent.price_sats,
    maker_pubkey: intent.maker_pubkey,
    maker_address: intent.maker_address,
    recipient_pubkey: bytesToHex(wallet.pub),
    expiry: intent.expiry,
    commit_txid: intent.commit_txid,
    commit_value: intent.commit_value,
    asset_utxo: intent.asset_utxo,
    partial_reveal: fulfilment.partial_reveal,
    recipient_blinding: rHexClear,
  };
  const result = await takeAxferOffer(offer, { onProgress });
  // takeAxferOffer already recordOpening'd with the verified blinding; the
  // intent path uses the same scalar so no overwrite needed here.
  return result;
}

async function cancelAxferIntent({ assetIdHex, intentIdHex }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const cMsg = _axintentCancelMsg(hexToBytes(assetIdHex), hexToBytes(intentIdHex));
  const sig = signSchnorr(cMsg, wallet.priv);
  const resp = await fetch(withNet(ATOMIC_INTENT_DELETE_URL(assetIdHex, intentIdHex)), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancel_sig: bytesToHex(sig) }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  // Drop the local secret once the worker confirms cancellation. Note that
  // worker cancellation alone does NOT invalidate any partial reveal already
  // signed (the maker would need to spend the asset UTXO via self-send for
  // a true cancel) — but it does mean we won't be re-fulfilling, so the
  // secret can go.
  forgetAxintentSecret(intentIdHex);
  invalidateDiscoverRegistryCache();
  return j;
}

// ============== BID INTENTS (off-chain bid book — SPEC §5.7.7) ==============
// Buyer-initiated mirror of axintents. Bids are PURELY off-chain — buyer
// signs an intent (no on-chain lock), seller claims by spinning up a regular
// §5.7.6 atomic intent targeted at the bidder, bidder takes via the existing
// §5.7.6 take flow. Settlement = T_AXFER, no new wire format.
//
// See SPEC §5.7.7 for the full design including trust analysis.

function _bidIntentMsg(assetIdBytes, bidIdBytes, buyerPubBytes, amount, priceSats, expiry, nonceBytes) {
  const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amount), true);
  const priceLE = new Uint8Array(8);  new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8); new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-bid-intent-v1'),
    assetIdBytes, bidIdBytes, buyerPubBytes,
    amountLE, priceLE, expiryLE,
    nonceBytes,
  ));
}
function _bidClaimMsg(assetIdBytes, bidIdBytes, sellerPubBytes, axintentIdBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-bid-claim-v1'),
    assetIdBytes, bidIdBytes, sellerPubBytes, axintentIdBytes,
  ));
}
function _bidCancelMsg(assetIdBytes, bidIdBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-bid-cancel-v1'),
    assetIdBytes, bidIdBytes,
  ));
}

// Publish a signed bid intent. assetIdHex is the asset to buy; amount is in
// base units; priceSats is the total sats the bidder offers for `amount`
// units; expiry is unix-seconds (≤ 30 days from now). Returns the worker's
// stored intent record.
async function publishBidIntent({ assetIdHex, amount, priceSats, expiry }) {
  if (!WORKER_BASE) throw new Error('worker disabled — bids require worker');
  if (!/^[0-9a-f]{64}$/.test(String(assetIdHex || ''))) throw new Error('invalid asset_id');
  const amt = BigInt(amount);
  if (amt <= 0n || amt >= (1n << 64n)) throw new Error('amount must be > 0 and < 2^64');
  if (!Number.isInteger(priceSats) || priceSats < DUST) throw new Error(`price_sats must be integer ≥ ${DUST}`);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expiry) || expiry <= now) throw new Error('expiry must be in the future');
  if (expiry > now + 30 * 86400) throw new Error('expiry must be within 30 days');

  const buyerPubBytes = wallet.pub;
  const assetIdBytes = hexToBytes(assetIdHex);
  // Random per-bid nonce so a bidder can post multiple independent bids on
  // the same asset; bid_id derives from sha256(asset || pub || nonce)[:16].
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const bidIdBytes = sha256(concatBytes(assetIdBytes, buyerPubBytes, nonceBytes)).slice(0, 16);
  const msg = _bidIntentMsg(assetIdBytes, bidIdBytes, buyerPubBytes, amt, priceSats, expiry, nonceBytes);
  const sig = signSchnorr(msg, wallet.priv);
  const body = {
    bid_id: bytesToHex(bidIdBytes),
    buyer_pubkey: bytesToHex(buyerPubBytes),
    buyer_address: wallet.address(),
    amount: amt.toString(),
    price_sats: priceSats,
    expiry,
    nonce: bytesToHex(nonceBytes),
    intent_sig: bytesToHex(sig),
  };
  const url = `${WORKER_BASE}/assets/${assetIdHex}/bid-intents?network=${encodeURIComponent(NET.name)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `worker returned ${resp.status}`);
  return j.intent;
}

// Browse open bids on an asset (sellers' view). Returns a list of bid
// intents with optional `claim` field if a seller has already claimed.
async function browseBidIntents(assetIdHex) {
  if (!WORKER_BASE) return { count: 0, intents: [] };
  if (!/^[0-9a-f]{64}$/.test(String(assetIdHex || ''))) throw new Error('invalid asset_id');
  const url = `${WORKER_BASE}/assets/${assetIdHex}/bid-intents?network=${encodeURIComponent(NET.name)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`worker returned ${resp.status}`);
  return resp.json();
}

// Cancel a bid (only the bidder can; cancel_sig is signed under buyer_pubkey).
async function cancelBidIntent(assetIdHex, bidIdHex) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const assetIdBytes = hexToBytes(assetIdHex);
  const bidIdBytes = hexToBytes(bidIdHex);
  const msg = _bidCancelMsg(assetIdBytes, bidIdBytes);
  const sig = signSchnorr(msg, wallet.priv);
  const url = `${WORKER_BASE}/assets/${assetIdHex}/bid-intents/${bidIdHex}?network=${encodeURIComponent(NET.name)}`;
  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancel_sig: bytesToHex(sig) }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `worker returned ${resp.status}`);
  return j;
}

// Seller flow: fulfil a bid by publishing a §5.7.6 atomic intent and linking
// it to the bid claim. The atomic intent is an open one — by §5.7.6 design
// any taker who derives recipBlinding via ECDH can claim, but only the
// bidder is incentivized to (the seller has signalled to them via the bid
// claim). The bidder takes priority via the existing 5-min claim TTL.
//
// The seller picks (or auto-splits) a UTXO matching the bid's amount, posts
// the atomic intent via publishAxferIntent (which broadcasts the commit tx
// and registers it on the worker), then signs + POSTs the bid claim.
async function fulfilBidIntent({ bid, sellerUtxo }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  if (!bid || !bid.bid_id || !bid.asset_id) throw new Error('invalid bid');
  // Auto-pick a UTXO of the right amount if the caller didn't pass one. If no
  // single UTXO matches the bid amount exactly, auto-split via self-CXFER —
  // mirrors the listing flow so sellers don't have to consolidate manually
  // before fulfilling.
  if (!sellerUtxo) {
    const holdings = await scanHoldings();
    const h = holdings.get(bid.asset_id);
    if (!h || h.utxos.length === 0) throw new Error('you hold none of this asset');
    const wantAmt = BigInt(bid.amount);
    if (h.balance < wantAmt) throw new Error(`insufficient balance: hold ${h.balance}, bid wants ${wantAmt}`);
    const exact = h.utxos.find(u => u.amount === wantAmt);
    if (exact) {
      sellerUtxo = exact;
    } else {
      const sorted = [...h.utxos].sort((a, b) => Number(a.amount - b.amount));
      const cover = sorted.find(u => u.amount >= wantAmt);
      if (!cover) throw new Error('no single UTXO covers bid amount — consolidate first via Send to your own address');
      if (!ensureBurnerBackedUp('Auto-split UTXO before fulfilling bid (one extra CXFER from your active wallet)')) {
        throw new Error('cancelled');
      }
      const need = await estimateSatsForOp('cxfer');
      if (!(await ensureSatsFunded(need, 'Auto-split before fulfilling bid'))) throw new Error('cancelled');
      const splitResult = await buildAndBroadcastCXferMulti({
        assetIdHex: bid.asset_id,
        recipients: [{ pubHex: bytesToHex(wallet.pub), amount: wantAmt }],
        forceUtxos: [cover],
      });
      const r0 = splitResult.recipients[0];
      // The reveal tx is broadcast but mempool.space's UTXO listing may not
      // yet reflect the new output. publishAxferIntent below calls
      // scanHoldings → getUtxos which would miss the freshly-minted UTXO.
      // Wait for the reveal tx to be visible before proceeding.
      await waitForTxVisible(splitResult.revealTxid);
      sellerUtxo = {
        utxo: { txid: splitResult.revealTxid, vout: r0.vout },
        amount: wantAmt,
        blinding: r0.blinding,
      };
    }
  }
  if (!sellerUtxo.utxo) throw new Error('invalid seller UTXO shape');
  if (BigInt(sellerUtxo.amount) !== BigInt(bid.amount)) {
    throw new Error('seller UTXO amount must equal bid amount');
  }
  // Build + broadcast the atomic intent (commit tx + worker post).
  // publishAxferIntent registers via /atomic-intents and returns the
  // worker's intent_id, which we link from the bid claim.
  const offer = await publishAxferIntent({
    utxoTxid: sellerUtxo.utxo.txid,
    utxoVout: sellerUtxo.utxo.vout,
    priceSats: Number(bid.price_sats),
    expiry: bid.expiry,  // align axintent expiry with bid expiry
  });
  // Sign + POST the bid claim.
  const assetIdBytes = hexToBytes(bid.asset_id);
  const bidIdBytes = hexToBytes(bid.bid_id);
  const axIdBytes = hexToBytes(offer.intent_id);
  const claimMsg = _bidClaimMsg(assetIdBytes, bidIdBytes, wallet.pub, axIdBytes);
  const claimSig = signSchnorr(claimMsg, wallet.priv);
  const url = `${WORKER_BASE}/assets/${bid.asset_id}/bid-intents/${bid.bid_id}/claim?network=${encodeURIComponent(NET.name)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seller_pubkey: bytesToHex(wallet.pub),
      axintent_id: offer.intent_id,
      sig: bytesToHex(claimSig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `claim POST returned ${resp.status}`);
  return { offer, claim: j.claim };
}

// ============== MINT BUILDER ==============
// Issuer creates an additional supply commitment for an existing mintable asset_id.
// Structure mirrors CETCH (commit + reveal Taproot script-path), but the envelope
// is T_MINT and the new UTXO at reveal vout=0 is the issuer's. mint_authority
// must be the wallet's xonly pubkey (so we can sign).
async function buildAndBroadcastCMint({ assetIdHex, etchTxidHex, amount, onProgress = null }) {
  const _progress = (stage) => { try { onProgress && onProgress(stage); } catch {} };
  const amt = BigInt(amount);
  if (amt <= 0n || amt >= (1n << BigInt(N_BITS))) {
    throw new Error(`mint amount must be 1..${(1n << BigInt(N_BITS)) - 1n} base units`);
  }
  // Sanity: asset_id must derive from etch_txid+vout=0.
  const aidBytes = hexToBytes(assetIdHex);
  const derivedAid = assetIdFor(etchTxidHex, 0);
  for (let i = 0; i < 32; i++) {
    if (aidBytes[i] !== derivedAid[i]) throw new Error('asset_id does not match etch_txid');
  }
  // Sanity: wallet must be the mint_authority on the CETCH envelope.
  const meta = getAssetMeta(assetIdHex);
  const myXonlyHex = bytesToHex(wallet.xonly());
  if (!meta?.mintable) throw new Error('asset is not mintable');
  if (meta.mintAuthorityHex !== myXonlyHex) throw new Error('this wallet is not the mint authority');

  const feeRate = await getFeeRate();
  const revealVb = estCMintRevealVb();
  const revealFee = feeFor(revealVb, feeRate);
  const commitValue = DUST + revealFee;

  const allUtxos = await getUtxos(wallet.address());
  const sats = allUtxos.filter(u => u.value > DUST).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0; let commitFee = 500;
  for (const u of sats) {
    picked.push(u); total += u.value;
    commitFee = feeFor(estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + DUST) break;
  }
  if (total < commitValue + commitFee) throw new Error(`insufficient sats (need ~${commitValue + commitFee}, have ${total}). Use the faucet.`);

  // Anchor: first commit input outpoint (same pattern as CETCH so an issuer
  // wallet can re-derive (amount, blinding) of every mint from chain alone).
  const firstIn = picked[0];
  const anchorBytes = concatBytes(
    reverseBytes(hexToBytes(firstIn.txid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, firstIn.vout >>> 0, true); return b; })(),
  );
  const blinding = deriveMintBlinding(wallet.priv, anchorBytes);
  const amountKs = deriveMintAmountKeystream(wallet.priv, anchorBytes);
  const encryptedAmount = encryptAmount(amt, amountKs);

  const { proof, commitments } = bpRangeAggProve([amt], [blinding]);
  const commitment = pointToBytes(commitments[0]);

  // Issuer signature over the bound mint payload. anchorBytes binds the sig to
  // this specific commit/reveal pair, blocking T_MINT envelope replay.
  const mintMsg = computeMintMsg(aidBytes, anchorBytes, commitment, encryptedAmount);
  const issuerSig = signSchnorr(mintMsg, wallet.priv);

  const payload = encodeCMintPayload({
    assetId: aidBytes,
    etchTxid: hexToBytes(etchTxidHex),
    commitment,
    encryptedAmount,
    rangeproof: proof,
    issuerSig,
  });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const change = total - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (change >= DUST) commitOutputs.push({ value: change, script: p2wpkhScript(wallet.pub) });

  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, picked[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxid = txid(commitTx);
  _progress('commit-start');
  await broadcast(commitHex);

  const revealTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: DUST, script: p2wpkhScript(wallet.pub) }],
  };
  const prevouts = [{ value: commitValue, script: p2trSpk }];
  revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxid = txid(revealTx);
  _progress('reveal-start');
  await broadcastWithRetry(revealHex);

  // Record the issuer's opening so the new minted UTXO is spendable later.
  recordOpening(revealTxid, 0, assetIdHex, amt, blinding);

  {
    const m = getAssetMeta(assetIdHex) || {};
    recordActivity({
      kind: 'mint', ticker: m.ticker || '',
      amount: amt, decimals: m.decimals || 0,
      assetId: assetIdHex, txid: revealTxid,
    });
  }

  return {
    commitTxid, revealTxid, assetIdHex,
    mintAmount: amt, mintBlinding: blinding,
    commitFee, revealFee,
  };
}

// ============== BURN BUILDER ==============
// Anyone holding asset UTXOs can burn an amount they choose. Outputs:
//   - (optional) 1 change commitment for the burner (vout=0) — created if change > 0
// Burned amount is public in the envelope. Kernel sig binds (asset_id, inputs,
// outputs, burned_amount) and verifies under E' = Σ C_out + burned·H − Σ C_in.
async function buildAndBroadcastCBurn({ assetIdHex, amount, onProgress = null }) {
  const _progress = (stage) => { try { onProgress && onProgress(stage); } catch {} };
  const burnAmt = BigInt(amount);
  if (burnAmt <= 0n || burnAmt >= (1n << BigInt(N_BITS))) {
    throw new Error(`burn amount must be 1..${(1n << BigInt(N_BITS)) - 1n} base units`);
  }
  const holdings = await scanHoldings();
  const h = holdings.get(assetIdHex);
  if (!h) throw new Error(`no holdings for asset ${assetIdHex}`);
  if (h.balance < burnAmt) throw new Error(`insufficient balance: have ${h.balance}, need ${burnAmt}`);

  const sortedUtxos = [...h.utxos].sort((a, b) => Number(b.amount - a.amount));
  const pickedAssetUtxos = []; let inAmt = 0n; let inBlindingSum = 0n;
  for (const x of sortedUtxos) {
    pickedAssetUtxos.push(x); inAmt += x.amount; inBlindingSum = modN(inBlindingSum + BigInt(x.blinding));
    if (inAmt >= burnAmt) break;
  }
  const changeAmt = inAmt - burnAmt;
  const hasChange = changeAmt > 0n;

  // Anchor for change blinding (only used if there's change).
  const firstAssetIn = pickedAssetUtxos[0].utxo;
  const anchorBytes = concatBytes(
    reverseBytes(hexToBytes(firstAssetIn.txid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, firstAssetIn.vout >>> 0, true); return b; })(),
  );

  let outputs = [];
  let aggProof = new Uint8Array(0);
  let changeBlinding = 0n;
  if (hasChange) {
    changeBlinding = deriveChangeBlinding(wallet.priv, anchorBytes, 0);
    const { proof, commitments } = bpRangeAggProve([changeAmt], [changeBlinding]);
    aggProof = proof;
    const changeCt = encryptAmount(changeAmt, deriveAmountKeystreamSelf(wallet.priv, anchorBytes, 0));
    outputs = [{ commitment: pointToBytes(commitments[0]), encryptedAmount: changeCt }];
  }

  // E' = C_change + burnedAmount·H − Σ C_in   ⇒  excess = changeBlinding − Σ inBlindings
  const excess = modN(changeBlinding - inBlindingSum);

  const inputOutpoints = pickedAssetUtxos.map(x => ({ txid: x.utxo.txid, vout: x.utxo.vout }));
  const outputCommitments = outputs.map(o => o.commitment);
  const assetIdBytes = hexToBytes(assetIdHex);
  const kernelMsg = computeKernelMsg(assetIdBytes, inputOutpoints, outputCommitments, burnAmt);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excess));

  const payload = encodeCBurnPayload({
    assetId: assetIdBytes,
    burnedAmount: burnAmt,
    kernelSig,
    outputs,
    rangeproof: aggProof,
  });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const feeRate = await getFeeRate();
  const numAssetIn = pickedAssetUtxos.length;
  const numExtraOuts = outputs.length;
  const revealVb = estCBurnRevealVb({ numChangeOuts: hasChange ? numExtraOuts : 0, numAssetIn });
  const revealFee = feeFor(revealVb, feeRate);

  const senderP2wpkh = p2wpkhScript(wallet.pub);
  const totalOutputDust = DUST * numExtraOuts;
  const assetInputTotal = pickedAssetUtxos.reduce((s, u) => s + u.utxo.value, 0);
  let satsChange = 0;
  let commitValue = totalOutputDust + revealFee - assetInputTotal;
  if (commitValue < DUST) {
    commitValue = DUST + revealFee;
    satsChange = commitValue + assetInputTotal - totalOutputDust - revealFee;
  }
  if (satsChange < DUST) satsChange = 0;

  const allUtxos = await getUtxos(wallet.address());
  const assetUtxoKeys = new Set(pickedAssetUtxos.map(x => `${x.utxo.txid}:${x.utxo.vout}`));
  const sats = allUtxos
    .filter(u => !assetUtxoKeys.has(`${u.txid}:${u.vout}`))
    .filter(u => u.value > DUST)
    .sort((a, b) => b.value - a.value);
  const pickedSats = []; let totalSats = 0; let commitFee = 500;
  for (const u of sats) {
    pickedSats.push(u); totalSats += u.value;
    commitFee = feeFor(estCommitVb(pickedSats.length), feeRate);
    if (totalSats >= commitValue + commitFee + DUST) break;
  }
  if (totalSats < commitValue + commitFee) {
    throw new Error(`insufficient sats for commit (need ~${commitValue + commitFee}, have ${totalSats})`);
  }
  const commitChange = totalSats - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (commitChange >= DUST) commitOutputs.push({ value: commitChange, script: p2wpkhScript(wallet.pub) });

  const commitTx = {
    version: 2, locktime: 0,
    inputs: pickedSats.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: commitOutputs,
  };
  for (let i = 0; i < commitTx.inputs.length; i++) {
    commitTx.inputs[i].witness = signP2wpkhInput(commitTx, i, pickedSats[i].value);
  }
  const commitHex = bytesToHex(serializeTx(commitTx));
  const commitTxid = txid(commitTx);
  _progress('commit-start');
  await broadcast(commitHex);

  const revealOutputs = outputs.length > 0
    ? [{ value: DUST, script: senderP2wpkh }]
    : [];
  if (satsChange >= DUST) revealOutputs.push({ value: satsChange, script: senderP2wpkh });
  // BURN with no outputs and no sats change still needs at least one output for
  // the tx to be valid; route the satsChange to the wallet (or pad with DUST).
  if (revealOutputs.length === 0) {
    revealOutputs.push({ value: DUST, script: senderP2wpkh });
  }
  const revealTx = {
    version: 2, locktime: 0,
    inputs: [
      { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
      ...pickedAssetUtxos.map(x => ({ txid: x.utxo.txid, vout: x.utxo.vout, sequence: 0xfffffffd, witness: [] })),
    ],
    outputs: revealOutputs,
  };
  const prevouts = [
    { value: commitValue, script: p2trSpk },
    ...pickedAssetUtxos.map(x => ({ value: x.utxo.value, script: p2wpkhScript(wallet.pub) })),
  ];
  revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  for (let i = 1; i < revealTx.inputs.length; i++) {
    revealTx.inputs[i].witness = signP2wpkhInput(revealTx, i, prevouts[i].value);
  }
  const revealHex = bytesToHex(serializeTx(revealTx));
  const revealTxid = txid(revealTx);
  _progress('reveal-start');
  await broadcastWithRetry(revealHex);
  // Hint the worker so the burn record (and a counter bump for the change
  // CXFER, if any) lands without waiting on the cron tick.
  postHint(revealTxid, 0);

  if (hasChange) recordOpening(revealTxid, 0, assetIdHex, changeAmt, changeBlinding);

  {
    const m = getAssetMeta(assetIdHex) || {};
    recordActivity({
      kind: 'burn', ticker: m.ticker || '',
      amount: burnAmt, decimals: m.decimals || 0,
      assetId: assetIdHex, txid: revealTxid,
    });
  }

  return {
    commitTxid, revealTxid, assetIdHex,
    burnedAmount: burnAmt, changeAmount: changeAmt,
    commitFee, revealFee,
  };
}

// ============== SATS SEND (plain Bitcoin out of tacit address) ==============
// Lets a user move plain bitcoin out of their tacit wallet's address — e.g.
// recovering leftover sats after using "Top up tacit" and not consuming all of
// it on tacit ops. The on-chain mechanic is a normal P2WPKH spend; the only
// tacit-specific concern is making absolutely sure no asset UTXO is spent as
// plain sats. A 546-sat asset UTXO carries a confidential commitment whose
// value is provably > 0 via the Pedersen commitment + bulletproof rangeproof;
// spending it as plain bitcoin destroys the commitment with no recovery path.
//
// Defense layers (must ALL pass for a UTXO to be selected as a sats input):
//   1) NOT in scanHoldings()'s asset-utxo / ghost-utxo set. This is the
//      canonical answer; same code that drives Holdings UI.
//   2) Value > DUST. Tacit asset outputs are exactly DUST (546). Real
//      funding-sats UTXOs are typically thousands+. Rejecting the entire
//      dust band is a cheap sanity backstop in case (1) ever has a bug.
// If scanHoldings() throws or returns falsy → HARD ABORT. We never proceed
// without ground-truth on which UTXOs are asset-bearing.

// Strict P2WPKH bech32 v0 decoder. Returns { hrp, version: 0, program: 20 bytes }
// or null. Mixed-case rejected per BIP-173. Programs other than 20 bytes (i.e.
// P2WSH at 32 bytes, or anything wrong) are rejected — the dapp only
// understands sending to P2WPKH receive addresses.
//
// P2TR (bech32m v1) is intentionally NOT supported in this revision. Adding it
// requires the vendor bundle to export `bech32m`, which it currently doesn't.
// Recipients holding P2TR-only addresses can route through any other wallet.
function decodeP2wpkhAddress(addr) {
  if (typeof addr !== 'string' || addr.length < 14 || addr.length > 90) return null;
  // BIP-173: address must be all-lowercase or all-uppercase. Mixed case → reject.
  const lower = addr.toLowerCase();
  if (addr !== lower && addr !== addr.toUpperCase()) return null;
  let decoded;
  try { decoded = bech32.decode(lower); } catch { return null; }
  if (!decoded.words || decoded.words.length === 0) return null;
  const version = decoded.words[0];
  if (version !== 0) return null; // not v0
  let program;
  try { program = bech32.fromWords(decoded.words.slice(1)); } catch { return null; }
  if (program.length !== 20) return null; // P2WPKH must be 20-byte program (P2WSH would be 32)
  return { hrp: decoded.prefix, version: 0, program: new Uint8Array(program) };
}

// Build the script for an arbitrary P2WPKH address. Used to construct the
// recipient output of a sats-send. Network HRP is checked against current NET
// at the call site, not here.
function p2wpkhScriptFromProgram(program20) {
  if (!(program20 instanceof Uint8Array) || program20.length !== 20) {
    throw new Error('program must be 20 bytes (P2WPKH hash160)');
  }
  return concatBytes(new Uint8Array([0x00, 0x14]), program20);
}

// Filter the user's address UTXOs down to plain-sats inputs that are SAFE to
// spend in a non-tacit P2WPKH transaction. `holdings` MUST be the result of a
// successful scanHoldings() call — passing null/undefined throws to prevent
// "scan failed → assume no asset UTXOs → spend everything" footguns.
function selectSatsUtxosSafe(allUtxos, holdings) {
  if (!holdings || !(holdings instanceof Map)) {
    throw new Error('asset-utxo classifier unavailable: scanHoldings() must succeed before sats-send. Aborting for safety.');
  }
  // Build the canonical "do not spend as sats" set from holdings. Both validated
  // asset utxos and ghost utxos (validation incomplete but parent might be tacit)
  // are excluded. Better to refuse a legitimate sats UTXO than spend a tacit one.
  // Pending T_PMINT UTXOs (audit fix #1) are also excluded — same DUST output
  // shape as a credited mint, so a sats-send would silently destroy the
  // commitment and the user's eventual cap-credit.
  const exclude = new Set();
  for (const h of holdings.values()) {
    for (const u of (h.utxos || []))    exclude.add(`${u.utxo?.txid || u.txid}:${u.utxo?.vout ?? u.vout}`);
    for (const g of (h.ghosts || []))   exclude.add(`${g.utxo?.txid || g.txid}:${g.utxo?.vout ?? g.vout}`);
    for (const i of (h.inflated || [])) exclude.add(`${i.utxo?.txid || i.txid}:${i.utxo?.vout ?? i.vout}`);
    for (const p of (h.pending || []))  exclude.add(`${p.utxo?.txid || p.txid}:${p.utxo?.vout ?? p.vout}`);
  }
  return (allUtxos || []).filter(u => {
    const key = `${u.txid}:${u.vout}`;
    if (exclude.has(key)) return false;       // gate 1
    if ((u.value || 0) <= DUST) return false; // gate 2: dust band is asset territory
    return true;
  });
}

// Vbyte estimate for a plain P2WPKH-only spend. Tx structure: marker+flag (2) +
// version(4) + locktime(4) + counts(2) + n×(36+1+4) inputs + 1+m×(8+1+22)
// outputs + n×(1+71+1+34) witness. We use the same per-input/output constants
// the rest of the dapp does to stay consistent with broadcast-time fee calc.
function estSatsSendVb(numInputs, hasChange) {
  const numOutputs = 1 + (hasChange ? 1 : 0);
  return 11 + numInputs * inputVbytes + numOutputs * p2wpkhOutVbytes;
}

// Build an unsigned sats-send tx given preselected inputs + outputs. Caller
// signs with signP2wpkhInput per input. Pure helper, no network or storage.
function buildSatsSendTx({ inputs, recipientScript, recipientValue, changeScript, changeValue }) {
  const outputs = [{ value: recipientValue, script: recipientScript }];
  if (changeValue > 0) outputs.push({ value: changeValue, script: changeScript });
  return {
    version: 2, locktime: 0,
    inputs: inputs.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs,
  };
}

// End-to-end sats-send: validate, classify, pick, build, sign, broadcast.
// Throws on any precondition failure — caller surfaces the message in the UI.
// Returns { txid, inputsSpent, recipientValue, changeValue, fee, feeRate }.
async function buildAndBroadcastSatsSend({ recipientAddr, amountSats }) {
  // (1) Address validation. Strict P2WPKH only. HRP must match current NET.
  const decoded = decodeP2wpkhAddress(recipientAddr);
  if (!decoded) throw new Error('recipient is not a valid P2WPKH bech32 address');
  if (decoded.hrp !== NET.hrp) throw new Error(`recipient address is for ${decoded.hrp === 'bc' ? 'mainnet' : decoded.hrp === 'tb' ? 'signet/testnet' : decoded.hrp}, current network is ${NET.name}`);

  // (2) Amount validation. Positive integer at minimum DUST.
  const amt = Number.isFinite(amountSats) ? Math.floor(amountSats) : NaN;
  if (!Number.isInteger(amt) || amt <= 0) throw new Error('amount must be a positive integer (sats)');
  if (amt < DUST) throw new Error(`amount must be at least ${DUST} sats (dust limit)`);

  // (3) Ground-truth holdings for the asset-UTXO exclusion set. If this throws,
  // we MUST bail — no fallback to "assume nothing is asset UTXO."
  const holdings = await scanHoldings();
  if (!holdings || !(holdings instanceof Map)) {
    throw new Error('could not classify asset UTXOs (holdings scan failed); not safe to send. Try again or hit ↻ Refresh first.');
  }

  // (4) UTXO classification + selection.
  const allUtxos = await getUtxos(wallet.address());
  const sats = selectSatsUtxosSafe(allUtxos, holdings).sort((a, b) => b.value - a.value);
  if (sats.length === 0) {
    throw new Error('no plain-sats UTXOs available to send. Top up first, or all your sats are bound up in asset commitments.');
  }

  // (5) Greedy input picking + fee estimate. Iterate growing the input set until
  // amount + fee fits; recompute fee each iteration since vbytes scale with n.
  const feeRate = await getFeeRate();
  const recipientScript = p2wpkhScriptFromProgram(decoded.program);
  const changeScript = p2wpkhScript(wallet.pub);
  let picked = [], total = 0, fee = 0, hasChange = false, change = 0;
  for (let i = 0; i < sats.length; i++) {
    picked.push(sats[i]); total += sats[i].value;
    // Try with-change (assume change > DUST). If change ends up <= DUST, recompute
    // without-change (donate dust to fee).
    const feeWithChange = feeFor(estSatsSendVb(picked.length, true), feeRate);
    if (total >= amt + feeWithChange + DUST) {
      fee = feeWithChange;
      change = total - amt - fee;
      hasChange = true;
      break;
    }
    const feeNoChange = feeFor(estSatsSendVb(picked.length, false), feeRate);
    if (total >= amt + feeNoChange) {
      fee = feeNoChange;
      change = 0;
      hasChange = false;
      break;
    }
  }
  if (fee === 0) {
    const have = total;
    throw new Error(`insufficient sats: have ${have}, need ${amt} + fees (~${feeFor(estSatsSendVb(picked.length, hasChange), feeRate)})`);
  }

  // (6) Belt-and-suspenders re-classification on the FINAL picked set. Catches
  // any race where holdings changed between the scan and the build (e.g. a
  // CXFER landed mid-flow). If any picked input has reentered the asset set,
  // hard-abort.
  const recheck = await scanHoldings();
  if (recheck && recheck instanceof Map) {
    const reExclude = new Set();
    for (const h of recheck.values()) {
      for (const u of (h.utxos || []))    reExclude.add(`${u.utxo?.txid || u.txid}:${u.utxo?.vout ?? u.vout}`);
      for (const g of (h.ghosts || []))   reExclude.add(`${g.utxo?.txid || g.txid}:${g.utxo?.vout ?? g.vout}`);
      for (const i of (h.inflated || [])) reExclude.add(`${i.utxo?.txid || i.txid}:${i.utxo?.vout ?? i.vout}`);
      for (const p of (h.pending || []))  reExclude.add(`${p.utxo?.txid || p.txid}:${p.utxo?.vout ?? p.vout}`);
    }
    for (const u of picked) {
      if (reExclude.has(`${u.txid}:${u.vout}`)) {
        throw new Error('one of the selected inputs is now classified as an asset UTXO (race with concurrent scan). Aborted for safety. Refresh and retry.');
      }
    }
  }

  // (7) Assemble + sign + broadcast.
  const tx = buildSatsSendTx({
    inputs: picked,
    recipientScript,
    recipientValue: amt,
    changeScript,
    changeValue: change,
  });
  for (let i = 0; i < tx.inputs.length; i++) {
    tx.inputs[i].witness = signP2wpkhInput(tx, i, picked[i].value);
  }
  const txHex = bytesToHex(serializeTx(tx));
  const sentTxid = txid(tx);
  await broadcast(txHex);
  return {
    txid: sentTxid,
    inputsSpent: picked.map(u => ({ txid: u.txid, vout: u.vout, value: u.value })),
    recipientValue: amt,
    changeValue: change,
    fee,
    feeRate,
  };
}

// ============== UTXO OPENING (publish) ==============
// Per-UTXO opening publication. Wallet signs (asset_id, txid, vout, amount,
// blinding, owner_pubkey) under BIP-340; worker verifies Pedersen binding +
// owner ownership before storing. Pedersen alone makes the opening unforgeable;
// the signature gates publication so a CXFER counterparty (who legitimately
// learned the opening) cannot dox the holder by republishing on their behalf.
function openingMsg(assetIdBytes, txidHex, vout, amountBigint, blindingBytes, ownerPubBytes) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  const amountLE = new Uint8Array(8);
  new DataView(amountLE.buffer).setBigUint64(0, BigInt(amountBigint), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-opening-v1'),
    assetIdBytes,
    txidBE,
    voutLE,
    amountLE,
    blindingBytes,
    ownerPubBytes,
  ));
}

async function publishOpening({ assetIdHex, txidHex, vout, amount, blinding }) {
  if (!WORKER_BASE) throw new Error('worker disabled (WORKER_BASE empty)');
  const blindingBytes = bigintToBytes32(blinding);
  const ownerPubBytes = wallet.pub; // 33-byte compressed
  const msg = openingMsg(
    hexToBytes(assetIdHex),
    txidHex,
    vout,
    amount,
    blindingBytes,
    ownerPubBytes,
  );
  const sig = signSchnorr(msg, wallet.priv);
  const resp = await fetch(withNet(UTXO_OPENING_URL(txidHex, vout)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: amount.toString(),
      blinding: bytesToHex(blindingBytes),
      owner_pubkey: bytesToHex(ownerPubBytes),
      sig: bytesToHex(sig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

// ============== RANGE DISCLOSURE ("balance ≥ K" without revealing balance) ==============
// Soundness sketch: C_sum = ΣC_i = a_sum·H + r_sum·G (homomorphic over the
// listed UTXOs). The prover commits to v = a_sum − K under the same blinding:
// C' = C_sum − K·H = v·H + r_sum·G. A bulletproof on C' bounds v ∈ [0, 2⁶⁴),
// so a_sum ≥ K. Verifier only needs the on-chain commitments, K, and the proof
// — never sees a_sum or r_sum.

function disclosureMsg(assetIdBytes, utxos, thresholdBig, rangeproofBytes, ownerPubBytes) {
  const N = utxos.length;
  if (N > 0xffff) throw new Error('disclosure: too many utxos');
  const refsBytes = new Uint8Array(N * 36);
  for (let i = 0; i < N; i++) {
    refsBytes.set(reverseBytes(hexToBytes(utxos[i].txid)), i * 36);
    new DataView(refsBytes.buffer, refsBytes.byteOffset + i * 36 + 32, 4)
      .setUint32(0, utxos[i].vout >>> 0, true);
  }
  const nLE = new Uint8Array(2);
  new DataView(nLE.buffer).setUint16(0, N, true);
  const thresholdLE = new Uint8Array(8);
  new DataView(thresholdLE.buffer).setBigUint64(0, BigInt(thresholdBig), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-disclosure-v1'),
    assetIdBytes,
    nLE,
    refsBytes,
    thresholdLE,
    rangeproofBytes,
    ownerPubBytes,
  ));
}

async function proveRangeDisclosure({ assetIdHex, threshold, holding }) {
  if (!WORKER_BASE) throw new Error('worker disabled (WORKER_BASE empty)');
  if (!holding?.utxos?.length) throw new Error('no openable UTXOs');
  const K = BigInt(threshold);
  if (K <= 0n || K >= (1n << BigInt(N_BITS))) throw new Error('threshold out of (0, 2^64)');

  // Homomorphic sum across all of the holder's UTXOs for this asset.
  let aSum = 0n, rSum = 0n;
  for (const u of holding.utxos) {
    aSum = aSum + u.amount;
    rSum = modN(rSum + u.blinding);
  }
  if (aSum < K) throw new Error(`insufficient balance: have ${aSum}, threshold ${K}`);
  const v = aSum - K;
  if (v < 0n || v >= (1n << BigInt(N_BITS))) {
    // Reachable only if a_sum ≥ 2^64 + K (e.g. > 8 UTXOs each near 2^64). Real
    // balances stay well under 2^64; surface a clear error if hit.
    throw new Error('(balance − threshold) does not fit in 64 bits — split or consolidate UTXOs and retry');
  }

  // Generate the bulletproof on (v, rSum). The commitment from the proof is
  // C' = v·H + rSum·G, which equals C_sum − K·H by construction.
  const { proof } = bpRangeAggProve([v], [rSum]);

  const utxoRefs = holding.utxos.map(u => ({ txid: u.utxo.txid, vout: u.utxo.vout }));
  const ownerPubBytes = wallet.pub;
  const msg = disclosureMsg(hexToBytes(assetIdHex), utxoRefs, K, proof, ownerPubBytes);
  const sig = signSchnorr(msg, wallet.priv);

  const resp = await fetch(withNet(DISCLOSURES_URL(assetIdHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      utxos: utxoRefs,
      threshold: K.toString(),
      rangeproof: bytesToHex(proof),
      owner_pubkey: bytesToHex(ownerPubBytes),
      sig: bytesToHex(sig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

// Consumer-side disclosure verifier (SPEC §5.6 verifier requirements).
//   1. 0 < K < 2⁶⁴.
//   2. For every listed UTXO: parent tx exists; vout's scriptpubkey is P2WPKH
//      whose 20-byte hash equals HASH160(owner_pubkey); parent's
//      vin[0].witness[1] decodes as a tacit envelope; getParentEnvelopeData
//      returns a commitment with the declared asset_id.
//   3. BIP-340 Schnorr verify of `sig` over disclosure_msg under x-only(owner).
//   4. Bulletproof verifies on C' = (Σ on-chain C_i) − K·H.
//
// Returns { ok: true } on success, { ok: false, reason } on rejection.
// `fetchTx` is an async (txid) => parent-tx (mempool.space shape) — same
// contract as validateOutpoint's. Failures fail closed (return false) — so a
// missing/unreadable parent tx counts as a rejection, not a throw.
async function verifyDisclosure(disclosure, fetchTx) {
  try {
    const assetIdHex   = String(disclosure.asset_id   || '').toLowerCase();
    const ownerPubHex  = String(disclosure.owner_pubkey || '').toLowerCase();
    const sigHex       = String(disclosure.sig || '').toLowerCase();
    const rangeproofHex = String(disclosure.rangeproof || '').toLowerCase();
    const thresholdStr = String(disclosure.threshold ?? '');
    const utxosRaw     = Array.isArray(disclosure.utxos) ? disclosure.utxos : null;

    if (!/^[0-9a-f]{64}$/.test(assetIdHex))         return { ok: false, reason: 'asset_id malformed' };
    if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex))   return { ok: false, reason: 'owner_pubkey malformed' };
    if (!/^[0-9a-f]{128}$/.test(sigHex))            return { ok: false, reason: 'sig malformed' };
    if (!/^[0-9a-f]+$/.test(rangeproofHex) || rangeproofHex.length % 2) return { ok: false, reason: 'rangeproof not hex' };
    if (!/^\d+$/.test(thresholdStr))                return { ok: false, reason: 'threshold malformed' };
    if (!utxosRaw || !utxosRaw.length || utxosRaw.length > 64) return { ok: false, reason: 'utxos count out of range (1..64)' };

    // (1) range bound on K
    const K = BigInt(thresholdStr);
    if (K <= 0n || K >= (1n << BigInt(N_BITS))) return { ok: false, reason: 'threshold out of (0, 2^64)' };

    // (2) per-UTXO ownership + asset_id consistency, accumulating C_sum on the way.
    const ownerPubBytes = hexToBytes(ownerPubHex);
    const expectHash160 = bytesToHex(hash160(ownerPubBytes));
    const utxos = [];
    let Csum = secp.ProjectivePoint.ZERO;
    for (const u of utxosRaw) {
      const txidHex = String(u?.txid || '').toLowerCase();
      const vout    = u?.vout;
      if (!/^[0-9a-f]{64}$/.test(txidHex)) return { ok: false, reason: 'utxo.txid malformed' };
      if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) return { ok: false, reason: 'utxo.vout out of range' };
      utxos.push({ txid: txidHex, vout });

      const tx = await fetchTx(txidHex);
      if (!tx?.vout?.[vout]?.scriptpubkey) return { ok: false, reason: `utxo ${txidHex}:${vout}: scriptpubkey missing` };
      const spk = hexToBytes(tx.vout[vout].scriptpubkey);
      if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
        return { ok: false, reason: `utxo ${txidHex}:${vout}: not P2WPKH` };
      }
      if (bytesToHex(spk.slice(2, 22)) !== expectHash160) {
        return { ok: false, reason: `utxo ${txidHex}:${vout}: owner_pubkey does not control this UTXO` };
      }

      const parentWitness = tx?.vin?.[0]?.witness;
      if (!parentWitness || parentWitness.length < 3) return { ok: false, reason: `utxo ${txidHex}:${vout}: parent has no envelope witness` };
      let parentEnv;
      try { parentEnv = decodeEnvelopeScript(hexToBytes(parentWitness[1])); } catch { parentEnv = null; }
      if (!parentEnv) return { ok: false, reason: `utxo ${txidHex}:${vout}: parent envelope decode failed` };
      const pd = getParentEnvelopeData(parentEnv, vout, txidHex);
      if (!pd) return { ok: false, reason: `utxo ${txidHex}:${vout}: parent envelope yields no commitment for vout` };
      if (pd.assetIdHex !== assetIdHex) return { ok: false, reason: `utxo ${txidHex}:${vout}: asset_id mismatch (parent=${pd.assetIdHex})` };

      let Ci;
      try { Ci = bytesToPoint(pd.commitment); } catch { return { ok: false, reason: `utxo ${txidHex}:${vout}: commitment unparseable` }; }
      Csum = Csum.add(Ci);
    }

    const rangeproofBytes = hexToBytes(rangeproofHex);

    // (3) Schnorr sig over canonical disclosure_msg under x-only(owner).
    const msg = disclosureMsg(hexToBytes(assetIdHex), utxos, K, rangeproofBytes, ownerPubBytes);
    if (!verifySchnorr(hexToBytes(sigHex), msg, ownerPubBytes.slice(1))) {
      return { ok: false, reason: 'Schnorr sig invalid' };
    }

    // (4) Bulletproof on C' = C_sum − K·H.
    const Cprime = Csum.add(safeMult(H, K).negate());
    if (!bpRangeAggVerify([Cprime], rangeproofBytes)) {
      return { ok: false, reason: 'rangeproof does not verify against C_sum − K·H' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'verifyDisclosure threw: ' + (e?.message || e) };
  }
}

// ============== LISTINGS (orderbook layer) ==============
// A listing wraps a published opening with price + expiry + maker_address.
// Settlement in v1 is OFF-CHAIN OTC: taker pays maker price_sats via a regular
// Bitcoin tx, then maker manually broadcasts a CXFER to the taker. Atomic
// single-tx settlement is a v1.5 spec relaxation.

function listingMsgBytes(assetIdBytes, txidHex, vout, priceSats, expiry, makerAddress, openingSigBytes) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  const priceLE = new Uint8Array(8);
  new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8);
  new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const addrBytes = new TextEncoder().encode(makerAddress);
  const addrLen = new Uint8Array(2);
  new DataView(addrLen.buffer).setUint16(0, addrBytes.length, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-v1'),
    assetIdBytes, txidBE, voutLE, priceLE, expiryLE, addrLen, addrBytes, openingSigBytes,
  ));
}

function cancelMsgBytes(assetIdBytes, txidHex, vout) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-cancel-v1'),
    assetIdBytes, txidBE, voutLE,
  ));
}

async function publishListing({ assetIdHex, txidHex, vout, amount, blinding, priceSats, expiry, makerAddress }) {
  if (!WORKER_BASE) throw new Error('worker disabled (WORKER_BASE empty)');
  if (!Number.isInteger(priceSats) || priceSats < DUST) throw new Error(`price_sats must be ≥ ${DUST}`);
  if (!Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) throw new Error('expiry must be in the future');

  const blindingBytes = bigintToBytes32(blinding);
  const ownerPubBytes = wallet.pub;
  const oMsg = openingMsg(hexToBytes(assetIdHex), txidHex, vout, amount, blindingBytes, ownerPubBytes);
  const openingSig = signSchnorr(oMsg, wallet.priv);
  const lMsg = listingMsgBytes(hexToBytes(assetIdHex), txidHex, vout, priceSats, expiry, makerAddress, openingSig);
  const listingSig = signSchnorr(lMsg, wallet.priv);

  const resp = await fetch(withNet(LISTINGS_URL(assetIdHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      txid: txidHex,
      vout,
      amount: amount.toString(),
      blinding: bytesToHex(blindingBytes),
      owner_pubkey: bytesToHex(ownerPubBytes),
      opening_sig: bytesToHex(openingSig),
      price_sats: priceSats,
      maker_address: makerAddress,
      expiry,
      listing_sig: bytesToHex(listingSig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

async function cancelListing({ assetIdHex, txidHex, vout }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const cMsg = cancelMsgBytes(hexToBytes(assetIdHex), txidHex, vout);
  const sig = signSchnorr(cMsg, wallet.priv);
  const resp = await fetch(withNet(LISTING_DELETE_URL(assetIdHex, txidHex, vout)), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_pubkey: bytesToHex(wallet.pub),
      cancel_sig: bytesToHex(sig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  // Bust Discover's 60s registry cache so the offer-count badge drops
  // immediately on cards rather than waiting for TTL.
  invalidateDiscoverRegistryCache();
  return j;
}

// Soft claim lock — taker reserves a listing for 5 min so two takers don't
// pay the maker for the same UTXO. Idempotent re-claim by same taker_pubkey.
function claimMsgBytes(assetIdBytes, txidHex, vout, takerPubBytes) {
  const txidBE = reverseBytes(hexToBytes(txidHex));
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, vout >>> 0, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-claim-v1'),
    assetIdBytes, txidBE, voutLE, takerPubBytes,
  ));
}

async function claimListing({ assetIdHex, txidHex, vout }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const takerPubBytes = wallet.pub;
  const cMsg = claimMsgBytes(hexToBytes(assetIdHex), txidHex, vout, takerPubBytes);
  const sig = signSchnorr(cMsg, wallet.priv);
  const resp = await fetch(withNet(LISTING_CLAIM_URL(assetIdHex, txidHex, vout)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taker_pubkey: bytesToHex(takerPubBytes),
      sig: bytesToHex(sig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (resp.status === 409) {
    const remain = j.claim?.expires_at ? Math.max(0, j.claim.expires_at - Math.floor(Date.now()/1000)) : null;
    const extra = remain != null ? ` (held ~${Math.ceil(remain/60)} more min)` : '';
    throw new Error('already claimed by another taker' + extra);
  }
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

// ============== RANGE-DISCLOSED LISTINGS ==============
// Same offer semantics as per-UTXO listings, but only a LOWER BOUND on balance
// is published (via the disclosure rangeproof). Other UTXOs of the maker stay
// confidential. Settlement: maker delivers exactly `available_amount` (=
// threshold) via a regular CXFER once the buyer pays.
function rangeListingMsgBytes(assetIdBytes, threshold, priceSats, expiry, makerAddress, disclosureSigBytes) {
  const priceLE = new Uint8Array(8);
  new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const expiryLE = new Uint8Array(8);
  new DataView(expiryLE.buffer).setBigUint64(0, BigInt(expiry), true);
  const thresholdLE = new Uint8Array(8);
  new DataView(thresholdLE.buffer).setBigUint64(0, BigInt(threshold), true);
  const addrBytes = new TextEncoder().encode(makerAddress);
  const addrLen = new Uint8Array(2);
  new DataView(addrLen.buffer).setUint16(0, addrBytes.length, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-range-v1'),
    assetIdBytes, thresholdLE, priceLE, expiryLE, addrLen, addrBytes, disclosureSigBytes,
  ));
}
function rangeListingCancelMsgBytes(assetIdBytes, ownerPubBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-range-cancel-v1'),
    assetIdBytes, ownerPubBytes,
  ));
}
function rangeListingClaimMsgBytes(assetIdBytes, makerPubBytes, takerPubBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-listing-range-claim-v1'),
    assetIdBytes, makerPubBytes, takerPubBytes,
  ));
}

async function publishRangeListing({ assetIdHex, holding, availableAmount, priceSats, expiry, makerAddress }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  if (!holding?.utxos?.length) throw new Error('no openable UTXOs');
  if (!Number.isInteger(priceSats) || priceSats < DUST) throw new Error(`price_sats must be ≥ ${DUST}`);
  if (!Number.isInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) throw new Error('expiry must be in the future');
  const K = BigInt(availableAmount);
  if (K <= 0n || K >= (1n << BigInt(N_BITS))) throw new Error('available_amount out of (0, 2^64)');
  let aSum = 0n, rSum = 0n;
  for (const u of holding.utxos) {
    aSum = aSum + u.amount;
    rSum = modN(rSum + u.blinding);
  }
  if (aSum < K) throw new Error(`insufficient balance: have ${aSum}, asking ${K}`);
  const v = aSum - K;
  if (v < 0n || v >= (1n << BigInt(N_BITS))) {
    throw new Error('(balance − available) doesn\'t fit in 64 bits — consolidate UTXOs and retry');
  }
  const { proof } = bpRangeAggProve([v], [rSum]);
  const utxoRefs = holding.utxos.map(u => ({ txid: u.utxo.txid, vout: u.utxo.vout }));
  const ownerPubBytes = wallet.pub;
  const dMsg = disclosureMsg(hexToBytes(assetIdHex), utxoRefs, K, proof, ownerPubBytes);
  const disclosureSig = signSchnorr(dMsg, wallet.priv);
  const lMsg = rangeListingMsgBytes(hexToBytes(assetIdHex), K, priceSats, expiry, makerAddress, disclosureSig);
  const listingSig = signSchnorr(lMsg, wallet.priv);
  const resp = await fetch(withNet(RANGE_LISTINGS_URL(assetIdHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      utxos: utxoRefs,
      threshold: K.toString(),
      rangeproof: bytesToHex(proof),
      owner_pubkey: bytesToHex(ownerPubBytes),
      disclosure_sig: bytesToHex(disclosureSig),
      price_sats: priceSats,
      maker_address: makerAddress,
      expiry,
      listing_sig: bytesToHex(listingSig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

async function cancelRangeListing({ assetIdHex }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const ownerPubBytes = wallet.pub;
  const cMsg = rangeListingCancelMsgBytes(hexToBytes(assetIdHex), ownerPubBytes);
  const sig = signSchnorr(cMsg, wallet.priv);
  const resp = await fetch(withNet(RANGE_LISTING_DELETE_URL(assetIdHex, bytesToHex(ownerPubBytes))), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancel_sig: bytesToHex(sig) }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  invalidateDiscoverRegistryCache();
  return j;
}

async function claimRangeListing({ assetIdHex, makerPubHex }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const takerPubBytes = wallet.pub;
  const cMsg = rangeListingClaimMsgBytes(hexToBytes(assetIdHex), hexToBytes(makerPubHex), takerPubBytes);
  const sig = signSchnorr(cMsg, wallet.priv);
  const resp = await fetch(withNet(RANGE_LISTING_CLAIM_URL(assetIdHex, makerPubHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taker_pubkey: bytesToHex(takerPubBytes),
      sig: bytesToHex(sig),
    }),
  });
  const j = await resp.json().catch(() => ({}));
  if (resp.status === 409) {
    const remain = j.claim?.expires_at ? Math.max(0, j.claim.expires_at - Math.floor(Date.now()/1000)) : null;
    const extra = remain != null ? ` (held ~${Math.ceil(remain/60)} more min)` : '';
    throw new Error('already claimed by another taker' + extra);
  }
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
  return j;
}

async function validateRangeListingFully(lst) {
  try {
    const ownerPubBytes = hexToBytes(lst.owner_pubkey);
    const xonly = ownerPubBytes.slice(1);
    const ownerHash160Hex = bytesToHex(hash160(ownerPubBytes));
    const K = BigInt(lst.threshold);
    if (K <= 0n || K >= (1n << BigInt(N_BITS))) return { ok: false, reason: 'threshold out of range' };
    let CSum = ZERO;
    for (const u of lst.utxos) {
      let parentTx;
      try { parentTx = await getTx(u.txid); }
      catch (e) { return { ok: false, reason: `utxo ${u.txid}:${u.vout} parent not found: ${e.message}` }; }
      const out = parentTx?.vout?.[u.vout];
      if (!out?.scriptpubkey) return { ok: false, reason: `utxo ${u.txid}:${u.vout} missing scriptpubkey` };
      const spk = hexToBytes(out.scriptpubkey);
      if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14
          || bytesToHex(spk.slice(2, 22)) !== ownerHash160Hex) {
        return { ok: false, reason: `utxo ${u.txid}:${u.vout} not P2WPKH owned by owner_pubkey` };
      }
      const wit = parentTx?.vin?.[0]?.witness;
      if (!wit || wit.length < 3) return { ok: false, reason: `utxo ${u.txid}:${u.vout} parent has no envelope` };
      let env;
      try { env = decodeEnvelopeScript(hexToBytes(wit[1])); } catch { env = null; }
      if (!env) return { ok: false, reason: `utxo ${u.txid}:${u.vout} no tacit envelope` };
      const pd = getParentEnvelopeData(env, u.vout, u.txid);
      if (!pd) return { ok: false, reason: `utxo ${u.txid}:${u.vout} cannot resolve commitment` };
      if (pd.assetIdHex !== lst.asset_id) return { ok: false, reason: `utxo ${u.txid}:${u.vout} asset mismatch` };
      const sp = await getOutspend(u.txid, u.vout).catch(() => null);
      if (!sp || sp.spent) return { ok: false, reason: `utxo ${u.txid}:${u.vout} spent — listing stale` };
      CSum = CSum.add(bytesToPoint(pd.commitment));
    }
    const dMsg = disclosureMsg(hexToBytes(lst.asset_id), lst.utxos, K, hexToBytes(lst.rangeproof), ownerPubBytes);
    if (!verifySchnorr(hexToBytes(lst.disclosure_sig), dMsg, xonly)) return { ok: false, reason: 'disclosure sig fails' };
    const lMsg = rangeListingMsgBytes(hexToBytes(lst.asset_id), K, lst.price_sats, lst.expiry, lst.maker_address, hexToBytes(lst.disclosure_sig));
    if (!verifySchnorr(hexToBytes(lst.listing_sig), lMsg, xonly)) return { ok: false, reason: 'listing sig fails' };
    const Cprime = CSum.add(safeMult(H, K).negate());
    if (!bpRangeAggVerify([Cprime], hexToBytes(lst.rangeproof))) return { ok: false, reason: 'bulletproof verification failed' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ============== AIRDROP / SNAPSHOT HELPERS ==============
// Pure helpers for the Drops tab and any future claim portal. No DOM, no
// network. Snapshot model:
//   - Issuer collects (eth_address, amount_in_target_base_units) rows.
//   - Each row becomes a leaf:
//       leaf_i = SHA256("tacit-airdrop-leaf-v1" || eth_addr(20) || amount_LE(8) || index_LE(4))
//     Index is the row position (0-based). Disambiguates same-(addr,amount)
//     entries and lets the claim portal show "you are leaf N".
//   - Tree: binary, sort-pair Merkle (OpenZeppelin-compatible). Inner node:
//       node = SHA256("tacit-airdrop-node-v1" || min(L,R) || max(L,R))
//     Sorted pairs make proofs positionless — no left/right bit per sibling.
//   - Odd layers: last orphan promoted unchanged (no implicit-self-pair).
//
// The full row list lives off-chain (IPFS-pinned JSON). Verifiers fetch it,
// recompute the root, and check it matches the published commitment. The
// merkle root is the public commitment; the Drops tab persists it alongside
// the asset_id + ipfs CID.

const AIRDROP_LEAF_TAG = 'tacit-airdrop-leaf-v1';
const AIRDROP_NODE_TAG = 'tacit-airdrop-node-v1';

function _parseEthAddress(s) {
  if (typeof s !== 'string') throw new Error('eth_address must be a string');
  let a = s.trim();
  if (a.startsWith('0x') || a.startsWith('0X')) a = a.slice(2);
  if (!/^[0-9a-fA-F]{40}$/.test(a)) throw new Error(`invalid eth_address: ${s}`);
  return hexToBytes(a.toLowerCase());
}

function airdropLeafHash(ethAddrBytes, amountBig, indexU32) {
  if (!(ethAddrBytes instanceof Uint8Array) || ethAddrBytes.length !== 20) {
    throw new Error('eth_address must be 20 bytes');
  }
  const amt = BigInt(amountBig);
  if (amt < 0n || amt >= (1n << 64n)) throw new Error('amount out of u64 range');
  const idx = Number(indexU32);
  if (!Number.isInteger(idx) || idx < 0 || idx > 0xffffffff) throw new Error('index out of u32 range');
  const amtLE = new Uint8Array(8);
  new DataView(amtLE.buffer).setBigUint64(0, amt, true);
  const idxLE = new Uint8Array(4);
  new DataView(idxLE.buffer).setUint32(0, idx, true);
  return sha256(concatBytes(
    new TextEncoder().encode(AIRDROP_LEAF_TAG),
    ethAddrBytes, amtLE, idxLE,
  ));
}

function _airdropNodeHash(a, b) {
  let cmp = 0;
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) { cmp = a[i] < b[i] ? -1 : 1; break; }
  }
  const [lo, hi] = cmp <= 0 ? [a, b] : [b, a];
  return sha256(concatBytes(
    new TextEncoder().encode(AIRDROP_NODE_TAG),
    lo, hi,
  ));
}

function buildAirdropMerkle(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error('leaves must be a non-empty array');
  for (const l of leaves) {
    if (!(l instanceof Uint8Array) || l.length !== 32) throw new Error('leaves must be 32-byte arrays');
  }
  if (leaves.length === 1) return { root: leaves[0], layers: [leaves.slice()] };
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 < prev.length) next.push(_airdropNodeHash(prev[i], prev[i + 1]));
      else next.push(prev[i]);
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

function airdropMerkleProof(layers, leafIndex) {
  if (!Array.isArray(layers) || layers.length === 0) throw new Error('empty layers');
  if (leafIndex < 0 || leafIndex >= layers[0].length) throw new Error('leafIndex out of range');
  const proof = [];
  let idx = leafIndex;
  for (let h = 0; h < layers.length - 1; h++) {
    const layer = layers[h];
    const sibIdx = idx ^ 1;
    if (sibIdx < layer.length) proof.push(layer[sibIdx]);
    idx = idx >> 1;
  }
  return proof;
}

function verifyAirdropMerkleProof(leaf, proof, root) {
  if (!(leaf instanceof Uint8Array) || leaf.length !== 32) return false;
  if (!(root instanceof Uint8Array) || root.length !== 32) return false;
  let h = leaf;
  for (const s of proof) {
    if (!(s instanceof Uint8Array) || s.length !== 32) return false;
    h = _airdropNodeHash(h, s);
  }
  return h.length === 32 && h.every((b, i) => b === root[i]);
}

// Tolerant CSV cell splitter. Handles unquoted comma/tab-separated rows and
// double-quoted cells (Etherscan's token-holder export uses these). Internal
// commas inside quoted cells are preserved.
function _splitCSVLine(line) {
  const cells = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    let cell = '';
    if (line[i] === '"') {
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { cell += '"'; i += 2; }
          else { i++; break; }
        } else { cell += line[i]; i++; }
      }
      while (i < n && line[i] !== ',' && line[i] !== '\t') i++;
      if (i < n && (line[i] === ',' || line[i] === '\t')) i++;
    } else if (line[i] === ',' || line[i] === '\t') {
      i++;
    } else {
      while (i < n && line[i] !== ',' && line[i] !== '\t') { cell += line[i]; i++; }
      if (i < n && (line[i] === ',' || line[i] === '\t')) i++;
    }
    cells.push(cell.trim());
  }
  return cells;
}

// Parse one amount cell. Modes:
//   decimals = 0  → integer base units only (rejects "1.5").
//   decimals > 0  → decimal display (e.g. "1234.5678" with decimals=18).
//                   Excess fractional digits past `decimals` are truncated.
function _parseAmountCell(s, decimals) {
  let clean = String(s).trim();
  if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
  clean = clean.replace(/[,\s_]/g, '');
  if (!clean) throw new Error('empty amount');
  if (decimals === 0) {
    if (!/^[0-9]+$/.test(clean)) {
      throw new Error(`amount must be a non-negative integer (saw "${s}"); set sourceDecimals to allow decimal display`);
    }
    return BigInt(clean);
  }
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(clean);
  if (!m) throw new Error(`invalid decimal amount: "${s}"`);
  const intPart = m[1];
  // Truncate excess fractional precision (Etherscan sometimes reports more
  // than `decimals` digits — extra precision is below the smallest unit).
  const fracPart = (m[2] || '').slice(0, decimals);
  const fracPadded = fracPart + '0'.repeat(decimals - fracPart.length);
  return BigInt(intPart) * (10n ** BigInt(decimals)) + BigInt(fracPadded);
}

// Floor-truncate a BigInt amount from sourceDecimals → dstDecimals. When
// dstDecimals > sourceDecimals, scales up (loses no information).
function truncateAmountDecimals(amount, sourceDecimals, dstDecimals) {
  if (sourceDecimals === dstDecimals) return amount;
  if (sourceDecimals > dstDecimals) {
    return amount / (10n ** BigInt(sourceDecimals - dstDecimals));
  }
  return amount * (10n ** BigInt(dstDecimals - sourceDecimals));
}

// Parse a CSV string into snapshot rows. Supports:
//   - Etherscan token-holder export: `"HolderAddress","Balance","PendingBalanceUpdate"`
//     (quoted cells, decimal balance, ignored trailing column)
//   - Plain `address,amount` form (with or without 0x prefix)
//   - Comments (#, //) and blank lines
//   - Header row auto-skipped when the first non-comment line's first cell
//     doesn't start with 0x
//
// opts:
//   sourceDecimals = 0     decimals of the amount column (0 = integer base units)
//   targetDecimals         decimals to floor-truncate to (default = sourceDecimals)
//   blacklist              Set<lowercase 40-char hex> to exclude
//   addressColumn = 0
//   amountColumn  = 1
//
// Returns rows in *targetDecimals* base units. Rows that truncate to 0 (e.g.
// dust holders below the target precision) are dropped — they'd burn an
// output for nothing.
function parseAirdropCSV(csvText, opts = {}) {
  if (typeof csvText !== 'string') throw new Error('csv must be a string');
  const sourceDecimals = Number.isInteger(opts.sourceDecimals) ? opts.sourceDecimals : 0;
  const targetDecimals = Number.isInteger(opts.targetDecimals) ? opts.targetDecimals : sourceDecimals;
  if (sourceDecimals < 0 || sourceDecimals > 36) throw new Error('sourceDecimals must be 0..36');
  if (targetDecimals < 0 || targetDecimals > 36) throw new Error('targetDecimals must be 0..36');
  const blacklist = opts.blacklist instanceof Set ? opts.blacklist : null;
  const addressColumn = Number.isInteger(opts.addressColumn) ? opts.addressColumn : 0;
  const amountColumn = Number.isInteger(opts.amountColumn) ? opts.amountColumn : 1;

  const lines = csvText.split(/\r?\n/);
  const rows = [];
  let assignedIndex = 0;
  let headerSeen = false;
  let droppedDust = 0;     // rows that truncated to 0 (sub-target-precision)
  let droppedBlacklist = 0;
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].trim();
    if (!raw) continue;
    if (raw.startsWith('#') || raw.startsWith('//')) continue;

    const cells = _splitCSVLine(raw);
    if (cells.length <= Math.max(addressColumn, amountColumn)) {
      throw new Error(`csv line ${lineNo + 1}: expected ≥${Math.max(addressColumn, amountColumn) + 1} columns, got ${cells.length}`);
    }
    const addrCell = cells[addressColumn];
    const amtCell = cells[amountColumn];

    // Header detection: skip the first non-comment line if it doesn't look
    // like an address. A 40-hex value with or without a `0x` prefix is data,
    // not header — without this, a header-less CSV whose first row is
    // `aaaa…(40 hex),100` was silently dropping the first holder.
    if (!headerSeen) {
      const stripped = String(addrCell).trim().replace(/^0[xX]/, '');
      if (!/^[0-9a-fA-F]{40}$/.test(stripped)) {
        headerSeen = true;
        continue;
      }
    }
    headerSeen = true;

    let ethAddrBytes;
    try { ethAddrBytes = _parseEthAddress(addrCell); }
    catch (e) { throw new Error(`csv line ${lineNo + 1}: ${e.message}`); }
    const ethAddrHex = bytesToHex(ethAddrBytes);

    if (blacklist && blacklist.has(ethAddrHex)) { droppedBlacklist++; continue; }

    let amount;
    try { amount = _parseAmountCell(amtCell, sourceDecimals); }
    catch (e) { throw new Error(`csv line ${lineNo + 1}: ${e.message}`); }

    if (sourceDecimals !== targetDecimals) {
      amount = truncateAmountDecimals(amount, sourceDecimals, targetDecimals);
    }
    if (amount < 0n) throw new Error(`csv line ${lineNo + 1}: negative amount`);
    if (amount >= (1n << 64n)) throw new Error(`csv line ${lineNo + 1}: amount overflows u64 after conversion to ${targetDecimals} decimals`);
    if (amount === 0n) { droppedDust++; continue; }  // post-truncation dust holder

    rows.push({ ethAddrHex, ethAddrBytes, amount, index: assignedIndex });
    assignedIndex++;
  }
  // Stash drop counts as array properties so the build-preview UI can surface
  // them. Tests that read `rows.length` / iterate `rows` are unaffected.
  rows.droppedDust = droppedDust;
  rows.droppedBlacklist = droppedBlacklist;
  return rows;
}

// Sum amounts across multiple parsed-row arrays by address. Reassigns indexes
// 0..N-1 in sorted-by-address order so the merkle root is stable regardless
// of source-upload ordering. All inputs must already be in the same target
// decimals (parseAirdropCSV with the same targetDecimals).
function mergeAirdropRows(rowSets) {
  if (!Array.isArray(rowSets)) throw new Error('rowSets must be an array');
  const byAddr = new Map();
  for (const rs of rowSets) {
    if (!Array.isArray(rs)) continue;
    for (const r of rs) {
      const key = r.ethAddrHex;
      const existing = byAddr.get(key);
      if (existing) existing.amount += r.amount;
      else byAddr.set(key, { ethAddrBytes: r.ethAddrBytes, amount: r.amount });
    }
  }
  for (const v of byAddr.values()) {
    if (v.amount >= (1n << 64n)) throw new Error('merged amount overflows u64 — split the drop or reduce target decimals');
  }
  const sorted = [...byAddr.entries()]
    .filter(([, v]) => v.amount > 0n)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sorted.map(([ethAddrHex, v], i) => ({
    ethAddrHex, ethAddrBytes: v.ethAddrBytes, amount: v.amount, index: i,
  }));
}

// Parse a free-form blacklist (textarea / file) into a Set of lowercase
// 40-char hex addresses. Lines may include 0x prefix or not, may be a CSV
// row (only the first cell is read), comments and blanks are skipped.
function parseBlacklist(text) {
  if (!text) return new Set();
  if (typeof text !== 'string') throw new Error('blacklist must be a string');
  const out = new Set();
  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].trim();
    if (!raw) continue;
    if (raw.startsWith('#') || raw.startsWith('//')) continue;
    const first = (_splitCSVLine(raw)[0] || '').trim();
    if (!first) continue;
    let hex = first.toLowerCase();
    if (hex.startsWith('0x')) hex = hex.slice(2);
    if (!/^[0-9a-f]{40}$/.test(hex)) {
      throw new Error(`blacklist line ${lineNo + 1}: invalid address "${first}"`);
    }
    out.add(hex);
  }
  return out;
}

// Compute the merkle commitment for a parsed snapshot. Returns
// { rows: [{...row, leaf}], root, layers, total, count, duplicates }.
function computeAirdropCommitment(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows must be non-empty');
  // Detect duplicate addresses — almost always an issuer mistake; surface
  // for confirmation rather than silently include both.
  const seen = new Map();
  const duplicates = [];
  for (const r of rows) {
    if (seen.has(r.ethAddrHex)) duplicates.push({ addr: r.ethAddrHex, indexes: [seen.get(r.ethAddrHex), r.index] });
    else seen.set(r.ethAddrHex, r.index);
  }
  const leaves = rows.map(r => airdropLeafHash(r.ethAddrBytes, r.amount, r.index));
  const { root, layers } = buildAirdropMerkle(leaves);
  const total = rows.reduce((s, r) => s + r.amount, 0n);
  return {
    rows: rows.map((r, i) => ({ ...r, leaf: leaves[i] })),
    root, layers, total, count: rows.length, duplicates,
  };
}

// Serialise a snapshot for IPFS pinning. Stable JSON, no Uint8Array values,
// so any client can re-parse and recompute the root.
function serialiseAirdropSnapshot({ assetIdHex, network, rows, root, ticker, decimals }) {
  return {
    schema: 'tacit-airdrop-v1',
    network,                         // 'signet' or 'mainnet'
    asset_id: assetIdHex,
    asset_ticker: ticker || null,    // convenience for claim portal display + msg
    asset_decimals: Number.isInteger(decimals) ? decimals : null,
    merkle_root: bytesToHex(root),
    leaf_count: rows.length,
    total_amount: rows.reduce((s, r) => s + r.amount, 0n).toString(),
    rows: rows.map(r => ({
      index: r.index,
      eth_address: '0x' + r.ethAddrHex,
      amount: r.amount.toString(),
    })),
  };
}

// ============== AIRDROP CLAIM (recipient-side EIP-191) ==============
// The claim message a recipient signs in MetaMask is a multi-line UTF-8
// string. It binds the merkle root, eth address, leaf index, amount, and
// the tacit pubkey that should receive the airdrop. The signature, plus
// the leaf's merkle proof, are sufficient evidence for the issuer to
// fulfil the claim with confidence:
//   - merkle root + (eth_address, amount, leaf_index) → leaf hash; proof
//     verifies inclusion under the published root
//   - eth signature recovers to the eth_address (proves key custody)
//   - tacit pubkey is bound into the signed message, so the signature can't
//     be replayed to fulfil the airdrop into a different tacit identity
//
// Format (exact byte sequence — any change invalidates the signature):
//
//   tacit airdrop claim v1
//
//   Drop:    <merkle_root_hex>
//   Network: <network>
//   Asset:   <asset_id_hex>
//   Address: 0x<eth_addr_hex>
//   Leaf:    <leaf_index>
//   Amount:  <amount_display> <ticker> (<base_units_decimal>)
//   Tacit:   <tacit_pubkey_hex>
//
//   By signing, you authorize the airdrop issuer to send the above amount
//   of <ticker> to the tacit pubkey listed.
//
// `Asset:` binding closes MED#4 (same merkle root + same recipient list could
// theoretically cover different assets without this binding). Format remains
// v1 since no in-flight signatures exist on mainnet — first signed claim
// will use the format below.
function buildAirdropClaimMsg({ rootHex, network, assetIdHex, ethAddrHex, leafIndex, amount, ticker, decimals, tacitPubHex }) {
  if (!/^[0-9a-f]{64}$/.test(String(rootHex || '').toLowerCase())) throw new Error('rootHex must be 64-hex');
  if (typeof network !== 'string' || !network) throw new Error('network required');
  if (!/^[0-9a-f]{64}$/.test(String(assetIdHex || '').toLowerCase())) throw new Error('assetIdHex must be 64-hex');
  const cleanAddr = String(ethAddrHex).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(cleanAddr)) throw new Error('ethAddrHex must be 40-hex');
  if (!Number.isInteger(leafIndex) || leafIndex < 0) throw new Error('leafIndex required');
  const amt = BigInt(amount);
  if (amt < 0n || amt >= (1n << 64n)) throw new Error('amount out of u64');
  if (typeof ticker !== 'string') throw new Error('ticker required');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('decimals 0..8 (CETCH max)');
  const cleanPub = String(tacitPubHex).toLowerCase().replace(/\s/g, '');
  if (!/^0[23][0-9a-f]{64}$/.test(cleanPub)) throw new Error('tacitPubHex must be 33-byte compressed');
  const display = fmtAssetAmountPlain(amt, decimals);
  const cleanRoot = String(rootHex).toLowerCase();
  const cleanAsset = String(assetIdHex).toLowerCase();
  return [
    'tacit airdrop claim v1',
    '',
    `Drop:    ${cleanRoot}`,
    `Network: ${network}`,
    `Asset:   ${cleanAsset}`,
    `Address: 0x${cleanAddr}`,
    `Leaf:    ${leafIndex}`,
    `Amount:  ${display} ${ticker} (${amt.toString()})`,
    `Tacit:   ${cleanPub}`,
    '',
    `By signing, you authorize the airdrop issuer to send the above amount of ${ticker} to the tacit pubkey listed.`,
  ].join('\n');
}

// EIP-191 personal_sign hash:
//   keccak256("\x19Ethereum Signed Message:\n" + utf8len(msg).toString() + msg)
function eip191Hash(msg) {
  const msgBytes = new TextEncoder().encode(msg);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  return keccak_256(concatBytes(prefix, msgBytes));
}

// Recover the eth address (20-byte) that signed an EIP-191 message. Accepts
// the MetaMask form: 0x-prefixed 132-char hex (r:32 || s:32 || v:1) with
// v ∈ {27, 28}. Also tolerates {0, 1}.
//
// Returns lowercase 40-char hex (no 0x). Throws on malformed sig.
function recoverEthAddrFromSig(msg, sigHex) {
  const clean = String(sigHex).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{130}$/.test(clean)) throw new Error('eth signature must be 65 bytes (130 hex)');
  const r = clean.slice(0, 64);
  const s = clean.slice(64, 128);
  const vByte = parseInt(clean.slice(128, 130), 16);
  let recovery;
  if (vByte === 27 || vByte === 28) recovery = vByte - 27;
  else if (vByte === 0 || vByte === 1) recovery = vByte;
  else throw new Error(`unsupported recovery v: ${vByte}`);
  const sig = secp.Signature.fromCompact(r + s).addRecoveryBit(recovery);
  const msgHash = eip191Hash(msg);
  const pub = sig.recoverPublicKey(msgHash);     // ProjectivePoint
  const pubBytes = pub.toRawBytes(false);         // 65B uncompressed
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) throw new Error('recovered pubkey malformed');
  const xy = pubBytes.slice(1);                   // 64B (X || Y)
  return bytesToHex(keccak_256(xy).slice(12));    // 20B address (lowercase hex)
}

// Canonical signing message for the discovery announcement of a drop. Must
// match worker's `dropAnnounceMsg` byte-for-byte (worker-parity covers it).
// network_byte: 0 = signet, 1 = mainnet (kept stable so future networks slot
// in without breaking sigs over signet/mainnet announcements).
function _dropNetworkByte(network) { return network === 'mainnet' ? 1 : 0; }
function dropAnnounceMsgBytes(network, assetIdHex, rootHex, cidString, expiresAt, noteString) {
  // Defensive validation so bad inputs throw a clear error rather than
  // failing later inside hexToBytes / DataView with a cryptic "Invalid
  // hex" message that's hard to trace back to a missing field.
  if (network !== 'signet' && network !== 'mainnet') throw new Error(`dropAnnounceMsgBytes: invalid network "${network}"`);
  if (!/^[0-9a-f]{64}$/i.test(String(assetIdHex || ''))) throw new Error('dropAnnounceMsgBytes: asset_id must be 64-char hex');
  if (!/^[0-9a-f]{64}$/i.test(String(rootHex || ''))) throw new Error('dropAnnounceMsgBytes: merkle_root must be 64-char hex');
  if (typeof cidString !== 'string' || cidString.length === 0) throw new Error('dropAnnounceMsgBytes: cid required');
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new Error('dropAnnounceMsgBytes: expires_at must be a positive integer unix timestamp');
  const cidBytes = new TextEncoder().encode(cidString);
  const noteBytes = new TextEncoder().encode(noteString || '');
  const cidLen = new Uint8Array(2); new DataView(cidLen.buffer).setUint16(0, cidBytes.length, true);
  const expiresLE = new Uint8Array(8); new DataView(expiresLE.buffer).setBigUint64(0, BigInt(expiresAt), true);
  const noteLen = new Uint8Array(2); new DataView(noteLen.buffer).setUint16(0, noteBytes.length, true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-drop-announce-v1'),
    new Uint8Array([_dropNetworkByte(network)]),
    hexToBytes(assetIdHex.toLowerCase()),
    hexToBytes(rootHex.toLowerCase()),
    cidLen, cidBytes,
    expiresLE,
    noteLen, noteBytes,
  ));
}
function dropAnnounceCancelMsgBytes(network, rootHex, issuerPubHex) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-drop-announce-cancel-v1'),
    new Uint8Array([_dropNetworkByte(network)]),
    hexToBytes(rootHex),
    hexToBytes(issuerPubHex),
  ));
}

// One-shot verify. True iff the sig recovers to expectedEthAddrHex.
function verifyAirdropClaimSig(msg, sigHex, expectedEthAddrHex) {
  try {
    const recovered = recoverEthAddrFromSig(msg, sigHex);
    const expected = String(expectedEthAddrHex).toLowerCase().replace(/^0x/, '');
    return recovered === expected;
  } catch { return false; }
}

// ============== SHARE-LINK ==============
// The rangeproof and kernel sig are on-chain (in the envelope), so the share-link only needs
// to identify the recipient's UTXO and provide the cleartext amount + asset.
// (The blinding is recomputable by the recipient via ECDH from the sender's tx.)
function encodeShareLink(d) {
  const obj = {
    tx: d.txid,           // reveal tx id
    vo: d.vout,           // vout of recipient's commitment in reveal tx
    a:  d.assetIdHex,
    am: d.amount.toString(),
    t:  d.ticker,
    d:  d.decimals,
  };
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return `${location.origin}${location.pathname}#recv=${b64}`;
}
function decodeShareLinkHash(hash) {
  if (!hash || !hash.startsWith('#recv=')) return null;
  try {
    const b64 = hash.slice(6);
    const json = decodeURIComponent(escape(atob(b64)));
    const obj = JSON.parse(json);

    // Strict validation. A malicious share-link could otherwise encode an amount
    // that opens the same Pedersen commitment as a smaller value (because
    // pedersenCommit reduces mod SECP_N), yielding an inflated displayed balance.
    // We also reject malformed hex / out-of-range vouts.
    const txidHex    = String(obj.tx || '').toLowerCase();
    const assetIdHex = String(obj.a  || '').toLowerCase();
    const vout       = Number(obj.vo);
    let amount;
    try { amount = BigInt(obj.am); } catch { return null; }
    const ticker     = typeof obj.t === 'string' ? obj.t : null;
    const decimals   = Number(obj.d);

    if (!/^[0-9a-f]{64}$/.test(txidHex)) return null;
    if (!/^[0-9a-f]{64}$/.test(assetIdHex)) return null;
    if (!Number.isInteger(vout) || vout < 0 || vout > 7) return null;
    if (amount < 0n || amount >= (1n << BigInt(N_BITS))) return null;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) return null;

    return { txid: txidHex, vout, assetIdHex, amount, ticker, decimals };
  } catch { return null; }
}
async function importShareLink(linkOrHash) {
  const hash = linkOrHash.includes('#recv=') ? linkOrHash.slice(linkOrHash.indexOf('#recv=')) : linkOrHash;
  const d = decodeShareLinkHash(hash);
  if (!d) throw new Error('invalid share-link');

  // Set up a tx fetcher with cache so the validator and the local checks below share fetches
  const txCache = new Map();
  const fetchTx = async id => {
    if (txCache.has(id)) return txCache.get(id);
    const t = await getTx(id);
    txCache.set(id, t);
    return t;
  };

  // 1. Recursive client-side validation: walk back to CETCH and verify every step.
  //    Refuse to record an opening for a UTXO that traces to bad ancestry —
  //    otherwise scanHoldings will later silently reject it as "inflated", which is bad UX.
  const validatedSet = new Map();
  const metadataOut = new Map();
  const valid = await validateOutpoint(d.txid, d.vout, validatedSet, fetchTx, 0, metadataOut);
  if (!valid) throw new Error('share-link UTXO failed validation (bad ancestry, kernel sig, or rangeproof)');

  // 2. Canonical metadata comes from the CETCH ancestor we just walked back to.
  //    Don't trust ticker/decimals from the share-link itself.
  const canonical = metadataOut.get(d.assetIdHex);
  if (!canonical) throw new Error('could not locate CETCH ancestor for asset_id');
  const ticker = canonical.ticker;
  const decimals = canonical.decimals;

  // 3. Now resolve the recipient's commitment + verify the share-link's claim opens it
  const tx = await fetchTx(d.txid);
  let senderPubHex = null;
  for (let i = 1; i < tx.vin.length; i++) {
    const w = tx.vin[i].witness;
    if (w && w.length === 2 && w[1].length === 66) { senderPubHex = w[1]; break; }
  }
  if (!senderPubHex) throw new Error('cannot identify sender pubkey from tx witnesses');
  const senderPub = hexToBytes(senderPubHex);

  // Compute the same anchor the sender used: first asset input's outpoint.
  // For CXFER reveal txs, vin[0] is the script-path P2TR (commit) and vin[1] is the
  // first asset input. The sender derived blindings from vin[1]'s outpoint.
  if (tx.vin.length < 2) throw new Error('reveal tx has no asset input');
  const firstAssetIn = tx.vin[1];
  const anchorBytes = concatBytes(
    reverseBytes(hexToBytes(firstAssetIn.txid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, firstAssetIn.vout >>> 0, true); return b; })(),
  );
  const blinding = deriveBlinding(wallet.priv, senderPub, anchorBytes, d.vout);
  const expectedC = pedersenCommit(d.amount, blinding);
  const envBytes = hexToBytes(tx.vin[0].witness[1]);
  const env = decodeEnvelopeScript(envBytes);
  if (!env || env.opcode !== T_CXFER) throw new Error('parent tx is not a CXFER');
  const dec = decodeCXferPayload(env.payload);
  if (!dec || d.vout >= dec.outputs.length) throw new Error('vout outside envelope outputs');
  // Asset_id from envelope must match the share-link's claim (already implied by metadata lookup but check explicitly)
  if (bytesToHex(dec.assetId) !== d.assetIdHex) throw new Error('asset_id mismatch between envelope and share-link');
  const onChainC = dec.outputs[d.vout].commitment;
  if (bytesToHex(pointToBytes(expectedC)) !== bytesToHex(onChainC)) {
    throw new Error('commitment mismatch — share-link does not open the on-chain commitment');
  }
  recordOpening(d.txid, d.vout, d.assetIdHex, d.amount, blinding);
  // Register asset metadata under canonical (CETCH-sourced) values
  if (!getAssetMeta(d.assetIdHex)) {
    registerAsset({ assetIdHex: d.assetIdHex, ticker, decimals, etchTxid: canonical.etchTxid, etchVout: 0, imageUri: canonical.imageUri || null });
  }
  recordActivity({
    kind: 'transfer-in', ticker, amount: d.amount, decimals,
    assetId: d.assetIdHex, txid: d.txid,
  });
  return { ticker, amount: d.amount, decimals, assetIdHex: d.assetIdHex };
}

// ============== UI HELPERS ==============
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const shorten = (s, n = 10) => !s || s.length <= n*2 + 3 ? s : s.slice(0, n) + '…' + s.slice(-n);

// Set transient status text on a small label element ("syncing", "scanning",
// "loading", etc.). Pass `pending: true` to toggle the .live-dots CSS class
// that pulses three trailing dots — strip your own ellipsis from the message
// since the pseudo-element draws them. Pass `pending: false` (default) for
// terminal text like "synced · 5 sat/vB" or "" to clear.
function setStatus(elOrSel, text, pending = false) {
  const el = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('live-dots', !!pending && !!text);
}

// Reusable progress-strip markup for embedding in inline forms (mint /
// burn) where there isn't a fixed DOM slot in index.html. Same 4 steps
// (Build → Commit → Reveal → Pending) — the form's onSubmit drives the
// strip via setProgressStrip(host.querySelector('.progress-strip'), …).
// Hidden by default; shown when broadcast starts.
const PROGRESS_STRIP_HTML = `
  <div class="progress-strip" style="display:none;margin-top:10px;" aria-live="polite">
    <div class="progress-step" data-step="0"><span class="progress-num">1</span><span class="progress-label">Build</span></div>
    <div class="progress-step" data-step="1"><span class="progress-num">2</span><span class="progress-label">Commit</span></div>
    <div class="progress-step" data-step="2"><span class="progress-num">3</span><span class="progress-label">Reveal</span></div>
    <div class="progress-step" data-step="3"><span class="progress-num">4</span><span class="progress-label">Pending</span></div>
  </div>
`;

// Optimistic balance debit applied to a Holdings asset card immediately
// after a successful CXFER broadcast — bridges the 1-2s gap between
// "broadcast resolved" and "next chain scan completes". Replaces the
// rendered .balance text with `prev - delta` and overlays a small "pending
// -X" pill on the card. The next renderHoldings() naturally rebuilds the
// card from the chain-truth balance, replacing both. Pure cosmetic — no
// state is mutated; the card is keyed on data-asset-card-aid (a class +
// data attribute we add to the asset-card root in renderHoldings so this
// helper can find the right card).
function applyOptimisticDebit(assetIdHex, delta) {
  // Find the holdings asset card. We can't use `data-aid` alone because
  // many child buttons share that attribute — find the card root.
  const cards = document.querySelectorAll('#holdings-list > .asset-card');
  let card = null;
  for (const c of cards) {
    if (c.dataset.aid === assetIdHex) { card = c; break; }
  }
  if (!card) return;
  const balanceEl = card.querySelector('.balance');
  if (!balanceEl) return;
  // Parse the current balance text (a fmtAssetAmount-formatted string).
  // We avoid round-tripping through display units by reading a stored
  // `data-base-amount` attr that renderHoldings stamps. Skip if absent —
  // the optimistic update is a nicety, not a correctness path.
  const baseAttr = card.dataset.baseAmount;
  const decAttr = card.dataset.decimals;
  if (!baseAttr || decAttr === undefined) return;
  let prev;
  try { prev = BigInt(baseAttr); }
  catch { return; }
  const dec = parseInt(decAttr, 10);
  if (!Number.isInteger(dec)) return;
  const next = prev > delta ? prev - delta : 0n;
  card.dataset.baseAmount = next.toString();
  // Update the visible balance number (preserve the unit + verified-tag spans).
  const firstTextNode = balanceEl.firstChild;
  if (firstTextNode && firstTextNode.nodeType === Node.TEXT_NODE) {
    firstTextNode.textContent = fmtAssetAmount(next, dec);
  }
  // Overlay a pending pill so the user sees the action took effect — and
  // also that the chain hasn't confirmed yet. Removed by the next full
  // re-render of the card. Idempotent: if a previous debit already left a
  // pill, update its text instead of stacking.
  let pill = card.querySelector('[data-optimistic-pending]');
  const fmtDelta = fmtAssetAmount(delta, dec);
  if (!pill) {
    pill = document.createElement('span');
    pill.setAttribute('data-optimistic-pending', '1');
    pill.className = 'pending-pill';
    balanceEl.appendChild(pill);
  }
  pill.textContent = `pending −${fmtDelta}`;
}

// Drive a progress strip's per-step state. `stripIdOrEl` is the strip
// element (or its id); `activeIdx` is the 0-based index of the in-flight
// step. All steps with index < activeIdx are marked done; the active step
// pulses; later steps stay pending. Pass `activeIdx === -1` to reset all
// steps to pending (used to hide / clean up between flows). Pass
// `errorAt` to mark a step as failed (red dot + label, no pulse).
//
// The strip itself is shown/hidden by the caller — this helper only
// updates classes so the same strip can be reused across flows.
function setProgressStrip(stripIdOrEl, activeIdx, opts = {}) {
  const strip = typeof stripIdOrEl === 'string' ? document.getElementById(stripIdOrEl) : stripIdOrEl;
  if (!strip) return;
  const steps = strip.querySelectorAll('.progress-step');
  const errorAt = Number.isInteger(opts.errorAt) ? opts.errorAt : -1;
  steps.forEach((step, i) => {
    step.classList.remove('done', 'active', 'error');
    if (errorAt === i) step.classList.add('error');
    else if (activeIdx === -1) { /* all pending */ }
    else if (i < activeIdx) step.classList.add('done');
    else if (i === activeIdx) step.classList.add('active');
  });
}

// Numeric badge on a tab — `name` is the tab's data-tab value
// (holdings / market / drops / discover / etc.). Pass 0/null/undefined to
// clear. CSS at .tab[data-count]::after renders the chip when count > 0.
function setTabBadge(name, count) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!tab) return;
  if (count == null || count === 0 || Number.isNaN(count)) tab.removeAttribute('data-count');
  else tab.setAttribute('data-count', String(count > 999 ? '999+' : count));
}

// Set element textContent and briefly flash an orange background if the
// value actually changed (suppresses the flash on first paint and on
// no-op refreshes). The .value-flash class self-clears on animationend
// so the next change can re-trigger. Pass `force: true` for the rare case
// you want to flash without a value change (e.g. confirmed tx receipt).
// Set element text to a numeric value, optionally tweening from the prior
// value over `ms` so the eye reads "this number changed" instead of just
// snapping. fmt() is called per-RAF-frame to render the in-flight number;
// the final value is set verbatim on completion to avoid floating-point
// drift in the displayed string. Stores the canonical numeric value on
// el.dataset.numericValue so successive calls can tween from the actual
// prior numeric, not from a re-parsed comma-formatted string.
//
// Triggers .value-flash on change (same as setIfChanged) so users get both
// signals: orange highlight + count-up. First paint and no-op refreshes
// skip animation. prefers-reduced-motion → snap, no tween.
function setNumberAnimated(elOrSel, value, fmt, ms = 500) {
  const el = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
  if (!el) return;
  const next = Number(value);
  if (!Number.isFinite(next)) { el.textContent = String(value); return; }
  const prevStr = el.dataset.numericValue;
  const prev = prevStr === undefined ? null : Number(prevStr);
  el.dataset.numericValue = String(next);
  // Cancel any in-flight tween on this element so a fast double-update
  // doesn't render two overlapping animations on the same node.
  if (el._tweenRAF) { cancelAnimationFrame(el._tweenRAF); el._tweenRAF = 0; }
  // First paint, no prior, or no real change: snap and bail.
  if (prev === null || !Number.isFinite(prev) || prev === next) {
    el.textContent = fmt(next);
    return;
  }
  // Honor reduced-motion: snap + flash, no tween.
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    el.textContent = fmt(next);
  } else {
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      // ease-out cubic — fast at first, settles into the final value.
      const eased = 1 - Math.pow(1 - t, 3);
      const v = prev + (next - prev) * eased;
      el.textContent = fmt(t < 1 ? v : next);
      if (t < 1) el._tweenRAF = requestAnimationFrame(tick);
      else el._tweenRAF = 0;
    };
    el._tweenRAF = requestAnimationFrame(tick);
  }
  // Replay-trick (same as setIfChanged) so back-to-back changes both flash.
  el.classList.remove('value-flash');
  void el.offsetWidth;
  el.classList.add('value-flash');
  if (!el._valueFlashWired) {
    el._valueFlashWired = true;
    el.addEventListener('animationend', e => {
      if (e.animationName === 'value-flash') el.classList.remove('value-flash');
    });
  }
}

function setIfChanged(elOrSel, text, force = false) {
  const el = typeof elOrSel === 'string' ? document.querySelector(elOrSel) : elOrSel;
  if (!el) return;
  const next = String(text == null ? '' : text);
  const prev = el.textContent;
  el.textContent = next;
  if (!force && (prev === '' || prev === '—' || prev === next)) return;
  // Replay-trick: remove the class, force a reflow, re-add. Without the
  // reflow, removing-and-immediately-adding the class is collapsed by the
  // browser into a no-op and the animation never restarts on the second
  // change in a row.
  el.classList.remove('value-flash');
  void el.offsetWidth;
  el.classList.add('value-flash');
  if (!el._valueFlashWired) {
    el._valueFlashWired = true;
    el.addEventListener('animationend', e => {
      if (e.animationName === 'value-flash') el.classList.remove('value-flash');
    });
  }
}

// Mark assets whose ticker is shared by ≥ 2 active assets in the supplied
// list. Tickers in tacit are free-form CETCH bytes; nothing prevents an
// etcher from cloning a popular asset's ticker string to phish takers. The
// on-chain identifier (asset_id = sha256(etch_txid_BE || vout_LE)) is the
// only canonical reference; in addition we surface "first-etched wins" by
// marking the chronologically-earliest asset for that ticker as `original`
// and every later collision as `duplicate`. Pure on-chain-derived signal:
// the timestamp comes from the etch tx's block_time, so the verdict is the
// same for every observer no matter which worker they query. No centralized
// allowlist or "verified by" blessing — just objective facts.
//
// Mutates each asset with `_tickerCollision`:
//   `false`      — ticker is unique in the supplied list
//   `'original'` — multiple assets share this ticker; this one etched first
//   `'duplicate'`— multiple assets share this ticker; this one is later
function markTickerCollisions(assets) {
  if (!Array.isArray(assets)) return;
  // Group by normalized ticker.
  const groups = new Map();
  for (const a of assets) {
    const t = (a?.ticker || '').trim().toLowerCase();
    if (!t) { a._tickerCollision = false; continue; }
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(a);
  }
  for (const [, group] of groups) {
    if (group.length < 2) {
      group[0]._tickerCollision = false;
      continue;
    }
    // First-etched wins. Order primarily by etched_at_height (block height
    // is the chain's canonical ordering); fall back to etched_at unix time
    // when height is missing (pending entries pre-confirmation), then to
    // asset_id lex for fully-deterministic tie-breaking.
    group.sort((x, y) => {
      const xh = Number.isInteger(x.etched_at_height) ? x.etched_at_height : Infinity;
      const yh = Number.isInteger(y.etched_at_height) ? y.etched_at_height : Infinity;
      if (xh !== yh) return xh - yh;
      const xt = Number(x.etched_at) || 0, yt = Number(y.etched_at) || 0;
      if (xt !== yt) return xt - yt;
      return String(x.asset_id || '').localeCompare(String(y.asset_id || ''));
    });
    group[0]._tickerCollision = 'original';
    for (let i = 1; i < group.length; i++) group[i]._tickerCollision = 'duplicate';
  }
}
// Asset-metadata `external_url` fields are issuer-controlled. Even with HTML
// attribute escaping, an `href="javascript:…"` (or `data:`, `vbscript:`, etc.)
// would execute the moment a user clicks. Restrict to https:// — anything
// else returns null and the caller shouldn't render the link at all.
function safeExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  return u.href;
}
const fmtSats = n => Number(n).toLocaleString('en-US');
function fmtAssetAmount(amt, decimals) {
  const a = BigInt(amt);
  if (decimals === 0) return a.toLocaleString('en-US');
  const div = 10n ** BigInt(decimals);
  const whole = a / div;
  const frac = a % div;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return whole.toLocaleString('en-US') + (fracStr ? '.' + fracStr : '');
}

// Normalize a user-provided asset image URI for safe rendering in <img>.
// Returns an HTTP(S) URL through the configured IPFS gateway, or null.
//
// Accepted: ipfs://CID, or a bare CID (Qm… | bafy…). Direct https:// URLs
// are deliberately NOT accepted: every wallet that views the asset would
// fetch from the issuer-controlled host, which is an IP-correlation beacon
// and a privacy leak. Forcing IPFS routes traffic through the configured
// gateway — one fixed origin that the CSP locks down at img-src.
function normalizeImageUri(uri) {
  if (!uri) return null;
  const s = String(uri).trim();
  if (!s) return null;
  let cid = null;
  const ipfsMatch = s.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
  if (ipfsMatch) cid = ipfsMatch[1];
  // bare CID v0 (Qm…) or v1 (bafy…)
  else if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s)) cid = s;
  else if (/^baf[a-z0-9]{50,80}$/i.test(s)) cid = s;
  if (cid) return `${IPFS_GATEWAY}${cid}`;
  return null;
}
// Render the supply-attestation badge that flags an asset as having a
// cryptographically verified Pedersen opening. For IPFS-source attestations
// we make the (IPFS) suffix a subtle dotted-underline link to the metadata
// blob's gateway URL with the CID in the tooltip — anyone can fetch the same
// bytes and re-run pedersenCommit(supply, blinding) == on-chain commitment
// without trusting the worker. Worker-cache attestations stay non-link.
function supplyAttestBadge(attestSource, imageUri) {
  if (attestSource === 'ipfs') {
    const gatewayUrl = normalizeImageUri(imageUri);
    const m = String(imageUri || '').match(/^(?:ipfs:\/\/)?([A-Za-z0-9]+)/);
    const cid = m ? m[1] : '';
    const ipfsTag = gatewayUrl
      ? `<a href="${escapeHtml(gatewayUrl)}" target="_blank" rel="noopener" title="${cid ? 'metadata CID ' + escapeHtml(cid) + ' — ' : ''}open in IPFS gateway" style="color:inherit;border-bottom:1px dotted currentColor;">IPFS</a>`
      : 'IPFS';
    return `<span title="(supply, blinding) opening fetched from IPFS and verified to open the on-chain commitment. Content-addressed — anyone can re-verify from chain + IPFS alone, no worker trust required.">✓ verified supply (${ipfsTag})</span>`;
  }
  return '<span title="(supply, blinding) opening fetched from the worker\'s cache and verified to open the on-chain commitment. IPFS is the primary attestation channel; this is a fast discovery cache. Same crypto either way.">✓ verified supply (worker cache)</span>';
}

// Validate a URI for storage in CETCH (UTF-8 bytes ≤ 256, must normalize successfully)
function validateImageUriForEtch(uri) {
  if (!uri) return null; // empty is fine — image is optional
  const s = String(uri).trim();
  if (!s) return null;
  if (new TextEncoder().encode(s).length > 256) throw new Error('image URI too long (max 256 bytes)');
  if (!normalizeImageUri(s)) throw new Error('image URI must be ipfs://CID or a bare CID (Qm… or bafy…). Direct https:// is rejected to keep viewer IPs out of issuer-controlled logs.');
  return s;
}
// ============== ASSET CARD HELPERS ==============
// Shared building blocks for the asset cards on Holdings, Discover, and the
// recent-etches tile grid. Lifting them keeps the markup consistent and
// avoids drift when one render is updated and the other isn't.

// Short/expand asset_id row — primary cause of UI drift across renders.
// Both Holdings and Discover want the same "8-char default + click-to-expand"
// behavior; this helper emits the markup and the parent render wires the
// click via [data-toggle-id].
function assetIdRowHTML(assetIdHex) {
  return `<span class="short-id-row" data-toggle-id>
              <span class="short mono-box inline">${escapeHtml(shorten(assetIdHex, 8))}</span>
              <span class="full mono-box inline">${escapeHtml(assetIdHex)}</span>
              <span class="toggle">expand</span>
            </span>`;
}

// Wire all asset-id short/expand toggles inside a container. Idempotent: each
// toggle's onclick handler is replaced, not stacked. Call after innerHTML.
function wireAssetIdToggles(container) {
  if (!container) return;
  container.querySelectorAll('[data-toggle-id]').forEach(row => {
    const toggle = row.querySelector('.toggle');
    if (!toggle) return;
    toggle.onclick = () => {
      const expanded = row.classList.toggle('expanded');
      toggle.textContent = expanded ? 'collapse' : 'expand';
    };
  });
}

function toast(msg, kind = '', ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Cross-tab deep-link target. Set when a Wallet-tab tile is clicked; consumed
// by renderDiscover after the tab's cards are mounted. Cleared on first use
// so a stale value can't re-fire a scroll on the next renderDiscover() call.
let pendingDiscoverFocus = null;

// Cross-tab deep-link target for Market — set when a Discover card's "view
// offers" badge is clicked. Consumed by renderMarket / applyMarketFilters
// after the Market tab mounts: the asset_id is dropped into the search box
// to filter the listings down to one asset. Cleared after first consumption.
let pendingMarketFilter = null;

// Lander recent-etches sort. 'recent' = worker order (newest first);
// 'active' = composite cumulative activity (transfers + offers + mints +
// burns). Persisted in localStorage so a user who picks "active" doesn't
// have to re-pick every reload. Read at module load to seed the initial
// renderRecentEtches.
let _landerSort = (() => {
  try { return localStorage.getItem('tacit-lander-sort-v1') === 'active' ? 'active' : 'recent'; }
  catch { return 'recent'; }
})();

// ============== TABS ==============
function setupTabs() {
  $$('.tab').forEach(tab => {
    tab.onclick = () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $('#tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'wallet') { refreshWallet(); renderRecentEtches(); }
      if (tab.dataset.tab === 'holdings') { renderHoldings(); renderOffers(); renderActivity(); }
      if (tab.dataset.tab === 'transfer') { refreshAssetSelect(); refreshRecipientRecents(); updateDerivedAddressHint(); refreshSatsSendBalance(); }
      if (tab.dataset.tab === 'drops') refreshDropsTab();
      if (tab.dataset.tab === 'claim') refreshClaimTab();
      if (tab.dataset.tab === 'discover') renderDiscover();
      if (tab.dataset.tab === 'market') renderMarket();
    };
  });
}

// ============== WALLET ==============
// Threshold below which we surface the demo-drip / manual-faucet buttons.
// One drip = 20K sats; an etch or transfer needs ~5–10K. Below 10K means
// "running low" — hide the drip CTA above this so the buttons only appear
// when actually useful.
const FAUCET_VISIBLE_BELOW_SATS = 10000;
// Demo drip is hidden if the faucet wallet itself can't fund a single drip
// (avoids the "faucet has no UTXOs" dead-end click).
const FAUCET_READY_MIN_SATS = 30000;
async function checkFaucetReady() {
  if (!WORKER_BASE) return false;
  // Faucet is signet-only by design (the worker holds a signet wallet). Don't
  // even probe /balance on mainnet — the response would be misleading.
  if (NET.name !== 'signet') return false;
  try {
    const resp = await fetch(WORKER_BASE + '/balance');
    if (!resp.ok) return false;
    const j = await resp.json();
    return (j.balance || 0) >= FAUCET_READY_MIN_SATS;
  } catch { return false; }
}
// Single source of truth for the wallet card's secondary visuals: which
// primary-action buttons surface, the mode/backup badges, the backup-warn
// box. refreshWallet() always calls into this so the card's appearance
// stays in sync with (network, ext-wallet state, balance, backup ack).
//
// State is *merged* across calls. refreshWallet() passes fresh balance +
// faucetReady; other call sites (renderExtWalletPanel after a connect, ack
// / import handlers) call with no args, which would otherwise wipe the
// last known balance back to null and resurrect the faucet button. The
// module-scope cache below preserves the last value across those re-renders.
const _walletCardState = { balance: null, faucetReady: false };
function renderWalletCard(patch = {}) {
  if (patch.balance !== undefined) _walletCardState.balance = patch.balance;
  if (patch.faucetReady !== undefined) _walletCardState.faucetReady = patch.faucetReady;
  const balance = _walletCardState.balance;
  const faucetReady = _walletCardState.faucetReady;
  const onSignet = NET.name === 'signet';
  const userLow = balance == null || balance < FAUCET_VISIBLE_BELOW_SATS;
  const hasExt = !!wallet.ext;

  // Primary-action buttons. Connect buttons are surfaced only when no ext
  // wallet is bound and the user could plausibly want to bind one (i.e. on
  // any network). Top-up shows when ext is connected. Drip/manual-faucet
  // are signet-only and gated on a low balance.
  const dripBtn = $('#btn-drip');
  const manualFaucetBtn = $('#btn-faucet');
  const fundBtn = $('#btn-ext-fund');
  const xBtn = $('#btn-ext-connect-xverse');
  const uBtn = $('#btn-ext-connect-unisat');
  const pkBtn = $('#btn-passkey-add');
  if (dripBtn) dripBtn.style.display = (onSignet && userLow && FAUCET_URL && faucetReady) ? '' : 'none';
  if (manualFaucetBtn) manualFaucetBtn.style.display = (onSignet && userLow) ? '' : 'none';
  if (fundBtn) fundBtn.style.display = hasExt ? '' : 'none';
  if (xBtn) xBtn.style.display = hasExt ? 'none' : '';
  if (uBtn) uBtn.style.display = hasExt ? 'none' : '';
  // Passkey upgrade affordance: parallel to the ext-connect buttons. Shown
  // only for local-passphrase users who could plausibly upgrade — not when
  // already in passkey mode (redundant), not when an ext is bound (the
  // welcome flow treats ext / passkey / local as exclusive paths and we
  // preserve that here to avoid an unintended dual-mode state), and not
  // when WebAuthn is unsupported / the page isn't a secure context.
  if (pkBtn) {
    const inPasskey = wallet.mode === 'passkey';
    const passkeyOk = typeof prfWallet !== 'undefined' && prfWallet.available();
    pkBtn.style.display = (passkeyOk && !inPasskey && !hasExt) ? '' : 'none';
  }
  if (!onSignet || !userLow) { const fp = $('#faucet-panel'); if (fp) fp.style.display = 'none'; }

  // Mode badge.
  const modeEl = $('#wallet-mode-badge');
  if (modeEl) {
    if (hasExt && wallet.ext.provider) {
      const label = wallet.ext.provider === 'sats-connect' ? 'xverse / leather' : wallet.ext.provider;
      modeEl.textContent = `· via ${label}`;
      modeEl.style.color = 'var(--ink-mid)';
    } else {
      modeEl.textContent = onSignet ? '· signet demo' : '';
      modeEl.style.color = 'var(--ink-mid)';
    }
  }

  // Backup badge + warn box.
  const backupEl = $('#wallet-backup-badge');
  const warnEl = $('#wallet-backup-warn');
  if (wallet.mode === 'passkey') {
    if (backupEl) { backupEl.textContent = '· passkey'; backupEl.style.color = 'var(--orange)'; }
    if (warnEl) warnEl.style.display = 'none';
  } else {
    const backedUp = isBurnerBackedUp();
    if (backupEl) {
      backupEl.textContent = backedUp ? '· ✓ backed up' : '· ⚠ not backed up';
      backupEl.style.color = backedUp ? 'var(--green)' : 'var(--red)';
    }
    if (warnEl) warnEl.style.display = backedUp ? 'none' : '';
  }

  // External-wallet info card inside the Manage Wallet drawer. The dl/dt/dd
  // grid was authored statically, but the values come from renderExtWalletPanel
  // which we still call separately; here we just toggle the wrapper visibility.
  const extInfoEl = $('#ext-wallet-connected-info');
  if (extInfoEl) extInfoEl.style.display = hasExt ? '' : 'none';

  // Saved passkeys list. renderPasskeyPanel hides #passkey-wallet-info when
  // the PRF map is empty, so this is a no-op for password/ext users. Calling
  // it here means a network flip refreshes the per-row tb1…/bc1… preview
  // (the address is computed at render time from the persisted pubkey).
  renderPasskeyPanel();
}

async function refreshWallet() {
  $('#w-address').textContent = wallet.address();
  $('#w-pubkey').textContent = wallet.pubHex();
  $('#explorer-link').href = `${NET.explorer}/address/${wallet.address()}`;
  setStatus('#wallet-status', 'syncing', true);
  // Render with conservative defaults immediately so badges and connect/faucet
  // visibility update the instant a refresh starts; the network result below
  // re-renders with the actual balance.
  renderWalletCard({ balance: null, faucetReady: false });
  try {
    const [utxos, height, rate, faucetReady] = await Promise.all([
      getUtxos(wallet.address()),
      getTip(),
      getFeeRate(),
      checkFaucetReady(),
    ]);
    const balance = utxos.reduce((a, u) => a + u.value, 0);
    setNumberAnimated('#w-balance', balance, fmtSats, 600);
    setIfChanged('#w-height', height);
    setStatus('#wallet-status', `synced · ${rate} sat/vB`);
    renderWalletCard({ balance, faucetReady });
  } catch (e) {
    setStatus('#wallet-status', 'offline: ' + e.message);
  }
}
function setupWalletButtons() {
  $('#btn-refresh').onclick = refreshWallet;
  // Lock: reload. `wallet.priv` is module-memory only, so a reload drops the
  // unlocked key and the next page load will prompt for the passphrase.
  const lockBtn = $('#btn-lock');
  if (lockBtn) lockBtn.onclick = () => location.reload();
  // Generic copy-to-clipboard handler for any element marked with
  // `data-copy-target="<element-id>"`. Reads .textContent of the target
  // (so users always copy what they see, not a stale state), invokes
  // navigator.clipboard, surfaces a toast. Falls back silently on browsers
  // without the API or on permission denial — the underlying mono-box is
  // still triple-click-selectable.
  document.querySelectorAll('.btn-copy[data-copy-target]').forEach(btn => {
    btn.onclick = async () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      const text = (target.textContent || '').trim();
      if (!text || text === '—') return;
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied', 'success', 1500);
      } catch {
        toast('Clipboard unavailable; select the value manually.', '', 2500);
      }
    };
  });
  $('#btn-export').onclick = async () => {
    if (wallet.mode === 'passkey') {
      try {
        const { priv } = await prfLogin({ credentialId: prfWallet.state?.credentialId });
        prompt('Your private key (hex). Save somewhere safe — there is no recovery:', bytesToHex(priv));
        priv.fill(0);
      } catch (e) { toast('Export cancelled: ' + e.message, 'error'); }
      return;
    }
    prompt('Your private key (hex). Save somewhere safe — there is no recovery:', bytesToHex(wallet.priv));
    if (!isBurnerBackedUp() && confirm('Mark this burner key as backed up?\n\nClick OK only if you copied the hex above to a safe location. This skips the export prompt before future tacit operations.')) {
      markBurnerBackedUp();
      toast('Burner key marked as backed up.', 'success');
      setupNetworkSelect();
    }
  };
  $('#btn-import').onclick = async () => {
    // Importing replaces the currently-loaded wallet identity in this network /
    // ext-binding slot. If the user hasn't exported the existing key, those
    // tokens become unrecoverable. Match the symmetric warning used by btn-regen.
    if (wallet.priv) {
      if (!confirm('Importing replaces the wallet currently loaded in this slot. If you haven\'t exported the existing key, the tokens it controls will become unrecoverable.\n\nProceed?')) return;
    }
    const v = prompt('Paste private key (hex, 64 chars):');
    if (!v) return;
    try { await wallet.setPriv(v, wallet.ext?.address || null); toast('Wallet imported', 'success'); refreshWallet(); renderExtWalletPanel(); }
    catch (e) { toast('Import failed: ' + e.message, 'error'); }
  };
  $('#btn-regen').onclick = async () => {
    if (!confirm('Generate a new wallet? Your old key will be replaced (export it first if you want to keep it).')) return;
    try { await wallet.regenerate(wallet.ext?.address || null); toast('New wallet generated', 'success'); refreshWallet(); renderExtWalletPanel(); }
    catch (e) { toast('Wallet regeneration cancelled: ' + e.message, ''); }
  };
  const dripBtn = $('#btn-drip');
  if (!FAUCET_URL) { dripBtn.disabled = true; dripBtn.title = 'demo drip disabled (no Worker)'; }
  dripBtn.onclick = async () => {
    if (!FAUCET_URL) return;
    dripBtn.disabled = true;
    const orig = dripBtn.textContent;
    dripBtn.textContent = 'Dripping…';
    try {
      const resp = await fetch(FAUCET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: wallet.address() }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
      toast(`Drip sent: ${j.amount_sats} sats${j.txid ? ' · tx ' + j.txid.slice(0, 10) + '…' : ''}`, 'success');
      // Wait long enough for mempool.space's address-UTXO index to pick up the new tx.
      setTimeout(refreshWallet, 4000);
    } catch (e) {
      toast(`Drip failed: ${e.message}`, 'error');
    } finally {
      dripBtn.disabled = false;
      dripBtn.textContent = orig;
    }
  };
  $('#btn-faucet').onclick = async () => {
    try { await navigator.clipboard.writeText(wallet.address()); } catch {}
    $('#faucet-panel').style.display = 'block';
    toast('Address copied to clipboard');
  };
}

// ============== ETCH UI ==============
let pendingCEtch = null;
async function uploadImageToPinata(file) {
  if (!PIN_URL) throw new Error('upload disabled — set PIN_URL after deploying the Worker');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(`file too big (max ${MAX_UPLOAD_BYTES} bytes)`);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error(`unsupported type ${file.type} (png/jpeg/webp only)`);
  }
  const fd = new FormData();
  fd.append('file', file);
  const resp = await fetch(PIN_URL, { method: 'POST', body: fd });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `upload failed: HTTP ${resp.status}`);
  if (!j.cid) throw new Error('worker returned no CID');
  return j.cid;
}

// Pin a small ERC-721-style metadata JSON to IPFS via the Worker.
// Returns the metadata CID, which the dApp stores in the CETCH envelope's image_uri.
async function uploadMetadataToPinata(metadata) {
  if (!PIN_JSON_URL) throw new Error('metadata pinning disabled — no Worker configured');
  const resp = await fetch(PIN_JSON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `metadata pin failed: HTTP ${resp.status}`);
  if (!j.cid) throw new Error('worker returned no CID');
  return j.cid;
}

// Resolve an envelope's image_uri to a renderable image URL.
// If the URI dereferences to JSON metadata (with an `image` field), follow it.
// If it dereferences to image bytes, use the URI directly.
//
// Persisted to localStorage: IPFS CIDs are content-addressed so the resolved
// value is deterministic forever for any given input URI. We only persist
// when the fetch returned with resp.ok=true — a transient gateway failure
// would otherwise cache the wrong "resolved" value forever. Non-deterministic
// branches (fetch threw, resp.ok=false) stay in-memory only and re-fetch on
// next reload. Network-agnostic (CIDs are global).
const _resolvedImageCache = new Map();
const _resolvedImageInFlight = new Map(); // imageUri → Promise; dedups concurrent fetches
const _metadataExtraCache = new Map(); // imageUri → { name, description, external_url }
const IMG_PERSIST_KEY = 'tacit-imgcache-v1';
const IMG_PERSIST_MAX = 500;
let _imgCacheHydrated = false;
let _imgCacheDirty = false;
let _imgCacheFlushTimer = null;
let _imgCachePersisted = null; // imageUri → { resolved, extra, ts }
function _ensureImgCacheHydrated() {
  if (_imgCacheHydrated) return;
  _imgCacheHydrated = true;
  _imgCachePersisted = {};
  try {
    const raw = localStorage.getItem(IMG_PERSIST_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || !parsed.entries) return;
    _imgCachePersisted = parsed.entries;
    for (const [uri, entry] of Object.entries(_imgCachePersisted)) {
      _resolvedImageCache.set(uri, entry.resolved);
      if (entry.extra) _metadataExtraCache.set(uri, entry.extra);
    }
  } catch { /* corrupt blob → start fresh */ }
}
function _writeImgCacheNow() {
  if (!_imgCacheDirty || !_imgCachePersisted) return;
  _imgCacheDirty = false;
  // LRU evict to cap (sort by ts ascending, drop oldest).
  const keys = Object.keys(_imgCachePersisted);
  if (keys.length > IMG_PERSIST_MAX) {
    keys.sort((a, b) => (_imgCachePersisted[a].ts || 0) - (_imgCachePersisted[b].ts || 0));
    const drop = keys.length - IMG_PERSIST_MAX;
    for (let i = 0; i < drop; i++) delete _imgCachePersisted[keys[i]];
  }
  try { localStorage.setItem(IMG_PERSIST_KEY, JSON.stringify({ v: 1, entries: _imgCachePersisted })); }
  catch { /* quota exceeded → skip; in-memory still works */ }
}
function _scheduleImgCacheFlush() {
  _imgCacheDirty = true;
  if (_imgCacheFlushTimer) return;
  _imgCacheFlushTimer = setTimeout(() => {
    _imgCacheFlushTimer = null;
    _writeImgCacheNow();
  }, 500);
}
function _persistImgCacheEntry(imageUri, resolved, extra) {
  _ensureImgCacheHydrated();
  _imgCachePersisted[imageUri] = { resolved, extra: extra || null, ts: Date.now() };
  _scheduleImgCacheFlush();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _imgCacheFlushTimer) {
      clearTimeout(_imgCacheFlushTimer); _imgCacheFlushTimer = null;
      _writeImgCacheNow();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (_imgCacheFlushTimer) {
      clearTimeout(_imgCacheFlushTimer); _imgCacheFlushTimer = null;
      _writeImgCacheNow();
    }
  });
}
async function resolveImageUri(imageUri) {
  if (!imageUri) return null;
  _ensureImgCacheHydrated();
  if (_resolvedImageCache.has(imageUri)) return _resolvedImageCache.get(imageUri);
  const existing = _resolvedImageInFlight.get(imageUri);
  if (existing) return existing;
  const p = (async () => {
  const url = normalizeImageUri(imageUri);
  if (!url) {
    _resolvedImageCache.set(imageUri, null);
    // Rejected URI scheme is deterministic — persist so we don't re-validate
    // every reload.
    _persistImgCacheEntry(imageUri, null, null);
    return null;
  }
  let resolved = url;
  let extra = null;
  let fetchOk = false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (resp.ok) {
      fetchOk = true;
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('json') || ct.includes('text/plain')) {
        // Treating the URI as a metadata blob. Default to no image and only
        // set one if the JSON has an actual image field — otherwise we'd
        // point an <img src> at JSON bytes and fail silently.
        resolved = null;
        const text = await resp.text();
        if (text.length < 8192) {
          try {
            const j = JSON.parse(text);
            if (j && typeof j === 'object') {
              if (typeof j.image === 'string') {
                // Only allow ipfs:// or bare CIDs for the inner image — never an
                // arbitrary https:// URL. An attacker who controls the metadata
                // JSON could otherwise point every viewer at their tracking
                // server (privacy beacon for IP correlation across all wallets
                // viewing the asset). Restricting to IPFS forces traffic
                // through the configured gateway.
                const innerRaw = String(j.image).trim();
                let innerCid = null;
                const m = innerRaw.match(/^ipfs:\/\/([A-Za-z0-9]+)/);
                if (m) innerCid = m[1];
                else if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(innerRaw)) innerCid = innerRaw;
                else if (/^baf[a-z0-9]{50,80}$/i.test(innerRaw)) innerCid = innerRaw;
                if (innerCid) resolved = `${IPFS_GATEWAY}${innerCid}`;
              }
              // external_url must be plain https:// — escapeHtml prevents HTML
              // injection but doesn't make `javascript:` / `data:` URLs safe to click.
              const rawExternal = typeof j.external_url === 'string' ? j.external_url.trim() : '';
              const safeExternal = /^https:\/\//i.test(rawExternal) ? rawExternal : null;
              // Optional human-readable name. Older blobs that defaulted name to
              // the ticker won't break anything: renderers compare against the
              // ticker and only show the name as primary if it differs.
              const rawName = typeof j.name === 'string' ? j.name.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64) : '';
              extra = {
                name: rawName || null,
                description: typeof j.description === 'string' ? j.description : null,
                external_url: safeExternal,
              };
            }
          } catch {}
        }
      }
    }
  } catch {} finally { clearTimeout(timer); }
  _resolvedImageCache.set(imageUri, resolved);
  if (extra) _metadataExtraCache.set(imageUri, extra);
  // Only persist on a successful fetch. A thrown fetch or non-200 response
  // would have left `resolved` as the original URL — caching that for a URI
  // that's actually a metadata blob would render JSON bytes as <img src> on
  // every future load. resp.ok ensures we know what kind of response we got.
  if (fetchOk) _persistImgCacheEntry(imageUri, resolved, extra);
  return resolved;
  })().finally(() => { _resolvedImageInFlight.delete(imageUri); });
  _resolvedImageInFlight.set(imageUri, p);
  return p;
}
function getMetadataExtras(imageUri) {
  // Hydrate the persistent cache before the synchronous read so callers that
  // run before any resolveImageUri (e.g. holdings card skeletons) still hit
  // warm-cache values from localStorage instead of falling back to ticker.
  _ensureImgCacheHydrated();
  return _metadataExtraCache.get(imageUri) || null;
}
function setupEtchForm() {
  const fileInput = $('#e-image-file');
  const fileLabel = document.querySelector('label[for="e-image-file"]');
  const fileStatus = $('#e-image-status');
  if (!PIN_URL) {
    fileLabel.style.opacity = '0.4';
    fileLabel.style.pointerEvents = 'none';
    fileStatus.textContent = 'upload disabled — set PIN_URL in tacit.js';
  }
  // Show the key-custody warning whenever Mintable is checked. The mint
  // authority IS the local burner key; users must export-and-back-up before
  // etching, or they lose the ability to mint later.
  const mintableCb = $('#e-mintable');
  const mintWarn = $('#mintable-key-warning');
  if (mintableCb && mintWarn) {
    const sync = () => { mintWarn.style.display = mintableCb.checked ? '' : 'none'; };
    mintableCb.addEventListener('change', sync);
    sync();
  }
  // Mainnet-beta: disable the Mintable checkbox until multisig mint authority
  // ships. Re-evaluated on every setupEtchForm call (network select fires
  // location.reload, which re-runs init → setupEtchForm in the new network).
  if (mintableCb && NET.name === 'mainnet' && !MAINNET_ALLOW_MINTABLE) {
    mintableCb.checked = false;
    mintableCb.disabled = true;
    const label = mintableCb.closest('label');
    if (label) {
      label.title = 'Disabled on mainnet during beta. Multisig mint authority pending.';
      label.style.opacity = '0.55';
    }
  }
  // Decimals presets + live "what you'll end up with" preview. Removes the
  // mental arithmetic users would otherwise need to translate (decimals,
  // supply) into base units, smallest divisible unit, and the 2^64 cap.
  const decimalsInput = $('#e-decimals');
  const supplyInput = $('#e-supply');
  const tickerInput = $('#e-ticker');
  const previewEl = $('#e-preview-line');
  const presetChips = document.querySelectorAll('#e-decimals-presets .preset-chip');
  const N_BITS_LOCAL = 64;
  const MAX_BASE = (1n << BigInt(N_BITS_LOCAL)) - 1n;
  function fmtBig(n) {
    // Insert thousands separators into a BigInt for readability.
    const s = n.toString();
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function syncDecimalsChips() {
    const d = parseInt(decimalsInput.value, 10);
    presetChips.forEach(chip => {
      chip.classList.toggle('active', parseInt(chip.dataset.decimals, 10) === d);
    });
  }
  function updateEtchPreview() {
    if (!previewEl) return;
    const ticker = (tickerInput?.value || 'TOKEN').trim().toUpperCase() || 'TOKEN';
    const safeTicker = ticker.replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'TOKEN';
    const d = parseInt(decimalsInput.value, 10);
    const dValid = Number.isInteger(d) && d >= 0 && d <= 8;
    const supplyStr = (supplyInput?.value || '').trim();
    if (!supplyStr || !dValid) {
      previewEl.classList.remove('show', 'error');
      previewEl.innerHTML = '';
      return;
    }
    let supplyBase;
    try { supplyBase = parseAssetAmount(supplyStr, d); }
    catch (e) {
      previewEl.classList.add('show', 'error');
      previewEl.innerHTML = `${escapeHtml(e.message)}`;
      return;
    }
    if (supplyBase <= 0n) {
      previewEl.classList.add('show', 'error');
      previewEl.innerHTML = 'supply must be greater than zero';
      return;
    }
    if (supplyBase > MAX_BASE) {
      const div = 10n ** BigInt(d);
      const maxDisp = MAX_BASE / div;
      const rem = (MAX_BASE - maxDisp * div).toString().padStart(d, '0');
      const maxStr = d > 0 ? `${fmtBig(maxDisp)}.${rem}` : fmtBig(maxDisp);
      previewEl.classList.add('show', 'error');
      previewEl.innerHTML = `supply exceeds 2⁶⁴ base units · max with ${d} decimals: <strong>${maxStr} ${escapeHtml(safeTicker)}</strong>`;
      return;
    }
    const smallest = d === 0 ? `1 ${safeTicker}` : `0.${'0'.repeat(d - 1)}1 ${safeTicker}`;
    const baseUnits = fmtBig(supplyBase);
    previewEl.classList.add('show');
    previewEl.classList.remove('error');
    previewEl.innerHTML = `
      <div><span class="lbl">on chain</span><strong>${baseUnits}</strong> base units committed</div>
      <div><span class="lbl">smallest unit</span>${escapeHtml(smallest)}</div>`;
  }
  // Invalidate a previously-staged Preview whenever an input that affects the
  // broadcast changes. Without this, a user could Preview {USDC, 1M, mintable=off},
  // toggle Mintable on (or rename the ticker), and click Broadcast — sending the
  // stale pendingCEtch while the form visibly showed something different.
  // Mirrors setupTransferForm's invalidatePreview pattern.
  const invalidateEtchPreview = () => {
    if (!pendingCEtch) return;
    pendingCEtch = null;
    const broadcastBtn = $('#btn-etch-broadcast');
    if (broadcastBtn) broadcastBtn.disabled = true;
    const previewCard = $('#etch-preview');
    if (previewCard) previewCard.style.display = 'none';
    // Don't touch #etch-error / #etch-success — those persist until the user
    // re-Previews (matches the Transfer-form invalidate behavior).
  };
  presetChips.forEach(chip => {
    chip.onclick = () => {
      decimalsInput.value = chip.dataset.decimals;
      syncDecimalsChips();
      updateEtchPreview();
      invalidateEtchPreview();
    };
  });
  decimalsInput?.addEventListener('input', () => { syncDecimalsChips(); updateEtchPreview(); invalidateEtchPreview(); });
  supplyInput?.addEventListener('input', () => { updateEtchPreview(); invalidateEtchPreview(); });
  tickerInput?.addEventListener('input', () => { updateEtchPreview(); invalidateEtchPreview(); });
  // Fields not wired into the live preview hint still affect the broadcast
  // (name → metadata blob; image / description / external_url → metadata blob;
  // attest → metadata blob + worker POST; mintable → mint_authority byte).
  $('#e-name')?.addEventListener('input', invalidateEtchPreview);
  $('#e-image')?.addEventListener('input', invalidateEtchPreview);
  $('#e-description')?.addEventListener('input', invalidateEtchPreview);
  $('#e-external-url')?.addEventListener('input', invalidateEtchPreview);
  $('#e-attest-on-etch')?.addEventListener('change', invalidateEtchPreview);
  mintableCb?.addEventListener('change', invalidateEtchPreview);
  syncDecimalsChips();
  updateEtchPreview();
  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileStatus.textContent = `uploading ${file.name} (${(file.size/1024).toFixed(1)} KB)…`;
    try {
      const cid = await uploadImageToPinata(file);
      $('#e-image').value = `ipfs://${cid}`;
      // Programmatic .value = doesn't dispatch 'input', so do it explicitly so
      // the invalidate listener above fires.
      invalidateEtchPreview();
      fileStatus.textContent = `pinned: ${cid.slice(0, 12)}…`;
      toast(`Uploaded to IPFS: ${cid.slice(0, 12)}…`, 'success');
    } catch (e) {
      fileStatus.textContent = '';
      toast(`Upload failed: ${e.message}`, 'error');
      console.error(e);
    } finally {
      fileInput.value = '';
    }
  };
  $('#btn-etch-preview').onclick = async () => {
    const btn = $('#btn-etch-preview');
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'previewing…';
    $('#etch-error').textContent = '';
    $('#etch-success').style.display = 'none';
    try {
      const ticker = $('#e-ticker').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{1,8}$/.test(ticker)) throw new Error('ticker must be 1–8 chars (A–Z, 0–9)');
      const decimals = parseInt($('#e-decimals').value);
      if (isNaN(decimals) || decimals < 0 || decimals > 8) {
        throw new Error('decimals must be 0–8');
      }
      // Decimal-aware supply parsing — accepts fractional display amounts (e.g. "1000.50" with decimals=2)
      const supplyStr = $('#e-supply').value.trim();
      let supplyBase;
      try { supplyBase = parseAssetAmount(supplyStr, decimals); }
      catch (e) { throw new Error(`supply: ${e.message}`); }
      if (supplyBase <= 0n) throw new Error('supply must be > 0');
      if (supplyBase >= (1n << BigInt(N_BITS))) {
        const maxBase = (1n << BigInt(N_BITS)) - 1n;
        const div = 10n ** BigInt(decimals);
        const maxDisp = maxBase / div;
        const rem = (maxBase - maxDisp * div).toString().padStart(decimals, '0');
        const maxStr = decimals > 0 ? `${maxDisp}.${rem}` : `${maxDisp}`;
        throw new Error(`supply exceeds 2⁶⁴ base units. Max with ${decimals} decimals: ${maxStr}`);
      }
      // Optional image URI
      let imageUri = null;
      try { imageUri = validateImageUriForEtch($('#e-image').value); }
      catch (e) { throw new Error(`image: ${e.message}`); }

      // Optional metadata-blob fields. If either is filled, the broadcast step
      // builds a JSON metadata object and pins it; the metadata CID becomes the
      // envelope's image_uri (replacing the raw image CID, which moves into
      // metadata.image). Renderers dereference the metadata transparently.
      const description = $('#e-description').value.trim();
      const externalUrl = $('#e-external-url').value.trim();
      // Optional human-readable name. Lives off-chain in the metadata blob;
      // ticker stays the on-chain identity. Strip control chars to keep
      // renderers safe. ≤64 chars enforced by the input's maxlength.
      const nameRaw = ($('#e-name')?.value || '').trim();
      const name = nameRaw.replace(/[\x00-\x1f\x7f]/g, '');
      if (name.length > 64) throw new Error('name max 64 chars');
      if (externalUrl && !/^https:\/\//i.test(externalUrl)) {
        throw new Error('external URL must start with https://');
      }
      if (description.length > 500) throw new Error('description max 500 chars');

      const mintable = !!$('#e-mintable')?.checked;
      if (mintable && NET.name === 'mainnet' && !MAINNET_ALLOW_MINTABLE) {
        throw new Error(
          'mainnet beta: mintable etches are disabled. Multisig mint authority (MuSig2/FROST) ' +
          'is required for safe institutional issuance and is not yet shipped — single-key mintable ' +
          'on mainnet means compromise-of-burner = uncapped inflation. Use fixed-supply for now.',
        );
      }
      pendingCEtch = { ticker, supplyBase, decimals, imageUri, name, description, externalUrl, mintable };
      const rate = await getFeeRate();
      const commitFeeEst = feeFor(estCommitVb(1), rate);
      // Exact reveal vb based on actual ticker + image_uri (or expected ipfs CID
      // length when metadata is being pinned). Matches what the build pays.
      // attestRequested also triggers metadata pinning even with no name/desc/url —
      // include it here so the preview fee matches the build's wantMetadata path.
      const _attestRequestedPreview = !!$('#e-attest-on-etch')?.checked;
      const _willPinMeta = !!(name || description || externalUrl || _attestRequestedPreview);
      const _rawImgLen = imageUri ? new TextEncoder().encode(imageUri).length : 0;
      const _expectedImgLen = _willPinMeta ? Math.max(_rawImgLen, 70) : _rawImgLen;
      const _tkLen = new TextEncoder().encode(ticker).length;
      const revealFeeEst = feeFor(estCEtchRevealVb({ tickerLen: _tkLen, imageUriLen: _expectedImgLen }), rate);
      const totalFeeEst = commitFeeEst + revealFeeEst;

      $('#etch-preview').style.display = 'block';
      $('#etch-preview').innerHTML = `
        <div class="tx-preview" style="margin-top:18px;">
          <h4>Preview envelope</h4>
          <div class="opreturn-decode">
            <div class="head">CETCH · confidential token issuance</div>
            <div class="data">${name ? `name = "<strong>${escapeHtml(name)}</strong>" · ` : ''}ticker = "${escapeHtml(ticker)}" · decimals = ${decimals} · supply = ${escapeHtml(supplyStr)} (${supplyBase} base units)</div>
            ${imageUri ? `<div class="data" style="display:flex;align-items:center;gap:10px;margin-top:6px;">image: <span style="font-family:var(--mono);font-size:11px;word-break:break-all;">${escapeHtml(imageUri)}</span><img loading="lazy" decoding="async" src="${escapeHtml(normalizeImageUri(imageUri) || '')}" alt="" style="width:32px;height:32px;border:1px solid var(--ink);object-fit:cover;background:#fff;"></div>` : ''}
            ${description ? `<div class="data" style="margin-top:6px;">description: <span style="font-style:italic;">${escapeHtml(description)}</span></div>` : ''}
            ${externalUrl ? `<div class="data" style="margin-top:4px;">link: <span style="font-family:var(--mono);font-size:11px;">${escapeHtml(externalUrl)}</span></div>` : ''}
            ${(description || externalUrl) ? `<div class="data" style="margin-top:6px;color:var(--ink-mid);font-size:10px;">↑ a JSON metadata blob will be pinned and the envelope will store its CID (instead of the raw image CID)</div>` : ''}
            <div class="data">supply commitment: 33 bytes that hide the actual amount — derived from your wallet key at broadcast</div>
            <div class="data" style="margin-top:6px;color:var(--ink-mid);">+ ~700-byte zero-knowledge proof that the supply is a valid 64-bit number (~3–5s to generate at broadcast)</div>
            <div class="data" style="margin-top:6px;">supply policy: <strong>${mintable ? 'mintable (you can issue more supply later)' : 'fixed (no further supply increases possible)'}</strong></div>
          </div>
          <h4 style="margin-top:14px;">2 Bitcoin transactions</h4>
          <div class="row"><span class="idx">[1]</span><span class="label">commit tx</span> creates the on-chain envelope (locked until the reveal)</div>
          <div class="row"><span class="idx">[2]</span><span class="label">reveal tx</span> publishes the envelope + proof, etching the asset</div>
          <h4 style="margin-top:14px;">Reveal tx outputs</h4>
          <div class="row"><span class="idx">[0]</span><span class="label">your address</span> ${fmtSats(DUST)} sats · holds the supply commitment</div>
          <h4 style="margin-top:14px;">Estimated fees</h4>
          <div>commit ~${commitFeeEst} sats · reveal ~${revealFeeEst} sats · total ~${totalFeeEst} sats @ ${rate} sat/vB</div>
        </div>`;
      $('#btn-etch-broadcast').disabled = false;
    } catch (e) {
      $('#etch-error').textContent = e.message;
      pendingCEtch = null;
      $('#btn-etch-broadcast').disabled = true;
      $('#etch-preview').style.display = 'none';
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  };
  $('#btn-etch-broadcast').onclick = async () => {
    if (!pendingCEtch) return;
    // Disable immediately. ensureSatsFunded can poll for ~45s while awaiting an
    // external wallet's funding tx; if we only disable inside the inner try
    // (after these awaits), a second click during that window re-enters with
    // the same pendingCEtch and runs two parallel broadcasts. Both early
    // returns below restore the enabled state so the user can retry.
    $('#btn-etch-broadcast').disabled = true;
    // Snapshot so a re-Preview during the async broadcast can't mutate the in-flight job.
    const job = pendingCEtch;
    // Burner-key backup gate. Etching takes custody of asset value at the
    // local burner; if the user hasn't backed up the key, force the export
    // flow before broadcast. Mintable assets carry the additional warning
    // that the burner key IS the mint authority for the asset's lifetime.
    const opLabel = job.mintable
      ? 'Etch a MINTABLE asset (the in-page privkey becomes the permanent mint authority)'
      : 'Etch a fixed-supply asset (the in-page privkey controls all supply UTXOs)';
    if (!ensureBurnerBackedUp(opLabel)) {
      toast('Etch cancelled. Back up the in-page privkey first, then retry.', '');
      $('#btn-etch-broadcast').disabled = false;
      return;
    }
    // Just-in-time funding: if the wallet has no sats (or not enough), pop the
    // appropriate funding flow inline before the build runs.
    const need = await estimateSatsForOp('etch');
    if (!(await ensureSatsFunded(need, 'Etching'))) {
      $('#btn-etch-broadcast').disabled = false;
      return;
    }
    const attestRequested = !!$('#e-attest-on-etch')?.checked;
    try {
      // Build a metadataBuilder closure that pins a metadata JSON containing
      // the (supply, blinding) opening to IPFS, returns its ipfs:// CID for
      // use as the envelope's image_uri. This routes attestation distribution
      // through IPFS — content-addressed, replicable by anyone, no worker
      // gatekeeping. The buildAndBroadcastCEtch hook is invoked AFTER the
      // opening is derived (so we can include it) and BEFORE the envelope is
      // built (so the resulting CID lands in the on-chain image_uri field).
      // Trigger metadata pinning when the user supplied any of: name, description,
      // external_url, or opted into attestation. Without metadata, the envelope
      // image_uri stays as the raw image (or empty), and renderers fall back to
      // showing just the ticker.
      const wantMetadata = (job.name || job.description || job.externalUrl || attestRequested) && PIN_JSON_URL;
      const metadataBuilder = !wantMetadata ? null : async ({ supply, blinding, commitment }) => {
        // Use the user-supplied name when present; fall back to the ticker so
        // ERC-721-style consumers always see a name field.
        const md = { name: job.name || job.ticker, decimals: job.decimals };
        if (job.imageUri) md.image = job.imageUri;
        if (job.description) md.description = job.description;
        if (job.externalUrl) md.external_url = job.externalUrl;
        if (attestRequested) {
          md.tacit_attest = {
            supply: supply.toString(),
            blinding: bytesToHex(bigintToBytes32(blinding)),
            commitment: bytesToHex(commitment),
          };
        }
        const metaCid = await uploadMetadataToPinata(md);
        return `ipfs://${metaCid}`;
      };

      // Reveal the inline progress strip and start at step 0 (Build:
      // rangeproof prove + optional metadata pin). The strip persists the
      // user's mental model across the ~3-5s the broadcast normally takes,
      // so they see commit → reveal → index landing in sequence instead of
      // staring at a generic "Broadcasting…" button.
      const progressEl = $('#etch-progress');
      if (progressEl) progressEl.style.display = 'flex';
      setProgressStrip('etch-progress', 0);
      $('#btn-etch-broadcast').textContent = 'Etching…';
      // Yield to UI before the ~250ms prove
      await new Promise(r => setTimeout(r, 50));
      const r = await buildAndBroadcastCEtch({
        ticker: job.ticker,
        supplyBase: job.supplyBase,
        decimals: job.decimals,
        imageUri: job.imageUri,
        mintable: job.mintable,
        metadataBuilder,
        onProgress: (stage) => {
          // Each event fires when the named broadcast is about to go out,
          // so the active step matches what's in flight.
          if (stage === 'commit-start') setProgressStrip('etch-progress', 1);
          else if (stage === 'reveal-start') setProgressStrip('etch-progress', 2);
        },
      });
      // All four stages done — flash the last one as complete then hide.
      setProgressStrip('etch-progress', 4);
      setTimeout(() => { if (progressEl) progressEl.style.display = 'none'; setProgressStrip('etch-progress', -1); }, 1200);
      toast(`Etched ${job.ticker}: commit=${shorten(r.commitTxid, 6)} · reveal=${shorten(r.revealTxid, 6)}`, 'success');
      markOnboarded();
      postHint(r.revealTxid, 0);
      // r.metadataPinned: true = pin succeeded; false = pin attempted but failed;
      // null = no metadataBuilder ran (no PIN_JSON_URL or no metadata reason).
      // When false, the on-chain envelope kept the original imageUri, which
      // means whichever metadata fields the user supplied (name / description /
      // external_url and/or tacit_attest) silently never made it to chain.
      // Surface that unconditionally so a failed pin isn't invisible.
      if (r.metadataPinned === false) {
        const lostBits = [
          (job.name || job.description || job.externalUrl) ? 'name/description/link' : '',
          attestRequested ? 'supply attestation' : '',
        ].filter(Boolean).join(' + ');
        toast(`Etched, but metadata pin to IPFS failed — ${lostBits} did not land in the envelope. Etch is still valid; ticker/decimals/supply commitment are on chain.`, 'error');
      }
      // Best-effort secondary path: also POST the opening to the worker's
      // /attest endpoint as a discovery-cache convenience. Not required for
      // correctness — verifiers reach the attestation via IPFS metadata above
      // and verify it cryptographically themselves. If the IPFS pin failed
      // (or the user has no Pinata-backed worker), the worker POST is the
      // fallback distribution path.
      if (attestRequested) {
        const ipfsHasAttest = r.metadataPinned === true;
        if (WORKER_BASE) {
          const opening = getOpening(r.revealTxid, 0);
          if (opening) {
            const fallbackNote = ipfsHasAttest
              ? ' The opening is still embedded in IPFS metadata.'
              : ' No IPFS-embedded opening either — supply remains unattested.';
            fetch(withNet(ATTEST_URL(r.assetIdHex)), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                supply: opening.amount.toString(),
                blinding: bytesToHex(bigintToBytes32(opening.blinding)),
                reveal_txid: r.revealTxid,
                reveal_vout: 0,
              }),
            }).then(async resp => {
              const j = await resp.json().catch(() => ({}));
              if (resp.ok) toast('Supply opening published ✓', 'success');
              else toast('Etch succeeded but worker attestation cache failed: ' + (j.error || resp.status) + '.' + fallbackNote, 'error');
            }).catch(e => toast('Worker attestation cache POST failed: ' + e.message + '.' + fallbackNote, 'error'));
          }
        }
      }
      // Only clear the form if the user hasn't queued a new preview during broadcast.
      // Surface a success card with txids + explorer + "view on Holdings" instead
      // of teleporting — losing the txid context is hostile.
      if (pendingCEtch === job) {
        pendingCEtch = null;
        $('#etch-preview').style.display = 'none';
        $('#e-ticker').value = '';
        // Reset attestation back to default-on so the next etch is also
        // trustless by default; user has to explicitly opt out each time.
        $('#e-attest-on-etch').checked = true;
        $('#e-mintable').checked = false;
        const successEl = $('#etch-success');
        if (successEl) {
          successEl.style.display = 'block';
          successEl.innerHTML = `
            <div class="warn" style="border-left-color:var(--green);background:var(--bg-warm);">
              <strong>✓ Etched ${escapeHtml(job.ticker)}</strong>
              <div class="muted" style="font-size:11px;margin-top:4px;">
                Asset ID <span class="mono-box inline">${escapeHtml(shorten(r.assetIdHex, 8))}</span>
                — your wallet has indexed this asset; the supply opening is cached locally. Export your key from the Wallet tab to back it up.
              </div>
              <div class="flex" style="margin-top:10px;">
                <button class="primary" id="btn-etch-goto-holdings">View on Holdings →</button>
                <a class="btn" href="${NET.explorer}/tx/${r.revealTxid}" target="_blank" rel="noopener noreferrer">Reveal tx ↗</a>
                <a class="btn" href="${NET.explorer}/tx/${r.commitTxid}" target="_blank" rel="noopener noreferrer">Commit tx ↗</a>
                <button id="btn-etch-another">Etch another</button>
              </div>
            </div>`;
          const gotoBtn = $('#btn-etch-goto-holdings');
          if (gotoBtn) gotoBtn.onclick = () => $('.tab[data-tab="holdings"]').click();
          const againBtn = $('#btn-etch-another');
          if (againBtn) againBtn.onclick = () => {
            successEl.style.display = 'none';
            $('#e-ticker').focus();
          };
        }
      }
      refreshWallet();
    } catch (e) {
      $('#etch-error').textContent = e.message;
      // Mark the in-flight step as errored. The strip stays visible — it
      // shows the user exactly which stage failed (build / commit / reveal)
      // so the error message has context. Hidden again on the next attempt
      // or when the user navigates away.
      const stripEl = $('#etch-progress');
      if (stripEl && stripEl.style.display !== 'none') {
        const activeStep = stripEl.querySelector('.progress-step.active');
        const errIdx = activeStep ? Number(activeStep.dataset.step) : -1;
        if (errIdx >= 0) setProgressStrip('etch-progress', -1, { errorAt: errIdx });
      }
      console.error(e);
    } finally {
      $('#btn-etch-broadcast').disabled = false;
      $('#btn-etch-broadcast').textContent = 'Etch & broadcast';
    }
  };
}

// ============== T_PETCH FORM (permissionless fair-launch deploy) ==============
// Mirrors setupEtchForm's commit-reveal flow but on a much simpler envelope:
// no supply commitment, no rangeproof, no metadata-attest path. The deploy
// step is a one-shot button (no preview) since there's no supply to surprise
// the user with — every parameter is in the form and visible up front.
function setupPetchForm() {
  const tickerInput = $('#p-ticker');
  const decimalsInput = $('#p-decimals');
  const capInput = $('#p-cap');
  const limitInput = $('#p-limit');
  const imageInput = $('#p-image');
  const hint = $('#p-divisibility-hint');
  const broadcastBtn = $('#btn-petch-broadcast');
  const errEl = $('#petch-error');
  const successEl = $('#petch-success');
  if (!broadcastBtn) return;

  const updateHint = () => {
    if (!hint) return;
    const decimals = parseInt(decimalsInput.value, 10);
    const capStr = capInput.value.trim();
    const limStr = limitInput.value.trim();
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) { hint.textContent = ''; return; }
    if (!capStr || !limStr) { hint.textContent = ''; return; }
    let cap, lim;
    try { cap = parseAssetAmount(capStr, decimals); lim = parseAssetAmount(limStr, decimals); }
    catch { hint.textContent = ''; return; }
    if (cap <= 0n || lim <= 0n) { hint.textContent = ''; return; }
    if (lim > cap) { hint.style.color = 'var(--red)'; hint.textContent = `mint_limit (${limStr}) exceeds cap (${capStr}) — invalid`; return; }
    if (cap % lim !== 0n) {
      hint.style.color = 'var(--red)';
      hint.textContent = `cap not evenly divisible by per-mint amount — leaves a residual that can never be minted; pick values where cap / per-mint is a whole integer`;
      return;
    }
    const mintCount = cap / lim;
    hint.style.color = '';
    hint.textContent = `${mintCount.toString()} mints will reach the cap (${capStr} ${tickerInput.value || 'token'} total at ${limStr} per mint)`;
  };
  capInput?.addEventListener('input', updateHint);
  limitInput?.addEventListener('input', updateHint);
  decimalsInput?.addEventListener('input', updateHint);
  tickerInput?.addEventListener('input', updateHint);

  broadcastBtn.onclick = async () => {
    errEl.textContent = '';
    successEl.style.display = 'none';
    let ticker, decimals, cap, lim, imageUri;
    try {
      ticker = tickerInput.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{1,8}$/.test(ticker)) throw new Error('ticker must be 1–8 chars (A–Z, 0–9)');
      decimals = parseInt(decimalsInput.value, 10);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('decimals must be 0–8');
      const capStr = capInput.value.trim();
      const limStr = limitInput.value.trim();
      if (!capStr || !limStr) throw new Error('cap_amount and per-mint amount required');
      try { cap = parseAssetAmount(capStr, decimals); }
      catch (e) { throw new Error(`cap_amount: ${e.message}`); }
      try { lim = parseAssetAmount(limStr, decimals); }
      catch (e) { throw new Error(`per-mint amount: ${e.message}`); }
      if (cap <= 0n || lim <= 0n) throw new Error('amounts must be > 0');
      if (lim > cap) throw new Error('per-mint amount exceeds cap');
      if (cap % lim !== 0n) throw new Error('cap is not evenly divisible by per-mint amount');
      try { imageUri = validateImageUriForEtch(imageInput.value); }
      catch (e) { throw new Error(`image: ${e.message}`); }
    } catch (e) {
      errEl.textContent = e.message;
      return;
    }
    if (!ensureBurnerBackedUp('Deploy a public-mint asset (T_PETCH; deployer receives no tokens)')) {
      errEl.textContent = 'Deploy cancelled. Back up the in-page privkey first, then retry.';
      return;
    }
    const need = await estimateSatsForOp('etch');
    if (!(await ensureSatsFunded(need, 'Deploying T_PETCH'))) return;
    broadcastBtn.disabled = true;
    broadcastBtn.textContent = 'deploying…';
    const stripEl = $('#petch-progress');
    if (stripEl) stripEl.style.display = 'flex';
    setProgressStrip('petch-progress', 0);
    try {
      const r = await buildAndBroadcastPetch({
        ticker, decimals, capAmount: cap, mintLimit: lim, imageUri,
        onProgress: (stage) => {
          if (stage === 'commit-start') setProgressStrip('petch-progress', 1);
          else if (stage === 'reveal-start') setProgressStrip('petch-progress', 2);
        },
      });
      setProgressStrip('petch-progress', 4);
      setTimeout(() => { if (stripEl) stripEl.style.display = 'none'; setProgressStrip('petch-progress', -1); }, 1200);
      successEl.style.display = 'block';
      successEl.innerHTML = `
        <div style="padding:12px;border:1px solid var(--ink);border-left:4px solid #0a8f43;background:var(--bg-warm);">
          <strong>✓ Public-mint asset deployed</strong>
          <div class="muted" style="margin-top:6px;font-size:11px;line-height:1.6;">
            asset_id: <span class="mono-box inline" style="font-size:10px;">${escapeHtml(r.assetIdHex)}</span><br>
            commit: <a href="${NET.explorer}/tx/${r.commitTxid}" target="_blank" rel="noopener noreferrer" class="mono-box inline" style="font-size:10px;">${escapeHtml(shorten(r.commitTxid, 10))}</a><br>
            reveal: <a href="${NET.explorer}/tx/${r.revealTxid}" target="_blank" rel="noopener noreferrer" class="mono-box inline" style="font-size:10px;">${escapeHtml(shorten(r.revealTxid, 10))}</a><br>
            Anyone (including you) can mint <strong>${escapeHtml(limitInput.value)} ${escapeHtml(ticker)}</strong> per mint until the cap of <strong>${escapeHtml(capInput.value)}</strong> is reached. Minting opens after the next block confirms.
          </div>
        </div>`;
      if (typeof invalidateDiscoverRegistryCache === 'function') invalidateDiscoverRegistryCache();
      toast(`Deployed ${ticker} ✓`, 'success', 8000);
    } catch (e) {
      errEl.textContent = `Deploy failed: ${e.message}`;
      // Mark in-flight step as errored; strip stays visible so the error
      // line has visual context (which stage failed).
      if (stripEl && stripEl.style.display !== 'none') {
        const activeStep = stripEl.querySelector('.progress-step.active');
        const errIdx = activeStep ? Number(activeStep.dataset.step) : -1;
        if (errIdx >= 0) setProgressStrip('petch-progress', -1, { errorAt: errIdx });
      }
      console.error(e);
    } finally {
      broadcastBtn.disabled = false;
      broadcastBtn.textContent = 'Deploy public-mint asset';
    }
  };
}

// ============== TRANSFER UI ==============
let pendingCXfer = null;

// Snapshot of the most recent transfer-tab holdings scan, keyed by assetId.
// Lets the amount hint and Max button render synchronously on every #x-asset
// change without re-scanning chain on each keystroke.
const _transferHoldings = new Map();

async function refreshAssetSelect() {
  const sel = $('#x-asset');
  if (!sel) return;
  const holdings = await scanHoldings().catch(() => new Map());
  const knownNonZero = [...holdings.values()].filter(h => !h.unknownAsset && h.balance > 0n);
  _transferHoldings.clear();
  for (const h of knownNonZero) _transferHoldings.set(h.assetIdHex, h);
  const current = sel.value;
  sel.innerHTML = '<option value="">— select —</option>' + knownNonZero.map(h =>
    `<option value="${h.assetIdHex}">${escapeHtml(h.ticker)} · balance: ${fmtAssetAmount(h.balance, h.decimals)}</option>`
  ).join('');
  if (current) sel.value = current;
  updateTransferAmountHint();
}

// Render the decimals/balance hint next to the Amount label and toggle the
// Max button's enabled state. Called on asset-select change and after each
// holdings refresh. Tolerates missing meta (asset selected but not yet in the
// snapshot) by clearing the hint rather than throwing.
function updateTransferAmountHint() {
  const hint = $('#x-amount-hint');
  const maxBtn = $('#btn-x-max');
  const sel = $('#x-asset');
  if (!hint || !maxBtn || !sel) return;
  const aid = sel.value;
  const h = aid ? _transferHoldings.get(aid) : null;
  if (!h) {
    hint.textContent = '';
    maxBtn.disabled = true;
    populateTransferUtxoPicker(null);
    return;
  }
  const decUnit = h.decimals === 1 ? 'decimal' : 'decimals';
  hint.textContent = `· ${h.decimals} ${decUnit} · balance ${fmtAssetAmount(h.balance, h.decimals)} ${h.ticker}`;
  maxBtn.disabled = h.balance <= 0n;
  populateTransferUtxoPicker(h);
}

// Populate the per-UTXO picker dropdown for the Send tab. Each option carries
// the txid:vout outpoint as its value (so the broadcast can re-locate the
// UTXO in the live holdings snapshot at preview time) and the amount as the
// label. The picker stays as `<auto>` by default — the broadcast then falls
// through to `buildAndBroadcastCXfer`'s greedy-largest picker. Used by users
// who need exact UTXO control (e.g. invalidating a stale listing's UTXO).
function populateTransferUtxoPicker(h) {
  const sel = $('#x-utxo-pick');
  if (!sel) return;
  sel.innerHTML = '<option value="">auto · greedy-largest (default)</option>';
  if (!h || !Array.isArray(h.utxos) || h.utxos.length === 0) {
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  // Sort by amount desc so the chunkiest UTXO surfaces first (common case:
  // user listed a single big UTXO and now wants to invalidate it).
  const sorted = [...h.utxos].sort((a, b) => Number(b.amount - a.amount));
  for (const u of sorted) {
    const out = u.utxo;
    const opt = document.createElement('option');
    opt.value = `${out.txid}:${out.vout}`;
    opt.textContent = `${shorten(out.txid, 6)}:${out.vout} · ${fmtAssetAmount(u.amount, h.decimals)} ${h.ticker}`;
    sel.appendChild(opt);
  }
}

// Lock / unlock the amount field + Max button based on UTXO-picker state.
// When a specific UTXO is chosen, the spend amount is fixed (you spend the
// whole UTXO, change comes back to you), so let the form reflect that and
// disable the inputs that no longer apply.
function applyTransferUtxoLock() {
  const pickerSel = $('#x-utxo-pick');
  const amountInp = $('#x-amount');
  const maxBtn    = $('#btn-x-max');
  const assetSel  = $('#x-asset');
  if (!pickerSel || !amountInp || !maxBtn || !assetSel) return;
  const pick = pickerSel.value;
  if (!pick) {
    amountInp.disabled = false;
    amountInp.title = '';
    const h = _transferHoldings.get(assetSel.value);
    maxBtn.disabled = !h || h.balance <= 0n;
    return;
  }
  const h = _transferHoldings.get(assetSel.value);
  if (!h) return;
  const [pickTxid, pickVoutStr] = pick.split(':');
  const pickVout = parseInt(pickVoutStr, 10);
  const u = h.utxos.find(x => x.utxo.txid === pickTxid && x.utxo.vout === pickVout);
  if (!u) {
    pickerSel.value = '';   // stale — reset to auto
    applyTransferUtxoLock();
    return;
  }
  amountInp.value = fmtAssetAmountPlain(u.amount, h.decimals);
  amountInp.disabled = true;
  amountInp.title = `Locked to UTXO ${shorten(pickTxid, 6)}:${pickVout}'s amount. Switch back to "auto" to edit.`;
  maxBtn.disabled = true;
  // Clear any pending warning since the value now matches a real UTXO.
  const warn = $('#x-amount-warn'); if (warn) { warn.textContent = ''; warn.style.display = 'none'; }
}

// Render an asset amount in display units WITHOUT thousands separators, so the
// result round-trips through parseAssetAmount without modification. Used by the
// Max button — fmtAssetAmount's localized form ("21,000,000") would otherwise
// fail input validation.
function fmtAssetAmountPlain(amt, decimals) {
  const a = BigInt(amt);
  if (decimals === 0) return a.toString();
  const div = 10n ** BigInt(decimals);
  const whole = (a / div).toString();
  const frac = (a % div).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// Compute the unit price of a listing in sats per *whole* token, accounting
// for the asset's decimals. Returns a Number (with up to 4 fractional digits
// of resolution) for display formatting, or null when inputs are unusable.
// BigInt-safe: keeps the division in 10^4 fixed-point so a 10000-sat listing
// of 100 TAC at 8 decimals correctly resolves to 100, not 0 or 100.000…001.
function unitPriceSats(priceSats, amountBaseUnits, decimals) {
  const p = Number(priceSats);
  if (!Number.isFinite(p) || p <= 0) return null;
  let amt;
  try { amt = BigInt(amountBaseUnits); } catch { return null; }
  if (amt <= 0n) return null;
  const PRECISION = 4n;                 // sub-sat precision for fractional unit prices
  const num = BigInt(Math.floor(p)) * (10n ** BigInt(decimals)) * (10n ** PRECISION);
  const fixed = num / amt;              // sats * 10^4 per whole token, truncated
  return Number(fixed) / 10_000;
}
// Display helper for a unit price computed by unitPriceSats. Strips trailing
// zeros, keeps thousands separators for whole-sat values, falls back to a
// short fractional form for sub-1-sat prices.
function fmtUnitPriceSats(sats) {
  if (sats == null) return '';
  if (sats >= 1) return sats.toLocaleString('en-US', { maximumFractionDigits: 4 });
  // Sub-1-sat prices: render up to 4 decimals without trailing zeros.
  return sats.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
// Relative time string for a unix timestamp ("3m", "5h", "2d"). Returns ''
// when ts is missing/zero so callers can drop the line entirely.
function relativeAge(unixTs) {
  if (!Number.isFinite(unixTs) || unixTs <= 0) return '';
  const min = Math.max(0, Math.floor((Date.now() / 1000 - unixTs) / 60));
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

// Render a single UTXO-picker option label. Used by the atomic pickers
// (publish-intent / list-atomic) so two UTXOs with identical token amounts
// can still be told apart by their txid prefix + age. The `tag` argument is
// optional; when present it appends a "⚠ already listed (…)" suffix that the
// caller renders alongside `option.disabled = true` to prevent re-listing the
// same UTXO under a second offer.
function utxoPickerOptionLabel(u, target, tag = null) {
  const ageStr = u.utxo.status?.confirmed
    ? (relativeAge(u.utxo.status.block_time) ? ` · ${relativeAge(u.utxo.status.block_time)} old` : '')
    : ' · mempool';
  const base = `${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} · UTXO ${shorten(u.utxo.txid, 8)}:${u.utxo.vout}${ageStr}`;
  return tag ? `${base} · ⚠ already listed (${tag.label})` : base;
}

// Post-mount enrichment for the atomic-flow UTXO picker. Fetches the active
// listing tag map for the asset, then re-labels each option with status +
// disables already-listed entries. If the user's currently-selected option
// becomes disabled, falls through to the first available one. Returns the
// loaded tag map (or an empty Map on failure) so the submit handler can
// re-check at click time and prompt if the user somehow picked a listed UTXO
// in the brief window before enrichment landed.
async function enrichUtxoPicker(selectEl, sortedUtxos, target, assetIdHex) {
  if (!selectEl) return new Map();
  const tags = await fetchListedUtxoTags(assetIdHex).catch(() => new Map());
  // The select may have been dismounted (form closed) while the fetch was in
  // flight; bail silently — touching options on a detached node is harmless,
  // but we'd rather not pay for the work.
  if (!selectEl.isConnected) return tags;
  let firstAvailable = null;
  for (const opt of Array.from(selectEl.options)) {
    const idx = parseInt(opt.value, 10);
    const u = sortedUtxos[idx];
    if (!u) continue;
    const key = `${u.utxo.txid}:${u.utxo.vout | 0}`;
    const tag = tags.get(key);
    opt.textContent = utxoPickerOptionLabel(u, target, tag);
    opt.disabled = !!tag;
    if (!tag && !firstAvailable) firstAvailable = opt;
  }
  if (selectEl.options[selectEl.selectedIndex]?.disabled && firstAvailable) {
    selectEl.value = firstAvailable.value;
  }
  return tags;
}

// Live-truncate the Send-tab amount input against the selected asset's decimals.
// Wired to the input's `input` event and re-fired on asset-change. No-op when
// no asset is selected (we don't know the target decimals yet) or the value
// already fits. Reuses the visible #x-amount-warn to surface what got dropped.
function applyAmountTruncation() {
  const inp = $('#x-amount');
  const warn = $('#x-amount-warn');
  if (!inp || !warn) return;
  const aid = $('#x-asset').value;
  const h = aid ? _transferHoldings.get(aid) : null;
  if (!h) {
    warn.textContent = '';
    warn.style.display = 'none';
    return;
  }
  const { trimmed, dropped } = truncateAmountToDecimals(inp.value, h.decimals);
  if (trimmed === null) {
    warn.textContent = '';
    warn.style.display = 'none';
    return;
  }
  inp.value = trimmed;
  warn.textContent = `Trimmed to ${h.decimals} decimals · dropped 0.${'0'.repeat(h.decimals)}${dropped}`;
  warn.style.display = '';
}

// Cross-decimal paste support: an ERC-20 user pasting "596.45782132688733573"
// into an 8-decimal asset would otherwise hit "too many decimals" at preview
// time. Truncates extra fractional digits (round-down — never spend more than
// typed) and reports what was dropped so the UI can surface the trim
// transparently. Returns { trimmed, dropped } with both as plain strings or
// null when no truncation was needed. The input is left otherwise untouched
// (commas/whitespace are normalised by parseAssetAmount, not here).
function truncateAmountToDecimals(input, decimals) {
  const s = String(input || '');
  const dot = s.indexOf('.');
  if (dot < 0) return { trimmed: null, dropped: null };
  const frac = s.slice(dot + 1);
  // Only digits in the fractional part — ignore stray characters; parseAssetAmount
  // will produce a clearer error than we could synthesize here.
  if (!/^\d*$/.test(frac)) return { trimmed: null, dropped: null };
  if (frac.length <= decimals) return { trimmed: null, dropped: null };
  const keep = frac.slice(0, decimals);
  const drop = frac.slice(decimals);
  // For a 0-decimal asset, drop the dot entirely so "5.99" → "5".
  const trimmed = decimals === 0 ? s.slice(0, dot) : `${s.slice(0, dot)}.${keep}`;
  return { trimmed, dropped: drop };
}

// Last 5 successfully-sent recipients, surfaced as a datalist on the Send tab
// so users don't have to re-paste a 66-char pubkey when transacting with the
// same person twice. Stored under a network-namespaced key so signet/mainnet
// don't pollute each other.
const RECENT_RECIPIENTS_KEY = () => `tacit_recent_recipients_${NET.name}`;
const RECENT_RECIPIENTS_MAX = 5;
function loadRecentRecipients() {
  try { return JSON.parse(localStorage.getItem(RECENT_RECIPIENTS_KEY()) || '[]'); }
  catch { return []; }
}
function saveRecentRecipient(pubHex) {
  if (!/^0[23][0-9a-f]{64}$/.test(pubHex)) return;
  const cur = loadRecentRecipients().filter(p => p !== pubHex);
  cur.unshift(pubHex);
  localStorage.setItem(RECENT_RECIPIENTS_KEY(), JSON.stringify(cur.slice(0, RECENT_RECIPIENTS_MAX)));
  refreshRecipientRecents();
}
function refreshRecipientRecents() {
  const dl = $('#x-recipient-recents');
  if (!dl) return;
  const items = loadRecentRecipients();
  dl.innerHTML = items.map(p => {
    try {
      const addr = bech32.encode(NET.hrp, [0, ...bech32.toWords(hash160(hexToBytes(p)))]);
      return `<option value="${p}" label="${escapeHtml(shorten(addr, 10))}"></option>`;
    } catch { return ''; }
  }).join('');
}
// Live preview of the bech32 address as the user types/pastes a recipient
// pubkey. Validates compressed-hex format + curve point; surfaces the derived
// address (or a parse error) so they can confirm before previewing the tx.
// Classify common non-pubkey inputs the user might paste by mistake (Bitcoin
// address, Ethereum address, xpub, Nostr key, raw 32-byte hex). Returns a
// targeted hint string or null if no specific pattern matched. Lets the live
// recipient-input hint say "looks like a Bitcoin address" instead of "X/66
// chars" when the user pasted bc1q… by mistake.
function classifyRecipientMisinput(raw) {
  if (/^(bc1|tb1)[02-9ac-hj-np-z]{6,}$/.test(raw)) {
    return 'looks like a Bitcoin address — tacit needs the recipient\'s pubkey (66 hex chars, 02… or 03…), not their address. They can copy it from their Wallet tab.';
  }
  if (/^0x[0-9a-f]{40}$/.test(raw)) {
    return 'looks like an Ethereum address — tacit needs a Bitcoin secp256k1 compressed pubkey (66 hex chars starting with 02 or 03).';
  }
  if (/^(xpub|ypub|zpub|tpub|upub|vpub)/.test(raw)) {
    return 'looks like an extended public key — paste a single compressed pubkey (66 hex chars), not the xpub.';
  }
  if (/^npub1/.test(raw)) {
    return 'looks like a Nostr pubkey — tacit needs a Bitcoin secp256k1 compressed pubkey (66 hex chars starting with 02 or 03).';
  }
  if (/^[13][1-9a-km-z]{25,34}$/.test(raw)) {
    return 'looks like a legacy Bitcoin address — tacit needs the recipient\'s pubkey (66 hex chars, 02… or 03…), not their address.';
  }
  if (/^[0-9a-f]{64}$/.test(raw)) {
    return '64 hex chars — that\'s a 32-byte value (privkey or x-only pubkey). tacit needs a 33-byte compressed pubkey: prefix 02 or 03 + 64 hex chars (66 total).';
  }
  return null;
}

function updateDerivedAddressHint() {
  const inputEl = $('#x-recipient-pub');
  const hintEl = $('#x-recipient-derived');
  if (!inputEl || !hintEl) return;
  const raw = inputEl.value.trim().toLowerCase().replace(/\s/g, '');
  if (!raw) { hintEl.style.display = 'none'; hintEl.textContent = ''; return; }
  if (!/^0[23][0-9a-f]{64}$/.test(raw)) {
    const targeted = classifyRecipientMisinput(raw);
    hintEl.style.display = '';
    hintEl.style.color = targeted ? 'var(--red)' : 'var(--ink-mid)';
    hintEl.textContent = targeted || `${raw.length}/66 chars · expecting compressed pubkey starting with 02 or 03`;
    return;
  }
  try { secp.ProjectivePoint.fromHex(raw); }
  catch {
    hintEl.style.display = '';
    hintEl.style.color = 'var(--red)';
    hintEl.textContent = 'not a valid secp256k1 point';
    return;
  }
  try {
    const addr = bech32.encode(NET.hrp, [0, ...bech32.toWords(hash160(hexToBytes(raw)))]);
    hintEl.style.display = '';
    hintEl.style.color = 'var(--ink-mid)';
    hintEl.innerHTML = `→ <span class="mono-box inline" style="font-size:10px;">${escapeHtml(addr)}</span>`;
  } catch {
    hintEl.style.display = 'none';
  }
}

function setupTransferForm() {
  refreshRecipientRecents();
  // Invalidate a previously-rendered Preview whenever the form changes. Without
  // this, a user could Preview {asset A, amount X, recipient R}, then change
  // any field without re-previewing, then click Broadcast — and we'd send the
  // stale {A, X, R} job while the form visibly showed something else. Real
  // correctness risk for a local-wallet confirmation flow. Forces re-Preview
  // after any edit.
  const invalidatePreview = () => {
    pendingCXfer = null;
    const broadcastBtn = $('#btn-transfer-broadcast');
    if (broadcastBtn) broadcastBtn.disabled = true;
    const preview = $('#transfer-preview');
    if (preview) preview.style.display = 'none';
    // Don't clear #transfer-error — surfaces stay visible until user retries.
  };
  const recipientInput = $('#x-recipient-pub');
  if (recipientInput) {
    recipientInput.addEventListener('input', () => {
      updateDerivedAddressHint();
      invalidatePreview();
    });
    // Re-evaluate on tab activation in case of network switches.
    updateDerivedAddressHint();
  }
  const assetSel = $('#x-asset');
  if (assetSel) assetSel.addEventListener('change', () => {
    // Reset the UTXO picker — its options are per-asset, so a stale selection
    // from the previous asset would point at a UTXO that no longer applies.
    const pick = $('#x-utxo-pick'); if (pick) pick.value = '';
    updateTransferAmountHint();
    applyTransferUtxoLock();
    // Re-truncate any value already in the input — e.g. user pasted 18-decimal
    // ERC-20 amount, then picked an 8-decimal asset. Without this, the trim
    // wouldn't fire until the next keystroke.
    applyAmountTruncation();
    invalidatePreview();
  });
  const utxoPicker = $('#x-utxo-pick');
  if (utxoPicker) utxoPicker.addEventListener('change', () => {
    applyTransferUtxoLock();
    invalidatePreview();
  });
  const maxBtn = $('#btn-x-max');
  if (maxBtn) maxBtn.onclick = () => {
    const aid = $('#x-asset').value;
    const h = aid ? _transferHoldings.get(aid) : null;
    if (!h || h.balance <= 0n) return;
    $('#x-amount').value = fmtAssetAmountPlain(h.balance, h.decimals);
    // Max-fill never produces a trim, but clear any prior warn so the field
    // looks clean.
    const warn = $('#x-amount-warn'); if (warn) { warn.textContent = ''; warn.style.display = 'none'; }
    // Treat Max-fill as a value change for invalidation purposes — programmatic
    // .value = doesn't dispatch 'input', so do it explicitly.
    invalidatePreview();
  };
  const amountInput = $('#x-amount');
  if (amountInput) amountInput.addEventListener('input', () => {
    applyAmountTruncation();
    invalidatePreview();
  });
  updateTransferAmountHint();
  $('#btn-transfer-preview').onclick = async () => {
    const btn = $('#btn-transfer-preview');
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'previewing…';
    $('#transfer-error').textContent = '';
    $('#transfer-share').style.display = 'none';
    try {
      const assetIdHex = $('#x-asset').value;
      if (!assetIdHex) throw new Error('select an asset');
      const recipientPubHex = $('#x-recipient-pub').value.trim().toLowerCase().replace(/\s/g, '');
      if (!/^0[23][0-9a-f]{64}$/.test(recipientPubHex)) throw new Error('recipient pubkey must be 33-byte compressed hex');
      try { secp.ProjectivePoint.fromHex(recipientPubHex); } catch { throw new Error('recipient pubkey is not a valid point'); }
      const meta = getAssetMeta(assetIdHex);
      if (!meta) throw new Error('unknown asset');
      const amountStr = $('#x-amount').value.trim();
      if (!amountStr) throw new Error('enter an amount');
      const amount = parseAssetAmount(amountStr, meta.decimals);
      if (amount <= 0n) throw new Error('amount must be > 0');
      if (amount >= (1n << BigInt(N_BITS))) throw new Error(`amount must be < 2^${N_BITS} base units`);

      const holdings = await scanHoldings();
      const h = holdings.get(assetIdHex);
      if (!h || h.balance < amount) throw new Error(`insufficient balance: have ${h ? fmtAssetAmount(h.balance, meta.decimals) : 0}, need ${fmtAssetAmount(amount, meta.decimals)}`);

      // UTXO-picker integration. When the user chose a specific UTXO, resolve
      // it from the freshly-fetched holdings (the same snapshot the broadcast
      // will use) and pass it as forceUtxos so the picker doesn't fall back
      // to greedy-largest. Validate that the chosen UTXO covers the amount —
      // catches the edge case where an external change spent the UTXO between
      // form-fill and Preview.
      let forceUtxos = null;
      const pickerVal = $('#x-utxo-pick')?.value || '';
      if (pickerVal) {
        const [pTxid, pVoutStr] = pickerVal.split(':');
        const pVout = parseInt(pVoutStr, 10);
        const u = h.utxos.find(x => x.utxo.txid === pTxid && x.utxo.vout === pVout);
        if (!u) throw new Error(`chosen UTXO ${shorten(pTxid, 6)}:${pVout} is no longer in holdings — refresh and try again`);
        if (u.amount < amount) throw new Error(`chosen UTXO holds ${fmtAssetAmount(u.amount, meta.decimals)} ${meta.ticker} — less than the requested ${fmtAssetAmount(amount, meta.decimals)}`);
        forceUtxos = [u];
      }

      pendingCXfer = { assetIdHex, recipientPubHex, amount, ticker: meta.ticker, decimals: meta.decimals, forceUtxos };

      const recipientPub = hexToBytes(recipientPubHex);
      const recipientAddr = bech32.encode(NET.hrp, [0, ...bech32.toWords(hash160(recipientPub))]);
      const rate = await getFeeRate();
      const commitFeeEst = feeFor(estCommitVb(1), rate);
      // m=2 (recipient + change) is the standard transfer shape; assume 1
      // asset input is sufficient (the worst case where the user has many
      // small UTXOs would estimate slightly higher and over-pay by ~70 vb).
      const revealFeeEst = feeFor(estCXferRevealVb({ m: 2, numAssetIn: 1, hasSatsChange: true }), rate);
      const totalFeeEst = commitFeeEst + revealFeeEst;

      $('#transfer-preview').style.display = 'block';
      $('#transfer-preview').innerHTML = `
        <div class="tx-preview" style="margin-top:14px;">
          <h4>2 Bitcoin transactions</h4>
          <div class="row"><span class="idx">[1]</span><span class="label">commit tx</span> creates the on-chain envelope (locked until the reveal)</div>
          <div class="row"><span class="idx">[2]</span><span class="label">reveal tx</span> spends the envelope + your asset UTXO; the witness carries a ~1 KB privacy proof</div>
          <h4 style="margin-top:14px;">Reveal tx outputs</h4>
          <div class="row"><span class="idx">[0]</span><span class="label">recipient</span> ${fmtSats(DUST)} sats → ${escapeHtml(shorten(recipientAddr, 14))} <span class="muted">(commitment to their amount)</span></div>
          <div class="row"><span class="idx">[1]</span><span class="label">you (change)</span> ${fmtSats(DUST)} sats <span class="muted">(commitment to your remaining balance)</span></div>
          <h4 style="margin-top:14px;">What stays private</h4>
          <div class="row">recipient amount: ${fmtAssetAmount(amount, meta.decimals)} ${escapeHtml(meta.ticker)}</div>
          <div class="row">your change: ${fmtAssetAmount(h.balance - amount, meta.decimals)} ${escapeHtml(meta.ticker)}</div>
          <div class="row" style="color:var(--ink-mid);font-style:italic;">observers see only 33-byte commitments + a single 754-byte privacy proof — neither amount is visible</div>
          <h4 style="margin-top:14px;">After broadcast</h4>
          <div class="row" style="color:var(--ink-mid);">a share-link is generated — the recipient can recover their balance from chain alone, but the link lets them import immediately without rescanning</div>
          <h4 style="margin-top:14px;">Estimated fees</h4>
          <div>commit ~${commitFeeEst} sats · reveal ~${revealFeeEst} sats · total ~${totalFeeEst} sats @ ${rate} sat/vB</div>
        </div>`;
      $('#btn-transfer-broadcast').disabled = false;
    } catch (e) {
      $('#transfer-error').textContent = e.message;
      console.error(e);
      pendingCXfer = null;
      $('#btn-transfer-broadcast').disabled = true;
      $('#transfer-preview').style.display = 'none';
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  };
  $('#btn-transfer-broadcast').onclick = async () => {
    if (!pendingCXfer) return;
    // Snapshot so a re-Preview during the async broadcast can't mutate the in-flight job.
    const job = pendingCXfer;
    if (!ensureBurnerBackedUp('Transfer confidential asset (sender change UTXO is owned by the burner)')) {
      toast('Transfer cancelled. Back up the in-page privkey first, then retry.', '');
      return;
    }
    // Just-in-time funding: covers tx fees only. CXFER pulls the asset UTXO
    // for value, but the commit/reveal still need plain sats for the fee.
    const need = await estimateSatsForOp('cxfer');
    if (!(await ensureSatsFunded(need, 'Transferring'))) return;
    $('#btn-transfer-broadcast').disabled = true;
    $('#btn-transfer-broadcast').textContent = 'Sending…';
    const xferStrip = $('#transfer-progress');
    if (xferStrip) xferStrip.style.display = 'flex';
    setProgressStrip('transfer-progress', 0);
    try {
      await new Promise(r => setTimeout(r, 50));
      const r = await buildAndBroadcastCXfer({
        ...job,
        onProgress: (stage) => {
          if (stage === 'commit-start') setProgressStrip('transfer-progress', 1);
          else if (stage === 'reveal-start') setProgressStrip('transfer-progress', 2);
        },
      });
      setProgressStrip('transfer-progress', 4);
      setTimeout(() => { if (xferStrip) xferStrip.style.display = 'none'; setProgressStrip('transfer-progress', -1); }, 1200);
      // Optimistic balance debit: scanHoldings is invalidated and the next
      // render will reconcile from chain in 1-2s, but during that window the
      // Holdings card on the previous tab still shows the pre-send number.
      // Annotate the affected card with a pending overlay so the user sees
      // their action take effect immediately. The overlay is purely visual;
      // the actual balance source of truth is still the chain scan.
      applyOptimisticDebit(job.assetIdHex, BigInt(r.sendAmount));
      saveRecentRecipient(job.recipientPubHex);
      toast(`CXFER: commit=${shorten(r.commitTxid, 6)} · reveal=${shorten(r.revealTxid, 6)}`, 'success');
      markOnboarded();
      const link = encodeShareLink({
        txid: r.revealTxid, vout: 0, // recipient is at vout 0 in reveal tx
        assetIdHex: r.assetIdHex,
        amount: r.sendAmount,
        ticker: job.ticker, decimals: job.decimals,
      });
      $('#transfer-share').style.display = 'block';
      $('#transfer-share').innerHTML = `
        <div class="warn" style="border-left-color:var(--green);background:var(--bg-warm);">
          <strong>↓ Send this share-link to the recipient (optional notification)</strong>
          <div class="muted" style="font-size:11px;margin-top:4px;">A compatible wallet auto-recovers the amount from chain (the on-chain <code>amount_ct</code> is decryptable by the recipient via ECDH against your pubkey). The share-link just lets them import immediately and verify without waiting for a rescan.</div>
          <div class="mono-box" style="margin-top:10px;font-size:10px;">${escapeHtml(link)}</div>
          <div class="flex" style="margin-top:10px;">
            <button id="btn-copy-share" class="primary">Copy share-link</button>
            <a class="btn" href="${NET.explorer}/tx/${r.revealTxid}" target="_blank" rel="noopener noreferrer">View reveal tx ↗</a>
            <a class="btn" href="${NET.explorer}/tx/${r.commitTxid}" target="_blank" rel="noopener noreferrer">View commit tx ↗</a>
          </div>
        </div>`;
      $('#btn-copy-share').onclick = async () => {
        try { await navigator.clipboard.writeText(link); toast('Share-link copied', 'success'); }
        catch { prompt('Copy this share-link:', link); }
      };
      // Only clear the form if the user hasn't queued a new preview during broadcast.
      if (pendingCXfer === job) {
        pendingCXfer = null;
        $('#x-amount').value = '';
        $('#x-recipient-pub').value = '';
        $('#transfer-preview').style.display = 'none';
        // Clear any leftover decimal-truncation warn from the cleared amount.
        const warn = $('#x-amount-warn'); if (warn) { warn.textContent = ''; warn.style.display = 'none'; }
      }
      refreshWallet();
      // Re-scan asset balances so the dropdown, the inline hint, and the Max
      // button reflect the post-transfer state. The new change UTXO may take a
      // few seconds to index on mempool.space; users who hit "send another"
      // before that lands will see the prior balance briefly. Acceptable —
      // refreshWallet() is the same story for sats. The user can also hit the
      // wallet card's ↻ Refresh.
      refreshAssetSelect();
    } catch (e) {
      $('#transfer-error').textContent = e.message;
      if (xferStrip && xferStrip.style.display !== 'none') {
        const activeStep = xferStrip.querySelector('.progress-step.active');
        const errIdx = activeStep ? Number(activeStep.dataset.step) : -1;
        if (errIdx >= 0) setProgressStrip('transfer-progress', -1, { errorAt: errIdx });
      }
      console.error(e);
    } finally {
      $('#btn-transfer-broadcast').disabled = false;
      $('#btn-transfer-broadcast').textContent = '2. Confirm & send';
    }
  };
}

// ============== SATS-SEND UI ==============
// Plain-bitcoin-out flow on the Send tab. Mirrors the token-transfer pattern
// (live validation, decimals/balance hint, Max button, Preview→Confirm two-
// step) but the safety story is much heavier: the asset-UTXO exclusion logic
// is the only thing standing between a user and accidentally burning their
// tacit holdings. See the SATS SEND section above for the underlying
// primitives; everything UI-side here is plumbing on top of those.
let pendingSatsSend = null;

// Cached snapshot of the most-recent sats-utxo classification. Lets the amount
// hint and Max button render synchronously without re-scanning chain on every
// keystroke. Populated by refreshSatsSendBalance(); cleared on tab-leave so
// stale data doesn't drive stale Max calculations.
let _satsSendCache = null;

async function refreshSatsSendBalance() {
  const hint = $('#s-amount-hint');
  const maxBtn = $('#btn-s-max');
  if (!hint || !maxBtn) return;
  hint.textContent = 'loading…';
  maxBtn.disabled = true;
  try {
    const [holdings, allUtxos] = await Promise.all([
      scanHoldings(),
      getUtxos(wallet.address()),
    ]);
    if (!holdings || !(holdings instanceof Map)) throw new Error('holdings scan unavailable');
    const sats = selectSatsUtxosSafe(allUtxos, holdings);
    const total = sats.reduce((acc, u) => acc + (u.value || 0), 0);
    _satsSendCache = { sats, total, fetchedAt: Date.now() };
    hint.textContent = sats.length
      ? `· available ${total.toLocaleString('en-US')} sats across ${sats.length} UTXO${sats.length === 1 ? '' : 's'}`
      : '· no plain-sats UTXOs available';
    maxBtn.disabled = sats.length === 0;
  } catch (e) {
    _satsSendCache = null;
    hint.textContent = `· unable to load: ${e.message}`;
    maxBtn.disabled = true;
  }
}

// Live recipient-address validation hint. Mirrors updateDerivedAddressHint
// (token-mode) but for the bech32 P2WPKH path.
function updateSatsRecipientHint() {
  const inputEl = $('#s-recipient-addr');
  const hintEl = $('#s-recipient-hint');
  if (!inputEl || !hintEl) return;
  const raw = inputEl.value.trim().toLowerCase().replace(/\s/g, '');
  if (!raw) { hintEl.style.display = 'none'; hintEl.textContent = ''; return; }
  const decoded = decodeP2wpkhAddress(raw);
  if (!decoded) {
    hintEl.style.display = '';
    hintEl.style.color = 'var(--red)';
    // Specific nudges for common confusions, same approach as the token-recipient field.
    if (/^bc1p|^tb1p/.test(raw)) {
      hintEl.textContent = 'looks like a P2TR (taproot) address — currently we only send to P2WPKH (bc1q… / tb1q…). Route via another wallet for P2TR.';
    } else if (/^0x[0-9a-f]{40}$/.test(raw)) {
      hintEl.textContent = 'looks like an Ethereum address — sats-send needs a Bitcoin P2WPKH bech32 address (bc1q… on mainnet, tb1q… on signet).';
    } else if (/^[13]/.test(raw)) {
      hintEl.textContent = 'looks like a legacy Bitcoin address — currently we only send to bech32 P2WPKH (bc1q… / tb1q…).';
    } else {
      hintEl.textContent = 'not a valid P2WPKH bech32 address';
    }
    return;
  }
  if (decoded.hrp !== NET.hrp) {
    hintEl.style.display = '';
    hintEl.style.color = 'var(--red)';
    hintEl.textContent = `address is for ${decoded.hrp === 'bc' ? 'mainnet' : decoded.hrp === 'tb' ? 'signet/testnet' : decoded.hrp}, current network is ${NET.name} — switch network or use a matching address`;
    return;
  }
  hintEl.style.display = '';
  hintEl.style.color = 'var(--ink-mid)';
  hintEl.textContent = `→ valid P2WPKH on ${NET.name}`;
}

function setupSatsSendForm() {
  // Mode toggle — clicking either pill swaps the visible form. Token form is
  // the default (active class set in HTML); sats form is hidden initially.
  document.querySelectorAll('#send-mode-pills [data-send-mode]').forEach(btn => {
    btn.onclick = () => {
      const mode = btn.dataset.sendMode;
      document.querySelectorAll('#send-mode-pills [data-send-mode]').forEach(b => b.classList.toggle('active', b === btn));
      const tokenEl = $('#send-mode-token');
      const satsEl = $('#send-mode-sats');
      if (tokenEl) tokenEl.style.display = mode === 'token' ? '' : 'none';
      if (satsEl) satsEl.style.display = mode === 'sats' ? '' : 'none';
      if (mode === 'sats') refreshSatsSendBalance();
    };
  });

  // Invalidate a stale Preview if the user edits the form afterwards. Same
  // pattern as the token-transfer form — we never want Broadcast to operate
  // on a job whose visible form has since changed.
  const invalidatePreview = () => {
    pendingSatsSend = null;
    const broadcastBtn = $('#btn-sats-broadcast');
    if (broadcastBtn) broadcastBtn.disabled = true;
    const preview = $('#sats-preview');
    if (preview) preview.style.display = 'none';
  };

  const recipInput = $('#s-recipient-addr');
  if (recipInput) recipInput.addEventListener('input', () => {
    updateSatsRecipientHint();
    invalidatePreview();
  });

  const amountInput = $('#s-amount');
  if (amountInput) amountInput.addEventListener('input', () => {
    // Strip non-digits aggressively — sats are integers, no decimals.
    const cleaned = amountInput.value.replace(/[^0-9]/g, '');
    if (cleaned !== amountInput.value) amountInput.value = cleaned;
    invalidatePreview();
  });

  const maxBtn = $('#btn-s-max');
  if (maxBtn) maxBtn.onclick = async () => {
    if (!_satsSendCache || _satsSendCache.sats.length === 0) {
      await refreshSatsSendBalance();
      if (!_satsSendCache || _satsSendCache.sats.length === 0) return;
    }
    // Estimate fee assuming all sats UTXOs as inputs and no change (max send).
    let feeRate = 2;
    try { feeRate = await getFeeRate(); } catch {}
    const vb = estSatsSendVb(_satsSendCache.sats.length, false);
    const fee = feeFor(vb, feeRate);
    const max = _satsSendCache.total - fee;
    if (max < DUST) {
      $('#sats-error').textContent = `max amount after fees (~${fee} sats) would be below dust (${DUST}). Need more sats first.`;
      return;
    }
    $('#s-amount').value = String(max);
    $('#sats-error').textContent = '';
    invalidatePreview();
  };

  $('#btn-sats-preview').onclick = async () => {
    const btn = $('#btn-sats-preview');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'previewing…';
    $('#sats-error').textContent = '';
    $('#sats-success').style.display = 'none';
    try {
      const recipient = $('#s-recipient-addr').value.trim().toLowerCase().replace(/\s/g, '');
      const decoded = decodeP2wpkhAddress(recipient);
      if (!decoded) throw new Error('recipient is not a valid P2WPKH bech32 address');
      if (decoded.hrp !== NET.hrp) throw new Error(`address is for ${decoded.hrp === 'bc' ? 'mainnet' : 'signet/testnet'}, current network is ${NET.name}`);
      const amtStr = $('#s-amount').value.trim().replace(/[\s,]/g, '');
      const amtSats = Number(amtStr);
      if (!Number.isInteger(amtSats) || amtSats <= 0) throw new Error('enter a positive integer (sats)');
      if (amtSats < DUST) throw new Error(`amount must be at least ${DUST} sats`);

      const holdings = await scanHoldings();
      if (!holdings || !(holdings instanceof Map)) {
        throw new Error('could not classify asset UTXOs (holdings scan failed); not safe to send');
      }
      const allUtxos = await getUtxos(wallet.address());
      const sats = selectSatsUtxosSafe(allUtxos, holdings).sort((a, b) => b.value - a.value);
      if (sats.length === 0) throw new Error('no plain-sats UTXOs available to send');

      const feeRate = await getFeeRate();
      let picked = [], total = 0, fee = 0, hasChange = false, change = 0;
      for (let i = 0; i < sats.length; i++) {
        picked.push(sats[i]); total += sats[i].value;
        const feeWith = feeFor(estSatsSendVb(picked.length, true), feeRate);
        if (total >= amtSats + feeWith + DUST) {
          fee = feeWith; change = total - amtSats - fee; hasChange = true; break;
        }
        const feeNo = feeFor(estSatsSendVb(picked.length, false), feeRate);
        if (total >= amtSats + feeNo) {
          fee = feeNo; change = 0; hasChange = false; break;
        }
      }
      if (fee === 0) throw new Error(`insufficient sats: have ${total}, need ${amtSats} + fees (~${feeFor(estSatsSendVb(picked.length, true), feeRate)})`);

      pendingSatsSend = { recipient, amtSats, picked, fee, change, feeRate };

      // Render preview with explicit input audit so the user can sanity-check
      // exactly which UTXOs are about to be spent.
      $('#sats-preview').style.display = 'block';
      $('#sats-preview').innerHTML = `
        <div class="tx-preview" style="margin-top:14px;">
          <h4>review · sats-send</h4>
          <div class="row"><span class="label">Recipient</span> <code>${escapeHtml(recipient)}</code></div>
          <div class="row"><span class="label">Send amount</span> ${amtSats.toLocaleString('en-US')} sats</div>
          <div class="row"><span class="label">Network fee</span> ~${fee.toLocaleString('en-US')} sats @ ${feeRate} sat/vB</div>
          <div class="row"><span class="label">Change to you</span> ${hasChange ? change.toLocaleString('en-US') + ' sats' : '0 (donated to fee)'}</div>
          <h4 style="margin-top:14px;">inputs being spent (${picked.length})</h4>
          ${picked.map(u => `<div class="row" style="font-family:var(--mono);font-size:11px;">${escapeHtml(u.txid.slice(0, 12))}…:${u.vout} · ${u.value.toLocaleString('en-US')} sats</div>`).join('')}
          <div class="row" style="color:var(--ink-mid);font-style:italic;margin-top:8px;font-size:11px;">these are non-asset UTXOs at your address. asset UTXOs holding tacit tokens are excluded automatically.</div>
        </div>`;
      $('#btn-sats-broadcast').disabled = false;
    } catch (e) {
      $('#sats-error').textContent = e.message;
      pendingSatsSend = null;
      $('#btn-sats-broadcast').disabled = true;
      $('#sats-preview').style.display = 'none';
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  };

  $('#btn-sats-broadcast').onclick = async () => {
    if (!pendingSatsSend) return;
    const job = pendingSatsSend;
    if (!ensureBurnerBackedUp('Send sats from the local tacit wallet')) {
      toast('Send cancelled. Back up the in-page privkey first, then retry.', '');
      return;
    }
    const btn = $('#btn-sats-broadcast');
    btn.disabled = true; btn.textContent = 'broadcasting…';
    try {
      // Re-run the full safety pipeline at broadcast time, not just sign and
      // ship the previewed tx. The buildAndBroadcastSatsSend helper does the
      // re-classification check for us so a race between Preview and Confirm
      // can't slip an asset UTXO through.
      const r = await buildAndBroadcastSatsSend({ recipientAddr: job.recipient, amountSats: job.amtSats });
      toast(`Sent ${r.recipientValue.toLocaleString('en-US')} sats · ${shorten(r.txid, 6)}`, 'success');
      if (pendingSatsSend === job) {
        pendingSatsSend = null;
        $('#s-amount').value = '';
        $('#s-recipient-addr').value = '';
        $('#sats-preview').style.display = 'none';
        $('#sats-error').textContent = '';
      }
      $('#sats-success').style.display = 'block';
      $('#sats-success').innerHTML = `
        <div class="warn" style="border-left-color:var(--green);background:var(--bg-warm);">
          <strong>✓ Sent ${r.recipientValue.toLocaleString('en-US')} sats</strong>
          <div class="muted" style="font-size:11px;margin-top:4px;">to <code>${escapeHtml(job.recipient)}</code></div>
          <div class="flex" style="margin-top:10px;">
            <a class="btn" href="${NET.explorer}/tx/${r.txid}" target="_blank" rel="noopener noreferrer">View tx ↗</a>
          </div>
        </div>`;
      refreshWallet();
      refreshSatsSendBalance();
    } catch (e) {
      $('#sats-error').textContent = e.message;
      console.error(e);
    } finally {
      btn.disabled = false; btn.textContent = '2. Confirm & send';
    }
  };
}

// ============== DROPS (airdrop issuer tab) ==============
// Snapshot composer state. Each "source" is one ERC-20 (or other token) CSV
// with its own decimal precision; sources are parsed at the chosen target
// asset's decimals (floor truncation), then summed per-address into one merged
// snapshot before computing the merkle root.
let _dropSources = new Map();   // sourceId → { ticker, sourceDecimals, csvText, fileName, parsedRows | null, error | null }
let _dropSourceNextId = 1;
let _dropBuilt = null;          // { commit, sourceStats, blacklistSize, totalRowsBeforeBlacklist }
let _dropPinnedCid = null;      // 'ipfs://...' once pinned
let _dropFulfilCurrent = null;  // active drop being fulfilled
let _dropFulfilStaged = null;   // verified batch: { drop, items: [{leafIndex, tacitPubHex, ethAddrHex, amount}] }
let _dropCrossCheckCurrent = null;  // active drop being cross-checked

function _dropsStorageKey() { return `tacit-drops-v1:${NET.name}`; }
function loadSavedDrops() {
  try { return JSON.parse(localStorage.getItem(_dropsStorageKey()) || '[]') || []; }
  catch { return []; }
}
function saveDrops(arr) {
  localStorage.setItem(_dropsStorageKey(), JSON.stringify(arr));
}
function _dropIdFor(rootHex, assetIdHex) {
  // Stable per (root, asset) so duplicate save attempts overwrite the same record.
  return bytesToHex(sha256(concatBytes(hexToBytes(rootHex), hexToBytes(assetIdHex)))).slice(0, 32);
}

// ============== DROP FULFILMENT LEASE LOCK ==============
// Prevents concurrent fulfilment broadcasts of the same drop from two browser
// tabs (or concurrent calls in any other scenario where state changes overlap).
// localStorage is shared across tabs but has no native CAS; the pending-entry
// in-flight lock alone has a TOCTOU window at phase-1 write where two tabs
// could each race to add the same leaves before either sees the other's write.
//
// The lease layer here serializes the entire broadcast handler against
// concurrent broadcasts of the SAME drop_id. Different drops can fulfil in
// parallel safely (no shared state).
//
// Mechanism:
//   - Each tab gets a random tab_id stored in sessionStorage (per-tab, not shared).
//   - Lease in localStorage at `tacit-drop-lease-v1:<network>:<drop_id>` records
//     `{ tab_id, acquired_at, expires_at }` with TTL ≥ a typical broadcast latency.
//   - Acquire reads existing lease; rejects if a different tab_id holds an
//     unexpired lease; otherwise writes its own and re-reads to verify it won
//     the (very narrow) write race.
//   - Release writes only if we still hold the lease.
//   - Stale leases (e.g. tab crashed mid-broadcast) auto-expire; another tab
//     can take over after TTL.
const DROP_LEASE_TTL_MS = 10 * 60 * 1000;  // 10 min — generous for slow mempool

function _ensureTabId() {
  try {
    let id = sessionStorage.getItem('tacit-tab-id-v1');
    if (!id) {
      id = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
      sessionStorage.setItem('tacit-tab-id-v1', id);
    }
    return id;
  } catch {
    // If sessionStorage is unavailable (very locked-down browsers), fall back
    // to a per-page-load random ID. Lock will still work within a single
    // broadcast call but won't survive page reloads — better than nothing.
    return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
  }
}

function _dropLeaseKey(dropId) {
  return `tacit-drop-lease-v1:${NET.name}:${dropId}`;
}

// Acquire the lease for `dropId`. Returns:
//   { ok: true,  tabId, expiresAt } on success
//   { ok: false, ownedBy, expiresAt } on conflict (another tab holds it)
function acquireDropLease(dropId, ttlMs = DROP_LEASE_TTL_MS) {
  const tabId = _ensureTabId();
  const key = _dropLeaseKey(dropId);
  const now = Date.now();

  // Check existing lease
  const existingRaw = localStorage.getItem(key);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      if (existing && typeof existing === 'object'
          && typeof existing.tab_id === 'string'
          && Number.isInteger(existing.expires_at)
          && existing.tab_id !== tabId
          && existing.expires_at > now) {
        return { ok: false, ownedBy: existing.tab_id, expiresAt: existing.expires_at };
      }
    } catch { /* malformed lease, treat as absent */ }
  }

  // Write our lease
  const lease = { tab_id: tabId, acquired_at: now, expires_at: now + ttlMs, drop_id: dropId };
  localStorage.setItem(key, JSON.stringify(lease));

  // Re-read and verify we won the race (narrows TOCTOU window from the time
  // between read and write to the time between write and re-read; effectively
  // microseconds, so the practical race window is closed for human-clicked
  // events).
  const verifyRaw = localStorage.getItem(key);
  if (verifyRaw) {
    try {
      const verify = JSON.parse(verifyRaw);
      if (verify && verify.tab_id === tabId) {
        return { ok: true, tabId, expiresAt: lease.expires_at };
      }
      return { ok: false, ownedBy: verify?.tab_id || 'unknown', expiresAt: verify?.expires_at || 0 };
    } catch {
      return { ok: false, ownedBy: 'unknown', expiresAt: 0 };
    }
  }
  return { ok: false, ownedBy: 'unknown', expiresAt: 0 };
}

// Release the lease IF we still own it. No-op if someone else holds it now
// (don't release another tab's lease — they may be mid-broadcast).
function releaseDropLease(dropId) {
  const tabId = _ensureTabId();
  const key = _dropLeaseKey(dropId);
  try {
    const existingRaw = localStorage.getItem(key);
    if (!existingRaw) return;
    const existing = JSON.parse(existingRaw);
    if (existing && existing.tab_id === tabId) {
      localStorage.removeItem(key);
    }
  } catch { /* best-effort */ }
}

// Refresh the lease's expiry IF we still own it. Useful for very long
// broadcasts that exceed the original TTL.
function refreshDropLease(dropId, ttlMs = DROP_LEASE_TTL_MS) {
  const tabId = _ensureTabId();
  const key = _dropLeaseKey(dropId);
  try {
    const existingRaw = localStorage.getItem(key);
    if (!existingRaw) return false;
    const existing = JSON.parse(existingRaw);
    if (!existing || existing.tab_id !== tabId) return false;
    existing.expires_at = Date.now() + ttlMs;
    localStorage.setItem(key, JSON.stringify(existing));
    return true;
  } catch { return false; }
}

function refreshDropsTab() {
  // Re-render across tab entry. Sources and built snapshot persist within a
  // session (user might tab away mid-edit and come back).
  refreshDropAssetSelect();
  _renderDropSources();
  _renderDropAssetMeta();
  renderSavedDropsList();
  if (_dropBuilt) _renderBuildPreview();
}

function refreshDropAssetSelect() {
  const sel = $('#drop-asset');
  if (!sel) return;
  // Source: registered asset metadata that the user has openable holdings for.
  // We use openable holdings (not just metadata) because the user can only
  // fulfil from assets they actually hold.
  scanHoldings().then(holdings => {
    const prev = sel.value;
    sel.innerHTML = '<option value="">— select —</option>';
    for (const [aid, h] of holdings) {
      if (h.balance <= 0n) continue;
      const opt = document.createElement('option');
      opt.value = aid;
      opt.textContent = `${h.ticker || '???'} · balance ${fmtAssetAmount(h.balance, h.decimals)} · ${shorten(aid, 10)}`;
      sel.appendChild(opt);
    }
    if (prev) sel.value = prev;
    _renderDropAssetMeta();
    _refreshDropSaveButtonState();
  }).catch(() => { /* network may be flaky; user can retry by switching tabs */ });
}

function renderSavedDropsList() {
  const list = $('#drop-list');
  if (!list) return;
  const drops = loadSavedDrops();
  setTabBadge('drops', drops.length);
  if (!drops.length) {
    list.innerHTML = `<div class="empty" style="font-size:12px;">No drops saved yet.</div>`;
    return;
  }
  drops.sort((a, b) => b.created_at - a.created_at);
  list.innerHTML = drops.map(d => {
    const fulfilledCount = (d.fulfilled || []).length;
    const total = BigInt(d.total_amount);
    const remainingLeaves = d.count - fulfilledCount;
    const cidLine = d.snapshot_cid
      ? `<a href="https://gateway.pinata.cloud/ipfs/${escapeHtml(d.snapshot_cid.replace(/^ipfs:\/\//, ''))}" target="_blank" rel="noopener">${escapeHtml(shorten(d.snapshot_cid, 12))}</a>`
      : `<span class="muted">unpinned</span>`;
    // Publish-state badge: a drop is "discoverable" once it has been
    // announced via the worker. Recipients without the (root, cid) pair can
    // then find it by connecting MetaMask.
    const announced = d.announced_at && (!d.announced_expires_at || d.announced_expires_at > Math.floor(Date.now() / 1000));
    const announceBadge = announced
      ? `<span class="status-pill confirmed" style="font-size:9px;">discoverable</span>`
      : `<span class="status-pill pending" style="font-size:9px;">private</span>`;
    const publishLabel = announced ? 'Update announcement' : 'Publish to discovery';
    const canPublish = !!d.snapshot_cid;  // need a pinned snapshot first
    const publishTitle = canPublish
      ? 'Sign + post a discovery announcement so recipients can find this drop in their Claim tab'
      : 'Pin the snapshot to IPFS first';
    return `
      <div class="card" style="margin-bottom:8px;">
        <div class="flex" style="justify-content:space-between;align-items:flex-start;">
          <div>
            <strong>${escapeHtml(d.asset_ticker || '???')}</strong>
            ${announceBadge}
            <span class="muted" style="font-size:11px;"> · root <code>${escapeHtml(shorten(d.merkle_root_hex, 10))}</code></span>
          </div>
          <div class="muted" style="font-size:11px;">${relTime(d.created_at)}</div>
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px;">
          ${d.count} recipients · ${fmtAssetAmount(total, d.asset_decimals)} ${escapeHtml(d.asset_ticker || '')} total · snapshot: ${cidLine}
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px;">
          fulfilled: ${fulfilledCount} / ${d.count} · ${remainingLeaves} pending
        </div>
        <div class="flex" style="gap:6px;margin-top:8px;">
          <button data-act="drop-fulfil" data-drop-id="${escapeHtml(d.drop_id)}" type="button">Fulfil claims</button>
          <button data-act="drop-publish" data-drop-id="${escapeHtml(d.drop_id)}" type="button" ${canPublish ? '' : 'disabled'} title="${escapeHtml(publishTitle)}">${escapeHtml(publishLabel)}</button>
          ${announced ? `<button data-act="drop-unpublish" data-drop-id="${escapeHtml(d.drop_id)}" type="button" title="Sign a cancel and remove the announcement from discovery">Unpublish</button>` : ''}
          <button data-act="drop-crosscheck" data-drop-id="${escapeHtml(d.drop_id)}" type="button" title="Verify each fulfilled[] entry against on-chain state">Cross-check</button>
          <button data-act="drop-export" data-drop-id="${escapeHtml(d.drop_id)}" type="button">Export JSON</button>
          <button data-act="drop-copy-root" data-drop-id="${escapeHtml(d.drop_id)}" type="button">Copy root</button>
          <button data-act="drop-delete" data-drop-id="${escapeHtml(d.drop_id)}" type="button" title="Delete this drop record (does NOT undo any fulfilled CXFERs)">Delete</button>
        </div>
      </div>
    `;
  }).join('');
  // Wire row buttons
  list.querySelectorAll('button[data-act]').forEach(btn => {
    btn.onclick = () => _handleDropRowAction(btn.dataset.act, btn.dataset.dropId);
  });
}

function _handleDropRowAction(act, dropId) {
  const drops = loadSavedDrops();
  const d = drops.find(x => x.drop_id === dropId);
  if (!d) { toast('drop record not found', 'error'); return; }
  if (act === 'drop-fulfil') {
    _openDropFulfil(d);
  } else if (act === 'drop-export') {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `drop-${shorten(d.merkle_root_hex, 8)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } else if (act === 'drop-copy-root') {
    navigator.clipboard?.writeText(d.merkle_root_hex)
      .then(() => toast('Merkle root copied', 'success'))
      .catch(() => prompt('Copy merkle root:', d.merkle_root_hex));
  } else if (act === 'drop-crosscheck') {
    _openDropCrossCheck(d);
  } else if (act === 'drop-delete') {
    if (!confirm(`Delete drop record for ${d.asset_ticker} (root ${shorten(d.merkle_root_hex, 8)})?\n\nThis only removes the local record. It does NOT undo any CXFERs already fulfilled. The remaining treasury balance is unaffected.`)) return;
    const filtered = drops.filter(x => x.drop_id !== dropId);
    saveDrops(filtered);
    renderSavedDropsList();
    if (_dropFulfilCurrent && _dropFulfilCurrent.drop_id === dropId) _closeDropFulfil();
    if (_dropCrossCheckCurrent && _dropCrossCheckCurrent.drop_id === dropId) _closeDropCrossCheck();
    toast('Drop record deleted', 'success');
  } else if (act === 'drop-publish') {
    _publishDropAnnouncement(d);
  } else if (act === 'drop-unpublish') {
    _unpublishDropAnnouncement(d);
  }
}

// Publishes a signed announcement to the worker's /drops endpoint so that
// recipients in the Claim tab can discover the drop without manually pasting
// (root, cid). The announcement is BIP-340-signed by the active wallet's
// tacit pubkey; the worker re-verifies before storing. Re-publishing the
// same root overwrites — useful for renewing the expiry or fixing a typo'd
// note. Idempotent: the worker key is `(network, root)`.
const _DROP_DEFAULT_TTL_DAYS = 90;
async function _publishDropAnnouncement(d) {
  if (!WORKER_BASE) { toast('Worker not configured', 'error'); return; }
  if (!d.snapshot_cid) { toast('Pin the snapshot to IPFS first', 'error'); return; }
  // Default TTL of 90 days from now; user can override with a freeform prompt.
  // The worker rejects expiries > 1 year so we don't need to clamp here.
  const ttlInput = prompt(
    `Publish "${d.asset_ticker}" drop to discovery?\n\n` +
    `Recipients connecting MetaMask in the Claim tab will see this drop and any amount they're entitled to.\n\n` +
    `Days until announcement expires (1–365):`,
    String(_DROP_DEFAULT_TTL_DAYS),
  );
  if (ttlInput === null) return;
  const ttlDays = parseInt(ttlInput, 10);
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
    toast('TTL must be 1–365 days', 'error');
    return;
  }
  const note = prompt('Optional note (≤200 chars). Surfaces alongside the drop in recipients\' Claim tab:', d.announced_note || '') ?? '';
  if (note.length > 200) { toast('note must be ≤200 chars', 'error'); return; }

  const expiresAt = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const cid = String(d.snapshot_cid).replace(/^ipfs:\/\//, '');
  const network = d.network || NET.name;
  // Saved drops use `asset_id_hex` (the local-record field name, distinct
  // from the worker registry's `asset_id` shape). Older drop records in
  // localStorage may still carry `asset_id`, so accept either; surface a
  // clear error if neither is present.
  const assetIdHex = d.asset_id_hex || d.asset_id;
  if (!/^[0-9a-f]{64}$/i.test(String(assetIdHex || ''))) {
    toast('drop record missing asset_id (corrupt local record)', 'error');
    return;
  }
  const issuerPub = wallet.pub;            // 33-byte compressed
  const issuerXOnly = issuerPub.slice(1);  // x-only for Schnorr

  let sigHex;
  try {
    const msg = dropAnnounceMsgBytes(network, assetIdHex, d.merkle_root_hex, cid, expiresAt, note);
    sigHex = bytesToHex(signSchnorr(msg, wallet.priv));
    // Belt-and-suspenders: verify locally before posting so we never ship a
    // sig the worker would reject — saves a round-trip and surfaces the
    // failure with a concrete cause if our local signing is broken.
    if (!verifySchnorr(hexToBytes(sigHex), msg, issuerXOnly)) {
      throw new Error('local Schnorr verify failed (bug?)');
    }
  } catch (e) {
    toast('sign failed: ' + e.message, 'error');
    return;
  }

  const body = {
    asset_id: assetIdHex,
    merkle_root: d.merkle_root_hex,
    ipfs_cid: cid,
    issuer_pubkey: bytesToHex(issuerPub),
    expires_at: expiresAt,
    note,
    announce_sig: sigHex,
  };
  try {
    const resp = await fetch(withNet(DROPS_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `worker ${resp.status}`);
    }
    // Persist announcement state on the local drop record so
    // renderSavedDropsList can reflect "discoverable" vs "private" without
    // round-tripping the worker.
    const drops = loadSavedDrops();
    const i = drops.findIndex(x => x.drop_id === d.drop_id);
    if (i >= 0) {
      drops[i].announced_at = Math.floor(Date.now() / 1000);
      drops[i].announced_expires_at = expiresAt;
      drops[i].announced_note = note;
      saveDrops(drops);
    }
    renderSavedDropsList();
    toast(`Drop published · expires in ${ttlDays}d`, 'success');
  } catch (e) {
    toast('publish failed: ' + e.message, 'error');
  }
}

async function _unpublishDropAnnouncement(d) {
  if (!WORKER_BASE) { toast('Worker not configured', 'error'); return; }
  if (!confirm(`Remove "${d.asset_ticker}" from discovery?\n\nRecipients who already saved the (root, CID) can still claim manually. This only hides the announcement from the Claim tab's eligible-drops list.`)) return;
  const issuerPub = wallet.pub;
  const issuerXOnly = issuerPub.slice(1);
  const network = d.network || NET.name;
  let sigHex;
  try {
    const msg = dropAnnounceCancelMsgBytes(network, d.merkle_root_hex, bytesToHex(issuerPub));
    sigHex = bytesToHex(signSchnorr(msg, wallet.priv));
    if (!verifySchnorr(hexToBytes(sigHex), msg, issuerXOnly)) throw new Error('local Schnorr verify failed');
  } catch (e) {
    toast('sign failed: ' + e.message, 'error');
    return;
  }
  try {
    const resp = await fetch(withNet(DROP_URL(d.merkle_root_hex)), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issuer_pubkey: bytesToHex(issuerPub),
        cancel_sig: sigHex,
      }),
    });
    if (!resp.ok && resp.status !== 404) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `worker ${resp.status}`);
    }
    const drops = loadSavedDrops();
    const i = drops.findIndex(x => x.drop_id === d.drop_id);
    if (i >= 0) {
      delete drops[i].announced_at;
      delete drops[i].announced_expires_at;
      delete drops[i].announced_note;
      saveDrops(drops);
    }
    renderSavedDropsList();
    toast('Drop unpublished', 'success');
  } catch (e) {
    toast('unpublish failed: ' + e.message, 'error');
  }
}

function _refreshDropSaveButtonState() {
  const saveBtn = $('#btn-drop-save');
  const pinBtn = $('#btn-drop-pin-snapshot');
  const haveSnapshot = !!_dropBuilt;
  const haveAsset = !!$('#drop-asset')?.value;
  if (saveBtn) saveBtn.disabled = !(haveSnapshot && haveAsset);
  if (pinBtn) pinBtn.disabled = !haveSnapshot;
}

function _renderDropAssetMeta() {
  const aid = $('#drop-asset')?.value || '';
  const meta = aid ? getAssetMeta(aid) : null;
  const out = $('#drop-asset-meta');
  if (!out) return;
  if (!meta) { out.textContent = ''; return; }
  out.innerHTML = `target decimals: <strong>${meta.decimals}</strong> · ticker: <strong>${escapeHtml(meta.ticker || '?')}</strong>`;
}

function _renderDropSources() {
  const container = $('#drop-sources');
  if (!container) return;
  if (_dropSources.size === 0) {
    container.innerHTML = `<div class="empty" style="font-size:11px;">No sources added. Click "Add source" to begin.</div>`;
    return;
  }
  let i = 0;
  container.innerHTML = '';
  for (const [sid, src] of _dropSources) {
    i++;
    const div = document.createElement('div');
    div.className = 'card';
    div.style.cssText = 'margin-bottom:8px;';
    const status = src.error
      ? `<span style="color:var(--red);">⚠ ${escapeHtml(src.error)}</span>`
      : src.parsedRows
        ? `<span style="color:var(--green);">✓ ${src.parsedRows.length} rows · ${escapeHtml(src.fileName || 'pasted')}</span>`
        : `<span class="muted">⏳ not parsed yet</span>`;
    div.innerHTML = `
      <div class="flex" style="justify-content:space-between;align-items:center;">
        <strong>Source ${i}</strong>
        <button data-act="drop-src-remove" data-sid="${sid}" type="button" title="Remove this source">×</button>
      </div>
      <div class="flex" style="gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap;">
        <label style="margin:0;flex-basis:100%;">Label (display only)</label>
        <input data-act="drop-src-ticker" data-sid="${sid}" type="text" placeholder="e.g. USDC" value="${escapeHtml(src.ticker || '')}" style="flex:1;min-width:120px;">
        <label style="margin:0;">Decimals</label>
        <input data-act="drop-src-decimals" data-sid="${sid}" type="number" min="0" max="36" value="${src.sourceDecimals}" style="width:70px;">
      </div>
      <div class="flex" style="gap:6px;align-items:center;margin-top:6px;">
        <input data-act="drop-src-file" data-sid="${sid}" type="file" accept=".csv,.tsv,.txt" style="flex:1;">
      </div>
      <details style="margin-top:6px;"><summary class="muted" style="cursor:pointer;font-size:11px;">…or paste CSV text</summary>
        <textarea data-act="drop-src-text" data-sid="${sid}" rows="4" style="margin-top:6px;font-family:var(--mono);font-size:11px;" placeholder='"HolderAddress","Balance","PendingBalanceUpdate"&#10;"0x...","100.0","No"'>${escapeHtml(src.csvText || '')}</textarea>
      </details>
      <div style="margin-top:6px;font-size:11px;">${status}</div>
    `;
    container.appendChild(div);
  }
  // Wire row event listeners
  container.querySelectorAll('[data-act]').forEach(el => {
    const sid = Number(el.dataset.sid);
    const act = el.dataset.act;
    if (act === 'drop-src-remove') {
      el.onclick = () => { _dropSources.delete(sid); _invalidateBuilt(); _renderDropSources(); };
    } else if (act === 'drop-src-ticker') {
      el.oninput = () => { const s = _dropSources.get(sid); if (s) s.ticker = el.value; _invalidateBuilt(); };
    } else if (act === 'drop-src-decimals') {
      el.oninput = () => {
        const s = _dropSources.get(sid);
        if (!s) return;
        const v = parseInt(el.value, 10);
        if (Number.isInteger(v) && v >= 0 && v <= 36) s.sourceDecimals = v;
        _invalidateBuilt();
      };
    } else if (act === 'drop-src-file') {
      el.onchange = async () => {
        const file = el.files?.[0];
        if (!file) return;
        const s = _dropSources.get(sid);
        if (!s) return;
        try {
          s.csvText = await file.text();
          s.fileName = file.name;
          s.parsedRows = null; s.error = null;
        } catch (e) { s.error = e.message; }
        _invalidateBuilt();
        _renderDropSources();
      };
    } else if (act === 'drop-src-text') {
      el.oninput = () => {
        const s = _dropSources.get(sid);
        if (s) { s.csvText = el.value; s.fileName = s.fileName || null; s.parsedRows = null; s.error = null; }
        _invalidateBuilt();
      };
    }
  });
}

function _invalidateBuilt() {
  _dropBuilt = null;
  _dropPinnedCid = null;
  const out = $('#drop-build-preview');
  if (out) { out.style.display = 'none'; out.innerHTML = ''; }
  const saveOut = $('#drop-save-out');
  if (saveOut) saveOut.innerHTML = '';
  _refreshDropSaveButtonState();
}

function _addDropSource() {
  if (_dropSources.size >= 6) {
    toast('max 6 sources per snapshot', 'error');
    return;
  }
  const sid = _dropSourceNextId++;
  _dropSources.set(sid, {
    ticker: '',
    sourceDecimals: 18,
    csvText: '',
    fileName: null,
    parsedRows: null,
    error: null,
  });
  _renderDropSources();
}

function _buildDropSnapshot() {
  const errEl = $('#drop-build-err');
  if (errEl) errEl.textContent = '';
  if (_dropSources.size === 0) throw new Error('add at least one source');
  const aid = $('#drop-asset')?.value;
  if (!aid) throw new Error('select a target asset');
  const meta = getAssetMeta(aid);
  if (!meta) throw new Error('target asset metadata missing');
  const targetDecimals = meta.decimals;

  // Parse blacklist once.
  const blacklistText = $('#drop-blacklist')?.value || '';
  const blacklist = parseBlacklist(blacklistText);

  // Parse each source with the chosen target decimals.
  const rowSets = [];
  const sourceStats = [];
  let i = 0;
  for (const [sid, src] of _dropSources) {
    i++;
    if (!src.csvText || !src.csvText.trim()) {
      throw new Error(`source ${i} (${src.ticker || 'unlabeled'}) has no CSV loaded`);
    }
    let rows;
    try {
      rows = parseAirdropCSV(src.csvText, {
        sourceDecimals: src.sourceDecimals,
        targetDecimals,
        blacklist,
      });
    } catch (e) {
      src.error = e.message;
      _renderDropSources();
      throw new Error(`source ${i} (${src.ticker || 'unlabeled'}): ${e.message}`);
    }
    src.parsedRows = rows;
    src.error = null;
    rowSets.push(rows);
    sourceStats.push({
      ticker: src.ticker || `Source ${i}`,
      sourceDecimals: src.sourceDecimals,
      rowCount: rows.length,
      droppedDust: rows.droppedDust || 0,
      droppedBlacklist: rows.droppedBlacklist || 0,
      total: rows.reduce((s, r) => s + r.amount, 0n),
    });
  }
  _renderDropSources();

  const merged = mergeAirdropRows(rowSets);
  if (merged.length === 0) throw new Error('all rows excluded — check blacklist or sources');
  if (merged.length > (1 << 20)) throw new Error(`merged snapshot too large: ${merged.length} rows (cap 2^20)`);

  const commit = computeAirdropCommitment(merged);
  _dropBuilt = {
    commit,
    sourceStats,
    blacklistSize: blacklist.size,
    totalRowsBeforeBlacklist: rowSets.reduce((s, rs) => s + rs.length, 0) + blacklist.size, // approximation
    targetDecimals,
    targetTicker: meta.ticker,
    targetAssetId: aid,
  };
  _dropPinnedCid = null;
  return _dropBuilt;
}

function _renderBuildPreview() {
  const out = $('#drop-build-preview');
  if (!out) return;
  if (!_dropBuilt) { out.style.display = 'none'; out.innerHTML = ''; return; }
  const { commit, sourceStats, blacklistSize, targetDecimals, targetTicker } = _dropBuilt;
  const { count, total, root, rows } = commit;
  const rootHex = bytesToHex(root);
  const sample = rows.slice(0, 5).map(r =>
    `<div class="row" style="font-family:var(--mono);font-size:11px;"><span class="idx">[${r.index}]</span> 0x${r.ethAddrHex} → ${fmtAssetAmountPlain(r.amount, targetDecimals)} ${escapeHtml(targetTicker)}</div>`,
  ).join('');
  const sourceLines = sourceStats.map((s, i) => {
    const dropNotes = [];
    if (s.droppedDust > 0) dropNotes.push(`${s.droppedDust} sub-precision`);
    if (s.droppedBlacklist > 0) dropNotes.push(`${s.droppedBlacklist} blacklisted`);
    const dropTail = dropNotes.length ? ` · <span class="muted">excluded: ${dropNotes.join(', ')}</span>` : '';
    return `<div class="row" style="font-size:11px;"><span class="idx">[${i + 1}]</span> ${escapeHtml(s.ticker)} · src decimals ${s.sourceDecimals} · ${s.rowCount} rows post-truncation · ${fmtAssetAmountPlain(s.total, targetDecimals)} ${escapeHtml(targetTicker)}${dropTail}</div>`;
  }).join('');
  out.style.display = 'block';
  out.innerHTML = `
    <div class="tx-preview">
      <h4>Merged snapshot</h4>
      <div class="row"><span class="label">unique recipients</span><strong>${count}</strong></div>
      <div class="row"><span class="label">total payout</span><strong>${fmtAssetAmountPlain(total, targetDecimals)} ${escapeHtml(targetTicker)}</strong></div>
      <div class="row"><span class="label">merkle root</span><code style="font-size:11px;">${escapeHtml(rootHex)}</code></div>
      ${blacklistSize > 0 ? `<div class="row"><span class="label">blacklist</span>${blacklistSize} address${blacklistSize === 1 ? '' : 'es'} excluded across all sources</div>` : ''}
      <h4 style="margin-top:14px;">Per-source contribution</h4>
      ${sourceLines}
      <h4 style="margin-top:14px;">First 5 merged rows</h4>
      ${sample}
      ${count > 5 ? `<div class="muted" style="font-size:11px;margin-top:4px;">… ${count - 5} more</div>` : ''}
    </div>
  `;
}

async function _pinDropSnapshot() {
  if (!_dropBuilt) throw new Error('build a snapshot first');
  if (!WORKER_BASE) throw new Error('worker disabled — set WORKER_BASE to enable IPFS pinning');
  const blob = serialiseAirdropSnapshot({
    assetIdHex: _dropBuilt.targetAssetId,
    network: NET.name,
    rows: _dropBuilt.commit.rows,
    root: _dropBuilt.commit.root,
    ticker: _dropBuilt.targetTicker,
    decimals: _dropBuilt.targetDecimals,
  });
  // Decorate with source-stat metadata so auditors can verify the merge later.
  blob.sources = _dropBuilt.sourceStats.map(s => ({
    label: s.ticker,
    source_decimals: s.sourceDecimals,
    row_count: s.rowCount,
    total: s.total.toString(),
  }));
  blob.blacklist_size = _dropBuilt.blacklistSize;
  const resp = await fetch(WORKER_BASE + '/pin-json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(blob),
  });
  if (!resp.ok) throw new Error(`pin-json failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  const j = await resp.json();
  const cid = j.IpfsHash || j.cid || j.Hash;
  if (!cid) throw new Error('worker /pin-json returned no CID');
  _dropPinnedCid = `ipfs://${cid}`;
  return _dropPinnedCid;
}

function _saveDropRecord() {
  if (!_dropBuilt) throw new Error('build a snapshot first');
  const assetIdHex = _dropBuilt.targetAssetId;
  const meta = getAssetMeta(assetIdHex);
  if (!meta) throw new Error('asset metadata missing');
  const { commit, sourceStats, blacklistSize } = _dropBuilt;
  const rootHex = bytesToHex(commit.root);
  const dropId = _dropIdFor(rootHex, assetIdHex);
  const drops = loadSavedDrops();
  const existingIdx = drops.findIndex(d => d.drop_id === dropId);
  const record = {
    drop_id: dropId,
    network: NET.name,
    asset_id_hex: assetIdHex,
    asset_ticker: meta.ticker,
    asset_decimals: meta.decimals,
    merkle_root_hex: rootHex,
    total_amount: commit.total.toString(),
    count: commit.count,
    snapshot_cid: _dropPinnedCid,
    snapshot_pinned_at: _dropPinnedCid ? Math.floor(Date.now() / 1000) : null,
    rows: commit.rows.map(r => ({
      index: r.index, eth_address: '0x' + r.ethAddrHex, amount: r.amount.toString(),
    })),
    sources: sourceStats.map(s => ({
      label: s.ticker, source_decimals: s.sourceDecimals,
      row_count: s.rowCount, total: s.total.toString(),
    })),
    blacklist_size: blacklistSize,
    fulfilled: existingIdx >= 0 ? (drops[existingIdx].fulfilled || []) : [],
    created_at: existingIdx >= 0 ? drops[existingIdx].created_at : Math.floor(Date.now() / 1000),
  };
  if (existingIdx >= 0) drops[existingIdx] = record;
  else drops.push(record);
  saveDrops(drops);
  return record;
}

function _openDropFulfil(drop) {
  _dropFulfilCurrent = drop;
  _dropFulfilStaged = null;
  const sec = $('#drop-fulfil-section');
  if (sec) sec.style.display = '';
  const meta = $('#drop-fulfil-meta');
  if (meta) {
    meta.innerHTML = `
      <div><span class="label">asset</span> <strong>${escapeHtml(drop.asset_ticker)}</strong> · <code>${escapeHtml(shorten(drop.asset_id_hex, 12))}</code></div>
      <div><span class="label">root</span> <code style="font-size:11px;">${escapeHtml(drop.merkle_root_hex)}</code></div>
      <div><span class="label">recipients</span> ${drop.count} · fulfilled ${(drop.fulfilled || []).length}</div>
      <div><span class="label">snapshot</span> ${drop.snapshot_cid ? escapeHtml(drop.snapshot_cid) : '<span class="muted">unpinned</span>'}</div>
      <div><span class="label">signing as</span> <code>${escapeHtml(shorten(bytesToHex(wallet.pub || new Uint8Array()), 14))}</code> <span class="muted">(active wallet)</span></div>
    `;
  }
  $('#drop-fulfil-claims').value = '';
  $('#drop-fulfil-err').textContent = '';
  $('#drop-fulfil-preview').style.display = 'none';
  $('#drop-fulfil-result').style.display = 'none';
  $('#btn-drop-fulfil-broadcast').disabled = true;
  // Scroll into view so the user can see what they just opened.
  sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function _closeDropFulfil() {
  _dropFulfilCurrent = null;
  _dropFulfilStaged = null;
  const sec = $('#drop-fulfil-section');
  if (sec) sec.style.display = 'none';
}

// ---- Cross-check: verify each fulfilled[] entry against on-chain state ----
// For each entry, fetch the txid; confirm the parent envelope is a CXFER (or
// T_AXFER) of the same asset_id; confirm an output's P2WPKH script pays
// hash160(tacit_pubkey). Tx-not-found, wrong opcode, asset mismatch, or
// missing recipient output are all flagged. Cannot reconstruct missing
// entries — for that, restore from a backup JSON.
async function _crossCheckOneEntry(drop, entry) {
  // Pending entries (broadcast in flight or crashed mid-broadcast) have no
  // txid yet. Surface as a distinct status so the user knows local state is
  // inconsistent and needs manual reconciliation. Closes HIGH#1's diagnostic
  // gap.
  if (entry.pending === true || entry.txid == null) {
    const errSuffix = entry.pending_error ? ` (broadcast error: "${String(entry.pending_error).slice(0, 120)}")` : '';
    return { ok: false, pending: true, reason: `broadcast crashed or did not complete; no on-chain txid recorded${errSuffix}. Check mempool.space for any matching CXFER from your wallet, then either update the entry with the txid or manually delete it from the drop record before retrying.` };
  }
  if (!/^[0-9a-f]{64}$/.test(entry.txid)) return { ok: false, reason: 'malformed txid in local record' };
  let tx;
  try { tx = await getTx(entry.txid); }
  catch (e) { return { ok: false, reason: `tx not found on chain (${e.message?.slice(0, 80) || 'fetch failed'})` }; }
  if (!tx || !Array.isArray(tx.vin) || !tx.vin[0]?.witness) {
    return { ok: false, reason: 'tx has no envelope-bearing input' };
  }
  const wit = tx.vin[0].witness;
  if (!Array.isArray(wit) || wit.length < 2) return { ok: false, reason: 'vin[0] witness too short' };
  let env;
  try { env = decodeEnvelopeScript(hexToBytes(wit[1])); } catch { env = null; }
  if (!env) return { ok: false, reason: 'envelope decode failed' };
  let dec, label;
  if (env.opcode === T_CXFER)      { dec = decodeCXferPayload(env.payload); label = 'CXFER'; }
  else if (env.opcode === T_AXFER) { dec = decodeAxferPayload(env.payload); label = 'T_AXFER'; }
  else return { ok: false, reason: `parent envelope is opcode 0x${env.opcode.toString(16)}, not CXFER or T_AXFER` };
  if (!dec) return { ok: false, reason: `${label} payload decode failed` };
  if (bytesToHex(dec.assetId) !== drop.asset_id_hex) {
    return { ok: false, reason: `${label} asset_id ${shorten(bytesToHex(dec.assetId), 8)} ≠ drop's ${shorten(drop.asset_id_hex, 8)}` };
  }
  // Find an output whose P2WPKH pays hash160(tacit_pubkey).
  const expectedHash160 = bytesToHex(hash160(hexToBytes(entry.tacit_pubkey)));
  let foundVout = -1;
  for (let i = 0; i < (tx.vout?.length || 0); i++) {
    const out = tx.vout[i];
    if (!out?.scriptpubkey) continue;
    const spk = hexToBytes(out.scriptpubkey);
    if (spk.length === 22 && spk[0] === 0x00 && spk[1] === 0x14 && bytesToHex(spk.slice(2, 22)) === expectedHash160) {
      foundVout = i;
      break;
    }
  }
  if (foundVout < 0) return { ok: false, reason: `tx has no output paying hash160(tacit_pubkey ${shorten(entry.tacit_pubkey, 8)})` };

  // Commitment-equality check (closes MED#7). Re-derive the recipient's
  // blinding via ECDH (we're the sender — deterministic from anchor + recipient
  // pubkey), commit to the local-record amount, compare against the on-chain
  // commitment at the matched vout. Catches hand-edited amount fields.
  if (foundVout >= dec.outputs.length) {
    return { ok: false, reason: `output ${foundVout} is outside the envelope's tacit-output range (${dec.outputs.length})` };
  }
  try {
    const firstAssetIn = tx.vin[1];
    if (firstAssetIn?.txid != null && Number.isInteger(firstAssetIn.vout)) {
      const anchorBytes = concatBytes(
        reverseBytes(hexToBytes(firstAssetIn.txid)),
        (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, firstAssetIn.vout >>> 0, true); return b; })(),
      );
      const blinding = deriveBlinding(wallet.priv, hexToBytes(entry.tacit_pubkey), anchorBytes, foundVout);
      const expectedCommit = pedersenCommit(BigInt(entry.amount), blinding);
      const onChainCommit = bytesToPoint(dec.outputs[foundVout].commitment);
      if (!expectedCommit.equals(onChainCommit)) {
        return { ok: false, reason: `commitment at vout ${foundVout} does not open to recorded amount ${entry.amount} — record may be hand-edited or the wrong vout was matched` };
      }
    }
  } catch (e) {
    return { ok: false, reason: `commitment check error: ${e.message}` };
  }

  return { ok: true, label, foundVout };
}

function _openDropCrossCheck(drop) {
  _dropCrossCheckCurrent = drop;
  const sec = $('#drop-crosscheck-section');
  if (sec) sec.style.display = '';
  const meta = $('#drop-crosscheck-meta');
  if (meta) {
    meta.innerHTML = `
      <div><span class="label">drop</span> <strong>${escapeHtml(drop.asset_ticker)}</strong> · root <code style="font-size:11px;">${escapeHtml(shorten(drop.merkle_root_hex, 12))}</code></div>
      <div><span class="label">fulfilled</span> ${(drop.fulfilled || []).length} / ${drop.count}</div>
      <div class="muted" style="font-size:11px;margin-top:4px;">Click "Run cross-check" to walk each fulfilled entry against chain. Each entry takes one tx-fetch round-trip; large drops may take a moment.</div>
    `;
  }
  $('#drop-crosscheck-progress').textContent = '';
  $('#drop-crosscheck-results').innerHTML = '';
  sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function _closeDropCrossCheck() {
  _dropCrossCheckCurrent = null;
  const sec = $('#drop-crosscheck-section');
  if (sec) sec.style.display = 'none';
}

async function _runDropCrossCheck() {
  const drop = _dropCrossCheckCurrent;
  if (!drop) return;
  const fulfilled = drop.fulfilled || [];
  const progress = $('#drop-crosscheck-progress');
  const out = $('#drop-crosscheck-results');
  out.innerHTML = '';
  if (fulfilled.length === 0) {
    out.innerHTML = `<div class="muted">No fulfilled[] entries to check.</div>`;
    return;
  }
  if (progress) progress.textContent = `Checking ${fulfilled.length} entries…`;
  const results = [];
  for (let i = 0; i < fulfilled.length; i++) {
    const entry = fulfilled[i];
    if (progress) progress.textContent = `Checking ${i + 1} / ${fulfilled.length}…`;
    const r = await _crossCheckOneEntry(drop, entry);
    results.push({ entry, ...r });
  }
  if (progress) progress.textContent = '';
  const okCount = results.filter(r => r.ok).length;
  const pendingCount = results.filter(r => r.pending).length;
  const failCount = results.length - okCount - pendingCount;
  const summary = (failCount === 0 && pendingCount === 0)
    ? `<div class="warn" style="border-left-color:var(--green);background:var(--bg-warm);"><strong>✓ All ${okCount} fulfilled entries match chain</strong></div>`
    : pendingCount > 0
      ? `<div class="warn" style="border-left-color:var(--orange);"><strong>${okCount} ✓ &nbsp; ${pendingCount} ⏳ pending &nbsp; ${failCount} ✗</strong> · ${pendingCount} entr${pendingCount === 1 ? 'y' : 'ies'} have no on-chain txid (broadcast may have crashed); ${failCount} mismatch${failCount === 1 ? '' : 'es'}.</div>`
      : `<div class="warn"><strong>${okCount} ✓ &nbsp; ${failCount} ✗</strong> · ${failCount} entr${failCount === 1 ? 'y' : 'ies'} failed cross-check (details below)</div>`;
  const rows = results.map(r => {
    const e = r.entry;
    const status = r.ok
      ? `<span style="color:var(--green);">✓ ${escapeHtml(r.label)}</span>`
      : r.pending
        ? `<span style="color:var(--orange);">⏳ ${escapeHtml(r.reason)}</span>`
        : `<span style="color:var(--red);">✗ ${escapeHtml(r.reason)}</span>`;
    return `
      <div class="row" style="font-family:var(--mono);font-size:11px;border-top:1px solid var(--border);padding-top:6px;margin-top:6px;">
        <span class="idx">[leaf ${e.leaf_index}]</span> ${escapeHtml(e.eth_address || '?')} → ${escapeHtml(shorten(e.tacit_pubkey || '?', 10))}
        <div style="margin-top:2px;">${status} · txid <code>${escapeHtml(shorten(e.txid || '?', 10))}</code></div>
      </div>
    `;
  }).join('');
  out.innerHTML = summary + rows;
}

function _parseClaimTuples(text) {
  // One tuple per line. Two formats accepted:
  //   leaf_index,tacit_pubkey_hex                              (unsigned — issuer trusts the source)
  //   leaf_index,tacit_pubkey_hex,eth_signature_hex            (signed via Claim portal — strict mode verifies)
  const out = [];
  const lines = (text || '').split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) continue;
    const cells = raw.split(/[,\t\s]+/).map(s => s.trim()).filter(Boolean);
    if (cells.length < 2) throw new Error(`line ${lineNo + 1}: expected "leaf_index,tacit_pubkey_hex[,eth_sig_hex]"`);
    const idx = parseInt(cells[0], 10);
    if (!Number.isInteger(idx) || idx < 0) throw new Error(`line ${lineNo + 1}: invalid leaf_index`);
    const pub = cells[1].toLowerCase();
    if (!/^0[23][0-9a-f]{64}$/.test(pub)) throw new Error(`line ${lineNo + 1}: tacit_pubkey must be 33-byte compressed hex`);
    let ethSigHex = null;
    if (cells.length >= 3) {
      const sig = cells[2].toLowerCase().replace(/^0x/, '');
      if (!/^[0-9a-f]{130}$/.test(sig)) throw new Error(`line ${lineNo + 1}: eth_sig must be 65-byte hex (130 chars)`);
      ethSigHex = '0x' + sig;
    }
    out.push({ leafIndex: idx, tacitPubHex: pub, ethSigHex });
  }
  if (!out.length) throw new Error('no claim tuples parsed');
  if (out.length > 7) throw new Error(`max 7 claims per batch (got ${out.length}). Submit additional batches separately.`);
  // Only reject duplicate leaf_index — that's the actual double-pay defense
  // (the same leaf can't be claimed twice in one batch). Duplicate recipient
  // tacit_pubkey is LEGITIMATE: a user with two eligible ETH addresses can
  // consolidate both leaves to one tacit wallet, with distinct ETH sigs per
  // leaf. The CXFER blinding derivation uses vout index, so two outputs to
  // the same recipient pubkey produce different commitments and don't clash.
  const seenIdx = new Set();
  for (const c of out) {
    if (seenIdx.has(c.leafIndex)) throw new Error(`duplicate leaf_index in batch: ${c.leafIndex}`);
    seenIdx.add(c.leafIndex);
  }
  return out;
}

async function _verifyDropFulfilBatch() {
  const drop = _dropFulfilCurrent;
  if (!drop) throw new Error('no drop selected');
  const claims = _parseClaimTuples($('#drop-fulfil-claims').value);
  const requireSigs = !!$('#drop-fulfil-require-sig')?.checked;
  // Smart-wallet (ERC-1271) fallback for sigs that don't ECDSA-recover. Only
  // available if an Ethereum provider is connected on this dapp instance — no
  // provider means EOA-only verification, surfaced in the error message below.
  const ethProvider = (typeof _ethProvider === 'function') ? _ethProvider() : null;

  // Reject claims for already-fulfilled leaves (defense against double-pay).
  const fulfilledSet = new Set((drop.fulfilled || []).map(f => f.leaf_index));
  for (const c of claims) {
    if (fulfilledSet.has(c.leafIndex)) {
      throw new Error(`leaf ${c.leafIndex} already fulfilled (txid ${shorten((drop.fulfilled.find(f => f.leaf_index === c.leafIndex) || {}).txid || '?', 8)})`);
    }
  }

  // Rebuild leaves + tree from drop.rows so we can compute proofs locally.
  const rows = drop.rows.map(r => ({
    index: r.index,
    ethAddrHex: r.eth_address.replace(/^0x/i, '').toLowerCase(),
    ethAddrBytes: hexToBytes(r.eth_address.replace(/^0x/i, '').toLowerCase()),
    amount: BigInt(r.amount),
  }));
  const commit = computeAirdropCommitment(rows);
  if (bytesToHex(commit.root) !== drop.merkle_root_hex) {
    throw new Error('stored merkle root does not match recomputed root — drop record corrupt');
  }
  const items = [];
  for (const c of claims) {
    if (c.leafIndex >= rows.length) throw new Error(`leaf_index ${c.leafIndex} ≥ row count ${rows.length}`);
    const row = rows[c.leafIndex];
    const leaf = commit.rows[c.leafIndex].leaf;
    const proof = airdropMerkleProof(commit.layers, c.leafIndex);
    if (!verifyAirdropMerkleProof(leaf, proof, commit.root)) {
      throw new Error(`merkle proof for leaf ${c.leafIndex} failed`);
    }
    // Signature verification (strict by default; checkbox lets issuer skip)
    let sigVerified = false;
    if (c.ethSigHex) {
      const claimMsg = buildAirdropClaimMsg({
        rootHex: drop.merkle_root_hex,
        network: drop.network || NET.name,
        assetIdHex: drop.asset_id_hex,
        ethAddrHex: row.ethAddrHex,
        leafIndex: row.index,
        amount: row.amount,
        ticker: drop.asset_ticker || '?',
        decimals: drop.asset_decimals,
        tacitPubHex: c.tacitPubHex,
      });
      // ECDSA recovery first (covers EOA wallets — MetaMask, Rainbow, Rabby,
      // Coinbase, Trust). Falls back to ERC-1271 eth_call for smart-contract
      // wallets (Safe, Argent, Ambire) when an Ethereum provider is reachable.
      sigVerified = verifyAirdropClaimSig(claimMsg, c.ethSigHex, row.ethAddrHex);
      if (!sigVerified && ethProvider) {
        try { sigVerified = await verifyEthSigViaErc1271(claimMsg, c.ethSigHex, row.ethAddrHex, ethProvider); }
        catch { sigVerified = false; }
      }
      if (!sigVerified) {
        const tail = ethProvider
          ? ' Tried ERC-1271 eth_call too; both failed.'
          : ' If this claimant uses a smart-contract wallet (Safe / Argent / Ambire), connect an Ethereum wallet on the Claim tab so the dapp can run an ERC-1271 eth_call, then re-verify.';
        throw new Error(`leaf ${c.leafIndex}: eth signature does NOT recover to row's eth_address (0x${row.ethAddrHex}). Reject — claim may be forged or the canonical message differs (check ticker/decimals/network).${tail}`);
      }
    } else if (requireSigs) {
      throw new Error(`leaf ${c.leafIndex}: missing eth signature (strict mode). Either ask the claimant to re-submit via the Claim portal, or uncheck "Require eth signatures" to fulfil unverified.`);
    }
    items.push({
      leafIndex: c.leafIndex,
      tacitPubHex: c.tacitPubHex,
      ethAddrHex: row.ethAddrHex,
      amount: row.amount,
      sigVerified,
    });
  }
  return items;
}

// Validate + restore a previously-exported drop record. Returns the merged
// record on success; throws on schema or value errors. Existing drops with
// the same drop_id are merged: locally-fulfilled entries are union'd with
// the imported ones (deduped by leaf_index, keeping the imported entry as
// authoritative if both have the same leaf).
function _importDropJSON(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('not valid JSON: ' + e.message); }
  if (!obj || typeof obj !== 'object') throw new Error('JSON root must be an object');

  const dropId = String(obj.drop_id || '');
  if (!/^[0-9a-f]{32}$/.test(dropId)) throw new Error('drop_id must be 32-char hex');
  const network = String(obj.network || '');
  if (network !== 'signet' && network !== 'mainnet') throw new Error('network must be "signet" or "mainnet"');
  if (network !== NET.name) {
    throw new Error(`drop is for "${network}" but you're on "${NET.name}". Switch networks (top-right) and re-import.`);
  }
  const assetIdHex = String(obj.asset_id_hex || '');
  if (!/^[0-9a-f]{64}$/.test(assetIdHex)) throw new Error('asset_id_hex must be 64-char hex');
  const rootHex = String(obj.merkle_root_hex || '');
  if (!/^[0-9a-f]{64}$/.test(rootHex)) throw new Error('merkle_root_hex must be 64-char hex');
  const count = Number(obj.count);
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  if (!Array.isArray(obj.rows) || obj.rows.length !== count) throw new Error(`rows.length (${obj.rows?.length}) must equal count (${count})`);

  // drop_id must equal _dropIdFor(rootHex, assetIdHex). An attacker-edited
  // JSON could otherwise reuse a legitimate drop_id with mismatched root/asset
  // to overwrite the local record (closes MED#8).
  const expectedDropId = _dropIdFor(rootHex, assetIdHex);
  if (dropId !== expectedDropId) {
    throw new Error(`drop_id ${shorten(dropId, 8)} does not match expected ${shorten(expectedDropId, 8)} for (root, asset_id) — record is hand-edited or mislabeled`);
  }

  // Cross-check ticker/decimals against on-chain CETCH metadata when the dapp
  // has scanned the asset (also closes MED#8). Mismatch breaks future
  // canonical-msg reconstruction during fulfilment, so reject loudly. If we
  // haven't scanned the asset yet, we soft-pass — first fulfilment attempt
  // will surface any mismatch via sig-verify failures.
  const onChainMeta = getAssetMeta(assetIdHex);
  if (onChainMeta) {
    const importTicker = String(obj.asset_ticker || '');
    const importDecimals = obj.asset_decimals;
    if (importTicker && importTicker !== onChainMeta.ticker) {
      throw new Error(`asset_ticker "${importTicker}" ≠ on-chain ticker "${onChainMeta.ticker}" for asset_id ${shorten(assetIdHex, 8)}`);
    }
    if (Number.isInteger(importDecimals) && importDecimals !== onChainMeta.decimals) {
      throw new Error(`asset_decimals ${importDecimals} ≠ on-chain decimals ${onChainMeta.decimals} for asset_id ${shorten(assetIdHex, 8)}`);
    }
  }

  // Recompute the merkle root from rows; refuse to import a record whose
  // declared root doesn't match the rows it claims to be from. Prevents an
  // attacker who edits an exported JSON to insert their own address from
  // succeeding.
  const reconstructedRows = obj.rows.map((r, i) => {
    const cleanAddr = String(r.eth_address || '').toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(cleanAddr)) throw new Error(`rows[${i}].eth_address malformed`);
    const amount = BigInt(r.amount);
    if (amount < 0n || amount >= (1n << 64n)) throw new Error(`rows[${i}].amount out of u64`);
    if (!Number.isInteger(r.index) || r.index !== i) throw new Error(`rows[${i}].index must be ${i}`);
    return { ethAddrHex: cleanAddr, ethAddrBytes: hexToBytes(cleanAddr), amount, index: i };
  });
  const leaves = reconstructedRows.map(r => airdropLeafHash(r.ethAddrBytes, r.amount, r.index));
  const { root } = buildAirdropMerkle(leaves);
  if (bytesToHex(root) !== rootHex) {
    throw new Error('rows do not hash to declared merkle_root_hex — record is tampered or corrupt');
  }

  // Fulfilled list: validate each entry shape but don't trust against chain
  // here (Cross-check is the separate validation pass).
  //
  // Two valid shapes:
  //   confirmed: { leaf_index, tacit_pubkey, txid: 64-hex string, ... }
  //   pending:   { leaf_index, tacit_pubkey, txid: null, pending: true, ... }
  //
  // Pending entries MUST survive a round-trip through export→import, otherwise
  // a backup taken between phase-1 and phase-2 of a fulfilment broadcast would
  // lose the in-flight lock and re-open the double-pay window. Preserve the
  // pending sentinels and their error annotations explicitly.
  const fulfilled = Array.isArray(obj.fulfilled) ? obj.fulfilled.filter(f => {
    if (!f || !Number.isInteger(f.leaf_index)) return false;
    if (f.leaf_index < 0 || f.leaf_index >= count) return false;
    if (typeof f.tacit_pubkey !== 'string' || !/^0[23][0-9a-f]{64}$/.test(f.tacit_pubkey)) return false;
    const isConfirmed = typeof f.txid === 'string' && /^[0-9a-f]{64}$/.test(f.txid);
    const isPending = (f.txid === null || f.txid === undefined) && f.pending === true;
    return isConfirmed || isPending;
  }).map(f => {
    // Preserve all fields the writer side cares about. Strip unknown ones to
    // bound malicious-payload bloat but keep pending sentinel + error.
    const out = {
      leaf_index: f.leaf_index,
      tacit_pubkey: f.tacit_pubkey,
      eth_address: typeof f.eth_address === 'string' ? f.eth_address : '',
      amount: String(f.amount ?? '0'),
      txid: typeof f.txid === 'string' ? f.txid : null,
      fulfilled_at: Number.isInteger(f.fulfilled_at) ? f.fulfilled_at : null,
      sig_verified: !!f.sig_verified,
    };
    if (f.pending === true) {
      out.pending = true;
      if (typeof f.pending_error === 'string') out.pending_error = f.pending_error.slice(0, 200);
      if (Number.isInteger(f.pending_error_at)) out.pending_error_at = f.pending_error_at;
    }
    return out;
  }) : [];

  const drops = loadSavedDrops();
  const existingIdx = drops.findIndex(d => d.drop_id === dropId);
  // If a record exists locally, union its fulfilled[] with the imported one.
  // Imported entry takes precedence if both list the same leaf_index.
  let mergedFulfilled = fulfilled;
  if (existingIdx >= 0) {
    const localFulfilled = drops[existingIdx].fulfilled || [];
    const importedLeaves = new Set(fulfilled.map(f => f.leaf_index));
    mergedFulfilled = [
      ...fulfilled,
      ...localFulfilled.filter(f => !importedLeaves.has(f.leaf_index)),
    ];
  }

  const record = {
    drop_id: dropId,
    network,
    asset_id_hex: assetIdHex,
    asset_ticker: String(obj.asset_ticker || '?'),
    asset_decimals: Number.isInteger(obj.asset_decimals) ? obj.asset_decimals : 0,
    merkle_root_hex: rootHex,
    total_amount: String(obj.total_amount || '0'),
    count,
    snapshot_cid: obj.snapshot_cid || null,
    snapshot_pinned_at: obj.snapshot_pinned_at || null,
    rows: obj.rows.map(r => ({
      index: r.index, eth_address: r.eth_address, amount: String(r.amount),
    })),
    sources: Array.isArray(obj.sources) ? obj.sources : [],
    blacklist_size: Number.isInteger(obj.blacklist_size) ? obj.blacklist_size : 0,
    fulfilled: mergedFulfilled,
    created_at: Number.isInteger(obj.created_at) ? obj.created_at : Math.floor(Date.now() / 1000),
  };

  if (existingIdx >= 0) drops[existingIdx] = record;
  else drops.push(record);
  saveDrops(drops);
  return { record, isNew: existingIdx < 0, mergedFulfilledCount: mergedFulfilled.length };
}

// Trigger a download of the current drop record as JSON. Convenience for
// post-broadcast backup nudge so the issuer always has a fresh local copy.
function _downloadDropBackup(drop) {
  const blob = new Blob([JSON.stringify(drop, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date(drop.fulfilled?.[drop.fulfilled.length - 1]?.fulfilled_at * 1000 || Date.now()).toISOString().slice(0, 10);
  a.href = url;
  a.download = `drop-${shorten(drop.merkle_root_hex, 8)}-${stamp}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function setupDropsForm() {
  // Source list management
  $('#btn-drop-add-source')?.addEventListener('click', () => _addDropSource());
  $('#btn-drop-clear-sources')?.addEventListener('click', () => {
    if (_dropSources.size === 0) return;
    if (!confirm(`Remove all ${_dropSources.size} loaded source${_dropSources.size === 1 ? '' : 's'}?`)) return;
    _dropSources.clear();
    _invalidateBuilt();
    _renderDropSources();
  });

  // Import drop record (restore from a previously-exported JSON)
  $('#btn-drop-import')?.addEventListener('click', () => $('#drop-import-file').click());
  $('#drop-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = $('#drop-import-status');
    if (status) status.textContent = '';
    try {
      const text = await file.text();
      const { record, isNew, mergedFulfilledCount } = _importDropJSON(text);
      renderSavedDropsList();
      const verb = isNew ? 'imported' : 'merged';
      if (status) status.innerHTML = `<span style="color:var(--green);">✓ ${verb} ${escapeHtml(record.asset_ticker)} drop · ${record.count} leaves · ${mergedFulfilledCount} fulfilled</span>`;
      toast(`Drop ${verb} · root ${shorten(record.merkle_root_hex, 10)}`, 'success');
    } catch (err) {
      if (status) status.innerHTML = `<span style="color:var(--red);">✗ ${escapeHtml(err.message)}</span>`;
      console.error(err);
    } finally {
      // Reset so the same file can be re-selected later.
      e.target.value = '';
    }
  });

  // Asset selector — re-render meta + invalidate build
  $('#drop-asset')?.addEventListener('change', () => {
    _renderDropAssetMeta();
    _invalidateBuilt();
  });

  // Blacklist textarea — invalidate build on edit (forces user to re-build)
  $('#drop-blacklist')?.addEventListener('input', () => _invalidateBuilt());

  // Build snapshot
  $('#btn-drop-build')?.addEventListener('click', () => {
    const errEl = $('#drop-build-err');
    if (errEl) errEl.textContent = '';
    try {
      _buildDropSnapshot();
      _renderBuildPreview();
      _refreshDropSaveButtonState();
      toast(`Snapshot built · ${_dropBuilt.commit.count} unique recipients · root ${shorten(bytesToHex(_dropBuilt.commit.root), 10)}`, 'success');
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
      _dropBuilt = null;
      _refreshDropSaveButtonState();
    }
  });

  // Generate treasury (one-shot reveal of fresh privkey hex)
  $('#btn-drop-gen-treasury')?.addEventListener('click', () => {
    const priv = secp.utils.randomPrivateKey();
    const pub = secp.getPublicKey(priv, true);
    const addr = bech32.encode(NET.hrp, [0, ...bech32.toWords(hash160(pub))]);
    const out = $('#drop-treasury-out');
    if (!out) return;
    out.style.display = '';
    out.innerHTML = `
      <div class="warn" style="border-left-color:var(--orange);background:var(--bg-warm);">
        <strong>⚠ Treasury privkey — shown ONCE</strong>
        <div class="muted" style="font-size:11px;margin-top:4px;">Copy this now. The dapp does NOT persist it. To use this treasury, switch wallets via <em>Wallet → Import key</em> in a separate browser profile, then fund it from your main wallet via Send.</div>
        <div style="margin-top:10px;font-family:var(--mono);font-size:11px;word-break:break-all;background:var(--bg-warm);padding:8px;border-radius:4px;">
          <div><span class="label">privkey</span> <code id="drop-treasury-priv">${escapeHtml(bytesToHex(priv))}</code></div>
          <div style="margin-top:4px;"><span class="label">pubkey</span> <code>${escapeHtml(bytesToHex(pub))}</code></div>
          <div style="margin-top:4px;"><span class="label">address</span> <code>${escapeHtml(addr)}</code></div>
        </div>
        <div class="flex" style="gap:6px;margin-top:8px;">
          <button id="btn-drop-treasury-copy" type="button">Copy privkey</button>
          <button id="btn-drop-treasury-hide" type="button">Hide</button>
        </div>
      </div>
    `;
    $('#btn-drop-treasury-copy').onclick = () => {
      navigator.clipboard?.writeText(bytesToHex(priv))
        .then(() => toast('Treasury privkey copied — store it safely', 'success'))
        .catch(() => prompt('Copy treasury privkey:', bytesToHex(priv)));
    };
    $('#btn-drop-treasury-hide').onclick = () => { out.style.display = 'none'; out.innerHTML = ''; };
  });

  // Pin snapshot
  $('#btn-drop-pin-snapshot')?.addEventListener('click', async () => {
    const btn = $('#btn-drop-pin-snapshot');
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'pinning…';
    try {
      const cid = await _pinDropSnapshot();
      const out = $('#drop-save-out');
      if (out) out.innerHTML = `Snapshot pinned: <a href="https://gateway.pinata.cloud/ipfs/${escapeHtml(cid.replace(/^ipfs:\/\//, ''))}" target="_blank" rel="noopener">${escapeHtml(cid)}</a>`;
      toast('Snapshot pinned to IPFS', 'success');
    } catch (e) {
      toast('Pin failed: ' + e.message, 'error');
      console.error(e);
    } finally {
      btn.disabled = false; btn.textContent = orig;
      _refreshDropSaveButtonState();
    }
  });

  // Save drop record
  $('#btn-drop-save')?.addEventListener('click', () => {
    try {
      const rec = _saveDropRecord();
      toast(`Drop saved · ${rec.count} recipients · ${shorten(rec.merkle_root_hex, 10)}`, 'success');
      $('#drop-save-out').innerHTML += `<div style="margin-top:6px;">Drop record saved locally · drop_id <code>${escapeHtml(shorten(rec.drop_id, 10))}</code></div>`;
      renderSavedDropsList();
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
      console.error(e);
    }
  });

  // Fulfil verify
  $('#btn-drop-fulfil-verify')?.addEventListener('click', async () => {
    const errEl = $('#drop-fulfil-err');
    errEl.textContent = '';
    $('#drop-fulfil-preview').style.display = 'none';
    $('#btn-drop-fulfil-broadcast').disabled = true;
    _dropFulfilStaged = null;
    try {
      const items = await _verifyDropFulfilBatch();
      const drop = _dropFulfilCurrent;
      const decimals = drop.asset_decimals;
      const ticker = drop.asset_ticker;
      const totalBatch = items.reduce((s, x) => s + x.amount, 0n);
      const m = items.length + 1 <= 2 ? 2 : items.length + 1 <= 4 ? 4 : 8;
      const sigCount = items.filter(x => x.sigVerified).length;
      const sigSummary = sigCount === items.length
        ? `<span style="color:var(--green);">✓ all ${items.length} signed + verified</span>`
        : sigCount === 0
          ? `<span style="color:var(--orange);">⚠ no signatures provided — strict mode off</span>`
          : `<span style="color:var(--orange);">⚠ partial: ${sigCount}/${items.length} signed</span>`;
      $('#drop-fulfil-preview').style.display = 'block';
      $('#drop-fulfil-preview').innerHTML = `
        <div class="tx-preview">
          <h4>Batch staged · ${items.length} recipient${items.length === 1 ? '' : 's'} (m=${m} CXFER)</h4>
          ${items.map(x => `<div class="row" style="font-family:var(--mono);font-size:11px;"><span class="idx">[leaf ${x.leafIndex}]</span> ${x.sigVerified ? '<span style="color:var(--green);">✓</span> ' : '<span style="color:var(--orange);">○</span> '}0x${escapeHtml(x.ethAddrHex)} → ${escapeHtml(shorten(x.tacitPubHex, 10))} · ${fmtAssetAmountPlain(x.amount, decimals)} ${escapeHtml(ticker)}</div>`).join('')}
          <div class="row" style="margin-top:8px;"><span class="label">batch total</span><strong>${fmtAssetAmountPlain(totalBatch, decimals)} ${escapeHtml(ticker)}</strong></div>
          <div class="row"><span class="label">signatures</span>${sigSummary}</div>
          <div class="muted" style="font-size:11px;margin-top:8px;">Each merkle proof verified against root <code>${escapeHtml(shorten(drop.merkle_root_hex, 10))}</code>. Click broadcast to send a single ${m}-output CXFER from your active wallet.</div>
        </div>
      `;
      _dropFulfilStaged = { drop: _dropFulfilCurrent, items };
      $('#btn-drop-fulfil-broadcast').disabled = false;
    } catch (e) {
      errEl.textContent = e.message;
    }
  });

  // Fulfil broadcast
  $('#btn-drop-fulfil-broadcast')?.addEventListener('click', async () => {
    if (!_dropFulfilStaged) return;
    const { drop, items } = _dropFulfilStaged;
    const btn = $('#btn-drop-fulfil-broadcast');
    if (!confirm(`Broadcast ${items.length}-recipient CXFER for ${drop.asset_ticker}?\n\nThis signs with your active wallet (${shorten(bytesToHex(wallet.pub || new Uint8Array()), 12)}). Total: ${fmtAssetAmountPlain(items.reduce((s, x) => s + x.amount, 0n), drop.asset_decimals)} ${drop.asset_ticker}.\n\nFulfilled leaves are recorded locally to prevent double-pay; this does NOT block someone else's wallet from CXFERing the same asset to a leaf if they hold the same key.`)) return;
    if (!ensureBurnerBackedUp('Fulfil airdrop batch (signs with active wallet)')) return;
    const need = await estimateSatsForOp('cxfer');
    if (!(await ensureSatsFunded(need, 'Fulfilling airdrop batch'))) return;

    btn.disabled = true; btn.textContent = 'broadcasting…';
    $('#drop-fulfil-err').textContent = '';
    const dropStrip = $('#drop-fulfil-progress');
    if (dropStrip) dropStrip.style.display = 'flex';
    setProgressStrip('drop-fulfil-progress', 0);

    // Multi-tab lease lock. Acquire BEFORE phase-1 write to prevent two
    // tabs from racing past the loadSavedDrops/saveDrops sequence with
    // overlapping leaf sets. Released in the finally block regardless of
    // outcome. Stale leases (e.g. tab crashed) auto-expire after TTL so
    // another tab can take over.
    const lease = acquireDropLease(drop.drop_id);
    if (!lease.ok) {
      const remainSec = Math.max(0, Math.ceil((lease.expiresAt - Date.now()) / 1000));
      $('#drop-fulfil-err').innerHTML =
        `<strong>Another browser tab is fulfilling this drop right now.</strong> ` +
        `Wait ~${remainSec}s for the lease to expire (or close that tab) and try again. ` +
        `If you're sure no other tab is active and the lease is stale, wait the full ${Math.ceil(remainSec / 60)} minutes for auto-expiry.`;
      btn.disabled = false; btn.textContent = 'Broadcast batch CXFER';
      return;
    }

    // Two-phase persistence (closes HIGH #1 — state-loss double-pay window).
    // Phase 1: write the fulfilment entries with `pending: true` BEFORE
    // broadcast. Phase 2: after broadcast confirms, flip pending→false and
    // attach the real txid. If the broadcast fails, remove the pending
    // entries we just added. If the dapp crashes between broadcast and
    // post-flip, the entries remain pending with txid=null; Cross-check
    // surfaces them so the user can reconcile manually.
    //
    // The pending entries also act as an in-flight lock: a subsequent Verify
    // for the same leaves sees them in fulfilledSet and refuses to re-stage.
    const itemLeaves = new Set(items.map(it => it.leafIndex));
    const phaseOneNow = Math.floor(Date.now() / 1000);
    {
      const drops = loadSavedDrops();
      const idx = drops.findIndex(d => d.drop_id === drop.drop_id);
      if (idx < 0) {
        $('#drop-fulfil-err').textContent = 'Drop record vanished — refusing to broadcast against a record that no longer exists locally.';
        btn.disabled = false; btn.textContent = 'Broadcast batch CXFER';
        return;
      }
      drops[idx].fulfilled = drops[idx].fulfilled || [];
      for (const it of items) {
        drops[idx].fulfilled.push({
          leaf_index: it.leafIndex,
          tacit_pubkey: it.tacitPubHex,
          eth_address: '0x' + it.ethAddrHex,
          amount: it.amount.toString(),
          txid: null,                   // unknown until broadcast returns
          fulfilled_at: phaseOneNow,
          sig_verified: !!it.sigVerified,
          pending: true,
        });
      }
      saveDrops(drops);
      _dropFulfilCurrent = drops[idx];
    }

    try {
      const recipients = items.map(x => ({ pubHex: x.tacitPubHex, amount: x.amount }));
      // Airdrop batches can legitimately have multiple leaves consolidating
      // to the same recipient pubkey (a user with two eligible ETH
      // addresses claiming both to one tacit wallet). The cross-tx
      // duplicate-recipient guard in buildAndBroadcastCXferMulti is meant
      // for the typo-prevention case in the Send tab, not here.
      const result = await buildAndBroadcastCXferMulti({
        assetIdHex: drop.asset_id_hex,
        recipients,
        allowDuplicateRecipients: true,
        onProgress: (stage) => {
          if (stage === 'commit-start') setProgressStrip('drop-fulfil-progress', 1);
          else if (stage === 'reveal-start') setProgressStrip('drop-fulfil-progress', 2);
        },
      });
      setProgressStrip('drop-fulfil-progress', 4);
      setTimeout(() => { if (dropStrip) dropStrip.style.display = 'none'; setProgressStrip('drop-fulfil-progress', -1); }, 1200);
      // Phase 2: flip pending → fulfilled with the confirmed txid. Reload
      // fresh because cross-check or other tabs may have touched the record.
      const drops = loadSavedDrops();
      const idx = drops.findIndex(d => d.drop_id === drop.drop_id);
      if (idx >= 0) {
        const now = Math.floor(Date.now() / 1000);
        for (const f of (drops[idx].fulfilled || [])) {
          if (f.pending === true && f.txid == null && itemLeaves.has(f.leaf_index)) {
            f.txid = result.revealTxid;
            f.fulfilled_at = now;
            delete f.pending;
          }
        }
        saveDrops(drops);
        _dropFulfilCurrent = drops[idx];
      }
      $('#drop-fulfil-result').style.display = 'block';
      $('#drop-fulfil-result').innerHTML = `
        <div class="warn" style="border-left-color:var(--green);background:var(--bg-warm);">
          <strong>✓ Batch broadcast</strong>
          <div style="margin-top:4px;font-size:11px;">commit <code>${escapeHtml(shorten(result.commitTxid, 10))}</code> · reveal <code>${escapeHtml(shorten(result.revealTxid, 10))}</code></div>
          <div class="muted" style="font-size:11px;margin-top:4px;">${items.length} leaves marked fulfilled in the local drop record. Recipients' wallets auto-recover their amounts via ECDH on next scan.</div>
          <div class="flex" style="gap:6px;margin-top:8px;">
            <button id="btn-drop-fulfil-backup" type="button" title="Save the updated drop record (with this batch's fulfilment entries) so you can restore on localStorage loss">↓ Download backup JSON</button>
          </div>
          <div class="muted" style="font-size:10px;margin-top:4px;">Saving is recommended after every batch — clearing browser data without a backup loses the local fulfilled-leaf ledger (chain unaffected).</div>
        </div>
      `;
      // Wire backup button to the post-merge drop record (loaded fresh inside
      // the closure so it includes the entries we just appended).
      const dropForBackup = drops[idx];
      $('#btn-drop-fulfil-backup').onclick = () => _downloadDropBackup(dropForBackup);
      $('#drop-fulfil-claims').value = '';
      $('#drop-fulfil-preview').style.display = 'none';
      _dropFulfilStaged = null;
      // Best-effort: remove the just-fulfilled claims from the worker queue so
      // the next "Pull queued" doesn't redeliver them. Failures here are
      // logged-and-swallowed — the local drop record is the source of truth
      // for double-pay prevention regardless of queue state.
      if (WORKER_BASE) {
        for (const it of items) {
          fetch(`${WORKER_BASE}/airdrops/${drop.merkle_root_hex}/claims/${it.leafIndex}?network=${encodeURIComponent(drop.network || NET.name)}`, { method: 'DELETE' })
            .catch(e => console.warn('queue delete failed for leaf', it.leafIndex, e));
        }
      }
      _openDropFulfil(_dropFulfilCurrent);  // re-render meta with updated fulfilled count
      renderSavedDropsList();
      toast(`Batch fulfilled · ${items.length} leaves`, 'success');
    } catch (e) {
      // Broadcast errored. Per the safety review, we DON'T roll back pending
      // entries automatically — the error could have come from anywhere in
      // the pipeline (commit broadcast, reveal broadcast, recordOpening,
      // recordActivity), and we cannot reliably distinguish "broadcast did
      // not happen" from "broadcast happened but post-step threw" inside the
      // catch. Auto-rollback in the latter case would unblock a retry that
      // double-pays. Conservative choice: leave entries marked `pending` and
      // tag the error so Cross-check / human review can reconcile.
      //
      // The downside: the user can't immediately retry the same leaves; they
      // must first run Cross-check, see whether the on-chain CXFER exists,
      // then either (a) keep the entries and update them with the txid, or
      // (b) manually delete the pending entries and retry.
      try {
        const dropsAfter = loadSavedDrops();
        const idxAfter = dropsAfter.findIndex(d => d.drop_id === drop.drop_id);
        if (idxAfter >= 0) {
          let touched = false;
          for (const f of (dropsAfter[idxAfter].fulfilled || [])) {
            if (f && f.pending === true && f.txid == null && itemLeaves.has(f.leaf_index)) {
              f.pending_error = String(e.message || e).slice(0, 200);
              f.pending_error_at = Math.floor(Date.now() / 1000);
              touched = true;
            }
          }
          if (touched) {
            saveDrops(dropsAfter);
            _dropFulfilCurrent = dropsAfter[idxAfter];
          }
        }
      } catch (annotateErr) {
        console.warn('pending entries annotation failed:', annotateErr);
      }
      $('#drop-fulfil-err').innerHTML =
        `Broadcast errored: ${escapeHtml(e.message)}. ` +
        `<strong>Pending entries are kept</strong> in the local record (NOT rolled back) to prevent accidental double-pay if the broadcast actually succeeded mid-error. ` +
        `Run Cross-check on this drop: if the on-chain CXFER appears, update the pending entries with the txid manually. ` +
        `If no matching CXFER exists, manually delete the pending entries before retrying.`;
      if (dropStrip && dropStrip.style.display !== 'none') {
        const a = dropStrip.querySelector('.progress-step.active');
        const errIdx = a ? Number(a.dataset.step) : -1;
        if (errIdx >= 0) setProgressStrip('drop-fulfil-progress', -1, { errorAt: errIdx });
      }
      console.error(e);
    } finally {
      // Release the multi-tab lease unconditionally on broadcast finish
      // (success OR failure). Pending entries persist independently — the
      // lease is just the in-flight serializer for the broadcast handler.
      releaseDropLease(drop.drop_id);
      btn.disabled = false; btn.textContent = 'Broadcast batch CXFER';
    }
  });
  $('#btn-drop-fulfil-cancel')?.addEventListener('click', _closeDropFulfil);

  // Cross-check buttons.
  $('#btn-drop-crosscheck-run')?.addEventListener('click', async () => {
    const btn = $('#btn-drop-crosscheck-run');
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'running…';
    try { await _runDropCrossCheck(); }
    catch (e) {
      $('#drop-crosscheck-results').innerHTML = `<div class="warn"><strong>Cross-check failed:</strong> ${escapeHtml(e.message)}</div>`;
      console.error(e);
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });
  $('#btn-drop-crosscheck-cancel')?.addEventListener('click', _closeDropCrossCheck);

  // Pull queued claims from the worker. De-dups against the drop's already-
  // fulfilled set so the textarea only contains genuinely-pending claims.
  // Append rather than replace if the textarea already has content.
  $('#btn-drop-fulfil-pull')?.addEventListener('click', async () => {
    const drop = _dropFulfilCurrent;
    if (!drop) return;
    const status = $('#drop-fulfil-pull-status');
    const btn = $('#btn-drop-fulfil-pull');
    if (status) status.textContent = '';
    if (!WORKER_BASE) {
      if (status) status.innerHTML = `<span style="color:var(--orange);">Worker disabled — paste claims manually.</span>`;
      return;
    }
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'pulling…';
    try {
      // Walk the worker's paginated queue (added in MED#9 fix). Stop early
      // once we have enough unfulfilled claims to fill a 7-recipient batch,
      // since paging beyond that point is wasted bandwidth.
      const baseUrl = `${WORKER_BASE}/airdrops/${drop.merkle_root_hex}/claims?network=${encodeURIComponent(drop.network || NET.name)}`;
      const fulfilledSet = new Set((drop.fulfilled || []).map(f => f.leaf_index));
      const allClaims = [];
      let nextCursor = null;
      let totalSeen = 0;
      let truncatedAtWorker = false;
      let pageGuard = 0;
      const PAGE_GUARD_CAP = 16;  // 16 pages × ≤1000 = 16K claims max per pull
      do {
        const url = nextCursor ? `${baseUrl}&cursor=${encodeURIComponent(nextCursor)}` : baseUrl;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`worker returned ${resp.status}`);
        const j = await resp.json();
        for (const c of (j.claims || [])) allClaims.push(c);
        totalSeen += (j.count || 0);
        nextCursor = j.next_cursor || null;
        truncatedAtWorker = !!j.truncated;
        // Stop early once we've collected enough unfulfilled claims for a batch.
        const unfulfilledSoFar = allClaims.filter(c => !fulfilledSet.has(c.leaf_index)).length;
        if (unfulfilledSoFar >= 7) break;
        pageGuard++;
        if (pageGuard > PAGE_GUARD_CAP) break;
      } while (nextCursor);

      const pending = allClaims.filter(c => !fulfilledSet.has(c.leaf_index));
      if (pending.length === 0) {
        const truncNote = truncatedAtWorker || nextCursor
          ? ' (worker reports more pages available; click Pull again after broadcasting these)'
          : '';
        if (status) status.innerHTML = `<span class="muted">No new claims in queue (${totalSeen} seen · ${fulfilledSet.size} already fulfilled locally${truncNote}).</span>`;
        return;
      }
      // Cap at 7 (the per-batch limit). Surplus claims stay in the queue for
      // the next pull — the issuer broadcasts in waves of 7.
      const take = pending.slice(0, 7);
      const lines = take.map(c => `${c.leaf_index},${c.tacit_pubkey},${c.eth_sig}`);
      $('#drop-fulfil-claims').value = lines.join('\n');
      if (status) {
        const localExtra = pending.length > take.length ? ` · ${pending.length - take.length} more in this fetch` : '';
        const remoteExtra = (nextCursor || truncatedAtWorker) ? ` · more queued upstream` : '';
        status.innerHTML = `<span style="color:var(--green);">Pulled ${take.length} claim${take.length === 1 ? '' : 's'} from queue${localExtra}${remoteExtra}. Click Verify next.</span>`;
      }
      toast(`Pulled ${take.length} queued claim${take.length === 1 ? '' : 's'}`, 'success');
    } catch (e) {
      if (status) status.innerHTML = `<span style="color:var(--red);">Pull failed: ${escapeHtml(e.message)}</span>`;
      console.error(e);
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });
}

// ============== CLAIM (recipient airdrop tab) ==============
// State for an in-progress claim. Cleared when user clicks Clear or when
// switching networks.
let _claimSnapshot = null;     // { schema, network, asset_id, asset_ticker, asset_decimals, merkle_root, rows: [{index, eth_address, amount}] }
let _claimEthAddr = null;      // lowercase 40-hex (no 0x); from MetaMask
let _claimEligibleRow = null;  // matched row from snapshot, or null
let _claimSigned = null;       // { msg, sigHex } once user signs

const IPFS_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

// Strip "ipfs://" prefix and any path; return bare CID. Tolerates spaces.
function _claimNormaliseCid(input) {
  let s = String(input || '').trim();
  s = s.replace(/^ipfs:\/\//i, '').replace(/\/+$/, '').split(/[/?#]/, 1)[0];
  if (!s) throw new Error('CID required');
  if (!/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|baf[a-z0-9]{50,})$/.test(s)) {
    throw new Error(`unrecognised IPFS CID format: ${s}`);
  }
  return s;
}

// Hard caps to bound a hostile/malfunctioning gateway: 10s per attempt and
// a 50 MB ceiling on the response body. A snapshot for a million-recipient
// drop is well under 200 MB of raw JSON; in practice they are KB to a few MB.
const _CLAIM_SNAPSHOT_TIMEOUT_MS = 10_000;
const _CLAIM_SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;

async function _claimFetchSnapshot(cid) {
  const errors = [];
  for (const gw of IPFS_GATEWAYS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), _CLAIM_SNAPSHOT_TIMEOUT_MS);
    try {
      const resp = await fetch(gw + cid, { cache: 'no-store', signal: ctl.signal });
      if (!resp.ok) { errors.push(`${gw}: ${resp.status}`); continue; }
      // Reject up-front if the gateway advertised an oversized body. Some
      // gateways omit content-length, in which case we still cap by reading
      // the body manually below.
      const advertised = Number(resp.headers.get('content-length') || 0);
      if (advertised > _CLAIM_SNAPSHOT_MAX_BYTES) {
        errors.push(`${gw}: response too large (${advertised} > ${_CLAIM_SNAPSHOT_MAX_BYTES})`);
        continue;
      }
      const text = await resp.text();
      if (text.length > _CLAIM_SNAPSHOT_MAX_BYTES) {
        errors.push(`${gw}: response too large (${text.length} > ${_CLAIM_SNAPSHOT_MAX_BYTES})`);
        continue;
      }
      return JSON.parse(text);
    } catch (e) {
      errors.push(`${gw}: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    } finally { clearTimeout(timer); }
  }
  throw new Error(`all gateways failed: ${errors.join(' | ')}`);
}

// Validate a parsed snapshot blob against a claimed merkle root. Refuses any
// inconsistency (wrong schema, wrong root, malformed rows, indexes not
// contiguous, root doesn't match recomputed). Sets the active claim state on
// success. Used by both IPFS-fetch and raw-paste paths.
function _claimValidateSnapshot(rootHexInput, blob) {
  const rootHex = String(rootHexInput || '').toLowerCase().replace(/^0x/, '').trim();
  if (!/^[0-9a-f]{64}$/.test(rootHex)) throw new Error('merkle root must be 64-hex');
  if (!blob || blob.schema !== 'tacit-airdrop-v1') throw new Error('snapshot not in tacit-airdrop-v1 schema');
  if (String(blob.merkle_root || '').toLowerCase() !== rootHex) {
    throw new Error(`snapshot root ${shorten(blob.merkle_root || '?', 8)} ≠ expected ${shorten(rootHex, 8)} — wrong source for this drop`);
  }
  if (!Array.isArray(blob.rows) || blob.rows.length === 0) throw new Error('snapshot has no rows');

  // Strict-validate every metadata field interpolated into UI templates so a
  // hostile gateway can't smuggle HTML through e.g. leaf_count or asset_id.
  // Closes MED#6.
  if (blob.leaf_count != null) {
    if (!Number.isInteger(blob.leaf_count) || blob.leaf_count !== blob.rows.length) {
      throw new Error(`snapshot leaf_count (${typeof blob.leaf_count === 'string' ? blob.leaf_count.slice(0, 32) : blob.leaf_count}) ≠ rows.length (${blob.rows.length})`);
    }
  }
  if (blob.network != null && blob.network !== 'signet' && blob.network !== 'mainnet') {
    throw new Error(`snapshot network must be "signet" or "mainnet"`);
  }
  if (blob.asset_id != null && !/^[0-9a-f]{64}$/.test(String(blob.asset_id).toLowerCase())) {
    throw new Error('snapshot asset_id must be 64-char hex');
  }
  if (blob.asset_decimals != null && (!Number.isInteger(blob.asset_decimals) || blob.asset_decimals < 0 || blob.asset_decimals > 8)) {
    throw new Error('snapshot asset_decimals must be integer 0..8 (CETCH max)');
  }
  if (blob.asset_ticker != null) {
    if (typeof blob.asset_ticker !== 'string' || blob.asset_ticker.length === 0 || blob.asset_ticker.length > 16) {
      throw new Error('snapshot asset_ticker must be a string of length 1..16');
    }
    // Reject control characters and bidi marks. The ticker is interpolated
    // verbatim into the EIP-191 message MetaMask shows when signing; a
    // newline or right-to-left override could visually rearrange the
    // displayed message even though the bytes signed are unambiguous.
    // Range covers C0 controls, DEL, and the LRE/RLE/PDF/LRO/RLO/LRI/RLI/FSI/PDI bidi codepoints.
    for (let i = 0; i < blob.asset_ticker.length; i++) {
      const cp = blob.asset_ticker.codePointAt(i);
      if (cp < 0x20 || cp === 0x7f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
        throw new Error('snapshot asset_ticker contains control or bidi characters');
      }
    }
  }
  if (blob.total_amount != null) {
    if (typeof blob.total_amount !== 'string' || !/^[0-9]+$/.test(blob.total_amount)) {
      throw new Error('snapshot total_amount must be a base-10 integer string');
    }
    try { const _t = BigInt(blob.total_amount); if (_t < 0n) throw new Error('negative'); }
    catch { throw new Error('snapshot total_amount unparseable as BigInt'); }
  }

  const reconstructedRows = blob.rows.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`row ${i} not an object`);
    const cleanAddr = String(r.eth_address || '').toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(cleanAddr)) throw new Error(`malformed eth_address at row ${i}`);
    if (!Number.isInteger(r.index) || r.index < 0) throw new Error(`row ${i} has non-integer index`);
    if (typeof r.amount !== 'string' && typeof r.amount !== 'number' && typeof r.amount !== 'bigint') {
      throw new Error(`row ${i} amount must be a string, number, or bigint`);
    }
    let amount;
    try { amount = BigInt(r.amount); }
    catch { throw new Error(`row ${i} amount unparseable: ${String(r.amount).slice(0, 32)}`); }
    if (amount < 0n || amount >= (1n << 64n)) throw new Error(`row ${i} amount out of u64 range`);
    return {
      ethAddrHex: cleanAddr,
      ethAddrBytes: hexToBytes(cleanAddr),
      amount,
      index: r.index,
    };
  });
  reconstructedRows.sort((a, b) => a.index - b.index);
  for (let i = 0; i < reconstructedRows.length; i++) {
    if (reconstructedRows[i].index !== i) {
      throw new Error(`snapshot indexes are not contiguous 0..N-1 (saw index ${reconstructedRows[i].index} at slot ${i})`);
    }
  }
  // Reject duplicate ETH addresses. The issuer-side builder dedupes by
  // summing duplicates, but a hand-rolled snapshot might pass the root
  // recompute with two leaves for the same address. Eligibility uses
  // `.find()`, so the recipient would only see the first leaf and the
  // second silently strands. Fail loudly at load time.
  const _seenAddrs = new Set();
  for (const r of reconstructedRows) {
    if (_seenAddrs.has(r.ethAddrHex)) {
      throw new Error(`snapshot contains duplicate eth_address: 0x${r.ethAddrHex} (each address must appear at most once)`);
    }
    _seenAddrs.add(r.ethAddrHex);
  }
  // If the snapshot advertises `total_amount`, it must equal the sum of
  // row amounts. Mismatch wouldn't break crypto (the root recompute below
  // catches tampered rows), but it would mislead the displayed payout
  // figure on the discover/claim UI.
  if (blob.total_amount != null) {
    const declared = BigInt(blob.total_amount);
    const summed = reconstructedRows.reduce((s, r) => s + r.amount, 0n);
    if (declared !== summed) {
      throw new Error(`snapshot total_amount (${declared}) does not equal sum of rows (${summed})`);
    }
  }
  const leaves = reconstructedRows.map(r => airdropLeafHash(r.ethAddrBytes, r.amount, r.index));
  const { root } = buildAirdropMerkle(leaves);
  if (bytesToHex(root) !== rootHex) {
    throw new Error('snapshot rows do NOT hash to claimed root — source is tampered or corrupt');
  }
  blob._reconstructedRows = reconstructedRows;
  _claimSnapshot = blob;
  _claimEligibleRow = null;
  _claimSigned = null;
  return blob;
}

// Fetch via IPFS gateway list, then validate.
async function _claimLoadSnapshot(rootHexInput, cidInput) {
  const rootHex = String(rootHexInput || '').toLowerCase().replace(/^0x/, '').trim();
  if (!/^[0-9a-f]{64}$/.test(rootHex)) throw new Error('merkle root must be 64-hex');
  const cid = _claimNormaliseCid(cidInput);
  const blob = await _claimFetchSnapshot(cid);
  return _claimValidateSnapshot(rootHex, blob);
}

// Parse a pasted JSON blob, then validate. Path of last resort when all IPFS
// gateways fail (corporate proxy, censorship, etc) or for offline review.
function _claimLoadSnapshotFromJSON(rootHexInput, jsonText) {
  let blob;
  try { blob = JSON.parse(jsonText); }
  catch (e) { throw new Error('not valid JSON: ' + e.message); }
  return _claimValidateSnapshot(rootHexInput, blob);
}

function _renderClaimSnapshotInfo() {
  const out = $('#claim-load-out');
  if (!out) return;
  if (!_claimSnapshot) { out.style.display = 'none'; out.innerHTML = ''; return; }
  const s = _claimSnapshot;
  const total = BigInt(s.total_amount || '0');
  const ticker = s.asset_ticker || '?';
  const decimals = Number.isInteger(s.asset_decimals) ? s.asset_decimals : 0;
  const networkBadge = s.network === 'mainnet'
    ? `<span style="color:var(--orange);">⚠ MAINNET</span>`
    : `<span style="color:var(--ink-mid);">signet</span>`;
  out.style.display = 'block';
  out.innerHTML = `
    <div class="tx-preview">
      <h4>Snapshot loaded · root verified</h4>
      <div class="row"><span class="label">network</span>${networkBadge}</div>
      <div class="row"><span class="label">asset</span><strong>${escapeHtml(ticker)}</strong> · <code style="font-size:11px;">${escapeHtml(shorten(s.asset_id || '?', 12))}</code></div>
      <div class="row"><span class="label">recipients</span>${s.leaf_count || s.rows.length}</div>
      <div class="row"><span class="label">total payout</span>${fmtAssetAmountPlain(total, decimals)} ${escapeHtml(ticker)}</div>
      <div class="row"><span class="label">root</span><code style="font-size:11px;">${escapeHtml(s.merkle_root)}</code></div>
    </div>
  `;
}

// ============== EIP-6963 multi-provider discovery ==============
// Pre-EIP-6963 dApps used `window.ethereum` directly, which silently picked
// "whichever wallet loaded last" when more than one was injected (MetaMask +
// Rabby + Coinbase Wallet, common combo). EIP-6963 fixes this: each wallet
// dispatches an `eip6963:announceProvider` event with its own EIP-1193
// provider object; the dApp listens, collects them, and presents a chooser
// when more than one is available.
//
// Compat: every wallet that supports EIP-6963 also keeps injecting
// `window.ethereum`, so the fallback path still works for older wallets that
// don't announce. We dispatch `eip6963:requestProvider` to nudge providers
// that load after our listener is wired.
const _ethProviders = [];                   // [{ info: {uuid, name, icon, rdns}, provider }]
let _ethSelectedProvider = null;            // selected provider; null = use window.ethereum
function _ethAnnounceProvider(detail) {
  if (!detail || !detail.info || !detail.provider) return;
  if (_ethProviders.find(p => p.info.uuid === detail.info.uuid)) return;
  _ethProviders.push(detail);
}
window.addEventListener('eip6963:announceProvider', e => _ethAnnounceProvider(e.detail));
// Fire once at module load so wallets announced before our listener wired up
// re-announce. Wallets that load after this still announce themselves on
// load and our persistent listener catches those.
try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch {}
function _ethProvider() {
  return _ethSelectedProvider || window.ethereum || null;
}
function _ethProviderLabel() {
  if (_ethSelectedProvider) {
    const announced = _ethProviders.find(p => p.provider === _ethSelectedProvider);
    if (announced?.info?.name) return announced.info.name;
  }
  return 'Ethereum wallet';
}

// Strip control + bidi characters from a wallet-supplied display string. A
// malicious or misconfigured wallet that announces itself with a name like
// "Trust‮kellaW" could visually invert text in the chooser; strip those
// codepoints. Same defense as the snapshot ticker validator.
function _sanitizeWalletDisplayString(s) {
  if (typeof s !== 'string') return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue;
    out += s[i];
  }
  return out.slice(0, 80);  // cap length so a long name can't blow out the layout
}

// Modal chooser — shown when ≥2 EIP-6963 providers are detected and none has
// been selected yet. Resolves with the chosen provider, or null on cancel.
function _showEthProviderChooser() {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'welcome-modal';
    modal.style.zIndex = '1020';
    // Idempotent removal: button onclick + cancel both can fire (rapid
    // clicks, ESC handler, etc). Without this guard, the second remove
    // throws "Node was not found" because the modal is no longer a child.
    const closeOnce = () => {
      if (modal.parentNode === document.body) document.body.removeChild(modal);
    };
    const card = document.createElement('div');
    card.className = 'welcome-card';
    card.innerHTML = `
      <div class="welcome-title">choose <span class="accent">wallet</span></div>
      <div class="welcome-lede">Multiple Ethereum wallets are installed in this browser. Pick the one holding the address you want to claim with.</div>
      <div class="welcome-options" id="eth-chooser-options"></div>
      <div class="welcome-footer" style="display:flex;justify-content:flex-end;">
        <button id="eth-chooser-cancel" type="button" style="font-size:11px;">Cancel</button>
      </div>
    `;
    modal.appendChild(card);
    document.body.appendChild(modal);
    const opts = card.querySelector('#eth-chooser-options');
    for (const p of _ethProviders) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'welcome-option';
      const safeName = _sanitizeWalletDisplayString(p.info.name) || 'unknown wallet';
      const safeRdns = _sanitizeWalletDisplayString(p.info.rdns);
      const iconHtml = (p.info.icon && /^data:image\//.test(p.info.icon))
        ? `<img loading="lazy" decoding="async" src="${escapeHtml(p.info.icon)}" alt="" style="width:20px;height:20px;vertical-align:middle;margin-right:8px;">`
        : '';
      btn.innerHTML = `
        <span class="welcome-option-title">${iconHtml}${escapeHtml(safeName)}</span>
        <span class="welcome-option-meta">${escapeHtml(safeRdns)}</span>
      `;
      btn.onclick = () => { closeOnce(); resolve(p.provider); };
      opts.appendChild(btn);
    }
    card.querySelector('#eth-chooser-cancel').onclick = () => {
      closeOnce();
      resolve(null);
    };
    // ESC key dismisses. Bound on the modal itself to avoid leaking the
    // listener once the modal closes — closeOnce removes the element so
    // subsequent ESC presses no-op.
    const onKey = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        closeOnce();
        resolve(null);
      }
    };
    document.addEventListener('keydown', onKey);
  });
}

// Connect to an Ethereum wallet. If multiple are announced via EIP-6963, the
// user picks one; otherwise we use the only announced provider, or fall back
// to `window.ethereum` for legacy injection.
async function _claimConnectMetaMask() {
  // Re-dispatch the EIP-6963 nudge each connect — wallets that loaded
  // milliseconds after our module-load dispatch will still be in
  // _ethProviders thanks to the persistent listener, but a wallet that
  // ignores its own announce-on-load contract only re-announces on this
  // request. Idempotent (existing entries dedupe by uuid).
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch {}

  let provider = _ethSelectedProvider;
  if (!provider) {
    if (_ethProviders.length >= 2) {
      provider = await _showEthProviderChooser();
      if (!provider) throw new Error('no wallet selected');
      _ethSelectedProvider = provider;
    } else if (_ethProviders.length === 1) {
      provider = _ethProviders[0].provider;
      _ethSelectedProvider = provider;
    } else {
      provider = window.ethereum;
    }
  }
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('no Ethereum wallet detected — install one (MetaMask, Rainbow, Rabby, Coinbase Wallet, …) or unlock an existing one');
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('no accounts returned by Ethereum wallet');
  const addr = String(accounts[0]).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(addr)) throw new Error(`wallet returned malformed address: ${accounts[0]}`);
  _claimEthAddr = addr;
  _claimSigned = null;
  // Re-bind the accountsChanged listener to the selected provider — the
  // window-level listener wired in setupClaimTab covered window.ethereum, but
  // a chosen EIP-6963 provider may be a different object. Idempotent (the
  // wallet's own dedupe means re-binding is safe).
  if (provider.on && !provider._tacitAccountsBound) {
    provider._tacitAccountsBound = true;
    provider.on('accountsChanged', accounts => {
      _claimEthAddr = (Array.isArray(accounts) && accounts.length)
        ? String(accounts[0]).toLowerCase().replace(/^0x/, '')
        : null;
      _claimSigned = null;
      _renderClaimEligibility();
      _renderClaimMsgPreview();
      _renderClaimResult();
      _renderClaimDiscoverList();
    });
  }
  return addr;
}

function _renderClaimEligibility() {
  const out = $('#claim-eligibility');
  const status = $('#claim-mm-status');
  const signBtn = $('#btn-claim-sign');
  if (!out) return;
  out.style.display = 'none'; out.innerHTML = '';
  if (signBtn) signBtn.disabled = true;

  if (!_claimEthAddr) {
    if (status) status.textContent = '';
    return;
  }
  if (status) status.innerHTML = `connected: <code>0x${escapeHtml(_claimEthAddr)}</code>`;

  if (!_claimSnapshot) {
    out.style.display = 'block';
    out.innerHTML = `<div class="muted">Load a snapshot first to check eligibility.</div>`;
    return;
  }

  const row = _claimSnapshot._reconstructedRows.find(r => r.ethAddrHex === _claimEthAddr);
  _claimEligibleRow = row || null;
  const ticker = _claimSnapshot.asset_ticker || '?';
  const decimals = Number.isInteger(_claimSnapshot.asset_decimals) ? _claimSnapshot.asset_decimals : 0;
  out.style.display = 'block';
  if (!row) {
    out.innerHTML = `
      <div class="warn">
        <strong>Not eligible.</strong> Address <code>0x${escapeHtml(_claimEthAddr)}</code> is not in this drop's snapshot. If you have multiple ETH addresses, switch in MetaMask and reconnect.
      </div>`;
    return;
  }
  // Network-mismatch banner — the readiness check already disables the
  // sign button, but the user needs a concrete reason: tacit wallets are
  // network-scoped, so signing a mainnet drop while on signet binds the
  // claim to a key that doesn't exist on mainnet. Block prominently.
  const networkMismatch = _claimSnapshot.network !== NET.name;
  const networkBanner = networkMismatch
    ? `<div class="warn" style="border-left-color:var(--red);background:#fee;">
         <strong>⚠ Network mismatch.</strong> This drop is for <strong>${escapeHtml(_claimSnapshot.network)}</strong>, but tacit is currently on <strong>${escapeHtml(NET.name)}</strong>.<br>
         Switch tacit to ${escapeHtml(_claimSnapshot.network)} (top-right network selector) before signing — otherwise the issuer fulfils on ${escapeHtml(_claimSnapshot.network)} to a pubkey that only exists on your ${escapeHtml(NET.name)} wallet.
       </div>`
    : '';
  out.innerHTML = `
    ${networkBanner}
    <div class="warn" style="border-left-color:var(--green);background:var(--bg-warm);">
      <strong>✓ Eligible</strong> · leaf #${row.index}
      <div style="margin-top:4px;">amount: <strong>${fmtAssetAmountPlain(row.amount, decimals)} ${escapeHtml(ticker)}</strong> (${row.amount.toString()} base units)</div>
    </div>
  `;
  _refreshClaimSignAvailability();
  _renderClaimMsgPreview();
}

function _renderClaimTacitId() {
  const out = $('#claim-tacit-id');
  if (!out) return;
  if (!wallet.pub) { out.textContent = '(no active wallet)'; return; }
  const pubHex = bytesToHex(wallet.pub);
  const addr = wallet.address ? wallet.address() : '?';
  out.innerHTML = `
    <div><span class="label">tacit pubkey</span> <code>${escapeHtml(pubHex)}</code></div>
    <div style="margin-top:4px;"><span class="label">tacit address</span> <code>${escapeHtml(addr)}</code></div>
    <div class="muted" style="margin-top:4px;font-size:11px;">network: ${escapeHtml(NET.name)}</div>
  `;
}

function _refreshClaimSignAvailability() {
  const btn = $('#btn-claim-sign');
  if (!btn) return;
  // Network-match guard: signing a mainnet drop while the dApp is on signet
  // (or vice versa) binds the claim to the wallet that exists on the OTHER
  // network than the one the issuer fulfils on — funds appear "lost." Hard
  // refuse unless `_claimSnapshot.network === NET.name`.
  const networkMatches = !_claimSnapshot || _claimSnapshot.network === NET.name;
  const ready = !!(_claimSnapshot && _claimEthAddr && _claimEligibleRow && wallet.pub && networkMatches);
  btn.disabled = !ready;
  if (!ready) btn.title = !_claimSnapshot ? 'Load a snapshot first'
    : !networkMatches ? `Drop is for ${_claimSnapshot.network}; switch tacit network before signing`
    : !_claimEthAddr ? 'Connect Ethereum wallet first'
    : !_claimEligibleRow ? 'This address is not in the snapshot'
    : !wallet.pub ? 'No active tacit wallet (open Wallet tab to set up)'
    : '';
  else btn.title = '';
}

function _renderClaimMsgPreview() {
  const out = $('#claim-msg-preview');
  if (!out) return;
  if (!_claimSnapshot || !_claimEthAddr || !_claimEligibleRow || !wallet.pub) {
    out.textContent = '(connect Ethereum wallet + load snapshot to preview)';
    return;
  }
  try {
    const msg = buildAirdropClaimMsg({
      rootHex: _claimSnapshot.merkle_root,
      network: _claimSnapshot.network,
      assetIdHex: _claimSnapshot.asset_id,
      ethAddrHex: _claimEthAddr,
      leafIndex: _claimEligibleRow.index,
      amount: _claimEligibleRow.amount,
      ticker: _claimSnapshot.asset_ticker || '?',
      decimals: Number.isInteger(_claimSnapshot.asset_decimals) ? _claimSnapshot.asset_decimals : 0,
      tacitPubHex: bytesToHex(wallet.pub),
    });
    out.textContent = msg;
  } catch (e) {
    out.textContent = '(error building preview: ' + e.message + ')';
  }
}

async function _claimSign() {
  if (!_claimSnapshot || !_claimEthAddr || !_claimEligibleRow || !wallet.pub) {
    throw new Error('not ready to sign');
  }
  // Defense-in-depth network match: the readiness guard already disables the
  // button, but a programmatic call (or a stale-state click) could otherwise
  // sign for the wrong tacit identity. Hard-refuse here too.
  if (_claimSnapshot.network !== NET.name) {
    throw new Error(`This drop is for ${_claimSnapshot.network}. Switch tacit to ${_claimSnapshot.network} (top-right network selector) before signing — otherwise the issuer fulfils on ${_claimSnapshot.network} to your ${NET.name} wallet's pubkey, which doesn't exist on ${_claimSnapshot.network}.`);
  }
  const tacitPubHex = bytesToHex(wallet.pub);
  const msg = buildAirdropClaimMsg({
    rootHex: _claimSnapshot.merkle_root,
    network: _claimSnapshot.network,
    assetIdHex: _claimSnapshot.asset_id,
    ethAddrHex: _claimEthAddr,
    leafIndex: _claimEligibleRow.index,
    amount: _claimEligibleRow.amount,
    ticker: _claimSnapshot.asset_ticker || '?',
    decimals: Number.isInteger(_claimSnapshot.asset_decimals) ? _claimSnapshot.asset_decimals : 0,
    tacitPubHex,
  });
  const eth = _ethProvider();
  if (!eth) throw new Error('Ethereum wallet unavailable — connect first');
  // personal_sign with msg as 0x-hex (most providers prefer hex; some EOA
  // wallets accept either form, smart-wallet bridges only accept hex).
  const msgHex = '0x' + bytesToHex(new TextEncoder().encode(msg));
  const sig = await eth.request({
    method: 'personal_sign',
    params: [msgHex, '0x' + _claimEthAddr],
  });
  if (typeof sig !== 'string' || !sig.startsWith('0x')) throw new Error('Ethereum wallet returned invalid signature');
  // Self-verify: try ECDSA recovery first (EOA wallets — MetaMask, Rainbow,
  // Coinbase Wallet, Rabby, Trust). On mismatch, fall back to ERC-1271 via
  // the wallet's own RPC (smart-wallet support — Ambire, Safe, Argent).
  // Either path passing means the wallet has cryptographically authorized
  // this message under the connected address.
  let verified = false;
  try { verified = verifyAirdropClaimSig(msg, sig, _claimEthAddr); } catch {}
  if (!verified) {
    try { verified = await verifyEthSigViaErc1271(msg, sig, _claimEthAddr, eth); }
    catch (e) { console.warn('ERC-1271 fallback failed:', e); }
  }
  if (!verified) {
    throw new Error('signature self-verify failed — wallet returned a malformed signature, or the connected address is a smart wallet on a chain whose ERC-1271 contract this wallet can\'t resolve');
  }
  _claimSigned = { msg, sigHex: sig.toLowerCase(), tacitPubHex };
  return _claimSigned;
}

// ============== ERC-1271 fallback (smart-contract wallets) ==============
// Smart-wallet wallets (Ambire, Safe, Argent) sign with contract logic, not a
// secp256k1 private key, so secp256k1 ecrecover doesn't return their address.
// EIP-1271 defines `isValidSignature(bytes32 hash, bytes sig) → bytes4` which
// the contract resolves on-chain; magic value 0x1626ba7e means valid.
//
// We piggy-back on the wallet's own EIP-1193 transport for the eth_call so we
// don't need a separate Ethereum RPC endpoint (and don't need to widen the
// CSP). The connected provider is whatever chain the wallet is on; if the
// snapshot is for a different chain than the wallet's current network, the
// eth_call would target the wrong contract address and (almost certainly)
// return empty bytes, causing this verifier to return false. That's the
// correct behavior — the user needs to switch chains in their wallet.
const ERC1271_MAGIC = '0x1626ba7e';
async function verifyEthSigViaErc1271(msg, sigHex, expectedEthAddrHex, provider) {
  if (!provider || typeof provider.request !== 'function') return false;
  const cleanAddr = String(expectedEthAddrHex).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(cleanAddr)) return false;
  const cleanSig = String(sigHex).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(cleanSig) || cleanSig.length % 2) return false;
  const hash = eip191Hash(msg);   // bytes32 — same hash MetaMask shows in personal_sign UX
  // ABI-encode (bytes32 hash, bytes sig):
  //   selector(4) || hash(32) || offset(32 = 0x40) || length(32) || sig_data || zero-pad
  const sigBytes = cleanSig.length / 2;
  const padBytes = (32 - (sigBytes % 32)) % 32;
  const calldata = '0x' +
    ERC1271_MAGIC.slice(2) +
    bytesToHex(hash) +
    '0000000000000000000000000000000000000000000000000000000000000040' +
    sigBytes.toString(16).padStart(64, '0') +
    cleanSig +
    '00'.repeat(padBytes);
  let result;
  try {
    result = await provider.request({
      method: 'eth_call',
      params: [{ to: '0x' + cleanAddr, data: calldata }, 'latest'],
    });
  } catch {
    // eth_call failed — could be that the address is an EOA (no contract code)
    // or the chain rejected it. Either way, ERC-1271 doesn't apply.
    return false;
  }
  // Result is right-padded to 32 bytes. We just check the magic-value prefix
  // — anything else (including empty, all-zeros, or a different bytes4) means
  // the contract did not validate the signature.
  return typeof result === 'string' && result.toLowerCase().startsWith(ERC1271_MAGIC);
}

function _renderClaimResult() {
  const out = $('#claim-result');
  if (!out) return;
  // Pre-sign placeholder so the "5 · Send to issuer" heading isn't a bare,
  // empty section. Mirrors step 4's preview pattern. Shown only when the
  // user has loaded a snapshot but hasn't signed yet — fully empty before
  // a snapshot exists so we don't push the user past steps 1–3.
  if (!_claimSigned || !_claimEligibleRow) {
    if (_claimSnapshot) {
      out.style.display = 'block';
      out.innerHTML = `<div class="muted" style="font-size:11px;font-style:italic;">Complete step 4 (sign with wallet) to populate the claim tuple here.</div>`;
    } else {
      out.style.display = 'none';
      out.innerHTML = '';
    }
    return;
  }
  const tuple = `${_claimEligibleRow.index},${_claimSigned.tacitPubHex},${_claimSigned.sigHex}`;
  const ticker = _claimSnapshot.asset_ticker || '?';
  const submitBlurb = WORKER_BASE
    ? `Submit to the issuer's queue with one click, OR copy the line below and send through whatever channel the issuer specified. Submission to the queue is dumb storage — the issuer's dapp re-verifies before broadcasting.`
    : `Worker is disabled in this dapp build, so manual hand-off is the only option. Copy the line below and send through whatever channel the issuer specified.`;
  out.style.display = 'block';
  out.innerHTML = `
    <div class="warn" style="border-left-color:var(--green);background:var(--bg-warm);">
      <strong>✓ Signed</strong>
      <div class="muted" style="font-size:11px;margin-top:4px;">${submitBlurb}</div>
      <textarea id="claim-tuple-out" rows="4" readonly style="margin-top:8px;font-family:var(--mono);font-size:11px;">${escapeHtml(tuple)}</textarea>
      <div class="flex" style="gap:6px;margin-top:8px;flex-wrap:wrap;">
        ${WORKER_BASE ? `<button id="btn-claim-submit" type="button" class="primary">Submit to issuer queue</button>` : ''}
        <button id="btn-claim-copy" type="button">Copy claim line</button>
        <button id="btn-claim-copy-msg" type="button" title="The full canonical message you signed">Copy signed message</button>
      </div>
      <div id="claim-submit-status" style="margin-top:8px;font-size:11px;"></div>
      <div class="muted" style="font-size:11px;margin-top:8px;">Once the issuer fulfils, your tacit wallet auto-recovers ${escapeHtml(ticker)} from chain on next scan. No further action needed on your end.</div>
    </div>
  `;
  $('#btn-claim-copy').onclick = () => {
    navigator.clipboard?.writeText(tuple)
      .then(() => toast('Claim copied', 'success'))
      .catch(() => prompt('Copy claim line:', tuple));
  };
  $('#btn-claim-copy-msg').onclick = () => {
    navigator.clipboard?.writeText(_claimSigned.msg)
      .then(() => toast('Signed message copied', 'success'))
      .catch(() => prompt('Copy signed message:', _claimSigned.msg));
  };
  const submitBtn = $('#btn-claim-submit');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      const status = $('#claim-submit-status');
      submitBtn.disabled = true; const orig = submitBtn.textContent; submitBtn.textContent = 'submitting…';
      if (status) status.textContent = '';
      try {
        const url = `${WORKER_BASE}/airdrops/${_claimSnapshot.merkle_root}/claims?network=${encodeURIComponent(_claimSnapshot.network)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leaf_index: _claimEligibleRow.index,
            tacit_pubkey: _claimSigned.tacitPubHex,
            eth_sig: _claimSigned.sigHex,
          }),
        });
        if (!resp.ok) throw new Error(`worker returned ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
        const j = await resp.json();
        if (status) status.innerHTML = `<span style="color:var(--green);">✓ Submitted to issuer queue at ${new Date((j.claim?.submitted_at || Math.floor(Date.now() / 1000)) * 1000).toLocaleString()}</span>`;
        toast('Claim submitted to issuer queue', 'success');
      } catch (e) {
        if (status) status.innerHTML = `<span style="color:var(--red);">✗ Submit failed: ${escapeHtml(e.message)} — fall back to copy + manual hand-off.</span>`;
      } finally {
        submitBtn.disabled = false; submitBtn.textContent = orig;
      }
    };
  }
}

// Silently probe MetaMask for already-authorized accounts. Unlike
// eth_requestAccounts (which prompts on every fresh connect), eth_accounts
// returns whatever the page already has permission for, with no popup.
// Called on Claim tab activation so a returning visitor's connection state
// is restored without a click.
async function _claimAutoConnect() {
  // Try the previously-selected EIP-6963 provider first (so a returning user
  // who picked Rabby last session reconnects to Rabby, not whatever happens
  // to be at window.ethereum now). Falls back to window.ethereum when no
  // EIP-6963 selection has been made yet.
  const eth = _ethProvider();
  if (!eth || typeof eth.request !== 'function') return;
  try {
    const accounts = await eth.request({ method: 'eth_accounts' });
    if (Array.isArray(accounts) && accounts.length > 0) {
      const addr = String(accounts[0]).toLowerCase().replace(/^0x/, '');
      if (/^[0-9a-f]{40}$/.test(addr)) _claimEthAddr = addr;
    }
  } catch { /* user not connected; nothing to restore */ }
}

function _consumeClaimUrlHash() {
  // Allow either:
  //   #claim=<root>&cid=<cid>
  //   #claim=<root>
  // Coexists with the existing #recv= share-link import (which never matches).
  const h = location.hash || '';
  if (!h.startsWith('#claim=')) return;
  const params = new URLSearchParams(h.slice(1));
  const rawRoot = params.get('claim');
  const rawCid = params.get('cid');
  // Validate both fields *before* writing them into inputs and triggering
  // auto-load. A crafted hash can't otherwise produce script execution (CSP
  // blocks inline JS and we use `.value=` not `innerHTML`), but stuffing
  // arbitrary strings into the inputs and auto-clicking Load could route a
  // claimant's request to an attacker-supplied CID.
  const root = (rawRoot && /^[0-9a-f]{64}$/i.test(rawRoot.replace(/^0x/, ''))) ? rawRoot.replace(/^0x/, '').toLowerCase() : null;
  let cid = null;
  if (rawCid) {
    try { cid = _claimNormaliseCid(rawCid); } catch { cid = null; }
  }
  if (root) {
    const rEl = $('#claim-root');
    if (rEl) rEl.value = root;
  }
  if (cid) {
    const cEl = $('#claim-cid');
    if (cEl) cEl.value = cid;
  }
  // Clear the hash from the address bar once consumed so a refresh doesn't
  // re-trigger auto-load and the URL doesn't propagate the snapshot fingerprint.
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  // Switch to the Claim tab automatically.
  const claimTabBtn = $('.tab[data-tab="claim"]');
  if (claimTabBtn) claimTabBtn.click();
  // Auto-load only if both fields parsed cleanly.
  if (root && cid) {
    setTimeout(() => $('#btn-claim-load')?.click(), 50);
  }
}

// ============== Discovery list (recipient side) ==============
// Holds the latest /drops fetch + per-drop snapshot fetch results, keyed by
// merkle_root. Populated by `_claimRefreshDiscover`; consumed by
// `_renderClaimDiscoverList` which re-renders on every state change (MetaMask
// connect/disconnect, snapshot fetch completion, snapshot fetch failure).
let _claimDiscoverDrops = [];
const _claimDiscoverSnapshots = new Map(); // root -> { rows, error?, fetching? }

async function _claimRefreshDiscover() {
  const list = $('#claim-discover-list');
  const status = $('#claim-discover-status');
  const netLabel = $('#claim-discover-network');
  if (netLabel) netLabel.textContent = NET.name;
  if (!WORKER_BASE) {
    if (list) list.innerHTML = `<div class="muted" style="padding:14px;text-align:center;font-style:italic;font-size:11px;">Worker not configured · use manual entry below</div>`;
    return;
  }
  if (status) status.textContent = 'loading…';
  try {
    const resp = await fetch(withNet(DROPS_URL));
    if (!resp.ok) throw new Error(`worker ${resp.status}`);
    const j = await resp.json();
    _claimDiscoverDrops = Array.isArray(j.drops) ? j.drops : [];
    if (status) status.textContent = `${_claimDiscoverDrops.length} active`;
  } catch (e) {
    if (status) status.textContent = `error: ${e.message}`;
    _claimDiscoverDrops = [];
  }
  // Kick off snapshot fetches in parallel — each completion re-renders so
  // eligibility flips into place as it arrives. Snapshots are cached per
  // root, so a refresh doesn't re-fetch already-resolved CIDs.
  for (const d of _claimDiscoverDrops) {
    if (!_claimDiscoverSnapshots.has(d.merkle_root)) {
      _claimDiscoverSnapshots.set(d.merkle_root, { fetching: true });
      _claimFetchSnapshot(d.ipfs_cid)
        .then(blob => {
          // The full root-recompute happens on the manual-load path the user
          // triggers via "Claim →"; the lighter-weight check here just
          // ensures the blob's declared root matches the announcement, so
          // we never display rows that disagree with what we'd verify later.
          if (String(blob.merkle_root || '').toLowerCase() !== d.merkle_root) {
            throw new Error('snapshot root does not match announcement');
          }
          const rows = _claimReconstructDiscoveredRows(blob);
          _claimDiscoverSnapshots.set(d.merkle_root, { rows });
          _renderClaimDiscoverList();
        })
        .catch(e => {
          _claimDiscoverSnapshots.set(d.merkle_root, { error: e.message });
          _renderClaimDiscoverList();
        });
    }
  }
  _renderClaimDiscoverList();
}

function _claimReconstructDiscoveredRows(blob) {
  if (!blob || !Array.isArray(blob.rows)) throw new Error('snapshot has no rows[]');
  return blob.rows.map((r, i) => {
    const ethAddrHex = String(r.eth_address || r.eth_addr || '').toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{40}$/.test(ethAddrHex)) throw new Error(`row ${i} has invalid eth_address`);
    let amount;
    try { amount = BigInt(r.amount); } catch { throw new Error(`row ${i} has invalid amount`); }
    const index = Number.isInteger(r.index) ? r.index : i;
    return { ethAddrHex, amount, index };
  });
}

// Provenance heuristic: 'matches_etcher' | 'self_announced' | 'unknown'.
// Conservative — for non-mintable assets we don't have the etcher's
// signing-pubkey cached locally, so the badge falls back to 'unknown' rather
// than misleading the user with a false-positive green flag.
function _claimProvenance(d, meta) {
  if (!d || !d.issuer_pubkey || !meta) return 'unknown';
  const issuerXOnly = String(d.issuer_pubkey).slice(2).toLowerCase();
  if (meta.mintAuthorityHex && /^[0-9a-f]{64}$/.test(meta.mintAuthorityHex)) {
    return meta.mintAuthorityHex.toLowerCase() === issuerXOnly ? 'matches_etcher' : 'self_announced';
  }
  return 'unknown';
}

function _renderClaimDiscoverList() {
  const list = $('#claim-discover-list');
  if (!list) return;
  if (!_claimDiscoverDrops.length) {
    list.innerHTML = `<div class="muted" style="padding:14px;text-align:center;font-style:italic;font-size:11px;">No drops announced on ${escapeHtml(NET.name)} yet · use manual entry below if you have a private (root, CID)</div>`;
    return;
  }
  // Sort: eligible first, then announced_at desc.
  const rendered = _claimDiscoverDrops.map(d => {
    const snap = _claimDiscoverSnapshots.get(d.merkle_root);
    let eligibleRow = null;
    let snapshotState = 'fetching';
    if (snap?.error) snapshotState = 'error';
    else if (snap?.rows) {
      snapshotState = 'loaded';
      if (_claimEthAddr) eligibleRow = snap.rows.find(r => r.ethAddrHex === _claimEthAddr) || null;
    }
    return { d, snap, eligibleRow, snapshotState };
  });
  rendered.sort((a, b) => {
    const aE = a.eligibleRow ? 1 : 0, bE = b.eligibleRow ? 1 : 0;
    if (aE !== bE) return bE - aE;
    return (b.d.announced_at || 0) - (a.d.announced_at || 0);
  });

  list.innerHTML = rendered.map(({ d, snap, eligibleRow, snapshotState }) => {
    const meta = getAssetMeta(d.asset_id);
    const ticker = meta?.ticker || '?';
    const decimals = Number.isInteger(meta?.decimals) ? meta.decimals : 0;
    const expIso = new Date((d.expires_at || 0) * 1000).toISOString().slice(0, 10);
    const issuerShort = shorten(d.issuer_pubkey || '', 10);
    const provenance = _claimProvenance(d, meta);
    const provBadge = provenance === 'matches_etcher'
      ? `<span class="status-pill confirmed" style="font-size:9px;">issued by etcher</span>`
      : provenance === 'self_announced'
        ? `<span class="status-pill" style="background:var(--bg-warm);color:var(--orange);border-color:var(--orange);font-size:9px;">⚠ self-announced</span>`
        : `<span class="status-pill pending" style="font-size:9px;">unverified provenance</span>`;
    let amountLine = '';
    let actionLine = '';
    if (snapshotState === 'fetching') {
      amountLine = `<div class="muted" style="font-size:11px;">checking eligibility…</div>`;
      actionLine = `<button disabled style="font-size:11px;">…</button>`;
    } else if (snapshotState === 'error') {
      amountLine = `<div class="error" style="font-size:11px;">snapshot fetch failed: ${escapeHtml(snap.error)}</div>`;
      actionLine = `<button disabled style="font-size:11px;">unavailable</button>`;
    } else if (!_claimEthAddr) {
      amountLine = `<div class="muted" style="font-size:11px;">${snap.rows.length} recipients · connect Ethereum wallet to check eligibility</div>`;
      actionLine = `<button disabled style="font-size:11px;">connect wallet</button>`;
    } else if (!eligibleRow) {
      amountLine = `<div class="muted" style="font-size:11px;">not eligible (your address not in this drop)</div>`;
      actionLine = `<button disabled style="font-size:11px;">not eligible</button>`;
    } else {
      amountLine = `<div style="font-size:13px;color:var(--green);"><strong>✓ ${escapeHtml(fmtAssetAmountPlain(eligibleRow.amount, decimals))} ${escapeHtml(ticker)}</strong> <span class="muted">· leaf #${eligibleRow.index}</span></div>`;
      actionLine = `<button data-act="claim-discover-pick" data-root="${escapeHtml(d.merkle_root)}" data-cid="${escapeHtml(d.ipfs_cid)}" class="primary" style="font-size:11px;">Claim →</button>`;
    }
    const noteLine = d.note
      ? `<div class="muted" style="font-size:11px;margin-top:4px;font-style:italic;">"${escapeHtml(d.note)}"</div>`
      : '';
    const selfAnnouncedHint = (provenance === 'self_announced')
      ? `<div class="muted" style="font-size:10px;margin-top:4px;">announcer ${escapeHtml(issuerShort)} is not the asset's etcher — verify the drop is legit before claiming</div>`
      : '';
    return `
      <div class="card" style="margin-bottom:8px;padding:12px;border:1px solid var(--ink);background:var(--bg);">
        <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <div style="min-width:0;flex:1;">
            <strong>${escapeHtml(ticker)}</strong>
            ${provBadge}
            <span class="muted" style="font-size:11px;"> · root <code>${escapeHtml(shorten(d.merkle_root, 10))}</code> · expires ${expIso}</span>
          </div>
          <div>${actionLine}</div>
        </div>
        <div style="margin-top:6px;">${amountLine}</div>
        ${noteLine}
        ${selfAnnouncedHint}
      </div>
    `;
  }).join('');

  list.querySelectorAll('button[data-act="claim-discover-pick"]').forEach(btn => {
    btn.onclick = () => {
      const rEl = $('#claim-root');
      const cEl = $('#claim-cid');
      if (rEl) rEl.value = btn.dataset.root;
      if (cEl) cEl.value = btn.dataset.cid;
      const m = $('#claim-manual-entry');
      if (m) m.open = true;
      $('#btn-claim-load')?.click();
    };
  });
}

function refreshClaimTab() {
  _renderClaimTacitId();
  _renderClaimSnapshotInfo();
  _claimRefreshDiscover();
  // Silent MetaMask reconnect: if the user previously authorized this origin,
  // their connected address is restored without a prompt. Followed by a render
  // pass so the eligibility section reflects the recovered state.
  _claimAutoConnect().then(() => {
    _renderClaimEligibility();
    _renderClaimMsgPreview();
    _refreshClaimSignAvailability();
    // Re-render the discover list so eligibility flags pick up the recovered ETH address.
    _renderClaimDiscoverList();
  });
  _renderClaimEligibility();
  _renderClaimMsgPreview();
  _renderClaimResult();
}

function setupClaimTab() {
  $('#btn-claim-load')?.addEventListener('click', async () => {
    const errEl = $('#claim-load-err');
    if (errEl) errEl.textContent = '';
    const root = $('#claim-root').value;
    const cid = $('#claim-cid').value;
    const btn = $('#btn-claim-load');
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'fetching…';
    try {
      await _claimLoadSnapshot(root, cid);
      _renderClaimSnapshotInfo();
      _renderClaimEligibility();
      _renderClaimMsgPreview();
      _refreshClaimSignAvailability();
      _renderClaimResult();
      toast(`Snapshot loaded · ${_claimSnapshot.leaf_count || _claimSnapshot.rows.length} recipients`, 'success');
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
      _claimSnapshot = null;
      _renderClaimSnapshotInfo();
      _renderClaimEligibility();
      _refreshClaimSignAvailability();
      _renderClaimResult();
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  $('#btn-claim-clear')?.addEventListener('click', () => {
    _claimSnapshot = null; _claimEligibleRow = null; _claimSigned = null;
    $('#claim-root').value = '';
    $('#claim-cid').value = '';
    const t = $('#claim-json-text'); if (t) t.value = '';
    $('#claim-load-err').textContent = '';
    refreshClaimTab();
  });

  // Raw-snapshot paste / upload fallback. Reuses the same root-recompute
  // validation as the IPFS path so a malicious paste can't substitute rows.
  const _loadClaimJSON = (text) => {
    const errEl = $('#claim-load-err');
    if (errEl) errEl.textContent = '';
    try {
      const root = $('#claim-root').value;
      _claimLoadSnapshotFromJSON(root, text);
      _renderClaimSnapshotInfo();
      _renderClaimEligibility();
      _renderClaimMsgPreview();
      _refreshClaimSignAvailability();
      _renderClaimResult();
      toast(`Snapshot loaded · ${_claimSnapshot.leaf_count || _claimSnapshot.rows.length} recipients`, 'success');
    } catch (e) {
      if (errEl) errEl.textContent = e.message;
      _claimSnapshot = null;
      _renderClaimSnapshotInfo();
      _renderClaimEligibility();
      _refreshClaimSignAvailability();
      _renderClaimResult();
    }
  };
  $('#btn-claim-json-load')?.addEventListener('click', () => {
    const text = $('#claim-json-text')?.value || '';
    if (!text.trim()) { $('#claim-load-err').textContent = 'paste snapshot JSON first'; return; }
    _loadClaimJSON(text);
  });
  $('#btn-claim-json-upload')?.addEventListener('click', () => $('#claim-json-file').click());
  $('#claim-json-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const t = $('#claim-json-text'); if (t) t.value = text;
      _loadClaimJSON(text);
    } catch (err) {
      $('#claim-load-err').textContent = 'file read failed: ' + err.message;
    } finally {
      e.target.value = '';
    }
  });

  $('#btn-claim-connect-mm')?.addEventListener('click', async () => {
    const btn = $('#btn-claim-connect-mm');
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'connecting…';
    try {
      await _claimConnectMetaMask();
      _renderClaimEligibility();
      _renderClaimMsgPreview();
      _refreshClaimSignAvailability();
      // Re-render the discovery list so eligibility flags fill in for any
      // already-fetched snapshots without a network round-trip.
      _renderClaimDiscoverList();
    } catch (e) {
      // User-cancelled paths are intentional, not errors: dismissing the
      // EIP-6963 chooser ('no wallet selected') and rejecting MetaMask's
      // eth_requestAccounts prompt (EIP-1193 code 4001 / "user rejected").
      // Suppress the toast in those cases — the button just resets.
      const userCancelled = e?.code === 4001
        || e?.message === 'no wallet selected'
        || /user rejected/i.test(e?.message || '');
      if (!userCancelled) {
        toast('Ethereum wallet connect failed: ' + e.message, 'error');
        console.error(e);
      }
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  $('#btn-claim-discover-refresh')?.addEventListener('click', () => {
    // Force re-fetch by clearing the per-root snapshot cache.
    _claimDiscoverSnapshots.clear();
    _claimRefreshDiscover();
  });

  $('#btn-claim-sign')?.addEventListener('click', async () => {
    const btn = $('#btn-claim-sign');
    const errEl = $('#claim-sign-err');
    if (errEl) errEl.textContent = '';
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'awaiting MetaMask…';
    try {
      await _claimSign();
      _renderClaimResult();
      toast('Claim signed', 'success');
    } catch (e) {
      // EIP-1193 code 4001 (user rejected) and the textual variant aren't
      // errors — they're the user changing their mind. Mirror the connect-
      // flow suppression so the inline error doesn't sit there shouting.
      const userCancelled = e?.code === 4001 || /user rejected/i.test(e?.message || '');
      if (!userCancelled) {
        if (errEl) errEl.textContent = e.message;
        console.error(e);
      }
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  // Legacy fallback listener on window.ethereum for wallets that don't
  // announce via EIP-6963. The post-EIP-6963 path re-binds an equivalent
  // listener on the selected provider inside `_claimConnectMetaMask`, guarded
  // by `_tacitAccountsBound` so we don't double-fire.
  if (window.ethereum?.on && !window.ethereum._tacitAccountsBound) {
    window.ethereum._tacitAccountsBound = true;
    window.ethereum.on('accountsChanged', accounts => {
      if (Array.isArray(accounts) && accounts.length > 0) {
        _claimEthAddr = String(accounts[0]).toLowerCase().replace(/^0x/, '');
      } else {
        _claimEthAddr = null;
      }
      _claimSigned = null;
      _renderClaimEligibility();
      _renderClaimMsgPreview();
      _renderClaimResult();
      _renderClaimDiscoverList();
    });
  }
}

function parseAssetAmount(input, decimals) {
  // Strip thousands separators and whitespace so a user pasting a localized
  // balance ("21,000,000.5") parses the same as a raw value ("21000000.5").
  const s = input.trim().replace(/[\s,]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${input}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`amount has too many decimals (max ${decimals})`);
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * (10n ** BigInt(decimals)) + (padded ? BigInt(padded) : 0n);
}

// ============== HOLDINGS UI ==============
async function renderHoldings() {
  const list = $('#holdings-list');
  setStatus('#holdings-status', 'scanning', true);
  list.innerHTML = '<div class="skeleton"><div class="skeleton-row medium"></div><div class="skeleton-row short"></div><div class="skeleton-row"></div></div>';
  try {
    const holdings = await scanHoldings();
    const arr = [...holdings.values()].sort((a, b) => Number(b.balance - a.balance));
    if (!arr.length) {
      // Funding hint is network-aware: faucet on signet, send-to-address
      // (or connect-and-fund) on mainnet. The protocol flow is otherwise
      // identical, but the funding path differs sharply.
      const fundingHint = NET.name === 'signet'
        ? `Hit the <strong>faucet</strong> for some signet sats, then go to <strong>Etch</strong> to mint your first token`
        : `Fund your wallet (connect Xverse / UniSat / Leather, or send sats to your address from any Bitcoin wallet) and head to <strong>Etch</strong> to mint your first token`;
      list.innerHTML = `<div class="empty">No tacit assets on ${escapeHtml(NET.name)} yet. ${fundingHint} — or paste a share-link below if someone sent you one.</div>`;
      setStatus('#holdings-status', '');
      setTabBadge('holdings', 0);
      return;
    }
    list.innerHTML = '';
    const ownerPubHex = bytesToHex(wallet.pub);
    // Render helpers — used by the initial skeleton AND by the per-asset
    // enrichment that updates [data-region] markers in place once each card's
    // 4 fetches resolve. Pure functions of arguments so call-sites stay
    // declarative and the same HTML is produced however we get the data.
    const avatarHTML = (url) => url
      ? `<img loading="lazy" decoding="async" src="${escapeHtml(url)}" alt="" style="width:40px;height:40px;border:1px solid var(--ink);object-fit:cover;background:#fff;flex-shrink:0;">`
      : '';
    const tickerSubHTML = (displayName, ticker) => displayName !== ticker
      ? `<span class="ticker-sub">${escapeHtml(ticker)}</span>`
      : '';
    const descriptionHTML = (extras) => extras?.description
      ? `<div class="muted" style="margin-top:10px;font-size:11px;font-style:italic;">${escapeHtml(extras.description)}</div>`
      : '';
    const externalUrlHTML = (extras) => {
      const safe = safeExternalUrl(extras?.external_url);
      return safe ? `<div style="margin-top:6px;font-size:11px;"><a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safe)} ↗</a></div>` : '';
    };
    const verifiedTagHTML = (myPublishedCount, totalUtxos) => myPublishedCount > 0
      ? `<span class="unit" style="color:#0a8f43;">✓ ${myPublishedCount === totalUtxos ? 'verified' : `${myPublishedCount}/${totalUtxos} verified`}</span>`
      : '';
    const metaPublishedHTML = (myPublishedCount) => myPublishedCount > 0
      ? ` · <span style="color:#0a8f43;">${myPublishedCount} published</span>`
      : '';
    const metaAssetWidePublishedHTML = (totalPublishedCount, myPublishedCount) =>
      totalPublishedCount > myPublishedCount
        ? ` · <span class="muted">${totalPublishedCount} openings published asset-wide</span>`
        : '';
    const renderClaim = (claim) => claim
      ? `<div style="margin-top:2px;color:#a04030;font-size:10px;">⏱ reserved by taker ${escapeHtml(shorten(claim.taker_pubkey, 6))} until ${new Date(claim.expires_at * 1000).toLocaleTimeString()} — they intend to pay; deliver via Send Privately when payment arrives</div>`
      : '';
    const myListingsHTML = (h, allListings, allRangeListings) => {
      const myListings = allListings.filter(l => l.owner_pubkey === ownerPubHex && !l.expired);
      const myRangeListings = allRangeListings.filter(l => l.owner_pubkey === ownerPubHex && !l.expired);
      if (!myListings.length && !myRangeListings.length) return '';
      return `
        <div style="margin-top:10px;padding:8px 10px;border:1px solid var(--ink);background:#f6f1e7;font-size:11px;">
          <strong>Your active listing${(myListings.length + myRangeListings.length)>1?'s':''}:</strong>
          ${myListings.map(l => `
            <div style="margin-top:4px;">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                <span>${escapeHtml(fmtAssetAmount(BigInt(l.amount), h.decimals))} (UTXO opening) for <strong>${l.price_sats.toLocaleString()} sats</strong> · expires ${new Date(l.expiry * 1000).toISOString().slice(0,10)}</span>
                <button data-act="cancel-listing" data-aid="${h.assetIdHex}" data-txid="${escapeHtml(l.txid)}" data-vout="${l.vout}" style="padding:2px 8px;font-size:10px;">Cancel</button>
              </div>
              ${renderClaim(l.claim)}
            </div>`).join('')}
          ${myRangeListings.map(l => `
            <div style="margin-top:4px;">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                <span>≥ ${escapeHtml(fmtAssetAmount(BigInt(l.threshold), h.decimals))} (range-disclosed) for <strong>${l.price_sats.toLocaleString()} sats</strong> · expires ${new Date(l.expiry * 1000).toISOString().slice(0,10)}</span>
                <button data-act="cancel-range-listing" data-aid="${h.assetIdHex}" style="padding:2px 8px;font-size:10px;">Cancel</button>
              </div>
              ${renderClaim(l.claim)}
            </div>`).join('')}
        </div>
      `;
    };
    // Skeleton render: paint cards immediately with everything derivable from
    // scanHoldings + sync caches (getAssetMeta, getMetadataExtras). The four
    // fetch-dependent regions (avatar, balance verified tag, meta published
    // counts, my-listings block) start empty and are filled by per-asset
    // enrichment below — no all-or-nothing wait for the slowest of 4N fetches.
    // DocumentFragment: build all cards then attach in one reflow rather
    // than one reflow per card. Bigger win on wallets with many assets.
    const frag = document.createDocumentFragment();
    const cardNodes = [];
    for (const h of arr) {
      const card = document.createElement('div');
      card.className = 'asset-card';
      // Stamp identity + numeric balance on the card root so
      // applyOptimisticDebit() can locate this card and update its display
      // immediately after a successful broadcast (bridges the 1-2s gap
      // before the next chain rescan reconciles).
      card.dataset.aid = h.assetIdHex;
      card.dataset.baseAmount = h.balance.toString();
      card.dataset.decimals = String(h.decimals);
      const meta = getAssetMeta(h.assetIdHex);
      const etchLink = meta?.etchTxid ? `${NET.explorer}/tx/${meta.etchTxid}` : '#';
      // getMetadataExtras hydrates the persistent _metadataExtraCache on first
      // call, so warm-cache loads paint with the canonical name immediately.
      // Cold-cache: extras=null → falls back to ticker, then enrichment swaps
      // in the canonical name/description once resolveImageUri completes.
      const extras = meta?.imageUri ? getMetadataExtras(meta.imageUri) : null;
      const displayName = (extras?.name && extras.name.trim()) ? extras.name : h.ticker;
      // Audit fix A: surface T_PETCH-rooted assets distinctly in the
      // Holdings card. Different trust model from CETCH (cumulative supply
      // is publicly observable, no mint authority, anyone can mint) — SPEC
      // §5.8 says wallets SHOULD surface this distinction. The badge mirrors
      // the one on the Discover petch tile so users see the same visual
      // identity end-to-end. meta.kind is set by registerAsset in
      // buildAndBroadcastPetch / buildAndBroadcastPmint (and by the
      // metadataOut path in validateOutpoint's T_PMINT branch).
      const isPetchRooted = meta?.kind === 'petch';
      const petchBadgeHTML = isPetchRooted
        ? `<span style="display:inline-block;padding:1px 6px;background:#7d4ff7;color:#fff;font-size:9px;border-radius:2px;margin-left:6px;cursor:help;" title="Permissionless fair-launch (SPEC §5.8 / §5.9). Cumulative supply is publicly observable; per-mint amount is fixed at deploy. No mint authority — anyone can mint until the cap fills.">⚡ public mint</span>`
        : '';
      // Per-asset action grouping. Primary actions (Send / Receive) sit on top
      // for the everyday holder. Disclosure (reveal supply / mints, publish
      // balance, prove ≥ X) and Marketplace (List for sale) live behind their
      // own collapsible sections so the card stays scannable. Burn —
      // irreversible — gets its own Danger zone.
      const isMintAuthority = meta?.mintable && meta?.mintAuthorityHex === bytesToHex(wallet.xonly());
      const canMarket = WORKER_BASE && h.utxos.length && !h.unknownAsset;
      const primaryButtons = [
        h.balance > 0n && !h.unknownAsset ? `<button class="primary" data-act="send" data-aid="${h.assetIdHex}">Send privately</button>` : '',
        !h.unknownAsset ? `<button data-act="show-receive" data-aid="${h.assetIdHex}">Receive</button>` : '',
        isMintAuthority ? `<button data-act="mint" data-aid="${h.assetIdHex}">Mint more</button>` : '',
      ].filter(Boolean).join('');
      const discloseButtons = [
        h.isEtcher && WORKER_BASE ? `<button data-act="reveal-supply" data-aid="${h.assetIdHex}">Reveal initial supply</button>` : '',
        h.myMints?.length && WORKER_BASE ? `<button data-act="reveal-mints" data-aid="${h.assetIdHex}">Reveal ${h.myMints.length} mint${h.myMints.length>1?'s':''}</button>` : '',
        h.utxos.length && !h.unknownAsset && WORKER_BASE ? `<button data-act="publish-balance" data-aid="${h.assetIdHex}">Publish balance (${h.utxos.length} UTXO${h.utxos.length>1?'s':''})</button>` : '',
        h.balance > 0n && !h.unknownAsset && WORKER_BASE ? `<button data-act="prove-balance" data-aid="${h.assetIdHex}">Prove ≥ threshold</button>` : '',
      ].filter(Boolean).join('');
      const marketButtons = canMarket
        ? `<button data-act="list-sale" data-aid="${h.assetIdHex}">List a UTXO for sale</button>` +
          `<button data-act="list-range" data-aid="${h.assetIdHex}">List (hidden balance)</button>` +
          `<button data-act="list-atomic" data-aid="${h.assetIdHex}">Atomic (targeted)</button>` +
          `<button data-act="publish-intent" data-aid="${h.assetIdHex}">Atomic intent (open)</button>`
        : '';
      const dangerButtons = h.balance > 0n && !h.unknownAsset ? `<button class="danger" data-act="burn" data-aid="${h.assetIdHex}">Burn</button>` : '';

      // [data-region] markers wrap the data-fetch-dependent regions so the
      // enrichment phase can update them in place without re-rendering the
      // whole card (which would lose any open inline-form / receive panel).
      // The avatar wrapper uses display:contents so an empty span doesn't
      // contribute a flex item / gap before the image lands.
      card.innerHTML = `
        <div class="head" style="display:flex;align-items:center;gap:12px;">
          <span data-region="avatar" style="display:contents;">${avatarHTML(null)}</span>
          <div style="flex:1;min-width:0;">
            <div class="ticker"><span data-region="display-name">${escapeHtml(displayName)}</span>${petchBadgeHTML}<span data-region="ticker-sub">${tickerSubHTML(displayName, h.ticker)}</span><span class="id-tag" data-act="copy-aid" data-aid="${h.assetIdHex}" title="Copy asset ID">${escapeHtml(shorten(h.assetIdHex, 4))}</span></div>
            <div class="balance">${fmtAssetAmount(h.balance, h.decimals)}<span class="unit">${h.unknownAsset ? 'unknown asset' : 'confidential'}</span><span data-region="verified-tag"></span></div>
          </div>
        </div>
        <div class="meta">
          <div><span class="lbl">Asset ID</span> ${assetIdRowHTML(h.assetIdHex)}</div>
          <div><span class="lbl">Decimals</span> ${h.decimals}</div>
          <div><span class="lbl">UTXOs</span> ${h.utxos.length} known${h.ghosts.length ? ` · <span style="color:var(--red);">${h.ghosts.length} ghost</span>` : ''}<span data-region="meta-published"></span></div>
          <div><span class="lbl">Etch tx</span> ${meta?.etchTxid ? `<a href="${escapeHtml(etchLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shorten(meta.etchTxid, 8))} ↗</a>` : '—'}<span data-region="meta-asset-wide-published"></span></div>
          ${isPetchRooted && meta?.capAmount && meta?.mintLimit ? `<div><span class="lbl">Cap</span> ${escapeHtml(fmtAssetAmount(BigInt(meta.capAmount), h.decimals))} ${escapeHtml(h.ticker)} · per mint ${escapeHtml(fmtAssetAmount(BigInt(meta.mintLimit), h.decimals))}</div>` : ''}
        </div>
        ${isPetchRooted ? `<div class="muted" style="margin-top:6px;font-size:10px;line-height:1.5;">Permissionless fair-launch — cumulative supply is publicly observable from chain alone. <strong>This is a deliberate trade-off vs. confidential CETCH supply.</strong> Per-holder balances stay confidential after the first transfer.</div>` : ''}
        <div data-region="description">${descriptionHTML(extras)}</div>
        <div data-region="external-url">${externalUrlHTML(extras)}</div>
        ${h.ghosts.length ? `<div class="warn" style="margin-top:10px;font-size:11px;">⚠ ${h.ghosts.length} UTXO${h.ghosts.length>1?'s':''} hold commitments this wallet can't open. Try ↻ Rescan, or import a share-link for legacy/incompatible sends.</div>` : ''}
        ${h.pending && h.pending.length ? (() => {
          // Pending T_PMINT mints split into two sub-states with different
          // user-facing copy: (a) unconfirmed — still in mempool, no block
          // height; (b) confirmed at depth < 3 (or worker hasn't yet credited
          // it). Same h.pending bucket but the wait-for is different, so the
          // banner reads accurately for each. SPEC §5.9 *Confirmation depth*.
          const total = h.pending.reduce((s, p) => s + p.amount, 0n);
          const unconfirmed = h.pending.filter(p => !p.utxo?.status?.confirmed).length;
          const confirmed = h.pending.length - unconfirmed;
          const totalStr = `${escapeHtml(fmtAssetAmount(total, h.decimals))} ${escapeHtml(h.ticker)}`;
          const n = h.pending.length, plural = n > 1 ? 's' : '';
          let detail;
          if (unconfirmed === n) detail = 'broadcast · awaiting block confirmation';
          else if (confirmed === n) detail = 'confirmed · awaiting ≥3 confs for cap credit (SPEC §5.9)';
          else detail = `${unconfirmed} unconfirmed · ${confirmed} awaiting ≥3 confs (SPEC §5.9)`;
          return `<div style="margin-top:10px;padding:8px 10px;font-size:11px;border:1px dashed #7d4ff7;background:#f5f1ff;color:#5a36c4;"><strong>⏳ ${n} mint${plural} pending cap-credit:</strong> ${totalStr} — ${detail}. Spendable once credited; ↻ Rescan in a few minutes.</div>`;
        })() : ''}
        ${h.inflated && h.inflated.length ? (() => {
          // Distinguish T_PMINT failures (no rangeproof — failure is cap
          // overflow, asset_id forgery, or wrong amount) from CETCH/CXFER
          // rangeproof failures so the warning copy matches the actual issue.
          // Generic "invalid rangeproofs" was technically incorrect for petch-
          // rooted UTXOs, which carry public (amount, blinding) and never have
          // a rangeproof to fail.
          const reason = isPetchRooted
            ? 'failed cap-credit or §5.9 validation (envelope decoded but not creditable — e.g. cap-overflow or wrong amount)'
            : 'have invalid rangeproofs';
          return `<div class="warn" style="margin-top:10px;font-size:11px;background:#fee;border-left-color:var(--red);"><strong>⚠ Inflation attempt detected:</strong> ${h.inflated.length} UTXO${h.inflated.length>1?'s':''} ${reason}. These are not counted in your balance.</div>`;
        })() : ''}
        <div data-region="my-listings"></div>
        ${primaryButtons ? `<div class="actions">${primaryButtons}</div>` : ''}
        <div data-receive-panel="${h.assetIdHex}" style="display:none;margin-top:10px;padding:10px 12px;background:var(--bg-warm);border:1px dashed var(--ink-faint);font-size:11px;">
          <strong>Your tacit pubkey</strong>
          <div class="muted" style="margin-top:4px;">Share this with senders so they can transfer ${escapeHtml(h.ticker)} to you. They paste it on the Send tab.</div>
          <div class="mono-box" style="margin-top:6px;font-size:10px;">${escapeHtml(wallet.pubHex())}</div>
          <div class="flex" style="margin-top:8px;">
            <button data-act="copy-pub" data-aid="${h.assetIdHex}" style="padding:2px 8px;font-size:10px;">Copy pubkey</button>
            <button data-act="hide-receive" data-aid="${h.assetIdHex}" style="padding:2px 8px;font-size:10px;">Close</button>
          </div>
        </div>
        ${discloseButtons ? `
          <details class="actions-group">
            <summary><span class="arrow">▸</span>Disclose · make verifiable</summary>
            <div class="group-body">
              <div class="group-blurb">Optional public attestations — pin a UTXO's amount + blinding factor so anyone can cryptographically verify it against the on-chain commitment. Permanent: published openings cannot be unpublished.</div>
              ${discloseButtons}
            </div>
          </details>` : ''}
        ${marketButtons ? `
          <details class="actions-group">
            <summary><span class="arrow">▸</span>Marketplace · list a UTXO</summary>
            <div class="group-body">
              <div class="group-blurb">Pin a signed offer to the worker. Settlement is OFF-CHAIN: a taker pays sats to your address, then you broadcast a CXFER to them. Your exact UTXO balance becomes public when listed.</div>
              ${marketButtons}
              <div data-list-form="${h.assetIdHex}" style="display:none;width:100%;"></div>
            </div>
          </details>` : ''}
        ${dangerButtons ? `
          <details class="actions-group">
            <summary><span class="arrow">▸</span>Danger · destroy supply</summary>
            <div class="group-body">
              <div class="group-blurb">Burning destroys part of your balance permanently. The burn amount is public and auditable on chain.</div>
              ${dangerButtons}
            </div>
          </details>` : ''}
      `;
      frag.appendChild(card);
      cardNodes.push(card);
    }
    list.appendChild(frag);
    // Asset-id short / full toggle.
    wireAssetIdToggles(list);
    // Click ticker id-tag to copy the asset_id without expanding.
    list.querySelectorAll('span[data-act="copy-aid"]').forEach(el => {
      el.onclick = async () => {
        try { await navigator.clipboard.writeText(el.dataset.aid); toast('Asset ID copied', 'success'); }
        catch { /* clipboard blocked; let the user expand and select instead */ }
      };
    });
    // Per-button handler factory. Extracted from the previous inline forEach
    // so the per-asset enrichment can re-run it on cancel-* buttons that the
    // my-listings region adds after its data fetch resolves. Idempotent —
    // overwrites onclick on already-wired buttons.
    const wireBtn = (b) => {
      b.onclick = async () => {
        if (b.dataset.act === 'send') {
          $('#x-asset').value = b.dataset.aid;
          $('.tab[data-tab="transfer"]').click();
          refreshAssetSelect().then(() => $('#x-asset').value = b.dataset.aid);
        } else if (b.dataset.act === 'show-receive') {
          const aid = b.dataset.aid;
          const panel = list.querySelector(`[data-receive-panel="${aid}"]`);
          if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        } else if (b.dataset.act === 'hide-receive') {
          const aid = b.dataset.aid;
          const panel = list.querySelector(`[data-receive-panel="${aid}"]`);
          if (panel) panel.style.display = 'none';
        } else if (b.dataset.act === 'copy-pub') {
          try { await navigator.clipboard.writeText(wallet.pubHex()); toast('Pubkey copied', 'success'); }
          catch { toast('Could not copy — select the text manually', 'error'); }
        } else if (b.dataset.act === 'burn') {
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target) return;
          const balanceDisp = fmtAssetAmount(target.balance, target.decimals);
          openInlineForm(b, {
            submitLabel: 'Burn permanently',
            submitClass: 'danger',
            content: `
              <label>Amount to burn (display units)</label>
              <input type="text" inputmode="decimal" data-field="amount" placeholder="e.g. 10 or 10.5">
              <div class="muted" style="margin-top:6px;font-size:11px;">
                Balance: <strong>${escapeHtml(balanceDisp)}</strong> ${escapeHtml(target.ticker)}
                · <a href="#" data-fill="max">use max</a>
              </div>
              <div class="muted" style="margin-top:8px;font-size:11px;color:var(--red);">
                ⚠ Irreversible. The burned amount is public on chain.
              </div>
              ${PROGRESS_STRIP_HTML}`,
            onSubmit: async ({ host, errEl }) => {
              const raw = host.querySelector('[data-field="amount"]').value.trim();
              if (!raw) { errEl.textContent = 'enter an amount'; return false; }
              let burnBase;
              try { burnBase = parseAssetAmount(raw, target.decimals); }
              catch (e) { errEl.textContent = 'parse error: ' + e.message; return false; }
              if (burnBase <= 0n || burnBase > target.balance) { errEl.textContent = 'amount out of range'; return false; }
              if (!ensureBurnerBackedUp(`Burn ${target.ticker} (change UTXO is owned by the burner)`)) {
                errEl.textContent = 'Back up the in-page privkey first, then retry.'; return false;
              }
              const need = await estimateSatsForOp('burn');
              if (!(await ensureSatsFunded(need, 'Burning'))) { errEl.textContent = 'Funding cancelled.'; return false; }
              const strip = host.querySelector('.progress-strip');
              if (strip) strip.style.display = 'flex';
              setProgressStrip(strip, 0);
              try {
                const r = await buildAndBroadcastCBurn({
                  assetIdHex: aid, amount: burnBase,
                  onProgress: (stage) => {
                    if (stage === 'commit-start') setProgressStrip(strip, 1);
                    else if (stage === 'reveal-start') setProgressStrip(strip, 2);
                  },
                });
                setProgressStrip(strip, 4);
                // Burn reduces balance just like send — apply the same
                // optimistic debit so the holdings card reflects it before
                // renderHoldings() reconciles from chain.
                applyOptimisticDebit(aid, burnBase);
                toast(`Burned ${fmtAssetAmount(burnBase, target.decimals)} ${target.ticker} · reveal=${shorten(r.revealTxid, 6)}`, 'success');
                renderHoldings(); renderActivity();
              } catch (e) {
                if (strip) {
                  const a = strip.querySelector('.progress-step.active');
                  const idx = a ? Number(a.dataset.step) : -1;
                  if (idx >= 0) setProgressStrip(strip, -1, { errorAt: idx });
                }
                throw e;
              }
            },
          });
          // Wire "use max" link in the just-mounted form
          const formHost = b.nextElementSibling;
          if (formHost?.classList.contains('inline-form-host')) {
            const maxLink = formHost.querySelector('[data-fill="max"]');
            const amtInput = formHost.querySelector('[data-field="amount"]');
            if (maxLink && amtInput) {
              maxLink.onclick = (e) => { e.preventDefault(); amtInput.value = balanceDisp; amtInput.focus(); };
            }
          }
        } else if (b.dataset.act === 'mint') {
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          const meta = getAssetMeta(aid);
          if (!meta?.etchTxid) { toast('Missing etch_txid for asset (rescan?)', 'error'); return; }
          const tickerSafe = escapeHtml(target.ticker);
          const handle = openInlineForm(b, {
            submitLabel: 'Mint',
            content: `
              <label>Amount to mint (display units)</label>
              <input type="text" inputmode="decimal" data-field="amount" placeholder="e.g. 1000">
              <div data-mint-warn class="muted" style="margin-top:4px;font-size:11px;color:var(--orange);display:none;"></div>

              <div data-mint-preview style="display:none;margin-top:14px;padding:10px 12px;background:var(--bg-warm);border:1px dashed var(--ink-faint);font-size:11px;line-height:1.6;">
                <div data-mint-impact></div>
                <div data-mint-fee class="muted" style="margin-top:4px;"></div>
                <div style="color:var(--red);margin-top:8px;font-weight:500;">⚠ Minting is irreversible. Once broadcast, the new supply exists on-chain forever — it can only be burned, never unminted.</div>
              </div>

              <label class="checkbox-row" style="margin-top:10px;">
                <input type="checkbox" data-field="confirm">
                <span class="cbx-body" style="font-size:11px;">I understand this mint is irreversible.</span>
              </label>

              <div class="muted" style="margin-top:6px;font-size:10px;">
                You hold the mint authority for <strong>${tickerSafe}</strong>. Each mint emits a new T_MINT envelope; per-mint amount is bounded to 2⁶⁴ base units by the rangeproof.
              </div>
              ${PROGRESS_STRIP_HTML}`,
            onSubmit: async ({ host, errEl }) => {
              const raw = host.querySelector('[data-field="amount"]').value.trim();
              const confirmed = host.querySelector('[data-field="confirm"]').checked;
              if (!confirmed) { errEl.textContent = 'check the irreversibility box first'; return false; }
              if (!raw) { errEl.textContent = 'enter an amount'; return false; }
              let mintBase;
              try { mintBase = parseAssetAmount(raw, target.decimals); }
              catch (e) { errEl.textContent = 'parse error: ' + e.message; return false; }
              if (mintBase <= 0n || mintBase >= (1n << BigInt(N_BITS))) { errEl.textContent = 'amount out of range'; return false; }
              if (!ensureBurnerBackedUp(`Mint additional ${target.ticker} (mint authority is the local burner key)`)) {
                errEl.textContent = 'Back up the in-page privkey first, then retry.'; return false;
              }
              const need = await estimateSatsForOp('mint');
              if (!(await ensureSatsFunded(need, 'Minting'))) { errEl.textContent = 'Funding cancelled.'; return false; }
              const strip = host.querySelector('.progress-strip');
              if (strip) strip.style.display = 'flex';
              setProgressStrip(strip, 0);
              let r;
              try {
                r = await buildAndBroadcastCMint({
                  assetIdHex: aid, etchTxidHex: meta.etchTxid, amount: mintBase,
                  onProgress: (stage) => {
                    if (stage === 'commit-start') setProgressStrip(strip, 1);
                    else if (stage === 'reveal-start') setProgressStrip(strip, 2);
                  },
                });
                setProgressStrip(strip, 4);
              } catch (e) {
                if (strip) {
                  const a = strip.querySelector('.progress-step.active');
                  const idx = a ? Number(a.dataset.step) : -1;
                  if (idx >= 0) setProgressStrip(strip, -1, { errorAt: idx });
                }
                throw e;
              }
              toast(`Minted ${fmtAssetAmount(mintBase, target.decimals)} ${target.ticker} · reveal=${shorten(r.revealTxid, 6)}`, 'success');
              postHint(r.revealTxid, 0);
              // Auto-attest the mint by default. A mintable asset whose etch
              // was attested but whose subsequent mints are NOT attested is
              // exactly the supply-trust loophole #3 from the production
              // review — the holder sees "K verified mints + N unattested"
              // and can't bound the actual supply. Auto-attesting closes
              // that loophole. Issuer can disable per-asset by setting
              // `tacit-skip-mint-attest:<asset_id>` in localStorage (no UI
              // for it yet — power-user only).
              const skipKey = `tacit-skip-mint-attest:${aid}`;
              const optedOut = localStorage.getItem(skipKey) === '1';
              if (!optedOut && WORKER_BASE) {
                fetch(withNet(MINT_ATTEST_URL(aid, r.revealTxid)), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    supply: r.mintAmount.toString(),
                    blinding: bytesToHex(bigintToBytes32(r.mintBlinding)),
                  }),
                }).then(async resp => {
                  const j = await resp.json().catch(() => ({}));
                  if (resp.ok) toast('Mint opening published ✓', 'success');
                  else toast('Mint succeeded but attestation failed: ' + (j.error || resp.status) + '. Try Reveal mints on the Holdings card.', 'error');
                }).catch(e => toast('Mint attestation request failed: ' + e.message, 'error'));
              }
              renderHoldings(); renderActivity();
              // Send-tab dropdown shows balance-after-mint; refresh so a user
              // who toggles to Send right after minting sees the new total.
              if (typeof refreshAssetSelect === 'function') refreshAssetSelect();
            },
          });
          // Live validation + impact preview. Wired after openInlineForm returns
          // so we can grab the rendered DOM. Mirrors the transfer-form pattern:
          // truncate excess decimals on the fly, render an impact card, gate
          // the submit button on (valid amount && irreversibility checkbox).
          if (handle) {
            const amountInput = handle.host.querySelector('[data-field="amount"]');
            const confirmInput = handle.host.querySelector('[data-field="confirm"]');
            const submitBtn = handle.host.querySelector('[data-form-act="submit"]');
            const warnEl = handle.host.querySelector('[data-mint-warn]');
            const previewEl = handle.host.querySelector('[data-mint-preview]');
            const impactEl = handle.host.querySelector('[data-mint-impact]');
            const feeEl = handle.host.querySelector('[data-mint-fee]');
            let cachedFeeRate = null;
            const updateMintPreview = async () => {
              const raw = amountInput.value;
              // Live decimal truncation (same helper the transfer form uses).
              const { trimmed, dropped } = truncateAmountToDecimals(raw, target.decimals);
              if (trimmed !== null) {
                amountInput.value = trimmed;
                warnEl.textContent = `Trimmed to ${target.decimals} decimals · dropped 0.${'0'.repeat(target.decimals)}${dropped}`;
                warnEl.style.display = '';
              } else {
                warnEl.textContent = '';
                warnEl.style.display = 'none';
              }
              let mintBase = null;
              try { mintBase = parseAssetAmount(amountInput.value.trim(), target.decimals); }
              catch { /* invalid → preview hidden */ }
              const validAmount = mintBase !== null && mintBase > 0n && mintBase < (1n << BigInt(N_BITS));
              if (validAmount) {
                const newBalance = (target.balance || 0n) + mintBase;
                impactEl.innerHTML =
                  `Adding <strong>${escapeHtml(fmtAssetAmount(mintBase, target.decimals))} ${tickerSafe}</strong> to circulating supply.<br>` +
                  `Your balance: ${escapeHtml(fmtAssetAmount(target.balance || 0n, target.decimals))} → <strong>${escapeHtml(fmtAssetAmount(newBalance, target.decimals))}</strong>`;
                if (cachedFeeRate == null) {
                  try { cachedFeeRate = await getFeeRate(); } catch { cachedFeeRate = 2; }
                }
                const revealFee = feeFor(estCMintRevealVb(), cachedFeeRate);
                const commitFee = feeFor(estCommitVb(1), cachedFeeRate);
                const total = commitFee + revealFee;
                feeEl.textContent = `Estimated network fee: ~${total.toLocaleString('en-US')} sats (commit ~${commitFee} + reveal ~${revealFee}) @ ${cachedFeeRate} sat/vB`;
                previewEl.style.display = '';
                submitBtn.textContent = `Mint ${fmtAssetAmount(mintBase, target.decimals)} ${target.ticker}`;
              } else {
                previewEl.style.display = 'none';
                submitBtn.textContent = 'Mint';
              }
              submitBtn.disabled = !(validAmount && confirmInput.checked);
            };
            amountInput.addEventListener('input', updateMintPreview);
            confirmInput.addEventListener('change', updateMintPreview);
            updateMintPreview();
          }
        } else if (b.dataset.act === 'reveal-supply') {
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.etchOpening) { toast('No opening available — rescan first', 'error'); return; }
          const { supply, blinding } = target.etchOpening;
          const decimals = target.decimals;
          const display = fmtAssetAmount(supply, decimals);
          if (!confirm(`Publish opening for ${target.ticker}?\n\nSupply: ${display} (${supply} base units)\n\nThis pins your supply + blinding factor to the worker so anyone can cryptographically verify the announced supply against the on-chain commitment. Once published, this asset's supply is publicly known.`)) return;
          b.disabled = true; b.textContent = 'publishing…';
          try {
            const resp = await fetch(withNet(ATTEST_URL(aid)), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ supply: supply.toString(), blinding: blinding.toString(16).padStart(64, '0') }),
            });
            const j = await resp.json();
            if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
            toast('Supply attested ✓ visible in Discover', 'success');
            b.textContent = '✓ revealed';
          } catch (e) {
            toast('Reveal failed: ' + e.message, 'error');
            b.disabled = false; b.textContent = 'Reveal supply';
          }
        } else if (b.dataset.act === 'reveal-mints') {
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.myMints?.length) { toast('No mints to reveal', 'error'); return; }
          const total = target.myMints.reduce((s, m) => s + m.amount, 0n);
          if (!confirm(`Publish openings for ${target.myMints.length} mint event${target.myMints.length>1?'s':''} of ${target.ticker}?\n\nTotal additional supply: ${fmtAssetAmount(total, target.decimals)}.\nOnce published, each mint amount is publicly verifiable.`)) return;
          b.disabled = true; b.textContent = 'publishing…';
          let okCount = 0, failCount = 0;
          for (const mint of target.myMints) {
            try {
              const resp = await fetch(withNet(MINT_ATTEST_URL(aid, mint.mintTxid)), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  supply: mint.amount.toString(),
                  blinding: mint.blinding.toString(16).padStart(64, '0'),
                }),
              });
              const j = await resp.json().catch(() => ({}));
              if (resp.ok) okCount++;
              else { failCount++; console.warn('mint attest failed', mint.mintTxid, j.error || resp.status); }
            } catch (e) { failCount++; console.warn('mint attest threw', mint.mintTxid, e); }
          }
          if (okCount && !failCount) {
            toast(`${okCount} mint${okCount>1?'s':''} attested ✓`, 'success');
            b.textContent = `✓ revealed ${okCount}`;
          } else if (okCount && failCount) {
            toast(`Partial: ${okCount} attested, ${failCount} failed (see console)`, 'error');
            b.disabled = false; b.textContent = 'Retry mint reveals';
          } else {
            toast(`All ${failCount} mint reveals failed (see console)`, 'error');
            b.disabled = false; b.textContent = 'Reveal mints';
          }
        } else if (b.dataset.act === 'publish-balance') {
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs to publish', 'error'); return; }
          const total = target.utxos.reduce((s, u) => s + u.amount, 0n);
          if (!confirm(
            `Publish ${target.utxos.length} UTXO opening${target.utxos.length>1?'s':''} for ${target.ticker}?\n\n` +
            `Total amount: ${fmtAssetAmount(total, target.decimals)}.\n\n` +
            `Each opening pins the UTXO's amount + blinding factor to the worker, signed by your wallet to prove ownership. ` +
            `Anyone can then cryptographically verify it against the on-chain commitment.\n\n` +
            `⚠ Permanent: once published, an opening cannot be unpublished. Mirrors / archives may keep copies.`
          )) return;
          b.disabled = true; b.textContent = 'publishing…';
          let okCount = 0, failCount = 0;
          for (const u of target.utxos) {
            try {
              await publishOpening({
                assetIdHex: aid,
                txidHex: u.utxo.txid,
                vout: u.utxo.vout,
                amount: u.amount,
                blinding: u.blinding,
              });
              okCount++;
            } catch (e) {
              failCount++;
              console.warn('publishOpening failed', u.utxo.txid + ':' + u.utxo.vout, e);
            }
          }
          if (okCount && !failCount) {
            toast(`${okCount} opening${okCount>1?'s':''} published ✓`, 'success');
            b.textContent = `✓ published ${okCount}`;
          } else if (okCount && failCount) {
            toast(`Partial: ${okCount} published, ${failCount} failed (see console)`, 'error');
            b.disabled = false; b.textContent = `Retry (${failCount} failed)`;
          } else {
            toast(`All ${failCount} publishes failed (see console)`, 'error');
            b.disabled = false; b.textContent = 'Publish balance';
          }
        } else if (b.dataset.act === 'prove-balance') {
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs', 'error'); return; }
          const balanceDisp = fmtAssetAmount(target.balance, target.decimals);
          openInlineForm(b, {
            submitLabel: 'Prove and publish',
            content: `
              <label>Threshold X (display units)</label>
              <input type="text" inputmode="decimal" data-field="threshold" placeholder="e.g. 100">
              <div class="muted" style="margin-top:6px;font-size:11px;">
                Your balance: <strong>${escapeHtml(balanceDisp)}</strong> ${escapeHtml(target.ticker)}
                · aggregates ${target.utxos.length} UTXO${target.utxos.length>1?'s':''}
              </div>
              <div class="muted" style="margin-top:8px;font-size:11px;">
                Generates a ~688-byte zero-knowledge bulletproof and pins it to the worker. Anyone can verify the lower bound; your exact balance stays hidden. ~250 ms to prove.
              </div>`,
            onSubmit: async ({ host, errEl }) => {
              const raw = host.querySelector('[data-field="threshold"]').value.trim();
              if (!raw) { errEl.textContent = 'enter a threshold'; return false; }
              let thresholdBase;
              try { thresholdBase = parseAssetAmount(raw, target.decimals); }
              catch (e) { errEl.textContent = 'parse error: ' + e.message; return false; }
              if (thresholdBase <= 0n) { errEl.textContent = 'threshold must be > 0'; return false; }
              if (thresholdBase > target.balance) {
                errEl.textContent = `threshold ${fmtAssetAmount(thresholdBase, target.decimals)} > balance ${balanceDisp}`;
                return false;
              }
              await new Promise(r => setTimeout(r, 50)); // yield to UI before ~250ms prove
              await proveRangeDisclosure({ assetIdHex: aid, threshold: thresholdBase, holding: target });
              toast(`Disclosure ${target.ticker} ≥ ${fmtAssetAmount(thresholdBase, target.decimals)} published ✓`, 'success');
              b.textContent = `✓ proved ≥ ${fmtAssetAmount(thresholdBase, target.decimals)}`;
            },
          });
        } else if (b.dataset.act === 'list-sale') {
          // Inline form replaces the chained prompt(price) → prompt(days) →
          // confirm(summary) flow. Mounts into the [data-list-form] slot inside
          // the Marketplace details panel; submission triggers publishListing.
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs to list', 'error'); return; }
          const formHost = list.querySelector(`[data-list-form="${aid}"]`);
          if (!formHost) { toast('Form host missing — try ↻ Rescan', 'error'); return; }
          // If the form is already open, treat the click as toggle-close.
          if (formHost.style.display === 'block') {
            formHost.style.display = 'none';
            formHost.innerHTML = '';
            return;
          }
          // List by AMOUNT, not by UTXO. If no UTXO matches the requested
          // amount exactly, the dapp auto-splits via a self-CXFER first (one
          // extra Bitcoin tx, ~$1-3 mainnet), creating a UTXO of the exact
          // amount + change. Closes the user-reported gap where the form
          // forced selling a whole UTXO. The largest holdable UTXO bounds
          // what's sellable in a single listing — for amounts spanning
          // multiple UTXOs, ask users to consolidate first via Send.
          const sortedUtxos = [...target.utxos].sort((a, b) => Number(b.amount - a.amount));
          const totalBal = sortedUtxos.reduce((s, u) => s + u.amount, 0n);
          const largestUtxo = sortedUtxos[0]?.amount || 0n;
          formHost.innerHTML = `
            <div class="inline-form">
              <label>Amount to sell (display units, e.g. 1.5)</label>
              <input type="text" inputmode="decimal" data-field="amount" placeholder="amount">
              <div class="muted" style="margin-top:4px;font-size:11px;">
                Holdings: ${fmtAssetAmount(totalBal, target.decimals)} ${escapeHtml(target.ticker)} across ${sortedUtxos.length} UTXO${sortedUtxos.length === 1 ? '' : 's'}
                (largest single: ${fmtAssetAmount(largestUtxo, target.decimals)} ${escapeHtml(target.ticker)}).
                If the amount you enter doesn't match any single UTXO exactly, the dapp auto-splits via a self-CXFER first
                (one extra Bitcoin tx), then lists the resulting amount-exact UTXO.
              </div>
              <div class="form-row two" style="margin-top:8px;">
                <div>
                  <label>Price (sats)</label>
                  <input type="text" inputmode="numeric" data-field="price" value="50000">
                </div>
                <div>
                  <label>Expires in (days)</label>
                  <input type="number" min="1" max="365" data-field="days" value="7">
                </div>
              </div>
              <div class="muted" style="margin-top:10px;font-size:11px;">
                Pay to: <span class="mono-box inline" style="font-size:10px;">${escapeHtml(wallet.address())}</span><br>
                ⚠ Your exact listed amount becomes <strong>public</strong> once listed.
              </div>
              <div class="form-buttons">
                <button class="primary" data-form-act="publish">Publish listing</button>
                <button data-form-act="cancel">Cancel</button>
              </div>
              <div class="error" data-form-error></div>
            </div>`;
          formHost.style.display = 'block';
          const errEl = formHost.querySelector('[data-form-error]');
          // Eager fetch — by submit time the response will almost always be
          // resolved, so the await below adds no perceptible latency. On a
          // slow network we avoid stalling the user mid-click.
          const listedTagsP = fetchListedUtxoTags(aid).catch(() => new Map());
          formHost.querySelector('[data-form-act="cancel"]').onclick = () => {
            formHost.style.display = 'none';
            formHost.innerHTML = '';
          };
          formHost.querySelector('[data-form-act="publish"]').onclick = async (ev) => {
            errEl.textContent = '';
            const amountStr = formHost.querySelector('[data-field="amount"]').value.trim();
            if (!amountStr) { errEl.textContent = 'enter an amount'; return; }
            let amount;
            try { amount = parseAssetAmount(amountStr, target.decimals); }
            catch (e) { errEl.textContent = e.message; return; }
            if (amount <= 0n) { errEl.textContent = 'amount must be > 0'; return; }
            if (amount > totalBal) { errEl.textContent = `amount exceeds holdings (${fmtAssetAmount(totalBal, target.decimals)} ${target.ticker})`; return; }
            if (amount > largestUtxo) {
              errEl.textContent = `amount exceeds largest single UTXO (${fmtAssetAmount(largestUtxo, target.decimals)} ${target.ticker}). Consolidate first via Send Privately to your own address.`;
              return;
            }
            const priceSats = parseInt(formHost.querySelector('[data-field="price"]').value.trim(), 10);
            if (!Number.isInteger(priceSats) || priceSats < DUST) { errEl.textContent = `price must be integer ≥ ${DUST}`; return; }
            const days = parseInt(formHost.querySelector('[data-field="days"]').value.trim(), 10);
            if (!Number.isInteger(days) || days < 1 || days > 365) { errEl.textContent = 'days must be 1–365'; return; }
            const expiry = Math.floor(Date.now() / 1000) + days * 86400;

            // Exclude UTXOs that are already in an active listing/intent —
            // both from the exact-match search and the auto-split cover pick.
            // Splitting an already-listed UTXO would silently invalidate the
            // existing listing once the split tx confirms; double-listing it
            // strands the older offer at fulfilment time.
            const listedTags = await listedTagsP;
            const isListed = u => listedTags.has(`${u.utxo.txid}:${u.utxo.vout | 0}`);
            const availableUtxos = sortedUtxos.filter(u => !isListed(u));
            const lockedCount = sortedUtxos.length - availableUtxos.length;
            const availLargest = availableUtxos[0]?.amount || 0n;
            if (amount > availLargest) {
              errEl.textContent = lockedCount
                ? `Largest free UTXO is ${fmtAssetAmount(availLargest, target.decimals)} ${target.ticker} (${lockedCount} UTXO${lockedCount === 1 ? '' : 's'} already in active listings/intents). Lower the amount or cancel an existing listing first.`
                : `amount exceeds largest single UTXO (${fmtAssetAmount(availLargest, target.decimals)} ${target.ticker}). Consolidate first via Send Privately to your own address.`;
              return;
            }

            // Pick a UTXO. Prefer an exact match (no split needed); else pick
            // the smallest UTXO that covers the amount (minimizes the
            // post-split change UTXO size, which is more usable later).
            const exactMatch = availableUtxos.find(u => u.amount === amount);
            let listUtxo = exactMatch;
            const submitBtn = ev.target;
            submitBtn.disabled = true; submitBtn.textContent = exactMatch ? 'listing…' : 'splitting + listing…';
            try {
              if (!exactMatch) {
                // Auto-split: self-CXFER for the exact amount. The result's
                // recipients[0] is what we'll list (vout 0 of the reveal tx).
                if (!ensureBurnerBackedUp('Auto-split UTXO before listing (one extra CXFER from your active wallet)')) {
                  throw new Error('cancelled');
                }
                const need = await estimateSatsForOp('cxfer');
                if (!(await ensureSatsFunded(need, 'Auto-split before listing'))) throw new Error('cancelled');
                // Force the smallest covering UTXO so the change UTXO is as
                // small as possible (future listings can take from it directly).
                const cover = [...availableUtxos].reverse().find(u => u.amount >= amount);
                if (!cover) throw new Error('no UTXO large enough (should not happen — guarded above)');
                const splitResult = await buildAndBroadcastCXferMulti({
                  assetIdHex: aid,
                  recipients: [{ pubHex: bytesToHex(wallet.pub), amount }],
                  forceUtxos: [cover],
                });
                const r0 = splitResult.recipients[0];
                listUtxo = {
                  utxo: { txid: splitResult.revealTxid, vout: r0.vout },
                  amount: r0.amount,
                  blinding: r0.blinding,
                };
                toast(`Split: ${fmtAssetAmount(amount, target.decimals)} ${target.ticker} carved out for listing ✓`, 'success');
              }
              await publishListing({
                assetIdHex: aid,
                txidHex: listUtxo.utxo.txid,
                vout: listUtxo.utxo.vout,
                amount: listUtxo.amount,
                blinding: listUtxo.blinding,
                priceSats,
                expiry,
                makerAddress: wallet.address(),
              });
              toast(`Listed ${fmtAssetAmount(listUtxo.amount, target.decimals)} ${target.ticker} at ${priceSats.toLocaleString()} sats ✓`, 'success');
              renderHoldings();
            } catch (e) {
              errEl.textContent = e.message === 'cancelled' ? 'cancelled' : 'Listing failed: ' + e.message;
              submitBtn.disabled = false; submitBtn.textContent = 'Publish listing';
            }
          };
        } else if (b.dataset.act === 'cancel-listing') {
          const aid = b.dataset.aid;
          const txidHex = b.dataset.txid;
          const vout = parseInt(b.dataset.vout, 10);
          // Try to locate the listed UTXO in current holdings so we can offer
          // a "true cancel" path: self-CXFER the exact UTXO (consumes ONLY
          // that outpoint via forceUtxos, not the user's full balance for the
          // asset). Worker DELETE alone is sufficient to remove the offer
          // from the marketplace, but doesn't invalidate the published
          // (amount, blinding) opening — a paranoid maker who wants the UTXO
          // unusable rather than just unlisted should self-spend.
          const _h = holdings.get(aid);
          const _u = _h?.utxos.find(x => x.utxo.txid === txidHex && x.utxo.vout === vout);
          const includeSelfSpend = _u
            ? confirm(
                `Cancel this listing?\n\n` +
                `[OK]     Remove from marketplace AND self-send the listed UTXO so it's permanently invalidated. Pays Bitcoin fees for one CXFER.\n\n` +
                `[Cancel] Don't change anything. Use the inline "Cancel" again and pick the marketplace-only path if you'd prefer that.`,
              )
            : (confirm(`Cancel this listing? The signed offer will be removed from the marketplace immediately.`) ? false : null);
          if (includeSelfSpend === null) return;
          b.disabled = true; b.textContent = 'cancelling…';
          let cxferBroadcast = false;
          try {
            if (includeSelfSpend && _u) {
              if (!ensureBurnerBackedUp('Cancel listing (signs a self-CXFER spending the listed UTXO)')) {
                b.disabled = false; b.textContent = 'Cancel';
                return;
              }
              const need = await estimateSatsForOp('cxfer');
              if (!(await ensureSatsFunded(need, 'Cancelling listing'))) {
                b.disabled = false; b.textContent = 'Cancel';
                return;
              }
              b.textContent = 'self-spending…';
              await buildAndBroadcastCXfer({
                assetIdHex: aid,
                recipientPubHex: bytesToHex(wallet.pub),
                amount: _u.amount,
                forceUtxos: [_u],
              });
              cxferBroadcast = true;
            }
            await cancelListing({ assetIdHex: aid, txidHex, vout });
            toast(includeSelfSpend
              ? 'Listing cancelled · UTXO self-spent · marketplace cleared ✓'
              : 'Listing cancelled ✓', 'success');
            renderHoldings();
          } catch (e) {
            if (cxferBroadcast) {
              // Self-CXFER already broadcast — listed UTXO is spent, so the
              // listing is permanently invalid. Worker DELETE failed (transient
              // network/worker error); the worker's reaper cron will prune the
              // stale entry once it sees the spend on chain.
              toast('UTXO self-spent ✓ — marketplace cleanup pending (will auto-prune): ' + e.message, 'error');
              renderHoldings();
            } else {
              toast('Cancel failed: ' + e.message, 'error');
              b.disabled = false; b.textContent = 'Cancel';
            }
          }
        } else if (b.dataset.act === 'list-range') {
          // Range-disclosed listing: aggregates all UTXOs of the asset behind a
          // bulletproof "balance ≥ K" proof. No Bitcoin tx broadcast — pure
          // off-chain prove + worker POST. Reuses [data-list-form] slot.
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs to list', 'error'); return; }
          const formHost = list.querySelector(`[data-list-form="${aid}"]`);
          if (!formHost) { toast('Form host missing — try ↻ Rescan', 'error'); return; }
          if (formHost.style.display === 'block') {
            formHost.style.display = 'none';
            formHost.innerHTML = '';
            return;
          }
          formHost.innerHTML = `
            <div class="inline-form">
              <label>Advertised lower bound (display units)</label>
              <input type="text" inputmode="decimal" data-field="avail" placeholder="e.g. 100" value="100">
              <div class="muted" style="margin-top:6px;font-size:11px;">
                Real balance: <strong>${escapeHtml(fmtAssetAmount(target.balance, target.decimals))}</strong> ${escapeHtml(target.ticker)}
                · aggregates ${target.utxos.length} UTXO${target.utxos.length>1?'s':''}
              </div>
              <div class="form-row two" style="margin-top:8px;">
                <div>
                  <label>Price (sats)</label>
                  <input type="text" inputmode="numeric" data-field="price" value="50000">
                </div>
                <div>
                  <label>Expires in (days, 1–365)</label>
                  <input type="number" min="1" max="365" data-field="days" value="7">
                </div>
              </div>
              <div class="muted" style="margin-top:10px;font-size:11px;line-height:1.5;">
                Pay-to: <span class="mono-box inline" style="font-size:10px;">${escapeHtml(wallet.address())}</span><br>
                Generates a ~688-byte zero-knowledge bulletproof proving balance ≥ K. Your exact balance and other UTXOs stay confidential.<br>
                ⚠ Settlement is OFF-CHAIN: taker pays sats, then you broadcast a CXFER for exactly the listed amount. Counterparty trust still required.
              </div>
              <div class="form-buttons">
                <button class="primary" data-form-act="publish">Prove & publish</button>
                <button data-form-act="cancel">Close</button>
              </div>
              <div class="error" data-form-error></div>
            </div>`;
          formHost.style.display = 'block';
          const errEl = formHost.querySelector('[data-form-error]');
          formHost.querySelector('[data-form-act="cancel"]').onclick = () => {
            formHost.style.display = 'none';
            formHost.innerHTML = '';
          };
          formHost.querySelector('[data-form-act="publish"]').onclick = async (ev) => {
            errEl.textContent = '';
            const availRaw = formHost.querySelector('[data-field="avail"]').value.trim();
            if (!availRaw) { errEl.textContent = 'enter an amount'; return; }
            let availBase;
            try { availBase = parseAssetAmount(availRaw, target.decimals); }
            catch (e) { errEl.textContent = 'parse error: ' + e.message; return; }
            if (availBase <= 0n) { errEl.textContent = 'amount must be > 0'; return; }
            if (availBase > target.balance) {
              errEl.textContent = `amount ${fmtAssetAmount(availBase, target.decimals)} > balance ${fmtAssetAmount(target.balance, target.decimals)}`;
              return;
            }
            const priceSats = parseInt(formHost.querySelector('[data-field="price"]').value.trim(), 10);
            if (!Number.isInteger(priceSats) || priceSats < DUST) { errEl.textContent = `price must be integer ≥ ${DUST}`; return; }
            const days = parseInt(formHost.querySelector('[data-field="days"]').value.trim(), 10);
            if (!Number.isInteger(days) || days < 1 || days > 365) { errEl.textContent = 'days must be 1–365'; return; }
            const expiry = Math.floor(Date.now() / 1000) + days * 86400;
            const submitBtn = ev.target;
            submitBtn.disabled = true; submitBtn.textContent = 'proving…';
            await new Promise(r => setTimeout(r, 50));
            try {
              await publishRangeListing({
                assetIdHex: aid,
                holding: target,
                availableAmount: availBase,
                priceSats,
                expiry,
                makerAddress: wallet.address(),
              });
              toast(`Range listing published ✓ ${fmtAssetAmount(availBase, target.decimals)} ${target.ticker} for ${priceSats} sats`, 'success');
              renderHoldings();
            } catch (e) {
              errEl.textContent = 'Range listing failed: ' + e.message;
              submitBtn.disabled = false; submitBtn.textContent = 'Prove & publish';
            }
          };
        } else if (b.dataset.act === 'cancel-range-listing') {
          const aid = b.dataset.aid;
          if (!confirm('Cancel your range-disclosed listing? It will be removed from the marketplace immediately.')) return;
          b.disabled = true; b.textContent = 'cancelling…';
          try {
            await cancelRangeListing({ assetIdHex: aid });
            toast('Range listing cancelled ✓', 'success');
            renderHoldings();
          } catch (e) {
            toast('Cancel failed: ' + e.message, 'error');
            b.disabled = false; b.textContent = 'Cancel';
          }
        } else if (b.dataset.act === 'list-atomic') {
          // Atomic offer = SPEC §5.7 T_AXFER. Sells a SINGLE UTXO whole (N=1).
          // To sell a partial amount, the maker pre-splits via Send Privately
          // first, then offers the resulting fixed-amount UTXO. Reuses the
          // marketplace [data-list-form] slot — same toggle-close pattern as
          // list-sale below.
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs to offer', 'error'); return; }
          const formHost = list.querySelector(`[data-list-form="${aid}"]`);
          if (!formHost) { toast('Form host missing — try ↻ Rescan', 'error'); return; }
          if (formHost.style.display === 'block') {
            formHost.style.display = 'none';
            formHost.innerHTML = '';
            return;
          }
          // Sort smallest-first so the default matches the most-common case
          // "send a small portion atomically to a specific recipient". The
          // dropdown still shows every UTXO; users wanting to send a larger
          // one scroll down or pre-split via Send Privately.
          const sortedUtxos = [...target.utxos].sort((a, b) => Number(a.amount - b.amount));
          const utxoOpts = sortedUtxos.map((u, idx) =>
            `<option value="${idx}">${escapeHtml(utxoPickerOptionLabel(u, target))}</option>`,
          ).join('');
          formHost.innerHTML = `
            <div class="inline-form">
              <label>Pick UTXO to sell ▾ (smallest first; entire UTXO is sold)</label>
              <select data-field="utxo">${utxoOpts}</select>
              <div class="muted" data-utxo-picker-status style="margin-top:4px;font-size:10px;">checking listings…</div>
              <details style="margin-top:6px;">
                <summary class="muted" style="cursor:pointer;font-size:11px;">Need a smaller UTXO? Split first ▾</summary>
                <div style="margin-top:8px;padding:8px;border:1px dashed var(--ink-faint);background:var(--bg);">
                  <div class="muted" style="font-size:11px;line-height:1.5;">
                    Atomic intents sell the entire UTXO — to list less than the chosen UTXO holds, broadcast a self-CXFER first that splits it into <strong>${escapeHtml(target.ticker)} you-want-to-list</strong> + <strong>change</strong>. After it confirms (~10 min), the new smaller UTXO appears in the dropdown above.
                  </div>
                  <div class="form-row two" style="margin-top:8px;">
                    <div>
                      <label>New UTXO size (display units)</label>
                      <input type="text" inputmode="decimal" data-field="split-amount" placeholder="e.g. 100">
                    </div>
                    <div style="display:flex;align-items:flex-end;">
                      <button data-form-act="split" type="button" style="font-size:11px;">Split UTXO</button>
                    </div>
                  </div>
                  <div class="muted" style="margin-top:6px;font-size:10px;">Spends the UTXO selected above; produces two new ones. Costs commit + reveal Bitcoin fees.</div>
                  <div class="error" data-split-error style="margin-top:6px;"></div>
                </div>
              </details>
              <label style="margin-top:8px;">Recipient public key (33-byte compressed hex, 02… or 03…)</label>
              <input type="text" data-field="recipient" placeholder="02… or 03…" autocomplete="off" spellcheck="false">
              <div class="form-row two" style="margin-top:8px;">
                <div>
                  <label>Price (sats)</label>
                  <input type="text" inputmode="numeric" data-field="price" value="50000">
                </div>
                <div>
                  <label>Expires in (days, 1–7)</label>
                  <input type="number" min="1" max="7" data-field="days" value="1">
                </div>
              </div>
              <div class="muted" style="margin-top:10px;font-size:11px;line-height:1.5;">
                Pay-to: <span class="mono-box inline" style="font-size:10px;">${escapeHtml(wallet.address())}</span><br>
                ⚠ Cancellation works by self-spending the asset UTXO (≈ commit + reveal fees). The original commit output is forfeit.
              </div>
              <div class="form-buttons">
                <button class="primary" data-form-act="publish">Build atomic offer</button>
                <button data-form-act="cancel">Close</button>
              </div>
              <div class="error" data-form-error></div>
            </div>`;
          formHost.style.display = 'block';
          const errEl = formHost.querySelector('[data-form-error]');
          // Enrich the picker post-mount with already-listed tags. The submit
          // handler awaits this Promise so a fast click before enrichment
          // lands still gets the guard — at the cost of a small wait, which is
          // imperceptible when the fetch already resolved before submit.
          const listedTagsP = enrichUtxoPicker(formHost.querySelector('[data-field="utxo"]'), sortedUtxos, target, aid)
            .then(t => {
              const statusEl = formHost.querySelector('[data-utxo-picker-status]');
              if (statusEl) {
                const blockedCount = Array.from(formHost.querySelectorAll('[data-field="utxo"] option')).filter(o => o.disabled).length;
                statusEl.textContent = blockedCount
                  ? `${blockedCount} UTXO${blockedCount === 1 ? '' : 's'} locked — already in an active listing/offer (greyed in dropdown)`
                  : '';
                if (!blockedCount) statusEl.style.display = 'none';
              }
              return t;
            })
            .catch(() => {
              const statusEl = formHost.querySelector('[data-utxo-picker-status]');
              if (statusEl) statusEl.style.display = 'none';
              return new Map();
            });
          formHost.querySelector('[data-form-act="cancel"]').onclick = () => {
            formHost.style.display = 'none';
            formHost.innerHTML = '';
          };
          // Split-UTXO helper. Atomic intents sell a whole UTXO, so a maker
          // who wants to list less than one of their UTXOs holds needs to
          // pre-split. This button broadcasts a self-CXFER that consumes the
          // selected UTXO via forceUtxos and produces (amount + change), so
          // the new smaller UTXO can be picked from the dropdown after
          // confirmation. Doesn't auto-list — splits and waits.
          formHost.querySelector('[data-form-act="split"]').onclick = async () => {
            const splitErr = formHost.querySelector('[data-split-error]');
            splitErr.textContent = '';
            const utxoIdx = parseInt(formHost.querySelector('[data-field="utxo"]').value, 10);
            const u = sortedUtxos[utxoIdx];
            if (!u) { splitErr.textContent = 'pick the source UTXO above first'; return; }
            const sizeStr = formHost.querySelector('[data-field="split-amount"]').value.trim();
            if (!sizeStr) { splitErr.textContent = 'enter the new UTXO size'; return; }
            let splitAmount;
            try { splitAmount = parseAssetAmount(sizeStr, target.decimals); }
            catch (e) { splitErr.textContent = e.message; return; }
            if (splitAmount <= 0n) { splitErr.textContent = 'split size must be > 0'; return; }
            if (splitAmount >= u.amount) {
              splitErr.textContent = `split size (${fmtAssetAmount(splitAmount, target.decimals)}) must be < the chosen UTXO's amount (${fmtAssetAmount(u.amount, target.decimals)}) — otherwise no smaller UTXO is produced`;
              return;
            }
            if (!confirm(
              `Split this UTXO?\n\n` +
              `Source UTXO: ${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} (${shorten(u.utxo.txid, 8)}:${u.utxo.vout})\n\n` +
              `New UTXO #1: ${fmtAssetAmount(splitAmount, target.decimals)} ${target.ticker} (use this for the atomic intent)\n` +
              `New UTXO #2: ${fmtAssetAmount(u.amount - splitAmount, target.decimals)} ${target.ticker} (change, stays in your wallet)\n\n` +
              `Cost: one CXFER (commit + reveal Bitcoin fees, ~10 min for confirmation).`,
            )) return;
            if (!ensureBurnerBackedUp('Split UTXO (self-CXFER consuming the selected UTXO)')) return;
            const need = await estimateSatsForOp('cxfer');
            if (!(await ensureSatsFunded(need, 'Splitting UTXO'))) return;
            const splitBtn = formHost.querySelector('[data-form-act="split"]');
            const origLabel = splitBtn.textContent;
            splitBtn.disabled = true; splitBtn.textContent = 'broadcasting…';
            try {
              const r = await buildAndBroadcastCXfer({
                assetIdHex: aid,
                recipientPubHex: bytesToHex(wallet.pub),
                amount: splitAmount,
                forceUtxos: [u],
              });
              toast(`Split broadcast · commit=${shorten(r.commitTxid, 6)} · wait ~10 min, then re-open this form to pick the new UTXO`, 'success', 8000);
              formHost.style.display = 'none';
              formHost.innerHTML = '';
              renderHoldings();
            } catch (e) {
              splitErr.textContent = 'Split failed: ' + e.message;
              splitBtn.disabled = false; splitBtn.textContent = origLabel;
            }
          };
          formHost.querySelector('[data-form-act="publish"]').onclick = async (ev) => {
            errEl.textContent = '';
            const utxoIdx = parseInt(formHost.querySelector('[data-field="utxo"]').value, 10);
            const u = sortedUtxos[utxoIdx];
            if (!u) { errEl.textContent = 'pick a UTXO'; return; }
            // Guard against double-listing the same UTXO. Awaits the
            // enrichment promise — guarantees the check fires even if the
            // user clicked Publish before the initial enrichment landed.
            const listedTags = await listedTagsP;
            const listedTag = listedTags?.get(`${u.utxo.txid}:${u.utxo.vout | 0}`);
            if (listedTag) {
              errEl.textContent = `That UTXO is already in an active ${listedTag.label}. Pick a different UTXO or cancel the existing one first.`;
              return;
            }
            const recipientPub = formHost.querySelector('[data-field="recipient"]').value.trim().toLowerCase().replace(/\s/g, '');
            if (!/^0[23][0-9a-f]{64}$/.test(recipientPub)) { errEl.textContent = 'recipient must be 33-byte compressed hex'; return; }
            try { secp.ProjectivePoint.fromHex(recipientPub); }
            catch { errEl.textContent = 'recipient is not a valid secp256k1 point'; return; }
            const priceSats = parseInt(formHost.querySelector('[data-field="price"]').value.trim(), 10);
            if (!Number.isInteger(priceSats) || priceSats < DUST) { errEl.textContent = `price must be integer ≥ ${DUST}`; return; }
            const days = parseInt(formHost.querySelector('[data-field="days"]').value.trim(), 10);
            if (!Number.isInteger(days) || days < 1 || days > 7) { errEl.textContent = 'days must be 1–7 (atomic offers should be short-lived)'; return; }
            const expiry = Math.floor(Date.now() / 1000) + days * 86400;
            // Final spend-authorization confirm: form is data entry, this is the
            // explicit "yes, broadcast a commit tx and pay sats" step.
            if (!confirm(
              `Create atomic offer?\n\n` +
              `Selling: ${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} (whole UTXO)\n` +
              `Price:   ${priceSats.toLocaleString()} sats (paid to ${wallet.address()})\n` +
              `To:      ${shorten(recipientPub, 8)}\n` +
              `Expires: ${days} day${days>1?'s':''}\n\n` +
              `On confirm: a commit tx will be broadcast (one-time fee ≈ ${feeFor(150, 10)} sats), and a partial reveal tx will be signed and copied to clipboard.`,
            )) return;
            if (!ensureBurnerBackedUp('Create atomic offer (the in-page privkey signs the partial reveal)')) {
              errEl.textContent = 'Back up the in-page privkey first, then retry.'; return;
            }
            const need = await estimateSatsForOp('cxfer');
            if (!(await ensureSatsFunded(need, 'Building atomic offer'))) { errEl.textContent = 'Funding cancelled.'; return; }
            const submitBtn = ev.target;
            submitBtn.disabled = true; submitBtn.textContent = 'committing…';
            await new Promise(r => setTimeout(r, 50)); // yield to UI before heavy ops
            try {
              const offer = await buildAxferOffer({
                utxoTxid: u.utxo.txid,
                utxoVout: u.utxo.vout,
                recipientPubHex: recipientPub,
                priceSats,
                expiry,
              });
              const json = JSON.stringify(offer);
              await navigator.clipboard?.writeText(json).catch(() => {});
              toast(`Atomic offer ready (${json.length} chars copied) — share JSON with the recipient`, 'success', 10000);
              // Replace the form with a success card. Lets the user copy again
              // (clipboard may have been overwritten) without re-running the build.
              formHost.innerHTML = `
                <div style="padding:10px 12px;border:1px solid var(--ink);border-left:4px solid #0a8f43;background:var(--bg-warm);font-size:11px;">
                  <strong>✓ Atomic offer ready</strong>
                  <div class="muted" style="margin-top:4px;">JSON copied to clipboard (${json.length} chars). Send it to the recipient — they paste into Holdings → "Take atomic offer".</div>
                  <div class="flex" style="margin-top:8px;gap:6px;">
                    <button data-form-act="copy">Copy again</button>
                    <button data-form-act="dismiss">Dismiss</button>
                  </div>
                </div>`;
              formHost.querySelector('[data-form-act="copy"]').onclick = async () => {
                try { await navigator.clipboard.writeText(json); toast('Offer JSON copied again', 'success'); }
                catch { /* clipboard blocked */ }
              };
              formHost.querySelector('[data-form-act="dismiss"]').onclick = () => {
                formHost.style.display = 'none';
                formHost.innerHTML = '';
              };
              renderActivity(); renderOffers();
            } catch (e) {
              errEl.textContent = 'Atomic offer failed: ' + e.message;
              submitBtn.disabled = false; submitBtn.textContent = 'Build atomic offer';
            }
          };
        } else if (b.dataset.act === 'publish-intent') {
          // Browse-and-take atomic intent — appears on the Market tab for any
          // taker to claim. Maker stays online to fulfil claims as they arrive.
          // Reuses the marketplace [data-list-form] slot.
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs to publish', 'error'); return; }
          const formHost = list.querySelector(`[data-list-form="${aid}"]`);
          if (!formHost) { toast('Form host missing — try ↻ Rescan', 'error'); return; }
          if (formHost.style.display === 'block') {
            formHost.style.display = 'none';
            formHost.innerHTML = '';
            return;
          }
          // Sort smallest-first so the default matches the common "test the
          // market with a small portion" case. Every UTXO appears in the
          // dropdown; users wanting to list a larger one scroll, or split
          // bigger UTXOs via Send Privately first.
          const sortedUtxos = [...target.utxos].sort((a, b) => Number(a.amount - b.amount));
          const utxoOpts = sortedUtxos.map((u, idx) =>
            `<option value="${idx}">${escapeHtml(utxoPickerOptionLabel(u, target))}</option>`,
          ).join('');
          formHost.innerHTML = `
            <div class="inline-form">
              <label>Pick UTXO to sell ▾ (smallest first; whole UTXO is sold atomically — v1 doesn't support partial fills)</label>
              <select data-field="utxo">${utxoOpts}</select>
              <div class="muted" data-utxo-picker-status style="margin-top:4px;font-size:10px;">checking listings…</div>
              <div class="form-row two" style="margin-top:8px;">
                <div>
                  <label>Price (sats)</label>
                  <input type="text" inputmode="numeric" data-field="price" value="50000">
                </div>
                <div>
                  <label>Expires in (days, 1–7)</label>
                  <input type="number" min="1" max="7" data-field="days" value="1">
                </div>
              </div>
              <div class="muted" style="margin-top:10px;font-size:11px;line-height:1.5;">
                Anyone can claim. Each claim has 5 min to be fulfilled by you.<br>
                ⚠ Fulfilment happens on this device — a per-intent secret stays in this browser, so you'll need to be back here to fulfil any incoming claim.<br>
                ⚠ If you fulfil a claim and then need to cancel, you'll have to send the asset UTXO to yourself (Bitcoin tx fees apply). Cancelling on the worker alone doesn't stop a taker who's already received the partial tx.
              </div>
              <div class="form-buttons">
                <button class="primary" data-form-act="publish">Publish intent</button>
                <button data-form-act="cancel">Close</button>
              </div>
              <div class="error" data-form-error></div>
              <!-- Custom 4-step strip for atomic-intent publish: there's
                   only one chain broadcast (commit) — the labels reflect
                   the actual stages: Build → Commit → Confirm → Publish. -->
              <div class="progress-strip" data-publish-progress style="display:none;margin-top:10px;" aria-live="polite">
                <div class="progress-step" data-step="0"><span class="progress-num">1</span><span class="progress-label">Build</span></div>
                <div class="progress-step" data-step="1"><span class="progress-num">2</span><span class="progress-label">Commit</span></div>
                <div class="progress-step" data-step="2"><span class="progress-num">3</span><span class="progress-label">Confirm</span></div>
                <div class="progress-step" data-step="3"><span class="progress-num">4</span><span class="progress-label">Publish</span></div>
              </div>
            </div>`;
          formHost.style.display = 'block';
          const errEl = formHost.querySelector('[data-form-error]');
          // Enrich the picker post-mount with already-listed tags. Same
          // pattern as the targeted-atomic flow above; see comments there.
          const listedTagsP = enrichUtxoPicker(formHost.querySelector('[data-field="utxo"]'), sortedUtxos, target, aid)
            .then(t => {
              const statusEl = formHost.querySelector('[data-utxo-picker-status]');
              if (statusEl) {
                const blockedCount = Array.from(formHost.querySelectorAll('[data-field="utxo"] option')).filter(o => o.disabled).length;
                statusEl.textContent = blockedCount
                  ? `${blockedCount} UTXO${blockedCount === 1 ? '' : 's'} locked — already in an active listing/intent (greyed in dropdown)`
                  : '';
                if (!blockedCount) statusEl.style.display = 'none';
              }
              return t;
            })
            .catch(() => {
              const statusEl = formHost.querySelector('[data-utxo-picker-status]');
              if (statusEl) statusEl.style.display = 'none';
              return new Map();
            });
          formHost.querySelector('[data-form-act="cancel"]').onclick = () => {
            formHost.style.display = 'none';
            formHost.innerHTML = '';
          };
          formHost.querySelector('[data-form-act="publish"]').onclick = async (ev) => {
            errEl.textContent = '';
            const utxoIdx = parseInt(formHost.querySelector('[data-field="utxo"]').value, 10);
            const u = sortedUtxos[utxoIdx];
            if (!u) { errEl.textContent = 'pick a UTXO'; return; }
            const listedTags = await listedTagsP;
            const listedTag = listedTags?.get(`${u.utxo.txid}:${u.utxo.vout | 0}`);
            if (listedTag) {
              errEl.textContent = `That UTXO is already in an active ${listedTag.label}. Pick a different UTXO or cancel the existing one first.`;
              return;
            }
            const priceSats = parseInt(formHost.querySelector('[data-field="price"]').value.trim(), 10);
            if (!Number.isInteger(priceSats) || priceSats < DUST) { errEl.textContent = `price must be integer ≥ ${DUST}`; return; }
            const days = parseInt(formHost.querySelector('[data-field="days"]').value.trim(), 10);
            if (!Number.isInteger(days) || days < 1 || days > 7) { errEl.textContent = 'days must be 1–7'; return; }
            const expiry = Math.floor(Date.now() / 1000) + days * 86400;
            if (!confirm(
              `Publish atomic intent on the Market?\n\n` +
              `Selling: ${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} (whole UTXO)\n` +
              `Price:   ${priceSats.toLocaleString()} sats\n` +
              `Expires: ${days} day${days>1?'s':''}\n\n` +
              `On confirm: a commit tx will be broadcast and the intent will be posted to the marketplace. The recipient blinding scalar is generated locally and stored in this browser only.`,
            )) return;
            if (!ensureBurnerBackedUp('Publish atomic intent (commits an asset UTXO; partial reveal generated at fulfilment time)')) {
              errEl.textContent = 'Back up the in-page privkey first, then retry.'; return;
            }
            const need = await estimateSatsForOp('cxfer');
            if (!(await ensureSatsFunded(need, 'Publishing intent'))) { errEl.textContent = 'Funding cancelled.'; return; }
            const submitBtn = ev.target;
            submitBtn.disabled = true; submitBtn.textContent = 'publishing…';
            const pubStrip = formHost.querySelector('[data-publish-progress]');
            if (pubStrip) pubStrip.style.display = 'flex';
            setProgressStrip(pubStrip, 0);
            await new Promise(r => setTimeout(r, 50));
            try {
              const r = await publishAxferIntent({
                utxoTxid: u.utxo.txid,
                utxoVout: u.utxo.vout,
                priceSats,
                expiry,
                onProgress: (stage) => {
                  if (stage === 'commit-start') setProgressStrip(pubStrip, 1);
                  else if (stage === 'wait-visible') setProgressStrip(pubStrip, 2);
                  else if (stage === 'publish-start') setProgressStrip(pubStrip, 3);
                },
              });
              setProgressStrip(pubStrip, 4);
              toast(`Intent ${shorten(r.intent_id, 6)} published ✓ — visible on the Market tab`, 'success', 8000);
              formHost.innerHTML = `
                <div style="padding:10px 12px;border:1px solid var(--ink);border-left:4px solid #0a8f43;background:var(--bg-warm);font-size:11px;">
                  <strong>✓ Intent published</strong>
                  <div class="muted" style="margin-top:4px;">Intent ID ${escapeHtml(shorten(r.intent_id, 8))} is now live on the Market tab. When a taker claims, you'll see a "Fulfil" button there.</div>
                  <div class="flex" style="margin-top:8px;gap:6px;">
                    <button data-form-act="goto-market">Go to Market →</button>
                    <button data-form-act="dismiss">Dismiss</button>
                  </div>
                </div>`;
              formHost.querySelector('[data-form-act="goto-market"]').onclick = () => {
                $('.tab[data-tab="market"]').click();
              };
              formHost.querySelector('[data-form-act="dismiss"]').onclick = () => {
                formHost.style.display = 'none';
                formHost.innerHTML = '';
              };
            } catch (e) {
              errEl.textContent = 'Intent failed: ' + e.message;
              if (pubStrip) {
                const a = pubStrip.querySelector('.progress-step.active');
                const idx = a ? Number(a.dataset.step) : -1;
                if (idx >= 0) setProgressStrip(pubStrip, -1, { errorAt: idx });
              }
              submitBtn.disabled = false; submitBtn.textContent = 'Publish intent';
            }
          };
        }
      };
    };
    list.querySelectorAll('button[data-act]').forEach(wireBtn);
    // Per-asset enrichment splits into two independent pipelines:
    //   • image (per-asset, IPFS) — refreshes the avatar + extras-dependent
    //     regions (display-name, ticker-sub, description, external-url) once
    //     resolveImageUri lands. Warm cache via persistent _metadataExtraCache
    //     already populated those during skeleton render; this updates them
    //     when a previously-unseen asset's blob arrives.
    //   • holdings aggregate (one worker round-trip) — POST asset_ids +
    //     owner_pubkey, get back per-asset openings + my listings + my range
    //     listings server-pre-filtered. Replaces N×3 per-asset fetches with
    //     a single request.
    // Errors are swallowed: missing region content stays on skeleton's
    // placeholder so a flaky worker / IPFS gateway doesn't blank cards.
    for (let i = 0; i < arr.length; i++) {
      const h = arr[i];
      const card = cardNodes[i];
      const meta = getAssetMeta(h.assetIdHex);
      if (meta?.imageUri) {
        resolveImageUri(meta.imageUri).then(imgUrl => {
          card.querySelector('[data-region="avatar"]').innerHTML = avatarHTML(imgUrl);
          // Re-read extras: resolveImageUri populates _metadataExtraCache as
          // a side effect, so any blob with name/description/external_url is
          // now visible to the synchronous getMetadataExtras call.
          const extras2 = getMetadataExtras(meta.imageUri);
          const displayName2 = (extras2?.name && extras2.name.trim()) ? extras2.name : h.ticker;
          card.querySelector('[data-region="display-name"]').textContent = displayName2;
          card.querySelector('[data-region="ticker-sub"]').innerHTML = tickerSubHTML(displayName2, h.ticker);
          card.querySelector('[data-region="description"]').innerHTML = descriptionHTML(extras2);
          card.querySelector('[data-region="external-url"]').innerHTML = externalUrlHTML(extras2);
        }).catch(() => {});
      }
    }
    if (HOLDINGS_URL && arr.length) {
      fetch(withNet(HOLDINGS_URL), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_pubkey: ownerPubHex,
          asset_ids: arr.map(h => h.assetIdHex),
        }),
      })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j) return;
          const openingsByAid = j.openings || {};
          const listingsByAid = j.listings || {};
          const rangeListingsByAid = j.range_listings || {};
          for (let i = 0; i < arr.length; i++) {
            const h = arr[i];
            const card = cardNodes[i];
            const aidOpenings = Array.isArray(openingsByAid[h.assetIdHex]) ? openingsByAid[h.assetIdHex] : [];
            const aidListings = Array.isArray(listingsByAid[h.assetIdHex]) ? listingsByAid[h.assetIdHex] : [];
            const aidRangeListings = Array.isArray(rangeListingsByAid[h.assetIdHex]) ? rangeListingsByAid[h.assetIdHex] : [];
            const myUtxoKeys = new Set(h.utxos.map(u => `${u.utxo.txid}:${u.utxo.vout}`));
            const myPublishedCount = aidOpenings.filter(o => myUtxoKeys.has(`${o.txid}:${o.vout}`)).length;
            const totalPublishedCount = aidOpenings.length;
            card.querySelector('[data-region="verified-tag"]').innerHTML = verifiedTagHTML(myPublishedCount, h.utxos.length);
            card.querySelector('[data-region="meta-published"]').innerHTML = metaPublishedHTML(myPublishedCount);
            card.querySelector('[data-region="meta-asset-wide-published"]').innerHTML = metaAssetWidePublishedHTML(totalPublishedCount, myPublishedCount);
            const region = card.querySelector('[data-region="my-listings"]');
            // myListingsHTML re-applies the owner_pubkey + !expired filter; the
            // worker already pre-filtered to owner so it's a no-op pass, but
            // running it preserves the helper's contract (no special-cased
            // server-trust path).
            region.innerHTML = myListingsHTML(h, aidListings, aidRangeListings);
            region.querySelectorAll('button[data-act]').forEach(wireBtn);
          }
        })
        .catch(() => {});
    }
    setStatus('#holdings-status', `${arr.length} asset${arr.length > 1 ? 's' : ''}`);
    setTabBadge('holdings', arr.length);
  } catch (e) {
    list.innerHTML = `<div class="error">Scan failed: ${escapeHtml(e.message)}</div>`;
    setStatus('#holdings-status', '');
    console.error(e);
  }
}

// Render outstanding atomic offers (maker side). Each row probes the chain
// to compute current status — never relying solely on localStorage, since
// the offer could have been settled / cancelled / expired since last view.
//
// Status:
//   commit unspent + asset_utxo unspent + before expiry → open
//   commit unspent + asset_utxo unspent + after  expiry → expired
//   asset_utxo spent by AXFER reveal (commit also spent in same tx) → settled
//   asset_utxo spent by anything else                  → cancelled
//   commit spent independently                          → unusual / uncertain
async function renderOffers() {
  const section = $('#offers-section');
  const list = $('#offers-list');
  const statusEl = $('#offers-status');
  if (!list || !section) return;
  const offers = loadOpenOffers();
  if (!offers.length) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  if (statusEl) statusEl.textContent = `${offers.length} entr${offers.length === 1 ? 'y' : 'ies'}`;
  list.innerHTML = `<div class="muted" style="font-size:11px;">checking chain status…</div>`;

  const now = Math.floor(Date.now() / 1000);
  const checks = await Promise.all(offers.map(async o => {
    const [commitSp, assetSp] = await Promise.all([
      getOutspend(o.commit_txid, 0).catch(() => null),
      o.asset_utxo
        ? getOutspend(o.asset_utxo.txid, o.asset_utxo.vout).catch(() => null)
        : Promise.resolve(null),
    ]);
    let status, statusColor;
    if (assetSp?.spent) {
      if (commitSp?.spent && commitSp.txid && commitSp.txid === assetSp.txid) {
        status = 'settled'; statusColor = 'var(--green)';
      } else {
        status = 'cancelled'; statusColor = 'var(--ink-mid)';
      }
    } else if (commitSp?.spent) {
      status = 'commit spent (unusual)'; statusColor = 'var(--ink-mid)';
    } else if (o.expiry && o.expiry < now) {
      status = 'expired'; statusColor = 'var(--red)';
    } else if (commitSp == null && assetSp == null) {
      status = 'unknown (api error)'; statusColor = 'var(--ink-mid)';
    } else {
      status = 'open'; statusColor = 'var(--orange)';
    }
    return { o, status, statusColor };
  }));

  list.innerHTML = checks.map(({ o, status, statusColor }) => {
    const amt = o.amount ? fmtAssetAmount(BigInt(o.amount), o.decimals || 0) : '';
    const expIso = o.expiry ? new Date(o.expiry * 1000).toISOString().replace('T', ' ').slice(0, 16) : '—';
    const isOpen = status === 'open';
    const canForget = !isOpen;
    return `
      <div class="offer-row" data-commit-txid="${escapeHtml(o.commit_txid)}">
        <div class="offer-line">
          <span class="offer-status" style="color:${statusColor};">${escapeHtml(status)}</span>
          <span class="offer-asset">${escapeHtml(amt)} ${escapeHtml(o.ticker || '?')}</span>
          <span class="offer-price muted">${(o.price_sats || 0).toLocaleString()} sats</span>
        </div>
        <div class="offer-line muted" style="font-size:10px;">
          to ${escapeHtml(shorten(o.recipient_pubkey || '', 8))} · expires ${escapeHtml(expIso)} · commit <a href="${NET.explorer}/tx/${escapeHtml(o.commit_txid)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shorten(o.commit_txid, 6))} ↗</a>
        </div>
        <div class="offer-line" style="gap:6px;">
          <button data-offer-act="copy" data-commit-txid="${escapeHtml(o.commit_txid)}" type="button" style="font-size:10px;padding:4px 9px;">Copy JSON</button>
          ${isOpen ? `<button data-offer-act="cancel" data-commit-txid="${escapeHtml(o.commit_txid)}" type="button" style="font-size:10px;padding:4px 9px;">Cancel</button>` : ''}
          ${canForget ? `<button data-offer-act="forget" data-commit-txid="${escapeHtml(o.commit_txid)}" type="button" style="font-size:10px;padding:4px 9px;">Dismiss</button>` : ''}
        </div>
      </div>`;
  }).join('');

  list.onclick = async (ev) => {
    const btn = ev.target.closest('[data-offer-act]');
    if (!btn) return;
    const act = btn.dataset.offerAct;
    const commitTxid = btn.dataset.commitTxid;
    const stored = loadOpenOffers().find(o => o.commit_txid === commitTxid);
    if (!stored) { renderOffers(); return; }
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(stored.json); toast('Offer JSON copied', 'success'); }
      catch { toast('Clipboard unavailable', 'error'); }
    } else if (act === 'forget') {
      forgetOpenOffer(commitTxid);
      renderOffers();
    } else if (act === 'cancel') {
      const amtStr = stored.amount ? fmtAssetAmount(BigInt(stored.amount), stored.decimals || 0) : '';
      if (!confirm(
        `Cancel this atomic offer?\n\n` +
        `Selling: ${amtStr} ${stored.ticker} (${shorten(stored.asset_id, 8)})\n\n` +
        `Cancellation spends the listed asset UTXO via a CXFER self-send. The asset is preserved; the original commit's value (≈DUST + reveal fee) is forfeit.\n\n` +
        `This costs a normal CXFER's commit + reveal fees in BTC.`,
      )) return;
      btn.disabled = true; btn.textContent = 'cancelling…';
      try {
        await cancelAxferOffer(commitTxid);
        toast('Atomic offer cancelled — listed UTXO consumed by self-send', 'success');
        renderOffers(); renderHoldings(); renderActivity();
      } catch (e) {
        toast('Cancel failed: ' + e.message, 'error');
        btn.disabled = false; btn.textContent = 'Cancel';
      }
    }
  };
}

// Render the local activity log inside the Holdings tab. Pure UX: reads from
// localStorage only, no network calls.
const ACTIVITY_VERBS = {
  'etch':         'Etched',
  'mint':         'Minted',
  'burn':         'Burned',
  'transfer-out': 'Sent',
  'transfer-in':  'Received',
  'list-atomic':  'Listed',
  // Public-mint (T_PETCH-rooted) flow — distinct from CETCH 'etch'/'mint' so
  // the activity log preserves the trust-model distinction (zero deployer
  // allocation; cap-credit at depth ≥ 3) instead of collapsing both into
  // generic verbs that hide the difference.
  'petch':        'Deployed',
  'pmint':        'Minted',
};
function relTime(ts) {
  const d = Math.max(0, Date.now() - Number(ts));
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h ago`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)}d ago`;
  try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
}
function renderActivity() {
  const list = $('#activity-list');
  const status = $('#activity-status');
  const clearBtn = $('#btn-activity-clear');
  if (!list) return;
  const entries = loadActivity();
  if (!entries.length) {
    list.innerHTML = `<div class="empty" style="font-size:12px;">No activity yet on ${escapeHtml(NET.name)}. Etches, transfers, mints, burns, and received share-links you process on this device will appear here.</div>`;
    if (status) status.textContent = '';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (status) status.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
  if (clearBtn) {
    clearBtn.style.display = '';
    clearBtn.onclick = () => {
      if (!confirm(`Clear ${entries.length} local activity ${entries.length === 1 ? 'entry' : 'entries'} for ${NET.name}?`)) return;
      try { localStorage.removeItem(activityKey()); } catch {}
      _invalidateLocalActivityCaches();  // all four pills depend on activity
      renderActivity();
    };
  }
  const rows = entries.map(e => {
    const verb = ACTIVITY_VERBS[e.kind] || e.kind;
    const amtStr = e.amount ? fmtAssetAmount(BigInt(e.amount), e.decimals || 0) : '';
    const tickerStr = e.ticker ? escapeHtml(e.ticker) : '';
    const txLink = e.txid
      ? `<a href="${NET.explorer}/tx/${escapeHtml(e.txid)}" target="_blank" rel="noopener noreferrer" class="muted" style="font-size:10px;">tx ${escapeHtml(shorten(e.txid, 6))} ↗</a>`
      : '';
    return `
      <div class="activity-row">
        <span class="activity-kind activity-${escapeHtml(e.kind)}">${escapeHtml(verb)}</span>
        <span class="activity-amount">${escapeHtml(amtStr)}${tickerStr ? ' ' + tickerStr : ''}</span>
        <span class="activity-time muted">${escapeHtml(relTime(e.ts))}</span>
        <span class="activity-tx">${txLink}</span>
      </div>`;
  }).join('');
  list.innerHTML = rows;
}

// Fire-and-forget targeted-scan hint. After a successful etch/mint broadcast,
// poke the worker with the reveal txid so the registry indexes it immediately
// instead of waiting on the 5-min cron tick. Retries on 404 because mempool.space
// often lags a few seconds behind broadcast — without retry, the hint fails
// silently and the etch only appears in Discover after the next cron scan
// (potentially many minutes on mainnet, where SCAN_BLOCKS_MAINNET=1). The cron
// is still the source of truth; this is purely a UX fast-path.
function postHint(revealTxid, revealVout = 0, opts = {}) {
  if (!HINT_URL || !revealTxid) return;
  // Optional last-trade fields — only meaningful for AXFER hints (atomic
  // intent settlements). The worker validates the tx is an AXFER for the
  // declared asset before recording the trade; if the caller supplies them
  // for a non-AXFER hint they're ignored server-side.
  const tradeBody = (Number.isInteger(opts.price_sats) && opts.price_sats > 0
                    && opts.amount != null)
    ? { price_sats: opts.price_sats, amount: String(opts.amount) }
    : null;
  const delays = [0, 3000, 8000, 20000, 60000]; // ~90s total before giving up
  (async () => {
    for (const d of delays) {
      if (d > 0) await new Promise(r => setTimeout(r, d));
      try {
        const resp = await fetch(withNet(HINT_URL), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reveal_txid: revealTxid,
            reveal_vout: revealVout,
            ...(tradeBody || {}),
          }),
        });
        // 2xx → indexed, done. 404 → tx not yet on mempool, retry. Other 4xx/5xx
        // (rate-limit, malformed, worker error) → don't retry, cron will catch it.
        if (resp.ok) return;
        if (resp.status !== 404) return;
      } catch { /* network blip — let the next delay retry */ }
    }
  })();
}

async function renderRecentEtches() {
  const section = $('#recent-etches-section');
  const list = $('#recent-etches-list');
  if (!REGISTRY_URL) { section.style.display = 'none'; return; }
  try {
    // Reuse loadDiscoverRegistry's 60s cache rather than a separate
    // limit=6 fetch. Two reasons:
    //   1. We need the full list to compute ticker-collision precedence
    //      correctly — if we only see 6 of N assets, a duplicate-ticker
    //      asset that shows up here without its earlier-etched sibling
    //      would be marked `original` instead of `duplicate`, defeating
    //      the spoof warning.
    //   2. The cache is shared with the Discover tab, so a user who hits
    //      Discover first pays zero extra; a wallet-first user warms it
    //      for Discover.
    // Worker is parallelized so the full hydration stays fast (~150ms
    // for 30 assets); if N grows past a few hundred we'd want a worker-
    // side `summary=0` flag that skips count/burns hydration.
    // Pull /assets (CETCH-rooted) and /petch-assets (T_PETCH-rooted public
    // mints) in parallel and merge by etched_at so the lander shows both
    // issuance models together. Petch entries stamp `kind:'petch'` (set by
    // the worker) which the tile renderer reads to add the ⚡ public mint
    // pill. Without this merge, fair launches would never appear here even
    // though Discover surfaces them in a dedicated section.
    const [j, petchJ] = await Promise.all([
      loadDiscoverRegistry(),
      PETCH_REGISTRY_URL
        ? fetch(withNet(PETCH_REGISTRY_URL))
            .then(r => r.ok ? r.json() : { assets: [] })
            .catch(() => ({ assets: [] }))
        : Promise.resolve({ assets: [] }),
    ]);
    const cetchAssets = j.assets || [];
    const petchAssets = (petchJ.assets || []).map(p => ({ ...p, kind: 'petch' }));
    const allAssets = [...cetchAssets, ...petchAssets];
    // Mark ticker collisions over the FULL list (first-etched wins) before
    // we trim to 6, so a duplicate that happens to be in the recent slice
    // gets correctly flagged against its earlier-etched sibling that isn't.
    markTickerCollisions(allAssets);
    // Network stats — directory-level signals only (assets etched, mintable
    // count, public-mint count). Marketplace state (live offers, floor) lives
    // on the Market tab to keep the lander uncluttered.
    const statsEl = $('#recent-etches-stats');
    if (statsEl) {
      const totalAssets = allAssets.length;
      const totalMintable = cetchAssets.filter(a => a.mintable).length;
      const totalPetch = petchAssets.length;
      statsEl.style.display = 'flex';
      statsEl.style.gap = '14px';
      statsEl.style.flexWrap = 'wrap';
      const petchLine = totalPetch > 0
        ? ` · <span class="muted">${totalPetch} public-mint</span>`
        : '';
      statsEl.innerHTML =
        `<span><strong>${totalAssets}</strong> asset${totalAssets === 1 ? '' : 's'} etched</span>` +
        ` · <span class="muted">${totalMintable} mintable</span>` +
        petchLine +
        ` · <span class="muted">${escapeHtml(NET.name)}</span>`;
    }
    // Lander sort toggle: "recent" (default, worker order) vs "active"
    // (cumulative activity — transfers + offers + mints + burns). Persisted
    // in localStorage so a user who prefers "active" doesn't have to re-pick
    // every reload. Honest UI label: "Most active", not "Trending" — without
    // timestamps on the per-tx transfer index, we can only sort cumulative.
    const toggleEl = $('#recent-etches-toggle');
    if (toggleEl) {
      // Show the toggle only when there are assets to sort. Explicitly hide
      // on empty networks so a user switching from a populated network to
      // an empty one doesn't see a stranded toggle row above the empty
      // state hint.
      if (allAssets.length > 0) {
        toggleEl.style.display = 'flex';
        toggleEl.querySelectorAll('[data-lander-sort]').forEach(b => {
          b.classList.toggle('active', b.dataset.landerSort === _landerSort);
          b.onclick = () => {
            if (b.dataset.landerSort === _landerSort) return;
            _landerSort = b.dataset.landerSort;
            try { localStorage.setItem('tacit-lander-sort-v1', _landerSort); } catch {}
            renderRecentEtches();
          };
        });
      } else {
        toggleEl.style.display = 'none';
      }
    }
    // Default "recent" sort merges both registries by etched_at desc — without
    // the explicit sort, the array order ([...cetch, ...petch]) would push all
    // petches behind all CETCHes regardless of when they were actually deployed.
    let sorted = [...allAssets].sort((x, y) =>
      (Number(y.etched_at) || 0) - (Number(x.etched_at) || 0));
    if (_landerSort === 'active') {
      // Composite "activity" signal — for CETCH: transfers + offers + mints +
      // burns. For petch: transfers + pmint_count (every public mint counts as
      // one activity event). Without the petch branch, fair launches would
      // always sort to zero and disappear from the active view.
      const score = (a) => {
        if (a.kind === 'petch') {
          return (Number(a.transfer_count || 0)) + (Number(a.pmint_count || 0));
        }
        return (Number(a.transfer_count || 0))
             + (Number(a.listing_count || 0)) + (Number(a.range_listing_count || 0)) + (Number(a.atomic_intent_count || 0))
             + (Array.isArray(a.mints) ? a.mints.length : 0)
             + (Array.isArray(a.burns) ? a.burns.length : 0);
      };
      sorted = [...allAssets].sort((x, y) => {
        const ya = score(y), xa = score(x);
        if (ya !== xa) return ya - xa;
        // Tiebreaker: newer first so two zero-activity assets surface in
        // recency order, matching the "recent" view's instinct.
        return (Number(y.etched_at) || 0) - (Number(x.etched_at) || 0);
      });
    }
    const assets = sorted.slice(0, 6);
    if (!assets.length) {
      list.innerHTML = `<div class="muted" style="padding:14px;text-align:center;font-style:italic;">No assets etched on ${escapeHtml(NET.name)} yet — be the first.</div>`;
      return;
    }
    // Same client-side validation as Discover. The teaser is a smaller surface
    // but still surfaces ticker strings — without verification a malicious
    // worker could spoof "USDT" thumbnails on the wallet tab. Reuses the
    // verifyDiscoverAsset cache so users pay the verification cost once
    // across the wallet teaser and the Discover tab.
    //
    // Progressive paint: tiles render immediately with worker-supplied text
    // and a "verifying…" badge, then update in-place as each verify + image
    // resolves. Avoids the all-or-nothing wait where the slowest of 6 ancestry
    // walks (cold-cache CETCH validation) gates the entire grid. Same security
    // model as Discover: worker strings are visibly marked unverified until
    // chain-verify swaps in canonical values.
    //
    // Re-paints reuse the same `<a class="recent-tile">` node, so the click
    // handler bound at construction time stays attached across updates.
    const paintTile = (tile, a, v, imgUrl) => {
      const safeAssetId = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
      const ageMin = Math.max(0, Math.floor((Date.now()/1000 - (a.etched_at || 0)) / 60));
      const ageStr = ageMin < 60 ? `${ageMin}m ago` : ageMin < 1440 ? `${Math.floor(ageMin/60)}h ago` : `${Math.floor(ageMin/1440)}d ago`;
      // Petch (T_PETCH-rooted public-mint deployments) skip CETCH-style
      // verify — there's no Pedersen commitment to open and the worker's
      // stored fields are all publicly auditable from chain. We render the
      // worker's ticker directly with a ⚡ pill instead of the CETCH ✓/✗
      // chain-verify mark.
      const isPetch = a.kind === 'petch';
      // Pre-verify (v=null): show worker ticker on a "verifying…" placeholder
      // so the tile isn't blank. After verify lands we swap in canonical text.
      const ticker = isPetch
        ? (typeof a.ticker === 'string' ? a.ticker : '?')
        : (v && v.ok ? v.ticker : (typeof a.ticker === 'string' ? a.ticker : '?'));
      // Read metadata-blob extras (name/description) from the *canonical*
      // image_uri when on-chain verification ran — the worker can otherwise
      // present a different image_uri whose blob spoofs name/description.
      // Pre-verify we leave displayName === ticker (no extras lookup).
      const _recentImg = isPetch
        ? a.image_uri
        : (v && v.ok ? v.imageUri : (v ? a.image_uri : null));
      const _recentExtras = _recentImg ? getMetadataExtras(_recentImg) : null;
      const displayName = (_recentExtras?.name && _recentExtras.name.trim()) ? _recentExtras.name : ticker;
      const verifyMark = isPetch
        ? ''
        : (!v
            ? ' · verifying…'
            : v.ok
              ? (v.mismatches && v.mismatches.length ? ' · ⚠' : ' · ✓')
              : ' · ✗');
      const pending = a.pending ? ' · pending' : '';
      // Ticker-collision marker. Computed across the FULL asset list above
      // (not just these 6) so a `duplicate` flag here is meaningful even
      // when the earlier-etched sibling isn't in the recent slice.
      const dupMark = a._tickerCollision === 'duplicate' ? ' · ⚠ DUP' : '';
      const petchMark = isPetch ? ' · ⚡ public mint' : '';
      tile.title = isPetch
        ? `${safeAssetId} · public-mint (T_PETCH) — anyone can mint up to the cap${a._tickerCollision === 'duplicate' ? ' · ⚠ ticker shared with an earlier asset' : ''}`
        : (!v
            ? `${safeAssetId} · verifying…`
            : v.ok
              ? `${safeAssetId}${v.mismatches && v.mismatches.length ? ' · worker mismatch: ' + v.mismatches.join(', ') : ' · chain-verified'}${a._tickerCollision === 'duplicate' ? ' · ⚠ ticker shared with an earlier asset' : ''}`
              : `${safeAssetId} · unverifiable: ${v.error || 'unknown'}`);
      const petchPill = isPetch
        ? ' <span style="display:inline-block;padding:0 4px;background:#7d4ff7;color:#fff;font-size:8px;border-radius:2px;font-style:normal;letter-spacing:0.05em;" title="Permissionless fair-launch (T_PETCH). Anyone can mint until cap fills.">⚡</span>'
        : '';
      tile.innerHTML = `
        ${imgUrl ? `<img loading="lazy" decoding="async" src="${escapeHtml(imgUrl)}" alt="">` : ''}
        <div class="recent-tile-body">
          <div class="recent-tile-ticker">${escapeHtml(displayName)}${displayName !== ticker ? ` <span style="font-family:var(--mono);font-size:9px;font-style:normal;color:var(--orange);letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(ticker)}</span>` : ''}${petchPill}${a._tickerCollision === 'duplicate' ? ' <span style="display:inline-block;padding:0 4px;background:var(--red);color:#fff;font-size:8px;border-radius:2px;font-style:normal;letter-spacing:0.05em;cursor:help;" title="Tickers aren\'t unique on tacit — asset_id is the canonical reference. Another asset claimed this ticker first; verify the asset_id before sending.">DUP</span>' : ''}</div>
          <div class="recent-tile-meta">${ageStr}${verifyMark}${petchMark}${pending}${dupMark}</div>
        </div>`;
    };
    // Build placeholder tiles synchronously and attach to the DOM in a single
    // reflow before kicking off any verify/image work.
    const grid = document.createElement('div');
    grid.className = 'recent-grid';
    const tileNodes = assets.map(a => {
      const safeAssetId = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
      const tile = document.createElement('a');
      tile.className = 'recent-tile';
      tile.href = '#';
      tile.onclick = (e) => {
        e.preventDefault();
        pendingDiscoverFocus = safeAssetId;
        $('.tab[data-tab="discover"]').click();
      };
      paintTile(tile, a, null, null);
      grid.appendChild(tile);
      return tile;
    });
    list.innerHTML = '';
    list.appendChild(grid);
    // Image fetches use the canonical image_uri from the verified envelope so
    // a bad worker can't redirect tile thumbnails through a tracking IPFS CID.
    // Per-tile pipeline: verify → repaint with badge → resolve image → repaint
    // with thumbnail. Independent across tiles; one slow ancestry walk doesn't
    // delay the others. Errors swallowed to keep one tile's failure from
    // breaking the grid (placeholder remains visible).
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      const tile = tileNodes[i];
      // Petches (T_PETCH-rooted) have no Pedersen commitment to verify and
      // no CETCH envelope — skip verify, paint directly with worker fields,
      // and resolve the image asynchronously. Same render shape, just no
      // ✓/✗ chain-verify mark.
      if (a.kind === 'petch') {
        paintTile(tile, a, null, null);
        if (a.image_uri) {
          resolveImageUri(a.image_uri)
            .then(url => { if (url) paintTile(tile, a, null, url); })
            .catch(() => {});
        }
        continue;
      }
      verifyDiscoverAsset(a)
        .catch(e => ({ ok: false, error: (e && e.message) || String(e) }))
        .then(v => {
          paintTile(tile, a, v, null);
          const uri = v.ok ? v.imageUri : a.image_uri;
          if (!uri) return;
          return resolveImageUri(uri)
            .then(url => { if (url) paintTile(tile, a, v, url); })
            .catch(() => {});
        })
        .catch(() => {});
    }
  } catch (e) {
    list.innerHTML = `<div class="muted" style="padding:14px;text-align:center;">discovery unavailable</div>`;
    console.error(e);
  }
}

// ============== DISCOVER CLIENT-VALIDATION ==============
// The worker structurally decodes envelopes for the /assets registry but does
// no rangeproof / signature / asset_id verification — that's all client-side
// per SPEC §8. Without re-checking the envelope ourselves before rendering,
// a malicious or compromised worker could spoof tickers (fake "USDT" for a
// look-alike asset_id), wrong commitments, or fabricated mint events. The
// crypto argument is preserved either way (no inflation downstream of etch),
// but the *display layer* would mislead.
//
// Verification is split into four independent stages, each with a persistent
// localStorage cache (chain-immutable results live forever):
//
//   1. Etch verify (verifyDiscoverAsset)    — on-chain CETCH validation,
//      returns canonical (ticker, decimals, commitment, image_uri, mintable).
//   2. Attestation enrich (enrichDiscoverAttestation) — fetches the IPFS
//      metadata blob, verifies tacit_attest opens the on-chain commitment.
//   3. Mint enrich       (enrichDiscoverMints)        — per-mint_txid validation.
//   4. Burn enrich       (enrichDiscoverBurns)        — per-burn_txid validation.
//
// renderDiscover renders cards eagerly with worker-supplied data + a
// "verifying…" badge, then runs (1) per asset (worker pool), then kicks off
// (2)/(3)/(4) in the background — each stage updates its own card region so
// the user sees progressively-trusted data without blocking on slow IPFS
// fetches or per-mint chain walks.

// Persistent cache: results are deterministic against an immutable chain, so
// we never need to re-validate. Stored as a single JSON blob per network with
// LRU eviction at hard caps. Versioned so future shape changes can migrate.
const DISCOVER_CACHE_KEY_BASE = 'tacit-discover-cache-v1';
const DISCOVER_CACHE_VERSION = 1;
const DISCOVER_CACHE_MAX_ETCHES = 1000;
const DISCOVER_CACHE_MAX_ATTESTS = 1000;
const DISCOVER_CACHE_MAX_TXVERS = 5000;   // mints + burns each
// Negative entries (ok: false) are auto-expired so a transient failure (IPFS
// gateway flake, mempool.space rate-limit during a rescan) doesn't poison the
// cache forever. Positive entries are cryptographically bound to the immutable
// chain and never expire.
const DISCOVER_NEG_TTL_MS = 24 * 60 * 60 * 1000;
function _isExpiredNegative(e) {
  return e && e.ok === false && (Date.now() - (e.ts || 0)) > DISCOVER_NEG_TTL_MS;
}
function _discoverCacheKey() { return `${DISCOVER_CACHE_KEY_BASE}:${NET.name}`; }
let _discoverCache = null;          // lazily loaded on first access
let _discoverCacheDirty = false;
let _discoverCacheFlushTimer = null;
function _loadDiscoverCache() {
  if (_discoverCache) return _discoverCache;
  try {
    const raw = localStorage.getItem(_discoverCacheKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === DISCOVER_CACHE_VERSION) {
        _discoverCache = {
          etches:  parsed.etches  && typeof parsed.etches  === 'object' ? parsed.etches  : {},
          attests: parsed.attests && typeof parsed.attests === 'object' ? parsed.attests : {},
          mints:   parsed.mints   && typeof parsed.mints   === 'object' ? parsed.mints   : {},
          burns:   parsed.burns   && typeof parsed.burns   === 'object' ? parsed.burns   : {},
        };
        return _discoverCache;
      }
    }
  } catch { /* corrupted blob → start fresh */ }
  _discoverCache = { etches: {}, attests: {}, mints: {}, burns: {} };
  return _discoverCache;
}
function _evictDiscoverCacheOldest() {
  // For each category, sort entries by timestamp asc and drop the oldest down
  // to the cap. ts is set on every set; entries without ts are treated as 0.
  const cap = (cat, limit) => {
    const c = _discoverCache[cat];
    const keys = Object.keys(c);
    if (keys.length <= limit) return;
    keys.sort((a, b) => (c[a].ts || 0) - (c[b].ts || 0));
    const toDrop = keys.length - limit;
    for (let i = 0; i < toDrop; i++) delete c[keys[i]];
  };
  cap('etches',  DISCOVER_CACHE_MAX_ETCHES);
  cap('attests', DISCOVER_CACHE_MAX_ATTESTS);
  cap('mints',   DISCOVER_CACHE_MAX_TXVERS);
  cap('burns',   DISCOVER_CACHE_MAX_TXVERS);
}
function _scheduleDiscoverCacheFlush() {
  _discoverCacheDirty = true;
  if (_discoverCacheFlushTimer) return;
  _discoverCacheFlushTimer = setTimeout(() => {
    _discoverCacheFlushTimer = null;
    if (!_discoverCacheDirty) return;
    _discoverCacheDirty = false;
    const blob = JSON.stringify({ v: DISCOVER_CACHE_VERSION, ...(_discoverCache || {}) });
    try { localStorage.setItem(_discoverCacheKey(), blob); }
    catch {
      // QuotaExceededError → drop oldest entries and retry once. If the retry
      // also fails we simply leave the cache in-memory for this session.
      try {
        _evictDiscoverCacheOldest();
        localStorage.setItem(_discoverCacheKey(), JSON.stringify({ v: DISCOVER_CACHE_VERSION, ...(_discoverCache || {}) }));
      } catch { /* give up */ }
    }
  }, 1000);   // debounce: many writes during a single render coalesce
}
function getCachedDiscoverEtch(assetId, etchTxid) {
  const c = _loadDiscoverCache();
  const e = c.etches[assetId];
  if (!e || !e.ok) return null;
  // Sanity: if a worker reports a different etch_txid than the cached one,
  // drop the cache entry. asset_id collisions shouldn't happen (asset_id is
  // sha256-bound to etch_txid) but defensive: a poisoned cache entry from
  // some unknown vector should not silently override a fresh verify.
  if (etchTxid && e.etch_txid !== etchTxid) return null;
  return e;
}
function setCachedDiscoverEtch(assetId, entry) {
  if (!entry) return;
  const c = _loadDiscoverCache();
  c.etches[assetId] = { ...entry, ts: Date.now() };
  if (Object.keys(c.etches).length > DISCOVER_CACHE_MAX_ETCHES * 1.2) _evictDiscoverCacheOldest();
  _scheduleDiscoverCacheFlush();
}
function getCachedDiscoverAttest(assetId) {
  const c = _loadDiscoverCache();
  const e = c.attests[assetId];
  // Expire stale negatives so a transient IPFS gateway failure doesn't
  // permanently hide a real attestation. Positives never expire.
  if (_isExpiredNegative(e)) return null;
  return e || null;
}
function setCachedDiscoverAttest(assetId, entry) {
  if (!entry) return;
  const c = _loadDiscoverCache();
  c.attests[assetId] = { ...entry, ts: Date.now() };
  if (Object.keys(c.attests).length > DISCOVER_CACHE_MAX_ATTESTS * 1.2) _evictDiscoverCacheOldest();
  _scheduleDiscoverCacheFlush();
}
function getCachedDiscoverMint(mintTxid) {
  const c = _loadDiscoverCache();
  const e = c.mints[mintTxid];
  // Expire stale negatives so a mempool API hiccup during validateOutpoint
  // doesn't permanently mark a real mint as phantom.
  if (_isExpiredNegative(e)) return null;
  return e || null;
}
function setCachedDiscoverMint(mintTxid, entry) {
  if (!entry) return;
  const c = _loadDiscoverCache();
  c.mints[mintTxid] = { ...entry, ts: Date.now() };
  if (Object.keys(c.mints).length > DISCOVER_CACHE_MAX_TXVERS * 1.2) _evictDiscoverCacheOldest();
  _scheduleDiscoverCacheFlush();
}
function getCachedDiscoverBurn(burnTxid) {
  const c = _loadDiscoverCache();
  const e = c.burns[burnTxid];
  // Expire stale negatives so a transient API failure doesn't permanently
  // mark a real burn as phantom.
  if (_isExpiredNegative(e)) return null;
  return e || null;
}
function setCachedDiscoverBurn(burnTxid, entry) {
  if (!entry) return;
  const c = _loadDiscoverCache();
  c.burns[burnTxid] = { ...entry, ts: Date.now() };
  if (Object.keys(c.burns).length > DISCOVER_CACHE_MAX_TXVERS * 1.2) _evictDiscoverCacheOldest();
  _scheduleDiscoverCacheFlush();
}

// In-memory caches (per session). _discoverVerifyCache short-circuits the
// localStorage round-trip for repeated lookups within one render. _discover-
// FetchCache is shared across all chain walks in this render so a tx referenced
// by multiple cards (e.g., a mint asset's etch tx) is only fetched once.
const _discoverVerifyCache = new Map();   // asset_id → result
const _discoverFetchCache = new Map();    // txid → tx (shared across the walk)
function _sharedFetchTx(id) {
  if (_discoverFetchCache.has(id)) return _discoverFetchCache.get(id);
  const p = getTx(id);
  // Dedup in-flight fetches but evict on rejection so a transient network
  // failure doesn't make the error sticky for the rest of the session.
  // (The .catch handler returns a new promise we discard; the original `p`
  // — which we cache and the caller awaits — still rejects normally.)
  p.catch(() => { if (_discoverFetchCache.get(id) === p) _discoverFetchCache.delete(id); });
  _discoverFetchCache.set(id, p);
  return p;
}

// ============== DISCOVER VERIFY: VIEWPORT-DRIVEN POOL ==============
// Pre-fix Discover walked every asset's chain on tab open, even ones the
// user never scrolled to. With many assets that wastes ~50–200ms of CPU
// each (rangeproof verification dominates). The replacement: each card
// registers an IntersectionObserver; only when it scrolls into view do
// we kick off its chain walk. Cache hits skip this gating because they
// cost essentially nothing and shouldn't delay the ✓ badge.
//
// Concurrency is capped via a single semaphore so the UI thread doesn't
// stall when many cards become visible simultaneously (e.g., on a fast
// scroll). Stats counters tick as work progresses; the stats line
// collapses once all cards are accounted for.
const DISCOVER_VERIFY_POOL_SIZE = 5;
let _discoverVerifySemaphoreN = DISCOVER_VERIFY_POOL_SIZE;
const _discoverVerifySemaphoreQ = [];
function _discoverVerifyAcquire() {
  if (_discoverVerifySemaphoreN > 0) { _discoverVerifySemaphoreN--; return Promise.resolve(); }
  return new Promise(resolve => _discoverVerifySemaphoreQ.push(resolve));
}
function _discoverVerifyRelease() {
  if (_discoverVerifySemaphoreQ.length) { _discoverVerifySemaphoreQ.shift()(); }
  else _discoverVerifySemaphoreN++;
}

let _discoverVerifyStats = { total: 0, verified: 0, failed: 0, cached: 0, pending: 0 };
function _setDiscoverVerifyStats(patch) {
  Object.assign(_discoverVerifyStats, patch);
  const el = $('#discover-verify-stats');
  if (!el) return;
  const { total, verified, failed, cached, pending } = _discoverVerifyStats;
  if (total === 0) { el.style.display = 'none'; return; }
  const done = verified + failed + cached;
  if (pending <= 0 && done >= total) {
    // All cards accounted for — collapse the indicator. Cached + verified
    // collapse into one count since both are equally "trusted by chain".
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  const parts = [];
  if (verified + cached > 0) parts.push(`${verified + cached} verified`);
  if (pending > 0)           parts.push(`${pending} pending`);
  if (failed > 0)            parts.push(`${failed} unverifiable`);
  el.textContent = `${parts.join(' · ')} of ${total} asset${total === 1 ? '' : 's'}`;
}

// Cards entering the viewport are pushed into a pending list and flushed
// 100ms later as a batch. The 100ms window is enough for the
// IntersectionObserver to fire for every card visible on initial paint,
// which lets us batch-verify their rangeproofs together via
// bpRangeAggBatchVerify (sub-linear in proof count — same trick
// scanHoldings already uses for wallet UTXO ancestry). Single-card flushes
// (a lone card scrolled into view later) skip batching since the overhead
// isn't worth it for one proof.
const DISCOVER_BATCH_DEBOUNCE_MS = 100;
let _discoverVerifyObserver = null;
let _discoverPendingItems = [];
let _discoverPendingTimer = null;
function _flushDiscoverPendingBatch() {
  const items = _discoverPendingItems;
  _discoverPendingItems = [];
  _discoverPendingTimer = null;
  if (items.length === 0) return;
  if (items.length === 1) {
    _processDiscoverCardVerify(items[0].card, items[0].asset);
  } else {
    _processBatchedDiscoverCardVerify(items);
  }
}
function _ensureDiscoverVerifyObserver() {
  if (_discoverVerifyObserver) return _discoverVerifyObserver;
  if (typeof IntersectionObserver === 'undefined') {
    // Fallback for browsers/environments without IntersectionObserver:
    // process every observed card immediately. Loses the CPU win but
    // preserves correctness; the legacy pool model is no worse than this.
    _discoverVerifyObserver = {
      observe(card) {
        if (card._discoverAsset) _processDiscoverCardVerify(card, card._discoverAsset);
      },
      unobserve() {},
    };
    return _discoverVerifyObserver;
  }
  _discoverVerifyObserver = new IntersectionObserver((entries) => {
    let added = false;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const card = e.target;
      _discoverVerifyObserver.unobserve(card);
      if (card.dataset.verifyState === 'pending' && card._discoverAsset) {
        _discoverPendingItems.push({ card, asset: card._discoverAsset });
        added = true;
      }
    }
    if (added) {
      if (_discoverPendingTimer) clearTimeout(_discoverPendingTimer);
      _discoverPendingTimer = setTimeout(_flushDiscoverPendingBatch, DISCOVER_BATCH_DEBOUNCE_MS);
    }
  }, { rootMargin: '300px 0px' }); // pre-warm the next ~screen of scroll-down cards
  return _discoverVerifyObserver;
}

// Run the full stage-1 verify path for a single card: chain walk, image
// resolution, primary render, then fan out background enrichment for
// attestation/mints/burns. Mirrors the body of the legacy POOL=5 loop
// but is per-card and gated by the semaphore + viewport observer above.
async function _processDiscoverCardVerify(card, a) {
  if (!card || !a) return;
  if (card.dataset.verifyState === 'verified' || card.dataset.verifyState === 'failed') return;
  card.dataset.verifyState = 'verifying';
  await _discoverVerifyAcquire();
  try {
    const cacheHit = !!getCachedDiscoverEtch(a.asset_id, a.etch_txid);
    const verify = await verifyDiscoverAsset(a)
      .catch(e => ({ ok: false, error: (e && e.message) || String(e),
                     mismatches: [], verifiedMints: {}, verifiedBurns: {}, ipfsAttest: null }));
    verify._assetId = a.asset_id;
    if (verify.ok && verify.etcherXonly) {
      _discoverRegisterEtcher(verify.etcherXonly, a.asset_id);
    }
    const effectiveImageUri = verify.ok ? verify.imageUri : a.image_uri;
    const imgUrl = effectiveImageUri ? await resolveImageUri(effectiveImageUri).catch(() => null) : null;
    const extras = effectiveImageUri ? getMetadataExtras(effectiveImageUri) : null;
    card.dataset.verifyState = verify.ok ? 'verified' : 'failed';
    renderDiscoverCard(card, a, verify, imgUrl, extras);
    applyDiscoverFilter();
    // Stats: cache hits and chain walks both move "pending" → "ok or fail",
    // but cached count is reported separately so the user can see how much
    // of the load was free.
    if (verify.ok) {
      _setDiscoverVerifyStats({
        verified: _discoverVerifyStats.verified + (cacheHit ? 0 : 1),
        cached:   _discoverVerifyStats.cached   + (cacheHit ? 1 : 0),
        pending:  Math.max(0, _discoverVerifyStats.pending - 1),
      });
    } else {
      _setDiscoverVerifyStats({
        failed:  _discoverVerifyStats.failed + 1,
        pending: Math.max(0, _discoverVerifyStats.pending - 1),
      });
    }
    // Stages 2-4 stay the same: per-asset background enrichment for IPFS
    // metadata, on-chain mints, on-chain burns. None awaited — each
    // updates the card itself when complete.
    if (verify.ok) {
      enrichDiscoverAttestation(verify)
        .then(() => { renderDiscoverCard(card, a, verify, imgUrl, extras); applyDiscoverFilter(); })
        .catch(() => {});
      enrichDiscoverMints(a, verify)
        .then(() => { verify._mintsEnriched = true; renderDiscoverCard(card, a, verify, imgUrl, extras); })
        .catch(() => { verify._mintsEnriched = true; renderDiscoverCard(card, a, verify, imgUrl, extras); });
      enrichDiscoverBurns(a, verify)
        .then(() => { verify._burnsEnriched = true; renderDiscoverCard(card, a, verify, imgUrl, extras); })
        .catch(() => { verify._burnsEnriched = true; renderDiscoverCard(card, a, verify, imgUrl, extras); });
      // Marketplace enrichments (price floor, open bids) are no longer
      // rendered on Discover cards — those surfaces moved to the Market tab.
      // Skipping the calls saves a worker round-trip per card on every load.
    }
  } finally {
    _discoverVerifyRelease();
  }
}

// Batched stage-1 verify across multiple cards entering view together. The
// chain walk runs per-asset (each has its own ancestry) but rangeproofs from
// every walk are pushed to a shared rpBatch and verified in one
// bpRangeAggBatchVerify call — same trick scanHoldings already uses for
// wallet UTXO ancestry. Sub-linear cost in number of proofs, so 12 cards
// verify in roughly the same wall-clock as 1 card. If the batch fails (an
// attacker-tampered chain in the visible set), we fall back to strict
// per-card verification so we can mark exactly which cards failed.
async function _processBatchedDiscoverCardVerify(items) {
  if (items.length === 0) return;
  if (items.length === 1) return _processDiscoverCardVerify(items[0].card, items[0].asset);
  // Mark cards as verifying upfront. Cards already in a terminal state are
  // dropped from the batch (a re-observe after verify is a no-op anyway).
  const live = [];
  for (const it of items) {
    if (it.card.dataset.verifyState === 'pending') {
      it.card.dataset.verifyState = 'verifying';
      live.push(it);
    }
  }
  if (live.length === 0) return;
  if (live.length === 1) return _processDiscoverCardVerify(live[0].card, live[0].asset);
  await _discoverVerifyAcquire();
  try {
    const rpBatch = [];
    const cacheHits = new Set();
    const canonicals = await Promise.all(live.map(async ({ asset }) => {
      const cached = getCachedDiscoverEtch(asset.asset_id, asset.etch_txid);
      if (cached) {
        cacheHits.add(asset.asset_id);
        return {
          ok: true, ticker: cached.ticker, decimals: cached.decimals,
          commitment: cached.commitment, imageUri: cached.imageUri,
          mintable: !!cached.mintable, mintAuthorityHex: cached.mintAuthorityHex,
          etcherXonly: cached.etcherXonly || null,
        };
      }
      try { return await _verifyDiscoverEtchOnlyBatched(asset, rpBatch); }
      catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
    }));
    let batchOk = rpBatch.length === 0;
    if (rpBatch.length > 0) {
      try { batchOk = bpRangeAggBatchVerify(rpBatch); } catch { batchOk = false; }
    }
    if (!batchOk) {
      // Fall back to strict per-card verify — the batch can't tell us which
      // entry's rangeproof failed without re-walking individually. Adversarial
      // chains are rare so this fallback is the cheap path on average.
      for (let i = 0; i < live.length; i++) {
        if (cacheHits.has(live[i].asset.asset_id)) continue;
        if (!canonicals[i].ok) continue;
        try { canonicals[i] = await _verifyDiscoverEtchOnly(live[i].asset); }
        catch (e) { canonicals[i] = { ok: false, error: (e && e.message) || String(e) }; }
      }
    }
    await Promise.all(live.map(async ({ card, asset }, i) => {
      const canonical = canonicals[i];
      if (canonical.ok && !cacheHits.has(asset.asset_id)) {
        setCachedDiscoverEtch(asset.asset_id, {
          etch_txid: asset.etch_txid,
          ok: true,
          ticker: canonical.ticker, decimals: canonical.decimals,
          commitment: canonical.commitment, imageUri: canonical.imageUri,
          mintable: canonical.mintable, mintAuthorityHex: canonical.mintAuthorityHex,
          etcherXonly: canonical.etcherXonly || null,
        });
      }
      const verify = canonical.ok
        ? {
            ok: true,
            ticker: canonical.ticker, decimals: canonical.decimals,
            commitment: canonical.commitment, imageUri: canonical.imageUri,
            mintable: canonical.mintable, mintAuthorityHex: canonical.mintAuthorityHex,
            etcherXonly: canonical.etcherXonly || null,
            ipfsAttest: null, verifiedMints: {}, verifiedBurns: {}, mismatches: [],
          }
        : { ok: false, error: canonical.error || 'unknown', mismatches: [], verifiedMints: {}, verifiedBurns: {}, ipfsAttest: null };
      if (verify.ok) {
        const m = [];
        if (typeof asset.ticker === 'string' && asset.ticker !== verify.ticker) m.push(`ticker (worker=${asset.ticker} vs chain=${verify.ticker})`);
        if (Number.isFinite(asset.decimals) && asset.decimals !== verify.decimals) m.push(`decimals (${asset.decimals} vs ${verify.decimals})`);
        if (typeof asset.commitment === 'string' && asset.commitment.toLowerCase() !== verify.commitment) m.push('commitment');
        if ((asset.image_uri || null) !== (verify.imageUri || null)) m.push('image_uri');
        verify.mismatches = m;
      }
      _discoverVerifyCache.set(asset.asset_id, verify);
      verify._assetId = asset.asset_id;
      const effectiveImageUri = verify.ok ? verify.imageUri : asset.image_uri;
      const imgUrl = effectiveImageUri ? await resolveImageUri(effectiveImageUri).catch(() => null) : null;
      const extras = effectiveImageUri ? getMetadataExtras(effectiveImageUri) : null;
      card.dataset.verifyState = verify.ok ? 'verified' : 'failed';
      renderDiscoverCard(card, asset, verify, imgUrl, extras);
      applyDiscoverFilter();
      if (verify.ok) {
        _setDiscoverVerifyStats({
          verified: _discoverVerifyStats.verified + (cacheHits.has(asset.asset_id) ? 0 : 1),
          cached:   _discoverVerifyStats.cached   + (cacheHits.has(asset.asset_id) ? 1 : 0),
          pending:  Math.max(0, _discoverVerifyStats.pending - 1),
        });
      } else {
        _setDiscoverVerifyStats({
          failed:  _discoverVerifyStats.failed + 1,
          pending: Math.max(0, _discoverVerifyStats.pending - 1),
        });
      }
      if (verify.ok) {
        enrichDiscoverAttestation(verify)
          .then(() => { renderDiscoverCard(card, asset, verify, imgUrl, extras); applyDiscoverFilter(); })
          .catch(() => {});
        enrichDiscoverMints(asset, verify)
          .then(() => { verify._mintsEnriched = true; renderDiscoverCard(card, asset, verify, imgUrl, extras); })
          .catch(() => { verify._mintsEnriched = true; renderDiscoverCard(card, asset, verify, imgUrl, extras); });
        enrichDiscoverBurns(asset, verify)
          .then(() => { verify._burnsEnriched = true; renderDiscoverCard(card, asset, verify, imgUrl, extras); })
          .catch(() => { verify._burnsEnriched = true; renderDiscoverCard(card, asset, verify, imgUrl, extras); });
        enrichDiscoverPriceFloor(asset, verify)
          .then(() => renderDiscoverCard(card, asset, verify, imgUrl, extras))
          .catch(() => {});
        enrichDiscoverBidCount(asset, verify)
          .then(() => renderDiscoverCard(card, asset, verify, imgUrl, extras))
          .catch(() => {});
      }
    }));
  } finally {
    _discoverVerifyRelease();
  }
}

// Stage 1 — etch validation. No IPFS, no mint/burn walks. Returns the
// canonical envelope fields. Persistent cache hit → no chain fetch at all.
async function verifyDiscoverAsset(a) {
  const aid = a.asset_id || '';
  if (!aid) return { ok: false, error: 'missing asset_id', mismatches: [], verifiedMints: {}, verifiedBurns: {}, ipfsAttest: null };
  if (_discoverVerifyCache.has(aid)) return _discoverVerifyCache.get(aid);
  let canonical;
  // Persistent cache: an etch is a one-time event and the chain is immutable,
  // so a cached "ok" is valid forever. Negative results are NOT cached
  // persistently (transient API failures shouldn't poison future loads).
  const cached = getCachedDiscoverEtch(aid, a.etch_txid);
  if (cached) {
    canonical = {
      ok: true,
      ticker:           cached.ticker,
      decimals:         cached.decimals,
      commitment:       cached.commitment,
      imageUri:         cached.imageUri,
      mintable:         !!cached.mintable,
      mintAuthorityHex: cached.mintAuthorityHex,
      etcherXonly:      cached.etcherXonly || null,
    };
  } else {
    canonical = await _verifyDiscoverEtchOnly(a)
      .catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
    if (canonical.ok) {
      setCachedDiscoverEtch(aid, {
        etch_txid:        a.etch_txid,
        ok:               true,
        ticker:           canonical.ticker,
        decimals:         canonical.decimals,
        commitment:       canonical.commitment,
        imageUri:         canonical.imageUri,
        mintable:         canonical.mintable,
        mintAuthorityHex: canonical.mintAuthorityHex,
        etcherXonly:      canonical.etcherXonly,
      });
    }
  }
  // Default placeholders so renderDiscoverCard reads uniformly. enrich-
  // Discover{Attestation,Mints,Burns} populate these in the background.
  canonical.ipfsAttest = canonical.ipfsAttest || null;
  canonical.verifiedMints = canonical.verifiedMints || {};
  canonical.verifiedBurns = canonical.verifiedBurns || {};
  // Mismatches are computed at every call against the *current* worker data
  // (worker entries can change between sessions; the cached canonical is
  // immutable). No persistence needed.
  if (canonical.ok) {
    const mismatches = [];
    if (typeof a.ticker === 'string' && a.ticker !== canonical.ticker) mismatches.push(`ticker (worker=${a.ticker} vs chain=${canonical.ticker})`);
    if (Number.isFinite(a.decimals) && a.decimals !== canonical.decimals) mismatches.push(`decimals (${a.decimals} vs ${canonical.decimals})`);
    if (typeof a.commitment === 'string' && a.commitment.toLowerCase() !== canonical.commitment) mismatches.push('commitment');
    if ((a.image_uri || null) !== (canonical.imageUri || null)) mismatches.push('image_uri');
    canonical.mismatches = mismatches;
  } else {
    canonical.mismatches = [];
  }
  _discoverVerifyCache.set(aid, canonical);
  return canonical;
}

// Variant of _verifyDiscoverEtchOnly that defers rangeproof verification to a
// shared rpBatch (caller runs bpRangeAggBatchVerify across many cards). All
// non-rangeproof checks (envelope decode, asset_id consistency, kernel sig)
// still run eagerly so non-rangeproof anomalies fail fast.
async function _verifyDiscoverEtchOnlyBatched(a, rpBatch) {
  if (!/^[0-9a-f]{64}$/.test(a.etch_txid || '')) return { ok: false, error: 'bad etch_txid' };
  if (!/^[0-9a-f]{64}$/.test(a.asset_id || ''))  return { ok: false, error: 'bad asset_id' };
  const aidComputed = bytesToHex(assetIdFor(a.etch_txid, 0));
  if (aidComputed !== a.asset_id) return { ok: false, error: 'asset_id ≠ sha256(etch_txid_BE‖0_LE)' };
  const validatedSet = new Map();
  const valid = await validateOutpoint(a.etch_txid, 0, validatedSet, _sharedFetchTx, 0, null, rpBatch);
  if (!valid) return { ok: false, error: 'on-chain CETCH failed validation (non-rangeproof)' };
  const etchTx = await _sharedFetchTx(a.etch_txid);
  let env;
  try { env = decodeEnvelopeScript(hexToBytes(etchTx.vin[0].witness[1])); } catch { return { ok: false, error: 'envelope decode failed' }; }
  if (!env || env.opcode !== T_CETCH) return { ok: false, error: 'parent is not CETCH' };
  const dec = decodeCEtchPayload(env.payload);
  if (!dec) return { ok: false, error: 'CETCH payload decode failed' };
  return {
    ok: true,
    ticker:           dec.ticker,
    decimals:         dec.decimals,
    commitment:       bytesToHex(dec.commitment),
    imageUri:         dec.imageUri,
    mintable:         dec.mintable,
    mintAuthorityHex: bytesToHex(dec.mintAuthority),
    etcherXonly:      bytesToHex(env.signingPubXonly),
  };
}

async function _verifyDiscoverEtchOnly(a) {
  if (!/^[0-9a-f]{64}$/.test(a.etch_txid || '')) return { ok: false, error: 'bad etch_txid' };
  if (!/^[0-9a-f]{64}$/.test(a.asset_id || ''))  return { ok: false, error: 'bad asset_id' };
  // asset_id consistency: must equal sha256(etch_txid_BE || vout=0_LE)
  const aidComputed = bytesToHex(assetIdFor(a.etch_txid, 0));
  if (aidComputed !== a.asset_id) return { ok: false, error: 'asset_id ≠ sha256(etch_txid_BE‖0_LE)' };
  // Recursive validator: envelope decode + opcode==CETCH + vout==0 +
  // range proof verifies. validatedSet is per-asset to avoid sharing across
  // verifications.
  const validatedSet = new Map();
  const valid = await validateOutpoint(a.etch_txid, 0, validatedSet, _sharedFetchTx);
  if (!valid) return { ok: false, error: 'on-chain CETCH failed validation' };
  const etchTx = await _sharedFetchTx(a.etch_txid);
  let env;
  try { env = decodeEnvelopeScript(hexToBytes(etchTx.vin[0].witness[1])); } catch { return { ok: false, error: 'envelope decode failed' }; }
  if (!env || env.opcode !== T_CETCH) return { ok: false, error: 'parent is not CETCH' };
  const dec = decodeCEtchPayload(env.payload);
  if (!dec) return { ok: false, error: 'CETCH payload decode failed' };
  return {
    ok: true,
    ticker:           dec.ticker,
    decimals:         dec.decimals,
    commitment:       bytesToHex(dec.commitment),
    imageUri:         dec.imageUri,
    mintable:         dec.mintable,
    mintAuthorityHex: bytesToHex(dec.mintAuthority),
    // Etcher's signing pubkey from the envelope leaf script (BIP-340 x-only).
    // Stable identity per etcher across all their etches; surfaced on Discover
    // cards so users can group assets by creator. Canonical bech32 derives
    // from hash160(0x02 || xonly) — BIP-340 keys are even-Y by convention.
    etcherXonly:      bytesToHex(env.signingPubXonly),
  };
}

// Stage 2 — IPFS attestation lookup. Mutates `verify.ipfsAttest`. Returns the
// attestation if found, null otherwise. Persistent cache prevents repeated
// IPFS round-trips for assets we've already queried (positive AND negative
// results — IPFS fetches are slow enough that caching "no attest here" is
// worth the entry).
async function enrichDiscoverAttestation(verify) {
  if (!verify.ok) return null;
  if (verify.ipfsAttest) return verify.ipfsAttest;
  const aid = verify._assetId;
  if (!aid) return null;
  // Persistent cache check.
  const cached = getCachedDiscoverAttest(aid);
  if (cached) {
    if (cached.ok && cached.supply && cached.blinding) {
      verify.ipfsAttest = { supply: cached.supply, blinding: cached.blinding };
      return verify.ipfsAttest;
    }
    // Negative cache: we already tried and failed. Don't re-fetch.
    return null;
  }
  if (!verify.imageUri) {
    setCachedDiscoverAttest(aid, { ok: false });
    return null;
  }
  const url = normalizeImageUri(verify.imageUri);
  if (!url) {
    setCachedDiscoverAttest(aid, { ok: false });
    return null;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (resp.ok) {
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('json') || ct.includes('text/plain')) {
        const text = await resp.text();
        if (text.length < 8192) {
          const md = JSON.parse(text);
          const att = md && md.tacit_attest;
          if (att && /^\d+$/.test(String(att.supply || '')) && /^[0-9a-f]{64}$/.test(String(att.blinding || ''))) {
            const sup = BigInt(att.supply);
            const r = BigInt('0x' + att.blinding);
            if (sup >= 0n && sup < (1n << BigInt(N_BITS))
                && pedersenCommit(sup, r).equals(bytesToPoint(hexToBytes(verify.commitment)))) {
              const result = { supply: sup.toString(), blinding: att.blinding };
              verify.ipfsAttest = result;
              setCachedDiscoverAttest(aid, { ok: true, supply: result.supply, blinding: result.blinding });
              return result;
            }
          }
        }
      }
    }
  } catch { /* abort, network error, parse error → fall through to negative cache */ }
  finally { clearTimeout(timer); }
  setCachedDiscoverAttest(aid, { ok: false });
  return null;
}

// Stage 3 — per-mint validation. Mutates `verify.verifiedMints`. Worker can
// fabricate mint entries to inflate displayed mint counts (the Pedersen
// attestation re-verification only checks (amount, blinding) opens the
// *commitment* the worker handed over — it doesn't check the commitment is
// actually on chain). Each mint must be a T_MINT envelope at vout=0
// referencing this asset_id. Persistent cache: mint_txids are immutable, so
// once validated we never re-walk that ancestor.
async function enrichDiscoverMints(a, verify) {
  if (!verify.ok) return;
  const claimedMints = Array.isArray(a.mints) ? a.mints : [];
  if (claimedMints.length === 0) return;
  for (const m of claimedMints) {
    const mtxid = m && m.mint_txid;
    if (!/^[0-9a-f]{64}$/.test(String(mtxid || ''))) continue;
    if (verify.verifiedMints[mtxid]) continue;
    const cached = getCachedDiscoverMint(mtxid);
    if (cached) {
      if (cached.ok && cached.asset_id === a.asset_id) {
        verify.verifiedMints[mtxid] = { commitment: cached.commitment, encryptedAmount: cached.encryptedAmount };
      }
      // Negative cache → skip; we already determined this mint is fake.
      continue;
    }
    try {
      const ok = await validateOutpoint(mtxid, 0, new Map(), _sharedFetchTx);
      if (!ok) { setCachedDiscoverMint(mtxid, { ok: false }); continue; }
      const mtx = await _sharedFetchTx(mtxid);
      const menv = decodeEnvelopeScript(hexToBytes(mtx.vin[0].witness[1]));
      if (!menv || menv.opcode !== T_MINT) { setCachedDiscoverMint(mtxid, { ok: false }); continue; }
      const md = decodeCMintPayload(menv.payload);
      if (!md) { setCachedDiscoverMint(mtxid, { ok: false }); continue; }
      if (bytesToHex(md.assetId) !== a.asset_id) { setCachedDiscoverMint(mtxid, { ok: false }); continue; }
      const entry = {
        ok: true,
        asset_id:        a.asset_id,
        commitment:      bytesToHex(md.commitment),
        encryptedAmount: bytesToHex(md.encryptedAmount),
      };
      setCachedDiscoverMint(mtxid, entry);
      verify.verifiedMints[mtxid] = { commitment: entry.commitment, encryptedAmount: entry.encryptedAmount };
    } catch { setCachedDiscoverMint(mtxid, { ok: false }); }
  }
}

// Stage 4 — per-burn validation. Mutates `verify.verifiedBurns` (BigInt) and
// pushes to `verify.mismatches` if a worker-claimed burn amount disagrees
// with the on-chain T_BURN envelope. Persistent cache of burned amounts as
// decimal strings (BigInt isn't JSON-serializable).
async function enrichDiscoverBurns(a, verify) {
  if (!verify.ok) return;
  const claimedBurns = Array.isArray(a.burns) ? a.burns : [];
  if (claimedBurns.length === 0) return;
  for (const b of claimedBurns) {
    const btxid = b && b.tx;
    if (!/^[0-9a-f]{64}$/.test(String(btxid || ''))) continue;
    if (verify.verifiedBurns[btxid] !== undefined) continue;
    const cached = getCachedDiscoverBurn(btxid);
    if (cached) {
      if (cached.ok && cached.asset_id === a.asset_id && typeof cached.burnedAmount === 'string') {
        try {
          const onChainBurn = BigInt(cached.burnedAmount);
          verify.verifiedBurns[btxid] = onChainBurn;
          // Re-check mismatch against the *current* worker claim (cached chain
          // truth is immutable; worker entries can change session to session).
          const workerBurn = (() => { try { return BigInt(b.burned_amount); } catch { return null; } })();
          if (workerBurn !== null && workerBurn !== onChainBurn) {
            const tag = `burn ${shorten(btxid, 6)} amount`;
            if (!verify.mismatches.includes(tag)) verify.mismatches.push(tag);
          }
        } catch { /* malformed cache entry */ }
      }
      continue;
    }
    try {
      const btx = await _sharedFetchTx(btxid);
      if (!btx?.vin?.[0]?.witness || btx.vin[0].witness.length < 3) { setCachedDiscoverBurn(btxid, { ok: false }); continue; }
      const benv = decodeEnvelopeScript(hexToBytes(btx.vin[0].witness[1]));
      if (!benv || benv.opcode !== T_BURN) { setCachedDiscoverBurn(btxid, { ok: false }); continue; }
      const bd = decodeCBurnPayload(benv.payload);
      if (!bd) { setCachedDiscoverBurn(btxid, { ok: false }); continue; }
      if (bytesToHex(bd.assetId) !== a.asset_id) { setCachedDiscoverBurn(btxid, { ok: false }); continue; }
      const onChainBurn = bd.burnedAmount;
      setCachedDiscoverBurn(btxid, { ok: true, asset_id: a.asset_id, burnedAmount: onChainBurn.toString() });
      verify.verifiedBurns[btxid] = onChainBurn;
      const workerBurn = (() => { try { return BigInt(b.burned_amount); } catch { return null; } })();
      if (workerBurn !== null && workerBurn !== onChainBurn) {
        if (!verify.mismatches.includes(`burn ${shorten(btxid, 6)} amount`)) {
          verify.mismatches.push(`burn ${shorten(btxid, 6)} amount`);
        }
      }
    } catch { setCachedDiscoverBurn(btxid, { ok: false }); }
  }
}

// Stage 5 — price floor enrichment. Fetches active per-UTXO listings and
// atomic intents for the asset, computes the lowest sats-per-smallest-unit
// across all of them, and stores it on `verify._priceFloorPpu`. Range
// listings are skipped because their amount is a lower-bound ("≥ K"), not
// an exact deliverable amount, so per-unit price isn't well-defined for them.
//
// Combined with the chain-attested supply (etch + Σ mint − Σ burn) this
// gives us a coarse market cap estimate per asset for the Discover card.
// Lowest-ask is a price-discovery floor — not a true mid-market until
// bid-side intents (§5.7.7) ship.
async function enrichDiscoverPriceFloor(a, verify) {
  if (!verify || !verify.ok) return;
  if (!WORKER_BASE) return;
  if (verify._priceFloorEnriched) return;
  // Ignore assets without claimed offers — saves the round-trip when there's
  // nothing to find. The registry's coarse counts already filter this case.
  const hasAnyOffer = Number(a.listing_count || 0) > 0 || Number(a.atomic_intent_count || 0) > 0;
  if (!hasAnyOffer) {
    verify._priceFloorEnriched = true;
    verify._priceFloorPpu = null;
    return;
  }
  try {
    const [listResp, intentResp] = await Promise.all([
      Number(a.listing_count || 0) > 0
        ? fetch(`${WORKER_BASE}/assets/${a.asset_id}/listings?network=${encodeURIComponent(NET.name)}`).then(r => r.ok ? r.json() : null).catch(() => null)
        : null,
      Number(a.atomic_intent_count || 0) > 0
        ? fetch(`${WORKER_BASE}/assets/${a.asset_id}/atomic-intents?network=${encodeURIComponent(NET.name)}`).then(r => r.ok ? r.json() : null).catch(() => null)
        : null,
    ]);
    const now = Math.floor(Date.now() / 1000);
    const items = [];
    for (const l of (listResp?.listings || [])) {
      if (!l || l.expired) continue;
      if (Number(l.expiry || 0) <= now) continue;
      items.push({ amount: l.amount, price_sats: l.price_sats });
    }
    for (const it of (intentResp?.intents || [])) {
      if (!it) continue;
      if (Number(it.expiry || 0) <= now) continue;
      items.push({ amount: it.amount, price_sats: it.price_sats });
    }
    let floor = null;
    for (const it of items) {
      let amt;
      try { amt = BigInt(it.amount || 0); } catch { continue; }
      const price = Number(it.price_sats || 0);
      if (amt <= 0n || !Number.isFinite(price) || price <= 0) continue;
      // sats-per-smallest-unit. Use Number(amt) because amt is bounded by
      // u64 range and any value that overflows Number's safe integer would
      // already be unrealistically large; rendering precision matters more
      // than perfect numerics for a UI floor display.
      const ppu = price / Number(amt);
      if (!Number.isFinite(ppu)) continue;
      if (floor === null || ppu < floor) floor = ppu;
    }
    verify._priceFloorPpu = floor;
  } catch {
    verify._priceFloorPpu = null;
  } finally {
    verify._priceFloorEnriched = true;
  }
}

// Stage 6 — bid-intent count. Cheap GET against /bid-intents that returns
// an active count + the full list (which we cache for the bid panel toggle).
// Worker GC's expired bids at read time, so the count we display reflects
// only live, claimable bids.
async function enrichDiscoverBidCount(a, verify) {
  if (!verify || !verify.ok) return;
  if (!WORKER_BASE) return;
  if (verify._bidCountEnriched) return;
  try {
    const url = `${WORKER_BASE}/assets/${a.asset_id}/bid-intents?network=${encodeURIComponent(NET.name)}`;
    const resp = await fetch(url);
    if (!resp.ok) { verify._bidCount = 0; return; }
    const j = await resp.json();
    verify._bidCount = Number(j.count || 0);
    verify._bidIntents = Array.isArray(j.intents) ? j.intents : [];
  } catch {
    verify._bidCount = 0;
  } finally {
    verify._bidCountEnriched = true;
  }
}

// Registry response cache (E). Tab-switches don't refetch /assets unless the
// cache is older than the TTL. The Refresh button bypasses by clearing the
// cache before re-rendering.
const DISCOVER_REGISTRY_CACHE_TTL_MS = 60 * 1000;
let _discoverRegistryCache = { net: null, fetchedAt: 0, data: null };
async function loadDiscoverRegistry(force = false) {
  const now = Date.now();
  if (!force
      && _discoverRegistryCache.net === NET.name
      && (now - _discoverRegistryCache.fetchedAt) < DISCOVER_REGISTRY_CACHE_TTL_MS
      && _discoverRegistryCache.data) {
    return _discoverRegistryCache.data;
  }
  const resp = await fetch(withNet(REGISTRY_URL));
  const j = await resp.json();
  _discoverRegistryCache = { net: NET.name, fetchedAt: now, data: j };
  return j;
}
// Force the next loadDiscoverRegistry() call to bypass the TTL. Called by any
// flow that mutates marketplace state (cancel-listing, cancel-atomic-intent,
// cancel-range-listing) so the offer-count / floor / atomic-pill on Discover
// cards reflect the change without waiting up to 60s for the TTL to lapse.
// If Discover is currently mounted, also re-render so the user sees the
// update without manually clicking Refresh.
function invalidateDiscoverRegistryCache() {
  _discoverRegistryCache = { net: null, fetchedAt: 0, data: null };
  // Also drop the per-asset attest / mint / burn negative-cache entries
  // — those are cheap to refetch and stale negatives can hide updates.
  // (Etch verifies are immutable so we keep those.)
  if (typeof renderDiscover === 'function'
      && document.querySelector('.tab.active[data-tab="discover"]')) {
    renderDiscover(true).catch(() => {});
  }
}

// Populate a Discover card after verification. `verify.ok` means the
// on-chain CETCH validated and the values shown are canonical; `!verify.ok`
// keeps worker-supplied strings but flags the card as unverifiable.
function renderDiscoverCard(card, a, verify, imgUrl, extras) {
  const safeAssetId = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
  const safeEtchTxid = /^[0-9a-f]{64}$/.test(a.etch_txid || '') ? a.etch_txid : '';
  // verify state machine:
  //   { ok: 'pending' }    — eager render: worker data shown, "verifying…" badge.
  //   { ok: false, error } — etch validation failed: worker data shown, ✗ badge.
  //   { ok: true, ... }    — etch validated, canonical fields available.
  //                          ipfsAttest / verifiedMints / verifiedBurns may still
  //                          be empty (background enrichment not yet done) —
  //                          gated by _attestEnriched / _mintsEnriched / _burnsEnriched.
  const pending = verify.ok === 'pending';
  const verified = verify.ok === true;
  // Canonical values come from the on-chain envelope when verified; otherwise
  // we render worker-supplied strings (regex-clamped for hex fields) under
  // either the pending or unverifiable badge.
  const ticker = verified ? verify.ticker : (typeof a.ticker === 'string' ? a.ticker : '?');
  // Discover-side display name — read off the metadata blob (cached by
  // resolveImageUri); falls back to the ticker so older assets render unchanged.
  // Source the URI from the on-chain verify when it succeeded, so a worker that
  // serves a different image_uri (whose IPFS blob spoofs name/description)
  // can't influence the displayed name once the chain has confirmed the asset.
  const _discoverImg = (verified && verify.imageUri) ? verify.imageUri : a.image_uri;
  const _discoverExtras = _discoverImg ? getMetadataExtras(_discoverImg) : null;
  const displayName = (_discoverExtras?.name && _discoverExtras.name.trim()) ? _discoverExtras.name : ticker;
  // Filter key: lowercase concatenation of name + ticker + asset_id, used by
  // the Discover search input to substring-match against card content.
  // Etcher identity: BIP-340 x-only signing pubkey from the CETCH envelope
  // leaf script. Renders as a bech32 derived from hash160(0x02 || xonly) —
  // BIP-340 keys are even-Y by convention, so 02-prefix gives the canonical
  // compressed form. Stable per etcher across all their etches; ends up in
  // filterKey so substring search by issuer bech32 narrows the registry to
  // one creator's assets.
  const etcherXonly = (verified && /^[0-9a-f]{64}$/.test(verify.etcherXonly || '')) ? verify.etcherXonly : null;
  let etcherAddr = null;
  if (etcherXonly) {
    try { etcherAddr = p2wpkhAddress(concatBytes(new Uint8Array([0x02]), hexToBytes(etcherXonly))); } catch { /* defensive */ }
  }
  if (etcherAddr) card.dataset.etcher = etcherAddr;
  card.dataset.filterKey = `${displayName} ${ticker} ${safeAssetId} ${etcherAddr || ''}`.toLowerCase();
  // Filter-pill attributes. Mintable comes from the canonical envelope so a
  // worker can't lie about it. Attested = the IPFS metadata blob carries a
  // tacit_attest that we've cryptographically verified opens the on-chain
  // commitment. Etched timestamp drives the "Recent" pill (24h window).
  card.dataset.mintable = (verified && verify.mintable) ? '1' : '0';
  card.dataset.attested = (verified && verify.ipfsAttest) ? '1' : '0';
  card.dataset.etchedAt = String(Number.isFinite(a.etched_at) ? a.etched_at : 0);
  // Pill + sort signals from worker-supplied counts. Coarse — these are raw
  // KV counts that may include not-yet-GC'd or unverified entries — but for
  // a "show me assets with any market activity" filter that's the right
  // granularity. The Market tab itself filters expired entries at render time.
  card.dataset.ticker = String(ticker || '').toLowerCase();
  const _offerCount = Number(a.listing_count || 0)
                    + Number(a.range_listing_count || 0)
                    + Number(a.atomic_intent_count || 0);
  // Pill predicates: the worker's counts only reflect what its cron has
  // indexed since it started running (mainnet starts at tip with no
  // backfill, signet backfills 2 weeks). Augment each pill with the user's
  // own local activity / offer log so a user who just sent / minted / burned
  // / listed sees the pill match immediately, even if the cron hasn't caught
  // up. Each Set is cached at module scope and invalidated by
  // recordActivity / saveOpenOffers, so per-card lookup is O(1).
  card.dataset.hasOffers = (_offerCount > 0 || _localOfferAssetIds().has(a.asset_id)) ? '1' : '0';
  card.dataset.hasMints = ((Array.isArray(a.mints) && a.mints.length > 0) || _localMintAssetIds().has(a.asset_id)) ? '1' : '0';
  card.dataset.hasBurns = ((Array.isArray(a.burns) && a.burns.length > 0) || _localBurnAssetIds().has(a.asset_id)) ? '1' : '0';
  card.dataset.hasTransfers = (Number(a.transfer_count || 0) > 0 || _localTransferAssetIds().has(a.asset_id)) ? '1' : '0';
  // Numeric counts on the dataset so the discover-sort comparator can rank
  // cards without re-reading the worker payload. transferCount comes from
  // the cron-maintained counter; offerCount aggregates the three orderbook
  // count fields. activityCount is the composite used by "Most active":
  // transfer count + offer count + mint count + burn count, equally
  // weighted. Coarse but cheap; a more nuanced score could weight by
  // recency (we'd need timestamped events) or by attestation status.
  const _xferCount = Number(a.transfer_count || 0);
  const _mintListCount = Array.isArray(a.mints) ? a.mints.length : 0;
  const _burnListCount = Array.isArray(a.burns) ? a.burns.length : 0;
  card.dataset.transferCount = String(_xferCount);
  card.dataset.offerCount = String(_offerCount);
  card.dataset.atomicCount = String(Number(a.atomic_intent_count || 0));
  card.dataset.activityCount = String(_xferCount + _offerCount + _mintListCount + _burnListCount);
  const decimals = verified ? verify.decimals
                  : (Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0);
  const safeHeight = Number.isInteger(a.etched_at_height) ? a.etched_at_height : null;
  const ageMin = Math.max(0, Math.floor((Date.now()/1000 - (a.etched_at || 0)) / 60));
  const ageStr = ageMin < 60 ? `${ageMin}m ago` : ageMin < 1440 ? `${Math.floor(ageMin/60)}h ago` : `${Math.floor(ageMin/1440)}d ago`;
  const avatar = imgUrl
    ? `<img loading="lazy" decoding="async" src="${escapeHtml(imgUrl)}" alt="" style="width:36px;height:36px;border:1px solid var(--ink);object-fit:cover;background:#fff;flex-shrink:0;">`
    : '';

  // Verification badge: ⏳ verifying (eager render) / ✗ unverifiable (failed) /
  // ⚠ mismatch (worker disagrees) / ✓ chain-verified (clean).
  let verifyBadge;
  if (pending) {
    verifyBadge = `<span style="font-size:10px;background:#fff8eb;color:var(--ink-mid);padding:2px 6px;border:1px solid var(--ink-faint);text-transform:uppercase;letter-spacing:0.1em;">⏳ verifying…</span>`;
  } else if (!verified) {
    verifyBadge = `<span style="font-size:10px;background:#fee;color:var(--red);padding:2px 6px;border:1px solid var(--red);text-transform:uppercase;letter-spacing:0.1em;cursor:help;" title="The on-chain CETCH envelope failed local verification — the rangeproof, kernel sig, or envelope decode rejected. Treat this asset as unsafe until the dApp can re-validate from chain.">✗ unverifiable · ${escapeHtml(verify.error || 'unknown')}</span>`;
  } else if (verify.mismatches && verify.mismatches.length) {
    verifyBadge = `<span style="font-size:10px;background:#fff8eb;color:#a04030;padding:2px 6px;border:1px solid #a04030;text-transform:uppercase;letter-spacing:0.1em;cursor:help;" title="Worker's metadata disagrees with the on-chain CETCH envelope. The dApp shows on-chain values (those are authoritative). Mismatches: ${escapeHtml(verify.mismatches.join('; '))}">⚠ worker mismatch</span>`;
  } else {
    verifyBadge = `<span style="font-size:10px;background:#eaf6ee;color:#0a7d4e;padding:2px 6px;border:1px solid #0a7d4e;text-transform:uppercase;letter-spacing:0.1em;cursor:help;" title="Rangeproof and CETCH envelope decoded + verified locally from chain bytes; worker's metadata matches the on-chain values. The asset's existence is cryptographically established, not just worker-claimed.">✓ chain-verified</span>`;
  }

  // Resolve etch supply attestation. Prefer the IPFS-embedded opening (which
  // enrichDiscoverAttestation already verified against the on-chain commitment) —
  // it's worker-independent, so a discovery worker that's down or censoring
  // can't suppress the proof. Fall back to the worker's /assets cache if
  // that's the only thing available. Either path is cryptographically equal
  // (same Pedersen check); they differ only in distribution trust.
  // In the pending state we suppress the badge entirely — no canonical
  // commitment yet, so the cryptographic check has nothing to bind against.
  let supplyBadge = '';
  let etchSupply = null;
  let attestSource = null;   // 'ipfs' | 'worker' | null
  if (!pending) {
    const commitmentHex = verified ? verify.commitment
                         : (typeof a.commitment === 'string' && /^[0-9a-f]{66}$/.test(a.commitment) ? a.commitment : '');
    // (a) IPFS-embedded attestation — pre-validated by enrichDiscoverAttestation.
    if (verified && verify.ipfsAttest) {
      etchSupply = BigInt(verify.ipfsAttest.supply);
      attestSource = 'ipfs';
    }
    // (b) Worker /assets attestation cache — cryptographically re-verify here.
    if (!etchSupply && commitmentHex) {
      const att = a.attestation;
      if (att && /^\d+$/.test(String(att.supply || '')) && /^[0-9a-f]{64}$/.test(String(att.blinding || ''))) {
        try {
          const sup = BigInt(att.supply);
          const r = BigInt('0x' + att.blinding);
          const onchain = bytesToPoint(hexToBytes(commitmentHex));
          if (pedersenCommit(sup, r).equals(onchain) && sup >= 0n && sup < (1n << BigInt(N_BITS))) {
            etchSupply = sup;
            attestSource = 'worker';
          }
        } catch {}
      }
    }
    if (etchSupply !== null) {
      const tag = supplyAttestBadge(attestSource, verify.imageUri || a.image_uri);
      supplyBadge = `<div style="margin-top:6px;font-size:12px;color:#0a7d4e;"><strong>Etch supply: ${escapeHtml(fmtAssetAmount(etchSupply, decimals))}</strong> · ${tag}</div>`;
    }
  }

  // Aggregate mint events. Only count entries whose mint_txid was verified
  // on-chain (verify.verifiedMints) AND whose attestation cryptographically
  // opens the on-chain commitment. Worker-only entries with no chain backing
  // are surfaced as "phantom" so they can't pad the count silently.
  // Gated on _mintsEnriched: while enrichment is still in flight we have no
  // verifiedMints yet, so showing "0 chain-verified · N worker-only (rejected)"
  // would be misleading. The badge appears once enrichDiscoverMints completes.
  const verifiedMintTxids = (verified && verify.verifiedMints) ? verify.verifiedMints : {};
  const claimedMints = Array.isArray(a.mints) ? a.mints : [];
  let mintBadge = '';
  let mintAttestedCount = 0, mintAttestedSum = 0n, mintAllAttested = true;
  let chainMintCount = 0;
  for (const m of claimedMints) {
    const v = verifiedMintTxids[m && m.mint_txid];
    if (!v) { mintAllAttested = false; continue; }
    chainMintCount++;
    const ma = m.attestation;
    if (ma && /^\d+$/.test(String(ma.supply || '')) && /^[0-9a-f]{64}$/.test(String(ma.blinding || ''))) {
      try {
        const mAmt = BigInt(ma.supply);
        const mR   = BigInt('0x' + ma.blinding);
        // Compare against the *chain* commitment, not the worker-supplied one
        // — defeats commitment-spoofing combined with attestation-spoofing.
        const mOnchain = bytesToPoint(hexToBytes(v.commitment));
        if (pedersenCommit(mAmt, mR).equals(mOnchain) && mAmt < (1n << BigInt(N_BITS))) {
          mintAttestedCount++;
          mintAttestedSum += mAmt;
        } else {
          mintAllAttested = false;
        }
      } catch { mintAllAttested = false; }
    } else {
      mintAllAttested = false;
    }
  }
  if (verified && verify._mintsEnriched && (chainMintCount > 0 || claimedMints.length > 0)) {
    const phantom = claimedMints.length - chainMintCount;
    mintBadge = `<div style="margin-top:6px;font-size:11px;">` +
      `${chainMintCount} chain-verified mint${chainMintCount === 1 ? '' : 's'}` +
      (mintAttestedCount > 0 ? ` · ${mintAttestedCount} attested (+${escapeHtml(fmtAssetAmount(mintAttestedSum, decimals))})` : '') +
      (mintAttestedCount < chainMintCount ? ` · ${chainMintCount - mintAttestedCount} unattested` : '') +
      (phantom > 0 ? ` · <span style="color:var(--red);">${phantom} worker-only (rejected)</span>` : '') +
      `</div>`;
  } else if (verified && !verify._mintsEnriched && claimedMints.length > 0) {
    // Soft hint while enrichment is in flight — keeps the user from thinking
    // the asset has zero mint history just because we haven't validated yet.
    mintBadge = `<div style="margin-top:6px;font-size:11px;color:var(--ink-mid);">${claimedMints.length} mint${claimedMints.length === 1 ? '' : 's'} reported · validating…</div>`;
  }
  // Burns: trust only on-chain T_BURN envelopes for this asset_id. The on-chain
  // burned_amount is the authority; worker-claimed entries with no chain
  // backing are surfaced as phantom so the user sees the discrepancy. Same
  // _burnsEnriched gating as mints.
  const verifiedBurnMap = (verified && verify.verifiedBurns) ? verify.verifiedBurns : {};
  const claimedBurns = Array.isArray(a.burns) ? a.burns : [];
  let burnedSum = 0n;
  let chainBurnCount = 0;
  for (const b of claimedBurns) {
    const x = verifiedBurnMap[b && b.tx];
    if (typeof x !== 'bigint') continue;
    if (x < 0n || x >= (1n << BigInt(N_BITS))) continue;
    burnedSum += x;
    chainBurnCount++;
  }
  const phantomBurns = claimedBurns.length - chainBurnCount;
  let burnBadge = '';
  if (verified && verify._burnsEnriched && (chainBurnCount > 0 || phantomBurns > 0)) {
    burnBadge = `<div style="margin-top:6px;font-size:11px;color:#a04030;">${chainBurnCount} chain-verified burn${chainBurnCount === 1 ? '' : 's'} · ${escapeHtml(fmtAssetAmount(burnedSum, decimals))} destroyed${phantomBurns > 0 ? ` · <span style="color:var(--red);">${phantomBurns} worker-only (rejected)</span>` : ''}</div>`;
  } else if (verified && !verify._burnsEnriched && claimedBurns.length > 0) {
    burnBadge = `<div style="margin-top:6px;font-size:11px;color:var(--ink-mid);">${claimedBurns.length} burn${claimedBurns.length === 1 ? '' : 's'} reported · validating…</div>`;
  }
  // Circulating supply = etched + Σ chain+attested mints − Σ chain burns.
  // Requires (a) chain-verified etch with attested supply, (b) every claimed
  // mint chain-verified AND attested, (c) zero phantom mints, (d) mints AND
  // burns enrichment complete (otherwise the math is incomplete).
  // When etch === circulating (no mints, no burns), we collapse the two
  // green lines into a single "Supply" line — the math is trivially the
  // same as the etch supply, so showing it twice is redundant noise.
  let totalSupplyBadge = '';
  if (verified && verify._mintsEnriched && verify._burnsEnriched
      && mintAllAttested && etchSupply !== null
      && chainMintCount === claimedMints.length
      && mintAttestedCount === chainMintCount) {
    const totalIssued = etchSupply + mintAttestedSum;
    const circulating = totalIssued - burnedSum;
    if (chainMintCount === 0 && chainBurnCount === 0) {
      // Collapsed: rewrite supplyBadge from "Etch supply: X · ✓ verified
      // supply" to "Supply: X · ✓ verified supply · fixed (no mints, no burns)".
      // Skip the totalSupplyBadge to avoid duplicating the same number.
      const tag = supplyAttestBadge(attestSource, verify.imageUri || a.image_uri);
      supplyBadge = `<div style="margin-top:6px;font-size:12px;color:#0a7d4e;"><strong>Supply: ${escapeHtml(fmtAssetAmount(etchSupply, decimals))}</strong> · ${tag} · fixed (no mints, no burns)</div>`;
    } else {
      totalSupplyBadge = `<div style="margin-top:6px;font-size:12px;color:#0a7d4e;"><strong>Circulating: ${escapeHtml(fmtAssetAmount(circulating, decimals))}</strong> · issued ${escapeHtml(fmtAssetAmount(totalIssued, decimals))}${burnedSum > 0n ? ` − burned ${escapeHtml(fmtAssetAmount(burnedSum, decimals))}` : ''}</div>`;
    }
  }

  // Market-cap, floor-price, and live-offer surfaces moved off Discover —
  // the Market tab consolidates them. Discover's job is "what tokens exist";
  // Market's job is "what's for sale + at what price". Keeping them split
  // means Discover stays scannable on small screens (no per-card market
  // chrome to scroll past) and the Market tab is the single source of truth
  // for orderbook state.

  // Mismatch detail — only when verified=true and at least one field differs.
  const mismatchDetail = (verified && verify.mismatches && verify.mismatches.length)
    ? `<div style="margin-top:6px;font-size:11px;color:#a04030;">⚠ Worker disagreed with on-chain envelope on: ${escapeHtml(verify.mismatches.join(', '))}. Showing on-chain values.</div>`
    : '';

  // Ticker-collision warning. Tickers are free-form CETCH bytes so multiple
  // assets can share one — the asset_id is the only canonical reference.
  // First-etched is shown as `original`; later etches with the same ticker
  // get a stronger duplicate badge nudging users to read the asset_id.
  // Atomic-OTC availability is dataset-only on Discover — the Market tab
  // owns the orderbook UI (open offers, floor, last-traded, atomic ⚡), so
  // Discover stays a clean directory of "what tokens exist" rather than
  // mixing in marketplace chrome. The dataset attr remains because the
  // ⚡ Atomic filter pill (when present) reads it; if you want to also drop
  // the pill, see index.html's #discover-pills.
  card.dataset.hasAtomic = (Number(a.atomic_intent_count || 0) > 0 || _localAtomicAssetIds().has(a.asset_id)) ? '1' : '0';

  // Network chip. Sourced from the asset record (worker stamps every entry
  // with `network`); falls back to the dapp's current NET.name when absent
  // so legacy records still render. Mainnet uses the same warm-amber accent
  // as other "real value" warnings; signet stays neutral.
  const _assetNet = (a && (a.network === 'mainnet' || a.network === 'signet')) ? a.network : NET.name;
  const networkBadge = _assetNet === 'mainnet'
    ? `<span style="font-size:10px;background:#fff8eb;color:#a04030;padding:2px 6px;border:1px solid #a04030;text-transform:uppercase;letter-spacing:0.1em;" title="Bitcoin mainnet asset — has real value. Verify the asset_id and supply attestation before trading.">mainnet</span>`
    : `<span style="font-size:10px;background:var(--bg-warm);color:var(--ink-mid);padding:2px 6px;border:1px solid var(--ink-faint);text-transform:uppercase;letter-spacing:0.1em;" title="Signet (Bitcoin testnet) asset — no real value, suitable for testing only.">signet</span>`;

  let collisionBadge = '', collisionDetail = '';
  if (a._tickerCollision === 'duplicate') {
    collisionBadge = `<span style="font-size:10px;background:#fee;color:var(--red);padding:2px 6px;border:1px solid var(--red);text-transform:uppercase;letter-spacing:0.1em;cursor:help;" title="Tickers aren't unique on tacit — multiple assets can share a name. The asset_id is the only canonical reference. Another asset claimed this ticker first; verify the asset_id below before sending or buying.">⚠ duplicate ticker</span>`;
    collisionDetail = `<div style="margin-top:6px;font-size:11px;color:var(--red);">⚠ This ticker is shared with ≥ 1 earlier-etched asset. <strong>Tickers are not unique on tacit</strong> — the asset_id below is the canonical reference. Confirm with the issuer before trading.</div>`;
  } else if (a._tickerCollision === 'original') {
    collisionBadge = `<span style="font-size:10px;background:#fff8eb;color:#a04030;padding:2px 6px;border:1px solid #a04030;text-transform:uppercase;letter-spacing:0.1em;cursor:help;" title="This asset was etched first under this ticker, but tickers aren't unique on tacit — the asset_id is the canonical reference. Verify it before sending or buying.">shared ticker · earliest</span>`;
  }

  card.innerHTML = `
    <div class="head" style="display:flex;align-items:center;gap:12px;">
      ${avatar}
      <div style="flex:1;min-width:0;">
        <div class="ticker" style="font-size:24px;">${escapeHtml(displayName)}${displayName !== ticker ? `<span class="ticker-sub">${escapeHtml(ticker)}</span>` : ''}<span class="id-tag">${escapeHtml(shorten(safeAssetId, 4))}</span></div>
        <div class="muted" style="font-size:11px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span>decimals ${decimals} · etched ${ageStr} · block ${safeHeight ?? '—'}</span>
          ${networkBadge}
          ${verifyBadge}
          ${collisionBadge}
        </div>
      </div>
    </div>
    ${collisionDetail}
    ${mismatchDetail}
    ${supplyBadge}
    ${mintBadge}
    ${burnBadge}
    ${totalSupplyBadge}
    ${(() => {
      // Transfer-count signal — coarse "is anyone moving this?" indicator,
      // not a legitimacy proof (self-spam is cheap). Cron-maintained counter;
      // absence of any transfers is meaningful, presence is movement only.
      // Rendered only when > 0 so static drops/airdrops that never moved
      // don't get a misleading "0 transfers" line.
      const xferCount = Number(a.transfer_count || 0);
      if (xferCount <= 0) return '';
      return `<div class="muted" style="margin-top:6px;font-size:11px;">🔄 ${xferCount} indexed transfer${xferCount === 1 ? '' : 's'} <span title="counted from CXFER + AXFER envelopes seen by this worker since it began scanning — coarse popularity signal, not a legitimacy proof">(CXFER + AXFER)</span></div>`;
    })()}
    ${(() => {
      // Disclosure signals — opt-in transparency from holders. opening_count
      // counts UTXOs whose (amount, blinding) opening has been published to
      // the worker (often as part of a listing); disclosure_count counts
      // "balance ≥ K" zero-knowledge proofs. Both link to the per-asset
      // /openings or /disclosures endpoints for inspection. Rendered only
      // when > 0 so quiet assets don't show empty rows.
      const openCount = Number(a.opening_count || 0);
      const rangeCount = Number(a.disclosure_count || 0);
      if (openCount <= 0 && rangeCount <= 0) return '';
      const parts = [];
      if (openCount > 0) parts.push(`${openCount} disclosed UTXO${openCount === 1 ? '' : 's'}`);
      if (rangeCount > 0) parts.push(`${rangeCount} range disclosure${rangeCount === 1 ? '' : 's'}`);
      return `<div class="muted" style="margin-top:6px;font-size:11px;" title="Holder-published (amount, blinding) openings and balance-≥-K range proofs — opt-in transparency, both verifiable from chain alone.">🔓 ${parts.join(' · ')}</div>`;
    })()}
    ${(() => {
      // Etcher reputation row — surfaces "this issuer has K other assets in
      // the current registry" so a buyer can pattern-match repeat issuers
      // (good or bad) without leaving Discover. Only shown when the etcher
      // is verified (we have their x-only) AND they appear on at least one
      // other asset. Click-to-filter narrows the list to that creator's
      // full set; same handler the existing Etcher row uses below.
      if (!etcherXonly || !etcherAddr) return '';
      const peers = _discoverEtcherMap.get(etcherXonly);
      const otherCount = peers ? Math.max(0, peers.size - 1) : 0;
      if (otherCount <= 0) return '';
      return `<div class="muted" style="margin-top:6px;font-size:11px;">📜 <a href="#" data-act="filter-etcher" data-etcher="${escapeHtml(etcherAddr)}" title="Click to filter Discover to this etcher's full set of assets">etcher has ${otherCount} other asset${otherCount === 1 ? '' : 's'} on ${escapeHtml(NET.name)}</a></div>`;
    })()}
    ${extras?.description ? `<div class="muted" style="margin-top:8px;font-size:11px;font-style:italic;">${escapeHtml(extras.description)}</div>` : ''}
    ${(() => {
      const safe = safeExternalUrl(extras?.external_url);
      return safe ? `<div style="margin-top:6px;font-size:11px;"><a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safe)} ↗</a></div>` : '';
    })()}
    ${/* Place-bid / open-bids row moved to the Market tab so Discover cards
        stay a clean directory view. */ ''}
    <div class="meta">
      <div><span class="lbl">Asset ID</span> ${assetIdRowHTML(safeAssetId)}</div>
      <div><span class="lbl">Etch tx</span> ${safeEtchTxid ? `<a href="${NET.explorer}/tx/${escapeHtml(safeEtchTxid)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shorten(safeEtchTxid, 8))} ↗</a>` : '—'}</div>
      <div><span class="lbl">Etcher</span> ${etcherAddr ? `<a href="#" data-act="filter-etcher" data-etcher="${escapeHtml(etcherAddr)}" title="Click to filter Discover by this etcher's assets">${escapeHtml(shorten(etcherAddr, 10))}</a>` : '—'}</div>
    </div>`;
  // Wire the asset_id short/full toggle for this card.
  wireAssetIdToggles(card);
  // Wire the "view offers" badge → Market tab with this asset_id pre-filtered.
  card.querySelectorAll('[data-act="discover-view-offers"]').forEach(el => {
    el.onclick = (ev) => {
      ev.preventDefault();
      pendingMarketFilter = el.dataset.aid || '';
      $('.tab[data-tab="market"]').click();
    };
  });
  // Wire the etcher row → fill the Discover search input with the etcher
  // bech32. Substring match against filterKey (which we appended the etcher
  // address to above) narrows the registry to that creator's assets only.
  card.querySelectorAll('[data-act="filter-etcher"]').forEach(el => {
    el.onclick = (ev) => {
      ev.preventDefault();
      const input = $('#discover-filter');
      if (!input) return;
      input.value = el.dataset.etcher || '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // Scroll the list back to the top so the newly-narrowed results are
      // immediately visible. The input keeps focus for easy deletion if the
      // user wants to clear the filter.
      const list = $('#discover-list');
      if (list) list.scrollTop = 0;
      input.focus();
    };
  });
  // Wire Place-Bid + View-Bids actions. Both toggle the same data-bid-host
  // panel directly below the action row, so users can post a bid and then
  // see it appear in the open-bids list without leaving the card.
  card.querySelectorAll('[data-act="discover-place-bid"]').forEach(el => {
    el.onclick = () => openDiscoverBidForm(card, el.dataset.aid, el.dataset.ticker || '?', Number(el.dataset.decimals || 0));
  });
  card.querySelectorAll('[data-act="discover-view-bids"]').forEach(el => {
    el.onclick = (ev) => {
      ev.preventDefault();
      openDiscoverBidPanel(card, el.dataset.aid, el.dataset.ticker || '?', Number(el.dataset.decimals || 0));
    };
  });
}

// Renders the place-bid form into the card's data-bid-host slot. Submit calls
// publishBidIntent (which signs with the wallet privkey + POSTs to worker).
// On success, switches the host into "panel" mode so the new bid is visible.
function openDiscoverBidForm(card, assetIdHex, ticker, decimals) {
  const host = card.querySelector(`[data-bid-host="${assetIdHex}"]`);
  if (!host) return;
  if (host.style.display !== 'none' && host.dataset.mode === 'form') {
    host.style.display = 'none';
    host.dataset.mode = '';
    host.innerHTML = '';
    return;
  }
  host.style.display = 'block';
  host.dataset.mode = 'form';
  const tickerSafe = escapeHtml(ticker);
  host.innerHTML = `
    <div style="border:1px solid var(--ink-mid);padding:8px;background:var(--bg);">
      <div style="font-size:11px;font-weight:bold;margin-bottom:6px;">Place a bid on ${tickerSafe}</div>
      <div class="muted" style="font-size:10px;margin-bottom:8px;">Off-chain bid book (SPEC §5.7.7). When a holder claims your bid, they spin up an atomic intent targeted at your wallet — settlement is a single Bitcoin tx, no protocol fee.</div>
      <div class="flex" style="gap:6px;flex-wrap:wrap;">
        <label style="font-size:10px;flex:1;min-width:120px;">Amount (${tickerSafe})
          <input data-bid-field="amount" type="text" inputmode="decimal" placeholder="0.0" style="width:100%;font-family:var(--mono);">
        </label>
        <label style="font-size:10px;flex:1;min-width:120px;">Total price (sats)
          <input data-bid-field="price" type="number" min="1" step="1" placeholder="e.g. 50000" style="width:100%;font-family:var(--mono);">
        </label>
        <label style="font-size:10px;flex:1;min-width:120px;">Expires (hours)
          <input data-bid-field="expiry-hours" type="number" min="1" max="720" step="1" value="24" style="width:100%;font-family:var(--mono);">
        </label>
      </div>
      <div class="flex" style="gap:6px;margin-top:8px;">
        <button data-bid-action="submit" class="primary" type="button" style="font-size:11px;">Sign & post bid</button>
        <button data-bid-action="cancel" type="button" style="font-size:11px;">Close</button>
      </div>
      <div data-bid-status="" class="muted" style="font-size:10px;margin-top:6px;"></div>
    </div>`;
  const status = host.querySelector('[data-bid-status=""]');
  host.querySelector('[data-bid-action="cancel"]').onclick = () => {
    host.style.display = 'none'; host.dataset.mode = ''; host.innerHTML = '';
  };
  const submitBtn = host.querySelector('[data-bid-action="submit"]');
  submitBtn.onclick = async () => {
    if (submitBtn.disabled) return;
    try {
      const amountStr = host.querySelector('[data-bid-field="amount"]').value.trim();
      const priceSatsRaw = host.querySelector('[data-bid-field="price"]').value.trim();
      const hoursRaw = host.querySelector('[data-bid-field="expiry-hours"]').value.trim();
      if (!amountStr || !priceSatsRaw || !hoursRaw) throw new Error('all fields required');
      const amount = parseAssetAmount(amountStr, decimals);
      if (amount <= 0n) throw new Error('amount must be positive');
      const priceSatsInt = parseInt(priceSatsRaw, 10);
      if (!Number.isInteger(priceSatsInt) || priceSatsInt <= 0) throw new Error('price must be a positive integer');
      const hours = Math.max(1, Math.min(720, parseInt(hoursRaw, 10) || 24));
      const expiry = Math.floor(Date.now() / 1000) + hours * 3600;
      submitBtn.disabled = true;
      status.textContent = 'signing & posting…';
      await publishBidIntent({ assetIdHex, amount, priceSats: priceSatsInt, expiry });
      status.textContent = 'bid posted ✓';
      toast(`Bid posted on ${ticker}`, 'success');
      openDiscoverBidPanel(card, assetIdHex, ticker, decimals);
    } catch (e) {
      submitBtn.disabled = false;
      status.textContent = 'failed: ' + (e?.message || String(e));
    }
  };
}

// Renders the open-bids panel into the same data-bid-host slot. Each row shows
// amount, total price, ppu, expiry, bidder pub. Holders see Fulfil; bidders
// see Cancel. Calling this also refreshes the cached _bidIntents on the card's
// verify object so the bid count stays current.
async function openDiscoverBidPanel(card, assetIdHex, ticker, decimals) {
  const host = card.querySelector(`[data-bid-host="${assetIdHex}"]`);
  if (!host) return;
  if (host.style.display !== 'none' && host.dataset.mode === 'panel') {
    host.style.display = 'none'; host.dataset.mode = ''; host.innerHTML = '';
    return;
  }
  host.style.display = 'block';
  host.dataset.mode = 'panel';
  host.innerHTML = `<div class="muted" style="font-size:11px;">loading bids…</div>`;
  let intents = [];
  try {
    intents = await browseBidIntents(assetIdHex);
  } catch (e) {
    host.innerHTML = `<div class="muted" style="font-size:11px;">load failed: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  // Update the count badge on the card without a full re-render.
  const countSpan = card.querySelector(`[data-bid-count-for="${assetIdHex}"]`);
  if (countSpan) countSpan.textContent = String(intents.length);
  if (intents.length === 0) {
    host.innerHTML = `
      <div style="border:1px solid var(--ink-mid);padding:8px;background:var(--bg);">
        <div style="font-size:11px;font-weight:bold;margin-bottom:6px;">No open bids on ${escapeHtml(ticker)}</div>
        <div class="muted" style="font-size:10px;">Be the first to post one — bids encourage holders to disclose pricing and surface a market for the asset.</div>
      </div>`;
    return;
  }
  const myPub = (wallet && wallet.pub) ? bytesToHex(wallet.pub) : null;
  const rowsHtml = intents.map((b) => {
    const amtStr = fmtAssetAmountPlain(BigInt(b.amount || 0), decimals);
    const ppuTotal = Number(b.price_sats || 0);
    const amtBase = Number(b.amount || 0);
    const ppu = (amtBase > 0) ? (ppuTotal / (amtBase / Math.pow(10, decimals))) : 0;
    const expiresIn = Math.max(0, Number(b.expiry || 0) - Math.floor(Date.now() / 1000));
    const expiryLbl = expiresIn > 0 ? `${Math.floor(expiresIn / 3600)}h ${Math.floor((expiresIn % 3600) / 60)}m` : 'expired';
    const claimed = !!b.axintent_id;
    const isMine = myPub && b.buyer_pubkey === myPub;
    let actionsHtml;
    if (claimed) {
      actionsHtml = `<span class="muted" style="font-size:10px;">claimed via atomic intent ${escapeHtml(shorten(b.axintent_id, 6))}</span>`;
    } else if (isMine) {
      actionsHtml = `<button data-bid-action="cancel-mine" data-bid-id="${escapeHtml(b.bid_id)}" type="button" style="font-size:10px;">Cancel</button>`;
    } else {
      actionsHtml = `<button data-bid-action="fulfil" data-bid-id="${escapeHtml(b.bid_id)}" class="primary" type="button" style="font-size:10px;" title="Spin up a §5.7.6 atomic intent targeted at this bidder, signed by your asset UTXO. Claiming the bid links the two so the bidder can take.">Fulfil</button>`;
    }
    return `
      <div style="border:1px solid var(--ink-mid);padding:6px;margin-bottom:4px;font-size:11px;">
        <div class="flex" style="justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <div><span class="lbl">amt</span> ${escapeHtml(amtStr)} ${escapeHtml(ticker)} · <span class="lbl">total</span> ${ppuTotal.toLocaleString()} sats · <span class="lbl">ppu</span> ${ppu.toFixed(2)} sats</div>
          <div>${actionsHtml}</div>
        </div>
        <div class="muted" style="font-size:10px;margin-top:2px;">bidder ${escapeHtml(shorten(b.buyer_pubkey, 6))} · expires ${escapeHtml(expiryLbl)}${isMine ? ' · <em>your bid</em>' : ''}</div>
      </div>`;
  }).join('');
  host.innerHTML = `
    <div style="border:1px solid var(--ink-mid);padding:8px;background:var(--bg);">
      <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-size:11px;font-weight:bold;">Open bids on ${escapeHtml(ticker)} (${intents.length})</div>
        <button data-bid-action="close-panel" type="button" style="font-size:10px;">Close</button>
      </div>
      ${rowsHtml}
    </div>`;
  host.querySelector('[data-bid-action="close-panel"]').onclick = () => {
    host.style.display = 'none'; host.dataset.mode = ''; host.innerHTML = '';
  };
  host.querySelectorAll('[data-bid-action="cancel-mine"]').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'cancelling…';
      try {
        await cancelBidIntent(assetIdHex, btn.dataset.bidId);
        toast('Bid cancelled ✓', 'success');
        openDiscoverBidPanel(card, assetIdHex, ticker, decimals);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Cancel';
        toast('Cancel failed: ' + (e?.message || String(e)), 'error');
      }
    };
  });
  host.querySelectorAll('[data-bid-action="fulfil"]').forEach(btn => {
    btn.onclick = async () => {
      const bid = intents.find(x => x.bid_id === btn.dataset.bidId);
      if (!bid) return;
      btn.disabled = true;
      btn.textContent = 'fulfilling…';
      try {
        await fulfilBidIntent({ bid });
        toast('Bid fulfilled ✓ — atomic intent published, awaiting bidder take', 'success');
        openDiscoverBidPanel(card, assetIdHex, ticker, decimals);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Fulfil';
        toast('Fulfil failed: ' + (e?.message || String(e)), 'error');
      }
    };
  });
}

// Per-asset floor unit price, derived from _marketCache.listings. Discover
// consults this so a card can show "▸ 5 live offers · floor X sats/TAC"
// without re-fetching listings on every render. Memoized against the cache
// reference so the map only rebuilds when the underlying listings change.
// For range listings the threshold is a minimum delivery, so price/threshold
// is an *upper* bound on the unit price — we accept that as the floor here
// (conservative: the user clicks through and sees the actual offer mix).
// Returns null when Market hasn't been loaded yet — Discover falls back to
// the plain offer-count badge.
let _marketFloorCache = { src: null, map: null };
function _marketFloorByAsset() {
  if (!_marketCache?.listings) return null;
  // Key on the listings array reference, not the _marketCache object — the
  // liveness prune at startMarketLivenessPrune replaces .listings (filter()
  // returns a new array) but keeps the _marketCache object identity, so a
  // _marketCache-keyed memo would serve stale data after a prune.
  if (_marketFloorCache.src === _marketCache.listings) return _marketFloorCache.map;
  const map = new Map();
  for (const l of _marketCache.listings) {
    const a = l._asset;
    if (!a?.asset_id) continue;
    const dec = Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0;
    const amount = l.kind === 'range' ? l.threshold : l.amount;
    const u = unitPriceSats(Number(l.price_sats || 0), BigInt(amount || 0), dec);
    if (u == null) continue;
    const cur = map.get(a.asset_id);
    if (!cur || u < cur.unit) map.set(a.asset_id, { unit: u, ticker: a.ticker || 'token' });
  }
  _marketFloorCache = { src: _marketCache.listings, map };
  return map;
}

// Per-asset live offer counts, derived from _marketCache.listings AFTER the
// liveness prune has filtered out spent UTXOs. Used by Discover to override
// the worker's raw `listing_count` / `range_listing_count` /
// `atomic_intent_count` (which still include UTXOs that have been spent on
// chain — the worker doesn't track spentness). Same memoization +
// fall-through-when-empty contract as the floor map.
let _marketLiveCountCache = { src: null, map: null };
function _marketLiveCountsByAsset() {
  if (!_marketCache?.listings) return null;
  // Same-key rationale as _marketFloorByAsset: the liveness prune swaps
  // _marketCache.listings for a filtered copy, so memoize on that array.
  if (_marketLiveCountCache.src === _marketCache.listings) return _marketLiveCountCache.map;
  const map = new Map();
  for (const l of _marketCache.listings) {
    const aid = l._asset?.asset_id;
    if (!aid) continue;
    const cur = map.get(aid) || { listings: 0, ranges: 0, intents: 0, total: 0 };
    if (l.kind === 'opening')      cur.listings++;
    else if (l.kind === 'range')   cur.ranges++;
    else if (l.kind === 'intent')  cur.intents++;
    cur.total = cur.listings + cur.ranges + cur.intents;
    map.set(aid, cur);
  }
  _marketLiveCountCache = { src: _marketCache.listings, map };
  return map;
}

// ============== MARKET TAB ==============
// Aggregates open listings (both opening-based and range-disclosed) across all
// etched assets. Filters: ticker / asset_id, kind, price min/max. Sort: newest
// first or by price. Cache the fetched batch so filter changes don't re-hit
// the worker on every keystroke.
//
// Two display modes:
//   • browse: one tile per asset (image, ticker, listing count, floor) — the
//     default landing. Matches the Runes/BRC-20 marketplace pattern: pick the
//     token first, then drill into its offers.
//   • asset: the per-listing grid for one selected asset, fronted by a header
//     strip with a "← All assets" affordance back to browse.
//
// _marketView is intentionally NOT persisted — every fresh tab visit lands on
// browse so the user always sees the index page first. Discover deep-links
// (pendingMarketFilter) jump straight into asset mode for the targeted asset.
let _marketCache = null;
let _marketView = 'browse';
function goToMarketBrowse() { _marketView = 'browse'; renderMarket(); }
function goToMarketAsset(assetIdHex) { _marketView = { mode: 'asset', assetId: assetIdHex }; renderMarket(); }

async function fetchMarketData() {
  if (!MARKET_URL) return { assets: [], listings: [] };
  // Worker-aggregated marketplace endpoint: one round-trip, server pre-joined
  // with kind + _asset reference per listing. Replaces the previous N×3
  // per-asset fan-out — the slowest of N×3 round-trips no longer gates
  // first paint of the Market tab.
  const r = await fetch(withNet(MARKET_URL));
  if (!r.ok) throw new Error(`market HTTP ${r.status}`);
  const j = await r.json();
  const assets = Array.isArray(j.assets) ? j.assets : [];
  // Mark ticker-collision precedence over the FULL asset set (not just the
  // ones with listings). Without this an attacker could side-step the
  // duplicate-ticker warning by listing a copycat asset before the original.
  markTickerCollisions(assets);
  const listings = Array.isArray(j.listings) ? j.listings : [];
  return { assets, listings };
}

// Background liveness prune: dispatched right after applyMarketFilters
// renders. The worker doesn't track UTXO spentness (constant chain polling
// per listing would be expensive), so without this pass takers would see
// dead listings until they click Verify. Strategy: paint immediately with
// what the worker returned, then in parallel hit /outspend per opening +
// intent listing. Each spent result removes its tile from the DOM AND
// from _marketCache.listings, so filter / sort re-renders don't bring it
// back. Range listings are skipped — their bulletproof can stay valid
// even after some UTXOs spend, and Verify still does the full check.
function startMarketLivenessPrune() {
  if (!_marketCache) return;
  const grid = $('#market-list');
  if (!grid) return;
  // Snapshot at dispatch — _marketCache.listings may mutate as checks resolve.
  for (const l of _marketCache.listings.slice()) {
    let txid, vout;
    if (l.kind === 'opening') { txid = l.txid; vout = l.vout | 0; }
    else if (l.kind === 'intent') { txid = l.asset_utxo?.txid; vout = l.asset_utxo?.vout | 0; }
    else continue;
    if (!txid) continue;
    getOutspend(txid, vout).then((sp) => {
      if (!sp || !sp.spent) return;
      if (_marketCache) {
        _marketCache.listings = _marketCache.listings.filter(x => x !== l);
      }
      // In browse mode the aggregate counts/floor would silently drift; just
      // re-apply filters (no fetch) to redraw the affected asset tile.
      if (_marketView === 'browse') {
        applyMarketFilters();
        return;
      }
      const key = l.kind === 'opening' ? `opening:${l.txid}:${l.vout | 0}` : `intent:${l.intent_id}`;
      const tile = grid.querySelector(`[data-listing-key="${CSS.escape(key)}"]`);
      if (!tile) return;
      tile.remove();
      if (!grid.querySelector('[data-listing-key]')) {
        grid.innerHTML = '<div class="empty">No live listings.</div>';
      }
    }).catch(() => {});
  }
}

// TTL on the worker round-trip so tab-clicks (Market → Discover → Market)
// don't re-pay the fetch when the data is fresh. Refresh button and any
// post-action callsite call invalidateMarketCache() (or recordActivity()
// invalidates it transitively) to force a re-fetch on the next renderMarket.
const MARKET_FETCH_TTL_MS = 30 * 1000;
let _marketFetchedAt = 0;
function invalidateMarketCache() { _marketFetchedAt = 0; }

async function renderMarket() {
  const list = $('#market-list');
  const status = $('#market-status');
  if (!REGISTRY_URL) {
    list.innerHTML = '<div class="muted" style="padding:14px;">marketplace disabled (no Worker)</div>';
    if (status) status.textContent = '';
    return;
  }
  // Cross-tab deep-link: a Discover card's "view offers" badge sets
  // pendingMarketFilter to a full asset_id. Drop straight into asset mode for
  // that asset rather than the browse index — the user already picked.
  if (pendingMarketFilter) {
    if (/^[0-9a-f]{64}$/.test(pendingMarketFilter)) {
      _marketView = { mode: 'asset', assetId: pendingMarketFilter };
    }
    pendingMarketFilter = null;
  }
  // Fast path: if the cache is fresh, skip the worker round-trip entirely
  // and just re-apply filters against what we already have. The liveness
  // prune already runs in the background; tiles whose UTXOs spent during
  // the cache window are gone from _marketCache.listings.
  if (_marketCache && (Date.now() - _marketFetchedAt) < MARKET_FETCH_TTL_MS) {
    applyMarketFilters();
    return;
  }
  list.innerHTML = '<div class="muted" style="padding:14px;text-align:center;font-style:italic;"><span class="live-dots">loading</span></div>';
  setStatus(status, 'loading', true);
  try {
    _marketCache = await fetchMarketData();
    _marketFetchedAt = Date.now();
    applyMarketFilters();
    setTabBadge('market', _marketCache?.listings?.length || 0);
    // Fire-and-forget: chain-check each listing's UTXO in parallel and
    // remove stale tiles as results come in. Doesn't block initial paint.
    startMarketLivenessPrune();
  } catch (e) {
    list.innerHTML = `<div class="error">Market load failed: ${escapeHtml(e.message)}</div>`;
    setStatus(status, 'error');
    console.error(e);
  }
}

function applyMarketFilters() {
  if (!_marketCache) return;
  const list = $('#market-list');
  const status = $('#market-status');
  const filterText = ($('#market-filter-asset')?.value || '').trim().toLowerCase();
  const filterKind = $('#market-filter-kind')?.value || 'all';
  const minPrice = parseInt($('#market-filter-min-price')?.value || '', 10);
  const maxPrice = parseInt($('#market-filter-max-price')?.value || '', 10);
  const sort = $('#market-sort')?.value || 'recency';
  let rows = _marketCache.listings.slice();
  if (filterText) {
    rows = rows.filter(l => {
      const a = l._asset || {};
      const ticker = (a.ticker || '').toLowerCase();
      const aid = (a.asset_id || '').toLowerCase();
      return ticker.includes(filterText) || aid.startsWith(filterText);
    });
  }
  if (filterKind !== 'all') rows = rows.filter(l => l.kind === filterKind);
  if (Number.isInteger(minPrice)) rows = rows.filter(l => Number(l.price_sats || 0) >= minPrice);
  if (Number.isInteger(maxPrice)) rows = rows.filter(l => Number(l.price_sats || 0) <= maxPrice);

  // Mode dispatch. Browse renders one tile per asset (the index page); asset
  // mode falls through to the existing per-listing grid below, scoped to the
  // selected asset_id. The text-search input is hidden in asset mode (see
  // updateMarketControlsVisibility) — back-out is via the "← All assets" link
  // in the asset-detail header.
  updateMarketControlsVisibility();
  if (_marketView === 'browse') {
    renderMarketBrowse(rows);
    return;
  }
  rows = rows.filter(l => (l._asset?.asset_id || '') === _marketView.assetId);

  // Sort priority: trustless atomic intents always surface above
  // trust-required listings (within each price/recency tier). The user can
  // still see opening/range offers, but the recommended path is on top.
  // For price sorts, atomic ↔ non-atomic at the same price stay grouped:
  // atomics first, then opening/range tied by price.
  const atomicScore = l => l.kind === 'intent' ? 0 : 1;
  // Cache the unit price per row so the comparator doesn't recompute it on
  // every pairwise call. Listings whose unit price can't be derived (zero
  // amount, malformed price) sort to the bottom under unit-asc, top under
  // unit-desc — Number.NEGATIVE_INFINITY / POSITIVE_INFINITY would invert
  // that, so we use Infinity sentinel and flip per direction below.
  const unitOf = l => {
    const a = l._asset || {};
    const dec = Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0;
    const amt = l.kind === 'range' ? l.threshold : l.amount;
    const u = unitPriceSats(Number(l.price_sats || 0), BigInt(amt || 0), dec);
    return u != null ? u : null;
  };
  if (sort === 'price-asc') {
    rows.sort((a, b) =>
      atomicScore(a) - atomicScore(b)
      || Number(a.price_sats || 0) - Number(b.price_sats || 0));
  } else if (sort === 'price-desc') {
    rows.sort((a, b) =>
      atomicScore(a) - atomicScore(b)
      || Number(b.price_sats || 0) - Number(a.price_sats || 0));
  } else if (sort === 'unit-asc' || sort === 'unit-desc') {
    const desc = sort === 'unit-desc';
    rows.sort((a, b) => {
      const ax = atomicScore(a) - atomicScore(b);
      if (ax !== 0) return ax;
      const ua = unitOf(a), ub = unitOf(b);
      // Listings without a derivable unit price sink to the bottom in either
      // direction so the user always sees ranked results first.
      if (ua == null && ub == null) return 0;
      if (ua == null) return 1;
      if (ub == null) return -1;
      return desc ? ub - ua : ua - ub;
    });
  } else {
    rows.sort((a, b) =>
      atomicScore(a) - atomicScore(b)
      || (b.listed_at || 0) - (a.listed_at || 0));
  }
  if (status) status.textContent = `${rows.length} live · ${_marketCache.listings.length} total`;
  // Asset-detail header strip — image, ticker, asset_id, network, floor,
  // count breakdown, "← All assets". Always rendered in asset mode regardless
  // of whether listings remain (so the back affordance stays reachable even
  // on an empty result).
  const assetHeaderHtml = renderMarketAssetHeader(_marketView.assetId, rows);
  if (!rows.length) {
    list.innerHTML = assetHeaderHtml + '<div class="empty">No listings match.</div>';
    bindMarketAssetHeader(list);
    return;
  }
  // Asset-detail header above already shows the per-kind breakdown
  // (⚡ atomic · opening · range) and floor — no separate banner needed here.
  // The "no atomic offers under current filters" nudge is preserved in
  // compact form for the all-trust-required case where it actually adds info.
  const atomicCount = rows.reduce((s, l) => s + (l.kind === 'intent' ? 1 : 0), 0);
  const trustCount = rows.length - atomicCount;
  const noAtomicHint = atomicCount === 0 && trustCount > 0
    ? `<div style="margin-bottom:10px;font-size:11px;font-style:italic;" class="muted">no atomic offers under current filters — try kind=⚡ atomic</div>`
    : '';
  list.innerHTML =
    assetHeaderHtml +
    noAtomicHint +
    `<div id="market-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;"></div>`;
  bindMarketAssetHeader(list);
  const grid = $('#market-grid');
  const myPubHex = bytesToHex(wallet.pub);
  // Build all tiles into a DocumentFragment first; one reflow at the end
  // instead of N reflows during the loop. Material on busy markets.
  const frag = document.createDocumentFragment();
  for (const l of rows) {
    const a = l._asset || {};
    const safeAid = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
    const dec = Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0;
    const expIso = new Date((l.expiry || 0) * 1000).toISOString().slice(0, 10);
    const amount = l.kind === 'range' ? l.threshold : l.amount;
    const tile = document.createElement('div');
    tile.style.cssText = 'border:1px solid var(--ink);padding:12px;background:var(--bg-warm);';
    // Stable per-listing key so the background liveness prune can target
    // this tile by selector when its UTXO turns out to be spent on-chain.
    // Includes asset_id on range so a maker with range listings across
    // multiple assets gets distinct keys (the prune doesn't query range
    // today, but the key should still be unique if a future feature does).
    tile.dataset.listingKey = l.kind === 'opening'
      ? `opening:${l.txid}:${l.vout | 0}`
      : l.kind === 'intent'
        ? `intent:${l.intent_id}`
        : `range:${a.asset_id}:${l.owner_pubkey || ''}`;
    const kindBadge =
        l.kind === 'range'  ? `<span style="display:inline-block;padding:1px 6px;background:#0a8f43;color:#fff;font-size:9px;border-radius:2px;margin-left:6px;cursor:help;" title="Range-disclosed listing — maker proved their balance ≥ the listed amount via a bulletproof, without revealing the exact balance.">≥</span>`
      : l.kind === 'intent' ? `<span style="display:inline-block;padding:1px 6px;background:#7d4ff7;color:#fff;font-size:9px;border-radius:2px;margin-left:6px;cursor:help;" title="Atomic intent — the confidential token transfer and the BTC payment that pays for it close in the same Bitcoin tx. The maker can't redirect your payment; you can't get tokens without paying. No counterparty trust required.">⚡</span>`
      : '';
    // Action buttons depend on listing kind + my role on this intent.
    let actions = '';
    if (l.kind === 'intent') {
      const isMaker = (l.maker_pubkey || '') === myPubHex;
      const claim = l.claim;
      const fulfilled = !!l.fulfilment_pending;
      if (isMaker) {
        if (claim && !fulfilled) {
          actions = `<button data-act="market-fulfil" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" title="Maker step 2 of 3: generate the partial reveal targeted at the taker's pubkey and upload it. The taker's Take button unlocks once you've fulfilled." style="flex:1;font-size:11px;">Fulfil claim from ${escapeHtml(shorten(claim.taker_pubkey, 6))}</button>` +
                    `<button data-act="market-cancel-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" title="Pull this atomic intent from the worker. The active claim is invalidated; if a partial reveal was already uploaded, it becomes un-finalizable." style="font-size:11px;">Cancel</button>`;
        } else if (fulfilled) {
          actions = `<button disabled title="You've fulfilled the claim. The atomic settlement tx is ready for the taker to broadcast — they have until the claim window expires (~5 min from claim) to do so." style="flex:1;font-size:11px;">awaiting taker broadcast…</button>` +
                    `<button data-act="market-cancel-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" title="Pull this atomic intent from the worker. The active claim is invalidated; if a partial reveal was already uploaded, it becomes un-finalizable." style="font-size:11px;">Cancel</button>`;
        } else {
          actions = `<button disabled title="Your atomic intent is published and waiting for someone to claim it. When a taker claims, this button flips to Fulfil." style="flex:1;font-size:11px;">your intent · awaiting claim</button>` +
                    `<button data-act="market-cancel-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" title="Pull this atomic intent from the worker. Safe to call any time before fulfilment." style="font-size:11px;">Cancel</button>`;
        }
      } else if (claim && claim.taker_pubkey === myPubHex) {
        // I claimed; check fulfilment status.
        actions = fulfilled
          ? `<button data-act="market-take-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" title="Taker step 3 of 3: broadcast the single Bitcoin tx that combines the maker's partial reveal with your BTC payment. Atomic — both legs settle or both fail." style="flex:1;font-size:11px;">Take (atomic broadcast)</button>`
          : `<button disabled title="Your claim is locked in. Waiting for the maker to upload the partial reveal targeted at your pubkey. Take unlocks the moment they fulfil — refresh to check." style="flex:1;font-size:11px;">awaiting maker fulfilment…</button>`;
      } else if (claim) {
        actions = `<button disabled title="Another taker has the 5-minute lock on this intent. If they don't broadcast in time the lock expires and this tile becomes claimable again." style="flex:1;font-size:11px;">claimed by ${escapeHtml(shorten(claim.taker_pubkey, 6))}</button>`;
      } else {
        actions = `<button data-act="market-claim-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" data-price="${Number(l.price_sats || 0)}" data-ticker="${escapeHtml(a.ticker || '?')}" data-amount="${escapeHtml(amount || '0')}" data-dec="${dec}" title="Taker step 1 of 3: reserve this atomic intent for 5 minutes. You commit a sat UTXO ≥ price as proof of funds; the maker then fulfils, then you Take to settle." style="flex:1;font-size:11px;">Claim</button>`;
      }
    } else {
      actions = `<button data-act="market-take" data-kind="${l.kind}" data-aid="${escapeHtml(safeAid)}" data-txid="${escapeHtml(l.txid || '')}" data-vout="${l.vout | 0}" data-maker="${escapeHtml(l.owner_pubkey || '')}" data-price="${Number(l.price_sats || 0)}" data-addr="${escapeHtml(l.maker_address || '')}" data-ticker="${escapeHtml(a.ticker || '?')}" data-amount="${escapeHtml(amount || '0')}" data-dec="${dec}" title="Off-chain OTC buy: pay the maker's BTC address the listed sats, then they broadcast a CXFER to your pubkey. Counterparty trust required — the maker can take the sats without delivering. Prefer ⚡ atomic intents when available." style="flex:1;font-size:11px;">Take</button>` +
                `<button data-act="market-verify" data-kind="${l.kind}" data-aid="${escapeHtml(safeAid)}" data-txid="${escapeHtml(l.txid || '')}" data-vout="${l.vout | 0}" data-maker="${escapeHtml(l.owner_pubkey || '')}" title="Run the full client-side check chain on this listing without buying it: signatures, P2WPKH ownership, Pedersen commitment binds against on-chain state, UTXO is still unspent. Safe to call as many times as you want." style="font-size:11px;">Verify</button>`;
    }
    // Unit price: sats per whole token, accounting for decimals. For range
    // listings the threshold is a *minimum* delivery amount, so this number
    // is the worst-case (most-expensive-per-token) price — labeled "≤" since
    // the maker may deliver more for the same total.
    const unit = unitPriceSats(Number(l.price_sats || 0), BigInt(amount || 0), dec);
    const unitStr = unit != null
      ? `${l.kind === 'range' ? '≤ ' : ''}${fmtUnitPriceSats(unit)} sats/${escapeHtml(a.ticker || 'token')}`
      : '';
    const listedRel = relativeAge(l.listed_at);
    const recencyLine = listedRel
      ? `listed ${escapeHtml(listedRel)} ago · expires ${expIso}`
      : `expires ${expIso}`;
    // Ticker, asset_id, network, and ticker-collision state are already shown
    // in the asset-detail header above; we don't repeat them on each tile.
    tile.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div>${kindBadge || '<span class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">opening</span>'}</div>
        <div style="font-size:11px;" class="muted">${recencyLine}</div>
      </div>
      <div style="margin-top:6px;font-size:18px;">${l.kind === 'range' ? '<span title="Range-disclosed listing — maker proved their balance ≥ this amount via a bulletproof, without revealing the exact balance." style="cursor:help;">≥</span> ' : ''}${escapeHtml(fmtAssetAmount(BigInt(amount || '0'), dec))} <span style="font-size:11px;" class="muted">${escapeHtml(a.ticker || '')}</span></div>
      <div style="margin-top:4px;font-size:14px;color:#0a8f43;"><strong>${Number(l.price_sats || 0).toLocaleString()} sats</strong>${unitStr ? `<span class="muted" style="font-size:11px;margin-left:6px;">· ${unitStr}</span>` : ''}</div>
      <div style="margin-top:8px;font-size:10px;" class="muted">maker: <span class="mono-box inline">${escapeHtml(shorten(l.maker_address || '', 6))}</span></div>
      <div style="margin-top:10px;display:flex;gap:6px;">${actions}</div>`;
    frag.appendChild(tile);
  }
  grid.appendChild(frag);
  grid.querySelectorAll('span[data-act="copy-aid"]').forEach(el => {
    el.onclick = async () => {
      try { await navigator.clipboard.writeText(el.dataset.aid); toast('Asset ID copied', 'success'); }
      catch { /* clipboard blocked; selectable via mono-box class */ }
    };
  });
  grid.querySelectorAll('button[data-act="market-take"]').forEach(btn => {
    btn.onclick = async () => marketTakeHandler(btn);
  });
  grid.querySelectorAll('button[data-act="market-verify"]').forEach(btn => {
    btn.onclick = async () => marketVerifyHandler(btn);
  });
  grid.querySelectorAll('button[data-act="market-claim-intent"]').forEach(btn => {
    btn.onclick = async () => marketClaimIntentHandler(btn);
  });
  grid.querySelectorAll('button[data-act="market-fulfil"]').forEach(btn => {
    btn.onclick = async () => marketFulfilIntentHandler(btn);
  });
  grid.querySelectorAll('button[data-act="market-take-intent"]').forEach(btn => {
    btn.onclick = async () => marketTakeIntentHandler(btn);
  });
  grid.querySelectorAll('button[data-act="market-cancel-intent"]').forEach(btn => {
    btn.onclick = async () => marketCancelIntentHandler(btn);
  });
}

// Browse-mode render: one tile per asset, sourced from the same filtered rows
// applyMarketFilters computed (so kind/price filters narrow the visible set
// the same way they would in asset mode). Aggregates per-asset count + floor
// + kind breakdown. Click handler flips _marketView to asset mode.
//
// Sort: total listing count desc, then floor unit-price asc (cheapest first
// within ties), then ticker. No user-facing sort dropdown — the per-listing
// sort applies inside asset mode.
function renderMarketBrowse(rows) {
  const list = $('#market-list');
  const status = $('#market-status');
  if (status) status.textContent = `${rows.length} live · ${_marketCache.listings.length} total`;
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No listings match.</div>';
    return;
  }
  // Group by asset_id. Each group carries the asset metadata (taken from the
  // first row's _asset reference, all rows for the same asset share it),
  // per-kind counts, lowest unit price, and lowest total sats.
  const groups = new Map();
  for (const l of rows) {
    const a = l._asset;
    const aid = a?.asset_id;
    if (!aid) continue;
    let g = groups.get(aid);
    if (!g) {
      g = { asset: a, openings: 0, ranges: 0, intents: 0, total: 0,
            floorUnit: null, floorSats: null };
      groups.set(aid, g);
    }
    if (l.kind === 'opening')      g.openings++;
    else if (l.kind === 'range')   g.ranges++;
    else if (l.kind === 'intent')  g.intents++;
    g.total = g.openings + g.ranges + g.intents;
    const dec = Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0;
    const amt = l.kind === 'range' ? l.threshold : l.amount;
    const u = unitPriceSats(Number(l.price_sats || 0), BigInt(amt || 0), dec);
    if (u != null && (g.floorUnit == null || u < g.floorUnit)) g.floorUnit = u;
    const ps = Number(l.price_sats || 0);
    if (ps > 0 && (g.floorSats == null || ps < g.floorSats)) g.floorSats = ps;
  }
  const tiles = Array.from(groups.values()).sort((x, y) =>
    y.total - x.total
    || ((x.floorUnit ?? Infinity) - (y.floorUnit ?? Infinity))
    || String(x.asset.ticker || '').localeCompare(String(y.asset.ticker || '')),
  );

  // Trust-mode breakdown banner — same shape as asset mode for consistency.
  const atomicCount = rows.reduce((s, l) => s + (l.kind === 'intent' ? 1 : 0), 0);
  const trustCount = rows.length - atomicCount;
  const trustlessLabel = atomicCount > 0
    ? `<span style="color:#7d4ff7;"><strong>⚡ ${atomicCount} trustless</strong></span>`
    : `<span class="muted">⚡ 0 trustless</span>`;
  const trustLabel = trustCount > 0
    ? `<span class="muted">${trustCount} trust-required (opening + range)</span>`
    : `<span class="muted">0 trust-required</span>`;
  list.innerHTML =
    `<div style="margin-bottom:10px;font-size:11px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;">
       <span class="muted"><strong>${tiles.length}</strong> asset${tiles.length === 1 ? '' : 's'} with live listings</span>
       <span class="muted">·</span> ${trustlessLabel} <span class="muted">·</span> ${trustLabel}
     </div>
     <div id="market-browse-grid" class="recent-grid"></div>`;
  const grid = $('#market-browse-grid');
  const frag = document.createDocumentFragment();
  for (const g of tiles) {
    const a = g.asset;
    const safeAid = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
    const imgUrl = normalizeImageUri(a.image_uri || a.imageUri);
    const collisionBadge = a._tickerCollision === 'duplicate'
      ? `<span style="display:inline-block;padding:1px 5px;background:var(--red);color:#fff;font-size:9px;border-radius:2px;margin-left:5px;cursor:help;" title="Tickers aren't unique on tacit. Another asset claimed this ticker first; verify the asset_id before trading.">⚠ DUP</span>`
      : a._tickerCollision === 'original'
        ? `<span style="display:inline-block;padding:1px 5px;background:#a04030;color:#fff;font-size:9px;border-radius:2px;margin-left:5px;cursor:help;" title="Etched first under this ticker, but tickers aren't unique on tacit — asset_id is canonical.">earliest</span>`
        : '';
    const kindBits = [];
    if (g.intents) kindBits.push(`<span style="color:#7d4ff7;font-weight:bold;" title="atomic intents (trustless)">⚡ ${g.intents}</span>`);
    if (g.openings) kindBits.push(`<span title="opening listings (trust-required OTC)">${g.openings} opening</span>`);
    if (g.ranges) kindBits.push(`<span title="range listings (trust-required OTC)">${g.ranges} range</span>`);
    const floorLine = g.floorUnit != null
      ? `<strong style="color:#0a8f43;">floor ${fmtUnitPriceSats(g.floorUnit)} sats</strong>/${escapeHtml(a.ticker || 'token')}`
      : (g.floorSats != null
          ? `<strong style="color:#0a8f43;">from ${g.floorSats.toLocaleString()} sats</strong>`
          : '');
    const tile = document.createElement('div');
    tile.style.cssText = 'border:1px solid var(--ink);padding:12px;background:var(--bg-warm);cursor:pointer;display:flex;flex-direction:column;gap:6px;';
    tile.dataset.assetTile = safeAid;
    tile.title = `View ${escapeHtml(a.ticker || '?')} listings`;
    tile.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        ${imgUrl
          ? `<img loading="lazy" decoding="async" src="${escapeHtml(imgUrl)}" alt="" style="width:36px;height:36px;border:1px solid var(--ink);object-fit:cover;background:#fff;flex-shrink:0;">`
          : `<div style="width:36px;height:36px;border:1px solid var(--ink-mid);background:var(--bg);flex-shrink:0;"></div>`}
        <div style="min-width:0;flex:1;">
          <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
            <strong style="font-size:15px;">${escapeHtml(a.ticker || '?')}</strong>${collisionBadge}
          </div>
          <div style="font-size:10px;color:var(--ink-mid);font-family:var(--mono);">${escapeHtml(shorten(safeAid, 10))}</div>
        </div>
      </div>
      <div style="font-size:14px;"><strong>${g.total}</strong> <span class="muted" style="font-size:11px;">offer${g.total === 1 ? '' : 's'}</span></div>
      ${kindBits.length ? `<div style="font-size:11px;display:flex;gap:10px;flex-wrap:wrap;">${kindBits.join('<span class="muted">·</span>')}</div>` : ''}
      ${floorLine ? `<div style="font-size:12px;">${floorLine}</div>` : ''}
    `;
    frag.appendChild(tile);
  }
  grid.appendChild(frag);
  grid.querySelectorAll('[data-asset-tile]').forEach(el => {
    el.onclick = () => {
      const aid = el.dataset.assetTile;
      if (/^[0-9a-f]{64}$/.test(aid || '')) goToMarketAsset(aid);
    };
  });
}

// Asset-detail header strip — sits at the top of the per-listing grid in
// asset mode. "← All assets" returns to browse. The asset_id chip is
// click-to-copy, mirroring the per-tile behavior. `rows` is the already-
// filtered+scoped row set for the asset; we use it to derive a live floor.
function renderMarketAssetHeader(assetId, rows) {
  const a = (rows.find(l => l._asset?.asset_id === assetId)?._asset)
         || (_marketCache?.listings.find(l => l._asset?.asset_id === assetId)?._asset)
         || (_marketCache?.assets?.find(x => x.asset_id === assetId))
         || { asset_id: assetId, ticker: '?', decimals: 0 };
  const safeAid = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
  const imgUrl = normalizeImageUri(a.image_uri || a.imageUri);
  const dec = Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0;
  let floorUnit = null, floorSats = null;
  let openings = 0, ranges = 0, intents = 0;
  for (const l of rows) {
    if (l.kind === 'opening')      openings++;
    else if (l.kind === 'range')   ranges++;
    else if (l.kind === 'intent')  intents++;
    const amt = l.kind === 'range' ? l.threshold : l.amount;
    const u = unitPriceSats(Number(l.price_sats || 0), BigInt(amt || 0), dec);
    if (u != null && (floorUnit == null || u < floorUnit)) floorUnit = u;
    const ps = Number(l.price_sats || 0);
    if (ps > 0 && (floorSats == null || ps < floorSats)) floorSats = ps;
  }
  const total = openings + ranges + intents;
  const kindBits = [];
  if (intents) kindBits.push(`<span style="color:#7d4ff7;font-weight:bold;">⚡ ${intents} atomic</span>`);
  if (openings) kindBits.push(`<span class="muted">${openings} opening</span>`);
  if (ranges) kindBits.push(`<span class="muted">${ranges} range</span>`);
  const floorLine = floorUnit != null
    ? `<strong style="color:#0a8f43;">floor ${fmtUnitPriceSats(floorUnit)} sats</strong>/${escapeHtml(a.ticker || 'token')}`
    : (floorSats != null
        ? `<strong style="color:#0a8f43;">from ${floorSats.toLocaleString()} sats</strong>`
        : '<span class="muted">no priced listings</span>');
  const collisionBadge = a._tickerCollision === 'duplicate'
    ? `<span style="display:inline-block;padding:1px 6px;background:var(--red);color:#fff;font-size:9px;border-radius:2px;margin-left:6px;cursor:help;" title="Tickers aren't unique on tacit. Another asset claimed this ticker first; verify the asset_id before trading.">⚠ DUP</span>`
    : a._tickerCollision === 'original'
      ? `<span style="display:inline-block;padding:1px 6px;background:#a04030;color:#fff;font-size:9px;border-radius:2px;margin-left:6px;cursor:help;" title="Etched first under this ticker, but tickers aren't unique on tacit — asset_id is canonical.">earliest</span>`
      : '';
  // Breadcrumb above the asset card. Critical for users who deep-link from a
  // Discover "view offers" badge straight into asset mode — without it, the
  // browse index is invisible and the Market reads as "all listings flat".
  // The "← All assets" anchor mirrors the button below so either click target
  // works; the binder's querySelectorAll picks both up.
  const breadcrumb = `
    <div style="font-size:12px;margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
      <a href="#" data-act="market-back-browse" title="Back to the asset index" style="text-decoration:underline;cursor:pointer;">← All assets</a>
      <span class="muted">›</span>
      <strong>${escapeHtml(a.ticker || '?')}</strong>
      <span class="muted">offers</span>
    </div>`;
  return breadcrumb + `
    <div data-market-asset-header style="border:1px solid var(--ink);padding:12px;background:var(--bg-warm);margin-bottom:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
      ${imgUrl
        ? `<img loading="lazy" decoding="async" src="${escapeHtml(imgUrl)}" alt="" style="width:44px;height:44px;border:1px solid var(--ink);object-fit:cover;background:#fff;flex-shrink:0;">`
        : `<div style="width:44px;height:44px;border:1px solid var(--ink-mid);background:var(--bg);flex-shrink:0;"></div>`}
      <div style="min-width:0;flex:1;">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <strong style="font-size:18px;">${escapeHtml(a.ticker || '?')}</strong>${collisionBadge}
        </div>
        <div style="font-size:10px;color:var(--ink-mid);margin-top:2px;">
          <span>id </span>
          <span class="mono-box inline" style="font-size:10px;cursor:pointer;" data-act="copy-aid" data-aid="${escapeHtml(safeAid)}" title="Click to copy full asset_id: ${escapeHtml(safeAid)}">${escapeHtml(shorten(safeAid, 12))}</span>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div style="font-size:14px;"><strong>${total}</strong> <span class="muted" style="font-size:11px;">offer${total === 1 ? '' : 's'}</span></div>
        ${kindBits.length ? `<div style="font-size:11px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:2px;">${kindBits.join('<span class="muted">·</span>')}</div>` : ''}
        <div style="font-size:12px;margin-top:4px;">${floorLine}</div>
      </div>
      <button data-act="market-back-browse" title="Back to the asset index" style="font-size:11px;padding:6px 10px;flex-shrink:0;">← All assets</button>
    </div>`;
}

// Wires the back-button + asset_id copy chip on a freshly rendered asset
// header. The per-tile copy handler in the grid below targets a different
// scope, so we wire the header chip independently to keep the binding stable
// across re-renders that only touch the grid (e.g. liveness prune).
function bindMarketAssetHeader(scope) {
  // Two affordances both target the breadcrumb anchor + the in-card button
  // — querySelectorAll picks up both in one pass. Anchor's default href="#"
  // would jump to the top of the page if the click handler doesn't
  // preventDefault, so we do that explicitly.
  scope.querySelectorAll('[data-act="market-back-browse"]').forEach(el => {
    el.onclick = (ev) => { ev.preventDefault(); goToMarketBrowse(); };
  });
  const copyEl = scope.querySelector('[data-market-asset-header] span[data-act="copy-aid"]');
  if (copyEl) copyEl.onclick = async () => {
    try { await navigator.clipboard.writeText(copyEl.dataset.aid); toast('Asset ID copied', 'success'); }
    catch { /* clipboard blocked */ }
  };
}

// Hide the ticker-prefix search input when in asset mode — it's redundant
// once an asset is selected, and a stale value left in it would silently
// re-narrow rows on the next applyMarketFilters call. Browse mode shows it.
function updateMarketControlsVisibility() {
  const txt = $('#market-filter-asset');
  if (!txt) return;
  if (_marketView === 'browse') {
    txt.style.display = '';
  } else {
    txt.style.display = 'none';
    if (txt.value) txt.value = '';
  }
}

// Atomic-intent click handlers (browse-and-take flow). All four roles
// (maker/taker × claim/fulfil/take/cancel) sit on the Market tab; the
// state-aware buttons in the tile rendering pick the right one.
async function marketClaimIntentHandler(btn) {
  const aid = btn.dataset.aid;
  const iid = btn.dataset.iid;
  const price = parseInt(btn.dataset.price, 10);
  const ticker = btn.dataset.ticker;
  const amt = btn.dataset.amount;
  const dec = parseInt(btn.dataset.dec, 10);
  if (!confirm(
    `Claim atomic intent?\n\n` +
    `Buying:  ${fmtAssetAmount(BigInt(amt), dec)} ${ticker}\n` +
    `Price:   ${price.toLocaleString()} sats\n\n` +
    `On confirm: you'll commit one of your own confirmed sat UTXOs (≥ price) as proof of funds, and the intent locks for 5 min so no one else can claim it. The maker then generates a partial reveal targeted at your pubkey. Once they fulfil, you click Take to finalize and broadcast — atomic, single Bitcoin tx, no trust.`,
  )) return;
  btn.disabled = true; btn.textContent = 'claiming…';
  try {
    await claimAxferIntent({ assetIdHex: aid, intentIdHex: iid, priceSats: price });
    toast('Claim placed ✓ — wait for the maker to fulfil (refresh Market tab)', 'success', 6000);
    setTimeout(() => renderMarket(), 1000);
  } catch (e) {
    toast('Claim failed: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = 'Claim';
  }
}

async function marketFulfilIntentHandler(btn) {
  const aid = btn.dataset.aid;
  const iid = btn.dataset.iid;
  // Re-fetch fresh intent + claim state in case the cache is stale.
  const r = await fetch(withNet(ATOMIC_INTENTS_URL(aid)));
  const jj = await r.json().catch(() => ({}));
  const intent = (jj.intents || []).find(x => x.intent_id === iid);
  if (!intent) { toast('Intent not found', 'error'); return; }
  const claim = intent.claim;
  if (!claim) { toast('No active claim to fulfil', 'error'); return; }
  if (!confirm(
    `Fulfil claim from taker ${shorten(claim.taker_pubkey, 8)}?\n\n` +
    `The dapp builds a partial Bitcoin tx targeted at the taker's pubkey, locked so they can only broadcast if they pay you. ` +
    `Posts it to the worker. The taker then broadcasts in one atomic Bitcoin tx and you receive ${intent.price_sats.toLocaleString()} sats.`,
  )) return;
  btn.disabled = true; btn.textContent = 'fulfilling…';
  try {
    await fulfilAxferIntent({ assetIdHex: aid, intentIdHex: iid, intent, claim });
    toast('Fulfilment posted ✓ — taker can now broadcast', 'success', 6000);
    setTimeout(() => renderMarket(), 1000);
  } catch (e) {
    toast('Fulfilment failed: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = 'Fulfil claim';
  }
}

async function marketTakeIntentHandler(btn) {
  const aid = btn.dataset.aid;
  const iid = btn.dataset.iid;
  btn.disabled = true; btn.textContent = 'fetching…';
  try {
    const fres = await fetchAxferFulfilment({ assetIdHex: aid, intentIdHex: iid });
    if (!fres) { toast('Fulfilment not yet posted', 'error'); btn.disabled = false; btn.textContent = 'Take'; return; }
    const intent = fres.intent;
    if (!intent) throw new Error('intent missing from fulfilment response');
    if (!confirm(
      `Take this atomic intent?\n\n` +
      `Buying:  ${fmtAssetAmount(BigInt(intent.amount), intent.decimals || 0)} ${intent.ticker}\n` +
      `Price:   ${(intent.price_sats | 0).toLocaleString()} sats\n` +
      `Pay to:  ${intent.maker_address}\n\n` +
      `On confirm: the dapp appends your BTC funding to the maker's partial tx, signs the whole thing (locking in the maker's payment so it can't be redirected), and broadcasts. Atomic, single Bitcoin tx, no trust.`,
    )) { btn.disabled = false; btn.textContent = 'Take'; return; }
    btn.textContent = 'broadcasting…';
    const takeStrip = $('#market-take-progress');
    if (takeStrip) takeStrip.style.display = 'flex';
    setProgressStrip('market-take-progress', 0);
    const r = await takeAxferIntent({
      intent, fulfilment: fres.fulfilment,
      onProgress: (stage) => {
        if (stage === 'verify-start') setProgressStrip('market-take-progress', 0);
        else if (stage === 'sign-start') setProgressStrip('market-take-progress', 1);
        else if (stage === 'broadcast-start') setProgressStrip('market-take-progress', 2);
      },
    });
    setProgressStrip('market-take-progress', 3);
    setTimeout(() => { if (takeStrip) takeStrip.style.display = 'none'; setProgressStrip('market-take-progress', -1); }, 1200);
    toast(`Atomic take broadcast ✓ tx=${shorten(r.txid, 8)}`, 'success', 8000);
    btn.textContent = '✓ broadcast';
    setTimeout(() => renderMarket(), 2000);
    renderHoldings();
  } catch (e) {
    const takeStrip = $('#market-take-progress');
    if (takeStrip && takeStrip.style.display !== 'none') {
      const a = takeStrip.querySelector('.progress-step.active');
      const idx = a ? Number(a.dataset.step) : -1;
      if (idx >= 0) setProgressStrip('market-take-progress', -1, { errorAt: idx });
    }
    toast('Take failed: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = 'Take';
  }
}

async function marketCancelIntentHandler(btn) {
  const aid = btn.dataset.aid;
  const iid = btn.dataset.iid;
  // Re-fetch fresh intent state — the cached `fulfilment_pending` could be
  // stale relative to the worker, which decides our safety-rail branch below.
  let intent = null;
  try {
    const r = await fetch(withNet(ATOMIC_INTENTS_URL(aid)));
    const j = await r.json().catch(() => ({}));
    intent = (j.intents || []).find(x => x.intent_id === iid) || null;
  } catch { /* fall through with intent=null; standard path will report */ }
  // Liveness: if the asset UTXO is already spent, the intent is moot — either
  // the taker raced ahead or the maker already self-spent. Just clean up.
  let assetSpent = false;
  if (intent?.asset_utxo) {
    const sp = await getOutspend(intent.asset_utxo.txid, intent.asset_utxo.vout).catch(() => null);
    assetSpent = !!sp?.spent;
  }
  if (assetSpent) {
    if (!confirm('Asset UTXO already spent — the intent has settled or been cancelled elsewhere. Remove the marketplace record?')) return;
    btn.disabled = true; btn.textContent = 'cleaning up…';
    try {
      await cancelAxferIntent({ assetIdHex: aid, intentIdHex: iid });
      toast('Marketplace record removed ✓', 'success');
      setTimeout(() => renderMarket(), 500);
    } catch (e) {
      toast('Cleanup failed: ' + e.message, 'error');
      btn.disabled = false; btn.textContent = 'Cancel';
    }
    return;
  }
  // Critical: worker DELETE alone does NOT invalidate a partial reveal that's
  // already been signed at fulfilment time. The taker can still broadcast
  // within the 24h fulfilment TTL. The only way to truly cancel is to spend
  // the asset UTXO ourselves (self-CXFER), so the partial reveal references a
  // now-spent outpoint and Bitcoin consensus rejects it.
  if (intent?.fulfilment_pending) {
    if (!confirm(
      `⚠ You have fulfilled a claim. The taker can still broadcast their finalized tx within 24h unless you spend the asset UTXO yourself.\n\n` +
      `[OK]     Send the asset UTXO to yourself (Bitcoin tx fees apply) and remove the marketplace record. This invalidates the taker's pending tx — the only way to truly stop them.\n\n` +
      `[Cancel] Abort. No changes.`,
    )) return;
    btn.disabled = true; btn.textContent = 'self-spending…';
    try {
      // Locate the asset UTXO in our holdings to source the local opening that
      // buildAndBroadcastCXfer needs (amount + blinding).
      const holdings = await scanHoldings();
      const h = holdings.get(aid);
      const u = h?.utxos.find(x =>
        x.utxo.txid === intent.asset_utxo.txid && x.utxo.vout === intent.asset_utxo.vout,
      );
      if (!u) throw new Error('asset UTXO is not in holdings — the taker may have already broadcast.');
      if (!ensureBurnerBackedUp('Cancel fulfilled atomic intent (spends the listed asset UTXO via self-send)')) {
        btn.disabled = false; btn.textContent = 'Cancel';
        return;
      }
      const need = await estimateSatsForOp('cxfer');
      if (!(await ensureSatsFunded(need, 'Cancelling intent'))) {
        btn.disabled = false; btn.textContent = 'Cancel';
        return;
      }
      btn.textContent = 'broadcasting…';
      await buildAndBroadcastCXfer({
        assetIdHex: aid,
        recipientPubHex: bytesToHex(wallet.pub),
        amount: u.amount,
        forceUtxos: [u],
      });
      // The on-chain self-CXFER is what actually invalidated the partial reveal.
      // Worker DELETE is now best-effort cleanup so the entry stops appearing.
      await cancelAxferIntent({ assetIdHex: aid, intentIdHex: iid }).catch(() => {});
      toast('Intent cancelled · asset UTXO spent · taker can no longer broadcast ✓', 'success', 6000);
      setTimeout(() => { renderMarket(); renderHoldings(); renderActivity(); }, 500);
    } catch (e) {
      toast('Cancel failed: ' + e.message, 'error');
      btn.disabled = false; btn.textContent = 'Cancel';
    }
    return;
  }
  // Standard path: not fulfilled, asset still unspent. Worker DELETE is enough
  // because no partial reveal has been signed yet.
  if (!confirm('Cancel this atomic intent? The intent is removed from the marketplace immediately. The commit-tx output stays unspent on chain — you can recover it manually if needed.')) return;
  btn.disabled = true; btn.textContent = 'cancelling…';
  try {
    await cancelAxferIntent({ assetIdHex: aid, intentIdHex: iid });
    toast('Intent cancelled ✓', 'success');
    setTimeout(() => renderMarket(), 500);
  } catch (e) {
    toast('Cancel failed: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = 'Cancel';
  }
}

async function marketTakeHandler(btn) {
  const kind = btn.dataset.kind;
  const aid = btn.dataset.aid;
  const addr = btn.dataset.addr;
  const price = parseInt(btn.dataset.price, 10);
  const ticker = btn.dataset.ticker;
  const amt = btn.dataset.amount;
  const dec = parseInt(btn.dataset.dec, 10);
  const myPub = bytesToHex(wallet.pub);
  btn.disabled = true; btn.textContent = 'checking…';
  const v = await marketValidate(kind, aid, btn).catch(e => ({ ok: false, reason: e.message }));
  if (!v.ok) {
    toast('Take blocked: ' + v.reason, 'error');
    btn.disabled = false; btn.textContent = 'Take';
    return;
  }
  const msg =
    `Take this listing?\n\n` +
    `Buying:  ${kind === 'range' ? '≥ ' : ''}${fmtAssetAmount(BigInt(amt), dec)} ${ticker}\n` +
    `Price:   ${price.toLocaleString()} sats\n\n` +
    `STEPS:\n` +
    `1) Pay ${price.toLocaleString()} sats to:\n   ${addr}\n` +
    `2) Send your tacit pubkey to the maker (will be copied to clipboard):\n   ${myPub}\n` +
    `3) Maker broadcasts a CXFER of ${ticker} to your pubkey within 5 min.\n` +
    `4) The new UTXO appears in Holdings (auto-discovered via ECDH).\n\n` +
    `On confirm: the listing is reserved for you for 5 min. Settlement is OTC — counterparty trust still required.`;
  if (!confirm(msg)) { btn.disabled = false; btn.textContent = 'Take'; return; }
  btn.textContent = 'reserving…';
  try {
    if (kind === 'opening') {
      const txidHex = btn.dataset.txid;
      const vout = parseInt(btn.dataset.vout, 10);
      await claimListing({ assetIdHex: aid, txidHex, vout });
    } else {
      await claimRangeListing({ assetIdHex: aid, makerPubHex: btn.dataset.maker });
    }
  } catch (e) {
    toast('Take blocked: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = 'Take';
    return;
  }
  navigator.clipboard?.writeText(myPub).catch(() => {});
  toast('Reserved 5 min · pubkey copied · pay the maker, then send pubkey to them', 'success', 8000);
  btn.textContent = '✓ reserved';
}

async function marketVerifyHandler(btn) {
  btn.disabled = true; btn.textContent = 'verifying…';
  const v = await marketValidate(btn.dataset.kind, btn.dataset.aid, btn).catch(e => ({ ok: false, reason: e.message }));
  if (v.ok) {
    btn.textContent = '✓ verified';
    toast('Listing verified — sigs ✓ ownership ✓ commitment/proof ✓ live ✓', 'success');
  } else {
    btn.disabled = false; btn.textContent = 'Verify';
    toast('Verify failed: ' + v.reason, 'error');
  }
}

// Shared validation used by both Take and Verify on the Market tab. Re-fetches
// the listing (in case the cache is stale) and re-verifies every invariant.
async function marketValidate(kind, aid, btn) {
  if (kind === 'opening') {
    const txidHex = btn.dataset.txid;
    const vout = parseInt(btn.dataset.vout, 10);
    const r = await fetch(withNet(LISTINGS_URL(aid)));
    const jj = await r.json().catch(() => ({}));
    const lst = (jj.listings || []).find(x => x.txid === txidHex && x.vout === vout);
    if (!lst) return { ok: false, reason: 'listing vanished' };
    const ownerPubBytes = hexToBytes(lst.owner_pubkey);
    const xonly = ownerPubBytes.slice(1);
    const ro = await fetch(withNet(UTXO_OPENING_URL(txidHex, vout)));
    if (!ro.ok) return { ok: false, reason: 'opening missing' };
    const op = await ro.json();
    const oMsg = openingMsg(hexToBytes(aid), txidHex, vout, op.amount, hexToBytes(op.blinding), ownerPubBytes);
    if (!verifySchnorr(hexToBytes(op.sig), oMsg, xonly)) return { ok: false, reason: 'opening sig fails' };
    const lMsg = listingMsgBytes(hexToBytes(aid), txidHex, vout, lst.price_sats, lst.expiry, lst.maker_address, hexToBytes(op.sig));
    if (!verifySchnorr(hexToBytes(lst.listing_sig), lMsg, xonly)) return { ok: false, reason: 'listing sig fails' };
    let parentTx;
    try { parentTx = await getTx(txidHex); } catch (e) { return { ok: false, reason: 'parent tx not found: ' + e.message }; }
    const out = parentTx?.vout?.[vout];
    if (!out?.scriptpubkey) return { ok: false, reason: 'vout missing scriptpubkey' };
    const spk = hexToBytes(out.scriptpubkey);
    if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) return { ok: false, reason: 'vout is not P2WPKH' };
    if (bytesToHex(spk.slice(2, 22)) !== bytesToHex(hash160(ownerPubBytes))) return { ok: false, reason: 'owner_pubkey does not control this UTXO' };
    const wit = parentTx?.vin?.[0]?.witness;
    if (!wit || wit.length < 3) return { ok: false, reason: 'parent has no envelope' };
    let env;
    try { env = decodeEnvelopeScript(hexToBytes(wit[1])); } catch { env = null; }
    if (!env) return { ok: false, reason: 'envelope decode failed' };
    const pd = getParentEnvelopeData(env, vout, txidHex);
    if (!pd) return { ok: false, reason: 'cannot resolve commitment' };
    if (pd.assetIdHex !== aid) return { ok: false, reason: 'asset_id mismatch' };
    try {
      const claimed = pedersenCommit(BigInt(op.amount), BigInt('0x' + op.blinding));
      if (!claimed.equals(bytesToPoint(pd.commitment))) return { ok: false, reason: 'opening does not match on-chain commitment' };
    } catch (e) { return { ok: false, reason: 'commitment math failed: ' + e.message }; }
    const sp = await getOutspend(txidHex, vout).catch(() => null);
    if (!sp || sp.spent) return { ok: false, reason: 'UTXO already spent — listing stale' };
    return { ok: true };
  } else {
    const makerPub = btn.dataset.maker;
    const r = await fetch(withNet(RANGE_LISTINGS_URL(aid)));
    const jj = await r.json().catch(() => ({}));
    const lst = (jj.listings || []).find(x => x.owner_pubkey === makerPub);
    if (!lst) return { ok: false, reason: 'listing vanished' };
    return await validateRangeListingFully(lst);
  }
}

// SPEC §5.8 / §5.9 fair-launch (T_PETCH-rooted) registry. Rendered as a
// dedicated Discover section so users can tell CETCH (confidential supply)
// and T_PETCH (public fair-launch) apart at a glance — same envelope-version
// 0x01 binary on chain, but different trust models that should not share
// visual real estate. Fires alongside renderDiscover; failures here don't
// block the CETCH list from rendering.
//
// Client-side TTL cache mirrors _marketCache. Worker SWR + cron pre-warm
// already make first-fetch fast; this 30s in-memory cache means tab-switches
// and back-to-back renders skip the fetch entirely. Bust on T_PMINT broadcast
// (see buildAndBroadcastPmint) so cap progress + remaining-mints update
// immediately on the next render.
const PETCH_FETCH_TTL_MS = 30 * 1000;
let _petchCache = null;
let _petchFetchedAt = 0;
function invalidatePetchCache() { _petchFetchedAt = 0; }

async function renderPetchDiscover() {
  const list = $('#petch-discover-list');
  const statusEl = $('#petch-discover-status');
  if (!list) return;
  if (!PETCH_REGISTRY_URL) {
    list.innerHTML = `<div class="muted" style="padding:14px;font-size:12px;">discovery disabled (no Worker)</div>`;
    if (statusEl) setStatus(statusEl, '');
    return;
  }
  list.innerHTML = `<div class="muted" style="padding:14px;font-size:12px;"><span class="live-dots">loading</span></div>`;
  if (statusEl) setStatus(statusEl, 'loading', true);
  try {
    let j;
    if (_petchCache && (Date.now() - _petchFetchedAt) < PETCH_FETCH_TTL_MS) {
      j = _petchCache;
    } else {
      const r = await fetch(withNet(PETCH_REGISTRY_URL));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      j = await r.json();
      _petchCache = j;
      _petchFetchedAt = Date.now();
    }
    const assets = Array.isArray(j.assets) ? j.assets : [];
    if (!assets.length) {
      list.innerHTML = `<div class="empty">No public-mint assets deployed on ${escapeHtml(NET.name)} yet. Deploy one from the Etch tab.</div>`;
      if (statusEl) setStatus(statusEl, '');
      _lastDiscoverPetchCount = 0; _bumpDiscoverBadge();
      return;
    }
    const myWalletReady = wallet && wallet.address && typeof wallet.address === 'function';
    const tiles = assets.map(a => {
      const safeAid = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
      const dec = Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0;
      const cap = a.cap_amount ? BigInt(a.cap_amount) : 0n;
      const mintedNow = a.cumulative_minted ? BigInt(a.cumulative_minted) : 0n;
      const limit = a.mint_limit ? BigInt(a.mint_limit) : 0n;
      const remaining = cap - mintedNow;
      const remMints = limit > 0n ? remaining / limit : 0n;
      const pct = cap > 0n ? Number(mintedNow * 10000n / cap) / 100 : 0;
      const capFull = remaining <= 0n;
      // Height-window check is best-effort here: tip + start_height come from
      // the worker's response. If we can't determine, leave the button enabled
      // and let buildAndBroadcastPmint fail loudly downstream rather than
      // pre-judging in the UI. The cap-full check is unambiguous.
      const tip = Number.isInteger(j?.meta?.tip) ? j.meta.tip : null;
      const startH = Number(a.mint_start_height) || 0;
      const endH = Number(a.mint_end_height) || 0;
      const beforeWindow = tip != null && startH > 0 && tip < startH;
      const afterWindow = tip != null && endH > 0 && tip > endH;
      let mintReason = '';
      let mintDisabled = false;
      if (capFull) { mintDisabled = true; mintReason = 'cap reached'; }
      else if (beforeWindow) { mintDisabled = true; mintReason = `opens at block ${startH}`; }
      else if (afterWindow) { mintDisabled = true; mintReason = 'mint window closed'; }
      else if (!myWalletReady) { mintDisabled = true; mintReason = 'wallet not ready'; }
      const imgUrl = normalizeImageUri(a.image_uri || a.imageUri);
      return `
        <div class="asset-card" data-petch-aid="${escapeHtml(safeAid)}" data-petch-cap="${escapeHtml(cap.toString())}" data-petch-limit="${escapeHtml(limit.toString())}" style="border:1px solid var(--ink);padding:14px;background:var(--bg-warm);margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:12px;">
            ${imgUrl
              ? `<img loading="lazy" decoding="async" src="${escapeHtml(imgUrl)}" alt="" style="width:40px;height:40px;border:1px solid var(--ink);object-fit:cover;background:#fff;flex-shrink:0;">`
              : `<div style="width:40px;height:40px;border:1px solid var(--ink-mid);background:var(--bg);flex-shrink:0;"></div>`}
            <div style="min-width:0;flex:1;">
              <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
                <strong style="font-size:16px;">${escapeHtml(a.ticker || '?')}</strong>
                <span style="display:inline-block;padding:1px 6px;background:#7d4ff7;color:#fff;font-size:9px;border-radius:2px;" title="Permissionless fair-launch (SPEC §5.8 / §5.9)">⚡ public mint</span>
              </div>
              <div style="font-size:10px;color:var(--ink-mid);font-family:var(--mono);margin-top:2px;">${escapeHtml(shorten(safeAid, 12))}</div>
            </div>
            <button data-act="petch-mint" data-etch-txid="${escapeHtml(a.etch_txid || '')}" data-aid="${escapeHtml(safeAid)}" data-ticker="${escapeHtml(a.ticker || '?')}" data-limit="${escapeHtml(a.mint_limit || '0')}" data-decimals="${dec}" ${mintDisabled ? 'disabled' : ''} style="flex-shrink:0;${mintDisabled ? '' : 'background:#7d4ff7;color:#fff;border-color:#5a36c4;'}">
              ${mintDisabled ? `Mint · ${escapeHtml(mintReason)}` : `Mint ${escapeHtml(fmtAssetAmount(limit, dec))}`}
            </button>
          </div>
          <div style="margin-top:10px;font-size:11px;display:flex;gap:14px;flex-wrap:wrap;color:var(--ink-mid);">
            <span><strong style="color:var(--ink);">${escapeHtml(fmtAssetAmount(mintedNow, dec))}</strong> / ${escapeHtml(fmtAssetAmount(cap, dec))} ${escapeHtml(a.ticker || '')}</span>
            <span>·</span>
            <span>${escapeHtml(remMints.toString())} mints remaining</span>
            <span>·</span>
            <span>${escapeHtml(fmtAssetAmount(limit, dec))} per mint</span>
          </div>
          <div style="margin-top:8px;height:6px;border:1px solid var(--ink);background:var(--bg);overflow:hidden;">
            <div style="height:100%;background:${capFull ? '#a04030' : '#7d4ff7'};width:${pct}%;transition:width 0.2s;"></div>
          </div>
          <div data-petch-optimistic data-optimistic-minted="0" style="display:none;margin-top:6px;font-size:10px;color:#5a36c4;font-style:italic;"></div>
          ${a.pending_pmint_count > 0
            ? `<div class="muted" style="margin-top:6px;font-size:10px;">${a.pending_pmint_count} mint${a.pending_pmint_count === 1 ? '' : 's'} pending (≥3 confs to credit)</div>`
            : ''}
        </div>`;
    }).join('');
    list.innerHTML = tiles;
    if (statusEl) setStatus(statusEl, `${assets.length} asset${assets.length === 1 ? '' : 's'}`);
    _lastDiscoverPetchCount = assets.length; _bumpDiscoverBadge();
    list.querySelectorAll('button[data-act="petch-mint"]').forEach(btn => {
      btn.onclick = async () => {
        const etchTxid = btn.dataset.etchTxid;
        const ticker = btn.dataset.ticker;
        const limitStr = btn.dataset.limit;
        const dec = parseInt(btn.dataset.decimals, 10) || 0;
        const limitDisp = fmtAssetAmount(BigInt(limitStr || '0'), dec);
        if (!confirm(`Mint ${limitDisp} ${ticker}?\n\nThis broadcasts a T_PMINT (commit + reveal). Cost: ~${(await estimateSatsForOp('etch')).toLocaleString()} sats in Bitcoin fees. The minted UTXO appears in your Holdings; cap-credit lands after 3 confirmations.`)) return;
        if (!ensureBurnerBackedUp('Mint a public-mint asset (T_PMINT; broadcasts a commit+reveal pair)')) return;
        const need = await estimateSatsForOp('etch');
        if (!(await ensureSatsFunded(need, 'Minting'))) return;
        const origLabel = btn.textContent;
        btn.disabled = true; btn.textContent = 'minting…';
        // Shared #pmint-progress strip lives just above the registry list.
        // Mark it with the in-flight ticker so a parallel render — which
        // would otherwise blow it away by re-rendering the list — can leave
        // it alone if the mint is still going.
        const pmintStrip = $('#pmint-progress');
        if (pmintStrip) {
          pmintStrip.style.display = 'flex';
          pmintStrip.dataset.ticker = ticker;
        }
        setProgressStrip('pmint-progress', 0);
        try {
          const r = await buildAndBroadcastPmint({
            etchTxidHex: etchTxid,
            onProgress: (stage) => {
              if (stage === 'commit-start') setProgressStrip('pmint-progress', 1);
              else if (stage === 'reveal-start') setProgressStrip('pmint-progress', 2);
            },
          });
          setProgressStrip('pmint-progress', 4);
          setTimeout(() => {
            if (pmintStrip) {
              pmintStrip.style.display = 'none';
              delete pmintStrip.dataset.ticker;
            }
            setProgressStrip('pmint-progress', -1);
          }, 1200);
          toast(`Minted ${limitDisp} ${ticker} — pending until ≥3 confs`, 'success', 8000);
          // Optimistic UI update: bump cap-progress + remaining-mints + pending
          // counter on this tile right away so the user sees their action
          // reflected without waiting for the next /petch-assets fetch (worker
          // takes ~5 min to re-index, plus the 30s edge cache). The next render
          // overwrites with authoritative numbers from chain — until then this
          // is the accurate "what just happened" view.
          try {
            const card = btn.closest('[data-petch-aid]');
            if (card) {
              const minted = BigInt(limitStr || '0');
              const optimisticEl = card.querySelector('[data-petch-optimistic]');
              if (optimisticEl) {
                const prior = BigInt(optimisticEl.dataset.optimisticMinted || '0');
                optimisticEl.dataset.optimisticMinted = String(prior + minted);
                optimisticEl.textContent = `+${fmtAssetAmount(prior + minted, dec)} ${ticker} pending — refresh in ~5 min for chain-confirmed counters`;
                optimisticEl.style.display = '';
              }
              // Re-disable the button as a soft-cooldown so a frustrated double-
              // click doesn't fan out N parallel commit+reveal pairs (each
              // burns sats). Re-enable after 6s — long enough for the user to
              // see the "minted" toast, short enough to allow another mint
              // since cap-fill needs many minters anyway. Anyone (incl. this
              // user) can mint again until cap, so we don't permanently lock.
              btn.disabled = true;
              btn.textContent = `Minted · cooldown 6s`;
              setTimeout(() => {
                btn.disabled = false;
                btn.textContent = origLabel;
              }, 6000);
            }
          } catch (e) { console.warn('optimistic petch update failed', e); }
          // Bust holdings cache so the new pending UTXO surfaces immediately.
          if (typeof invalidateHoldingsCache === 'function') invalidateHoldingsCache();
          // Refresh the petch list so the cap progress + pending counter update.
          // (The optimistic block above already covers the in-flight wait.)
          renderPetchDiscover();
        } catch (e) {
          if (pmintStrip && pmintStrip.style.display !== 'none') {
            const activeStep = pmintStrip.querySelector('.progress-step.active');
            const errIdx = activeStep ? Number(activeStep.dataset.step) : -1;
            if (errIdx >= 0) setProgressStrip('pmint-progress', -1, { errorAt: errIdx });
          }
          toast(`Mint failed: ${e.message}`, 'error');
          console.error(e);
          btn.disabled = false; btn.textContent = origLabel;
        }
      };
    });
  } catch (e) {
    list.innerHTML = `<div class="error">Public-mint registry load failed: ${escapeHtml(e.message)}</div>`;
    if (statusEl) setStatus(statusEl, 'error');
    console.error(e);
  }
}

async function renderDiscover(force = false) {
  // Kick off the petch-discover render in parallel — it has its own DOM
  // section + status indicator, so failure here doesn't block the CETCH
  // list and vice versa.
  renderPetchDiscover().catch(e => console.warn('renderPetchDiscover failed', e));
  const list = $('#discover-list');
  const statusEl = $('#discover-status');
  if (!REGISTRY_URL) {
    list.innerHTML = `<div class="muted" style="padding:14px;">discovery disabled (no Worker)</div>`;
    setStatus(statusEl, '');
    return;
  }
  list.innerHTML = `<div class="skeleton"><div class="skeleton-row medium"></div><div class="skeleton-row short"></div><div class="skeleton-row"></div></div>`;
  setStatus(statusEl, 'loading', true);
  try {
    // Registry response is cached for ~60s by default; the Refresh button
    // passes force=true to bypass and re-fetch. Tab-switches reuse the cache.
    const j = await loadDiscoverRegistry(force);
    const ls = j.meta?.last_scanned, tip = j.meta?.tip;
    const tipUnavailable = j.meta?.tip_unavailable === true;
    // Three states: tip known + matches → caught up · tip known + behind →
    // show delta · tip unknown → flag the upstream outage instead of
    // silently labelling "caught up".
    const freshness = Number.isInteger(ls)
      ? `<div class="muted" style="font-size:10px;text-align:right;margin-bottom:8px;">scanned through block ${ls}${
          tipUnavailable ? ' · <span style="color:var(--red);">tip unavailable</span>'
          : Number.isInteger(tip) ? (tip > ls ? ` · ${tip - ls} block${tip - ls === 1 ? '' : 's'} behind tip` : ' · caught up')
          : ''
        }</div>`
      : '';
    setStatus(statusEl, j.assets?.length ? `${j.assets.length} asset${j.assets.length === 1 ? '' : 's'}` : '');
    _lastDiscoverCetchCount = j.assets?.length || 0; _bumpDiscoverBadge();
    if (!j.assets || !j.assets.length) {
      list.innerHTML = freshness + `<div class="empty">No assets etched on ${NET.name} yet. Be the first.</div>`;
      return;
    }
    // Stamp ticker-collision precedence (first-etched wins) so each card
    // can show the right warning. Pure on-chain-derived; no centralized list.
    markTickerCollisions(j.assets);
    // Reset the etcher reputation map for this load and pre-populate from
    // cached etch verifications so the first card render can already show
    // "K other assets" rows when the user has visited Discover before. Any
    // not-yet-cached etch verifies will register their etcher when they
    // complete (see _processDiscoverCardVerify).
    _discoverEtcherMap = new Map();
    for (const _a of j.assets) {
      const _cached = getCachedDiscoverEtch(_a.asset_id, _a.etch_txid);
      if (_cached?.etcherXonly) _discoverRegisterEtcher(_cached.etcherXonly, _a.asset_id);
    }
    list.innerHTML = freshness;
    // EAGER RENDER. Each card mounts immediately with worker-supplied strings
    // (ticker, decimals, image, asset_id) under a "verifying…" badge — the
    // user sees usable content within a frame instead of waiting for the
    // chain walk. The verified render replaces the card's innerHTML once
    // verifyDiscoverAsset completes; background enrichment (attestation /
    // mints / burns) re-renders again as each stage lands. card.dataset.
    // verifyState transitions: 'pending' → 'verified' | 'failed'.
    const cards = new Map();   // asset_id → card DOM element
    for (const a of j.assets) {
      const card = document.createElement('div');
      card.className = 'asset-card';
      const aidSel = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
      card.dataset.aid = aidSel;
      card.dataset.verifyState = 'pending';
      const eagerImgUri = a.image_uri || null;
      const eagerExtras = eagerImgUri ? getMetadataExtras(eagerImgUri) : null;
      // Render synchronously without waiting for image — the avatar fills in
      // via the resolveImageUri promise below, only if the card is still pending.
      renderDiscoverCard(card, a, { ok: 'pending' }, null, eagerExtras);
      list.appendChild(card);
      cards.set(a.asset_id, card);
      if (eagerImgUri) {
        resolveImageUri(eagerImgUri)
          .then(url => {
            // The verified render runs its own resolveImageUri (cache hit by
            // then), so skip the eager update if the card has already
            // upgraded — avoids a redundant innerHTML write.
            if (url && card.dataset.verifyState === 'pending') {
              renderDiscoverCard(card, a, { ok: 'pending' }, url, eagerExtras);
            }
          })
          .catch(() => { /* image resolution is best-effort */ });
      }
    }
    // STAGE 1: LAZY VIEWPORT-DRIVEN ETCH VERIFY. Pre-fix the verify pool
    // walked through every asset on load, even ones the user never scrolled
    // to — pure CPU/battery waste at scale. Now: each card's chain walk is
    // gated on IntersectionObserver. Cache hits process eagerly (free) so
    // the user gets immediate ✓ badges on already-verified assets; cold
    // chain walks defer until the card is in viewport (with a 300px margin
    // so a fast scroller pre-warms the next page's worth of cards).
    //
    // Concurrency is enforced via a single semaphore shared by all cards,
    // so the UI thread isn't saturated when many cards become visible at
    // once. Stats counters tick as work completes; an empty pending queue
    // collapses the stats display.
    _setDiscoverVerifyStats({ total: j.assets.length, verified: 0, failed: 0, cached: 0, pending: j.assets.length });
    const observer = _ensureDiscoverVerifyObserver();
    for (const a of j.assets) {
      const card = cards.get(a.asset_id);
      if (!card) continue;
      card._discoverAsset = a;
      // Cache-hit fast path: process immediately. The verify cost is
      // negligible (localStorage decode + small crypto check) so deferring
      // would only delay the ✓ badge for no CPU savings.
      if (getCachedDiscoverEtch(a.asset_id, a.etch_txid)) {
        _processDiscoverCardVerify(card, a);
      } else {
        // Cold path: defer until the card scrolls into view.
        observer.observe(card);
      }
    }
    // The verify work is no longer awaited here — it streams in via the
    // observer and the cache-hit fast path. The listings panel below runs
    // independently. Stats stop ticking once every card is processed.
    // (asset_id short/full toggles are wired per-card inside renderDiscoverCard.)
    // Open listings panel — shares the Market tab's /market aggregate so
    // Discover doesn't pay its own N×listings fan-out. /market already
    // returns kind-tagged, _asset-joined, server-filtered (non-expired)
    // listings, so we just filter to `kind === 'opening'` here. Reuses
    // _marketCache when fresh; populates it otherwise so a subsequent
    // Market tab open lands on a cache hit too.
    let _marketData;
    if (_marketCache && (Date.now() - _marketFetchedAt) < MARKET_FETCH_TTL_MS) {
      _marketData = _marketCache;
    } else {
      _marketData = await fetchMarketData().catch(() => ({ assets: [], listings: [] }));
      _marketCache = _marketData;
      _marketFetchedAt = Date.now();
    }
    const flat = (_marketData.listings || [])
      .filter(l => l.kind === 'opening' && !l.expired)
      .sort((a, b) => (b.listed_at || 0) - (a.listed_at || 0));
    if (flat.length > 0) {
        const section = document.createElement('div');
        section.className = 'section';
        section.style.marginTop = '24px';
        section.innerHTML = `
          <div class="section-header">
            <span>market · open listings</span>
            <span class="muted">${flat.length} live</span>
          </div>
          <div class="section-body">
            <div class="muted" style="font-size:12px;margin-bottom:14px;">
              Bilateral OTC offers. Settlement is off-chain in v1: pay the maker's
              address in sats, then the maker broadcasts a CXFER to your pubkey.
              Counterparty trust required (or use a 2-of-2 escrow).
            </div>
            <div id="market-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;"></div>
          </div>`;
        list.appendChild(section);
        const grid = section.querySelector('#market-grid');
        for (const l of flat) {
          const a = l._asset;
          const safeAid = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
          const dec = Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0;
          const expIso = new Date((l.expiry || 0) * 1000).toISOString().slice(0,10);
          // Duplicate-ticker warning — mirrors the Market tab so a buyer
          // browsing this footer gallery can't accidentally trust an
          // impostor that copied an existing asset's ticker.
          const collisionDup = a._tickerCollision === 'duplicate'
            ? `<span style="display:inline-block;padding:1px 6px;background:var(--red);color:#fff;font-size:9px;border-radius:2px;margin-left:6px;cursor:help;" title="Tickers aren't unique on tacit — multiple assets can share a name. The asset_id is the only canonical reference. Another asset claimed this ticker first; verify the asset_id below before buying.">⚠ DUP</span>`
            : a._tickerCollision === 'original'
              ? `<span style="display:inline-block;padding:1px 6px;background:#a04030;color:#fff;font-size:9px;border-radius:2px;margin-left:6px;cursor:help;" title="This asset was etched first under this ticker, but tickers aren't unique on tacit — the asset_id is the canonical reference. Verify it before sending or buying.">earliest</span>`
              : '';
          const tile = document.createElement('div');
          tile.style.cssText = 'border:1px solid var(--ink);padding:12px;background:var(--bg-warm);';
          tile.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <div><strong>${escapeHtml(a.ticker || '?')}</strong>${collisionDup} <span class="muted" style="font-size:10px;">${escapeHtml(shorten(safeAid, 4))}</span></div>
              <div style="font-size:11px;" class="muted">${(() => { const r = relativeAge(l.listed_at); return r ? `listed ${escapeHtml(r)} ago · expires ${expIso}` : `expires ${expIso}`; })()}</div>
            </div>
            ${a._tickerCollision === 'duplicate' ? `<div style="margin-top:6px;font-size:10px;color:var(--red);">⚠ ticker shared with an earlier asset — verify asset_id before trading</div>` : ''}
            <div style="margin-top:6px;font-size:18px;">${escapeHtml(fmtAssetAmount(BigInt(l.amount || '0'), dec))} <span style="font-size:11px;" class="muted">${escapeHtml(a.ticker || '')}</span></div>
            <div style="margin-top:4px;font-size:14px;color:#0a8f43;"><strong>${(l.price_sats || 0).toLocaleString()} sats</strong>${(() => { const u = unitPriceSats(Number(l.price_sats || 0), BigInt(l.amount || 0), dec); return u != null ? `<span class="muted" style="font-size:11px;margin-left:6px;">· ${fmtUnitPriceSats(u)} sats/${escapeHtml(a.ticker || 'token')}</span>` : ''; })()}</div>
            <div style="margin-top:8px;font-size:10px;" class="muted">maker: <span class="mono-box inline">${escapeHtml(shorten(l.maker_address || '', 6))}</span></div>
            <div style="margin-top:10px;display:flex;gap:6px;">
              <button data-act="take-listing" data-aid="${escapeHtml(safeAid)}" data-txid="${escapeHtml(l.txid || '')}" data-vout="${l.vout|0}" data-price="${l.price_sats|0}" data-addr="${escapeHtml(l.maker_address || '')}" data-ticker="${escapeHtml(a.ticker || '?')}" data-amount="${escapeHtml(l.amount || '0')}" data-dec="${dec}" style="flex:1;font-size:11px;">Take</button>
              <button data-act="verify-listing" data-aid="${escapeHtml(safeAid)}" data-txid="${escapeHtml(l.txid || '')}" data-vout="${l.vout|0}" style="font-size:11px;">Verify</button>
            </div>
          `;
          grid.appendChild(tile);
        }
        // Take button: surface payment instructions; settlement is OTC.
        // Full client-side validation. Re-checks every layer the worker promises:
        // sigs, P2WPKH ownership, Pedersen binding against on-chain commitment,
        // and UTXO liveness. Returns { ok, reason?, lst, op, parentTx }.
        async function validateListingFully(aid, txidHex, vout) {
          const r = await fetch(withNet(LISTINGS_URL(aid)));
          const jj = await r.json();
          const lst = (jj.listings || []).find(x => x.txid === txidHex && x.vout === vout);
          if (!lst) return { ok: false, reason: 'listing vanished' };
          const ownerPubBytes = hexToBytes(lst.owner_pubkey);
          const xonly = ownerPubBytes.slice(1);
          const ro = await fetch(withNet(UTXO_OPENING_URL(txidHex, vout)));
          if (!ro.ok) return { ok: false, reason: 'opening missing' };
          const op = await ro.json();
          // Sig 1: opening sig.
          const oMsg = openingMsg(hexToBytes(aid), txidHex, vout, op.amount, hexToBytes(op.blinding), ownerPubBytes);
          if (!verifySchnorr(hexToBytes(op.sig), oMsg, xonly)) return { ok: false, reason: 'opening sig fails' };
          // Sig 2: listing sig (binds price + expiry + address + opening_sig).
          const lMsg = listingMsgBytes(hexToBytes(aid), txidHex, vout, lst.price_sats, lst.expiry, lst.maker_address, hexToBytes(op.sig));
          if (!verifySchnorr(hexToBytes(lst.listing_sig), lMsg, xonly)) return { ok: false, reason: 'listing sig fails' };
          // Ownership: P2WPKH(hash160(owner_pubkey)) must match the UTXO's spk.
          let parentTx;
          try { parentTx = await getTx(txidHex); }
          catch (e) { return { ok: false, reason: 'parent tx not found: ' + e.message }; }
          const out = parentTx?.vout?.[vout];
          if (!out?.scriptpubkey) return { ok: false, reason: 'vout missing scriptpubkey' };
          const spk = hexToBytes(out.scriptpubkey);
          if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) return { ok: false, reason: 'vout is not P2WPKH' };
          if (bytesToHex(spk.slice(2, 22)) !== bytesToHex(hash160(ownerPubBytes))) {
            return { ok: false, reason: 'owner_pubkey does not control this UTXO' };
          }
          // Pedersen: claimed (amount, blinding) must open the on-chain commitment.
          const wit = parentTx?.vin?.[0]?.witness;
          if (!wit || wit.length < 3) return { ok: false, reason: 'parent has no envelope' };
          let env;
          try { env = decodeEnvelopeScript(hexToBytes(wit[1])); } catch { env = null; }
          if (!env) return { ok: false, reason: 'envelope decode failed' };
          const pd = getParentEnvelopeData(env, vout, txidHex);
          if (!pd) return { ok: false, reason: 'cannot resolve commitment from envelope' };
          if (pd.assetIdHex !== aid) return { ok: false, reason: 'asset_id mismatch with parent envelope' };
          try {
            const claimed = pedersenCommit(BigInt(op.amount), BigInt('0x' + op.blinding));
            if (!claimed.equals(bytesToPoint(pd.commitment))) {
              return { ok: false, reason: 'opening does not match on-chain commitment' };
            }
          } catch (e) {
            return { ok: false, reason: 'commitment math failed: ' + e.message };
          }
          // Liveness: refuse if the UTXO has already been spent.
          const sp = await getOutspend(txidHex, vout);
          if (sp?.spent) return { ok: false, reason: 'UTXO already spent — listing is stale' };
          return { ok: true, lst, op, parentTx };
        }

        grid.querySelectorAll('button[data-act="take-listing"]').forEach(btn => {
          btn.onclick = async () => {
            const aid = btn.dataset.aid;
            const txidHex = btn.dataset.txid;
            const vout = parseInt(btn.dataset.vout, 10);
            const addr = btn.dataset.addr;
            const price = parseInt(btn.dataset.price, 10);
            const ticker = btn.dataset.ticker;
            const amt = btn.dataset.amount;
            const dec = parseInt(btn.dataset.dec, 10);
            const myPub = bytesToHex(wallet.pub);
            btn.disabled = true; btn.textContent = 'checking…';
            // Full client-side validation before showing payment instructions.
            // Same code path as Verify so a Take is never offered for a listing
            // that wouldn't pass Verify.
            const v = await validateListingFully(aid, txidHex, vout).catch(e => ({ ok: false, reason: e.message }));
            if (!v.ok) {
              toast('Take blocked: ' + v.reason, 'error');
              btn.disabled = false; btn.textContent = 'Take';
              return;
            }
            // Confirm BEFORE claiming. If the user cancels, no 5-min stale
            // claim is left behind blocking other takers. Two takers racing
            // past the dialog is exactly the case the claim mechanism is
            // designed to resolve: one wins, one sees a clear "already
            // claimed" error.
            const msg =
              `Take this listing?\n\n` +
              `Buying:  ${fmtAssetAmount(BigInt(amt), dec)} ${ticker}\n` +
              `Price:   ${price.toLocaleString()} sats\n\n` +
              `STEPS:\n` +
              `1) Pay ${price.toLocaleString()} sats to:\n   ${addr}\n` +
              `2) Send your tacit pubkey to the maker (will be copied to clipboard):\n   ${myPub}\n` +
              `3) Maker broadcasts a CXFER of ${ticker} to your pubkey within 5 min.\n` +
              `4) The new UTXO appears in Holdings (auto-discovered via ECDH).\n\n` +
              `On confirm: the listing is reserved for you for 5 min so no one else can pay the maker for the same UTXO. ` +
              `Settlement is OTC — counterparty trust still required.`;
            if (!confirm(msg)) {
              btn.disabled = false; btn.textContent = 'Take';
              return;
            }
            btn.textContent = 'reserving…';
            try {
              await claimListing({ assetIdHex: aid, txidHex, vout });
            } catch (e) {
              toast('Take blocked: ' + e.message, 'error');
              btn.disabled = false; btn.textContent = 'Take';
              return;
            }
            navigator.clipboard?.writeText(myPub).catch(() => {});
            toast('Reserved 5 min · pubkey copied · pay the maker, then send pubkey to them', 'success', 8000);
            btn.textContent = '✓ reserved';
          };
        });
        grid.querySelectorAll('button[data-act="verify-listing"]').forEach(btn => {
          btn.onclick = async () => {
            const aid = btn.dataset.aid;
            const txidHex = btn.dataset.txid;
            const vout = parseInt(btn.dataset.vout, 10);
            btn.disabled = true; btn.textContent = 'verifying…';
            const v = await validateListingFully(aid, txidHex, vout).catch(e => ({ ok: false, reason: e.message }));
            if (v.ok) {
              btn.textContent = '✓ verified';
              toast('Listing verified — sigs ✓ ownership ✓ commitment ✓ live ✓', 'success');
            } else {
              btn.disabled = false; btn.textContent = 'Verify';
              toast('Verify failed: ' + v.reason, 'error');
            }
          };
        });
      }
  } catch (e) {
    list.innerHTML = `<div class="error">Discovery failed: ${escapeHtml(e.message)}</div>`;
    setStatus(statusEl, 'error');
    console.error(e);
  }
  // Re-apply the Discover filter + sort (if any) after a refresh so the
  // user's current query and ordering stay active across re-renders.
  applyDiscoverSort();
  applyDiscoverFilter();
  // Deep-link consumer: if a Wallet-tab tile click set a target, find the
  // corresponding card and scroll into view with a brief highlight pulse.
  if (pendingDiscoverFocus) {
    const aid = pendingDiscoverFocus;
    pendingDiscoverFocus = null;
    requestAnimationFrame(() => {
      const card = list.querySelector(`.asset-card[data-aid="${aid}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('highlight-pulse');
        setTimeout(() => card.classList.remove('highlight-pulse'), 1800);
      }
    });
  }
}

// ============== EXTERNAL WALLET UI ==============
function renderExtWalletPanel() {
  // Disable connect-buttons whose providers aren't installed, regardless of
  // current connection state — the buttons live on the home card now.
  const av = extWallet.available();
  const x = $('#btn-ext-connect-xverse');
  const u = $('#btn-ext-connect-unisat');
  if (x) {
    x.disabled = !av.satsConnect;
    x.title = av.satsConnect ? '' : 'sats-connect could not load (Xverse / Leather extension not detected)';
  }
  if (u) {
    u.disabled = !av.unisat;
    u.title = av.unisat ? '' : 'window.unisat not present (UniSat extension not detected)';
  }
  // Status text (kept for legacy callers; visible signal is the badge).
  const status = $('#ext-wallet-status');
  if (status) status.textContent = wallet.ext ? `✓ ${wallet.ext.provider} (${shorten(wallet.ext.address, 8)})` : 'not connected';
  // Manage-wallet drawer: populate the connected-info card when present.
  if (wallet.ext) {
    const provEl = $('#ext-wallet-provider');
    const addrEl = $('#ext-wallet-address');
    const netEl  = $('#ext-wallet-network');
    if (provEl) provEl.textContent = wallet.ext.provider;
    if (addrEl) addrEl.textContent = wallet.ext.address;
    if (netEl)  netEl.textContent = wallet.ext.network || '—';
  }
  // Re-evaluate the network selector lock + the home-card visuals whenever the
  // ext-wallet state changes (covers connect, disconnect, silent restore).
  setupNetworkSelect();
  renderWalletCard();
}

async function rebindToExt() {
  // After a successful connect, rotate the in-memory tacit identity to the
  // privkey bound to this external wallet's address. Generates a fresh one if
  // this wallet has never been seen on this device.
  const addr = wallet.ext.address;
  // If the user was in passkey mode (wallet.mode='passkey') we're now
  // switching out of it — clear the marker so the backup badge, mainnet
  // hints, and ensureBurnerBackedUp gate stop treating this session as
  // passkey-backed. The PRF map (the credential pointers) persists; only
  // the in-memory active-mode flag and prfWallet.state are cleared.
  if (wallet.mode === 'passkey') {
    wallet.mode = null;
    prfWallet.state = null;
  }
  await wallet.load(addr);
  setActiveWalletMode('ext');
  await refreshWallet();
  renderExtWalletPanel();
  // Connecting an external wallet is the strongest "I'm past step 1" signal.
  if (typeof markOnboarded === 'function') markOnboarded();
}

// Shared tear-down for "external wallet went away" — used by the manual
// disconnect button and by the UniSat accountsChanged listener when the user
// signs out from the wallet side. Falls back to the global burner wallet so
// the dApp keeps working.
async function applyExtDisconnect() {
  extWallet.disconnect();
  await wallet.load();
  refreshWallet();
  renderExtWalletPanel();
}

// Connect-button race guard. Without this, clicking Xverse and UniSat in
// quick succession kicks off two parallel connect flows that race for
// extWallet.state and EXT_MODE_KEY. The flag stays true through the whole
// connect → reconcile → rebind sequence.
let _extConnecting = false;

function setupExtWalletButtons() {
  const xBtn = $('#btn-ext-connect-xverse');
  const uBtn = $('#btn-ext-connect-unisat');
  const fundBtn = $('#btn-ext-fund');
  const discBtn = $('#btn-ext-disconnect');

  // Disable both connect buttons while either is in flight.
  const lockConnects = () => {
    if (xBtn) xBtn.disabled = true;
    if (uBtn) uBtn.disabled = true;
  };
  // Restore button state. renderExtWalletPanel re-evaluates availability and
  // sets `disabled` accordingly, so we just delegate to it.
  const unlockConnects = () => renderExtWalletPanel();

  if (xBtn) xBtn.onclick = async () => {
    if (_extConnecting) return;
    _extConnecting = true;
    lockConnects();
    xBtn.textContent = 'connecting…';
    try {
      const st = await extWallet.connectSatsConnect();
      // If the wallet is on a different network than the dApp, switch + reload
      // so address derivation and API calls all line up. 'unsupported' means
      // reconcile already disconnected; 'reload' means a reload is queued.
      if (reconcileWalletNetwork(st) !== 'ok') return;
      await rebindToExt();
      toast('Connected ' + st.provider, 'success');
    } catch (e) {
      toast('Connect failed: ' + e.message, 'error');
    } finally {
      _extConnecting = false;
      xBtn.textContent = 'Connect Xverse / Leather';
      unlockConnects();
    }
  };
  if (uBtn) uBtn.onclick = async () => {
    if (_extConnecting) return;
    _extConnecting = true;
    lockConnects();
    uBtn.textContent = 'connecting…';
    try {
      const st = await extWallet.connectUnisat();
      if (reconcileWalletNetwork(st) !== 'ok') return;
      await rebindToExt();
      toast('Connected UniSat', 'success');
    } catch (e) {
      toast('Connect failed: ' + e.message, 'error');
    } finally {
      _extConnecting = false;
      uBtn.textContent = 'Connect UniSat';
      unlockConnects();
    }
  };
  if (fundBtn) fundBtn.onclick = (e) => {
    if (!wallet.ext) return;
    openInlineForm(e.currentTarget, {
      submitLabel: 'Send sats',
      content: `
        <label>Amount (sats)</label>
        <input type="text" inputmode="numeric" data-field="sats" value="20000">
        <div class="muted" style="margin-top:6px;font-size:11px;">
          Sends from your connected external wallet to the in-page tacit identity
          <span class="mono-box inline" style="font-size:10px;">${escapeHtml(wallet.address())}</span>.
          Your wallet will pop up to approve the transfer.
        </div>`,
      onSubmit: async ({ host, errEl }) => {
        const sats = parseInt(host.querySelector('[data-field="sats"]').value.trim(), 10);
        if (!Number.isFinite(sats) || sats <= 0) { errEl.textContent = 'enter a positive integer'; return false; }
        const txid = await extWallet.sendSats(wallet.address(), sats);
        toast(`Sent ${sats.toLocaleString()} sats · tx ${txid ? shorten(txid, 8) : '…'}`, 'success');
        // Mempool indexing latency is variable (1–30s on signet, faster on
        // mainnet). Refresh a few times across that window so the new balance
        // shows up without making the user hit "rescan".
        [2000, 5000, 10000, 20000].forEach(ms =>
          setTimeout(() => { refreshWallet().catch(() => {}); }, ms),
        );
      },
    });
  };
  if (discBtn) discBtn.onclick = () => {
    if (!confirm('Disconnect external wallet? Your tacit identity stays bound to it locally — reconnecting later will restore it.')) return;
    applyExtDisconnect();
    toast('External wallet disconnected', 'success');
  };
}

// "Use a passkey" button in the wallet card primary-actions row. Mirrors
// setupExtWalletButtons for the ext-connect buttons: a post-onboarding entry
// point so users who picked local-passphrase at first load can later opt in
// to a passkey without clearing storage. Visibility is gated in
// renderWalletCard (hidden for ext / passkey / non-secure-context users).
function setupPasskeyButtons() {
  const pBtn = $('#btn-passkey-add');
  if (!pBtn) return;
  pBtn.onclick = async () => {
    if (pBtn.disabled) return;
    pBtn.disabled = true;
    const orig = pBtn.textContent;
    pBtn.textContent = 'opening…';
    try {
      const ok = await _showPasskeyModal();
      if (ok) {
        await refreshWallet();
        toast('Passkey wallet active', 'success');
      }
    } catch (e) {
      toast('Passkey: ' + (e?.message || e), 'error');
    } finally {
      pBtn.disabled = false;
      pBtn.textContent = orig;
    }
  };
}

// React to wallet-extension events (UniSat exposes accountsChanged and
// networkChanged; sats-connect v3 has no event API). Wired once at init.
let _unisatHooked = false;
function setupUnisatEvents() {
  if (_unisatHooked) return;
  if (!window.unisat || typeof window.unisat.on !== 'function') return;
  _unisatHooked = true;

  window.unisat.on('accountsChanged', async (accounts) => {
    // Only react if the user is currently connected via UniSat — Xverse-driven
    // sessions ignore UniSat events.
    if (!extWallet.state || extWallet.state.provider !== 'unisat') return;
    if (!accounts || !accounts.length) {
      // User signed out / locked UniSat. Drop to burner mode.
      applyExtDisconnect();
      toast('UniSat signed out — using the in-page wallet only', '');
      return;
    }
    if (accounts[0] === extWallet.state.address) return;
    // Account switch: rebind tacit identity to the new external address.
    try {
      const st = await extWallet.connectUnisat();
      if (reconcileWalletNetwork(st) !== 'ok') return;
      await rebindToExt();
      toast('UniSat account switched', 'success');
    } catch (e) {
      toast('Account switch failed: ' + e.message, 'error');
    }
  });

  window.unisat.on('networkChanged', (network) => {
    if (!extWallet.state || extWallet.state.provider !== 'unisat') return;
    extWallet.state = { ...extWallet.state, network };
    _cacheExtState(extWallet.state);
    // reconcile handles its own disconnect/reload/toast paths.
    reconcileWalletNetwork(extWallet.state);
  });
}

function setupHoldingsButtons() {
  $('#btn-rescan').onclick = renderHoldings;
  // Inline share-link import — replaces a single-shot prompt() with a textarea
  // that's easier to paste long URLs into and surfaces parse errors in-form.
  $('#btn-import-share').onclick = (e) => {
    openInlineForm(e.currentTarget, {
      submitLabel: 'Import',
      content: `
        <label>Share-link URL</label>
        <textarea data-field="link" rows="2" style="font-family:var(--mono);font-size:11px;padding:8px;border:1px solid var(--ink);background:var(--bg);width:100%;resize:vertical;" placeholder="https://…/#recv=…"></textarea>
        <div class="muted" style="margin-top:6px;font-size:11px;">
          Paste a share-link sent to you. The dapp validates the claim against on-chain data before recording an opening.
        </div>`,
      onSubmit: async ({ host, errEl }) => {
        const link = host.querySelector('[data-field="link"]').value.trim();
        if (!link) { errEl.textContent = 'paste a share-link'; return false; }
        if (!link.includes('#recv=')) { errEl.textContent = 'link must contain a #recv= fragment'; return false; }
        const data = await importShareLink(link);
        toast(`Imported ${fmtAssetAmount(data.amount, data.decimals)} ${data.ticker}`, 'success');
        markOnboarded();
        renderHoldings();
      },
    });
  };
  // Take an atomic offer (SPEC §5.7 T_AXFER). Paste the JSON the maker shared,
  // we validate + finalize + broadcast in one atomic Bitcoin tx.
  $('#btn-take-atomic')?.addEventListener('click', (e) => {
    openInlineForm(e.currentTarget, {
      submitLabel: 'Validate offer',
      content: `
        <label>Atomic offer (JSON pasted from the maker)</label>
        <textarea data-field="offer" rows="4" style="font-family:var(--mono);font-size:11px;padding:8px;border:1px solid var(--ink);background:var(--bg);width:100%;resize:vertical;" placeholder='{"version":1,"asset_id":"…",…}'></textarea>
        <div class="muted" style="margin-top:6px;font-size:11px;">
          Settles atomically in one Bitcoin tx: you pay the maker's address, you receive the tacit UTXO. No counterparty trust required — the maker's sigs are SIGHASH_SINGLE_ACP, so they can't redirect your payment, and the kernel sig is bound to the on-chain commitments.
        </div>`,
      onSubmit: async ({ host, errEl }) => {
        const raw = host.querySelector('[data-field="offer"]').value.trim();
        if (!raw) { errEl.textContent = 'paste an offer'; return false; }
        let offer;
        try { offer = JSON.parse(raw); }
        catch (e2) { errEl.textContent = 'invalid JSON: ' + e2.message; return false; }
        // Cryptographically verify the offer before showing confirm() — the
        // dialog must reflect verified facts (commitment binding to amount,
        // address derived from pubkey, etc.) rather than the maker's claims.
        try { verifyAxferOffer(offer); }
        catch (e2) { errEl.textContent = 'offer rejected: ' + e2.message; return false; }
        const dec = Number.isInteger(offer.decimals) ? offer.decimals : 0;
        const ticker = offer.ticker || '?';
        const amt = BigInt(offer.amount);
        const expIso = new Date(offer.expiry * 1000).toISOString();
        if (!confirm(
          `Take this atomic offer? (cryptographically verified)\n\n` +
          `Asset:    ${ticker} (${shorten(offer.asset_id, 8)})\n` +
          `Buying:   ${fmtAssetAmount(amt, dec)} ${ticker}\n` +
          `Price:    ${offer.price_sats.toLocaleString()} sats\n` +
          `Pay to:   ${offer.maker_address}\n` +
          `Expires:  ${expIso}\n\n` +
          `Verified: amount matches the on-chain commitment · maker address derives from maker pubkey · output scripts pay the right parties · range proof valid.\n\n` +
          `On confirm: the dapp appends your BTC funding to the maker's partial tx, signs the whole thing (locking in the maker's payment so it can't be redirected), and broadcasts.`,
        )) return false;
        try {
          const r = await takeAxferOffer(offer);
          toast(`Atomic take broadcast ✓ tx=${shorten(r.txid, 8)}`, 'success', 8000);
          renderHoldings(); renderActivity();
        } catch (e2) {
          errEl.textContent = e2.message;
          return false;
        }
      },
    });
  });
}

// Active pill predicate — combined with the text-search query in
// applyDiscoverFilter. 'all' = no predicate; mintable/attested/recent/
// offers/minted/burned each add one. Held in module scope so a re-render
// (which rebuilds cards) keeps the user's selection.
let _discoverPill = 'all';
// Default to oldest-first so long-established assets surface ahead of fresh
// etches (which can be junk during high-traffic windows). The dropdown still
// exposes Newest first; persisted prefs override this default per-network.
let _discoverSort = 'oldest';
// Etcher → Set<asset_id> for the current Discover load. Populated lazily
// from cached etch verifications at load time, then incrementally as fresh
// verifies complete. Read by renderDiscoverCard to surface "etcher has K
// other assets" reputation rows. Resets every renderDiscover() call so a
// network switch or refresh starts clean.
let _discoverEtcherMap = new Map();
function _discoverRegisterEtcher(etcherXonly, assetId) {
  if (!etcherXonly || !assetId) return;
  if (!_discoverEtcherMap.has(etcherXonly)) _discoverEtcherMap.set(etcherXonly, new Set());
  _discoverEtcherMap.get(etcherXonly).add(assetId);
}
function _matchesPill(card) {
  switch (_discoverPill) {
    case 'mintable': return card.dataset.mintable === '1';
    case 'attested': return card.dataset.attested === '1';
    case 'recent': {
      const t = Number(card.dataset.etchedAt) || 0;
      if (!t) return false;
      return t * 1000 >= Date.now() - 24 * 3600 * 1000;
    }
    case 'offers':   return card.dataset.hasOffers === '1';
    case 'atomic':   return card.dataset.hasAtomic === '1';
    case 'minted':   return card.dataset.hasMints === '1';
    case 'burned':   return card.dataset.hasBurns === '1';
    case 'moved':    return card.dataset.hasTransfers === '1';
    default: return true;
  }
}

// Re-order the rendered cards in-place by detaching and re-appending in
// the requested sort. Worker returns assets in newest-first order so
// 'newest' is the on-load default and is essentially a no-op when the
// sort hasn't been touched. Other sorts read off card.dataset; cards are
// already mounted so this is purely a DOM shuffle, no network fetch.
function applyDiscoverSort() {
  const list = $('#discover-list');
  if (!list) return;
  const cards = Array.from(list.querySelectorAll('.asset-card[data-aid]'));
  if (cards.length < 2) return;
  // Activity sorts use cumulative counters (transfer/offer/composite). They
  // bias toward older assets with more time on chain — this is "most active
  // overall" not "trending in the last 24h". Real time-windowed trending
  // would need timestamped per-tx records; the current counter-only design
  // can't compute a velocity. The labels in the dropdown say "Most …",
  // never "Trending", to keep that distinction honest.
  // Tiebreaker: when two cards have the same count (e.g., both 0), fall
  // back to recency so newer assets surface above identical-but-older ones.
  const tieByRecency = (a, b) => (Number(b.dataset.etchedAt) || 0) - (Number(a.dataset.etchedAt) || 0);
  const numDesc = (key) => (a, b) => {
    const d = (Number(b.dataset[key]) || 0) - (Number(a.dataset[key]) || 0);
    return d !== 0 ? d : tieByRecency(a, b);
  };
  // Floor-asc reads from the Market cache (populated once the user has
  // Market-related sorts (offers / atomic / floor) live on the Market tab,
  // not Discover — keeps the directory of "what tokens exist" cleanly split
  // from orderbook state. Stale persisted prefs targeting a removed sort
  // fall through to the default below.
  cards.sort((a, b) => {
    switch (_discoverSort) {
      case 'newest':         return tieByRecency(a, b);
      case 'ticker-asc':     return (a.dataset.ticker || '').localeCompare(b.dataset.ticker || '');
      case 'ticker-desc':    return (b.dataset.ticker || '').localeCompare(a.dataset.ticker || '');
      case 'transfers-desc': return numDesc('transferCount')(a, b);
      case 'active-desc':    return numDesc('activityCount')(a, b);
      case 'oldest':
      default:               return (Number(a.dataset.etchedAt) || 0) - (Number(b.dataset.etchedAt) || 0);
    }
  });
  for (const c of cards) list.appendChild(c);
}
// Apply the Discover filter (search input + active pill) to the currently
// rendered cards. Substring-matches against card.dataset.filterKey for the
// query, and reads card.dataset.{mintable,attested,etchedAt} for the pill.
function applyDiscoverFilter() {
  const input = $('#discover-filter');
  const list = $('#discover-list');
  if (!input || !list) return;
  const q = input.value.trim().toLowerCase();
  const cards = list.querySelectorAll('.asset-card[data-filter-key]');
  let visible = 0;
  cards.forEach(card => {
    const matchQ = !q || card.dataset.filterKey.includes(q);
    const matchP = _matchesPill(card);
    const match = matchQ && matchP;
    card.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  let emptyHint = list.querySelector('[data-filter-empty]');
  const filterActive = q || _discoverPill !== 'all';
  if (filterActive && cards.length > 0 && visible === 0) {
    if (!emptyHint) {
      emptyHint = document.createElement('div');
      emptyHint.dataset.filterEmpty = '1';
      emptyHint.className = 'empty';
      emptyHint.style.marginTop = '12px';
      list.appendChild(emptyHint);
    }
    const pillLabel = _discoverPill === 'all' ? '' : ` (${_discoverPill})`;
    emptyHint.textContent = q
      ? `No assets match "${q}"${pillLabel}.`
      : `No ${_discoverPill} assets.`;
  } else if (emptyHint) {
    emptyHint.remove();
  }
}

// Per-network user-preference persistence for Discover + Market views. The
// search input + asset_id filter are intentionally NOT persisted — they're
// transient (deep-linked or one-off lookups). What does survive a reload:
// Discover sort + active pill, Market kind/min/max/sort. Per-network keying
// keeps signet and mainnet curations independent.
const _PREFS_DISCOVER_KEY = (net) => `tacit-discover-prefs:${net}`;
const _PREFS_MARKET_KEY = (net) => `tacit-market-prefs:${net}`;
function _saveDiscoverPrefs() {
  try {
    localStorage.setItem(_PREFS_DISCOVER_KEY(NET.name), JSON.stringify({
      sort: _discoverSort,
      pill: _discoverPill,
    }));
  } catch { /* quota / private-mode — non-fatal */ }
}
function _loadDiscoverPrefs() {
  try {
    const raw = localStorage.getItem(_PREFS_DISCOVER_KEY(NET.name));
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch { return null; }
}
function _saveMarketPrefs() {
  try {
    localStorage.setItem(_PREFS_MARKET_KEY(NET.name), JSON.stringify({
      kind: $('#market-filter-kind')?.value || 'all',
      min:  $('#market-filter-min-price')?.value || '',
      max:  $('#market-filter-max-price')?.value || '',
      sort: $('#market-sort')?.value || 'recency',
    }));
  } catch {}
}
function _loadMarketPrefs() {
  try {
    const raw = localStorage.getItem(_PREFS_MARKET_KEY(NET.name));
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch { return null; }
}

function setupDiscoverButtons() {
  const refreshBtn = $('#btn-discover-refresh');
  if (!REGISTRY_URL) { refreshBtn.disabled = true; refreshBtn.title = 'discovery disabled (no Worker)'; }
  // Force-refresh: bypass the 60s registry cache so the user gets fresh data.
  refreshBtn.onclick = () => renderDiscover(true);
  const allLink = $('#recent-etches-all');
  if (allLink) allLink.onclick = (e) => { e.preventDefault(); $('.tab[data-tab="discover"]').click(); };
  // Filter wiring. Debounced so a rapid stream of keystrokes doesn't spam
  // querySelectorAll on a large list. 80ms keeps it feeling immediate.
  const filterInput = $('#discover-filter');
  if (filterInput) {
    let t = null;
    filterInput.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(applyDiscoverFilter, 80);
    });
  }
  // Pill toggles. Single-selection (radio-like) — clicking a pill replaces
  // the active predicate. Delegated so a re-render of the discover list
  // doesn't strip handlers off the static pill elements.
  const pills = $('#discover-pills');
  if (pills) {
    pills.addEventListener('click', e => {
      const btn = e.target.closest('.filter-pill[data-pill]');
      if (!btn) return;
      _discoverPill = btn.dataset.pill;
      pills.querySelectorAll('.filter-pill').forEach(b => {
        b.classList.toggle('active', b.dataset.pill === _discoverPill);
      });
      _saveDiscoverPrefs();
      applyDiscoverFilter();
    });
  }
  // Sort dropdown — re-orders the already-mounted cards in place, no fetch.
  // Market-related sorts (offers / atomic / floor) live on Market; Discover
  // keeps directory-style sorts (recency, ticker, transfers, activity).
  const sortSel = $('#discover-sort');
  if (sortSel) {
    sortSel.addEventListener('change', () => {
      _discoverSort = sortSel.value || 'oldest';
      _saveDiscoverPrefs();
      applyDiscoverSort();
    });
  }
  // Restore last-used Discover prefs for this network. Validated against the
  // dropdown's actual <option>s (and the pill set in the DOM) so a stale
  // localStorage value from a removed sort/pill silently degrades to default.
  const _prefs = _loadDiscoverPrefs();
  if (_prefs) {
    if (sortSel && typeof _prefs.sort === 'string') {
      const valid = Array.from(sortSel.options).some(o => o.value === _prefs.sort);
      if (valid) { sortSel.value = _prefs.sort; _discoverSort = _prefs.sort; }
    }
    if (pills && typeof _prefs.pill === 'string') {
      const target = pills.querySelector(`.filter-pill[data-pill="${CSS.escape(_prefs.pill)}"]`);
      if (target) {
        _discoverPill = _prefs.pill;
        pills.querySelectorAll('.filter-pill').forEach(b => {
          b.classList.toggle('active', b.dataset.pill === _discoverPill);
        });
      }
    }
  }
}

function setupMarketButtons() {
  const refreshBtn = $('#btn-market-refresh');
  if (refreshBtn) {
    if (!REGISTRY_URL) { refreshBtn.disabled = true; refreshBtn.title = 'market disabled (no Worker)'; }
    refreshBtn.onclick = () => { invalidateMarketCache(); renderMarket(); };
  }
  // Filters: re-apply against the cached batch on every change. Text input
  // is debounced; the others are fast enough to fire on `change`.
  const txt = $('#market-filter-asset');
  if (txt) {
    let t = null;
    txt.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(applyMarketFilters, 80);
    });
  }
  ['#market-filter-kind', '#market-filter-min-price', '#market-filter-max-price', '#market-sort'].forEach(sel => {
    const el = $(sel);
    if (el) el.addEventListener('change', () => { _saveMarketPrefs(); applyMarketFilters(); });
  });
  // Restore last-used Market prefs. Filter inputs are populated before the
  // first applyMarketFilters runs so the user lands on their saved view.
  const _mprefs = _loadMarketPrefs();
  if (_mprefs) {
    const k  = $('#market-filter-kind');
    const mn = $('#market-filter-min-price');
    const mx = $('#market-filter-max-price');
    const s  = $('#market-sort');
    if (k && typeof _mprefs.kind === 'string'
        && Array.from(k.options).some(o => o.value === _mprefs.kind)) {
      k.value = _mprefs.kind;
    }
    if (mn && typeof _mprefs.min === 'string') mn.value = _mprefs.min;
    if (mx && typeof _mprefs.max === 'string') mx.value = _mprefs.max;
    if (s && typeof _mprefs.sort === 'string'
        && Array.from(s.options).some(o => o.value === _mprefs.sort)) {
      s.value = _mprefs.sort;
    }
  }
}

async function autoImportShareLink() {
  if (!location.hash.includes('recv=')) return;
  // Decode (but don't import) so we can show the user what they're consenting
  // to. A bare confirm() is a deliberate friction point: visiting a URL must
  // not silently mutate localStorage with whatever the link encodes — the
  // recipient wallet should explicitly accept the claim before it's persisted.
  const hash = location.hash.slice(location.hash.indexOf('#recv='));
  const claim = decodeShareLinkHash(hash);
  if (!claim) {
    toast('Share-link in URL is malformed; ignoring.', 'error');
    history.replaceState(null, '', location.pathname + location.search);
    return;
  }
  const human = `${fmtAssetAmount(claim.amount, claim.decimals)} ${claim.ticker || '???'}`;
  const ok = confirm(
    `Import received share-link?\n\n` +
    `Claim: ${human}\nAsset: ${claim.assetIdHex.slice(0, 16)}…\nUTXO: ${claim.txid.slice(0, 16)}…:${claim.vout}\n\n` +
    `Importing will validate the claim against on-chain data and (if valid) record an opening in your local wallet. Cancel if you didn't expect this link.`,
  );
  // Always strip the hash so a refusal isn't re-prompted on every reload.
  history.replaceState(null, '', location.pathname + location.search);
  if (!ok) {
    toast('Share-link import declined.', '');
    return;
  }
  try {
    const data = await importShareLink(hash);
    toast(`Imported ${fmtAssetAmount(data.amount, data.decimals)} ${data.ticker} from URL`, 'success');
    markOnboarded();
    $('.tab[data-tab="holdings"]').click();
  } catch (e) {
    toast('Auto-import failed: ' + e.message, 'error');
    console.error('auto-import failed:', e);
  }
}

// ============== INIT ==============
function setupNetworkSelect() {
  const sel = $('#net-select');
  if (!sel) return;
  sel.value = NET.name;
  const dh = $('#discover-header-title');
  if (dh) dh.textContent = `discover · all etched assets on ${NET.name}`;
  // Mainnet banner: real BTC at stake, but show only until the user has
  // acknowledged ("× Acknowledge and hide" button). Once dismissed,
  // MAINNET_OK_KEY persists the ack and the banner stays hidden for that
  // browser. The persistent red `mainnet` text inside the network selector
  // is the lighter-touch indicator that remains.
  const banner = $('#mainnet-banner');
  const mainnetAcked = localStorage.getItem('tacit-mainnet-consented-v1') === '1';
  if (banner) {
    banner.style.display = (NET.name === 'mainnet' && !mainnetAcked) ? 'block' : 'none';
  }
  // Hints inside the mainnet banner: surface the two custody pitfalls (no
  // external wallet connected; burner key not yet acknowledged-as-backed-up).
  // Recomputed on every render so they stay in sync with state changes.
  const extHint = $('#mainnet-extwallet-hint');
  const backHint = $('#mainnet-burner-backup-hint');
  if (NET.name === 'mainnet' && !mainnetAcked) {
    if (extHint) extHint.style.display = wallet.ext || wallet.mode === 'passkey' ? 'none' : 'block';
    if (backHint) backHint.style.display = wallet.mode === 'passkey' || isBurnerBackedUp() ? 'none' : 'block';
  }
  // Wire the close button. Sets the ack flag and hides immediately. Idempotent —
  // setupNetworkSelect runs on every state change, so re-binding is fine.
  const closeBtn = $('#mainnet-banner-close');
  if (closeBtn && !closeBtn._wired) {
    closeBtn._wired = true;
    closeBtn.onclick = () => {
      localStorage.setItem('tacit-mainnet-consented-v1', '1');
      const b = $('#mainnet-banner'); if (b) b.style.display = 'none';
    };
  }
  // When an external wallet is connected, the wallet drives the network
  // (reconcileWalletNetwork would bounce any local override). Lock the
  // selector and surface an inline hint with a one-click disconnect — the
  // tooltip on a disabled <select> isn't reliably hoverable, so the hint
  // is the discoverable affordance.
  const lockHint = $('#net-lock-hint');
  if (wallet.ext) {
    sel.disabled = true;
    sel.title = 'Connected wallet drives the network — switch in your wallet, or disconnect first.';
    if (lockHint) lockHint.style.display = '';
    const provider = wallet.ext.provider === 'sats-connect' ? 'Xverse / Leather' : (wallet.ext.provider || 'wallet');
    const lbl = lockHint?.querySelector('a');
    if (lbl) lbl.textContent = `disconnect ${provider}`;
  } else {
    sel.disabled = false;
    sel.title = '';
    if (lockHint) lockHint.style.display = 'none';
  }
  const disconnectLink = $('#net-lock-disconnect');
  if (disconnectLink) {
    disconnectLink.onclick = (e) => {
      e.preventDefault();
      if (!wallet.ext) return;
      if (typeof applyExtDisconnect === 'function') applyExtDisconnect();
    };
  }
  sel.onchange = () => {
    const next = sel.value === 'mainnet' ? 'mainnet' : 'signet';
    if (next === NET.name) return;
    // Mainnet flip uses real BTC. Make the user explicitly opt in once;
    // remember the consent so subsequent toggles don't re-prompt.
    const MAINNET_OK_KEY = 'tacit-mainnet-consented-v1';
    if (next === 'mainnet' && !localStorage.getItem(MAINNET_OK_KEY)) {
      const ok = confirm(
        '⚠ Switch to Bitcoin MAINNET?\n\n' +
        'This is real money. Tacit is experimental software with no warranty. ' +
        'You may lose funds to bugs, fee miscalculation, lost private keys, ' +
        'or any number of issues that haven\'t shown up on signet yet.\n\n' +
        'Recommended: test thoroughly on signet first. Only put amounts on mainnet ' +
        'that you can afford to lose.\n\n' +
        'Continue to mainnet?',
      );
      if (!ok) { sel.value = NET.name; return; }
      localStorage.setItem(MAINNET_OK_KEY, '1');
    }
    // Queue a one-time toast for the next page load explaining that wallets
    // are per-network. Without this, a user who etches on signet then flips
    // to mainnet sees a fresh empty wallet and may think their assets were
    // lost — they're preserved, just on the other network's identity.
    try {
      localStorage.setItem('tacit-net-flip-toast-v1', JSON.stringify({
        prev: NET.name,
        prevAddr: wallet.pub ? wallet.address() : null,
        next,
        ts: Date.now(),
      }));
    } catch {}
    localStorage.setItem(NET_KEY, next);
    // Network change touches address derivation, API endpoints, holdings cache,
    // and registry scope — easier to reload than to invalidate every cache.
    location.reload();
  };
}

// On every load, surface the queued cross-network toast (if any) so the user
// understands why their wallet looks "empty" after a network flip.
function consumePendingNetFlipToast() {
  let payload;
  try {
    const raw = localStorage.getItem('tacit-net-flip-toast-v1');
    if (!raw) return;
    payload = JSON.parse(raw);
  } catch { localStorage.removeItem('tacit-net-flip-toast-v1'); return; }
  localStorage.removeItem('tacit-net-flip-toast-v1');
  if (!payload || payload.next !== NET.name) return;   // stale or doesn't match current network
  const prevTag = payload.prev || 'previous network';
  const prevSnippet = payload.prevAddr ? ` (${shorten(payload.prevAddr, 8)})` : '';
  toast(
    `Switched to ${payload.next}. Your ${prevTag} wallet${prevSnippet} is preserved separately — this is a fresh ${payload.next} wallet at your current address. Both networks have independent keys; export each one before holding value.`,
    '',
    9000,
  );
}

// First-load detection — true only when this device has never set up any
// tacit wallet (no global blob, no network-scoped blob, no ext-bound blob).
// Returning users with an existing encrypted blob skip the welcome modal and
// go straight to the unlock prompt.
function _hasAnyExistingWallet() {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(WALLET_KEY_BASE)) return true;
  }
  return false;
}

// FAQ modal: opened by the "?" button in the header. Static reference content
// (questions hard-coded in index.html); this just wires up open/close. Closes
// on the ✕ button, on backdrop click outside the card, and on Escape.
function setupFaqModal() {
  const btn = document.getElementById('btn-faq');
  const modal = document.getElementById('faq-modal');
  const closeBtn = document.getElementById('faq-close');
  if (!btn || !modal || !closeBtn) return;
  const open = () => { modal.style.display = 'grid'; closeBtn.focus(); };
  const close = () => { modal.style.display = 'none'; };
  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display !== 'none') close();
  });
}

// ============== COMMAND PALETTE ==============
// ⌘K / Ctrl+K (or `/` outside an input) opens a keyboard-first action
// surface. Items are built dynamically per-open so visibility reflects
// current state — "Disconnect external wallet" only appears when one is
// connected, "Manual faucet" only on signet, etc. Each command's run()
// delegates to the same handler the on-screen button would invoke (a
// programmatic .click() in most cases) so the palette never duplicates
// business logic. Pure additive — closing the palette restores focus to
// whatever was focused before; tabbing inside the palette stays inside.
function buildCommandPaletteItems() {
  const items = [];
  const tabs = [
    { id: 'wallet', title: 'Wallet', hint: 'address · balance · backup' },
    { id: 'holdings', title: 'Holdings', hint: 'your confidential assets' },
    { id: 'transfer', title: 'Send', hint: 'token or plain bitcoin' },
    { id: 'discover', title: 'Discover', hint: 'browse all etched assets' },
    { id: 'market', title: 'Market', hint: 'open listings' },
    { id: 'etch', title: 'Etch', hint: 'mint a new asset' },
    { id: 'drops', title: 'Drops', hint: 'airdrop tooling' },
    { id: 'claim', title: 'Claim', hint: 'redeem an airdrop' },
    { id: 'about', title: 'Protocol', hint: 'spec primer' },
  ];
  for (const t of tabs) {
    items.push({
      title: `Go to <strong>${t.title}</strong>`,
      hint: t.hint,
      run: () => document.querySelector(`.tab[data-tab="${t.id}"]`)?.click(),
    });
  }
  // Wallet actions — call .click() on the existing buttons so handler logic
  // stays single-sourced. Skip when the button is missing or hidden so the
  // palette doesn't surface unreachable actions.
  const clickable = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    if (el.disabled) return null;
    if (el.offsetParent === null) return null; // hidden
    return el;
  };
  const cmd = (id, title, hint) => {
    const el = clickable(id);
    if (!el) return;
    items.push({ title, hint, run: () => el.click() });
  };
  cmd('btn-refresh', 'Refresh <strong>wallet</strong>', 'pull balance + tip + fee');
  cmd('btn-rescan', 'Rescan <strong>holdings</strong>', 'walk UTXOs again');
  cmd('btn-lock', 'Lock', 'forget privkey from memory');
  cmd('btn-faucet', 'Manual <strong>faucet</strong>', 'open signet faucet');
  cmd('btn-drip', 'Demo <strong>drip</strong>', 'one-tap signet sats');
  cmd('btn-export', 'Export <strong>key</strong>', 'back up the privkey');
  cmd('btn-import', 'Import <strong>key</strong>', 'restore from backup');
  cmd('btn-regen', 'New <strong>wallet</strong>', 'wipe and regenerate');
  cmd('btn-import-share', 'Import <strong>share-link</strong>', 'received from a sender');
  cmd('btn-petch-broadcast', 'Deploy <strong>public-mint asset</strong>', 'fair launch · T_PETCH');
  cmd('btn-take-atomic', 'Take <strong>atomic offer</strong>', 'paste an offer link');
  cmd('btn-faq', 'Open <strong>FAQ</strong>', 'short help');
  // Copy address + pubkey directly — small but heavily-used.
  const addrText = (document.getElementById('w-address')?.textContent || '').trim();
  const pubText = (document.getElementById('w-pubkey')?.textContent || '').trim();
  if (addrText && addrText !== '—') {
    items.push({
      title: `Copy <strong>address</strong>`,
      hint: shorten(addrText, 6),
      run: () => navigator.clipboard?.writeText(addrText).then(() => toast('Address copied', 'success', 1500)),
    });
  }
  if (pubText && pubText !== '—') {
    items.push({
      title: `Copy <strong>public key</strong>`,
      hint: shorten(pubText, 6),
      run: () => navigator.clipboard?.writeText(pubText).then(() => toast('Pubkey copied', 'success', 1500)),
    });
  }
  // Network switch — only the option you're not currently on. The select's
  // change handler runs through the same checks as user interaction.
  const netSel = document.getElementById('net-select');
  if (netSel && !netSel.disabled) {
    const cur = netSel.value;
    for (const n of ['mainnet', 'signet']) {
      if (n === cur) continue;
      items.push({
        title: `Switch to <strong>${n}</strong>`,
        hint: 'reload required',
        run: () => { netSel.value = n; netSel.dispatchEvent(new Event('change', { bubbles: true })); },
      });
    }
  }
  // Discover-tab focus shortcut — handy when the palette opens via "/".
  const discoverTab = document.querySelector('.tab[data-tab="discover"]');
  if (discoverTab) {
    items.push({
      title: 'Focus <strong>discover filter</strong>',
      hint: 'jump to search',
      run: () => {
        discoverTab.click();
        setTimeout(() => document.getElementById('discover-filter')?.focus(), 80);
      },
    });
  }
  return items;
}

function setupCommandPalette() {
  const palette = document.getElementById('cmd-palette');
  const input = document.getElementById('cmd-input');
  const list = document.getElementById('cmd-list');
  if (!palette || !input || !list) return;
  let items = [];
  let filtered = [];
  let activeIdx = 0;
  let restoreFocusTo = null;

  const renderList = () => {
    if (!filtered.length) {
      list.innerHTML = `<li class="cmd-empty">no commands match</li>`;
      return;
    }
    activeIdx = Math.max(0, Math.min(activeIdx, filtered.length - 1));
    list.innerHTML = filtered.map((c, i) => `
      <li class="cmd-item${i === activeIdx ? ' active' : ''}" data-i="${i}" role="option" aria-selected="${i === activeIdx}">
        <span class="cmd-item-title">${c.title}</span>
        ${c.hint ? `<span class="cmd-item-hint">${escapeHtml(c.hint)}</span>` : ''}
      </li>
    `).join('');
  };

  const filter = (q) => {
    const ql = q.trim().toLowerCase();
    if (!ql) { filtered = items.slice(); return; }
    // Match on stripped title (drop <strong> tags) + hint. Cheap substring;
    // command sets are tiny so fuzzy ranking doesn't pay off here.
    filtered = items.filter(c => {
      const plain = (c.title + ' ' + (c.hint || '')).replace(/<[^>]+>/g, '').toLowerCase();
      return plain.includes(ql);
    });
  };

  const open = () => {
    if (palette.style.display !== 'none') return;
    restoreFocusTo = document.activeElement;
    items = buildCommandPaletteItems();
    filtered = items.slice();
    activeIdx = 0;
    input.value = '';
    palette.style.display = 'grid';
    renderList();
    requestAnimationFrame(() => input.focus());
  };

  const close = () => {
    if (palette.style.display === 'none') return;
    palette.style.display = 'none';
    if (restoreFocusTo && typeof restoreFocusTo.focus === 'function') {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  };

  const exec = (i) => {
    if (!filtered[i]) return;
    const fn = filtered[i].run;
    close();
    // Defer so the palette's hide doesn't fight the action's own focus
    // moves (e.g. opening another modal). One frame is plenty.
    requestAnimationFrame(() => { try { fn(); } catch (e) { console.error('cmd-palette:', e); } });
  };

  input.addEventListener('input', () => { filter(input.value); activeIdx = 0; renderList(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx++; renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx--; renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); exec(activeIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.cmd-item');
    if (!li) return;
    const i = Number(li.dataset.i);
    if (i !== activeIdx) { activeIdx = i; renderList(); }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.cmd-item');
    if (!li) return;
    exec(Number(li.dataset.i));
  });
  palette.addEventListener('click', (e) => { if (e.target === palette) close(); });

  // Header opener button — the only entry point on touch devices where the
  // keyboard shortcut isn't reachable. Toggles like the keyboard does.
  const headerBtn = document.getElementById('btn-cmd');
  if (headerBtn) {
    headerBtn.addEventListener('click', () => {
      palette.style.display === 'none' ? open() : close();
    });
  }

  // Global shortcut — listen on document with capture so an editable
  // textarea doesn't swallow ⌘K. `/` only triggers when the active element
  // isn't text-entering, so it doesn't fight typing. The palette can also
  // be invoked while another modal is open (welcome / pass / faq); they
  // stack via z-index and Esc closes the topmost.
  document.addEventListener('keydown', (e) => {
    const isInput = e.target instanceof HTMLElement
      && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      palette.style.display === 'none' ? open() : close();
      return;
    }
    if (e.key === '/' && !isInput && palette.style.display === 'none') {
      e.preventDefault();
      open();
    }
  }, true);
}

// Welcome modal: shown on genuine first load to give the user a real choice
// between connecting an existing bitcoin wallet (ext) and generating a fresh
// local burner. Resolves to 'ext-xverse' | 'ext-unisat' | 'local'. Caller
// dispatches to the appropriate flow; on failure the modal can be re-shown.
function _showWelcomeModal() {
  return new Promise((resolve) => {
    const modal = document.getElementById('welcome-modal');
    const xBtn = document.getElementById('welcome-xverse');
    const uBtn = document.getElementById('welcome-unisat');
    const pBtn = document.getElementById('welcome-passkey');
    const lBtn = document.getElementById('welcome-local');
    if (!modal || !xBtn || !uBtn || !pBtn || !lBtn) { resolve('local'); return; }
    const av = extWallet.available();
    xBtn.disabled = !av.satsConnect;
    xBtn.title = av.satsConnect ? '' : 'Xverse / Leather extension not detected';
    uBtn.disabled = !av.unisat;
    uBtn.title = av.unisat ? '' : 'UniSat extension not detected';
    pBtn.disabled = !prfWallet.available();
    pBtn.title = prfWallet.available() ? '' : 'Passkey requires HTTPS (or localhost)';
    const close = (choice) => {
      xBtn.onclick = uBtn.onclick = pBtn.onclick = lBtn.onclick = null;
      modal.style.display = 'none';
      resolve(choice);
    };
    xBtn.onclick = () => close('ext-xverse');
    uBtn.onclick = () => close('ext-unisat');
    pBtn.onclick = () => close('passkey');
    lBtn.onclick = () => close('local');
    modal.style.display = 'grid';
  });
}

// Run a welcome-modal choice through to a loaded wallet. Loops on failure
// (cancelled passphrase, ext connect rejected) so the user can re-pick rather
// than getting wedged with a stale partial state. Returns 'reload' if a
// network reconcile queued a reload (caller bails); otherwise undefined.
async function _runFirstLoadChoice() {
  while (true) {
    const choice = await _showWelcomeModal();
    try {
      if (choice === 'ext-xverse' || choice === 'ext-unisat') {
        const st = choice === 'ext-xverse'
          ? await extWallet.connectSatsConnect()
          : await extWallet.connectUnisat();
        const verdict = reconcileWalletNetwork(st);
        if (verdict === 'reload') return 'reload';
        // 'unsupported' = wallet is on a network tacit doesn't run on.
        // reconcileWalletNetwork already toasted + disconnected — loop back
        // to the welcome modal so the user can switch their wallet network
        // and retry, or pick a different option, instead of silently
        // creating a burner that's mislabelled as 'ext' mode.
        if (verdict === 'unsupported') continue;
        await wallet.load(st.address);
        setActiveWalletMode('ext');
      } else if (choice === 'passkey') {
        if (!await _showPasskeyModal()) throw new Error('cancelled');
        // _showPasskeyModal → prfWallet.register/login already called
        // setActiveWalletMode('passkey') via _setupSession.
      } else {
        await wallet.load();
        setActiveWalletMode('local');
      }
      return;
    } catch (e) {
      // Roll back any partial state so the next iteration starts clean. If the
      // ext connect succeeded but the passphrase prompt was cancelled, the
      // EXT_MODE_KEY is set with no burner — disconnect to avoid a confusing
      // half-bound state on reload.
      extWallet.disconnect();
      wallet.ext = null;
      // User-cancel (passkey modal cancel, passphrase modal cancel, ext popup
      // dismissed) is a navigation choice, not a failure — the welcome modal
      // re-renders on the next loop iteration, which is signal enough. Toasts
      // here would read as errors. Reserve the toast for genuine failures.
      if (!e || e.message === 'cancelled') continue;
      toast('Setup failed: ' + (e?.message || e), 'error', 5000);
    }
  }
}

async function init() {
  // Run the crypto KAT first. If any primitive returns the wrong answer for a
  // known input, the bundle has been tampered with or version-drifted and the
  // wallet is unsafe. Refuse to mount the UI and surface a hard error.
  try { runStartupKAT(); }
  catch (e) {
    document.body.innerHTML =
      '<div style="max-width:680px;margin:80px auto;padding:24px;border:2px solid #c62828;background:#fee;font-family:ui-monospace,monospace;color:#0a0a0a;">' +
      '<h2 style="color:#c62828;font-family:serif;font-style:italic;margin-bottom:12px;">tacit refuses to start</h2>' +
      '<p style="margin-bottom:8px;">A startup integrity check failed. The cryptographic libraries this dApp depends on returned an unexpected answer for a known input — the bundle has likely been tampered with, drifted, or failed to load correctly. Using this page to manage tokens would be unsafe.</p>' +
      '<pre style="background:#fff;border:1px solid #0a0a0a;padding:10px;font-size:11px;white-space:pre-wrap;word-break:break-all;">' + escapeHtml(e.message) + '</pre>' +
      '<p style="margin-top:12px;font-size:12px;">Reload the page; if the failure persists, do not enter any private keys here. File an issue with the message above.</p>' +
      '</div>';
    throw e;
  }
  if (location.protocol === 'file:') {
    const w = document.getElementById('file-protocol-warning');
    if (w) w.style.display = 'block';
  }
  // Restore order is preference-driven: ACTIVE_MODE_KEY records what the user
  // last successfully unlocked, so reloads don't surface a passkey OS prompt
  // for users whose primary wallet is an extension (and vice versa). On a
  // cancelled passkey prompt we DON'T wipe the PRF map — WebAuthn returns the
  // same NotAllowedError for "user cancelled" and "credential missing", and
  // cancels are far more common than genuinely stale credentials. The user
  // can clear stale entries from the Manage Wallet drawer if needed.
  const activeMode = getActiveWalletMode();
  const restoredPasskey = prfWallet.tryRestore();
  let bootstrapped = false;
  if (restoredPasskey && activeMode !== 'ext' && activeMode !== 'local') {
    try {
      await prfWallet.login({ label: restoredPasskey.label });
      bootstrapped = true;
    } catch (e) {
      prfWallet.lock();
      console.warn('passkey auto-login failed:', e.message);
      // Stay on this path only if the user explicitly chose passkey last
      // time; otherwise fall through to the other restore paths so a single
      // cancelled prompt doesn't strand the user.
    }
  }
  if (!bootstrapped) {
    const restored = await extWallet.tryRestore().catch(() => null);
    let extOk = false;
    if (restored) {
      const verdict = reconcileWalletNetwork(restored);
      if (verdict === 'reload') return;
      extOk = verdict === 'ok';
      // 'unsupported': reconcile already toasted + disconnected the ext
      // wallet. Fall through so we either unlock an existing burner or
      // run the welcome flow — never silently bind 'ext' mode against a
      // wallet on an unsupported network.
    }
    if (extOk) {
      await wallet.load(restored.address);
      setActiveWalletMode('ext');
    } else if (_hasAnyExistingWallet()) {
      try {
        await wallet.load();
        setActiveWalletMode('local');
      } catch (e) {
        // Returning-user unlock failures must not strand init: a throw here
        // bubbles to init().catch(...) and aborts every setup* call below,
        // leaving the dapp non-interactive until reload. Route them through
        // the welcome modal so they can switch to passkey/ext, retry local,
        // or at minimum see a usable UI. Covers: explicit cancel, exhausted
        // passphrase attempts ('unlock failed'), and corrupt/unknown blobs
        // ('unknown wallet storage format'). Cancel stays silent; genuine
        // errors surface via toast so the user knows why local failed.
        if (e?.message !== 'cancelled') {
          toast(`Couldn't unlock local wallet: ${e?.message || e}. Pick another option below.`, 'error', 6000);
        }
        if (await _runFirstLoadChoice() === 'reload') return;
      }
    } else {
      if (await _runFirstLoadChoice() === 'reload') return;
    }
  }
  setupNetworkSelect();
  setupTabs();
  setupFaqModal();
  setupCommandPalette();
  setupWalletButtons();
  setupExtWalletButtons();
  setupPasskeyButtons();
  setupUnisatEvents();
  setupEtchForm();
  setupPetchForm();
  setupTransferForm();
  setupSatsSendForm();
  setupDropsForm();
  setupClaimTab();
  setupHoldingsButtons();
  setupDiscoverButtons();
  setupMarketButtons();
  setupHero();
  // Start the second-Esplora chain-divergence watchdog. Fires once
  // immediately + every CHAIN_DIVERGE_INTERVAL_MS thereafter. Surfaces a
  // banner if the primary and secondary endpoints disagree on tip height.
  startChainDivergenceWatchdog();
  // Lander grid (recent etches) is independent of wallet keys — kick it off
  // BEFORE awaiting refreshWallet so the registry + per-asset verify fetches
  // run concurrently with the wallet's mempool round-trips instead of strictly
  // after them. On cold caches this is the difference between the lander
  // appearing in step with the wallet card vs. several seconds later.
  // Fire-and-forget: renderRecentEtches has its own try/catch and writes to a
  // disjoint DOM region, so no rejection bubbles into init.
  renderRecentEtches();
  await refreshWallet();
  renderExtWalletPanel();
  // Surface any one-time net-flip explainer queued by the network selector.
  // Runs after refreshWallet so the toast text references the current
  // network's address that's already visible in the wallet card.
  consumePendingNetFlipToast();
  await autoImportShareLink();
  _consumeClaimUrlHash();
  // Best-effort recovery: if a previous publishAxferIntent call broadcast a
  // commit tx but the worker POST never landed (indexer race, network blip,
  // worker outage), the body was persisted to localStorage. Re-POST it now
  // that the chain has had time to index. Errors are non-fatal — they leave
  // the entry in localStorage for a future retry. Fired-and-forgotten so a
  // slow chain API doesn't block the rest of init.
  resumePendingAxintents().then(() => {
    const remaining = listAxintentPendings();
    if (remaining.length) {
      toast(
        `${remaining.length} atomic intent${remaining.length === 1 ? '' : 's'} couldn't be published yet ` +
        `(commit tx broadcast, marketplace POST pending). The dapp will retry automatically on reload — ` +
        `your Bitcoin fees are not lost.`,
        '', 12000,
      );
    }
  }).catch(e => console.warn('[axintent] resume failed:', e));
}
// Gate the auto-init for offline test harnesses. Setting __TACIT_NO_INIT__ on
// globalThis BEFORE importing this module (e.g. from a Node parity test) skips
// the IIFE so the protocol functions can be exercised without DOM/network/
// extension dependencies. Has zero effect in browser contexts where the global
// is undefined.
if (!globalThis.__TACIT_NO_INIT__) {
  init().catch(e => { toast('Init error: ' + e.message, 'error'); console.error(e); });
}

// Hero strip = the 3-step "Connect → Etch → Transfer" funnel on the Wallet
// tab. It's onboarding scaffolding — once a user is past step 1 in any
// meaningful way (external wallet connected, burner key acknowledged as
// backed up, asset etched / transferred / received), the hero becomes
// noise. Hide it persistently and surface a small "↺ show getting started"
// link next to it so it can be brought back.
const ONBOARDED_KEY = 'tacit-onboarded-v1';
function isOnboarded() {
  return localStorage.getItem(ONBOARDED_KEY) === '1';
}
function markOnboarded() {
  if (isOnboarded()) return;
  localStorage.setItem(ONBOARDED_KEY, '1');
  applyHeroVisibility();
}
function applyHeroVisibility() {
  const strip = document.getElementById('hero-strip');
  const showBar = document.getElementById('hero-show');
  if (!strip || !showBar) return;
  if (isOnboarded()) {
    strip.style.display = 'none';
    showBar.style.display = '';
  } else {
    strip.style.display = '';
    showBar.style.display = 'none';
  }
}
function setupHero() {
  applyHeroVisibility();
  const closeBtn = document.getElementById('hero-close');
  if (closeBtn) closeBtn.onclick = () => {
    // Set the flag idempotently AND force-hide. Don't go through
    // markOnboarded() because it early-returns when already onboarded —
    // which broke the close button after the user revealed the hero via
    // "↺ show getting started" (that reveal preserves the flag, so a
    // subsequent × click would otherwise be a no-op).
    if (!isOnboarded()) localStorage.setItem(ONBOARDED_KEY, '1');
    const strip = document.getElementById('hero-strip');
    const showBar = document.getElementById('hero-show');
    if (strip) strip.style.display = 'none';
    if (showBar) showBar.style.display = '';
  };
  const showLink = document.getElementById('hero-show-link');
  if (showLink) showLink.onclick = (e) => {
    e.preventDefault();
    // Reveal without clearing the flag — we want a one-click reveal that
    // doesn't reset onboarded state. Re-clicking the × hides it again.
    const strip = document.getElementById('hero-strip');
    const showBar = document.getElementById('hero-show');
    if (strip) strip.style.display = '';
    if (showBar) showBar.style.display = 'none';
  };
}


// Inline-form helper: mounts a styled form as the trigger button's next
// sibling. Replaces native prompt()+confirm() chains with a single in-flow
// panel that matches the dapp's editorial design and supports inline
// validation. Toggles on re-click of the same trigger.
//
// onSubmit receives ({ host, errEl }) and may:
//   - throw — message becomes the form's inline error, form stays open
//   - return false — same: validation-failed, form stays open
//   - return any other value (incl. undefined) — form closes on success
function openInlineForm(triggerBtn, { content, submitLabel = 'Confirm', submitClass = 'primary', cancelLabel = 'Cancel', onSubmit, onClose }) {
  const existing = triggerBtn.nextElementSibling;
  if (existing && existing.classList.contains('inline-form-host')) {
    existing.remove();
    if (onClose) onClose();
    return null;
  }
  const host = document.createElement('div');
  host.className = 'inline-form-host';
  host.innerHTML = `
    <div class="inline-form">
      ${content}
      <div class="form-buttons">
        <button class="${submitClass}" data-form-act="submit">${escapeHtml(submitLabel)}</button>
        <button data-form-act="cancel">${escapeHtml(cancelLabel)}</button>
      </div>
      <div class="error" data-form-error></div>
    </div>`;
  triggerBtn.insertAdjacentElement('afterend', host);
  const errEl = host.querySelector('[data-form-error]');
  const submitBtn = host.querySelector('[data-form-act="submit"]');
  const cancelBtn = host.querySelector('[data-form-act="cancel"]');
  const close = () => { host.remove(); if (onClose) onClose(); };
  cancelBtn.onclick = close;
  submitBtn.onclick = async () => {
    errEl.textContent = '';
    submitBtn.disabled = true; cancelBtn.disabled = true;
    const orig = submitBtn.textContent;
    submitBtn.textContent = '…';
    try {
      const r = await onSubmit({ host, errEl });
      if (r === false) return;
      close();
    } catch (e) {
      errEl.textContent = e?.message || String(e);
    } finally {
      submitBtn.disabled = false; cancelBtn.disabled = false;
      submitBtn.textContent = orig;
    }
  };
  const firstInput = host.querySelector('input, select, textarea');
  if (firstInput) firstInput.focus();
  return { host, errEl, close };
}

// Named exports: index.html loads this file via <script type="module"> with
// no importer, so these are inert in production. Their sole purpose is to let
// tests/dapp-parity.test.mjs import the canonical dApp implementations and
// diff them against the test-side mirrors in tests/composition.mjs — catches
// silent drift like F1 (BP generator domain strings) or T7 (mint anchor
// binding) that internal-consistency tests can't surface.
export {
  // Curve + scalars
  G, H, ZERO, SECP_N, SECP_P, N_BITS,
  // Point + commitment helpers
  pedersenCommit, bytesToPoint, pointToBytes,
  // BIP-340 Schnorr
  signSchnorr, verifySchnorr,
  // KDF / blinding / keystream derivations
  assetIdFor,
  deriveBlinding, deriveChangeBlinding,
  deriveEtchBlinding, deriveEtchAmountKeystream,
  deriveMintBlinding, deriveMintAmountKeystream,
  deriveAmountKeystreamECDH, deriveAmountKeystreamSelf,
  encryptAmount, decryptAmount,
  // Bitcoin script builders (exported for dapp↔worker contract tests so the
  // exact bytes the dapp publishes can be validated against the worker's
  // regex/length checks — drift here would silently break feature endpoints
  // (the 5120 vs 0020 P2TR atomic-intent regression is the canonical example).
  p2trScript, controlBlock,
  // Sats-send safety primitives (exported for unit tests). The asset-UTXO
  // exclusion logic is the primary defense against accidentally destroying
  // tacit holdings via plain-Bitcoin spends, so it gets dedicated test coverage.
  decodeP2wpkhAddress, selectSatsUtxosSafe, estSatsSendVb, buildSatsSendTx,
  // Wire format encoders / decoders
  encodeEnvelopeScript, decodeEnvelopeScript,
  encodeCEtchPayload, decodeCEtchPayload,
  encodeCXferPayload, decodeCXferPayload,
  encodeCMintPayload, decodeCMintPayload,
  encodeCBurnPayload, decodeCBurnPayload,
  encodeCPetchPayload, decodeCPetchPayload,
  encodeCPmintPayload, decodeCPmintPayload,
  // Protocol message hashes
  computeKernelMsg, computeMintMsg,
  openingMsg, disclosureMsg,
  listingMsgBytes, cancelMsgBytes, claimMsgBytes,
  _axintentMsg as axintentMsg,
  _axintentClaimMsg as axintentClaimMsg,
  _axintentFulfilMsg as axintentFulfilmentMsg,
  _axintentCancelMsg as axintentCancelMsg,
  _bidIntentMsg as bidIntentMsg,
  _bidClaimMsg as bidClaimMsg,
  _bidCancelMsg as bidCancelMsg,
  deriveAxintentBlindingKeystream, xor32,
  // Drop-announcement signing messages — exported so tests can verify cross-impl parity with the worker.
  dropAnnounceMsgBytes, dropAnnounceCancelMsgBytes,
  // Encrypted-at-rest privkey storage
  encryptPrivkey, decryptPrivkey,
};
