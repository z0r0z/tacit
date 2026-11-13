
import { DEC, ONE, esc, fmtTac, parseTac, slowNet, pairId, highFee, highTake, keyTag, lineageText } from './fmt.js';
import { minutesFor } from './route.js';
export { fmtTac, parseTac, slowNet, lineageText };
const pct = (fee, of) => (of > 0n ? `${(Number((fee * 1000000n) / of) / 10000).toFixed(2)}%` : '');
const SCAN = 'https://mempool.space/tx/';
const KEPT = 'tacit-fast-providers-v1';
const big = (xs, pick) => xs.reduce((a, x) => (pick(x) > a ? pick(x) : a), 0n);

const capOf = (p) => { const t = p.terms; return t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount; };
const hasRoom = (p) => capOf(p) >= p.terms.minAmount && capOf(p) > 0n;
const feeLine = (t) => `${(t.feeBps / 100).toFixed(2)}%${t.flatFee > 0n ? ` + ${fmtTac(t.flatFee)} TAC` : ''}`;
const range = (a, b) => `${fmtTac(a, 2)} to ${fmtTac(b, 2)} TAC`;

export function mountFast({ root, keyS, signIn, open, discover, wants = null, notify = () => {}, pinned = () => null, quoteDelayMs = 350, refreshMs = 30000, retryMs = 15000, say = () => {} }) {
  const doc = root.ownerDocument;
  const S = { providers: [], empties: 0, loaded: false, termsAt: 0, sess: null, pub: null, bal: null, amt: '', quotes: [], quote: null, best: null, seq: 0, busy: false, note: '', bad: false, recs: [], stop: null, timer: 0, opening: null, want: null, told: false, watch: 0, cost: null, sure: null, checking: false, anyOnly: null };
  let kept = 0;
  try { kept = Number(doc.defaultView.localStorage.getItem(KEPT)) || 0; } catch { }

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
    <p class="alt" id="fx-alt">No provider fee? The <a href="/#card=bridge">regular bridge</a>, about 4 hours. Or <a href="#provide">provide liquidity</a> and earn the fee.</p>
    <div class="rows" id="fx-list" hidden></div>`;
  const $ = (id) => doc.getElementById(id);

  const note = (text, bad = false) => { S.note = text; S.bad = bad; paintNote(); say(text); };
  function paintNote() {
    const e = $('fx-st');
    e.textContent = S.note || (S.sess && !S.busy ? problem(parseTac(S.amt)) : '');
    e.className = `status${S.bad && S.note ? ' err' : ''}`;
  }

  const others = () => S.providers.filter((p) => !(keyS.unlocked && keyS.key && p.id === keyS.key.pubHex));

  function summary() {
    const ps = others();
    if (!ps.length) return null;
    const room = ps.filter(hasRoom), from = room.length ? room : ps;
    const mins = from.map((p) => p.terms.minAmount).sort((a, b) => (a < b ? -1 : 1));
    const best = from.reduce((a, b) => (b.terms.feeBps < a.terms.feeBps || (b.terms.feeBps === a.terms.feeBps && b.terms.flatFee < a.terms.flatFee) ? b : a));
    return { count: ps.length, min: mins[0], max: big(ps, (p) => p.terms.maxAmount), cap: big(room, capOf), best };
  }

  function paintProvider() {
    const e = $('fx-lp'), sm = summary();
    e.classList.toggle('held', !S.loaded && kept !== 1);
    const mine = keyS.unlocked && keyS.key && S.providers.some((p) => p.id === keyS.key.pubHex);
    if (S.loaded && !sm && mine) { e.textContent = 'You are the provider online. Bridgers see your offer; to bridge yourself, use another wallet.'; return; }
    if (S.loaded && !sm) { e.textContent = `No provider is online right now. ${keyS.unlocked ? 'Enter an amount to wait for one, or provide below.' : 'Open your wallet to wait for one, or to provide.'}`; return; }
    if (!sm) { e.textContent = 'Reading the providers…'; return; }
    const t = sm.best.terms, many = sm.count > 1;
    e.innerHTML = `<b>${many ? `${sm.count} providers online` : esc(sm.best.name || 'Provider')}</b><span>${many ? 'from ' : ''}${esc(feeLine(t))} fee</span><span>${sm.cap > 0n ? `${esc(range(sm.min, sm.cap))}${sm.cap < sm.max ? ' now' : ''}` : 'full right now'}</span>`;
  }

  function problem(units) {
    const sm = summary();
    if (units == null) return S.amt.trim() ? 'That is not an amount.' : '';
    if (sm && units < sm.min) return `The least is ${fmtTac(sm.min)} TAC.`;
    if (sm && units > sm.max) return `The most is ${fmtTac(sm.max)} TAC.`;
    if (sm && units > sm.cap) return sm.cap > 0n ? `${sm.count > 1 ? 'The providers can' : 'The provider can'} take up to ${fmtTac(sm.cap)} TAC right now.` : `${sm.count > 1 ? 'The providers cannot' : 'The provider cannot'} take more right now.`;
    if (S.bal != null && units > S.bal) return 'That is more than your TAC on Bitcoin.';
    return '';
  }

  const byAmount = (units) => others().filter((p) => units >= p.terms.minAmount && units <= capOf(p));
  const takersOf = (units) => (S.anyOnly === units ? byAmount(units).filter((p) => p.terms.anyTac) : byAmount(units));
  const LEAST = 10n * ONE;
  const waitable = (units) => !!wants && !!S.sess && !S.want && units != null && units >= LEAST && (S.bal == null || units <= S.bal) && !takersOf(units).length;
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
      recv.innerHTML = `${sm && sm.count > 1 && S.best ? `<div class="kv"><span>Provider</span><b>${esc(S.best.name || 'Provider')}<small class="num">${esc(keyTag(S.best.id))}</small></b></div>` : ''}<div class="kv"><span>Fee</span><b class="num">${esc(fmtTac(q.fee))} TAC<small>${esc(pct(q.fee, q.btcValue))}</small></b></div>${btc}
        <div class="kv"><span>Time</span><b class="num">about ${minutesFor(q.minConfs)} minutes<small>${Math.max(1, Number(q.minConfs) || 1)} Bitcoin confirmation${(Number(q.minConfs) || 1) > 1 ? 's' : ''}, then a pool settle</small></b></div>${highTake(q) ? `
        <p class="status err" role="alert" id="fx-high-take">High Bitcoin fee: this provider asks ${esc(Number(q.takeSats).toLocaleString('en-US'))} sats for its take, well above what it costs at the current rate. Other providers may ask less.</p>` : ''}${highFee(q) ? `
        <p class="status err" role="alert" id="fx-high">High fee: this provider keeps ${esc(fmtTac(q.fee))} TAC (${esc(pct(q.fee, q.btcValue))}) of your ${esc(fmtTac(q.btcValue))} TAC, and you receive ${esc(fmtTac(q.evmAmount))}. A smaller bridge costs more in proportion, a larger one less, and the regular bridge may cost less.</p>` : ''}`;
    }
    go.textContent = S.busy ? 'Working…' : S.checking ? 'Checking…' : S.sure ? 'Press again to bridge' : 'Bridge';
    go.disabled = S.busy || S.checking || !!bad || !q || units == null || short;
    paintNote();
  }

  const ago = (sec) => {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - Number(sec || 0));
    return d < 90 ? 'just now' : d < 5400 ? `${Math.round(d / 60)} minutes ago` : d < 172800 ? `${Math.round(d / 3600)} hours ago` : `${Math.round(d / 86400)} days ago`;
  };
  function paintList() {
    const e = $('fx-list'), recs = S.recs.slice(0, 10), open = recs.some((r) => ['built', 'broadcast', 'offered', 'claiming'].includes(r.phase));
    e.hidden = !recs.length;
    e.innerHTML = recs.length ? `<div class="rows-h"><span>Your bridges</span>${open ? '<span class="fx-keep">Keep this page open until it is done</span>' : ''}</div>` + recs.map((r) => `
      <div class="fx-rec" data-id="${esc(r.id)}" data-phase="${esc(r.phase)}">
        <div class="kv"><b>${esc(r.title)}</b><span class="num">${esc(fmtTac(r.amount))} TAC${r.receive && r.receive !== '0' ? ` → ${esc(fmtTac(r.receive))} TAC` : ''}</span></div>
        ${r.returned ? '' : `<ol class="fx-steps" aria-label="Steps">${r.steps.map((s, i) => `<li${i < r.at || r.ended ? ' class="on"' : i === r.at ? ' class="at"' : ''}>${esc(s)}</li>`).join('')}</ol>`}
        <p class="note">${esc(r.detail)}${r.error && !r.ended ? ` <span class="err">${esc(r.error)}</span>` : ''}</p>
        <p class="note fx-meta">${esc(ago(r.created))}${r.lockTxid ? ` · <a href="${SCAN}${esc(r.lockTxid)}" target="_blank" rel="noopener noreferrer">Bitcoin lock ↗</a>` : ''}${r.ended && !r.returned ? ' · <a href="/">Your TAC, on the front page</a>' : ''}</p>
      </div>`).join('') : '';
  }

  function paintTiles() {
    const e = doc.getElementById('fx-tiles');
    if (!e) return;
    if (!S.loaded) {
      const n = Math.min(kept, 6);
      e.hidden = n < 2;
      e.innerHTML = n < 2 ? '' : `<p class="eyebrow"><span>Providers online</span><span class="who num">&nbsp;</span></p>
      <div class="lp-grid" aria-hidden="true">${'<div class="lp-tile"><div class="lp-top"><b>&nbsp;</b><small class="num lp-key">&nbsp;</small></div><div class="kv"><span>Fee</span><b class="num">…</b></div><div class="kv"><span>Takes</span><b class="num">…</b></div></div>'.repeat(n)}</div>`;
      return;
    }
    const me = keyS.unlocked && keyS.key ? keyS.key.pubHex : null;
    const ps = S.providers.slice().sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.terms.feeBps - b.terms.feeBps));
    const show = ps.length > 1 || (ps.length === 1 && ps[0].id === me);
    e.hidden = !show;
    e.innerHTML = show ? `<p class="eyebrow"><span>Providers online</span><span class="who num">${ps.length}</span></p>
      <div class="lp-grid">${ps.map((p) => `<div class="lp-tile${p.id === me ? ' mine' : ''}">
        <div class="lp-top"><b>${esc(p.name || 'Provider')}</b><small class="num lp-key">${esc(keyTag(p.id))}</small>${p.id === me ? '<span class="lp-tag">You</span>' : ''}</div>
        <div class="kv"><span>Fee</span><b class="num">${esc(feeLine(p.terms))}</b></div>
        <div class="kv"><span>Takes</span><b class="num">${hasRoom(p) ? esc(range(p.terms.minAmount, capOf(p))) : 'full right now'}</b></div>
      </div>`).join('')}</div>` : '';
  }

  const paint = () => { paintProvider(); paintTiles(); paintForm(); paintNote(); paintList(); };

  async function readProviders(force = false) {
    if (!force && Date.now() - S.termsAt < refreshMs) return;
    S.termsAt = Date.now();
    try {
      const ps = await discover();
      S.empties = ps.length ? 0 : S.empties + 1;
      if (ps.length || !S.providers.length || S.empties >= 2) S.providers = ps;
    } catch { }
    S.loaded = true;
    if (S.providers.length !== kept) { kept = S.providers.length; try { doc.defaultView.localStorage.setItem(KEPT, String(kept)); } catch { } }
    paint();
  }

  function reset(text) {
    if (S.stop) { S.stop(); S.stop = null; }
    clearTimeout(S.timer); clearInterval(S.watch); S.seq++;
    Object.assign(S, { sess: null, pub: null, bal: null, quotes: [], quote: null, best: null, amt: '', recs: [], busy: false, opening: null, want: null, told: false, cost: null, sure: null, checking: false, anyOnly: null });
    $('fx-amt').value = '';
    note(text || '');
    paint();
  }
  async function openSession() {
    if (S.sess) return S.sess;
    if (S.opening) return S.opening;
    const pub = keyS.key.pubHex;
    const me = S.opening = (async () => {
      S.busy = true; note('Reading your TAC on Bitcoin…'); paintForm();
      try {
        const sess = await open();
        if (!keyS.unlocked || keyS.key.pubHex !== pub || S.opening !== me) return null;
        S.sess = sess; S.pub = pub;
        S.want = wants ? wants.kept(pub) : null; S.told = false; watchWant();
        S.stop = sess.run({ onChange: (list) => { if (S.sess === sess) { S.recs = list; paintList(); } } });
        S.bal = await sess.balance();
        sess.recover().then((found) => { if (found.length && S.sess === sess) sess.records().then((l) => { S.recs = l; paintList(); }); }).catch(() => {});
        note('');
        return sess;
      } catch (e) {
        if (S.opening !== me) return null;
        S.sess = null; note(wording(e), !slowNet(e));
        if (slowNet(e)) setTimeout(() => { if (keyS.unlocked && keyS.key.pubHex === pub && !S.sess) openSession(); }, retryMs);
        return null;
      } finally { if (S.opening === me) { S.busy = false; S.opening = null; paint(); } }
    })();
    return me;
  }
  keyS.onChange(() => {
    if (!keyS.unlocked) { reset('Your Tacit wallet is locked.'); return; }
    if (S.sess && keyS.key.pubHex !== S.pub) reset('');
    if (!S.sess && !S.opening) openSession(); else paint();
  });

  const pinFirst = (quotes) => { const pin = pinned(); return pin ? quotes.slice().sort((a, b) => (pairId(b.provider.id) === pin) - (pairId(a.provider.id) === pin)) : quotes; };
  function typed() {
    readProviders();
    S.amt = $('fx-amt').value; S.quotes = []; S.quote = null; S.best = null; S.note = ''; S.cost = null; S.sure = null; S.checking = false; S.anyOnly = null;
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
        if (S.sess.cost) {
          const sess = S.sess, checking = 'Checking your TAC…';
          S.checking = true; note(checking); paintForm();
          const onProgress = (read) => { if (seq === S.seq && S.checking) { S.note = `${checking} ${Number(read).toLocaleString('en-US')} transfers read so far.`; paintNote(); } };
          let c = null, at = -1, refused = null, unread = null;
          for (let i = 0; i < S.quotes.length && at < 0; i++) {
            const x = S.quotes[i];
            try { c = await sess.cost({ quote: x.quote, provider: x.provider, onProgress }); at = i; }
            catch (e) {
              if (e && e.code === 'lineage') { refused ||= e; continue; }
              if (e && e.code === 'lineage_unread') unread = e;
              c = null; at = i;
            }
          }
          if (seq !== S.seq || S.sess !== sess) return;
          S.checking = false;
          if (S.note.startsWith(checking)) note('');
          if (at < 0) { S.quotes = []; S.quote = null; S.best = null; S.anyOnly = units; note(wording(refused), true); paintForm(); return; }
          if (at > 0) { S.quotes = [S.quotes[at], ...S.quotes.filter((_, k) => k !== at)]; S.quote = S.quotes[0].quote; S.best = S.quotes[0].provider; }
          if (unread) note(wording(unread), true);
          if (c) { S.cost = c; if (c.short) note(shortText(c), true); }
          paintForm();
        }
      } catch (e) { if (seq === S.seq) { S.checking = false; note(wording(e), true); paintForm(); } }
    }, quoteDelayMs);
  }
  $('fx-amt').addEventListener('input', typed);
  $('fx-max').addEventListener('click', () => {
    const sm = summary(), lim = sm && sm.cap > 0n ? sm.cap : S.bal, cap = S.bal > lim ? lim : S.bal;
    $('fx-amt').value = plain(cap);
    typed();
  });

  function watchWant() {
    clearInterval(S.watch);
    if (!S.want) return;
    const look = async () => {
      if (!S.want || S.told) return;
      await readProviders(true);
      if (!S.want || S.told) return;
      let ps = byAmount(S.want.amount);
      if (ps.length && S.sess && S.sess.reach) {
        const kind = await S.sess.reach(S.want.amount).catch(() => 'all');
        if (kind === 'any') ps = ps.filter((p) => p.terms.anyTac);
      }
      if (!S.want || S.told || !ps.length) return;
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

  async function go() {
    if (S.busy || S.checking) return;
    if (!keyS.unlocked) {
      try { await signIn(); } catch (e) { if (!e?.unlockCancelled) note(wording(e), true); return; }
      if (S.opening) await S.opening; else if (!S.sess && !S.bad) await openSession();
      return;
    }
    if (!S.sess) { await openSession(); return; }
    if (!S.quote && waitable(parseTac(S.amt))) { await wait(parseTac(S.amt)); return; }
    if (!S.quote) return;
    if (S.cost && S.cost.short) { note(shortText(S.cost), true); return; }
    const sure = () => {
      const who = S.best && S.best.name ? `${S.best.name} (${keyTag(S.best.id)})` : 'the provider';
      S.sure = { key: `${S.quote.id}|${S.quote.btcValue}`, at: Date.now() };
      note(`${highTake(S.quote) ? `High Bitcoin fee: ${who} asks ${Number(S.quote.takeSats).toLocaleString('en-US')} sats for its take, well above what it costs at the current rate. ` : ''}${highFee(S.quote) ? `High fee: ${who} keeps ${fmtTac(S.quote.fee)} TAC (${pct(S.quote.fee, S.quote.btcValue)}). ` : ''}This locks ${fmtTac(S.quote.btcValue)} TAC on Bitcoin until ${who} has paid you ${fmtTac(S.quote.evmAmount)} private TAC in the pool, in about ${minutesFor(S.quote.minConfs)} minutes. If it does not, the lock returns to your address after about a day. Press again to bridge.`);
    };
    if (!(S.sure && S.sure.key === `${S.quote.id}|${S.quote.btcValue}` && Date.now() - S.sure.at < 180e3)) { sure(); paintForm(); return; }
    S.sure = null;
    S.busy = true; note('Locking your TAC on Bitcoin…'); paintForm();
    let again = false, quotes = S.quotes, fits = [];
    try {
      const soon = Math.floor(Date.now() / 1000) + 150;
      if (quotes.some((x) => Number(x.quote.validUntil) <= soon)) {
        const r = await S.sess.quoteAll(quotes.map((x) => x.provider), S.quote.btcValue);
        if (!r.quotes.length) throw new Error('the quote expired');
        quotes = pinFirst(r.quotes);
      }
      const floor = BigInt(S.quote.evmAmount);
      if (!quotes.length) throw new Error('the quote expired');
      if (BigInt(quotes[0].quote.evmAmount) < floor) { S.quotes = quotes; S.quote = quotes[0].quote; S.best = quotes[0].provider; again = true; return; }
      fits = quotes.filter((x) => BigInt(x.quote.evmAmount) >= floor || (!highFee(x.quote) && !highTake(x.quote)));
      await S.sess.start({ quotes: fits });
      if (S.want) { const pub = S.pub; S.want = null; S.told = false; clearInterval(S.watch); wants.stop(pub).catch(() => {}); }
      S.recs = await S.sess.records(); S.quotes = []; S.quote = null; S.best = null; S.amt = ''; $('fx-amt').value = '';
      const unsent = S.recs[0] && S.recs[0].phase === 'built' && S.recs[0].error;
      note(unsent ? 'Signed, but Bitcoin has not taken the lock yet. It is listed below and sent again by itself while this page is open.' : 'Started. It is listed below, and each step is taken as Bitcoin confirms.');
      S.sess.balance().then((b) => { S.bal = b; paintForm(); }).catch(() => {});
    } catch (e) {
      const rest = /cannot hold that amount/.test(String((e && e.message) || e)) ? quotes.filter((x) => !fits.includes(x)) : [];
      if (rest.length) { S.quotes = rest; S.quote = rest[0].quote; S.best = rest[0].provider; again = true; } else note(wording(e), true);
    } finally {
      if (again) {
        S.cost = null;
        if (S.sess && S.sess.cost) { const sess = S.sess, seq = S.seq, c = await sess.cost({ quote: S.quote, provider: S.best }).catch(() => null); if (seq === S.seq && S.sess === sess && c) S.cost = c; }
      }
      S.busy = false; paint();
      if (again && S.quote) { if (S.cost && S.cost.short) note(`The quote changed. ${shortText(S.cost)}`, true); else { sure(); note(`The quote changed. ${S.note}`); } paintForm(); }
    }
  }
  $('fx-go').addEventListener('click', go);

  const shortText = (c) => `This key's Bitcoin address holds ${(c.have || 0).toLocaleString('en-US')} sats for fees and this bridge needs about ${(c.need || c.total || 0).toLocaleString('en-US')}. Add some from Receive in the Bitcoin tab on the front page.`;

  function wording(e) {
    const m = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e || '');
    if (slowNet(e)) return 'Ethereum is slow to answer right now. This page tries again on its own.';
    if (e && e.code === 'lineage') return lineageText(e);
    if (e && e.code === 'lineage_unread') return 'Could not read this TAC’s history from Bitcoin just now, so nothing was locked. Press again to try once more.';
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
  if (keyS.unlocked) openSession();
  readProviders(true).then(() => { if (keyS.unlocked && !S.sess && !S.opening) openSession(); });
  return {
    lock: (text) => reset(text),
    destroy: () => { if (S.stop) S.stop(); clearTimeout(S.timer); clearInterval(S.watch); },
  };
}
