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
import { hmac } from './vendor/tacit-deps.min.js';
import { hexToBytes, bytesToHex, concatBytes } from './vendor/tacit-deps.min.js';
import { bech32 } from './vendor/tacit-deps.min.js';
import { satsConnect as SatsConnect } from './vendor/tacit-deps.min.js';

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
// allow-list of the meta-CSP in tacit.html. The strict policy
// (`script-src 'self'`, no wildcards) means changing a host here without
// updating the CSP causes the browser to silently drop fetches with a
// console warning — the dApp will look broken in subtle ways (loading
// spinner forever on the wallet/discover tabs). Same coupling applies to
// `WORKER_BASE`, `IPFS_GATEWAY`, and the `<link href="https://fonts...">`
// tags in tacit.html.
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
const HINT_URL     = WORKER_BASE ? WORKER_BASE + '/assets/hint' : '';
const ATTEST_URL   = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/attest` : '';
const MINT_ATTEST_URL = (assetIdHex, mintTxidHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/mints/${mintTxidHex}/attest` : '';
const UTXO_OPENING_URL = (txidHex, vout) => WORKER_BASE ? `${WORKER_BASE}/utxos/${txidHex}/${vout}/opening` : '';
const ASSET_OPENINGS_URL = (assetIdHex) => WORKER_BASE ? `${WORKER_BASE}/assets/${assetIdHex}/openings` : '';
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
  const iter = Number.isInteger(blob.iter) && blob.iter >= 100000 ? blob.iter : PBKDF2_ITER;
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

// Tab-session privkey cache. After a successful unlock, decrypt the privkey
// once and stash the bytes in sessionStorage so refreshes within the same tab
// don't re-prompt. sessionStorage is per-tab and cleared on tab close, so the
// at-rest encryption (localStorage AES-GCM blob) remains the boundary against
// device theft / cross-tab access. The unlocked key was already in JS memory
// for the duration of the session, so this doesn't expand the XSS surface.
const SESSION_PRIV_BASE = 'tacit-session-priv-v1';
function sessionPrivKey(boundExtAddr = null) {
  return boundExtAddr
    ? `${SESSION_PRIV_BASE}:${NET.name}:by:${boundExtAddr.toLowerCase()}`
    : `${SESSION_PRIV_BASE}:${NET.name}`;
}
function _cacheSessionPriv(privBytes, boundExtAddr) {
  try { sessionStorage.setItem(sessionPrivKey(boundExtAddr), bytesToHex(privBytes)); }
  catch { /* sessionStorage may be unavailable in restricted contexts */ }
}
function _readSessionPriv(boundExtAddr) {
  try {
    const hex = sessionStorage.getItem(sessionPrivKey(boundExtAddr));
    if (!hex || !/^[0-9a-f]{64}$/.test(hex)) return null;
    const b = hexToBytes(hex);
    secp.getPublicKey(b, true);
    return b;
  } catch {
    try { sessionStorage.removeItem(sessionPrivKey(boundExtAddr)); } catch {}
    return null;
  }
}
function clearAllSessionPriv() {
  try {
    const toRemove = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(SESSION_PRIV_BASE)) toRemove.push(k);
    }
    toRemove.forEach(k => sessionStorage.removeItem(k));
  } catch {}
}

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
    // Tab-session fast path: if this tab already unlocked the same wallet,
    // skip the passphrase prompt on refresh. Only meaningful when the on-disk
    // blob is encrypted — empty/plaintext shapes need to run their setup or
    // migration paths regardless.
    if (shape === 'encrypted') {
      const cached = _readSessionPriv(boundExtAddr);
      if (cached) {
        this.priv = cached;
        this.pub = secp.getPublicKey(this.priv, true);
        return;
      }
    }
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
    _cacheSessionPriv(this.priv, boundExtAddr);
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
    _cacheSessionPriv(b, boundExtAddr);
  },

  async regenerate(boundExtAddr = null) {
    const passphrase = await _promptNewPassphrase('Set a passphrase for the new wallet.');
    this.priv = secp.utils.randomPrivateKey();
    this.pub = secp.getPublicKey(this.priv, true);
    const key = walletStorageKey(boundExtAddr);
    localStorage.setItem(key, await encryptPrivkey(this.priv, passphrase));
    _cacheSessionPriv(this.priv, boundExtAddr);
  },
  address() { return p2wpkhAddress(this.pub); },
  pubHex()  { return bytesToHex(this.pub); },
  xonly()   { return this.pub.slice(1); }
};

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
const getOutspend = (txid, vout) => apiJson(`/tx/${txid}/outspend/${vout}`);
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
      // Only retry on errors that suggest propagation/indexing delay. Notably we
      // do NOT retry on `non-mandatory-script-verify-flag` (the tx is invalid
      // under mainnet policy — retry just hides the real bug) or
      // `bad-txns-inputs-missingorspent` (already covered by `missing inputs`
      // and otherwise indicates a permanent double-spend, not a race).
      if (!/missing inputs|mempool-conflict|already in block|already known|too-long-mempool-chain/i.test(msg)) {
        throw e;
      }
    }
  }
  throw lastErr || new Error('broadcast failed');
}
const getTx = id => apiJson(`/tx/${id}`).catch(() => null);

let _cachedRate = null, _cachedRateAt = 0;
async function getFeeRate() {
  if (_cachedRate && Date.now() - _cachedRateAt < 60000) return _cachedRate;
  let base = 2;
  try {
    const r = await fetch(`${NET.api}/v1/fees/recommended`);
    if (!r.ok) throw new Error();
    const j = await r.json();
    base = Math.max(1, j.halfHourFee || j.hourFee || 2);
  } catch {}
  // 10% safety margin on mainnet so a small intra-block fee spike between the
  // cache write and the broadcast doesn't push the tx below the min-relay
  // threshold and stall it. Signet has no fee market, so no margin needed.
  _cachedRate = NET.name === 'mainnet' ? Math.ceil(base * 1.1) : base;
  _cachedRateAt = Date.now();
  return _cachedRate;
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
  if (decimals < 0 || decimals > 8) throw new Error('decimals 0–8');
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
const loadRegistry = () => {
  try { return JSON.parse(localStorage.getItem(regKey()) || '{}') || {}; }
  catch (e) { console.warn('registry parse failed; resetting to empty', e); return {}; }
};
const saveRegistry = r => localStorage.setItem(regKey(), JSON.stringify(r));
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
  try { return JSON.parse(localStorage.getItem(openKey()) || '{}') || {}; }
  catch (e) { console.warn('openings parse failed; resetting to empty', e); return {}; }
};
const saveOpenings = o => localStorage.setItem(openKey(), JSON.stringify(o));
function recordOpening(txidHex, vout, assetIdHex, amount, blinding) {
  const o = loadOpenings();
  o[`${txidHex}:${vout}`] = {
    assetIdHex,
    amount: amount.toString(),
    blinding: bytesToHex(bigintToBytes32(blinding)),
  };
  saveOpenings(o);
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
}
function forgetOpenOffer(commitTxid) {
  const arr = loadOpenOffers().filter(o => o.commit_txid !== commitTxid);
  saveOpenOffers(arr);
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
async function validateOutpoint(txidHex, vout, validatedSet, fetchTx, depth = 0, metadataOut = null, rpBatch = null) {
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
    // BURN may have N=0 (burn everything to nothing). CXFER requires vout < N.
    if (!isBurn && vout >= N) { validatedSet.set(key, false); return false; }
    if (isBurn && N > 0 && vout >= N) { validatedSet.set(key, false); return false; }

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
  return null;
}

// For each wallet UTXO, look at its parent tx's input[0].witness[1] for a tacit envelope.
// Decode envelope, identify which envelope output corresponds to this UTXO,
// match against local openings, verify rangeproofs.
async function scanHoldings() {
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
  for (const u of utxos) {
    // Demote thrown errors to "not validated" but log them — silent demotion to
    // ghost makes scan failures indistinguishable from genuinely-bad ancestry,
    // which has bitten us during debugging.
    await validateOutpoint(u.txid, u.vout, validatedSet, fetchTx, 0, metadataOut, rpBatch)
      .catch(e => { console.warn('validateOutpoint threw for', u.txid + ':' + u.vout, e); return false; });
  }
  if (rpBatch.length > 0 && !bpRangeAggBatchVerify(rpBatch)) {
    // Strict re-validation: at least one rangeproof is bad. Clear the optimistic
    // cache so the main loop below re-walks each UTXO in single-proof mode and
    // records ghost/inflated state precisely.
    validatedSet = new Map();
    rpBatch = null;
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
        balance: 0n, utxos: [], ghosts: [], inflated: [],
        unknownAsset: !getAssetMeta(assetIdHex),
      });
    }
    const h = holdings.get(assetIdHex);

    // Recursive validation: this UTXO and ALL its ancestors must be valid.
    // A bad CXFER anywhere in the ancestry invalidates everything downstream.
    // Pass metadataOut so the validator records canonical CETCH metadata for any
    // ancestor it walks; we use that below to register tickers/decimals/imageUri
    // for assets that aren't yet in our local registry.
    const valid = await validateOutpoint(u.txid, u.vout, validatedSet, fetchTx, 0, metadataOut);

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
async function buildAndBroadcastCEtch({ ticker, supplyBase, decimals, imageUri = null, mintable = false, metadataBuilder = null }) {
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

// ============== CXFER (commit-reveal) ==============
// forceUtxos (optional) lets callers pre-select the exact asset UTXO(s) to
// consume — used by the cancel-atomic-offer flow, which must spend the
// specific UTXO referenced by an outstanding T_AXFER partial reveal in order
// to invalidate it. Default is the greedy largest-first picker.
async function buildAndBroadcastCXfer({ assetIdHex, recipientPubHex, amount, forceUtxos = null }) {
  const amt = BigInt(amount);
  if (amt < 0n || amt >= (1n << BigInt(N_BITS))) {
    throw new Error(`amount must be 0..${(1n << BigInt(N_BITS)) - 1n} base units (64-bit range)`);
  }
  // Find wallet UTXOs for this asset with known openings
  const holdings = await scanHoldings();
  const h = holdings.get(assetIdHex);
  if (!h) throw new Error(`no holdings for asset ${assetIdHex}`);
  if (h.balance < amt) throw new Error(`insufficient balance: have ${h.balance}, need ${amt}`);

  let pickedAssetUtxos, inAmt = 0n, inBlindingSum = 0n;
  if (forceUtxos && forceUtxos.length > 0) {
    pickedAssetUtxos = forceUtxos;
    for (const x of pickedAssetUtxos) {
      inAmt += x.amount; inBlindingSum = modN(inBlindingSum + BigInt(x.blinding));
    }
    if (inAmt < amt) throw new Error(`forced utxos provide ${inAmt}, need ${amt}`);
  } else {
    // Pick UTXOs greedily until covered
    const sortedUtxos = [...h.utxos].sort((a, b) => Number(b.amount - a.amount));
    pickedAssetUtxos = [];
    for (const x of sortedUtxos) {
      pickedAssetUtxos.push(x); inAmt += x.amount; inBlindingSum = modN(inBlindingSum + BigInt(x.blinding));
      if (inAmt >= amt) break;
    }
  }
  const changeAmt = inAmt - amt;
  if (changeAmt < 0n) throw new Error('internal: change negative');

  const recipientPub = hexToBytes(recipientPubHex);
  if (recipientPub.length !== 33) throw new Error('recipient pubkey must be 33-byte compressed');

  // Anchor for blinding derivation: first asset input's outpoint. Unique per CXFER
  // because spent UTXOs are unique. Known to both sender (from picked UTXOs) and
  // recipient (from tx.vin[1] of the reveal tx). Including this prevents cross-tx
  // commitment correlation that would otherwise leak amount differences.
  const firstAssetIn = pickedAssetUtxos[0].utxo;
  const anchorBytes = concatBytes(
    reverseBytes(hexToBytes(firstAssetIn.txid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, firstAssetIn.vout >>> 0, true); return b; })(),
  );

  // Recipient blinding via ECDH (vout 0 = recipient in reveal tx)
  const recipBlinding = deriveBlinding(wallet.priv, recipientPub, anchorBytes, 0);
  // Sender change blinding: deterministic from (sender_priv, anchor, vout). Recoverable
  // from chain — wallet can scan its own CXFER outputs and re-derive openings even after
  // localStorage is cleared.
  const changeBlinding = deriveChangeBlinding(wallet.priv, anchorBytes, 1);

  // Aggregated bulletproof: one proof covers both output commitments. Recipient
  // is vout 0, change is vout 1 — same order is enforced on the verifier.
  const { proof: aggProof, commitments } = bpRangeAggProve([amt, changeAmt], [recipBlinding, changeBlinding]);
  const recipCommitmentBytes = pointToBytes(commitments[0]);
  const changeCommitmentBytes = pointToBytes(commitments[1]);

  // Compute kernel signature (proves Σ a_out = Σ a_in without revealing amounts).
  //   excess = Σ r_out − Σ r_in   (a scalar; sender knows it)
  //   E = excess·G                  (a point; equals ΣC_out − ΣC_in iff amounts balance)
  //   sig = Schnorr-sign(kernel_msg, excess)
  // Verifier reconstructs E' = ΣC_out − ΣC_in and verifies sig under E'.xonly().
  // If amounts don't balance, E' has a nonzero H-component and no signer can produce a valid sig
  // (would require knowing dlog of H w.r.t. G — H is NUMS).
  const excess = modN(recipBlinding + changeBlinding - inBlindingSum);
  const inputOutpoints = pickedAssetUtxos.map(x => ({ txid: x.utxo.txid, vout: x.utxo.vout }));
  const outputCommitments = [recipCommitmentBytes, changeCommitmentBytes];
  const assetIdBytes = hexToBytes(assetIdHex);
  const kernelMsg = computeKernelMsg(assetIdBytes, inputOutpoints, outputCommitments);
  const kernelSig = signSchnorr(kernelMsg, bigintToBytes32(excess));

  // Encrypt amounts so recipient and sender can recover from chain alone.
  // Recipient (vout 0): ECDH-derived keystream. Sender's change (vout 1): self-derived keystream.
  const recipKs = deriveAmountKeystreamECDH(wallet.priv, recipientPub, anchorBytes, 0);
  const changeKs = deriveAmountKeystreamSelf(wallet.priv, anchorBytes, 1);
  const recipCt = encryptAmount(amt, recipKs);
  const changeCt = encryptAmount(changeAmt, changeKs);

  const payload = encodeCXferPayload({
    assetId: assetIdBytes,
    kernelSig,
    outputs: [
      { commitment: recipCommitmentBytes, encryptedAmount: recipCt },
      { commitment: changeCommitmentBytes, encryptedAmount: changeCt },
    ],
    rangeproof: aggProof,
  });
  const envelopeScript = encodeEnvelopeScript(wallet.xonly(), payload);
  const leaf = tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
  const p2trSpk = p2trScript(Q_xonly);
  const cb = controlBlock(TAP_NUMS, parity);

  const feeRate = await getFeeRate();
  // Reveal vbytes: bulletproof, envelope, witness, and base all derive from m
  // (output count) + numAssetIn. estCXferRevealVb computes the exact value.
  // Assume hasSatsChange=true for the estimate; if it ends up being false the
  // tx pays ~30 vb extra fee, which is in the helper's safety margin anyway.
  const numAssetIn = pickedAssetUtxos.length;
  const revealVb = estCXferRevealVb({ m: 2, numAssetIn, hasSatsChange: true });
  const revealFee = feeFor(revealVb, feeRate);

  // Reveal tx outputs:
  //   output 0: recipient commitment (DUST P2WPKH)
  //   output 1: sender change commitment (DUST P2WPKH)
  //   output 2 (optional): sats change to sender
  const recipientP2wpkh = concatBytes(new Uint8Array([0x00, 0x14]), hash160(recipientPub));
  const senderP2wpkh = p2wpkhScript(wallet.pub);
  // The two confidential outputs (recipient + change) are always at fixed
  // positions vout[0]/vout[1]; a sats-change vout[2] is added separately
  // below if commitValue can't cover the reveal's DUST + fee.
  const numExtraOuts = outputCommitments.length;
  const totalOutputDust = DUST * numExtraOuts;
  const assetInputTotal = pickedAssetUtxos.reduce((s, u) => s + u.utxo.value, 0); // sat values

  // We need: commitValue + assetInputTotal = totalOutputDust + satsChange + revealFee
  // satsChange ≥ 0; commitValue must be at least enough for it to work
  let satsChange = 0;
  let commitValue = totalOutputDust + revealFee - assetInputTotal;
  if (commitValue < DUST) {
    // pad with extra sats inputs in commit
    commitValue = DUST + revealFee;
    satsChange = commitValue + assetInputTotal - totalOutputDust - revealFee;
  }
  if (satsChange < DUST) satsChange = 0;

  // Build commit tx (pure sats spend → P2TR + change)
  const allUtxos = await getUtxos(wallet.address());
  // Exclude the asset UTXOs we're going to spend in the reveal
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

  await broadcast(commitHex);

  // Build reveal tx
  const revealOutputs = [
    { value: DUST, script: recipientP2wpkh },
    { value: DUST, script: senderP2wpkh },
  ];
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

  // Retry on "missing inputs" — the commit may not yet be indexed by mempool.space.
  await broadcastWithRetry(revealHex);

  // Save sender change opening locally (recipient gets theirs via share-link)
  recordOpening(revealTxid, 1, assetIdHex, changeAmt, changeBlinding);

  {
    const m = getAssetMeta(assetIdHex) || {};
    recordActivity({
      kind: 'transfer-out', ticker: m.ticker || '',
      amount: amt, decimals: m.decimals || 0,
      assetId: assetIdHex, txid: revealTxid,
    });
  }

  return {
    commitTxid, revealTxid, assetIdHex,
    sendAmount: amt, changeAmount: changeAmt,
    recipBlinding, changeBlinding,
    commitFee, revealFee,
    revealCommitmentRecipient: recipCommitmentBytes,
    revealCommitmentChange: changeCommitmentBytes,
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
async function takeAxferOffer(offer) {
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
  await broadcastWithRetry(txHex);

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
function _axintentClaimMsg(assetIdBytes, intentIdBytes, takerPubBytes) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-axintent-claim-v1'),
    assetIdBytes, intentIdBytes, takerPubBytes,
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

async function publishAxferIntent({ utxoTxid, utxoVout, priceSats, expiry }) {
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
  const resp = await fetch(withNet(ATOMIC_INTENTS_URL(assetIdHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);

  // Persist `r` locally so we can encrypt it to the claimant at fulfilment.
  // Without this, a page reload would lose the secret and the trade can't
  // complete (we wouldn't be able to communicate the amount→commitment
  // opening that the taker needs to spend).
  recordAxintentSecret(intentIdHex, bytesToHex(bigintToBytes32(recipBlinding)));
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

async function claimAxferIntent({ assetIdHex, intentIdHex }) {
  if (!WORKER_BASE) throw new Error('worker disabled');
  const cMsg = _axintentClaimMsg(hexToBytes(assetIdHex), hexToBytes(intentIdHex), wallet.pub);
  const sig = signSchnorr(cMsg, wallet.priv);
  const resp = await fetch(withNet(ATOMIC_INTENT_CLAIM_URL(assetIdHex, intentIdHex)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taker_pubkey: bytesToHex(wallet.pub), sig: bytesToHex(sig) }),
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

async function takeAxferIntent({ intent, fulfilment }) {
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
  const result = await takeAxferOffer(offer);
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
  return j;
}

// ============== MINT BUILDER ==============
// Issuer creates an additional supply commitment for an existing mintable asset_id.
// Structure mirrors CETCH (commit + reveal Taproot script-path), but the envelope
// is T_MINT and the new UTXO at reveal vout=0 is the issuer's. mint_authority
// must be the wallet's xonly pubkey (so we can sign).
async function buildAndBroadcastCMint({ assetIdHex, etchTxidHex, amount }) {
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
async function buildAndBroadcastCBurn({ assetIdHex, amount }) {
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
  await broadcastWithRetry(revealHex);

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
  return j;
}

// Soft claim lock — taker reserves a listing for 30 min so two takers don't
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
      if (tab.dataset.tab === 'transfer') { refreshAssetSelect(); refreshRecipientRecents(); updateDerivedAddressHint(); }
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
  if (dripBtn) dripBtn.style.display = (onSignet && userLow && FAUCET_URL && faucetReady) ? '' : 'none';
  if (manualFaucetBtn) manualFaucetBtn.style.display = (onSignet && userLow) ? '' : 'none';
  if (fundBtn) fundBtn.style.display = hasExt ? '' : 'none';
  if (xBtn) xBtn.style.display = hasExt ? 'none' : '';
  if (uBtn) uBtn.style.display = hasExt ? 'none' : '';
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
  const backedUp = isBurnerBackedUp();
  if (backupEl) {
    backupEl.textContent = backedUp ? '· ✓ backed up' : '· ⚠ not backed up';
    backupEl.style.color = backedUp ? 'var(--green)' : 'var(--red)';
  }
  if (warnEl) warnEl.style.display = backedUp ? 'none' : '';

  // External-wallet info card inside the Manage Wallet drawer. The dl/dt/dd
  // grid was authored statically, but the values come from renderExtWalletPanel
  // which we still call separately; here we just toggle the wrapper visibility.
  const extInfoEl = $('#ext-wallet-connected-info');
  if (extInfoEl) extInfoEl.style.display = hasExt ? '' : 'none';
}

async function refreshWallet() {
  $('#w-address').textContent = wallet.address();
  $('#w-pubkey').textContent = wallet.pubHex();
  $('#explorer-link').href = `${NET.explorer}/address/${wallet.address()}`;
  $('#wallet-status').textContent = 'syncing…';
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
    $('#w-balance').textContent = fmtSats(balance);
    $('#w-height').textContent = height;
    $('#wallet-status').textContent = `synced · ${rate} sat/vB`;
    renderWalletCard({ balance, faucetReady });
  } catch (e) {
    $('#wallet-status').textContent = 'offline: ' + e.message;
  }
}
function setupWalletButtons() {
  $('#btn-refresh').onclick = refreshWallet;
  // Lock: drop the tab-session privkey cache and reload. The encrypted blob in
  // localStorage is untouched, so the next page load will prompt for the
  // passphrase as it did pre-cache. Clears all bound/unbound entries so a user
  // who has cycled through ext-wallet bindings re-locks every cached identity.
  const lockBtn = $('#btn-lock');
  if (lockBtn) lockBtn.onclick = () => {
    clearAllSessionPriv();
    location.reload();
  };
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
  $('#btn-export').onclick = () => {
    prompt('Your private key (hex). Save somewhere safe — there is no recovery:', bytesToHex(wallet.priv));
    // After a manual export, ask once whether the user wants to clear the
    // forced-backup gate. We don't auto-set it: the user might have hit the
    // button by accident and not actually copied the value.
    if (!isBurnerBackedUp() && confirm('Mark this burner key as backed up?\n\nClick OK only if you copied the hex above to a safe location. This skips the export prompt before future tacit operations.')) {
      markBurnerBackedUp();
      toast('Burner key marked as backed up.', 'success');
      setupNetworkSelect(); // refresh banner hints
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
// If it dereferences to image bytes, use the URI directly. Cached per session.
const _resolvedImageCache = new Map();
const _metadataExtraCache = new Map(); // imageUri → { name, description, external_url }
async function resolveImageUri(imageUri) {
  if (!imageUri) return null;
  if (_resolvedImageCache.has(imageUri)) return _resolvedImageCache.get(imageUri);
  const url = normalizeImageUri(imageUri);
  if (!url) { _resolvedImageCache.set(imageUri, null); return null; }
  let resolved = url;
  let extra = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (resp.ok) {
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
  return resolved;
}
function getMetadataExtras(imageUri) {
  return _metadataExtraCache.get(imageUri) || null;
}
function setupEtchForm() {
  const fileInput = $('#e-image-file');
  const fileLabel = document.querySelector('label[for="e-image-file"]');
  const fileStatus = $('#e-image-status');
  if (!PIN_URL) {
    fileLabel.style.opacity = '0.4';
    fileLabel.style.pointerEvents = 'none';
    fileStatus.textContent = 'upload disabled — set PIN_URL in tacit.html';
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
  presetChips.forEach(chip => {
    chip.onclick = () => {
      decimalsInput.value = chip.dataset.decimals;
      syncDecimalsChips();
      updateEtchPreview();
    };
  });
  decimalsInput?.addEventListener('input', () => { syncDecimalsChips(); updateEtchPreview(); });
  supplyInput?.addEventListener('input', updateEtchPreview);
  tickerInput?.addEventListener('input', updateEtchPreview);
  syncDecimalsChips();
  updateEtchPreview();
  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileStatus.textContent = `uploading ${file.name} (${(file.size/1024).toFixed(1)} KB)…`;
    try {
      const cid = await uploadImageToPinata(file);
      $('#e-image').value = `ipfs://${cid}`;
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
            <div class="head">CETCH · Taproot envelope</div>
            <div class="data">${name ? `name = "<strong>${escapeHtml(name)}</strong>" · ` : ''}ticker = "${escapeHtml(ticker)}" · decimals = ${decimals} · supply = ${escapeHtml(supplyStr)} (${supplyBase} base units)</div>
            ${imageUri ? `<div class="data" style="display:flex;align-items:center;gap:10px;margin-top:6px;">image: <span style="font-family:var(--mono);font-size:11px;word-break:break-all;">${escapeHtml(imageUri)}</span><img src="${escapeHtml(normalizeImageUri(imageUri) || '')}" alt="" style="width:32px;height:32px;border:1px solid var(--ink);object-fit:cover;background:#fff;"></div>` : ''}
            ${description ? `<div class="data" style="margin-top:6px;">description: <span style="font-style:italic;">${escapeHtml(description)}</span></div>` : ''}
            ${externalUrl ? `<div class="data" style="margin-top:4px;">link: <span style="font-family:var(--mono);font-size:11px;">${escapeHtml(externalUrl)}</span></div>` : ''}
            ${(description || externalUrl) ? `<div class="data" style="margin-top:6px;color:var(--ink-mid);font-size:10px;">↑ a JSON metadata blob will be pinned and the envelope will store its CID (instead of the raw image CID)</div>` : ''}
            <div class="data">commitment C = supply·H + r·G (33B, supply hidden) — bytes computed at broadcast from your wallet key + commit input</div>
            <div class="data" style="margin-top:6px;color:var(--ink-mid);">+ ~688-byte aggregated bulletproof proving supply ∈ [0, 2⁶⁴) — generated at broadcast (~3–5s)</div>
            <div class="data" style="margin-top:6px;">supply policy: <strong>${mintable ? 'mintable (you can issue more later via T_MINT)' : 'fixed (no further supply increases possible)'}</strong></div>
          </div>
          <h4 style="margin-top:14px;">2-tx commit-reveal flow</h4>
          <div class="row"><span class="idx">[1]</span><span class="label">commit tx</span> creates P2TR output (envelope merkle-committed in tweak)</div>
          <div class="row"><span class="idx">[2]</span><span class="label">reveal tx</span> spends P2TR via script-path, exposing envelope + rangeproof in witness</div>
          <h4 style="margin-top:14px;">Reveal tx outputs</h4>
          <div class="row"><span class="idx">[0]</span><span class="label">P2WPKH (you)</span> ${fmtSats(DUST)} sats · holds the supply commitment</div>
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
      return;
    }
    // Just-in-time funding: if the wallet has no sats (or not enough), pop the
    // appropriate funding flow inline before the build runs.
    const need = await estimateSatsForOp('etch');
    if (!(await ensureSatsFunded(need, 'Etching'))) return;
    const attestRequested = !!$('#e-attest-on-etch')?.checked;
    $('#btn-etch-broadcast').disabled = true;
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
        $('#btn-etch-broadcast').textContent = 'Pinning metadata…';
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

      $('#btn-etch-broadcast').textContent = 'Proving rangeproof…';
      // Yield to UI before the ~250ms prove
      await new Promise(r => setTimeout(r, 50));
      $('#btn-etch-broadcast').textContent = 'Broadcasting commit + reveal…';
      const r = await buildAndBroadcastCEtch({
        ticker: job.ticker,
        supplyBase: job.supplyBase,
        decimals: job.decimals,
        imageUri: job.imageUri,
        mintable: job.mintable,
        metadataBuilder,
      });
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
                — supply commitment lives at vout 0 of the reveal tx. The recovered amount + blinding sit in localStorage; export your key to back them up.
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
      console.error(e);
    } finally {
      $('#btn-etch-broadcast').disabled = false;
      $('#btn-etch-broadcast').textContent = 'Etch & broadcast';
    }
  };
}

// ============== TRANSFER UI ==============
let pendingCXfer = null;

async function refreshAssetSelect() {
  const sel = $('#x-asset');
  if (!sel) return;
  const holdings = await scanHoldings().catch(() => new Map());
  const knownNonZero = [...holdings.values()].filter(h => !h.unknownAsset && h.balance > 0n);
  const current = sel.value;
  sel.innerHTML = '<option value="">— select —</option>' + knownNonZero.map(h =>
    `<option value="${h.assetIdHex}">${escapeHtml(h.ticker)} · balance: ${fmtAssetAmount(h.balance, h.decimals)}</option>`
  ).join('');
  if (current) sel.value = current;
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
function updateDerivedAddressHint() {
  const inputEl = $('#x-recipient-pub');
  const hintEl = $('#x-recipient-derived');
  if (!inputEl || !hintEl) return;
  const raw = inputEl.value.trim().toLowerCase().replace(/\s/g, '');
  if (!raw) { hintEl.style.display = 'none'; hintEl.textContent = ''; return; }
  if (!/^0[23][0-9a-f]{64}$/.test(raw)) {
    hintEl.style.display = '';
    hintEl.style.color = 'var(--ink-mid)';
    hintEl.textContent = `${raw.length}/66 chars · expecting compressed pubkey starting with 02 or 03`;
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
  const recipientInput = $('#x-recipient-pub');
  if (recipientInput) {
    recipientInput.addEventListener('input', updateDerivedAddressHint);
    // Re-evaluate on tab activation in case of network switches.
    updateDerivedAddressHint();
  }
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

      pendingCXfer = { assetIdHex, recipientPubHex, amount, ticker: meta.ticker, decimals: meta.decimals };

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
          <h4>2-tx commit-reveal flow (Taproot envelope)</h4>
          <div class="row"><span class="idx">[1]</span><span class="label">commit tx</span> creates P2TR output (envelope merkle-committed in tweak)</div>
          <div class="row"><span class="idx">[2]</span><span class="label">reveal tx</span> spends P2TR via script-path + your asset UTXO; exposes envelope + aggregated rangeproof (~1 KB witness at m=2)</div>
          <h4 style="margin-top:14px;">Reveal tx outputs</h4>
          <div class="row"><span class="idx">[0]</span><span class="label">P2WPKH</span> ${fmtSats(DUST)} sats → ${escapeHtml(shorten(recipientAddr, 14))} <span class="muted">(recipient's commitment)</span></div>
          <div class="row"><span class="idx">[1]</span><span class="label">P2WPKH (you)</span> ${fmtSats(DUST)} sats <span class="muted">(your change commitment)</span></div>
          <h4 style="margin-top:14px;">What stays private</h4>
          <div class="row">recipient amount: ${fmtAssetAmount(amount, meta.decimals)} ${escapeHtml(meta.ticker)}</div>
          <div class="row">your change: ${fmtAssetAmount(h.balance - amount, meta.decimals)} ${escapeHtml(meta.ticker)}</div>
          <div class="row" style="color:var(--ink-mid);font-style:italic;">observers see only 33-byte commitments + a single 754-byte aggregated rangeproof — neither amount visible</div>
          <h4 style="margin-top:14px;">After broadcast</h4>
          <div class="row" style="color:var(--ink-mid);">a share-link will be generated — recipients can recover the amount from chain alone, but the link lets them import immediately without rescanning</div>
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
    $('#btn-transfer-broadcast').textContent = 'Proving rangeproofs…';
    try {
      await new Promise(r => setTimeout(r, 50));
      $('#btn-transfer-broadcast').textContent = 'Broadcasting commit + reveal…';
      const r = await buildAndBroadcastCXfer(job);
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
      }
      refreshWallet();
    } catch (e) {
      $('#transfer-error').textContent = e.message;
      console.error(e);
    } finally {
      $('#btn-transfer-broadcast').disabled = false;
      $('#btn-transfer-broadcast').textContent = 'Transfer & broadcast';
    }
  };
}

function parseAssetAmount(input, decimals) {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount: ${input}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`amount has too many decimals (max ${decimals})`);
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * (10n ** BigInt(decimals)) + (padded ? BigInt(padded) : 0n);
}

// ============== HOLDINGS UI ==============
async function renderHoldings() {
  const list = $('#holdings-list');
  $('#holdings-status').textContent = 'scanning…';
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
      $('#holdings-status').textContent = '';
      return;
    }
    list.innerHTML = '';
    // Resolve all metadata blobs + per-asset published openings in parallel —
    // sequential awaits inside the loop turn N tokens into N back-to-back
    // round-trips to IPFS / worker. Best-effort: errors leave the badge off,
    // they don't break the render.
    const [imgUrls, openingsByAsset, listingsByAsset, rangeListingsByAsset] = await Promise.all([
      Promise.all(arr.map(h => {
        const m = getAssetMeta(h.assetIdHex);
        return m?.imageUri ? resolveImageUri(m.imageUri) : Promise.resolve(null);
      })),
      Promise.all(arr.map(h => {
        if (!WORKER_BASE) return Promise.resolve([]);
        return fetch(withNet(ASSET_OPENINGS_URL(h.assetIdHex)))
          .then(r => r.ok ? r.json() : { openings: [] })
          .then(j => Array.isArray(j.openings) ? j.openings : [])
          .catch(() => []);
      })),
      Promise.all(arr.map(h => {
        if (!WORKER_BASE) return Promise.resolve([]);
        return fetch(withNet(LISTINGS_URL(h.assetIdHex)))
          .then(r => r.ok ? r.json() : { listings: [] })
          .then(j => Array.isArray(j.listings) ? j.listings : [])
          .catch(() => []);
      })),
      Promise.all(arr.map(h => {
        if (!WORKER_BASE) return Promise.resolve([]);
        return fetch(withNet(RANGE_LISTINGS_URL(h.assetIdHex)))
          .then(r => r.ok ? r.json() : { listings: [] })
          .then(j => Array.isArray(j.listings) ? j.listings : [])
          .catch(() => []);
      })),
    ]);
    for (let i = 0; i < arr.length; i++) {
      const h = arr[i];
      const card = document.createElement('div');
      card.className = 'asset-card';
      const meta = getAssetMeta(h.assetIdHex);
      const etchLink = meta?.etchTxid ? `${NET.explorer}/tx/${meta.etchTxid}` : '#';
      const imgUrl = imgUrls[i];
      const extras = meta?.imageUri ? getMetadataExtras(meta.imageUri) : null;
      // Display name from metadata blob; falls back to ticker for assets that
      // never set a name (older blobs, or etches without metadata at all).
      const displayName = (extras?.name && extras.name.trim()) ? extras.name : h.ticker;
      const avatar = imgUrl
        ? `<img src="${escapeHtml(imgUrl)}" alt="" style="width:40px;height:40px;border:1px solid var(--ink);object-fit:cover;background:#fff;flex-shrink:0;">`
        : '';
      // Cross-reference the published-openings list against the user's own UTXOs.
      // "myPublishedCount" tells the user which of their balance is already public;
      // "totalPublishedCount" is the asset-wide count for marketplace context.
      const myUtxoKeys = new Set(h.utxos.map(u => `${u.utxo.txid}:${u.utxo.vout}`));
      const allOpenings = openingsByAsset[i] || [];
      const myPublishedCount = allOpenings.filter(o => myUtxoKeys.has(`${o.txid}:${o.vout}`)).length;
      const totalPublishedCount = allOpenings.length;
      const balanceVerifiedTag = myPublishedCount > 0
        ? `<span class="unit" style="color:#0a8f43;">✓ ${myPublishedCount === h.utxos.length ? 'verified' : `${myPublishedCount}/${h.utxos.length} verified`}</span>`
        : '';
      // Listings authored by this wallet, surfaced on the holdings card so the
      // maker can see their active offers + cancel them. Both opening-based
      // and range-disclosed variants render here.
      const allListings = listingsByAsset[i] || [];
      const allRangeListings = rangeListingsByAsset[i] || [];
      const ownerPubHex = bytesToHex(wallet.pub);
      const myListings = allListings.filter(l => l.owner_pubkey === ownerPubHex && !l.expired);
      const myRangeListings = allRangeListings.filter(l => l.owner_pubkey === ownerPubHex && !l.expired);
      const renderClaim = (claim) => claim
        ? `<div style="margin-top:2px;color:#a04030;font-size:10px;">⏱ reserved by taker ${escapeHtml(shorten(claim.taker_pubkey, 6))} until ${new Date(claim.expires_at * 1000).toLocaleTimeString()} — they intend to pay; deliver via Send Privately when payment arrives</div>`
        : '';
      const myListingsBlock = (myListings.length || myRangeListings.length) ? `
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
      ` : '';
      // Per-asset action grouping. Primary actions (Send / Receive) sit on top
      // for the everyday holder. Disclosure (reveal supply / mints, publish
      // balance, prove ≥ X) and Marketplace (List for sale) live behind their
      // own collapsible sections so the card stays scannable. Burn — irreversible
      // — gets its own Danger zone.
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

      card.innerHTML = `
        <div class="head" style="display:flex;align-items:center;gap:12px;">
          ${avatar}
          <div style="flex:1;min-width:0;">
            <div class="ticker">${escapeHtml(displayName)}${displayName !== h.ticker ? `<span class="ticker-sub">${escapeHtml(h.ticker)}</span>` : ''}<span class="id-tag" data-act="copy-aid" data-aid="${h.assetIdHex}" title="Copy asset ID">${escapeHtml(shorten(h.assetIdHex, 4))}</span></div>
            <div class="balance">${fmtAssetAmount(h.balance, h.decimals)}<span class="unit">${h.unknownAsset ? 'unknown asset' : 'confidential'}</span>${balanceVerifiedTag}</div>
          </div>
        </div>
        <div class="meta">
          <div><span class="lbl">Asset ID</span> ${assetIdRowHTML(h.assetIdHex)}</div>
          <div><span class="lbl">Decimals</span> ${h.decimals}</div>
          <div><span class="lbl">UTXOs</span> ${h.utxos.length} known${h.ghosts.length ? ` · <span style="color:var(--red);">${h.ghosts.length} ghost</span>` : ''}${myPublishedCount > 0 ? ` · <span style="color:#0a8f43;">${myPublishedCount} published</span>` : ''}</div>
          <div><span class="lbl">Etch tx</span> ${meta?.etchTxid ? `<a href="${escapeHtml(etchLink)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shorten(meta.etchTxid, 8))} ↗</a>` : '—'}${totalPublishedCount > myPublishedCount ? ` · <span class="muted">${totalPublishedCount} openings published asset-wide</span>` : ''}</div>
        </div>
        ${extras?.description ? `<div class="muted" style="margin-top:10px;font-size:11px;font-style:italic;">${escapeHtml(extras.description)}</div>` : ''}
        ${(() => {
          const safe = safeExternalUrl(extras?.external_url);
          return safe ? `<div style="margin-top:6px;font-size:11px;"><a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safe)} ↗</a></div>` : '';
        })()}
        ${h.ghosts.length ? `<div class="warn" style="margin-top:10px;font-size:11px;">⚠ ${h.ghosts.length} UTXO${h.ghosts.length>1?'s':''} hold commitments this wallet can't open. Try ↻ Rescan, or import a share-link for legacy/incompatible sends.</div>` : ''}
        ${h.inflated && h.inflated.length ? `<div class="warn" style="margin-top:10px;font-size:11px;background:#fee;border-left-color:var(--red);"><strong>⚠ Inflation attempt detected:</strong> ${h.inflated.length} UTXO${h.inflated.length>1?'s':''} have invalid rangeproofs. These are not counted in your balance.</div>` : ''}
        ${myListingsBlock}
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
              <div class="group-blurb">Optional public attestations — pin (amount, blinding) so anyone can verify <code>C == amount·H + r·G</code> against on-chain commitments. Permanent: published openings cannot be unpublished.</div>
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
      list.appendChild(card);
    }
    // Asset-id short / full toggle.
    wireAssetIdToggles(list);
    // Click ticker id-tag to copy the asset_id without expanding.
    list.querySelectorAll('span[data-act="copy-aid"]').forEach(el => {
      el.onclick = async () => {
        try { await navigator.clipboard.writeText(el.dataset.aid); toast('Asset ID copied', 'success'); }
        catch { /* clipboard blocked; let the user expand and select instead */ }
      };
    });
    list.querySelectorAll('button[data-act]').forEach(b => {
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
              </div>`,
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
              const r = await buildAndBroadcastCBurn({ assetIdHex: aid, amount: burnBase });
              toast(`Burned ${fmtAssetAmount(burnBase, target.decimals)} ${target.ticker} · reveal=${shorten(r.revealTxid, 6)}`, 'success');
              renderHoldings(); renderActivity();
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
          openInlineForm(b, {
            submitLabel: 'Mint more',
            content: `
              <label>Amount to mint (display units)</label>
              <input type="text" inputmode="decimal" data-field="amount" placeholder="e.g. 1000">
              <div class="muted" style="margin-top:6px;font-size:11px;">
                You hold the mint authority for <strong>${escapeHtml(target.ticker)}</strong>. Each mint emits a new T_MINT envelope; supply is rangeproof-bounded to 2⁶⁴ per envelope.
              </div>`,
            onSubmit: async ({ host, errEl }) => {
              const raw = host.querySelector('[data-field="amount"]').value.trim();
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
              const r = await buildAndBroadcastCMint({ assetIdHex: aid, etchTxidHex: meta.etchTxid, amount: mintBase });
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
            },
          });
        } else if (b.dataset.act === 'reveal-supply') {
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.etchOpening) { toast('No opening available — rescan first', 'error'); return; }
          const { supply, blinding } = target.etchOpening;
          const decimals = target.decimals;
          const display = fmtAssetAmount(supply, decimals);
          if (!confirm(`Publish opening for ${target.ticker}?\n\nSupply: ${display} (${supply} base units)\n\nThis pins (supply, blinding) to the worker so anyone can verify C == supply·H + r·G against the on-chain commitment. Once published, this asset's supply is publicly known.`)) return;
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
            `Each opening pins (amount, blinding) to the worker, signed by your wallet to prove ownership. ` +
            `Anyone can verify C == amount·H + blinding·G against the on-chain commitment.\n\n` +
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
          // Each listing is per-UTXO. Default to selling the largest UTXO; let
          // the user pick another one via the dropdown.
          const sortedUtxos = [...target.utxos].sort((a, b) => Number(b.amount - a.amount));
          const utxoOpts = sortedUtxos.map((u, idx) => `
            <option value="${idx}">${escapeHtml(fmtAssetAmount(u.amount, target.decimals))} ${escapeHtml(target.ticker)} · UTXO ${escapeHtml(shorten(u.utxo.txid, 8))}:${u.utxo.vout}</option>
          `).join('');
          formHost.innerHTML = `
            <div class="inline-form">
              <label>UTXO to sell</label>
              <select data-field="utxo">${utxoOpts}</select>
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
                ⚠ Your exact balance for the chosen UTXO becomes <strong>public</strong> once listed.
              </div>
              <div class="form-buttons">
                <button class="primary" data-form-act="publish">Publish listing</button>
                <button data-form-act="cancel">Cancel</button>
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
            const utxoIdx = parseInt(formHost.querySelector('[data-field="utxo"]').value, 10);
            const u = sortedUtxos[utxoIdx];
            if (!u) { errEl.textContent = 'pick a UTXO'; return; }
            const priceSats = parseInt(formHost.querySelector('[data-field="price"]').value.trim(), 10);
            if (!Number.isInteger(priceSats) || priceSats < DUST) { errEl.textContent = `price must be integer ≥ ${DUST}`; return; }
            const days = parseInt(formHost.querySelector('[data-field="days"]').value.trim(), 10);
            if (!Number.isInteger(days) || days < 1 || days > 365) { errEl.textContent = 'days must be 1–365'; return; }
            const expiry = Math.floor(Date.now() / 1000) + days * 86400;
            const submitBtn = ev.target;
            submitBtn.disabled = true; submitBtn.textContent = 'listing…';
            try {
              await publishListing({
                assetIdHex: aid,
                txidHex: u.utxo.txid,
                vout: u.utxo.vout,
                amount: u.amount,
                blinding: u.blinding,
                priceSats,
                expiry,
                makerAddress: wallet.address(),
              });
              toast(`Listed ${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} at ${priceSats.toLocaleString()} sats ✓`, 'success');
              renderHoldings();
            } catch (e) {
              errEl.textContent = 'Listing failed: ' + e.message;
              submitBtn.disabled = false; submitBtn.textContent = 'Publish listing';
            }
          };
        } else if (b.dataset.act === 'cancel-listing') {
          const aid = b.dataset.aid;
          const txidHex = b.dataset.txid;
          const vout = parseInt(b.dataset.vout, 10);
          if (!confirm(`Cancel this listing? The signed offer will be removed from the marketplace immediately.`)) return;
          b.disabled = true; b.textContent = 'cancelling…';
          try {
            await cancelListing({ assetIdHex: aid, txidHex, vout });
            toast('Listing cancelled ✓', 'success');
            renderHoldings();
          } catch (e) {
            toast('Cancel failed: ' + e.message, 'error');
            b.disabled = false; b.textContent = 'Cancel';
          }
        } else if (b.dataset.act === 'list-range') {
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs to list', 'error'); return; }
          const availInput = prompt(
            `List "${target.ticker} balance ≥ X" with hidden total balance.\n\n` +
            `Your real balance: ${fmtAssetAmount(target.balance, target.decimals)} (${target.utxos.length} UTXOs aggregated)\n\n` +
            `How much are you offering to sell? Display units (e.g. "100"):`,
            '100',
          );
          if (!availInput) return;
          let availBase;
          try { availBase = parseAssetAmount(availInput.trim(), target.decimals); }
          catch (e) { toast('Available parse error: ' + e.message, 'error'); return; }
          if (availBase <= 0n) { toast('Available must be > 0', 'error'); return; }
          if (availBase > target.balance) {
            toast(`Available ${fmtAssetAmount(availBase, target.decimals)} > balance ${fmtAssetAmount(target.balance, target.decimals)}`, 'error');
            return;
          }
          const priceInput = prompt(`Price in sats (≥ ${DUST}):`, '50000');
          if (!priceInput) return;
          const priceSats = parseInt(priceInput.trim(), 10);
          if (!Number.isInteger(priceSats) || priceSats < DUST) { toast(`Price must be integer ≥ ${DUST}`, 'error'); return; }
          const daysInput = prompt('Listing expiry in days (1–365):', '7');
          if (!daysInput) return;
          const days = parseInt(daysInput.trim(), 10);
          if (!Number.isInteger(days) || days < 1 || days > 365) { toast('Days must be 1–365', 'error'); return; }
          const expiry = Math.floor(Date.now() / 1000) + days * 86400;
          if (!confirm(
            `Publish range-disclosed listing for ${target.ticker}?\n\n` +
            `Selling: ${fmtAssetAmount(availBase, target.decimals)} ${target.ticker} (advertised lower bound)\n` +
            `Price:   ${priceSats.toLocaleString()} sats\n` +
            `Pay to:  ${wallet.address()}\n` +
            `Expires: ${days} day${days>1?'s':''}\n\n` +
            `Proves balance ≥ ${fmtAssetAmount(availBase, target.decimals)} via a bulletproof. ` +
            `Your exact balance and other UTXOs stay confidential. ` +
            `Settlement is OFF-CHAIN: taker pays sats, then you broadcast a CXFER for exactly the listed amount.`,
          )) return;
          b.disabled = true; b.textContent = 'proving…';
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
            toast('Range listing failed: ' + e.message, 'error');
            b.disabled = false; b.textContent = 'List (hidden balance)';
          }
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
          // first, then offers the resulting fixed-amount UTXO.
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs to offer', 'error'); return; }
          // Auto-pick the largest UTXO. Future: let user pick from a list.
          const sortedUtxos = [...target.utxos].sort((a, b) => Number(b.amount - a.amount));
          const u = sortedUtxos[0];
          const recipientInput = prompt(
            `Atomic offer for ${target.ticker}.\n\n` +
            `Selling: UTXO ${shorten(u.utxo.txid, 8)}:${u.utxo.vout} containing ${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} (whole UTXO; v1 atomic offers don't support partial fills — split via Send Privately first if needed)\n\n` +
            `Recipient pubkey (33-byte compressed hex, 02… or 03…):`,
          );
          if (!recipientInput) return;
          const recipientPub = recipientInput.trim().toLowerCase();
          if (!/^0[23][0-9a-f]{64}$/.test(recipientPub)) { toast('Invalid recipient pubkey', 'error'); return; }
          const priceInput = prompt(`Price in sats (≥ ${DUST}):`, '50000');
          if (!priceInput) return;
          const priceSats = parseInt(priceInput.trim(), 10);
          if (!Number.isInteger(priceSats) || priceSats < DUST) { toast(`Price must be integer ≥ ${DUST}`, 'error'); return; }
          const daysInput = prompt('Offer expiry in days (1–7):', '1');
          if (!daysInput) return;
          const days = parseInt(daysInput.trim(), 10);
          if (!Number.isInteger(days) || days < 1 || days > 7) { toast('Days must be 1–7 (atomic offers should be short-lived)', 'error'); return; }
          const expiry = Math.floor(Date.now() / 1000) + days * 86400;
          if (!confirm(
            `Create atomic offer?\n\n` +
            `Selling: ${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} (whole UTXO)\n` +
            `Price:   ${priceSats.toLocaleString()} sats (paid to ${wallet.address()})\n` +
            `To:      ${shorten(recipientPub, 8)}\n` +
            `Expires: ${days} day${days>1?'s':''}\n\n` +
            `On confirm: a commit tx will be broadcast (one-time fee ≈ ${feeFor(150, 10)} sats), and a partial reveal tx will be signed and copied to clipboard. Send the JSON to the recipient — they finalize and broadcast in one atomic Bitcoin tx.\n\n` +
            `If they don't take it before the commit output is spent (by you, in any other tx), nothing happens.`,
          )) return;
          b.disabled = true; b.textContent = 'committing…';
          await new Promise(r => setTimeout(r, 50));
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
            b.textContent = '✓ offer copied';
            renderActivity(); renderOffers();
          } catch (e) {
            toast('Atomic offer failed: ' + e.message, 'error');
            b.disabled = false; b.textContent = 'Atomic (targeted)';
          }
        } else if (b.dataset.act === 'publish-intent') {
          // Browse-and-take atomic intent — appears on the Market tab for any
          // taker to claim. Maker stays online to fulfil claims as they arrive.
          const aid = b.dataset.aid;
          const target = holdings.get(aid);
          if (!target?.utxos.length) { toast('No openable UTXOs to publish', 'error'); return; }
          const sortedUtxos = [...target.utxos].sort((a, b) => Number(b.amount - a.amount));
          const u = sortedUtxos[0];
          const priceInput = prompt(
            `Publish atomic intent for ${target.ticker}.\n\n` +
            `Selling: UTXO ${shorten(u.utxo.txid, 8)}:${u.utxo.vout} containing ${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} (whole UTXO; v1 atomic doesn't support partial fills)\n\n` +
            `Price in sats (≥ ${DUST}):`,
            '50000',
          );
          if (!priceInput) return;
          const priceSats = parseInt(priceInput.trim(), 10);
          if (!Number.isInteger(priceSats) || priceSats < DUST) { toast(`Price must be integer ≥ ${DUST}`, 'error'); return; }
          const daysInput = prompt('Intent expiry in days (1–7):', '1');
          if (!daysInput) return;
          const days = parseInt(daysInput.trim(), 10);
          if (!Number.isInteger(days) || days < 1 || days > 7) { toast('Days must be 1–7', 'error'); return; }
          const expiry = Math.floor(Date.now() / 1000) + days * 86400;
          if (!confirm(
            `Publish atomic intent on the Market?\n\n` +
            `Selling: ${fmtAssetAmount(u.amount, target.decimals)} ${target.ticker} (whole UTXO)\n` +
            `Price:   ${priceSats.toLocaleString()} sats\n` +
            `Expires: ${days} day${days>1?'s':''}\n\n` +
            `Anyone can claim. When a claim arrives, you'll see a "Fulfil" button on the Market tab — that generates a partial reveal targeted at the claimant. The taker then finalizes and broadcasts in one atomic Bitcoin tx. Trustless.\n\n` +
            `Stay online or check back periodically: each claim has 30 min to be fulfilled.`,
          )) return;
          b.disabled = true; b.textContent = 'committing…';
          await new Promise(r => setTimeout(r, 50));
          try {
            const r = await publishAxferIntent({
              utxoTxid: u.utxo.txid,
              utxoVout: u.utxo.vout,
              priceSats,
              expiry,
            });
            toast(`Intent ${shorten(r.intent_id, 6)} published ✓ — visible on the Market tab`, 'success', 8000);
            b.textContent = '✓ intent posted';
          } catch (e) {
            toast('Intent failed: ' + e.message, 'error');
            b.disabled = false; b.textContent = 'Atomic intent (open)';
          }
        }
      };
    });
    $('#holdings-status').textContent = `${arr.length} asset${arr.length > 1 ? 's' : ''}`;
  } catch (e) {
    list.innerHTML = `<div class="error">Scan failed: ${escapeHtml(e.message)}</div>`;
    $('#holdings-status').textContent = '';
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
function postHint(revealTxid, revealVout = 0) {
  if (!HINT_URL || !revealTxid) return;
  const delays = [0, 3000, 8000, 20000, 60000]; // ~90s total before giving up
  (async () => {
    for (const d of delays) {
      if (d > 0) await new Promise(r => setTimeout(r, d));
      try {
        const resp = await fetch(withNet(HINT_URL), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reveal_txid: revealTxid, reveal_vout: revealVout }),
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
    const resp = await fetch(withNet(REGISTRY_URL, 'limit=6&mints=0'));
    const j = await resp.json();
    const assets = (j.assets || []).slice(0, 6);
    if (!assets.length) {
      list.innerHTML = `<div class="muted" style="padding:14px;text-align:center;font-style:italic;">No assets etched on ${escapeHtml(NET.name)} yet — be the first.</div>`;
      return;
    }
    // Same client-side validation as Discover. The teaser is a smaller surface
    // but still surfaces ticker strings — without verification a malicious
    // worker could spoof "USDT" thumbnails on the wallet tab. Reuses the
    // verifyDiscoverAsset cache so users pay the verification cost once
    // across the wallet teaser and the Discover tab.
    const verifications = await Promise.all(assets.map(a =>
      verifyDiscoverAsset(a).catch(e => ({ ok: false, error: (e && e.message) || String(e) }))
    ));
    // Image fetches use the canonical image_uri from the verified envelope so
    // a bad worker can't redirect tile thumbnails through a tracking IPFS CID.
    const imgUrls = await Promise.all(assets.map((a, i) => {
      const uri = verifications[i].ok ? verifications[i].imageUri : a.image_uri;
      return uri ? resolveImageUri(uri) : Promise.resolve(null);
    }));
    const grid = document.createElement('div');
    grid.className = 'recent-grid';
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      const v = verifications[i];
      const safeAssetId = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
      const ageMin = Math.max(0, Math.floor((Date.now()/1000 - (a.etched_at || 0)) / 60));
      const ageStr = ageMin < 60 ? `${ageMin}m ago` : ageMin < 1440 ? `${Math.floor(ageMin/60)}h ago` : `${Math.floor(ageMin/1440)}d ago`;
      // Display canonical ticker if verified; fall back to worker string only
      // when on-chain validation couldn't run (the ✗ badge signals it).
      const ticker = v.ok ? v.ticker : (typeof a.ticker === 'string' ? a.ticker : '?');
      const _recentExtras = a.image_uri ? getMetadataExtras(a.image_uri) : null;
      const displayName = (_recentExtras?.name && _recentExtras.name.trim()) ? _recentExtras.name : ticker;
      const verifyMark = v.ok
        ? (v.mismatches && v.mismatches.length ? ' · ⚠' : ' · ✓')
        : ' · ✗';
      const pending = a.pending ? ' · pending' : '';
      const tile = document.createElement('a');
      tile.className = 'recent-tile';
      tile.href = '#';
      tile.title = v.ok
        ? `${safeAssetId}${v.mismatches && v.mismatches.length ? ' · worker mismatch: ' + v.mismatches.join(', ') : ' · chain-verified'}`
        : `${safeAssetId} · unverifiable: ${v.error || 'unknown'}`;
      tile.onclick = (e) => {
        e.preventDefault();
        pendingDiscoverFocus = safeAssetId;
        $('.tab[data-tab="discover"]').click();
      };
      tile.innerHTML = `
        ${imgUrls[i] ? `<img src="${escapeHtml(imgUrls[i])}" alt="">` : ''}
        <div class="recent-tile-body">
          <div class="recent-tile-ticker">${escapeHtml(displayName)}${displayName !== ticker ? ` <span style="font-family:var(--mono);font-size:9px;font-style:normal;color:var(--orange);letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(ticker)}</span>` : ''}</div>
          <div class="recent-tile-meta">${ageStr}${verifyMark}${pending}</div>
        </div>`;
      grid.appendChild(tile);
    }
    list.innerHTML = '';
    list.appendChild(grid);
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
// `verifyDiscoverAsset(a)` walks back to the on-chain CETCH envelope, decodes
// it, runs validateOutpoint(etch_txid, 0, …) for the range proof, and returns
// the *canonical* (ticker, decimals, commitment, image_uri, mint_authority).
// Results are cached for the session.
const _discoverVerifyCache = new Map();   // asset_id → result
const _discoverFetchCache = new Map();    // txid → tx (shared across the walk)
async function verifyDiscoverAsset(a) {
  const aid = a.asset_id || '';
  if (_discoverVerifyCache.has(aid)) return _discoverVerifyCache.get(aid);
  const result = await _verifyDiscoverAssetInner(a)
    .catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
  _discoverVerifyCache.set(aid, result);
  return result;
}
async function _verifyDiscoverAssetInner(a) {
  if (!/^[0-9a-f]{64}$/.test(a.etch_txid || '')) return { ok: false, error: 'bad etch_txid' };
  if (!/^[0-9a-f]{64}$/.test(a.asset_id || ''))  return { ok: false, error: 'bad asset_id' };
  // asset_id consistency: must equal sha256(etch_txid_BE || vout=0_LE)
  const aidComputed = bytesToHex(assetIdFor(a.etch_txid, 0));
  if (aidComputed !== a.asset_id) return { ok: false, error: 'asset_id ≠ sha256(etch_txid_BE‖0_LE)' };
  // Shared fetcher across cards in the same session.
  const fetchTx = async id => {
    if (_discoverFetchCache.has(id)) return _discoverFetchCache.get(id);
    const t = await getTx(id);
    _discoverFetchCache.set(id, t);
    return t;
  };
  // Recursive validator covers: envelope decode + opcode==CETCH + vout==0 +
  // range proof verifies. validatedSet is per-asset to avoid sharing across
  // verifications (each asset's CETCH leaf is validated once, no shared state
  // between assets needed).
  const validatedSet = new Map();
  const valid = await validateOutpoint(a.etch_txid, 0, validatedSet, fetchTx);
  if (!valid) return { ok: false, error: 'on-chain CETCH failed validation' };
  // Pull canonical strings from the envelope itself.
  const etchTx = await fetchTx(a.etch_txid);
  let env;
  try { env = decodeEnvelopeScript(hexToBytes(etchTx.vin[0].witness[1])); } catch { return { ok: false, error: 'envelope decode failed' }; }
  if (!env || env.opcode !== T_CETCH) return { ok: false, error: 'parent is not CETCH' };
  const dec = decodeCEtchPayload(env.payload);
  if (!dec) return { ok: false, error: 'CETCH payload decode failed' };
  const canonical = {
    ok: true,
    ticker: dec.ticker,
    decimals: dec.decimals,
    commitment: bytesToHex(dec.commitment),
    imageUri: dec.imageUri,
    mintable: dec.mintable,
    mintAuthorityHex: bytesToHex(dec.mintAuthority),
  };
  // IPFS-attestation path. If the envelope's image_uri points at a metadata
  // blob containing tacit_attest, fetch + verify it here. Trust comes from
  // pedersenCommit(supply, blinding) == on_chain_commitment — no worker
  // involved in the verification, so a discovery worker that's down or
  // censoring can't hide the attestation.
  canonical.ipfsAttest = null;
  if (dec.imageUri) {
    const url = normalizeImageUri(dec.imageUri);
    if (url) {
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
                    && pedersenCommit(sup, r).equals(bytesToPoint(dec.commitment))) {
                  canonical.ipfsAttest = { supply: sup.toString(), blinding: att.blinding };
                }
              }
            }
          }
        }
      } catch {} finally { clearTimeout(timer); }
    }
  }
  // Note any disagreement between worker-supplied and on-chain canonical so
  // the UI can flag a worker-spoofing attempt.
  const mismatches = [];
  if (typeof a.ticker === 'string' && a.ticker !== canonical.ticker) mismatches.push(`ticker (worker=${a.ticker} vs chain=${canonical.ticker})`);
  if (Number.isFinite(a.decimals) && a.decimals !== canonical.decimals) mismatches.push(`decimals (${a.decimals} vs ${canonical.decimals})`);
  if (typeof a.commitment === 'string' && a.commitment.toLowerCase() !== canonical.commitment) mismatches.push('commitment');
  if ((a.image_uri || null) !== (canonical.imageUri || null)) mismatches.push('image_uri');
  canonical.mismatches = mismatches;
  // Validate each worker-claimed mint event by its txid. The worker can
  // otherwise fabricate mint entries to inflate displayed mint counts (the
  // Pedersen attestation re-verification only checks (amount, blinding)
  // opens the *commitment* the worker handed over — it doesn't check the
  // commitment is actually on chain). Each mint must be a T_MINT envelope
  // at vout=0 referencing this asset_id.
  const verifiedMints = {};   // mint_txid → { commitment_hex, encryptedAmount_hex }
  for (const m of (Array.isArray(a.mints) ? a.mints : [])) {
    const mtxid = m && m.mint_txid;
    if (!/^[0-9a-f]{64}$/.test(String(mtxid || ''))) continue;
    try {
      const ok = await validateOutpoint(mtxid, 0, new Map(), fetchTx);
      if (!ok) continue;
      const mtx = await fetchTx(mtxid);
      const menv = decodeEnvelopeScript(hexToBytes(mtx.vin[0].witness[1]));
      if (!menv || menv.opcode !== T_MINT) continue;
      const md = decodeCMintPayload(menv.payload);
      if (!md) continue;
      if (bytesToHex(md.assetId) !== a.asset_id) continue;
      verifiedMints[mtxid] = {
        commitment: bytesToHex(md.commitment),
        encryptedAmount: bytesToHex(md.encryptedAmount),
      };
    } catch {}
  }
  canonical.verifiedMints = verifiedMints;
  // Validate each worker-claimed burn event. The on-chain T_BURN envelope is
  // the authority for both existence and the public burned_amount.
  const verifiedBurns = {};   // burn_txid → on-chain burned_amount (BigInt)
  for (const b of (Array.isArray(a.burns) ? a.burns : [])) {
    const btxid = b && b.tx;
    if (!/^[0-9a-f]{64}$/.test(String(btxid || ''))) continue;
    try {
      const btx = await fetchTx(btxid);
      if (!btx?.vin?.[0]?.witness || btx.vin[0].witness.length < 3) continue;
      const benv = decodeEnvelopeScript(hexToBytes(btx.vin[0].witness[1]));
      if (!benv || benv.opcode !== T_BURN) continue;
      const bd = decodeCBurnPayload(benv.payload);
      if (!bd) continue;
      if (bytesToHex(bd.assetId) !== a.asset_id) continue;
      const onChainBurn = bd.burnedAmount;
      const workerBurn = (() => { try { return BigInt(b.burned_amount); } catch { return null; } })();
      if (workerBurn !== null && workerBurn !== onChainBurn) {
        canonical.mismatches.push(`burn ${shorten(btxid, 6)} amount`);
      }
      verifiedBurns[btxid] = onChainBurn;
    } catch {}
  }
  canonical.verifiedBurns = verifiedBurns;
  return canonical;
}

// Populate a Discover card after verification. `verify.ok` means the
// on-chain CETCH validated and the values shown are canonical; `!verify.ok`
// keeps worker-supplied strings but flags the card as unverifiable.
function renderDiscoverCard(card, a, verify, imgUrl, extras) {
  const safeAssetId = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
  const safeEtchTxid = /^[0-9a-f]{64}$/.test(a.etch_txid || '') ? a.etch_txid : '';
  // Canonical values come from the on-chain envelope when verification
  // succeeded; otherwise we render worker-supplied strings (regex-clamped
  // for hex fields) under the unverifiable banner.
  const ticker = verify.ok ? verify.ticker : (typeof a.ticker === 'string' ? a.ticker : '?');
  // Discover-side display name — read off the metadata blob (cached by
  // resolveImageUri); falls back to the ticker so older assets render unchanged.
  const _discoverExtras = a.image_uri ? getMetadataExtras(a.image_uri) : null;
  const displayName = (_discoverExtras?.name && _discoverExtras.name.trim()) ? _discoverExtras.name : ticker;
  // Filter key: lowercase concatenation of name + ticker + asset_id, used by
  // the Discover search input to substring-match against card content.
  card.dataset.filterKey = `${displayName} ${ticker} ${safeAssetId}`.toLowerCase();
  // Filter-pill attributes. Mintable comes from the canonical envelope so a
  // worker can't lie about it. Attested = the IPFS metadata blob carries a
  // tacit_attest that we've cryptographically verified opens the on-chain
  // commitment. Etched timestamp drives the "Recent" pill (24h window).
  card.dataset.mintable = (verify.ok && verify.mintable) ? '1' : '0';
  card.dataset.attested = (verify.ok && verify.ipfsAttest) ? '1' : '0';
  card.dataset.etchedAt = String(Number.isFinite(a.etched_at) ? a.etched_at : 0);
  const decimals = verify.ok ? verify.decimals
                  : (Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0);
  const safeHeight = Number.isInteger(a.etched_at_height) ? a.etched_at_height : null;
  const ageMin = Math.max(0, Math.floor((Date.now()/1000 - (a.etched_at || 0)) / 60));
  const ageStr = ageMin < 60 ? `${ageMin}m ago` : ageMin < 1440 ? `${Math.floor(ageMin/60)}h ago` : `${Math.floor(ageMin/1440)}d ago`;
  const avatar = imgUrl
    ? `<img src="${escapeHtml(imgUrl)}" alt="" style="width:36px;height:36px;border:1px solid var(--ink);object-fit:cover;background:#fff;flex-shrink:0;">`
    : '';

  // Verification badge: ✓ verified (chain match) / ⚠ mismatch (worker disagrees
  // with chain on some field) / ✗ unverifiable (validateOutpoint rejected or
  // the etch tx couldn't be fetched).
  let verifyBadge;
  if (!verify.ok) {
    verifyBadge = `<span style="font-size:10px;background:#fee;color:var(--red);padding:2px 6px;border:1px solid var(--red);text-transform:uppercase;letter-spacing:0.1em;">✗ unverifiable · ${escapeHtml(verify.error || 'unknown')}</span>`;
  } else if (verify.mismatches && verify.mismatches.length) {
    verifyBadge = `<span style="font-size:10px;background:#fff8eb;color:#a04030;padding:2px 6px;border:1px solid #a04030;text-transform:uppercase;letter-spacing:0.1em;" title="${escapeHtml(verify.mismatches.join('; '))}">⚠ worker mismatch</span>`;
  } else {
    verifyBadge = `<span style="font-size:10px;background:#eaf6ee;color:#0a7d4e;padding:2px 6px;border:1px solid #0a7d4e;text-transform:uppercase;letter-spacing:0.1em;">✓ chain-verified</span>`;
  }

  // Resolve etch supply attestation. Prefer the IPFS-embedded opening (which
  // verifyDiscoverAsset already verified against the on-chain commitment) —
  // it's worker-independent, so a discovery worker that's down or censoring
  // can't suppress the proof. Fall back to the worker's /assets cache if
  // that's the only thing available. Either path is cryptographically equal
  // (same Pedersen check); they differ only in distribution trust.
  let supplyBadge = '';
  let etchSupply = null;
  let attestSource = null;   // 'ipfs' | 'worker' | null
  const commitmentHex = verify.ok ? verify.commitment
                       : (typeof a.commitment === 'string' && /^[0-9a-f]{66}$/.test(a.commitment) ? a.commitment : '');
  // (a) IPFS-embedded attestation — pre-validated by verifyDiscoverAsset.
  if (verify.ok && verify.ipfsAttest) {
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
    const tag = attestSource === 'ipfs' ? '✓ verified opening (IPFS)' : '✓ verified opening (worker cache)';
    supplyBadge = `<div style="margin-top:6px;font-size:12px;color:#0a7d4e;"><strong>Etch supply: ${escapeHtml(fmtAssetAmount(etchSupply, decimals))}</strong> · ${tag}</div>`;
  }

  // Aggregate mint events. Only count entries whose mint_txid was verified
  // on-chain (verify.verifiedMints) AND whose attestation cryptographically
  // opens the on-chain commitment. Worker-only entries with no chain backing
  // are surfaced as "phantom" so they can't pad the count silently.
  const verifiedMintTxids = (verify.ok && verify.verifiedMints) ? verify.verifiedMints : {};
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
  if (chainMintCount > 0 || claimedMints.length > 0) {
    const phantom = claimedMints.length - chainMintCount;
    mintBadge = `<div style="margin-top:6px;font-size:11px;">` +
      `${chainMintCount} chain-verified mint${chainMintCount === 1 ? '' : 's'}` +
      (mintAttestedCount > 0 ? ` · ${mintAttestedCount} attested (+${escapeHtml(fmtAssetAmount(mintAttestedSum, decimals))})` : '') +
      (mintAttestedCount < chainMintCount ? ` · ${chainMintCount - mintAttestedCount} unattested` : '') +
      (phantom > 0 ? ` · <span style="color:var(--red);">${phantom} worker-only (rejected)</span>` : '') +
      `</div>`;
  }
  // Burns: trust only on-chain T_BURN envelopes for this asset_id. The on-chain
  // burned_amount is the authority; worker-claimed entries with no chain
  // backing are surfaced as phantom so the user sees the discrepancy.
  const verifiedBurnMap = (verify.ok && verify.verifiedBurns) ? verify.verifiedBurns : {};
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
  const burnBadge = (chainBurnCount > 0 || phantomBurns > 0)
    ? `<div style="margin-top:6px;font-size:11px;color:#a04030;">${chainBurnCount} chain-verified burn${chainBurnCount === 1 ? '' : 's'} · ${escapeHtml(fmtAssetAmount(burnedSum, decimals))} destroyed${phantomBurns > 0 ? ` · <span style="color:var(--red);">${phantomBurns} worker-only (rejected)</span>` : ''}</div>`
    : '';
  // Circulating supply = etched + Σ chain+attested mints − Σ chain burns.
  // Requires (a) chain-verified etch with attested supply, (b) every claimed
  // mint chain-verified AND attested, (c) zero phantom mints. Phantom-mint
  // workers can't sneak past — phantom counts disqualify the badge entirely.
  let totalSupplyBadge = '';
  if (verify.ok && mintAllAttested && etchSupply !== null
      && chainMintCount === claimedMints.length
      && mintAttestedCount === chainMintCount) {
    const totalIssued = etchSupply + mintAttestedSum;
    const circulating = totalIssued - burnedSum;
    totalSupplyBadge = `<div style="margin-top:6px;font-size:12px;color:#0a7d4e;"><strong>Circulating: ${escapeHtml(fmtAssetAmount(circulating, decimals))}</strong> · issued ${escapeHtml(fmtAssetAmount(totalIssued, decimals))}${burnedSum > 0n ? ` − burned ${escapeHtml(fmtAssetAmount(burnedSum, decimals))}` : ''}</div>`;
  }

  // Mismatch detail — only when verify.ok=true but at least one field differs.
  const mismatchDetail = (verify.ok && verify.mismatches && verify.mismatches.length)
    ? `<div style="margin-top:6px;font-size:11px;color:#a04030;">⚠ Worker disagreed with on-chain envelope on: ${escapeHtml(verify.mismatches.join(', '))}. Showing on-chain values.</div>`
    : '';

  card.innerHTML = `
    <div class="head" style="display:flex;align-items:center;gap:12px;">
      ${avatar}
      <div style="flex:1;min-width:0;">
        <div class="ticker" style="font-size:24px;">${escapeHtml(displayName)}${displayName !== ticker ? `<span class="ticker-sub">${escapeHtml(ticker)}</span>` : ''}<span class="id-tag">${escapeHtml(shorten(safeAssetId, 4))}</span></div>
        <div class="muted" style="font-size:11px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span>decimals ${decimals} · etched ${ageStr} · block ${safeHeight ?? '—'}</span>
          ${verifyBadge}
        </div>
      </div>
    </div>
    ${mismatchDetail}
    ${supplyBadge}
    ${mintBadge}
    ${burnBadge}
    ${totalSupplyBadge}
    ${extras?.description ? `<div class="muted" style="margin-top:8px;font-size:11px;font-style:italic;">${escapeHtml(extras.description)}</div>` : ''}
    ${(() => {
      const safe = safeExternalUrl(extras?.external_url);
      return safe ? `<div style="margin-top:6px;font-size:11px;"><a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(safe)} ↗</a></div>` : '';
    })()}
    <div class="meta">
      <div><span class="lbl">Asset ID</span> ${assetIdRowHTML(safeAssetId)}</div>
      <div><span class="lbl">Etch tx</span> ${safeEtchTxid ? `<a href="${NET.explorer}/tx/${escapeHtml(safeEtchTxid)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shorten(safeEtchTxid, 8))} ↗</a>` : '—'}</div>
    </div>`;
  // Wire the asset_id short/full toggle for this card.
  wireAssetIdToggles(card);
}

// ============== MARKET TAB ==============
// Aggregates open listings (both opening-based and range-disclosed) across all
// etched assets. Filters: ticker / asset_id, kind, price min/max. Sort: newest
// first or by price. Cache the fetched batch so filter changes don't re-hit
// the worker on every keystroke.
let _marketCache = null;

async function fetchMarketData() {
  if (!REGISTRY_URL) return { assets: [], listings: [] };
  const r = await fetch(withNet(REGISTRY_URL, 'mints=0'));
  const j = await r.json();
  const assets = j.assets || [];
  const haveAny = assets.filter(a =>
    Number(a.listing_count || 0) > 0
    || Number(a.range_listing_count || 0) > 0
    || Number(a.atomic_intent_count || 0) > 0,
  );
  const all = await Promise.all(haveAny.map(async a => {
    const [openings, ranges, intents] = await Promise.all([
      Number(a.listing_count || 0) > 0
        ? fetch(withNet(LISTINGS_URL(a.asset_id))).then(r => r.ok ? r.json() : { listings: [] }).catch(() => ({ listings: [] }))
        : Promise.resolve({ listings: [] }),
      Number(a.range_listing_count || 0) > 0
        ? fetch(withNet(RANGE_LISTINGS_URL(a.asset_id))).then(r => r.ok ? r.json() : { listings: [] }).catch(() => ({ listings: [] }))
        : Promise.resolve({ listings: [] }),
      Number(a.atomic_intent_count || 0) > 0
        ? fetch(withNet(ATOMIC_INTENTS_URL(a.asset_id))).then(r => r.ok ? r.json() : { intents: [] }).catch(() => ({ intents: [] }))
        : Promise.resolve({ intents: [] }),
    ]);
    const opens = (openings.listings || []).filter(l => !l.expired).map(l => ({ ...l, kind: 'opening', _asset: a }));
    const ranges_ = (ranges.listings || []).filter(l => !l.expired).map(l => ({ ...l, kind: 'range', _asset: a }));
    const intents_ = (intents.intents || []).filter(i => !i.expired).map(i => ({ ...i, kind: 'intent', _asset: a }));
    return [...opens, ...ranges_, ...intents_];
  }));
  return { assets, listings: all.flat() };
}

async function renderMarket() {
  const list = $('#market-list');
  const status = $('#market-status');
  list.innerHTML = '<div class="muted" style="padding:14px;text-align:center;font-style:italic;">loading…</div>';
  if (status) status.textContent = 'loading…';
  if (!REGISTRY_URL) {
    list.innerHTML = '<div class="muted" style="padding:14px;">marketplace disabled (no Worker)</div>';
    if (status) status.textContent = '';
    return;
  }
  try {
    _marketCache = await fetchMarketData();
    applyMarketFilters();
  } catch (e) {
    list.innerHTML = `<div class="error">Market load failed: ${escapeHtml(e.message)}</div>`;
    if (status) status.textContent = 'error';
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
  if (Number.isInteger(minPrice)) rows = rows.filter(l => (l.price_sats | 0) >= minPrice);
  if (Number.isInteger(maxPrice)) rows = rows.filter(l => (l.price_sats | 0) <= maxPrice);
  if (sort === 'price-asc')       rows.sort((a, b) => (a.price_sats | 0) - (b.price_sats | 0));
  else if (sort === 'price-desc') rows.sort((a, b) => (b.price_sats | 0) - (a.price_sats | 0));
  else                             rows.sort((a, b) => (b.listed_at || 0) - (a.listed_at || 0));
  if (status) status.textContent = `${rows.length} live · ${_marketCache.listings.length} total`;
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No listings match.</div>';
    return;
  }
  list.innerHTML = '<div id="market-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;"></div>';
  const grid = $('#market-grid');
  const myPubHex = bytesToHex(wallet.pub);
  for (const l of rows) {
    const a = l._asset || {};
    const safeAid = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
    const dec = Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 8 ? a.decimals : 0;
    const expIso = new Date((l.expiry || 0) * 1000).toISOString().slice(0, 10);
    const amount = l.kind === 'range' ? l.threshold : l.amount;
    const tile = document.createElement('div');
    tile.style.cssText = 'border:1px solid var(--ink);padding:12px;background:var(--bg-warm);';
    const kindBadge =
        l.kind === 'range'  ? `<span style="display:inline-block;padding:1px 6px;background:#0a8f43;color:#fff;font-size:9px;border-radius:2px;margin-left:6px;">≥</span>`
      : l.kind === 'intent' ? `<span style="display:inline-block;padding:1px 6px;background:#7d4ff7;color:#fff;font-size:9px;border-radius:2px;margin-left:6px;" title="atomic — settles in one Bitcoin tx, no counterparty trust">⚡</span>`
      : '';
    // Action buttons depend on listing kind + my role on this intent.
    let actions = '';
    if (l.kind === 'intent') {
      const isMaker = (l.maker_pubkey || '') === myPubHex;
      const claim = l.claim;
      const fulfilled = !!l.fulfilment_pending;
      if (isMaker) {
        if (claim && !fulfilled) {
          actions = `<button data-act="market-fulfil" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" style="flex:1;font-size:11px;">Fulfil claim from ${escapeHtml(shorten(claim.taker_pubkey, 6))}</button>` +
                    `<button data-act="market-cancel-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" style="font-size:11px;">Cancel</button>`;
        } else if (fulfilled) {
          actions = `<button disabled style="flex:1;font-size:11px;">awaiting taker broadcast…</button>` +
                    `<button data-act="market-cancel-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" style="font-size:11px;">Cancel</button>`;
        } else {
          actions = `<button disabled style="flex:1;font-size:11px;">your intent · awaiting claim</button>` +
                    `<button data-act="market-cancel-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" style="font-size:11px;">Cancel</button>`;
        }
      } else if (claim && claim.taker_pubkey === myPubHex) {
        // I claimed; check fulfilment status.
        actions = fulfilled
          ? `<button data-act="market-take-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" style="flex:1;font-size:11px;">Take (atomic broadcast)</button>`
          : `<button disabled style="flex:1;font-size:11px;">awaiting maker fulfilment…</button>`;
      } else if (claim) {
        actions = `<button disabled style="flex:1;font-size:11px;">claimed by ${escapeHtml(shorten(claim.taker_pubkey, 6))}</button>`;
      } else {
        actions = `<button data-act="market-claim-intent" data-aid="${escapeHtml(safeAid)}" data-iid="${escapeHtml(l.intent_id || '')}" data-price="${l.price_sats | 0}" data-ticker="${escapeHtml(a.ticker || '?')}" data-amount="${escapeHtml(amount || '0')}" data-dec="${dec}" style="flex:1;font-size:11px;">Claim</button>`;
      }
    } else {
      actions = `<button data-act="market-take" data-kind="${l.kind}" data-aid="${escapeHtml(safeAid)}" data-txid="${escapeHtml(l.txid || '')}" data-vout="${l.vout | 0}" data-maker="${escapeHtml(l.owner_pubkey || '')}" data-price="${l.price_sats | 0}" data-addr="${escapeHtml(l.maker_address || '')}" data-ticker="${escapeHtml(a.ticker || '?')}" data-amount="${escapeHtml(amount || '0')}" data-dec="${dec}" style="flex:1;font-size:11px;">Take</button>` +
                `<button data-act="market-verify" data-kind="${l.kind}" data-aid="${escapeHtml(safeAid)}" data-txid="${escapeHtml(l.txid || '')}" data-vout="${l.vout | 0}" data-maker="${escapeHtml(l.owner_pubkey || '')}" style="font-size:11px;">Verify</button>`;
    }
    tile.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div><strong>${escapeHtml(a.ticker || '?')}</strong>${kindBadge} <span class="muted" style="font-size:10px;">${escapeHtml(shorten(safeAid, 4))}</span></div>
        <div style="font-size:11px;" class="muted">expires ${expIso}</div>
      </div>
      <div style="margin-top:6px;font-size:18px;">${l.kind === 'range' ? '≥ ' : ''}${escapeHtml(fmtAssetAmount(BigInt(amount || '0'), dec))} <span style="font-size:11px;" class="muted">${escapeHtml(a.ticker || '')}</span></div>
      <div style="margin-top:4px;font-size:14px;color:#0a8f43;"><strong>${(l.price_sats | 0).toLocaleString()} sats</strong></div>
      <div style="margin-top:8px;font-size:10px;" class="muted">maker: <span class="mono-box inline">${escapeHtml(shorten(l.maker_address || '', 6))}</span></div>
      <div style="margin-top:10px;display:flex;gap:6px;">${actions}</div>`;
    grid.appendChild(tile);
  }
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
    `On confirm: locks the intent for 30 min so no one else can claim it. The maker then has 30 min to generate a partial reveal targeted at your pubkey. Once they fulfil, you click Take to finalize and broadcast — atomic, single Bitcoin tx, no trust.`,
  )) return;
  btn.disabled = true; btn.textContent = 'claiming…';
  try {
    await claimAxferIntent({ assetIdHex: aid, intentIdHex: iid });
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
    `Generates a partial reveal targeted at the taker's pubkey, signed SIGHASH_SINGLE_ACP. ` +
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
      `On confirm: appends your BTC funding, signs SIGHASH_ALL (locks the maker's payment), broadcasts. Atomic, single Bitcoin tx, no trust.`,
    )) { btn.disabled = false; btn.textContent = 'Take'; return; }
    btn.textContent = 'broadcasting…';
    const r = await takeAxferIntent({ intent, fulfilment: fres.fulfilment });
    toast(`Atomic take broadcast ✓ tx=${shorten(r.txid, 8)}`, 'success', 8000);
    btn.textContent = '✓ broadcast';
    setTimeout(() => renderMarket(), 2000);
    renderHoldings();
  } catch (e) {
    toast('Take failed: ' + e.message, 'error');
    btn.disabled = false; btn.textContent = 'Take';
  }
}

async function marketCancelIntentHandler(btn) {
  const aid = btn.dataset.aid;
  const iid = btn.dataset.iid;
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
    `3) Maker broadcasts a CXFER of ${ticker} to your pubkey within 30 min.\n` +
    `4) The new UTXO appears in Holdings (auto-discovered via ECDH).\n\n` +
    `On confirm: the listing is reserved for you for 30 min. Settlement is OTC — counterparty trust still required.`;
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
  toast('Reserved 30 min · pubkey copied · pay the maker, then send pubkey to them', 'success', 8000);
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

async function renderDiscover() {
  const list = $('#discover-list');
  const statusEl = $('#discover-status');
  if (!REGISTRY_URL) {
    list.innerHTML = `<div class="muted" style="padding:14px;">discovery disabled (no Worker)</div>`;
    if (statusEl) statusEl.textContent = '';
    return;
  }
  list.innerHTML = `<div class="skeleton"><div class="skeleton-row medium"></div><div class="skeleton-row short"></div><div class="skeleton-row"></div></div>`;
  if (statusEl) statusEl.textContent = 'loading…';
  try {
    const resp = await fetch(withNet(REGISTRY_URL));
    const j = await resp.json();
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
    if (statusEl) statusEl.textContent = j.assets?.length ? `${j.assets.length} asset${j.assets.length === 1 ? '' : 's'}` : '';
    if (!j.assets || !j.assets.length) {
      list.innerHTML = freshness + `<div class="empty">No assets etched on ${NET.name} yet. Be the first.</div>`;
      return;
    }
    list.innerHTML = freshness;
    // Pre-render placeholders with stable data-aid hooks so async fills can
    // target them. Worker-supplied strings appear under a "verifying…" badge
    // until validateOutpoint(etch_txid, 0, …) confirms the on-chain CETCH;
    // canonical values from the envelope replace them on completion. Mismatch
    // between worker-supplied and on-chain → ⚠ banner so the user sees it.
    for (const a of j.assets) {
      const card = document.createElement('div');
      card.className = 'asset-card';
      card.dataset.aid = /^[0-9a-f]{64}$/.test(a.asset_id || '') ? a.asset_id : '';
      card.innerHTML = `<div class="muted" style="padding:14px;font-size:12px;">⏳ verifying ${escapeHtml(a.ticker || a.asset_id || '?')}…</div>`;
      list.appendChild(card);
    }
    // Concurrent verify with a small worker pool. Limits the number of
    // simultaneous mempool.space fetches per Discover render so a 50-asset
    // registry doesn't hit rate limits.
    const queue = j.assets.slice();
    const POOL = 5;
    await Promise.all(Array.from({ length: POOL }, async () => {
      while (queue.length) {
        const a = queue.shift();
        if (!a) continue;
        const verify = await verifyDiscoverAsset(a).catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
        // Resolve image AFTER verification so we use the canonical image_uri
        // (worker could otherwise inject a different IPFS CID for tracking).
        const effectiveImageUri = verify.ok ? verify.imageUri : a.image_uri;
        const imgUrl = effectiveImageUri ? await resolveImageUri(effectiveImageUri) : null;
        const extras = effectiveImageUri ? getMetadataExtras(effectiveImageUri) : null;
        const aidSel = (a.asset_id || '').replace(/[^0-9a-f]/gi, '');
        const card = aidSel ? list.querySelector(`[data-aid="${aidSel}"]`) : null;
        if (card) {
          renderDiscoverCard(card, a, verify, imgUrl, extras);
          // Re-apply filter so a card whose pill predicate fails (e.g. not
          // mintable while the Mintable pill is active) hides immediately
          // rather than flashing in then disappearing on the final pass.
          applyDiscoverFilter();
        }
      }
    }));
    // (asset_id short/full toggles are wired per-card inside renderDiscoverCard.)
    // Open listings panel: fetch listings for every asset that reports
    // listing_count > 0, flatten into a single grid, sorted by recency.
    const assetsWithListings = j.assets.filter(a => Number(a.listing_count || 0) > 0);
    if (assetsWithListings.length > 0) {
      const allLists = await Promise.all(assetsWithListings.map(a =>
        fetch(withNet(LISTINGS_URL(a.asset_id)))
          .then(r => r.ok ? r.json() : { listings: [] })
          .then(j2 => Array.isArray(j2.listings) ? j2.listings.map(l => ({ ...l, _asset: a })) : [])
          .catch(() => [])
      ));
      const flat = allLists.flat().filter(l => !l.expired);
      flat.sort((a, b) => (b.listed_at || 0) - (a.listed_at || 0));
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
          const tile = document.createElement('div');
          tile.style.cssText = 'border:1px solid var(--ink);padding:12px;background:var(--bg-warm);';
          tile.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:baseline;">
              <div><strong>${escapeHtml(a.ticker || '?')}</strong> <span class="muted" style="font-size:10px;">${escapeHtml(shorten(safeAid, 4))}</span></div>
              <div style="font-size:11px;" class="muted">expires ${expIso}</div>
            </div>
            <div style="margin-top:6px;font-size:18px;">${escapeHtml(fmtAssetAmount(BigInt(l.amount || '0'), dec))} <span style="font-size:11px;" class="muted">${escapeHtml(a.ticker || '')}</span></div>
            <div style="margin-top:4px;font-size:14px;color:#0a8f43;"><strong>${(l.price_sats || 0).toLocaleString()} sats</strong></div>
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
            // Confirm BEFORE claiming. If the user cancels, no 30-min stale
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
              `3) Maker broadcasts a CXFER of ${ticker} to your pubkey within 30 min.\n` +
              `4) The new UTXO appears in Holdings (auto-discovered via ECDH).\n\n` +
              `On confirm: the listing is reserved for you for 30 min so no one else can pay the maker for the same UTXO. ` +
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
            toast('Reserved 30 min · pubkey copied · pay the maker, then send pubkey to them', 'success', 8000);
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
    }
  } catch (e) {
    list.innerHTML = `<div class="error">Discovery failed: ${escapeHtml(e.message)}</div>`;
    if (statusEl) statusEl.textContent = 'error';
    console.error(e);
  }
  // Re-apply the Discover filter (if any) after a refresh so the user's
  // current query stays active across re-renders.
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
  await wallet.load(addr);
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
          `Verified: amount opens the on-chain commitment · maker_address derives from maker_pubkey · output scripts pay the right parties · rangeproof valid.\n\n` +
          `On confirm: appends your BTC funding, signs SIGHASH_ALL (locks the maker's payment in vout[1]), and broadcasts.`,
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
// applyDiscoverFilter. 'all' = no predicate; mintable/attested/recent each
// add one. Held in module scope so a re-render (which rebuilds cards) keeps
// the user's selection.
let _discoverPill = 'all';
function _matchesPill(card) {
  switch (_discoverPill) {
    case 'mintable': return card.dataset.mintable === '1';
    case 'attested': return card.dataset.attested === '1';
    case 'recent': {
      const t = Number(card.dataset.etchedAt) || 0;
      if (!t) return false;
      return t * 1000 >= Date.now() - 24 * 3600 * 1000;
    }
    default: return true;
  }
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

function setupDiscoverButtons() {
  const refreshBtn = $('#btn-discover-refresh');
  if (!REGISTRY_URL) { refreshBtn.disabled = true; refreshBtn.title = 'discovery disabled (no Worker)'; }
  refreshBtn.onclick = renderDiscover;
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
      applyDiscoverFilter();
    });
  }
}

function setupMarketButtons() {
  const refreshBtn = $('#btn-market-refresh');
  if (refreshBtn) {
    if (!REGISTRY_URL) { refreshBtn.disabled = true; refreshBtn.title = 'market disabled (no Worker)'; }
    refreshBtn.onclick = renderMarket;
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
    if (el) el.addEventListener('change', applyMarketFilters);
  });
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
    if (extHint) extHint.style.display = wallet.ext ? 'none' : 'block';
    if (backHint) backHint.style.display = isBurnerBackedUp() ? 'none' : 'block';
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

// Welcome modal: shown on genuine first load to give the user a real choice
// between connecting an existing bitcoin wallet (ext) and generating a fresh
// local burner. Resolves to 'ext-xverse' | 'ext-unisat' | 'local'. Caller
// dispatches to the appropriate flow; on failure the modal can be re-shown.
function _showWelcomeModal() {
  return new Promise((resolve) => {
    const modal = document.getElementById('welcome-modal');
    const xBtn = document.getElementById('welcome-xverse');
    const uBtn = document.getElementById('welcome-unisat');
    const lBtn = document.getElementById('welcome-local');
    if (!modal || !xBtn || !uBtn || !lBtn) { resolve('local'); return; }
    const av = extWallet.available();
    xBtn.disabled = !av.satsConnect;
    xBtn.title = av.satsConnect ? '' : 'Xverse / Leather extension not detected';
    uBtn.disabled = !av.unisat;
    uBtn.title = av.unisat ? '' : 'UniSat extension not detected';
    const close = (choice) => {
      xBtn.onclick = uBtn.onclick = lBtn.onclick = null;
      modal.style.display = 'none';
      resolve(choice);
    };
    xBtn.onclick = () => close('ext-xverse');
    uBtn.onclick = () => close('ext-unisat');
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
        wallet.ext = st;
        if (verdict === 'unsupported') await wallet.load();
        else                           await wallet.load(st.address);
      } else {
        await wallet.load();
      }
      return;
    } catch (e) {
      // Roll back any partial state so the next iteration starts clean. If the
      // ext connect succeeded but the passphrase prompt was cancelled, the
      // EXT_MODE_KEY is set with no burner — disconnect to avoid a confusing
      // half-bound state on reload.
      extWallet.disconnect();
      wallet.ext = null;
      if (e && e.message === 'cancelled') {
        toast('Setup cancelled — pick an option to continue.', '', 4000);
      } else {
        toast('Setup failed: ' + (e?.message || e), 'error', 5000);
      }
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
  // Try silent reconnect of the previous external wallet first. If it succeeds,
  // load the tacit identity bound to that wallet's address; otherwise fall
  // through to the network-scoped local wallet (tacit-wallet-v1:<network>).
  const restored = await extWallet.tryRestore().catch(() => null);
  if (restored) {
    wallet.ext = restored;
    // 'reload' = a reload is queued, bail; 'unsupported' = reconcile already
    // disconnected the wallet, fall through to burner mode.
    const verdict = reconcileWalletNetwork(restored);
    if (verdict === 'reload') return;
    if (verdict === 'unsupported') await wallet.load();
    else                           await wallet.load(restored.address);
  } else if (_hasAnyExistingWallet()) {
    // Returning user — encrypted blob exists somewhere under tacit-wallet-v1:*
    // so go straight to the unlock prompt rather than the welcome modal.
    await wallet.load();
  } else {
    // Genuine first load on this device. Surface the welcome modal so the user
    // explicitly picks between connecting an existing wallet and generating a
    // fresh local burner before any passphrase prompt fires.
    if (await _runFirstLoadChoice() === 'reload') return;
  }
  setupNetworkSelect();
  setupTabs();
  setupWalletButtons();
  setupExtWalletButtons();
  setupUnisatEvents();
  setupEtchForm();
  setupTransferForm();
  setupHoldingsButtons();
  setupDiscoverButtons();
  setupMarketButtons();
  setupHero();
  // Start the second-Esplora chain-divergence watchdog. Fires once
  // immediately + every CHAIN_DIVERGE_INTERVAL_MS thereafter. Surfaces a
  // banner if the primary and secondary endpoints disagree on tip height.
  startChainDivergenceWatchdog();
  await refreshWallet();
  renderExtWalletPanel();
  renderRecentEtches();
  // Surface any one-time net-flip explainer queued by the network selector.
  // Runs after refreshWallet so the toast text references the current
  // network's address that's already visible in the wallet card.
  consumePendingNetFlipToast();
  await autoImportShareLink();
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
  if (closeBtn) closeBtn.onclick = () => { markOnboarded(); };
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

// Named exports: tacit.html loads this file via <script type="module"> with
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
  // Wire format encoders / decoders
  encodeEnvelopeScript, decodeEnvelopeScript,
  encodeCEtchPayload, decodeCEtchPayload,
  encodeCXferPayload, decodeCXferPayload,
  encodeCMintPayload, decodeCMintPayload,
  encodeCBurnPayload, decodeCBurnPayload,
  // Protocol message hashes
  computeKernelMsg, computeMintMsg,
  openingMsg, disclosureMsg,
  listingMsgBytes, cancelMsgBytes, claimMsgBytes,
  _axintentMsg as axintentMsg,
  _axintentClaimMsg as axintentClaimMsg,
  _axintentFulfilMsg as axintentFulfilmentMsg,
  _axintentCancelMsg as axintentCancelMsg,
  deriveAxintentBlindingKeystream, xor32,
  // Encrypted-at-rest privkey storage
  encryptPrivkey, decryptPrivkey,
};
