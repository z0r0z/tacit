// The fast bridge page: a provider's terms, the key's TAC on Bitcoin, an amount and its quote, and the swaps under way. What
// is not DOM is passed in, so the page's logic runs without a wallet.
//
//   const ui = mountFast({ root, providers, keyS, signIn, open, info })
//   root        the element the page draws in
//   providers   [{ name, base, claimPub }]: the providers the page knows; the first that answers is used
//   keyS        the key session (trade/key.js): unlocked, key, onChange(fn)
//   signIn()    opens the key; resolves once one is open, rejects when the sheet is closed
//   open({ provider })  -> { fb, notes(), balance() } for the open key (fast/wire.js)
//   info(provider)      -> the provider's terms (fastbridge-http.js info)
//   -> { lock(text), destroy() }

const DEC = 8, ONE = 10n ** BigInt(DEC);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const group = (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
export function fmtTac(units, max = 4) {
  const n = BigInt(units), whole = n / ONE, frac = (n % ONE).toString().padStart(DEC, '0');
  const short = frac.slice(0, max).replace(/0+$/, '');
  const text = (k) => `${group(String(whole))}${k ? `.${k}` : ''}`;
  return n > 0n && whole === 0n && !short ? text(frac.replace(/0+$/, '')) : text(short);
}
export function parseTac(text) {
  const t = String(text).trim().replace(/,/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  if (f.length > DEC) return null;
  const n = BigInt(w || '0') * ONE + BigInt(f.padEnd(DEC, '0') || '0');
  return n > 0n ? n : null;
}
const pct = (fee, of) => (of > 0n ? `${(Number((fee * 1000000n) / of) / 10000).toFixed(2)}%` : '');
const SCAN = 'https://mempool.space/tx/';

export function mountFast({ root, providers = [], keyS, signIn, open, info, quoteDelayMs = 350, say = () => {} }) {
  const doc = root.ownerDocument;
  const S = { provider: null, terms: null, offline: false, sess: null, pub: null, bal: null, amt: '', quote: null, seq: 0, busy: false, note: '', bad: false, recs: [], stop: null, timer: 0, opening: null };

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
  function paintNote() { const e = $('fx-st'); e.textContent = S.note; e.className = `status${S.bad ? ' err' : ''}`; }

  function paintProvider() {
    const e = $('fx-lp'), t = S.terms;
    if (S.offline) { e.innerHTML = '<p class="empty">No provider is online right now. Bridging from the <a href="/">front page</a> takes a few hours.</p>'; return; }
    if (!t) { e.innerHTML = '<p class="empty">Reading the provider…</p>'; return; }
    e.innerHTML = `<div class="kv"><span>Provider</span><b>${esc(S.provider.name || 'Provider')}</b></div>
      <div class="kv"><span>Fee</span><b class="num">${esc((t.feeBps / 100).toFixed(2))}%${t.flatFee > 0n ? ` + ${esc(fmtTac(t.flatFee))} TAC` : ''}</b></div>
      <div class="kv"><span>Amount</span><b class="num">${esc(fmtTac(t.minAmount))} to ${esc(fmtTac(t.maxAmount))} TAC</b></div>`;
  }

  // the amount typed: what is wrong with it, or null
  function problem(units) {
    const t = S.terms;
    if (units == null) return S.amt.trim() ? 'That is not an amount.' : '';
    if (t && units < t.minAmount) return `The least is ${fmtTac(t.minAmount)} TAC.`;
    if (t && units > t.maxAmount) return `The most is ${fmtTac(t.maxAmount)} TAC.`;
    if (S.bal != null && units > S.bal) return 'That is more than your TAC on Bitcoin.';
    return '';
  }

  function paintForm() {
    const signed = !!S.sess, form = $('fx-form'), go = $('fx-go'), recv = $('fx-recv');
    form.hidden = !signed || S.offline;
    go.hidden = S.offline || !S.terms;
    $('fx-bal').textContent = signed && S.bal != null ? `${fmtTac(S.bal)} TAC on Bitcoin` : '';
    $('fx-max').hidden = !(signed && S.bal > 0n);
    if (!signed) { go.textContent = 'Open wallet'; go.disabled = S.busy; recv.hidden = true; return; }
    const units = parseTac(S.amt), bad = problem(units), q = S.quote;
    recv.hidden = !q;
    if (q) {
      recv.innerHTML = `<div class="kv"><span>You pay</span><b class="num">${esc(fmtTac(q.btcValue))} TAC</b></div>
        <div class="kv"><span>You receive, private</span><b class="num">${esc(fmtTac(q.evmAmount))} TAC</b></div>
        <div class="kv"><span>Fee</span><b class="num">${esc(fmtTac(q.fee))} TAC<small>${esc(pct(q.fee, q.btcValue))}</small></b></div>`;
    }
    go.textContent = S.busy ? 'Working…' : 'Bridge';
    go.disabled = S.busy || !!bad || !q || units == null;
    if (!S.busy && !S.note) { const e = $('fx-st'); e.textContent = bad; e.className = 'status'; }
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

  const paint = () => { paintProvider(); paintForm(); paintNote(); paintList(); };

  // ── the provider ──
  async function readProvider() {
    S.offline = false; S.terms = null; paint();
    for (const p of providers) {
      try {
        const i = await info(p);
        const claimPub = String(i.claimPub || '').toLowerCase();
        if (p.claimPub && p.claimPub.toLowerCase() !== claimPub) continue;
        S.provider = p;
        S.terms = { feeBps: Number(i.feeBps) || 0, flatFee: BigInt(i.flatFee ?? 0), minAmount: BigInt(i.minAmount), maxAmount: BigInt(i.maxAmount) };
        paint(); return;
      } catch { /* the next provider */ }
    }
    S.offline = true; paint();
  }

  // ── the key ──
  function reset(text) {
    if (S.stop) { S.stop(); S.stop = null; }
    clearTimeout(S.timer); S.seq++;
    Object.assign(S, { sess: null, pub: null, bal: null, quote: null, amt: '', recs: [], busy: false, opening: null });
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
        const sess = await open({ provider: S.provider });
        if (!keyS.unlocked || keyS.key.pubHex !== pub) return null;
        S.sess = sess; S.pub = pub;
        S.bal = await sess.balance();
        S.stop = sess.fb.run({ onChange: (list) => { if (S.sess === sess) { S.recs = list; paintList(); } } });
        sess.fb.recover().then((found) => { if (found.length && S.sess === sess) sess.fb.records().then((l) => { S.recs = l; paintList(); }); }).catch(() => {});
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
    S.amt = $('fx-amt').value; S.quote = null; S.note = '';
    clearTimeout(S.timer); const seq = ++S.seq;
    const units = parseTac(S.amt);
    paintForm();
    if (units == null || problem(units) || !S.sess) return;
    S.timer = setTimeout(async () => {
      try {
        const q = await S.sess.fb.quote(units);
        if (seq !== S.seq) return;
        S.quote = q; paintForm();
      } catch (e) { if (seq === S.seq) note(wording(e), true); }
    }, quoteDelayMs);
  }
  $('fx-amt').addEventListener('input', typed);
  $('fx-max').addEventListener('click', () => {
    const cap = S.terms && S.bal > S.terms.maxAmount ? S.terms.maxAmount : S.bal;
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
    const q = S.quote;
    if (!q) return;
    S.busy = true; note('Locking your TAC on Bitcoin…'); paintForm();
    try {
      const fresh = Number(q.validUntil) > Math.floor(Date.now() / 1000) + 90 ? q : await S.sess.fb.quote(q.btcValue);
      const notes = await S.sess.notes();
      await S.sess.fb.start({ quote: fresh, notes });
      S.recs = await S.sess.fb.records(); S.quote = null; S.amt = ''; $('fx-amt').value = '';
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
    return m.length > 160 ? `${m.slice(0, 157)}…` : m || 'Something went wrong. Try again.';
  }

  paint();
  readProvider().then(() => { if (keyS.unlocked && S.terms) openSession(); });
  return {
    lock: (text) => reset(text),
    destroy: () => { if (S.stop) S.stop(); clearTimeout(S.timer); },
  };
}
