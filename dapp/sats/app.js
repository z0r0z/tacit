// Secret Sats page. The landing copy is static; everything that touches a key
// or the chain comes from ../tacit.js, imported only once the user connects.

const TACIT_URL = '/tacit.js?cb=7574a102';
const SECRET_URL = '/sats/secret.js?cb=423f48a3';
const MIX_URL = '/sats/mix.js?cb=18747071';
const ETH_URL = '/sats/eth.js?cb=8f726558';
const POOL_STATUS = 'https://tacit-btc-pool.onrender.com/btc-pool/status';

// tacit.js reads its network from this shared key once, at import. This page
// defaults to signet under its own key, writes the shared one just before the
// import, and puts the previous value back when the page goes away so the main
// app keeps the network its user chose.
const NET_PREF = 'tacit-sats-net-v1';
const SHARED_NET = 'tacit-network-v1';
const PREV_NET = 'tacit-sats-prev-net-v1';
// This page's own record of how the user signed in, per network. The page
// never reads its identity from the main app's linked-wallet records and puts
// them back after any call that rewrites them, so signing in here never
// changes which wallet the main app opens.
const SESSION = 'tacit-sats-session-v1';
const IDENTITY = (net) => `tacit-sats-id-v1:${net}`;
const SHARED_WALLET_KEYS = [
  'tacit-eth-identity', 'tacit-btc-identity', 'tacit-active-mode-v1', 'tacit-ext-mode-v1', 'tacit-ext-state-v1',
  ...['mainnet', 'signet'].flatMap((n) => [`tacit-eth-identity:${n}`, `tacit-btc-identity:${n}`, `tacit-active-mode-v1:${n}`]),
];
// Silent-payment tweak index per network. The wallet fetches public tweaks
// and matches them locally; the index never sees a key.
const SP_INDEX_URL = { signet: 'https://tacit-sp-index.onrender.com', mainnet: null };
const DUST = 546;
const POLL_MS = 20_000;
// Tokens always scanned for shielded receipts, beside the ones the wallet holds (signet test cBTC). On
// mainnet the pool's own assets are added at scan time from secret.js, so they are not repeated here.
const KNOWN_ASSETS = { signet: ['17619b4c65ad462481b74a59dbd566730a4376f07fb0e6ff8beca216044466c5'], mainnet: [] };
// Sats a token send needs on hand for its commit and reveal fees.
const TOKEN_SEND_SATS = 3000;
const PRF_MAP = 'tacit-prf-v1';
// The wallet a returning visitor already has on mainnet (tacit-wallet-known.js, shared by the front page, /pay, /pay/eth
// and /tac): the one tacit.finance has open first, then a key one of those pages opened. Public data only.
const KNOWN_URL = '/tacit-wallet-known.js?cb=ed4c75b7';
const KNOWN_IDS = ['tacit-pay-hub-id-v1', 'tacit-lite-id-v1', 'tacit-pay-id-v1', 'tacit-tac-id-v1'];
const FETCH_MS = 20_000;

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

// The front page's toasts: a short line at the foot of the screen, an error one in red and for longer.
function toast(msg, bad = false, ms = bad ? 7000 : 4200) {
  const box = $('toast-container');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' error' : '');
  el.textContent = String(msg);
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

// Where the clipboard is refused, the toast carries the whole text to copy by hand.
async function copy(text, done = 'Copied') {
  if (!text || text === '—') return;
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { toast(`Could not copy: ${text}`, true); }
}

// Errors meant for the user as written (bad input, not enough sats); not logged to the console.
function fail(msg) { const e = new Error(msg); e.user = true; return e; }

function isCancel(e) { return !!(e && (e.unlockCancelled || e.name === 'UnlockCancelled' || e.message === 'cancelled')); }

// One line, no stack, no JSON dumps from wallet libraries: the front page's wording for the errors this page can meet.
function errMsg(e) {
  if (isCancel(e) || e?.name === 'NotAllowedError') return 'Cancelled.';
  if (e?.user) return String(e.message);
  const m = String(e?.shortMessage || e?.message || e || 'Something went wrong');
  if (e?.code === 4001 || /user (rejected|denied|cancel)|rejected by user|rejected the request|request rejected|denied transaction|no wallet selected/i.test(m)) return 'Cancelled in your wallet.';
  if (/insufficient sats|no plain-sats|not enough (?:signet )?sats/i.test(m)) return 'Not enough sats for this and its Bitcoin fee.';
  if (/does not match the ceremony|verification key does not match/i.test(m)) return 'The proving key did not match its published hash, so it was not used. Reload and try again.';
  if (/short of gas|can.t take this one/i.test(m)) return 'The relay can’t take this one right now. Try again shortly.';
  if (/^the relay is busy with other sends/i.test(m)) return m.charAt(0).toUpperCase() + m.slice(1);
  if (/\bHTTP 5\d\d\b/.test(m)) return 'The service is busy right now. Try again in a moment.';
  if (/failed to fetch|networkerror|load failed|all rpcs failed/i.test(m)) return 'Could not reach the network. Check your connection and try again.';
  if (/rate.?limit|too many requests|\b429\b|exceeded.*(?:request|quota)|upgrade.*(?:plan|tier)/i.test(m)) return 'That network is busy right now. Try again in a moment.';
  if (/timed? ?out|timeout|aborted due to timeout/i.test(m)) return 'The network took too long to answer. Try again.';
  if (/previously derived a different Tacit identity|ETH signature changed/i.test(m)) return 'This account opened a different Tacit key on this device before. Switch to that account in your wallet, or open your key another way.';
  if (/non-canonical \(high-s\) signature/i.test(m)) return 'The wallet’s signature came back in a form Tacit does not use, so nothing was opened. Reconnect the wallet and try again.';
  // Anything else as written, first letter up, cut at a sentence (or at least a word) when it runs long.
  let t = m.split('\n')[0].replace(/^Error:\s*/, '').replace(/\brelayer/gi, 'relay');
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length <= 240) return t;
  const cut = t.slice(0, 240), end = cut.lastIndexOf('. ');
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// Runs fn with every button in `btns` disabled; the error goes to `out` (a section's output line) or the wallet log.
// `working` counts this page's own actions; `paying` the ones that move money, which the page asks before leaving in the
// middle of. The Mix and ETH panels hold the page the same way (hold()) while a step runs.
let working = 0, paying = 0, holds = 0;
async function busy(btns, fn, out = null, { pays = false } = {}) {
  btns = (Array.isArray(btns) ? btns : [btns]).filter(Boolean);
  if (btns.some((b) => b.dataset.busy === '1')) return;
  const prev = btns.map((b) => b.disabled);
  btns.forEach((b) => { b.disabled = true; b.dataset.busy = '1'; });
  working++; if (pays) paying++;
  try { return await fn(); }
  catch (e) {
    const m = errMsg(e);
    if (out) { out.replaceChildren(); const s = document.createElement('span'); s.className = isCancel(e) ? '' : 'err'; s.textContent = m; out.append(s); }
    else log(m, isCancel(e) ? '' : 'error');
    if (!isCancel(e) && !e?.user) console.warn('[sats]', e);
  }
  finally { working--; if (pays) paying--; btns.forEach((b, i) => { b.disabled = prev[i]; delete b.dataset.busy; }); }
}
function hold() {
  holds++;
  let on = true;
  return () => { if (on) { on = false; holds--; } };
}
// The Secret payment panel says whether a step of its is running. A panel that does not say is read from its markup: the
// signet one marks the step it runs, and the mainnet one disables every button while a step runs, and only then.
function secretRunning() {
  if (typeof secretHandle?.running === 'boolean') return secretHandle.running;
  const root = $('secret-steps');
  if (!root) return false;
  if (root.querySelector('.is-running')) return true;
  if (!root.querySelector('#mn-asset')) return false;
  const b = [...root.querySelectorAll('button')];
  return b.length > 0 && b.every((x) => x.disabled);
}
// A step that moves money or holds a place in a round, anywhere on the page: the key and the network stay put until it ends.
const moving = () => paying > 0 || holds > 0 || secretRunning();
window.addEventListener('beforeunload', (e) => { if (moving()) { e.preventDefault(); e.returnValue = ''; } });

// tacit.js holds one key at a time. Every call into it from this page and its panels is counted while it runs, and a
// new key goes in only once none is running, so a read begun under one key never finishes under another.
const inflight = new Set();
function counted(m) {
  const wrapped = new Map();
  return new Proxy(m, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      if (!wrapped.has(k)) {
        wrapped.set(k, function (...a) {
          const r = v.apply(t, a);
          if (r && typeof r.then === 'function') { inflight.add(r); r.then(() => inflight.delete(r), () => inflight.delete(r)); }
          return r;
        });
      }
      return wrapped.get(k);
    },
  });
}
async function settle() { while (inflight.size) await Promise.allSettled([...inflight]); }
// Bumped whenever the key goes or changes: a read that started under an earlier one is dropped, not shown.
let keyGen = 0;
const pubNow = () => (T?.wallet.pub ? T.bytesToHex(T.wallet.pub) : null);

// ---------- network ----------

function parseHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const sp = (h.get('sp') || '').toLowerCase();
  const st = (h.get('st') || '').toLowerCase();
  const net = h.get('net');
  const eth = h.get('eth');
  return {
    sp: /^[0-9a-f]{64}$/.test(sp) ? sp : null,
    st: /^[0-9a-f]{64}$/.test(st) ? st : null,
    net: net === 'mainnet' || net === 'signet' ? net : null,
    // #eth=<chain id> opens private ETH on that chain (it runs on mainnet).
    eth: ['1', '8453', '4663'].includes(eth) ? eth : null,
  };
}

function netPref() { return store.get(NET_PREF) === 'mainnet' ? 'mainnet' : 'signet'; }
function curNet() { return T ? T.NET.name : netPref(); }

function claimSharedNet() {
  // A value another tab of this page already set is not this tab's to restore when it closes.
  if (store.get(PREV_NET, sessionStorage) === null && store.get(SHARED_NET) !== netPref()) {
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

// A reload would stop a step halfway (a send, a proof, a place in a round), so the network waits for it.
function switchNet(net) {
  if (T && (working || moving())) { toast('Wait for the step in progress to finish, then switch networks.', true); return; }
  store.set(NET_PREF, net);
  if (!T) { renderNet(); probeIndex(); refreshCreateLabel(); paintChip(); loadKnown(); resume(); return; }
  releaseSharedNet();
  // A #…&net= in the URL would switch the page straight back on reload.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  location.reload();
}

function renderNet() {
  const net = curNet();
  for (const b of document.querySelectorAll('#net [data-net]')) b.setAttribute('aria-pressed', String(b.dataset.net === net));
  show('mainnet-note', net === 'mainnet');
  $('foot-net').textContent = `tacit sats · ${net}`;
  renderScan();
  renderSendLabels();
  const ph = $('secret-placeholder');
  // #secret-steps carries the signet demo's static preview markup (six signet-only steps) until mountSecret()
  // replaces it with the network's own panel. Pre-mount, that preview is only accurate for signet; mainnet
  // stays on the placeholder line below until mountMainnet() unhides and fills it.
  if (ph) show('secret-steps', net !== 'mainnet');
  if (ph) ph.textContent = net === 'mainnet'
    ? 'Connect a wallet above to start. Shield, pay and withdraw TAC in the pool; each step is one Bitcoin transaction.'
    : 'Connect a wallet above to start. Each step is one signet transaction.';
  show('mix-hint', net !== 'mainnet');
  const mp = $('mix-placeholder');
  if (mp) show('mix-steps', net !== 'mainnet');
  if (mp) mp.textContent = net === 'mainnet'
    ? 'Mixing runs on signet for now. Switch the wallet to signet to try it.'
    : 'Connect a wallet above to start. Mix turns your sats into a coin with no history.';
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

// Scan always covers shielded token payments; silent payments join when the index answers.
function renderScan() {
  const on = indexState.ok && indexState.net === curNet();
  const last = on && T?.wallet.pub ? T.spIndexLastScanned() : null;
  $('scan-depth').textContent = !on ? 'tokens only; sats index offline' : last ? `sats since block ${last}, and tokens` : 'sats from about the last week, and tokens';
  $('receive-note').textContent = 'Private payments can’t be looked up by address. Scan, and this device checks recent payments itself, so no server learns which are yours. Or paste the link the sender gives you.';
}

// ---------- tacit.js ----------

function loadTacit() {
  if (T) return Promise.resolve(T);
  if (!loading) {
    log('Loading wallet…');
    claimSharedNet();
    globalThis.__TACIT_NO_INIT__ = true;
    loading = import(TACIT_URL).then((m) => {
      T = counted(m);
      log('');
      renderNet();
      mountSecret();
      mountMix();
      mountEth();
      return m;
    }).catch((e) => {
      loading = null;
      releaseSharedNet();
      throw fail('Could not load the wallet code. Reload and try again. (' + errMsg(e) + ')');
    });
  }
  return loading;
}

// Run a call that may rewrite the main app's linked-wallet caches, then put them back as they were. A record another
// tab writes while the call runs is theirs: it is left as they wrote it.
async function keepShared(fn) {
  const snap = SHARED_WALLET_KEYS.map((k) => [k, store.get(k)]);
  const theirs = new Set(), seen = (e) => { if (e.storageArea === localStorage) theirs.add(e.key); };
  window.addEventListener('storage', seen);
  try { return await fn(); }
  finally {
    window.removeEventListener('storage', seen);
    for (const [k, v] of snap) { if (theirs.has(k) || theirs.has(null)) continue; (v === null ? store.del(k) : store.set(k, v)); }
  }
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
  } else if (rec.mode === 'passkey' && okPub(rec.pubkey) && rec.label && T.prfWallet) {
    T.prfWallet.state = { label: rec.label, credentialId: rec.credentialId, pubkey: rec.pubkey };
    w.pub = T.hexToBytes(rec.pubkey); w.mode = 'passkey';
  }
  return !!w.pub;
}

async function ensureKey() {
  if (!T?.wallet.pub) throw fail('Connect a wallet first.');
  if (T.wallet.priv) return;
  const before = pubNow();
  await keepShared(() => T.ensurePrivkey());
  if (pubNow() !== before) { keyGen++; try { T.invalidateHoldingsCache?.({ fromPoll: true }); } catch {} }
  unlocked();
}

// ---------- wallet paths ----------

const CONNECT_IDS = ['btn-known', 'btn-passkey', 'btn-passkey-restore', 'btn-create', 'btn-import', 'btn-import-go', 'btn-eth', 'btn-xverse', 'btn-unisat', 'btn-btc'];
function connectButtons() { return CONNECT_IDS.map($).filter(Boolean); }

// Drops the key from tacit.js, and with it the holdings it read: they belong to that key, which the next one must
// never see or spend.
function clearSession() {
  const w = T.wallet;
  try { w.priv?.fill?.(0); } catch {}
  w.priv = null; w.pub = null; w.mode = null;
  T.extWallet.state = null; T.ethWallet.state = null; T.btcWallet.state = null;
  if (T.prfWallet) T.prfWallet.state = null;
  keyGen++;
  try { T.invalidateHoldingsCache?.({ fromPoll: true }); } catch {}
}

// Every way in: never while a step that moves money runs, and only once every call made under the last key has ended.
async function signIn(fn) {
  if (moving()) throw fail('Wait for the step in progress to finish, then sign in.');
  if (inflight.size) { log('Waiting for the balance read to finish…'); await settle(); log(''); }
  return fn();
}

// A way in that names the key it must open (the known wallet): anything else is put back and refused.
function expectKey(pubHex) {
  if (!pubHex || pubNow() === String(pubHex).toLowerCase()) return;
  clearSession();
  throw fail('That opened a different Tacit key than the one tacit.finance has open, so nothing was changed. Choose that account in your wallet, or open your key another way.');
}

// Passkeys: the same PRF key as tacit.finance, so the same passkey opens the same wallet there.
const passkeyOk = () => !!(window.isSecureContext && window.PublicKeyCredential);
function savedPasskey() {
  const m = store.json(PRF_MAP) || {};
  const labels = Object.keys(m).sort((a, b) => (m[b]?.lastUsed || 0) - (m[a]?.lastUsed || 0));
  return labels.length ? labels[0] : null;
}

async function usePasskey({ restore = false, label = null, expect = null } = {}) {
  await loadTacit();
  if (!passkeyOk() || !T.prfWallet) throw fail('Passkeys need a secure (https) page and a browser that supports them.');
  await keepShared(async () => {
    clearSession();
    const saved = label || savedPasskey();
    if (restore) await T.prfWallet.login({});
    else if (saved) await T.prfWallet.login({ label: saved });
    else await T.prfWallet.register('Tacit');
    expectKey(expect);
    const s = T.prfWallet.state;
    saveIdentity({ mode: 'passkey', label: s.label, credentialId: s.credentialId, pubkey: s.pubkey });
  });
  unlocked();
  log('Passkey wallet ready. Your passkey is the backup.');
  await connected();
}

// The key is saved in this browser under a passphrase, where tacit.finance keeps its own: a different saved key is
// replaced only when the user says so, knowing only its backup opens it again.
async function importKey() {
  const hex = $('import-key').value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw fail('A Tacit key is 64 hex characters.');
  await loadTacit();
  const { secp } = await import('/vendor/tacit-deps.min.js');
  let pubHex;
  try { pubHex = T.bytesToHex(secp.getPublicKey(T.hexToBytes(hex), true)); } catch { throw fail('That is not a valid Tacit key.'); }
  const saved = blobPub();
  const same = !!saved && pubHex === T.bytesToHex(saved);
  if (saved && !same && !confirm(`This browser already keeps a different Tacit key for ${T.NET.name}, the one tacit.finance opens here. Restoring replaces it, and only that key's own backup opens it again. Continue?`)) return;
  await keepShared(async () => {
    clearSession();
    await T.wallet.setPriv(hex);
  });
  store.set('tacit-backup-ack-v1:' + T.bytesToHex(T.wallet.pub), '1');
  saveIdentity({ mode: 'local' });
  $('import-key').value = '';
  show('import-row', false);
  log('Wallet restored.');
  await connected();
}

// Xverse / Leather / UniSat as a funding wallet: Tacit keeps its own key, bound to the linked address.
async function linkExt(connect) {
  await loadTacit();
  const av = T.extWallet.available();
  if (connect === 'unisat' ? !av.unisat : !av.satsConnect) {
    throw fail(`${connect === 'unisat' ? 'UniSat' : 'Xverse or Leather'} isn’t installed in this browser.`);
  }
  await keepShared(async () => {
    clearSession();
    const st = connect === 'unisat' ? await T.extWallet.connectUnisat() : await T.extWallet.connectSatsConnect();
    assertWalletNet(st);
    const ext = { ...T.extWallet.state };
    await T.wallet.load(st.address);
    saveIdentity({ mode: 'ext', ext });
  });
  log('Linked. Your wallet funds a Tacit key kept in this browser.');
  await connected();
  if (!isBackedUp()) openBackup();
}

// The key an extension funds, opened from its saved record (the known wallet), with that key's passphrase.
async function openExt(k) {
  await loadTacit();
  await keepShared(async () => {
    clearSession();
    T.extWallet.state = { ...k.ext };
    await T.wallet.load(k.address);
    expectKey(k.pubHex);
    saveIdentity({ mode: 'ext', ext: { ...k.ext } });
  });
  log('Opened. Your wallet funds a Tacit key kept in this browser.');
  await connected();
}

async function linkBtcId(prior = null) {
  await loadTacit();
  const av = T.extWallet.available();
  if (!av.unisat && !av.satsConnect) throw fail('No Bitcoin wallet found in this browser. Install Xverse, Leather or UniSat, or use a passkey.');
  await linkBtc(() => T.extWallet.connectDefault(), prior);
}

async function createWallet({ expect = null } = {}) {
  await loadTacit();
  const existed = !!blobPub();
  await keepShared(async () => {
    clearSession();
    await T.wallet.load();
    expectKey(expect);
  });
  saveIdentity({ mode: 'local' });
  log(existed ? 'Wallet unlocked.' : 'Wallet created. Back up its key.');
  await connected();
  if (!isBackedUp()) openBackup();
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

// prior: the known wallet's record ({ address, pubHex, btc }), whose key this must open.
async function linkBtc(connect, prior = null) {
  await keepShared(async () => {
    clearSession();
    const st = await connect();
    assertWalletNet(st);
    if (prior?.address && st.address !== prior.address) {
      T.extWallet.state = null;
      throw fail(`Switch your Bitcoin wallet to ${short(prior.address, 6)}, the account your Tacit wallet was opened with.`);
    }
    const ext = { ...T.extWallet.state };
    // A key enrolled before for this address needs one signature;
    // a new one needs two (the second proves the wallet signs the same way).
    const prev = prior?.btc ? { mode: 'btc', btc: prior.btc } : readIdentity();
    T.btcWallet.state = prev?.mode === 'btc' && prev.btc?.address === st.address ? prev.btc : null;
    try {
      if (T.btcWallet.state) await T.btcWallet.login(); else await T.btcWallet.enroll();
      expectKey(prior?.pubHex);
      saveIdentity({ mode: 'btc', btc: T.btcWallet.state, ext });
      log('Linked. Your Tacit key comes from your wallet’s signature.');
    } catch (e) {
      if (!e?._btcNonDeterministic || prior) { T.extWallet.state = null; throw e; }
      log('This wallet signs differently each time, so it funds a Tacit key kept in this browser instead.');
      T.btcWallet.state = null;
      T.extWallet.state = ext;
      T.wallet.mode = null;
      await T.wallet.load(st.address);
      saveIdentity({ mode: 'ext', ext });
    }
  });
  await connected();
  if (!isBackedUp()) openBackup();
}

// prior: the known wallet's record ({ address, pubHex }): that account signs once, and must open that key.
async function linkEth(prior = null) {
  await loadTacit();
  if (!T.ethWallet.available()) throw fail('No Ethereum wallet found in this browser.');
  await keepShared(async () => {
    clearSession();
    const prev = readIdentity();
    if (prior?.address) {
      const address = String(prior.address).toLowerCase().replace(/^0x/, '');
      T.ethWallet.state = { address, pubkey: String(prior.pubHex).toLowerCase() };
      await T.ethWallet.login({ address });
      expectKey(prior.pubHex);
    } else await T.ethWallet.login();
    if (prev?.mode === 'eth' && prev.address === T.ethWallet.state.address && prev.pubkey !== T.ethWallet.state.pubkey) {
      clearSession();
      throw fail('This account signed differently than last time, so it would open a different wallet. Nothing was changed.');
    }
    saveIdentity({ mode: 'eth', address: T.ethWallet.state.address, pubkey: T.ethWallet.state.pubkey });
  });
  log('Linked. Same key as on tacit.finance.');
  await connected();
}

// ---------- the wallet tacit.finance has open (mainnet) ----------

let knownMod = null;
function knownWallet() {
  if (netPref() !== 'mainnet' || !knownMod) return null;
  try { return knownMod.knownWallets(KNOWN_IDS).primary || null; } catch { return null; }
}
function loadKnown() {
  if (knownMod || netPref() !== 'mainnet') return;
  import(KNOWN_URL).then((m) => { knownMod = m; refreshCreateLabel(); paintChip(); }).catch(() => {});
}
const viaKnown = (k) => ({ eth: `Ethereum ${short(k.address || '', 6)}`, btc: `Bitcoin ${short(k.address || '', 6)}`, ext: `the key ${short(k.address || '', 6)} funds`,
  passkey: `passkey “${k.label || 'Tacit'}”`, local: 'the key saved in this browser' })[k.mode] || 'your wallet';

async function continueKnown() {
  const k = knownWallet();
  if (!k) throw fail('No Tacit wallet is open on tacit.finance in this browser. Choose a way in below.');
  if (k.mode === 'passkey') return usePasskey({ label: k.label, expect: k.pubHex });
  if (k.mode === 'eth') return linkEth(k);
  if (k.mode === 'btc') return linkBtcId(k);
  if (k.mode === 'ext' && k.ext?.address) return openExt(k);
  if (k.mode === 'local') return createWallet({ expect: k.pubHex });
  throw fail('Open that wallet with the way you used on tacit.finance, below.');
}

function via() {
  const w = T.wallet;
  if (w.mode === 'eth') return `Ethereum 0x${short(T.ethWallet.state?.address || '', 6)}`;
  if (w.mode === 'btc') return `Bitcoin wallet ${short(T.btcWallet.state?.address || '', 6)}`;
  if (w.mode === 'passkey') return 'Passkey';
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

// The way in ends here; the first balance read goes on by itself, so signing out right after never waits on it.
async function connected() {
  show('connect', false);
  show('connected', true);
  show('send', true);
  show('receive', true);
  renderActivity();
  renderScan();
  refresh().catch((e) => { log('Balance lookup failed: ' + errMsg(e), 'error'); console.warn('[sats] refresh', e); });
  startPoll();
  checkHashPayment();
}

function unlocked() {
  renderIdentity();
  refreshAssets();
  if (!exitSats.key) refreshSats();
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
  const st = stealthAddress();
  const stEl = $('w-st');
  stEl.textContent = st ? short(st, 14) : '—';
  stEl.title = st || '';
  if (st) stEl.dataset.full = st; else delete stEl.dataset.full;
  show('copy-st-wrap', !!st);
  show('btn-unlock', !w.priv);
  show('btn-fund', !!w.ext);
  show('btn-backup', !(w.mode === 'eth' || w.mode === 'btc' || w.mode === 'passkey'));
  paintChip();
}

// The header chip: Sign in (or Open wallet, when tacit.finance has one open) and, signed in, the wallet address. It
// takes the reader to the wallet panel either way.
function paintChip() {
  const pub = T?.wallet.pub;
  $('chip-dot').className = 'dot' + (pub ? ' on' : '');
  $('chip-label').textContent = pub ? short(T.wallet.address(), 6) : knownWallet() ? 'Open wallet' : 'Sign in';
  $('chip').setAttribute('aria-label', pub ? `Wallet ${T.wallet.address()}` : $('chip-label').textContent);
}
function toWallet() {
  $('wallet').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  const first = T?.wallet.pub ? $('btn-refresh') : connectButtons().find((b) => !b.classList.contains('hidden') && !b.disabled && b.offsetParent);
  first?.focus({ preventScroll: true });
}

// Shielded (stealth) address for tokens, as the main app shows it: the wallet key, single mode.
function stealthAddress() {
  try { return T.encodeStealthAddress({ network: T.NET.name, recipientPub: T.wallet.pub }); } catch { return null; }
}

let satsTotal = null;
let faucetPending = null; // { txid, sats, t } of a faucet payout not yet listed by the indexer
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
// A read that finishes after a newer one started, or after the key changed, is dropped.
let satsSeq = 0;
async function refreshSats() {
  const w = T?.wallet;
  if (!w?.pub) return;
  const my = ++satsSeq, gen = keyGen;
  const stale = () => my !== satsSeq || gen !== keyGen || !T.wallet.pub;
  try {
    const utxos = await T.getUtxos(w.address());
    let conf = 0, pend = 0;
    for (const u of utxos || []) {
      if ((u.value || 0) <= DUST) continue;
      if (u.status?.confirmed) conf += u.value; else pend += u.value;
    }
    const silent = await unspentSilent();
    const fromPool = await refreshExitSats();
    if (stale()) return;
    let txt = conf || !pend ? fmtSats(conf) : '';
    if (pend) txt += `${txt ? ' · ' : ''}${fmtSats(pend)} unconfirmed`;
    if (silent) txt += ` · ${fmtSats(silent)} in silent payments`;
    if (fromPool) txt += ` · ${fmtSats(fromPool)} from the pool`;
    satsTotal = conf + pend + silent;
    // A faucet payout the indexer hasn't listed yet: say it is on its way rather than showing an empty wallet.
    const arriving = satsTotal === 0 && faucetPending && Date.now() - faucetPending.t < 20 * 60_000;
    if (satsTotal > 0) faucetPending = null;
    $('w-bal').textContent = arriving ? `${fmtSats(faucetPending.sats)} arriving…` : txt;
    show('faucet-hint', T.NET.name === 'signet' && satsTotal === 0 && !fromPool && !arriving);
  } catch (e) {
    if (stale()) return;
    $('w-bal').textContent = 'unavailable · try Refresh';
    log('Balance lookup failed: ' + errMsg(e), 'error');
  }
  emit();
}

const spentChecked = new Map();
// Asks about a few outputs at a time, so a wallet with many silent payments does not wait on them one by one.
async function unspentSilent() {
  // Mix entries and mixed coins are kept apart from plain sats (the Mix tab shows them).
  const credits = Object.entries(T.loadSpCredits() || {}).filter(([, c]) => !c.coinClass);
  let sum = 0, i = 0;
  const next = async () => {
    while (i < credits.length) {
      const [key, c] = credits[i++];
      const [txid, vout] = key.split(':');
      let spent = spentChecked.get(key);
      if (spent === undefined) {
        try { spent = !!(await getJson(`/tx/${txid}/outspend/${vout}`)).spent; } catch { spent = false; }
        if (spent) spentChecked.set(key, true);
      }
      if (!spent) sum += Number(c.sats || 0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, credits.length) }, next));
  return sum;
}

// Sats that Back to sats paid to the pool wallet's exit keys. They count in the
// balance, and one sweep from the Send tab moves them to the wallet address.
// The exit keys derive from the unlocked key; the scan is kept for a minute.
const EXIT_TTL = 60_000;
let exitSats = { key: null, t: 0, coins: [], feeRate: null };
let exitStale = false;
const exitSum = () => exitSats.coins.reduce((t, c) => t + c.value, 0);
async function refreshExitSats() {
  const w = T?.wallet;
  if (!w?.priv || T.NET.name !== 'signet') { exitSats = { key: null, t: 0, coins: [], feeRate: null }; renderSweep(); return 0; }
  const key = T.bytesToHex(w.pub), gen = keyGen;
  if (exitStale || exitSats.key !== key || Date.now() - exitSats.t > EXIT_TTL) {
    exitStale = false;
    try {
      const mod = await import(SECRET_URL);
      const { coins } = await mod.exitCoins(T, mod.poolWalletFor(w.priv, T.NET.name), { known: mod.knownExitCount(T.NET.name, key) });
      const feeRate = coins.length ? await mod.sweepFeeRate(T).catch(() => null) : null;
      if (gen === keyGen) exitSats = { key, t: Date.now(), coins, feeRate, vb: mod.sweepVbytes(coins.length) };
    } catch (e) { console.warn('[sats] exit keys', e); }
  }
  renderSweep();
  return exitSats.key === key ? exitSum() : 0;
}

function renderSweep() {
  const n = exitSats.coins.length;
  show('sweep', n > 0);
  if (!n) return;
  $('sweep-lead').textContent = `${fmtSats(exitSum())} from the pool ${n === 1 ? 'is' : 'are'} at your pool wallet's payout ${n === 1 ? 'key' : 'keys'}. Move ${n === 1 ? 'it' : 'them'} to your wallet address to send ${n === 1 ? 'it' : 'them'} like any other sats.`;
  $('sweep-fee').textContent = exitSats.feeRate ? `Network fee about ${fmtSats(Math.ceil(exitSats.vb * exitSats.feeRate))}.` : '';
}

async function sweep() {
  if (!exitSats.coins.length) throw fail('Nothing to move.');
  await ensureKey();
  if (exitSats.key !== pubNow()) throw fail('Your wallet changed. Refresh, then move them.');
  const out = $('sweep-out');
  out.textContent = 'Moving…';
  const mod = await import(SECRET_URL);
  const r = await mod.sweepExitCoins(T, mod.poolWalletFor(T.wallet.priv, T.NET.name), exitSats.coins);
  exitSats = { ...exitSats, t: Date.now(), coins: [] };
  out.replaceChildren(`Moved ${fmtSats(r.total)} to your wallet${r.added ? ` (with ${fmtSats(r.added)} of your own sats)` : ''} · fee ${fmtSats(r.fee)} · `, txLink(r.txid));
  track(r.txid, `Moved ${fmtSats(r.total)} from the pool`);
  setTimeout(refreshSats, 3000);
}

// Token balances need the unlocked key (amounts are hidden on chain). A call while a read runs asks for one more after it,
// so a send's refresh is never skipped; a read that finishes under another key is dropped.
let assetsBusy = false, assetsAgain = false;
let held = []; // tokens with a balance: { id, ticker, decimals, balance }
// From the last holdings scan, txid:vout → 'counted', 'checking' (held back until it can be checked) or 'invalid'
// (did not validate, so not counted). A found credit is listed with what the scan made of it.
let creditState = new Map();
async function refreshAssets() {
  const w = T?.wallet;
  if (w?.pub && !w.priv) { show('w-assets-row', true); $('w-assets').textContent = 'unlock to show'; return; }
  if (!w?.priv) return;
  if (assetsBusy) { assetsAgain = true; return; }
  assetsBusy = true; assetsAgain = false;
  const gen = keyGen;
  show('w-assets-row', true);
  if (!$('w-assets').dataset.known) $('w-assets').textContent = '…';
  try {
    const h = await T.scanHoldings();
    if (gen !== keyGen) return;
    const rows = [];
    held = [];
    const states = new Map(), mark = (list, state) => { for (const e of list || []) { const u = e?.utxo || e; if (u?.txid != null) states.set(`${u.txid}:${u.vout}`, state); } };
    for (const x of (h instanceof Map ? h.values() : [])) { mark(x.utxos, 'counted'); mark(x.unverified, 'checking'); mark(x.inflated, 'invalid'); }
    creditState = states;
    renderFound();
    for (const [id, x] of (h instanceof Map ? h.entries() : [])) {
      const bal = typeof x.balance === 'bigint' ? x.balance : 0n;
      if (bal <= 0n) continue;
      const a = { id: x.assetIdHex || id, ticker: x.ticker && x.ticker !== '???' ? x.ticker : short(x.assetIdHex || id, 4), decimals: Number.isInteger(x.decimals) ? x.decimals : 0, balance: bal };
      held.push(a);
      rows.push(`${fmtUnits(bal, a.decimals)} ${a.ticker}`);
    }
    renderAssetPicker();
    $('w-assets').textContent = rows.length ? rows.join(' · ') : 'none';
    $('w-assets').dataset.known = '1';
  } catch (e) {
    if (gen !== keyGen) return;
    $('w-assets').textContent = 'unavailable · try Refresh';
    console.warn('[sats] holdings', e);
  } finally {
    assetsBusy = false;
    if (gen === keyGen) emit();
    if (assetsAgain || gen !== keyGen) { assetsAgain = false; if (T?.wallet.priv) refreshAssets(); }
  }
}

async function unlock() {
  await ensureKey();
  await refresh();
}

function signOut() {
  if (scanAbort) scanAbort.abort();
  stopPoll();
  clearSession();
  store.del(SESSION);
  satsTotal = null;
  faucetPending = null;
  hashChecked = null;
  held = [];
  creditState = new Map();
  exitSats = { key: null, t: 0, coins: [], feeRate: null };
  renderSweep();
  $('sweep-out').textContent = '';
  renderAssetPicker();
  show('connected', false); show('send', false); show('receive', false);
  show('backup', false); show('share', false); show('fund-row', false);
  show('connect', true);
  $('backup-key').textContent = '—';
  $('found').replaceChildren();
  $('send-out').textContent = ''; $('scan-out').textContent = '';
  delete $('w-assets').dataset.known;
  $('w-bal').textContent = '—';
  show('btn-scan-stop', false);
  refreshCreateLabel();
  paintChip();
  emit();
  log('Signed out on this page. Your key stays where it was.');
}

// A whole number of sats, with or without thousands separators. A decimal is refused rather than rounded down: 0.001
// reads as a BTC amount.
function parseSats(v) {
  const t = String(v ?? '').trim().replace(/[\s,_]/g, '');
  if (!t) throw fail('Enter an amount in sats.');
  if (!/^\d+$/.test(t)) throw fail(/^\d*\.\d+$/.test(t) ? 'Enter a whole number of sats (1 BTC is 100,000,000 sats).' : 'Enter the amount as a whole number of sats.');
  const n = Number(t);
  if (!Number.isSafeInteger(n)) throw fail('That amount is too large.');
  return n;
}

async function fund() {
  const n = parseSats($('fund-amt').value);
  if (n < DUST) throw fail(`Enter at least ${DUST} sats.`);
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
    r = await fetch(`${FAUCET_URL}/faucet/sats`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: T.wallet.address() }), signal: AbortSignal.timeout(45_000) });
  } catch { throw fail('The faucet is unreachable. Try signetfaucet.com.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.txid) throw fail(j.error ? `Faucet: ${j.error}` : `Faucet unavailable (HTTP ${r.status}). Try signetfaucet.com.`);
  track(j.txid, 'Signet sats from the faucet');
  faucetPending = { txid: j.txid, sats: j.sats || 5000, t: Date.now() };
  log(`${fmtSats(j.sats || 5000)} on the way. You can use them before they confirm.`);
  await refresh();
  for (const ms of [4000, 10000, 20000]) setTimeout(() => { if (faucetPending && T?.wallet.pub) refreshSats(); }, ms);
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
  const gen = keyGen;
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
  if (gen !== keyGen || !T.wallet.pub) return;
  if (changed) { saveActivity(a); renderActivity(); await refresh(); return; }
  // Keep an empty or unconfirmed wallet's balance live (faucet payouts), and
  // everything else fresh every few minutes.
  if (satsTotal === 0 || a.some((x) => !x.height && !x.dropped) || pollN % 9 === 0) await refreshSats();
}

// ---------- send ----------

function isSilent(addr) { return /^t?sp1/i.test(addr); }

// #sp= carries a silent sats payment, #st= a shielded token payment.
function shareUrl(txid, kind = 'sp') {
  const base = /^https?:$/.test(location.protocol) ? location.origin + location.pathname : 'https://tacit.finance/sats/';
  return `${base}#${kind}=${txid}&net=${T.NET.name}`;
}

function showShare(txid, kind) {
  $('share-lead').textContent = kind === 'st'
    ? 'A shielded payment hides who received it. Send the recipient this link so their wallet finds it:'
    : 'A silent payment leaves no reusable address on chain. Send the recipient this link so their wallet finds it:';
  $('share-url').textContent = shareUrl(txid, kind);
  show('share', true);
}

// ---------- send: sats or a token ----------

function sendAsset() {
  const v = $('send-asset').value;
  return v === 'sats' ? null : held.find((a) => a.id === v) || null;
}

function renderAssetPicker() {
  const sel = $('send-asset');
  const cur = sel.value;
  const opts = [new Option('sats', 'sats')];
  for (const a of held) opts.push(new Option(`${a.ticker} · ${fmtUnits(a.balance, a.decimals)} held`, a.id));
  sel.replaceChildren(...opts);
  sel.value = opts.some((o) => o.value === cur) ? cur : 'sats';
  renderSendLabels();
}

function renderSendLabels() {
  const net = curNet();
  const a = T ? sendAsset() : null;
  // What a send shows on chain, said before it is made.
  $('send-note').textContent = a
    ? `A ${a.ticker} transfer hides its amount. To a shielded address, it also hides who received it; your Bitcoin address pays its fee and shows.`
    : `Sats go out as an ordinary Bitcoin payment: the amount and your address show on chain. To a silent address (${net === 'mainnet' ? 'sp1' : 'tsp1'}…), the payment lands at a fresh address only the recipient can find. For a hidden amount, use Secret payment.`;
  if (!a) {
    $('to-label').textContent = net === 'mainnet'
      ? 'To: a bc1q… address or a silent address (sp1…)'
      : 'To: a tb1q… address or a silent address (tsp1…)';
    $('amt-label').textContent = 'Amount (sats)';
    $('amt').placeholder = `${DUST} or more`;
    $('amt').inputMode = 'numeric';
  } else {
    $('to-label').textContent = `To: a shielded address (${net === 'mainnet' ? 'tcs1' : 'tcsts1'}…) or a public key`;
    $('amt-label').textContent = `Amount (${a.ticker})`;
    $('amt').placeholder = fmtUnits(a.balance, a.decimals);
    $('amt').inputMode = 'decimal';
  }
}

function parseUnits(s, decimals) {
  const m = String(s || '').trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2]) || (m[2] || '').length > decimals) throw fail(`Enter an amount with at most ${decimals} decimals.`);
  return BigInt((m[1] || '0') + (m[2] || '').padEnd(decimals, '0'));
}

async function sendToken(a) {
  const out = $('send-out');
  const raw = $('to').value.trim().toLowerCase().replace(/\s/g, '');
  if (!raw) throw fail('Enter a shielded address or a public key.');
  if (isSilent(raw) || T.decodeP2wpkhAddress(raw) || T.decodeP2trAddress(raw)) {
    throw fail('Tokens go to a shielded address or a public key. Silent and plain addresses take sats.');
  }
  const r = T.parseRecipientInput(raw);
  if (r.kind === 'error') throw fail(r.message.charAt(0).toUpperCase() + r.message.slice(1) + '.');
  const amount = parseUnits($('amt').value, a.decimals);
  if (amount <= 0n) throw fail('Enter an amount above zero.');
  if (amount > a.balance) throw fail(`You hold ${fmtUnits(a.balance, a.decimals)} ${a.ticker}.`);
  if (satsTotal !== null && satsTotal < TOKEN_SEND_SATS) throw fail(`A token send needs about ${fmtSats(TOKEN_SEND_SATS)} for fees. Add sats first.`);
  if (!isBackedUp()) { await ensureKey(); openBackup(); throw fail('Back up your key first (above), then send.'); }
  const amt = `${fmtUnits(amount, a.decimals)} ${a.ticker}`;
  if (T.NET.name === 'mainnet' && !confirm(`Send ${amt} to ${short(raw, 12)}?`)) return;
  show('share', false);
  await ensureKey();
  out.textContent = 'Building the transfer…';
  const stage = { 'commit-start': 'Sending the fee transaction…', 'reveal-start': 'Sending the transfer…' };
  const res = await T.buildAndBroadcastCXfer({
    assetIdHex: a.id, amount,
    ...(r.kind === 'stealth' ? { stealthAddress: r.stealthAddress } : { recipientPubHex: r.pubHex }),
    onProgress: (s) => { if (stage[s]) out.textContent = stage[s]; },
  });
  out.replaceChildren(`Sent ${amt}${r.kind === 'stealth' ? ', recipient hidden' : ''} · `, txLink(res.revealTxid));
  track(res.revealTxid, `${r.kind === 'stealth' ? 'Shielded payment' : 'Sent'} ${amt}`);
  if (r.kind === 'stealth') showShare(res.revealTxid, 'st');
  $('amt').value = '';
  try { T.invalidateHoldingsCache?.(); } catch {}
  setTimeout(() => { refreshSats(); refreshAssets(); }, 3000);
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
  const token = sendAsset();
  if (token) return sendToken(token);
  const out = $('send-out');
  const to = $('to').value.trim();
  if (!to) throw fail('Enter an address.');
  const silent = checkRecipient(to);
  const amt = parseSats($('amt').value);
  if (amt < DUST) throw fail(`Amount must be at least ${DUST} sats.`);
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
  if (silent) showShare(r.txid, 'sp');
  $('amt').value = '';
  setTimeout(refreshSats, 3000);
}

// ---------- receive ----------

function renderFound() {
  const box = $('found');
  box.replaceChildren();
  const credits = Object.entries(T?.wallet.pub ? T.loadSpCredits() || {} : {});
  let tokens = [];
  try { tokens = T?.wallet.priv ? Object.entries(T.loadStealthCredits() || {}) : []; } catch {}
  if (!credits.length && !tokens.length) return;
  const ol = document.createElement('ol');
  ol.className = 'lines compact';
  const row = (key, amount) => {
    const [txid, vout] = key.split(':');
    const li = document.createElement('li');
    const a = txLink(txid);
    a.textContent = `${short(txid, 8)}:${vout}`;
    const l = document.createElement('span'); l.append(a);
    const r = document.createElement('span'); r.textContent = amount;
    li.append(l, r);
    ol.append(li);
  };
  for (const [key, c] of credits) row(key, fmtSats(c.sats) + (c.coinClass ? ` · ${c.coinClass === 'mixed' ? 'mixed' : 'mix entry'}, kept apart` : '') + (spentChecked.get(key) ? ' · spent' : ''));
  const said = { checking: ' · being checked, not counted yet', invalid: ' · did not validate, not counted' };
  for (const [key, c] of tokens) row(key, tokenAmount(c.assetIdHex, c.amount) + (said[creditState.get(key)] || ''));
  const h = document.createElement('p');
  h.className = 'muted';
  h.textContent = tokens.some(([key]) => creditState.get(key) === 'checking' || creditState.get(key) === 'invalid')
    ? 'Found for you. Send spends the ones counted like anything else you hold:'
    : 'Found for you. Send spends them like anything else you hold:';
  box.append(h, ol);
}

function tokenAmount(assetIdHex, amount) {
  const m = held.find((a) => a.id === assetIdHex) || (() => { try { return T.getAssetMeta(assetIdHex); } catch { return null; } })() || {};
  const d = Number.isInteger(m.decimals) ? m.decimals : 0;
  return `${fmtUnits(BigInt(amount), d)} ${m.ticker && m.ticker !== '???' ? m.ticker : short(assetIdHex, 4)}`;
}

// Shielded token payments in one transaction, credited to this wallet.
async function checkToken(txid) {
  const found = await T.discoverStealthFromTxid(txid, { merge: true });
  for (const f of found) track(txid, `Received ${tokenAmount(f.assetIdHex, f.amount)}`);
  return found;
}

// The pool's own assets, so a wallet that has never held one still finds a shielded receipt of it — the
// case for anyone taking delivery of a pool asset for the first time. secret.js owns the list, and it is
// already the module this page imports lazily, so there is one source of truth and no second copy to drift.
async function poolAssetIds() {
  try { const m = await import(SECRET_URL); return (m.livePoolAssets?.() || []).map((a) => a.id); } catch { return []; }
}

// Shielded receipts for the tokens this wallet holds or knows of, via the worker's per-token transfer index.
async function scanTokens(line) {
  const seeded = T.NET.name === 'mainnet' ? await poolAssetIds() : [];
  const ids = [...new Set([...(KNOWN_ASSETS[T.NET.name] || []), ...seeded, ...held.map((a) => a.id)])];
  let found = 0, txs = 0;
  for (const id of ids) {
    const r = await T.scanAssetForStealthReceipts(id, {
      onProgress: (p) => { line.textContent = `Tokens: ${txs + p.txsScanned + p.txsSkipped} transfers checked · ${found + p.found} found…`; },
    });
    found += r.discovered.length;
    txs += r.txsScanned + r.txsSkipped;
    for (const f of r.discovered) track(f.txid, `Received ${tokenAmount(f.assetIdHex, f.amount)}`);
  }
  line.textContent = `Tokens: ${txs.toLocaleString('en-US')} transfers checked, ${found ? `${found} payment${found === 1 ? '' : 's'} found for you` : 'none for you'}.`;
  return found;
}

// kind: 'sp' (silent sats), 'st' (shielded token) or null (try both).
async function checkPayment(txid, kind = null) {
  const out = $('scan-out');
  await ensureKey();
  out.textContent = `Checking ${short(txid, 8)}…`;
  let found = [], spErr = null;
  if (kind !== 'st') {
    try { found = await T.discoverSilentPaymentFromTxid(txid); }
    catch (e) {
      if (/missing or malformed/.test(e?.message || '')) throw fail(`Transaction ${short(txid, 8)} was not found on ${T.NET.name}.`);
      if (/not fully indexed/.test(e?.message || '')) throw fail(`Transaction ${short(txid, 8)} is not indexed yet. Try again in a minute.`);
      if (kind === 'sp') throw e;
      spErr = e;
    }
  }
  if (found.length) {
    const total = found.reduce((s, f) => s + Number(f.sats), 0);
    out.replaceChildren(`Found ${fmtSats(total)} for you in `, txLink(txid), '.');
    track(txid, `Received ${fmtSats(total)}`);
  } else {
    const tokens = kind === 'sp' ? [] : await checkToken(txid).catch((e) => {
      if (/missing or malformed/.test(e?.message || '')) return [];
      throw e;
    });
    if (tokens.length) out.replaceChildren(`Found ${tokens.map((f) => tokenAmount(f.assetIdHex, f.amount)).join(' + ')} for you in `, txLink(txid), '.');
    // A sats check that failed is not a "no": say why it could not be read.
    else if (spErr) throw spErr;
    else out.replaceChildren('That payment is not addressed to this wallet. ', txLink(txid));
  }
  try { T.invalidateHoldingsCache?.(); } catch {}
  await refresh();
}

let hashChecked = null;
async function checkHashPayment() {
  const h = parseHash();
  const net = h.net;
  const sp = h.sp || h.st;
  const kind = h.sp ? 'sp' : 'st';
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
  // Marked checked only once the check runs: a scan in progress leaves it for the next chance.
  await busy([$('btn-check'), $('btn-scan')], () => { hashChecked = sp; return checkPayment(sp, kind); }, out);
}

function parseCheckInput(s) {
  s = s.trim();
  const m = s.match(/[#&?](sp|st)=([0-9a-fA-F]{64})/) || s.match(/^()([0-9a-fA-F]{64})$/);
  if (!m) throw fail('Paste a payment link or a 64-character txid.');
  const n = s.match(/[#&?]net=(mainnet|signet)/);
  if (n && n[1] !== T.NET.name) throw fail(`That link is for ${n[1]}. Switch the network above first.`);
  return { txid: m[2].toLowerCase(), kind: m[1] || null };
}

// A request that hangs gives up after FETCH_MS, so a balance never waits on it for minutes.
function withTimeout(signal, ms = FETCH_MS) {
  if (!signal) return AbortSignal.timeout(ms);
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : signal;
}

async function getJson(path, signal) {
  const bases = [T.NET.api, T.NET.api2].filter(Boolean);
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const base = bases[attempt % bases.length];
    try {
      const r = await fetch(base + path, { signal: withTimeout(signal) });
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
  await ensureKey();
  const ctl = new AbortController();
  scanAbort = ctl;
  show('btn-scan-stop', true);
  $('btn-scan-stop').disabled = false;
  const out = $('scan-out');
  const satsLine = document.createElement('div');
  const tokLine = document.createElement('div');
  out.replaceChildren(satsLine, tokLine);
  satsLine.textContent = 'Sats: starting…';
  let res = null, prog = null, tokens = 0;
  try {
    if (!url || !indexState.ok) {
      satsLine.textContent = 'Sats: the silent-payment index is offline. Paste the payment link instead.';
    } else {
      try {
        res = await T.scanSilentPaymentsViaIndex({
          baseUrl: url,
          signal: ctl.signal,
          onProgress: (p) => { prog = p; satsLine.textContent = `Sats: block ${p.height} of ${p.to} · ${p.found} found…`; },
        });
        const n = res.found.length;
        const total = res.found.reduce((s, f) => s + Number(f.sats || 0), 0);
        const span = res.blocks ? `${res.blocks.toLocaleString('en-US')} block${res.blocks === 1 ? '' : 's'}` : 'no new blocks';
        satsLine.textContent = `Sats: ${ctl.signal.aborted ? 'stopped, ' : ''}${span}, ${res.txs.toLocaleString('en-US')} transactions checked, ${n ? `${fmtSats(total)} found for you` : 'none for you'}.`;
        for (const f of res.found) track(f.txid, `Received ${fmtSats(f.sats)}`);
      } catch (e) {
        const found = prog?.found || 0;
        satsLine.textContent = ctl.signal.aborted
          ? `Sats: stopped${prog ? ` at block ${prog.height}` : ''}. ${found} found.`
          : `Sats: stopped${prog ? ` at block ${prog.height}` : ''}: ${errMsg(e)} ${found} found so far.`;
      }
    }
    if (ctl.signal.aborted) return;
    tokLine.textContent = 'Tokens: checking…';
    try { tokens = await scanTokens(tokLine); }
    catch (e) { tokLine.textContent = `Tokens: ${errMsg(e)}`; }
  } finally {
    scanAbort = null;
    show('btn-scan-stop', false);
    renderScan();
    if (tokens) { try { T.invalidateHoldingsCache?.(); } catch {} }
    if (res?.found.length || prog?.found || tokens) await refresh(); else renderFound();
  }
}

// ---------- secret payment mount ----------

// Each panel hears of a change once: a listener is called only when what it was last told differs (the mainnet pool
// panel reads its balances again on every call, so a repeat would re-read them for nothing).
const told = new WeakMap();
function emit() {
  const w = T?.wallet;
  const detail = {
    connected: !!w?.pub, unlocked: !!w?.priv,
    address: w?.pub ? w.address() : null, pubHex: w?.pub ? T.bytesToHex(w.pub) : null,
    sats: satsTotal,
  };
  const sig = JSON.stringify(detail);
  for (const fn of listeners) {
    if (told.get(fn) === sig) continue;
    told.set(fn, sig);
    try { fn(detail); } catch (e) { console.error(e); }
  }
}

let secretMounted = false;
let secretHandle = null;
async function mountSecret() {
  if (secretMounted) return;
  secretMounted = true;
  const ph = $('secret-placeholder');
  const mainnet = T.NET.name === 'mainnet';
  let mod;
  try { mod = await import(SECRET_URL); } catch (e) { console.warn('[sats] secret.js', e); if (ph) ph.textContent = 'Secret payments are coming soon.'; return; }
  const fn = mainnet ? mod.mountMainnet : mod.mount;
  if (typeof fn !== 'function') { if (ph) ph.textContent = 'Secret payments are coming soon.'; return; }
  if (ph) ph.remove();
  show('secret-steps', true);
  try {
    secretHandle = await fn($('secret-steps'), {
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

// ---------- mix mount ----------

let mixMounted = false;
async function mountMix() {
  if (mixMounted) return;
  mixMounted = true;
  const ph = $('mix-placeholder');
  if (T.NET.name !== 'signet') { renderNet(); return; }
  let mod;
  try { mod = await import(MIX_URL); } catch (e) { console.warn('[sats] mix.js', e); ph.textContent = 'Mixing is coming soon.'; return; }
  ph.remove();
  try {
    mod.mount($('mix-steps'), {
      tacit: T, wallet: T.wallet, network: T.NET.name, log, refresh, ensureKey, track, errMsg, hold,
      onWallet(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      secretModule: () => import(SECRET_URL),
      secretHandle: () => secretHandle,
      hintEl: $('mix-hint'),
      openMix: () => selectTab('mix', { focus: true, remember: true }),
    });
    emit();
  } catch (e) { log('Mix failed to load: ' + errMsg(e), 'error'); }
}

// ---------- private ETH mount ----------

let ethMounted = false;
async function mountEth() {
  if (ethMounted) return;
  ethMounted = true;
  const ph = $('eth-placeholder');
  let mod;
  try { mod = await import(ETH_URL); } catch (e) { console.warn('[sats] eth.js', e); ph.textContent = 'Private ETH is coming soon.'; return; }
  ph.remove();
  try {
    await mod.mount($('eth-root'), {
      wallet: T.wallet, network: T.NET.name, ensureKey, errMsg, switchNet, hold, toast,
      onWallet(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    });
  } catch (e) { log('Private ETH failed to load: ' + errMsg(e), 'error'); }
}

// ---------- pool panel ----------

async function poolStatus() {
  try {
    const r = await fetch(POOL_STATUS, { cache: 'no-store', signal: AbortSignal.timeout(FETCH_MS) });
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
      const net = a.dataset.net;
      if (net !== curNet()) switchNet(net);
    };
  }
  $('chip').onclick = toWallet;
  const way = (fn) => () => busy(connectButtons(), () => signIn(fn));
  $('btn-known').onclick = way(continueKnown);
  $('btn-passkey').onclick = way(() => usePasskey());
  $('btn-passkey-restore').onclick = way(() => usePasskey({ restore: true }));
  $('btn-create').onclick = way(() => createWallet());
  $('btn-import').onclick = () => { show('import-row', $('import-row').classList.contains('hidden')); $('import-key').focus(); };
  $('btn-import-go').onclick = way(importKey);
  $('import-key').onkeydown = (e) => { if (e.key === 'Enter') $('btn-import-go').click(); };
  $('btn-eth').onclick = way(() => linkEth());
  $('btn-xverse').onclick = way(() => linkExt('xverse'));
  $('btn-unisat').onclick = way(() => linkExt('unisat'));
  $('btn-btc').onclick = way(() => linkBtcId());
  $('send-asset').onchange = () => { renderSendLabels(); show('share', false); $('send-out').textContent = ''; };
  $('copy-st').onclick = () => copy($('w-st').dataset.full);
  $('faucet').onclick = () => busy($('faucet'), faucetSats);
  $('btn-refresh').onclick = () => busy($('btn-refresh'), async () => { spentChecked.clear(); exitStale = true; try { T.invalidateHoldingsCache?.(); } catch {} await refresh(); });
  $('btn-sweep').onclick = () => busy([$('btn-sweep'), $('btn-send')], sweep, $('sweep-out'), { pays: true });
  $('btn-unlock').onclick = () => busy($('btn-unlock'), unlock);
  $('btn-fund').onclick = () => { show('fund-row', $('fund-row').classList.contains('hidden')); $('fund-amt').focus(); };
  $('btn-fund-go').onclick = () => busy($('btn-fund-go'), fund, null, { pays: true });
  $('btn-backup').onclick = () => busy($('btn-backup'), async () => { await ensureKey(); openBackup(); });
  $('btn-backup-copy').onclick = () => copy($('backup-key').textContent);
  $('btn-backup-done').onclick = () => {
    store.set('tacit-backup-ack-v1:' + T.bytesToHex(T.wallet.pub), '1');
    $('backup-key').textContent = '—';
    show('backup', false);
  };
  $('backup-key').onclick = () => copy($('backup-key').textContent);
  $('btn-disconnect').onclick = () => {
    if (working || moving()) { toast('Wait for the step in progress to finish, or leave its round, then sign out.', true); return; }
    signOut();
  };
  $('copy-addr').onclick = () => copy($('w-addr').textContent);
  $('copy-sp').onclick = () => copy($('w-sp').dataset.full);
  $('btn-send').onclick = () => busy([$('btn-send'), $('btn-sweep')], send, $('send-out'), { pays: true });
  $('btn-share-copy').onclick = () => copy($('share-url').textContent);
  $('btn-mix-hint').onclick = () => selectTab('mix', { focus: true, remember: true });
  $('btn-check').onclick = () => busy([$('btn-check'), $('btn-scan')], () => { const p = parseCheckInput($('check-in').value); return checkPayment(p.txid, p.kind); }, $('scan-out'));
  $('btn-scan').onclick = () => busy([$('btn-scan'), $('btn-check')], scan, $('scan-out'));
  $('btn-scan-stop').onclick = () => { scanAbort?.abort(); $('btn-scan-stop').disabled = true; };
  window.addEventListener('hashchange', () => {
    const { net } = parseHash();
    const sp = parseHash().sp || parseHash().st;
    // A link for the other network reloads the page on it, keeping the link so the payment is checked there.
    if (net && net !== curNet()) {
      if (T && (working || moving())) { toast(`That link is for ${net}. Open it again once the step in progress has finished.`, true); return; }
      store.set(NET_PREF, net);
      if (T) { releaseSharedNet(); location.reload(); } else { renderNet(); probeIndex(); refreshCreateLabel(); paintChip(); loadKnown(); resume(); }
      return;
    }
    hashChecked = null;
    if (sp) selectTab('receive');
    if (sp && !T?.wallet.pub) log('Someone sent you a payment link. Connect your wallet to check it.');
    checkHashPayment();
  });
  window.addEventListener('pagehide', () => releaseSharedNet());       // also when tacit.js failed to load after the claim
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
  const h = parseHash();
  selectTab(h.eth ? 'eth' : h.sp || h.st ? 'receive' : store.get(TAB_PREF) || (netPref() === 'signet' ? 'secret' : 'send'));
}

function refreshCreateLabel() {
  const has = hasLocalWallet();
  $('create-t').textContent = has ? 'Unlock your local wallet' : 'Generate a local wallet';
  $('create-m').textContent = has
    ? 'The wallet saved in this browser. Enter its passphrase.'
    : 'Works in every browser. A new key, locked with a passphrase you set next. Back it up.';
  // Passkey leads where the browser supports it, as on tacit.finance; otherwise the local wallet does.
  const pk = passkeyOk();
  const b = $('btn-passkey');
  b.disabled = !pk;
  b.title = pk ? '' : 'Passkeys need https and a supporting browser';
  b.classList.toggle('primary', pk);
  $('btn-create').classList.toggle('primary', !pk);
  show('passkey-rec', pk);
  show('local-rec', !pk);
  show('passkey-alt', pk && !savedPasskey());
  // On mainnet, the wallet tacit.finance has open leads, in one press.
  const k = knownWallet();
  show('btn-known', !!k);
  show('known-or', !!k);
  if (k) {
    $('known-t').textContent = k.tacit ? `Continue as ${short(k.tacit, 7)}` : 'Continue with your Tacit wallet';
    $('known-m').textContent = `Opens with ${viaKnown(k)}, the same key as on tacit.finance.`;
    b.classList.remove('primary');
    $('btn-create').classList.remove('primary');
    show('passkey-rec', false);
    show('local-rec', false);
  }
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
  const { net, eth } = parseHash();
  if (net || eth) store.set(NET_PREF, net || 'mainnet');
  wire();
  wireTabs();
  renderNet();
  refreshCreateLabel();
  paintChip();
  loadKnown();
  poolStatus();
  probeIndex();
  setInterval(() => { if (!document.hidden) poolStatus(); }, 60_000);
  await resume();
}

// Reconnect a previous session on this network, or load the wallet code for a payment link.
async function resume() {
  const sp = parseHash().sp || parseHash().st;
  if (!(store.get(SESSION) === '1' && readIdentity()) && !sp) return;
  try {
    await loadTacit();
    if (T.wallet.pub) return;
    if (restore()) await connected();
    else if (sp) log('Someone sent you a payment link. Connect your wallet to check it.');
  } catch (e) { log('Could not load the wallet: ' + errMsg(e), 'error'); }
}

boot();
