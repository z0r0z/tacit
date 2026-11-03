// The provider panel of the fast bridge page: what the key can provide (its private TAC), a fee and a size, and
// a switch. Anyone with a Tacit key can be a provider: the page answers requests and takes the Bitcoin while it is open. What is not
// DOM is passed in, so the panel's logic runs without a wallet.
//
//   const pv = mountProvide({ root, keyS, open, hasOpen, settings })
//   root        a <details> the panel draws in
//   keyS        the key session (trade/key.js)
//   open()      -> { inventory(), start({ settings, accept }), stop(), status() } for the open key (fast/wire.js openProvider)
//   hasOpen(pub)  whether this key has provider swaps that are not finished: they are tended as soon as the key is open
//   settings    { get(pub), set(pub, settings) } the fee and size kept for a key
//   waiting()   -> { count, total }: the bridges waiting on the boards for a provider (fast/want.js), shown to anyone who could provide
//   -> { busy() }   whether closing the page now would leave a swap untended

import { DEC, ONE, esc, fmtTac, parseTac } from './fmt.js';

const MIN_AMOUNT = 10n * ONE;
const DEFAULT_MOST = 1000n * ONE;
const percent = (text) => { const t = String(text).trim().replace('%', ''); if (!/^\d+(\.\d{0,2})?$/.test(t)) return null; const bps = Math.round(Number(t) * 100); return bps >= 0 && bps <= 500 ? bps : null; };
const every = 5000;
const SCAN = 'https://mempool.space/tx/';

export function mountProvide({ root, keyS, open, hasOpen = () => false, settings = { get: () => null, set: () => {} }, waiting = null, waitMs = 60000, refreshMs = every }) {
  const doc = root.ownerDocument;
  const S = { sess: null, pub: null, inv: null, st: null, loading: false, note: '', bad: false, timer: 0, opened: false, wait: null };

  root.hidden = true;
  root.innerHTML = `
    <summary>Provide liquidity<span class="pv-waiting" id="pv-waiting"></span></summary>
    <div class="pv-in">
      <p class="note">Earn the fee on each bridge. Keep this page open while you provide.</p>
      <div class="kv" id="pv-want" hidden><span>Waiting for a provider</span><b class="num"></b></div>
      <div class="rows flat" id="pv-inv"></div>
      <div id="pv-set" hidden>
        <label class="pv-f"><span>Fee, %</span><input id="pv-fee" inputmode="decimal" autocomplete="off" aria-label="Fee in percent"></label>
        <label class="pv-f"><span>Most per bridge, TAC</span><input id="pv-most" inputmode="decimal" autocomplete="off" aria-label="Most TAC per bridge"></label>
      </div>
      <div class="rows" id="pv-run" hidden></div>
      <button class="btn" id="pv-go" type="button" hidden>Start providing</button>
      <p class="status" id="pv-st" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (id) => doc.getElementById(id);
  const note = (text, bad = false) => { S.note = text; S.bad = bad; $('pv-st').textContent = text; $('pv-st').className = `status${bad ? ' err' : ''}`; };

  const running = () => !!(S.st && S.st.running);
  const accepting = () => !!(S.st && S.st.accepting);

  function paint() {
    root.hidden = !keyS.unlocked;
    const inv = S.inv, st = S.st, w = S.wait && S.wait.count ? S.wait : null;
    $('pv-waiting').textContent = w ? ` · ${w.count} waiting` : '';
    $('pv-want').hidden = !w;
    if (w) $('pv-want').lastElementChild.textContent = `${w.count} bridge${w.count === 1 ? '' : 's'}, ${fmtTac(w.total)} TAC`;
    $('pv-inv').innerHTML = S.loading ? '<p class="empty">Reading what you can provide…</p>' : inv ? `
      <div class="kv"><span>Your private TAC</span><b class="num">${esc(fmtTac(inv.pool))} TAC</b></div>` : '';
    $('pv-set').hidden = !inv || accepting();
    const run = $('pv-run');
    run.hidden = !st || !(st.running || st.lastTake);
    if (st) {
      run.innerHTML = `${st.running ? `<div class="kv"><span>${st.accepting ? 'Providing' : 'Finishing'}</span><b class="num">${st.accepting ? 'on' : 'no new bridges'}</b></div>
        <div class="kv"><span>Open bridges</span><b class="num">${st.open}</b></div>
        <div class="kv"><span>Done</span><b class="num">${st.done}</b></div>
        <div class="kv"><span>Earned</span><b class="num">${esc(fmtTac(st.earned))} TAC</b></div>` : ''}${st.lastTake ? `
        <div class="kv"><span>Last take</span><b><a href="${SCAN}${esc(st.lastTake)}" target="_blank" rel="noopener noreferrer">Bitcoin transaction ↗</a></b></div>` : ''}`;
    }
    const go = $('pv-go');
    go.hidden = !inv;
    go.textContent = accepting() ? 'Stop providing' : 'Start providing';
    if (st && st.lastError && !S.note) $('pv-st').textContent = st.lastError;
  }

  // what is typed, as the engine takes it: { feeBps, maxAmount } or the reason it cannot be
  function read() {
    const feeBps = percent($('pv-fee').value), most = parseTac($('pv-most').value);
    if (feeBps == null) return { why: 'The fee is a percentage from 0 to 5.' };
    if (most == null || most < MIN_AMOUNT) return { why: `The most per bridge is at least ${fmtTac(MIN_AMOUNT)} TAC.` };
    if (S.inv && most > S.inv.pool) return { why: 'That is more private TAC than you have.' };
    return { feeBps, maxAmount: most };
  }

  async function load() {
    if (S.sess || S.loading || !keyS.unlocked) return;
    const pub = keyS.key.pubHex;
    S.loading = true; paint();
    try {
      const sess = await open();
      if (!keyS.unlocked || keyS.key.pubHex !== pub) return;
      S.sess = sess; S.pub = pub;
      S.inv = await sess.inventory();
      const kept = settings.get(pub) || {};
      $('pv-fee').value = ((kept.feeBps ?? 30) / 100).toFixed(2);
      const most = kept.maxAmount != null ? BigInt(kept.maxAmount) : (S.inv.pool < DEFAULT_MOST ? S.inv.pool : DEFAULT_MOST);
      $('pv-most').value = (most / ONE).toString() + (most % ONE ? '.' + (most % ONE).toString().padStart(DEC, '0').replace(/0+$/, '') : '');
      S.st = await sess.status();
      note('');
      // swaps left open by an earlier visit are tended as soon as the key is open, whether or not the key provides again
      if (!S.st.running && hasOpen(pub)) { await sess.start({ accept: false }); S.st = await sess.status(); note('Bridges you provided are still open. Keep this page open until they are done.'); }
    } catch (e) { S.sess = null; note(String((e && e.message) || e).slice(0, 160), true); } finally { S.loading = false; paint(); poll(); }
  }

  function poll() {
    clearInterval(S.timer);
    if (!S.sess) return;
    S.timer = setInterval(async () => { try { S.st = await S.sess.status(); S.inv = await S.sess.inventory().catch(() => S.inv); paint(); } catch { /* the next look */ } }, refreshMs);
  }

  async function go() {
    if (!S.sess || !S.inv) return;
    if (accepting()) {
      // stopping takes no new bridges; the ones open are still seen to the end
      S.sess.stop();
      const st = await S.sess.status();
      if (st.open) { await S.sess.start({ accept: false }); note('No new bridges. Keep this page open until the open ones are done.'); } else note('Stopped.');
      S.st = await S.sess.status(); paint();
      return;
    }
    const r = read();
    if (r.why) { note(r.why, true); return; }
    if (S.inv.pool < MIN_AMOUNT) { note('Make some TAC private on the front page first.', true); return; }
    settings.set(S.pub, { feeBps: r.feeBps, maxAmount: r.maxAmount.toString() });
    try {
      if (running()) S.sess.stop();
      await S.sess.start({ settings: { feeBps: r.feeBps, maxAmount: r.maxAmount }, accept: true });
      S.st = await S.sess.status();
      note('Providing. Keep this page open until your bridges are done.');
    } catch (e) { note(String((e && e.message) || e).slice(0, 160), true); }
    paint();
  }
  $('pv-go').addEventListener('click', go);
  root.addEventListener('toggle', () => { if (root.open) load(); });
  keyS.onChange(() => {
    if (!keyS.unlocked || (S.pub && keyS.key.pubHex !== S.pub)) {
      if (S.sess) { try { S.sess.stop(); } catch { /* already stopped */ } }
      clearInterval(S.timer);
      Object.assign(S, { sess: null, pub: null, inv: null, st: null });
      note('');
    }
    paint();
    // a key that has swaps open to tend is not left waiting for the panel to be opened
    if (keyS.unlocked && !S.sess && hasOpen(keyS.key.pubHex)) { root.open = true; load(); }
    else if (keyS.unlocked && !S.sess && root.open) load();
  });

  // /fast/#provide comes straight to this panel
  if (doc.defaultView?.location.hash === '#provide') root.open = true;
  // what is waiting for a provider, read now and every minute
  if (waiting) {
    const look = () => waiting().then((w) => { S.wait = w; paint(); }).catch(() => {});
    look(); setInterval(look, waitMs);
  }
  paint();
  return { busy: () => !!(S.st && S.st.running && (S.st.accepting || S.st.open > 0)) };
}
