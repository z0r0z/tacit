
import { DEC, ONE, esc, fmtTac, parseTac, slowNet, pairId, highFee, highTake, keyTag, lineageText, timelockText } from './fmt.js';
import { minutesFor } from './route.js';
import { sweepRoom } from './sweep.js';
import { costBySize, waitLevels } from './ladder.js';
import { feeOf, meetsPrice, noWorse } from '../fastbridge-price.js';
export { fmtTac, parseTac, slowNet, lineageText };
const pct = (fee, of) => (of > 0n ? `${(Number((fee * 1000000n) / of) / 10000).toFixed(2)}%` : '');
// a price in hundredths of a percent, as the page says it
const bpsText = (bps) => `${(bps / 100).toFixed(2)}%`;
// the most fee a holder can name for a want: a percentage with up to two places, 0 to 90 (a fee over 90% is one the page does not quote)
const percentBps = (text) => { const t = String(text).trim().replace('%', ''); if (!/^\d+(\.\d{0,2})?$/.test(t)) return null; const bps = Math.round(Number(t) * 100); return bps >= 0 && bps <= 9000 ? bps : null; };
const SCAN = 'https://mempool.space/tx/';
// where private TAC is turned into public TAC in an Ethereum wallet: the front page's Withdraw tab on TAC, set to take it all (the app's own link for it)
const WITHDRAW = '/#card=shield:tac:wallet';
const KEPT = 'tacit-fast-providers-v1';
const big = (xs, pick) => xs.reduce((a, x) => (pick(x) > a ? pick(x) : a), 0n);

const capOf = (p) => { const t = p.terms; return t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount; };
const hasRoom = (p) => capOf(p) >= p.terms.minAmount && capOf(p) > 0n;
const feeLine = (t) => `${(t.feeBps / 100).toFixed(2)}%${t.flatFee > 0n ? ` + ${fmtTac(t.flatFee)} TAC` : ''}`;
const range = (a, b) => `${fmtTac(a, 2)} to ${fmtTac(b, 2)} TAC`;

export function mountFast({ root, keyS, signIn, open, discover, wants = null, face = () => '', notify = () => {}, pinned = () => null, quoteDelayMs = 350, refreshMs = 30000, retryMs = 15000, say = () => {} }) {
  const doc = root.ownerDocument;
  const S = { providers: [], empties: 0, loaded: false, termsAt: 0, sess: null, pub: null, bal: null, amt: '', quotes: [], quote: null, best: null, seq: 0, busy: false, note: '', bad: false, recs: [], stop: null, timer: 0, opening: null, want: null, told: false, watch: 0, cost: null, sure: null, checking: false, anyOnly: null, split: null, waits: null, depthTimer: 0 };
  let kept = 0;
  try { kept = Number(doc.defaultView.localStorage.getItem(KEPT)) || 0; } catch { }

  root.innerHTML = `
    <p class="fx-sum" id="fx-lp" aria-live="polite"></p>
    <div class="fx-back" id="fx-back" hidden></div>
    <div id="fx-pre" hidden>
      <p class="eyebrow"><span>You bridge</span><span class="who">from your Bitcoin address</span></p>
      <div class="fx-amt"><input id="fx-pre-amt" inputmode="decimal" placeholder="0" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" aria-label="TAC to bridge"><span>TAC</span></div>
      <p class="status" id="fx-pre-st" aria-live="polite"></p>
      <div class="fx-out" id="fx-pre-out" hidden>
        <p class="eyebrow"><span>You receive, private, about</span><span class="who">in your Tacit wallet</span></p>
        <div class="fx-big"><output class="num" id="fx-pre-big" for="fx-pre-amt">0</output><span>TAC</span></div>
      </div>
      <div class="rows" id="fx-pre-recv" hidden></div>
    </div>
    <div id="fx-form" hidden>
      <p class="eyebrow"><span>You bridge</span><span class="who num" id="fx-bal"></span></p>
      <div class="fx-amt"><input id="fx-amt" inputmode="decimal" placeholder="0" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" aria-label="TAC to bridge"><span>TAC</span><button class="linkbtn" id="fx-max" type="button" hidden>Max</button></div>
      <div class="fx-out" id="fx-out" hidden>
        <p class="eyebrow"><span>You receive, private</span><span class="who">in your Tacit wallet</span></p>
        <div class="fx-big"><output class="num" id="fx-big" for="fx-amt">0</output><span>TAC</span></div>
        <p class="note fx-tip">Private TAC on Ethereum, in your Tacit wallet. To hold it in an Ethereum wallet, withdraw it afterwards.</p>
      </div>
      <div class="rows" id="fx-recv" hidden></div>
      <div class="kv" id="fx-wait" hidden><span></span><button class="linkbtn" id="fx-unwait" type="button">Stop waiting</button></div>
      <p class="note" id="fx-wait-note" hidden></p>
      <div id="fx-price" hidden>
        <label class="pv-f"><span>Most fee, %</span><input id="fx-maxfee" inputmode="decimal" placeholder="any" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" aria-label="Most fee in percent, or blank for any"></label>
        <p class="note" id="fx-price-note"></p>
      </div>
    </div>
    <button class="btn" id="fx-go" type="button" hidden>Sign in</button>
    <p class="status" id="fx-st" role="status" aria-live="polite"></p>
    <p class="alt" id="fx-alt">No provider fee? The <a href="/#card=bridge">regular bridge</a> takes hours, not minutes. Or <a href="#provide">provide liquidity</a> and earn the fee.</p>
    <details class="fx-how fx-depth" id="fx-depth" hidden><summary>Cost by size, and who is waiting</summary><div id="fx-depth-in"></div></details>
    <details class="fx-how" id="fx-how"><summary>New to the fast bridge?</summary>
      <p class="note">You lock TAC on Bitcoin. A liquidity provider pays you the same TAC, less its fee, into your private balance on Tacit (Ethereum’s private pool). It takes minutes; the quote says how many.</p>
      <p class="note">A private balance is not an Ethereum wallet. To hold the TAC in a wallet, withdraw it afterwards: <a href="${WITHDRAW}">Withdraw to Ethereum</a>.</p>
      <p class="note">Use this when the regular bridge cannot take your TAC (a long history, or TAC that came out of Bitcoin’s shielded pool). The regular bridge has no provider fee but takes hours, not minutes.</p>
      <p class="note">When no one provider can take an amount, the page splits it across several. Each part is a bridge of its own, locked from notes of its own with its own fee on Bitcoin, so it needs a note and a coin for each part.</p>
      <p class="note">Keep this page open until it says Done: it claims your TAC at the end. If a bridge cannot finish, your lock returns to your Bitcoin address when its timelock ends (12 to 48 hours, shown before you press), and this page sends it back: open it with your wallet then.</p>
      <p class="note">Closed the page mid-bridge, or cleared your browser? Open your wallet here: the page finds your lock from your key and, once its timelock has passed, sends your TAC back.</p>
      <p class="note">Your Bitcoin address needs a few thousand sats for the Bitcoin fee. The quote shows how many.</p>
    </details>
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
    return { count: ps.length, min: mins[0], max: big(ps, (p) => p.terms.maxAmount), cap: big(room, capOf), together: sweepRoom(ps), best };
  }
  // A bridge no one provider takes whole is split across several (fast/sweep.js; fast/wire.js sweepOffer): the most that can be had now is then
  // what the providers that take any TAC hold together. A session that cannot split (and the page before a key opens, which assumes the one
  // that will) says so by lacking sweepOffer.
  const splits = () => !S.sess || typeof S.sess.sweepOffer === 'function';
  const roomNow = (sm) => (sm && splits() && sm.together > sm.cap ? sm.together : sm ? sm.cap : 0n);

  function paintProvider() {
    const e = $('fx-lp'), sm = summary();
    e.classList.toggle('held', !S.loaded && kept !== 1);
    const mine = keyS.unlocked && keyS.key && S.providers.some((p) => p.id === keyS.key.pubHex);
    if (S.loaded && !sm && mine) { e.textContent = 'You are the provider online. Bridgers see your offer; to bridge yourself, use another wallet.'; return; }
    if (S.loaded && !sm) { e.textContent = `No provider is online right now. ${keyS.unlocked ? 'Enter an amount to wait for one, or provide below.' : 'Open your wallet to wait for one, or to provide.'}`; return; }
    if (!sm) { e.textContent = 'Reading the providers…'; return; }
    const t = sm.best.terms, many = sm.count > 1, top = roomNow(sm), room = others().filter(hasRoom).length;
    if (!room) { e.innerHTML = `<b>${many ? `${sm.count} providers online` : esc(sm.best.name || 'Provider')}</b><span>${many ? 'all full right now' : 'full right now'}</span><span>${esc(feeLine(t))} fee when there is room</span>`; return; }
    e.innerHTML = `<b>${many ? `${sm.count} providers online` : esc(sm.best.name || 'Provider')}</b>${many && room < sm.count ? `<span>${room} with room</span>` : ''}<span>${many && room > 1 ? 'cheapest ' : ''}${esc(feeLine(t))} fee</span><span>${top > 0n ? `${esc(range(sm.min, top))}${top < sm.max ? ' now' : ''}` : 'full right now'}</span>`;
  }

  function problem(units) {
    const sm = summary(), top = roomNow(sm), most = sm && top > sm.max ? top : sm ? sm.max : 0n;
    if (units == null) return S.amt.trim() ? 'That is not an amount.' : '';
    if (sm && units < sm.min) return `The least is ${fmtTac(sm.min)} TAC.`;
    if (sm && units > most) return `The most is ${fmtTac(most)} TAC.`;
    if (sm && units > top) return top > 0n ? `${sm.count > 1 ? 'The providers can' : 'The provider can'} take up to ${fmtTac(top)} TAC right now.` : `${sm.count > 1 ? 'The providers cannot' : 'The provider cannot'} take more right now.`;
    if (S.bal != null && units > S.bal) return 'That is more than your TAC on Bitcoin.';
    return '';
  }

  const byAmount = (units) => others().filter((p) => units >= p.terms.minAmount && units <= capOf(p));
  const takersOf = (units) => (S.anyOnly === units ? byAmount(units).filter((p) => p.terms.anyTac) : byAmount(units));
  // no one provider takes this amount whole, and the providers that take any TAC hold it between them: it can be split (and waiting is not the way)
  const splittable = (units) => { const sm = summary(); return !!(S.sess && typeof S.sess.sweepOffer === 'function' && sm && units != null && !byAmount(units).length && units <= sm.together); };
  const LEAST = 10n * ONE;
  const waitable = (units) => !!wants && !!S.sess && !S.want && units != null && units >= LEAST && (S.bal == null || units <= S.bal) && !takersOf(units).length && !splittable(units);
  const plain = (units) => (units / ONE).toString() + (units % ONE ? '.' + (units % ONE).toString().padStart(DEC, '0').replace(/0+$/, '') : '');

  function paintForm() {
    const signed = !!S.sess, form = $('fx-form'), go = $('fx-go'), recv = $('fx-recv'), out = $('fx-out'), wt = $('fx-wait');
    form.hidden = !signed;
    go.hidden = false;
    $('fx-pre').hidden = signed;
    $('fx-bal').textContent = signed && S.bal != null ? `${fmtTac(S.bal)} TAC on Bitcoin` : '';
    $('fx-max').hidden = !(signed && S.bal > 0n);
    wt.hidden = !(signed && S.want);
    if (!wt.hidden) wt.firstElementChild.textContent = `Waiting for a provider for ${fmtTac(S.want.amount)} TAC${S.want.maxFeeBps != null ? `, at up to ${bpsText(S.want.maxFeeBps)}` : ''}`;
    const dear = !wt.hidden ? pricedOut() : '';
    $('fx-wait-note').hidden = !dear; $('fx-wait-note').textContent = dear;
    $('fx-price').hidden = true;
    if (!signed) {
      // before a key: the amount can be typed, and what the cheapest provider that takes it would keep is said; the quote itself needs the key
      const raw = $('fx-pre-amt').value, units = parseTac(raw), bad = units != null ? problem(units) : (raw.trim() ? 'That is not an amount.' : '');
      const fit = units != null && !bad ? byAmount(units) : [];
      const best = fit.length ? fit.reduce((a, b) => (feeOf(b.terms, units) < feeOf(a.terms, units) ? b : a)) : null, fee = best ? feeOf(best.terms, units) : 0n, est = !!best && fee < units;
      $('fx-pre-out').hidden = !est; $('fx-pre-recv').hidden = !est;
      $('fx-pre-st').textContent = bad || (units != null && !best && S.loaded ? 'No one provider takes that amount right now. Signed in, the page can split it or wait for one.' : '');
      if (est) {
        $('fx-pre-big').textContent = fmtTac(units - fee);
        $('fx-pre-recv').innerHTML = `<div class="kv"><span>Fee</span><b class="num">${esc(fmtTac(fee))} TAC<small>${esc(feeLine(best.terms))}, the cheapest provider that takes this amount now</small></b></div>
          <div class="kv"><span>Provider</span><b>${face(best.id)}${esc(best.name || 'Provider')}<small class="num">${esc(keyTag(best.id))}</small></b></div>
          <p class="note">An estimate. Signed in, the provider quotes it, with the Bitcoin fee and the time.</p>`;
      }
      go.textContent = S.busy ? 'Working…' : est ? 'Sign in to bridge' : 'Sign in'; go.disabled = S.busy; recv.hidden = true; out.hidden = true; return;
    }
    const units = parseTac(S.amt), bad = problem(units), q = S.quote, wait = waitable(units);
    // a bridge split across providers has its own offer: a receipt of its parts, in place of a single quote's
    const sp = !q && S.split && units != null && S.split.amount === units ? S.split : null, short = !!(sp ? sp.cost && sp.cost.short : S.cost && S.cost.short);
    go.hidden = !!S.want && !q && !sp;
    if (wait) {
      recv.hidden = true; out.hidden = true;
      $('fx-price').hidden = false; $('fx-price-note').textContent = priceNote(units); $('fx-maxfee').disabled = S.busy;
      go.textContent = S.busy ? 'Working…' : 'Wait for a provider'; go.disabled = S.busy; paintNote(); return;
    }
    out.hidden = !q && !sp; recv.hidden = !q && !sp;
    if (sp) drawSplit(sp);
    else if (q) {
      const c = S.cost, sm = summary();
      $('fx-big').textContent = fmtTac(q.evmAmount);
      const btc = c && c.total ? `<div class="kv"><span>Bitcoin fee</span><b class="num">≈ ${esc(c.total.toLocaleString('en-US'))} sats${c.take ? `<small>${esc(c.take.toLocaleString('en-US'))} of it is the provider's take${c.takeInLock ? ', and it comes back to you if the bridge does not go through' : ''}</small>` : ''}</b></div>`
        : q.takeSats ? `<div class="kv"><span>Bitcoin fee</span><b class="num">${esc(q.takeSats.toLocaleString('en-US'))} sats<small>for the provider's take, and your own transaction's fee</small></b></div>` : '';
      recv.innerHTML = `${sm && sm.count > 1 && S.best ? `<div class="kv"><span>Provider</span><b>${face(S.best.id)}${esc(S.best.name || 'Provider')}<small class="num">${esc(keyTag(S.best.id))}</small></b></div>` : ''}<div class="kv"><span>Fee</span><b class="num">${esc(fmtTac(q.fee))} TAC<small>${esc(pct(q.fee, q.btcValue))}</small></b></div>${btc}
        <div class="kv"><span>Time</span><b class="num">about ${minutesFor(q.minConfs)} minutes<small>${Math.max(1, Number(q.minConfs) || 1)} Bitcoin confirmation${(Number(q.minConfs) || 1) > 1 ? 's' : ''}, then a pool settle</small></b></div>${highTake(q) ? `
        <p class="status err" role="alert" id="fx-high-take">High Bitcoin fee: this provider asks ${esc(Number(q.takeSats).toLocaleString('en-US'))} sats for its take, well above what it costs at the current rate. Other providers may ask less.</p>` : ''}${q.aboveTerms || q.aboveWant ? `
        <p class="status err" role="alert" id="fx-above">${q.aboveTerms ? 'This quote keeps more than the fee this provider lists.' : ''}${q.aboveTerms && q.aboveWant ? ' ' : ''}${q.aboveWant && S.want && S.want.maxFeeBps != null ? `It keeps more than the ${esc(bpsText(S.want.maxFeeBps))} you set.` : ''}</p>` : ''}${S.pinNote ? `
        <p class="status" id="fx-pin">${esc(S.pinNote)}</p>` : ''}${highFee(q) ? `
        <p class="status err" role="alert" id="fx-high">High fee: this provider keeps ${esc(fmtTac(q.fee))} TAC (${esc(pct(q.fee, q.btcValue))}) of your ${esc(fmtTac(q.btcValue))} TAC, and you receive ${esc(fmtTac(q.evmAmount))}. A smaller bridge costs more in proportion, a larger one less, and the regular bridge may cost less.</p>` : ''}`;
    }
    go.textContent = S.busy ? 'Working…' : S.checking ? 'Checking…' : S.sure ? 'Press again to bridge' : sp ? `Bridge in ${sp.legs.length} parts` : 'Bridge';
    go.disabled = S.busy || S.checking || !!bad || (!q && !sp) || units == null || short;
    paintNote();
  }

  // What a holder is told about the price of waiting: that providers see it, and what the providers online keep of this amount (full ones too: they
  // say what the fee is, if not whether there is room).
  function priceNote(units) {
    const fees = others().map((p) => feeOf(p.terms, units));
    const said = 'Optional. Providers see the most you would pay, and you are told when one can take it for no more.';
    if (!fees.length) return said;
    const lo = fees.reduce((a, b) => (b < a ? b : a)), hi = fees.reduce((a, b) => (b > a ? b : a));
    return `${said} The providers online keep ${pct(lo, units)}${hi > lo ? ` to ${pct(hi, units)}` : ''} of this amount.`;
  }
  // a want with a price that every provider able to take it asks more than: said under the waiting line, with what to do
  function pricedOut() {
    const w = S.want;
    if (!w || w.maxFeeBps == null) return '';
    const fit = byAmount(w.amount);
    if (!fit.length || fit.some((p) => meetsPrice(p.terms, w))) return '';
    const lowest = fit.map((p) => feeOf(p.terms, w.amount)).reduce((a, b) => (b < a ? b : a));
    return `Providers that can take it keep at least ${pct(lowest, w.amount)} of it, above the ${bpsText(w.maxFeeBps)} you set. Stop waiting and wait again with a higher limit, or bridge at their fee.`;
  }

  // The receipt of a split bridge: each part (its provider, its size, the fee it keeps), then the fee, the Bitcoin fee of all the locks, and the time.
  function drawSplit(sp) {
    const n = sp.legs.length, c = sp.cost, sats = (v) => `${Number(v).toLocaleString('en-US')} sats`;
    $('fx-big').textContent = fmtTac(sp.receive);
    $('fx-recv').innerHTML = `<div class="kv"><span>Split</span><b class="num">${n} parts<small>no one provider takes it whole</small></b></div>`
      + sp.legs.map((l) => `<div class="kv"><span>${face(l.provider.id)}${esc(l.provider.name || 'Provider')}</span><b class="num">${esc(fmtTac(l.amount))} TAC<small>fee ${esc(fmtTac(l.quote.fee))} (${esc(pct(l.quote.fee, l.quote.btcValue))}) · ${esc(keyTag(l.provider.id))}</small></b></div>`).join('')
      + `<div class="kv"><span>Fee</span><b class="num">${esc(fmtTac(sp.fee))} TAC<small>${esc(pct(sp.fee, sp.amount))}</small></b></div>`
      + (c && c.total ? `<div class="kv"><span>Bitcoin fee</span><b class="num">≈ ${esc(sats(c.total))}<small>${n} locks, each with its own fee${c.take ? `; ${esc(sats(c.take))} of it is the providers' take` : ''}</small></b></div>` : '')
      + `<div class="kv"><span>Time</span><b class="num">about ${minutesFor(sp.minConfs)} minutes<small>${Math.max(1, Number(sp.minConfs) || 1)} Bitcoin confirmation${(Number(sp.minConfs) || 1) > 1 ? 's' : ''} for the slowest part, then a pool settle</small></b></div>`
      + `<p class="note">Each part is a bridge of its own, with its own lock on Bitcoin and its own refund: if one stops, the others carry on.</p>`
      + (sp.high.take ? `<p class="status err" role="alert" id="fx-high-take">High Bitcoin fee: a provider asks well above what its take costs at the current rate. Other providers may ask less.</p>` : '')
      + (sp.high.fee ? `<p class="status err" role="alert" id="fx-high">High fee: a provider keeps over 5% of its part. The regular bridge may cost less.</p>` : '');
  }

  const ago = (sec) => {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - Number(sec || 0));
    return d < 90 ? 'just now' : d < 5400 ? `${Math.round(d / 60)} minutes ago` : d < 172800 ? `${Math.round(d / 3600)} hours ago` : `${Math.round(d / 86400)} days ago`;
  };
  // Bridges this browser holds that are not finished (the records are plain files in the browser: no key is needed to see that there are some), and what a bridge
  // that did not go through is waiting for. A returning visitor sees it at once, signed in or not, and is told what moves it on: this page, with the wallet open.
  const DONE_PHASES = ['done', 'refunded', 'counter-took'];
  function localPending() {
    const out = [];
    try {
      const ls = doc.defaultView.localStorage;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (!k || !k.startsWith('tacit-fastbridge-v1:mainnet:')) continue;
        let r = null; try { r = JSON.parse(ls.getItem(k)); } catch { continue; }
        if (!r || !r.phase || DONE_PHASES.includes(r.phase)) continue;
        const t = r.lockAt || r.confirmedAt;
        out.push({ phase: r.phase, opens: r.phase === 'refund-wait' && t && r.csvBlocks ? t + (r.csvBlocks - 1) * 600 : null });
      }
    } catch { }
    return out;
  }
  const reminder = (at) => {
    const z = (d) => new Date(d * 1000).toISOString().replace(/[-:]|\.\d{3}/g, '');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tacit//fast//EN', 'BEGIN:VEVENT', 'UID:tacit-take-back-' + at + '@tacit.finance', 'DTSTAMP:' + z(Date.now() / 1000), 'DTSTART:' + z(at), 'DURATION:PT15M',
      'SUMMARY:Open Tacit to take your TAC back', 'DESCRIPTION:Your fast bridge lock is due back on Bitcoin. Open https://tacit.finance/fast/ with your wallet: the page sends it back while it is open.', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
  };
  function paintBack() {
    const e = $('fx-back');
    if (!e) return;
    const now = Math.floor(Date.now() / 1000);
    const returning = S.sess ? S.recs.filter((r) => r.returned && !r.ended) : [];
    let html = '';
    if (returning.length) {
      const n = returning.length, ds = returning.map((r) => r.opens).filter((x) => x != null), first = ds.length ? Math.min(...ds) : null;
      const what = `<b>${n === 1 ? 'A lock is' : `${n} locks are`} coming back to your Bitcoin address.</b>`;
      if (first != null && first <= now) html = `${what} ${n === 1 ? 'It is' : 'They are'} due now, and this page sends ${n === 1 ? 'it' : 'them'} back: keep it open for a few minutes.`;
      else if (first != null) {
        const h = (first - now) / 3600, when = h >= 1.5 ? `about ${Math.round(h)} hours` : h >= 0.75 ? 'about an hour' : 'under an hour';
        html = `${what} The first is due in ${when}. This page sends it back, so open it then with your wallet. <a href="${reminder(first)}" download="tacit-take-back.ics">Add a reminder</a>`;
      } else html = `${what} This page sends ${n === 1 ? 'it' : 'them'} back when the timelock ends, 12 to 48 hours after the lock confirmed: open it then with your wallet.`;
    } else if (!S.sess) {
      const held = localPending();
      if (held.length) {
        const n = held.length, due = held.filter((x) => x.opens != null && x.opens <= now).length;
        html = `<b>You have ${n === 1 ? 'a bridge' : `${n} bridges`} not finished in this browser.</b> Open your wallet and ${n === 1 ? 'it carries' : 'they carry'} on${due ? `; ${due === 1 ? 'a lock is' : `${due} locks are`} due back now and will be sent to your address` : ''}. <button class="linkbtn" id="fx-back-open" type="button">Open your wallet</button>`;
      }
    }
    e.hidden = !html;
    if (e.innerHTML !== html) e.innerHTML = html;
  }

  function paintList() {
    paintBack();
    const e = $('fx-list'), recs = S.recs.slice(0, 10), open = recs.some((r) => ['built', 'broadcast', 'offered', 'claiming'].includes(r.phase));
    e.hidden = !recs.length;
    e.innerHTML = recs.length ? `<div class="rows-h"><span>Your bridges</span>${open ? '<span class="fx-keep">Keep this page open until it is done</span>' : ''}</div>` + recs.map((r) => `
      <div class="fx-rec" data-id="${esc(r.id)}" data-phase="${esc(r.phase)}">
        <div class="kv"><b>${r.sweep ? `Part ${esc(r.sweep.part)} of ${esc(r.sweep.of)} · ` : ''}${esc(r.title)}</b><span class="num">${esc(fmtTac(r.amount))} TAC${r.receive && r.receive !== '0' ? ` → ${esc(fmtTac(r.receive))} TAC` : ''}</span></div>
        ${r.returned ? '' : `<ol class="fx-steps" aria-label="Steps">${r.steps.map((s, i) => `<li${i < r.at || r.ended ? ' class="on"' : i === r.at ? ' class="at"' : ''}>${esc(s)}</li>`).join('')}</ol>`}
        <p class="note">${esc(r.detail)}${r.error && !r.ended ? ` <span class="err">${esc(r.error)}</span>` : ''}</p>
        <p class="note fx-meta">${esc(ago(r.created))}${r.lockTxid ? ` · <a href="${SCAN}${esc(r.lockTxid)}" target="_blank" rel="noopener noreferrer">Bitcoin lock ↗</a>` : ''}${r.ended && !r.returned ? ' · <a href="/">Your TAC, on the front page</a>' : ''}</p>
        ${r.ended && !r.returned && Date.now() / 1000 - Number(r.created || 0) < 7 * 86400 ? `<p class="note fx-next"><b>It is in your private balance on Tacit, not yet in an Ethereum wallet.</b> Swap, send or earn with it privately, or <a href="${WITHDRAW}">withdraw it to an Ethereum address</a> (public TAC).</p>` : ''}
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
    const ps = S.providers.slice().sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : (hasRoom(b) - hasRoom(a)) || a.terms.feeBps - b.terms.feeBps));
    const show = ps.length > 1 || (ps.length === 1 && ps[0].id === me);
    e.hidden = !show;
    if (!show) { e.innerHTML = ''; return; }
    const was = e.querySelector('details'), open = was ? was.open : false, room = ps.filter(hasRoom).length;
    e.innerHTML = `<details class="lp-fold"${open ? ' open' : ''}><summary><span>Providers</span><span class="who num">${ps.length} online · ${room} with room</span></summary>
      <div class="lp-grid">${ps.map((p) => `<div class="lp-tile${p.id === me ? ' mine' : ''}${hasRoom(p) ? '' : ' full'}">
        <div class="lp-top"><b>${face(p.id)}${esc(p.name || 'Provider')}</b><small class="num lp-key">${esc(keyTag(p.id))}</small>${p.id === me ? '<span class="lp-tag">You</span>' : ''}</div>
        <div class="kv"><span>Fee</span><b class="num">${esc(feeLine(p.terms))}</b></div>
        <div class="kv"><span>Takes</span><b class="num">${hasRoom(p) ? esc(range(p.terms.minAmount, capOf(p))) : 'full right now'}</b></div>
      </div>`).join('')}</div></details>`;
  }

  // The depth of the providers as a ladder (fast/ladder.js): what each size costs the way the page would bridge it now, and what is waiting for a
  // provider and at what price. It needs no key. It is drawn only while it is open; the waiting bridges are read when it opens and then each minute.
  function paintDepth() {
    const d = $('fx-depth'), ps = others();
    d.hidden = !S.loaded || !ps.length;
    if (d.hidden || !d.open) return;
    const L = costBySize(ps), tac = (u) => `${fmtTac(u)} TAC`, name = (p) => esc(p.provider.name || 'Provider');
    const via = (r) => (r.parts.length === 1 ? name(r.parts[0]) : `split in ${r.parts.length}: ${r.parts.slice(0, 3).map((x) => `${name(x)} ${esc(fmtTac(x.amount))}`).join(', ')}${r.parts.length > 3 ? `, +${r.parts.length - 3}` : ''}`);
    let html = '<p class="eyebrow"><span>What it costs, by size</span></p>';
    if (L.rows.length) {
      html += L.rows.map((r) => `<div class="kv"><span>${esc(tac(r.amount))}</span><b class="num">${esc(fmtTac(r.fee))} TAC<small>${esc(pct(r.fee, r.amount))} · ${via(r)}</small></b></div>`).join('');
      html += `<p class="note">Each is the way it would be bridged now. The most that can be bridged now is ${esc(tac(L.depth))}.${L.rows.some((r) => r.parts.length > 1) ? ' A size no one provider takes is split across several, each part a bridge of its own.' : ''}</p>`;
    } else html += '<p class="note">Every provider is full right now.</p>';
    if (S.waits && S.waits.items) {
      const levels = waitLevels(S.waits.items);
      html += `<p class="eyebrow"><span>Waiting for a provider</span><span class="who num">${esc(String(S.waits.count))}</span></p>`;
      html += levels.length ? levels.map((x) => `<div class="kv"><span>${x.maxFeeBps === null ? 'any fee' : `up to ${esc(bpsText(x.maxFeeBps))}`}</span><b class="num">${x.count} bridge${x.count === 1 ? '' : 's'}<small>${esc(tac(x.total))}</small></b></div>`).join('') : '<p class="note">No one is waiting.</p>';
    }
    $('fx-depth-in').innerHTML = html;
  }
  async function lookWaits() {
    if (!wants || typeof wants.waiting !== 'function') return;
    try { S.waits = await wants.waiting(); } catch { /* the boards did not answer: what was read stands */ }
    paintDepth();
  }
  // (a toggle that changes nothing, which some browsers send twice for one change, is ignored: it would read the boards and start a timer again)
  let depthOpen = false;
  $('fx-depth').addEventListener('toggle', () => {
    const now = $('fx-depth').open;
    if (now === depthOpen) return;
    depthOpen = now;
    clearInterval(S.depthTimer);
    if (now) { paintDepth(); lookWaits(); S.depthTimer = setInterval(lookWaits, 60000); }
  });

  const paint = () => { paintProvider(); paintTiles(); paintDepth(); paintForm(); paintNote(); paintList(); };

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
    Object.assign(S, { sess: null, pub: null, bal: null, quotes: [], quote: null, best: null, amt: '', recs: [], busy: false, opening: null, want: null, told: false, cost: null, sure: null, checking: false, anyOnly: null, split: null });
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
        { const pre = $('fx-pre-amt').value.trim(); if (pre && !S.amt.trim()) { $('fx-amt').value = pre; setTimeout(typed, 0); } }      // an amount typed before the key opened is quoted now
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

  // A provider paired by a link (#with=) is put first only while its quote is about as good as the best: within PIN_SLACK_BPS of the best payout,
  // with a fair take and a fee within its own terms. Otherwise the best quote stays first and the page says the paired provider asks more.
  const PIN_SLACK_BPS = 10n;
  const pinFirst = (quotes) => {
    const pin = pinned();
    S.pinNote = '';
    if (!pin || !quotes.length) return quotes;
    const at = quotes.findIndex((x) => pairId(x.provider.id) === pin);
    if (at <= 0) return quotes;
    const p = quotes[at].quote, best = quotes[0].quote;
    const close = BigInt(p.evmAmount) * 10000n >= BigInt(best.evmAmount) * (10000n - PIN_SLACK_BPS);
    if (close && !p.takeAbove && !p.highTake && !p.highFee && !p.aboveTerms && !p.aboveWant) return [quotes[at], ...quotes.filter((_, k) => k !== at)];
    S.pinNote = `The provider you paired with asks more than the best quote now, so the best is shown: it pays ${fmtTac(BigInt(best.evmAmount) - BigInt(p.evmAmount) > 0n ? BigInt(best.evmAmount) - BigInt(p.evmAmount) : 0n)} TAC more.`;
    return quotes;
  };
  // a kept want's price, for the amount it waits for
  const wantPrice = (units) => (S.want && S.want.maxFeeBps != null && units === S.want.amount ? { maxFeeBps: S.want.maxFeeBps } : {});
  function typed() {
    readProviders();
    S.amt = $('fx-amt').value; S.quotes = []; S.quote = null; S.best = null; S.note = ''; S.cost = null; S.sure = null; S.checking = false; S.anyOnly = null; S.split = null; S.pinNote = '';
    clearTimeout(S.timer); const seq = ++S.seq;
    const units = parseTac(S.amt);
    paintForm();
    if (units == null || problem(units) || !S.sess) return;
    S.timer = setTimeout(async () => {
      try {
        const eligible = others().filter((p) => units >= p.terms.minAmount && units <= capOf(p));
        if (!eligible.length) {
          if (splittable(units)) { await offerSplit(units, seq); return; }
          if (seq === S.seq) note(problem(units) || 'No provider can take that amount right now.', !wants);
          return;
        }
        const r = await S.sess.quoteAll(eligible, units, wantPrice(units));
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
  // The offer for a bridge split across providers: the parts, each quoted by its own provider, and what the locks cost on Bitcoin.
  async function offerSplit(units, seq) {
    const sess = S.sess;
    S.checking = true; note('Planning the split…'); paintForm();
    let o;
    try { o = await sess.sweepOffer(others(), units); } catch (e) { if (seq === S.seq) { S.checking = false; note(wording(e), true); paintForm(); } return; }
    if (seq !== S.seq || S.sess !== sess) return;
    S.checking = false;
    if (!o.ok) { note(splitWhy(o, units), true); paintForm(); return; }
    S.split = o;
    if (o.cost && o.cost.short) note(splitShort(o), true); else note('');
    paintForm();
  }
  function splitWhy(o, units) {
    if (o.why === 'notes') return `Your TAC on Bitcoin is in ${o.notes} note${o.notes === 1 ? '' : 's'}, and a lock spends a note whole, so ${o.parts} parts need ${o.parts} notes. Split a note first (Chains, then Notes), or bridge less.`;
    if (o.why === 'busy') return 'A provider did not answer with its part, so the split cannot be priced. Try again in a moment.';
    return `The providers cannot take ${fmtTac(units)} TAC between them right now. Try a smaller amount.`;
  }
  const splitShort = (o) => {
    const c = o.cost, n = o.legs.length, at = c.at == null ? 0 : c.at;
    return `This key's Bitcoin address can pay the Bitcoin fee for ${at} of the ${n} parts, one coin for each lock. Add some sats from Receive in the Bitcoin tab on the front page${c.need ? ` (about ${c.need.toLocaleString('en-US')} for a part)` : ''}, or bridge less.`;
  };

  $('fx-amt').addEventListener('input', typed);
  $('fx-pre-amt').addEventListener('input', () => { readProviders(); paintForm(); });
  $('fx-back').addEventListener('click', async (ev) => {
    if (!ev.target.closest('#fx-back-open')) return;
    try { await signIn(); } catch (e) { if (!e?.unlockCancelled) note(wording(e), true); }
  });
  $('fx-max').addEventListener('click', () => {
    const sm = summary(), top = roomNow(sm), lim = sm && top > 0n ? top : S.bal, cap = S.bal > lim ? lim : S.bal;
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
      // the providers that take the amount, and keep no more of it than the price the want names (when it names one)
      let ps = byAmount(S.want.amount).filter((p) => meetsPrice(p.terms, S.want));
      if (ps.length && S.sess && S.sess.reach) {
        const kind = await S.sess.reach(S.want.amount).catch(() => 'all');
        if (kind === 'any') ps = ps.filter((p) => p.terms.anyTac);
      }
      if (!S.want || S.told || !ps.length) return;
      S.told = true;
      const text = `A provider can take your ${fmtTac(S.want.amount)} TAC now${S.want.maxFeeBps != null ? `, for no more than the ${bpsText(S.want.maxFeeBps)} you set` : ''}.`;
      note(text); notify(text);
      if (!S.amt.trim() || parseTac(S.amt) === S.want.amount) { $('fx-amt').value = plain(S.want.amount); typed(); }
    };
    S.watch = setInterval(look, refreshMs);
    look();
  }
  async function wait(units) {
    // the price is optional: blank is any fee; what is typed must be a percentage the page can quote
    const raw = $('fx-maxfee').value.trim(), bps = raw === '' ? null : percentBps(raw);
    if (raw !== '' && bps == null) { note('The most fee is a percentage from 0 to 90, or leave it blank for any.', true); return; }
    S.busy = true; paintForm();
    try {
      await (wants.ask ? wants.ask() : null);
      S.want = await wants.start(S.pub, units, { maxFeeBps: bps }); S.told = false;
      note(`You are told here, and on the front page, when one can take it${bps != null ? ` for no more than ${bpsText(bps)}` : ''}.`);
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
    if (!S.quote && S.split && S.split.amount === parseTac(S.amt)) { await goSplit(); return; }
    if (!S.quote && waitable(parseTac(S.amt))) { await wait(parseTac(S.amt)); return; }
    if (!S.quote) return;
    if (S.cost && S.cost.short) { note(shortText(S.cost), true); return; }
    const sure = () => {
      const who = S.best && S.best.name ? `${S.best.name} (${keyTag(S.best.id)})` : 'the provider';
      S.sure = { key: `${S.quote.id}|${S.quote.btcValue}`, at: Date.now() };
      note(`${highTake(S.quote) ? `High Bitcoin fee: ${who} asks ${Number(S.quote.takeSats).toLocaleString('en-US')} sats for its take, well above what it costs at the current rate. ` : ''}${highFee(S.quote) ? `High fee: ${who} keeps ${fmtTac(S.quote.fee)} TAC (${pct(S.quote.fee, S.quote.btcValue)}). ` : ''}${S.quote.aboveTerms ? `${who} quotes more than the fee it lists. ` : ''}This locks ${fmtTac(S.quote.btcValue)} TAC on Bitcoin until ${who} has paid you ${fmtTac(S.quote.evmAmount)} private TAC in the pool, in about ${minutesFor(S.quote.minConfs)} minutes. If it does not, the lock returns to your address after ${timelockText(S.quote.csvBlocks)}. Press again to bridge.`);
    };
    if (!(S.sure && S.sure.key === `${S.quote.id}|${S.quote.btcValue}` && Date.now() - S.sure.at < 180e3)) { sure(); paintForm(); return; }
    S.sure = null;
    S.busy = true; note('Locking your TAC on Bitcoin…'); paintForm();
    let again = false, quotes = S.quotes, fits = [];
    try {
      const soon = Math.floor(Date.now() / 1000) + 150;
      if (quotes.some((x) => Number(x.quote.validUntil) <= soon)) {
        const r = await S.sess.quoteAll(quotes.map((x) => x.provider), S.quote.btcValue, wantPrice(S.quote.btcValue));
        if (!r.quotes.length) throw new Error('the quote expired');
        quotes = pinFirst(r.quotes);
      }
      if (!quotes.length) throw new Error('the quote expired');
      // only quotes no worse than the one confirmed are started: one that pays less or asks more is shown, and needs another press
      fits = quotes.filter((x) => noWorse(x.quote, S.quote));
      if (!fits.length) { S.quotes = quotes; S.quote = quotes[0].quote; S.best = quotes[0].provider; again = true; return; }
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

  // The press for a split bridge: the first says what it does and costs, the second goes. Every provider's share is held before the first lock.
  const sureSplit = (o) => {
    const names = o.legs.map((l) => l.provider.name || 'a provider').join(', ');
    S.sure = { key: o.legs.map((l) => `${l.quote.id}|${l.quote.btcValue}`).join(','), at: Date.now() };
    note(`${o.high.take ? 'High Bitcoin fee: a provider asks well above what its take costs at the current rate. ' : ''}${o.high.fee ? 'High fee: a provider keeps over 5% of its part. ' : ''}This locks ${fmtTac(o.amount)} TAC on Bitcoin in ${o.legs.length} separate locks, one for each of ${names}, until each has paid you its part: ${fmtTac(o.receive)} private TAC in all, in about ${minutesFor(o.minConfs)} minutes. A part that does not go through returns its lock to your address after ${timelockText(Math.max(...o.legs.map((l) => Number(l.quote.csvBlocks) || 0)))}, and the others carry on. Press again to bridge.`);
  };
  async function goSplit() {
    const o = S.split, n = o.legs.length, sess = S.sess;
    if (o.cost && o.cost.short) { note(splitShort(o), true); return; }
    const key = o.legs.map((l) => `${l.quote.id}|${l.quote.btcValue}`).join(',');
    if (!(S.sure && S.sure.key === key && Date.now() - S.sure.at < 180e3)) { sureSplit(o); paintForm(); return; }
    S.sure = null;
    S.busy = true; note('Holding each provider’s share…'); paintForm();
    let offer = o, again = null;
    try {
      // quotes close to running out are asked for again, the split planned as before; a dearer one is shown first and needs another press
      if (offer.legs.some((l) => Number(l.quote.validUntil) <= Math.floor(Date.now() / 1000) + 150)) {
        const fresh = await sess.sweepOffer(others(), offer.amount);
        if (!fresh.ok) throw new Error(splitWhy(fresh, offer.amount));
        const takeOf = (x) => x.legs.reduce((s, l) => s + Number(l.quote.takeSats ?? 0), 0);
        const flagged = (x, k) => x.legs.some((l) => !!l.quote[k]);
        const worse = fresh.receive < offer.receive || takeOf(fresh) > takeOf(offer) || ['highFee', 'highTake', 'takeAbove', 'aboveTerms'].some((k) => flagged(fresh, k) && !flagged(offer, k))
          || Math.max(...fresh.legs.map((l) => Number(l.quote.csvBlocks) || 0)) > Math.max(...offer.legs.map((l) => Number(l.quote.csvBlocks) || 0));
        if (worse || (fresh.cost && fresh.cost.short)) { S.split = fresh; again = 'The quote changed.'; return; }
        offer = fresh;
      }
      const r = await sess.startSweep(offer);
      if (S.want) { const pub = S.pub; S.want = null; S.told = false; clearInterval(S.watch); wants.stop(pub).catch(() => {}); }
      S.recs = await sess.records(); S.split = null; S.amt = ''; $('fx-amt').value = '';
      const unsent = r.started.filter((x) => x.unsent).length;
      if (!r.failed.length) note(unsent ? `Signed, but Bitcoin has not taken ${unsent} of the ${n} locks yet. They are listed below and sent again by themselves while this page is open.` : `Started in ${n} parts. Each is listed below, and every step is taken as Bitcoin confirms.`);
      else note(`${r.started.length} of ${n} parts started. The other ${fmtTac(r.failed.reduce((s, f) => s + BigInt(f.amount), 0n))} TAC was not: ${wording(r.failed[0].error)} Bridge it again once the first locks have confirmed.`, true);
      sess.balance().then((b) => { S.bal = b; paintForm(); }).catch(() => {});
    } catch (e) {
      if (e && e.code === 'sweep-hold' && e.provider) {
        // that provider could not hold its part, and nothing was locked: the split is planned again without it
        const next = await sess.sweepOffer(others(), offer.amount, { exclude: new Set([e.provider.id]) }).catch(() => null);
        if (next && next.ok) { S.split = next; again = `${e.provider.name || 'A provider'} could not hold its part, so the split was planned again without it.`; }
        else note(`${e.message}. Nothing was locked.${next && !next.ok ? ` ${splitWhy(next, offer.amount)}` : ''}`, true);
      } else note(wording(e), true);
    } finally {
      S.busy = false; paint();
      if (again && S.split) { if (S.split.cost && S.split.cost.short) note(`${again} ${splitShort(S.split)}`, true); else { sureSplit(S.split); note(`${again} ${S.note}`); } paintForm(); }
    }
  }

  const shortText =(c) => `This key's Bitcoin address holds ${(c.have || 0).toLocaleString('en-US')} sats for fees and this bridge needs about ${(c.need || c.total || 0).toLocaleString('en-US')}. Add some from Receive in the Bitcoin tab on the front page.`;

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
    destroy: () => { if (S.stop) S.stop(); clearTimeout(S.timer); clearInterval(S.watch); clearInterval(S.depthTimer); },
  };
}
