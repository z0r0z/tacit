// The "Send TAC to Bitcoin" panel of the fast bridge page: private TAC sent for TAC on Bitcoin, from a provider that holds it there (the bridge's other
// direction). It is hidden until a provider's ad says it sells this way. What is not DOM is passed in, so the panel's logic runs without a wallet.
//
//   const rv = mountReverse({ root, keyS, open, providers, signIn })
//   root        a <details> the panel draws in
//   keyS        the key session (trade/key.js)
//   open()      -> { available(), quote({ provider, units }), start({ provider, quote }), records(), run({ onChange }) } for the open key (fast/wire.js openReverse)
//   providers() -> the list discoverProviders gives; the ones with `reverse` terms are the ones that sell this way
//   -> { busy(), refresh() }: busy is true while a swap is not over, so the page can say so before it is closed

import { ONE, esc, fmtTac, parseTac } from './fmt.js';

const SCAN = 'https://mempool.space/tx/';
// a send takes a Bitcoin confirmation or more before the TAC is locked, as many as the provider's lock needs for the amount (a bigger one waits longer)
const confsFor = (units) => (units >= 10_000n * ONE ? 3 : units >= 1_000n * ONE ? 2 : 1);
const cost = (t, units) => t.flatFee + (units * BigInt(t.feeBps)) / 10000n;
const room = (t) => (t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount);
const hours = (blocks) => { const h = Math.max(1, Math.round((blocks * 10) / 60)); return h === 1 ? 'about an hour' : `about ${h} hours`; };

export function mountReverse({ root, keyS, open, providers, signIn = () => {}, quoteDelayMs = 350, refreshMs = 60000, tendMs = 15000 }) {
  const doc = root.ownerDocument;
  const S = { sess: null, pub: null, bal: null, list: [], recs: [], quote: null, loading: false, busy: false, seq: 0, timer: 0, stop: null, qtimer: 0, quoting: false, shown: false };

  root.hidden = true;
  root.innerHTML = `
    <summary>Send TAC to Bitcoin</summary>
    <div class="pv-in">
      <p class="note">Send private TAC and get TAC on Bitcoin, from a provider that holds it there. The provider locks its Bitcoin first, so your TAC is only locked once its Bitcoin is.</p>
      <p class="note" id="rv-bal"></p>
      <div class="fx-amt"><input id="rv-amt" inputmode="decimal" placeholder="0" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore="true" data-form-type="other" spellcheck="false" aria-label="Private TAC to send">
      <button class="btn" id="rv-go" type="button">Send</button></div>
      <p class="status" id="rv-quote" role="status" aria-live="polite"></p>
      <p class="status" id="rv-st" role="status" aria-live="polite"></p>
      <div class="rows" id="rv-list"></div>
      <p class="note">Keep this page open until it says Done. If you have to close it, open it again within a few hours: your Bitcoin has to be taken before the provider's timelock ends. The TAC you get is whatever the provider holds on Bitcoin; some of it cannot be bridged back to Ethereum later (it can be traded on Bitcoin).</p>
    </div>`;
  const $ = (id) => doc.getElementById(id);
  const say = (id, text, bad = false) => { const el = $(id); el.textContent = text; el.className = `status${bad ? ' err' : ''}`; };
  const note = (text, bad = false) => say('rv-st', text, bad);
  const reverse = () => (S.list || []).filter((p) => p.reverse);
  const ended = (r) => !!r.ended;

  // what is wrong with an amount before anyone is asked for a quote
  function problem(units) {
    if (units == null) return $('rv-amt').value.trim() ? 'That is not an amount.' : '';
    if (S.bal != null && units > S.bal) return `That is more than the ${fmtTac(S.bal)} private TAC you can send now.`;
    return '';
  }
  const options = (units) => reverse().filter((p) => units >= p.reverse.minAmount && units <= room(p.reverse)).sort((a, b) => { const x = cost(a.reverse, units), y = cost(b.reverse, units); return x < y ? -1 : x > y ? 1 : 0; });
  function noRoom(units) {
    const all = reverse();
    if (!all.length) return 'No provider is selling TAC on Bitcoin right now.';
    const least = all.reduce((m, p) => (p.reverse.minAmount < m ? p.reverse.minAmount : m), all[0].reverse.minAmount), most = all.reduce((m, p) => (room(p.reverse) > m ? room(p.reverse) : m), 0n);
    if (units < least) return `The least a provider takes is ${fmtTac(least)} TAC.`;
    if (units > most) return most > 0n ? `The most a provider can take now is ${fmtTac(most)} TAC.` : 'The providers have no TAC on Bitcoin to sell right now.';
    return 'No provider can take that amount now.';
  }

  function paintQuote() {
    const q = S.quote;
    if (!q) return;
    const { p, q: x } = q, pct = Number((x.fee * 10000n) / x.evmAmount) / 100;
    say('rv-quote', `You send ${fmtTac(x.evmAmount)} TAC and get ${fmtTac(x.btcValue)} TAC on Bitcoin. ${p.name} keeps ${fmtTac(x.fee)} (${pct}%). `
      + `Its Bitcoin lock needs ${confsFor(x.btcValue)} confirmation${confsFor(x.btcValue) === 1 ? '' : 's'} first, then your TAC is locked and it claims it.${x.highFee ? ' That fee is high.' : ''}`, !!x.highFee);
  }

  function paintList() {
    const list = $('rv-list');
    list.innerHTML = S.loading && !S.sess ? '<p class="empty">Reading your swaps…</p>' : (S.recs || []).map((r) => `<div class="rv-swap" data-id="${esc(r.id)}">
        <div class="kv"><span class="num">${esc(fmtTac(r.amount || '0'))} TAC → ${esc(fmtTac(r.receive || '0'))} on Bitcoin</span><b>${esc(r.title)}</b></div>
        <p class="empty">${esc(r.provider || '')}${r.provider && r.detail ? ' · ' : ''}${esc(r.detail || '')}${r.error && !r.ended ? ` (${esc(String(r.error).slice(0, 120))})` : ''}${r.lockTxid ? ` <a href="${SCAN}${esc(r.lockTxid)}" target="_blank" rel="noopener noreferrer">Provider's lock ↗</a>` : ''}${r.takeTxid ? ` <a href="${SCAN}${esc(r.takeTxid)}" target="_blank" rel="noopener noreferrer">Your Bitcoin ↗</a>` : ''}</p>
      </div>`).join('');
  }

  function paint() {
    const any = reverse().length > 0 || (S.recs || []).length > 0;
    root.hidden = !any;
    $('rv-bal').textContent = !keyS.unlocked ? '' : S.bal == null ? (S.loading ? 'Reading your private balance…' : '') : `Private TAC you can send now: ${fmtTac(S.bal)}`;
    const units = parseTac($('rv-amt').value), go = $('rv-go');
    go.textContent = S.busy ? 'Working…' : !keyS.unlocked ? 'Open your wallet' : S.sure ? 'Press again to send' : 'Send';
    go.disabled = S.busy || (keyS.unlocked && (!S.sess || !S.quote || units == null || S.quoting));
    paintList();
  }

  async function refresh() {
    if (!S.sess) return;
    try { const bal = await S.sess.available(); if (S.sess) S.bal = bal; } catch (e) { note(String((e && e.message) || e).slice(0, 160), true); }
    try { const l = await providers(); S.list = l; } catch { /* the list stays as it was */ }
    paint();
  }

  async function load() {
    if (S.sess || S.loading || !keyS.unlocked) return;
    const pub = keyS.key.pubHex;
    S.loading = true; paint();
    try {
      const sess = await open();
      if (!keyS.unlocked || keyS.key.pubHex !== pub) return;
      S.sess = sess; S.pub = pub;
      S.stop = sess.run({ everyMs: tendMs, onChange: (recs) => { S.recs = recs; paintList(); refreshSoon(); } });
      await refresh();
      clearInterval(S.timer);
      S.timer = setInterval(refresh, refreshMs);
    } catch (e) { S.sess = null; note(String((e && e.message) || e).slice(0, 160), true); } finally { S.loading = false; paint(); }
  }
  // the balance moves as a swap goes on; read it again a moment after the swaps change
  let soon = 0;
  const refreshSoon = () => { clearTimeout(soon); soon = setTimeout(refresh, 2000); };

  async function requote() {
    const my = ++S.seq, units = parseTac($('rv-amt').value);
    S.quote = null; S.sure = null; say('rv-quote', ''); S.quoting = false;
    if (!S.sess) { paint(); return; }
    const bad = problem(units);
    if (bad) { say('rv-quote', bad, true); paint(); return; }
    if (units == null) { paint(); return; }
    const opts = options(units);
    if (!opts.length) { say('rv-quote', noRoom(units), true); paint(); return; }
    S.quoting = true; say('rv-quote', `Asking ${opts[0].name}…`); paint();
    let last = null;
    for (const p of opts.slice(0, 3)) {
      try {
        const q = await S.sess.quote({ provider: p, units });
        if (my !== S.seq) return;
        S.quote = { p, q }; S.quoting = false; paintQuote(); paint();
        return;
      } catch (e) { last = e; if (my !== S.seq) return; }
    }
    S.quoting = false;
    say('rv-quote', last ? `${String((last && last.message) || last).slice(0, 160)}` : 'No provider gave a quote.', true);
    paint();
  }
  const requoteSoon = () => { clearTimeout(S.qtimer); S.quote = null; S.sure = null; say('rv-quote', ''); paint(); S.qtimer = setTimeout(requote, quoteDelayMs); };

  async function go() {
    if (!keyS.unlocked) { signIn(); return; }
    const q = S.quote;
    if (!S.sess || S.busy || !q) return;
    // the first press says what is sent, what arrives and what the provider keeps; the same press again, within three minutes, sends it
    const key = `${q.p.id}|${q.q.id}`;
    if (!(S.sure && S.sure.key === key && Date.now() - S.sure.at < 180e3)) {
      S.sure = { key, at: Date.now() };
      const pct = Number((q.q.fee * 10000n) / q.q.evmAmount) / 100;
      note(`${q.q.highFee ? `High fee: ${q.p.name} keeps ${fmtTac(q.q.fee)} TAC (${pct}%). ` : ''}This sends ${fmtTac(q.q.evmAmount)} private TAC once ${q.p.name}'s Bitcoin lock has confirmed, for ${fmtTac(q.q.btcValue)} TAC on Bitcoin. Press again to send.`, !!q.q.highFee);
      paint();
      return;
    }
    S.sure = null;
    S.busy = true; note('Asking the provider to lock its Bitcoin…'); paint();
    try {
      await S.sess.start({ provider: q.p, quote: q.q });
      $('rv-amt').value = ''; S.quote = null; say('rv-quote', '');
      note('Started. The provider is locking its Bitcoin. Keep this page open until it says Done.');
      try { S.recs = await S.sess.records(); } catch { /* the next pass */ }
    } catch (e) { note(String((e && e.message) || e).slice(0, 200), true); } finally { S.busy = false; paint(); refreshSoon(); }
  }

  $('rv-amt').addEventListener('input', () => { note(''); S.sure = null; requoteSoon(); });
  $('rv-go').addEventListener('click', go);
  root.addEventListener('toggle', () => { if (root.open) { if (keyS.unlocked) load(); } });
  keyS.onChange(() => {
    if (!keyS.unlocked || (S.pub && keyS.key.pubHex !== S.pub)) {
      clearInterval(S.timer); if (S.stop) S.stop(); S.stop = null;
      Object.assign(S, { sess: null, pub: null, bal: null, recs: [], quote: null, busy: false });
      note(''); say('rv-quote', '');
    }
    paint();
    if (keyS.unlocked && !S.sess && root.open) load();
  });

  // the providers are read as the page draws: the panel shows only when one of them sells this way
  (async () => { try { S.list = await providers(); } catch { S.list = []; } paint(); })();
  paint();
  return { busy: () => (S.recs || []).some((r) => !ended(r)), refresh };
}
