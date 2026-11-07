// The header's menu closes on Escape, on a click or a tab outside it, and when a page is chosen. It is a <details>, so it opens and shuts without this.
(() => {
  const m = document.querySelector('.sm');
  if (!m) return;
  const shut = () => { m.open = false; };
  document.addEventListener('click', (e) => { if (m.open && !m.contains(e.target)) shut(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.open) { shut(); m.querySelector('summary').focus(); } });
  m.addEventListener('focusout', (e) => { if (e.relatedTarget && !m.contains(e.relatedTarget)) shut(); });
  m.addEventListener('click', (e) => { if (e.target.closest('.sm-p a')) shut(); });
})();

// A bridge under way shows on every page: a dot on the menu button, and its count on the menu's Bridges entry (the bridge page that follows them). It reads the journals the front page keeps for
// its bridges in this browser (the stage, any error, the flags that say what it waits on, and the plans that send a burn; nothing else), so it shows with no key open, and it follows another tab through the storage event.
(() => {
  const m = document.querySelector('.sm');
  if (!m) return;
  const OUT = 'tacit-crossout-bridge-v1:mainnet:', IN = 'tacit-burndep-bridge-v1:mainnet:';
  const summary = m.querySelector('summary'), link = m.querySelector('.sm-p a[href="/bridge/"]');
  if (!summary) return;
  const mark = () => { const d = document.createElement('i'); d.className = 'bd'; d.setAttribute('aria-hidden', 'true'); d.hidden = true; return d; };
  const dot = mark(), tag = document.createElement('span');
  tag.style.cssText = 'margin-left:auto;font-size:12px;color:var(--orange,#c2410c)';
  tag.hidden = true;
  summary.append(dot);
  if (link) link.append(tag);
  const label = summary.getAttribute('aria-label') || 'More pages';
  // What waits on the holder, as inDue and outDue in /bridge/track.js say it (tests/chrome-bridge-count.mjs holds the two together): a press to make, or a step
  // that has failed again and again. A burn that the holder's plan has the front page send is not waited on while it goes.
  const MINER_WAIT = 12 * 3600e3, PLANS = 'tacit-lite-bridge-plan-v1', TAC = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
  const tac = (r) => { const a = r.source || {}; return String(a.assetId || '').replace(/^0x/i, '').toLowerCase() === TAC || a.ticker === 'TAC'; };
  const waits = (out, r, plan, now) => {
    const s = r.stage, err = r.lastError, tries = r.errorCount || 0;
    if (out) return s === 'covered' || s === 'mint-rejected' || (s === 'settled' && !!r.settle && r.settle.claimIdVerified === false)
      || ((s === 'mint-signed' || s === 'mint-submitted') && !!err && tries >= 6 && !r.feeWait);
    if (s === 'traced') return !(((plan && plan.burn) || (r.checkWait && r.checkWait.go)) && !err && !r.feeWait);
    if (s === 'folded' || s === 'rfolded') return !(r.arm && r.arm.ok) && !(err && (Number(err.until) > now || err.relay));
    if (s === 'stopped') return true;
    if (s === 'burn-submitted') return now - Number(r.submittedAt || r.updatedAt || now) > MINER_WAIT;
    if (s === 'not-recorded') return r.path === 'reflected' && !(r.source && r.source.p2tr) && tac(r);
    return !!err && tries >= 3 && ['burn-signed', 'migrate-confirmed', 'rburn-signed', 'rburn-sent', 'migrate-signed', 'migrate-sent'].includes(s);
  };
  const count = () => {
    let under = 0, needs = 0;
    try {
      const now = Date.now();
      let plans = {}; try { plans = JSON.parse(localStorage.getItem(PLANS) || 'null') || {}; } catch {}
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i), out = k.startsWith(OUT);
        if (!out && !k.startsWith(IN)) continue;
        let list = null; try { list = JSON.parse(localStorage.getItem(k)); } catch {}
        if (!Array.isArray(list)) continue;
        const own = (!out && plans[k.slice(IN.length)]) || {};
        for (const r of list) {
          const s = r && r.stage;
          if (!s || (out ? s === 'minted' : s === 'minted' || s === 'reclaimed' || s === 'recovered')) continue;
          under++;
          if (waits(out, r, own[r.id], now)) needs++;
        }
      }
    } catch {}
    return { under, needs };
  };
  window.tacitBridges = count;
  const paint = () => {
    const { under, needs } = count();
    dot.hidden = tag.hidden = !under;
    tag.textContent = under ? (needs ? `${needs} needs you` : `${under} under way`) : '';
    const says = under ? `, ${under} bridge${under === 1 ? '' : 's'} under way${needs ? `, ${needs} needs you` : ''}` : '';
    summary.setAttribute('aria-label', label + says);
  };
  paint();
  addEventListener('storage', (e) => { if (!e.key || e.key.startsWith(OUT) || e.key.startsWith(IN) || e.key === PLANS) paint(); });
  addEventListener('focus', paint);
  setInterval(paint, 30e3);
})();

// What this browser has under way shows on every page that does not draw its own Activity chip (the front page does): a link to the front
// page's Activity, with how many entries are still going. It reads the shared journal (/activity.js) and follows another tab's writes.
(() => {
  const nav = document.querySelector('.sn');
  if (!nav || document.getElementById('act')) return;
  import('/activity.js').then(({ activityCount, onActivity }) => {
    const a = document.createElement('a'), n = document.createElement('b');
    a.className = 'sa'; a.href = '/#activity'; a.hidden = true;
    a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>';
    n.className = 'n'; n.hidden = true; a.append(n);
    nav.insertBefore(a, nav.querySelector('.sm'));
    const paint = () => {
      const { total, live } = activityCount();
      a.hidden = !total; n.hidden = !live; n.textContent = live ? String(live) : '';
      a.title = live ? `Activity, ${live} in progress` : 'Activity'; a.setAttribute('aria-label', a.title);
    };
    paint();
    onActivity(paint);
    addEventListener('focus', paint);
    setInterval(paint, 30e3);
  }).catch(() => {});
})();

// The pages share one service worker (dapp/sw.js). It keeps a versioned file (a ?cb= URL whose token matches its bytes) and answers for it from disk, so a
// repeat visit asks the network for the page and little else. It is registered once the page has loaded, and a page works the same without it.
(() => {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  // Under browser automation it is left out unless a test asks for it (window.__tacitSw): a page the worker controls is out of reach of a harness's own request mocks.
  if (navigator.webdriver && !window.__tacitSw) return;
  const register = () => setTimeout(() => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}), 1500);
  if (document.readyState === 'complete') register(); else addEventListener('load', register, { once: true });
})();

// A tab left open across a deploy keeps running the code it loaded. When the page is shown again (and every ten minutes while it
// is, no oftener) it asks for its own address with HEAD; another ETag means the page has changed since, and one line offers a reload.
(() => {
  if (!/^https?:$/.test(location.protocol) || typeof fetch !== 'function') return;
  if (navigator.webdriver && !window.__tacitUpd) return;
  const EVERY = 10 * 60e3;
  let mine = null, at = 0, said = false;
  // the same bytes carry a weak tag uncompressed and a strong one compressed, so the W/ is not part of the comparison
  const tag = () => fetch(location.pathname, { method: 'HEAD', cache: 'no-store' }).then((r) => (r.ok ? (r.headers.get('etag') || '').replace(/^W\//, '') || null : null), () => null);
  const say = () => {
    said = true;
    const bar = document.createElement('div'), go = document.createElement('button');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;display:flex;gap:12px;align-items:center;'
      + 'max-width:calc(100% - 32px);box-sizing:border-box;padding:10px 14px;border:1px solid var(--hair,#ddd);border-radius:12px;'
      + 'background:var(--card,#fff);color:var(--ink,#111);font:500 12.5px/1.3 var(--mono,monospace);box-shadow:0 6px 24px rgba(0,0,0,.14)';
    bar.textContent = 'This page has been updated.';
    go.type = 'button';
    go.textContent = 'Reload';
    go.style.cssText = 'flex:none;border:0;background:none;padding:0;color:var(--orange,#c2410c);font:inherit;cursor:pointer';
    go.addEventListener('click', () => location.reload());
    bar.append(go);
    document.body.append(bar);
  };
  const check = async () => {
    if (said || document.hidden || !mine || Date.now() - at < EVERY) return;
    at = Date.now();
    const now = await tag();
    if (now && now !== mine) say();
  };
  const start = () => tag().then((t) => { mine = t; at = Date.now(); });
  if (document.readyState === 'complete') start(); else addEventListener('load', start, { once: true });
  document.addEventListener('visibilitychange', check);
  setInterval(check, 60e3);
})();
