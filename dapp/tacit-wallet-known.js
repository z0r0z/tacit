import { loadPrfMap } from './prf-wallet.js';

const lc = (s) => String(s || '').toLowerCase();
const isPub = (h) => /^0[23][0-9a-f]{64}$/.test(lc(h));
function readJson(k) {
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
}
const savedPub = (addr) => lc(readJson(addr ? `tacit-wallet-v1:mainnet:by:${lc(addr)}` : 'tacit-wallet-v1:mainnet')?.pub);

export function siteWallet() {
  try {
    const mode = localStorage.getItem('tacit-active-mode-v1:mainnet') ?? localStorage.getItem('tacit-active-mode-v1');
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

export function rememberedWallet(ids) {
  try {
    for (const k of ids || []) {
      const o = readJson(k);
      if (o && isPub(o.pubHex) && o.mode !== 'key' && (o.mode === 'local' ? savedPub() === lc(o.pubHex) : o.mode === 'ext' ? savedPub(o.address) === lc(o.pubHex) : true)) return o;
    }
  } catch {}
  return null;
}

export function knownWallets(ids) {
  const site = siteWallet(), own = rememberedWallet(ids);
  if (!site) return { primary: own, other: null };
  if (own && lc(own.pubHex) === site.pubHex) return { primary: own, other: null };
  return { primary: site, other: own };
}
