// tacit.finance/tac — shielded TAC on Bitcoin.
//
// Everything here runs against the same modules the /sats page uses: dapp/sats/secret.js owns the pool
// operations (shield, private pay, exit, note scanning) and dapp/tacit.js owns the chain reads and holds the
// open key. This file is the page: the sign-in, balances, the five panes, and the live pool strip.
//
// Every proof is made on this device. The pool's relay is used for payments whenever it quotes TAC —
// then the sender needs no BTC at all and pays the relay inside the pool. Shields and exits always fund
// their own carrier, by design, so those need a little BTC in the wallet.

const TACIT_URL = '/tacit.js?cb=f6c8ff4f';        // tokens rewritten by build/build.mjs (TAC_CB_FILES)
const SECRET_URL = '/sats/secret.js?cb=df53b5a1';
const SATS_URL = '/tac/sats.js?cb=19b44eda';
const MARKET_URL = '/tac/market.js?cb=b6459103';
const CLAIM_URL = '/tac/claim.js?cb=0d2f2281';
const UNIFIED_URL = '/tacit-unified.js?cb=a5b3a042';
const KNOWN_URL = '/tacit-wallet-known.js?cb=ed4c75b7';
const EVM_URL = '/evm-wallet.js?cb=1e6da73a';
const ID_URL = '/address-id.js?cb=c4fa5a58';
const DEPS_URL = '/vendor/tacit-deps.min.js';
const PRF_URL = '/prf-wallet.js';
const WORKER = 'https://api.tacit.finance';
const ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';

const $ = (id) => document.getElementById(id);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let T = null;          // dapp/tacit.js
let S = null;          // dapp/sats/secret.js
let D = null;          // vendor/tacit-deps.min.js
let prf = null;        // dapp/prf-wallet.js
let K = null;          // dapp/tacit-wallet-known.js
let ID = null;         // dapp/address-id.js
let evm = null;        // dapp/evm-wallet.js, for opening a key with an Ethereum wallet's signature
let poolWallet = null;
let tacitAddress = null;   // the unified tacit1… address of the open key: null until its module has loaded, false if it could not
let pub = { loading: false, notes: [], decimals: 8 };
let shielded = { loading: false, notes: [] };
let relayLive = null;
let relayFee = null;   // the relay's quoted fee for TAC, in base units
let markSats = null;   // sats per whole TAC, from the worker's trade-backed mark price
let btcUsd = null;     // BTC/USD spot, via tacit.js's cached three-source failover
let busyId = null;

const DECIMALS = 8;
const fmt = (units, d = DECIMALS) => {
  const s = BigInt(units).toString().padStart(d + 1, '0');
  const whole = s.slice(0, -d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = s.slice(-d).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};
// fmt() is for reading; this is for writing back into an input.
const fmtPlain = (units, d = DECIMALS) => {
  const s = BigInt(units).toString().padStart(d + 1, '0');
  const frac = s.slice(-d).replace(/0+$/, '');
  return frac ? `${s.slice(0, -d)}.${frac}` : s.slice(0, -d);
};
// A decimal comma counts (1,5 is 1.5, as a comma keypad types it), and so do thousands commas (1,234.5 or 1,000,000).
// A lone comma before exactly three digits (1,500) could mean either, so it is refused, never guessed. null: not an amount.
function parseAmount(s, dec = 8) {
  let t = String(s || '').trim();
  if (t.includes(',')) {
    if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d*)?$/.test(t) && (t.includes('.') || t.indexOf(',') !== t.lastIndexOf(','))) t = t.replace(/,/g, '');
    else if (/^\d*,\d*$/.test(t) && !/^[1-9]\d{0,2},\d{3}$/.test(t)) t = t.replace(',', '.');
    else return null;
  }
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  if (f.length > dec) return null;
  return BigInt(w || '0') * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
const amountWhy = (t, dec) => (t.includes(',') ? 'Write 1500 for fifteen hundred, or 1,5 for a decimal comma.' : /^\d*\.?\d*$/.test(t) ? `Up to ${dec} decimals.` : 'Numbers only.');
const parseUnits = (str, d = DECIMALS) => {
  const t = String(str || '').trim(), v = parseAmount(t, d);
  if (v == null) throw new Error(t ? amountWhy(t, d) : 'Enter an amount above zero.');
  return v;
};
// Says why an amount is not read, beside the field, where a screen reader finds it with the field.
function amountHint(i, msg) {
  const box = i.closest('.amt') || i, at = box.nextElementSibling?.matches?.('[data-amt-hint]') ? box.nextElementSibling : null;
  if (!msg) return at?.remove();
  const h = at || Object.assign(document.createElement('p'), { className: 'note err' });
  h.setAttribute('data-amt-hint', ''); h.setAttribute('role', 'alert'); h.textContent = msg;
  if (!at) box.after(h);
}
for (const ev of ['input', 'change']) document.addEventListener(ev, ({ target: i }) => {
  if (!i.matches?.('input[inputmode="decimal"]')) return;
  const t = i.value.trim(), open = ev === 'input' && (t === '.' || /^[1-9]\d{0,2}(?:,\d{3})*,\d{0,3}$/.test(t));
  const bad = t && !open && parseAmount(t, DECIMALS) == null;
  if (bad) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid');
  amountHint(i, bad ? amountWhy(t, DECIMALS) : '');
}, true);
// A long address as its start and end. A Tacit address starts with 10 characters every one shares (the prefix and its
// format), so it keeps n of its own after them: what shows is the address's own.
const short = (a, n = 4) => { if (!a) return ''; const head = /^tacit1/.test(a) ? 10 + n : n + 2; return a.length > head + n + 2 ? `${a.slice(0, head)}…${a.slice(-n)}` : a; };
const txLink = (txid) => {
  const a = document.createElement('a');
  a.href = `https://mempool.space/tx/${txid}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = `${txid.slice(0, 10)}…`;
  return a;
};
const lc = (s) => String(s || '').toLowerCase();
const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const writeJson = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
// Markup for the sign-in, with every value escaped.
const escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
class Raw { constructor(s) { this.s = s; } }
const part = (v) => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v == null || v === false ? '' : String(v).replace(/[&<>"']/g, (c) => escMap[c]);
const html = (strs, ...vals) => new Raw(strs.reduce((a, s, i) => a + part(vals[i - 1]) + s));
const mount = (el, view) => { if (el) el.innerHTML = view.s; };

// An error the page wrote in words already (`said`), and one that only asks for a step first (`quiet`).
const said = (msg, extra = {}) => Object.assign(new Error(msg), { said: true, ...extra });
const errText = (e) => {
  if (e?.said) return e.message;
  const m = String(e?.shortMessage || e?.message || e || 'Something went wrong');
  if (e?.code === 4001 || /user (rejected|denied)|rejected the request|denied transaction|no wallet selected/i.test(m)) return 'Cancelled in your wallet.';
  if (e?.unlockCancelled || e?.name === 'NotAllowedError') return 'Cancelled.';         // the passphrase or passkey prompt was closed
  if (/no ethereum wallet detected/i.test(m)) return `No Ethereum wallet found in this browser. Open this page in your wallet's own browser, or install MetaMask, Rabby or Rainbow.${prf?.isPasskeyAvailable?.() ? ' Or use a passkey.' : ''}`;
  if (/insufficient sats|no plain-sats|not enough (?:signet )?sats/i.test(m)) return 'Not enough BTC at your Bitcoin address for this and its network fee.';
  if (/two notes cannot cover/i.test(m)) return 'One payment spends two of your notes at most. Combine them first, then pay again.';
  if (/no spendable notes/i.test(m)) return 'Nothing in your shielded balance can be spent yet: a payment you just made is still settling.';
  if (/\bHTTP 5\d\d\b/.test(m)) return 'The service is busy right now. Try again in a moment.';
  if (/failed to fetch|networkerror|load failed|all rpcs failed/i.test(m)) return 'Could not reach the network. Check your connection and try again.';
  if (/rate.?limit|too many requests|\b429\b|exceeded.*(?:request|quota)|upgrade.*(?:plan|tier)/i.test(m)) return 'That network is busy right now. Try again in a moment.';
  if (/timed? ?out|timeout/i.test(m)) return 'The network took too long to answer. Try again.';
  if (/previously derived a different Tacit identity/i.test(m)) return 'This account opened a different Tacit key on this device before. Switch to that account in your wallet, or open your key another way.';
  if (/non-canonical \(high-s\) signature/i.test(m)) return 'The wallet’s signature came back in a form Tacit does not use, so nothing was opened. Reconnect the wallet and try again.';
  // Anything else as written, cut at a sentence (or at least a word) when it runs long.
  const t = m.replace(/^Error:\s*/, '').replace(/\brelayer/gi, 'relay');
  if (t.length <= 240) return t;
  const cut = t.slice(0, 240), end = cut.lastIndexOf('. ');
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
};
function say(id, ...nodes) {
  const el = $(id);
  if (!el) return;
  el.replaceChildren(...nodes.filter((n) => n != null).map((n) => (typeof n === 'string' ? document.createTextNode(n) : n)));
}
function errSay(id, e) {
  const msg = errText(e);
  if (e?.quiet || e?.relayDeclined) return say(id, msg);
  const span = document.createElement('span');
  span.className = 'err'; span.setAttribute('role', 'alert'); span.textContent = msg;
  say(id, span);
  if (!/^Cancelled/.test(msg)) console.warn('[tac]', id, e);
}

// Toasts sit in a popover, the top layer, raised above whatever sheet is open whenever one appears. tacit.js posts
// its own toasts into the same container.
const toasts = $('toast-container');
// A modal dialog makes everything outside it inert, a popover included, so the toasts sit inside the topmost open dialog
// (the page itself when none is open): their links and buttons then work over a sheet.
const openDialogs = [];
const announce = (v) => { const el = $('live'); if (el) el.textContent = v; };
// The live region moves with them: outside the top modal it would be inert, and nothing in it would be read out.
function raiseToasts() {
  const on = toasts.childElementCount > 0, host = openDialogs.at(-1) || document.body, live = $('live');
  try { if (toasts.matches(':popover-open')) toasts.hidePopover(); } catch {}
  if (toasts.parentElement !== host) host.append(toasts);
  if (live && live.parentElement !== host) host.append(live);
  try { if (on) toasts.showPopover(); } catch {}
}
// Every toast, this page's or tacit.js's, is read out through the live region: the toast box appears and fills in one
// tick, which screen readers miss.
new MutationObserver((recs) => {
  raiseToasts();
  const words = recs.flatMap((r) => [...r.addedNodes]).map((n) => n.textContent || '').join(' ').trim();
  if (words) { announce(''); requestAnimationFrame(() => announce(words)); }
}).observe(toasts, { childList: true });
const dialogWatch = new MutationObserver((recs) => {
  for (const { target: d } of recs) { const i = openDialogs.indexOf(d); if (d.open && i < 0) openDialogs.push(d); else if (!d.open && i >= 0) openDialogs.splice(i, 1); }
  raiseToasts();
});
for (const d of document.querySelectorAll('dialog')) dialogWatch.observe(d, { attributes: true, attributeFilter: ['open'] });
function toast(msg, bad = false, ms = bad ? 7000 : 4200) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' error' : '');
  el.textContent = msg;
  toasts.append(el);
  setTimeout(() => el.remove(), ms);
}

// One action at a time: they share the wallet's key and the prover. A click that arrives while something
// else is running has to say so — swallowing it silently reads as a dead button, which is exactly how it
// looked while a background scan held the lock.
let afterBusy = null;   // what waits for the action in progress to end (a lock asked for by the wallet)
async function busy(btn, id, fn) {
  if (busyId) { say(id, busyId === id ? 'Already working on that…' : 'Finishing the last action first — try again in a moment.'); return; }
  busyId = id;
  const wasDisabled = btn.disabled;
  btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try { await fn(); }
  catch (e) { errSay(id, e); }
  finally {
    busyId = null; btn.disabled = wasDisabled; btn.removeAttribute('aria-busy');
    if (afterBusy) { const f = afterBusy; afterBusy = null; f(); }
  }
}
const whenIdle = (fn) => { if (busyId) afterBusy = fn; else fn(); };
// Leaving while an action that sends is under way asks first; a read is left alone.
const READS = new Set(['st-recv', 'st-claim-links']);
window.addEventListener('beforeunload', (e) => { if (busyId && !READS.has(busyId)) { e.preventDefault(); e.returnValue = ''; } });

// ── price ──
// Sats per whole TAC, from the worker's mark price (computed from real trades, outlier-guarded). Used only
// to annotate amounts — nothing on this page is priced or settled against it.
const satsFor = (units) => (markSats == null ? null : Math.floor((Number(units) / 10 ** DECIMALS) * markSats));
const usdFor = (units) => {
  const s = satsFor(units);
  return s == null || btcUsd == null ? null : (s / 1e8) * btcUsd;
};
const usdText = (usd) => (usd == null ? '' : usd >= 1 ? `$${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${usd.toFixed(4)}`);
const satsText = (units) => {
  const s = satsFor(units);
  if (s == null) return '';
  const usd = usdFor(units);
  return `≈ ${s.toLocaleString('en-US')} sats${usd == null ? '' : ` · ${usdText(usd)}`}`;
};
async function loadPrice() {
  try {
    const r = await fetch(`${WORKER}/assets/${ASSET}?network=mainnet`, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    const u = Number(j?.mark_price?.unit);
    if (Number.isFinite(u) && u > 0) markSats = u;
  } catch { /* the page works priceless */ }
  renderHeaderPrice();
  renderBalances(); renderAmountHints();
  try { btcUsd = await (await loadTacit()).getBtcUsdPrice(); } catch { btcUsd = null; }
  renderHeaderPrice();
  renderBalances(); renderAmountHints();
}

// The rate, stated once in the header rather than repeated beside every figure.
function renderHeaderPrice() {
  const el = $('hdr-price');
  if (!el) return;
  if (markSats == null) { el.replaceChildren(); return; }
  const oneTac = usdFor(BigInt(10 ** DECIMALS));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#tk-btc');
  svg.append(use); svg.setAttribute('aria-hidden', 'true');
  const b = document.createElement('b');
  b.textContent = `${markSats.toLocaleString('en-US')} sats`;
  el.replaceChildren(svg, b);
  if (oneTac != null) el.append(document.createTextNode(` · ${usdText(oneTac)}`));
  el.append(document.createTextNode(' / TAC'));
}

// ── modules ──
// tacit.js reads the shared network once, at import. This page pins mainnet for its visit and puts the previous
// value back when it goes away, so the main app keeps the network its user chose.
const SHARED_NET = 'tacit-network-v1', PREV_NET = 'tacit-tac-prev-net-v1';
function pinNetwork() {
  // Another tab of these pages may have pinned it already: its own value is then not this tab's to restore later.
  try {
    const cur = localStorage.getItem(SHARED_NET);
    if (sessionStorage.getItem(PREV_NET) === null && cur !== 'mainnet') sessionStorage.setItem(PREV_NET, cur ?? '');
    localStorage.setItem(SHARED_NET, 'mainnet');
  } catch {}
}
window.addEventListener('pagehide', () => {
  try {
    const p = sessionStorage.getItem(PREV_NET);
    if (p !== null) { p === '' ? localStorage.removeItem(SHARED_NET) : localStorage.setItem(SHARED_NET, p); sessionStorage.removeItem(PREV_NET); }
  } catch {}
});

let secretP = null, tacitP = null;
// secret.js alone serves the pool reads (the strip, the relay's fee), so those need not wait for tacit.js.
const loadSecret = () => (secretP ||= import(SECRET_URL).then((m) => (S = m), (e) => { secretP = null; throw e; }));
function loadTacit() {
  return (tacitP ||= (async () => {
    pinNetwork();
    globalThis.__TACIT_NO_INIT__ = true;
    const [t, , d, p, k, e] = await Promise.all([import(TACIT_URL), loadSecret(), import(DEPS_URL), import(PRF_URL), import(KNOWN_URL), import(EVM_URL)]);
    T = t; D = d; prf = p; K = k;
    evm = e.makeEvmWallet({ secp: d.secp, sha256: d.sha256, keccak256: d.keccak_256, bytesToHex: d.bytesToHex, hexToBytes: d.hexToBytes, prfBytesToScalar: p.prfBytesToScalar, netName: 'mainnet' });
    import(ID_URL).then((m) => { ID = m; }, () => {});
    return T;
  })().catch((e) => { tacitP = null; throw e; }));
}

// ── wallet ──
// The wallet this page offers is the one tacit.finance has open, chosen by the module the front page and pay share
// (tacit-wallet-known.js), so every page opens the same key. The key this page opens stays in tacit.js until it is
// locked; `key` is its public record.
const isPub = (h) => /^0[23][0-9a-f]{64}$/.test(lc(h));
const pubOf = (privHex) => D.bytesToHex(D.secp.getPublicKey(D.hexToBytes(privHex), true));
const TAC_ID = 'tacit-tac-id-v1';                       // how this page last opened a key: public data only
const KNOWN_IDS = [TAC_ID, 'tacit-pay-hub-id-v1', 'tacit-lite-id-v1', 'tacit-pay-id-v1'];
const knownWallet = () => K?.knownWallets(KNOWN_IDS).primary ?? null;
const otherWallet = () => K?.knownWallets(KNOWN_IDS).other ?? null;
const viaText = (k) => ({ eth: `Ethereum ${short(k.address || '')}`, btc: `Bitcoin ${short(k.address || '', 6)}`, ext: `a key funded by ${short(k.address || '', 6)}`,
  passkey: `passkey “${k.label || 'Tacit'}”`, local: 'the key saved in this browser', key: 'a pasted key' })[k?.mode] || 'your wallet';

let key = null;        // { mode, pubHex, address?, ext?, label?, credentialId?, btc? }
const unlocked = () => !!(key && T && T.wallet.priv);

// A turn may rewrite tacit.finance's records of which wallet it has open. Each turn puts them back, except a record
// another tab writes while the turn runs: that one is theirs, and is left as they wrote it.
const SHARED_WALLET_KEYS = ['tacit-eth-identity', 'tacit-btc-identity', 'tacit-active-mode-v1', 'tacit-ext-mode-v1', 'tacit-ext-state-v1',
  ...['mainnet', 'signet'].flatMap((n) => [`tacit-eth-identity:${n}`, `tacit-btc-identity:${n}`, `tacit-active-mode-v1:${n}`])];
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
// tacit.js keeps one global wallet, so each use runs in its own turn — a key never changes mid-operation.
let walletQ = Promise.resolve();
const turn = (fn) => { const r = walletQ.then(async () => { await loadTacit(); return keepShared(fn); }); walletQ = r.catch(() => {}); return r; };
const mainnetBtc = (a) => { if (!/^(bc1|[13])/i.test(String(a || ''))) throw new Error('Your Bitcoin wallet is on a test network. Switch it to mainnet.'); };
const tPriv = () => { const h = D.bytesToHex(T.wallet.priv); T.wallet.priv.fill(0); T.wallet.priv = null; return h; };

const rememberKey = () => { if (key) writeJson(TAC_ID, key.mode === 'key' ? null : { ...key, ...(tacitAddress ? { tacit: tacitAddress } : {}) }); };
// Every way in ends here: the key goes into tacit.js for this visit, and only the key the wallet said it would open.
async function setKey(k) {
  const pubHex = lc(String(k.pubHex || pubOf(k.priv)).replace(/^0x/, ''));
  if (pubOf(k.priv) !== pubHex) throw new Error('That wallet opened a different key than expected. Nothing was changed.');
  const { priv, ...rest } = k;
  forget();
  await turn(() => {
    T.wallet.priv = D.hexToBytes(priv); T.wallet.pub = D.hexToBytes(pubHex);
    try { T.invalidateHoldingsCache?.(); } catch {}
  });
  key = { ...rest, pubHex };
  rememberKey();
  afterUnlock(true);
  refreshAll().catch(() => {});
}
function forget() {
  key = null;
  if (T) { T.wallet.priv = null; T.wallet.pub = null; try { T.invalidateHoldingsCache?.(); } catch {} }
  poolWallet = null; tacitAddress = null; stealthScanned = false;
  shielded = { loading: false, notes: [] };
  pub = { loading: false, notes: [], decimals: DECIMALS };
}

function pickWallet(list) {
  return new Promise((resolve) => {
    const d = $('sheet-pick');
    mount($('pick-body'), html`<div class="picker">${list.map((w) => html`
      <button type="button" data-uuid="${w.uuid}">${/^data:image\//.test(w.icon || '') ? html`<img src="${w.icon}" alt="">` : ''}<span>${w.name}</span></button>`)}</div>`);
    const onClose = () => resolve(null);
    d.addEventListener('close', onClose, { once: true });
    $$('[data-uuid]', d).forEach((b) => b.onclick = () => { d.removeEventListener('close', onClose); d.close(); resolve(b.dataset.uuid); });
    d.showModal();
  });
}
// The ways in, each ending in setKey.
const open = {
  async eth(k) {
    const id = await evm.deriveIdentity({ pick: pickWallet, expect: k?.address });
    await setKey({ mode: 'eth', priv: id.priv, pubHex: k?.pubHex || id.pubHex, address: '0x' + lc(id.address).replace(/^0x/, '') });
  },
  async passkey(k) {
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
    await setKey(await turn(async () => {
      T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null;
      const av = T.extWallet.available();
      if (!av.satsConnect && !av.unisat) throw new Error(`No Bitcoin wallet found in this browser. Install Xverse, Leather or UniSat${prf.isPasskeyAvailable() ? ', or use a passkey' : ''}.`);
      const st = await T.extWallet.connectDefault();
      mainnetBtc(st.address);
      if (k?.address && st.address !== k.address) { T.extWallet.state = null; throw new Error(`Switch your Bitcoin wallet to ${short(k.address, 6)}, the account this Tacit wallet was opened with.`); }
      const ext = { ...T.extWallet.state };
      // A wallet enrolled before signs once and must open the key it opened then; a new one signs twice, the second
      // proving it signs the same way.
      const prior = k?.btc?.address === st.address ? k.btc : T.btcWallet._read?.();
      T.btcWallet.state = prior?.address === st.address ? prior : null;
      try {
        if (T.btcWallet.state) await T.btcWallet.login(); else await T.btcWallet.enroll();
        return { mode: 'btc', priv: tPriv(), pubHex: T.btcWallet.state.tacitPubkey, address: st.address, btc: { ...T.btcWallet.state } };
      } catch (e) {
        if (!e?._btcNonDeterministic) { T.extWallet.state = null; throw e; }
        // This wallet signs differently each time, so it funds a Tacit key kept in this browser instead.
        T.btcWallet.state = null; T.extWallet.state = ext; T.wallet.mode = null;
        await T.wallet.load(st.address);
        return { mode: 'ext', priv: tPriv(), address: st.address, ext };
      }
    }));
  },
  async ext(k) {
    const priv = await turn(async () => { T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null; T.extWallet.state = k.ext; await T.wallet.load(k.address); return tPriv(); });
    await setKey({ mode: 'ext', priv, pubHex: k.pubHex, address: k.address, ext: k.ext });
  },
  async local(k) {
    const priv = await turn(async () => { T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null; T.extWallet.state = null; await T.wallet.load(); return tPriv(); });
    await setKey({ mode: 'local', priv, pubHex: k?.pubHex });
  },
  // A pasted key is held for this tab only: nothing of it is written to this browser.
  async key(hex) {
    const h = lc(String(hex || '').trim()).replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('A Tacit key is 64 hex characters.');
    if (!BigInt('0x' + h) || BigInt('0x' + h) >= D.secp.CURVE.n) throw new Error('That is not a valid Tacit key.');
    await setKey({ mode: 'key', priv: h });
  },
};
// A wallet in this browser, told without loading anything: the way in puts what is not here after what is.
const btcWalletSeen = () => !!(window.btc_providers?.length || window.XverseProviders?.BitcoinProvider || window.LeatherProvider || window.unisat);
// A way in that fails says so beside the options, not in a toast, which would cover the rows to try next.
const signInErr = (box, id, e) => { const p = box.querySelector(`#${id}-err`); p.textContent = errText(e); p.hidden = false; };
function signIn(id) {
  const known = knownWallet(), other = otherWallet(), pk = prf.isPasskeyAvailable();
  const saved = known?.mode !== 'local' && isPub(readJson('tacit-wallet-v1:mainnet')?.pub);
  const hasBtc = btcWalletSeen(), hasEth = evm.available(), bare = pk && !known && !other && !hasBtc && !hasEth;
  const opt = (k, title, sub, cls = '') => html`<button class="opt ${cls}" type="button" data-in="${k}"><span class="opt-t">${title}</span><span class="opt-m">${sub}</span></button>`;
  return html`<div class="opts" id="${id}-in">
    ${known ? opt('known', html`<svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>Continue with your Tacit wallet`, `Opens with ${viaText(known)}, the same key as on tacit.finance.`, 'main') : ''}
    ${other ? opt('other', html`<svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>${other.tacit ? html`Continue as <b>${short(other.tacit, 7)}</b>` : 'Your other Tacit key'}`, html`A different key, opened here before with ${viaText(other)}. Not the one tacit.finance has open.`) : ''}
    ${bare ? opt('new', html`<svg class="tk sm" aria-hidden="true"><use href="#i-key"/></svg>Create a wallet`, 'Touch ID, Face ID or Windows Hello. Nothing to install.', 'main') : ''}
    ${bare ? opt('passkey', html`<svg class="tk sm" aria-hidden="true"><use href="#i-key"/></svg>Open a passkey wallet`, 'One you made before, with a passkey on this device or in your password manager.') : ''}
    ${opt('btc', html`<svg class="tk sm" aria-hidden="true"><use href="#tk-btc"/></svg>Bitcoin wallet`, hasBtc || !bare ? 'Xverse, Leather or UniSat. One signature, two the first time.' : 'Xverse, Leather or UniSat. None found in this browser.')}
    ${opt('eth', html`<svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>Ethereum wallet`, hasEth || !bare ? 'MetaMask, Rabby, Rainbow or any browser wallet. One signature, two the first time on this browser.' : 'MetaMask, Rabby, Rainbow or any browser wallet. None found in this browser.')}
    ${pk && !bare ? opt('passkey', html`<svg class="tk sm" aria-hidden="true"><use href="#i-key"/></svg>Passkey`, 'Touch ID, Windows Hello or a security key.') : ''}
    <p class="opts-err" id="${id}-err" role="alert" hidden></p>
    <p class="more">${pk && !bare ? html`<button class="link" type="button" data-in="new">New passkey wallet</button>` : ''}${saved ? html`<button class="link" type="button" data-in="local">Saved in this browser</button>` : ''}<button class="link" type="button" data-in="paste">Paste a key</button></p>
    <div class="amt text" id="${id}-paste" hidden><input id="${id}-hex" type="password" placeholder="64-character Tacit key" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Tacit key"><button class="link" type="button" data-in="key">Open</button></div>
  </div>`;
}
let signing = false;                                    // one way in at a time: two wallet prompts must not race
function wireSignIn(root, id, after) {
  const box = root.querySelector(`#${id}-in`);
  if (!box) return;
  const known = knownWallet(), other = otherWallet();
  for (const b of box.querySelectorAll('[data-in]')) b.onclick = async () => {
    const k = b.dataset.in;
    if (k === 'paste') { const p = box.querySelector(`#${id}-paste`); p.hidden = false; p.querySelector('input').focus(); return; }
    if (signing || b.getAttribute('aria-busy') === 'true') return;
    box.querySelector(`#${id}-err`).hidden = true;
    signing = true;
    b.setAttribute('aria-busy', 'true'); b.disabled = true;
    const rest = $$('[data-in]', box).filter((x) => x !== b && !x.disabled);
    rest.forEach((x) => { x.disabled = true; });
    try {
      if (k === 'known') await open[known.mode](known);
      else if (k === 'other') await open[other.mode](other);
      else if (k === 'key') await open.key(box.querySelector(`#${id}-hex`).value);
      else if (k === 'new') await open.newPasskey();
      else if (k === 'local') await open.local({ pubHex: readJson('tacit-wallet-v1:mainnet')?.pub });
      else await open[k]();
      after?.();
    } catch (e) { if (!/cancel/i.test(e?.message || '') && e?.name !== 'NotAllowedError' && !e?.unlockCancelled) signInErr(box, id, e); }
    finally { signing = false; b.removeAttribute('aria-busy'); b.disabled = false; rest.forEach((x) => { x.disabled = false; }); }
  };
  box.querySelector(`#${id}-hex`)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') box.querySelector('[data-in="key"]').click(); });
}

// The open wallet: its address, Lock, and the key to back up when this browser is the only place it is kept.
function renderWalletSheet() {
  const el = $('wallet-body');
  if (!unlocked()) {
    mount(el, html`<p class="lede-s">Open your Tacit wallet. It is the same key, with the same balances, as on tacit.finance.</p>${signIn('ws')}`);
    return wireSignIn(el, 'ws', () => $('connect-sheet').close());
  }
  const k = key, kept = k.mode === 'ext' || k.mode === 'local', a = tacitAddress || null;
  mount(el, html`
    <div class="who"><div class="a num">${a ? short(a, 12) : tacitAddress === false ? short(poolWallet?.addressString || '', 12) : '…'}</div><div class="u">${a || tacitAddress !== false ? 'Your Tacit address' : 'Your pool address'} · opened with ${viaText(k)}</div>
      ${a && ID ? html`<div class="u">ID <b class="num">${ID.addressId(a)}</b> · a payer sees the same ID</div>` : ''}
      <div class="row2"><button class="btn ghost" type="button" id="w-copy" ${a ? '' : 'disabled'}>Copy address</button><button class="btn ghost" type="button" id="w-lock">Lock</button></div></div>
    ${kept ? html`<p class="more"><button class="link" type="button" id="w-backup">Copy key to back up</button></p>` : ''}
    <p class="note">${kept ? 'This key is kept in this browser only, so clearing the browser’s data loses it. Copy it somewhere private: anyone who has it controls these funds, and pasting it back opens them again.' : k.mode === 'key' ? 'You pasted this key and it is not saved here, so closing the tab forgets it. Keep your own copy somewhere private: anyone who has it controls these funds.' : 'Your wallet or passkey is the only way back to these funds: keep it safe.'} The key stays in this tab; payments to your addresses reach you here and on tacit.finance.</p>`);
  $('w-copy').onclick = () => a && navigator.clipboard.writeText(a).then(() => toast('Address copied'), () => toast(`Could not copy: ${a}`, true));
  $('w-backup')?.addEventListener('click', () => {
    if (!unlocked() || key !== k) return;
    navigator.clipboard.writeText(D.bytesToHex(T.wallet.priv)).then(() => toast('Key copied. Keep it somewhere private.'), () => toast('Could not copy the key: the browser refused clipboard access.', true));
  });
  $('w-lock').onclick = () => { if (busyId) return toast('Finish the action in progress first.', true); lock(); renderWalletSheet(); };
}
function openWallet() {
  renderWalletSheet();
  if (!$('connect-sheet').open) $('connect-sheet').showModal();
}

// The wallet chip's Tacit address: its short form, and on a narrow screen the prefix and six characters of its own.
const chipView = (a) => (/^tacit1/.test(a || '') && a.length > 30 ? html`<span class="wide">${short(a, 6)}</span><span class="narrow">tacit1…${a.slice(10, 16)}</span>` : html`${short(a, 6)}`);
function paintWallet() {
  $('wallet-dot').className = 'dot' + (unlocked() ? ' on' : '');
  mount($('wallet-label'), unlocked()
    ? (tacitAddress ? chipView(tacitAddress) : tacitAddress === false ? chipView(poolWallet?.addressString || '') : html`Opening…`)
    : html`${knownWallet() ? 'Open wallet' : 'Sign in'}`);
  if ($('connect-sheet').open && !signing) renderWalletSheet();
}

// Unlock if needed, and always leave `poolWallet` derived. Separate conditions: a key can already be in
// memory while this page has never derived the pool wallet from it, and every pool call below would then
// be handed a null wallet. Locked, the wallet tacit.finance has open is opened in place; with none, the
// sign-in comes up.
async function ensureKey() {
  if (!unlocked()) {
    await loadTacit();
    const k = knownWallet();
    if (!k || signing) { openWallet(); throw said(signing ? 'Finish signing in first.' : 'Open your wallet first.', { quiet: true }); }
    signing = true;
    try { await open[k.mode](k); } finally { signing = false; }
  }
  if (!poolWallet) afterUnlock();
}

function afterUnlock(fresh = false) {
  // tacit.js only drops this cache inside ensurePrivkey; these paths open a key without going through it,
  // so a 30s-stale Map from the previous identity could otherwise be read as this one's holdings.
  try { T.invalidateHoldingsCache?.(); } catch {}
  poolWallet = S.poolWalletFor(T.wallet.priv, 'mainnet');
  tacitAddress = null;
  paintReceive(); loadTacitAddress(fresh);
  paintWallet();
  window.dispatchEvent(new Event('tac:wallet'));                  // the market says what this key can buy with
  // One quiet pass so a stealth payment shows up without the owner knowing to go looking for it.
  if (!stealthScanned) {
    findStealth().then((n) => { if (n) say('st-recv', `Found ${n} stealth payment${n === 1 ? '' : 's'} paid to you.`); }).catch(() => {});
  }
}

// The passphrase prompt is a plain div, which the modal Wallet sheet covers and makes inert: the sheet steps aside while
// the prompt is up and comes back when it closes, so a cancel shows its message there.
function watchPassphrase() {
  const modal = $('pass-modal'), sheet = $('connect-sheet');
  let aside = false;
  new MutationObserver(() => {
    const up = modal.style.display === 'grid';
    if (up && sheet.open) { sheet.close(); aside = true; }
    else if (!up && aside) { aside = false; if (!sheet.open) sheet.showModal(); }
  }).observe(modal, { attributes: true, attributeFilter: ['style'] });
}

function paintReceive() {
  $('recv-addr').value = poolWallet ? poolWallet.addressString : 'Open your wallet to see your pool address';
  $('recv-tacit').value = !poolWallet ? 'Open your wallet to see your Tacit address'
    : tacitAddress === false ? 'Not available here: use the pool address below.' : tacitAddress || 'Deriving your Tacit address…';
}
// Receive leads with the unified Tacit address, which the pool pays, and keeps the pool address beneath it.
async function loadTacitAddress(fresh = false) {
  const pw = poolWallet;
  try {
    const { unifiedAddress } = await import(UNIFIED_URL);
    if (poolWallet !== pw || !unlocked()) return;
    tacitAddress = unifiedAddress(T.wallet.priv).address;
    rememberKey();
    if (fresh) toast(`Opened ${short(tacitAddress, 8)}`);
  } catch (e) {
    console.warn('[tac] tacit address', e);
    if (poolWallet !== pw) return;
    tacitAddress = false;
  }
  paintReceive(); paintWallet();
}

function lock() {
  forget();
  writeJson(TAC_ID, null);
  evm?.deselectProvider();
  paintReceive();
  paintWallet(); renderBalances(); renderShieldPicker();
  window.dispatchEvent(new Event('tac:wallet'));
}
// The wallet that opened this key is the proof of it: when it moves to another account, or locks, the key is locked
// too, once the action in progress has ended.
window.addEventListener('tacit:evm-accounts', (e) => {
  if (key?.mode !== 'eth') return;
  const a = (e.detail?.accounts || [])[0], was = key;
  if (a && lc(a) === lc(key.address)) return;
  whenIdle(() => {
    if (key !== was) return;
    lock();
    toast(a ? 'Your wallet switched accounts, so the key it opened was locked.' : 'Your wallet locked, so the key it opened was locked.');
  });
});

// ── balances ──
// A read that ends after its key was locked, or another key opened, is dropped: it describes that other key.
async function loadPublic() {
  if (!unlocked()) return;
  const k = key;
  pub = { ...pub, loading: true }; renderBalances();
  try {
    const h = await T.scanHoldings();
    if (key !== k) return;
    const entry = h instanceof Map ? h.get(S.TAC_ASSET_MAINNET) : null;
    pub = {
      loading: false,
      notes: entry?.utxos || [],
      decimals: Number.isInteger(entry?.decimals) ? entry.decimals : DECIMALS,
    };
  } catch (e) { if (key !== k) return; pub = { ...pub, loading: false }; errSay('st-shield', e); }
  renderBalances(); renderShieldPicker();
}

async function loadShielded() {
  if (!poolWallet) return;
  const pw = poolWallet;
  shielded = { ...shielded, loading: true }; renderBalances();
  try {
    const notes = await S.poolNotes(pw, S.TAC_ASSET_MAINNET);
    if (poolWallet !== pw) return;
    shielded = { loading: false, notes };
  } catch (e) { if (poolWallet !== pw) return; shielded = { ...shielded, loading: false }; errSay('st-recv', e); }
  renderBalances();
}

const relayFeeUnits = () => (relayLive && relayFee != null ? relayFee : 0n);
const noteVal = (u) => (typeof u.amount === 'bigint' ? u.amount : BigInt(u.amount));
const publicTotal = () => pub.notes.reduce((t, u) => t + noteVal(u), 0n);
const shieldedTotal = () => (shielded.notes || []).filter((n) => !n.spent).reduce((t, n) => t + BigInt(n.value), 0n);

function renderBalances() {
  const sT = shieldedTotal(), pT = publicTotal();
  // Both balances are read only with the key open; a locked wallet has no figure to show yet.
  $('bal-shielded').textContent = !unlocked() ? '—' : shielded.loading ? '…' : fmt(sT);
  $('bal-public').textContent = !unlocked() ? '—' : pub.loading ? '…' : fmt(pT);
  $('bal-shielded-sats').textContent = unlocked() && !shielded.loading && sT > 0n ? satsText(sT) : '';
  $('bal-public-sats').textContent = unlocked() && !pub.loading && pT > 0n ? satsText(pT) : '';
  // Spends pad to three outputs with zero-value notes so the real count stays hidden on chain. They are
  // padding, not holdings — counting them would tell the wallet's owner they have notes they don't.
  const n = (shielded.notes || []).filter((x) => !x.spent && BigInt(x.value) > 0n).length;
  $('bal-note').textContent = !unlocked() ? 'Open your wallet to see your balances.'
    : `${n} shielded note${n === 1 ? '' : 's'} only you can see.`;
  if (unlocked() && !shielded.loading && liveNotes().length > 4) {
    const b = Object.assign(document.createElement('button'), { className: 'link', type: 'button', textContent: 'Combine my notes' });
    b.onclick = offerCombine;
    $('bal-note').append(' ', b);
  }
  $('btn-refresh').hidden = !unlocked();
  renderSendComb();
}

// One payment spends two notes at most. One that two cannot cover goes after the two largest are joined into one, paid to
// this wallet's own pool address; the relay's fee comes out of them when the relay posts it.
const liveNotes = () => (S && poolWallet ? S.pendingView(shielded.notes || [], S.TAC_ASSET_MAINNET, poolWallet).live.filter((n) => BigInt(n.value) > 0n) : []);
const liveValues = () => liveNotes().map((n) => BigInt(n.value)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
const combineFee = () => (relayLive && relayFee != null ? relayFee : null);
const combineBox = (id, lead, each = false) => html`<div class="callout"><span>${lead}<small>${combineFee() != null ? `Relay fee ≈ ${fmt(combineFee())} TAC${each ? ' each' : ''}` : 'Posted from your Bitcoin address, which pays its Bitcoin fee and shows as the sender'}.</small></span><button class="btn ghost" type="button" id="${id}">Combine my notes</button></div>`;
// Under Send's amount: the offer to combine first, when two notes cannot cover the amount and its fee and a run of combines can.
function renderSendComb() {
  const box = $('send-comb');
  if (!box) return;
  let v = 0n;
  try { v = parseUnits($('send-amt').value); } catch {}
  const vals = liveValues(), k = v > 0n && unlocked() && S ? S.combinePlan(vals, v + relayFeeUnits(), combineFee() || 0n) : null;
  box.hidden = !k;
  if (!k) return box.replaceChildren();
  mount(box, combineBox('btn-comb-send', html`Your TAC is in ${vals.length} notes; one payment spends two.${k > 1 ? ` This one takes ${k} combines, one per press.` : ''} Combine them first:`, k > 1));
  $('btn-comb-send').onclick = (e) => busy(e.currentTarget, 'st-send', () => doCombine('st-send', 'Then pay again.'));
}
function offerCombine() {
  const [a = 0n, b = 0n] = liveValues();
  mount($('st-comb'), combineBox('btn-comb', html`Your TAC is in ${liveValues().length} notes; one payment spends two. Combining joins your two largest into one note of ${fmt(a + b - (combineFee() || 0n))} TAC.`));
  $('btn-comb').onclick = (e) => busy(e.currentTarget, 'st-comb', () => doCombine('st-comb', ''));
}

// Live sats equivalent under each amount field, so an amount is never entered blind.
function renderAmountHints() {
  for (const [field, hint] of [['send-amt', 'send-sats'], ['exit-amt', 'exit-sats']]) {
    const el = $(hint); if (!el) continue;
    let units = 0n;
    try { units = parseUnits($(field).value); } catch { units = 0n; }
    el.textContent = units > 0n ? satsText(units) : '';
  }
}

function renderShieldPicker() {
  const sel = $('shield-pick'), was = sel.value;
  sel.replaceChildren();
  if (!pub.notes.length) {
    const o = document.createElement('option');
    o.textContent = unlocked() ? 'No public TAC in this wallet' : 'Open your wallet first';
    sel.append(o); sel.disabled = true;
    $('shield-stealth-note').textContent = '';
    return;
  }
  // A stealth-received note sits at P2WPKH(walletPub + b·G) and is spent with its tweaked key; shieldNote
  // signs with the wallet key alone, so offering one here would broadcast a commit whose reveal is invalid.
  const shieldable = pub.notes.filter((u) => !u.stealthTweakedSk);
  const stealthHeld = pub.notes.length - shieldable.length;
  $('shield-stealth-note').textContent = stealthHeld
    ? `${stealthHeld} note${stealthHeld === 1 ? '' : 's'} paid to a one-time address ${stealthHeld === 1 ? 'is' : 'are'} in your balance but cannot be shielded from this page yet — move ${stealthHeld === 1 ? 'it' : 'them'} in the classic app first.`
    : '';
  if (!shieldable.length) {
    const o = document.createElement('option');
    o.textContent = 'No shieldable TAC in this wallet';
    sel.append(o); sel.disabled = true; return;
  }
  sel.disabled = false;
  [...shieldable]
    .sort((a, b) => (noteVal(b) > noteVal(a) ? 1 : noteVal(b) < noteVal(a) ? -1 : 0))
    .forEach((u, i) => {
      const o = document.createElement('option');
      o.value = `${u.utxo.txid}:${u.utxo.vout}`;
      const s = satsText(noteVal(u));
      o.textContent = `${fmt(noteVal(u))} TAC${s ? `  ·  ${s}` : ''}`;
      sel.append(o);
    });
  // A rebuild (the stealth scan after unlock runs one) keeps the note picked, so Shield moves the one shown.
  ([...sel.options].find((o) => o.value === was) || sel.options[0]).selected = true;
}

// ── pool stats ──
async function loadStats() {
  try {
    await loadSecret();
    const st = await S.poolClientFor('mainnet').status();
    $('s-set').textContent = Number(st.leafCount || 0).toLocaleString('en-US');
    $('s-height').textContent = Number(st.height || 0).toLocaleString('en-US');
    $('s-proof').textContent = st.proofSystem === 'halo2-kzg-bn254' ? 'Halo2·KZG' : (st.proofSystem || '—');
    // Every Bitcoin transaction that added notes to the pool: shields, spends and a relay's batched carriers alike.
    const feed = await S.poolClientFor('mainnet').allNotes().catch(() => null);
    const txs = feed ? new Set(feed.filter((n) => n.txid).map((n) => n.txid)).size : null;
    $('s-txs').textContent = txs == null ? '—' : txs.toLocaleString('en-US');
  } catch {
    for (const id of ['s-set', 's-txs', 's-height', 's-proof']) if ($(id).textContent === '…') $(id).textContent = '—';
  }
  try {
    const info = await S.poolClientFor('mainnet').relayInfo();
    relayLive = !!info;
    const f = info?.fees?.['0x' + S.TAC_ASSET_MAINNET];
    relayFee = f == null ? null : BigInt(f);
  } catch { relayLive = false; relayFee = null; }
}

// ── actions ──
async function doShield() {
  await ensureKey();
  if (!pub.notes.length) await loadPublic();
  const picked = $('shield-pick').value;
  const shieldable = pub.notes.filter((x) => !x.stealthTweakedSk);
  if (!shieldable.length) throw new Error('No shieldable TAC in this wallet yet.');
  const u = shieldable.find((x) => `${x.utxo.txid}:${x.utxo.vout}` === picked);
  if (!u) throw new Error('Your notes changed. Pick the note to shield again.');
  if (u.stealthTweakedSk) throw new Error('That note was paid to a one-time address and needs its own key to move.');
  const blinding = (() => {
    const v = u.blinding;
    const big = typeof v === 'bigint' ? v : BigInt(/^0x/i.test(String(v)) ? v : '0x' + String(v));
    return big.toString(16).padStart(64, '0');
  })();
  const note = { assetId: S.TAC_ASSET_MAINNET, txid: u.utxo.txid, vout: u.utxo.vout, amount: noteVal(u).toString(), blinding };
  const r = await S.shieldNote(T, { note, poolWallet, say: (m) => say('st-shield', m) });
  say('st-shield', `${fmt(r.poolNote.value)} TAC shielded in `, txLink(r.revealTxid), '. It joins the pool after one confirmation.');
  try { T.invalidateHoldingsCache?.(); } catch {}
  await loadPublic(); await loadShielded();
}

async function doSend(anchor = null) {
  await ensureKey();
  const to = $('send-to').value.trim();
  if (!to) throw new Error('Paste the Tacit or pool address you are paying.');
  const amount = parseUnits($('send-amt').value);
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  if (!shielded.notes.length) await loadShielded();   // a cold unlock has not scanned the pool yet
  // A relayed payment spends the fee out of the same notes, so it has to fit alongside the amount.
  if (amount + relayFeeUnits() > shieldedTotal()) {
    throw new Error(relayFeeUnits() > 0n
      ? `More than your shielded balance once the relay's ${fmt(relayFeeUnits())} TAC fee is included.`
      : 'More than your shielded balance.');
  }
  const r = await S.payPrivately(T, { poolWallet, to, amount, asset: S.TAC_ASSET_MAINNET, anchor, say: (m) => say('st-send', m), askSelf: askSelfPost('st-send') });
  if (r.wait) return waitBox('st-send', r, (tip) => doSend(tip));
  $('send-to').value = ''; $('send-amt').value = ''; renderAmountHints();
  say('st-send', `Sent ${fmt(amount)} TAC in `, txLink(r.revealTxid), r.relayed ? ' — relayed, fee paid in TAC.' : ' — self-funded.');
  await loadShielded();
}

async function doCombine(statusId, then, anchor = null) {
  await ensureKey();
  if (!shielded.notes.length) await loadShielded();
  const fee = combineFee();
  let r;
  try {
    r = await S.combineNotes(T, { poolWallet, asset: S.TAC_ASSET_MAINNET, anchor, noRelay: fee == null, maxFee: fee, say: (m) => say(statusId, m), askSelf: askSelfPost(statusId) });
  } catch (e) {
    if (e?.feeMoved == null) throw e;
    relayFee = e.feeMoved; renderSendComb();
    throw said(`The relay’s fee changed to ${fmt(e.feeMoved)} TAC. Check it and press again.`);
  }
  if (r.wait) return waitBox(statusId, r, (tip) => doCombine(statusId, then, tip));
  say(statusId, 'Combining: the new note counts after three Bitcoin confirmations, about 30 minutes.', then ? ` ${then} ` : ' ', txLink(r.revealTxid));
  await loadShielded();
}

async function doExit(anchor = null) {
  await ensureKey();
  const amount = parseUnits($('exit-amt').value);
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  if (!shielded.notes.length) await loadShielded();   // a cold unlock has not scanned the pool yet
  if (amount > shieldedTotal()) throw new Error('More than your shielded balance.');
  const r = await S.exitToWallet(T, { poolWallet, amount, asset: S.TAC_ASSET_MAINNET, anchor, say: (m) => say('st-exit', m) });
  if (r.wait) return waitBox('st-exit', r, (tip) => doExit(tip));
  $('exit-amt').value = ''; renderAmountHints();
  say('st-exit', `${fmt(amount)} TAC withdrawn in `, txLink(r.revealTxid), '. The rest stays shielded.');
  try { T.invalidateHoldingsCache?.(); } catch {}
  await loadPublic(); await loadShielded();
}

// Asks before a payment the relay did not take is posted from this wallet's Bitcoin address. It stays on the status line
// until answered, whatever else writes there. "Not now", or ten minutes with no answer, is a no; the relay posting the
// payment meanwhile ends the question.
const askSelfPost = (statusId) => (why, { timedOut = false, signal } = {}) => new Promise((resolve) => {
  const el = $(statusId), box = document.createElement('div'), p = document.createElement('div'), row = document.createElement('div');
  const lead = why === 'relay-slow' ? (timedOut ? 'The relay hasn’t posted it in five minutes.' : 'The relay hasn’t posted it.') : 'The relay didn’t take this payment.';
  p.textContent = `${lead} Post it from your Bitcoin address instead? Your Bitcoin address shows as the sender.`;
  const button = (cls, text, yes) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = text; b.onclick = () => end(yes); return b; };
  row.className = 'row2';
  row.append(button('btn', 'Post it from my Bitcoin address', true), button('btn ghost', 'Not now', false));
  box.append(p, row);
  const keep = new MutationObserver(() => { if (!box.isConnected) el.append(box); });
  const end = (yes) => { clearTimeout(timer); keep.disconnect(); signal?.removeEventListener('abort', no); box.remove(); resolve(yes); };
  const no = () => end(false), timer = setTimeout(no, 10 * 60e3);
  if (signal?.aborted) return no();
  signal?.addEventListener('abort', no);
  say(statusId, box);
  keep.observe(el, { childList: true });
});

// A note younger than the wallet's anchor policy can still be spent — against the newest block instead of a
// settled one — but that tells an observer the note is new. The choice is the wallet owner's, not ours.
function waitBox(statusId, w, retry) {
  const wrap = document.createElement('div');
  const p = document.createElement('div');
  p.textContent = `Your newest note needs ${w.wait} more Bitcoin block${w.wait === 1 ? '' : 's'} (≈ ${w.wait * 10} min) before the wallet will spend it against a settled block.`;
  const row = document.createElement('div');
  row.className = 'row2';
  const now = document.createElement('button');
  now.className = 'btn ghost'; now.textContent = 'Spend now anyway';
  now.onclick = () => busy(now, statusId, () => retry(w.tip));
  const wait = document.createElement('button');
  wait.className = 'btn ghost'; wait.textContent = 'Wait';
  wait.onclick = () => say(statusId, 'Waiting. Try again in a few minutes.');
  row.append(now, wait);
  const why = document.createElement('p');
  why.className = 'note';
  why.textContent = 'Spending now anchors at the newest block, which hints to an observer that the note is fresh.';
  wrap.append(p, row, why);
  say(statusId, wrap);
}

// ── tabs ──
// One tab in the tab order at a time; the arrow keys, Home and End move between them. `user`: picked by a press or a
// key, not by the address bar.
function tabs(ids, panes, onPick) {
  const pick = (i, focus = false, user = false) => {
    ids.forEach((x, j) => {
      const t = $(x);
      t.setAttribute('aria-selected', String(i === j));
      t.tabIndex = i === j ? 0 : -1;
      $(panes[j]).hidden = i !== j;
    });
    if (focus) $(ids[i]).focus();
    onPick?.(i, user);
  };
  ids.forEach((id, i) => {
    $(id).addEventListener('click', () => pick(i, false, true));
    $(id).addEventListener('keydown', (e) => {
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
      if (j === undefined) return;
      e.preventDefault();
      pick((j + ids.length) % ids.length, true, true);
    });
  });
  return pick;
}

async function refreshAll() {
  renderBalances(); paintWallet();
  await Promise.all([loadPublic(), loadShielded()]);
  await recoverExits().catch(() => {});
}

// TAC withdrawn to this wallet that this browser holds no opening for (withdrawn on another device, or before its
// storage was cleared) is opened again from the pool seed, and the public balance read again when any is.
async function recoverExits() {
  if (!unlocked() || !poolWallet || !shielded.notes) return;
  const k = key;
  const h = await T.scanHoldings();
  if (key !== k) return;
  const ghosts = (h instanceof Map ? h.get(S.TAC_ASSET_MAINNET)?.ghosts : null) || [];
  if (!ghosts.length) return;
  const n = await S.recoverExitOpenings(T, { poolWallet, asset: S.TAC_ASSET_MAINNET, utxos: ghosts.map((g) => g.utxo), notes: shielded.notes });
  if (n) { T.invalidateHoldingsCache?.(); await loadPublic(); }
}

// TAC paid to a one-time stealth address does not sit at this wallet's own script, so a plain holdings scan
// never sees it. The worker's transfer index is walked for receipts this key can claim; each one found is
// persisted as a credit that scanHoldings rehydrates from then on. Runs once automatically after unlock and
// on demand, because it is a multi-page walk rather than a single read.
let stealthScanned = false;
async function findStealth({ say: report } = {}) {
  if (!unlocked()) return 0;
  let found = 0;
  try {
    const r = await T.scanAssetForStealthReceipts(S.TAC_ASSET_MAINNET, {
      onProgress: (pr) => report?.(`Checking transfers for payments to you… ${(pr.txsScanned + pr.txsSkipped).toLocaleString('en-US')} seen`),
    });
    found = r?.discovered?.length || 0;
  } catch (e) {
    report?.(`Could not check for stealth payments: ${errText(e)}`);
    return 0;
  }
  stealthScanned = true;
  if (found) {
    try { T.invalidateHoldingsCache?.(); } catch {}
    await loadPublic();
  }
  return found;
}

// Everything this wallet can be paid by: shielded notes in the pool, plain TAC at its own address, and TAC
// sent to a one-time stealth address.
async function scanEverything(statusId = 'st-recv') {
  await ensureKey();
  say(statusId, 'Scanning…');
  const [found] = await Promise.all([
    findStealth({ say: (m) => say(statusId, m) }),
    loadShielded(),
  ]);
  if (!found) await loadPublic();
  const n = (shielded.notes || []).filter((x) => !x.spent && BigInt(x.value) > 0n).length;
  say(statusId, `${n} shielded note${n === 1 ? '' : 's'}${found ? `, and ${found} stealth payment${found === 1 ? '' : 's'} added to your wallet balance` : ', no new stealth payments'}.`);
}

// ── boot ──
// The address bar names the tab in view (#shield, #send, #withdraw, #withdraw/sats, #receive, #market), so a link opens
// it and a reload keeps it. #buy opens the market; a #tacclaim= link is left in the bar as it came.
const TABS = ['shield', 'send', 'withdraw', 'receive', 'market'];
let wTab = 0;
const tabHash = (i) => TABS[i] + (i === 2 && wTab === 1 ? '/sats' : '');
function writeTab(i) {
  if (/tacclaim=/.test(location.hash)) return;
  try { history.replaceState(null, '', `#${tabHash(i)}`); } catch {}
}

// ── claim links ──
// Handing shielded TAC to someone with no wallet: the link carries a throwaway pool wallet, and the
// recipient sweeps it into their own. See tac/claim.js for the wire format and why it is bearer.
let claimMod = null;
const loadClaim = async () => (claimMod ||= await import(CLAIM_URL));

// Every link this device makes, written before its payment goes out and given its link once the payment lands, so a
// tab closed mid-payment does not take the only copy of the secret with it. The PIN is never stored.
const CLAIM_LINKS = 'tacit-tac-claim-links-v1';
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));
function claimLinks() {
  try {
    const v = JSON.parse(localStorage.getItem(CLAIM_LINKS) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && /^[0-9a-f]{64}$/.test(x.secret)) : [];
  } catch { return []; }
}
function writeClaimLinks(list) {
  try { localStorage.setItem(CLAIM_LINKS, JSON.stringify(list)); } catch {}
  renderClaimLinks();
}
const putClaimLink = (rec) => writeClaimLinks([...claimLinks().filter((x) => x.secret !== rec.secret), rec]);
const patchClaimLink = (secret, patch) => writeClaimLinks(claimLinks().map((x) => (x.secret === secret ? { ...x, ...patch } : x)));
const dropClaimLink = (secret) => writeClaimLinks(claimLinks().filter((x) => x.secret !== secret));

function renderClaimLinks() {
  const host = $('claim-links'), list = claimLinks().sort((a, b) => b.at - a.at);
  if (!host) return;
  host.hidden = !list.length;
  $('claim-links-list').replaceChildren(...list.map((rec) => {
    const row = document.createElement('div');
    row.className = 'kv';
    const what = document.createElement('span');
    let amount = '';
    try { amount = `${fmt(rec.amount)} TAC · `; } catch {}
    what.textContent = `${amount}${new Date(rec.at).toLocaleString()}${rec.pinned ? ' · with a PIN' : ''}`;
    const acts = document.createElement('b');
    const act = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'link'; b.textContent = label; b.style.marginLeft = '12px';
      b.onclick = () => fn(b);
      acts.append(b);
      return b;
    };
    if (rec.link) {
      act('copy link', (b) => { navigator.clipboard?.writeText(rec.link); b.textContent = 'copied'; });
    } else {
      let pinField = null;
      if (rec.pinned) {
        pinField = document.createElement('input');
        pinField.autocomplete = 'off'; pinField.inputMode = 'numeric'; pinField.placeholder = 'its PIN';
        pinField.setAttribute('aria-label', 'The PIN you set for this link');
        pinField.className = 'field-in sm';
        acts.append(pinField);
      }
      act('find the link', (b) => busy(b, 'st-claim-links', () => findClaimLink(rec, pinField ? pinField.value.trim() : '')));
    }
    act('forget', () => {
      if (!confirm(rec.link ? 'Forget this link on this device? Anyone who already has it can still claim it.' : 'Forget this link? This device keeps the only copy of its secret.')) return;
      dropClaimLink(rec.secret);
    });
    row.append(what, acts);
    return row;
  }));
}

// A link whose payment was cut short: its note is found under the link's own pool wallet, and the note's
// transaction completes the link.
async function findClaimLink(rec, pin) {
  await loadTacit();
  const C = await loadClaim();
  if (rec.pinned && !pin) throw new Error('Enter the PIN you set for this link.');
  const secret32 = fromHex(rec.secret);
  say('st-claim-links', 'Looking for its payment…');
  const notes = await S.poolNotes(C.claimPoolWallet(S.pool, secret32, { pin, network: rec.network }), S.TAC_ASSET_MAINNET);
  const n = notes.find((x) => x.txid && BigInt(x.value) > 0n);
  if (!n) {
    return say('st-claim-links', rec.pinned
      ? 'Nothing under this link yet. Check the PIN, or try again in a few blocks.'
      : 'Nothing under this link yet. Try again in a few blocks. A payment that never went out left the TAC in your shielded balance.');
  }
  patchClaimLink(rec.secret, { txid: n.txid, link: C.claimUrl(location.origin, C.encodeClaim({ secret32, txid: n.txid, network: rec.network, pinned: rec.pinned })) });
  say('st-claim-links', 'Found. Copy the link above.');
}

async function makeClaimLink() {
  await ensureKey();
  const C = await loadClaim();
  const amount = parseUnits($('claim-amt').value);
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  if (!shielded.notes.length) await loadShielded();
  if (amount + relayFeeUnits() > shieldedTotal()) throw new Error('More than your shielded balance.');
  const pin = $('claim-pin').value.trim();
  let secret = null;
  const r = await C.createClaim(T, {
    S, pool: S.pool, poolWallet, amount, asset: S.TAC_ASSET_MAINNET, pin, network: 'mainnet',
    say: (m) => say('st-claim-make', m), askSelf: askSelfPost('st-claim-make'),
    keep: ({ secret32, pinned, network }) => {
      secret = toHex(secret32);
      putClaimLink({ secret, pinned, network, amount: amount.toString(), at: Date.now() });
    },
  });
  if (r.wait) {
    if (secret) dropClaimLink(secret);
    return say('st-claim-make', `Your newest note needs ${r.wait} more Bitcoin block${r.wait === 1 ? '' : 's'} first.`);
  }
  if (secret) patchClaimLink(secret, { txid: r.revealTxid, link: r.link });
  $('claim-amt').value = ''; $('claim-pin').value = '';
  const box = document.createElement('div');
  const field = document.createElement('input');
  field.readOnly = true; field.value = r.link; field.setAttribute('aria-label', 'Claim link');
  field.className = 'field-in out';
  const copy = document.createElement('button');
  copy.className = 'btn ghost'; copy.textContent = 'Copy the link';
  copy.onclick = () => { navigator.clipboard?.writeText(r.link); copy.textContent = 'Copied'; };
  box.append(document.createTextNode(`${fmt(amount)} TAC is under this link. Anyone who opens it can take it${pin ? ', with the PIN' : ''}.`), field, copy);
  say('st-claim-make', box);
  await loadShielded();
}

// A link in the address bar takes over the top of the page.
async function showClaim(payload) {
  const host = $('claim-body'); const panel = $('claim-panel');
  panel.hidden = false;
  host.textContent = 'Reading the link…';
  let C, parsed;
  try { [C] = await Promise.all([loadClaim(), loadSecret()]); parsed = C.decodeClaim(payload); }
  catch (e) { host.textContent = ''; return errSayInto(host, e); }
  if (parsed.network !== 'mainnet') { host.textContent = 'That link is for another network.'; return; }

  const pinField = document.createElement('input');
  pinField.placeholder = 'PIN'; pinField.autocomplete = 'off'; pinField.inputMode = 'numeric';
  pinField.setAttribute('aria-label', 'PIN');
  pinField.className = 'field-in';
  const line = document.createElement('div'); line.className = 'kv';
  const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = 'Claim into my wallet';
  const st = document.createElement('div'); st.className = 'status'; st.id = 'st-claim'; st.setAttribute('role', 'status');

  async function refresh() {
    line.replaceChildren(document.createTextNode('Checking…'));
    try {
      const r = await C.readClaim(S, S.pool, { secret32: parsed.secret32, pin: pinField.value.trim(), network: 'mainnet', asset: S.TAC_ASSET_MAINNET });
      line.replaceChildren(
        Object.assign(document.createElement('span'), { textContent: r.total > 0n ? 'Waiting for you' : 'Nothing under this link' }),
        Object.assign(document.createElement('b'), { className: 'num', textContent: r.total > 0n ? `${fmt(r.total)} TAC${satsText(r.total) ? ' · ' + satsText(r.total) : ''}` : parsed.pinned ? 'check the PIN' : 'already claimed' }));
      btn.disabled = r.total <= 0n;
    } catch (e) { line.replaceChildren(); errSayInto(line, e); }
  }

  btn.onclick = () => busy(btn, 'st-claim', async () => {
    await loadTacit();
    if (!unlocked() && !knownWallet()) {
      openWallet();
      say('st-claim', 'Sign in first: the TAC moves into your wallet. Then press Claim again.');
      return;
    }
    await ensureKey();
    const r = await C.sweepClaim(T, {
      S, pool: S.pool, secret32: parsed.secret32, pin: pinField.value.trim(), network: 'mainnet',
      asset: S.TAC_ASSET_MAINNET, toAddress: poolWallet.addressString, fmt, say: (m) => { st.textContent = m; }, askSelf: askSelfPost('st-claim'),
    });
    if (r.wait) { st.textContent = `The note needs ${r.wait} more Bitcoin block${r.wait === 1 ? '' : 's'} before it can move.`; return; }
    st.replaceChildren(document.createTextNode('Claimed into your wallet in '), txLink(r.revealTxid), document.createTextNode(r.relayed ? ' — the fee came out of the TAC, so this cost you no bitcoin.' : '.'));
    await refreshAll();
    await refresh();
  });

  host.replaceChildren(
    Object.assign(document.createElement('p'), { className: 'note', style: 'margin-top:0', textContent: parsed.pinned ? 'This link is PIN-protected. Enter the PIN you were given.' : 'This link holds shielded TAC. Claiming moves it into a wallet only you control.' }),
    ...(parsed.pinned ? [pinField] : []), line, btn, st);
  if (parsed.pinned) pinField.addEventListener('input', () => { clearTimeout(showClaim._t); showClaim._t = setTimeout(refresh, 400); });
  await refresh();
}

function errSayInto(host, e) {
  const span = document.createElement('span');
  span.className = 'err'; span.setAttribute('role', 'alert');
  span.textContent = errText(e);
  host.append(span);
}

// ── market ──
// Lazy: the Bitcoin book and an Ethereum pool read are both off this page's critical path.
let marketMounted = false;
function renderMarket() {
  if (marketMounted) return;
  marketMounted = true;
  import(MARKET_URL)
    .then((m) => m.mount($('market-body'), {
      markSats, get T() { return T; }, unlocked, ensureKey, turn, busy, say, errSay, errText, said, txLink, refresh: () => loadPublic(),
    }))
    .catch((e) => { marketMounted = false; $('market-body').replaceChildren(); errSay('st-recv', e); });
}

// ── withdraw to sats ──
function renderSats() {
  const host = $('sats-body');
  if (host.dataset.ready) return;
  host.dataset.ready = '1';
  import(SATS_URL).then((m) => m.mount(host, {
    get T() { return T; }, get S() { return S; }, get poolWallet() { return poolWallet; },
    get markSats() { return markSats; },
    ensureKey, busy, say, errSay, fmt, parseUnits, shieldedTotal, txLink, loadShielded,
  })).catch((e) => { host.textContent = ''; errSay('st-exit', e); });
}

// Boot, last: the fragment is opened at once, and a claim link or #market reaches declarations above.
(async function boot() {
  let mainTab = 0;
  const pickMain = tabs(TABS.map((t) => `tab-${t}`), TABS.map((t) => `pane-${t}`),
    (i, user) => {
      mainTab = i;
      if (i === 1) renderClaimLinks();
      if (i === 3) paintReceive();
      if (i === 4) renderMarket();
      if (user) writeTab(i);
    });
  const pickW = tabs(['wtab-self', 'wtab-sats'], ['wpane-self', 'wpane-sats'], (i, user) => {
    wTab = i;
    if (i === 1) renderSats();
    if (user) writeTab(mainTab);
  });

  watchPassphrase();
  $('wallet-chip').onclick = async () => { await loadTacit(); openWallet(); };
  $$('[data-close]').forEach((b) => b.onclick = () => b.closest('dialog').close());
  $$('dialog.sheet').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  $('btn-refresh').onclick = (e) => busy(e.currentTarget, 'st-recv', () => scanEverything('st-recv'));

  $('btn-shield').onclick = (e) => busy(e.currentTarget, 'st-shield', doShield);
  $('btn-send').onclick = (e) => busy(e.currentTarget, 'st-send', () => doSend());
  $('btn-exit').onclick = (e) => busy(e.currentTarget, 'st-exit', () => doExit());
  $('send-amt').addEventListener('input', () => { renderAmountHints(); renderSendComb(); });
  $('exit-amt').addEventListener('input', renderAmountHints);
  // "max" before the pool scan has run would otherwise quietly write 0 and look like an empty balance.
  const maxInto = (field, statusId) => async () => {
    await ensureKey();
    if (!shielded.notes.length && !shielded.loading) await loadShielded();
    const total = shieldedTotal() - (field === 'send-amt' ? relayFeeUnits() : 0n);
    if (total <= 0n) return say(statusId, 'Nothing shielded yet — shield some TAC first.');
    $(field).value = fmtPlain(total);
    $(field).dispatchEvent(new Event('input', { bubbles: true }));
    say(statusId, '');
  };
  $('send-max').onclick = () => maxInto('send-amt', 'st-send')().catch((e) => errSay('st-send', e));
  $('exit-max').onclick = () => maxInto('exit-amt', 'st-exit')().catch((e) => errSay('st-exit', e));
  $('btn-copy').onclick = () => {
    if (!poolWallet) return say('st-recv', 'Open your wallet first: your pool address is derived from its key.');
    navigator.clipboard?.writeText(poolWallet.addressString);
    say('st-recv', 'Pool address copied.');
  };
  $('btn-copy-tacit').onclick = () => {
    if (!poolWallet) return say('st-recv', 'Open your wallet first: your Tacit address is derived from its key.');
    if (!tacitAddress) return say('st-recv', tacitAddress === false ? 'Your Tacit address could not be derived here. Copy the pool address instead.' : 'Still deriving your Tacit address. Try again in a moment, or copy the pool address.');
    navigator.clipboard?.writeText(tacitAddress);
    say('st-recv', 'Tacit address copied.');
  };
  $('btn-claim-make').onclick = (e) => busy(e.currentTarget, 'st-claim-make', makeClaimLink);
  $('claim-amt').addEventListener('input', () => {
    let u = 0n; try { u = parseUnits($('claim-amt').value); } catch {}
    $('claim-sats').textContent = u > 0n ? satsText(u) : '';
  });
  $('btn-scan').onclick = (e) => busy(e.currentTarget, 'st-recv', () => scanEverything('st-recv'));

  // Also on hashchange: opening a claim link while this page is already loaded changes only the fragment,
  // which is a same-document navigation — boot does not run again and the link would be ignored.
  const openFrag = () => {
    const frag = location.hash || '';
    if (/tacclaim=/.test(frag)) { showClaim(frag).catch((e) => console.warn('[tac] claim link', e)); return; }
    const [area, view] = lc(frag.replace(/^#/, '')).split(/[/&]/);
    const i = TABS.indexOf(area === 'buy' ? 'market' : area);          // #buy: the market, where TAC is bought with sats
    if (i < 0) return;
    if (i === 2) pickW(view === 'sats' ? 1 : 0);
    pickMain(i);
  };
  window.addEventListener('hashchange', openFrag);
  openFrag();

  // The strip and the mark price load alongside tacit.js; neither needs it.
  const early = Promise.all([loadStats(), loadPrice()]);
  await loadTacit();
  renderClaimLinks();
  paintWallet(); renderBalances(); renderShieldPicker();
  await early;
  if (unlocked()) await refreshAll();
})();
