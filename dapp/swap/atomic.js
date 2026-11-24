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
//             pending, relayWords), or null, and the button then says the balance is short. onBal(bal) hears each read of the balances; onOpen(opened) the
//             pair opener's answer once the key is open (its `bitcoin` is what a page sends the address's own sats with).
//
// A swap under way is stepped while the lane is open, the tab hidden or not (a hidden tab's timers run about once a minute, and a claim or a take that waits for the tab
// to be seen again can miss its window); and the page asks before it is left while one is under way.
import { esc, fmtUnits, parseUnits, plain } from '/trade/util.js?cb=9c8b4133';

const BTC_MODULE = '/trade/btc.js?cb=f4f79584';
const TETH_ID = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const DEC = 8, POLL_MS = 5000, HIDDEN_POLL_MS = 20000, QUOTE_MS = 300, REFRESH_MS = 15000, MARKET_MS = 60000, PEEK_MS = 3000;
// A swap starts only on a quote with more than two minutes left (fastbridge-pair.js quoteMarginSecs): the lane renews the quote it shows before then, and a press on
// one too near its end asks for a new one first
const RENEW_SECS = 150, START_SECS = 125;
const MARKET_MODULE = '/swap/atomic-market.js?cb=a626d195';
const COINS = { btc: { sym: 'BTC', mark: 'tk-btc', at: 'c-btc', where: 'Bitcoin' }, eth: { sym: 'ETH', mark: 'tk-teth', at: 'c-eth', where: 'Ethereum, private' } };
const SIDES = { b2e: ['btc', 'eth'], e2b: ['eth', 'btc'] };
const DISMISS_KEY = 'tacit-atomic-dismissed-v1';
const LOCK_GUESS_SATS = 3000;                                     // what Max keeps back for the Bitcoin fee until a quote has said what it is
const SHIELD_NOTE = 'The deposit from your wallet is public. The swap and your Bitcoin address are not linked to it on chain.';
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
    // which key is open: the pair client is one key's, and is dropped when another opens
    get pubHex() { return bitcoin?.session.unlocked ? bitcoin.session.key?.pubHex || null : null; },
    async signIn() { await load(); await bitcoin.signIn(); },
    fund(o) { bitcoin?.fund(o); },
    // the open key, for a deposit into its private balance: its private bytes (a copy), its public key and how it was opened
    key() { const s = bitcoin?.session; if (!s?.unlocked || !T?.wallet?.priv) return null; return { priv: Uint8Array.from(T.wallet.priv), pubHex: s.key.pubHex, mode: s.key.mode || null, address: s.key.address || null }; },
    async open() {
      await load();
      const s = bitcoin.session;
      if (!s.unlocked) throw new Error('Open your Tacit wallet first.');
      const wire = await import('/fast/pair-wire.js?cb=af4d888c');
      if (typeof wire.openPair !== 'function') throw new Error('Bitcoin and Ethereum swaps are not offered by this version of the page.');
      return wire.openPair({ T, ux: await getUx(), priv: Uint8Array.from(T.wallet.priv), pubHex: s.key.pubHex, wallet: provider, ask: () => {} });
    },
  };
}

export function makeAtomicLane({ host, notify = () => {}, wallet = () => null, provider = () => null, getUx = null, door = null, onState = () => {}, dir = 'b2e', now = nowSecs, recsHost = null, market = null, onRecs = () => {}, shield = null, onBal = () => {}, onOpen = () => {} }) {
  const D = door || bitcoinDoor({ notify, wallet, provider, getUx, onChange: () => keyChanged() });
  const L = { dir: dir === 'e2b' ? 'e2b' : 'b2e', amt: '', q: null, qErr: '', bal: { sats: null, eth: null, ethHeld: null, pending: 0n }, recs: [], busy: false, open: false, line: '', cls: '', unlocked: false, loaded: false, terms: null, mk: null, fits: null };
  let fundAsk = null, addAsk = null, pair = null, pairP = null, pairKey = null, gen = 0, opened = null, mounted = false, seq = 0, qTimer = 0, poll = 0, refreshTimer = 0, marketTimer = 0, recovered = false, recovering = null, lookFailed = false, reading = null, began = null;
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
    <div class="act">
      <button class="go" id="a-go" type="button" disabled>Open your Tacit wallet</button>
      <p class="q" id="a-q" role="status"></p>
    </div>`;

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
    L.bal = { sats: null, eth: null, ethHeld: null, pending: 0n }; L.recs = []; L.q = null; L.qErr = ''; L.unread = null; L.fits = null; L.terms = null; L.busy = false;
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
        paint();
        clearInterval(refreshTimer);
        refreshTimer = setInterval(() => { if (!document.hidden && L.open) { readMe(true); if (!recovered) findPast(); if (L.q && !L.busy && L.q.expiresAt - now() < RENEW_SECS) requote(true, true); } }, REFRESH_MS);
        if (recovered) follow(1000); else await findPast();
      } catch (e) { if (g === gen) say(esc(plainError(e)), 'err'); }
      finally { if (g === gen) began = null; }
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
        const worse = was && was.dir === q.dir && was.pay === q.pay && !q.blocked && (q.get < was.get || Number(q.networkFeeSats ?? 0) > Number(was.networkFeeSats ?? 0) * 1.1 + 100 || Number(q.takeFeeSats ?? 0) > Number(was.takeFeeSats ?? 0) * 1.1 + 100);
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
    const amount = amountBase(), q = L.q, [pk] = SIDES[L.dir], bal = balOf(pk), c = COINS[pk];
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
      if (pk === 'btc') { const need = amount + BigInt(q?.networkFeeSats ?? LOCK_GUESS_SATS); return { label: `Add ${fmt(need - bal)} BTC`, act: 'fund', fund: { sats: Number(need - bal), need: Number(need) } }; }
      // with a way to add ETH from an Ethereum wallet, the shortfall is offered (exactly: addUnits); else the button says what is short
      const add = shield ? addUnits(amount, bal) : 0n;
      if (add > 0n) return { label: `Add ${fmt(add)} ETH`, act: 'shield', add };
      return { label: held != null && amount <= held ? `${fmt(held - bal)} ETH stays back for the pool’s fee` : 'Not enough ETH in your private balance', off: true };
    }
    if (L.qErr) return { label: 'No quote', off: true };
    if (!q) return { label: 'Getting a quote…', off: true };
    if (q.blocked) return { label: 'Not at this price', off: true };
    if (q.renewed) return { label: 'Accept the new price', act: 'accept' };
    if (q.highFee && !q.feeAccepted) return { label: 'Accept the Bitcoin fee', act: 'acceptFee' };
    if (L.dir === 'b2e' && bal != null && q.networkFeeSats != null && amount + BigInt(q.networkFeeSats) > bal) { const need = amount + BigInt(q.networkFeeSats); return { label: 'Add sats for the Bitcoin fee', act: 'fund', fund: { sats: Number(need - bal), need: Number(need) } }; }
    return { label: `Swap ${COINS[SIDES[L.dir][0]].sym} → ${COINS[SIDES[L.dir][1]].sym}`, act: 'swap' };
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
      ['Time', etaText(q.etaSecs), ''],
      ['If it stops', L.dir === 'b2e' ? 'your BTC returns to you within about a day' : 'your ETH returns to your private balance after about 4 hours', ''],
      ...(q.warnings || []).map((w) => ['Note', w, 'warn']),
    ];
    rc.hidden = false;
    rc.innerHTML = rows(rows0);
  }
  function paintRecs() {
    const box = recsHost || $('a-sent'), gone = dismissed(), recs = L.recs.filter((r) => !gone.has(r.id));
    if (recsHost) $('a-sent').hidden = true;
    box.hidden = !recs.length;
    onRecs(recs);
    box.innerHTML = recs.map((r) => {
      const cls = r.state === 'done' ? 'ok' : r.state === 'working' ? 'wait' : 'warn', [pk, gk] = SIDES[r.dir] || SIDES.b2e;
      // both sides, each way; a swap found again from the key, or one whose provider has not offered yet, may not know an amount: that side is named without one
      // (a swap of BTC found again from the key sees only its Bitcoin lock, so its ETH amount is not known)
      const side = (v, k) => (v > 0n ? `${fmt(v)} ${COINS[k].sym}` : COINS[k].sym);
      const what = r.pay > 0n || r.get > 0n ? `${side(r.pay, pk)} → ${r.pay > 0n && r.get > 0n && r.state !== 'done' ? 'about ' : ''}${side(r.get, gk)}` : '';
      const eta = r.state === 'working' && r.etaSecs ? etaText(r.etaSecs) : '';
      const back = r.state === 'working' && r.refundAt ? `If it stops, your ${COINS[pk].sym} returns ${untilText(r.refundAt, now())} at the latest.` : '';
      // when the page must be open again: b2e, to claim the ETH by the pool deadline (else the BTC returns, later); e2b, once its ETH is locked, to take the BTC in time
      const locked = r.dir === 'e2b' && (r.steps || [])[1] && r.steps[1].state !== 'todo', by = r.state === 'working' && r.backBy ? clockText(r.backBy, now()) : '';
      const stay = r.state !== 'working' ? '' : !by ? 'Keep this page open until it is done.'
        : r.dir === 'b2e' ? `Keep this page open until it is done. If you close it, come back by ${by}: the ETH has to be claimed by then, or your BTC returns by itself after about a day.`
          : locked ? `Keep this page open until it is done. If you close it, come back by ${by}: the BTC has to be taken in time, or the ETH you locked can be lost.` : 'Keep this page open until it is done.';
      const steps = (r.steps || []).map((s) => `<li class="${esc(s.state)}" data-step="${esc(s.key)}"><i aria-hidden="true"></i>${esc(s.title)}</li>`).join('');
      return `<div class="${cls}" data-rec="${esc(r.id)}"><span><i class="dot" aria-hidden="true"></i><b>${esc(r.title)}</b></span><span>${eta ? esc(eta) : ''}${r.state === 'working' ? '' : ` <button class="link" type="button" data-dismiss="${esc(r.id)}" aria-label="Dismiss">×</button>`}</span>
        ${what ? `<span class="what">${esc(what)}</span>` : ''}${steps ? `<ol class="stp">${steps}</ol>` : ''}${r.detail || back ? `<small>${esc([r.detail, back].filter(Boolean).join(' '))}</small>` : ''}${stay ? `<small class="stay${by ? ' by' : ''}">${esc(stay)}</small>` : ''}</div>`;
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
    paintRcpt(); paintRecs();
    const gt = gate(), go = $('a-go');
    go.textContent = gt.label; go.disabled = !!gt.off; go.dataset.act = gt.act || ''; fundAsk = gt.fund || null; addAsk = gt.add || null;
    // what a deposit from the wallet shows on chain, said under the button that makes it
    if (gt.act === 'shield' && !L.busy && (!L.line || L.cls === 'hint')) say(SHIELD_NOTE, 'hint');
    else if (gt.act !== 'shield' && L.cls === 'hint') say('');
    if (L.qErr && !L.busy) say(esc(L.qErr), 'err');
    else if (L.q?.blocked && !L.busy) say(esc(L.q.blocked.charAt(0).toUpperCase() + L.q.blocked.slice(1) + (/[.!?]$/.test(L.q.blocked) ? '' : '.')), 'err');
    else if (L.q?.highFee && !L.q.feeAccepted && !L.q.renewed && !L.busy) say(esc(`The Bitcoin fee is about ${L.q.highFee.sats.toLocaleString('en-US')} sats, ${(L.q.highFee.bps / 100).toFixed(1)}% of the amount. Accept it to go on, or swap a larger amount.`), 'warn');
    else if (L.cls === 'err' && !L.busy && !L.sticky) say('');
  }

  // ── actions ──
  async function unlock() {
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
      L.amt = ''; $('a-amt').value = ''; L.q = null; L.qErr = '';
      say('');
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
  // One wallet transaction deposits the shortfall and the relay finishes it; the page then reads the balance until the swap can be made, and the button says so.
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
  async function addEth(units) {
    const k = D.key ? D.key() : null;
    if (L.adding || !units || !k || !shield) return;
    L.adding = true; L.sticky = false; paint();
    let kept = false;
    try {
      await shield.start({ key: k, units, onStep: addStep });
      await waitLanded();
      say('');
    } catch (e) {
      kept = !!e?.kept;
      if (!kept) { say(await addError(e), 'err'); L.sticky = true; }
    } finally { clearTimeout(slowTimer); L.adding = false; paint(); requote(true); }
    if (kept) resumeAdd();
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
      } catch { /* the next pass */ }
      if (g === gen) follow(document.hidden ? HIDDEN_POLL_MS : POLL_MS);
    }, wait);
  }
  // leaving the page while a swap is under way stops its steps: the browser asks first
  globalThis.addEventListener?.('beforeunload', (e) => { if (L.recs.some((r) => r.state === 'working')) { e.preventDefault(); e.returnValue = ''; } });

  // ── events ──
  function dismiss(id) { const s = dismissed(); s.add(id); try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...s].slice(-50))); } catch { /* storage is a convenience */ } paintRecs(); }
  const setAmt = (v) => { L.amt = v; L.sticky = false; if (L.cls === 'err' && !L.busy) say(''); onState(); requote(); };
  host.addEventListener('input', (e) => { if (e.target.id === 'a-amt') setAmt(e.target.value.trim()); });
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'a-amt' && !$('a-go').disabled) $('a-go').click(); });
  host.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#a-flip')) { if (L.busy) return; L.dir = L.dir === 'b2e' ? 'e2b' : 'b2e'; L.amt = ''; $('a-amt').value = ''; L.q = null; L.qErr = ''; seq++; L.sticky = false; say(''); onState(); paint(); return; }
    const dm = t.closest('[data-dismiss]');
    if (dm) { dismiss(dm.dataset.dismiss); return; }
    const qk = t.closest('[data-quick]'); if (qk) { $('a-amt').value = qk.dataset.quick; setAmt(qk.dataset.quick); return; }
    if (t.closest('#a-go')) { const a = $('a-go').dataset.act; if (a === 'unlock') unlock(); else if (a === 'fund') D.fund(fundAsk || {}); else if (a === 'shield') addEth(addAsk); else if (a === 'swap') swap(); else if (a === 'reread') { L.unread = null; paint(); readMe(); } else if (a === 'accept' && L.q) { L.q = { ...L.q, renewed: null }; L.sticky = false; say(''); paint(); } else if (a === 'acceptFee' && L.q) { L.q = { ...L.q, feeAccepted: true }; say(''); paint(); } }
  });
  recsHost?.addEventListener('click', (e) => { const dm = e.target.closest('[data-dismiss]'); if (dm) dismiss(dm.dataset.dismiss); });

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
    // the pair and amount a link names
    set({ dir: d, amt } = {}) {
      if (d && d !== L.dir && !L.busy) { L.dir = d === 'e2b' ? 'e2b' : 'b2e'; L.q = null; L.qErr = ''; seq++; }
      if (amt !== undefined && !L.busy) { L.amt = String(amt); $('a-amt').value = L.amt; }
      if (mounted) { paint(); if (L.amt) requote(true); }
    },
    state: () => ({ dir: L.dir, amt: L.amt }),
    get unlocked() { return D.unlocked; },
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
