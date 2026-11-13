// The provider panel of the fast bridge page: what the key can provide (its private TAC), a fee and a size, and
// a switch. Anyone with a Tacit key can be a provider: the page answers requests and takes the Bitcoin while it is open. What is not
// DOM is passed in, so the panel's logic runs without a wallet.
//
//   const pv = mountProvide({ root, keyS, open, hasOpen, settings })
//   root        a <details> the panel draws in
//   keyS        the key session (trade/key.js)
//   open()      -> { inventory(), start({ settings, accept }), stop(), status() } for the open key (fast/wire.js openProvider)
//   hasOpen(pub)  whether this key has provider swaps that are not finished: they are tended as soon as the key is open
//   base        { minAmount, flatFee } the terms the panel does not ask for (fast/wire.js PROVIDER_DEFAULTS)
//   settings    { get(pub), set(pub, settings) } the fee and size kept for a key
//   waiting()   -> { count, total, items }: the bridges waiting on the boards for a provider (fast/want.js), shown to anyone who could provide
//   notify(t)   a notice for a new waiting bridge this key could take (the page shows it while the tab is hidden); ask() asks leave for it
//   linkOf(id)  the address of the page that pairs a bridger with this key's provider
//   signIn()    opens the key (the page's wallet sheet): given, the panel is shown before a key too, so anyone who comes by finds that they can provide
//   -> { busy() }   whether closing the page now would leave a swap untended

import { DEC, ONE, esc, fmtTac, parseTac, slowNet, pairId } from './fmt.js';

const MIN_AMOUNT = 10n * ONE;
const FEE_LIMIT_BPS = 500n;
const DEFAULT_MOST = 1000n * ONE;
const percent = (text) => { const t = String(text).trim().replace('%', ''); if (!/^\d+(\.\d{0,2})?$/.test(t)) return null; const bps = Math.round(Number(t) * 100); return bps >= 0 && bps <= 500 ? bps : null; };
const every = 5000;
const SCAN = 'https://mempool.space/tx/';

export function mountProvide({ base = { minAmount: MIN_AMOUNT, flatFee: 10_000_000n }, root, keyS, open, hasOpen = () => false, settings = { get: () => null, set: () => {} }, waiting = null, notify = () => {}, ask = async () => {}, signIn = null, linkOf = (id) => `https://tacit.finance/fast/#with=${id}`, waitMs = 60000, retryMs = 15000, refreshMs = every }) {
  const doc = root.ownerDocument;
  const S = { sess: null, pub: null, inv: null, st: null, loading: false, busy: false, invAt: 0, note: '', bad: false, timer: 0, opened: false, wait: null, seen: null };

  root.hidden = true;
  root.innerHTML = `
    <summary>Provide liquidity<span class="pv-waiting" id="pv-waiting"></span></summary>
    <div class="pv-in">
      <p class="note">Earn the fee on each bridge. Keep this page open while you provide, or <a href="https://github.com/src-company/tacit/blob/main/fastbridge-lp/README.md" target="_blank" rel="noopener noreferrer">run a provider</a> that stays on.</p>
      <div class="kv" id="pv-want" hidden><span>Waiting for a provider</span><b class="num"></b></div>
      <div class="rows flat" id="pv-inv"></div>
      <div id="pv-set" hidden>
        <label class="pv-f"><span>Fee, %</span><input id="pv-fee" inputmode="decimal" autocomplete="off" aria-label="Fee in percent"></label>
        <label class="pv-f"><span>Most per bridge, TAC</span><input id="pv-most" inputmode="decimal" autocomplete="off" aria-label="Most TAC per bridge"></label>
        <label class="pv-chk"><input id="pv-any" type="checkbox" checked><span>Take TAC that came out of the shielded pool<small>It cannot be bridged home afterwards, only traded on Bitcoin.</small></span></label>
      </div>
      <div class="rows" id="pv-run" hidden></div>
      <button class="btn" id="pv-go" type="button" hidden>Start providing</button>
      <p class="status" id="pv-st" role="status" aria-live="polite"></p>
    </div>`;
  const $ = (id) => doc.getElementById(id);
  const note = (text, bad = false) => { S.note = text; S.bad = bad; $('pv-st').textContent = text; $('pv-st').className = `status${bad ? ' err' : ''}`; };

  const running = () => !!(S.st && S.st.running);
  const accepting = () => !!(S.st && S.st.accepting);

  // the waiting bridges this key could take: inside its least and what it holds free, and its most per bridge when it has one set
  const fitting = (w) => {
    if (!S.inv || !w || !w.items) return [];
    const free = S.st && S.st.held != null && S.inv.pool > S.st.held ? S.inv.pool - S.st.held : S.st && S.st.held != null ? 0n : S.inv.pool;
    const kept = S.pub ? settings.get(S.pub) : null, most = kept && kept.maxAmount != null ? BigInt(kept.maxAmount) : free;
    return w.items.filter((i) => i.amount >= base.minAmount && i.amount <= free && i.amount <= most);
  };
  // too little private TAC for the smallest bridge, and not providing (a provider that is on can always stop)
  const short = () => !!(S.inv && S.inv.pool < MIN_AMOUNT && !accepting());
  function paint() {
    const locked = !keyS.unlocked;
    root.hidden = locked && !signIn;
    const inv = S.inv, st = S.st, w = S.wait && S.wait.count ? S.wait : null;
    $('pv-waiting').textContent = w ? ` · ${w.count} waiting` : '';
    $('pv-want').hidden = !w;
    if (w) {
      const sizes = (w.items || []).map((i) => fmtTac(i.amount)), fits = fitting(w).length;
      $('pv-want').lastElementChild.textContent = sizes.length ? `${sizes.slice(0, 4).join(' · ')} TAC${sizes.length > 4 ? ` +${sizes.length - 4}` : ''}${inv ? ` (you can take ${fits})` : ''}` : `${w.count} bridge${w.count === 1 ? '' : 's'}, ${fmtTac(w.total)} TAC`;
    }
    $('pv-inv').innerHTML = S.loading ? '<p class="empty">Reading what you can provide…</p>' : inv ? `
      <div class="kv"><span>Your private TAC</span><b class="num">${esc(fmtTac(inv.pool))} TAC</b></div>${st && st.held != null && st.held > 0n ? `
      <div class="kv"><span>Held for bridges under way</span><b class="num">${esc(fmtTac(st.held))} TAC</b></div>
      <div class="kv"><span>Free to lend now</span><b class="num">${esc(fmtTac(inv.pool > st.held ? inv.pool - st.held : 0n))} TAC</b></div>` : ''}${short() ? `
      <p class="empty">Providing takes at least ${esc(fmtTac(MIN_AMOUNT))} private TAC. <a href="/#card=bridge">Make TAC private ↗</a></p>` : ''}${inv.claimPub ? `
      <div class="kv"><span>Your link</span><b><button class="linkbtn" type="button" id="pv-link" data-link="${esc(linkOf(pairId(inv.claimPub)))}">copy</button></b></div>` : ''}` : '';
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
    go.hidden = !inv && !locked;
    go.textContent = locked ? 'Open wallet' : S.busy ? 'Working…' : accepting() ? 'Stop providing' : 'Start providing';
    go.disabled = !locked && (short() || S.busy);
    if (st && st.lastError && !S.note) $('pv-st').textContent = st.lastError;
    keepAwake();
  }

  // While it provides, or a bridge it provides is open, the screen is kept awake: a laptop that sleeps after taking on a bridge leaves the
  // user's lock waiting a day for its timelock. A hidden tab with a bridge open says so in its title, where the tab strip shows it.
  const W = { lock: null, asking: false, title: '' };
  async function keepAwake() {
    const st = S.st, need = !!(st && st.running && (st.accepting || st.open > 0));
    const nav = doc.defaultView && doc.defaultView.navigator;
    if (need && !W.lock && !W.asking && nav && nav.wakeLock && doc.visibilityState === 'visible') {
      W.asking = true;
      try { W.lock = await nav.wakeLock.request('screen'); if (W.lock && W.lock.addEventListener) W.lock.addEventListener('release', () => { W.lock = null; }); } catch { /* refused, or not here: the page says to keep it open */ } finally { W.asking = false; }
    }
    if (!need && W.lock) { const l = W.lock; W.lock = null; try { await l.release(); } catch { /* already let go */ } }
    const warn = 'Keep this open: a bridge is under way · tacit fast';
    if (need && doc.hidden && st.open > 0) { if (doc.title !== warn) { W.title = doc.title; doc.title = warn; } } else if (doc.title === warn) doc.title = W.title;
  }
  // the browser lets go of the lock when the tab is hidden: it is asked for again when the tab is back
  doc.addEventListener('visibilitychange', async () => { if (S.sess) { try { S.st = await S.sess.status(); } catch { /* the last one read */ } } keepAwake(); });

  // what is typed, as the engine takes it: { feeBps, maxAmount } or the reason it cannot be
  function read() {
    const feeBps = percent($('pv-fee').value), most = parseTac($('pv-most').value);
    if (feeBps == null) return { why: 'The fee is a percentage from 0 to 5.' };
    if (most == null || most < MIN_AMOUNT) return { why: `The most per bridge is at least ${fmtTac(MIN_AMOUNT)} TAC.` };
    if (S.inv && most > S.inv.pool) return { why: 'That is more private TAC than you have.' };
    // the front page's Bridge tab prefers only a fee within 5% (fast/fmt.js highFee); the smallest bridge feels the flat fee most
    const least = base.minAmount, atLeast = (least * BigInt(feeBps)) / 10000n + base.flatFee;
    if (atLeast * 10000n > least * FEE_LIMIT_BPS) {
      const top = Number(((least * FEE_LIMIT_BPS - base.flatFee * 10000n) / least)) / 100;
      return { why: `At ${fmtTac(least)} TAC that fee is ${fmtTac(atLeast)} TAC, over the 5% the front page's Bridge tab prefers (the fast page quotes more, with a warning). Use at most ${top.toFixed(2)}%.` };
    }
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
      S.inv = await sess.inventory(); S.invAt = Date.now();
      const kept = settings.get(pub) || {};
      $('pv-fee').value = ((kept.feeBps ?? 30) / 100).toFixed(2);
      $('pv-any').checked = kept.anyTac !== false;
      // the default is what is held, down to four places, so it reads whole in the field and is never more than is held
      // a kept most that is more than is held now (bridges paid out since) is brought down to what is held
      const held = S.inv.pool - (S.inv.pool % 10_000n), was = kept.maxAmount != null ? BigInt(kept.maxAmount) : null;
      const most = was != null && was <= S.inv.pool ? was : held < DEFAULT_MOST ? held : DEFAULT_MOST;
      $('pv-most').value = (most / ONE).toString() + (most % ONE ? '.' + (most % ONE).toString().padStart(DEC, '0').replace(/0+$/, '') : '');
      S.st = await sess.status();
      note('');
      // swaps left open by an earlier visit are tended as soon as the key is open, whether or not the key provides again
      if (!S.st.running && hasOpen(pub)) { await sess.start({ accept: false }); S.st = await sess.status(); note('Bridges you provided are still open. Keep this page open until they are done.'); }
    } catch (e) {
      S.sess = null;
      if (slowNet(e)) {
        note('Ethereum is slow to answer right now. This panel tries again on its own.');
        setTimeout(() => { if (keyS.unlocked && keyS.key.pubHex === pub && !S.sess && root.open) load(); }, retryMs);
      } else note(String((e && e.message) || e).slice(0, 160), true);
    } finally { S.loading = false; paint(); poll(); }
  }

  // the private TAC is a scan of the pool's notes: it is read again when a bridge opened or ended since the last look, else twice a minute
  const invEvery = 30000;
  function poll() {
    clearInterval(S.timer);
    if (!S.sess) return;
    S.timer = setInterval(async () => {
      try {
        const was = S.st; S.st = await S.sess.status();
        if (!was || S.st.open !== was.open || S.st.done !== was.done || Date.now() - S.invAt > invEvery) { S.inv = await S.sess.inventory().catch(() => S.inv); S.invAt = Date.now(); }
        paint();
      } catch { /* the next look */ }
    }, refreshMs);
  }

  // one press at a time: a start is not running until it has read what it holds, and a second press meanwhile would start a second service
  async function go() {
    if (!S.sess || !S.inv || S.busy) return;
    S.busy = true; paint();
    try {
      if (accepting()) {
        // stopping takes no new bridges; the ones open are still seen to the end
        S.sess.stop();
        const st = await S.sess.status();
        if (st.open) { await S.sess.start({ accept: false }); note('No new bridges. Keep this page open until the open ones are done.'); } else note('Stopped.');
        S.st = await S.sess.status();
        return;
      }
      const r = read();
      if (r.why) { note(r.why, true); return; }
      if (S.inv.pool < MIN_AMOUNT) { note('Make some TAC private on the front page first.', true); return; }
      const anyTac = $('pv-any').checked;
      settings.set(S.pub, { feeBps: r.feeBps, maxAmount: r.maxAmount.toString(), anyTac });
      try {
        if (running()) S.sess.stop();
        await S.sess.start({ settings: { feeBps: r.feeBps, maxAmount: r.maxAmount, anyTac }, accept: true });
        S.st = await S.sess.status();
        note('Providing. Keep this page open until your bridges are done.');
      } catch (e) { note(String((e && e.message) || e).slice(0, 160), true); }
    } finally { S.busy = false; paint(); }
  }
  $('pv-go').addEventListener('click', async () => {
    // before a key, the button opens one; the panel reads it once it is open (keyS.onChange below)
    if (!keyS.unlocked) { if (signIn) { try { await signIn(); } catch (e) { if (!e?.unlockCancelled) note(String((e && e.message) || e).slice(0, 160), true); } } return; }
    if (!accepting()) ask().catch(() => {});
    go();
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('#pv-link');
    if (!b) return;
    try { await doc.defaultView.navigator.clipboard.writeText(b.dataset.link); note('Link copied. A bridger who opens it is paired with you whenever you can take their amount.'); } catch { note(b.dataset.link); }
  });
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

  if (keyS.unlocked && hasOpen(keyS.key.pubHex)) { root.open = true; load(); }

  // /fast/#provide comes straight to this panel: on load, and when a link on the page to it is followed
  const toLink = () => { if (doc.defaultView?.location.hash === '#provide') root.open = true; };
  toLink();
  doc.defaultView?.addEventListener('hashchange', toLink);
  // what is waiting for a provider, read now and every minute (a hidden tab with nothing to provide reads it again when it is back)
  if (waiting) {
    // a bridge that starts waiting and that this key could take is said once (the ones there at the first look are not news)
    let lookedAt = 0;
    const look = () => {
      if (S.seen && !S.inv && doc.visibilityState === 'hidden') return;
      lookedAt = Date.now();
      waiting().then((w) => {
        S.wait = w;
        const now = new Set((w.items || []).map((i) => i.pub));
        if (S.seen && S.inv) { const fresh = fitting(w).filter((i) => !S.seen.has(i.pub)); if (fresh.length) notify(`A bridge of ${fmtTac(fresh[0].amount)} TAC is waiting for a provider you can be.`); }
        if (S.inv || !S.seen) S.seen = now;
        paint();
      }).catch(() => {});
    };
    look(); setInterval(look, waitMs);
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState !== 'hidden' && Date.now() - lookedAt >= waitMs) look(); });
  }
  paint();
  return { busy: () => !!(S.st && S.st.running && (S.st.accepting || S.st.open > 0)) };
}
