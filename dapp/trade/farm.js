import { day, group } from '/trade/fmt.js?cb=32b1744b';
import { shieldedApr, readSpot } from '/trade/farm-read.js?cb=112a01b9';

const POOL = '0x0155358241411dB868BA714aE7c83A27087e3D6E', FARM = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0', LENS = '0x000000956bf20A41C54BaE4a4b6F5C8A166DAB4E';
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11', ZERO = '0x0000000000000000000000000000000000000000';
const SEL = {
  reserve0: '0x443cb4bc', reserve1: '0x5a76f25e', totalSupply: '0x18160ddd', sqrtPrice: '0x2af1f249', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', timestamp: '0x0f28c97d',
  totalStaked: '0x817b1cd2', rewardRate: '0x7b0a47ee', periodFinish: '0xebe2b12b', staked: '0x98807d84', earned: '0x008cc262',
  previewZap: '0xe7cddab0', previewAdd: '0xe03ec807', zapETH: '0x8703a0d8', zapToken: '0x9376f34e', zapTokenWithPermit: '0x51291e77', addAndStake: '0x6d15c09b', addAndStakeWithPermit: '0xddd9f3fb',
  claim: '0x4e71d92d', stake: '0xa694fc3a', stakeWithPermit: '0xecd9ba82', exitAndRemove: '0xbccbe38a', withdrawAndRemove: '0xbd8196a9', exitTo: '0x6ae36ea7', withdrawTo: '0x47d1eebd', nonces: '0x7ecebe00', approve: '0x095ea7b3',
};
const REWARD_PAID = '0xe2403640ba68fed3a2f88b7557551d1993f84b99bb10ff833f0cf8db0c5e0486';
// The most any one action takes (a fork measured a deposit with its permit and swap at 160,000-240,000 gas), which Max keeps twice over for the network fee; and the gas
// price taken when it could not be read.
const FARM_GAS = 300000n, GAS_FALLBACK = 3n * 10n ** 9n;
// Each action's gas for the fee line, a little over what the fork measured: a deposit of ETH 236,000, of TAC 233,000 (permit included), of both 159,000, a claim 70,000,
// staking shares 136,000, a withdrawal 130,000-200,000.
const GAS = { eth: 250000, tac: 250000, pair: 175000, claim: 75000, stake: 150000, out: 220000 };
const strip = (h) => String(h).replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => strip(a).toLowerCase().padStart(64, '0');
const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
const now = () => Math.floor(Date.now() / 1000);

export function mountFarm(host, ctx) {
  const { ethCall, batch, api, wallet, W, connect, fmtUnits: fmt, parseUnits, esc, usd, ethUsd, txLink, onDone, refarm = false, gasPrice = () => null } = ctx;
  const F = { wdOpen: false, rseq: 0, ackKey: null, x: null, prog: null, mode: 'eth', outPct: '100', outAs: 'both', q: null, seq: 0, w: null, wseq: 0, busy: false, tick: 0, err: false };
  const $ = (s) => host.querySelector(s);
  const plain = (v) => { const n = BigInt(v), b = 10n ** 18n, f = (n % b).toString().padStart(18, '0').replace(/0+$/, ''); return `${n / b}${f ? `.${f}` : ''}`; };
  const amt = (v, dp) => { let d = dp; const n = BigInt(v); while (n > 0n && d < 12 && fmt(n, 18, d).replace(/[^1-9]/g, '').length < 2) d++; return fmt(n, 18, d); };
  const share = (num, den) => { if (!den || !num) return '0%'; const bp = Number(num * 1000000n / den) / 10000; return bp > 0 && bp < 0.01 ? 'under 0.01%' : `${bp.toFixed(2)}%`; };
  const cut = (v, dp) => { const u = 10n ** BigInt(18 - dp); return (v / u) * u; };
  const dayFmt = day;
  const usdOfEth = (wei) => (ethUsd() ? usd((Number(wei) / 1e18) * ethUsd()) : '');
  const tacUsd = (tac, x = F.x) => (x?.tacEth ? usdOfEth(Number(tac) * x.tacEth) : '');
  const aprTxt = (a) => (a == null ? '—' : a >= 100000 ? 'over 100,000%' : `${group(Math.round(a))}%`);
  const say = (el, h) => { if (el) { el.innerHTML = h; delete el.dataset.keep; } };
  const unsay = () => { if (!status.dataset.keep) say(status, ''); };           // what was said of a finished deposit goes when a new one is begun; a warning that one is unconfirmed does not
  const errMsg = (e) => esc(e?.userStopped ? e.message : String(e?.message || e).slice(0, 220));
  // What an action costs the network at the gas price now, as the ticket says it: in dollars, or in ETH where there is no dollar price.
  const feeTxt = (gas, x = F.x) => {
    if (x?.gp == null) return '';
    const eth = Number(BigInt(gas) * x.gp) / 1e18, fee = ethUsd() ? eth * ethUsd() : null;
    return fee == null ? `≈ ${eth.toPrecision(2)} ETH` : fee < 0.01 ? 'under $0.01' : `≈ $${fee.toFixed(2)}`;
  };
  const feeRow = (gas, x = F.x) => (feeTxt(gas, x) ? `<div class="kv"><span>Network fee</span><b title="About ${group(gas)} gas at ${(Number(x.gp) / 1e9).toPrecision(2)} gwei, the gas price now">${feeTxt(gas, x)}</b></div>` : '');

  host.innerHTML = `
    <h2 class="eyebrow" id="fm-h"><span class="pairtk"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg></span>Earn · Precision pool farm</h2>
    <div class="fm-stats" id="fm-stats"><p class="note">Reading the farm…</p></div>
    <div class="fm-pos" id="fm-pos" hidden></div>
    <div class="status" id="fm-pos-status" role="status"></div>
    <div class="fm-add">
      <h3 id="fm-add-h">Farm TAC/ETH</h3>
        <div class="seg big" id="fm-mode" role="group" aria-label="Deposit with">
          <button type="button" data-fm="eth" aria-pressed="true">ETH</button><button type="button" data-fm="tac" aria-pressed="false">TAC</button><button type="button" data-fm="pair" aria-pressed="false">ETH + TAC</button>
        </div>
        <p class="note fm-how" id="fm-how"></p>
        <div id="fm-eth"><div class="lbl"><span>ETH</span><button class="linkbtn" type="button" id="fm-emax" hidden></button></div>
          <div class="amt"><input id="fm-amt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="ETH to deposit"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-eth"/></svg>ETH</span></div></div>
        <div id="fm-tac" hidden><div class="lbl"><span>TAC</span><button class="linkbtn" type="button" id="fm-tmax" hidden></button></div>
          <div class="amt"><input id="fm-tacamt" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="TAC to deposit"><span class="u"><svg class="tk sm" aria-hidden="true"><use href="#tk-tac"/></svg>TAC</span></div></div>
        <div class="fm-rcpt" id="fm-rcpt" hidden></div>
        <button class="btn" type="button" id="fm-go">Connect wallet</button>
        <div class="status" id="fm-status" role="status"></div>
    </div>
    <div class="fm-prog" id="fm-prog"></div>`;
  const ethIn = $('#fm-amt'), tacIn = $('#fm-tacamt'), go = $('#fm-go'), rc = $('#fm-rcpt'), status = $('#fm-status');

  async function read() {
    const who = W.account, my = ++F.rseq;
    const calls = [
      { to: POOL, data: SEL.reserve0 }, { to: POOL, data: SEL.reserve1 }, { to: POOL, data: SEL.totalSupply }, { to: POOL, data: SEL.sqrtPrice },
      { to: FARM, data: SEL.totalStaked }, { to: FARM, data: SEL.rewardRate }, { to: FARM, data: SEL.periodFinish }, { to: MC3, data: SEL.timestamp },
    ];
    if (who) calls.push({ to: FARM, data: SEL.staked + addr(who) }, { to: FARM, data: SEL.earned + addr(who) }, { to: TAC, data: SEL.balanceOf + addr(who) },
      { to: TAC, data: SEL.allowance + addr(who) + addr(FARM) }, { to: POOL, data: SEL.balanceOf + addr(who) }, { to: POOL, data: SEL.allowance + addr(who) + addr(FARM) });
    const [r, bal, gp] = await Promise.all([batch(calls), who ? ctx.rpc('eth_getBalance', [who, 'latest']).then(BigInt, () => null) : null, who ? ctx.rpc('eth_gasPrice', []).then(BigInt, () => null) : null]);
    if (!r[0] || !r[2] || !r[4]) throw new Error('the farm did not answer');
    const w = (i) => (r[i] ? wordAt(r[i], 0) : 0n);
    const x = { who, r0: w(0), r1: w(1), supply: w(2), sp: w(3), totalStaked: w(4), rate: w(5), finish: Number(w(6)), t: Number(w(7)) || now(), staked: w(8), earned: w(9), tac: w(10), allowance: w(11), lp: w(12), lpAllow: w(13), bal, gp: gp ?? gasPrice(), at: now() };
    const s = Number(x.sp) / 1e18;
    x.live = x.t < x.finish;
    x.perDay = x.live ? x.rate * 86400n : 0n;
    x.tacEth = s > 0 ? 1 / (s * s) : 0;
    x.value = Number(x.r0) + Number(x.r1) * x.tacEth;
    x.stakedEth = x.supply ? x.value * Number(x.totalStaked) / Number(x.supply) : 0;
    x.apr = x.live && x.stakedEth > 0 ? Number(x.perDay) * 365 * x.tacEth / x.stakedEth * 100 : null;
    x.mine = x.supply ? { eth: x.staked * x.r0 / x.supply, tac: x.staked * x.r1 / x.supply } : { eth: 0n, tac: 0n };
    if (my !== F.rseq || W.account !== who) return;
    F.x = x; F.err = false;
  }
  const readProgram = () => Promise.all([api('/farm/program?network=mainnet'), readSpot(batch)]).then(([p, px]) => { if (p?.epoch) F.prog = p; F.px = px; });

  const earnedNow = (x) => (!x?.live || !(x.staked > 0n) || !x.totalStaked ? x?.earned ?? 0n
    : x.earned + x.rate * x.staked / x.totalStaked * BigInt(Math.max(0, Math.min(now() + (x.t - x.at), x.finish) - x.t)));

  function renderStats() {
    const x = F.x, el = $('#fm-stats');
    if (!x) { el.innerHTML = `<p class="note">${F.err ? 'Could not read the farm. Try again in a moment.' : 'Reading the farm…'}</p>`; return; }
    const cell = (k, v, s = '') => `<div><span class="k">${k}</span><b class="num">${v}</b>${s ? `<span class="s">${s}</span>` : ''}</div>`;
    el.innerHTML = cell('APR now', aprTxt(x.apr), 'paid in TAC, swap fees on top')
      + cell('Rewards', x.live ? `<svg class="tk xs inl" aria-hidden="true"><use href="#tk-tac"/></svg>${group(Math.round(Number(x.perDay) / 1e18))} TAC a day` : 'between periods', x.live ? tacUsd(x.perDay) ? `about ${tacUsd(x.perDay)} a day` : '' : '')
      + cell('Staked', ethUsd() ? usd(x.stakedEth / 1e18 * ethUsd()) : `${(x.stakedEth / 1e18).toFixed(2)} ETH`, x.supply ? `${Math.round(Number(x.totalStaked * 1000n / x.supply)) / 10}% of the pool` : '')
      + cell('Stream ends', x.live ? dayFmt(x.finish) : '—');
    const p = F.prog, e = p?.epoch;
    const pairName = (pair) => { const k = String(pair).split('/').map((y) => (y === 'cETH' ? 'tETH' : y)); if (k[1] === 'tETH') k.reverse(); return k.join(' / '); };
    const aprOf = (pool) => (x.tacEth ? shieldedApr(pool, x.tacEth, { ethUsd: F.px?.ethUsd ?? ethUsd(), btcUsd: F.px?.btcUsd }) : null);
    $('#fm-prog').innerHTML = e?.active && p.pools?.length
      ? `<div class="fm-ph" title="Private positions: who farms and how much is not shown. Each opens with your Tacit wallet on the main page."><b>Private farms</b><span>${group(Math.round(Number(e.ratePerDayTac)))} TAC a day more, to ${dayFmt(e.periodFinish)}</span></div>`
        + p.pools.filter((pool) => Number(pool.tacPerDayForPool) > 0).map((pool) => `<a class="fm-pf" href="/#farm/private-${Number(pool.pid)}"><span class="pair">${esc(pairName(pool.pair))}</span><span class="d">${group(Math.round(Number(pool.tacPerDayForPool)))} TAC a day</span><b class="num">${aprTxt(aprOf(pool))}</b><i aria-hidden="true">→</i></a>`).join('')

      : '';
  }

  // The block is drawn again only when something it shows has changed (the earned figure ticks by itself), so the minute's read does not flicker it, close a
  // choice being read or lose a box ticked in it.
  let posKey = '';
  function renderPos() {
    const x = F.x, el = $('#fm-pos');
    if (!x || !W.account || x.who !== W.account || !(x.staked > 0n || x.lp > 0n)) { clearInterval(F.tick); posKey = ''; el.hidden = true; el.innerHTML = ''; $('#fm-add-h').textContent = 'Farm TAC/ETH'; return; }
    const day = x.totalStaked ? x.perDay * x.staked / x.totalStaked : 0n, has = x.staked > 0n;
    const key = [x.who, x.staked, x.lp, x.totalStaked, x.supply, x.perDay, x.live, x.r0, x.r1, F.wdOpen, F.outPct, F.outAs, ethUsd()].join('|');
    if (key === posKey && !el.hidden) { if (has && F.wdOpen) previewOut(); return; }
    posKey = key; clearInterval(F.tick);
    el.hidden = false; $('#fm-add-h').textContent = 'Add more';
    const worth = Number(x.mine.eth) + Number(x.mine.tac) * x.tacEth, worthUsd = ethUsd() ? usd(worth / 1e18 * ethUsd()) : '';
    el.innerHTML = (has ? `<h3>Your stake</h3>
      <div class="kv"><span>In the farm</span><b>${amt(x.mine.eth, 4)} ETH + ${amt(x.mine.tac, 0)} TAC</b></div>
      <div class="kv"><span>Worth</span><b>${worthUsd ? `about ${worthUsd} · ` : ''}${share(x.staked, x.totalStaked)} of the farm</b></div>
      <div class="kv"><span>Earning</span><b>${amt(day, 2)} TAC a day${tacUsd(day) ? ` · ${tacUsd(day)}` : ''}</b></div>
      <div class="kv earned"><span>Earned</span><span class="rt"><b class="num" id="fm-earned">${fmt(earnedNow(x), 18, 4)} TAC</b><button class="btn sm" type="button" id="fm-claim"${earnedNow(x) > 0n ? '' : ' disabled'}${feeTxt(GAS.claim, x) ? ` title="Network fee ${feeTxt(GAS.claim, x)}"` : ''}>Claim</button></span></div>
      <details class="wd" id="fm-wd"${F.wdOpen ? ' open' : ''}><summary>Withdraw</summary>
      <div class="fm-out"><div class="seg" id="fm-pct" role="group" aria-label="How much">${[['25', '25%'], ['50', '50%'], ['100', 'All']].map(([v, l]) => `<button type="button" data-pct="${v}" aria-pressed="${F.outPct === v}">${l}</button>`).join('')}</div>
      <div class="seg" id="fm-as" role="group" aria-label="Withdraw as">${[['both', 'ETH + TAC'], ['eth', 'ETH'], ['tac', 'TAC']].map(([v, l]) => `<button type="button" data-as="${v}" aria-pressed="${F.outAs === v}">${l}</button>`).join('')}</div></div>
      <div class="fm-rcpt" id="fm-out-rcpt" hidden></div>
      <button class="btn ghost" type="button" id="fm-exit" disabled>Withdraw</button></details>` : '')
      + (x.lp > 0n ? `<div class="kv"><span>LP shares not staked</span><b>${fmt(x.lp, 18, 6)}</b></div>${feeRow(GAS.stake, x)}<button class="btn ghost" type="button" id="fm-stake">Stake them</button>` : '');
    if (has && x.live) F.tick = setInterval(() => {
      const e = $('#fm-earned'), c = $('#fm-claim'), cur = F.x;                      // the latest read, so a block that is not drawn again keeps its figure true
      if (!e || !cur || cur.who !== W.account) return clearInterval(F.tick);
      const v = earnedNow(cur);
      e.textContent = `${fmt(v, 18, 4)} TAC`;
      if (c && c.getAttribute('aria-busy') !== 'true') c.disabled = v === 0n;
    }, 1000);
    const wd = $('#fm-wd');
    if (wd) wd.addEventListener('toggle', () => { F.wdOpen = wd.open; if (wd.open) previewOut(); });
    if (has && F.wdOpen) previewOut();
  }

  function renderForm() {
    const x = F.x, m = F.mode;
    $('#fm-mode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.fm === m)));
    $('#fm-eth').hidden = m === 'tac'; $('#fm-tac').hidden = m === 'eth';
    const em = $('#fm-emax'), tm = $('#fm-tmax'), mine = x && W.account && x.who === W.account;
    $('#fm-how').innerHTML = m === 'pair' ? (mine && x.tac === 0n ? 'You hold no TAC in this wallet, and ETH + TAC takes both. <button class="linkbtn" type="button" data-fm="eth">Farm with ETH alone</button>.' : 'Both go in at the pool’s ratio, then are staked.')
      : `Half is swapped to ${m === 'eth' ? 'TAC' : 'ETH'} inside the pool, then both are staked: one transaction.`;
    em.hidden = !(mine && x.bal != null); tm.hidden = !mine;
    if (mine && x.bal != null) em.textContent = `Balance ${fmt(x.bal, 18, 4)} · Max`;
    if (mine) tm.textContent = `Balance ${fmt(x.tac, 18, 2)} · Max`;
    gate();
  }
  // What is typed, as the form for the mode in use reads it: the ETH in wei and the TAC (0 for a side the mode has no field for, or one that cannot be read).
  const amounts = () => [F.mode !== 'tac' ? parseUnits(ethIn.value) || 0n : 0n, F.mode !== 'eth' ? parseUnits(tacIn.value) || 0n : 0n];
  function gate() {
    const q = F.q, x = F.x;
    if (F.busy) return;
    go.disabled = false;
    if (!W.account) { go.textContent = 'Connect wallet'; return; }
    go.textContent = { eth: 'Farm with ETH', tac: 'Farm with TAC', pair: 'Farm with ETH + TAC' }[F.mode];
    const mine = !!x && mineX(x) && x.bal != null, [wei, tac] = amounts();
    if (mine && x.bal < feeMin(x)) { go.textContent = 'Add ETH for the network fee'; go.disabled = true; return; }
    if (!wei && !tac) { go.textContent = 'Enter an amount'; go.disabled = true; return; }
    if (q?.over) { go.textContent = `Not enough ${q.over}`; go.disabled = true; return; }
    if (mine && wei > 0n && wei + feeMin(x) > x.bal) { go.textContent = 'Leave ETH for the network fee'; go.disabled = true; return; }
    go.disabled = !q || !x || !accepted('fm-ack', q.loss);
  }
  const ackBox = (id, loss, what, prior) => {
    const n = Math.round(loss);
    return loss >= 30 ? `<label class="ack"><span>Type <b>${n}</b> to accept losing about ${n}% of this ${what} to the swap.</span><input id="${id}" inputmode="numeric" autocomplete="off" aria-label="Type ${n} to accept" value="${prior ? n : ''}"></label>`
      : `<label class="ack"><input type="checkbox" id="${id}"${prior ? ' checked' : ''}><span>I accept losing about ${n}% of this ${what} to the swap.</span></label>`;
  };
  const accepted = (id, loss) => {
    if (!(loss >= 15)) return true;
    const el = $(`#${id}`);
    return !!el && (el.type === 'checkbox' ? el.checked : el.value.trim() === String(Math.round(loss)));
  };
  const up = (v, dp) => { const u = 10n ** BigInt(18 - dp); return ((v + u - 1n) / u) * u; };
  const mineX = (x) => !!W.account && x?.who === W.account;
  // ETH a deposit leaves for its own fee: twice its gas at the gas price now (Max keeps it), and the fee alone, half again, is the least that lets one go
  const reserve = (x) => 2n * FARM_GAS * (x?.gp ?? GAS_FALLBACK), feeMin = (x) => (3n * FARM_GAS * (x?.gp ?? GAS_FALLBACK)) / 2n;
  const spendEth = (x) => (x.bal != null && x.bal > reserve(x) ? x.bal - reserve(x) : 0n);
  // A side held back by the wallet's balance is cut to the figures a field shows (2 decimals of TAC, 6 of ETH), not written out to the last digit.
  const capTac = (v, x) => (mineX(x) && v > x.tac ? cut(x.tac, 2) : v), capEth = (v, x) => (mineX(x) && x.bal != null && v > spendEth(x) ? cut(spendEth(x), 6) : v);
  const tacFor = (wei, x) => (x.r0 > 0n ? (wei * x.r1 + x.r0 - 1n) / x.r0 : 0n);
  const ethFor = (tac, x) => (x.r1 > 0n ? (tac * x.r0 + x.r1 - 1n) / x.r1 : 0n);
  // The pool's own view of a deposit: the shares it would mint and, for a pair, the sides it would take (the farm gives the rest back at once).
  async function previewLp(m, wei, tac) {
    if (m === 'pair') {
      const r = await ethCall(LENS, SEL.previewAdd + addr(POOL) + word(wei) + word(tac));
      if (wordAt(r, 0) !== 1n || wordAt(r, 1) === 0n) throw new Error('The pool would refuse this deposit.');
      return { lp: wordAt(r, 1), used: { eth: wordAt(r, 2), tac: wordAt(r, 3) } };            // the pool takes both sides at its ratio and the farm returns the rest at once
    }
    const r = await ethCall(LENS, SEL.previewZap + addr(POOL) + addr(m === 'eth' ? ZERO : TAC) + word(m === 'eth' ? wei : tac));
    if (wordAt(r, 0) !== 1n || wordAt(r, 2) === 0n) throw new Error('The pool would refuse this deposit.');
    return { lp: wordAt(r, 2), used: null };
  }
  async function requote(src = null) {
    const my = ++F.seq, x = F.x, m = F.mode;
    if (m === 'pair' && x && src === ethIn) { const v = parseUnits(ethIn.value); tacIn.value = !ethIn.value ? '' : v != null ? plain(capTac(up(tacFor(v, x), 2), x)) : tacIn.value; }
    if (m === 'pair' && x && src === tacIn) { const v = parseUnits(tacIn.value); ethIn.value = !tacIn.value ? '' : v != null ? plain(capEth(up(ethFor(v, x), 6), x)) : ethIn.value; }
    const [wei, tac] = amounts();
    F.q = null; gate();
    const unread = [[ethIn, m !== 'tac'], [tacIn, m !== 'eth']].filter(([i, shown]) => { const off = shown && !!i.value.trim() && parseUnits(i.value) == null; i.toggleAttribute('aria-invalid', off); return off; });
    if (unread.length) { rc.hidden = false; rc.innerHTML = '<p class="note err">Could not read that amount. Write 1500 or 0.05.</p>'; return; }
    if (!x || (!wei && !tac)) { rc.hidden = true; rc.innerHTML = ''; return; }
    // More than the wallet holds is said at once, with none of the figures for a deposit that cannot be made.
    const short = mineX(x) ? (x.bal != null && wei > x.bal ? 'ETH' : tac > x.tac ? 'TAC' : '') : '';
    if (short) { F.q = { m, wei, tac, lp: 0n, loss: 0, over: short }; rc.hidden = false; rc.innerHTML = `<p class="note err">Not enough ${short} in this wallet.</p>`; gate(); return; }
    try {
      const { lp, used } = await previewLp(m, wei, tac);
      let loss = 0;
      if (m !== 'pair') {
        const ideal = Number(x.supply) * (m === 'eth' ? Number(wei) : Number(tac) * x.tacEth) / x.value;
        loss = ideal > 0 ? Math.max(0, (1 - Number(lp) / ideal) * 100) : 0;
      }
      if (my !== F.seq) return;
      const day = x.perDay * lp / (x.totalStaked + lp);
      const inEth = Number(wei) + Number(tac) * x.tacEth, apr = x.live && inEth > 0 ? Number(day) * 365 * x.tacEth / inEth * 100 : null;
      const ackKey = `${m}|${wei}|${tac}|${Math.round(loss)}`;
      F.q = { m, wei, tac, lp, loss, over: '' };
      rc.hidden = false;
      const back = used ? [wei - used.eth > wei / 200n ? `${fmt(wei - used.eth, 18, 5)} ETH` : '', tac - used.tac > tac / 200n ? `${fmt(tac - used.tac, 18, 2)} TAC` : ''].filter(Boolean).join(' and ') : '';
      rc.innerHTML = `${m === 'pair' ? `<div class="kv"><span>Deposit</span><b>${fmt(used.eth, 18, 5)} ETH + ${fmt(used.tac, 18, 2)} TAC</b></div>${back ? `<p class="note">The pool takes both at its ratio: ${back} comes straight back to your wallet.</p>` : ''}` : ''}
        <div class="kv"><span>Earns about</span><b>${amt(day, 2)} TAC a day${tacUsd(day) ? ` · ${tacUsd(day)}` : ''}</b></div>
        <div class="kv"><span>APR</span><b>${aprTxt(apr)}</b></div>
        ${loss >= 0.5 ? `<div class="kv"><span>Swap price impact</span><b class="${loss >= 5 ? 'err' : ''}">${loss.toFixed(loss < 10 ? 1 : 0)}%</b></div>` : ''}
        ${feeRow(GAS[m])}
        <p class="note">${share(lp, x.totalStaked + lp)} of the farm. ${x.live ? `At today’s price and stake; the APR falls as more joins. Streams to ${dayFmt(x.finish)}.` : 'The farm is between reward periods: nothing streams until the next one.'}</p>
        ${loss >= 5 ? `<p class="note">The swap inside the pool costs a lot at this size. A smaller deposit${m !== 'pair' ? ', or ETH + TAC,' : ''} costs less.</p>` : ''}
        ${loss >= 15 ? ackBox('fm-ack', loss, 'deposit', F.ackKey === ackKey) : ''}`;
      for (const ev of ['input', 'change']) $('#fm-ack')?.addEventListener(ev, () => { F.ackKey = accepted('fm-ack', loss) ? ackKey : null; gate(); });
      gate();
    } catch (e) {
      if (my !== F.seq) return;
      rc.hidden = false; rc.innerHTML = `<p class="note err">${errMsg(e)}</p>`;
    }
  }

  async function send(tx, label, at, from) {
    say(at, 'Checking it first…');
    await ethCall(FARM, tx.data, 'latest', { from, value: tx.value ? '0x' + tx.value.toString(16) : undefined }).catch((e) => { throw new Error(e?.revert ? 'This would fail, so nothing was sent. Try a smaller amount or try again.' : 'Could not reach the farm to check this. Nothing was sent.'); });
    say(at, 'Confirm in your wallet…');
    const hash = await wallet.sendTx({ to: FARM, data: tx.data, value: tx.value || 0n, from });
    say(at, `${label}… ${txLink(hash)}`);
    const r = await wallet.receipt(hash).catch((e) => { throw Object.assign(e, { sentHash: hash }); });
    if (r.status !== '0x1') throw new Error(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee.`);
    return { hash, r };
  }
  // A permit for the farm to take `value` of `token`, or - for a wallet that cannot sign one (a smart-contract account, or one without typed-data signing) - an approval sent
  // first, after which the call goes without a signature (returns ''). A "no" from the person is the end of it, and a failed read is not a wallet that cannot sign.
  async function signOrApprove(token, name, value, dl, from, at, what) {
    say(at, `Sign the permit for ${what} in your wallet. The signature costs nothing.`);
    const nonce = wordAt(await ethCall(token, SEL.nonces + addr(from)), 0);
    try {
      const s = await wallet.signPermit({ token, name, spender: FARM, value, deadline: dl, nonce, owner: from });
      return word(s.v) + strip(s.r) + strip(s.s);
    } catch (e) {
      if (e?.userStopped || e?.code === 4001 || /account changed/i.test(e?.message || '')) throw e;
      say(at, `Your wallet cannot sign a permit. Approve ${what} for the farm in your wallet.`);
      const hash = await wallet.sendTx({ to: token, data: SEL.approve + addr(FARM) + word(value), from });
      say(at, `Waiting for the approval… ${txLink(hash)}`);
      if ((await wallet.receipt(hash)).status !== '0x1') throw new Error('The approval did not go through.');
      return '';
    }
  }
  const deadline = () => BigInt((F.x ? F.x.t + (now() - F.x.at) : now()) + 1800);
  const run = async (btn, at, f) => {
    if (F.busy) return;
    F.busy = true; btn.disabled = true; btn.setAttribute('aria-busy', 'true'); lock(true);
    try { await f(); } catch (e) {
      if (e?.sentHash) {
        if (btn === go) { ethIn.value = ''; tacIn.value = ''; F.q = null; rc.hidden = true; }
        say(at, `<span class="err">Sent, not confirmed yet.</span> ${txLink(e.sentHash)} Check it there before sending anything again.`);
        at.dataset.keep = '1';                                // typing a new amount does not take this warning away
      } else say(at, `<span class="err">${errMsg(e)}</span>`);
    }
    finally { F.busy = false; btn.removeAttribute('aria-busy'); lock(false); posKey = ''; await refresh(); }
  };
  const lock = (b) => { [ethIn, tacIn].forEach((i) => { i.disabled = b; }); host.querySelectorAll('#fm-mode button, #fm-pct button, #fm-as button').forEach((x) => { x.disabled = b; }); };

  go.onclick = () => {
    if (!W.account) return connect();
    const z = F.q, x = F.x, from = W.account;
    if (!z || z.over || !x || x.who !== from || !accepted('fm-ack', z.loss)) return;
    run(go, status, async () => {
      // The price is read again at the press: a pool that has moved against the quote is not sent into (the quote is drawn again instead), and the least it takes is kept from the new read.
      say(status, 'Reading the price again…');
      const fresh = await previewLp(z.m, z.wei, z.tac);
      if (fresh.lp * 1000n < z.lp * 995n) throw new Error('The price moved. Nothing was sent; the quote above is the new one.');
      const minShares = fresh.lp * 995n / 1000n, dl = deadline(), tail = word(minShares) + word(dl);
      const sig = z.tac > 0n && x.allowance < z.tac ? await signOrApprove(TAC, 'Tacit Token', z.tac, dl, from, status, 'your TAC') : '';
      const tx = z.m === 'eth' ? { data: SEL.zapETH + word(0) + tail, value: z.wei }
        : z.m === 'tac' ? { data: (sig ? SEL.zapTokenWithPermit : SEL.zapToken) + word(z.tac) + word(0) + tail + sig }
        : { data: (sig ? SEL.addAndStakeWithPermit : SEL.addAndStake) + word(z.tac) + tail + sig, value: z.wei };
      const { hash } = await send(tx, 'Farming', status, from);
      ethIn.value = ''; tacIn.value = ''; F.q = null; rc.hidden = true;
      say(status, `<span class="ok">Farming.</span> TAC streams to you every second. ${txLink(hash)}`);
      onDone();
    });
  };

  host.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || F.busy) return;
    if (b.dataset.fm) {
      const prev = F.mode, next = b.dataset.fm;
      F.mode = next; F.q = null; F.ackKey = null;
      // An amount stays only where it means the same: ETH between ETH and ETH + TAC, TAC between TAC and ETH + TAC. The other tab's figure is not carried back in as a deposit.
      if (prev === 'tac' || next === 'tac') ethIn.value = '';
      if (prev === 'eth' || next === 'eth') tacIn.value = '';
      clearTimeout(t); unsay(); rc.hidden = true; rc.innerHTML = '';
      renderForm();
      requote(next === 'pair' ? (ethIn.value ? ethIn : tacIn.value ? tacIn : null) : null);
      return;
    }
    if (b.dataset.pct) { F.outPct = b.dataset.pct; say($('#fm-pos-status'), ''); renderPos(); return; }
    if (b.dataset.as) { F.outAs = b.dataset.as; say($('#fm-pos-status'), ''); renderPos(); return; }
    const x = F.x;
    if ((b.id === 'fm-emax' || b.id === 'fm-tmax') && x && mineX(x)) {
      if (F.mode !== 'pair') {
        if (b.id === 'fm-emax' && x.bal != null) { const wei = cut(spendEth(x), 6); ethIn.value = wei > 0n ? plain(wei) : ''; }
        if (b.id === 'fm-tmax') { const tac = cut(x.tac, 2); tacIn.value = tac > 0n ? plain(tac) : ''; }
      } else if (x.bal != null) {
        let wei = cut(spendEth(x), 6), tac = capTac(up(tacFor(wei, x), 2), x);
        if (tacFor(wei, x) > x.tac) { tac = cut(x.tac, 2); wei = capEth(up(ethFor(tac, x), 6), x); }
        ethIn.value = wei > 0n ? plain(wei) : ''; tacIn.value = tac > 0n ? plain(tac) : '';
      }
      clearTimeout(t); unsay();
      requote();
    }
    const ps = () => $('#fm-pos-status'), from = W.account;
    if (['fm-claim', 'fm-stake', 'fm-exit'].includes(b.id) && (!from || x?.who !== from)) return;
    if (b.id === 'fm-claim') {
      let rewarded = 0n;
      run(b, ps(), async () => {
        const { hash, r } = await send({ data: SEL.claim }, 'Claiming', ps(), from);
        const got = (r.logs || []).filter((l) => l.address.toLowerCase() === FARM.toLowerCase() && l.topics[0] === REWARD_PAID).reduce((t, l) => t + BigInt(l.data), 0n);
        rewarded = got;
        say(ps(), `<span class="ok">Claimed${got ? ` ${fmt(got, 18, 2)} TAC` : ''}.</span> ${txLink(hash)}${refarm && got ? ' The form below is filled in to farm it again.' : ''}`); onDone();
      }).then(() => { if (refarm && rewarded > 0n) pairWith(rewarded, { settle: true }); });
    }
    if (b.id === 'fm-stake') run(b, ps(), async () => {
      const dl = deadline(), sig = x.lpAllow < x.lp ? await signOrApprove(POOL, 'Precision LP', x.lp, dl, from, ps(), 'your LP shares') : '';
      const { hash } = await send({ data: sig ? SEL.stakeWithPermit + word(x.lp) + word(dl) + sig : SEL.stake + word(x.lp) }, 'Staking', ps(), from);
      say(ps(), `<span class="ok">Staked.</span> ${txLink(hash)}`); onDone();
    });
    if (b.id === 'fm-exit' && F.w && accepted('fm-out-ack', F.w.loss)) run(b, ps(), async () => {
      const z = F.w, dl = deadline();
      say(ps(), 'Reading the price again…');
      const sim = await ethCall(FARM, outData(z, 0n, 0n, dl), 'latest', { from });
      if (wordAt(sim, 0) * 1000n < z.out0 * 995n) throw new Error('The price moved. Nothing was sent; the figures above are the new ones.');
      const m0 = wordAt(sim, 0) * 995n / 1000n, m1 = z.as === 'both' ? wordAt(sim, 1) * 995n / 1000n : 0n;
      const { hash } = await send({ data: outData(z, m0, m1, dl) }, 'Withdrawing', ps(), from);
      say(ps(), `<span class="ok">Withdrawn.</span> ${txLink(hash)}`); onDone();
    });
  });
  const outData = ({ all, as, shares }, m0, m1, dl) => (as === 'both'
    ? (all ? SEL.exitAndRemove : SEL.withdrawAndRemove + word(shares)) + word(m0) + word(m1) + word(dl)
    : (all ? SEL.exitTo + word(as === 'eth' ? 1 : 0) : SEL.withdrawTo + word(as === 'eth' ? 1 : 0) + word(shares)) + word(m0) + word(dl));
  async function previewOut() {
    const x = F.x, my = ++F.wseq, all = F.outPct === '100', as = F.outAs, shares = all ? x.staked : x.staked * BigInt(F.outPct) / 100n, el = $('#fm-out-rcpt'), ex = $('#fm-exit');
    const wkey = `${as}|${shares}`;
    if (F.w?.wkey !== wkey) F.w = null;           // another choice's figures are not this one's; the same choice read again keeps its own until the new ones are in
    try {
      const r = await ethCall(FARM, outData({ all, as, shares }, 0n, 0n, deadline()), 'latest', { from: W.account });
      if (my !== F.wseq || !ex?.isConnected) return;
      const worth = x.value * Number(shares) / Number(x.supply), got = as === 'both' ? null : Number(wordAt(r, 0));
      const loss = got == null || !worth ? 0 : Math.max(0, (1 - got / (as === 'eth' ? worth : worth / x.tacEth)) * 100);
      const ackId = `${wkey}|${Math.round(loss)}`;
      F.w = { all, as, shares, loss, wkey, out0: wordAt(r, 0) };
      el.hidden = false;
      el.innerHTML = `<div class="kv"><span>You get about</span><b>${as === 'both' ? `${amt(wordAt(r, 0), 5)} ETH + ${amt(wordAt(r, 1), 2)} TAC` : `${amt(wordAt(r, 0), as === 'eth' ? 5 : 2)} ${as === 'eth' ? 'ETH' : 'TAC'}`}</b></div>${all && x.earned > 0n ? `<div class="kv"><span>Plus earned</span><b>${amt(earnedNow(x), 2)} TAC</b></div>` : ''}`
        + (loss >= 0.5 ? `<div class="kv"><span>Swap price impact</span><b class="${loss >= 5 ? 'err' : ''}">${loss.toFixed(loss < 10 ? 1 : 0)}%</b></div>` : '')
        + feeRow(GAS.out)
        + (loss >= 15 ? ackBox('fm-out-ack', loss, 'withdrawal', F.outAck === ackId) : '');
      ex.textContent = all ? 'Withdraw all' : `Withdraw ${F.outPct}%`;
      const outGate = () => { ex.disabled = F.busy || !accepted('fm-out-ack', loss); };
      for (const ev of ['input', 'change']) $('#fm-out-ack')?.addEventListener(ev, () => { F.outAck = accepted('fm-out-ack', loss) ? ackId : null; outGate(); });
      outGate();
    } catch { if (my === F.wseq && el?.isConnected) { F.w = null; if (ex) ex.disabled = true; el.hidden = false; el.innerHTML = '<p class="note err">Could not preview the withdrawal. Try again in a moment.</p>'; } }
  }

  async function pairWith(tac = null, { settle = false } = {}) {
    if (F.busy || !W.account) return null;
    for (let i = 0; i < (settle ? 5 : 1); i++) {
      await read().catch(() => {});
      if (!settle || (mineX(F.x) && F.x.tac >= (tac || 1n))) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const x = F.x;
    renderStats(); if (!F.busy) renderPos();
    if (!mineX(x) || !(x.tac > 0n)) return null;
    let use = tac && tac < x.tac ? tac : x.tac, wei = up(ethFor(use, x), 6);
    const all = use, need = wei;
    const room = x.bal != null ? cut(spendEth(x), 6) : wei;
    if (wei > room) { wei = room; use = wei > 0n ? capTac(up(tacFor(wei, x), 2), x) : use; }
    const pair = wei > 0n;
    F.mode = pair ? 'pair' : 'tac'; F.q = null; F.ackKey = null;
    ethIn.value = pair ? plain(wei) : ''; tacIn.value = plain(use);
    renderForm();
    await requote();
    return { mode: F.mode, tac: use, wei: pair ? wei : 0n, left: all > use ? all - use : 0n, all, need };
  }

  let t = 0;
  const typed = (i) => () => { clearTimeout(t); F.q = null; gate(); if (!F.busy) unsay(); t = setTimeout(() => requote(i), 300); };
  for (const i of [ethIn, tacIn]) {
    i.addEventListener('input', typed(i));
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !F.busy && !go.disabled) go.click(); });
  }

  async function refresh() {
    await Promise.allSettled([read().catch(() => { if (!F.x) F.err = true; }), F.prog ? null : readProgram()]);
    renderStats(); renderForm();
    if (!F.busy) { renderPos(); if (ethIn.value || tacIn.value) requote(); }
  }
  // The page's own "Farm it" after a purchase: what the wallet holds of TAC (up to what was just bought) in the TAC form, quoted, with the farm in view.
  async function use({ tac = null } = {}) {
    if (F.busy || !W.account) return false;
    await read().catch(() => {});
    const x = F.x;
    if (!mineX(x) || !(x.tac > 0n)) return false;
    const v = tac && tac < x.tac ? tac : x.tac;
    F.mode = 'tac'; F.q = null; F.ackKey = null; ethIn.value = ''; tacIn.value = plain(cut(v, 2)); unsay();
    renderStats(); renderPos(); renderForm();
    requote();
    host.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return true;
  }
  renderForm(); refresh();
  return { refresh, paint: renderStats, busy: () => F.busy, pairWith, use };
}
