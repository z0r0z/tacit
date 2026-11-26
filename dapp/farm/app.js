// tacit.finance/farm: the farms that pay TAC now, a tile each, and the one picked opened in place with an amount of ETH and one press.
// The TAC/ETH farm is the Precision farm's own form (trade/farm.js, as /trade/tac/ and /rewards/ mount it): one transaction from the
// wallet. A private farm is this page's form over farm/zap.js: the share is proved, one transaction puts the ETH in and makes the share
// private, and the relay bonds it. What the key holds in the private farms is the rewards page's panel (rewards/farms.js), on one
// sign-in with the deposits. The borrow markets' pools are joined on the vault page: their tiles lead there.
// Figures are read as /assets/ and /rewards/ read them (trade/farm-read.js, trade/lp-campaign.js), so a farm's APR is the same on each.
import { makeConnect } from '/trade/connect.js?cb=514272b7';
import { rpc, api, esc, usd, fmtUnits, parseUnits, plain, $ } from '/trade/util.js?cb=9c8b4133';
import { nodeHealth } from '/trade/rpc.js';
import { batchReads } from '/trade/batch.js';
import { day as dayFmt } from '/trade/fmt.js?cb=172824e5';
import { aprText, readPrecision, readSpot, readStake, privateFarms, poolWorthEth } from '/trade/farm-read.js?cb=fb6ec72f';
import { readCampaign, bestApr, notTrading } from '/trade/lp-campaign.js?cb=8da1c942';
import { DEPLOYMENTS } from '/vault/deployments.js?cb=02c84743';
import { exitSaid, walletSettle, ownWhy } from '/farm-ops.js?cb=c5192cc4';
import { quoteEthToToken } from '/swap/route.js?cb=c4135f43';
import { zapPlanExt, offMarket, ackFor, pairCost, payback, streamDays } from '/lp-zap.js?cb=1cc6342a';
import { relayWords } from '/relay-outcome.js?cb=ad7c898d';
import { readReserves, marketOf, otherOf, zapMath, zapQuote, zapRun, bondShare, readNotes, looseOf, declined, assetRow, publicRate, ackKind, askedMore, poolRatio, CETH, ZAP_GAS } from '/farm/zap.js?cb=a9471e7a';

try { sessionStorage.removeItem('tacit-farm-back-v1'); } catch { /* the front page's way back to a farm: this page is where it goes, so it is spent */ }
const API = 'https://api.tacit.finance', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC', ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992';
const outsideFor = (token) => (x) => quoteEthToToken({ ethCall: (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: o.value } : {}) }, block]), to: ROUTER, tokenOut: token, amount: x, slippageBps: 50, deadline: BigInt(Math.floor(Date.now() / 1000) + 1800) });
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
const sharePct = (f) => `${(f * 100).toFixed(f >= 0.1 ? 0 : f >= 0.01 ? 1 : 2)}%`;
const tacTxt = (n) => (n >= 99.5 ? Math.round(n).toLocaleString('en-US') : n >= 0.995 ? String(Number(n.toFixed(2))) : n > 0 ? String(Number(n.toPrecision(2))) : '0');
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const joining = () => !!mineUi?.busy?.();                                         // the both-sides join in the card is under way (minutes, through the relay)
const busyNow = () => !!Z.busy || joining();
const note = $('#note'), said = (t) => { note.textContent = ''; setTimeout(() => { note.textContent = t; }, 30); };

const connect = makeConnect({
  describe: 'Farm TAC with ETH, in public or in private.',
  name: 'tacit farm',
  busy: () => busyNow() || !!pubUi?.busy(),
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
const S = { ext: new Map(), pub: null, prog: null, priv: [], px: {}, camp: null, stake: null, mine: new Map(), read: false, failed: false, mk: new Map() };
// the farms a deposit of ETH goes into from here, in the menu's order: known before anything is read, filled in as it is
const BASE = [
  { id: 'tac-eth', kind: 'public', name: 'TAC / ETH', icons: ['tac', 'eth'] },
  { id: 'teth-tac', kind: 'private', name: 'tETH / TAC', icons: ['teth', 'tac'] },
  { id: 'teth-cusd', kind: 'private', name: 'tETH / cUSD', icons: ['teth', 'cusd'] },
  { id: 'teth-cbtc', kind: 'private', name: 'tETH / cBTC', icons: ['teth', 'cbtc'] },
];
const tacEth = () => S.pub?.tacEth || 0;
// A coin the page has no price of its own for (SPX) is priced from the public pools (readMarket), with the pool's unit for it: kept in S.mk by the coin's id in the pool.
const lc = (s) => String(s || '').toLowerCase();
const otherId = (pool) => { const r = pool?.reserves; return !r ? null : lc(r.assetA) === CETH ? lc(r.assetB) : lc(r.assetB) === CETH ? lc(r.assetA) : null; };
const mkOf = (pool) => S.mk.get(otherId(pool)) || null;
const builtIn = (pool) => marketOf(pool.pair, { tacEth: 1, ethUsd: 1, btcUsd: 1 }) != null;           // TAC, cUSD and cBTC are priced here already
const marketFor = (pool) => marketOf(pool.pair, { tacEth: tacEth(), ethUsd: S.px.ethUsd || 0, btcUsd: S.px.btcUsd || 0 }) ?? mkOf(pool)?.rate ?? null;
const unitsFor = (pool) => { const m = mkOf(pool); return m ? { unitB: m.unitB, decimals: m.decimals } : {}; };
// ETH goes into a pool with tETH on one side, in one transaction. A pool without (SPX / TAC) takes its two coins from the private balance.
const hasEth = (f) => /\btETH\b/.test(String(f?.name || ''));
// Whether a pool's price for its other coin is 10% or more away from the market's: { gap, dear } or null (also null where the market is not known or the
// pool has not been read). Read from the program's reserves, so it is there before any amount is typed.
function offOf(f) {
  const r = f?.pool?.reserves;
  if (f?.kind !== 'private' || !r || !Number(r.reserveB) || !hasEth(f)) return null;
  const m = marketFor(f.pool);
  return offMarket(poolRatio({ res: { reserveA: r.reserveA, reserveB: r.reserveB }, market: m, ...unitsFor(f.pool) }));
}
// The sentence that says a pool is off the market, for the line under a tile and the form: what its price is against the market's and what that does to a deposit.
function offSaid(f, off) {
  const other = otherOf(f.pool.pair);
  return `This pool is off the market: its price for ${other} is ${pctTxt(off.gap * 100)} ${off.dear ? 'above' : 'below'} the market’s. Half of a deposit of ETH is swapped at that price, and what stays in the pool is what traders take when they bring the price back.`;
}
// The cheaper way into a pool that is off the market: both coins together at its own ratio, nothing swapped (what that gives up is lp-zap.js pairCost), and where the coin comes from.
const betterSaid = (f, off) => {
  const other = otherOf(f.pool.pair);
  return `A cheaper way in is to add ${other} together with ETH: nothing is swapped, and it gives up about ${pctTxt(pairCost(off.ratio))}.${GET[other] ? ` To get ${other}, use the links below.` : ''}`;
};
// What a tenth of an ETH gives up on its way into a farm, in percent: the swap of half of it, and for a pool priced away from the market, that.
function entryCost(f) {
  if (f.kind === 'public') { const r0 = Number(S.pub?.r0 || 0) / 1e18, half = Number(HINT) / 2e18; return r0 > 0 ? half / (r0 + half) * 50 : null; }          // the swap moves the price by half/(r0+half), on the half of the deposit that is swapped
  const r = f.pool?.reserves;
  if (!r || !Number(r.lpTotalShares) || !hasEth(f)) return null;
  try {
    const inPool = zapMath({ res: { reserveA: BigInt(r.reserveA), reserveB: BigInt(r.reserveB), totalShares: BigInt(r.lpTotalShares), feeBps: f.pool.feeBps ?? 30 }, wei: HINT, market: marketFor(f.pool), ...unitsFor(f.pool) })?.cost ?? null;
    const out = S.ext.get(otherId(f.pool))?.cost;                       // a coin that trades outside is also entered by buying part of the deposit's swap there, which leaves the pool's price alone (zap.js)
    return out != null && (inPool == null || out < inPool) ? out : inPool;
  } catch { return null; }
}
// The public price of a coin the page prices from the market: zQuoter's best route over the public pools for a hundredth of an ETH, kept a minute (a
// failed read too, so a typing hand does not ask again at every key). The deposit's quote waits for it, a few seconds at most.
const MK_TTL = 60e3, mkReads = new Map();
function readMarket(pool) {
  const id = otherId(pool);
  if (!id || builtIn(pool)) return Promise.resolve();
  const had = S.mk.get(id);
  if (had && Date.now() - had.at < MK_TTL) return Promise.resolve();
  if (mkReads.has(id)) return mkReads.get(id);
  const p = (async () => {
    const row = await assetRow(call, POOL, id).catch(() => null);
    if (!row || row.poolMinted) return;
    const rate = await publicRate({ rpc, token: row.underlying, decimals: row.decimals }).catch(() => null);
    S.mk.set(id, { rate: rate ?? had?.rate ?? null, unitB: row.unitScale, decimals: row.decimals, at: Date.now() });
    if (rate != null && !had) paint();                                                // the tiles' entry costs are said against the market now
  })().finally(() => mkReads.delete(id));
  mkReads.set(id, p);
  return p;
}
// The entry cost of a tenth of an ETH bought outside (the pool's ratio against the market), read a minute at a time like the market's price.
const extReads = new Map();
function readOutside(pool) {
  const id = otherId(pool), r = pool?.reserves;
  if (!id || builtIn(pool) || !r || !Number(r.lpTotalShares)) return Promise.resolve();
  const had = S.ext.get(id);
  if (had && Date.now() - had.at < MK_TTL) return Promise.resolve();
  if (extReads.has(id)) return extReads.get(id);
  const p = (async () => {
    const row = await assetRow(call, POOL, id).catch(() => null);
    if (!row || row.poolMinted || !row.underlying) return;
    const ext = await zapPlanExt({ eth: HINT, ra: BigInt(r.reserveA), rb: BigInt(r.reserveB), total: BigInt(r.lpTotalShares), unitB: row.unitScale, quote: outsideFor(row.underlying) }).catch(() => null);
    const m = marketFor(pool), dep = Number(HINT) / 1e18;
    const cost = ext ? (m ? Math.max(0, (Number(ext.ethLeg) / 1e18 - (Number(ext.bLeg) / 10 ** row.decimals) * m) / dep * 100) : null) : null;
    S.ext.set(id, { cost, at: Date.now() });
    if (cost != null) paint();
  })().finally(() => extReads.delete(id));
  extReads.set(id, p);
  return p;
}
const readMarkets = () => { for (const x of S.prog?.pools || []) if (x.reserves && !builtIn(x)) readMarket(x).then(() => readOutside(x)); };
function farms() {
  const list = BASE.map((b) => ({ ...b, live: false, apr: null, perDay: 0, pool: null, finish: 0 }));
  const pub = list[0];
  if (S.pub) Object.assign(pub, { read: true, live: S.pub.live, apr: S.pub.live ? S.pub.apr : null, perDay: Number(S.pub.perDay) / 1e18, finish: S.pub.finish });
  const pools = S.prog?.pools || [];
  for (const x of S.priv) {
    const id = slug(x.name), pool = pools.find((p) => Number(p.pid) === x.pid);
    let f = list.find((y) => y.id === id);
    if (!f) list.push(f = { id, kind: 'private', name: x.name, icons: x.icons });
    const epoch = pool?.epoch?.periodFinish ? pool.epoch : S.prog.epoch;                  // a standalone farm (SPX) runs its own reward period; the launch farms share the program's
    Object.assign(f, { read: true, live: true, apr: x.apr, perDay: x.perDay, pid: x.pid, pool, epoch, finish: Number(epoch?.periodFinish) || 0 });
  }
  if (S.prog) for (const f of list) if (f.kind === 'private' && !f.read) {
    // a farm the program does not pay now: its pool still takes liquidity, with nothing streaming to it
    const pool = pools.find((p) => slug(pairName(p.pair)) === f.id);
    Object.assign(f, { read: true, pool: pool || null, pid: pool ? Number(pool.pid) : null, gone: !pool });
  }
  for (const f of list) { f.cost = entryCost(f); f.off = offOf(f); f.yours = f.kind === 'public' ? stakeHeld() : S.mine.has(f.pid); }
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
    S.px = { ethUsd: px?.ethUsd ?? S.px.ethUsd ?? null, btcUsd: px?.btcUsd ?? S.px.btcUsd ?? null };            // a price that cannot be read now keeps the last good one: the market check is what a deposit's loss is held to
    if (p?.pools) { S.prog = p; S.priv = privateFarms(p, f?.tacEth || 0, S.px); }
    S.read = true; S.failed = !f && !p;
    paint();
    readMarkets();                                                              // the public price of a coin with no price of its own here (SPX)
    if (keyPub && looseFor !== keyPub) readLoose();                              // a key opened before the program was read
    if (!VIEW && location.hash.length > 1) route();                             // a link to a farm only the program names
  });
  Promise.all([readCampaign({ ethCall: (to, data) => call({ to, data }), synths }).catch(() => null), spot, facts]).then(([c, px, f]) => { S.camp = { c, tacUsd: (px?.ethUsd ?? S.px.ethUsd ?? 0) * (f?.tacEth || 0) }; paintMarkets(); });
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
    a.classList.toggle('off', dry); a.classList.toggle('pick', f.id === pick); a.classList.toggle('held', !!f.yours);
    $('.apr', a).textContent = f.apr == null ? '' : aprText(f.apr);
    const worth = f.kind === 'private' && f.pool ? poolWorthEth(f.pool, tacEth(), S.px) : null, size = worth > 0 && S.px.ethUsd > 0 ? usd(worth * S.px.ethUsd) : '';
    $('.kind', a).textContent = dry ? 'Between reward periods' : f.kind === 'public' ? 'Public pool' : `Private pool${size ? ` · ${size}` : ''}`;
    $('.kind', a).title = size && !dry ? 'What the pool holds, in dollars: its APR is shared by everyone in it, so a small pool pays a small deposit a lot and a large one little.' : '';
    $('.sel', a).textContent = f.yours ? 'Manage' : 'Select';
    $('.day', a).textContent = f.live && f.perDay ? `${tacTxt(f.perDay)} TAC a day` : '';
    flag(a, 'tag', f.id === pick ? 'Chef’s pick' : '', 'The most TAC over a week for 0.1 ETH, once the way in is paid');
    flag(a, 'yours', f.yours ? 'Yours' : '');
    const dear = f.cost != null && f.cost >= 5;
    flag($('.sub', a), 'cost', dear ? `0.1 ETH entry −${pctTxt(f.cost)}` : '', dear ? costWhy(f) : '');
    flag($('.sub', a), 'offm', f.off ? `Off the market · ${pctTxt(f.off.gap * 100)} ${f.off.dear ? 'above' : 'below'}` : '', f.off ? offSaid(f, f.off) : '');
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
  return f.off ? offSaid(f, f.off)
    : ratio - 1 >= 0.05 ? `This pool’s price for ${other} is ${pctTxt((ratio - 1) * 100)} above the market’s, and half of a deposit of ETH is swapped at it.`
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
  if (VIEW && S.read && !farmOf(VIEW.id)) route();                                // the farm opened from a link is not one the program names: back to the menu
  paintTiles();
  $('#menu-note').textContent = S.failed ? 'The farms could not be read. Trying again shortly.' : $('#menu-note').classList.contains('err') ? $('#menu-note').textContent : '';
  if (VIEW) paintStation();
}

// ── one farm, open ──
let VIEW = null, menuY = 0, shown = false;
const farmOf = (id) => FARMS.find((f) => f.id === id) || null;
function route({ first = false } = {}) {
  const id = decodeURIComponent(location.hash.slice(1)), f = id ? farmOf(id) : null;
  if (id && !f && !S.read && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return;         // a farm the page does not know yet (tETH / SPX, SPX / TAC): decided once the program is read
  if (id && !f) { history.replaceState(null, '', location.pathname + location.search); }
  show(f, { first });
}
function show(f, { first = false } = {}) {
  const was = VIEW;
  if (shown && (was?.id || null) === (f?.id || null) && !first) return;
  shown = true;
  if (busyNow() && was && was.id !== f?.id) { history.replaceState(null, '', `#${was.id}`); return; }      // a deposit under way keeps its farm on screen
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
  vt.ready.catch(() => {});                                                       // a transition another one skips (a quick Back or Escape) rejects it: nothing to report
  vt.finished.finally(() => { for (const [a, b] of ends) { name(a, ''); name(b, ''); } });
  if (f) react('pick', 900);
}
addEventListener('hashchange', () => route());
$('#bk').addEventListener('click', (e) => { e.preventDefault(); if (busyNow()) return; history.pushState(null, '', location.pathname + location.search); route(); });
// Escape leaves a field being typed in, and from anywhere else closes the farm
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !VIEW || busyNow() || document.querySelector('.bsheet')) return;
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
  return pubP ||= Promise.all([import('/trade/farm.js?cb=431619ca'), import('/evm-trade-venues.js?cb=9aac0fac')]).then(([{ mountFarm }, E]) => {
    const ethCall = (to, data, block = 'latest', o = {}) => rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: `0x${BigInt(o.value).toString(16)}` } : {}) }, block]);
    const batch = async (calls) => E._internal.decAggregate3(await ethCall(E.MULTICALL3, E._internal.encAggregate3(calls)), calls.length);
    const host = $('#farm-host');
    const done = () => {
      // a deposit that went in is cheered; a claim or a withdrawal gets a nod
      if (/^Farming\./.test($('#fm-status .ok', host)?.textContent || '')) cheer('In the farm'); else { react('up', 2600); said('Farm updated'); }
      readPrecision(call).then((x) => { if (x) { S.pub = x; paint(); readStakeNow(); } }, () => {});
    };
    pubUi = mountFarm(host, { ethCall, batch, rpc, api, wallet, W, connect: () => connect.connect(), fmtUnits, parseUnits, esc, usd, ethUsd: () => S.px.ethUsd || 0, txLink, onDone: done, refarm: true, buyTac: '/#card=swap:ether:tac&amp;back=tac-eth' });
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
const Z = { f: null, q: null, seq: 0, busy: false, ready: null, ack: null, timer: 0, share: null, mode: 'eth', pref: 'eth' };
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
// Where each coin of a private pool comes from, for a deposit that brings both and so swaps nothing here: links into the front page's cards.
// cBTC is minted one for one against bitcoin locked at the key's own address (or bridged in from Bitcoin), and cUSD is borrowed against it.
const GET = {
  tETH: [['Shield ETH', 'shield:ether:defi', 'ETH in your wallet, made private one for one']],
  TAC: [['Buy TAC', 'swap:ether:tac:private', 'ETH swapped for private TAC']],
  cBTC: [['Lock BTC for cBTC', 'borrow:cbtc', 'Bitcoin locked at an address only your key spends mints cBTC one for one. A refundable wstETH bond backs the lock, and Bitcoin’s proof takes a few hours.'],
    ['Bridge cBTC from Bitcoin', 'bridge:kb', 'cBTC you already hold on Bitcoin, brought here']],
  cUSD: [['Lock BTC and borrow cUSD', 'borrow:cusd', 'One press starts it: it locks your bitcoin, posts the bond (one wallet confirmation), then mints cBTC and borrows dollars against it by itself, over a few hours. Or borrow against cBTC you hold']],
};
// A private coin held on its own goes in as a single-sided farm on the front page's Earn card (half is swapped inside the pool).
const ALONE = { tETH: 'earn:eth', TAC: 'earn:tac' };
const getRow = (tk, { pid = null, alone = null } = {}) => {
  const links = [...(GET[tk] || []), ...(alone && ALONE[alone] && pid != null ? [[`Farm ${alone} alone`, `${ALONE[alone]}:p${Number(pid)}`, `Put your private ${alone} in on its own: half of it is swapped inside the pool`]] : [])];
  // a coin got on the front page leaves the way back here: its cards and sheets link to this farm (`back`, kept in that tab), but farming it alone is the farm itself
  const back = Z.f?.id ? `&amp;back=${esc(Z.f.id)}` : '';
  return links.length ? `<div class="getrow" role="group" aria-label="Get ${esc(tk)}">${links.map(([t, c, w]) => `<a href="/#card=${c}${/^earn:/.test(c) ? '' : back}" title="${esc(w)}">${esc(t)}</a>`).join('')}</div>` : '';
};
// `user` is a choice made on the card (kept for the next farm opened); the card itself offers what the farm can take: a pool with no ETH side
// (SPX / TAC) has only the two-coin deposit, so the ETH form is not shown for it, and the card says so instead of quoting an ETH deposit it cannot make.
function setMode(m, user = false) {
  if (Z.busy) return;
  const f = Z.f, eth = hasEth(f), both = bothOk(f);
  if (user) Z.pref = m;
  Z.mode = !eth ? 'both' : m === 'both' && both ? 'both' : 'eth';
  for (const b of $$('#pz-mode button')) b.setAttribute('aria-pressed', String(b.dataset.pm === Z.mode));
  const form = $('#pz-eth');
  form.classList.toggle('noeth', !eth);
  form.hidden = Z.mode !== 'eth' && (eth || $('#pz-cook').hidden);                 // without an ETH side the form stays hidden, but not the steps of a share being farmed: they are said in its card
  $('#pz-join').hidden = !(Z.mode === 'both' && both);
  const other = f?.name?.split(' / ')[1] || 'TAC', first = f?.name?.split(' / ')[0] || 'tETH';
  $('#pz-how').textContent = !eth ? (both ? `This pool has no ETH side: bring your private ${first} and ${other}, at the pool’s ratio. Nothing is swapped.` : 'This pool has no ETH side, and its farm is not taking joins until the next reward period.')
    : Z.mode === 'both' ? `From your private ${first} and ${other}, at the pool’s ratio: nothing is swapped. Holding only ETH? Use the ETH tab.` : 'Half is swapped inside the pool, then both go in privately: one transaction.';
  if (Z.mode === 'both' && both && Z.joinFor !== f.pid) { Z.joinFor = f.pid; session().then(() => mountMine()).then((ui) => ui?.choose(f.pid), () => { Z.joinFor = null; }); }
}
$('#pz-mode').addEventListener('click', (e) => { const b = e.target.closest('[data-pm]'); if (b && !b.disabled) setMode(b.dataset.pm, true); });
rcpt.addEventListener('click', (e) => { if (e.target.closest('[data-alt="both"]')) { setMode('both', true); $('#pz-mode').scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'nearest' }); } });
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
// Where the TAC that funds a stream runs out before its period does (the stream stops then, whatever the date says), as a line under the date.
function fundedNote(f) {
  const run = Number(f.epoch?.fundedRunwaySeconds), at = Math.floor(Date.now() / 1000);
  return run > 0 && at + run < f.finish - 3600 ? `funded until ${dayFmt(at + run)}` : '';
}
function paintPrivate() {
  const f = VIEW;
  Z.f = f;
  const p = f.pool, eu = S.px.ethUsd || 0, worth = p ? poolWorthEth(p, tacEth(), S.px) : null;
  const cell = (k, v, s = '') => `<div><span class="k">${k}</span><b class="num">${v}</b>${s ? `<span class="s">${s}</span>` : ''}</div>`;
  const stats = !f.read ? '<p class="note">Reading the farm…</p>'
    : cell('Rewards', f.live ? `${tk('tac').replace('class="tk"', 'class="tk xs inl"')}${tacTxt(f.perDay)} TAC a day` : 'between periods', f.live && eu && tacEth() ? `about ${usd(f.perDay * tacEth() * eu)} a day` : '')
      + cell('In the pool', worth == null ? '—' : eu ? usd(worth * eu) : `${worth.toFixed(2)} ETH`, f.name.replace(' / ', ' and '))
      + cell('Stream ends', f.live && f.finish ? dayFmt(f.finish) : '—', f.live && f.finish ? fundedNote(f) : '');
  if ($('#pz-stats').__h !== stats) { $('#pz-stats').__h = stats; $('#pz-stats').innerHTML = stats; }
  $('#pz-both').textContent = `${f.name.split(' / ')[0] || 'tETH'} + ${f.name.split(' / ')[1] || 'TAC'}`;
  const offNow = hasEth(f) && f.off ? `${offSaid(f, f.off)} ${betterSaid(f, f.off)}` : '', offEl = $('#pz-off');          // a pool off the market is said before any amount is typed
  offEl.hidden = !offNow;
  if (offEl.textContent !== offNow) offEl.textContent = offNow;
  const getEl = $('#pz-offget'), gets = offNow && GET[otherOf(f.pool.pair)] ? getRow(otherOf(f.pool.pair)) : '';        // and where to get the other coin, for a holder with none of it
  getEl.hidden = !gets;
  if (getEl.__h !== gets) { getEl.__h = gets; getEl.innerHTML = gets; }
  $('#pz-mode').hidden = !(hasEth(f) && bothOk(f));                              // two ways in only where there are two
  setMode(Z.pref);
  maxLine();
  gate();
  if (f.pool && !Z.busy && amtIn.value.trim() && Z.quotedPool !== f.pool.poolId) requote();     // an amount typed before this farm's pool was read
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

const acked = () => { const q = Z.q; if (!ackKind(q)) return true; const el = $('#pz-ack'); return !!el && (el.type === 'checkbox' ? el.checked : el.value.trim() === String(Math.round(q.cost))); };
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
// TAC, cUSD and cBTC are 18-decimal coins with a pool unit of 1e10, registered with the pool at its deployment: a read of their row that fails does not hold a quote up.
// Any other coin (SPX) is sized from its row, and a deposit into it waits for the row rather than guess its units.
const BUILTIN_ROW = { underlying: null, unitScale: 10n ** 10n, poolMinted: true, decimals: 18 };
const rowFor = (f, res) => assetRow(call, POOL, res.assetB).catch(() => null).then((row) => row || (builtIn(f.pool) ? BUILTIN_ROW : null));
const quoteOf = async (f, wei) => {
  await Promise.race([readMarket(f.pool), new Promise((r) => setTimeout(r, 7000))]).catch(() => {});        // the market check is part of the quote: a coin priced from the public pools is read first
  return zapQuote({ pool: f.pool, wei, reserves: () => readReserves(call, POOL, f.pool.poolId), gasPrice: () => rpc('eth_gasPrice', []).then(BigInt),
    balance: async () => (W.account ? BigInt(await rpc('eth_getBalance', [W.account, 'latest'])) : null), market: marketFor(f.pool), tacEth: tacEth(), live: f.live,
    asset: (res) => rowFor(f, res),
    outside: outsideFor });
};
async function requote() {
  const my = ++Z.seq, f = Z.f, text = amtIn.value.trim(), wei = parseUnits(text);
  Z.q = null; gate();
  const bad = (m) => { rcpt.hidden = false; rcpt.innerHTML = `<p class="note err">${m}</p>`; };
  amtIn.toggleAttribute('aria-invalid', !!text && wei == null);
  if (text && wei == null) return bad('Could not read that amount. Write 0.05 or 1.');
  if (!wei || !f?.pool || !hasEth(f)) { rcpt.hidden = true; rcpt.innerHTML = ''; return; }                // a pool with no ETH side has no ETH deposit to price
  Z.quotedPool = f.pool.poolId;
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
  // the pool's price for the coin, in ETH a coin, from the reserves in the coins' own units (tETH's unit is 1e-8 ETH; the other coin's is `unitB` of its smallest)
  const other = otherOf(f.pool.pair), ratio = q.ratio ?? 1, n = Math.round(q.cost), key = `${f.id}|${q.wei}|${n}`;
  // what the farm's TAC makes up of the way in, over the days the stream still pays (lp-zap.js payback)
  const pb = f.live ? payback({ cost: q.cost, eth: Number(q.plan.value) / 1e18, day: q.day, tacEth: tacEth(), off: q.off, left: streamDays({ end: f.finish, run: f.epoch?.fundedRunwaySeconds }) }) : null;
  const line = q.over ? 'More ETH than this wallet holds, with the network fee.'
    : q.against >= 5 && !q.off ? `This pool’s price for ${esc(other)} is ${pctTxt(Math.abs(ratio - 1) * 100)} ${ratio > 1 ? 'above' : 'below'} the market’s, and half of the deposit is swapped at it.`
    : q.impact >= 5 ? 'The swap inside the pool costs a lot at this size. A smaller deposit costs less.'
    : !f.live ? 'Between reward periods: nothing streams until the next one starts.' : '';
  // a pool this thin takes a real swap at this size: the other way in swaps nothing, and the links say where the other coin comes from
  const skip = (q.cost >= 5 || q.off) && bothOk(f) ? `<p class="note">${q.off ? `A cheaper way in: both coins together, nothing swapped, about ${pctTxt(pairCost(q.off.ratio))} instead of ${pctTxt(q.cost)}. ` : ''}Skip the swap: <button class="linkbtn" type="button" data-alt="both">add the ${esc(f.name.split(' / ')[0] || 'tETH')} and ${esc(other)} you already hold</button>${GET[other] ? `, or get ${esc(other)} first.</p>${getRow(other)}` : '.</p>'}` : '';
  // with no market price to check against (its read failed), the pool's own price is all there is: said, and held to a tick
  const kind = ackFor(q.cost, q.off), why = q.off ? `: this pool is priced ${pctTxt(q.off.gap * 100)} off the market` : ' to the pool’s price';
  const ack = kind === 'type' ? `<label class="ack"><span>Type <b>${n}</b> to accept losing about ${n}% of this deposit${why}.</span><input id="pz-ack" inputmode="numeric" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" aria-label="Type ${n} to accept" value="${Z.ack === key ? n : ''}"></label>`
    : kind === 'box' ? `<label class="ack"><input type="checkbox" id="pz-ack"${Z.ack === key ? ' checked' : ''}><span>I accept losing about ${n}% of this deposit${why}.</span></label>`
    : !q.checked ? `<label class="ack"><input type="checkbox" id="pz-ack"${Z.ack === key ? ' checked' : ''}><span>The market’s price for ${esc(other)} could not be read, so this pool’s price is not checked against it. I accept that.</span></label>` : '';
  rcpt.innerHTML = (f.live ? row('Earns about', `${tacTxt(q.day)} TAC a day${dayUsd ? ` · ${dayUsd}` : ''}`) + row('APR', q.apr == null ? '—' : aprText(q.apr)) : '')
    + (q.plan.shareOfPool > 0 ? row('Your share', `${sharePct(q.plan.shareOfPool)} of the pool`, '', 'What this deposit would be of the pool once it is in, counting its own shares. The farm’s TAC is shared in proportion, and a deposit that is a big part of the pool moves its price on the way in and out.') : '')
    + (q.impact >= 0.5 ? row('Price impact', pctTxt(q.impact), q.impact >= 5 ? 'err' : '') : '')
    + (q.against >= 1 ? row('Against the market', `${pctTxt(q.against)} of this deposit`, q.against >= 5 ? 'err' : '') : '')
    + (pb ? row('Rewards make it up', pb.text, pb.past ? 'err' : '', pb.note) : '')
    + row('You hold', `a private ${esc(f.name)} position`)
    + row('Exit', esc(exitSaid(f.pool.lockSeconds, f.name) || 'any time'))
    + row('Chain sees', 'ETH in, private after', '', 'The deposit is public: your wallet, the amount and the swap. The position it makes, what it earns and its exit are private.')
    + row('Network fee', fee, '', `About ${ZAP_GAS.toLocaleString('en-US')} gas at ${(Number(q.gp) / 1e9).toPrecision(2)} gwei, the gas price now`)
    + (line ? `<p class="note${q.over || q.cost >= 5 ? ' err' : ''}">${line}</p>` : '') + skip + ack;
  for (const ev of ['input', 'change']) $('#pz-ack')?.addEventListener(ev, () => { Z.ack = acked() ? key : null; gate(); });
}
function typed() {
  clearTimeout(Z.timer);
  Z.seq++;                                                                       // a quote still on its way is for the amount before this one
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
  else if (step === 'own') cookSay(esc(ownWhy(d)) + (d?.code === 'open' ? '' : ' About a minute to prove…'), { secs: d?.code === 'open' ? 0 : 60 });
  else if (step === 'own-confirm') cookSay('Confirm in your wallet: this one puts your share in the farm.');
}
// The farm entry sent from the connected wallet, for when the relay proves it but will not send it for free just now (farm-ops.js).
const ownSender = (t) => walletSettle(t, wallet, async () => W.account || (await connect.connect().catch(() => null), W.account), { confirm: () => onStep('own-confirm') });

// The Tacit key: the tab's own if it has one open, else opened at the press (the wallet connected here signs, with no sheet, on a first
// visit). The pool module and the key's notes are read as soon as it is open, so a press finds them ready.
let keyP = null, key = null, K = null, mineUi = null, mineP = null, uxP = null, ownP = null, runner = null;
const getUx = () => (uxP ||= import('/trade/poolux.js?cb=59d125e5').then((m) => m.getUx()).catch((e) => { uxP = null; throw e; }));
function session() {
  return keyP ||= import('/trade/key.js?cb=e9a3a06d').then((m) => {
    K = m;
    key = m.makeKeySession({ moved: (why) => { mineUi ? mineUi.forget(why) : key.lock(); statusEl.innerHTML = `<span class="err">${esc(why)}</span>`; }, busy: busyNow });
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
  if (busyNow()) return;
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
    if (!fresh.plan || fresh.over || fresh.plan.shares * 1000n < q.plan.shares * 995n || askedMore(q, fresh)) {
      Z.q = fresh; paintQuote();
      throw Object.assign(new Error('The price moved. Nothing was sent; the figures above are the new ones.'), { said: true, quiet: true });
    }
    Z.q = q = fresh;
    await openKey();
    const [t, r] = await Promise.all([getUx(), run()]), from = W.account, priv = () => key.priv();
    J = r.journal;
    const record = (h) => { hash = h; J.put(`tx:1:${String(h).toLowerCase()}`, { kind: 'tx', label: `Zap ${fmtUnits(q.plan.value, 18, 6)} ETH into ${f.name}`, chain: 1, hash: h, to: from, status: 'pending' }); };
    const out = await zapRun({ t, rpc, wallet, from, priv, pool: f.pool, q, ready: Z.ready, wait: waitFor(r, f), used: usedIndexes(f.pool), owned: () => owned(), own: ownSender(t),
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
  if (e?.share || e?.already) {                                                 // the transaction landed (now, or at an earlier press): the ETH is in the pool as a private share
    steps('farm', true); clearForm(); Z.share = { f, note: e.note || null };
    sayEl.innerHTML = `<span class="ok">Your share is private and safe.</span> It is not in the farm yet: ${msg}`;
    acts.innerHTML = '<button class="btn sm" type="button" data-act="farmit">Farm it</button>';
    react('down', 1600); readLoose();
    if (!e.note) watchLoose(f.pool);                                            // a balance that does not show it yet is read again, so the Farm it under the positions is there when it does
    return;
  }
  if (e?.reverted) {                                                            // sent and failed: the fee is gone, the share was not made, the proof is kept
    steps('send', true);
    sayEl.innerHTML = `<span class="err">${msg}</span>`;
    react('down', 1600);
    return;
  }
  if (e?.sent || hash) {                                                        // sent, and not seen to land
    steps('send', true); clearForm();
    sayEl.innerHTML = `<span class="err">Sent, not confirmed yet.</span> ${txLink(e.sent || hash)} Check it there before sending anything again. Once it lands, your share shows under Your private farms.`;
    react('down', 1600); readLoose(); watchLoose(f.pool);                       // and is read again until it does
    return;
  }
  const held = !!Z.ready, kept = held && declined(e);
  steps(held ? 'send' : 'prove', !kept);
  sayEl.innerHTML = kept ? 'Not sent. Your share’s proof is kept: press again to send it.' : `<span class="err">${msg}</span>${/Nothing was sent|nothing was spent/i.test(msg) ? '' : ' Nothing was sent.'}${held && !(e?.stale || e?.moved) ? ' Your share’s proof is kept for this amount.' : ''}`;
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
let LOOSE = [], looseFor = null, watchTimer = 0;
// A deposit sent and not seen to land, or made private where the balance does not show it yet: the key's shares are read again every half minute
// for ten minutes (until one of this pool's shows), so the Farm it under the positions is there once the share is.
function watchLoose(pool) {
  clearTimeout(watchTimer);
  const pub = keyPub, id = lc(pool?.poolId);
  const tick = async (left) => {
    if (keyPub !== pub || left <= 0) return;
    if (!Z.busy) { await readLoose(); if (looseFor === pub && LOOSE.some((x) => lc(x.pool.poolId) === id)) return; }
    watchTimer = setTimeout(() => tick(left - 1), 30e3);
  };
  watchTimer = setTimeout(() => tick(20), 30e3);
}
async function farmIt(pool, note0, btn = null) {
  if (busyNow()) return;
  if (Z.mode === 'both' && hasEth(Z.f)) setMode('eth');                           // its steps are said in the ETH form's card, which is the one on screen
  const f = FARMS.find((x) => x.pool && x.pool.poolId === pool.poolId) || { name: pairName(pool.pair), pid: Number(pool.pid) };
  Z.busy = true; lock(true); if (btn) btn.disabled = true;
  steps('farm'); acts.innerHTML = ''; react('cook');
  cookSay('Checking your share…');
  if (Z.f && !hasEth(Z.f)) { const form = $('#pz-eth'); form.classList.add('noeth'); form.hidden = false; }     // a pool with no ETH side keeps its form hidden: the steps are shown without it
  try {
    const [t, r] = await Promise.all([getUx(), run()]), priv = () => key.priv();
    // read afresh: a share the relay has put in the farm since is not held any more, and is not farmed twice
    const fresh = looseOf((await scan(true)).notes, [pool]), same = (n) => String(n.leaf).toLowerCase() === String(note0?.leaf).toLowerCase();
    if (note0 && !fresh.some((x) => same(x.note))) { farmed(f, null); return; }
    const note = note0 || fresh[0]?.note;
    if (!note) throw Object.assign(new Error('That share is not in your balance yet. Try again in a minute.'), { said: true });
    cookSay('The relay is putting your share in the farm, about a minute…', { secs: 70 });
    const out = await bondShare({ t, priv, note, wait: waitFor(r, f), say: onStep, own: ownSender(t) });
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
  return mineP ||= import('/rewards/farms.js?cb=f72e0b8a').then((m) => {
    mineUi = m.mountFarms($('#pf-mine'), { pick: pickProvider, session: key, wallet, W, connect: () => connect.connect(), program: () => S.prog,
      names: () => new Map(S.priv.map((x) => [x.pid, x.name])), pair: (pid) => { const icons = S.priv.find((x) => String(x.pid) === String(pid))?.icons; return icons ? pairIcons(icons) : ''; },
      onRead: (list) => { S.mine = new Map(list.map((p) => [Number(p.pid), p])); paint(); },
      joinAt: $('#pz-join'), more: getRow, onAct: (name, ok) => { if (name !== 'join') return; if (ok) { cheer('In the farm'); readLoose(); } else react('down', 1600); } });
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
