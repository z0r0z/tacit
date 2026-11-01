// Bitcoin for the trade page: tacit.js loaded for this visit, and the key a visitor opens to sign with. The key lives in tacit.js's wallet
// object until it is locked and is never stored. What is stored is the public record of how it was opened, which every page that opens a
// Tacit key reads (tacit-wallet-known.js), so a visitor is offered the wallet they already use.
//
// These are the ways in /tac has (dapp/tac/app.js) that need nothing but the wallet or the passkey itself. A key pasted in, one saved in
// the browser and one an extension funds each ask for a passphrase in tacit.js's own dialogs, which belong to the classic app.

const TACIT_URL = '/tacit.js?cb=0bd37721', KNOWN_URL = '/tacit-wallet-known.js?cb=ed4c75b7', EVM_URL = '/evm-wallet.js?cb=f3072d82';
const DEPS_URL = '/vendor/tacit-deps.min.js', PRF_URL = '/prf-wallet.js';
const RECORD = 'tacit-trade-id-v1';                                           // how this page last opened a key: public data only
const KNOWN_IDS = [RECORD, 'tacit-tac-id-v1', 'tacit-pay-hub-id-v1', 'tacit-lite-id-v1', 'tacit-pay-id-v1'];
const SHARED_NET = 'tacit-network-v1', PREV_NET = 'tacit-trade-prev-net-v1';
// tacit.finance's records of which wallet it has open. A turn may rewrite them, so each turn puts them back.
const SHARED_WALLET_KEYS = ['tacit-eth-identity', 'tacit-btc-identity', 'tacit-active-mode-v1', 'tacit-ext-mode-v1', 'tacit-ext-state-v1',
  ...['mainnet', 'signet'].flatMap((n) => [`tacit-eth-identity:${n}`, `tacit-btc-identity:${n}`, `tacit-active-mode-v1:${n}`])];
const DERIVED = new Set(['eth', 'btc', 'passkey']);                          // ways in where the wallet or passkey is itself the backup of the key

const lc = (s) => String(s || '').toLowerCase();
const writeJson = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage is a convenience */ } };
export const short = (a, n = 4) => (!a ? '' : a.length > 2 * n + 4 ? `${a.slice(0, n + 2)}…${a.slice(-n)}` : a);
export class Cancelled extends Error { constructor(m = 'Cancelled.') { super(m); this.unlockCancelled = true; } }

// tacit.js reads the shared network once, at import. This page pins mainnet for its visit and puts the previous value back when it goes away,
// so the main app keeps the network its user chose.
function pinNetwork() {
  try {
    const cur = localStorage.getItem(SHARED_NET);
    if (sessionStorage.getItem(PREV_NET) === null && cur !== 'mainnet') sessionStorage.setItem(PREV_NET, cur ?? '');
    localStorage.setItem(SHARED_NET, 'mainnet');
  } catch { /* storage is a convenience */ }
}
let restoring = false;
function restoreNetwork() {
  if (restoring) return; restoring = true;
  addEventListener('pagehide', () => {
    try {
      const p = sessionStorage.getItem(PREV_NET);
      if (p !== null) { p === '' ? localStorage.removeItem(SHARED_NET) : localStorage.setItem(SHARED_NET, p); sessionStorage.removeItem(PREV_NET); }
    } catch { /* storage is a convenience */ }
  });
}

// `moved(text)`: the wallet that opened the key has moved to another account or locked, and `text` says so. The page locks the key in full and says it;
// a page that gives no `moved` has the session lock.
export function makeBtcSession({ moved = null } = {}) {
  let T = null, D = null, prf = null, K = null, evm = null, loading = null, key = null, walletQ = Promise.resolve();
  const listeners = new Set(), emit = () => listeners.forEach((f) => { try { f(); } catch { /* a listener must not break the session */ } });

  const load = () => (loading ||= (async () => {
    pinNetwork(); restoreNetwork();
    globalThis.__TACIT_NO_INIT__ = true;
    const [t, d, p, k, e] = await Promise.all([import(TACIT_URL), import(DEPS_URL), import(PRF_URL), import(KNOWN_URL), import(EVM_URL)]);
    T = t; D = d; prf = p; K = k;
    evm = e.makeEvmWallet({ secp: d.secp, sha256: d.sha256, keccak256: d.keccak_256, bytesToHex: d.bytesToHex, hexToBytes: d.hexToBytes, prfBytesToScalar: p.prfBytesToScalar, netName: 'mainnet' });
    return T;
  })().catch((e) => { loading = null; throw e; }));

  // A turn may rewrite tacit.finance's records of which wallet it has open. Each turn puts them back, except a record another tab writes while
  // the turn runs: that one is theirs, and is left as they wrote it.
  async function keepShared(fn) {
    let snap = [];
    try { snap = SHARED_WALLET_KEYS.map((k) => [k, localStorage.getItem(k)]); } catch { /* storage is a convenience */ }
    const theirs = new Set(), seen = (e) => { if (e.storageArea === localStorage) theirs.add(e.key); };
    addEventListener('storage', seen);
    try { return await fn(); } finally {
      removeEventListener('storage', seen);
      for (const [k, v] of snap) { if (theirs.has(k) || theirs.has(null)) continue; try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage is a convenience */ } }
    }
  }
  // tacit.js keeps one global wallet, so each use runs in its own turn: a key never changes mid-operation.
  const turn = (fn) => { const r = walletQ.then(async () => { await load(); return keepShared(fn); }); walletQ = r.catch(() => {}); return r; };

  const pubOf = (privHex) => D.bytesToHex(D.secp.getPublicKey(D.hexToBytes(privHex), true));
  const tPriv = () => { const h = D.bytesToHex(T.wallet.priv); T.wallet.priv.fill(0); T.wallet.priv = null; return h; };
  const mainnetBtc = (a) => { if (!/^(bc1|[13])/i.test(String(a || ''))) throw new Error('Your Bitcoin wallet is on a test network. Switch it to mainnet.'); };

  // Every way in ends here: the key goes into tacit.js for this visit, and only the key the wallet said it would open.
  async function setKey(k) {
    const pubHex = lc(String(k.pubHex || pubOf(k.priv)).replace(/^0x/, ''));
    if (pubOf(k.priv) !== pubHex) throw new Error('That wallet opened a different key than expected. Nothing was changed.');
    const { priv, ...rest } = k;
    forget();
    await turn(() => {
      T.wallet.priv = D.hexToBytes(priv); T.wallet.pub = D.hexToBytes(pubHex);
      T.wallet.mode = DERIVED.has(k.mode) ? k.mode : null;                  // a derived key is its own backup: tacit.js asks for no export before a listing
      try { T.invalidateHoldingsCache?.(); } catch { /* the cache is rebuilt on the next read */ }
    });
    key = { ...rest, pubHex };
    writeJson(RECORD, key);
    emit();
  }
  function forget() {
    key = null;
    if (T) { T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null; try { T.invalidateHoldingsCache?.(); } catch { /* the cache is rebuilt on the next read */ } }
  }

  // The ways in, each ending in setKey. `pick(list)` chooses among several Ethereum wallets (the page's own picker).
  const open = {
    async eth(k, pick) {
      await load();
      const id = await evm.deriveIdentity({ pick, expect: k?.address });
      await setKey({ mode: 'eth', priv: id.priv, pubHex: k?.pubHex || id.pubHex, address: '0x' + lc(id.address).replace(/^0x/, '') });
    },
    async passkey(k) {
      await load();
      if (!prf.isPasskeyAvailable()) throw new Error('Passkeys need a browser that supports them.');
      const r = await prf.prfLogin({ credentialId: k?.credentialId });
      const pubHex = D.bytesToHex(r.pub), m = prf.loadPrfMap();
      const label = k?.label || Object.keys(m).find((l) => m[l]?.credentialId === r.credentialId) || `passkey-${pubHex.slice(0, 6)}`;
      m[label] = { credentialId: r.credentialId, pubkey: pubHex, createdAt: m[label]?.createdAt || Date.now(), lastUsed: m[label]?.lastUsed ?? Date.now() };
      prf.savePrfMap(m);
      const priv = D.bytesToHex(r.priv); r.priv.fill(0);
      await setKey({ mode: 'passkey', priv, pubHex, label, credentialId: r.credentialId });
    },
    async newPasskey() {
      await load();
      if (!prf.isPasskeyAvailable()) throw new Error('Passkeys need a browser that supports them.');
      const m = prf.loadPrfMap();
      let label = 'Tacit', n = 1;
      while (m[label]) label = `Tacit ${++n}`;
      const r = await prf.prfRegister(label);
      m[label] = { credentialId: r.credentialId, pubkey: r.pubHex, createdAt: Date.now(), lastUsed: Date.now() };
      prf.savePrfMap(m);
      const priv = D.bytesToHex(r.priv); r.priv.fill(0);
      await setKey({ mode: 'passkey', priv, pubHex: r.pubHex, label, credentialId: r.credentialId });
    },
    async btc(k) {
      await load();
      await setKey(await turn(async () => {
        T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null;
        const av = T.extWallet.available();
        if (!av.satsConnect && !av.unisat) throw new Error(`No Bitcoin wallet found in this browser. Install Xverse, Leather or UniSat${prf.isPasskeyAvailable() ? ', or use a passkey' : ''}.`);
        const st = await T.extWallet.connectDefault();
        mainnetBtc(st.address);
        if (k?.address && st.address !== k.address) { T.extWallet.state = null; throw new Error(`Switch your Bitcoin wallet to ${short(k.address, 6)}, the account this Tacit wallet was opened with.`); }
        // A wallet enrolled before signs once and must open the key it opened then; a new one signs twice, the second proving it signs the same way.
        const prior = k?.btc?.address === st.address ? k.btc : T.btcWallet._read?.();
        T.btcWallet.state = prior?.address === st.address ? prior : null;
        try {
          if (T.btcWallet.state) await T.btcWallet.login(); else await T.btcWallet.enroll();
          return { mode: 'btc', priv: tPriv(), pubHex: T.btcWallet.state.tacitPubkey, address: st.address, btc: { ...T.btcWallet.state } };
        } catch (e) {
          if (e?._btcNonDeterministic) { T.btcWallet.state = null; T.extWallet.state = null; throw new Error('This Bitcoin wallet signs differently each time, so it cannot open a Tacit wallet by itself. Open your Tacit wallet in the classic app, or use a passkey or an Ethereum wallet.'); }
          T.extWallet.state = null; throw e;
        }
      }));
    },
  };

  const knownIds = () => (K ? K.knownWallets(KNOWN_IDS) : { primary: null, other: null });
  // A record whose way in this page does not offer (a key saved in the browser, or one an extension funds) is not offered here.
  const usable = (w) => (w && DERIVED.has(w.mode) ? w : null);
  // The wallet that opened a key is the proof of it: when that wallet moves to another account, or locks, the key is locked too, as on every other
  // page of the site.
  addEventListener('tacit:evm-accounts', (e) => {
    if (key?.mode !== 'eth') return;
    const a = lc((e.detail?.accounts || [])[0]);
    if (a && a === lc(key.address)) return;
    const why = `Your wallet ${a ? 'switched accounts' : 'locked'}, so the Tacit key opened with it was locked. Open it again to continue.`;
    if (moved) moved(why); else { forget(); emit(); }
  });
  return {
    load, turn, open, setKey,
    get T() { return T; }, get D() { return D; }, get key() { return key; }, get unlocked() { return !!(key && T && T.wallet.priv); },
    get address() { return key && T ? T.wallet.address() : null; },
    known: () => usable(knownIds().primary), other: () => usable(knownIds().other),
    passkeyAvailable: () => !!prf?.isPasskeyAvailable?.(), ethAvailable: () => !!evm?.available?.(),
    btcSeen: () => !!(window.btc_providers?.length || window.XverseProviders?.BitcoinProvider || window.LeatherProvider || window.unisat),
    lock() { forget(); emit(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
