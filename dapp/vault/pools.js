import { word, addrWord, wordAt, SEL, encApprove } from '/vault/chain.js?cb=c20b4576';
import * as M from '/vault/math.js?cb=ac1ed53e';
import { MULTICALL3 } from '/vault/batch.js?cb=7f44b203';

const WAD = 10n ** 18n, ZERO = '0x0000000000000000000000000000000000000000';
const MIN_LIQUIDITY = 1000n;
const SLACK_BPS = 50n;
const GAS_KEEP = 2n * 10n ** 15n;
const FOUND_MAX = 32;
const DISCOVER_EVERY = 300;
const OFF_PEG = 3n;
const SELS = {
  poolFor: '0x83bd1387', isPool: '0x5b16ebb7', createPool: '0xb18a0dcf', createAndSeed: '0x7163352a', seed: '0xbdc5ef29', countFor: '0x20e832ec', sliceFor: '0x64d69dc9',
  reserve0: '0x443cb4bc', reserve1: '0x5a76f25e', totalSupply: '0x18160ddd', sqrtPriceCurrent: '0x2af1f249', removeLiquidity: '0xe39b0eb5', ethBalance: '0x4d2301cc',
  token0: '0x0dfe1681', token1: '0xd21220a7', sqrtPLow: '0x5c5ac485', sqrtPHigh: '0x87e43840', fee: '0xddca3f43', hook: '0x7f5a7c7b', feeRecipient: '0x46904840', creatorFeeBps: '0x17773ebb',
};
const CONFIG_READS = ['token0', 'token1', 'sqrtPLow', 'sqrtPHigh', 'fee', 'hook', 'feeRecipient', 'creatorFeeBps'];
const REVERTS = {
  '0x93687c0b': 'Only the address that owns this market can open it.', '0x846ec056': 'This market is already open.', '0xbb55fd27': 'That amount is too small for this market.',
  '0x37c8a83c': 'The price is outside this market’s range.', '0x1f2a2005': 'That amount is too small for this market.', '0xa9e4150c': 'The tokens did not arrive. Nothing was sent.', '0xbb2875c3': 'The market moved. Try again.',
  '0xe143a034': 'The market does not accept this.', '0xf591b277': 'This market is not open yet.',
};

const ceilDiv = (a, b) => (a + b - 1n) / b;
const isqrt = (n) => { if (n < 2n) return n; let x = 1n << BigInt((n.toString(2).length + 1) >> 1); for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; } };
const frac = (t) => {
  const part = (s) => { const [w, f = ''] = String(s).trim().split('.'); return [BigInt(w + f), 10n ** BigInt(f.length)]; };
  const [a, b = '1'] = String(t).split('/'), [an, ad] = part(a), [bn, bd] = part(b);
  return [an * bd, ad * bn];
};
const wordsOf = (hex) => String(hex).replace(/^0x/, '').match(/.{64}/g) || [];
const addrOf = (w) => '0x' + w.slice(24);

export function priceOf(m, sqrtNow) {
  if (!(sqrtNow > 0n)) return null;
  const dq = 10n ** BigInt(m.quote.dec), s2 = sqrtNow * sqrtNow;
  return m.synthIs1 ? 10n ** 72n / (s2 * dq) : s2 / dq;
}
function finish(kind, quote, synth, t, open) {
  const sa = synth.toLowerCase(), synthIs1 = t.token1 === sa, dq = BigInt(quote.dec);
  const sqrtOf = ([n, d]) => { const [a, b] = synthIs1 ? [n * 10n ** 18n, d * 10n ** dq] : [d * 10n ** dq, n * 10n ** 18n]; return isqrt(a * 10n ** 36n / b); };
  const m = { kind, synth: sa, quote, synthIs1, t, open, sOpen: open ? sqrtOf(open) : null };
  m.range = synthIs1 ? [priceOf(m, t.sqrtPHigh), priceOf(m, t.sqrtPLow)] : [priceOf(m, t.sqrtPLow), priceOf(m, t.sqrtPHigh)];
  m.refQps = open ? open[1] * WAD / open[0] : null;
  m.openOk = m.sOpen !== null && m.sOpen > t.sqrtPLow && m.sOpen < t.sqrtPHigh;
  return m;
}
export function marketOf(kind, quote, synth, recipient = ZERO) {
  const open = [1n, 1n];
  const [low, high] = [frac(kind.low), frac(kind.high)];
  const qa = quote.addr ? quote.addr.toLowerCase() : ZERO, sa = synth.toLowerCase(), synthIs1 = BigInt(sa) > BigInt(qa), dq = BigInt(quote.dec);
  const sqrtOf = ([n, d]) => { const [a, b] = synthIs1 ? [n * 10n ** 18n, d * 10n ** dq] : [d * 10n ** dq, n * 10n ** 18n]; return isqrt(a * 10n ** 36n / b); };
  const [sLow, sHigh] = synthIs1 ? [sqrtOf(low), sqrtOf(high)] : [sqrtOf(high), sqrtOf(low)];
  const t = { token0: synthIs1 ? qa : sa, token1: synthIs1 ? sa : qa, sqrtPLow: sLow, sqrtPHigh: sHigh, fee: BigInt(kind.fee), hook: ZERO, feeRecipient: recipient.toLowerCase(), creatorFeeBps: 0n };
  return finish({ ...kind, template: true }, { ...quote, addr: quote.addr ? quote.addr.toLowerCase() : null }, synth, t, open);
}
const encMarket = (t) => addrWord(t.token0) + addrWord(t.token1) + word(t.sqrtPLow) + word(t.sqrtPHigh) + word(t.fee) + addrWord(t.hook) + addrWord(t.feeRecipient) + word(t.creatorFeeBps);

export function seedPlan(m, side, amount) {
  const { sqrtPLow: sl, sqrtPHigh: sh } = m.t, s = m.sOpen;
  if (!m.openOk) return null;
  const typed0 = side === 's' ? !m.synthIs1 : m.synthIs1;
  const lp = typed0 ? amount * s / (sh - s) * sh / WAD : amount * WAD / (s - sl);
  if (lp <= MIN_LIQUIDITY) return null;
  const u0 = ceilDiv(lp * (sh - s) * WAD, sh * s), u1 = ceilDiv(lp * (s - sl), WAD);
  const used = m.synthIs1 ? { s: u1, q: u0 } : { s: u0, q: u1 }, other = side === 's' ? 'q' : 's';
  return { lp: lp - MIN_LIQUIDITY, used, send: { [side]: amount, [other]: used[other] }, minLP: (lp - MIN_LIQUIDITY) * 99n / 100n };
}
export function addPlan(m, st, side, amount) {
  const typed0 = side === 's' ? !m.synthIs1 : m.synthIs1, rT = typed0 ? st.r0 : st.r1;
  if (!(rT > 0n) || !(st.supply > 0n)) return null;
  const lp = amount * st.supply / rT;
  if (lp === 0n) return null;
  const u0 = st.r0 ? ceilDiv(lp * st.r0, st.supply) : 0n, u1 = st.r1 ? ceilDiv(lp * st.r1, st.supply) : 0n;
  const used = m.synthIs1 ? { s: u1, q: u0 } : { s: u0, q: u1 }, other = side === 's' ? 'q' : 's';
  return { lp, used, send: { [side]: amount, [other]: used[other] * (10000n + SLACK_BPS) / 10000n }, minLP: lp * 995n / 1000n };
}
const callSeed = (m, to, plan, first) => {
  const a0 = m.synthIs1 ? plan.send.q : plan.send.s, a1 = m.synthIs1 ? plan.send.s : plan.send.q;
  return (first ? SELS.createAndSeed : SELS.seed) + encMarket(m.t) + word(first ? m.sOpen : 0n) + word(a0) + word(a1) + word(plan.minLP) + addrWord(to);
};

export function makePools({ el, cfg, esc, rpc, ethCall, batch, wallet, W, synthOf, symOf, connect, txLink, onChange }) {
  // `add`: whether the add-liquidity form is open, null until the holder opens or closes it (until then a market not yet open, a holder's own
  // liquidity or an amount typed opens it)
  const P = { by: {}, busy: false, key: null, sel: {}, side: 's', text: { s: '', q: '' }, shape: '', msg: '', reading: {}, failed: false, camp: null, campAt: 0, campFor: null, add: null };
  const recipient = cfg?.recipient || ZERO, quotes = cfg?.quotes || {};
  const keys = [...new Set((cfg?.markets || []).map((k) => k.vault))];
  const quoteByAddr = (a) => Object.entries(quotes).map(([sym, q]) => ({ sym, ...q })).find((q) => (q.addr || ZERO).toLowerCase() === a.toLowerCase()) || null;
  const ico = (id) => `<svg class="tk" aria-hidden="true"><use href="#tk-${id}"/></svg>`;
  const pair = (key, qs) => `<span class="pair">${ico(symOf(key).toLowerCase())}${ico(qs.toLowerCase())}</span>`;

  const near = (v, dec, dp) => M.fmtUnits(v + 5n * 10n ** BigInt(Math.max(0, dec - dp - 1)), dec, dp);
  const qFmt = (m, v, max = 4) => near(v, m.quote.dec, Math.min(max, m.quote.dec)), sFmt = (v, max = 4) => near(v, 18, max);
  const feeText = (m) => `${(Number(m.t.fee) / 1e4).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;
  const inv = (qps) => (qps > 0n ? 10n ** 36n / qps : 0n);
  const small = (qps) => qps < 10n ** 16n;
  const pxText = (m, sym, qps) => (small(qps) ? `1 ${m.quote.sym} = ${near(inv(qps), 18, 0)} ${sym}` : `1 ${sym} = ${near(qps, 18, 4)} ${m.quote.sym}`);
  const rangeText = (m, sym) => (small(m.range[1])
    ? `${near(inv(m.range[1]), 18, 0)} – ${near(inv(m.range[0]), 18, 0)} ${sym} per ${m.quote.sym}` : `${near(m.range[0], 18, 3)} – ${near(m.range[1], 18, 3)} ${m.quote.sym}`);
  const tierText = (m) => m.kind?.tier || '';

  const V = (key) => P.by[key] || null;
  const list = (key) => V(key)?.markets || [];
  const selected = (key) => { const l = list(key), id = P.sel[key]; return l.find((x) => x.pool === id) || l[0] || null; };
  const seeded = (x) => !!x && x.exists && x.supply > 0n;
  const inRange = (x) => !!x && x.sqrtNow != null && x.sqrtNow > x.m.t.sqrtPLow && x.sqrtNow < x.m.t.sqrtPHigh;
  const px = (x) => priceOf(x.m, x.sqrtNow);
  function view(key) {
    const x = selected(key), v = V(key);
    if (!x) return null;
    const q = v.hold?.quote?.[x.m.quote.sym] || {};
    return { ...x, acc: v.hold?.acc || null, balS: v.hold?.balS ?? null, allowS: v.hold?.allowS ?? null, balQ: q.bal ?? null, allowQ: q.allow ?? null };
  }
  const quoteOpen = (key, qsym) => ((key === 'usd' && qsym === 'USDC') || (key === 'eth' && qsym === 'ETH') ? [1n, 1n] : null);

  async function read(key, force = false) {
    const synth = key && synthOf(key);
    if (!synth || !keys.includes(key) || (P.reading[key] && !force)) return;
    P.reading[key] = true;
    try {
      const old = V(key), acc = W.account, acct = acc ? addrWord(acc) : null;
      const again = !old || force || Date.now() - old.discAt > DISCOVER_EVERY * 1000;
      let markets = old?.markets || [], discAt = old?.discAt || 0;
      if (again) {
        const tm = (cfg.markets || []).filter((k) => k.vault === key).map((k) => marketOf(k, { sym: k.quote, ...quotes[k.quote] }, synth, recipient)).filter(Boolean);
        const r1 = await batch([...tm.map((m) => ({ to: cfg.factory, data: SELS.poolFor + encMarket(m.t) })), { to: cfg.factory, data: SELS.countFor + addrWord(synth) }]);
        const pools = tm.map((m, i) => {
          if (!/^0x0{24}[0-9a-f]{40}$/i.test(r1[i] || '')) throw new Error('the factory gave no pool address');
          return { m, pool: '0x' + r1[i].slice(-40) };
        });
        const count = Math.min(Number(r1[tm.length] ? wordAt(r1[tm.length], 0) : 0n), FOUND_MAX), have = new Set(pools.map((x) => x.pool)), extra = [];
        if (count > 0) {
          for (const w of wordsOf(await ethCall(cfg.factory, SELS.sliceFor + addrWord(synth) + word(0) + word(count))).slice(2, 2 + count)) { const p = addrOf(w); if (!have.has(p)) { have.add(p); extra.push(p); } }
        }
        const rc = extra.length ? await batch(extra.flatMap((p) => CONFIG_READS.map((f) => ({ to: p, data: SELS[f] })))) : [];
        extra.forEach((p, i) => {
          const g = (j) => (rc[i * 8 + j] == null ? null : wordAt(rc[i * 8 + j], 0)), ga = (j) => (rc[i * 8 + j] == null ? null : addrOf(wordsOf(rc[i * 8 + j])[0]));
          const [t0, t1, hook] = [ga(0), ga(1), ga(5)];
          if (!t0 || !t1 || hook !== ZERO || ![t0, t1].some((a) => a.toLowerCase() === synth.toLowerCase())) return;
          const q = quoteByAddr(t0.toLowerCase() === synth.toLowerCase() ? t1 : t0);
          if (!q) return;
          const t = { token0: t0.toLowerCase(), token1: t1.toLowerCase(), sqrtPLow: g(2), sqrtPHigh: g(3), fee: g(4), hook, feeRecipient: ga(6).toLowerCase(), creatorFeeBps: g(7) };
          pools.push({ m: finish({ vault: key, quote: q.sym, tier: '', template: false }, q, synth, t, quoteOpen(key, q.sym)), pool: p });
        });
        markets = pools; discAt = Date.now();
      }
      const qsyms = [...new Set(markets.map((x) => x.m.quote.sym))], per = acc ? 6 : 5;
      const calls = markets.flatMap((x) => [{ to: cfg.factory, data: SELS.isPool + addrWord(x.pool) }, ...['reserve0', 'reserve1', 'totalSupply', 'sqrtPriceCurrent'].map((f) => ({ to: x.pool, data: SELS[f] })), ...(acc ? [{ to: x.pool, data: SEL.balanceOf + acct }] : [])]);
      const hold = [];
      if (acc) {
        hold.push({ to: synth, data: SEL.balanceOf + acct }, { to: synth, data: SEL.allowance + acct + addrWord(cfg.factory) });
        for (const s of qsyms) { const q = quotes[s]; hold.push(...(q.addr ? [{ to: q.addr, data: SEL.balanceOf + acct }, { to: q.addr, data: SEL.allowance + acct + addrWord(cfg.factory) }] : [{ to: MULTICALL3, data: SELS.ethBalance + acct }])); }
      }
      const r = await batch([...calls, ...hold]), w = (i) => (r[i] == null ? null : wordAt(r[i], 0));
      markets = markets.map((x, i) => {
        const b = i * per;
        return { ...x, exists: w(b) === 1n, r0: w(b + 1) ?? 0n, r1: w(b + 2) ?? 0n, supply: w(b + 3) ?? 0n, sqrtNow: w(b + 4), mine: acc ? w(b + 5) ?? 0n : 0n };
      });
      const held = { acc: null };
      if (acc) {
        let j = markets.length * per;
        held.acc = acc; held.balS = w(j++) ?? 0n; held.allowS = w(j++) ?? 0n; held.quote = {};
        for (const s of qsyms) { const bal = w(j++) ?? 0n; held.quote[s] = { bal, allow: quotes[s].addr ? w(j++) ?? 0n : 2n ** 256n - 1n }; }
      }
      P.by[key] = { markets, hold: held, discAt, at: Date.now() };
      if (key === P.key) P.failed = false;
    } catch (e) { if (key === P.key) P.failed = true; console.warn('pool read:', e?.message || e); } finally { P.reading[key] = false; }
    draw(); onChange?.();
  }

  async function readCampaign() {
    if (!cfg?.campaign) return;
    const acc = W.account || null;
    if (Date.now() - P.campAt < 60e3 && P.campFor === acc) return;
    P.campAt = Date.now(); P.campFor = acc;
    try {
      const r = await fetch(`${cfg.campaign}/lp${acc ? `?address=${acc}` : ''}`, { signal: AbortSignal.timeout(8000) });
      const j = r.ok ? await r.json() : null;
      P.camp = j && j.enabled ? j : null;
    } catch { P.camp = null; }
    draw();
  }
  const dayText = (day) => new Date(day * 86400e3).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const tacText = (wei) => M.fmtUnits(BigInt(wei), 18, 2);
  const termsNow = () => { const c = P.camp, t = c?.terms, soon = !t && c?.next, e = t || soon; return e ? { create: BigInt(e.createWei), daily: BigInt(e.dailyWei), cap: BigInt(e.capWeiPerUsdDay), from: soon ? c.next.fromDay : null } : null; };
  function campaignRows(x) {
    const c = P.camp, p = c?.pools?.find((q) => q.pool === x.pool.toLowerCase()), n = termsNow();
    if (!p || !n) return { bonus: null, earn: null, mine: null };
    const from = n.from ? ` · from ${esc(dayText(n.from))}` : '', half = p.weightBps !== '10000' ? ` · counts ×${Number(p.weightBps) / 1e4}` : '';
    const usd = Math.round(Number(BigInt(c.minUsdWei) / 10n ** 16n)) / 100;
    let bonus = null;
    if (p.openPaid) bonus = '<b>Paid</b>';
    else if (n.create > 0n) bonus = `<b>${esc(tacText(n.create))} TAC</b><small>${p.opened ? `to the opener, once it holds $${esc(usd)} for a day` : `to the first in with $${esc(usd)} for a day`}${from}</small>`;
    const earn = n.daily > 0n ? `<b>${esc(tacText(n.daily))} TAC a day</b><small>to those who hold it all day · up to ${esc(M.fmtUnits(n.cap, 18, 4))} per $1${esc(half)}${from}</small>` : null;
    const got = c.mine && BigInt(c.mine.creditedWei) > 0n ? `<b>${esc(tacText(c.mine.creditedWei))} TAC</b>` : null;
    return { bonus, earn, mine: got };
  }
  function promo() {
    const c = P.camp, n = termsNow();
    if (!c || !n) return null;
    const parts = [];
    if (n.create > 0n && c.pools.some((p) => !p.openPaid)) parts.push(`${tacText(n.create)} TAC for opening a ${keys.map(symOf).join(' or ')} market`);
    if (n.daily > 0n) parts.push(`${tacText(n.daily)} TAC a day for supplying one`);
    return parts.length ? `Earn ${esc(parts.join(', and '))}.${n.from ? ` From ${esc(dayText(n.from))}.` : ''}` : null;
  }

  function planNow(st) {
    const m = st.m, side = P.side, dec = side === 's' ? 18 : m.quote.dec;
    const amount = M.parseUnits(P.text[side], dec);
    if (!amount || amount <= 0n) return { ok: false, why: 'Enter an amount' };
    const first = !seeded(st), plan = first ? seedPlan(m, side, amount) : addPlan(m, st, side, amount);
    if (!plan) return { ok: false, why: first && !m.open ? 'This pool is empty and has no opening price.' : first && !m.openOk ? 'The price is outside this market’s range' : 'Too small for this market' };
    return { ok: true, plan, first, amount };
  }
  function maxOf(st, side) {
    const m = st.m, first = !seeded(st), bq = st.balQ ?? 0n, keep = m.quote.addr ? 0n : (GAS_KEEP < bq ? GAS_KEEP : bq);
    const hold = { s: st.balS ?? 0n, q: bq - keep };
    const over = (a) => { const p = first ? seedPlan(m, side, a) : addPlan(m, st, side, a); return !!p && (p.send.s > hold.s || p.send.q > hold.q); };
    let lo = 0n, hi = hold[side];
    if (!over(hi)) return hi;
    while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (over(mid)) hi = mid - 1n; else lo = mid; }
    return lo;
  }

  const bit = (s) => el.querySelector(s);
  const setText = (s, h) => { const n = bit(s); if (n && n.__h !== h) { n.__h = h; n.innerHTML = h; } };
  const statusBox = () => `<div class="status" id="pl-status" role="status">${P.msg || ''}</div>`;
  function shapeSet(shape, html) { if (P.shape !== shape) { P.shape = shape; el.innerHTML = html; } }
  function draw() {
    const key = P.key;
    if (!key || !keys.includes(key) || !synthOf(key)) { el.hidden = true; return; }
    el.hidden = false;
    const sym = symOf(key), v = V(key), st = view(key);
    const head = `<p class="eyebrow" id="pl-h"><span>Where ${esc(sym)} sells</span><span class="who" id="pl-fee"></span></p>`;
    if (!v || !st) { shapeSet(P.failed ? 'failed' : 'loading', `${head}<p class="empty">${P.failed ? 'Could not read the markets. Try again in a moment.' : 'Reading the markets…'}</p>${statusBox()}`); return; }
    const m = st.m, qs = m.quote.sym, open = seeded(st), l = list(key);
    const pick = l.length > 1 ? `<div class="seg pick2" id="pl-pick" role="group" aria-label="Which market">${l.map((x) => `<button type="button" data-m="${x.pool}" aria-pressed="${x.pool === st.pool}"${P.busy ? ' disabled' : ''}>${pair(key, x.m.quote.sym)}<span class="mk"><b>${esc(symOf(key))} / ${esc(x.m.quote.sym)}</b><small>${esc(`${tierText(x.m)}${tierText(x.m) ? ' · ' : ''}${feeText(x.m)}`)}</small></span></button>`).join('')}</div>` : '';
    const showAdd = P.add ?? (!open || st.mine > 0n || !!(P.text.s || P.text.q));
    const shape = [key, st.pool, open, st.exists, !!st.acc, !!m.quote.addr, st.mine > 0n, l.map((x) => x.pool).join(), showAdd].join();
    if (P.shape !== shape) {
      shapeSet(shape, `${head}${pick}
        <div class="rows flat" id="pl-rows">${open
          ? '<div class="kv"><span>Price</span><b class="num" id="pl-px"></b></div><div class="kv"><span>In the pool</span><b class="num" id="pl-depth"></b></div><div class="kv"><span>Range</span><b class="num" id="pl-range"></b></div>' + (st.mine > 0n ? '<div class="kv"><span>Yours</span><b class="num" id="pl-mine"></b></div>' : '')
          : '<div class="kv"><span>Opens at</span><b class="num" id="pl-px"></b></div><div class="kv"><span>Range</span><b class="num" id="pl-range"></b></div>'}
          </div>
        <div class="reward" id="pl-reward" hidden><p class="rwd-h">Earn TAC here</p><div class="kv" id="pl-kb" hidden><span>Opening bonus</span><b id="pl-bonus"></b></div><div class="kv" id="pl-ke" hidden><span>Daily rewards</span><b id="pl-earn"></b></div><div class="kv" id="pl-km" hidden><span>Earned so far</span><b class="num" id="pl-got"></b></div></div>
        <details class="pl-add" id="pl-add"${showAdd ? ' open' : ''}><summary>Add liquidity</summary>
        <div class="lbl"><span>${esc(sym)}</span><button class="linkbtn" id="pl-bs" type="button"></button></div>
        <div class="amt"><input id="pl-s" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${esc(sym)} to add"><span class="u">${ico(sym.toLowerCase())}${esc(sym)}</span></div>
        <div class="lbl"><span>${esc(qs)}</span><button class="linkbtn" id="pl-bq" type="button"></button></div>
        <div class="amt"><input id="pl-q" inputmode="decimal" placeholder="0.00" autocomplete="off" aria-label="${esc(qs)} to add"><span class="u">${ico(qs.toLowerCase())}${esc(qs)}</span></div>
        <p class="hint" id="pl-hint"></p>
        <button class="btn" id="pl-go" type="button"></button>
        </details>
        ${st.mine > 0n ? '<div class="chips" id="pl-rm" role="group" aria-label="Take liquidity out"><button type="button" data-rm="25">Take 25%</button><button type="button" data-rm="50">50%</button><button type="button" data-rm="100">All</button></div>' : ''}
        ${statusBox()}`);
      bit('#pl-s').value = P.text.s; bit('#pl-q').value = P.text.q;
    }
    setText('#pl-fee', `${esc(tierText(m))}${tierText(m) ? ' · ' : ''}${esc(feeText(m))} fee`);
    const r = m.synthIs1 ? { s: st.r1, q: st.r0 } : { s: st.r0, q: st.r1 }, now = px(st);
    if (open) {
      setText('#pl-px', now ? `${esc(pxText(m, sym, now))}${inRange(st) ? '' : ' · out of range'}` : '—');
      setText('#pl-depth', `${esc(qFmt(m, r.q, 2))} ${esc(qs)} · ${esc(sFmt(r.s, 2))} ${esc(sym)}`);
      if (st.mine > 0n) setText('#pl-mine', `${esc((Number((st.mine * 10000n + st.supply / 2n) / st.supply) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }))}% · ${esc(qFmt(m, st.mine * r.q / st.supply, 4))} ${esc(qs)} + ${esc(sFmt(st.mine * r.s / st.supply, 4))} ${esc(sym)}`);
    } else setText('#pl-px', m.open ? esc(pxText(m, sym, m.refQps)) : '—');
    setText('#pl-range', esc(rangeText(m, sym)));
    const camp = campaignRows(st);
    for (const [row, cell, html] of [['#pl-kb', '#pl-bonus', camp.bonus], ['#pl-ke', '#pl-earn', camp.earn], ['#pl-km', '#pl-got', camp.mine]]) {
      const r = bit(row); if (!r) continue;
      r.hidden = html == null; if (html != null) setText(cell, html);
    }
    const block = bit('#pl-reward'); if (block) block.hidden = camp.bonus == null && camp.earn == null;
    setText('#pl-bs', st.balS == null ? '' : `Balance ${esc(sFmt(st.balS, 4))} · Max`);
    setText('#pl-bq', st.balQ == null ? '' : `Balance ${esc(qFmt(m, st.balQ, 4))} · Max`);
    drawButton(st);
  }
  function drawButton(st) {
    const go = bit('#pl-go'), hint = bit('#pl-hint');
    if (!go) return;
    const m = st.m, sym = symOf(P.key), qs = m.quote.sym, open = seeded(st), typedAny = !!(P.text.s || P.text.q);
    let label = open ? 'Add liquidity' : st.exists ? 'Add the first liquidity' : typedAny ? 'Create and add liquidity' : 'Create pool', why = '', dis = false, note = '';
    if (!st.acc) label = 'Connect wallet';
    else if (!open && !typedAny) {
      if (st.exists) { dis = true; why = 'Created. Add liquidity to open it for trading.'; }
    } else {
      const pl = planNow(st);
      if (!pl.ok) { dis = true; if (open && pl.why === 'Enter an amount') label = 'Enter an amount'; else if (pl.why !== 'Enter an amount') why = pl.why; }
      else if (pl.plan.send.s > st.balS) { label = `Not enough ${sym}`; dis = true; why = `Borrow ${sym} above, then add it here.`; }
      else if (pl.plan.send.q > st.balQ) { label = `Not enough ${qs}`; dis = true; }
      else {
        const steps = (st.allowS < pl.plan.send.s ? 1 : 0) + (m.quote.addr && st.allowQ < pl.plan.send.q ? 1 : 0);
        if (steps) note = `${steps} approval${steps > 1 ? 's' : ''} first, then ${st.exists ? 'the deposit' : 'the pool and the deposit'}. Each is a confirmation.`;
      }
    }
    if (open && st.acc && !dis) {
      const now = px(st);
      if (!inRange(st)) note = 'The price is outside this market’s range, so it is not trading now.';
      else if (now && m.refQps) {
        const dev = now > m.refQps ? (now - m.refQps) * 100n / m.refQps : (m.refQps - now) * 100n / m.refQps;
        if (dev >= OFF_PEG) note = `The pool trades ${dev}% away from ${pxText(m, sym, m.refQps)}. A deposit takes the pool as it stands.`;
      }
    }
    if (P.busy) dis = true;
    setText('#pl-go', esc(label)); go.disabled = dis;
    if (hint) { const h = esc(why || note); if (hint.__h !== h) { hint.__h = h; hint.textContent = why || note; } }
    for (const b of el.querySelectorAll('#pl-rm button, #pl-pick button')) b.disabled = P.busy;
  }
  function mirror(st) {
    const m = st.m, other = P.side === 's' ? 'q' : 's', pl = planNow(st), box = bit(`#pl-${other}`);
    if (!box) return;
    const v = pl.ok ? pl.plan.used[other] : null, dec = other === 's' ? 18 : m.quote.dec;
    P.text[other] = v == null ? '' : M.fmtUnits(v, dec, dec === 18 ? 6 : dec).replace(/,/g, '');
    box.value = P.text[other];
  }

  const say = (h) => { P.msg = h; const n = bit('#pl-status'); if (n) n.innerHTML = h; };
  const stopped = (e) => e?.code === 4001 || /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message)/i.test(e?.message || '');
  const why = (e) => REVERTS[String(e?.data || '').slice(0, 10).toLowerCase()] || null;
  const call = (from, to, data, value = 0n) => rpc('eth_call', [{ from, to, data, ...(value ? { value: '0x' + value.toString(16) } : {}) }, 'latest']);
  async function approve(from, token, amount) {
    say('Approve in your wallet. It lets the market take exactly this amount.');
    const h = await wallet.sendTx({ to: token, data: encApprove(cfg.factory, amount), from });
    say(`Waiting for the approval ${txLink(h)}`);
    if ((await wallet.receipt(h)).status !== '0x1') throw new Error('The approval did not go through.');
  }
  async function send(from, to, data, value, done, again = 0) {
    let err = null;
    for (let i = 0; i <= again; i++) {
      try { await call(from, to, data, value); err = null; break; } catch (e) { err = e; if (i < again) await new Promise((r) => setTimeout(r, 2000)); }
    }
    if (err) throw Object.assign(new Error(why(err) || 'This would fail. Nothing was sent; the figures above are current.'), { sim: true });
    say('Confirm in your wallet.');
    const h = await wallet.sendTx({ to, data, value, from });
    say(`Sent ${txLink(h)}. Waiting for it to land…`);
    if ((await wallet.receipt(h)).status !== '0x1') throw new Error(`The transaction failed (${h.slice(0, 10)}…).`);
    say(`${done} ${txLink(h)}`);
  }
  const guard = async (fn) => {
    if (P.busy) return;
    P.busy = true; draw();
    try { await fn(); } catch (e) { say(`<span class="err">${esc(stopped(e) ? 'Cancelled. Nothing was sent.' : String(e?.message || e).slice(0, 220))}</span>`); } finally { P.busy = false; await read(P.key, true); }
  };

  async function act() {
    if (!W.account) { connect(); return; }
    const key = P.key, from = W.account, pick = P.sel[key];
    await guard(async () => {
      say('Reading the market again…');
      await read(key, true);
      const st = view(key);
      if (!st || st.acc?.toLowerCase() !== from.toLowerCase()) throw new Error('The wallet’s account changed. Nothing was sent.');
      if (P.sel[key] !== pick) throw new Error('The market changed. Nothing was sent.');
      const mm = st.m, sym = symOf(key), typedAny = !!(P.text.s || P.text.q);
      if (!typedAny && !st.exists) {
        await send(from, cfg.factory, SELS.createPool + encMarket(mm.t), 0n, `The ${sym} / ${mm.quote.sym} pool is created. Add liquidity to open it for trading.`);
        return;
      }
      const pl = planNow(st);
      if (!pl.ok) throw new Error(pl.why);
      if (pl.plan.send.s > st.balS || pl.plan.send.q > st.balQ) throw new Error('The balance is not enough.');
      let approved = false;
      if (st.allowS < pl.plan.send.s) { await approve(from, mm.synth, pl.plan.send.s); approved = true; }
      if (mm.quote.addr && st.allowQ < pl.plan.send.q) { await approve(from, mm.quote.addr, pl.plan.send.q); approved = true; }
      const a0 = mm.synthIs1 ? pl.plan.send.q : pl.plan.send.s;
      await send(from, cfg.factory, callSeed(mm, from, pl.plan, pl.first), mm.quote.addr ? 0n : a0, pl.first ? `The ${sym} / ${mm.quote.sym} market is open.` : 'Added.', approved ? 3 : 0);
      P.text = { s: '', q: '' };
      const sb = bit('#pl-s'), qb = bit('#pl-q'); if (sb) sb.value = ''; if (qb) qb.value = '';
    });
  }
  async function take(pct) {
    if (!W.account) { connect(); return; }
    const key = P.key, from = W.account;
    await guard(async () => {
      say('Reading the market again…');
      await read(key, true);
      const st = view(key);
      if (!st || !(st.mine > 0n)) throw new Error('There is nothing to take out.');
      const lp = st.mine * BigInt(pct) / 100n, o0 = lp * st.r0 / st.supply, o1 = lp * st.r1 / st.supply;
      if (!(lp > 0n)) throw new Error('That is too small.');
      await send(from, st.pool, SELS.removeLiquidity + word(lp) + word(o0 * 99n / 100n) + word(o1 * 99n / 100n) + addrWord(from), 0n, 'Taken out.');
    });
  }

  // a details element's toggle does not bubble, so it is caught on the way down
  el.addEventListener('toggle', (e) => { if (e.target.id === 'pl-add') P.add = e.target.open; }, true);
  el.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id !== 'pl-s' && id !== 'pl-q') return;
    const st = view(P.key);
    if (!st) return;
    P.side = id === 'pl-s' ? 's' : 'q'; P.text[P.side] = e.target.value;
    mirror(st); drawButton(st);
    if (P.msg && !P.busy) say('');
  });
  el.addEventListener('click', (e) => {
    const st = view(P.key);
    if (!st) return;
    const b = e.target.closest('#pl-bs, #pl-bq'), rm = e.target.closest('[data-rm]'), mk = e.target.closest('[data-m]');
    if (mk && !P.busy) { P.sel[P.key] = mk.dataset.m; P.text = { s: '', q: '' }; P.side = 's'; P.shape = ''; P.msg = ''; draw(); return; }
    if (b && !P.busy) {
      const side = b.id === 'pl-bs' ? 's' : 'q', a = maxOf(st, side), dec = side === 's' ? 18 : st.m.quote.dec;
      P.side = side; P.text[side] = a > 0n ? M.plain(a, dec) : ''; bit(`#pl-${side}`).value = P.text[side];
      mirror(st); drawButton(st); return;
    }
    if (rm && !P.busy) { take(Number(rm.dataset.rm)); return; }
    if (e.target.closest('#pl-go') && !P.busy) act();
  });
  function show(key) {
    if (key !== P.key) { P.key = key; P.text = { s: '', q: '' }; P.side = 's'; P.shape = ''; P.msg = ''; }
    draw();
    for (const k of keys) if (!V(k) && synthOf(k)) read(k);
    readCampaign();
  }
  function cell(key) {
    if (!keys.includes(key) || !synthOf(key)) return null;
    if (!V(key)) return '<span class="mute">…</span>';
    const x = list(key).find(seeded);
    if (!x) {
      const n = termsNow(), unopened = n && n.create > 0n && list(key).some((m) => P.camp?.pools?.some((p) => p.pool === m.pool.toLowerCase() && !p.openPaid));
      return unopened ? `Not open yet<small>opening earns ${esc(tacText(n.create))} TAC</small>` : 'Not open yet';
    }
    const q = x.m.synthIs1 ? x.r0 : x.r1, now = px(x), depth = `${esc(qFmt(x.m, q, 2))} ${esc(x.m.quote.sym)} in the pool`;
    if (!inRange(x)) return `<b>Not trading</b><small>price outside the market’s range · ${depth}</small>`;   // a price outside the range is not one anything trades at
    return now && !small(now) ? `<b>${esc(near(now, 18, 4))}</b> ${esc(x.m.quote.sym)}<small>${depth}</small>` : now ? `<b>${esc(pxText(x.m, symOf(key), now))}</b><small>${depth}</small>` : `<b>${esc(qFmt(x.m, q, 2))}</b> ${esc(x.m.quote.sym)}<small>in the pool</small>`;
  }
  return { show, read: () => Promise.all([...keys.map((k) => read(k)), readCampaign()]), draw, cell, promo };
}
