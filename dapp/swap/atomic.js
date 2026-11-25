// The swap card's Bitcoin and Ethereum lane: real BTC for ETH, and ETH for BTC, swapped with a liquidity provider so that neither side holds the other's funds at
// any step. The card loads this when the lane is first opened, and shows the lane's switch only when providers of the pair exist (swap/atomic-probe.js).
// Nothing here builds or signs a transaction: the pair client does (fastbridge-pair.js, opened by fast/pair-wire.js openPair) with the Tacit key.
//
//   makeAtomicLane({ host, notify, wallet, provider, getUx, door, onState, dir, now, recsHost, market }) -> { show, hide, set, state, get unlocked, get looking, records, keep }
//
//   door   how the key and the pair client are reached: { load(), unlocked, signIn(), fund(), open() -> { pair } | pair }. The page's door is made here from
//          the trade page's Bitcoin module (the same sign-in as the Bitcoin lane); a test passes its own.
//   pair   quote({ dir, amount }), start(q), pump(), records(), recover(), balances(), reference(): see the contract in fastbridge-pair.js. A swap is 'b2e'
//          (pay BTC, get ETH) or 'e2b'; amounts are in sats and in the pool's ETH unit (8 places, 1e-8 ETH).
//   recsHost  where the swaps are listed, when the page shows them apart from the lane (the /btc/ page); else under the lane
//   market    () -> what swap/atomic-market.js readMarket gives: the providers' limits and an estimate before the wallet is open (a test passes its own)
//   shield    how ETH is added to the private balance from an Ethereum wallet when a swap of ETH is short of it (btc/add-eth.js makeAddEth: start, resume,
//             pending, relayWords, warm), or null, and the button then says the balance is short. With it, a swap of ETH the private balance is short of is
//             one press: the shortfall made private and the swap started on it (see "one press" below). onBal(bal) hears each read of the balances; onOpen(opened)
//             the pair opener's answer once the key is open (its `bitcoin` is what a page sends the address's own sats with).
//   payout    where the ETH of a swap of BTC goes (btc/payout.js makePayout), or null: with it the lane asks "Receive as" (kept private, or sent on to an
//             Ethereum address once it has arrived) and carries the choice out. A swap of BTC the address is short of is one press when a Bitcoin wallet is in
//             this browser (the door's sendIn: see "one press of BTC" below).
//   onNext    ({ act: 'send', sats }) from a finished swap of ETH for BTC, ({ act: 'withdraw', id, units }) from one of BTC whose ETH was kept private: the page sends the BTC that arrived (its card also links the Bitcoin order book of TAC and
//             the wallet sheet); null shows no next steps
//
// A swap under way is stepped while the lane is open, the tab hidden or not (a hidden tab's timers run about once a minute, and a claim or a take that waits for the tab
// to be seen again can miss its window); and the page asks before it is left while one is under way.
import { esc, fmtUnits, parseUnits, plain } from '/trade/util.js?cb=9c8b4133';

const BTC_MODULE = '/trade/btc.js?cb=d4694338';
const PAIR_WIRE = '/fast/pair-wire.js?cb=d4b93d58';
const TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const DEC = 8, POLL_MS = 5000, HIDDEN_POLL_MS = 20000, QUOTE_MS = 300, REFRESH_MS = 15000, MARKET_MS = 60000, PEEK_MS = 3000;
// A swap starts only on a quote with more than two minutes left (fastbridge-pair.js quoteMarginSecs): the lane renews the quote it shows before then, and a press on
// one too near its end asks for a new one first
const RENEW_SECS = 150, START_SECS = 125;
const MARKET_MODULE = '/swap/atomic-market.js?cb=7b7f1698';
const COINS = { btc: { sym: 'BTC', mark: 'tk-btc', at: 'c-btc', where: 'Bitcoin' }, eth: { sym: 'ETH', mark: 'tk-teth', at: 'c-eth', where: 'Ethereum, private' } };
const SIDES = { b2e: ['btc', 'eth'], e2b: ['eth', 'btc'] };
const DISMISS_KEY = 'tacit-atomic-dismissed-v1';
const LOCK_GUESS_SATS = 3000;                                     // what Max keeps back for the Bitcoin fee until a quote has said what it is
const SHIELD_NOTE = 'The deposit from your wallet is public. The swap and your Bitcoin address are not linked to it on chain.';
const ONE_PRESS = 'One wallet transaction. Your ETH is made private first.';
const ONE_PRESS_BTC = 'One payment from your Bitcoin wallet, straight into the swap.';
const BTC_NOTE = 'A Bitcoin payment is public, as every one is. The ETH arrives private, in your Tacit wallet.';
// A swap of ETH for BTC started with one press (the ETH made private first): its first step, then the swap's own (fastbridge-pair.js names them the same way)
const PRIVATE_STEP = 'Made private';
const E2B_STEPS = ['They lock BTC', 'You lock ETH', 'They claim ETH', 'You take BTC'];
// About how long a press's deposit takes to be mined and the provider to be asked, before the swap's own time (fastbridge-pair.js: 1710 s from the ask)
const PRESS_SECS = 60, E2B_SECS = 1710, B2E_SECS = 1050;
const B2E_STEPS = ['You lock BTC', 'They lock ETH', 'You claim ETH', 'They take BTC'];
// Where a finished swap's BTC can go next on Tacit: the Bitcoin order book of TAC (the trade page opens the same key in this tab), and the wallet sheet,
// whose "Use this wallet's Bitcoin and Ethereum elsewhere" gives the Bitcoin key for another wallet
const BTC_BOOK = '/trade/tac/?lane=btc', WALLET_SHEET = '/#wallet';
// The ETH (pool units) to add so a lock of `amount` can be made: a lock spends one note of exactly the amount, or notes that hold it and the relay's fee of cutting
// them, and `available` is what the notes hold less that fee. So with something available, the shortfall; with nothing available, the amount itself, deposited as
// one note of exactly that amount, which needs no cut. (btc/add-eth.js keeps the same rule, and its tests pin both.)
export function addUnits(amount, available) { const a = BigInt(amount), have = available == null ? 0n : BigInt(available); return a <= 0n || have >= a ? 0n : have > 0n ? a - have : a; }

const tidy = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
export const fmt = (v) => tidy(fmtUnits(v, DEC, DEC));
const nowSecs = () => Math.floor(Date.now() / 1000);

// About how long a swap takes, in words: a Bitcoin block or two, then the pool's settle.
export const etaText = (secs) => {
  const m = Math.max(1, Math.round(Number(secs) / 60));
  return Number(secs) < 90 ? 'about a minute' : m < 90 ? `about ${m} minutes` : `about ${Math.round(m / 60)} hours`;
};
// The time a swap has left, in words: while a Bitcoin block is still ahead, a range, since a block comes about every ten minutes but some come much sooner
// or later (the live swaps of ETH for BTC of 11-25 took 19 and 26 minutes, those of BTC for ETH about 13); nearer the end, one figure.
export const etaSpan = (secs) => {
  const s = Number(secs);
  if (!(s >= 900)) return etaText(s);
  const lo = Math.max(5, Math.round((s * 0.7) / 300) * 5), hi = Math.max(lo + 5, Math.round((s * 1.1) / 300) * 5);
  return `about ${lo}\u2060–\u2060${hi} minutes`;                         // (kept on one line: the range does not break at its dash)
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
// An error as the lane says it: what the engine wrote when that is a sentence, with a capital, else a plain line (never an exception's own words, nor a module's tag)
export const plainError = (e) => {
  let t = String((e && e.message) || e || '').trim();
  if (/^fastbridge: the pool notes hold \d+, short of \d+/.test(t)) t = 'your private ETH does not cover that amount';
  t = t.replace(/^[a-z-]+: (?=[a-z])/, '');
  if (!t || t.length > 220 || /^(TypeError|ReferenceError|SyntaxError|RangeError|Error:)|undefined|\bat\s\S+:\d+|Failed to fetch|NetworkError|\[object/i.test(t)) return 'Something did not answer just now. Nothing was sent. Try again in a moment.';
  // (the page's sentences name no address, link, key or markup: a line that does came from elsewhere, and is not said)
  if (/[<>]|https?:|\b(?:bc1|tb1)[a-z0-9]{6,}|\b0x[0-9a-f]{6,}|[0-9a-f]{16,}|[13][a-km-zA-HJ-NP-Z1-9]{25,}/i.test(t)) return 'The provider could not do that just now. Nothing was sent. Try again in a moment.';
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
// A time later today, tomorrow or on a date, in the reader's own clock, for the line that says when to be back
export const clockText = (at, now = nowSecs()) => {
  const d = new Date(Number(at) * 1000), n = new Date(now * 1000), hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), diff = Math.round((day(d) - day(n)) / 86400000);
  return diff === 0 ? `${hm} today` : diff === 1 ? `${hm} tomorrow` : `${hm} on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
};

// How the page reaches the key and the pair client: the trade page's Bitcoin module signs the key in (as the Bitcoin lane does), and fast/pair-wire.js opens the pair
// with it. `getUx` gives the pool wallet, `provider` the connected Ethereum wallet (for a settle sent from it), `onChange` hears the key open or close.
export function bitcoinDoor({ notify, wallet, provider, getUx, onChange, busy = null }) {
  let bitcoin = null, T = null, loading = null;
  const load = () => (loading ||= (async () => {
    const m = await import(BTC_MODULE);
    // (`busy`: a swap under way counts as use, so the key is not locked for want of a click while the page steps it)
    bitcoin = m.makeBitcoin({ notify, wallet, onChange, busy, asset: { id: TETH_ID, title: 'tETH on Bitcoin', after: '' }, purpose: 'swap BTC and ETH' });
    T = await bitcoin.session.load();
    return T;
  })().catch((e) => { loading = null; throw e; }));
  return {
    load,
    get unlocked() { return !!bitcoin?.session.unlocked; },
    // which key is open: the pair client is one key's, and is dropped when another opens
    get pubHex() { return bitcoin?.session.unlocked ? bitcoin.session.key?.pubHex || null : null; },
    async signIn() { await load(); await bitcoin.signIn(); },
    fund(o) { bitcoin?.fund(o); },
    // a Bitcoin wallet in this browser pays sats to the key's own address, in one prompt of its own (trade/btc.js sendIn)
    canSendIn() { return !!(bitcoin?.session.unlocked && bitcoin.canSendIn?.()); },
    sendIn(sats) { if (!bitcoin?.sendIn) throw new Error('No Bitcoin wallet in this browser.'); return bitcoin.sendIn(sats); },
    // the open key, for a deposit into its private balance: its private bytes (a copy), its public key and how it was opened
    key() { const s = bitcoin?.session; if (!s?.unlocked || !T?.wallet?.priv) return null; return { priv: Uint8Array.from(T.wallet.priv), pubHex: s.key.pubHex, mode: s.key.mode || null, address: s.key.address || null }; },
    // the pair opener's modules, read before the key opens, so the lane is ready sooner after it does
    warm() { return import(PAIR_WIRE).catch(() => {}); },
    async open() {
      await load();
      const s = bitcoin.session;
      if (!s.unlocked) throw new Error('Open your Tacit wallet first.');
      const wire = await import(PAIR_WIRE);
      if (typeof wire.openPair !== 'function') throw new Error('Bitcoin and Ethereum swaps are not offered by this version of the page.');
      return wire.openPair({ T, ux: await getUx(), priv: Uint8Array.from(T.wallet.priv), pubHex: s.key.pubHex, wallet: provider, ask: () => {} });
    },
  };
}

export function makeAtomicLane({ host, notify = () => {}, wallet = () => null, provider = () => null, getUx = null, door = null, onState = () => {}, dir = 'b2e', now = nowSecs, recsHost = null, market = null, onRecs = () => {}, shield = null, onBal = () => {}, onOpen = () => {}, onNext = null, payout = null }) {
  // (a swap under way, or a press that is still making the ETH private, keeps the key open: the page has steps to take for it)
  const D = door || bitcoinDoor({ notify, wallet, provider, getUx, onChange: () => keyChanged(), busy: () => !!L.chain || !!L.adding || L.recs.some((r) => r.state === 'working') });
  const L = { dir: dir === 'e2b' ? 'e2b' : 'b2e', amt: '', q: null, qErr: '', bal: { sats: null, eth: null, ethHeld: null, pending: 0n }, recs: [], busy: false, open: false, line: '', cls: '', unlocked: false, loaded: false, terms: null, mk: null, fits: null, chain: null, payTo: { mode: 'private', address: null } };
  let fundAsk = null, addAsk = null, pair = null, pairP = null, pairKey = null, gen = 0, opened = null, mounted = false, seq = 0, qTimer = 0, poll = 0, refreshTimer = 0, marketTimer = 0, recovered = false, recovering = null, lookFailed = false, reading = null, began = null;
  // the swaps started with one press, by id: their first step (the ETH made private) is shown before the swap's own, until the deposit has landed
  const chains = new Map();
  const readMarket = market || (() => import(MARKET_MODULE).then((M) => M.readMarket().then((m) => ({ ...m, estimate: (d, a) => M.estimate(m, d, a) }))));
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
    <div class="payto" id="a-payto" hidden></div>
    <div class="act">
      <button class="go" id="a-go" type="button" disabled>Open your Tacit wallet</button>
      <p class="q" id="a-q" role="status"></p>
    </div>`;

  // an amount's length, for a page that sizes it to its field (--n)
  const fit = (el) => el.style.setProperty('--n', String(Math.max(5, String(el.tagName === 'INPUT' ? el.value : el.textContent).length)));
  const say = (h, cls = '') => { L.line = h; L.cls = cls; const q = $('a-q'); q.className = `q${cls ? ` ${cls}` : ''}`; q.innerHTML = h; };
  const sides = () => SIDES[L.dir].map((k) => COINS[k]);
  const amountBase = () => { const v = parseUnits(L.amt, DEC); return v && v > 0n ? v : null; };
  // what can go into a swap (confirmed coins; notes less the relay fee to cut one), and what the wallet holds, which is what the balance line says
  const balOf = (k) => (k === 'btc' ? L.bal.sats : L.bal.eth);
  const heldOf = (k) => (k === 'btc' ? L.bal.sats : (L.bal.ethHeld ?? L.bal.eth));
  // What the providers take in a direction, in the pay side's units: the least any asks and the most any can take now; null until they are read
  // (before the wallet is open, the terms are the ones the ads name, read with the market)
  const termsFor = (d) => {
    const ts = (L.terms || L.mk?.providers || []).map((p) => p && p[d]).filter(Boolean);
    if (!ts.length) return null;
    return { min: ts.reduce((a, t) => (t.min < a ? t.min : a), ts[0].min), max: ts.reduce((a, t) => { const m = t.available != null && t.available < t.max ? t.available : t.max; return m > a ? m : a; }, 0n) };
  };
  const coin = (c) => `<svg class="tk" aria-hidden="true"><use href="#${c.mark}"/></svg>${c.sym}`;

  // ── the pair client and what it reads ──
  // The pair client is the open key's: it is made for that key (pairKey) and dropped when the wallet locks or another key opens (keyChanged), so nothing of one
  // key's (its pair client, balances, swaps or quote) is used or shown under another.
  const keyOf = () => (D.unlocked ? (D.pubHex === undefined ? 'open' : D.pubHex) : null);
  const getPair = () => {
    if (pairP && pairKey !== keyOf()) dropPair();
    const g = gen;
    return (pairP ||= (pairKey = keyOf(), Promise.resolve(D.open()).then((o) => {
      if (g !== gen) throw new Error('Your Tacit wallet changed. Open it again.');
      opened = o && o.pair ? o : null; pair = o && o.pair ? o.pair : o;
      try { onOpen(opened); } catch { /* a page's hook does not stop the lane */ }
      return pair;
    }).catch((e) => { if (g === gen) { pairP = null; pairKey = null; } throw e; })));
  };
  function dropPair() {
    gen++;
    pair = null; pairP = null; pairKey = null; opened = null; began = null; recovered = false; recovering = null; lookFailed = false; reading = null;
    clearInterval(refreshTimer); clearTimeout(poll); clearTimeout(qTimer);
    seq++; known.clear();
    L.bal = { sats: null, eth: null, ethHeld: null, pending: 0n }; L.recs = []; L.q = null; L.qErr = ''; L.unread = null; L.fits = null; L.terms = null; L.busy = false; L.chain = null;
    chains.clear();
  }
  // The wallet locked, or opened with a key: a key other than the pair client's drops it, and its swaps are no longer listed or stepped. A swap of the key that
  // was under way is not stepped by another: the page says to open that key again (its records are kept under it, and are found again when it opens).
  function keyChanged() {
    const k = keyOf();
    if (pairKey !== null && k !== pairKey) {
      const wasWorking = L.recs.some((r) => r.state === 'working');
      dropPair();
      L.sticky = wasWorking;
      if (mounted) { paint(); say(wasWorking ? esc(k ? 'A swap of the wallet that was open is under way. Open that wallet again to finish it.' : 'A swap is under way. Open the same Tacit wallet again to finish it.') : '', wasWorking ? 'warn' : ''); }
    }
    if (L.open) { L.unlocked = D.unlocked; paint(); begin(); }
  }
  // the providers and the market, read with no wallet open: limits and an estimate to show before the quote (read again each minute until the pair client has its own)
  function readMk() {
    clearTimeout(marketTimer);
    if (!L.open) return;
    Promise.resolve().then(readMarket).then((m) => { if (m) { L.mk = m; paint(); } }, () => {})
      .finally(() => { if (L.open && !pair) marketTimer = setTimeout(readMk, MARKET_MS); });
  }
  function readMe(quiet = false) {
    if (!pair || !D.unlocked) return Promise.resolve();
    if (reading) return reading;
    const g = gen, p = pair;
    reading = (async () => {
      try {
        const b = await p.balances();
        if (g !== gen) return;
        // (what is available keeps back the fee of cutting a note, so a note of exactly the amount reads as short of it: whether it covers the lock is asked
        // before the balance is shown, or the button would offer to add that fee for a moment)
        const want = L.dir === 'e2b' ? amountBase() : null;
        if (b && want && b.eth != null && want > b.eth && p.covers && !(L.fits && L.fits.amt === want && L.fits.eth === b.eth)) { const ok = await p.covers(want).catch(() => false); if (g !== gen) return; L.fits = { amt: want, ok: !!ok, eth: b.eth }; }
        if (b) L.bal = { sats: b.sats ?? null, eth: b.eth ?? null, ethHeld: b.ethHeld ?? null, pending: b.pendingSats ?? 0n };
        // a side the explorers or nodes did not answer for is said as such (the lane's refresh reads it again), not left as 'reading'
        L.unread = { btc: !b || b.sats == null, eth: !b || b.eth == null };
        try { onBal({ ...L.bal }); } catch { /* a page's hook does not stop the lane */ }
        paint();
      }
      // (a read that throws leaves both sides unread: the button offers to read again, and the lane's refresh tries again by itself)
      catch (e) { if (g !== gen) return; L.unread = { btc: L.bal.sats == null, eth: L.bal.eth == null }; paint(); if (!quiet) say(esc(plainError(e)), 'err'); }
      finally { if (g === gen) reading = null; }
    })();
    return reading;
  }
  // The swaps of an earlier visit, or of another browser, are found again from the key (pair.recover: the key's Bitcoin locks and its pool locks, each then read
  // to its end on the chains), which can take a minute or two. Meanwhile what is found is listed as it is found (a swap still being read says 'Checking'), the
  // page says it is still looking rather than that there are none, and a look that fails is made again by the lane's refresh. Swaps are stepped once it ends.
  function findPast() {
    if (recovered || !pair) return Promise.resolve();
    if (recovering) return recovering;
    lookFailed = false;
    let live = true;
    const g = gen, p = pair;
    const peek = setInterval(() => { if (g !== gen) { clearInterval(peek); return; } p.records().then((rs) => { if (live && g === gen && Array.isArray(rs)) { L.recs = rs; paintRecs(); } }, () => {}); }, PEEK_MS);
    recovering = (async () => {
      let ok = false;
      try { await p.recover(); ok = true; } catch { /* looked for again by the refresh */ }
      finally { live = false; clearInterval(peek); }
      if (g !== gen) return;
      recovered = ok; lookFailed = !ok;
      const recs = await p.records().catch(() => L.recs);
      if (g !== gen) return;
      L.recs = recs;
      recovering = null;
      paint(); follow(1000);
    })();
    paint();
    return recovering;
  }
  // The key is open: the pair client is made, the swaps this browser keeps are listed, those of an earlier visit are looked for, and what is under way is shown.
  function begin() {
    if (!D.unlocked || !L.open) return Promise.resolve();
    const g = gen;
    return (began ||= (async () => {
      try {
        if (!L.sticky) say('');
        await getPair();
        if (g !== gen) return;
        L.unlocked = true;
        // the balance is read while the swaps of an earlier visit are looked for, not after: the two read the same pool history, and the button waits on the balance
        paint(); readMe(); requote(true);
        const k0 = shield && D.key ? D.key() : null;
        if (k0 && !L.adding && shield.pending(k0.pubHex)) resumeAdd();
        const p = pair, recs = await p.records().catch(() => L.recs);
        if (g !== gen) return;
        L.recs = recs;
        p.providers().then((ps) => { if (g === gen) { L.terms = ps; paint(); } }, () => {});
        paint(); payDue();
        clearInterval(refreshTimer);
        // (a press under way renews its own quote when it starts the swap: the refresh leaves it be)
        refreshTimer = setInterval(() => { if (!document.hidden && L.open) { readMe(true); payDue(); if (!recovered) findPast(); if (L.q && !L.busy && !L.chain && L.q.expiresAt - now() < RENEW_SECS) requote(true, true); } }, REFRESH_MS);
        if (recovered) follow(1000); else await findPast();
      } catch (e) { if (g === gen) say(esc(plainError(e)), 'err'); }
      finally { if (g === gen) began = null; }
    })());
  }

  // ── the quote ──
  // A quote for the same swap that gives less than the one seen, or costs more on Bitcoin: never swapped on unseen (the button asks for it to be accepted)
  const worseThan = (was, q) => !!was && was.dir === q.dir && was.pay === q.pay && !q.blocked && (q.get < was.get || Number(q.networkFeeSats ?? 0) > Number(was.networkFeeSats ?? 0) * 1.1 + 100 || Number(q.takeFeeSats ?? 0) > Number(was.takeFeeSats ?? 0) * 1.1 + 100);
  // `keep` leaves the quote shown until the new one lands (the lane's own refresh); an amount, direction or provider change clears it
  function requote(immediate = false, keep = false) {
    clearTimeout(qTimer);
    seq++;
    const amount = amountBase();
    if (!keep || !amount || !pair) { L.q = null; L.qErr = ''; }
    if (!amount || !pair || !D.unlocked) { paint(); return; }
    const p = pair;
    const run = async () => {
      if (p !== pair) return;
      const my = ++seq, dirNow = L.dir;
      try {
        // more than `available` says (it keeps back the fee of a cut) can still be locked from a note of exactly the amount: asked of the pool side, not guessed
        if (dirNow === 'e2b' && p.covers && L.bal.eth != null && amount > L.bal.eth) { const ok = await p.covers(amount).catch(() => false); if (my !== seq) return; L.fits = { amt: amount, ok: !!ok }; }
        const q = await p.quote({ dir: dirNow, amount });
        if (my !== seq) return;
        // a renewed quote that gives less than the one shown (or costs more on Bitcoin) is not swapped on unseen: the button asks for the new numbers to be accepted
        const was = keep ? L.q : null;
        const worse = worseThan(was, q);
        L.q = worse ? { ...q, renewed: { get: was.get } } : (was && was.renewed && q.dir === was.dir && q.pay === was.pay && !q.blocked && q.get < was.renewed.get ? { ...q, renewed: was.renewed } : q); L.qErr = '';
        if (L.q.renewed) { L.sticky = true; say(esc(`The quote was renewed and gives less: ${fmt(L.q.renewed.get)} → ${fmt(q.get)} ${COINS[SIDES[q.dir][1]].sym}${q.dir === 'b2e' && Number(q.networkFeeSats) > 0 ? `, Bitcoin fee about ${Number(q.networkFeeSats).toLocaleString('en-US')} sats` : ''}. Accept the new price to go on.`), 'warn'); }
      } catch (e) { if (my !== seq) return; L.q = null; L.qErr = plainError(e); }
      paint();
    };
    paint();
    if (immediate) run(); else qTimer = setTimeout(run, QUOTE_MS);
  }

  // ── painting ──
  // `fund` is what the Add BTC press asks the wallet for: the sats short and the total the address must hold
  function gate() {
    const amount = amountBase(), q = L.q, [pk] = SIDES[L.dir], bal = balOf(pk), c = COINS[pk], C = L.chain;
    // one press under way: its own steps, or the new numbers waiting for a yes (a renewed quote that gives less, or a large Bitcoin fee)
    if (C && C.phase === 'paused') return { label: C.why === 'fee' ? 'Accept the Bitcoin fee' : 'Accept the new price', act: 'chainGo' };
    if (C) return { label: C.phase === 'adding' && !C.mined ? 'Adding your ETH privately…' : 'Starting the swap…', off: true };
    if (L.busy) return { label: 'Swapping…', off: true };
    if (!L.loaded) return { label: 'Loading…', off: true };
    if (!D.unlocked) return { label: 'Open your Tacit wallet', act: 'unlock' };
    if (!pair) return { label: 'Loading…', off: true };
    // nothing is swapped against a balance not read yet; a read that failed is offered again (the refresh also tries again by itself)
    if (bal == null) return L.unread?.[pk] ? { label: 'Read the balance again', act: 'reread' } : { label: 'Reading your balance…', off: true };
    // ETH on its way into the private balance: nothing of ETH is swapped until it has landed
    if (L.adding && L.dir === 'e2b') return { label: 'Adding ETH to your private balance…', off: true };
    // an address with no BTC is not a dead end: the press opens the way to add some
    if (!L.amt) return L.dir === 'b2e' && L.bal.sats === 0n && !(L.bal.pending > 0n) ? { label: 'Add BTC', act: 'fund', fund: {} } : { label: 'Enter an amount', off: true };
    if (!amount) return { label: 'Enter a valid amount', off: true };
    const t = termsFor(L.dir);
    // a provider that holds less than its own minimum cannot take any swap: say so, instead of a minimum nobody can meet and then a maximum under it
    if (t && t.max < t.min) return { label: 'No provider has enough to swap right now', off: true };
    if (t && amount < t.min) return { label: `Minimum ${fmt(t.min)} ${c.sym}`, off: true };
    if (t && amount > t.max) return { label: `Most a provider takes is ${fmt(t.max)} ${c.sym}`, off: true };
    const held = heldOf(pk), exact = pk === 'eth' && L.fits && L.fits.amt === amount && L.fits.ok;
    if (bal != null && amount > bal && !exact) {
      if (pk === 'btc') {
        // with a Bitcoin wallet in this browser, one press pays what is short into the address and swaps it (see "one press" below); else the way to add it
        if (D.canSendIn?.()) {
          if (L.qErr) return { label: 'No quote', off: true };
          if (!q) return { label: 'Getting a quote…', off: true };
          const p1 = pressGate(q, amount, bal); if (p1) return p1;
        }
        const need = amount + BigInt(q?.networkFeeSats ?? LOCK_GUESS_SATS);
        return { label: `Add ${fmt(need - bal)} BTC`, act: 'fund', fund: { sats: Number(need - bal), need: Number(need) } };
      }
      // With a way to add ETH from an Ethereum wallet, one press makes the shortfall private (exactly: addUnits) and swaps: so it asks for a quote fit to
      // swap on first, as the swap's own press does. Else the button says what is short.
      const add = shield ? addUnits(amount, bal) : 0n;
      if (add > 0n) {
        if (L.qErr) return { label: 'No quote', off: true };
        if (!q) return { label: 'Getting a quote…', off: true };
        if (q.blocked) return { label: 'Not at this price', off: true };
        if (q.renewed) return { label: 'Accept the new price', act: 'accept' };
        if (q.highFee && !q.feeAccepted) return { label: 'Accept the Bitcoin fee', act: 'acceptFee' };
        return { label: `Swap ${fmt(amount)} ETH → BTC`, act: 'oneclick', add };
      }
      return { label: held != null && amount <= held ? `${fmt(held - bal)} ETH stays back for the pool’s fee` : 'Not enough ETH in your private balance', off: true };
    }
    if (L.qErr) return { label: 'No quote', off: true };
    if (!q) return { label: 'Getting a quote…', off: true };
    if (q.blocked) return { label: 'Not at this price', off: true };
    if (q.renewed) return { label: 'Accept the new price', act: 'accept' };
    if (q.highFee && !q.feeAccepted) return { label: 'Accept the Bitcoin fee', act: 'acceptFee' };
    if (L.dir === 'b2e' && bal != null && q.networkFeeSats != null && amount + BigInt(q.networkFeeSats) > bal) {
      if (D.canSendIn?.()) { const p1 = pressGate(q, amount, bal); if (p1) return p1; }
      const need = amount + BigInt(q.networkFeeSats); return { label: 'Add sats for the Bitcoin fee', act: 'fund', fund: { sats: Number(need - bal), need: Number(need) } };
    }
    if (payout && L.dir === 'b2e' && L.payTo.mode !== 'private' && !L.payTo.address) return { label: 'Enter the Ethereum address', off: true };
    return { label: `Swap ${COINS[SIDES[L.dir][0]].sym} → ${COINS[SIDES[L.dir][1]].sym}`, act: 'swap' };
  }
  // One press of BTC: the quote must be fit to swap on (as the swap's own press asks), and the press pays the amount and the lock's fee, with half the fee
  // again in hand (a fee that rises before the lock is made; what is left stays at the address), less what the address holds already
  function pressGate(q, amount, bal) {
    if (q.blocked) return { label: 'Not at this price', off: true };
    if (q.renewed) return { label: 'Accept the new price', act: 'accept' };
    if (q.highFee && !q.feeAccepted) return { label: 'Accept the Bitcoin fee', act: 'acceptFee' };
    if (L.payTo.mode !== 'private' && !L.payTo.address) return { label: 'Enter the Ethereum address', off: true };
    const fee = BigInt(q.networkFeeSats ?? LOCK_GUESS_SATS), send = amount + (fee * 3n + 1n) / 2n - (bal ?? 0n);
    if (send <= 546n) return null;
    return { label: `Swap ${fmt(amount)} BTC → ETH`, act: 'bpress', fund: { sats: Number(send) } };
  }
  const rows = (rs) => rs.map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd${c ? ` class="${c}"` : ''}>${esc(v)}</dd></div>`).join('');
  // Before a quote: the market, what the providers take and hold, and who; the firm price comes once the wallet is open
  function preview() {
    const m = L.mk, t = termsFor(L.dir), [pk] = SIDES[L.dir], c = COINS[pk], amount = amountBase();
    if (!m || (!m.rate && !t)) return null;
    const ts = (m.providers || []).map((p) => p[L.dir]).filter(Boolean), now0 = ts.reduce((a, s) => { const n = s.available != null && s.available < s.max ? s.available : s.max; return n >= s.min && n > a ? n : a; }, 0n);
    const out = [];
    if (m.rate) out.push(['Market', L.dir === 'b2e' ? rateText(m.rate) : `1 ETH = ${tidy((1 / m.rate).toFixed(6))} BTC`, '']);
    if (!ts.length) out.push(['Providers', 'none online this way right now', 'warn']);
    else {
      // the limits the ads name (what a provider holds now is the next row)
      const lo = ts.reduce((a, x) => (x.min < a ? x.min : a), ts[0].min), hi = ts.reduce((a, x) => (x.max > a ? x.max : a), 0n);
      out.push(['Limits', `${fmt(lo)} to ${fmt(hi)} ${c.sym}`, amount && (amount < t.min || amount > t.max) ? 'warn' : '']);
      out.push(['Available now', now0 > 0n ? `up to ${fmt(now0)} ${c.sym}` : 'none, until a provider refills', now0 > 0n ? '' : 'warn']);
      out.push([ts.length === 1 ? 'Provider' : 'Providers', ts.length === 1 ? (m.providers.find((p) => p[L.dir])?.name || 'Provider') : `${ts.length} online`, '']);
    }
    if (amount && !D.unlocked) out.push(['Firm price', 'once your wallet is open', '']);
    return out;
  }
  function paintRcpt() {
    const rc = $('a-rcpt'), q = L.q;
    if (!q) { const pv = !pair ? preview() : null; rc.hidden = !pv; rc.innerHTML = pv ? rows(pv) : ''; return; }
    const mk = marketText(q.vsMarketBps), rows0 = [
      ['Price', L.dir === 'b2e' ? rateText(q.rate) : `1 ETH = ${tidy((1 / q.rate).toFixed(6))} BTC`, ''],
      ['Market', q.market ? (L.dir === 'b2e' ? rateText(q.market) : `1 ETH = ${tidy((1 / q.market).toFixed(6))} BTC`) : 'not available', q.market ? '' : 'warn'],
      ...(mk ? [['You get', mk, q.blocked ? 'err' : q.vsMarketBps < -100 ? 'warn' : '']] : []),
      // (what a quote costs against the market is the row above: the engine's feeBps is that, not a fee the provider named, so it is not called one here)
      ['Provider', q.provider?.name || 'Provider', ''],
      ...(Number(q.networkFeeSats) > 0 ? [['Bitcoin fee', `about ${Number(q.networkFeeSats).toLocaleString('en-US')} sats`, '']] : []),
      ...(L.dir === 'e2b' && Number(q.takeFeeSats) > 0 ? [['Bitcoin fee', `about ${Number(q.takeFeeSats).toLocaleString('en-US')} sats, from the lock when you take it`, '']] : []),
      ['Time', etaSpan(q.etaSecs), ''],
      ['If it stops', L.dir === 'b2e' ? 'your BTC returns to you within about a day' : 'your ETH returns to your private balance after about 4 hours', ''],
      ...(q.warnings || []).map((w) => ['Note', w, 'warn']),
    ];
    rc.hidden = false;
    rc.innerHTML = rows(rows0);
  }
  // A press under way, before its swap has started: shown as the swap it becomes, its first step (the ETH made private) under way, the rest to come
  function pressCard(C) {
    if (C.dir === 'b2e') return pressCardBtc(C);
    const waits = C.phase === 'paused', sent = C.mined ? 'The deposit is in a block. The swap is being started with the provider.' : C.sent ? 'The deposit is sent and waits for a block. The swap starts with the provider as soon as it is in one.' : 'Confirm the deposit in your wallet.';
    return {
      id: 'press', dir: 'e2b', state: 'working', title: waits ? 'Waiting for you' : 'Adding your ETH privately', press: true,
      detail: waits ? 'Your ETH is in your private balance. Nothing has been asked of the provider yet.' : C.cancelled ? 'Cancelled: no swap starts. A deposit that was sent stays in your private balance.' : sent,
      pay: C.amount, get: C.q ? C.q.get : 0n, steps: [{ key: 'private', title: PRIVATE_STEP, state: waits ? 'done' : 'active' }, ...E2B_STEPS.map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: 'todo' }))],
      etaSecs: waits ? 0 : (C.mined ? 0 : PRESS_SECS) + E2B_SECS, refundAt: null, backBy: null,
    };
  }
  function pressCardBtc(C) {
    const waits = C.phase === 'paused';
    const said = waits ? 'Your BTC is at your Tacit wallet’s Bitcoin address. Nothing has been asked of the provider yet.' : C.cancelled ? 'Cancelled: no swap starts. Sats that were sent stay at your Tacit wallet’s Bitcoin address.'
      : C.mined ? 'The payment has arrived. Your lock is being made from it, so the two confirm together.' : C.sent ? 'The payment is sent. The swap starts as soon as Bitcoin shows it.' : 'Confirm the payment in your Bitcoin wallet.';
    return {
      id: 'press', dir: 'b2e', state: 'working', title: waits ? 'Waiting for you' : 'Sending your BTC', press: true, detail: said,
      pay: C.amount, get: C.q ? C.q.get : 0n, steps: B2E_STEPS.map((title, i) => ({ key: ['lock', 'match', 'claim', 'take'][i], title, state: i === 0 && !waits ? 'active' : 'todo' })),
      etaSecs: waits ? 0 : PRESS_SECS + B2E_SECS, refundAt: null, backBy: null,
    };
  }
  // what a swap of ETH started with one press shows: the step that made its ETH private first, done once the deposit has landed
  const withPress = (r) => {
    const C = r.dir === 'e2b' ? chains.get(r.id) : null;
    if (!C) return r;
    const steps = [{ key: 'private', title: PRIVATE_STEP, state: C.landed || r.state !== 'working' ? 'done' : 'active' }, ...(r.steps || [])];
    return { ...r, steps, detail: !C.landed && r.state === 'working' ? [r.detail, 'Your ETH is made private meanwhile.'].filter(Boolean).join(' ') : r.detail };
  };
  // Once the provider has been asked, a swap of ETH is not cancelled (its lock of BTC comes first, and costs it a fee and the time the BTC is held): it goes
  // through, or its ETH comes back. Said in those words, with the time the ETH comes back by once it is locked.
  function lockedIn(r) {
    if (r.dir !== 'e2b' || r.state !== 'working' || r.press || r.checking) return '';
    if (r.refundAt) return `Locked in: it goes through, or if the provider has not claimed by ${clockText(r.refundAt, now())}, your ETH returns to your private balance.`;
    if (r.steps && r.steps.some((s) => s.key === 'take' && s.state === 'active')) return '';
    return 'Locked in: the provider has been asked, so this swap can no longer be cancelled. If it does not claim in time, your ETH returns to your private balance.';
  }
  // A finished swap of ETH for BTC: what to do with the BTC, right in its card. Send it (the panel's send, the amount that arrived filled in), use it on
  // Tacit's Bitcoin order book (same key, same tab), or hold it in another wallet (the wallet sheet gives the Bitcoin key).
  const RECENT_SECS = 3 * 86400;
  function nextSteps(r) {
    if (r.dir === 'b2e') return payNext(r);
    if (!onNext || r.dir !== 'e2b' || r.state !== 'done' || !(r.get > 0n) || (r.at && now() - r.at > RECENT_SECS)) return '';
    const got = r.got != null && r.got > 0n ? r.got : r.get;
    return `<div class="nx"><button class="nx-b main" type="button" data-next="send" data-sats="${esc(String(got))}">Send BTC</button><a class="nx-b" href="${BTC_BOOK}" data-next="book">Use it on Tacit</a></div>`
      + `<small class="nx-n">Send it to any wallet (UniSat, Sparrow, an exchange), or bid for TAC with it on Tacit’s Bitcoin order book. To keep it in another wallet instead, import this wallet’s Bitcoin key: <a href="${WALLET_SHEET}" data-next="elsewhere">Use this wallet’s Bitcoin elsewhere</a>.</small>`;
  }
  // a finished swap of BTC whose ETH was kept private: one button sends it on to an Ethereum address (the page asks where, and shows the fee first)
  function payNext(r) {
    const k = D.key ? D.key() : null;
    if (!payout || !onNext || !k || r.state !== 'done' || !(r.get > 0n) || (r.at && now() - r.at > RECENT_SECS) || payout.want(k.pubHex, r.id)) return '';
    return `<div class="nx"><button class="nx-b" type="button" data-next="withdraw" data-id="${esc(r.id)}" data-units="${esc(String(r.get))}">Send to an Ethereum address</button></div>`;
  }
  function paintRecs() {
    const box = recsHost || $('a-sent'), gone = dismissed(), recs = L.recs.filter((r) => !gone.has(r.id)).map(withPress);
    const shown = L.chain ? [pressCard(L.chain), ...recs] : recs;
    if (recsHost) $('a-sent').hidden = true;
    box.hidden = !shown.length;
    onRecs(recs);
    box.innerHTML = shown.map((r) => {
      const cls = r.state === 'done' ? 'ok' : r.state === 'working' ? 'wait' : 'warn', [pk, gk] = SIDES[r.dir] || SIDES.b2e;
      // both sides, each way; a swap found again from the key, or one whose provider has not offered yet, may not know an amount: that side is named without one
      // (a swap of BTC found again from the key sees only its Bitcoin lock, so its ETH amount is not known)
      const side = (v, k) => (v > 0n ? `${fmt(v)} ${COINS[k].sym}` : COINS[k].sym);
      const got = r.state === 'done' && r.got != null && r.got > 0n ? r.got : r.get;
      const what = r.pay > 0n || r.get > 0n ? `${side(r.pay, pk)} → ${r.pay > 0n && r.get > 0n && r.state !== 'done' ? 'about ' : ''}${side(got, gk)}` : '';
      const eta = r.state === 'working' && r.etaSecs ? etaSpan(r.etaSecs) : '';
      const sure = lockedIn(r);
      // the Bitcoin lock under way, linked: the provider's (e2b, once it says its txid) or the user's own (b2e)
      const lockAt = r.state === 'working' && /^[0-9a-f]{64}$/.test(String(r.lockTxid || '')) ? ` <a href="https://mempool.space/tx/${esc(r.lockTxid)}" target="_blank" rel="noopener noreferrer">${r.dir === 'e2b' ? 'The provider’s lock' : 'Your lock'} ↗</a>` : '';
      const back = r.state === 'working' && r.refundAt && !sure ? `If it stops, your ${COINS[pk].sym} returns ${untilText(r.refundAt, now())} at the latest.` : '';
      // when the page must be open again: b2e, to claim the ETH by the pool deadline (else the BTC returns, later); e2b, once its ETH is locked, to take the BTC in time
      const locked = r.dir === 'e2b' && (r.steps || []).some((s) => s.key === 'match' && s.state !== 'todo'), by = r.state === 'working' && r.backBy ? clockText(r.backBy, now()) : '';
      const stay = r.state !== 'working' ? '' : !by ? 'Keep this page open until it is done.'
        : r.dir === 'b2e' ? `Keep this page open until it is done. If you close it, come back by ${by}: the ETH has to be claimed by then, or your BTC returns by itself after about a day.`
          : locked ? `Keep this page open until it is done. If you close it, come back by ${by}: the BTC has to be taken in time, or the ETH you locked can be lost.` : 'Keep this page open until it is done.';
      const steps = (r.steps || []).map((s) => `<li class="${esc(s.state)}" data-step="${esc(s.key)}"><i aria-hidden="true"></i>${esc(s.title)}</li>`).join('');
      // (a press may be cancelled only while that costs the provider nothing: before it is asked, which is before the deposit is mined, or while new numbers wait)
      const cancel = r.press && !L.chain.cancelled && (L.chain.phase === 'paused' || (L.chain.phase === 'adding' && !L.chain.mined)) ? ' <button class="link cx" type="button" data-press-cancel>Cancel</button>' : '';
      return `<div class="${cls}${r.press ? ' press' : ''}" data-rec="${esc(r.id)}"><span><i class="dot" aria-hidden="true"></i><b>${esc(r.title)}</b></span><span>${eta ? esc(eta) : ''}${r.state === 'working' || r.press ? cancel : ` <button class="link" type="button" data-dismiss="${esc(r.id)}" aria-label="Dismiss">×</button>`}</span>
        ${what ? `<span class="what">${esc(what)}</span>` : ''}${steps ? `<ol class="stp${r.steps.length === 5 ? ' s5' : ''}">${steps}</ol>` : ''}${r.detail || back ? `<small>${esc([r.detail, back].filter(Boolean).join(' '))}${lockAt}</small>` : ''}${sure ? `<small class="sure">${esc(sure)}</small>` : ''}${stay && !r.press ? `<small class="stay${by ? ' by' : ''}">${esc(stay)}</small>` : ''}${payLine(r)}${nextSteps(r)}</div>`;
    }).join('');
  }
  function paint() {
    if (!mounted) return;
    const [p, g] = sides(), [pk, gk] = SIDES[L.dir];
    $('a-pay-coin').innerHTML = coin(p); $('a-get-coin').innerHTML = coin(g);
    $('a-pay-coin').setAttribute('aria-label', `Pay with ${p.sym}`); $('a-get-coin').setAttribute('aria-label', `Get ${g.sym}`);
    $('a-pay-at').innerHTML = `<svg class="tk xs" aria-hidden="true"><use href="#${p.at}"/></svg>${esc(p.where)}`;
    $('a-get-at').innerHTML = `<svg class="tk xs" aria-hidden="true"><use href="#${g.at}"/></svg>${esc(g.where)}`;
    const bp = balOf(pk), bg = balOf(gk), hp = heldOf(pk), hg = heldOf(gk);
    // sats that have reached the address and wait for a block are said, so a deposit that has not confirmed yet is not mistaken for a balance that is not there
    const confirming = (k) => (k === 'btc' && L.bal.pending > 0n ? ` · ${fmt(L.bal.pending)} BTC confirming` : '');
    const unread = (k) => (k === 'btc' ? L.unread?.btc : L.unread?.eth);
    $('a-bal').textContent = !D.unlocked || !pair ? '' : hp == null ? (unread(pk) ? `${p.sym} balance not read yet: trying again` : 'Reading your balance…') : `Balance ${fmt(hp)} ${p.sym}${confirming(pk)}`;
    $('a-get-bal').textContent = !D.unlocked || !pair || hg == null ? '' : `Balance ${fmt(hg)} ${g.sym}${confirming(gk)}`;
    const max = bp != null && bp > 0n ? (pk === 'btc' ? bp - BigInt(L.q?.networkFeeSats ?? LOCK_GUESS_SATS) : bp) : 0n;
    $('a-quick').innerHTML = max > 0n ? [25, 50, 100].map((n) => `<button type="button" data-quick="${tidy(plain((max * BigInt(n)) / 100n, DEC))}">${n === 100 ? 'Max' : `${n}%`}</button>`).join('') : '';
    const out = $('a-out'), q = L.q;
    // what arrives is what the provider locks less the fee of the transaction that takes it (e2b), not the lock
    const arrives = q && L.dir === 'e2b' && Number(q.takeFeeSats) > 0 && q.get > BigInt(q.takeFeeSats) ? q.get - BigInt(q.takeFeeSats) : q && q.get;
    // before a quote (the wallet not open yet), what the best provider would give at the market, marked as an estimate (to six places: it is not a quote)
    const est = !q && !pair && L.mk?.estimate && amountBase() ? L.mk.estimate(L.dir, amountBase()) : null;
    out.classList.toggle('est', !!est);
    if (q) { out.textContent = fmt(arrives); out.classList.remove('ph'); } else if (est) { out.textContent = `≈ ${tidy(fmtUnits(est.get, DEC, 6))}`; out.classList.remove('ph'); } else { out.textContent = '0'; out.classList.add('ph'); }
    fit(out); fit($('a-amt'));
    paintRcpt(); paintRecs();
    const gt = gate(), go = $('a-go');
    go.textContent = gt.label; go.disabled = !!gt.off; go.dataset.act = gt.act || ''; fundAsk = gt.fund || null; addAsk = gt.add || null;
    // what one press does, and what its deposit from the wallet shows on chain, said under the button
    if (gt.act === 'oneclick' && !L.busy && (!L.line || L.cls === 'hint')) say(`${ONE_PRESS}<small>${esc(SHIELD_NOTE)}</small>`, 'hint');
    else if (gt.act === 'bpress' && !L.busy && (!L.line || L.cls === 'hint')) say(`${ONE_PRESS_BTC}<small>${esc(BTC_NOTE)}</small>`, 'hint');
    else if (gt.act !== 'oneclick' && gt.act !== 'bpress' && L.cls === 'hint') say('');
    paintPayTo();
    // (nothing of a press under way changes under it: the amount and the way round wait for it)
    $('a-amt').disabled = !!L.chain;
    if (L.chain) { /* a press under way says its own steps */ }
    else if (L.qErr && !L.busy) say(esc(L.qErr), 'err');
    else if (L.q?.blocked && !L.busy) say(esc(L.q.blocked.charAt(0).toUpperCase() + L.q.blocked.slice(1) + (/[.!?]$/.test(L.q.blocked) ? '' : '.')), 'err');
    else if (L.q?.highFee && !L.q.feeAccepted && !L.q.renewed && !L.busy) say(esc(`The Bitcoin fee is about ${L.q.highFee.sats.toLocaleString('en-US')} sats, ${(L.q.highFee.bps / 100).toFixed(1)}% of the amount. Accept it to go on, or swap a larger amount.`), 'warn');
    else if (L.cls === 'err' && !L.busy && !L.sticky) say('');
  }

  // ── "Receive as" (a swap of BTC, with btc/payout.js): the ETH kept private, or sent on to an Ethereum address once it has arrived ──
  // Drawn once while it shows and changed in place (what is typed stays), the relay's fee read for the amount and said before the press.
  let ptShown = '', ptFee = { units: null, fee: null, net: null, at: 0 };
  const ptShort = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  function paintPayTo() {
    const box = $('a-payto');
    const k = payout && D.unlocked && D.key ? D.key() : null, q = L.q;
    const on = !!(k && pair && L.dir === 'b2e' && !L.chain && amountBase());
    box.hidden = !on;
    if (!on) return;
    const own = payout.tacitAddress(k.priv);
    if (ptShown !== k.pubHex) {
      ptShown = k.pubHex;
      box.innerHTML = `<fieldset class="pt"><legend>Receive as</legend>
        <label><input type="radio" name="a-pt" value="private" checked><span>Private ETH in your Tacit wallet</span></label>
        <label><input type="radio" name="a-pt" value="tacit"><span>Sent to your Tacit Ethereum address <code class="num" id="a-pt-own"></code></span></label>
        <label><input type="radio" name="a-pt" value="other"><span>Sent to another Ethereum address</span></label>
        <input id="a-pt-addr" placeholder="0x…" autocomplete="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" aria-label="Ethereum address" hidden>
        <p class="pt-say" id="a-pt-say" role="status"></p></fieldset>`;
      L.payTo = { mode: 'private', address: null };
    }
    $('a-pt-own').textContent = ptShort(own);
    $('a-pt-own').title = own;
    const mode = L.payTo.mode;
    $('a-pt-addr').hidden = mode !== 'other';
    const ptSay = $('a-pt-say');
    if (mode === 'private') { ptSay.textContent = ''; ptSay.className = 'pt-say'; return; }
    if (mode === 'other' && !L.payTo.address) {
      const t = $('a-pt-addr').value.trim(), c = payout.checkAddress(t);
      ptSay.textContent = t && !c.ok ? c.why : 'The ETH goes there once it arrives; the relay takes its fee from it.'; ptSay.className = `pt-say${t && !c.ok ? ' err' : ''}`;
      return;
    }
    const units = q && q.dir === 'b2e' ? q.get : null;
    if (units && (ptFee.units !== units || Date.now() - ptFee.at > 60000)) {
      ptFee = { units, fee: null, net: null, at: Date.now() };
      payout.quote(units).then((f) => { if (ptFee.units === units) { ptFee = { ...ptFee, ...f }; paintPayTo(); } }, () => {});
    }
    const fee = ptFee.units === units ? ptFee : null;
    ptSay.className = 'pt-say';
    ptSay.textContent = `${fee && fee.fee != null ? `The relay’s fee, about ${fmt(fee.fee)} ETH, comes out of it: about ${fmt(fee.net)} ETH arrives at ${ptShort(L.payTo.address)}.` : 'Reading the relay’s fee…'} `
      + 'Sent there, it is public from that address on. Sending all of it right after the swap makes the two easy to match by amount and time; kept private, they are not.';
  }
  host.addEventListener('change', (e) => {
    if (e.target.name !== 'a-pt') return;
    const k = D.key ? D.key() : null, mode = e.target.value;
    L.payTo = { mode, address: mode === 'tacit' && k && payout ? payout.tacitAddress(k.priv) : mode === 'other' ? (payout.checkAddress($('a-pt-addr').value).address || null) : null };
    paint();
    if (mode === 'other') $('a-pt-addr').focus();
  });
  host.addEventListener('input', (e) => {
    if (e.target.id !== 'a-pt-addr') return;
    const c = payout.checkAddress(e.target.value);
    L.payTo = { mode: 'other', address: c.ok ? c.address : null };
    paint();
  });

  // ── actions ──
  // What the lane reads first once a key opens, read ahead while the visitor signs in or before (once): the pair opener's modules, the pool's history (which
  // every key's balance is read from: what is left after the signature is the key's own part), and, for a swap of ETH, what a deposit reads first
  let warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    D.warm?.();
    if (getUx) Promise.resolve().then(getUx).then((ux) => ux.fetchEvents?.({ include: ['wraps'] })).catch(() => {});
    if (shield && L.dir === 'e2b') shield.warm?.();
  }
  async function unlock() {
    warm();
    try { await D.signIn(); } catch (e) { if (!e?.unlockCancelled) say(esc(plainError(e)), 'err'); return; }
    L.unlocked = D.unlocked; if (!L.sticky) say(''); paint(); await begin();
  }
  async function swap() {
    const q = L.q; if (!q || q.blocked || L.busy) return;
    if (q.renewed) return;
    if (q.expiresAt - now() < START_SECS) { say('That quote is about to run out. Getting a new one.'); requote(true, true); return; }
    L.busy = true; L.sticky = false; say('Starting the swap…'); paint();
    const g = gen, p = pair;
    try {
      const r = await p.start(q);
      if (g !== gen) return;
      const to = payToNow();
      L.amt = ''; $('a-amt').value = ''; L.q = null; L.qErr = '';
      say('');
      payChosen(r.id, to);
      const recs = await (recovering ? Promise.reject() : p.pump()).catch(async () => p.records().catch(() => L.recs));
      if (g !== gen) return;
      L.recs = recs;
      known.set(r.id, 'working');
      onState();
      follow(POLL_MS);
    } catch (e) {
      if (g === gen) {
        say(esc(plainError(e)), 'err'); L.sticky = true;
        // a provider that could not hold its quote: the next best is asked for, and shown before anything is started
        if (e && e.requote) { L.q = null; requote(true); }
      }
    }
    finally { if (g === gen) { L.busy = false; paint(); } }
    if (g === gen) readMe(true);
  }
  // ── adding ETH from an Ethereum wallet (btc/add-eth.js) ──
  // One wallet transaction deposits the shortfall and the relay finishes it (a press, below); a deposit kept from an earlier visit is finished here, and the page
  // then reads the balance until the swap can be made.
  const ethLink = (h) => (h ? ` <a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(String(h).slice(0, 10))}…↗</a>` : '');
  const ethOf = (wei) => tidy(fmtUnits(wei, 18, 8));
  let slowTimer = 0;
  function addStep(k, d) {
    clearTimeout(slowTimer);
    if (k === 'wallet') say('Finding your Ethereum wallet…');
    else if (k === 'quote') say('Getting the relay’s fee for the deposit…');
    else if (k === 'prepare') say('Preparing the deposit…');
    else if (k === 'confirm') say(`Confirm in your wallet: ${esc(ethOf(d.wei))} ETH into your private balance and the relay’s fee of ${esc(ethOf(d.tip))} ETH, from ${esc(String(d.from).slice(0, 6))}…${esc(String(d.from).slice(-4))}. Your wallet adds the network fee.`);
    else if (k === 'sent') {
      say(`Adding ETH to your private balance… The deposit is sent${ethLink(d)} and waits for Ethereum.`);
      slowTimer = setTimeout(() => { if (L.adding) say(`Adding ETH to your private balance… The deposit${ethLink(d)} is still waiting for Ethereum, which is slow right now. Nothing needs to be sent again: this page keeps checking.`); }, 3 * 60e3);
    } else if (k === 'proving') say(`Adding ETH to your private balance… The deposit landed${ethLink(d)}. The relay is finishing it, about a minute.`);
    else if (k === 'landed') say('Adding ETH to your private balance… Done. Reading your balance…');
  }
  async function addError(e) {
    if (e?.html) return e.html;
    if (e?.userStopped || e?.code === 4001) return 'Nothing was sent.';
    if (e?.kept) return esc(`${await Promise.resolve(shield.relayWords?.(e)).catch(() => '') || plainError(e)} Your deposit is safe: this page finishes it while it is open, or on your next visit.`);
    return esc(plainError(e));
  }
  // after a deposit lands, the balance is read until it covers the amount (or about two minutes pass: the lane's refresh keeps reading)
  async function waitLanded() {
    for (let i = 0; i < 24 && L.open && pair; i++) {
      await readMe(true);
      const amount = amountBase();
      if (!amount || L.dir !== 'e2b' || (L.bal.eth != null && L.bal.eth >= amount) || (pair?.covers && (await pair.covers(amount).catch(() => false)))) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  // ── one press: the ETH made private, then swapped ──
  // The press deposits the shortfall from the Ethereum wallet (btc/add-eth.js). Once the deposit is mined, the ETH has left the wallet for good and lands as a
  // note of the key's within minutes, so the swap is started with the provider then (pair.start with `coming`), while the relay settles the note: the provider's
  // lock waits for a Bitcoin block meanwhile, and the swap's lock of ETH is made once the note is there (fastbridge-el.js waits for it). A deposit declined or
  // failed starts nothing. A quote that ran out meanwhile is renewed; one that gives less than the press saw, or asks a large Bitcoin fee not accepted, waits
  // for a yes. Until the provider is asked, the press can be cancelled: the deposit (if it was sent) stays in the private balance.
  const cancelLink = () => ' <button class="link" type="button" data-press-cancel>Cancel</button>';
  // where a press's money stays when no swap starts: the private balance (ETH), or the Tacit wallet's Bitcoin address (BTC, sent anywhere with Send BTC)
  const keptLine = (C) => (C.dir === 'b2e' ? 'Your BTC stays at your Tacit wallet’s Bitcoin address: nothing was swapped.' : 'Your ETH stays in your private balance: nothing was swapped.');
  function pressSay(C, h, cls = '') {
    if (L.chain !== C) return;
    say(`${h}${!C.cancelled && C.phase === 'adding' && !C.mined ? cancelLink() : ''}`, cls);
    paintRecs();
  }
  function pressStep(C, k, d) {
    clearTimeout(slowTimer);
    if (k === 'sent') C.sent = true;
    if (L.chain !== C) return;
    if (C.cancelled) { pressSay(C, cancelledLine(C)); return; }
    if (k === 'wallet') pressSay(C, 'Finding your Ethereum wallet…');
    else if (k === 'quote') pressSay(C, 'Getting the relay’s fee for the deposit…');
    else if (k === 'prepare') pressSay(C, 'Preparing the deposit…');
    else if (k === 'confirm') pressSay(C, `Confirm in your wallet: ${esc(ethOf(d.wei))} ETH and the relay’s fee of ${esc(ethOf(d.tip))} ETH, from ${esc(String(d.from).slice(0, 6))}…${esc(String(d.from).slice(-4))}. Your wallet adds the network fee.`);
    else if (k === 'sent') {
      pressSay(C, `The deposit is sent${ethLink(d)}. The swap starts as soon as Ethereum has it in a block.`);
      slowTimer = setTimeout(() => { if (L.chain === C && !C.mined) pressSay(C, `The deposit${ethLink(d)} is still waiting for a block: Ethereum is slow right now. Nothing needs to be sent again.`); }, 3 * 60e3);
    } else if (k === 'mined') pressSay(C, `The deposit is in${ethLink(d.hash)}. Starting the swap…`);
  }
  const cancelledLine = (C) => (C.dir === 'b2e' ? (C.sent ? 'Cancelled: no swap starts. The payment is already sent, so its sats arrive at your Tacit wallet’s Bitcoin address; Send BTC below sends them anywhere.' : 'Cancelled: no swap starts. Decline the payment in your wallet and nothing is sent.')
    : C.sent ? 'Cancelled: no swap starts. The deposit is already sent, so its ETH lands in your private balance, ready for a later swap.'
    : 'Cancelled: no swap starts. Decline the deposit in your wallet and nothing is sent; if it goes ahead, its ETH stays in your private balance.');
  function cancelPress() {
    const C = L.chain;
    if (!C || C.cancelled) return;
    if (C.phase === 'paused') { endPress(C, C.dir === 'b2e' ? 'Nothing was swapped. Your BTC is at your Tacit wallet’s Bitcoin address.' : 'Kept private: nothing was swapped. Your ETH is in your private balance.', ''); return; }
    if (C.phase !== 'adding' || C.mined) return;                     // the provider is being asked: from here the swap goes through or returns
    C.cancelled = true; L.sticky = true;
    pressSay(C, cancelledLine(C));
  }
  // the press ends without a swap: the line says why, and what of the deposit is where
  function endPress(C, h, cls = 'err') {
    if (L.chain !== C) return;
    C.phase = 'ended'; L.chain = null; L.sticky = !!h;
    say(esc(h), cls); paint();
    requote(true);
  }
  async function oneClick(add) {
    const k = D.key ? D.key() : null, q = L.q, amount = amountBase();
    if (!k || !shield || L.chain || L.busy || L.adding || !add || !q || !amount || q.blocked || q.renewed || (q.highFee && !q.feeAccepted)) return;
    const g = gen;
    const C = L.chain = { dir: 'e2b', phase: 'adding', amount, add, q, sent: false, mined: false, landed: false, cancelled: false, coming: add, id: null, payTo: null };
    L.adding = true; L.sticky = false; paint();
    let minedNow;
    const mined = new Promise((r) => { minedNow = r; });
    const landing = shield.start({ key: k, units: add, onStep: (s, d) => { if (s === 'mined') { C.mined = true; C.coming = BigInt(d?.units ?? add); minedNow(d); } pressStep(C, s, d); } });
    // the deposit runs to its end whatever the swap does: once it lands, the lock can be made from its note
    const landed = landing.then(() => { C.landed = true; }, (e) => { C.landErr = e; throw e; });
    landed.catch(() => {});
    const first = await Promise.race([mined.then(() => 'mined'), landed.then(() => 'landed', (e) => ({ e }))]);
    if (g !== gen) return;
    if (first && first.e) {
      // declined, too little in the wallet, no wallet, failed, or sent and never mined: no swap is started
      const e = first.e;
      C.phase = 'ended'; L.chain = null; L.adding = false; clearTimeout(slowTimer);
      if (e?.kept) { say(''); paint(); resumeAdd(); return; }
      say(await addError(e), 'err'); L.sticky = true; paint(); requote(true);
      return;
    }
    if (C.cancelled) {
      // cancelled before it was mined: the deposit lands in the private balance, and nothing is swapped
      L.chain = null; C.phase = 'ended'; paint();
      try { await landing; await waitLanded(); say('Your ETH is in your private balance. No swap was started.', 'ok'); }
      catch (e) { if (e?.kept) resumeAdd(); else say(await addError(e), 'err'); }
      finally { L.adding = false; paint(); }
      return;
    }
    afterLanding(C, landing);
    await startPress(C);
  }
  // The deposit's end: the note is there (the lane reads the balance, cuts a note to the amount if one is needed, and steps the swap at once), or it is kept
  // and finished as any kept deposit is
  function afterLanding(C, landing) {
    const g = gen;
    landing.then(async () => {
      if (g !== gen) return;
      L.adding = false; C.landed = true;
      await readMe(true);
      if (C.id && pair) { pair.prepare?.(C.amount)?.catch?.(() => {}); follow(1000); }
      paint();
    }, async (e) => {
      if (g !== gen) return;
      L.adding = false;
      if (e?.kept) resumeAdd(); else { say(await addError(e), 'err'); L.sticky = true; paint(); }
    });
  }
  // the swap of a press: on the quote the press saw while it is good to start on, else a new one that is no worse, else the new numbers wait for a yes
  async function startPress(C) {
    const g = gen, p = pair;
    if (!p || L.chain !== C) return;
    C.phase = 'starting'; paint();
    let q = C.q;
    for (let tries = 0; ; tries++) {
      if (g !== gen || L.chain !== C) return;
      if (!q || q.expiresAt - now() < START_SECS) {
        let nq;
        try { nq = await p.quote({ dir: C.dir, amount: C.amount }); } catch (e) { if (g === gen) endPress(C, `${plainError(e)} ${keptLine(C)}`); return; }
        if (g !== gen || L.chain !== C) return;
        if (nq.blocked) { endPress(C, `${nq.blocked.charAt(0).toUpperCase()}${nq.blocked.slice(1)}. ${keptLine(C)}`); return; }
        if (worseThan(C.q, nq)) { pausePress(C, nq, 'price'); return; }
        if (nq.highFee && !C.q.feeAccepted) { pausePress(C, nq, 'fee'); return; }
        q = { ...nq, feeAccepted: !!C.q.feeAccepted };
      }
      try {
        const r = await p.start(q, C.dir === 'b2e' ? { coins: C.coins } : { coming: C.landed ? null : C.coming });
        if (g !== gen) return;
        C.phase = 'started'; C.id = r.id; if (C.dir === 'e2b') chains.set(r.id, C); L.chain = null; clearTimeout(slowTimer);
        payChosen(r.id, C.payTo);
        L.amt = ''; $('a-amt').value = ''; L.q = null; L.qErr = ''; L.sticky = false;
        say('');
        if (C.dir === 'e2b' && C.landed && pair) pair.prepare?.(C.amount)?.catch?.(() => {});
        const recs = await (recovering ? Promise.reject() : p.pump()).catch(async () => p.records().catch(() => L.recs));
        if (g !== gen) return;
        L.recs = recs; known.set(r.id, 'working');
        onState(); paint(); follow(POLL_MS);
        (recsHost || host).querySelector(`[data-rec="${CSS.escape(r.id)}"]`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        return;
      } catch (e) {
        if (g !== gen) return;
        // a provider that could not hold its quote: the next best is asked for, and taken only if it is no worse (else it waits for a yes)
        if (e && e.requote && tries < 1) { q = null; continue; }
        endPress(C, `${plainError(e)} ${keptLine(C)}`);
        return;
      }
    }
  }
  function pausePress(C, nq, why) {
    C.phase = 'paused'; C.why = why; C.next = nq;
    L.q = why === 'price' ? { ...nq, renewed: { get: C.q.get } } : nq;
    L.sticky = true;
    const arrives = (x) => (Number(x.takeFeeSats) > 0 && x.get > BigInt(x.takeFeeSats) ? x.get - BigInt(x.takeFeeSats) : x.get);
    const keep = C.dir === 'b2e' ? 'keep your BTC at your Tacit wallet’s address' : 'keep your ETH private', gets = COINS[SIDES[C.dir][1]].sym;
    const h = why === 'price'
      ? `The price moved ${C.dir === 'b2e' ? 'while your BTC was on its way' : 'while your ETH was made private'}: ${esc(fmt(arrives(C.q)))} → ${esc(fmt(arrives(nq)))} ${gets}. Accept the new price to go on, or cancel and ${keep}.`
      : `The Bitcoin fee is now about ${esc(nq.highFee.sats.toLocaleString('en-US'))} sats, ${esc((nq.highFee.bps / 100).toFixed(1))}% of the amount. Accept it to go on, or cancel and ${keep}.`;
    say(`${h}${cancelLink()}`, 'warn');
    paint();
  }
  function acceptPress() {
    const C = L.chain;
    if (!C || C.phase !== 'paused' || !C.next) return;
    C.q = { ...C.next, renewed: null, feeAccepted: C.why === 'fee' ? true : !!C.q.feeAccepted }; C.next = null;
    L.sticky = false; say('Starting the swap…');
    startPress(C);
  }

  // ── one press of BTC: paid in from a Bitcoin wallet, then swapped ──
  // The Bitcoin wallet in this browser pays the amount and the lock's fee to the Tacit wallet's own Bitcoin address, in one prompt of its own (its coin choice
  // is the wallet's: a coin with an inscription or a rune is never spent here). As soon as the explorers show the payment, the swap's lock is made from it,
  // not waiting for its block: the payment and the lock then confirm together (only the payer could undo the payment, and the provider locks nothing until
  // the lock is in a block). A payment declined starts nothing. Until the lock is made the press can be cancelled, and the sats stay at the address.
  const btcOf = (sats) => `${tidy(fmtUnits(BigInt(sats), 8, 8))} BTC`;
  const ARRIVE_TRIES = 40, ARRIVE_MS = 3000;
  async function oneClickBtc(fund) {
    const q = L.q, amount = amountBase(), sats = Number(fund?.sats || 0);
    if (L.chain || L.busy || !q || !amount || !(sats > 546) || q.blocked || q.renewed || (q.highFee && !q.feeAccepted) || !D.sendIn) return;
    const g = gen, p = pair;
    const C = L.chain = { dir: 'b2e', phase: 'adding', amount, q, sats, sent: false, mined: false, landed: true, cancelled: false, coins: null, id: null, payTo: payToNow() };
    L.sticky = false; paint();
    pressSay(C, `Confirm in your Bitcoin wallet: ${esc(btcOf(sats))} (${esc(sats.toLocaleString('en-US'))} sats) to your Tacit wallet’s Bitcoin address. It goes straight into the swap. Your wallet adds its network fee.`);
    let sent;
    try { sent = await D.sendIn(sats); } catch (e) {
      if (g !== gen || L.chain !== C) return;
      const m = String(e?.message || e || '');
      endPress(C, /reject|cancel|denied|declin|user/i.test(m) ? 'Nothing was sent.' : `${plainError(e)} Nothing was sent.`, /reject|cancel|denied|declin|user/i.test(m) ? '' : 'err');
      return;
    }
    if (g !== gen || L.chain !== C) return;
    C.sent = true; C.txid = sent.txid;
    const link = /^[0-9a-f]{64}$/.test(C.txid || '') ? ` <a href="https://mempool.space/tx/${esc(C.txid)}" target="_blank" rel="noopener noreferrer">${esc(C.txid.slice(0, 10))}…↗</a>` : '';
    pressSay(C, `Sent${link}. The swap starts as soon as Bitcoin shows the payment, in a few seconds.`);
    // the payment as the explorers show it: the coins it made at this address
    for (let i = 0; i < ARRIVE_TRIES && g === gen && L.chain === C && !C.cancelled; i++) {
      const cs = /^[0-9a-f]{64}$/.test(C.txid || '') ? await p.arriving(C.txid).catch(() => []) : [];
      if (cs.length) { C.coins = cs; break; }
      await new Promise((r) => setTimeout(r, ARRIVE_MS));
    }
    if (g !== gen || L.chain !== C) return;
    if (C.cancelled) { endPress(C, 'Cancelled: no swap starts. The sats are at your Tacit wallet’s Bitcoin address; Send BTC below sends them anywhere.', ''); readMe(true); return; }
    if (!C.coins) { endPress(C, `The payment${link ? '' : ''} is not showing on Bitcoin yet. Nothing was swapped: once it arrives, its sats are at your Tacit wallet’s Bitcoin address, and the swap can be pressed again.`); return; }
    C.mined = true;
    await startPress(C);
  }

  // ── where the ETH of a swap of BTC goes (btc/payout.js): the private balance, or an Ethereum address once it has arrived ──
  const payToNow = () => (payout && L.dir === 'b2e' && L.payTo.mode !== 'private' && L.payTo.address ? L.payTo.address : null);
  function payChosen(id, to) {
    const k = D.key ? D.key() : null;
    if (!payout || !to || !k) return;
    payout.choose(k.pubHex, id, { to, state: 'waiting' });
  }
  // A swap of BTC whose ETH has been claimed, with an address chosen for it: the relay withdraws it there, one at a time (and one tab at a time), a
  // withdrawal the relay has not finished is asked again a little later
  let paying = false;
  async function payDue() {
    const k = D.key ? D.key() : null;
    if (!payout || paying || !k) return;
    const due = L.recs.find((r) => {
      if (r.dir !== 'b2e' || !(r.get > 0n) || !(r.steps || []).some((s) => s.key === 'claim' && s.state === 'done')) return false;
      const w = payout.want(k.pubHex, r.id);
      return w && (w.state === 'waiting' || (w.state === 'sending' && Date.now() - Number(w.tried || 0) > 15 * 60e3)) && Date.now() >= Number(w.nextAt || 0);
    });
    if (!due) return;
    const run = async () => {
      const w = payout.want(k.pubHex, due.id);
      if (!w || w.state === 'sent') return;
      paying = true;
      payout.choose(k.pubHex, due.id, { state: 'sending', tried: Date.now() }); paintRecs();
      try {
        const r = await payout.send({ key: k, units: due.get, to: w.to });
        payout.choose(k.pubHex, due.id, { state: 'sent', tx: r.txHash, net: String(r.net), fee: String(r.fee) });
        notify('ETH sent to your address');
      } catch (e) {
        // (one that may yet go is asked again by itself, its reason said on the card from the second try; one that cannot waits for Try again)
        const tries = Number(w.tries || 0) + 1;
        payout.choose(k.pubHex, due.id, e?.retry ? { state: 'waiting', nextAt: Date.now() + 30000, tries, why: plainError(e) } : { state: 'failed', tries, why: plainError(e) });
      } finally { paying = false; paintRecs(); }
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (locks && typeof locks.request === 'function') await locks.request(`tacit-btc-payout:${k.pubHex}`, { ifAvailable: true }, (l) => (l ? run() : null));
    else await run();
  }
  // what the card of a swap of BTC says of its ETH's way on: chosen, being sent, sent (linked), or a send that failed (with a way to try again)
  function payLine(r) {
    const k = D.key ? D.key() : null;
    if (!payout || !k || r.dir !== 'b2e') return '';
    const w = payout.want(k.pubHex, r.id);
    if (!w) return '';
    const to = `${w.to.slice(0, 6)}…${w.to.slice(-4)}`;
    if (w.state === 'sent') return `<small class="paid">Sent to ${esc(to)}${w.net && w.net !== '0' ? `: ${esc(fmt(BigInt(w.net)))} ETH` : ''}.${/^0x[0-9a-f]{64}$/i.test(w.tx || '') ? ` <a href="https://etherscan.io/tx/${esc(w.tx)}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a>` : ''}</small>`;
    if (w.state === 'failed') return `<small class="paid err">Couldn’t send to ${esc(to)}: ${esc(w.why || 'try again.')} <button class="link" type="button" data-pay-retry="${esc(r.id)}">Try again</button></small>`;
    if (w.state === 'waiting' && w.why && Number(w.tries || 0) >= 2) return `<small class="paid err">Couldn’t send to ${esc(to)} yet: ${esc(w.why)} Trying again by itself. <button class="link" type="button" data-pay-retry="${esc(r.id)}">Try again now</button></small>`;
    return `<small class="paid">${w.state === 'sending' ? `Sending the ETH to ${esc(to)}…` : `Then sent to ${esc(to)}, once the ETH has arrived.`}</small>`;
  }
  function payRetry(id) {
    const k = D.key ? D.key() : null;
    if (!payout || !k) return;
    payout.choose(k.pubHex, id, { state: 'waiting', why: null, nextAt: 0, tries: 0 }); paintRecs(); payDue();
  }

  // a deposit this browser kept (a reload, or a wait that ran out) is finished while the key is open
  async function resumeAdd() {
    const k = D.key ? D.key() : null;
    if (!shield || !k || L.resuming) return;
    L.adding = true; L.resuming = true; paint();
    try {
      const r = await shield.resume({ key: k, onStep: addStep });
      if (r) await waitLanded();
      say('');
    } catch (e) { say(await addError(e), 'err'); L.sticky = true; }
    finally { clearTimeout(slowTimer); L.resuming = false; L.adding = false; paint(); requote(true); }
  }

  // Swaps under way are stepped while the lane is open, the tab seen or hidden (hidden, less often: the browser runs a hidden tab's timers about once a minute anyway,
  // and a claim or a take that waited for the tab to be seen again could miss its window); one that ends is said once.
  function follow(wait = POLL_MS) {
    clearTimeout(poll);
    if (!pair || !L.open || !L.recs.some((r) => r.state === 'working')) return;
    const g = gen, p = pair;
    poll = setTimeout(async () => {
      if (g !== gen) return;
      // (a look for earlier swaps steps what it finds itself: the two do not step the same swap at once, so a pass waits for it to end)
      if (recovering) { follow(POLL_MS); return; }
      try {
        const next = await p.pump();
        if (g !== gen) return;
        for (const r of next) {
          const was = known.get(r.id);
          if (was === 'working' && r.state !== 'working') { notify(r.state === 'done' ? 'Swap done' : 'Swap returned'); readMe(true); }
          known.set(r.id, r.state);
        }
        L.recs = next; paintRecs();
        payDue();
      } catch { /* the next pass */ }
      if (g === gen) follow(document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    }, wait);
  }
  // leaving the page while a swap is under way stops its steps: the browser asks first
  globalThis.addEventListener?.('beforeunload', (e) => { if (L.chain || L.recs.some((r) => r.state === 'working')) { e.preventDefault(); e.returnValue = ''; } });

  // ── events ──
  function dismiss(id) { const s = dismissed(); s.add(id); try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...s].slice(-50))); } catch { /* storage is a convenience */ } paintRecs(); }
  const setAmt = (v) => { L.amt = v; L.sticky = false; if (L.cls === 'err' && !L.busy) say(''); onState(); requote(); };
  host.addEventListener('input', (e) => { if (e.target.id === 'a-amt') { fit(e.target); setAmt(e.target.value.trim()); } });
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'a-amt' && !$('a-go').disabled) $('a-go').click(); });
  host.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-press-cancel]')) { cancelPress(); return; }
    if (t.closest('[data-pay-retry]')) { payRetry(t.closest('[data-pay-retry]').dataset.payRetry); return; }
    if (t.closest('#a-flip')) { if (L.busy || L.chain) return; L.dir = L.dir === 'b2e' ? 'e2b' : 'b2e'; L.amt = ''; $('a-amt').value = ''; L.q = null; L.qErr = ''; seq++; L.sticky = false; say(''); onState(); paint(); return; }
    const dm = t.closest('[data-dismiss]');
    if (dm) { dismiss(dm.dataset.dismiss); return; }
    const qk = t.closest('[data-quick]'); if (qk && !L.chain) { $('a-amt').value = qk.dataset.quick; setAmt(qk.dataset.quick); return; }
    if (t.closest('#a-go')) { const a = $('a-go').dataset.act; if (a === 'unlock') unlock(); else if (a === 'fund') D.fund(fundAsk || {}); else if (a === 'oneclick') oneClick(addAsk); else if (a === 'bpress') oneClickBtc(fundAsk); else if (a === 'chainGo') acceptPress(); else if (a === 'swap') swap(); else if (a === 'reread') { L.unread = null; paint(); readMe(); } else if (a === 'accept' && L.q) { L.q = { ...L.q, renewed: null }; L.sticky = false; say(''); paint(); } else if (a === 'acceptFee' && L.q) { L.q = { ...L.q, feeAccepted: true }; say(''); paint(); } }
  });
  recsHost?.addEventListener('click', (e) => {
    const dm = e.target.closest('[data-dismiss]'); if (dm) { dismiss(dm.dataset.dismiss); return; }
    if (e.target.closest('[data-press-cancel]')) { cancelPress(); return; }
    // a finished swap's next step: the page sends the BTC (its own panel); the links go where they say
    const nx = e.target.closest('[data-next="send"]');
    if (nx && onNext) { try { onNext({ act: 'send', sats: BigInt(nx.dataset.sats) }); } catch { /* the page's hook */ } }
    const wd = e.target.closest('[data-next="withdraw"]');
    if (wd && onNext) { try { onNext({ act: 'withdraw', id: wd.dataset.id, units: BigInt(wd.dataset.units) }); } catch { /* the page's hook */ } }
    const pr = e.target.closest('[data-pay-retry]'); if (pr) payRetry(pr.dataset.payRetry);
  });

  return {
    // The lane opens: the key is looked for, and with one open the pair client is made and what is under way is shown.
    async show() {
      L.open = true; mounted = true; paint();
      if (!pair) readMk();
      try { await D.load(); } catch (e) { say(`Could not load this lane: ${esc(plainError(e))}`, 'err'); return; }
      L.loaded = true; L.unlocked = D.unlocked; paint();
      if (D.unlocked) await begin();
    },
    hide() { L.open = false; clearInterval(refreshTimer); clearTimeout(poll); clearTimeout(qTimer); clearTimeout(marketTimer); },
    // read ahead what the lane needs once the key opens (a page calls it when the visitor shows an interest; signing in does too)
    warm,
    // a finished swap of BTC's ETH, sent on to `to` by the relay (the page asked where, and showed the fee)
    payTo: (id, to) => { payChosen(id, to); paintRecs(); payDue(); },
    payout: () => payout,
    // the Ethereum address the open key makes (the wallet sheet's), or null
    ethAddress: () => { const k = D.key ? D.key() : null; return k && payout ? payout.tacitAddress(k.priv) : null; },
    // the pair and amount a link names
    set({ dir: d, amt } = {}) {
      if (d && d !== L.dir && !L.busy && !L.chain) { L.dir = d === 'e2b' ? 'e2b' : 'b2e'; L.q = null; L.qErr = ''; seq++; }
      if (amt !== undefined && !L.busy && !L.chain) { L.amt = String(amt); $('a-amt').value = L.amt; }
      if (mounted) { paint(); if (L.amt) requote(true); }
    },
    state: () => ({ dir: L.dir, amt: L.amt }),
    get unlocked() { return D.unlocked; },
    // which key is open (null when none): what a page shows of the key's own may stay up while its pair client is opened again for the same key
    get key() { return keyOf(); },
    // whether the swaps of an earlier visit are still being looked for: 'looking' from the key's opening until the look ends, 'failed' while one that failed waits
    // to be made again, else null (a page that lists the swaps says 'looking' then, not that there are none)
    get looking() { return !D.unlocked || recovered ? null : lookFailed && !recovering ? 'failed' : 'looking'; },
    // the swaps the lane holds, and the open pair's copy of them as a file (fast/pair-keep.js), or null before the wallet is open
    records: () => L.recs.slice(),
    // the pair opener's `bitcoin` (fast/pair-wire.js): the address's own sats, for a page that sends them; null before the wallet is open
    bitcoin: () => opened?.bitcoin || null,
    balances: () => ({ ...L.bal }),
    refresh: () => readMe(true),
    keep: () => opened?.keep || null,
    // after a copy is read back: the swaps are found and stepped again
    reread: async () => { if (!pair) return; const g = gen, recs = await pair.records().catch(() => L.recs); if (g !== gen) return; L.recs = recs; paint(); follow(1000); },
  };
}
