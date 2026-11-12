const SHARED_NET = 'tacit-network-v1', PREV_NET = 'tacit-lite-prev-net-v1';
const SHARED_WALLET_KEYS = ['tacit-eth-identity', 'tacit-btc-identity', 'tacit-active-mode-v1', 'tacit-ext-mode-v1', 'tacit-ext-state-v1',
  ...['mainnet', 'signet'].flatMap((n) => [`tacit-eth-identity:${n}`, `tacit-btc-identity:${n}`, `tacit-active-mode-v1:${n}`])];

export function makeTacitSession({ url, key, secp, bytesToHex, hexToBytes, onLoad = () => {} }) {
  let T = null, loading = null, q = Promise.resolve();

  function load() {
    return (loading ||= (async () => {
      try { const cur = localStorage.getItem(SHARED_NET); if (sessionStorage.getItem(PREV_NET) === null && cur !== 'mainnet') sessionStorage.setItem(PREV_NET, cur ?? ''); localStorage.setItem(SHARED_NET, 'mainnet'); } catch {}
      globalThis.__TACIT_NO_INIT__ = true;
      T = await import(url);
      onLoad(T);
      return T;
    })().catch((e) => { loading = null; throw e; }));
  }
  window.addEventListener('pagehide', () => {
    try { const p = sessionStorage.getItem(PREV_NET); if (p !== null) { p === '' ? localStorage.removeItem(SHARED_NET) : localStorage.setItem(SHARED_NET, p); sessionStorage.removeItem(PREV_NET); } } catch {}
  });

  async function keepShared(fn) {
    let snap = [];
    try { snap = SHARED_WALLET_KEYS.map((k) => [k, localStorage.getItem(k)]); } catch {}
    const theirs = new Set(), seen = (e) => { if (e.storageArea === localStorage) theirs.add(e.key); };
    window.addEventListener('storage', seen);
    try { return await fn(); } finally {
      window.removeEventListener('storage', seen);
      for (const [k, v] of snap) { if (theirs.has(k) || theirs.has(null)) continue; try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
    }
  }
  function turn(fn) {
    const run = q.then(async () => { await load(); return keepShared(fn); });
    q = run.catch(() => {});
    return run;
  }

  function withKey(fn, pub = key()?.pubHex) {
    return turn(async () => {
      const k = key();
      if (!k || k.pubHex !== pub) throw new Error('Your Tacit wallet changed, so nothing was done.');
      if (!T.wallet.priv || bytesToHex(T.wallet.pub || new Uint8Array()) !== pub) {
        const priv = hexToBytes(k.priv);
        T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true);
        try { T.invalidateHoldingsCache({ fromPoll: true }); } catch {}
      }
      return fn(T);
    });
  }
  function drop() {
    if (!T) return;
    turn(() => { T.wallet.priv?.fill(0); T.wallet.priv = null; T.wallet.pub = null; try { T.invalidateHoldingsCache({ fromPoll: true }); } catch {} }).catch(() => {});
  }
  const tPriv = () => { const h = bytesToHex(T.wallet.priv); T.wallet.priv.fill(0); T.wallet.priv = null; return h; };

  return { load, turn, withKey, drop, tPriv, get T() { return T; } };
}
