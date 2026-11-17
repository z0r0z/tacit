(() => {
  const m = document.querySelector('.sm');
  if (!m) return;
  const shut = () => { m.open = false; };
  document.addEventListener('click', (e) => { if (m.open && !m.contains(e.target)) shut(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.open) { shut(); m.querySelector('summary').focus(); } });
  m.addEventListener('focusout', (e) => { if (e.relatedTarget && !m.contains(e.relatedTarget)) shut(); });
  m.addEventListener('click', (e) => { if (e.target.closest('.sm-p a')) shut(); });
})();

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

(() => {
  const LIVE = true;
  let on = LIVE;
  try { const v = localStorage.getItem('tacit.help'); on = v === 'on' || (LIVE && v !== 'off'); } catch { }
  if (!on || window.top !== window.self || location.pathname.startsWith('/help')) return;
  import('/help/widget.js').catch(() => {});
})();

(() => {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  if (navigator.webdriver && !window.__tacitSw) return;
  const register = () => setTimeout(() => navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}), 1500);
  if (document.readyState === 'complete') register(); else addEventListener('load', register, { once: true });
})();

(() => {
  if (!/^https?:$/.test(location.protocol) || typeof fetch !== 'function') return;
  if (navigator.webdriver && !window.__tacitUpd) return;
  const EVERY = 10 * 60e3;
  let mine = null, at = 0, said = false;
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

// The sections' heads. A page that is a view of a section (the front page's card held to one thing, a part of TAC's page, the farm, the fast bridge,
// borrowing, rewards) gets the section's name and line over it, and the section's views as tabs, so the six sections of the header each read as
// one place however many pages they are made of. Which view a page is, is read from its address alone: the front page's #/section/view, TAC's page's
// ?v=, and a page's own path. <html data-sec="section/view"> says it to the stylesheets, which put each page's own heading out of the way, and the
// header's and the bar's entry for the section is marked. /#/menu is the More page: the sections a phone's bar has no room for, and the menu's pages.
// This is the one place the address is read for a section: the front page holds its card to the view it finds on <html data-sec> (and is told of a
// change by a `tacit:sec` event on the document), so the two cannot disagree. Each view lives at one address (its href in SEC): an address on the
// front page that names a view another page shows goes there, and one that names a view the section does not have is put right, to its first view.
(() => {
  const SEC = {
    payments: ['Payments', 'Send to anyone, ask to be paid, or leave TAC for someone with no wallet yet.', [['send', 'Send', '/#/payments/send'], ['request', 'Request', '/tac/?v=request#receive'], ['links', 'Claim links', '/tac/?v=links#pool/send']]],
    defi: ['DeFi', 'Swap, farm and stake, privately when you want.', [['swap', 'Swap', '/#/defi/swap'], ['farm', 'Farm', '/farm/'], ['stake', 'Stake', '/tac/?v=stake#private']]],
    chains: ['Chains', 'Move your money: wallet ↔ private, Ethereum ↔ Tacit chain, Bitcoin ↔ Ethereum.', [['move', 'Move', '/#/chains/move'], ['bridge', 'Bridge', '/#/chains/bridge'], ['fast', 'Fast bridge', '/fast/'], ['notes', 'Notes', '/tac/?v=notes#bridge']]],
    borrow: ['Borrow', 'Borrow dollars against your BTC or your TAC.', [['btc', 'Against BTC', '/vault/#btc'], ['tac', 'Against TAC', '/vault/']]],
    rewards: ['Rewards', 'Your airdrop, your points and the leaderboard.', []],
  };
  const TAC_VIEW = { request: 'payments', links: 'payments', stake: 'defi', notes: 'chains' };
  const HREF = { portfolio: '/#portfolio', payments: '/#/payments', defi: '/#/defi', chains: '/#/chains', borrow: '/vault/', rewards: '/rewards/', menu: '/#/menu' };
  const main = document.querySelector('main');
  if (!main || !document.querySelector('.sn')) return;
  const front = () => location.pathname === '/' || location.pathname === '/index.html';
  const at = () => {
    const p = location.pathname, h = location.hash;
    if (front()) { const m = /^#\/(payments|defi|chains)(?:\/([a-z]*))?$/.exec(h); return m ? [m[1], SEC[m[1]][2].some((v) => v[0] === m[2]) ? m[2] : SEC[m[1]][2][0][0]] : h === '#/menu' ? ['menu', ''] : null; }
    if (/^\/tac\/?$/.test(p)) { const v = new URLSearchParams(location.search).get('v'); return TAC_VIEW[v] ? [TAC_VIEW[v], v] : null; }
    if (p.startsWith('/farm/')) return ['defi', 'farm'];
    if (p.startsWith('/fast/')) return ['chains', 'fast'];
    if (p.startsWith('/vault/')) return ['borrow', h === '#btc' ? 'btc' : 'tac'];
    if (p.startsWith('/rewards/')) return ['rewards', ''];
    return null;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // the view's own address: false when it is another page's (that page is loading in this one's place), and the address made the view's own when
  // it named a view the section lacks or none (/#/defi is /#/defi/swap), without a step in the history
  const home = (a) => {
    if (!a || a[0] === 'menu' || !front()) return true;
    const href = SEC[a[0]][2].find((v) => v[0] === a[1])[2], u = new URL(href, location.href), v = u.searchParams.get('v');
    if (u.pathname !== '/' || (v && new URLSearchParams(location.search).get('v') !== v)) { location.replace(href); return false; }
    if (u.hash !== location.hash) history.replaceState(history.state, '', location.pathname + location.search + u.hash);
    return true;
  };
  let head = null, shown = '';
  const sync = () => {
    const a = at();
    if (!home(a)) return;
    const key = a ? a.join('/') : '';
    if (key === shown) return;
    shown = key;
    const root = document.documentElement;
    if (a) root.dataset.sec = key; else delete root.dataset.sec;
    document.dispatchEvent(new CustomEvent('tacit:sec', { detail: key }));
    // the section's entry, in the header and in the bar; a page that is not a view of one keeps what the build marked
    if (a || document.querySelector('.sn > a[data-sec-on], .bn a[data-sec-on]')) for (const l of document.querySelectorAll('.sn > a, .bn a')) {
      const on = !!a && l.getAttribute('href') === HREF[a[0] === 'menu' ? 'menu' : a[0]];
      if (on) { l.setAttribute('aria-current', 'page'); l.dataset.secOn = '1'; } else if (l.dataset.secOn) { l.removeAttribute('aria-current'); delete l.dataset.secOn; }
    }
    if (!a) { head?.remove(); head = null; return; }
    if (!head) { head = document.createElement('div'); head.className = 'sh'; head.id = 'sec-head'; }
    if (a[0] === 'menu') {
      const row = (href, name, line) => `<li><a href="${esc(href)}"><b>${esc(name)}</b>${line ? `<small>${esc(line)}</small>` : ''}<i aria-hidden="true">→</i></a></li>`;
      const rest = [...document.querySelectorAll('.sm-p a:not(.pr)')].map((l) => row(l.getAttribute('href'), l.textContent.trim(), ''));
      head.innerHTML = `<h1 tabindex="-1">More</h1><ul class="sh-more">${row('/vault/', 'Borrow', 'against BTC or TAC')}${row('/rewards/', 'Rewards', 'airdrop, points, leaderboard')}${rest.join('')}</ul>`;
    } else {
      const [name, line, views] = SEC[a[0]];
      head.innerHTML = `<h1 tabindex="-1">${esc(name)}</h1><p>${esc(line)}</p>${views.length > 1 ? `<nav class="sh-t" aria-label="${esc(name)}">${views.map(([k, label, href]) => `<a href="${esc(href)}"${k === a[1] ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav>` : ''}`;
    }
    if (head.parentNode !== main || main.firstElementChild !== head) main.prepend(head);
  };
  sync();
  addEventListener('hashchange', sync); addEventListener('popstate', sync);
  // the front page and TAC's page change the address without leaving the document
  for (const k of ['pushState', 'replaceState']) { const was = history[k]; history[k] = function (...args) { const r = was.apply(this, args); queueMicrotask(sync); return r; }; }
})();

// The skins. skin.js put the one in use on <html data-skin>; here the switch beside the menu shows it (on is Graphite, the default), a press
// turns it at once and keeps the choice on this device, and another tab's change is followed. Graphite's glyph layer (glyphs.js) is drawn
// while that skin is on, once the page is idle, and taken away when it is not; nothing is reloaded, so an open key stays open.
(() => {
  const root = document.documentElement, KEY = 'tacit-skin';
  let stop = null, loading = false;
  const graphite = () => root.dataset.skin !== 'classic';
  const glyphs = () => {
    if (!graphite() && stop) { stop(); stop = null; }
    if (graphite() && !stop && !loading) {
      loading = true;
      import('/glyphs.js').then((g) => { loading = false; if (graphite() && !stop) stop = g.start(); }, () => { loading = false; });
    }
  };
  const mark = () => { for (const b of document.querySelectorAll('.skt')) { b.setAttribute('aria-checked', String(graphite())); b.title = graphite() ? 'Graphite look (turn off for Classic)' : 'Classic look (turn on for Graphite)'; } };
  const use = (skin, keep) => {
    skin = skin === 'classic' ? 'classic' : 'graphite';
    if (keep) try { localStorage.setItem(KEY, skin); } catch {}
    if (root.dataset.skin !== skin) { root.dataset.skin = skin; glyphs(); }
    mark();
  };
  document.addEventListener('click', (e) => { if (e.target.closest?.('.skt')) use(graphite() ? 'classic' : 'graphite', true); });
  addEventListener('storage', (e) => { if (e.key === KEY) use(e.newValue, false); });
  if (!root.dataset.skin) { let skin = 'graphite'; try { if (localStorage.getItem(KEY) === 'classic') skin = 'classic'; } catch {} root.dataset.skin = skin; }
  mark();
  (window.requestIdleCallback || setTimeout)(glyphs);
})();
