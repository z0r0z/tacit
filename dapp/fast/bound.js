// The "ready for Ethereum" panel of the fast bridge page: TAC made ready once on Bitcoin (a bound note) moves to the key's private
// balance in one step once the reflection has it, with no provider. What is not DOM is passed in, so the panel's logic runs without a
// wallet.
//
//   const bd = mountBound({ root, keyS, open })
//   root        a <details> the panel draws in
//   keyS        the key session (trade/key.js)
//   open()      -> { balance(), bound(), bind({ amount }), move(note), unbind(note) } for the open key (fast/wire.js openBound)

import { ONE, esc, fmtTac, parseTac } from './fmt.js';

const MIN = 10n * ONE, MAX = 1000n * ONE;
const SCAN = 'https://mempool.space/tx/';
const hours = (mins) => (mins < 90 ? 'about an hour' : `about ${Math.round(mins / 60)} hours`);

export function mountBound({ root, keyS, open, refreshMs = 60000 }) {
  const doc = root.ownerDocument;
  const S = { sess: null, pub: null, bal: null, notes: null, loading: false, busy: null, timer: 0, last: null, shown: false };

  root.hidden = true;
  root.innerHTML = `
    <summary>Ready for Ethereum</summary>
    <div class="pv-in">
      <p class="note">Make TAC ready once. A few hours later it moves to your private balance in one step, with no provider.</p>
      <div class="rows" id="bd-list"></div>
      <div class="fx-amt"><input id="bd-amt" inputmode="decimal" placeholder="0" autocomplete="off" spellcheck="false" aria-label="TAC to make ready"><span>TAC</span></div>
      <button class="btn" id="bd-go" type="button">Make ready</button>
      <p class="status" id="bd-st" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (id) => doc.getElementById(id);
  const note = (text, bad = false) => { $('bd-st').textContent = text; $('bd-st').className = `status${bad ? ' err' : ''}`; };

  function problem(units) {
    if (units == null) return $('bd-amt').value.trim() ? 'That is not an amount.' : '';
    if (units < MIN) return `The least is ${fmtTac(MIN)} TAC.`;
    if (units > MAX) return `The most at a time is ${fmtTac(MAX)} TAC.`;
    if (S.bal != null && units > S.bal) return 'That is more than your TAC on Bitcoin.';
    return '';
  }

  function paint() {
    root.hidden = !keyS.unlocked || !S.shown;
    const list = $('bd-list'), ns = (S.notes || []).filter((n) => n.state !== 'moved' && n.state !== 'spent');
    list.innerHTML = S.loading && !S.notes ? '<p class="empty">Reading your TAC ready for Ethereum…</p>'
      : ns.length ? ns.map((n) => { const k = `${n.txid}:${n.vout}`, dis = S.busy ? ' disabled' : ''; return `<div class="kv bd-note" data-k="${esc(k)}">
          <span class="num">${esc(fmtTac(n.amount))} TAC</span>
          ${n.state === 'ready'
            ? `<button class="linkbtn" type="button" data-move="${esc(k)}"${dis}>${S.busy === k ? 'Moving…' : 'Move to Ethereum'}</button>`
            : `<b>Ready in ${esc(hours(n.etaMins))}</b>`}
          <button class="linkbtn bd-off" type="button" data-unbind="${esc(k)}"${dis}>${S.busy === 'u' + k ? 'Sending…' : 'Use on Bitcoin'}</button>
        </div>`; }).join('') : '';
    const units = parseTac($('bd-amt').value), bad = problem(units);
    const go = $('bd-go');
    go.textContent = S.busy === 'bind' ? 'Working…' : 'Make ready';
    go.disabled = !S.sess || !!S.busy || units == null || !!bad;
    if (bad) note(bad, true);
  }

  async function refresh() {
    if (!S.sess) return;
    try {
      const [notes, bal] = await Promise.all([S.sess.bound(), S.sess.balance()]);
      if (S.sess) { S.notes = notes; S.bal = bal; }
    } catch (e) { note(String((e && e.message) || e).slice(0, 160), true); }
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
      await refresh();
      clearInterval(S.timer);
      S.timer = setInterval(refresh, refreshMs);
    } catch (e) { S.sess = null; note(String((e && e.message) || e).slice(0, 160), true); } finally { S.loading = false; paint(); }
  }

  async function bind() {
    const units = parseTac($('bd-amt').value);
    if (!S.sess || S.busy || units == null || problem(units)) return;
    S.busy = 'bind'; note('Making your TAC ready…'); paint();
    try {
      const r = await S.sess.bind({ amount: units });
      $('bd-amt').value = '';
      note('Sent. It is ready in about 4 hours.');
      S.last = r.txid;
      $('bd-st').insertAdjacentHTML('beforeend', ` <a href="${SCAN}${esc(r.txid)}" target="_blank" rel="noopener noreferrer">Bitcoin transaction ↗</a>`);
    } catch (e) { note(String((e && e.message) || e).slice(0, 160), true); } finally { S.busy = null; await refresh(); }
  }

  async function move(key) {
    const n = (S.notes || []).find((x) => `${x.txid}:${x.vout}` === key);
    if (!n || S.busy) return;
    S.busy = key; note('Moving to your private balance…'); paint();
    try {
      await S.sess.move(n);
      note(`${fmtTac(n.amount)} TAC moved to your private balance.`);
    } catch (e) { note(String((e && e.message) || e).slice(0, 160), true); } finally { S.busy = null; await refresh(); }
  }

  // a bound note back to ordinary TAC at the trading address: there to send or sell once the reflection passes it
  async function unbind(key) {
    const n = (S.notes || []).find((x) => `${x.txid}:${x.vout}` === key);
    if (!n || S.busy || !S.sess.unbind) return;
    S.busy = 'u' + key; note('Sending it back to your Bitcoin address…'); paint();
    try {
      const r = await S.sess.unbind(n);
      note(`${fmtTac(n.amount)} TAC is back at your Bitcoin address, to use there in about 4 hours.`);
      $('bd-st').insertAdjacentHTML('beforeend', ` <a href="${SCAN}${esc(r.txid)}" target="_blank" rel="noopener noreferrer">Bitcoin transaction ↗</a>`);
    } catch (e) { note(String((e && e.message) || e).slice(0, 160), true); } finally { S.busy = null; await refresh(); }
  }

  $('bd-amt').addEventListener('input', () => { note(''); paint(); });
  $('bd-go').addEventListener('click', bind);
  $('bd-list').addEventListener('click', (e) => {
    const m = e.target?.closest?.('[data-move]')?.dataset.move, u = e.target?.closest?.('[data-unbind]')?.dataset.unbind;
    if (m) move(m); else if (u) unbind(u);
  });
  root.addEventListener('toggle', () => { if (root.open) load(); });
  keyS.onChange(() => {
    if (!keyS.unlocked || (S.pub && keyS.key.pubHex !== S.pub)) {
      clearInterval(S.timer);
      Object.assign(S, { sess: null, pub: null, bal: null, notes: null, busy: null });
      note('');
    }
    paint();
    if (keyS.unlocked && !S.sess && root.open) load();
  });

  // While the fast lane is new the panel is unlisted: /fast/#ready shows it, open, and it stays for the visit.
  const reveal = () => {
    if (doc.defaultView?.location.hash !== '#ready' || S.shown) return;
    S.shown = true; root.open = true; paint(); if (keyS.unlocked) load();
    // the front page then offers TAC bridged to Bitcoin arriving ready for this panel
    try { doc.defaultView.localStorage.setItem('tacit-fast-ready-v1', '1'); } catch { /* a convenience */ }
  };
  doc.defaultView?.addEventListener('hashchange', reveal);
  reveal();
  paint();
  return { refresh };
}

