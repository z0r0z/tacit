// The Tacit wallet a returning visitor already has, read one way on every page that opens a key next to tacit.finance
// (weld, pay, pay/eth). tacit.finance's own choice comes first, the wallet it restores on load, so every page offers the
// key the user is logged in with there. A key a page opened by itself is a fallback, and is offered second when it is a
// different key. Public data only: pubkeys, labels and addresses, never a private key.
import { loadPrfMap } from './prf-wallet.js';

const lc = (s) => String(s || '').toLowerCase();
const isPub = (h) => /^0[23][0-9a-f]{64}$/.test(lc(h));
function readJson(k) {
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
}
// A record of a key tacit.finance saved counts only while that key is still the one saved.
const savedPub = (addr) => lc(readJson(addr ? `tacit-wallet-v1:mainnet:by:${lc(addr)}` : 'tacit-wallet-v1:mainnet')?.pub);

// The wallet tacit.finance opens, in the order its init() restores one: the linked Ethereum or Bitcoin wallet when that
// is the active mode, then the last passkey (unless an extension or the saved key was chosen), then the key an extension
// funds, then the key saved in this browser.
export function siteWallet() {
  try {
    // tacit.finance keeps its mode per network (`tacit-active-mode-v1:<net>`, '' once cleared there); the un-suffixed
    // record is the one kept before that, read until tacit.finance has moved it.
    const mode = localStorage.getItem('tacit-active-mode-v1:mainnet') ?? localStorage.getItem('tacit-active-mode-v1');
    // tacit.finance keeps the Ethereum wallet's address as 40 hex characters, without 0x.
    if (mode === 'eth') { const r = readJson('tacit-eth-identity:mainnet'); if (r?.address && isPub(r.pubkey)) return { mode, pubHex: lc(r.pubkey), address: '0x' + lc(r.address).replace(/^0x/, '') }; }
    if (mode === 'btc') { const r = readJson('tacit-btc-identity:mainnet'); if (r?.address && isPub(r.tacitPubkey)) return { mode, pubHex: lc(r.tacitPubkey), address: r.address, btc: r }; }
    if (mode !== 'ext' && mode !== 'local') {
      const m = loadPrfMap(), l = Object.keys(m).sort((a, b) => (m[b]?.lastUsed || 0) - (m[a]?.lastUsed || 0))[0];
      if (l && isPub(m[l]?.pubkey)) return { mode: 'passkey', pubHex: lc(m[l].pubkey), label: l, credentialId: m[l].credentialId };
    }
    if (!mode || mode === 'ext') {
      const ext = readJson('tacit-ext-state-v1'), blob = ext?.address && readJson(`tacit-wallet-v1:mainnet:by:${lc(ext.address)}`);
      if (blob && isPub(blob.pub)) return { mode: 'ext', pubHex: lc(blob.pub), address: ext.address, ext };
    }
    if (!mode || mode === 'local') { const b = readJson('tacit-wallet-v1:mainnet'); if (b && isPub(b.pub)) return { mode: 'local', pubHex: lc(b.pub) }; }
  } catch {}
  return null;
}

// The first still-valid record of how one of these pages last opened a key (`ids` are their storage keys, this page's
// first). A pasted key is never remembered.
export function rememberedWallet(ids) {
  try {
    for (const k of ids || []) {
      const o = readJson(k);
      if (o && isPub(o.pubHex) && o.mode !== 'key' && (o.mode === 'local' ? savedPub() === lc(o.pubHex) : o.mode === 'ext' ? savedPub(o.address) === lc(o.pubHex) : true)) return o;
    }
  } catch {}
  return null;
}

// { primary, other }: `primary` is what "Continue" opens; `other` is a different key one of these pages opened before.
// A page's own record of tacit.finance's key carries more (the tacit1 address it showed), so it stands in for it.
export function knownWallets(ids) {
  const site = siteWallet(), own = rememberedWallet(ids);
  if (!site) return { primary: own, other: null };
  if (own && lc(own.pubHex) === site.pubHex) return { primary: own, other: null };
  return { primary: site, other: own };
}
