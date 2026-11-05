// The fast bridge page: the providers there are, the key's TAC on Bitcoin, an amount and the best quote for it, and the swaps under
// way. What is not DOM is passed in, so the page's logic runs without a wallet.
//
//   const ui = mountFast({ root, keyS, signIn, open, discover })
//   root        the element the page draws in
//   keyS        the key session (trade/key.js): unlocked, key, onChange(fn)
//   signIn()    opens the key; resolves once one is open, rejects when the sheet is closed
//   discover()  -> [{ id, name, ref, terms }]: the providers to bridge with, terms as fastbridge-client.js termsOf makes them
//   open()      -> { balance(), quoteAll(providers, units), start({ quotes }), records(), run({ onChange }), recover() } for the open key
//               (fast/wire.js openFast)
//   wants       waiting for a provider when none takes the amount (fast/want.js makeWants): kept(pub), start(pub, units), stop(pub)
//   notify(text)  tells the holder, also when the page is in the background, that a provider can take what it waits with
//   pinned()    the pairing id of a provider the bridger came by a link of (fast/fmt.js pairId), quoted first when it quotes, or null
//   -> { lock(text), destroy() }

import { DEC, ONE, esc, fmtTac, parseTac, slowNet, pairId, highFee } from './fmt.js';
import { minutesFor } from './route.js';
export { fmtTac, parseTac, slowNet };
const pct = (fee, of) => (of > 0n ? `${(Number((fee * 1000000n) / of) / 10000).toFixed(2)}%` : '');
const SCAN = 'https://mempool.space/tx/';
const big = (xs, pick) => xs.reduce((a, x) => (pick(x) > a ? pick(x) : a), 0n);

// what a provider can take now: its most, or less when it says so
const capOf = (p) => { const t = p.terms; return t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount; };
const feeLine = (t) => `${(t.feeBps / 100).toFixed(2)}%${t.flatFee > 0n ? ` + ${fmtTac(t.flatFee)} TAC` : ''}`;

export function mountFast({ root, keyS, signIn, open, discover, wants = null, notify = () => {}, pinned = () => null, quoteDelayMs = 350, refreshMs = 30000, retryMs = 15000, say = () => {} }) {
  const doc = root.ownerDocument;
  const S = { providers: [], loaded: false, termsAt: 0, sess: null, pub: null, bal: null, amt: '', quotes: [], quote: null, best: null, seq: 0, busy: false, note: '', bad: false, recs: [], stop: null, timer: 0, opening: null, want: null, told: false, watch: 0, cost: null, sure: null };

  root.innerHTML = `
    <p class="fx-sum" id="fx-lp" aria-live="polite"></p>
    <div id="fx-form" hidden>
      <p class="eyebrow"><span>You bridge</span><span class="who num" id="fx-bal"></span></p>
      <div class="fx-amt"><input id="fx-amt" inputmode="decimal" placeholder="0" autocomplete="off" spellcheck="false" aria-label="TAC to bridge"><span>TAC</span><button class="linkbtn" id="fx-max" type="button" hidden>Max</button></div>
      <div class="fx-out" id="fx-out" hidden>
        <p class="eyebrow"><span>You receive, private</span><span class="who">in your Tacit wallet</span></p>
        <div class="fx-big"><output class="num" id="fx-big" for="fx-amt">0</output><span>TAC</span></div>
      </div>
      <div class="rows" id="fx-recv" hidden></div>
      <div class="kv" id="fx-wait" hidden><span></span><button class="linkbtn" id="fx-unwait" type="button">Stop waiting</button></div>
    </div>
    <button class="btn" id="fx-go" type="button" hidden>Open wallet</button>
    <p class="status" id="fx-st" role="status" aria-live="polite"></p>
    <div class="rows" id="fx-list" hidden></div>`;
  const $ = (id) => doc.getElementById(id);

  const note = (text, bad = false) => { S.note = text; S.bad = bad; paintNote(); say(text); };
  // what the status line says: the last thing that happened, or else what is wrong with the amount typed
  function paintNote() {
    const e = $('fx-st');
    e.textContent = S.note || (S.sess && !S.busy ? problem(parseTac(S.amt)) : '');
    e.className = `status${S.bad && S.note ? ' err' : ''}`;
  }

  // the providers to bridge with: not the key's own, which would only cost it the fees of a bridge with itself
  const others = () => S.providers.filter((p) => !(keyS.unlocked && keyS.key && p.id === keyS.key.pubHex));

  // what the providers together offer: the amounts they take, and the lowest fee
  function summary() {
    const ps = others();
    if (!ps.length) return null;
    const mins = ps.map((p) => p.terms.minAmount).sort((a, b) => (a < b ? -1 : 1));
    const best = ps.reduce((a, b) => (b.terms.feeBps < a.terms.feeBps || (b.terms.feeBps === a.terms.feeBps && b.terms.flatFee < a.terms.flatFee) ? b : a));
    return { count: ps.length, min: mins[0], max: big(ps, (p) => p.terms.maxAmount), cap: big(ps, capOf), best };
  }

  function paintProvider() {
    const e = $('fx-lp'), sm = summary();
    // with nobody providing, a key must still be able to open: it is how the first provider starts
    // the key's own offer is not one to bridge with, but it is online: the provider is told so, not that nobody is
    const mine = keyS.unlocked && keyS.key && S.providers.some((p) => p.id === keyS.key.pubHex);
    if (S.loaded && !sm && mine) { e.textContent = 'You are the provider online. Bridgers see your offer; to bridge yourself, use another wallet.'; return; }
    if (S.loaded && !sm) { e.innerHTML = `No provider is online right now. ${keyS.unlocked ? 'Enter an amount to wait for one, or provide below.' : 'Open your wallet to wait for one, or to provide.'} The regular bridge, which takes a few hours, is <a href="/#card=bridge">on the front page</a>.`; return; }
    if (!sm) { e.textContent = 'Reading the providers…'; return; }
    const t = sm.best.terms, many = sm.count > 1;
    e.innerHTML = `<b>${many ? `${sm.count} providers online` : esc(sm.best.name || 'Provider')}</b><span>${many ? 'from ' : ''}${esc(feeLine(t))} fee</span><span>${sm.cap > 0n ? `${esc(fmtTac(sm.min))} to ${esc(fmtTac(sm.cap))} TAC${sm.cap < sm.max ? ' now' : ''}` : 'full right now'}</span>`;
  }

  // the amount typed: what is wrong with it, or ''
  function problem(units) {
    const sm = summary();
    if (units == null) return S.amt.trim() ? 'That is not an amount.' : '';
    if (sm && units < sm.min) return `The least is ${fmtTac(sm.min)} TAC.`;
    if (sm && units > sm.max) return `The most is ${fmtTac(sm.max)} TAC.`;
    if (sm && units > sm.cap) return sm.cap > 0n ? `${sm.count > 1 ? 'The providers can' : 'The provider can'} take up to ${fmtTac(sm.cap)} TAC right now.` : `${sm.count > 1 ? 'The providers cannot' : 'The provider cannot'} take more right now.`;
    if (S.bal != null && units > S.bal) return 'That is more than your TAC on Bitcoin.';
    return '';
  }

  // the providers that take an amount now
  const takersOf = (units) => others().filter((p) => units >= p.terms.minAmount && units <= capOf(p));
  // an amount the key holds that no provider online takes now: one to wait with
  const waitable = (units) => !!wants && !!S.sess && !S.want && units != null && units > 0n && (S.bal == null || units <= S.bal) && !takersOf(units).length;
  const plain = (units) => (units / ONE).toString() + (units % ONE ? '.' + (units % ONE).toString().padStart(DEC, '0').replace(/0+$/, '') : '');

  function paintForm() {
    const signed = !!S.sess, form = $('fx-form'), go = $('fx-go'), recv = $('fx-recv'), out = $('fx-out'), wt = $('fx-wait');
    form.hidden = !signed;
    go.hidden = false;
    $('fx-bal').textContent = signed && S.bal != null ? `${fmtTac(S.bal)} TAC on Bitcoin` : '';
    $('fx-max').hidden = !(signed && S.bal > 0n);
    wt.hidden = !(signed && S.want);
    if (!wt.hidden) wt.firstElementChild.textContent = `Waiting for a provider for ${fmtTac(S.want.amount)} TAC`;
    if (!signed) { go.textContent = 'Open wallet'; go.disabled = S.busy; recv.hidden = true; out.hidden = true; return; }
    const units = parseTac(S.amt), bad = problem(units), q = S.quote, wait = waitable(units), short = !!(S.cost && S.cost.short);
    go.hidden = !!S.want && !q;
    if (wait) { recv.hidden = true; out.hidden = true; go.textContent = S.busy ? 'Working…' : 'Wait for a provider'; go.disabled = S.busy; paintNote(); return; }
    out.hidden = !q; recv.hidden = !q;
    if (q) {
      const c = S.cost, sm = summary();
      $('fx-big').textContent = fmtTac(q.evmAmount);
      const btc = c && c.total ? `<div class="kv"><span>Bitcoin fee</span><b class="num">≈ ${esc(c.total.toLocaleString('en-US'))} sats${c.take ? `<small>${esc(c.take.toLocaleString('en-US'))} of it is the provider's take</small>` : ''}</b></div>`
        : q.takeSats ? `<div class="kv"><span>Bitcoin fee</span><b class="num">${esc(q.takeSats.toLocaleString('en-US'))} sats<small>for the provider's take, and your own transaction's fee</small></b></div>` : '';
      recv.innerHTML = `${sm && sm.count > 1 && S.best ? `<div class="kv"><span>Provider</span><b>${esc(S.best.name || 'Provider')}</b></div>` : ''}<div class="kv"><span>Fee</span><b class="num">${esc(fmtTac(q.fee))} TAC<small>${esc(pct(q.fee, q.btcValue))}</small></b></div>${btc}
        <div class="kv"><span>Time</span><b class="num">about ${minutesFor(q.minConfs)} minutes<small>${Math.max(1, Number(q.minConfs) || 1)} Bitcoin confirmation${(Number(q.minConfs) || 1) > 1 ? 's' : ''}, then a pool settle</small></b></div>${highFee(q) ? `
        <p class="status err" role="alert" id="fx-high">High fee: this provider keeps ${esc(fmtTac(q.fee))} TAC (${esc(pct(q.fee, q.btcValue))}) of your ${esc(fmtTac(q.btcValue))} TAC, and you receive ${esc(fmtTac(q.evmAmount))}. A smaller bridge costs more in proportion, a larger one less, and the regular bridge may cost less.</p>` : ''}`;
    }
    go.textContent = S.busy ? 'Working…' : S.sure ? 'Press again to bridge' : 'Bridge';
    go.disabled = S.busy || !!bad || !q || units == null || short;
    paintNote();
  }

  const ago = (sec) => {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - Number(sec || 0));
    return d < 90 ? 'just now' : d < 5400 ? `${Math.round(d / 60)} minutes ago` : d < 172800 ? `${Math.round(d / 3600)} hours ago` : `${Math.round(d / 86400)} days ago`;
  };
  function paintList() {
    const e = $('fx-list'), recs = S.recs.slice(0, 10), open = recs.some((r) => !r.ended);
    e.hidden = !recs.length;
    e.innerHTML = recs.length ? `<div class="rows-h"><span>Your bridges</span></div>` + recs.map((r) => `
      <div class="fx-rec" data-id="${esc(r.id)}" data-phase="${esc(r.phase)}">
        <div class="kv"><b>${esc(r.title)}</b><span class="num">${esc(fmtTac(r.amount))} TAC${r.receive && r.receive !== '0' ? ` → ${esc(fmtTac(r.receive))} TAC` : ''}</span></div>
        ${r.returned ? '' : `<ol class="fx-steps" aria-label="Steps">${r.steps.map((s, i) => `<li${i < r.at || r.ended ? ' class="on"' : i === r.at ? ' class="at"' : ''}>${esc(s)}</li>`).join('')}</ol>`}
        <p class="note">${esc(r.detail)}${r.error && !r.ended ? ` <span class="err">${esc(r.error)}</span>` : ''}</p>
        <p class="note fx-meta">${esc(ago(r.created))}${r.lockTxid ? ` · <a href="${SCAN}${esc(r.lockTxid)}" target="_blank" rel="noopener noreferrer">Bitcoin lock ↗</a>` : ''}${r.ended && !r.returned ? ' · <a href="/assets/">Your TAC in Assets</a>' : ''}</p>
      </div>`).join('') + (open ? '<p class="note">Keep this page open until it is done: each step is taken as Bitcoin confirms.</p>' : '') : '';
  }

  // every provider online as a tile, the key's own first and marked: what a provider sees of its own offer, and a bridger of the market
  function paintTiles() {
    const e = doc.getElementById('fx-tiles');
    if (!e) return;
    const me = keyS.unlocked && keyS.key ? keyS.key.pubHex : null;
    const ps = S.providers.slice().sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.terms.feeBps - b.terms.feeBps));
    e.hidden = !ps.length;
    e.innerHTML = ps.length ? `<p class="eyebrow"><span>Providers online</span><span class="who num">${ps.length}</span></p>
      <div class="lp-grid">${ps.map((p) => `<div class="lp-tile${p.id === me ? ' mine' : ''}">
        <div class="lp-top"><b>${esc(p.name || 'Provider')}</b>${p.id === me ? '<span class="lp-tag">You</span>' : ''}</div>
        <div class="kv"><span>Fee</span><b class="num">${esc(feeLine(p.terms))}</b></div>
        <div class="kv"><span>Takes</span><b class="num">${capOf(p) >= p.terms.minAmount ? `${esc(fmtTac(p.terms.minAmount))} to ${esc(fmtTac(capOf(p)))} TAC` : 'full right now'}</b></div>
      </div>`).join('')}</div>` : '';
  }

  const paint = () => { paintProvider(); paintTiles(); paintForm(); paintNote(); paintList(); };

  // ── the providers ──
  // what they can take changes with every bridge: read again when a session opens and while an amount is typed
  async function readProviders(force = false) {
    if (!force && Date.now() - S.termsAt < refreshMs) return;
    S.termsAt = Date.now();
    try {
      const ps = await discover();
      if (ps.length || !S.providers.length) S.providers = ps;
    } catch { /* the providers already read stand */ }
    S.loaded = true;
    paint();
  }

  // ── the key ──
  function reset(text) {
    if (S.stop) { S.stop(); S.stop = null; }
    clearTimeout(S.timer); clearInterval(S.watch); S.seq++;
    Object.assign(S, { sess: null, pub: null, bal: null, quotes: [], quote: null, best: null, amt: '', recs: [], busy: false, opening: null, want: null, told: false, cost: null, sure: null });
    $('fx-amt').value = '';
    note(text || '');
    paint();
  }
  async function openSession() {
    if (S.sess) return S.sess;
    if (S.opening) return S.opening;
    const pub = keyS.key.pubHex;
    S.opening = (async () => {
      S.busy = true; note('Reading your TAC on Bitcoin…'); paintForm();
      try {
        const sess = await open();
        if (!keyS.unlocked || keyS.key.pubHex !== pub) return null;
        S.sess = sess; S.pub = pub;
        S.want = wants ? wants.kept(pub) : null; S.told = false; watchWant();
        S.bal = await sess.balance();
        S.stop = sess.run({ onChange: (list) => { if (S.sess === sess) { S.recs = list; paintList(); } } });
        sess.recover().then((found) => { if (found.length && S.sess === sess) sess.records().then((l) => { S.recs = l; paintList(); }); }).catch(() => {});
        note('');
        return sess;
      } catch (e) {
        S.sess = null; note(wording(e), !slowNet(e));
        // Ethereum's nodes not answering is passing: the key is read again on its own
        if (slowNet(e)) setTimeout(() => { if (keyS.unlocked && keyS.key.pubHex === pub && !S.sess) openSession(); }, retryMs);
        return null;
      } finally { S.busy = false; S.opening = null; paint(); }
    })();
    return S.opening;
  }
  keyS.onChange(() => {
    if (!keyS.unlocked) reset('Your Tacit wallet is locked.');
    else if (S.sess && keyS.key.pubHex !== S.pub) reset('');
    else paint();
  });

  // ── the amount ──
  // a bridger who came by a provider's link is paired with it whenever it quotes, the others kept behind it in their order
  const pinFirst = (quotes) => { const pin = pinned(); return pin ? quotes.slice().sort((a, b) => (pairId(b.provider.id) === pin) - (pairId(a.provider.id) === pin)) : quotes; };
  function typed() {
    readProviders();
    S.amt = $('fx-amt').value; S.quotes = []; S.quote = null; S.best = null; S.note = ''; S.cost = null; S.sure = null;
    clearTimeout(S.timer); const seq = ++S.seq;
    const units = parseTac(S.amt);
    paintForm();
    if (units == null || problem(units) || !S.sess) return;
    S.timer = setTimeout(async () => {
      try {
        const eligible = others().filter((p) => units >= p.terms.minAmount && units <= capOf(p));
        if (!eligible.length) { if (seq === S.seq) note(problem(units) || 'No provider can take that amount right now.', !wants); return; }
        const r = await S.sess.quoteAll(eligible, units);
        if (seq !== S.seq) return;
        if (!r.quotes.length) { note(r.failed[0] ? wording(r.failed[0].error) : 'No provider can take that amount right now.', true); return; }
        S.quotes = pinFirst(r.quotes); S.quote = S.quotes[0].quote; S.best = S.quotes[0].provider; paintForm();
        // what the lock costs on Bitcoin, and whether this address can pay it, is read before the press and not found out at it
        if (S.sess.cost) {
          const sess = S.sess, c = await sess.cost({ quote: S.quote, provider: S.best }).catch(() => null);
          if (seq === S.seq && S.sess === sess && c) { S.cost = c; if (c.short) note(shortText(c), true); paintForm(); }
        }
      } catch (e) { if (seq === S.seq) note(wording(e), true); }
    }, quoteDelayMs);
  }
  $('fx-amt').addEventListener('input', typed);
  $('fx-max').addEventListener('click', () => {
    const sm = summary(), lim = sm ? sm.cap : S.bal, cap = S.bal > lim ? lim : S.bal;
    $('fx-amt').value = plain(cap);
    typed();
  });

  // ── waiting for a provider ──
  // the want is kept in this browser and posted to the boards; the providers are read again every refresh while it stands, and the
  // holder is told once, here and in a notification, when one can take it
  function watchWant() {
    clearInterval(S.watch);
    if (!S.want) return;
    const look = async () => {
      if (!S.want || S.told) return;
      await readProviders(true);
      if (!S.want || S.told || !takersOf(S.want.amount).length) return;
      S.told = true;
      const text = `A provider can take your ${fmtTac(S.want.amount)} TAC now.`;
      note(text); notify(text);
      if (!S.amt.trim() || parseTac(S.amt) === S.want.amount) { $('fx-amt').value = plain(S.want.amount); typed(); }
    };
    S.watch = setInterval(look, refreshMs);
    look();
  }
  async function wait(units) {
    S.busy = true; paintForm();
    try {
      await (wants.ask ? wants.ask() : null);
      S.want = await wants.start(S.pub, units); S.told = false;
      note('You are told here, and on the front page, when one can take it.');
      watchWant();
    } catch (e) { note(wording(e), true); } finally { S.busy = false; paint(); }
  }
  function unwait() {
    if (!S.want || !S.pub) return;
    const pub = S.pub;
    S.want = null; S.told = false; clearInterval(S.watch);
    wants.stop(pub).catch(() => {});
    note(''); paint();
  }
  $('fx-unwait').addEventListener('click', unwait);

  // ── the press ──
  async function go() {
    if (S.busy) return;
    if (!keyS.unlocked) {
      try { await signIn(); } catch (e) { if (!e?.unlockCancelled) note(wording(e), true); return; }
      await openSession();
      return;
    }
    if (!S.sess) { await openSession(); return; }
    if (!S.quote && waitable(parseTac(S.amt))) { await wait(parseTac(S.amt)); return; }
    if (!S.quote) return;
    if (S.cost && S.cost.short) { note(shortText(S.cost), true); return; }
    // a lock on Bitcoin is not taken back for about a day if the provider stops: the first press says so, the same press again goes
    const key = `${S.quote.id}|${S.quote.btcValue}`, who = S.best && S.best.name ? S.best.name : 'the provider';
    if (!(S.sure && S.sure.key === key && Date.now() - S.sure.at < 180e3)) {
      S.sure = { key, at: Date.now() };
      note(`${highFee(S.quote) ? `High fee: ${who} keeps ${fmtTac(S.quote.fee)} TAC (${pct(S.quote.fee, S.quote.btcValue)}). ` : ''}This locks ${fmtTac(S.quote.btcValue)} TAC on Bitcoin until ${who} has paid you ${fmtTac(S.quote.evmAmount)} private TAC in the pool, in about ${minutesFor(S.quote.minConfs)} minutes. If it does not, the lock returns to your address after about a day. Press again to bridge.`);
      paintForm();
      return;
    }
    S.sure = null;
    S.busy = true; note('Locking your TAC on Bitcoin…'); paintForm();
    try {
      // a quote close to its end is asked for again, from every provider that gave one
      const soon = Math.floor(Date.now() / 1000) + 90;
      let quotes = S.quotes;
      if (quotes.some((x) => Number(x.quote.validUntil) <= soon)) {
        const r = await S.sess.quoteAll(quotes.map((x) => x.provider), S.quote.btcValue);
        if (!r.quotes.length) throw new Error('the quote expired');
        quotes = pinFirst(r.quotes);
      }
      await S.sess.start({ quotes });
      if (S.want) { const pub = S.pub; S.want = null; S.told = false; clearInterval(S.watch); wants.stop(pub).catch(() => {}); }
      S.recs = await S.sess.records(); S.quotes = []; S.quote = null; S.best = null; S.amt = ''; $('fx-amt').value = '';
      note('Started. It is listed below, and each step is taken as Bitcoin confirms.');
      S.sess.balance().then((b) => { S.bal = b; paintForm(); }).catch(() => {});
    } catch (e) { note(wording(e), true); } finally { S.busy = false; paint(); }
  }
  $('fx-go').addEventListener('click', go);

  // what the address lacks for the Bitcoin fee, in words: the front page's Bitcoin tab is where sats come in
  const shortText = (c) => `This key's Bitcoin address holds ${(c.have || 0).toLocaleString('en-US')} sats for fees and this bridge needs about ${(c.need || c.total || 0).toLocaleString('en-US')}. Add some from Receive in the Bitcoin tab on the front page.`;

  // a message in the page's words for what went wrong
  function wording(e) {
    const m = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e || '');
    if (slowNet(e)) return 'Ethereum is slow to answer right now. This page tries again on its own.';
    if (/already part of a swap/.test(m)) return 'This note is already in a bridge.';
    if (/do not cover the amount/.test(m)) return 'Your TAC on Bitcoin does not cover that amount in one go.';
    if (/quote expired|expires too soon/.test(m)) return 'The quote ran out. Try again.';
    if (/fee is above the limit/.test(m)) return 'The provider keeps almost all of that amount as its fee, so this page does not quote it.';
    if (/is not the one this page expects/.test(m)) return 'This provider is not the one this page knows.';
    if (/not enough sats to fund/.test(m)) { const x = /need (\d+), have (\d+)/.exec(m); return x ? shortText({ need: Number(x[1]), have: Number(x[2]) }) : 'This key\'s Bitcoin address does not hold enough sats for the fee.'; }
    if (/cannot hold that amount|cannot take that amount/.test(m)) return 'The provider cannot take that amount right now. Try a smaller amount.';
    return m.length > 160 ? `${m.slice(0, 157)}…` : m || 'Something went wrong. Try again.';
  }

  paint();
  readProviders(true).then(() => { if (keyS.unlocked && S.providers.length) openSession(); });
  return {
    lock: (text) => reset(text),
    destroy: () => { if (S.stop) S.stop(); clearTimeout(S.timer); clearInterval(S.watch); },
  };
}
