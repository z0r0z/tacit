// The test harness for the swap card (tests/swap-page.mjs, tests/swap-bitcoin-lane.mjs), made from the retired /swap/ page; the tests serve it at /swap/app.js.
// /swap/: the swap card (swap/card.js) with this page's wallet, its Earn tab, the prices under the title, and the address bar kept in step
// with the card (from, to, amt, private; #earn and #bitcoin).
import { makeConnect } from '/trade/connect.js?cb=b758e60b';
import { rpc, api, esc, fmtUnits, parseUnits, plain, usd, $ } from '/trade/util.js?cb=1d2cd8d3';
import { aprText } from '/trade/farm-read.js?cb=efe1d81e';
import { mountSwapCard, ethCall, batch } from '/swap/card.js?cb=5b4de3fa';

const txLink = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(h.slice(0, 10))}…↗</a>`;
const P = { tab: location.hash === '#earn' ? 'earn' : 'swap', farm: 'precision', farms: null, px: {} };

let card = null;
const connect = makeConnect({
  describe: 'Swap into Tacit’s tokens and farm them.',
  busy: () => !!card?.busy,
  say: (t, bad) => { const q = $('#q'); if (q) { q.className = `q${bad ? ' err' : ''}`; q.innerHTML = t; } },
  onChange: () => card?.walletChanged(),
});
const { wallet, W } = connect;

function paintPx(p) {
  P.px = p;
  const el = $('#pxs'), tac = p.perEth ? p.ethUsd / p.perEth : null;
  el.innerHTML = `${tac ? `<span><svg class="tk xs" aria-hidden="true"><use href="#tk-tac"/></svg>TAC <b class="num">${usd(tac)}</b></span>` : ''}<span><svg class="tk xs" aria-hidden="true"><use href="#tk-eth"/></svg>ETH <b class="num">${usd(p.ethUsd)}</b></span>${p.btcUsd ? `<span><svg class="tk xs" aria-hidden="true"><use href="#tk-btc"/></svg>BTC <b class="num">${usd(p.btcUsd)}</b></span>` : ''}`;
  el.classList.add('on');
}
// the address the page was opened at stands until something on it changes
let started = false;
function keepUrl() {
  if (!started) return;
  const qs = P.tab === 'swap' ? card.params().toString() : '';
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${P.tab === 'earn' ? '#earn' : card.lane ? '#bitcoin' : ''}`);
}

// ── Earn: the farms to choose between, then the chosen one ──
let farmUi = null;
function paintEarn() {
  const list = P.farms || [{ k: 'precision', name: 'Precision farm', note: 'public', icons: ['tac', 'eth'] }];
  $('#farms').innerHTML = list.map((f) => `<button type="button" role="radio" class="c" aria-checked="${f.k === P.farm}" data-farm="${esc(f.k)}"><span class="pairtk">${f.icons.map((i) => `<svg class="tk sm" aria-hidden="true"><use href="#tk-${esc(i)}"/></svg>`).join('')}</span><span class="rt"><b>${esc(f.name)}</b><small>${esc(f.note)}</small></span><span class="ra"><span>${f.apr != null ? esc(aprText(f.apr)) : P.farms ? '—' : '…'}</span><small>APR now</small></span><span class="rd" aria-hidden="true"></span></button>`).join('');
  const f = list.find((x) => x.k === P.farm) || list[0];
  $('#farm').hidden = f.k !== 'precision';
  $('#privfarm').hidden = f.k === 'precision';
  if (f.k === 'precision' && !farmUi) {
    farmUi = import('/trade/farm.js?cb=6f0b3ce6').then(({ mountFarm }) => mountFarm($('#farm'), { ethCall, batch, rpc, api, wallet, W, connect: () => connect.connect(), fmtUnits, parseUnits, esc, usd, ethUsd: () => P.px.ethUsd, txLink, onDone: () => card.readBalances() }));
  }
  if (f.k !== 'precision') $('#privfarm').innerHTML = `<a class="go priv" href="/#farm/private-${f.pid}">Farm ${esc(f.name)} privately →</a>`;
}
const readFarms = () => card.farms().then((l) => { P.farms = l; paintEarn(); }, paintEarn);
function setTab(t) {
  if (P.tab === t) return;
  P.tab = t; paintTabs(); keepUrl();
  if (t === 'earn') { paintEarn(); if (!P.farms) readFarms(); }
}
function paintTabs() {
  for (const [t, el] of [['swap', $('#tab-swap')], ['earn', $('#tab-earn')]]) el.setAttribute('aria-selected', String(P.tab === t));
  $('.sw-h').style.setProperty('--i', P.tab === 'swap' ? 0 : 1);
  $('#p-swap').hidden = P.tab !== 'swap'; $('#p-earn').hidden = P.tab !== 'earn';
}
// What was just bought is farmed: the Precision farm, opened on its TAC side with the amount in.
function farmIt(got) {
  P.farm = 'precision'; setTab('earn'); paintEarn();
  const host = $('#farm');
  Promise.resolve(farmUi).then(() => {
    host.querySelector('[data-fm="tac"]')?.click();
    const i = host.querySelector('#fm-tacamt');
    if (i && got) { i.value = plain(got); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); }
  });
}

card = mountSwapCard($('#p-swap'), {
  wallet, W, connect: () => connect.connect(),
  onChange: keepUrl, onPrices: paintPx, farmIt,
  warm: () => { const t = $('#warm'); if (t) { document.head.append(t.content); t.remove(); } },
});
card.load(new URLSearchParams(location.search));
if (location.hash === '#bitcoin') card.setLane(true);
started = true;
paintTabs();
if (P.tab === 'earn') { paintEarn(); readFarms(); }
else if (matchMedia('(pointer: fine)').matches && !location.hash) card.focus();

$('#tab-swap').addEventListener('click', () => setTab('swap'));
$('#tab-earn').addEventListener('click', () => setTab('earn'));
$('.sw-h').addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { setTab(P.tab === 'swap' ? 'earn' : 'swap'); $(`#tab-${P.tab}`).focus(); } });
$('#farms').addEventListener('click', (e) => { const b = e.target.closest('[data-farm]'); if (!b) return; P.farm = b.dataset.farm; paintEarn(); });
$('#farms').addEventListener('keydown', (e) => {
  const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key], rs = [...$('#farms').querySelectorAll('[role="radio"]')], i = rs.indexOf(document.activeElement);
  if (!d || i < 0) return;
  e.preventDefault();
  const k = rs[(i + d + rs.length) % rs.length].dataset.farm;
  P.farm = k; paintEarn(); $(`#farms [data-farm="${k}"]`)?.focus();
});
addEventListener('hashchange', () => { setTab(location.hash === '#earn' ? 'earn' : 'swap'); if (location.hash !== '#earn') card.setLane(location.hash === '#bitcoin'); });
