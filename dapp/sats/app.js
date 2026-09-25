// Secret Sats page. The landing copy is static; everything that touches a key
// or the chain comes from ../tacit.js, imported only once the user connects.

const TACIT_URL = '/tacit.js?cb=5c98d635';
const SECRET_URL = '/sats/secret.js?cb=e5fb1df1';
const POOL_STATUS = 'https://tacit-btc-pool.onrender.com/btc-pool/status';

// tacit.js reads its network from this shared key once, at import. This page
// defaults to signet under its own key, writes the shared one just before the
// import, and puts the previous value back when the page goes away so the main
// app keeps the network its user chose.
const NET_PREF = 'tacit-sats-net-v1';
const SHARED_NET = 'tacit-network-v1';
const PREV_NET = 'tacit-sats-prev-net-v1';
// This page's own record of how the user signed in, per network. The main
// app's linked-wallet caches hold one identity for whichever network it last
// used, and the derived key differs per network, so the page never reads its
// identity from them and puts them back after any call that rewrites them.
const SESSION = 'tacit-sats-session-v1';
const IDENTITY = (net) => `tacit-sats-id-v1:${net}`;
const SHARED_WALLET_KEYS = ['tacit-eth-identity', 'tacit-btc-identity', 'tacit-active-mode-v1', 'tacit-ext-mode-v1', 'tacit-ext-state-v1'];
// Silent-payment tweak index per network. The wallet fetches public tweaks
// and matches them locally; the index never sees a key.
const SP_INDEX_URL = { signet: 'https://tacit-sp-index.onrender.com', mainnet: null };
const DUST = 546;
const POLL_MS = 20_000;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, s = localStorage) { try { return s.getItem(k); } catch { return null; } },
  set(k, v, s = localStorage) { try { s.setItem(k, v); } catch {} },
  del(k, s = localStorage) { try { s.removeItem(k); } catch {} },
  json(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
};

let T = null;
let loading = null;
let scanAbort = null;
const listeners = new Set();

// ---------- small helpers ----------

function log(msg, kind = '') {
  const el = $('log');
  if (!msg) { el.replaceChildren(); return; }
  const line = document.createElement('div');
  if (kind === 'error') line.className = 'err';
  line.textContent = String(msg);
  el.prepend(line);
  while (el.children.length > 3) el.lastChild.remove();
}

function show(id, on) { $(id).classList.toggle('hidden', !on); }

function short(s, n = 10) { return s && s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || ''; }

function fmtSats(n) { return `${Number(n).toLocaleString('en-US')} sats`; }

function fmtUnits(units, decimals = 8) {
  const neg = units < 0n; const s = (neg ? -units : units).toString().padStart(decimals + 1, '0');
  const out = decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, '') : s;
  return (neg ? '-' : '') + out;
}

async function copy(text) {
  if (!text || text === '—') return;
  try { await navigator.clipboard.writeText(text); log('Copied.'); }
  catch { log('Clipboard blocked. Select the text and copy it.', 'error'); }
}

// Errors meant for the user as written (bad input, not enough sats); not logged to the console.
function fail(msg) { const e = new Error(msg); e.user = true; return e; }

function isCancel(e) { return !!(e && (e.unlockCancelled || e.name === 'UnlockCancelled' || e.message === 'cancelled')); }

// One line, no stack, no JSON dumps from wallet libraries.
function errMsg(e) {
  if (isCancel(e)) return 'Cancelled.';
  if (e?.name === 'NotAllowedError') return 'Cancelled.';
  let m = String(e?.message || e || 'Something went wrong.');
  if (/user (rejected|denied|cancel)|rejected by user|request rejected|4001/i.test(m)) return 'Cancelled in your wallet.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Network request failed. Check your connection and try again.';
  m = m.split('\n')[0];
  return m.length > 240 ? m.slice(0, 237) + '…' : m;
}

// Runs fn with every button in `btns` disabled; the error goes to `out`
// (a section's output line) or the wallet log.
let working = 0;
async function busy(btns, fn, out = null) {
  btns = (Array.isArray(btns) ? btns : [btns]).filter(Boolean);
  if (btns.some((b) => b.dataset.busy === '1')) return;
  const prev = btns.map((b) => b.disabled);
  btns.forEach((b) => { b.disabled = true; b.dataset.busy = '1'; });
  working++;
  try { return await fn(); }
  catch (e) {
    const m = errMsg(e);
    if (out) { out.replaceChildren(); const s = document.createElement('span'); s.className = isCancel(e) ? '' : 'err'; s.textContent = m; out.append(s); }
    else log(m, isCancel(e) ? '' : 'error');
    if (!isCancel(e) && !e?.user) console.warn('[sats]', e);
  }
  finally { working--; btns.forEach((b, i) => { b.disabled = prev[i]; delete b.dataset.busy; }); }
}

// ---------- network ----------

function parseHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const sp = (h.get('sp') || '').toLowerCase();
  const net = h.get('net');
  return { sp: /^[0-9a-f]{64}$/.test(sp) ? sp : null, net: net === 'mainnet' || net === 'signet' ? net : null };
}

function netPref() { return store.get(NET_PREF) === 'mainnet' ? 'mainnet' : 'signet'; }
function curNet() { return T ? T.NET.name : netPref(); }

function claimSharedNet() {
  if (store.get(PREV_NET, sessionStorage) === null) {
    store.set(PREV_NET, store.get(SHARED_NET) ?? '', sessionStorage);
  }
  store.set(SHARED_NET, netPref());
}

function releaseSharedNet() {
  const prev = store.get(PREV_NET, sessionStorage);
  if (prev === null) return;
  if (prev === '') store.del(SHARED_NET); else store.set(SHARED_NET, prev);
  store.del(PREV_NET, sessionStorage);
}

function switchNet(net) {
  store.set(NET_PREF, net);
  if (!T) { renderNet(); probeIndex(); refreshCreateLabel(); resume(); return; }
  releaseSharedNet();
  // A #…&net= in the URL would switch the page straight back on reload.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  location.reload();
}

function renderNet() {
  const net = curNet();
  for (const b of document.querySelectorAll('#net [data-net]')) b.setAttribute('aria-pressed', String(b.dataset.net === net));
  show('mainnet-note', net === 'mainnet');
  renderScan();
  $('to-label').textContent = net === 'mainnet'
    ? 'To: a bc1q… address or a silent address (sp1…)'
    : 'To: a tb1q… address or a silent address (tsp1…)';
  const ph = $('secret-placeholder');
  if (ph) show('secret-steps', net !== 'mainnet');
  if (ph) ph.textContent = net === 'mainnet'
    ? 'The private pool runs on signet. Switch the wallet to signet to try it.'
    : 'Connect a wallet above to start. Each step is one signet transaction.';
}

// Scan is offered when this network has an index and it answered.
const indexState = { net: null, tip: null, ok: false };
async function probeIndex() {
  const net = curNet();
  const url = SP_INDEX_URL[net];
  indexState.net = net; indexState.ok = false; indexState.tip = null;
  if (url) {
    try {
      const r = await fetch(`${url}/sp/tip`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      const j = r.ok ? await r.json() : null;
      if (curNet() !== net) return;
      if (Number.isInteger(j?.height)) { indexState.ok = true; indexState.tip = j.height; }
    } catch {}
  }
  renderScan();
}

function renderScan() {
  const on = indexState.ok && indexState.net === curNet();
  show('btn-scan', on);
  const last = on && T?.wallet.pub ? T.spIndexLastScanned() : null;
  $('scan-depth').textContent = !on ? '' : last ? `new blocks since ${last}` : 'about the last week of blocks';
  $('receive-note').textContent = on
    ? 'Payments to your silent address can’t be looked up by address. Scan to find them: this device checks every recent payment itself, so the index never learns which are yours. A payment link or txid works too.'
    : 'Payments to your silent address can’t be looked up by address. To find one, paste its payment link or txid here.';
}

// ---------- tacit.js ----------

function loadTacit() {
  if (T) return Promise.resolve(T);
  if (!loading) {
    log('Loading wallet…');
    claimSharedNet();
    globalThis.__TACIT_NO_INIT__ = true;
    loading = import(TACIT_URL).then((m) => {
      T = m;
      log('');
      renderNet();
      mountSecret();
      return m;
    }).catch((e) => {
      loading = null;
      releaseSharedNet();
      throw fail('Could not load the wallet code. Reload and try again. (' + errMsg(e) + ')');
    });
  }
  return loading;
}

// Run a call that may rewrite the main app's linked-wallet caches, then put
// them back as they were.
async function keepShared(fn) {
  const snap = SHARED_WALLET_KEYS.map((k) => [k, store.get(k)]);
  try { return await fn(); }
  finally { for (const [k, v] of snap) (v === null ? store.del(k) : store.set(k, v)); }
}

function saveIdentity(rec) { store.set(IDENTITY(T.NET.name), JSON.stringify(rec)); store.set(SESSION, '1'); }
function readIdentity() { return store.json(IDENTITY(curNet())); }

function blobPub(boundAddr = null) {
  const key = `tacit-wallet-v1:${T.NET.name}${boundAddr ? `:by:${boundAddr.toLowerCase()}` : ''}`;
  try {
    const j = JSON.parse(store.get(key) || 'null');
    return j && /^0[23][0-9a-f]{64}$/.test(j.pub || '') ? T.hexToBytes(j.pub) : null;
  } catch { return null; }
}

function hasLocalWallet() {
  return !!store.get(`tacit-wallet-v1:${netPref()}`);
}

// Rehydrate a previous session from public data only; the key unlocks at the
// first action that signs.
function restore() {
  const w = T.wallet;
  const rec = readIdentity();
  if (!rec) return false;
  const okPub = (h) => /^0[23][0-9a-f]{64}$/.test(h || '');
  if (rec.mode === 'eth' && okPub(rec.pubkey) && rec.address) {
    T.ethWallet.state = { address: rec.address, pubkey: rec.pubkey };
    w.pub = T.hexToBytes(rec.pubkey); w.mode = 'eth';
  } else if (rec.mode === 'btc' && okPub(rec.btc?.tacitPubkey) && rec.ext?.address) {
    T.btcWallet.state = rec.btc; T.extWallet.state = rec.ext;
    w.pub = T.hexToBytes(rec.btc.tacitPubkey); w.mode = 'btc';
  } else if (rec.mode === 'ext' && rec.ext?.address) {
    const pub = blobPub(rec.ext.address);
    if (pub) { T.extWallet.state = rec.ext; w.pub = pub; w.mode = null; }
  } else if (rec.mode === 'local') {
    const pub = blobPub();
    if (pub) { w.pub = pub; w.mode = null; }
  }
  return !!w.pub;
}

async function ensureKey() {
  if (!T?.wallet.pub) throw fail('Connect a wallet first.');
  if (T.wallet.priv) return;
  await keepShared(() => T.ensurePrivkey());
  unlocked();
}

// ---------- wallet paths ----------

function connectButtons() { return [$('btn-create'), $('btn-btc'), $('btn-eth'), ...$('btc-choices').querySelectorAll('button')]; }

async function createWallet() {
  await loadTacit();
  const existed = !!blobPub();
  T.extWallet.state = null;
  T.wallet.mode = null;
  await T.wallet.load();
  saveIdentity({ mode: 'local' });
  log(existed ? 'Wallet unlocked.' : 'Wallet created. Back up its key.');
  await connected();
  if (!isBackedUp()) openBackup();
}

function btcChoices() {
  const box = $('btc-choices');
  box.replaceChildren();
  const av = T.extWallet.available();
  const add = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn quiet';
    b.textContent = label;
    b.onclick = () => busy(connectButtons(), () => linkBtc(fn));
    box.append(b);
  };
  if (av.unisat) add('UniSat', () => T.extWallet.connectUnisat());
  if (av.satsConnect) add('Xverse · Leather · OKX', () => T.extWallet.connectSatsConnect());
  if (!box.children.length) {
    const p = document.createElement('span');
    p.className = 'muted';
    p.textContent = 'No Bitcoin wallet found in this browser. Install UniSat, Xverse, Leather or OKX, or create a Tacit wallet instead.';
    box.append(p);
  }
  show('btc-choices', true);
}

function assertWalletNet(st) {
  const addr = String(st.address || '').toLowerCase();
  const want = T.NET.name;
  const isMain = addr.startsWith('bc1') || /^[13]/.test(addr);
  if ((want === 'mainnet') !== isMain) {
    T.extWallet.state = null;
    throw fail(`Your wallet is on ${isMain ? 'mainnet' : 'a test network'}. Switch it to ${want}, or switch this page.`);
  }
}

async function linkBtc(connect) {
  await keepShared(async () => {
    T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null;
    const st = await connect();
    assertWalletNet(st);
    const ext = { ...T.extWallet.state };
    // A key this page enrolled before for this address needs one signature;
    // a new one needs two (the second proves the wallet signs the same way).
    const prev = readIdentity();
    T.btcWallet.state = prev?.mode === 'btc' && prev.btc?.address === st.address ? prev.btc : null;
    try {
      if (T.btcWallet.state) await T.btcWallet.login(); else await T.btcWallet.enroll();
      saveIdentity({ mode: 'btc', btc: T.btcWallet.state, ext });
      log('Linked. Your Tacit key comes from your wallet’s signature.');
    } catch (e) {
      if (!e?._btcNonDeterministic) { T.extWallet.state = null; throw e; }
      log('This wallet signs differently each time, so it funds a Tacit key kept in this browser instead.');
      T.btcWallet.state = null;
      T.extWallet.state = ext;
      T.wallet.mode = null;
      await T.wallet.load(st.address);
      saveIdentity({ mode: 'ext', ext });
    }
  });
  show('btc-choices', false);
  await connected();
  if (!isBackedUp()) openBackup();
}

async function linkEth() {
  await loadTacit();
  if (!T.ethWallet.available()) throw fail('No Ethereum wallet found in this browser.');
  await keepShared(async () => {
    T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null;
    T.ethWallet.state = null;
    const prev = readIdentity();
    await T.ethWallet.login();
    if (prev?.mode === 'eth' && prev.address === T.ethWallet.state.address && prev.pubkey !== T.ethWallet.state.pubkey) {
      T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null;
      throw fail('This account signed differently than last time, so it would open a different wallet. Nothing was changed.');
    }
    saveIdentity({ mode: 'eth', address: T.ethWallet.state.address, pubkey: T.ethWallet.state.pubkey });
  });
  log('Linked. Same key as on tacit.finance.');
  await connected();
}

function via() {
  const w = T.wallet;
  if (w.mode === 'eth') return `Ethereum 0x${short(T.ethWallet.state?.address || '', 6)}`;
  if (w.mode === 'btc') return `Bitcoin wallet ${short(T.btcWallet.state?.address || '', 6)}`;
  if (w.ext?.address) return `Tacit key, funded by ${short(w.ext.address, 6)}`;
  return 'Tacit key in this browser';
}

function isBackedUp() {
  const w = T.wallet;
  if (w.mode === 'eth' || w.mode === 'btc' || w.mode === 'passkey') return true;
  return store.get('tacit-backup-ack-v1:' + T.bytesToHex(w.pub)) === '1';
}

function openBackup() {
  if (!T.wallet.priv) return;
  $('backup-key').textContent = T.bytesToHex(T.wallet.priv);
  show('backup', true);
}

function spCacheKey() { return `tacit-sats-sp-v2:${T.NET.name}:${T.bytesToHex(T.wallet.pub)}`; }

function silentAddress() {
  if (T.wallet.priv) {
    const a = T.walletSilentPaymentAddress();
    store.set(spCacheKey(), a);
    return a;
  }
  return store.get(spCacheKey());
}

async function connected() {
  show('connect', false);
  show('btc-choices', false);
  show('connected', true);
  show('send', true);
  show('receive', true);
  renderActivity();
  renderScan();
  await refresh();
  startPoll();
  checkHashPayment();
}

function unlocked() {
  renderIdentity();
  refreshAssets();
  checkHashPayment();
  emit();
}

function renderIdentity() {
  const w = T.wallet;
  if (!w.pub) return;
  const addr = w.address();
  $('w-via').textContent = via();
  $('w-addr').textContent = addr;
  $('view-addr').href = `${T.NET.explorer}/address/${addr}`;
  const sp = silentAddress();
  const spEl = $('w-sp');
  spEl.textContent = sp ? short(sp, 14) : 'unlock to show';
  spEl.title = sp || '';
  if (sp) spEl.dataset.full = sp; else delete spEl.dataset.full;
  show('copy-sp-wrap', !!sp);
  show('btn-unlock', !w.priv);
  show('btn-fund', !!w.ext);
  show('btn-backup', !(w.mode === 'eth' || w.mode === 'btc'));
}

let satsTotal = null;
async function refresh() {
  const w = T?.wallet;
  if (!w?.pub) return;
  renderIdentity();
  renderFound();
  emit();
  if (satsTotal === null) $('w-bal').textContent = '…';
  await refreshSats();
  refreshAssets();
}

// Plain sats: UTXOs above the dust band at the wallet address, plus silent
// payments found for this wallet that are still unspent. Dust-band outputs
// are token notes and are shown under tokens instead.
async function refreshSats() {
  const w = T.wallet;
  try {
    const utxos = await T.getUtxos(w.address());
    let conf = 0, pend = 0;
    for (const u of utxos || []) {
      if ((u.value || 0) <= DUST) continue;
      if (u.status?.confirmed) conf += u.value; else pend += u.value;
    }
    const silent = await unspentSilent();
    let txt = fmtSats(conf);
    if (pend) txt += ` · ${fmtSats(pend)} unconfirmed`;
    if (silent) txt += ` · ${fmtSats(silent)} in silent payments`;
    $('w-bal').textContent = txt;
    satsTotal = conf + pend + silent;
    show('faucet-hint', T.NET.name === 'signet' && satsTotal === 0);
  } catch (e) {
    $('w-bal').textContent = 'unavailable · try Refresh';
    log('Balance lookup failed: ' + errMsg(e), 'error');
  }
  emit();
}

const spentChecked = new Map();
async function unspentSilent() {
  const credits = Object.entries(T.loadSpCredits() || {});
  let sum = 0;
  for (const [key, c] of credits) {
    const [txid, vout] = key.split(':');
    let spent = spentChecked.get(key);
    if (spent === undefined) {
      try { spent = !!(await getJson(`/tx/${txid}/outspend/${vout}`)).spent; } catch { spent = false; }
      if (spent) spentChecked.set(key, true);
    }
    if (!spent) sum += Number(c.sats || 0);
  }
  return sum;
}

// Token balances need the unlocked key (amounts are hidden on chain).
let assetsBusy = false;
async function refreshAssets() {
  const w = T?.wallet;
  if (!w?.priv || assetsBusy) { if (w && !w.priv) { show('w-assets-row', true); $('w-assets').textContent = 'unlock to show'; } return; }
  assetsBusy = true;
  show('w-assets-row', true);
  if (!$('w-assets').dataset.known) $('w-assets').textContent = '…';
  try {
    const h = await T.scanHoldings();
    const rows = [];
    for (const x of (h instanceof Map ? h.values() : [])) {
      const bal = typeof x.balance === 'bigint' ? x.balance : 0n;
      if (bal <= 0n) continue;
      rows.push(`${fmtUnits(bal, Number.isInteger(x.decimals) ? x.decimals : 0)} ${x.ticker || short(x.assetIdHex, 4)}`);
    }
    $('w-assets').textContent = rows.length ? rows.join(' · ') : 'none';
    $('w-assets').dataset.known = '1';
  } catch (e) {
    $('w-assets').textContent = 'unavailable · try Refresh';
    console.warn('[sats] holdings', e);
  } finally { assetsBusy = false; emit(); }
}

async function unlock() {
  await ensureKey();
  await refresh();
}

function signOut() {
  if (scanAbort) scanAbort.abort();
  stopPoll();
  const w = T.wallet;
  w.priv = null; w.pub = null; w.mode = null;
  T.extWallet.state = null; T.ethWallet.state = null; T.btcWallet.state = null;
  store.del(SESSION);
  satsTotal = null;
  show('connected', false); show('send', false); show('receive', false);
  show('backup', false); show('share', false); show('fund-row', false);
  show('connect', true);
  $('backup-key').textContent = '—';
  $('found').replaceChildren();
  $('send-out').textContent = ''; $('scan-out').textContent = '';
  delete $('w-assets').dataset.known;
  refreshCreateLabel();
  emit();
  log('Signed out on this page. Your key stays where it was.');
}

async function fund() {
  const n = Math.floor(Number($('fund-amt').value));
  if (!Number.isFinite(n) || n < DUST) throw fail(`Enter at least ${DUST} sats.`);
  if (T.NET.name === 'mainnet' && !confirm(`Move ${fmtSats(n)} of real bitcoin from your linked wallet?`)) return;
  const txid = await T.extWallet.sendSats(T.wallet.address(), n);
  track(txid, `Funded ${fmtSats(n)}`);
  $('fund-amt').value = '';
  show('fund-row', false);
  log('Funding sent.');
  setTimeout(refreshSats, 3000);
}

// Signet sats from the demo faucet, to the wallet address.
async function faucetSats() {
  if (!T?.wallet.pub) throw fail('Connect a wallet first.');
  if (T.NET.name !== 'signet') throw fail('The faucet pays signet sats only.');
  const { FAUCET_URL } = await import(SECRET_URL);
  let r;
  try {
    r = await fetch(`${FAUCET_URL}/faucet/sats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: T.wallet.address() }) });
  } catch { throw fail('The faucet is unreachable. Try signetfaucet.com.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.txid) throw fail(j.error ? `Faucet: ${j.error}` : `Faucet unavailable (HTTP ${r.status}). Try signetfaucet.com.`);
  track(j.txid, 'Signet sats from the faucet');
  log(`Sent ${fmtSats(j.sats || 10000)} to your address. It counts right away, unconfirmed.`);
  await refresh();
}

// ---------- activity (this page's transactions, with confirmation status) ----------

function activityKey() { return `tacit-sats-activity-v1:${T.NET.name}:${T.bytesToHex(T.wallet.pub)}`; }
function loadActivity() { const a = T?.wallet.pub ? store.json(activityKey()) : null; return Array.isArray(a) ? a : []; }
function saveActivity(a) { store.set(activityKey(), JSON.stringify(a.slice(0, 8))); }

function track(txid, label) {
  if (!T?.wallet.pub || !/^[0-9a-f]{64}$/.test(txid || '')) return;
  const a = loadActivity().filter((x) => x.txid !== txid);
  a.unshift({ txid, label, height: null, t: Date.now() });
  saveActivity(a);
  renderActivity();
  startPoll();
}

function renderActivity() {
  const ol = $('activity');
  const a = T?.wallet.pub ? loadActivity() : [];
  ol.replaceChildren();
  for (const x of a) {
    const li = document.createElement('li');
    const l = document.createElement('span');
    l.append(`${x.label} · `, txLink(x.txid, 8));
    const r = document.createElement('span');
    r.textContent = x.height ? `block ${x.height}` : x.dropped ? 'not found' : 'unconfirmed';
    li.append(l, r);
    ol.append(li);
  }
  show('activity', a.length > 0);
}

let pollTimer = null;
let pollN = 0;
function startPoll() { if (!pollTimer && T?.wallet.pub) pollTimer = setInterval(poll, POLL_MS); }
function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

async function poll() {
  if (document.hidden || !T?.wallet.pub || working) return;
  pollN++;
  const a = loadActivity();
  let changed = false;
  for (const x of a) {
    if (x.height || x.dropped) continue;
    try {
      const st = await getJson(`/tx/${x.txid}/status`);
      if (st?.confirmed) { x.height = st.block_height; changed = true; }
    } catch (e) {
      // Not found for 30 minutes: stop polling it.
      if (/^404 /.test(e.message) && Date.now() - x.t > 30 * 60_000) { x.dropped = true; changed = true; }
    }
  }
  if (changed) { saveActivity(a); renderActivity(); await refresh(); return; }
  // Keep an empty or unconfirmed wallet's balance live (faucet payouts), and
  // everything else fresh every few minutes.
  if (satsTotal === 0 || a.some((x) => !x.height && !x.dropped) || pollN % 9 === 0) await refreshSats();
}

// ---------- send ----------

function isSilent(addr) { return /^t?sp1/i.test(addr); }

function shareUrl(txid) {
  const base = /^https?:$/.test(location.protocol) ? location.origin + location.pathname : 'https://tacit.finance/sats/';
  return `${base}#sp=${txid}&net=${T.NET.name}`;
}

function txLink(txid, n = 10) {
  const a = document.createElement('a');
  a.href = `${T.NET.explorer}/tx/${txid}`;
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = short(txid, n);
  return a;
}

function checkRecipient(to) {
  const net = T.NET.name;
  const sp = T.decodeSilentPaymentAddress(to);
  if (sp) {
    if (sp.network !== net) throw fail(`That silent address is for ${sp.network}; this page is on ${net}.`);
    return true;
  }
  const hrp = net === 'mainnet' ? 'bc' : 'tb';
  const d = T.decodeP2wpkhAddress(to) || T.decodeP2trAddress(to);
  if (!d) throw fail(`Enter a ${hrp}1q… or ${hrp}1p… address, or a silent address (${net === 'mainnet' ? 'sp1' : 'tsp1'}…).`);
  if (d.hrp !== T.NET.hrp) throw fail(`That address is for ${d.hrp === 'bc' ? 'mainnet' : 'another network'}; this page is on ${net}.`);
  return false;
}

async function send() {
  const out = $('send-out');
  const to = $('to').value.trim();
  const amt = Math.floor(Number($('amt').value));
  if (!to) throw fail('Enter an address.');
  const silent = checkRecipient(to);
  if (!Number.isFinite(amt) || amt < DUST) throw fail(`Amount must be at least ${DUST} sats.`);
  if (satsTotal !== null && amt > satsTotal) throw fail(`You have ${fmtSats(satsTotal)}. Lower the amount or add sats first.`);
  if (T.NET.name === 'mainnet' && !confirm(`Send ${fmtSats(amt)} of real bitcoin to ${short(to, 12)}?`)) return;
  show('share', false);
  await ensureKey();
  out.textContent = 'Sending…';
  let r;
  try { r = await T.buildAndBroadcastSatsSend({ recipientAddr: to, amountSats: amt }); }
  catch (e) {
    if (/insufficient sats|no plain-sats/i.test(e?.message || '')) throw fail(`Not enough sats for ${fmtSats(amt)} plus the network fee.`);
    throw e;
  }
  out.replaceChildren(`Sent ${fmtSats(r.recipientValue)} · fee ${fmtSats(r.fee)} · `, txLink(r.txid));
  track(r.txid, `${silent ? 'Silent payment' : 'Sent'} ${fmtSats(r.recipientValue)}`);
  if (silent) {
    $('share-url').textContent = shareUrl(r.txid);
    show('share', true);
  }
  $('amt').value = '';
  setTimeout(refreshSats, 3000);
}

// ---------- receive ----------

function renderFound() {
  const box = $('found');
  box.replaceChildren();
  const credits = Object.entries(T?.wallet.pub ? T.loadSpCredits() || {} : {});
  if (!credits.length) return;
  const ol = document.createElement('ol');
  ol.className = 'lines compact';
  for (const [key, c] of credits) {
    const [txid, vout] = key.split(':');
    const li = document.createElement('li');
    const a = txLink(txid);
    a.textContent = `${short(txid, 8)}:${vout}`;
    const l = document.createElement('span'); l.append(a);
    const r = document.createElement('span'); r.textContent = fmtSats(c.sats) + (spentChecked.get(key) ? ' · spent' : '');
    li.append(l, r);
    ol.append(li);
  }
  const h = document.createElement('p');
  h.className = 'muted';
  h.textContent = 'Silent payments found (Send spends them like any sats):';
  box.append(h, ol);
}

async function checkPayment(txid) {
  const out = $('scan-out');
  await ensureKey();
  out.textContent = `Checking ${short(txid, 8)}…`;
  let found;
  try { found = await T.discoverSilentPaymentFromTxid(txid); }
  catch (e) {
    if (/missing or malformed/.test(e?.message || '')) throw fail(`Transaction ${short(txid, 8)} was not found on ${T.NET.name}.`);
    if (/not fully indexed/.test(e?.message || '')) throw fail(`Transaction ${short(txid, 8)} is not indexed yet. Try again in a minute.`);
    throw e;
  }
  if (!found.length) {
    out.replaceChildren('That payment is not addressed to this wallet. ', txLink(txid));
  } else {
    const total = found.reduce((s, f) => s + Number(f.sats), 0);
    out.replaceChildren(`Found ${fmtSats(total)} for you in `, txLink(txid), '.');
    track(txid, `Received ${fmtSats(total)}`);
  }
  await refresh();
}

let hashChecked = null;
async function checkHashPayment() {
  const { sp, net } = parseHash();
  if (!sp || !T?.wallet.pub || hashChecked === sp) return;
  if (net && net !== T.NET.name) return;
  const out = $('scan-out');
  if (!T.wallet.priv) {
    out.replaceChildren('A payment link is waiting. ');
    const b = document.createElement('button');
    b.className = 'btn sm';
    b.textContent = 'Unlock to check it';
    b.onclick = () => busy(b, unlock, out);
    out.append(b);
    return;
  }
  hashChecked = sp;
  await busy([$('btn-check'), $('btn-scan')], () => checkPayment(sp), out);
}

function parseCheckInput(s) {
  s = s.trim();
  const m = s.match(/[#&?]sp=([0-9a-fA-F]{64})/) || s.match(/^([0-9a-fA-F]{64})$/);
  if (!m) throw fail('Paste a payment link or a 64-character txid.');
  const n = s.match(/[#&?]net=(mainnet|signet)/);
  if (n && n[1] !== T.NET.name) throw fail(`That link is for ${n[1]}. Switch the network above first.`);
  return m[1].toLowerCase();
}

async function getJson(path, signal) {
  const bases = [T.NET.api, T.NET.api2].filter(Boolean);
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const base = bases[attempt % bases.length];
    try {
      const r = await fetch(base + path, { signal });
      if (r.ok) return path.endsWith('/height') ? r.text() : r.json();
      last = new Error(`${r.status} ${path}`);
      if (r.status === 404 || r.status === 400) throw last;
    } catch (e) {
      if (signal?.aborted || e === last && /^40[04] /.test(e.message)) throw e;
      last = e;
    }
    await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
  }
  throw last;
}

async function scan() {
  const url = SP_INDEX_URL[T.NET.name];
  if (!url || !indexState.ok) throw fail('The payment index is not reachable. Paste the payment link or txid instead.');
  await ensureKey();
  const ctl = new AbortController();
  scanAbort = ctl;
  show('btn-scan-stop', true);
  $('btn-scan-stop').disabled = false;
  const out = $('scan-out');
  out.textContent = 'Starting scan…';
  let res = null, prog = null;
  try {
    res = await T.scanSilentPaymentsViaIndex({
      baseUrl: url,
      signal: ctl.signal,
      onProgress: (p) => { prog = p; out.textContent = `Scanned to block ${p.height} of ${p.to} · ${p.found} found…`; },
    });
    const n = res.found.length;
    const total = res.found.reduce((s, f) => s + Number(f.sats || 0), 0);
    const span = res.blocks ? `${res.blocks.toLocaleString('en-US')} block${res.blocks === 1 ? '' : 's'}` : 'no new blocks';
    out.textContent = `${ctl.signal.aborted ? 'Stopped' : 'Done'}: ${span}, ${res.txs.toLocaleString('en-US')} transactions checked, ${n ? `${fmtSats(total)} found for you` : 'none for you'}.`;
    for (const f of res.found) track(f.txid, `Received ${fmtSats(f.sats)}`);
  } catch (e) {
    const found = prog?.found || 0;
    out.textContent = ctl.signal.aborted
      ? `Stopped${prog ? ` at block ${prog.height}` : ''}. ${found} found.`
      : `Scan stopped${prog ? ` at block ${prog.height}` : ''}: ${errMsg(e)} ${found} found so far.`;
  } finally {
    scanAbort = null;
    show('btn-scan-stop', false);
    renderScan();
    if (res?.found.length || prog?.found) await refresh(); else renderFound();
  }
}

// ---------- secret payment mount ----------

function emit() {
  const w = T?.wallet;
  const detail = {
    connected: !!w?.pub, unlocked: !!w?.priv,
    address: w?.pub ? w.address() : null, pubHex: w?.pub ? T.bytesToHex(w.pub) : null,
    sats: satsTotal,
  };
  for (const fn of listeners) { try { fn(detail); } catch (e) { console.error(e); } }
}

let secretMounted = false;
async function mountSecret() {
  if (secretMounted) return;
  secretMounted = true;
  const ph = $('secret-placeholder');
  if (T.NET.name !== 'signet') { renderNet(); return; }
  let mod;
  try { mod = await import(SECRET_URL); } catch (e) { console.warn('[sats] secret.js', e); ph.textContent = 'Secret payments are coming soon.'; return; }
  if (typeof mod.mount !== 'function') { ph.textContent = 'Secret payments are coming soon.'; return; }
  ph.remove();
  try {
    await mod.mount($('secret-steps'), {
      tacit: T,
      wallet: T.wallet,
      network: T.NET.name,
      log,
      refresh,
      ensureKey,
      track,
      errMsg,
      getSats: faucetSats,
      onWallet(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    });
    emit();
  } catch (e) { log('Secret payment failed to load: ' + errMsg(e), 'error'); }
}

// ---------- pool panel ----------

async function poolStatus() {
  try {
    const r = await fetch(POOL_STATUS, { cache: 'no-store' });
    if (!r.ok) throw fail(r.status);
    const s = await r.json();
    $('h').textContent = s.height ?? '—';
    $('n').textContent = s.leafCount ?? '—';
    $('r').textContent = s.root ? s.root.slice(0, 10) + '…' + s.root.slice(-6) : '—';
    $('st').textContent = s.halted ? 'paused' : 'replaying';
    $('dot').classList.toggle('on', !s.halted);
  } catch { $('st').textContent = 'offline'; $('dot').classList.remove('on'); }
}

// ---------- wiring ----------

function wire() {
  for (const a of document.querySelectorAll('#net [data-net]')) {
    a.onclick = () => {
      if (working) { log('Wait for the current step to finish before switching networks.', 'error'); return; }
      const net = a.dataset.net;
      if (net !== curNet()) switchNet(net);
    };
  }
  $('btn-create').onclick = () => busy(connectButtons(), createWallet);
  $('btn-btc').onclick = () => busy(connectButtons(), async () => { await loadTacit(); btcChoices(); });
  $('btn-eth').onclick = () => busy(connectButtons(), linkEth);
  $('faucet').onclick = () => busy($('faucet'), faucetSats);
  $('btn-refresh').onclick = () => busy($('btn-refresh'), async () => { spentChecked.clear(); try { T.invalidateHoldingsCache?.(); } catch {} await refresh(); });
  $('btn-unlock').onclick = () => busy($('btn-unlock'), unlock);
  $('btn-fund').onclick = () => { show('fund-row', $('fund-row').classList.contains('hidden')); $('fund-amt').focus(); };
  $('btn-fund-go').onclick = () => busy($('btn-fund-go'), fund);
  $('btn-backup').onclick = () => busy($('btn-backup'), async () => { await ensureKey(); openBackup(); });
  $('btn-backup-copy').onclick = () => copy($('backup-key').textContent);
  $('btn-backup-done').onclick = () => {
    store.set('tacit-backup-ack-v1:' + T.bytesToHex(T.wallet.pub), '1');
    $('backup-key').textContent = '—';
    show('backup', false);
  };
  $('backup-key').onclick = () => copy($('backup-key').textContent);
  $('btn-disconnect').onclick = () => { if (working) { log('Wait for the current step to finish.', 'error'); return; } signOut(); };
  $('copy-addr').onclick = (e) => { e.preventDefault(); copy($('w-addr').textContent); };
  $('copy-sp').onclick = (e) => { e.preventDefault(); copy($('w-sp').dataset.full); };
  $('btn-send').onclick = () => busy($('btn-send'), send, $('send-out'));
  $('btn-share-copy').onclick = () => copy($('share-url').textContent);
  $('btn-check').onclick = () => busy([$('btn-check'), $('btn-scan')], () => checkPayment(parseCheckInput($('check-in').value)), $('scan-out'));
  $('btn-scan').onclick = () => busy([$('btn-scan'), $('btn-check')], scan, $('scan-out'));
  $('btn-scan-stop').onclick = () => { scanAbort?.abort(); $('btn-scan-stop').disabled = true; };
  window.addEventListener('hashchange', () => {
    const { net, sp } = parseHash();
    if (net && net !== curNet()) {
      store.set(NET_PREF, net);
      if (T) { releaseSharedNet(); location.reload(); } else { renderNet(); probeIndex(); refreshCreateLabel(); resume(); }
      return;
    }
    hashChecked = null;
    if (sp) selectTab('receive');
    if (sp && !T?.wallet.pub) log('Someone sent you a payment link. Connect your wallet to check it.');
    checkHashPayment();
  });
  window.addEventListener('pagehide', () => { if (T) releaseSharedNet(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted && T) claimSharedNet(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && T?.wallet.pub && pollTimer) poll(); });
}

// ---------- tabs ----------

const TAB_PREF = 'tacit-sats-tab-v1';
function tabs() { return [...document.querySelectorAll('[role=tab]')]; }
function selectTab(id, { focus = false, remember = false } = {}) {
  const all = tabs();
  const tab = all.find((t) => t.id === `tab-${id}`) || all[0];
  for (const t of all) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
  if (remember) store.set(TAB_PREF, tab.id.slice(4));
}
function wireTabs() {
  const all = tabs();
  all.forEach((t, i) => {
    t.onclick = () => selectTab(t.id.slice(4), { remember: true });
    t.onkeydown = (e) => {
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
      if (j === undefined) return;
      e.preventDefault();
      selectTab(all[(j + all.length) % all.length].id.slice(4), { focus: true, remember: true });
    };
  });
  selectTab(parseHash().sp ? 'receive' : store.get(TAB_PREF) || (netPref() === 'signet' ? 'secret' : 'send'));
}

function refreshCreateLabel() {
  $('btn-create').textContent = hasLocalWallet() ? 'Unlock your Tacit wallet' : 'Create a Tacit wallet';
}

// Test-only: ?debug=errors collects uncaught errors into a hidden DOM node.
function errorHook() {
  if (!new URLSearchParams(location.search).has('debug')) return;
  const box = document.createElement('pre');
  box.id = 'debug-errors'; box.hidden = true;
  document.body.append(box);
  const add = (m) => { box.textContent += m + '\n'; };
  window.addEventListener('error', (e) => add('error: ' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => add('rejection: ' + (e.reason?.message || e.reason)));
}

async function boot() {
  errorHook();
  const { net } = parseHash();
  if (net) store.set(NET_PREF, net);
  wire();
  wireTabs();
  renderNet();
  refreshCreateLabel();
  poolStatus();
  probeIndex();
  setInterval(() => { if (!document.hidden) poolStatus(); }, 60_000);
  await resume();
}

// Reconnect a previous session on this network, or load the wallet code for a payment link.
async function resume() {
  const sp = parseHash().sp;
  if (!(store.get(SESSION) === '1' && readIdentity()) && !sp) return;
  try {
    await loadTacit();
    if (T.wallet.pub) return;
    if (restore()) await connected();
    else if (sp) log('Someone sent you a payment link. Connect your wallet to check it.');
  } catch (e) { log('Could not load the wallet: ' + errMsg(e), 'error'); }
}

boot();
