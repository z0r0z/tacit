// tacit.finance/farm: the farms that pay TAC now, a tile each, and the one picked opened in place with an amount of ETH and one press.
// The TAC/ETH farm is the Precision farm's own form (trade/farm.js, as /trade/tac/ and /rewards/ mount it): one transaction from the
// wallet. A private farm is this page's form over farm/zap.js: the share is proved, one transaction puts the ETH in and makes the share
// private, and the relay bonds it. What the key holds in the private farms is the rewards page's panel (rewards/farms.js), on one
// sign-in with the deposits. The borrow markets' pools are joined on the vault page: their tiles lead there.
// Figures are read as /assets/ and /rewards/ read them (trade/farm-read.js, trade/lp-campaign.js), so a farm's APR is the same on each.
import { makeConnect } from '/trade/connect.js?cb=b758e60b';
import { rpc, api, esc, usd, fmtUnits, parseUnits, plain, $ } from '/trade/util.js?cb=1d2cd8d3';
import { nodeHealth } from '/trade/rpc.js';
import { batchReads } from '/trade/batch.js';
import { day as dayFmt } from '/trade/fmt.js?cb=172824e5';
import { aprText, readPrecision, readSpot, readStake, privateFarms, poolWorthEth } from '/trade/farm-read.js?cb=efe1d81e';
import { readCampaign, bestApr, notTrading } from '/trade/lp-campaign.js?cb=8da1c942';
import { DEPLOYMENTS } from '/vault/deployments.js?cb=4af96594';
import { exitSaid } from '/farm-ops.js?cb=28af38e1';
import { relayWords } from '/relay-outcome.js?cb=17e48a9a';
import { readReserves, marketOf, otherOf, zapMath, zapQuote, zapRun, bondShare, readNotes, looseOf, declined, ZAP_GAS } from '/farm/zap.js?cb=bb5bff74';

const API = 'https://api.tacit.finance', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const E10 = 10n ** 10n, HINT = 10n ** 17n;                                      // a tenth of an ETH: the deposit a tile's entry cost is said for
const QUICK = ['0.05', '0.1', '0.5'];
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches, fine = matchMedia('(pointer: fine)').matches;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage is a convenience */ } } };
const health = nodeHealth({ store: { getItem: store.get, setItem: store.set } });
const call = batchReads(({ to, data, from }) => rpc('eth_call', [{ to: to.toLowerCase(), data, ...(from ? { from: from.toLowerCase() } : {}) }, 'latest'], undefined, { health })
  .catch((e) => { throw e?.revert ? Object.assign(e, { code: 3 }) : e; }));
const txLink = (h) => `<a href="https://etherscan.io/tx/${h}" target="_blank" rel="noopener noreferrer">${h.slice(0, 10)}…${h.slice(-6)} ↗</a>`;
const tk = (k) => `<svg class="tk" aria-hidden="true"><use href="#tk-${k}"/></svg>`;
const pairIcons = (icons) => `<span class="pairtk">${icons.map(tk).join('')}</span>`;
const pctTxt = (x) => `${x.toFixed(x < 10 ? 1 : 0)}%`;
const tacTxt = (n) => (n >= 99.5 ? Math.round(n).toLocaleString('en-US') : n >= 0.995 ? String(Number(n.toFixed(2))) : n > 0 ? String(Number(n.toPrecision(2))) : '0');
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const note = $('#note'), said = (t) => { note.textContent = ''; setTimeout(() => { note.textContent = t; }, 30); };

const connect = makeConnect({
  describe: 'Farm TAC with ETH, in public or in private.',
  name: 'tacit farm',
  busy: () => Z.busy || !!pubUi?.busy(),
  say: (html, bad) => { const el = $('#menu-note'); el.innerHTML = html; el.classList.toggle('err', !!bad); },
  onChange: () => onWallet(),
});
const { wallet, W } = connect;

// ── the chef ──
const chef = $('#chef'), emo = $('#emo');
let moodTimer = 0, winkTimer = 0;
function react(mood, ms = 3200) {
  clearTimeout(moodTimer); clearTimeout(winkTimer);
  chef.classList.remove('wink');
  chef.dataset.mood = mood;
  emo.classList.remove('pop');
  emo.textContent = mood === 'up' ? '🤌' : '';
  if (emo.textContent) { void emo.offsetWidth; emo.classList.add('pop'); }
  const wink = () => { chef.classList.add('wink'); winkTimer = setTimeout(() => chef.classList.remove('wink'), 650); };
  if (mood === 'wink') wink(); else if (mood === 'up') winkTimer = setTimeout(wink, 1100);
  if (mood === 'idle' || mood === 'cook') return;
  moodTimer = setTimeout(() => { chef.dataset.mood = Z.busy ? 'cook' : 'idle'; emo.textContent = ''; }, ms);
}
chef.addEventListener('click', () => react('wink', 1400));

// TAC coins falling over the page, for a deposit that is in (the rewards page's, for a claim)
const COIN = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0a0a0a"/><circle cx="16" cy="16" r="13" fill="none" stroke="#f4efe6" stroke-width="2.5"/><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="#f7931a" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="#f7931a" stroke-width="2.4" stroke-linecap="round"/></svg>')}`;
function confetti() {
  if (calm) return;
  $('#fx')?.remove();
  const cv = document.createElement('canvas'), w = innerWidth, h = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
  cv.id = 'fx'; cv.setAttribute('aria-hidden', 'true'); cv.width = w * dpr; cv.height = h * dpr;
  const n = Math.max(40, Math.min(150, Math.round(w / 9))), g = cv.getContext('2d'), img = new Image();
  g.scale(dpr, dpr);
  document.body.append(cv);
  const coins = Array.from({ length: n }, () => ({ x: Math.random() * w, y: -40 - Math.random() * h * 0.7, s: 18 + Math.random() * 18, vy: 190 + Math.random() * 230, sway: 16 + Math.random() * 38, ph: Math.random() * 6.28, spin: 3 + Math.random() * 5, a: Math.random() * 6.28 }));
  let last = performance.now();
  const t0 = last, frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    g.clearRect(0, 0, w, h);
    let live = 0;
    for (const c of coins) {
      c.y += c.vy * dt; c.vy += 90 * dt; c.a += c.spin * dt;
      if (c.y > h + 40) continue;
      live++;
      g.save();
      g.translate(c.x + Math.sin(c.ph + (now - t0) / 600) * c.sway, c.y); g.rotate(Math.sin(c.a) * 0.4); g.scale(Math.cos(c.a * 1.3), 1);
      g.drawImage(img, -c.s / 2, -c.s / 2, c.s, c.s);
      g.restore();
    }
    if (live && now - t0 < 9000 && cv.isConnected) requestAnimationFrame(frame); else cv.remove();
  };
  img.addEventListener('load', () => requestAnimationFrame(frame), { once: true });
  img.addEventListener('error', () => cv.remove(), { once: true });
  img.src = COIN;
}
const cheer = (words) => { react('up', 4200); confetti(); said(words); import('/reward-pop.js').then((m) => m.chime(), () => {}); };

// ── what is read: the Precision farm, the private farms' program, the prices, the borrow markets' campaign, the wallet's stake ──
const S = { pub: null, prog: null, priv: [], px: {}, camp: null, stake: null, mine: new Map(), read: false, failed: false };
// the farms a deposit of ETH goes into from here, in the menu's order: known before anything is read, filled in as it is
const BASE = [
  { id: 'tac-eth', kind: 'public', name: 'TAC / ETH', icons: ['tac', 'eth'] },
  { id: 'teth-tac', kind: 'private', name: 'tETH / TAC', icons: ['teth', 'tac'] },
  { id: 'teth-cusd', kind: 'private', name: 'tETH / cUSD', icons: ['teth', 'cusd'] },
  { id: 'teth-cbtc', kind: 'private', name: 'tETH / cBTC', icons: ['teth', 'cbtc'] },
];
const tacEth = () => S.pub?.tacEth || 0;
const marketFor = (pool) => marketOf(pool.pair, { tacEth: tacEth(), ethUsd: S.px.ethUsd || 0, btcUsd: S.px.btcUsd || 0 });
// What a tenth of an ETH gives up on its way into a farm, in percent: the swap of half of it, and for a pool priced away from the market, that.
function entryCost(f) {
  if (f.kind === 'public') { const r0 = Number(S.pub?.r0 || 0) / 1e18, half = Number(HINT) / 2e18; return r0 > 0 ? half / (r0 + half) * 100 : null; }
  const r = f.pool?.reserves;
  if (!r || !Number(r.lpTotalShares)) return null;
  try { return zapMath({ res: { reserveA: BigInt(r.reserveA), reserveB: BigInt(r.reserveB), totalShares: BigInt(r.lpTotalShares), feeBps: f.pool.feeBps ?? 30 }, wei: HINT, market: marketFor(f.pool) })?.cost ?? null; } catch { return null; }
}
function farms() {
  const list = BASE.map((b) => ({ ...b, live: false, apr: null, perDay: 0, pool: null, finish: 0 }));
  const pub = list[0];
  if (S.pub) Object.assign(pub, { read: true, live: S.pub.live, apr: S.pub.live ? S.pub.apr : null, perDay: Number(S.pub.perDay) / 1e18, finish: S.pub.finish });
  const pools = S.prog?.pools || [];
  for (const x of S.priv) {
    const id = slug(x.name), pool = pools.find((p) => Number(p.pid) === x.pid);
    let f = list.find((y) => y.id === id);
    if (!f) list.push(f = { id, kind: 'private', name: x.name, icons: x.icons });
    Object.assign(f, { read: true, live: true, apr: x.apr, perDay: x.perDay, pid: x.pid, pool, finish: Number(S.prog.epoch?.periodFinish) || 0 });
  }
  if (S.prog) for (const f of list) if (f.kind === 'private' && !f.read) {
    // a farm the program does not pay now: its pool still takes liquidity, with nothing streaming to it
    const pool = pools.find((p) => slug(pairName(p.pair)) === f.id);
    Object.assign(f, { read: true, pool: pool || null, pid: pool ? Number(pool.pid) : null, gone: !pool });
  }
  for (const f of list) { f.cost = entryCost(f); f.yours = f.kind === 'public' ? stakeHeld() : S.mine.has(f.pid); }
  return list.filter((f) => !f.gone);
}
const pairName = (pair) => { const k = String(pair).split('/').map((x) => (x === 'cETH' ? 'tETH' : x)); if (k[1] === 'tETH') k.reverse(); return k.join(' / '); };
const stakeHeld = () => !!S.stake && (S.stake.staked > 0n || S.stake.earned > 0n || S.stake.loose > 0n);
// The farm the chef would pick: the most TAC over a week for a tenth of an ETH once the way in is paid, among those that stream now.
function chefsPick(list) {
  let best = null;
  for (const f of list) {
    if (!f.live || f.apr == null || f.cost == null) continue;
    const net = f.apr * 7 / 365 - f.cost;
    if (net > 0 && (!best || net > best.net)) best = { id: f.id, net };
  }
  return best?.id || null;
}

let FARMS = farms(), readTimer = 0;
async function readAll() {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => { if (!document.hidden && !Z.busy) readAll(); else readTimer = setTimeout(readAll, 30e3); }, 120e3);
  const facts = readPrecision(call).catch(() => null);
  const spot = readSpot((calls) => Promise.all(calls.map((c) => call(c).catch(() => null))));
  const prog = api('/farm/program?network=mainnet');
  const synths = Object.fromEntries(DEPLOYMENTS.vaults.map((v) => [v.key, v.hint?.synth]).filter(([, a]) => a));
  facts.then((f) => { if (f) { S.pub = f; paint(); readStakeNow(); } });
  Promise.all([facts, prog, spot]).then(([f, p, px]) => {
    S.px = px || {};
    if (p?.pools) { S.prog = p; S.priv = privateFarms(p, f?.tacEth || 0, S.px); }
    S.read = true; S.failed = !f && !p;
    paint();
    if (keyPub && looseFor !== keyPub) readLoose();                              // a key opened before the program was read
    if (!VIEW && location.hash.length > 1) route();                             // a link to a farm only the program names
  });
  Promise.all([readCampaign({ ethCall: (to, data) => call({ to, data }), synths }).catch(() => null), spot, facts]).then(([c, px, f]) => { S.camp = { c, tacUsd: (px?.ethUsd || 0) * (f?.tacEth || 0) }; paintMarkets(); });
}
async function readStakeNow() {
  const who = W.account;
  if (!who || !S.pub) { if (S.stake) { S.stake = null; paint(); } return; }
  const s = await readStake(call, who, S.pub).catch(() => null);
  if (W.account !== who) return;
  S.stake = s ? { ...s, who } : null;
  paint();
}

// ── the menu ──
function tileFor(f) {
  let a = $(`#d-${f.id}`);
  if (a) return a;
  const li = document.createElement('li');
  li.innerHTML = `<a class="dish" id="d-${esc(f.id)}" href="#${esc(f.id)}" data-farm="${esc(f.id)}"><span class="plate">${f.icons.map(tk).join('')}</span><b class="nm"></b><span class="kind">Private pool</span><span class="how">Deposit <b>ETH</b><br>Earn <b>TAC</b></span><span class="sel">Select</span><span class="apy"><span>APR</span><b class="num apr"></b></span><span class="sub"><span class="day"></span></span></a>`;
  li.querySelector('.nm').textContent = f.name;
  const at = $$('#dishes a[data-farm]').pop()?.closest('li');
  if (at) at.after(li); else $('#dishes').prepend(li);
  return li.firstChild;
}
function paintTiles() {
  const pick = chefsPick(FARMS), ids = new Set(FARMS.map((f) => f.id));
  if (S.prog) for (const a of $$('#dishes a[data-farm]')) if (!ids.has(a.dataset.farm)) a.closest('li').remove();
  for (const f of FARMS) {
    const a = tileFor(f), dry = f.read && !f.live;
    a.classList.toggle('off', dry); a.classList.toggle('pick', f.id === pick); a.classList.toggle('mine', !!f.yours);
    $('.apr', a).textContent = f.apr == null ? '' : aprText(f.apr);
    $('.kind', a).textContent = dry ? 'Between reward periods' : f.kind === 'public' ? 'Public pool' : 'Private pool';
    $('.sel', a).textContent = f.yours ? 'Manage' : 'Select';
    $('.day', a).textContent = f.live && f.perDay ? `${tacTxt(f.perDay)} TAC a day` : '';
    flag(a, 'tag', f.id === pick ? 'Chef’s pick' : '', 'The most TAC over a week for 0.1 ETH, once the way in is paid');
    flag(a, 'yours', f.yours ? 'Yours' : '');
    const dear = f.cost != null && f.cost >= 5;
    flag($('.sub', a), 'cost', dear ? `0.1 ETH entry −${pctTxt(f.cost)}` : '', dear ? costWhy(f) : '');
  }
}
// a line a tile has only when there is something to say
function flag(a, cls, text, title = '') {
  let el = $(`.${cls}`, a);
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('span'); el.className = cls; a.append(el); }
  if (el.textContent !== text) el.textContent = text;
  el.title = title;
}
function costWhy(f) {
  if (f.kind !== 'private' || !f.pool) return 'A small pool: half of a deposit of ETH is swapped inside it, which moves its price.';
  const r = f.pool.reserves, m = marketFor(f.pool), ratio = m ? Number(r.reserveA) / Number(r.reserveB) / m : 1, other = otherOf(f.pool.pair);
  return Math.abs(ratio - 1) >= 0.05 ? `This pool’s price for ${other} is ${pctTxt(Math.abs(ratio - 1) * 100)} ${ratio > 1 ? 'above' : 'below'} the market’s, and half of a deposit of ETH is swapped at it.`
    : 'A small pool: half of a deposit of ETH is swapped inside it, which moves its price.';
}
function paintMarkets() {
  const { c, tacUsd } = S.camp || {};
  for (const a of $$('#dishes a[data-market]')) {
    const key = a.dataset.market, idle = !!c && notTrading(c, key), apr = c && !idle ? bestApr(c, key, tacUsd) : null;
    a.closest('li').hidden = !!S.camp && (!c || idle);                           // the campaign is over or not answering, or these pools trade outside their range: nothing to join now
    a.classList.toggle('off', !!S.camp && apr == null);
    $('.apr', a).textContent = apr == null ? '' : aprText(apr);
    $('.kind', a).textContent = idle ? 'Not trading now' : 'Borrow market';
  }
}
function paint() {
  FARMS = farms();
  paintTiles();
  $('#menu-note').textContent = S.failed ? 'The farms could not be read. Trying again shortly.' : $('#menu-note').classList.contains('err') ? $('#menu-note').textContent : '';
  if (VIEW) paintStation();
}

// ── one farm, open ──
let VIEW = null, menuY = 0, shown = false;
const farmOf = (id) => FARMS.find((f) => f.id === id) || null;
function route({ first = false } = {}) {
  const id = decodeURIComponent(location.hash.slice(1)), f = id ? farmOf(id) : null;
  if (id && !f && !S.read && /^teth-[a-z0-9]+$/.test(id)) return;                // a farm the page does not know yet: decided once the program is read
  if (id && !f) { history.replaceState(null, '', location.pathname + location.search); }
  show(f, { first });
}
function show(f, { first = false } = {}) {
  const was = VIEW;
  if (shown && (was?.id || null) === (f?.id || null) && !first) return;
  shown = true;
  if (Z.busy && was && was.id !== f?.id) { history.replaceState(null, '', `#${was.id}`); return; }      // a deposit under way keeps its farm on screen
  const swap = () => {
    if (!was) menuY = scrollY;
    VIEW = f;
    document.documentElement.dataset.view = f ? 'farm' : 'menu';
    $('#menu').hidden = !!f; $('#station').hidden = !f;
    document.title = f ? `tacit farm · ${f.name}` : 'tacit farm';
    if (f) { openStation(f); scrollTo(0, 0); } else scrollTo(0, menuY);
    if (f && was && !calm) { const k = $('.kitchen'); k.style.animation = 'none'; void k.offsetWidth; k.style.animation = ''; }      // another farm: its card rises in again
  };
  const tile = (x) => (x ? $(`#d-${x.id}`) : null), src = tile(f || was), morph = !first && !calm && !!document.startViewTransition && !!src && !(was && f);
  if (!morph) { swap(); if (f && !first) react('pick', 900); return; }
  // the plate and the name picked travel to the open farm's head, and back
  const name = (el, v) => { if (el) el.style.viewTransitionName = v; };
  const ends = [[$('.plate', src), $('#k-plate'), 'plate'], [$('.nm', src), $('#k-name'), 'dishname']];
  for (const [a, b, v] of ends) name(f ? a : b, v);
  const vt = document.startViewTransition(() => { for (const [a, b, v] of ends) { name(f ? a : b, ''); name(f ? b : a, v); } swap(); });
  vt.finished.finally(() => { for (const [a, b] of ends) { name(a, ''); name(b, ''); } });
  if (f) react('pick', 900);
}
addEventListener('hashchange', () => route());
$('#bk').addEventListener('click', (e) => { e.preventDefault(); if (Z.busy) return; history.pushState(null, '', location.pathname + location.search); route(); });
// Escape leaves a field being typed in, and from anywhere else closes the farm
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !VIEW || Z.busy || document.querySelector('.bsheet')) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) { document.activeElement.blur(); return; }
  $('#bk').click();
});

function openStation(f) {
  $('#k-pub').hidden = f.kind !== 'public'; $('#k-priv').hidden = f.kind !== 'private'; $('#k-mine').hidden = f.kind !== 'private';
  if (f.kind === 'public') mountPublic(); else openPrivate(f);
  paintStation();
  if (fine) setTimeout(() => (f.kind === 'public' ? $('#fm-amt') : $('#pz-amt'))?.focus({ preventScroll: true }), 60);
  said(`${f.name} farm`);
}
function paintStation() {
  const f = VIEW && farmOf(VIEW.id);
  if (!f) return;
  VIEW = f;
  const plate = f.icons.map(tk).join('');
  if ($('#k-plate').dataset.for !== f.id) { $('#k-plate').dataset.for = f.id; $('#k-plate').innerHTML = plate; }
  $('#k-name').textContent = f.name;
  $('#k-kind').textContent = f.read && !f.live ? 'Between reward periods' : f.kind === 'public' ? 'Public pool' : 'Private pool';
  $('#k-apr').textContent = f.apr == null ? (f.read ? '—' : '') : aprText(f.apr);
  const others = FARMS.filter((x) => x.id !== f.id), sw = others.map((x) => `<a href="#${esc(x.id)}" title="${esc(x.name)}">${pairIcons(x.icons)}<b class="num">${x.apr == null ? '' : aprText(x.apr)}</b></a>`).join('');
  if ($('#sw').__h !== sw) { $('#sw').__h = sw; $('#sw').innerHTML = sw; }
  $('#k-more').innerHTML = f.kind === 'private' && f.pid != null
    ? `With one private coin alone, or as liquidity with no farm: <a href="/#card=earn:ether:p${f.pid}">the front page’s Earn card</a>.`
    : 'The stake, what it earns and its exit are public, at your wallet’s address. <a href="#teth-tac">A private farm</a> keeps them to you.';
  if (f.kind === 'private') paintPrivate();
  pubUi?.paint();
}

// ── the TAC/ETH farm: the Precision farm's form, with amounts a press away under its ETH field ──
let pubP = null, pubUi = null;
function mountPublic() {
  return pubP ||= Promise.all([import('/trade/farm.js?cb=6f0b3ce6'), import('/evm-trade-venues.js?cb=196b14fb')]).then(([{ mountFarm }, E]) => {
    const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: `0x${BigInt(o.value).toString(16)}` } : {}) }, block]);
    const batch = async (calls) => E._internal.decAggregate3(await ethCall(E.MULTICALL3, E._internal.encAggregate3(calls)), calls.length);
    const host = $('#farm-host');
    const done = () => {
      // a deposit that went in is cheered; a claim or a withdrawal gets a nod
      if (/^Farming\./.test($('#fm-status .ok', host)?.textContent || '')) cheer('In the farm'); else { react('up', 2600); said('Farm updated'); }
      readPrecision(call).then((x) => { if (x) { S.pub = x; paint(); readStakeNow(); } }, () => {});
    };
    pubUi = mountFarm(host, { ethCall, batch, rpc, api, wallet, W, connect: () => connect.connect(), fmtUnits, parseUnits, esc, usd, ethUsd: () => S.px.ethUsd || 0, txLink, onDone: done, refarm: true });
    $('#fm-eth .amt', host)?.after(quickRow($('#fm-amt', host)));
    return pubUi;
  }).catch((e) => { pubP = null; $('#farm-host').innerHTML = '<p class="note err">The farm could not be loaded. <a href="/rewards/#farm">Open it on the rewards page</a>.</p>'; console.warn('farm:', e?.message || e); });
}
// a field's amounts a press away: each writes the field and lets the form hear it as typing
function quickRow(input) {
  const row = document.createElement('div');
  row.className = 'quick'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Amounts');
  row.innerHTML = QUICK.map((v) => `<button type="button" data-q="${v}">${v}<small>ETH</small></button>`).join('');
  row.addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b || input.disabled) return;
    input.value = b.dataset.q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (fine) input.focus({ preventScroll: true });
  });
  return row;
}

// ── a private farm: ETH in with one transaction, the position private after ──
const Z = { f: null, q: null, seq: 0, busy: false, ready: null, ack: null, timer: 0, share: null, mode: 'eth' };
const amtIn = $('#pz-amt'), goBtn = $('#pz-go'), rcpt = $('#pz-rcpt'), statusEl = $('#pz-status'), cook = $('#pz-cook'), sayEl = $('#pz-say'), bar = $('#pz-bar'), acts = $('#pz-acts');
$('#pz-quick').replaceWith(quickRow(amtIn));
function openPrivate(f) {
  if (Z.f?.id !== f.id) { dropReady(); Z.q = null; Z.ack = null; amtIn.value = ''; rcpt.hidden = true; rcpt.innerHTML = ''; statusEl.innerHTML = ''; if (!Z.busy) cookHide(); }
  Z.f = f;
  session().then(() => mountMine(), () => {});
}
// Deposit with ETH (half swapped in the pool, one transaction), or with both coins from the private balance at the pool's ratio (the
// positions panel's join, drawn in this card). Both sides needs the farm to be open to joins, which a farm between periods is not.
const bothOk = (f) => !!f?.live && f.pid != null;
function setMode(m) {
  if (Z.busy) return;
  Z.mode = m === 'both' && bothOk(Z.f) ? 'both' : 'eth';
  for (const b of $$('#pz-mode button')) b.setAttribute('aria-pressed', String(b.dataset.pm === Z.mode));
  $('#pz-eth').hidden = Z.mode !== 'eth'; $('#pz-join').hidden = Z.mode !== 'both';
  const other = Z.f?.name?.split(' / ')[1] || 'TAC';
  $('#pz-how').textContent = Z.mode === 'both' ? `From your private tETH and ${other}, at the pool’s ratio: nothing is swapped.` : 'Half is swapped inside the pool, then both go in privately: one transaction.';
  if (Z.mode === 'both' && Z.joinFor !== Z.f.pid) { Z.joinFor = Z.f.pid; session().then(() => mountMine()).then((ui) => ui?.choose(Z.f.pid), () => { Z.joinFor = null; }); }
}
$('#pz-mode').addEventListener('click', (e) => { const b = e.target.closest('[data-pm]'); if (b && !b.disabled) setMode(b.dataset.pm); });
// The join's way in and the positions' Show mine open the key as a deposit does: the wallet connected here signs, with no sheet on a first
// visit. Show mine works before the panel has mounted too (it mounts, then reads).
for (const host of ['#pz-join', '#pf-mine']) $(host).addEventListener('click', (e) => {
  const b = e.target.closest('[data-pf="open"]');
  if (!b) return;
  e.stopImmediatePropagation();
  if (b.getAttribute('aria-busy') === 'true') return;
  b.setAttribute('aria-busy', 'true');
  openKey().then(() => mountMine()).then((ui) => ui?.read(), () => {}).finally(() => b.removeAttribute('aria-busy'));
}, true);
function paintPrivate() {
  const f = VIEW;
  Z.f = f;
  const p = f.pool, eu = S.px.ethUsd || 0, worth = p ? poolWorthEth(p, tacEth(), S.px) : null;
  const cell = (k, v, s = '') => `<div><span class="k">${k}</span><b class="num">${v}</b>${s ? `<span class="s">${s}</span>` : ''}</div>`;
  const stats = !f.read ? '<p class="note">Reading the farm…</p>'
    : cell('Rewards', f.live ? `${tk('tac').replace('class="tk"', 'class="tk xs inl"')}${tacTxt(f.perDay)} TAC a day` : 'between periods', f.live && eu && tacEth() ? `about ${usd(f.perDay * tacEth() * eu)} a day` : '')
      + cell('In the pool', worth == null ? '—' : eu ? usd(worth * eu) : `${worth.toFixed(2)} ETH`, f.name.replace(' / ', ' and '))
      + cell('Stream ends', f.live && f.finish ? dayFmt(f.finish) : '—');
  if ($('#pz-stats').__h !== stats) { $('#pz-stats').__h = stats; $('#pz-stats').innerHTML = stats; }
  $('#pz-both').textContent = `tETH + ${f.name.split(' / ')[1] || 'TAC'}`;
  $('#pz-mode').hidden = !bothOk(f);
  setMode(Z.mode);
  maxLine();
  gate();
}
let bal = null;                                                                // the wallet's ETH, for Max and the fee check: { who, wei, gp }
async function readBal() {
  const who = W.account;
  if (!who) { bal = null; maxLine(); return; }
  const [wei, gp] = await Promise.all([rpc('eth_getBalance', [who, 'latest']).then(BigInt, () => null), rpc('eth_gasPrice', []).then(BigInt, () => null)]);
  if (W.account !== who) return;
  bal = wei == null ? null : { who, wei, gp: gp ?? 3n * 10n ** 9n };
  maxLine();
}
const spendable = () => { if (!bal) return 0n; const keep = 2n * ZAP_GAS * bal.gp, v = bal.wei > keep ? bal.wei - keep : 0n; return (v / 10n ** 12n) * 10n ** 12n; };
function maxLine() {
  const el = $('#pz-max'), on = !!bal && bal.who === W.account;
  el.hidden = !on;
  if (on) el.textContent = `Balance ${fmtUnits(bal.wei, 18, 4)} · Max`;
}
$('#pz-max').addEventListener('click', () => { if (Z.busy) return; const v = spendable(); amtIn.value = v > 0n ? plain(v) : ''; typed(); });

const acked = () => { const q = Z.q; if (!q?.plan || !(q.cost >= 15)) return true; const el = $('#pz-ack'); return !!el && (el.type === 'checkbox' ? el.checked : el.value.trim() === String(Math.round(q.cost))); };
function gate() {
  if (Z.busy) return;
  const f = Z.f, q = Z.q, wei = parseUnits(amtIn.value) || 0n;
  goBtn.disabled = false;
  if (!W.account) { goBtn.textContent = 'Connect wallet'; return; }
  if (!f?.pool) { goBtn.textContent = f?.read ? 'This farm is not open now' : 'Reading the farm…'; goBtn.disabled = true; return; }
  if (!wei) { goBtn.textContent = 'Enter an amount'; goBtn.disabled = true; return; }
  if (q && !q.plan) { goBtn.textContent = 'Enter a larger amount'; goBtn.disabled = true; return; }
  if (q?.over) { goBtn.textContent = 'Not enough ETH'; goBtn.disabled = true; return; }
  goBtn.textContent = 'Farm privately';
  goBtn.disabled = !q || !acked();
}
const quoteOf = (f, wei) => zapQuote({ pool: f.pool, wei, reserves: () => readReserves(call, POOL, f.pool.poolId), gasPrice: () => rpc('eth_gasPrice', []).then(BigInt),
  balance: async () => (W.account ? BigInt(await rpc('eth_getBalance', [W.account, 'latest'])) : null), market: marketFor(f.pool), tacEth: tacEth(), live: f.live });
async function requote() {
  const my = ++Z.seq, f = Z.f, text = amtIn.value.trim(), wei = parseUnits(text);
  Z.q = null; gate();
  const bad = (m) => { rcpt.hidden = false; rcpt.innerHTML = `<p class="note err">${m}</p>`; };
  amtIn.toggleAttribute('aria-invalid', !!text && wei == null);
  if (text && wei == null) return bad('Could not read that amount. Write 0.05 or 1.');
  if (!wei || !f?.pool) { rcpt.hidden = true; rcpt.innerHTML = ''; return; }
  if (wei % E10 !== 0n) return bad('Up to 8 decimals.');
  try {
    const q = await quoteOf(f, wei);
    if (my !== Z.seq) return;
    Z.q = q; paintQuote(); gate();
  } catch (e) { if (my === Z.seq) bad(esc(e?.said ? e.message : 'The pool could not be read. Try again in a moment.')); }
}
function paintQuote() {
  const f = Z.f, q = Z.q, eu = S.px.ethUsd || 0;
  rcpt.hidden = false;
  if (!q.plan) { rcpt.innerHTML = '<p class="note err">This is too small to make a share of the pool. Enter a larger amount.</p>'; return; }
  const row = (k, v, cls = '', title = '') => `<div class="kv"><span>${k}</span><b${cls ? ` class="${cls}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${v}</b></div>`;
  const dayUsd = eu && tacEth() ? usd(q.day * tacEth() * eu) : '', feeEth = Number(ZAP_GAS * q.gp) / 1e18, fee = eu ? (feeEth * eu < 0.01 ? 'under $0.01' : `≈ $${(feeEth * eu).toFixed(2)}`) : `≈ ${feeEth.toPrecision(2)} ETH`;
  const other = otherOf(f.pool.pair), m = marketFor(f.pool), ratio = m ? Number(q.res.reserveA) / Number(q.res.reserveB) / m : 1, n = Math.round(q.cost), key = `${f.id}|${q.wei}|${n}`;
  const line = q.over ? 'More ETH than this wallet holds, with the network fee.'
    : q.against >= 5 ? `This pool’s price for ${esc(other)} is ${pctTxt(Math.abs(ratio - 1) * 100)} ${ratio > 1 ? 'above' : 'below'} the market’s, and half of the deposit is swapped at it.`
    : q.impact >= 5 ? 'The swap inside the pool costs a lot at this size. A smaller deposit costs less.'
    : !f.live ? 'Between reward periods: nothing streams until the next one starts.' : '';
  const ack = q.cost >= 30 ? `<label class="ack"><span>Type <b>${n}</b> to accept losing about ${n}% of this deposit to the pool’s price.</span><input id="pz-ack" inputmode="numeric" autocomplete="off" aria-label="Type ${n} to accept" value="${Z.ack === key ? n : ''}"></label>`
    : q.cost >= 15 ? `<label class="ack"><input type="checkbox" id="pz-ack"${Z.ack === key ? ' checked' : ''}><span>I accept losing about ${n}% of this deposit to the pool’s price.</span></label>` : '';
  rcpt.innerHTML = (f.live ? row('Earns about', `${tacTxt(q.day)} TAC a day${dayUsd ? ` · ${dayUsd}` : ''}`) + row('APR', q.apr == null ? '—' : aprText(q.apr)) : '')
    + (q.impact >= 0.5 ? row('Price impact', pctTxt(q.impact), q.impact >= 5 ? 'err' : '') : '')
    + (q.against >= 1 ? row('Against the market', `${pctTxt(q.against)} of this deposit`, q.against >= 5 ? 'err' : '') : '')
    + row('You hold', `a private ${esc(f.name)} position`)
    + row('Exit', esc(exitSaid(f.pool.lockSeconds, f.name) || 'any time'))
    + row('Chain sees', 'ETH in, private after', '', 'The deposit is public: your wallet, the amount and the swap. The position it makes, what it earns and its exit are private.')
    + row('Network fee', fee, '', `About ${ZAP_GAS.toLocaleString('en-US')} gas at ${(Number(q.gp) / 1e9).toPrecision(2)} gwei, the gas price now`)
    + (line ? `<p class="note${q.over || q.cost >= 5 ? ' err' : ''}">${line}</p>` : '') + ack;
  for (const ev of ['input', 'change']) $('#pz-ack')?.addEventListener(ev, () => { Z.ack = acked() ? key : null; gate(); });
}
function typed() {
  clearTimeout(Z.timer);
  dropReady(); Z.q = null; gate();
  if (!Z.busy) { statusEl.innerHTML = ''; if (!Z.share) cookHide(); }
  Z.timer = setTimeout(requote, 260);
}
amtIn.addEventListener('input', typed);
amtIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !Z.busy && !goBtn.disabled) goBtn.click(); });
amtIn.addEventListener('focus', () => { if (Z.f?.kind === 'private') getUx().catch(() => {}); }, { once: true });

// the steps of a deposit, as the page says them
const STEP = ['prove', 'send', 'farm'];
function steps(now, bad = false) {
  const at = STEP.indexOf(now);
  for (const li of $$('#pz-steps li')) { const i = STEP.indexOf(li.dataset.s); li.dataset.at = now === 'all' || i < at ? 'done' : i === at ? (bad ? 'bad' : 'now') : ''; }
}
let barTimer = 0;
function barRun(secs) {
  clearInterval(barTimer);
  bar.hidden = !secs;
  if (!secs) return;
  const t0 = Date.now(), fill = bar.firstElementChild;
  fill.style.width = '2%';
  barTimer = setInterval(() => { fill.style.width = `${Math.min(94, 2 + (Date.now() - t0) / (secs * 10))}%`; }, 1000);
}
function cookSay(html, { secs = 0, live = true } = {}) { cook.hidden = false; cook.toggleAttribute('data-live', live); sayEl.innerHTML = html; barRun(secs); }
function cookHide() { cook.hidden = true; clearInterval(barTimer); acts.innerHTML = ''; Z.share = null; }
function onStep(step, d) {
  if (step === 'prepare') { steps('prove'); cookSay('Reading your private balance…'); }
  else if (step === 'proving') cookSay('Making your share’s proof, about a minute. Nothing has left your wallet.', { secs: 50 });
  else if (step === 'check') { steps('send'); cookSay('Checking the deposit against the pool…'); }
  else if (step === 'confirm') cookSay('Confirm in your wallet: one transaction adds your ETH and makes your share private.');
  else if (step === 'sent') cookSay(`Sent ${txLink(d)}. Waiting for it to land…`, { secs: 24 });
  else if (step === 'landed') { steps('farm'); cookSay('In the pool, as a private share. Reading it…'); }
  else if (step === 'bonding') cookSay('The relay is putting your share in the farm, about a minute…', { secs: 70 });
  else if (step === 'waiting') cookSay('Proved. The relay sends it in turn: waiting for it to land…', { secs: 90 });
}

// The Tacit key: the tab's own if it has one open, else opened at the press (the wallet connected here signs, with no sheet, on a first
// visit). The pool module and the key's notes are read as soon as it is open, so a press finds them ready.
let keyP = null, key = null, K = null, mineUi = null, mineP = null, uxP = null, ownP = null, runner = null;
const getUx = () => (uxP ||= import('/trade/poolux.js?cb=59d125e5').then((m) => m.getUx()).catch((e) => { uxP = null; throw e; }));
function session() {
  return keyP ||= import('/trade/key.js?cb=09f263cb').then((m) => {
    K = m;
    key = m.makeKeySession({ moved: (why) => { mineUi ? mineUi.forget(why) : key.lock(); statusEl.innerHTML = `<span class="err">${esc(why)}</span>`; } });
    key.onChange(onKey);
    // The key this tab already held is opened again in the background, once its wallet answers: a wallet that never does (locked, or
    // busy with another request) holds nothing up, and the panel and the presses are there at once.
    key.ready().then(onKey, () => {});
    onKey();
    return key;
  }).catch((e) => { keyP = null; throw e; });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const hereWallet = () => { const uuid = wallet.available().find((w) => w.provider === W.prov)?.info?.uuid; return uuid && W.account ? { uuid, address: W.account } : null; };
const pickProvider = (list) => { const here = hereWallet(); return here && list.some((x) => x.uuid === here.uuid) ? here.uuid : K.pickWalletSheet(list); };
async function openKey() {
  const k = await session();
  if (!k.unlocked) await Promise.race([k.ready(), pause(3000)]);                 // the tab's own key, if its wallet answers soon
  if (k.unlocked) return;
  const here = hereWallet();
  if (here && !k.known() && !k.other()) { cookSay('Sign in your wallet to open your Tacit wallet: free, and two signatures the first time.'); await k.open.eth({ address: here.address }, async () => here.uuid); return; }
  await K.signInSheet(k, { pick: pickProvider, here, why: 'Open your Tacit wallet to farm in private. It stays open in this tab only.' });
}
let keyPub = null;
function onKey() {
  const pub = key?.unlocked ? key.key.pubHex : null;
  if (pub === keyPub) return;
  keyPub = pub; ownP = null; dropReady(true); S.mine = new Map(); Z.share = null;
  if (pub) readLoose(); else { $('#pz-loose').innerHTML = ''; import('/trade/poolux.js?cb=59d125e5').then((m) => m.forgetUx(), () => {}); }
  paint();
}
// the key's notes, read once and kept for half a minute: what a new share's index is chosen against, and where a share in no farm shows
function scan(fresh = false) {
  const pub = keyPub;
  if (!fresh && ownP && ownP.pub === pub && Date.now() - ownP.at < 30e3) return ownP.p;
  const p = getUx().then((t) => readNotes(t, () => key.priv()));
  ownP = { pub, at: Date.now(), p };
  p.catch(() => { if (ownP?.p === p) ownP = null; });
  return p;
}
const owned = () => scan().then((s) => [...s.notes, ...s.spentNotes]);
const run = () => (runner ||= import('/activity.js').then(async (m) => {
  const base = (await import('/confidential-deployments.js')).getConfidentialDeployment('mainnet')?.relayBase || API;
  return m.makeRunner({ api: API, base: async () => base, pub: () => key?.key?.pubHex || null });
}));
// what a wait on the relay carries: the page's time limit, its place in Activity, and the line when it is in a queue
const waitFor = (r, f) => (kind) => {
  const w = r.wait(kind === 'prove' ? `Prove a private ${f.name} share` : `Farm your ${f.name} share`, kind === 'prove' ? 5 * 60e3 : 20 * 60e3);
  return { ...w, onUpdate: (st) => { if (kind === 'prove' && st?.status === 'pending' && st.ahead > 0) cookSay(`In line for Tacit’s prover: ${st.ahead} ahead of it. Nothing has left your wallet.`, { secs: 50 + 35 * st.ahead }); } };
};
// shares a zap left pending elsewhere hold their indexes (the front page keeps their records)
function usedIndexes(pool) {
  try { return (JSON.parse(store.get('tacit-zaps-v1') || '[]') || []).filter((z) => z?.pub === keyPub && String(z.poolId).toLowerCase() === String(pool.poolId).toLowerCase() && Number.isInteger(z.index)).map((z) => z.index); } catch { return []; }
}
// a proof made for a press that was not sent is for one amount in one pool: another amount lets its index go
function dropReady(quiet = false) {
  const r = Z.ready;
  Z.ready = null;
  if (!r || quiet || !key?.unlocked) return;
  getUx().then((t) => t.releaseShareIndex({ walletPriv: key.priv(), poolId: r.poolId, index: r.index })).catch(() => {});
}
const lock = (on) => { amtIn.disabled = on; for (const b of $$('#pz .quick button, #pz-max, #pz-mode button')) b.disabled = on; if (on) { goBtn.setAttribute('aria-busy', 'true'); goBtn.disabled = true; } else goBtn.removeAttribute('aria-busy'); };
const frontLink = (f, wei) => `<a href="/#card=earn:ether:p${f.pid}&amt=${plain(wei)}">The front page can prove it another way →</a>`;

goBtn.addEventListener('click', async () => {
  if (Z.busy) return;
  if (!W.account) { await connect.connect(); return; }
  const f = Z.f;
  let q = Z.q;
  if (!f?.pool || !q?.plan || q.over || !acked()) return;
  Z.busy = true; lock(true); goBtn.textContent = 'Working…'; statusEl.innerHTML = ''; acts.innerHTML = ''; Z.share = null;
  steps('prove'); cookSay('Reading the price again…'); react('cook');
  let hash = null, J = null;
  try {
    // the price at the press: one that has moved against the quote is shown, not sent into
    const fresh = await quoteOf(f, q.wei);
    if (!fresh.plan || fresh.over || fresh.plan.shares * 1000n < q.plan.shares * 995n || (fresh.cost >= 15 && Math.round(fresh.cost) !== Math.round(q.cost))) {
      Z.q = fresh; paintQuote();
      throw Object.assign(new Error('The price moved. Nothing was sent; the figures above are the new ones.'), { said: true, quiet: true });
    }
    Z.q = q = fresh;
    await openKey();
    const [t, r] = await Promise.all([getUx(), run()]), from = W.account, priv = () => key.priv();
    J = r.journal;
    const record = (h) => { hash = h; J.put(`tx:1:${String(h).toLowerCase()}`, { kind: 'tx', label: `Zap ${fmtUnits(q.plan.value, 18, 6)} ETH into ${f.name}`, chain: 1, hash: h, to: from, status: 'pending' }); };
    const out = await zapRun({ t, rpc, wallet, from, priv, pool: f.pool, q, ready: Z.ready, wait: waitFor(r, f), used: usedIndexes(f.pool), owned: () => owned(),
      say: (step, d) => { if (step === 'sent') record(d); if (step === 'landed') { J.put(`tx:1:${String(d).toLowerCase()}`, { status: 'confirmed' }); Z.ready = null; } onStep(step, d); } });
    if (out.bond?.jobId) J.put('job:' + out.bond.jobId, { status: 'settled', hash: out.bond.txHash || undefined });
    farmed(f, out.bond?.txHash || out.hash);
  } catch (e) {
    if (hash && e?.reverted) J?.put(`tx:1:${String(hash).toLowerCase()}`, { status: 'failed', err: 'The transaction reverted.' });
    failed(f, q, e, e?.reverted ? null : hash);
  }
  finally { Z.busy = false; lock(false); gate(); if (chef.dataset.mood === 'cook') react('idle'); ownP = null; readBal(); }
});
function farmed(f, hash) {
  steps('all');
  cookSay(`<span class="ok">${S.prog?.epoch?.active ? 'In the farm: TAC is streaming to your private position.' : 'In the farm. It earns once the next reward period starts.'}</span> ${hash ? txLink(hash) : ''}`, { live: false });
  clearForm();
  cheer('In the farm');
  mineUi?.read(); readLoose();
  api('/farm/program?network=mainnet').then((p) => { if (p?.pools) { S.prog = p; S.priv = privateFarms(p, tacEth(), S.px); paint(); } });
}
// a deposit that went in (or was sent) leaves the form empty: the next press is a new deposit, not that one again
const clearForm = () => { amtIn.value = ''; Z.q = null; Z.ready = null; Z.ack = null; rcpt.hidden = true; rcpt.innerHTML = ''; };
function failed(f, q, e, hash) {
  const w = relayWords(e), msg = esc(e?.said || e?.userStopped ? e.message : w ? w.text : String(e?.message || e).slice(0, 220));
  barRun(0);
  if (e?.ready) Z.ready = e.ready;
  if (e?.stale || e?.moved) { Z.ready = null; requote(); }
  if (e?.unlockCancelled || (declined(e) && !e?.ready && !hash && !e?.share)) { cookHide(); statusEl.textContent = 'Not signed in. Nothing was sent.'; return; }
  if (e?.quiet) { cookHide(); statusEl.innerHTML = `<span class="err">${msg}</span>`; return; }
  cook.removeAttribute('data-live');
  if (e?.share) {                                                               // the transaction landed: the ETH is in the pool as a private share
    steps('farm', true); clearForm(); Z.share = { f, note: e.note || null };
    sayEl.innerHTML = `<span class="ok">Your share is private and safe.</span> It is not in the farm yet: ${msg}`;
    acts.innerHTML = '<button class="btn sm" type="button" data-act="farmit">Farm it</button>';
    react('down', 1600); readLoose();
    return;
  }
  if (e?.sent || hash) {                                                        // sent, and not seen to land
    steps('send', true); clearForm();
    sayEl.innerHTML = `<span class="err">Sent, not confirmed yet.</span> ${txLink(e.sent || hash)} Check it there before sending anything again. Once it lands, your share shows under Your private farms.`;
    react('down', 1600);
    return;
  }
  const kept = !!Z.ready && declined(e);
  steps(kept ? 'send' : 'prove', !kept);
  sayEl.innerHTML = kept ? 'Not sent. Your share’s proof is kept: press again to send it.' : `<span class="err">${msg}</span>${/Nothing was sent|nothing was spent/i.test(msg) ? '' : ' Nothing was sent.'}`;
  acts.innerHTML = !kept && (w || e?.front || /prove/i.test(String(e?.message || ''))) && f.pid != null ? frontLink(f, q.wei) : '';
  if (!kept) react('down', 1600);
}

// A share note that is in no farm (a deposit whose last step did not finish): said over the positions, with the press that farms it.
async function readLoose() {
  const pub = keyPub, host = $('#pz-loose');
  if (!pub || !S.prog?.pools) { host.innerHTML = ''; return; }
  try {
    const list = looseOf((await scan(true)).notes, S.prog.pools);
    if (keyPub !== pub) return;
    LOOSE = list; looseFor = pub;
    host.innerHTML = list.map(({ pool }, i) => `<div class="loose"><p>A ${esc(pairName(pool.pair))} share of yours is private and not in the farm.</p><button class="act" type="button" data-loose="${i}">Farm it</button></div>`).join('');
  } catch { /* read again at the next change */ }
}
let LOOSE = [], looseFor = null;
async function farmIt(pool, note0, btn = null) {
  if (Z.busy) return;
  const f = FARMS.find((x) => x.pool && x.pool.poolId === pool.poolId) || { name: pairName(pool.pair), pid: Number(pool.pid) };
  Z.busy = true; lock(true); if (btn) btn.disabled = true;
  steps('farm'); acts.innerHTML = ''; react('cook');
  cookSay('Checking your share…');
  try {
    const [t, r] = await Promise.all([getUx(), run()]), priv = () => key.priv();
    // read afresh: a share the relay has put in the farm since is not held any more, and is not farmed twice
    const fresh = looseOf((await scan(true)).notes, [pool]), same = (n) => String(n.leaf).toLowerCase() === String(note0?.leaf).toLowerCase();
    if (note0 && !fresh.some((x) => same(x.note))) { farmed(f, null); return; }
    const note = note0 || fresh[0]?.note;
    if (!note) throw Object.assign(new Error('That share is not in your balance yet. Try again in a minute.'), { said: true });
    cookSay('The relay is putting your share in the farm, about a minute…', { secs: 70 });
    const out = await bondShare({ t, priv, note, wait: waitFor(r, f), say: onStep });
    if (out?.jobId) r.journal.put('job:' + out.jobId, { status: 'settled', hash: out.txHash || undefined });
    farmed(f, out?.txHash || null);
  } catch (e) {
    const w = relayWords(e);
    steps('farm', true); cook.removeAttribute('data-live'); barRun(0);
    sayEl.innerHTML = `<span class="ok">Your share is private and safe.</span> It is not in the farm yet: ${esc(e?.said ? e.message : w ? w.text : String(e?.message || e).slice(0, 220))}`;
    acts.innerHTML = '<button class="btn sm" type="button" data-act="farmit">Farm it</button>';
    Z.share = { f, note: note0 || null, pool };
    react('down', 1600);
  } finally { Z.busy = false; lock(false); gate(); if (chef.dataset.mood === 'cook') react('idle'); if (btn?.isConnected) btn.disabled = false; ownP = null; }
}
acts.addEventListener('click', (e) => { if (e.target.closest('[data-act="farmit"]') && Z.share) farmIt(Z.share.pool || Z.share.f.pool, Z.share.note); });
$('#pz-loose').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-loose]'), x = b && LOOSE[Number(b.dataset.loose)];
  if (!x) return;
  cook.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
  farmIt(x.pool, x.note, b);
});

// the key's positions in the private farms: the rewards page's panel, on this page's key
function mountMine() {
  return mineP ||= import('/rewards/farms.js?cb=86891f34').then((m) => {
    mineUi = m.mountFarms($('#pf-mine'), { pick: pickProvider, session: key, wallet, W, connect: () => connect.connect(), program: () => S.prog,
      names: () => new Map(S.priv.map((x) => [x.pid, x.name])), pair: (pid) => { const icons = S.priv.find((x) => String(x.pid) === String(pid))?.icons; return icons ? pairIcons(icons) : ''; },
      onRead: (list) => { S.mine = new Map(list.map((p) => [Number(p.pid), p])); paint(); },
      joinAt: $('#pz-join'), onAct: (name, ok) => { if (name !== 'join') return; if (ok) { cheer('In the farm'); readLoose(); } else react('down', 1600); } });
    if (Z.mode === 'both' && Z.f?.pid != null) { Z.joinFor = Z.f.pid; mineUi.choose(Z.f.pid); }
    return mineUi;
  }).catch((e) => { mineP = null; console.warn('your farms:', e?.message || e); });
}

function onWallet() {
  $('#menu-note').textContent = ''; $('#menu-note').classList.remove('err');
  S.stake = null;
  readStakeNow(); readBal();
  pubUi?.refresh();                                                              // the Precision farm's form reads the wallet it is told of
  gate();
  if (Z.q && !Z.busy) requote();
}

route({ first: true });
paintTiles();
readAll();
addEventListener('visibilitychange', () => { if (!document.hidden && !Z.busy && S.read) readAll(); });
