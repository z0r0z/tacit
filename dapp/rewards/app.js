import { secp, keccak_256 } from '/vendor/tacit-deps.min.js';
import { makeConfidentialNames, makeMainnetCall, MAINNET_RPCS, NameError } from '/confidential-names.js?cb=9efdff52';
import { bodyType } from '/rpc-body.js';
import { makeTacAirdrop, makeRpcCall } from '/tac-airdrop.js?cb=6a6bb45f';
import { makeConnect, UserStopped } from '/trade/connect.js?cb=de979716';
import { TAC, POOL, FARM, aprText, readPrecision, readSpot, readStake, privateFarms } from '/trade/farm-read.js?cb=112a01b9';
import { rememberOwed } from '/trade/rewards-dot.js?cb=f9cbe2e7';
import { readTasks } from '/rewards/earn.js?cb=74689244';
import { readCampaign, bestApr } from '/trade/lp-campaign.js?cb=9d89e80f';
import { DEPLOYMENTS } from '/vault/deployments.js?cb=4af96594';

const NO_SEND = ['0x0000000000000000000000000000000000000000', '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', '0x000000c918e44a3a443937fa7594ea4f7c95d6b9', '0x4b4cb98d0c836c2783ac46f0078b904dab533ae8'];
const API = 'https://api.tacit.finance', DISTRIBUTOR = '0x000000C918e44A3a443937fA7594eA4f7C95D6b9', BOARD = 500, KEEP = 60e3, RECENT = 'tacit-rewards-recent-v1';
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const names = makeConfidentialNames({ call: makeMainnetCall({}), secp, keccak256: keccak_256 });
const call = makeRpcCall({ rpcs: MAINNET_RPCS });
const air = makeTacAirdrop({ call, keccak256: keccak_256 });
const within = (s) => (s && AbortSignal.any ? AbortSignal.any([s, AbortSignal.timeout(20e3)]) : AbortSignal.timeout(20e3));
const get = (path, signal) => fetch(`${API}/${path}`, { signal: within(signal) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };
const connect = makeConnect({
  describe: 'Farm TAC, and look up and claim the airdrop and points.',
  rewards: false,
  busy: () => claiming,
  say: (html, bad) => wsay(html, bad),
  onChange: () => onWallet(),
  rows: () => '<button class="btn ghost" type="button" data-mine-sheet>Look up this account</button><button class="btn ghost" type="button" data-switch-sheet>Switch account</button>',
  wire: (root, close) => {
    root.querySelector('[data-mine-sheet]').onclick = () => { close(); lookMine(); };
    root.querySelector('[data-switch-sheet]').onclick = () => { close(); switchAccount(); };
  },
  restore: false,
});
const { wallet, W } = connect;

function tac(wei, dp = 2) {
  const v = BigInt(wei), unit = 10n ** BigInt(18 - dp), r = (v + unit / 2n) / unit;
  if (v > 0n && r === 0n) return `< ${(0.1 ** dp).toFixed(dp)}`;
  const s = r.toString().padStart(dp + 1, '0'), int = s.slice(0, s.length - dp), frac = s.slice(s.length - dp).replace(/0+$/, '');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
}
const day = (sec) => new Date(sec * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function checksumOk(a) {
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const h = Array.from(keccak_256(new TextEncoder().encode(body.toLowerCase())), (x) => x.toString(16).padStart(2, '0')).join('');
  return [...body.toLowerCase()].every((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c) === body[i]);
}

const kept = new Map();
function keep(key, make) {
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < KEEP) return hit.p;
  const p = make();
  kept.set(key, { at: Date.now(), p });
  p.then((v) => { if (v == null || v.reason === 'error' || v.error) kept.delete(key); }, () => kept.delete(key));
  return p;
}

function identify(raw) {
  const s = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    if (!checksumOk(s)) throw new Error('That address has a bad checksum. Check it for typos.');
    return Promise.resolve({ address: s.toLowerCase(), name: null });
  }
  if (/^\S+\.\S+$/.test(s)) {
    const n = s.toLowerCase();
    return keep(`name:${n}`, async () => {
      let r;
      try { r = await names.resolveAddress(n); } catch (e) { throw new Error(e instanceof NameError ? e.message : 'Could not read that name. Try again.'); }
      if (!r) throw new Error(`${n} has no address set.`);
      return { address: r.address, name: r.name };
    });
  }
  throw new Error('Enter a 0x address, or a name ending in .eth, .wei or .gwei.');
}

const claimedOn = (address) => call({ to: DISTRIBUTOR, data: `0xc884ef83${address.slice(2).padStart(64, '0')}` }).then(BigInt);
const capNow = () => keep('cap', () => get('leaderboard?day=today&limit=1').then((d) => {
  const c = (d?.program?.rateCap || []).filter((x) => x.fromDay <= d.day).sort((a, b) => b.fromDay - a.fromDay)[0];
  return d?.program ? { program: d.program, day: d.day, cap: c ? BigInt(c.maxWeiPerPoint) : null, programDay: d.programDay, programDays: d.programDays, settleAt: ((d.day + 1) * 86400 + (Number(d.program.settleGraceSecs) || 0)) * 1000 } : null;
}));
function readPoints(address, signal) {
  return keep(`points:${address}`, async () => {
    const [p, c, paid, prog] = await Promise.all([get(`points/${address}`, signal), get(`claim/${address}`, signal), claimedOn(address).catch(() => null), capNow().catch(() => null)]);
    if (!p) return { error: true };
    const earned = BigInt(c?.cumulativeAmount || 0), claimed = paid ?? BigInt(c?.claimedWei || 0);
    const t = p.today, pts = Number(t?.points) || 0, all = Number(t?.totalPoints) || 0;
    let today = null;
    if (pts > 0 && all > 0) {
      const mp = BigInt(Math.round(pts * 1e6)), share = BigInt(t.dayBudgetWei || 0) * mp / BigInt(Math.round(all * 1e6));
      const own = t.tacWei != null && /^\d+$/.test(String(t.tacWei)) ? BigInt(t.tacWei) : null;
      today = { points: pts, pct: pts / all * 100, tac: own ?? (prog ? (prog.cap != null && mp * prog.cap / 1000000n < share ? mp * prog.cap / 1000000n : share) : null) };
    }
    return { points: Number(p.points) || 0, earned, claimed, owed: c?.proof && earned > claimed ? earned - claimed : 0n, unread: paid === null && earned > 0n, today, clock: prog && prog.programDay <= prog.programDays ? { day: prog.programDay, days: prog.programDays, settleAt: prog.settleAt } : null };
  });
}
const readAirdrop = (address) => keep(`airdrop:${address}`, () => air.status(address));

let primedAt = 0;
function prime() {
  if (Date.now() - primedAt < 300e3) return;
  primedAt = Date.now();
  for (const u of MAINNET_RPCS) fetch(u, { method: 'POST', headers: { 'content-type': bodyType(u) }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).catch(() => {});
}

let boardP = null, boardAt = 0;
function board() {
  if (!boardP || Date.now() - boardAt > KEEP) {
    boardAt = Date.now();
    boardP = get(`leaderboard?limit=${BOARD}`).then((b) => { if (!Array.isArray(b)) boardP = null; return Array.isArray(b) ? b : null; });
  }
  return boardP;
}
const rankOf = (address) => board().then((b) => { const i = b ? b.findIndex((e) => String(e.address).toLowerCase() === address) : -1; return i >= 0 ? i + 1 : b && b.length >= BOARD ? 0 : null; });

const ninja = $('#ninja'), emo = $('#emo');
let moodTimer = 0, winkTimer = 0;
function react(mood, ms = 3400) {
  clearTimeout(moodTimer); clearTimeout(winkTimer);
  ninja.classList.remove('wink');
  ninja.dataset.mood = mood;
  emo.classList.remove('pop');
  emo.textContent = { up: '👍', down: '👎' }[mood] || '';
  if (emo.textContent) { void emo.offsetWidth; emo.classList.add('pop'); }
  const wink = () => { ninja.classList.add('wink'); winkTimer = setTimeout(() => ninja.classList.remove('wink'), 650); };
  if (mood === 'wink') wink(); else if (mood === 'up') winkTimer = setTimeout(wink, 950);
  if (mood === 'idle' || mood === 'think') return;
  moodTimer = setTimeout(() => { ninja.dataset.mood = 'idle'; emo.textContent = ''; }, ms);
}
ninja.addEventListener('click', () => react('wink', 1600));

const figure = (n, text, unit) => `<p class="fig num"><span class="cu" data-to="${n}" data-text="${esc(text)}">${esc(text)}</span><small>${unit}</small></p>`;
const lone = (title, line, cls = 'mute') => `<div class="rw none"><h3>${title}</h3><p class="st ${cls}">${line}</p></div>`;
const claimUi = (kind, label, address, to, amount, wei) => (wallet.available().length
  ? `<button class="act" type="button" data-claim="${kind}" data-addr="${address}" data-amt="${esc(amount)}" data-wei="${wei}">${label}</button>`
  : `<a class="act" href="${to}">${label}</a>`);
const sendTo = (address, wei) => (wallet.available().length ? `<p class="to"><button class="linkbtn" type="button" data-to-show>Send it to another address</button></p>
  <form class="toform" id="to-f" hidden novalidate><label class="sr" for="to-q">Where to send it: an address or a .eth, .wei or .gwei name</label><input id="to-q" placeholder="0x address or name" autocomplete="off" spellcheck="false" autocapitalize="off" autocorrect="off"><button class="act" type="submit" data-claim="airdrop-to" data-addr="${address}" data-amt="${esc(tac(wei))}" data-wei="${wei}">Claim to this address</button></form>` : '');
function airdropRow(s, address) {
  if (s.reason === 'error') return lone('Airdrop', 'Could not read the airdrop. Try again in a moment.', 'warn');
  if (!s.eligible) return lone('Airdrop', 'Not on the airdrop list.');
  const left = Math.ceil((s.deadline - Date.now() / 1000) / 86400), by = day(s.deadline);
  const [cls, line] = s.claimed ? ['ok', 'Claimed'] : s.claimable ? [left <= 7 ? 'warn' : 'ok', `Claim by ${by} · ${left} day${left === 1 ? '' : 's'} left`] : s.reason === 'closed' ? ['mute', `Closed ${by}`] : ['warn', s.message];
  return `<div class="rw"><h3>Airdrop</h3>${figure(Number(s.amountTac), tac(s.amountWei), 'TAC')}<p class="st ${cls}">${esc(line)}</p>${s.claimable ? claimUi('airdrop', `Claim ${tac(s.amountWei)} TAC`, address, '/#airdrop', tac(s.amountWei), s.amountWei) + sendTo(address, s.amountWei) : ''}</div>`;
}
function clockLine(c) {
  const at = new Date(c.settleAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `Day ${c.day} of ${c.days} · today’s points can be claimed after ${at} UTC`;
}
function pointsRow(p, address) {
  if (p.error) return lone('Points', 'Could not read points. Try again in a moment.', 'warn');
  const t = p.today, pct = t ? (t.pct < 0.01 ? t.pct.toFixed(4) : t.pct < 1 ? t.pct.toFixed(3) : t.pct.toFixed(2)) : '', pts = Math.round(p.points).toLocaleString('en-US');
  const fig = p.owed > 0n ? figure(Number(p.owed) / 1e18, tac(p.owed), 'TAC') : figure(Math.round(p.points), pts, 'points');
  const kv = p.earned > 0n ? `<dl class="kv"><div><dt>Earned from finished days</dt><dd class="num">${tac(p.earned)} TAC</dd></div><div><dt>Claimed</dt><dd class="num">${tac(p.claimed)} TAC</dd></div><div><dt>To claim</dt><dd class="num">${p.unread ? 'unavailable' : `${tac(p.owed)} TAC`}</dd></div></dl>` : '';
  return `<div class="rw"><h3>Points</h3>${fig}<p class="st mute"><span>${p.points > 0 ? `${pts} points` : 'No points yet.'}</span><span id="rank"></span></p>`
    + (t ? `<p class="st mute">Today ${Math.round(t.points).toLocaleString('en-US')} points · ${pct}% of the day${t.tac != null ? ` · about ${tac(t.tac)} TAC` : ''}</p>` : '')
    + (p.claimed > 0n && p.owed <= 0n ? `<p class="st mute">${tac(p.claimed)} TAC claimed so far</p>` : '')
    + (p.points > 0 && p.clock ? `<p class="st mute clock">${clockLine(p.clock)}</p>` : '')
    + (p.owed > 0n ? claimUi('points', `Claim ${tac(p.owed)} TAC`, address, '/#points', tac(p.owed), p.owed) : '')
    + (p.points > 0 ? `<details class="fold x" data-days="${address}"><summary>Points by day</summary><div class="fold-b">${kv}<div class="days"></div><p class="more"><a href="/#points">Holding proof and more in the app →</a></p></div></details>` : '')
    + '</div>';
}
let stakeOf = null;
const readFarmFor = (address) => farmFacts().then((facts) => readStake(call, address, facts).then((stake) => ({ facts, stake })), () => null);
function paintFarmRow(address) {
  const el = $('#c-farm');
  if (!el) return;
  const h = farmRow(address);
  if (el.__h !== h) { el.__h = h; paint('#c-farm', h); }
}
function showStake(address, r) {
  stakeOf = r?.stake ? { address, stake: r.stake, facts: r.facts } : null;
  paintFarmRow(address);
  tot.farm = r?.stake ? r.stake.earned : 0n;
  if (!r?.stake) tot.bad = true;
  paintTotal();
}
function farmRow(address) {
  const m = stakeOf?.address === address ? stakeOf.stake : null, f = stakeOf?.facts;
  if (!m) return '';
  const looseWorth = f && f.supply > 0n ? m.loose * f.r0 / f.supply : 0n;
  if (m.staked === 0n && m.earned === 0n && looseWorth < 10n ** 14n) return '';
  const mine = !!W.account && W.account.toLowerCase() === address;
  const worth = m.staked > 0n ? `${eth4(m.eth)} ETH + ${tac(m.tac, 0)} TAC in the pool` : `${tac(m.loose, 4)} pool shares, not staked`;
  return `<div class="rw"><h3>Farm</h3>${figure(Number(m.earned) / 1e18, tac(m.earned, 4), 'TAC')}<p class="st mute">${esc(worth)}${f?.apr != null ? ` · ${aprText(f.apr)} APR` : ''}</p>`
    + `<button class="act" type="button" data-open-farm>${mine && m.earned > 0n ? 'Claim in the farm' : 'Open the farm'}</button></div>`;
}
let tot = { address: null, air: null, pts: null, farm: null, bad: false };
function paintTotal() {
  if (!$('#tot') || tot.address !== out.dataset.address || [tot.air, tot.pts, tot.farm].some((v) => v == null)) return;
  const sum = tot.air + tot.pts + tot.farm;
  if (!tot.bad && W.account && W.account.toLowerCase() === tot.address) rememberOwed(tot.address, tot.air > 0n || tot.pts >= 10n ** 16n);
  paint('#tot', sum > 0n ? `<b class="num">${esc(tac(sum))}</b>TAC to claim` : tot.bad ? '' : 'Nothing to claim yet');
}
const whoLine = (who, q) => `<p class="who"><b>${esc(who.name || short(who.address))}</b>${who.name ? `<span>${short(who.address)}</span>` : ''}</p>
  <p class="acts"><button type="button" data-copy="${who.address}">Copy address</button><a href="https://etherscan.io/address/${who.address}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a><button type="button" data-copy="${esc(`${location.origin}/rewards/?q=${encodeURIComponent(q)}`)}" data-said="Link copied">Copy link</button></p>
  <p class="wl" id="wl"></p>
  <div id="done" aria-live="polite"></div>`;
const SKEL = (t) => `<div class="rw ld"><h3>${t}</h3><p class="fig"><span class="sk"></span></p></div>`;
const YOURS = `<section class="card yours" id="yours"><div class="yh"><h2>Your rewards</h2><p class="tot" id="tot"></p></div><div id="c-air">${SKEL('Airdrop')}</div><div id="c-pts">${SKEL('Points')}</div><div id="c-farm"></div></section>`;
const SKELETON = `<p class="who"><b><span class="sk"></span></b></p>${YOURS}`;

function countUp(el) {
  const to = Number(el.dataset.to), text = el.dataset.text;
  if (calm || !(to > 0)) { el.dataset.settled = '1'; return; }
  const t0 = performance.now(), ms = 650, dp = text.includes('.') ? text.split('.')[1].length : 0;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms), e = 1 - (1 - k) ** 3;
    el.textContent = k >= 1 ? text : (to * e).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    if (k < 1 && el.isConnected) requestAnimationFrame(step); else { el.textContent = text; el.dataset.settled = '1'; }
  };
  requestAnimationFrame(step);
}
function paint(sel, html) { const el = $(sel); if (!el) return; el.innerHTML = html; el.querySelectorAll('.cu').forEach(countUp); }
function fillRank(address, p) {
  if (p.error || !(p.points > 0)) return;
  rankOf(address).then((k) => { const el = $('#rank'); if (el && out.dataset.address === address) el.textContent = k > 0 ? ` · Rank #${k.toLocaleString('en-US')}` : k === 0 ? ` · Outside the top ${BOARD}` : ''; });
}

const COIN = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#0a0a0a"/><circle cx="16" cy="16" r="13" fill="none" stroke="#f4efe6" stroke-width="2.5"/><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="#f7931a" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="#f7931a" stroke-width="2.4" stroke-linecap="round"/></svg>')}`;
function confetti() {
  if (calm) return;
  $('#fx')?.remove();
  const cv = document.createElement('canvas'), W = innerWidth, H = innerHeight, dpr = Math.min(2, devicePixelRatio || 1);
  cv.id = 'fx'; cv.setAttribute('aria-hidden', 'true'); cv.width = W * dpr; cv.height = H * dpr;
  const n = Math.max(40, Math.min(150, Math.round(W / 9))), g = cv.getContext('2d'), img = new Image();
  cv.dataset.coins = String(n);
  g.scale(dpr, dpr);
  document.body.append(cv);
  const coins = Array.from({ length: n }, () => ({ x: Math.random() * W, y: -40 - Math.random() * H * 0.7, s: 18 + Math.random() * 18, vy: 190 + Math.random() * 230, sway: 16 + Math.random() * 38, ph: Math.random() * 6.28, spin: 3 + Math.random() * 5, a: Math.random() * 6.28 }));
  let last = performance.now();
  const t0 = last, frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    g.clearRect(0, 0, W, H);
    let live = 0;
    for (const c of coins) {
      c.y += c.vy * dt; c.vy += 90 * dt; c.a += c.spin * dt;
      if (c.y > H + 40) continue;
      live++;
      g.save();
      g.translate(c.x + Math.sin(c.ph + (now - t0) / 600) * c.sway, c.y); g.rotate(Math.sin(c.a) * 0.4); g.scale(Math.cos(c.a * 1.3), 1);
      g.drawImage(img, -c.s / 2, -c.s / 2, c.s, c.s);
      g.restore();
    }
    cv.dataset.live = String(live);
    if (live && now - t0 < 9000 && cv.isConnected) requestAnimationFrame(frame); else cv.remove();
  };
  img.addEventListener('load', () => requestAnimationFrame(frame), { once: true });
  img.addEventListener('error', () => cv.remove(), { once: true });
  img.src = COIN;
}

const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const txLink = (h) => `<a href="https://etherscan.io/tx/${h}" target="_blank" rel="noopener noreferrer">${h.slice(0, 10)}…${h.slice(-6)} ↗</a>`;
async function signedIn(address) {
  if (!W.account && !(await connect.connect())) throw new UserStopped();
  const mine = String(W.account || '').toLowerCase();
  if (!mine) throw new Error('Your wallet did not share an account.');
  if (mine !== address) throw new Error(`Your wallet is on ${short(mine)}. Switch it to ${short(address)} to claim.`);
}
async function pointsTx(address) {
  const attempt = async (c) => {
    const proof = c?.proof;
    if (!proof?.length || !c.cumulativeAmount) throw new Error('Nothing left to claim here.');
    const data = `0x2f52ebb7${word(c.cumulativeAmount)}${word(64)}${word(proof.length)}${proof.map((h) => h.replace(/^0x/, '').padStart(64, '0')).join('')}`;
    try { await call({ to: DISTRIBUTOR, data, from: address }); } catch (e) {
      const sel = String(e?.data || '').slice(2, 10);
      if (e?.code !== 3) throw new Error('Could not check the claim before sending it. Nothing was sent.');
      throw Object.assign(new Error(sel === '797dba54' ? 'Nothing left to claim here.' : 'The contract would refuse this claim. Nothing was sent.'), { stale: sel === '7ca55c77' });
    }
    return wallet.sendTx({ to: DISTRIBUTOR, data, from: address });
  };
  try { return await attempt(await get(`claim/${address}`)); } catch (e) {
    if (!e.stale) throw e;
    try { return await attempt(await get(`claim/${address}`)); } catch (e2) { throw e2.stale ? new Error('The reward list just updated. Try again in a minute.') : e2; }
  }
}
let claiming = false;
async function claim(kind, address, btn, to = '') {
  if (claiming) return;
  claiming = true;
  const label = btn.textContent, amt = btn.dataset.amt;
  let dest = null;
  let hash = null;
  const say = (html) => { const d = $('#done'); if (!d || out.dataset.address !== address) return; d.querySelector('.note-claim')?.remove(); d.insertAdjacentHTML('afterbegin', html); };
  btn.disabled = true;
  try {
    if (to !== '') {
      btn.textContent = 'Looking it up…'; dest = (await identify(to)).address;
      if (NO_SEND.includes(dest)) throw new Error('TAC sent to that address could not be recovered. Use another address.');
    }
    await signedIn(address);
    btn.textContent = 'Confirm in your wallet…'; react('think');
    const send = (t) => wallet.sendTx({ to: t.to, data: t.data, from: address });
    hash = kind === 'airdrop' ? (await (dest ? air.claimTo(address, dest, { send }) : air.claim(address, { from: address, send }))).txHash : await pointsTx(address);
    btn.textContent = 'Claiming…'; say(`<p class="note-claim st mute">Claiming ${esc(amt)} TAC · ${txLink(hash)}</p>`);
    const rc = await wallet.receipt(hash);
    if (rc.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was claimed.`);
    $('#done')?.querySelector('.note-claim')?.remove();
    $('#done')?.insertAdjacentHTML('beforeend', `<p class="done"><b>Claimed ${esc(amt)} TAC${dest ? ` to ${short(dest)}` : ''}</b>${txLink(hash)}${dest ? '' : '<button class="linkbtn" type="button" data-watch>Add TAC to wallet</button>'}</p>`);
    said(`Claimed ${amt} TAC`); react('up', 4200); confetti();
    if (!dest) farmClaimed(BigInt(btn.dataset.wei || 0));
    kept.delete(`airdrop:${address}`); kept.delete(`points:${address}`);
    await sleep(1500);
    const [a, p] = await Promise.all([readAirdrop(address), readPoints(address)]);
    if (out.dataset.address === address) {
      paint('#c-air', airdropRow(a, address)); paint('#c-pts', pointsRow(p, address)); fillRank(address, p); claimedNow(address, a0(a), p0(p));
      tot.air = a.claimable ? BigInt(a.amountWei) : 0n; tot.pts = p.error ? 0n : p.owed; tot.bad = a.reason === 'error' || !!p.error || tot.bad; paintTotal();
    }
  } catch (e) {
    react(e instanceof UserStopped ? 'idle' : 'shake');
    say(`<p class="note-claim st ${e instanceof UserStopped ? 'mute' : 'warn'}">${esc(e.message || 'The claim did not go through.')}${hash ? ` · ${txLink(hash)}` : ''}</p>`);
    btn.textContent = label;
  } finally { claiming = false; if (btn.isConnected) btn.disabled = false; }
}

let got = { address: null, air: 0n, pts: 0n }, bwMod = null, bwSeq = 0;
const bwQuotes = new Map();
const a0 = (s) => (s && s.claimed && s.amountWei ? BigInt(s.amountWei) : 0n);
const p0 = (v) => (v && !v.error && v.claimed > 0n ? v.claimed : 0n);
const rpcOf = (method, params) => (method === 'eth_call' ? call(params[0]) : Promise.reject(new Error(`${method} is not read here`)));
function quoteFor(wei) {
  return keepFor(bwQuotes, String(wei), () => (bwMod ||= import('/vault/quote.js?cb=5444fc51').catch((e) => { bwMod = null; throw e; })).then((m) => m.quoteBorrow({ tac: wei, rpc: rpcOf })));
}
function keepFor(map, key, make) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < KEEP) return hit.p;
  const p = make(); map.set(key, { at: Date.now(), p }); p.catch(() => map.delete(key));
  return p;
}
const BW_DP = { usd: 2, eth: 4 };
function borrowLine(q) {
  const open = ['usd', 'eth'].map((k) => q?.[k]).filter((v) => v?.state === 'open'), fig = (v) => `${esc(tac(v.amount, BW_DP[v.key]))} ${v.sym}`;
  if (!open.length) {
    if (q && ['usd', 'eth'].every((k) => q[k]?.state === 'closed')) return '<p class="bw-l">Borrowing against TAC is not open right now. <a class="bw-alt" href="/vault/">See the vaults →</a></p>';
    return '<p class="bw-l"><a class="bw-go" href="/vault/">Borrow TACD or TACE against the TAC you claimed →</a></p>';
  }
  const [a, b] = open;
  return `<p class="bw-l"><a class="bw-go" href="${esc(a.href)}">Borrow up to <b>${fig(a)}</b> against the TAC you claimed →</a>${b ? `<a class="bw-alt" href="${esc(b.href)}">or ${fig(b)}</a>` : ''}</p>`;
}
function claimedNow(address, air, pts) {
  if (got.address !== address) return;
  if (air != null) got.air = air;
  if (pts != null) got.pts = pts;
  const el = $('#c-bw'), total = got.air + got.pts, my = ++bwSeq;
  if (!el || out.dataset.address !== address) return;
  if (total <= 0n) { el.innerHTML = ''; return; }
  if (!$('#bw')) el.innerHTML = `<section class="card slim bw" id="bw">${borrowLine(null)}</section>`;
  quoteFor(total).then((q) => q, () => null).then((q) => { const box = $('#bw'); if (my === bwSeq && box && out.dataset.address === address) { const h = borrowLine(q); if (box.__h !== h) { box.__h = h; box.innerHTML = h; } } });
}

const json = (url) => fetch(url, { signal: AbortSignal.timeout(8e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const farmFacts = () => keep('farm', () => readPrecision(call));
const ICONS = new Set(['tac', 'tacd', 'tace', 'eth', 'teth', 'cusd', 'cbtc']);
const pairIcons = (ids) => `<span class="pairtk">${ids.filter((i) => ICONS.has(i)).map((i) => `<svg class="tk" aria-hidden="true"><use href="#tk-${i}"/></svg>`).join('')}</span>`;
const dot = (on) => `<i class="sd${on ? ' on' : ''}"></i>`;
function noteFarm(f) {
  $('#farm-apr').textContent = f?.live ? aprText(f.apr) : f ? '—' : '';
  $('#farm-d').innerHTML = f?.live ? `${dot(true)}Public · ${tac(f.perDay, 0)} TAC a day` : f ? `${dot(false)}Public · between reward periods` : 'Public';
}
let PRIV = [], PROG = null;
function paintPrivate(list) {
  PRIV = list;
  const host = $('#farms'), h = list.map((x) => `<a class="ern" data-priv href="/#farm/private-${x.pid}">${pairIcons(x.icons)}<span class="rt"><b>${esc(x.name)}</b><small>${dot(true)}Private · ${Math.round(x.perDay).toLocaleString('en-US')} TAC a day</small></span><span class="ra"><b class="apr">${aprText(x.apr)}</b><small>APR now</small></span><span class="go o">Farm</span></a>`).join('');
  if (host.__priv === h) return;
  host.__priv = h;
  $$('#farms [data-priv]').forEach((e) => e.remove());
  const at = $('#lp-usd');
  if (at) at.insertAdjacentHTML('beforebegin', h); else host.insertAdjacentHTML('beforeend', h);
}
// The holder's own private positions (rewards/farms.js): loaded on the first press, so the page reads nothing more until then
const pickProvider = (list) => { const mine = wallet.available().find((w) => w.provider === W.prov)?.info?.uuid; return mine && list.some((x) => x.uuid === mine) ? mine : list[0]?.uuid; };
let farmsP = null;
const openFarms = () => (farmsP ||= import('/rewards/farms.js?cb=b5169592').then((m) => { const f = m.mountFarms($('#pf-mine'), { pick: pickProvider, names: () => new Map(PRIV.map((x) => [x.pid, x.name])), pair: (pid) => { const icons = PRIV.find((x) => String(x.pid) === String(pid))?.icons || []; return icons.length ? pairIcons(icons) : ''; }, program: () => PROG, wallet, W, connect: () => connect.connect() }); $('#pf-mine [data-pf="open"]')?.click(); return f; })
  .catch((err) => { farmsP = null; console.warn('your positions:', err?.message || err); }));
$('#pf-mine').addEventListener('click', (e) => {
  if (farmsP || !e.target.closest('[data-pf="open"]')) return;
  e.stopImmediatePropagation();
  openFarms();
});
// a private farm's row opens the panel here with that farm in the join form (a new tab still goes to the front page's)
$('#farms').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-priv]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  const pid = /private-(\d+)/.exec(a.getAttribute('href'))?.[1], row = $('#pf-row');
  row.open = true; row.scrollIntoView({ behavior: 'smooth', block: 'start' });
  openFarms().then((f) => f?.choose(pid));
});
function notePoints(c) {
  if (!c?.program) return;
  const over = c.programDay > c.programDays;
  $('#pts-f').textContent = over ? '' : tac(BigInt(c.program.dayBudgetWei || 0), 0);
  $('#pts-s').innerHTML = over ? `${dot(false)}The program has ended` : `${dot(true)}Day ${c.programDay} of ${c.programDays} · split by points`;
}
// TACD's and TACE's pools: shown while the liquidity campaign pays for them, each with the most a dollar in one of them earns a year
function noteLiquidity(c, tacUsd = 0) {
  for (const [key, id] of [['usd', 'lp-usd'], ['eth', 'lp-eth']]) {
    const row = $(`#${id}`), apr = c ? bestApr(c, key, tacUsd) : null;
    row.hidden = !c;
    row.classList.remove('wait');
    row.querySelector('.apr').textContent = apr == null ? '' : aprText(apr);
  }
}
const noteTasks = (t) => { $('#tk-f').textContent = t ? tac(t.left, 0) : '—'; };
function farmChanged() {
  kept.delete('farm');
  farmFacts().then(noteFarm, () => {});
  const address = out.dataset.address;
  if (address) readFarmFor(address).then((r) => { if (out.dataset.address === address) showStake(address, r); });
}
let earnTimer = 0;
function earnAgain() {
  clearTimeout(earnTimer);
  earnTimer = setTimeout(() => { if (!document.hidden) { kept.delete('farm'); readEarn(); } else earnAgain(); }, 120e3);
}
async function readEarn() {
  earnAgain();
  const f = await farmFacts().catch(() => null);
  noteFarm(f);
  const spot = readSpot((calls) => Promise.all(calls.map((c) => call(c).catch(() => null))));
  Promise.all([get('farm/program?network=mainnet'), spot]).then(([prog, px]) => { PROG = prog; paintPrivate(privateFarms(prog, f?.tacEth || 0, px)); }, () => paintPrivate([]));
  capNow().then(notePoints, () => {});
  const synths = Object.fromEntries(DEPLOYMENTS.vaults.map((v) => [v.key, v.hint?.synth]).filter(([, a]) => a));
  Promise.all([readCampaign({ ethCall: (to, data) => call({ to, data }), synths }), spot]).then(([c, px]) => noteLiquidity(c, (px.ethUsd || 0) * (f?.tacEth || 0)), () => noteLiquidity(null));
  readTasks(json).then(noteTasks, () => noteTasks(null));
}

const ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const farm = $('#farm'), farmSum = $('#farm-s'), farmNote = $('#farm-note');
let farmUi = null, farmFor = null, farmSeq = 0, ethUsd = 0, hasStake = false;
const eth4 = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumSignificantDigits: 3 });
const wordOf = (a) => a.slice(2).toLowerCase().padStart(64, '0');
function mountedFarm() {
  return farmUi ||= Promise.all([import('/trade/farm.js?cb=e3f70b9d'), import('/trade/util.js?cb=dcf3a4f2'), import('/evm-trade-venues.js?cb=5a940508'),
    call({ to: ETH_USD, data: '0xfeaf968c' }).then((r) => { ethUsd = Number(BigInt(`0x${r.slice(66, 130)}`)) / 1e8; }, () => {})])
    .then(([{ mountFarm }, U, E]) => {
      const ethCall = (to, data, block = 'latest', o = {}) => U.rpc('eth_call', [{ to, data, ...(o.from ? { from: o.from } : {}), ...(o.value ? { value: `0x${BigInt(o.value).toString(16)}` } : {}) }, block]);
      const batch = async (calls) => E._internal.decAggregate3(await ethCall(E.MULTICALL3, E._internal.encAggregate3(calls)), calls.length);
      const done = () => { react('up', 3000); said('Farm updated'); showFarm(); farmChanged(); };
      return mountFarm($('#farm-host'), { ethCall, batch, rpc: U.rpc, api: U.api, wallet, W, connect: () => connect.connect(), fmtUnits: U.fmtUnits, parseUnits: U.parseUnits, esc, usd: U.usd, ethUsd: () => ethUsd, txLink, onDone: done, refarm: true });
    })
    .catch((e) => { farmUi = null; throw e; });
}
async function showFarm(extra = 0n) {
  const mine = W.account ? W.account.toLowerCase() : null, my = ++farmSeq;
  if (!mine) { farmSum.textContent = ''; hasStake = false; return; }
  const [held, staked, earned, lp] = await Promise.all([[TAC, '0x70a08231'], [FARM, '0x98807d84'], [FARM, '0x008cc262'], [POOL, '0x70a08231']].map(([to, sel]) => call({ to, data: `${sel}${wordOf(mine)}` }).then(BigInt, () => 0n)));
  if (my !== farmSeq || (W.account || '').toLowerCase() !== mine) return;
  const shown = held > extra ? held : extra;
  hasStake = staked > 0n || earned > 0n || lp > 0n;
  farmSum.textContent = shown > 0n ? `${tac(shown)} TAC held` : hasStake ? 'Your stake' : '';
}
async function openFarm() {
  const want = farmFor; farmFor = null;
  farmNote.textContent = '';
  try {
    const f = await mountedFarm();
    if (!W.account) return;
    const r = await f.pairWith(want, { settle: want != null });
    if (!r) farmNote.textContent = want != null ? 'Your TAC has not arrived yet. Close this and open it again in a moment.' : '';
    else if (r.mode === 'tac') farmNote.textContent = 'This wallet has no spare ETH, so the TAC is added alone. The pool first swaps half of it to ETH.';
    else if (r.left > 0n) farmNote.textContent = `Your ETH covers ${tac(r.tac)} of the ${tac(r.all)} TAC. All of it needs ${eth4(r.need)} ETH.`;
  } catch { $('#farm-host').innerHTML = '<p class="note err">Could not load the farm. <a href="/#farm/public">Open it on the front page</a>.</p>'; }
}
farm.addEventListener('toggle', () => { if (farm.open) openFarm(); });
$('#farm-host').addEventListener('input', () => { farmNote.textContent = ''; });
const toFarm = () => setTimeout(() => farm.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'nearest' }), 350);
function farmClaimed(wei) {
  farmFor = wei > 0n ? wei : null;
  showFarm(wei).then(() => { if (farm.open) openFarm(); else farm.open = true; toFarm(); });
}
function openTheFarm() { if (!farm.open) farm.open = true; toFarm(); farm.querySelector('summary').focus({ preventScroll: true }); }
if (location.hash === '#farm') farm.open = true;
addEventListener('hashchange', () => { if (location.hash === '#farm') openTheFarm(); });

const dayName = (n) => new Date(n * 86400e3).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
async function paintDays(d) {
  const el = d.querySelector('.days'), a = d.dataset.days;
  if (el.dataset.done === a) return;
  el.innerHTML = '<p class="st mute">Loading…</p>';
  const r = await keep(`days:${a}`, () => get(`points/${a}/days`));
  if (!el.isConnected) return;
  if (!r || !Array.isArray(r.days)) { el.innerHTML = '<p class="st warn">Could not load this. Close it and open it again.</p>'; return; }
  const list = r.days.slice(0, 14);
  el.innerHTML = list.length ? `<ul class="rows">${list.map((x) => `<li><span>${dayName(x.day)}</span><b class="num">+${Number(x.points).toLocaleString('en-US', { minimumFractionDigits: Number(x.points) < 10 ? 2 : 1, maximumFractionDigits: Number(x.points) < 10 ? 2 : 1 })}</b><span class="m">${x.settled ? (x.tacWei == null ? '—' : `${tac(BigInt(x.tacWei), 4)} TAC`) : 'in progress'}</span></li>`).join('')}</ul>${list.some((x) => x.settled && x.tacWei == null) ? '<p class="st mute">A dash means that day’s TAC is in the total above but not shown by day.</p>' : ''}${r.days.length > 14 ? `<p class="st mute">The latest 14 of ${r.days.length} days.</p>` : ''}` : '<p class="st mute">No days yet.</p>';
  el.dataset.done = a;
}
async function paintBoard() {
  const el = $('#lb-b'), who = out.dataset.address;
  if (!el || el.dataset.done === '1') return;
  el.innerHTML = '<p class="st mute">Loading…</p>';
  const b = await board();
  if (!el.isConnected) return;
  if (!b) { el.innerHTML = '<p class="st warn">Could not load this. Close it and open it again.</p>'; return; }
  const i = b.findIndex((e) => String(e.address).toLowerCase() === who);
  const row = (e, k) => `<li${String(e.address).toLowerCase() === who ? ' class="me"' : ''}><button type="button" data-q="${esc(e.address)}"><span class="k">#${k}</span><span class="a">${short(e.address)}</span><b class="num">${Math.round(e.points).toLocaleString('en-US')}</b></button></li>`;
  el.innerHTML = `<ol class="board">${b.slice(0, 10).map((e, k) => row(e, k + 1)).join('')}${i >= 10 ? `<li class="gap" aria-hidden="true">⋯</li>${row(b[i], i + 1)}` : ''}</ol>`;
  el.dataset.done = '1';
}
const inForce = (list, day) => (list || []).filter((e) => e.fromDay <= day).sort((a, b) => b.fromDay - a.fromDay)[0];
async function paintEarn() {
  const el = $('#earn-b');
  if (!el || el.dataset.done === '1') return;
  el.innerHTML = '<p class="st mute">Loading…</p>';
  const c = await capNow().catch(() => null);
  if (!el.isConnected) return;
  const P = c?.program;
  if (!P?.rates) { el.innerHTML = '<p class="st warn">Could not load this. Close it and open it again.</p>'; return; }
  const day = c.day, wts = inForce(P.weights, day)?.weights || {}, caps = inForce(P.addressDayCaps, day)?.caps || {}, shares = inForce(P.categoryShareCaps, day)?.caps || {};
  const pot = tac(BigInt(P.dayBudgetWei || 0), 0), n = (x) => Math.round(x).toLocaleString('en-US');
  const note = (k) => `${wts[k] != null && wts[k] !== 1 ? ` · ${wts[k]}×` : ''}${caps[k] ? ` · up to ${caps[k]} ETH a day per address` : ''}${shares[k] ? ` · together at most ${Math.round(shares[k] * 100)}% of a day’s ${pot} TAC` : ''}`;
  const mark = (id) => `<svg class="tk sm inl" aria-hidden="true"><use href="#tk-${id}"/></svg>`;
  const chains = [[1, 'c-eth', 'Ethereum'], [8453, 'c-base', 'Base'], [4663, 'c-rh', 'Robinhood Chain']].map(([, id, name]) => `<svg class="tk xs inl" role="img" aria-label="${name}"><title>${name}</title><use href="#${id}"/></svg>`).join('');
  const ways = [
    ['holding', 'Hold ETH in the private pools', '/#points', (r) => `${n(r)} points per ETH a day, proven on your device`, mark('eth')],
    ['wrap', 'Wrap ETH into the Tacit pool', '/#private', (r) => `${n(r)} points per ETH`, mark('eth')],
    ['evmpooldeposit', 'Deposit ETH in a device pool', '/#device', (r) => `${n(r)} points per ETH`, mark('eth'), ` ${chains}`],
    ['zswapeth', 'Buy TAC with ETH (Precision pool)', '/?from=ETH&to=TAC', (r) => `${n(r)} points per ETH`, mark('eth')],
    ['cbtcmint', 'Post a bond toward cBTC', '/vault/#btc', (r) => `${n(r)} points per wstETH${P.rates.cbtchold ? `, then ${n(P.rates.cbtchold)} a day while it stays posted` : ''}`, mark('cbtc')],
    ['cusdmint', 'Borrow cUSD', '/vault/#btc', (r) => `${n(r)} points per dollar, when you send the loan yourself`, mark('cusd')],
  ].filter(([k]) => P.rates[k] && wts[k] !== 0);
  const WORDS = { holding: 'holding ETH in the private pools', cbtchold: 'keeping bonds posted', zswapeth: 'buying TAC', cusdmint: 'borrowing', cbtcmint: 'posting bonds', weiname: '.wei names', pmbet: 'bets', pmcreate: 'markets', wrap: 'wrapping ETH', evmpooldeposit: 'pool deposits', btcpool: 'the Bitcoin pool' };
  const orList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);
  const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const upcoming = (P.budgets || []).filter((e) => e.fromDay > day).sort((a, b) => a.fromDay - b.fromDay)[0], live = inForce(P.budgets, day);
  const entry = live?.groups?.length ? live : upcoming?.groups?.length ? upcoming : null;
  const perPoint = (w) => `${(Number(BigInt(w) / 10n ** 12n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 4 })} TAC a point`;
  const reserved = [live, upcoming].filter((e) => e?.groups?.length).map((entry) => `<p class="st mute">${entry.fromDay > day ? `From ${dayName(entry.fromDay)}, part` : 'Part'} of each day’s ${pot} TAC is set aside: ${entry.groups.map((g) => `${Math.round(g.share * 100)}%${g.capped ? ' at most' : ''} for ${andList(g.activities.map((a) => WORDS[a] || a))}${g.maxWeiPerPoint ? ` (up to ${perPoint(g.maxWeiPerPoint)}${g.topWeiPerPoint && BigInt(g.topWeiPerPoint) > BigInt(g.maxWeiPerPoint) ? `, and ${perPoint(g.topWeiPerPoint).replace(' TAC a point', '')} when the day has TAC left over` : ''})` : ''}`).join(' and ')}. ${entry.groups.some((g) => g.capped) ? 'A share that is not used is not paid out.' : 'A share that is not used goes back to everyone else.'}</p>`).join('');
  const tiers = P.holder?.tiers || [];
  el.innerHTML = `<ul class="rows ways">${ways.map(([k, label, to, f, lead, tail = '']) => `<li><a href="${to}">${lead}${esc(label)}${tail}</a><span class="m">${f(P.rates[k] * (wts[k] ?? 1))}${esc(note(k))}</span></li>`).join('')}</ul>`
    + reserved
    + (tiers.length ? `<p class="st mute">Holding ${orList(tiers.map((t) => n(t.tac)))} public TAC at the same address for a day multiplies that day’s points by ${orList(tiers.map((t) => `${t.multiplier}×`))}. ` : '<p class="st mute">')
    + `Early activity counts up to ${P.earlyBonus?.max ?? 1}×. Each day’s pot is split by points.</p>`;
  el.dataset.done = '1';
}
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.open) return;
  if (d.id === 'lb') paintBoard(); else if (d.id === 'earn') paintEarn(); else if (d.dataset.days) paintDays(d);
}, true);

let wmsgTimer = 0;
function wsay(html, bad = false) {
  const el = $('#wmsg'); if (!el) return;
  clearTimeout(wmsgTimer);
  el.className = `wmsg${bad ? ' bad' : ''}`; el.innerHTML = html;
  if (html) wmsgTimer = setTimeout(() => { el.innerHTML = ''; }, 9000);
}
function paintWallet() {
  const el = $('#wl'); if (!el) return;
  const mine = W.account ? W.account.toLowerCase() : null, asked = out.dataset.address;
  el.innerHTML = !mine || !asked ? '' : mine === asked ? '<span class="ok">Your wallet is on this account</span>'
    : `Your wallet is on ${short(mine)}.<button type="button" data-mine>Look up mine</button><button type="button" data-switch>Switch account</button>`;
  if (asked) paintFarmRow(asked);
}
function lookMine() {
  if (!W.account) return;
  const a = W.account.toLowerCase();
  input.value = a; showHints(''); run(a);
}
let seenAccount = null;
function onWallet() {
  const acct = W.account ? W.account.toLowerCase() : null, fresh = !!acct && acct !== seenAccount;
  seenAccount = acct;
  paintWallet(); showFarm(); showRecent(); farmUi?.then((f) => f.refresh()).catch(() => {});
  if (fresh && farm.open) openFarm();
  if (fresh) { if (!input.value.trim() && !out.innerHTML) lookMine(); else react('wink', 1600); }
}
async function switchAccount() {
  const prov = W.prov;
  if (!prov) { connect.connect(); return; }
  if (prov.isWalletConnect) { wsay('Switch accounts in your wallet app, then press Claim.'); return; }
  try { await prov.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
  catch (e) { if (e?.code !== 4001) wsay('Switch accounts in your wallet, then press Claim.'); }
}

const input = $('#q'), go = $('#go'), out = $('#out'), hints = $('#hints'), recent = $('#recent'), note = $('#note');
// a phone's bar is too narrow for the whole placeholder; the chips and the label still say which names work
const fullHint = input.placeholder, phone = matchMedia('(max-width: 480px)');
const hint = () => { input.placeholder = phone.matches ? '0x address or name.eth' : fullHint; };
hint(); phone.addEventListener('change', hint);
const said = (t) => { note.textContent = ''; setTimeout(() => { note.textContent = t; }, 30); };
const recents = () => { try { const l = JSON.parse(store.get(RECENT) || '[]'); return Array.isArray(l) ? l.filter((x) => typeof x === 'string').slice(0, 6) : []; } catch { return []; } };
const remember = (q) => store.set(RECENT, JSON.stringify([q, ...recents().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6)));
function showRecent() {
  const l = recents(), empty = !out.innerHTML && !input.value.trim(), own = empty && !W.account ? '<button type="button" class="chip own" data-own>Connect wallet</button>' : '';
  recent.innerHTML = empty && (l.length || own) ? `${own}${l.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q.length > 22 ? short(q) : q)}</button>`).join('')}${l.length ? '<button type="button" class="chip x" data-clear aria-label="Clear recent lookups">×</button>' : ''}` : '';
  recent.dataset.ready = '1';
}
function showHints(v) {
  hints.innerHTML = /^[a-z0-9][a-z0-9-]{1,62}$/i.test(v) && !/^0x/i.test(v) ? ['eth', 'wei', 'gwei'].map((t) => `<button type="button" class="chip" data-q="${esc(`${v.toLowerCase()}.${t}`)}">${esc(v.toLowerCase())}.${t}</button>`).join('') : '';
}

let seq = 0, ctl = null, last = '';
const unreserve = () => { delete document.documentElement.dataset.lookup; };
function clear() {
  unreserve(); seq++; ctl?.abort(); last = ''; out.innerHTML = ''; delete out.dataset.address; hints.innerHTML = ''; go.disabled = false;
  input.setAttribute('aria-invalid', 'false');
  react('idle');
  try { history.replaceState(null, '', location.pathname); } catch { }
  showRecent();
}
async function run(raw) {
  const q = raw.trim(), my = ++seq;
  ctl?.abort(); ctl = new AbortController();
  input.setAttribute('aria-invalid', 'false');
  if (!q) { clear(); return; }
  last = q; hints.innerHTML = ''; recent.innerHTML = ''; go.disabled = true; out.innerHTML = SKELETON; delete out.dataset.address;
  react('think');
  try {
    const who = await identify(q);
    if (my !== seq) return;
    remember(q);
    out.dataset.address = who.address;
    out.innerHTML = `${whoLine(who, q)}${YOURS}<div id="c-bw"></div>`;
    got = { address: who.address, air: 0n, pts: 0n };
    tot = { address: who.address, air: null, pts: null, farm: null, bad: false }; stakeOf = null;
    paintWallet();
    try { history.replaceState(null, '', `?q=${encodeURIComponent(q)}`); } catch { }
    const a = readAirdrop(who.address), p = readPoints(who.address, ctl.signal);
    const can = { air: null, pts: null };
    let given = false;
    const answer = () => {
      if (my !== seq || given) return;
      if (can.air === true || can.pts === true) { given = true; react('up'); said('Something to claim'); }
      else if (can.air === false && can.pts === false) { given = true; react('down'); said('Nothing to claim'); }
      else if (can.air !== null && can.pts !== null) { given = true; react('idle'); }
    };
    a.then((s) => { if (my !== seq) return; paint('#c-air', airdropRow(s, who.address)); can.air = s.reason === 'error' ? undefined : !!s.claimable; answer(); claimedNow(who.address, a0(s), null); tot.air = s.claimable ? BigInt(s.amountWei) : 0n; if (s.reason === 'error') tot.bad = true; paintTotal(); });
    p.then((v) => { if (my !== seq) return; paint('#c-pts', pointsRow(v, who.address)); fillRank(who.address, v); can.pts = v.error ? undefined : v.owed > 0n; answer(); claimedNow(who.address, null, p0(v)); tot.pts = v.error ? 0n : v.owed; if (v.error) tot.bad = true; paintTotal(); });
    const fm = readFarmFor(who.address);
    fm.then((r) => { if (my === seq) showStake(who.address, r); });
    await Promise.allSettled([a, p, fm]);
  } catch (e) {
    if (my !== seq) return;
    react('shake'); unreserve();
    input.setAttribute('aria-invalid', 'true');
    out.innerHTML = `<p class="err" role="alert">${esc(e.message || 'Something went wrong. Try again.')}</p>`;
  } finally { if (my === seq) go.disabled = false; }
}

let pause = 0, was = 0;
input.addEventListener('input', () => {
  clearTimeout(pause);
  const v = input.value.trim(), jumped = Math.abs(v.length - was) > 1;
  was = v.length;
  showHints(v); showRecent();
  if (!v) { clear(); return; }
  if (v === last) return;
  if (/^0x[0-9a-fA-F]{40}$/.test(v) || (jumped && /^\S+\.(eth|wei|gwei)$/i.test(v))) run(v);
  else if (/^\S+\.(eth|wei|gwei)$/i.test(v)) pause = setTimeout(() => { if (input.value.trim() === v && v !== last) run(v); }, 450);
});
input.addEventListener('focus', prime);
input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; clear(); } });
document.addEventListener('keydown', (e) => { if (e.key === '/' && !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); input.focus(); input.select(); } });
$('#f').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(pause); run(input.value); });
document.addEventListener('submit', (e) => { if (e.target.id === 'to-f') e.preventDefault(); });

document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-q]'), cp = e.target.closest('[data-copy]'), cl = e.target.closest('[data-claim]');
  if (chip) { input.value = chip.dataset.q; run(chip.dataset.q); return; }
  if (e.target.closest('[data-own]')) { connect.connect(); return; }
  if (e.target.closest('[data-open-farm]')) { openTheFarm(); return; }
  if (e.target.closest('[data-clear]')) { store.set(RECENT, '[]'); showRecent(); return; }
  if (cl) { const toward = cl.dataset.claim === 'airdrop-to'; claim(toward ? 'airdrop' : cl.dataset.claim, cl.dataset.addr, cl, toward ? $('#to-q').value.trim() || ' ' : ''); return; }
  if (e.target.closest('[data-to-show]')) { const f = $('#to-f'); f.hidden = false; e.target.closest('.to').hidden = true; $('#to-q').focus(); return; }
  if (e.target.closest('[data-watch]')) { wallet.watchAsset({ address: TAC, symbol: 'TAC', decimals: 18 }).catch(() => {}); return; }
  if (e.target.closest('[data-mine]')) { lookMine(); return; }
  if (e.target.closest('[data-switch]')) { switchAccount(); return; }
  if (cp) {
    const text = cp.dataset.copy, label = cp.textContent;
    try { await navigator.clipboard.writeText(text); } catch {
      const t = Object.assign(document.createElement('textarea'), { value: text }); document.body.append(t); t.select();
      try { document.execCommand('copy'); } catch { } t.remove();
    }
    cp.textContent = 'Copied'; said(cp.dataset.said || 'Address copied'); setTimeout(() => { cp.textContent = label; }, 1400);
  }
});

const asked = new URLSearchParams(location.search).get('q');
if (asked) { input.value = asked; run(asked); } else { showRecent(); if (matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true }); }
(window.requestIdleCallback || ((f) => setTimeout(f, 300)))(() => { prime(); board(); connect.restore().then(() => { if (!W.account && !out.innerHTML) unreserve(); }); });
readEarn();
