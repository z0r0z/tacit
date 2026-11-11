// tacit.finance/etch: an asset made on Bitcoin, and a search of the ones that exist. Create takes a ticker and a supply (a name, a logo and a link are optional)
// and etches it from the Tacit key the visitor opens; Discover searches the registry. tacit.js and the key come in when the visitor first touches the form
// (/trade/btc.js signs them in), not before. The asset is the key's own the moment the reveal is sent, so the front page's wallet lists it as it lists TAC.
import { $, esc, fmtUnits, parseUnits, short } from '/trade/util.js?cb=ba5a02b1';
import { ETH_LOG_NODES } from '/eth-nodes.js';
import { day } from '/trade/fmt.js?cb=32b1744b';
import { addrView } from '/address-view.js?cb=57bc64d3';
import { loadAssets, readNames, search, ipfs } from '/etch/find.js?cb=c6d1da75';

const BTC_MODULE = '/trade/btc.js?cb=d8b57cb3', ETH_MODULE = '/etch/eth.js?cb=96e842d9', WALLET_MODULE = '/trade/wallet.js?cb=c12e83a8', SHEET_MODULE = '/trade/sheet.js?cb=1161dd4e', UTIL_MODULE = '/trade/util.js?cb=ba5a02b1';
const DECIMALS_OF = { btc: [0, 2, 6, 8], eth: [0, 6, 8, 18] };
// What the pool can hold of an asset, in its base units (2^64 − 1 in-system units); on Bitcoin, the etch's own limit.
const maxFor = (dec) => (S.chain === 'eth' ? ((1n << 64n) - 1n) * 10n ** BigInt(dec - Math.min(dec, 8)) : MAX_BASE);
const API = 'https://api.tacit.finance', MEMPOOL = 'https://mempool.space', SCAN = 'https://www.tacitscan.io';
const MAX_BASE = (1n << 64n) - 1n;
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']), LOGO_MAX = 2 * 1024 * 1024;
const PAGE = 30;
const sats = (n) => Math.round(n).toLocaleString('en-US');
// The registry's assets, and what this visit etched that it does not list yet (it is read every few minutes), first.
const known = () => (S.assets ? [...S.mine.filter((m) => !S.assets.some((a) => a.id === m.id)), ...S.assets] : null);
const knownEth = () => (S.ethList ? [...S.mineEth.filter((m) => !S.ethList.some((a) => a.id === m.id)), ...S.ethList] : null);
// What this browser has etched, kept so that it is found again after the page is left (a convenience: the registry and the factory's record hold them too, and
// a Bitcoin asset is also in the wallet that holds it).
const MINE_KEY = 'tacit-etch-mine-v1';
function loadMine() {
  try {
    const v = JSON.parse(localStorage.getItem(MINE_KEY) || '[]');
    return (Array.isArray(v) ? v : []).filter((m) => m && /^(0x[0-9a-f]{40}|[0-9a-f]{64})$/.test(m.id) && typeof m.ticker === 'string').map((m) => ({ ...m, supply: m.supply == null ? null : BigInt(m.supply), mine: true, pending: false, height: Infinity }));
  } catch { return []; }
}
const saveMine = () => { try { localStorage.setItem(MINE_KEY, JSON.stringify([...S.mine, ...S.mineEth].slice(0, 40).map((m) => ({ id: m.id, chain: m.chain || 'btc', ticker: m.ticker, decimals: m.decimals, etchTxid: m.etchTxid, at: m.at, mintable: m.mintable, supply: m.supply == null ? null : String(m.supply), name: m.name, logo: m.logo && /^https:/.test(m.logo) ? m.logo : null, later: m.later, same: m.same })))); } catch { /* storage is a convenience */ } };

const S = { tab: 'create', chain: 'btc', fchain: 'btc', ethList: null, ethFailed: false, ethNamed: false, held: {}, mineEth: [], eth: { bal: null, gasPrice: 0n, px: 0 }, dec: 8, logo: null, quote: null, silent: 0, silentKey: '', busy: false, working: false, uploading: false, done: null, soft: '', mine: [], assets: null, failed: false, named: false, shown: PAGE, open: null };
{ const mine = loadMine(); S.mine = mine.filter((m) => m.chain !== 'eth'); S.mineEth = mine.filter((m) => m.chain === 'eth'); }
let bitcoin = null, T = null, laneP = null, quoteKey = '', quoteTimer = 0, warmed = false;
const ui = { reg: $('#reg'), tk: $('#tk'), sup: $('#sup'), dec: $('#dec'), nm: $('#nm'), ds: $('#ds'), ln: $('#ln'), pub: $('#pub'), mint: $('#mint'), lg: $('#lg'), find: $('#find'), list: $('#list') };

const live = (t) => { $('#live').textContent = t; };
// A line the visitor must read stays (a progress step, an error) until the next thing they do; the one about sats follows the balance and goes when it is met.
const put = (h, cls = '') => { const q = $('#q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };
const say = (h, cls = '') => { S.soft = ''; put(h, cls); };
const notify = (m, kind) => { live(m); say(esc(m), kind === 'error' ? 'err' : ''); };

// ── marks: a logo where there is one, else the ticker's first letters on a colour taken from the id ──
const hue = (s) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const letters = (t) => String(t || '?').slice(0, 2).toUpperCase();
const colour = (s) => `hsl(${hue(s)} 38% 48%)`;
function paintMark(node, ticker, id, url) {
  node.hidden = !ticker && !url;
  node.textContent = url ? '' : letters(ticker);
  node.style.setProperty('--c', colour(id || ticker));
  node.style.backgroundImage = url ? `url("${url}")` : '';
  node.style.backgroundSize = 'cover'; node.style.backgroundPosition = 'center';
}
// the letters stay under a logo until it has loaded (some are megabytes), and are what is left when it does not load
const markHtml = (a) => `<span class="tk letter" style="--c:${colour(a.id)}">${esc(letters(a.ticker))}${a.logo ? `<img src="${esc(a.logo)}" alt="" loading="lazy" decoding="async">` : ''}</span>`;

// ── the key and tacit.js, loaded when the form is first touched ──
function lane() {
  return (laneP ||= (async () => {
    const m = await import(BTC_MODULE);
    bitcoin = m.makeBitcoin({ notify, purpose: 'etch an asset on Bitcoin', prefer: 'btc', onChange: () => { paint(); needQuote(); readSilent(); } });
    T = await bitcoin.session.load();
    return bitcoin;
  })().catch((e) => { laneP = null; throw e; }));
}
function warm() {
  if (warmed) return;
  warmed = true;
  readPrice();
  if (S.chain !== 'btc') return;                       // an Ethereum etch does not load the Bitcoin side's library
  const t = $('#warm');
  if (t) document.head.append(t.content.cloneNode(true));
  lane().then(() => { paint(); needQuote(); }, () => {});
}
// What sats are worth in dollars, for a visitor who thinks in them; nothing is said of it when the price cannot be read.
let px = 0;
function readPrice() {
  for (const [pair, set] of [['BTC', (v) => { px = v; }], ['ETH', (v) => { S.eth.px = v; }]]) {
    fetch(`https://api.coinbase.com/v2/prices/${pair}-USD/spot`, { signal: AbortSignal.timeout(8e3) }).then((r) => (r.ok ? r.json() : null))
      .then((j) => { const v = Number(j?.data?.amount); if (v > 0) { set(v); paint(); } }).catch(() => {});
  }
}
const fiat = (n) => (px > 0 ? `≈ $${(n / 1e8 * px).toFixed(2)}` : '');
const withFiat = (n) => `${sats(n)} sats${px > 0 ? ` (${fiat(n)})` : ''}`;
// The sheet that gets sats to the wallet's address: what it is short of, and what the address must hold.
const addSats = () => {
  const need = S.quote?.need || 0, mine = bitcoin?.me?.sats || 0;
  bitcoin.fund({ sats: need ? Math.max(0, need - mine) : 0, need, fiat });
};

// ── Create ──
function read() {
  const ticker = ui.tk.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (ui.tk.value !== ticker) ui.tk.value = ticker;
  const raw = ui.sup.value.trim();
  let base = null, err = '';
  if (raw) {
    base = parseUnits(raw, S.dec);
    if (base == null) err = /^\d{1,3},\d{3}$/.test(raw) ? 'Write it without the comma' : parseUnits(raw, 18) != null ? (S.dec ? `Up to ${S.dec} decimals` : 'Whole numbers only') : 'Enter a number';
    else if (base <= 0n) { base = null; err = 'More than zero'; }
    else if (base > maxFor(S.dec)) { base = null; err = `At most ${fmtUnits(maxFor(S.dec), S.dec, S.dec)}`; }
  }
  const link = ui.ln.value.trim();
  return { ticker, tickerOk: /^[A-Z0-9]{1,8}$/.test(ticker), base, supplyOk: base != null, err, linkOk: !link || /^https:\/\//i.test(link) };
}
const wantsPin = () => !!(ui.nm.value.trim() || ui.ds.value.trim() || ui.ln.value.trim() || S.logo || (S.chain === 'btc' && ui.pub.checked));
// What is etched is what the form held when the button was pressed: its fields can change while the balance is read and the etch is built.
const snapshot = (r) => ({ ...r, dec: S.dec, name: ui.nm.value, description: ui.ds.value, link: ui.ln.value, logo: S.logo, mint: ui.mint.checked, pub: ui.pub.checked, pin: wantsPin() });

function needQuote() {
  const r = read();
  if (!T || !r.tickerOk) return;
  const pin = wantsPin(), key = `${r.ticker.length}|${pin ? 1 : 0}|${S.logo ? 1 : 0}`;
  if (key === quoteKey) return;
  quoteKey = key;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    try {
      const q = await T.etchQuote({ tickerLen: r.ticker.length, imageUri: S.logo?.uri || null, pin });
      if (quoteKey === key) { S.quote = q; paint(); }
    } catch { if (quoteKey === key) quoteKey = ''; }
  }, 150);
}

// What the key can spend: the sats at its address, and silent payments sent to it, which are moved to the address first when the address falls short.
// 'ok': the address holds what the etch needs. 'gather': it does not, and the silent payments cover it. 'short': neither. null: not read yet.
function funding() {
  const mine = bitcoin?.session.unlocked ? bitcoin.me?.sats : null, need = S.quote?.need;
  if (mine == null || need == null || S.silentKey !== bitcoin.session.key?.pubHex) return null;
  return mine >= need ? 'ok' : mine + S.silent >= need + 1000 ? 'gather' : 'short';
}
function readSilent() {
  const key = bitcoin?.session.key?.pubHex;
  if (!key || !bitcoin.session.unlocked) { S.silentKey = ''; if (S.silent) { S.silent = 0; paint(); } return Promise.resolve(); }
  if (typeof T?.silentSats !== 'function') { S.silentKey = key; return Promise.resolve(); }
  return T.silentSats().then((v) => { if (bitcoin.session.key?.pubHex === key) { S.silentKey = key; S.silent = v; paint(); } }, () => {});
}

function goState(r) {
  const unlocked = !!bitcoin?.session.unlocked;
  if (S.busy) return ['Etching…', true];
  if (S.working) return ['One moment…', true];
  if (S.uploading) return ['Uploading the logo…', true];
  if (!unlocked) return ['Open your Tacit wallet', false];
  if (!r.tickerOk) return ['Enter a ticker', true];
  if (!r.supplyOk) return ['Enter a supply', true];
  if (!r.linkOk) return ['The link starts with https://', true];
  if (funding() === 'short') return ['Add sats', false];
  return [`Etch ${r.ticker}`, false];
}

function paint() {
  const r = read(), unlocked = !!bitcoin?.session.unlocked, mine = bitcoin?.me?.sats;
  ui.tk.classList.toggle('long', ui.tk.value.length > 6);
  ui.sup.classList.toggle('long', ui.sup.value.length > 12); ui.sup.classList.toggle('longer', ui.sup.value.length > 17);
  paintMark($('#mark'), r.tickerOk ? r.ticker : '', r.ticker, S.logo?.url);
  $('#unit').textContent = r.tickerOk ? r.ticker : '';
  $('#sup-note').textContent = r.err;
  for (const b of ui.dec.querySelectorAll('[data-d]')) b.setAttribute('aria-pressed', String(Number(b.dataset.d) === S.dec));
  const used = r.tickerOk && S.assets && S.chain === 'btc' ? known().filter((a) => a.ticker.toLowerCase() === r.ticker.toLowerCase()).length : 0;
  $('#tk-note').innerHTML = used ? `<button class="link" type="button" data-find="${esc(r.ticker)}">${used === 1 ? '1 asset uses' : `${used} assets use`} ${esc(r.ticker)}</button>` : '';
  if (S.chain === 'eth') { ethFoot(r); return; }
  const rc = $('#rcpt');
  rc.hidden = !(r.tickerOk && r.supplyOk);
  if (!rc.hidden) {
    const rows = [['Supply', `${fmtUnits(r.base, S.dec, S.dec)} ${esc(r.ticker)}`], ['Network fee', S.quote ? `about ${esc(withFiat(S.quote.fee))}` : '…']];
    if (unlocked && mine != null) rows.push(['In your wallet', `${sats(mine)} sats${S.silent ? ` + ${sats(S.silent)} silent` : ''} <button class="link" type="button" data-fund>add</button>`, funding() === 'short' ? 'warn' : '']);
    rc.innerHTML = rows.map(([k, v, c]) => `<div><dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd></div>`).join('');
  }
  const [label, off] = goState(r), go = $('#go');
  go.textContent = label; go.disabled = off;
  $('#edit').inert = S.busy || S.working;
  const f = !S.busy && r.tickerOk && r.supplyOk ? funding() : null;
  const soft = f === 'short' ? `Needs about ${withFiat(S.quote.need)} at your wallet’s address. It holds ${sats(mine)}.`
    : f === 'gather' ? 'Your sats are silent payments: etching first moves them to your wallet’s address, in one more transaction.' : '';
  if (soft !== S.soft) { if (soft || S.soft) put(soft); S.soft = soft; }
}

async function act() {
  if (S.busy || S.working) return;
  if (S.chain === 'eth') return actEth();
  S.working = true; paint();
  try {
    const b = await lane();
    if (typeof T.etchAsset !== 'function') throw new Error('Your browser has an older wallet than this page needs. Reload in a minute.');
    if (!b.session.unlocked) { say(''); await b.signIn(); return; }
    const r = read();
    if (!r.tickerOk || !r.supplyOk || !r.linkOk) return;
    const job = snapshot(r);
    // The balance is read again at the press: an etch is not sent on one read minutes ago. A press on Add sats that finds the sats has arrived only
    // changes the button, and sends nothing.
    const wasShort = funding() === 'short';
    await Promise.all([b.refresh(), readSilent()]);
    S.quote = await T.etchQuote({ tickerLen: job.ticker.length, imageUri: job.logo?.uri || null, pin: job.pin });
    if (funding() === 'short') { paint(); addSats(); return; }
    if (wasShort) return;
    await etch(job);
  } catch (e) {
    if (e?.unlockCancelled) return;
    say(esc(e?.message || String(e)), 'err');
  } finally { S.working = false; paint(); }
}

async function etch(job) {
  let reached = '';
  S.busy = true; paint();
  try {
    if (funding() === 'gather') {
      say('Moving your silent-payment sats to your address…');
      await T.gatherSats(S.quote.need);
      await bitcoin.refresh();
    }
    say('Proving the supply…');
    const out = await T.etchAsset({
      ticker: job.ticker, supply: job.base, decimals: job.dec, name: job.name, description: job.description, externalUrl: job.link,
      imageUri: job.logo?.uri || null, mintable: job.mint, publishSupply: job.pub,
      onProgress: (st) => { reached = st; say(st === 'commit-start' ? 'Sending the first transaction…' : st === 'reveal-start' ? 'Sending the second…' : 'Proving the supply…'); },
    });
    S.done = { ...out, ticker: job.ticker, base: job.base, dec: job.dec, logo: job.logo?.url || null, details: !!(job.name.trim() || job.description.trim() || job.link.trim()) };
    rememberMine(out, job);
    bitcoin.refresh().catch(() => {});
    showDone();
  } catch (e) {
    const m = esc(e?.message || String(e));
    say(reached === 'reveal-start' ? `The first transaction went out and the second did not: ${m}` : m, 'err');
  } finally { S.busy = false; paint(); }
}

// The asset this visit etched, kept for Discover until the registry lists it.
function rememberMine(out, job) {
  const t = job.ticker.toLowerCase(), earlier = (S.assets || []).filter((a) => a.ticker.toLowerCase() === t).length, name = job.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  S.mine.unshift({
    id: out.assetIdHex, ticker: job.ticker, decimals: job.dec, etchTxid: out.revealTxid, at: Math.floor(Date.now() / 1000), height: Infinity, mintable: job.mint, verified: false,
    supply: out.supplyPublished ? job.base : null, holders: 1, cid: null, name: name.toLowerCase() === t ? '' : name, logo: job.logo ? ipfs(job.logo.uri.slice(7)) : null, later: earlier > 0, same: earlier, pending: true, mine: true, chain: 'btc',
  });
  saveMine();
}
function rememberEth(d, job) {
  const t = d.plan.token.toLowerCase(), same = (S.ethList || []).filter((a) => a.ticker.toLowerCase() === job.ticker.toLowerCase()).length, name = job.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64);
  S.mineEth.unshift({ id: t, chain: 'eth', ticker: job.ticker, decimals: job.dec, etchTxid: d.hashes[0], at: Math.floor(Date.now() / 1000), height: Infinity, mintable: false, verified: false, supply: job.base, holders: 0, cid: null,
    name: name.toLowerCase() === job.ticker.toLowerCase() ? '' : name, logo: job.logo ? ipfs(job.logo.uri.slice(7)) : null, later: same > 0, same, pending: true, mine: true });
  saveMine();
}
function showDone() {
  const d = S.done, done = $('#done');
  done.innerHTML = `<span class="tk letter" id="d-mark"></span>
    <h2>${esc(d.ticker)} <em>is etched</em></h2>
    <div class="kvs">
      <div class="kv"><span>Asset ID</span><b><code>${addrView(d.assetIdHex, 6)}</code> <button class="link" type="button" data-copy="${esc(d.assetIdHex)}">Copy</button></b></div>
      <div class="kv"><span>Link</span><b><button class="link" type="button" data-copy="${esc(`${location.origin}/etch/#discover=${d.assetIdHex}`)}">Copy link</button></b></div>
      <div class="kv"><span>Supply</span><b>${esc(fmtUnits(d.base, d.dec, d.dec))} ${esc(d.ticker)}${d.supplyPublished ? '' : ' · private'}</b></div>
      <div class="kv"><span>Transactions</span><b><a href="${MEMPOOL}/tx/${esc(d.commitTxid)}" target="_blank" rel="noopener noreferrer">commit</a> · <a href="${MEMPOOL}/tx/${esc(d.revealTxid)}" target="_blank" rel="noopener noreferrer">reveal</a></b></div>
    </div>
    <a class="btn" href="/#bitcoin/${esc(d.assetIdHex)}">Open it in your wallet</a>
    <div class="pair"><a class="btn ghost" href="${market(d.assetIdHex)}">Trade it</a><button class="btn ghost" type="button" id="again">Etch another</button></div>
    <p class="q${d.details && d.metadataPinned === false ? ' err' : ''}">${d.details && d.metadataPinned === false ? 'The name and details could not be saved with it. The asset itself is etched.' : 'It shows in Discover within a few minutes.'}</p>`;
  paintMark($('#d-mark'), d.ticker, d.assetIdHex, d.logo);
  $('#edit').hidden = true; $('.act').hidden = true; done.hidden = false;
  $('#again').onclick = reset;
  $('#again').focus();
}
function reset() {
  if (S.logo) URL.revokeObjectURL(S.logo.url);
  S.done = null; S.logo = null;
  for (const k of ['tk', 'sup', 'nm', 'ds', 'ln']) ui[k].value = '';
  ui.pub.checked = true; ui.mint.checked = false;
  lgSay(''); $('#lg-x').hidden = true; paintMark($('#lg-mark'), '', '', null);
  quoteKey = ''; say('');
  $('#done').hidden = true; $('#edit').hidden = false; $('.act').hidden = false;
  paint(); needQuote();
  ui.tk.focus();
}

// ── the logo: pinned to IPFS through the API, then named in the envelope by its CID ──
const lgSay = (t, err = false) => { const s = $('#lg-s'); s.textContent = t; s.style.color = err ? 'var(--err)' : ''; };
// The image chosen last is the logo: an upload still in flight when another is chosen, or the logo is removed, is dropped when it lands.
let lgSeq = 0;
ui.lg.addEventListener('change', async () => {
  const f = ui.lg.files && ui.lg.files[0];
  ui.lg.value = '';
  if (!f) return;
  if (!LOGO_TYPES.has(f.type)) return lgSay('PNG, JPEG or WebP', true);
  if (f.size > LOGO_MAX) return lgSay('2 MB at most', true);
  const my = ++lgSeq;
  lgSay('Uploading…');
  S.uploading = true; paint();
  const url = URL.createObjectURL(f);
  try {
    const fd = new FormData();
    fd.append('file', f);
    const r = await fetch(`${API}/pin`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30e3) });
    const j = await r.json().catch(() => ({}));
    if (my !== lgSeq) { URL.revokeObjectURL(url); return; }
    if (!r.ok || !j.cid) throw new Error(j.error || `the upload failed (${r.status})`);
    if (S.logo) URL.revokeObjectURL(S.logo.url);
    S.logo = { uri: `ipfs://${j.cid}`, url };
    lgSay(''); $('#lg-x').hidden = false; paintMark($('#lg-mark'), '', '', url);
    paint(); needQuote();
  } catch (e) { URL.revokeObjectURL(url); if (my === lgSeq) lgSay(e?.message || 'The upload failed', true); }
  finally { if (my === lgSeq) { S.uploading = false; paint(); } }
});
$('#lg-x').addEventListener('click', () => {
  lgSeq++; S.uploading = false;
  if (S.logo) URL.revokeObjectURL(S.logo.url);
  S.logo = null; $('#lg-x').hidden = true; paintMark($('#lg-mark'), '', '', null); lgSay('');
  paint(); needQuote();
});

// ── On Ethereum: the same form, an asset made through the canonical factory (etch/eth.js) from the visitor's own wallet ──
// Gas, as measured on a fork of mainnet (877,447 and 83,018 at the time of writing), with room: the token's creation and its supply, and the pool's registration.
const GAS_ETCH = 950_000n, GAS_REGISTER = 120_000n;
const ZERO32 = '0x' + '00'.repeat(32);
let ethP = null;
function ethLane() {
  return (ethP ||= (async () => {
    const [E, Wm, U] = await Promise.all([import(ETH_MODULE), import(WALLET_MODULE), import(UTIL_MODULE)]);
    const wallet = Wm.makeWallet({ rpc: U.rpc });
    wallet.onChange(() => { ethRead(); paint(); if (S.tab === 'find' && S.fchain === 'eth') ethHeld(); });
    wallet.restore().then(() => { ethRead(); paint(); }, () => {});
    return { E, wallet, rpc: U.rpc, RPCS: U.RPCS };
  })().catch((e) => { ethP = null; throw e; }));
}
// The balance and the price of gas, read for the account that is connected.
async function ethRead() {
  try {
    const lane = await ethLane(), a = lane.wallet.state.account;
    if (!a) { S.eth.bal = null; return; }
    const [bal, gp] = await Promise.all([lane.rpc('eth_getBalance', [a, 'latest']).catch(() => null), lane.rpc('eth_gasPrice', []).catch(() => null)]);
    if (lane.wallet.state.account !== a) return;
    S.eth.bal = bal == null ? null : BigInt(bal); S.eth.gasPrice = gp == null ? S.eth.gasPrice : BigInt(gp);
    paint();
  } catch { /* the balance is a convenience: the send reads the chain itself */ }
}
const ethFiat = (wei) => (S.eth.px > 0 ? ` (≈ $${(Number(wei) / 1e18 * S.eth.px).toFixed(2)})` : '');
const ethCost = (reg) => (S.eth.gasPrice > 0n ? (GAS_ETCH + (reg ? GAS_REGISTER : 0n)) * S.eth.gasPrice * 12n / 10n : 0n);
function ethFoot(r) {
  const W = ethP ? S.eth.wallet : null, on = !!W?.account, reg = ui.reg.checked, cost = ethCost(reg);
  const rc = $('#rcpt');
  rc.hidden = !(r.tickerOk && r.supplyOk);
  const short = on && S.eth.bal != null && cost > 0n && S.eth.bal < cost;
  if (!rc.hidden) {
    const rows = [['Supply', `${fmtUnits(r.base, S.dec, S.dec)} ${esc(r.ticker)}`], ['Network fee', cost > 0n ? `about ${fmtUnits(cost, 18, 5)} ETH${ethFiat(cost)}` : '…']];
    if (on && S.eth.bal != null) rows.push(['In your wallet', `${fmtUnits(S.eth.bal, 18, 5)} ETH`, short ? 'warn' : '']);
    rc.innerHTML = rows.map(([k, v, c]) => `<div><dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd></div>`).join('');
  }
  const go = $('#go');
  const [label, off] = S.busy ? ['Etching…', true] : S.working ? ['One moment…', true] : S.uploading ? ['Uploading the logo…', true] : !on ? ['Connect a wallet', false]
    : !r.tickerOk ? ['Enter a ticker', true] : !r.supplyOk ? ['Enter a supply', true] : !r.linkOk ? ['The link starts with https://', true] : [`Etch ${r.ticker} on Ethereum`, false];
  go.textContent = label; go.disabled = off;
  $('#edit').inert = S.busy || S.working;
  const soft = !S.busy && on && short && r.tickerOk && r.supplyOk ? `Needs about ${fmtUnits(cost, 18, 5)} ETH${ethFiat(cost)} for the network fee. Your wallet holds ${fmtUnits(S.eth.bal, 18, 5)}.` : '';
  if (soft !== S.soft) { if (soft || S.soft) put(soft); S.soft = soft; }
}
async function pickEth(list) {
  const { overlay } = await import(SHEET_MODULE);
  return new Promise((resolve) => {
    const o = overlay({ title: 'Choose a wallet', top: true, onClose: () => resolve(null) });
    o.body.innerHTML = `<div class="picker">${list.map((w, i) => `<button class="way" type="button" data-i="${i}"><span class="way-t">${esc(w.info?.name || 'Wallet')}</span></button>`).join('')}</div>`;
    o.body.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { resolve(Number(b.dataset.i)); o.close(); }; });
  });
}
async function connectEth(lane) {
  const list = lane.wallet.available();
  if (!list.length) throw new Error('No Ethereum wallet was found in this browser. Open this page in your wallet app’s browser, or on a computer with a wallet extension.');
  let w = list[0];
  if (list.length > 1) { const i = await pickEth(list); if (i == null) return false; w = list[i]; }
  await lane.wallet.connect(w);
  await ethRead();
  return true;
}
// The details of an Ethereum asset are pinned before anything is sent: their content hash is part of the token's address, so there is no making it without them.
async function pinDetails(job, E) {
  if (!(job.name.trim() || job.description.trim() || job.link.trim() || job.logo)) return ZERO32;
  const md = { name: job.name.trim() || job.ticker, decimals: job.dec };
  if (job.logo) md.image = job.logo.uri;
  if (job.description.trim()) md.description = job.description.trim();
  if (job.link.trim()) md.external_url = job.link.trim();
  const r = await fetch(`${API}/pin-json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(md), signal: AbortSignal.timeout(20e3) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.cid) throw new Error(`Could not save its details (${j.error || r.status}). Nothing was made. Try again in a moment.`);
  return E.cidDigest(j.cid);
}
const stopped = (e) => e?.userStopped || e?.code === 4001 || /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message)|cancell?ed in your wallet/i.test(e?.message || '');
async function actEth() {
  S.working = true; paint();
  try {
    const lane = await ethLane();
    S.eth.wallet = lane.wallet.state;
    if (!lane.wallet.state.account) { say(''); await connectEth(lane); return; }
    const r = read();
    if (!r.tickerOk || !r.supplyOk || !r.linkOk) return;
    const job = { ...snapshot(r), reg: ui.reg.checked };
    const need = ethCost(job.reg);
    if (S.eth.bal != null && need > 0n && S.eth.bal < need) { say(`Needs about ${esc(fmtUnits(need, 18, 5))} ETH for the network fee. Your wallet holds ${esc(fmtUnits(S.eth.bal, 18, 5))}.`, 'err'); return; }
    S.busy = true; paint();
    say('Saving its details…');
    const cid = await pinDetails(job, lane.E);
    say('Checking it…');
    const account = lane.wallet.state.account.toLowerCase();
    const plan = await lane.E.plan({ account, symbol: job.ticker, decimals: job.dec, supply: job.base, cid, register: job.reg }, lane.rpc);
    const cost = plan.gas * (S.eth.gasPrice || 0n) * 12n / 10n;
    if (S.eth.bal != null && cost > 0n && S.eth.bal < cost) { say(`Needs about ${esc(fmtUnits(cost, 18, 5))} ETH for the network fee. Your wallet holds ${esc(fmtUnits(S.eth.bal, 18, 5))}.`, 'err'); return; }
    let hashes, note = null;
    try { hashes = await lane.E.send(plan, lane.wallet, { read: lane.rpc, step: (i, n, label) => say(n > 1 ? `${esc(label)} (${i} of ${n})…` : `${esc(label)}…`) }); }
    catch (e) {
      if (!e?.partial?.length) throw e;
      // the token was made and a later call was not: what exists is said, and the page shows it
      hashes = e.partial;
      note = stopped(e) ? 'Registering it with the pool was not confirmed in your wallet. The token is made.' : `Could not register it with the pool: ${e.message}. The token is made.`;
    }
    // The token exists once its create call is mined, so it is kept before the chain is asked what was made: a read that fails leaves it shown, unchecked, not unrecorded.
    S.done = { eth: true, job, plan, hashes, verified: { ok: false, checks: {} }, ticker: job.ticker, base: job.base, dec: job.dec, logo: job.logo?.url || null, logoUri: job.logo?.uri || null, reg: job.reg, registered: job.reg && !note, note };
    rememberEth(S.done, job);
    say('Checking what was made…');
    S.done.verified = await lane.E.verify(plan, lane.rpc).catch(() => ({ ok: false, checks: {} }));
    showDoneEth();
  } catch (e) {
    say(stopped(e) ? 'Nothing was sent.' : esc(e?.message || String(e)), stopped(e) ? '' : 'err');
  } finally { S.busy = false; S.working = false; paint(); }
}
function showDoneEth() {
  const d = S.done, done = $('#done'), scan = 'https://etherscan.io', t = d.plan.token;
  const bad = d.verified.ok ? '' : `The chain does not show everything that was asked for (${Object.entries(d.verified.checks).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'it could not be read'}). Check the token on Etherscan before using it.`;
  done.innerHTML = `<span class="tk letter" id="d-mark"></span>
    <h2>${esc(d.ticker)} <em>is etched</em></h2>
    <div class="kvs">
      <div class="kv"><span>Token</span><b><code>${addrView(t, 6)}</code> <button class="link" type="button" data-copy="${esc(t)}">Copy</button></b></div>
      <div class="kv"><span>Link</span><b><button class="link" type="button" data-copy="${esc(`${location.origin}/etch/#discover=${t}`)}">Copy link</button></b></div>
      <div class="kv"><span>Supply</span><b>${esc(fmtUnits(d.base, d.dec, d.dec))} ${esc(d.ticker)}, all in your wallet</b></div>
      <div class="kv"><span>${d.hashes.length > 1 ? 'Transactions' : 'Transaction'}</span><b>${d.hashes.map((h, i) => `<a href="${scan}/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${d.hashes.length > 1 ? (i ? 'register' : 'create') : 'view'}</a>`).join(' · ')}</b></div>
      ${d.registered ? '<div class="kv"><span>Tacit pool</span><b>registered</b></div>' : ''}
    </div>
    <button class="btn" type="button" id="watch">Add it to your wallet</button>
    <div class="pair"><a class="btn ghost" href="${scan}/token/${esc(t)}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a><button class="btn ghost" type="button" id="again">Etch another</button></div>
    <p class="q${bad || d.note ? ' err' : ''}">${esc(bad || d.note || 'It is yours: nothing can mint more of it.')}</p>`;
  paintMark($('#d-mark'), d.ticker, t, d.logo);
  $('#edit').hidden = true; $('.act').hidden = true; done.hidden = false;
  $('#again').onclick = reset;
  $('#watch').onclick = async () => {
    try { const lane = await ethLane(); const ok = await lane.E.addToWallet(lane.wallet, { token: t, symbol: d.ticker, decimals: d.dec }, d.logoUri ? `${API}/ipfs/${d.logoUri.slice(7)}` : null); $('#watch').textContent = ok ? 'Added' : 'Add it to your wallet'; }
    catch { $('#watch').textContent = 'Add it in your wallet by its address'; }
  };
  $('#again').focus();
}
// The switch between the two sides: the form is the same, the decimals offered and what is chosen under "more" are not.
function setChain(c) {
  if (S.chain === c) return;
  // the quote is the Bitcoin side's: it is asked again on the way back
  S.chain = c; S.dec = c === 'eth' ? 18 : 8; S.quote = null; quoteKey = '';
  for (const b of document.querySelectorAll('#chain [data-chain]')) b.setAttribute('aria-checked', String(b.dataset.chain === c));
  $('#pub-row').hidden = $('#mint-row').hidden = c === 'eth'; $('#reg-row').hidden = c === 'btc';
  chips(); say('');
  if (c === 'eth') { S.eth.wallet = null; ethLane().then((l) => { S.eth.wallet = l.wallet.state; ethRead(); paint(); }, (e) => say(esc(e?.message || String(e)), 'err')); readPrice(); }
  else if (warmed) lane().then(() => { paint(); needQuote(); }, () => {});
  paint();
}

// ── Discover ──
const ageOf = (a) => (a.at ? day(a.at) : '');
// An asset's order book, in the classic app: the one place Bitcoin assets besides TAC are bought and sold.
const market = (id) => `/classic.html#tab=market&aid=${id}`;
function row(a) {
  const sup = a.supply != null ? `${fmtUnits(a.supply, a.decimals, Math.min(a.decimals, 4))}` : null;
  const own = a.mine ? (Date.now() / 1000 - a.at < 1800 ? 'Just etched' : 'Yours') : '';
  const note = (a.later ? [own, 'Ticker used by an earlier asset'] : [a.mintable ? 'Mintable' : '', own || ageOf(a)]).filter(Boolean).join(' · ');
  const held = a.chain === 'eth' && S.held[a.id] > 0n ? `You hold ${fmtUnits(S.held[a.id], a.decimals, Math.min(a.decimals, 4))}` : a.holders ? `${a.holders} holder${a.holders === 1 ? '' : 's'}` : '';
  return `<li class="as" data-id="${a.id}"><button class="as-b" type="button" aria-expanded="${S.open === a.id}">${markHtml(a)}
    <span class="as-t"><span class="as-n"><b>${esc(a.ticker)}</b>${a.verified ? '<i class="vf" title="On Tacit’s list of official assets">✓</i>' : ''}${a.name ? `<small>${esc(a.name)}</small>` : ''}</span><small>${esc(note)}</small></span>
    <span class="as-v num">${sup != null ? esc(sup) : a.chain === 'eth' ? '' : '<small>Supply private</small>'}<small>${esc(held)}</small></span></button>
    <div class="as-d"${S.open === a.id ? '' : ' hidden'}>${S.open === a.id ? details(a) : ''}</div></li>`;
}
function details(a) {
  if (a.chain === 'eth') return `<div class="kv"><span>Token</span><b><code>${a.id}</code> <button class="link" type="button" data-copy="${a.id}">Copy</button></b></div>
    ${a.at ? `<div class="kv"><span>Etched</span><b>${esc(day(a.at))}</b></div>` : ''}
    <div class="links"><a href="https://etherscan.io/token/${a.id}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a>${a.etchTxid ? `<a href="https://etherscan.io/tx/${a.etchTxid}" target="_blank" rel="noopener noreferrer">Etch transaction ↗</a>` : ''}</div>`;
  return `<div class="kv"><span>Asset ID</span><b><code>${a.id}</code> <button class="link" type="button" data-copy="${a.id}">Copy</button></b></div>
    ${a.at ? `<div class="kv"><span>Etched</span><b>${esc(day(a.at))}</b></div>` : ''}
    <div class="links"><a href="${market(a.id)}">Trade</a><a href="${SCAN}/assets/${a.id}" target="_blank" rel="noopener noreferrer">tacitscan ↗</a>${a.etchTxid ? `<a href="${MEMPOOL}/tx/${a.etchTxid}" target="_blank" rel="noopener noreferrer">Etch transaction ↗</a>` : ''}</div>`;
}
const skeleton = `<li class="sks" aria-hidden="true"><span class="sk" style="width:62%"></span><span class="sk" style="width:48%"></span><span class="sk" style="width:55%"></span><span class="sk" style="width:40%"></span></li>`;
function paintList() {
  const cnt = $('#cnt'), more = $('#more-r'), fq = $('#find-q'), eth = S.fchain === 'eth';
  fq.textContent = '';
  for (const b of document.querySelectorAll('#fchain [data-fchain]')) b.setAttribute('aria-checked', String(b.dataset.fchain === S.fchain));
  const failed = eth ? S.ethFailed : S.failed, ready = eth ? S.ethList || S.mineEth.length : S.assets;
  if (!ready) {
    more.hidden = true; cnt.textContent = '';
    if (failed) { ui.list.innerHTML = ''; fq.className = 'q err'; fq.innerHTML = `Could not load the ${eth ? 'Ethereum ' : ''}assets. <button class="link" type="button" id="retry">Try again</button>`; $('#retry').onclick = () => { if (eth) S.ethFailed = false; else S.failed = false; openFind(); }; }
    else ui.list.innerHTML = skeleton;
    return;
  }
  const term = ui.find.value.trim(), all = eth ? knownEth() || S.mineEth : known(), hits = search(all, term), shown = hits.slice(0, S.shown);
  cnt.textContent = term ? `${hits.length} found` : hits.length ? `${hits.length} asset${hits.length === 1 ? '' : 's'}` : '';
  ui.list.innerHTML = shown.length ? shown.map(row).join('') : `<li class="empty">${term ? `Nothing matches “${esc(term)}”.` : `Nothing etched on ${eth ? 'Ethereum' : 'Bitcoin'} yet. <button class="link" type="button" data-new>Etch the first</button>`}</li>`;
  more.hidden = hits.length <= shown.length;
}
let loading = null;
function ensureAssets() {
  if (S.assets) return Promise.resolve();
  return (loading ||= loadAssets().then((a) => { S.assets = a; S.failed = false; }, () => { S.failed = true; }).finally(() => { loading = null; }));
}
// The Ethereum side's list: the factory's record of what it has made, and what the connected wallet holds of it.
let ethLoading = null;
function ensureEthList() {
  if (S.ethList) return Promise.resolve();
  return (ethLoading ||= (async () => {
    try { const lane = await ethLane(); S.ethList = await lane.E.listEtches(lane.rpc, ETH_LOG_NODES); S.ethFailed = false; }
    catch { S.ethFailed = true; }
  })().finally(() => { ethLoading = null; }));
}
async function ethHeld() {
  try {
    const lane = await ethLane(), a = lane.wallet.state.account;
    if (!a) { if (Object.keys(S.held).length) { S.held = {}; paintList(); } return; }
    if (!S.ethList?.length) return;
    const held = await lane.E.balances(lane.rpc, a, knownEth().map((x) => x.id));
    if (lane.wallet.state.account !== a) return;
    S.held = held;
    paintList();
  } catch { /* what is held is a convenience */ }
}
async function openFind(term) {
  if (term != null) ui.find.value = term;
  S.shown = PAGE;
  paintList();
  if (S.fchain === 'eth') {
    await ensureEthList();
    paintList();
    if (S.ethList && !S.ethNamed) { S.ethNamed = true; readNames(S.ethList, paintList).catch(() => {}); }
    ethHeld();
    return;
  }
  await ensureAssets();
  paintList(); paint();
  if (S.assets && !S.named) { S.named = true; readNames(S.assets, paintList).catch(() => {}); }
}
ui.find.addEventListener('input', () => { S.shown = PAGE; S.open = null; paintList(); keepUrl(); });
$('#more-r').addEventListener('click', () => { S.shown += PAGE; paintList(); });
ui.list.addEventListener('click', (e) => {
  const b = e.target.closest('.as-b');
  if (!b) return;
  const id = b.closest('.as').dataset.id;
  S.open = S.open === id ? null : id;
  paintList();
});
// a logo shows once it has loaded; one that does not load leaves the letters
ui.list.addEventListener('load', (e) => { const i = e.target; if (i.tagName === 'IMG') (i.decode ? i.decode() : Promise.resolve()).then(() => i.classList.add('ok'), () => i.remove()); }, true);
ui.list.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.remove(); }, true);

// ── the two panels ──
function setTab(t, term = null, side = null) {
  S.tab = t;
  if (t === 'find') S.fchain = side || (/^0x[0-9a-f]{40}$/i.test(term || '') ? 'eth' : S.fchain);
  for (const [k, id] of [['create', 't-create'], ['find', 't-find']]) { const b = $(`#${id}`); b.setAttribute('aria-selected', String(k === t)); b.tabIndex = k === t ? 0 : -1; }
  $('.sw-h').style.setProperty('--i', t === 'find' ? 1 : 0);
  $('#p-create').hidden = t !== 'create'; $('#p-find').hidden = t !== 'find';
  if (t === 'find') openFind(term);
  keepUrl();
}
function keepUrl() {
  // an address names its own side; a word keeps the side it was searched on
  const q = ui.find.value.trim(), side = S.fchain === 'eth' && !/^0x[0-9a-f]{40}$/i.test(q) ? ':eth' : '';
  const h = S.tab === 'find' ? `#discover${side}${q ? `=${encodeURIComponent(q)}` : ''}` : '';
  try { history.replaceState(null, '', location.pathname + location.search + h); } catch { /* the address is a convenience */ }
}
function readUrl() {
  let h = '';
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { /* an unreadable address opens Create */ }
  const m = /^discover(:eth)?(?:=([\s\S]*))?$/.exec(h);
  return m ? { tab: 'find', term: m[2] ?? '', side: m[1] ? 'eth' : null } : { tab: 'create', term: null };
}
$('#t-create').addEventListener('click', () => setTab('create'));
$('#t-find').addEventListener('click', () => setTab('find'));
$('.sw-h').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const t = S.tab === 'create' ? 'find' : 'create';
  setTab(t); $(`#t-${t}`).focus();
});
addEventListener('hashchange', () => { const u = readUrl(); if (u.tab !== S.tab || u.term != null) setTab(u.tab, u.term, u.side); });
$('#fchain').addEventListener('click', (e) => { const b = e.target.closest('[data-fchain]'); if (!b || b.dataset.fchain === S.fchain) return; S.fchain = b.dataset.fchain; S.open = null; openFind(); keepUrl(); });

// ── events ──
const chips = () => { ui.dec.innerHTML = `<span>Decimals</span>${DECIMALS_OF[S.chain].map((d) => `<button type="button" data-d="${d}" aria-pressed="false">${d}</button>`).join('')}`; };
chips();
$('#form').addEventListener('submit', (e) => { e.preventDefault(); act(); });
$('#form').addEventListener('input', () => { warm(); if (!S.busy && !S.soft) say(''); paint(); needQuote(); });
$('#more').addEventListener('toggle', warm);
ui.dec.addEventListener('click', (e) => {
  const b = e.target.closest('[data-d]');
  if (!b) return;
  S.dec = Number(b.dataset.d); paint();
});
$('#chain').addEventListener('click', (e) => { const b = e.target.closest('[data-chain]'); if (b) setChain(b.dataset.chain); });
ui.reg.addEventListener('change', paint);
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-fund]')) { if (bitcoin?.session.unlocked) addSats(); return; }
  if (e.target.closest('[data-new]')) { setTab('create'); setChain(S.fchain); ui.tk.focus(); return; }
  const f = e.target.closest('[data-find]');
  if (f) { setTab('find', f.dataset.find, 'btc'); return; }
  const c = e.target.closest('[data-copy]');
  if (c) { const was = c.textContent; navigator.clipboard?.writeText(c.dataset.copy).then(() => { c.textContent = 'Copied'; setTimeout(() => { c.textContent = was; }, 1500); }, () => { c.textContent = 'Could not copy'; }); }
});
addEventListener('beforeunload', (e) => { if (S.busy) { e.preventDefault(); e.returnValue = ''; } });
// a visitor short of sats goes to their wallet and comes back: the balance is read again, on return and every half minute while the page is in view
const recheck = () => { if (S.busy || funding() !== 'short') return; bitcoin.refresh().catch(() => {}); readSilent(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
addEventListener('focus', recheck);
setInterval(() => { if (!document.hidden) recheck(); }, 30e3);

// the registry is read at once so a ticker already in use is said while it is typed
ensureAssets().then(paint);
const u = readUrl();
paint();
if (u.tab === 'find') setTab('find', u.term, u.side);
