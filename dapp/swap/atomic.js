// The swap card's Bitcoin and Ethereum lane: real BTC for ETH, and ETH for BTC, swapped with a liquidity provider so that neither side holds the other's funds at
// any step. The card loads this when the lane is first opened, and shows the lane's switch only when providers of the pair exist (swap/atomic-probe.js).
// Nothing here builds or signs a transaction: the pair client does (fastbridge-pair.js, opened by fast/pair-wire.js openPair) with the Tacit key.
//
//   makeAtomicLane({ host, notify, wallet, provider, getUx, door, onState, dir, now }) -> { show, hide, set, state, get unlocked }
//
//   door   how the key and the pair client are reached: { load(), unlocked, signIn(), fund(), open() -> { pair } | pair }. The page's door is made here from
//          the trade page's Bitcoin module (the same sign-in as the Bitcoin lane); a test passes its own.
//   pair   quote({ dir, amount }), start(q), pump(), records(), recover(), balances(), reference(): see the contract in fastbridge-pair.js. A swap is 'b2e'
//          (pay BTC, get ETH) or 'e2b'; amounts are in sats and in the pool's ETH unit (8 places, 1e-8 ETH).
import { esc, fmtUnits, parseUnits, plain } from '/trade/util.js?cb=9c8b4133';

const BTC_MODULE = '/trade/btc.js?cb=a1ece943';
const TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const DEC = 8, POLL_MS = 5000, QUOTE_MS = 300, REFRESH_MS = 15000, BAL_MS = 45000;
const COINS = { btc: { sym: 'BTC', mark: 'tk-btc', at: 'c-btc', where: 'Bitcoin' }, eth: { sym: 'ETH', mark: 'tk-teth', at: 'c-eth', where: 'Ethereum, private' } };
const SIDES = { b2e: ['btc', 'eth'], e2b: ['eth', 'btc'] };
const DISMISS_KEY = 'tacit-atomic-dismissed-v1';
const LOCK_GUESS_SATS = 3000;                                     // what Max keeps back for the Bitcoin fee until a quote has said what it is

const tidy = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export const fmt = (v) => tidy(fmtUnits(v, DEC, DEC));
const nowSecs = () => Math.floor(Date.now() / 1000);

// About how long a swap takes, in words: a Bitcoin block or two, then the pool's settle.
export const etaText = (secs) => {
  const m = Math.max(1, Math.round(Number(secs) / 60));
  return Number(secs) < 90 ? 'about a minute' : m < 90 ? `about ${m} minutes` : `about ${Math.round(m / 60)} hours`;
};
// How long until a time (seconds since the epoch), in words, for a refund that opens then.
export const untilText = (at, now = nowSecs()) => {
  const s = Number(at) - now;
  if (!(s > 0)) return 'now';
  const h = Math.floor(s / 3600), m = Math.ceil((s % 3600) / 60);
  return h >= 48 ? `in ${Math.round(h / 24)} days` : h >= 1 ? `in ${h} h${m && m < 60 ? ` ${m} min` : ''}` : `in ${Math.max(1, m)} min`;
};
// The rate the provider gives, as a line: always BTC first, in ETH.
export const rateText = (rate) => `1 BTC = ${Number(rate).toLocaleString('en-US', { maximumFractionDigits: rate >= 100 ? 1 : 3 })} ETH`;
// Against the market, from basis points where a negative number is worse for the user.
export const marketText = (bps) => {
  const b = Number(bps);
  if (!Number.isFinite(b)) return null;
  if (Math.abs(b) < 5) return 'at the market price';
  return `${(Math.abs(b) / 100).toFixed(Math.abs(b) < 995 ? 2 : 1)}% ${b < 0 ? 'less' : 'more'} than the market price`;
};
// An error as the lane says it: what the engine wrote when that is a sentence, else a plain line (never an exception's own words).
export const plainError = (e) => {
  const t = String((e && e.message) || e || '').trim();
  if (!t || t.length > 220 || /^(TypeError|ReferenceError|SyntaxError|RangeError|Error:)|undefined|\bat\s\S+:\d+|Failed to fetch|NetworkError|\[object/i.test(t)) return 'Something did not answer just now. Nothing was sent. Try again in a moment.';
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

// How the page reaches the key and the pair client: the trade page's Bitcoin module signs the key in (as the Bitcoin lane does), and fast/pair-wire.js opens the pair
// with it. `getUx` gives the pool wallet, `provider` the connected Ethereum wallet (for a settle sent from it), `onChange` hears the key open or close.
export function bitcoinDoor({ notify, wallet, provider, getUx, onChange }) {
  let bitcoin = null, T = null, loading = null;
  const load = () => (loading ||= (async () => {
    const m = await import(BTC_MODULE);
    bitcoin = m.makeBitcoin({ notify, wallet, onChange, asset: { id: TETH_ID, title: 'tETH on Bitcoin', after: '' } });
    T = await bitcoin.session.load();
    return T;
  })().catch((e) => { loading = null; throw e; }));
  return {
    load,
    get unlocked() { return !!bitcoin?.session.unlocked; },
    async signIn() { await load(); await bitcoin.signIn(); },
    fund() { bitcoin?.fund(); },
    async open() {
      await load();
      const s = bitcoin.session;
      if (!s.unlocked) throw new Error('Open your Tacit wallet first.');
      // (a literal, so that the build finds this module and the ones it imports, and the page's import map gives each its cache token)
      const wire = await import('/fast/pair-wire.js');
      if (typeof wire.openPair !== 'function') throw new Error('Bitcoin and Ethereum swaps are not offered by this version of the page.');
      return wire.openPair({ T, ux: await getUx(), priv: Uint8Array.from(T.wallet.priv), pubHex: s.key.pubHex, wallet: provider, ask: () => {} });
    },
  };
}

export function makeAtomicLane({ host, notify = () => {}, wallet = () => null, provider = () => null, getUx = null, door = null, onState = () => {}, dir = 'b2e', now = nowSecs }) {
  const D = door || bitcoinDoor({ notify, wallet, provider, getUx, onChange: () => { if (L.open) { L.unlocked = D.unlocked; paint(); begin(); } } });
  const L = { dir: dir === 'e2b' ? 'e2b' : 'b2e', amt: '', q: null, qErr: '', bal: { sats: null, eth: null }, recs: [], busy: false, open: false, line: '', cls: '', unlocked: false, loaded: false, terms: null };
  let pair = null, pairP = null, mounted = false, seq = 0, qTimer = 0, poll = 0, refreshTimer = 0, recovered = false, reading = null, began = null;
  const known = new Map();
  const $ = (id) => host.querySelector(`#${id}`);
  const dismissed = () => { try { return new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch { return new Set(); } };

  host.innerHTML = `
    <div class="f" id="a-pay">
      <div class="fh"><span>From</span><span class="where" id="a-pay-at"></span></div>
      <div class="fm"><input class="amt" id="a-amt" inputmode="decimal" placeholder="0" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" aria-label="Amount to pay"><span class="coin" id="a-pay-coin"></span></div>
      <div class="ff"><span id="a-bal" class="num"></span><span class="quick" id="a-quick"></span></div>
    </div>
    <div class="mid"><button class="flip" id="a-flip" type="button" aria-label="Swap the two sides"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v17m0 0-4-4m4 4 4-4M16 21V4m0 0-4 4m4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <div class="f" id="a-get">
      <div class="fh"><span>To</span><span class="where" id="a-get-at"></span></div>
      <div class="fm"><output class="big ph num" id="a-out" for="a-amt">0</output><span class="coin" id="a-get-coin"></span></div>
      <div class="ff"><span id="a-get-bal" class="num"></span><span></span></div>
    </div>
    <dl class="rcpt" id="a-rcpt" hidden></dl>
    <div class="snt atm" id="a-sent" hidden></div>
    <div class="act">
      <button class="go" id="a-go" type="button" disabled>Open your Tacit wallet</button>
      <p class="q" id="a-q" role="status"></p>
    </div>`;

  const say = (h, cls = '') => { L.line = h; L.cls = cls; const q = $('a-q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };
  const sides = () => SIDES[L.dir].map((k) => COINS[k]);
  const amountBase = () => { const v = parseUnits(L.amt, DEC); return v && v > 0n ? v : null; };
  const balOf = (k) => (k === 'btc' ? L.bal.sats : L.bal.eth);
  // What the providers take in a direction, in the pay side's units: the least any asks and the most any can take now; null until they are read
  const termsFor = (d) => {
    const ts = (L.terms || []).map((p) => p && p[d]).filter(Boolean);
    if (!ts.length) return null;
    return { min: ts.reduce((a, t) => (t.min < a ? t.min : a), ts[0].min), max: ts.reduce((a, t) => { const m = t.available != null && t.available < t.max ? t.available : t.max; return m > a ? m : a; }, 0n) };
  };
  const coin = (c) => `<svg class="tk" aria-hidden="true"><use href="#${c.mark}"/></svg>${c.sym}`;

  // ── the pair client and what it reads ──
  const getPair = () => (pairP ||= Promise.resolve(D.open()).then((o) => (pair = o && o.pair ? o.pair : o)).catch((e) => { pairP = null; throw e; }));
  function readMe(quiet = false) {
    if (!pair || !D.unlocked) return Promise.resolve();
    if (reading) return reading;
    reading = (async () => {
      try { const b = await pair.balances(); if (b) L.bal = { sats: b.sats ?? null, eth: b.eth ?? null }; paint(); }
      catch (e) { if (!quiet) say(esc(plainError(e)), 'err'); }
      finally { reading = null; }
    })();
    return reading;
  }
  // The key is open: the pair client is made, swaps from an earlier visit are found again, and what is under way is shown.
  function begin() {
    if (!D.unlocked || !L.open) return Promise.resolve();
    return (began ||= (async () => {
      try {
        say('');
        await getPair();
        L.unlocked = true;
        if (!recovered) { recovered = true; await pair.recover().catch(() => 0); }
        L.recs = await pair.records().catch(() => []);
        pair.providers().then((ps) => { L.terms = ps; paint(); }, () => {});
        paint(); readMe(); requote(true); follow(1000);
        clearInterval(refreshTimer);
        refreshTimer = setInterval(() => { if (!document.hidden && L.open) { readMe(true); if (L.q && !L.busy && L.q.expiresAt - now() < 30) requote(true, true); } }, REFRESH_MS);
      } catch (e) { say(esc(plainError(e)), 'err'); }
      finally { began = null; }
    })());
  }

  // ── the quote ──
  // `keep` leaves the quote shown until the new one lands (the lane's own refresh); an amount, direction or provider change clears it
  function requote(immediate = false, keep = false) {
    clearTimeout(qTimer);
    seq++;
    const amount = amountBase();
    if (!keep || !amount || !pair) { L.q = null; L.qErr = ''; }
    if (!amount || !pair || !D.unlocked) { paint(); return; }
    const run = async () => {
      const my = ++seq, dirNow = L.dir;
      try {
        const q = await pair.quote({ dir: dirNow, amount });
        if (my !== seq) return;
        L.q = q; L.qErr = '';
      } catch (e) { if (my !== seq) return; L.q = null; L.qErr = plainError(e); }
      paint();
    };
    paint();
    if (immediate) run(); else qTimer = setTimeout(run, QUOTE_MS);
  }

  // ── painting ──
  function gate() {
    const amount = amountBase(), q = L.q, [pk] = SIDES[L.dir], bal = balOf(pk), c = COINS[pk];
    if (L.busy) return { label: 'Swapping…', off: true };
    if (!L.loaded) return { label: 'Loading…', off: true };
    if (!D.unlocked) return { label: 'Open your Tacit wallet', act: 'unlock' };
    if (!pair) return { label: 'Loading…', off: true };
    if (!L.amt) return { label: 'Enter an amount', off: true };
    if (!amount) return { label: 'Enter a valid amount', off: true };
    const t = termsFor(L.dir);
    if (t && amount < t.min) return { label: `Minimum ${fmt(t.min)} ${c.sym}`, off: true };
    if (t && amount > t.max) return { label: `Most a provider takes is ${fmt(t.max)} ${c.sym}`, off: true };
    if (bal != null && amount > bal) return { label: `Not enough ${c.sym}${pk === 'eth' ? ' in your private balance' : ''}`, off: true };
    if (L.qErr) return { label: 'No quote', off: true };
    if (!q) return { label: 'Getting a quote…', off: true };
    if (q.blocked) return { label: 'Not at this price', off: true };
    if (L.dir === 'b2e' && bal != null && q.networkFeeSats != null && amount + BigInt(q.networkFeeSats) > bal) return { label: 'Add sats for the Bitcoin fee', act: 'fund' };
    return { label: `Swap ${COINS[SIDES[L.dir][0]].sym} → ${COINS[SIDES[L.dir][1]].sym}`, act: 'swap' };
  }
  function paintRcpt() {
    const rc = $('a-rcpt'), q = L.q;
    if (!q) { rc.hidden = true; rc.innerHTML = ''; return; }
    const mk = marketText(q.vsMarketBps), rows = [
      ['Price', L.dir === 'b2e' ? rateText(q.rate) : `1 ETH = ${tidy((1 / q.rate).toFixed(6))} BTC`, ''],
      ['Market', q.market ? (L.dir === 'b2e' ? rateText(q.market) : `1 ETH = ${tidy((1 / q.market).toFixed(6))} BTC`) : 'not available', q.market ? '' : 'warn'],
      ...(mk ? [['You get', mk, q.blocked ? 'err' : q.vsMarketBps < -100 ? 'warn' : '']] : []),
      // (what a quote costs against the market is the row above: the engine's feeBps is that, not a fee the provider named, so it is not called one here)
      ['Provider', q.provider?.name || 'Provider', ''],
      ...(Number(q.networkFeeSats) > 0 ? [['Bitcoin fee', `about ${Number(q.networkFeeSats).toLocaleString('en-US')} sats`, '']] : []),
      ['Time', etaText(q.etaSecs), ''],
      ['If it stops', L.dir === 'b2e' ? 'your BTC returns to you' : 'your ETH returns to your private balance', ''],
      ...(q.warnings || []).map((w) => ['Note', w, 'warn']),
    ];
    rc.hidden = false;
    rc.innerHTML = rows.map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd${c ? ` class="${c}"` : ''}>${esc(v)}</dd></div>`).join('');
  }
  function paintRecs() {
    const box = $('a-sent'), gone = dismissed(), recs = L.recs.filter((r) => !gone.has(r.id));
    box.hidden = !recs.length;
    box.innerHTML = recs.map((r) => {
      const cls = r.state === 'done' ? 'ok' : r.state === 'working' ? 'wait' : 'warn', [pk, gk] = SIDES[r.dir] || SIDES.b2e;
      // (a swap found again from the key, or one whose provider has not offered yet, may not know a side: only the sides it knows are said)
      const what = r.pay > 0n && r.get > 0n ? `${fmt(r.pay)} ${COINS[pk].sym} → ${r.state === 'done' ? '' : 'about '}${fmt(r.get)} ${COINS[gk].sym}` : r.pay > 0n ? `${fmt(r.pay)} ${COINS[pk].sym}` : r.get > 0n ? `${fmt(r.get)} ${COINS[gk].sym}` : '';
      const eta = r.state === 'working' && r.etaSecs ? etaText(r.etaSecs) : '';
      const back = r.state === 'working' && r.refundAt ? `If it stops, your ${COINS[pk].sym} returns ${untilText(r.refundAt, now())} at the latest.` : '';
      const steps = (r.steps || []).map((s) => `<li class="${esc(s.state)}" data-step="${esc(s.key)}"><i aria-hidden="true"></i>${esc(s.title)}</li>`).join('');
      return `<div class="${cls}" data-rec="${esc(r.id)}"><span><i class="dot" aria-hidden="true"></i><b>${esc(r.title)}</b></span><span>${eta ? esc(eta) : ''}${r.state === 'working' ? '' : ` <button class="link" type="button" data-dismiss="${esc(r.id)}" aria-label="Dismiss">×</button>`}</span>
        ${what ? `<span class="what">${esc(what)}</span>` : ''}${steps ? `<ol class="stp">${steps}</ol>` : ''}${r.detail || back ? `<small>${esc([r.detail, back].filter(Boolean).join(' '))}</small>` : ''}</div>`;
    }).join('');
  }
  function paint() {
    if (!mounted) return;
    const [p, g] = sides(), [pk, gk] = SIDES[L.dir];
    $('a-pay-coin').innerHTML = coin(p); $('a-get-coin').innerHTML = coin(g);
    $('a-pay-coin').setAttribute('aria-label', `Pay with ${p.sym}`); $('a-get-coin').setAttribute('aria-label', `Get ${g.sym}`);
    $('a-pay-at').innerHTML = `<svg class="tk xs" aria-hidden="true"><use href="#${p.at}"/></svg>${esc(p.where)}`;
    $('a-get-at').innerHTML = `<svg class="tk xs" aria-hidden="true"><use href="#${g.at}"/></svg>${esc(g.where)}`;
    const bp = balOf(pk), bg = balOf(gk);
    $('a-bal').textContent = !D.unlocked || !pair ? '' : bp == null ? 'Reading your balance…' : `Balance ${fmt(bp)} ${p.sym}`;
    $('a-get-bal').textContent = !D.unlocked || !pair || bg == null ? '' : `Balance ${fmt(bg)} ${g.sym}`;
    const max = bp != null && bp > 0n ? (pk === 'btc' ? bp - BigInt(L.q?.networkFeeSats ?? LOCK_GUESS_SATS) : bp) : 0n;
    $('a-quick').innerHTML = max > 0n ? [25, 50, 100].map((n) => `<button type="button" data-quick="${tidy(plain((max * BigInt(n)) / 100n, DEC))}">${n === 100 ? 'Max' : `${n}%`}</button>`).join('') : '';
    const out = $('a-out'), q = L.q;
    if (q) { out.textContent = fmt(q.get); out.classList.remove('ph'); } else { out.textContent = '0'; out.classList.add('ph'); }
    paintRcpt(); paintRecs();
    const gt = gate(), go = $('a-go');
    go.textContent = gt.label; go.disabled = !!gt.off; go.dataset.act = gt.act || '';
    if (L.qErr && !L.busy) say(esc(L.qErr), 'err');
    else if (L.q?.blocked && !L.busy) say(esc(L.q.blocked.charAt(0).toUpperCase() + L.q.blocked.slice(1) + (/[.!?]$/.test(L.q.blocked) ? '' : '.')), 'err');
    else if (L.cls === 'err' && !L.busy && !L.sticky) say('');
  }

  // ── actions ──
  async function unlock() {
    try { await D.signIn(); } catch (e) { if (!e?.unlockCancelled) say(esc(plainError(e)), 'err'); return; }
    L.unlocked = D.unlocked; say(''); paint(); await begin();
  }
  async function swap() {
    const q = L.q; if (!q || q.blocked || L.busy) return;
    if (q.expiresAt - now() < 5) { say('That quote has run out. Getting a new one.'); requote(true); return; }
    L.busy = true; L.sticky = false; say('Starting the swap…'); paint();
    try {
      const r = await pair.start(q);
      L.amt = ''; $('a-amt').value = ''; L.q = null; L.qErr = '';
      say('');
      L.recs = await pair.pump().catch(async () => pair.records().catch(() => L.recs));
      known.set(r.id, 'working');
      onState();
      follow(POLL_MS);
    } catch (e) { say(esc(plainError(e)), 'err'); L.sticky = true; }
    finally { L.busy = false; paint(); }
    readMe(true);
  }
  // Swaps under way are stepped while the lane is open and the tab is seen; one that ends is said once.
  function follow(wait = POLL_MS) {
    clearTimeout(poll);
    if (!pair || !L.open || !L.recs.some((r) => r.state === 'working')) return;
    poll = setTimeout(async () => {
      if (!document.hidden) {
        try {
          const next = await pair.pump();
          for (const r of next) {
            const was = known.get(r.id);
            if (was === 'working' && r.state !== 'working') { notify(r.state === 'done' ? 'Swap done' : 'Swap returned'); readMe(true); }
            known.set(r.id, r.state);
          }
          L.recs = next; paintRecs();
        } catch { /* the next pass */ }
      }
      follow();
    }, wait);
  }

  // ── events ──
  const setAmt = (v) => { L.amt = v; L.sticky = false; if (L.cls === 'err' && !L.busy) say(''); onState(); requote(); };
  host.addEventListener('input', (e) => { if (e.target.id === 'a-amt') setAmt(e.target.value.trim()); });
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'a-amt' && !$('a-go').disabled) $('a-go').click(); });
  host.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#a-flip')) { if (L.busy) return; L.dir = L.dir === 'b2e' ? 'e2b' : 'b2e'; L.amt = ''; $('a-amt').value = ''; L.q = null; L.qErr = ''; seq++; L.sticky = false; say(''); onState(); paint(); return; }
    const dm = t.closest('[data-dismiss]');
    if (dm) { const s = dismissed(); s.add(dm.dataset.dismiss); try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...s].slice(-50))); } catch { /* storage is a convenience */ } paintRecs(); return; }
    const qk = t.closest('[data-quick]'); if (qk) { $('a-amt').value = qk.dataset.quick; setAmt(qk.dataset.quick); return; }
    if (t.closest('#a-go')) { const a = $('a-go').dataset.act; if (a === 'unlock') unlock(); else if (a === 'fund') D.fund(); else if (a === 'swap') swap(); }
  });

  return {
    // The lane opens: the key is looked for, and with one open the pair client is made and what is under way is shown.
    async show() {
      L.open = true; mounted = true; paint();
      try { await D.load(); } catch (e) { say(`Could not load this lane: ${esc(plainError(e))}`, 'err'); return; }
      L.loaded = true; L.unlocked = D.unlocked; paint();
      if (D.unlocked) await begin();
    },
    hide() { L.open = false; clearInterval(refreshTimer); clearTimeout(poll); clearTimeout(qTimer); },
    // the pair and amount a link names
    set({ dir: d, amt } = {}) {
      if (d && d !== L.dir && !L.busy) { L.dir = d === 'e2b' ? 'e2b' : 'b2e'; L.q = null; L.qErr = ''; seq++; }
      if (amt !== undefined && !L.busy) { L.amt = String(amt); $('a-amt').value = L.amt; }
      if (mounted) { paint(); if (L.amt) requote(true); }
    },
    state: () => ({ dir: L.dir, amt: L.amt }),
    get unlocked() { return D.unlocked; },
  };
}
