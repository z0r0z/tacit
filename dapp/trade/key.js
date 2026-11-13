// The Tacit key for the tETH page: opened from an Ethereum wallet's signature or a passkey, held in memory and kept for this tab (tab-key.js). What
// is stored is the public record of how it was opened, which every page that opens a Tacit key reads (tacit-wallet-known.js), so a visitor is
// offered the wallet they already use. This is /trade's own session (btc-session.js) without tacit.js, which a private deposit has no use for
// and which is four megabytes: the ways in that need it (a Bitcoin wallet, a saved key) are left to tacit.finance.
import { secp, sha256, keccak_256, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';
import { prfBytesToScalar, prfLogin, prfRegister, loadPrfMap, savePrfMap, isPasskeyAvailable } from '/prf-wallet.js';
import { knownWallets } from '/tacit-wallet-known.js?cb=ec5b5193';
import { makeEvmWallet } from '/evm-wallet.js?cb=ce3b412c';
import { signInSheet, pickWalletSheet, Cancelled } from '/trade/sign-in.js?cb=921b5084';
import { tabKeyRead, tabKeyWrite, tabKeyClear, tabKeyWatch } from '/tab-key.js?cb=ec8829ac';

const RECORD = 'tacit-trade-id-v1';                                           // how /trade last opened a key: public data only (the Bitcoin market writes it too)
const KNOWN_IDS = [RECORD, 'tacit-tac-id-v1', 'tacit-pay-hub-id-v1', 'tacit-lite-id-v1', 'tacit-pay-id-v1'];
const DERIVED = new Set(['eth', 'passkey']);                                  // ways in where the wallet or passkey is itself the backup of the key

const lc = (s) => String(s || '').toLowerCase();
const writeJson = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage is a convenience */ } };

// `moved(text)`: the wallet that opened the key has moved to another account or locked, and `text` says so. The page locks the key in full (what it
// holds besides the session goes with it) and says it; a page that gives no `moved` has the session lock.
// `ways` adds the ways in that need tacit.js, from a page that loads it: `btc(record)` opens a Bitcoin wallet (btc-session.js openBtcWallet) and
// resolves to { mode: 'btc', priv, pubHex, address, btc }; `btcSeen()` says whether this browser has one, for the sign-in sheet.
export function makeKeySession({ moved = null, ways = {} } = {}) {
  const evm = makeEvmWallet({ secp, sha256, keccak256: keccak_256, bytesToHex, hexToBytes, prfBytesToScalar, netName: 'mainnet' });
  let priv = null, key = null;
  const listeners = new Set(), emit = () => listeners.forEach((f) => { try { f(); } catch { /* a listener must not break the session */ } });
  const pubOf = (hex) => bytesToHex(secp.getPublicKey(hexToBytes(hex), true));

  function set(k) {
    const pubHex = lc(String(k.pubHex || pubOf(k.priv)).replace(/^0x/, ''));
    if (pubOf(k.priv) !== pubHex) throw new Error('That wallet opened a different key than expected. Nothing was changed.');
    const { priv: p, ...rest } = k;
    priv = p; key = { ...rest, pubHex };
    writeJson(RECORD, key);
    tabKeyWrite({ ...k, pubHex });
    emit();
  }
  const open = {
    // `pick(list)` names which of several announced wallets signs: the page passes the one already connected.
    async eth(k, pick) {
      const id = await evm.deriveIdentity({ pick, expect: k?.address });
      set({ mode: 'eth', priv: id.priv, pubHex: k?.pubHex || id.pubHex, address: '0x' + lc(id.address).replace(/^0x/, '') });
    },
    async passkey(k) {
      if (!isPasskeyAvailable()) throw new Error('Passkeys need a browser that supports them.');
      const r = await prfLogin({ credentialId: k?.credentialId });
      const pubHex = bytesToHex(r.pub), m = loadPrfMap();
      const label = k?.label || Object.keys(m).find((l) => m[l]?.credentialId === r.credentialId) || `passkey-${pubHex.slice(0, 6)}`;
      m[label] = { credentialId: r.credentialId, pubkey: pubHex, createdAt: m[label]?.createdAt || Date.now(), lastUsed: m[label]?.lastUsed ?? Date.now() };
      savePrfMap(m);
      const p = bytesToHex(r.priv); r.priv.fill(0);
      set({ mode: 'passkey', priv: p, pubHex, label, credentialId: r.credentialId });
    },
    // A key pasted in: 64 hex characters, held like any other.
    async key(hex) {
      const h = lc(String(hex || '').trim()).replace(/^0x/, '');
      if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('A Tacit key is 64 hex characters.');
      if (!BigInt('0x' + h) || BigInt('0x' + h) >= secp.CURVE.n) throw new Error('That is not a valid Tacit key.');
      set({ mode: 'key', priv: h });
    },
    async newPasskey() {
      if (!isPasskeyAvailable()) throw new Error('Passkeys need a browser that supports them.');
      const m = loadPrfMap();
      let label = 'Tacit', n = 1;
      while (m[label]) label = `Tacit ${++n}`;
      const r = await prfRegister(label);
      m[label] = { credentialId: r.credentialId, pubkey: r.pubHex, createdAt: Date.now(), lastUsed: Date.now() };
      savePrfMap(m);
      const p = bytesToHex(r.priv); r.priv.fill(0);
      set({ mode: 'passkey', priv: p, pubHex: r.pubHex, label, credentialId: r.credentialId });
    },
  };
  if (ways.btc) open.btc = async (k) => set(await ways.btc(k));
  const opens = new Set([...DERIVED, ...(ways.btc ? ['btc'] : [])]);
  const ids = () => knownWallets(KNOWN_IDS);
  const usable = (w) => (w && opens.has(w.mode) ? w : null);
  // The wallet that opened a key is the proof of it: when that wallet moves to another account, or locks, the key is locked too, as on every other
  // page of the site.
  addEventListener('tacit:evm-accounts', (e) => {
    if (key?.mode !== 'eth') return;
    const a = lc((e.detail?.accounts || [])[0]);
    if (a && a === lc(key.address)) return;
    const why = `Your wallet ${a ? 'switched accounts' : 'locked'}, so the Tacit key opened with it was locked. Open it again to continue.`;
    tabKeyClear();
    if (moved) moved(why); else { priv = null; key = null; emit(); }
  });
  // The key this tab opened on another page of the site (tab-key.js), opened again with no sign-in: one that needs no wallet at once, an
  // Ethereum wallet's once that wallet answers, without a prompt, as the account that opened it (any other answer, or none, locks it).
  tabKeyWatch();
  const kept = tabKeyRead();
  if (kept && kept.mode !== 'eth') { try { set(kept); } catch { tabKeyClear(); } }
  else if (kept?.mode === 'eth') {
    evm.restore().then((c) => {
      if (key) return;
      if (c && '0x' + lc(c.address) === lc(kept.address)) { try { set(kept); } catch { tabKeyClear(); } } else tabKeyClear();
    }, () => tabKeyClear());
  }
  return {
    open,
    get unlocked() { return !!(key && priv); }, get key() { return key; },
    // A fresh copy each time, as the front page's walletPriv: whatever takes it may wipe it.
    priv() { if (!priv) throw Object.assign(new Error('Your Tacit key was locked, so this stopped. Open it again to continue.'), { said: true }); return hexToBytes(priv); },
    known: () => usable(ids().primary), other: () => usable(ids().other),
    // The wallet tacit.finance has open, when this page cannot open it (a Bitcoin wallet, a key saved in the browser).
    elsewhere: () => { const p = ids().primary; return p && !opens.has(p.mode) ? p : null; },
    passkeyAvailable: () => isPasskeyAvailable(), ethAvailable: () => evm.available(), warm: () => evm.warm(), btcSeen: ways.btcSeen,
    // the Ethereum wallet the key was opened with (null for a passkey, a pasted key or a Bitcoin wallet): a page's last-resort node for reads
    walletProvider: () => (key && key.mode === 'eth' ? evm.provider() : null),
    lock() { priv = null; key = null; tabKeyClear(); emit(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// The sheets that open the key, from sign-in.js: the same on every page, and the front page's.
export { signInSheet, pickWalletSheet, Cancelled };
