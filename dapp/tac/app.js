// tacit.finance/tac — shielded TAC on Bitcoin.
//
// Everything here runs against the same modules the /sats page uses: dapp/sats/secret.js owns the pool
// operations (shield, private pay, exit, note scanning) and dapp/tacit.js owns the wallet and the chain
// reads. This file is the page: wallet gate, balances, the four panes, and the live pool strip.
//
// Every proof is made on this device. The pool's relayer is used for payments whenever it quotes TAC —
// then the sender needs no BTC at all and pays the relayer inside the pool. Shields and exits always fund
// their own carrier, by design, so those need a little BTC in the wallet.

const SATS_URL = '/tac/sats.js?cb=6655b51b';     // tokens rewritten by build/build.mjs (TAC_CB_FILES)
const MARKET_URL = '/tac/market.js?cb=8508c2d7';
const CLAIM_URL = '/tac/claim.js?cb=25c5f1f4';
const UNIFIED_URL = '/tacit-unified.js?cb=a5b3a042';
const KNOWN_URL = '/tacit-wallet-known.js?cb=49410363';
const WORKER = 'https://api.tacit.finance';
const ASSET = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';

const $ = (id) => document.getElementById(id);

let T = null;          // dapp/tacit.js
let S = null;          // dapp/sats/secret.js
let prf = null;        // dapp/prf-wallet.js
let K = null;          // dapp/tacit-wallet-known.js
let poolWallet = null;
let tacitAddress = null;   // the unified tacit1… address of the open key: null until its module has loaded, false if it could not
let pub = { loading: false, notes: [], decimals: 8 };
let shielded = { loading: false, notes: [] };
let relayLive = null;
let relayFee = null;   // the relayer's quoted fee for TAC, in base units
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
// fmt() is for reading; this is for writing back into an input, because parseUnits rejects separators.
const fmtPlain = (units, d = DECIMALS) => {
  const s = BigInt(units).toString().padStart(d + 1, '0');
  const frac = s.slice(-d).replace(/0+$/, '');
  return frac ? `${s.slice(0, -d)}.${frac}` : s.slice(0, -d);
};
const parseUnits = (str, d = DECIMALS) => {
  const m = String(str || '').trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2]) || (m[2] || '').length > d) throw new Error(`Enter an amount with at most ${d} decimals.`);
  return BigInt((m[1] || '0') + (m[2] || '').padEnd(d, '0'));
};
const short = (s, a = 14, b = 8) => (String(s).length > a + b + 1 ? `${String(s).slice(0, a)}…${String(s).slice(-b)}` : String(s));
const txLink = (txid) => {
  const a = document.createElement('a');
  a.href = `https://mempool.space/tx/${txid}`; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = `${txid.slice(0, 10)}…`;
  return a;
};
function say(id, ...nodes) {
  const el = $(id);
  if (!el) return;
  el.replaceChildren(...nodes.filter((n) => n != null).map((n) => (typeof n === 'string' ? document.createTextNode(n) : n)));
}
function errSay(id, e) {
  const msg = String(e?.message || e || 'Something went wrong.');
  const span = document.createElement('span');
  span.className = 'err'; span.setAttribute('role', 'alert'); span.textContent = msg;
  say(id, span);
  if (!/^Cancelled/.test(msg)) console.warn('[tac]', id, e);
}

// One action at a time: they share the wallet's key and the prover. A click that arrives while something
// else is running has to say so — swallowing it silently reads as a dead button, which is exactly how it
// looked while a background scan held the lock.
async function busy(btn, id, fn) {
  if (busyId) { say(id, busyId === id ? 'Already working on that…' : 'Finishing the last action first — try again in a moment.'); return; }
  busyId = id;
  const wasDisabled = btn.disabled;
  btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try { await fn(); }
  catch (e) { errSay(id, e); }
  finally { busyId = null; btn.disabled = wasDisabled; btn.removeAttribute('aria-busy'); }
}

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
  try { btcUsd = await T.getBtcUsdPrice(); } catch { btcUsd = null; }
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
  use.setAttribute('href', '#i-btc');
  svg.append(use); svg.setAttribute('aria-hidden', 'true');
  const b = document.createElement('b');
  b.textContent = `${markSats.toLocaleString('en-US')} sats`;
  el.replaceChildren(svg, b);
  if (oneTac != null) el.append(document.createTextNode(` · ${usdText(oneTac)}`));
  el.append(document.createTextNode(' / TAC'));
}

// ── modules ──
async function loadTacit() {
  if (T) return T;
  globalThis.__TACIT_NO_INIT__ = true;
  try { localStorage.setItem('tacit-network-v1', 'mainnet'); } catch {}
  T = await import('/tacit.js');
  S = await import('/sats/secret.js');
  try { prf = await import('/prf-wallet.js'); } catch { prf = null; }
  try { K = await import(KNOWN_URL); } catch { K = null; }
  return T;
}

// ── wallet ──
// The wallet this page offers is the one tacit.finance has open, chosen by the module weld and pay share
// (tacit-wallet-known.js), so every page opens the same key.
const isPub = (h) => /^0[23][0-9a-f]{64}$/.test(String(h || '').toLowerCase());

let known = null;   // { mode, pubHex, address?, ext?, label?, credentialId? }

const knownWallet = () => K?.siteWallet() ?? null;

const viaText = (k) => ({
  eth: `an Ethereum wallet (${short(k?.address || '', 6, 4)})`,
  btc: `a Bitcoin wallet (${short(k?.address || '', 6, 4)})`,
  ext: `a key funded by ${short(k?.address || '', 6, 4)}`,
  passkey: `the passkey “${k?.label || 'Tacit'}”`,
  local: 'the key saved in this browser',
}[k?.mode] || 'your wallet');

// tacit.js keeps one global wallet, so each open runs in its own turn — a key never changes mid-operation.
let walletQ = Promise.resolve();
const turn = (fn) => { const r = walletQ.then(async () => { await loadTacit(); return fn(); }); walletQ = r.catch(() => {}); return r; };

function haveWallet() { return !!(T && T.wallet.pub); }
const unlocked = () => !!(T && T.wallet.priv);

function refreshChip() {
  const dot = $('wallet-dot'), label = $('wallet-label');
  if (unlocked()) { dot.className = 'dot on'; label.textContent = short(T.wallet.address(), 10, 6); return; }
  if (known || haveWallet()) { dot.className = 'dot live'; label.textContent = 'Unlock'; return; }
  dot.className = 'dot'; label.textContent = 'Connect';
}

// Whatever route opened the key, it must be the key this browser's stored identity advertised.
function adopt(expectedPubHex) {
  if (!T.wallet.priv) throw new Error('That did not open a key.');
  const got = T.bytesToHex(T.wallet.pub).toLowerCase();
  if (expectedPubHex && got !== String(expectedPubHex).toLowerCase()) {
    T.wallet.priv = null; T.wallet.pub = null;
    throw new Error('That opened a different key than this browser expected. Nothing was changed.');
  }
  afterUnlock();
}

async function openKnown(k) {
  if (!k) throw new Error('No wallet saved in this browser yet — create one first.');
  if (k.mode === 'eth' || k.mode === 'btc') {
    throw new Error(`Your current wallet is ${viaText(k)}, which opens on tacit.finance. Unlock it there once, then reload this page.`);
  }
  if (k.mode === 'passkey') {
    if (!prf?.isPasskeyAvailable?.()) throw new Error('Passkeys need a browser that supports them.');
    // Through prfWallet, never setPriv: setPriv asks for a new passphrase and writes the key under the
    // local-wallet storage key, which would overwrite a password wallet saved in this browser and lose it.
    await turn(() => T.prfWallet.login({ credentialId: k.credentialId, label: k.label }));
    return adopt(k.pubHex);
  }
  await turn(async () => {
    T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null;
    T.extWallet.state = k.mode === 'ext' ? k.ext : null;
    await T.wallet.load(k.mode === 'ext' ? k.address : null);
  });
  return adopt(k.pubHex);
}

// Unlock if needed, and always leave `poolWallet` derived. Separate conditions: a key can already be in
// memory while this page has never derived the pool wallet from it, and every pool call below would then
// be handed a null wallet.
async function ensureKey() {
  if (!unlocked()) {
    if (known) await openKnown(known);
    else if (haveWallet()) { await turn(() => T.ensurePrivkey()); adopt(null); }
    else throw new Error('Connect a wallet first.');
  }
  if (!poolWallet) afterUnlock();
}

function afterUnlock() {
  // tacit.js only drops this cache inside ensurePrivkey; these paths open a key without going through it,
  // so a 30s-stale Map from the previous identity could otherwise be read as this one's holdings.
  try { T.invalidateHoldingsCache?.(); } catch {}
  poolWallet = S.poolWalletFor(T.wallet.priv, 'mainnet');
  tacitAddress = null;
  paintReceive(); loadTacitAddress();
  refreshChip(); renderKnownLine();
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
  $('recv-addr').value = poolWallet ? poolWallet.addressString : 'Unlock to see your pool address';
  $('recv-tacit').value = !poolWallet ? 'Unlock to see your Tacit address'
    : tacitAddress === false ? 'Not available here: use the pool address below.' : tacitAddress || 'Deriving your Tacit address…';
}
// Receive leads with the unified Tacit address, which the pool pays, and keeps the pool address beneath it.
async function loadTacitAddress() {
  const pw = poolWallet;
  try {
    const { unifiedAddress } = await import(UNIFIED_URL);
    if (poolWallet !== pw || !T.wallet.priv) return;
    tacitAddress = unifiedAddress(T.wallet.priv).address;
  } catch (e) {
    console.warn('[tac] tacit address', e);
    if (poolWallet !== pw) return;
    tacitAddress = false;
  }
  paintReceive();
}

function lock() {
  if (T) T.wallet.priv = null;
  $('key-out').value = '';
  try { T.invalidateHoldingsCache?.(); } catch {}
  poolWallet = null;
  tacitAddress = null;
  shielded = { loading: false, notes: [] };
  pub = { loading: false, notes: [], decimals: DECIMALS };
  paintReceive();
  refreshChip(); renderBalances(); renderShieldPicker(); renderKnownLine();
  window.dispatchEvent(new Event('tac:wallet'));
  say('st-connect', 'Locked. The key stays saved in this browser.');
}

function renderKnownLine() {
  const line = $('known-line'), openBtn = $('btn-open'), lockBtn = $('btn-lock'), createBtn = $('btn-create');
  if (!line) return;
  if (unlocked()) {
    line.hidden = false;
    line.textContent = `Open via ${viaText(known || { mode: 'local' })}.`;
    openBtn.hidden = true; lockBtn.hidden = false; createBtn.hidden = true;
    return;
  }
  lockBtn.hidden = true;
  if (known) {
    line.hidden = false;
    line.textContent = `This browser already has a wallet: ${viaText(known)}.`;
    openBtn.hidden = false;
    openBtn.textContent = known.mode === 'passkey' ? 'Unlock with passkey' : 'Unlock';
    createBtn.hidden = true;
  } else {
    line.hidden = true; openBtn.hidden = true; createBtn.hidden = false;
  }
}

async function createWallet() {
  await turn(async () => {
    T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null; T.extWallet.state = null;
    await T.wallet.load();
  });
  adopt(null);
  known = knownWallet();
  $('connect-sheet').close();
  say('st-connect', '');
  showKey();
  await refreshAll();
}

async function unlockKnown() {
  await openKnown(known);
  $('connect-sheet').close();
  say('st-connect', '');
  await refreshAll();
}

async function importKey() {
  const hex = $('import-key').value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('A Tacit key is 64 hex characters.');
  await turn(async () => {
    T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null; T.extWallet.state = null;
    await T.wallet.setPriv(hex);
  });
  $('import-key').value = '';
  adopt(null);
  known = knownWallet();
  $('connect-sheet').close();
  await refreshAll();
}

function showKey() {
  if (!unlocked()) return;
  $('key-out').value = T.bytesToHex(T.wallet.priv);
  $('key-sheet').showModal();
}

// ── balances ──
async function loadPublic() {
  if (!unlocked()) return;
  pub = { ...pub, loading: true }; renderBalances();
  try {
    const h = await T.scanHoldings();
    const entry = h instanceof Map ? h.get(S.TAC_ASSET_MAINNET) : null;
    pub = {
      loading: false,
      notes: entry?.utxos || [],
      decimals: Number.isInteger(entry?.decimals) ? entry.decimals : DECIMALS,
    };
  } catch (e) { pub = { ...pub, loading: false }; errSay('st-shield', e); }
  renderBalances(); renderShieldPicker();
}

async function loadShielded() {
  if (!poolWallet) return;
  shielded = { ...shielded, loading: true }; renderBalances();
  try { shielded = { loading: false, notes: await S.poolNotes(poolWallet, S.TAC_ASSET_MAINNET) }; }
  catch (e) { shielded = { ...shielded, loading: false }; errSay('st-recv', e); }
  renderBalances();
}

const relayFeeUnits = () => (relayLive && relayFee != null ? relayFee : 0n);
const noteVal = (u) => (typeof u.amount === 'bigint' ? u.amount : BigInt(u.amount));
const publicTotal = () => pub.notes.reduce((t, u) => t + noteVal(u), 0n);
const shieldedTotal = () => (shielded.notes || []).filter((n) => !n.spent).reduce((t, n) => t + BigInt(n.value), 0n);

function renderBalances() {
  const sT = shieldedTotal(), pT = publicTotal();
  $('bal-shielded').textContent = !haveWallet() ? '—' : shielded.loading ? '…' : fmt(sT);
  $('bal-public').textContent = !haveWallet() ? '—' : pub.loading ? '…' : fmt(pT);
  $('bal-shielded-sats').textContent = haveWallet() && !shielded.loading && sT > 0n ? satsText(sT) : '';
  $('bal-public-sats').textContent = haveWallet() && !pub.loading && pT > 0n ? satsText(pT) : '';
  // Spends pad to three outputs with zero-value notes so the real count stays hidden on chain. They are
  // padding, not holdings — counting them would tell the wallet's owner they have notes they don't.
  const n = (shielded.notes || []).filter((x) => !x.spent && BigInt(x.value) > 0n).length;
  $('bal-note').textContent = !haveWallet() ? 'Connect a wallet to see your balances.'
    : !unlocked() ? 'Unlock to scan the pool for your notes.'
    : `${n} shielded note${n === 1 ? '' : 's'} only you can see.`;
  $('btn-refresh').hidden = !haveWallet();
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
  const sel = $('shield-pick');
  sel.replaceChildren();
  if (!pub.notes.length) {
    const o = document.createElement('option');
    o.textContent = unlocked() ? 'No public TAC in this wallet' : 'Unlock to load your TAC';
    sel.append(o); sel.disabled = true;
    $('shield-stealth-note').textContent = '';
    return;
  }
  // A stealth-received note sits at P2WPKH(walletPub + b·G) and is spent with its tweaked key; shieldNote
  // signs with the wallet key alone, so offering one here would broadcast a commit whose reveal is invalid.
  const shieldable = pub.notes.filter((u) => !u.stealthTweakedSk);
  const stealthHeld = pub.notes.length - shieldable.length;
  $('shield-stealth-note').textContent = stealthHeld
    ? `${stealthHeld} note${stealthHeld === 1 ? '' : 's'} paid to a one-time address ${stealthHeld === 1 ? 'is' : 'are'} in your balance but cannot be shielded from this page yet — spend ${stealthHeld === 1 ? 'it' : 'them'} on tacit.finance first.`
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
      if (i === 0) o.selected = true;
      sel.append(o);
    });
}

// ── pool stats ──
async function loadStats() {
  try {
    const st = await S.poolClientFor('mainnet').status();
    $('s-set').textContent = Number(st.leafCount || 0).toLocaleString('en-US');
    $('s-height').textContent = Number(st.height || 0).toLocaleString('en-US');
    $('s-proof').textContent = st.proofSystem === 'halo2-kzg-bn254' ? 'Halo2·KZG' : (st.proofSystem || '—');
    const feed = await S.poolClientFor('mainnet').allNotes().catch(() => null);
    const spends = feed ? new Set(feed.filter((n) => n.txid).map((n) => n.txid)).size : null;
    $('s-spends').textContent = spends == null ? '—' : spends.toLocaleString('en-US');
  } catch { /* the strip stays dashed; the page still works */ }
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
  const u = shieldable.find((x) => `${x.utxo.txid}:${x.utxo.vout}` === picked) || shieldable[0];
  if (!u) throw new Error('No shieldable TAC in this wallet yet.');
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
      ? `More than your shielded balance once the relayer's ${fmt(relayFeeUnits())} TAC fee is included.`
      : 'More than your shielded balance.');
  }
  const r = await S.payPrivately(T, { poolWallet, to, amount, asset: S.TAC_ASSET_MAINNET, anchor, say: (m) => say('st-send', m) });
  if (r.wait) return waitBox('st-send', r, (tip) => doSend(tip));
  $('send-to').value = ''; $('send-amt').value = ''; renderAmountHints();
  say('st-send', `Sent ${fmt(amount)} TAC in `, txLink(r.revealTxid), r.relayed ? ' — relayed, fee paid in TAC.' : ' — self-funded.');
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

// A note younger than the wallet's anchor policy can still be spent — against the newest block instead of a
// settled one — but that tells an observer the note is new. The choice is the wallet owner's, not ours.
function waitBox(statusId, w, retry) {
  const wrap = document.createElement('div');
  const p = document.createElement('div');
  p.textContent = `Your newest note needs ${w.wait} more Bitcoin block${w.wait === 1 ? '' : 's'} (about ${w.wait * 10} min) before the wallet will spend it against a settled block.`;
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
function tabs(ids, panes, onPick) {
  ids.forEach((id, i) => {
    $(id).addEventListener('click', () => {
      ids.forEach((x, j) => { $(x).setAttribute('aria-selected', String(i === j)); $(panes[j]).hidden = i !== j; });
      onPick?.(i);
    });
  });
}

async function refreshAll() {
  renderBalances(); refreshChip();
  await Promise.all([loadPublic(), loadShielded()]);
  await recoverExits().catch(() => {});
}

// TAC withdrawn to this wallet that this browser holds no opening for (withdrawn on another device, or before its
// storage was cleared) is opened again from the pool seed, and the public balance read again when any is.
async function recoverExits() {
  if (!unlocked() || !poolWallet || !shielded.notes) return;
  const h = await T.scanHoldings();
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
    report?.(`Could not check for stealth payments: ${e?.message || e}`);
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
(async function boot() {
  tabs(['tab-shield', 'tab-send', 'tab-withdraw', 'tab-receive', 'tab-market'],
    ['pane-shield', 'pane-send', 'pane-withdraw', 'pane-receive', 'pane-market'],
    (i) => {
      if (i === 3) paintReceive();
      if (i === 4) renderMarket();
    });
  tabs(['wtab-self', 'wtab-sats'], ['wpane-self', 'wpane-sats'], (i) => { if (i === 1) renderSats(); });

  watchPassphrase();
  $('wallet-chip').onclick = async () => {
    await loadTacit();
    known = known || knownWallet();
    renderKnownLine();
    if (unlocked()) return showKey();
    $('connect-sheet').showModal();
  };
  $('connect-x').onclick = () => $('connect-sheet').close();
  $('key-x').onclick = () => $('key-sheet').close();
  $('btn-open').onclick = (e) => busy(e.currentTarget, 'st-connect', unlockKnown);
  $('btn-lock').onclick = () => { lock(); $('connect-sheet').close(); };
  $('btn-create').onclick = (e) => busy(e.currentTarget, 'st-connect', createWallet);
  $('btn-import').onclick = (e) => busy(e.currentTarget, 'st-connect', importKey);
  $('btn-key-copy').onclick = () => { navigator.clipboard?.writeText($('key-out').value); };
  $('btn-key-lock').onclick = () => { $('key-sheet').close(); lock(); };
  $('key-sheet').addEventListener('close', () => { $('key-out').value = ''; });
  $('btn-refresh').onclick = (e) => busy(e.currentTarget, 'st-recv', () => scanEverything('st-recv'));

  $('btn-shield').onclick = (e) => busy(e.currentTarget, 'st-shield', doShield);
  $('btn-send').onclick = (e) => busy(e.currentTarget, 'st-send', () => doSend());
  $('btn-exit').onclick = (e) => busy(e.currentTarget, 'st-exit', () => doExit());
  $('send-amt').addEventListener('input', renderAmountHints);
  $('exit-amt').addEventListener('input', renderAmountHints);
  // "max" before the pool scan has run would otherwise quietly write 0 and look like an empty balance.
  const maxInto = (field, statusId) => async () => {
    if (!haveWallet() && !known) return say(statusId, 'Connect a wallet first.');
    if (!shielded.notes.length && !shielded.loading) { await ensureKey(); await loadShielded(); }
    const total = shieldedTotal() - (field === 'send-amt' ? relayFeeUnits() : 0n);
    if (total <= 0n) return say(statusId, 'Nothing shielded yet — shield some TAC first.');
    $(field).value = fmtPlain(total);
    renderAmountHints();
    say(statusId, '');
  };
  $('send-max').onclick = () => maxInto('send-amt', 'st-send')().catch((e) => errSay('st-send', e));
  $('exit-max').onclick = () => maxInto('exit-amt', 'st-exit')().catch((e) => errSay('st-exit', e));
  $('btn-copy').onclick = () => {
    if (!poolWallet) return say('st-recv', 'Unlock the wallet first — your pool address is derived from its key.');
    navigator.clipboard?.writeText(poolWallet.addressString);
    say('st-recv', 'Pool address copied.');
  };
  $('btn-copy-tacit').onclick = () => {
    if (!poolWallet) return say('st-recv', 'Unlock the wallet first — your Tacit address is derived from its key.');
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

  await loadTacit();
  // Show whichever identity this browser already has as connected-but-locked. Reading its pubkey needs no
  // passphrase and no passkey prompt; opening it is always a deliberate click.
  known = knownWallet();
  if (known && isPub(known.pubHex)) { try { T.wallet.pub = T.hexToBytes(known.pubHex); } catch {} }
  refreshChip(); renderBalances(); renderShieldPicker(); renderKnownLine();
  // Also on hashchange: opening a claim link while this page is already loaded changes only the fragment,
  // which is a same-document navigation — boot does not run again and the link would be ignored.
  const openFrag = () => {
    const frag = location.hash || '';
    if (/tacclaim=/.test(frag)) showClaim(frag).catch((e) => console.warn('[tac] claim link', e));
    else if (/^#(market|buy)$/.test(frag)) $('tab-market').click();          // a link to the market, or to buying with sats
  };
  window.addEventListener('hashchange', openFrag);
  openFrag();
  await Promise.all([loadStats(), loadPrice()]);
  if (unlocked()) await refreshAll();
})();

// ── claim links ──
// Handing shielded TAC to someone with no wallet: the link carries a throwaway pool wallet, and the
// recipient sweeps it into their own. See tac/claim.js for the wire format and why it is bearer.
let claimMod = null;
const loadClaim = async () => (claimMod ||= await import(CLAIM_URL));

async function makeClaimLink() {
  await ensureKey();
  const C = await loadClaim();
  const amount = parseUnits($('claim-amt').value);
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  if (!shielded.notes.length) await loadShielded();
  if (amount + relayFeeUnits() > shieldedTotal()) throw new Error('More than your shielded balance.');
  const pin = $('claim-pin').value.trim();
  const r = await C.createClaim(T, {
    S, pool: S.pool, poolWallet, amount, asset: S.TAC_ASSET_MAINNET, pin, network: 'mainnet',
    say: (m) => say('st-claim-make', m),
  });
  if (r.wait) return say('st-claim-make', `Your newest note needs ${r.wait} more Bitcoin block${r.wait === 1 ? '' : 's'} first.`);
  $('claim-amt').value = ''; $('claim-pin').value = '';
  const box = document.createElement('div');
  const field = document.createElement('input');
  field.readOnly = true; field.value = r.link;
  field.style.cssText = 'width:100%;font:400 12px/1.4 var(--mono);color:var(--ink);background:var(--field);border:1px solid var(--hair);padding:10px;margin-top:8px';
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
  try { C = await loadClaim(); parsed = C.decodeClaim(payload); }
  catch (e) { host.textContent = ''; return errSayInto(host, e); }
  if (parsed.network !== 'mainnet') { host.textContent = 'That link is for another network.'; return; }

  const pinField = document.createElement('input');
  pinField.placeholder = 'PIN'; pinField.autocomplete = 'off'; pinField.inputMode = 'numeric';
  pinField.style.cssText = 'width:100%;font:400 14px/1.4 var(--mono);color:var(--ink);background:var(--field);border:1px solid var(--hair);padding:12px';
  const line = document.createElement('div'); line.className = 'kv';
  const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = 'Claim into my wallet';
  const st = document.createElement('div'); st.className = 'status';

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
    await ensureKey();   // creates or unlocks a wallet, so a first-time recipient lands somewhere real
    const r = await C.sweepClaim(T, {
      S, pool: S.pool, secret32: parsed.secret32, pin: pinField.value.trim(), network: 'mainnet',
      asset: S.TAC_ASSET_MAINNET, toAddress: poolWallet.addressString, say: (m) => { st.textContent = m; },
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
  span.textContent = String(e?.message || e);
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
      markSats, get T() { return T; }, unlocked, ensureKey, turn, busy, say, errSay, txLink, refresh: () => loadPublic(),
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
