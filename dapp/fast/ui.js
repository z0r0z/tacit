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
//   -> { lock(text), destroy() }

import { DEC, ONE, esc, fmtTac, parseTac } from './fmt.js';
export { fmtTac, parseTac };
const pct = (fee, of) => (of > 0n ? `${(Number((fee * 1000000n) / of) / 10000).toFixed(2)}%` : '');
const SCAN = 'https://mempool.space/tx/';
const big = (xs, pick) => xs.reduce((a, x) => (pick(x) > a ? pick(x) : a), 0n);

// what a provider can take now: its most, or less when it says so
const capOf = (p) => { const t = p.terms; return t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount; };
const feeLine = (t) => `${(t.feeBps / 100).toFixed(2)}%${t.flatFee > 0n ? ` + ${fmtTac(t.flatFee)} TAC` : ''}`;

export function mountFast({ root, keyS, signIn, open, discover, quoteDelayMs = 350, refreshMs = 30000, say = () => {} }) {
  const doc = root.ownerDocument;
  const S = { providers: [], loaded: false, termsAt: 0, sess: null, pub: null, bal: null, amt: '', quotes: [], quote: null, best: null, seq: 0, busy: false, note: '', bad: false, recs: [], stop: null, timer: 0, opening: null };

  root.innerHTML = `
    <div id="fx-lp" class="rows flat" aria-live="polite"></div>
    <div id="fx-form" hidden>
      <p class="eyebrow"><span>Bridge TAC</span><span class="who num" id="fx-bal"></span></p>
      <div class="fx-amt"><input id="fx-amt" inputmode="decimal" placeholder="0" autocomplete="off" spellcheck="false" aria-label="TAC to bridge"><span>TAC</span><button class="linkbtn" id="fx-max" type="button" hidden>Max</button></div>
      <div class="rows" id="fx-recv" hidden></div>
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
    if (S.loaded && !sm && mine) { e.innerHTML = '<p class="empty">You are the provider online. Bridgers see your offer; to bridge yourself, use another wallet.</p>'; return; }
    if (S.loaded && !sm) { e.innerHTML = `<p class="empty">No provider is online right now. ${keyS.unlocked ? 'Provide below' : 'Open your wallet to provide'}, or bridge from the <a href="/">front page</a>, which takes a few hours.</p>`; return; }
    if (!sm) { e.innerHTML = '<p class="empty">Reading the providers…</p>'; return; }
    const t = sm.best.terms, many = sm.count > 1;
    e.innerHTML = `<div class="kv"><span>${many ? 'Providers' : 'Provider'}</span><b>${many ? `${sm.count} online` : esc(sm.best.name || 'Provider')}</b></div>
      <div class="kv"><span>Fee</span><b class="num">${many ? 'from ' : ''}${esc(feeLine(t))}</b></div>
      <div class="kv"><span>Amount</span><b class="num">${esc(fmtTac(sm.min))} to ${esc(fmtTac(sm.max))} TAC</b></div>${sm.cap < sm.max ? `
      <div class="kv"><span>Available now</span><b class="num">${esc(fmtTac(sm.cap))} TAC</b></div>` : ''}`;
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

  function paintForm() {
    const signed = !!S.sess, form = $('fx-form'), go = $('fx-go'), recv = $('fx-recv'), sm = summary();
    form.hidden = !signed || !sm;
    go.hidden = signed && !sm;
    $('fx-bal').textContent = signed && S.bal != null ? `${fmtTac(S.bal)} TAC on Bitcoin` : '';
    $('fx-max').hidden = !(signed && S.bal > 0n);
    if (!signed) { go.textContent = 'Open wallet'; go.disabled = S.busy; recv.hidden = true; return; }
    const units = parseTac(S.amt), bad = problem(units), q = S.quote;
    recv.hidden = !q;
    if (q) {
      recv.innerHTML = `${sm.count > 1 && S.best ? `<div class="kv"><span>Provider</span><b>${esc(S.best.name || 'Provider')}</b></div>` : ''}<div class="kv"><span>You pay</span><b class="num">${esc(fmtTac(q.btcValue))} TAC</b></div>
        <div class="kv"><span>You receive, private</span><b class="num">${esc(fmtTac(q.evmAmount))} TAC</b></div>
        <div class="kv"><span>Fee</span><b class="num">${esc(fmtTac(q.fee))} TAC<small>${esc(pct(q.fee, q.btcValue))}</small></b></div>${q.takeSats ? `
        <div class="kv"><span>Bitcoin network fee</span><b class="num">${esc(q.takeSats.toLocaleString('en-US'))} sats<small>for the provider's take</small></b></div>` : ''}`;
    }
    go.textContent = S.busy ? 'Working…' : 'Bridge';
    go.disabled = S.busy || !!bad || !q || units == null;
    paintNote();
  }

  function paintList() {
    const e = $('fx-list'), recs = S.recs.slice(0, 10);
    e.hidden = !recs.length;
    e.innerHTML = recs.length ? `<div class="rows-h"><span>Your bridges</span></div>` + recs.map((r) => `
      <div class="fx-rec" data-id="${esc(r.id)}" data-phase="${esc(r.phase)}">
        <div class="kv"><b>${esc(r.title)}</b><span class="num">${esc(fmtTac(r.amount))} TAC${r.receive && r.receive !== '0' ? ` → ${esc(fmtTac(r.receive))} TAC` : ''}</span></div>
        ${r.returned ? '' : `<ol class="fx-steps" aria-label="Steps">${r.steps.map((s, i) => `<li${i < r.at || r.ended ? ' class="on"' : i === r.at ? ' class="at"' : ''}>${esc(s)}</li>`).join('')}</ol>`}
        <p class="note">${esc(r.detail)}${r.lockTxid ? ` <a href="${SCAN}${esc(r.lockTxid)}" target="_blank" rel="noopener noreferrer">Bitcoin lock ↗</a>` : ''}</p>
      </div>`).join('') : '';
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
        <div class="kv"><span>Takes</span><b class="num">${esc(fmtTac(p.terms.minAmount))} to ${esc(fmtTac(capOf(p)))} TAC</b></div>
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
    clearTimeout(S.timer); S.seq++;
    Object.assign(S, { sess: null, pub: null, bal: null, quotes: [], quote: null, best: null, amt: '', recs: [], busy: false, opening: null });
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
        S.bal = await sess.balance();
        S.stop = sess.run({ onChange: (list) => { if (S.sess === sess) { S.recs = list; paintList(); } } });
        sess.recover().then((found) => { if (found.length && S.sess === sess) sess.records().then((l) => { S.recs = l; paintList(); }); }).catch(() => {});
        note('');
        return sess;
      } catch (e) { S.sess = null; note(wording(e), true); return null; } finally { S.busy = false; S.opening = null; paint(); }
    })();
    return S.opening;
  }
  keyS.onChange(() => {
    if (!keyS.unlocked) reset('Your Tacit wallet is locked.');
    else if (S.sess && keyS.key.pubHex !== S.pub) reset('');
    else paint();
  });

  // ── the amount ──
  function typed() {
    readProviders();
    S.amt = $('fx-amt').value; S.quotes = []; S.quote = null; S.best = null; S.note = '';
    clearTimeout(S.timer); const seq = ++S.seq;
    const units = parseTac(S.amt);
    paintForm();
    if (units == null || problem(units) || !S.sess) return;
    S.timer = setTimeout(async () => {
      try {
        const eligible = others().filter((p) => units >= p.terms.minAmount && units <= capOf(p));
        if (!eligible.length) { if (seq === S.seq) note(problem(units) || 'No provider can take that amount right now.', true); return; }
        const r = await S.sess.quoteAll(eligible, units);
        if (seq !== S.seq) return;
        if (!r.quotes.length) { note(r.failed[0] ? wording(r.failed[0].error) : 'No provider can take that amount right now.', true); return; }
        S.quotes = r.quotes; S.quote = r.quotes[0].quote; S.best = r.quotes[0].provider; paintForm();
      } catch (e) { if (seq === S.seq) note(wording(e), true); }
    }, quoteDelayMs);
  }
  $('fx-amt').addEventListener('input', typed);
  $('fx-max').addEventListener('click', () => {
    const sm = summary(), lim = sm ? sm.cap : S.bal, cap = S.bal > lim ? lim : S.bal;
    $('fx-amt').value = (cap / ONE).toString() + (cap % ONE ? '.' + (cap % ONE).toString().padStart(DEC, '0').replace(/0+$/, '') : '');
    typed();
  });

  // ── the press ──
  async function go() {
    if (S.busy) return;
    if (!keyS.unlocked) {
      try { await signIn(); } catch (e) { if (!e?.unlockCancelled) note(wording(e), true); return; }
      await openSession();
      return;
    }
    if (!S.sess) { await openSession(); return; }
    if (!S.quote) return;
    S.busy = true; note('Locking your TAC on Bitcoin…'); paintForm();
    try {
      // a quote close to its end is asked for again, from every provider that gave one
      const soon = Math.floor(Date.now() / 1000) + 90;
      let quotes = S.quotes;
      if (quotes.some((x) => Number(x.quote.validUntil) <= soon)) {
        const r = await S.sess.quoteAll(quotes.map((x) => x.provider), S.quote.btcValue);
        if (!r.quotes.length) throw new Error('the quote expired');
        quotes = r.quotes;
      }
      await S.sess.start({ quotes });
      S.recs = await S.sess.records(); S.quotes = []; S.quote = null; S.best = null; S.amt = ''; $('fx-amt').value = '';
      note('Started.');
      S.sess.balance().then((b) => { S.bal = b; paintForm(); }).catch(() => {});
    } catch (e) { note(wording(e), true); } finally { S.busy = false; paint(); }
  }
  $('fx-go').addEventListener('click', go);

  // a message in the page's words for what went wrong
  function wording(e) {
    const m = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e || '');
    if (/already part of a swap/.test(m)) return 'This note is already in a bridge.';
    if (/do not cover the amount/.test(m)) return 'Your TAC on Bitcoin does not cover that amount in one go.';
    if (/quote expired|expires too soon/.test(m)) return 'The quote ran out. Try again.';
    if (/fee is above the limit/.test(m)) return 'The provider\'s fee is above what this page accepts.';
    if (/is not the one this page expects/.test(m)) return 'This provider is not the one this page knows.';
    if (/cannot hold that amount|cannot take that amount/.test(m)) return 'The provider cannot take that amount right now. Try a smaller amount.';
    return m.length > 160 ? `${m.slice(0, 157)}…` : m || 'Something went wrong. Try again.';
  }

  paint();
  readProviders(true).then(() => { if (keyS.unlocked && S.providers.length) openSession(); });
  return {
    lock: (text) => reset(text),
    destroy: () => { if (S.stop) S.stop(); clearTimeout(S.timer); },
  };
}
