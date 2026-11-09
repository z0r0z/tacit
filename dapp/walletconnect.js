
export const WC_PROJECT_ID = '1e8390ef1c1d8a185e035912a1409749';
const BUNDLE = '/vendor/tacit-walletconnect.min.js?cb=29a8864b';
const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#3B99FC"/>'
  + '<path transform="translate(10 18.5) scale(.147)" fill="#fff" d="M61.4 36.3c48.9-47.9 128.3-47.9 177.2 0l5.9 5.8c2.4 2.4 2.4 6.3 0 8.7l-20.1 19.7c-1.2 1.2-3.2 1.2-4.4 0l-8.1-7.9c-34.1-33.4-89.4-33.4-123.5 0l-8.7 8.5c-1.2 1.2-3.2 1.2-4.4 0L55.2 51.4c-2.4-2.4-2.4-6.3 0-8.7l6.2-6.4zm218.9 40.8l17.9 17.5c2.4 2.4 2.4 6.3 0 8.7l-80.7 79c-2.4 2.4-6.4 2.4-8.9 0l-57.3-56.1c-.6-.6-1.6-.6-2.2 0L91.8 182.3c-2.4 2.4-6.4 2.4-8.9 0L1.8 103.3c-2.4-2.4-2.4-6.3 0-8.7l17.9-17.5c2.4-2.4 6.4-2.4 8.9 0l57.3 56.1c.6.6 1.6.6 2.2 0l57.3-56.1c2.4-2.4 6.4-2.4 8.9 0l57.3 56.1c.6.6 1.6.6 2.2 0l57.3-56.1c2.4-2.4 6.4-2.4 8.9 0z"/></svg>');
const ASKS = new Set(['personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_watchAsset']);
const rejected = (message) => Object.assign(new Error(message), { code: 4001 });
const hexChain = (c) => `0x${BigInt(c).toString(16)}`;
function holds(session, chainId) {
  if (typeof chainId !== 'string') return false;
  const want = `eip155:${parseInt(chainId, 16)}`;
  return Object.entries(session?.namespaces || {}).some(([k, ns]) => /^eip155(:|$)/.test(k)
    && [...(ns.chains || []), ...(ns.accounts || []).map((a) => String(a).split(':').slice(0, 2).join(':'))].includes(want));
}
const SITE_RPC = { 1: 'https://ethereum-rpc.publicnode.com', 8453: 'https://mainnet.base.org', 4663: 'https://rpc.mainnet.chain.robinhood.com' };
const LOAD_MS = 20_000;
const NOT_LOADED = 'WalletConnect did not load. Check your connection and try again.';
const within = (work, ms) => {
  let t;
  return Promise.race([work, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(NOT_LOADED)), ms); })]).finally(() => clearTimeout(t));
};
const dropPairings = (p) => { (async () => p.signer?.cleanupPendingPairings?.({ deletePairings: true }))().catch(() => {}); };

const KEPT = 'tacit-wc-session';
const kept = {
  get() { try { return localStorage.getItem(KEPT); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEPT, String(v)); } catch { } },
};

export function announceWalletConnect({ projectId, chains, rpcMap, metadata, onPair, onAsk }) {
  const listeners = new Map();
  let wc = null, loading = null, pairing = null;
  const start = () => (loading ||= (async () => {
    const { EthereumProvider, qrcode } = await import(BUNDLE).catch(() => { throw new Error(NOT_LOADED); });
    const optionalChains = [...new Set([...chains, ...Object.keys(SITE_RPC).map(Number)])];
    const p = await EthereumProvider.init({ projectId, optionalChains, rpcMap: { ...SITE_RPC, ...rpcMap }, metadata, showQrModal: false, telemetryEnabled: false });
    for (const [ev, fns] of listeners) for (const fn of fns) p.on(ev, fn);
    p.on('disconnect', () => { kept.set(0); for (const fn of listeners.get('accountsChanged') || []) fn([]); });
    kept.set(p.session?.expiry || 0);
    wc = { p, qrcode };
    return wc;
  })().catch((e) => { loading = null; throw e; }));
  const load = () => (wc ? Promise.resolve(wc) : within(start(), LOAD_MS));

  async function pair({ p, qrcode }) {
    let cancel, done = null;
    const cancelled = new Promise((_, reject) => { cancel = () => { dropPairings(p); reject(rejected('Connection cancelled')); }; });
    cancelled.catch(() => {});
    const shown = (uri) => {
      const q = qrcode(0, 'M');
      q.addData(uri); q.make();
      done = onPair?.({ uri, qrSvg: q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }), cancel }) || null;
    };
    p.on('display_uri', shown);
    const connecting = p.connect();
    connecting.catch(() => {});
    try { await Promise.race([connecting, cancelled]); }
    catch (e) {
      const m = e?.message || '';
      if (e?.code === 4001 || /reject|denied|cancel/i.test(m)) throw rejected(m || 'Connection refused');
      if (/expire|time(d)? ?out/i.test(m)) throw Object.assign(new Error('The code ran out before a wallet app approved it. Connect again for a new one.'), { expired: true });
      throw e;
    }
    finally { p.removeListener('display_uri', shown); done?.(); }
    kept.set(p.session?.expiry || 0);
  }

  function peer(p) {
    const m = p.session?.peer?.metadata, r = m?.redirect;
    const native = /^[a-z][a-z0-9+.-]*:/i.test(r?.native || '') && !/^(https?|javascript|data|file|blob|about|vbscript):/i.test(r.native) ? r.native : null;
    return { name: String(m?.name || '').slice(0, 40), link: native || (/^https:\/\//i.test(r?.universal || '') ? r.universal : null) };
  }

  const provider = {
    isWalletConnect: true,
    async request(args) {
      const method = args?.method;
      const unpaired = () => Object.assign(new Error('Connect a wallet through WalletConnect first.'), { code: 4100 });
      if (!wc && kept.get() === '0' && method !== 'eth_requestAccounts') { if (method === 'eth_accounts') return []; throw unpaired(); }
      const w = await load();
      if (!w.p.session) {
        if (method === 'eth_accounts') return [];
        if (method !== 'eth_requestAccounts') throw unpaired();
        await (pairing ||= pair(w).finally(() => { pairing = null; }));
      }
      if (method === 'eth_requestAccounts') return w.p.accounts;
      if (method === 'eth_chainId') return hexChain(await w.p.request(args));
      if (!ASKS.has(method) || (method === 'wallet_switchEthereumChain' && holds(w.p.session, args.params?.[0]?.chainId))) return w.p.request(args);
      const p = peer(w.p), done = onAsk?.({ name: p.name || 'your wallet app', link: p.link }) || null;
      try { return await w.p.request(args); } finally { done?.(); }
    },
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); wc?.p.on(ev, fn); return provider; },
    removeListener(ev, fn) { listeners.get(ev)?.delete(fn); wc?.p.removeListener(ev, fn); return provider; },
    peerName: () => (wc?.p.session ? peer(wc.p).name : ''),
    endSession: () => disconnect(),
  };
  async function disconnect() {
    if (!wc?.p.session) return;
    try { await wc.p.disconnect(); } catch { }
    kept.set(0);
    for (const fn of listeners.get('accountsChanged') || []) fn([]);
  }

  const detail = Object.freeze({ info: Object.freeze({ uuid: crypto.randomUUID(), name: 'WalletConnect', icon: ICON, rdns: 'com.walletconnect' }), provider });
  const others = new Set();
  window.addEventListener('eip6963:announceProvider', (e) => { const u = e.detail?.info?.uuid; if (u && u !== detail.info.uuid) others.add(u); });
  const announce = () => { if (others.size || !window.ethereum) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail })); };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  return { provider, disconnect };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phone = () => matchMedia('(pointer: coarse)').matches;
const APPS = [['MetaMask', 'metamask'], ['Rainbow', 'rainbow'], ['Trust Wallet', 'trust']];
export const appLinks = (uri) => APPS.map(([name, scheme]) => ({ name, href: `${scheme}://wc?uri=${encodeURIComponent(uri)}` }));

export function wcSheets(open) {
  const lede = (t) => `<p class="lede-s" style="margin:0 0 12px">${t}</p>`;
  return {
    onPair({ uri, qrSvg, cancel }) {
      let over = false;
      const o = open('Connect a wallet app', () => { if (!over) cancel(); });
      const on = phone();
      const apps = on ? `<div style="display:grid;gap:8px;margin:0 0 14px">${appLinks(uri).map((a) => `<a class="btn" style="margin:0" href="${esc(a.href)}">Open ${esc(a.name)}</a>`).join('')}<a class="btn ghost" style="margin:0" href="${esc(uri)}">Other wallet app</a></div>` : '';
      const qr = `<div class="wc-qr" role="img" aria-label="QR code of the WalletConnect link">${qrSvg}</div>`;
      o.body.innerHTML = `${lede(on ? 'Open your wallet app to connect, or scan the code from another device.' : 'Scan the code with a wallet app on your phone: MetaMask, Rainbow, Trust, Zerion or any WalletConnect wallet.')}${on ? apps + qr : qr}<button class="btn ghost" type="button" style="margin-top:0" data-copy>Copy link</button><span role="status" aria-live="polite" data-copied style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap"></span><p class="note">This waits until the wallet app approves. Connecting costs nothing, and the code works for a few minutes.</p>`;
      const copy = o.body.querySelector('[data-copy]'), said = o.body.querySelector('[data-copied]');
      const tell = (label, words) => { copy.textContent = label; said.textContent = words; };
      copy.onclick = () => navigator.clipboard?.writeText(uri).then(() => tell('Copied', 'Link copied'), () => tell('Could not copy', 'Could not copy the link'));
      return () => { over = true; o.close(); };
    },
    onAsk({ name, link }) {
      const o = open('Approve in your wallet');
      const on = phone();
      o.body.innerHTML = `${lede(on ? `Open ${esc(name)} to approve the request, then come back here.` : `Approve the request in ${esc(name)} on your phone.`)}${on && link ? `<a class="btn" style="margin-top:0" href="${esc(link)}"${/^https:/i.test(link) ? ' target="_blank" rel="noopener"' : ''}>Open ${esc(name)}</a>` : ''}<p class="note">This closes once the wallet answers.</p>`;
      return () => o.close();
    },
  };
}

export function dialogHost({ dialog, title, body }) {
  let use = 0;
  return (text, onClose) => {
    const mine = ++use;
    title.textContent = text; body.replaceChildren();
    dialog.addEventListener('close', () => { if (use === mine) onClose?.(); }, { once: true });
    if (!dialog.open) dialog.showModal();
    return { body, close: () => { if (use === mine && dialog.open) dialog.close(); } };
  };
}

const OVERLAY_CSS = `.wcx { width: min(460px, calc(100vw - 32px)); max-height: 90vh; padding: 22px 22px 26px; overflow: auto; color: CanvasText; background: Canvas; border: 1px solid currentColor; font: 14px/1.5 system-ui, sans-serif; }
.wcx::backdrop { background: rgba(0,0,0,.45); }
.wcx .wcx-head { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; }
.wcx h2 { margin: 0; font-size: 22px; font-weight: 500; }
.wcx h2:focus { outline: none; }
.wcx .wcx-x { margin-left: auto; width: 40px; height: 40px; font-size: 22px; line-height: 1; color: inherit; background: none; border: 1px solid transparent; cursor: pointer; }
.wcx .lede-s, .wcx .note { margin: 0 0 12px; font-size: 13px; opacity: .75; }
.wcx .wc-qr { width: min(264px, 100%); margin: 6px auto 16px; padding: 14px; background: #fff; border: 1px solid #0003; }
.wcx .wc-qr svg { display: block; width: 100%; height: auto; }
.wcx .btn { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; padding: 8px 14px; box-sizing: border-box; font: inherit; color: Canvas; background: CanvasText; border: 1px solid CanvasText; text-decoration: none; cursor: pointer; }
.wcx .btn.ghost { color: CanvasText; background: transparent; }
@media (max-width: 560px) { .wcx { width: 100vw; max-width: 100vw; margin: auto 0 0; max-height: 92vh; border-width: 1px 0 0; } }`;
export function overlayHost() {
  let open = null;
  return (text, onClose) => {
    if (!open) {
      const dialog = document.createElement('dialog');
      dialog.className = 'wcx';
      dialog.setAttribute('aria-labelledby', 'wcx-h');
      if (!document.getElementById('wcx-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'wcx-style', textContent: OVERLAY_CSS }));
      dialog.innerHTML = `<div class="wcx-head"><h2 id="wcx-h" tabindex="-1"></h2><button class="wcx-x" type="button" aria-label="Close">×</button></div><div class="wcx-body"></div>`;
      const title = dialog.querySelector('h2'), body = dialog.querySelector('.wcx-body');
      dialog.querySelector('.wcx-x').onclick = () => dialog.close();
      dialog.addEventListener('mousedown', (e) => { if (e.target === dialog) dialog.close(); });
      document.body.append(dialog);
      open = dialogHost({ dialog, title, body });
    }
    return open(text, onClose);
  };
}
