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
  // the dot goes on the Bridge section's entry in the header (the menu's More where a page has no such entry); a menu that still lists /bridge/ also says the count there
  const link = m.querySelector('.sm-p a[href="/bridge/"]'), summary = document.querySelector('.sn > a[href="/#/chains"]') || m.querySelector('summary');
  if (!summary) return;
  const mark = () => { const d = document.createElement('i'); d.className = 'bd'; d.setAttribute('aria-hidden', 'true'); d.hidden = true; return d; };
  const dot = mark(), tag = document.createElement('span');
  tag.style.cssText = 'margin-left:auto;font-size:12px;color:var(--orange,#c2410c)';
  tag.hidden = true;
  summary.append(dot);
  if (link) link.append(tag);
  const label = summary.getAttribute('aria-label') || summary.getAttribute('title') || 'More pages';
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
  setInterval(() => { if (!document.hidden) paint(); }, 30e3);
})();

(() => {
  const nav = document.querySelector('.sn');
  if (!nav || document.getElementById('act')) return;
  const start = () => import('/activity.js').then(({ activityCount, onActivity }) => {
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
    setInterval(() => { if (!document.hidden) paint(); }, 30e3);
  }).catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 2000 });
  else if (document.readyState === 'complete') setTimeout(start, 0);
  else addEventListener('load', () => setTimeout(start, 0), { once: true });
})();

(() => {
  const LIVE = true;
  let on = LIVE;
  try { const v = localStorage.getItem('tacit.help'); on = v === 'on' || (LIVE && v !== 'off'); } catch { }
  if (!on || window.top !== window.self || location.pathname.startsWith('/help')) return;
  const start = () => import('/help/widget.js').catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 2500 });
  else if (document.readyState === 'complete') setTimeout(start, 250);
  else addEventListener('load', () => setTimeout(start, 250), { once: true });
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
  // (written as JSON: build/chrome.mjs reads this table to stamp the head into the pages that are a view by their path)
  const SEC = {
    "payments": ["Pay", "Send to anyone, ask to be paid, or leave TAC for someone with no wallet yet.", [
      ["send", "Send", "/#/payments/send", ""],
      ["request", "Request", "/#/payments/request", ""],
      ["links", "Claim links", "/tac/?v=links#pool/send", ""]]],
    "defi": ["DeFi", "Swap, farm and stake, privately when you want.", [
      ["swap", "Swap", "/#/defi/swap", ""],
      ["farm", "Farm", "/farm/", "Pick a farm, put ETH in, earn TAC."],
      ["stake", "Stake", "/tac/?v=stake#private", "Stake TAC on the Tacit chain: it earns a share of every payment, with no lock."]]],
    "chains": ["Bridge", "Move money between Bitcoin and Ethereum.", [
      ["overview", "Overview", "/#/chains/overview", "Pick what you have and where it should go. Each route shows its time and fee."],
      ["bridge", "Bitcoin ⇄ Ethereum", "/#/chains/bridge", "TAC, tETH, cBTC, cUSD or USDT between the chains, both ways, with no provider fee. TAC from Bitcoin can also go fast."],
      ["btc", "BTC ⇄ ETH swap", "/btc/", "Swap Bitcoin for ETH or back, with a provider. Your ETH arrives private."],
      ["notes", "Bitcoin notes", "/tac/?v=notes#bridge", "Your TAC on Bitcoin, note by note: bring it over, merge or split it, or follow notes still moving."],
      ["fast", "Fast TAC", "/fast/", "TAC from Bitcoin in minutes, through a provider, for a quoted fee.", "bridge"]]],
    "borrow": ["Borrow", "Borrow without selling your BTC or TAC.", [
      ["btc", "Against BTC", "/vault/#btc", "Lock BTC (you keep the key), mint cBTC, borrow cUSD."],
      ["tac", "Against TAC", "/vault/", "Keep your TAC, borrow TACD or TACE. No interest; one fee when you borrow."]]],
    "rewards": ["Rewards", "Your airdrop, your points and the leaderboard.", []]
  };
  // the More page's line for each page of the menu
  const ABOUT = { '/assets/': 'TAC, tETH, cBTC, cUSD and how each is backed', '/tac/': 'the Tacit chain: stake, pay, bridge', '/trade/tac/?src=menu': 'buy and sell TAC: Ethereum pools, a Bitcoin order book', '/pay/': 'BTC, TAC and ETH paid privately from one key', '/bridge/': 'every way between Bitcoin and Ethereum', '/btc/': 'swap Bitcoin and ETH directly, either way',
    '/etch/': 'issue your own asset', '/shop/': 'addresses that start with zeros, for TAC', '/prove/': 'run a prover, send waiting settles', '/tasks/': 'small jobs paid in TAC', '/face/': 'buy TAC: the biggest buyer wins the address', '/praxis/': 'help build the key for smart contracts on Bitcoin', '/govern/': 'TAC holders signal on proposals, voting from Bitcoin or Ethereum' };
  // the mock-up's addresses for what is a page, a sheet or another address here
  const ELSE = { '#/portfolio': '/#portfolio', '#/defi/earn': '/#card=earn', '#/borrow': '/vault/', '#/borrow/btc': '/vault/#btc', '#/borrow/tac': '/vault/', '#/rewards': '/rewards/', '#/more': '/#/menu', '#/activity': '/#activity',
    '#/account': '/#wallet', '#/account/wallet': '/#wallet', '#/account/addresses': '/#bitcoin/receive', '#/account/proofs': '/#prove-self' };
  const TAC_VIEW = { links: 'payments', stake: 'defi', notes: 'chains' };
  const HREF = { portfolio: '/#portfolio', payments: '/#/payments', defi: '/#/defi', chains: '/#/chains', borrow: '/vault/', rewards: '/rewards/', menu: '/#/menu' };
  const main = document.querySelector('main');
  if (!main || !document.querySelector('.sn')) return;
  const front = () => location.pathname === '/' || location.pathname === '/index.html';
  let whole = false;
  const at = () => {
    const p = location.pathname, h = location.hash;
    if (front()) { const m = /^#\/(payments|defi|chains)(?:\/([a-z]*))?$/.exec(h); return m ? [m[1], SEC[m[1]][2].some((v) => v[0] === m[2]) ? m[2] : SEC[m[1]][2][0][0]] : h === '#/menu' ? ['menu', ''] : null; }
    if (/^\/tac\/?$/.test(p)) { const v = new URLSearchParams(location.search).get('v'); return v && Object.hasOwn(TAC_VIEW, v) ? [TAC_VIEW[v], v] : null; }
    if (p.startsWith('/farm/')) return ['defi', 'farm'];
    if (p.startsWith('/fast/')) return ['chains', 'fast'];
    if (p.startsWith('/btc/')) return ['chains', 'btc'];
    if (h === '#pools') whole = true; else if (h === '#btc') whole = false;      // (the page takes #pools off the address once it has shown them: they stay the whole page's until a side is asked for)
    if (p.startsWith('/vault/')) return whole ? null : ['borrow', h === '#btc' ? 'btc' : 'tac'];      // where TACD sells (linked from other pages) is the whole page's: the view of TAC's side leaves it out
    if (p.startsWith('/rewards/')) return ['rewards', ''];
    return null;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // the view's own address: false when it is another page's (that page is loading in this one's place), and the address made the view's own when
  // it named a view the section lacks or none (/#/defi is /#/defi/swap), without a step in the history
  const home = (a, nav) => {
    // TAC's page cut to a view reads its form from the address's part after #: one that came without it (a bookmark of the address the page had
    // rewritten, back or forward to it) gets the view's own, before the page reads it. Only on arriving: the page's own changes of address are its own.
    if (nav && a && !front() && !location.hash && /^\/tac\/?$/.test(location.pathname)) {
      const own = new URL(SEC[a[0]][2].find((v) => v[0] === a[1])[2], location.href).hash;
      if (own) history.replaceState(history.state, '', location.pathname + location.search + own);
    }
    if (!a || a[0] === 'menu' || !front()) return true;
    const href = SEC[a[0]][2].find((v) => v[0] === a[1])[2], u = new URL(href, location.href), v = u.searchParams.get('v');
    if (u.pathname !== '/' || (v && new URLSearchParams(location.search).get('v') !== v)) { location.replace(href); return false; }
    if (u.hash !== location.hash) history.replaceState(history.state, '', location.pathname + location.search + u.hash);
    return true;
  };
  // A view opens the folds its page keeps shut that the view is for: the fast bridge's provider panel. At once, so it is open at the first paint;
  // once only, so a fold the holder shuts stays shut. The page's script fills a fold when it is told it opened, and may not have been listening
  // yet: once the page has loaded it is told again (each filler leaves a fold it has filled alone).
  const FOLDS = {};
  const folds = (key) => {
    const mine = [];
    for (const id of FOLDS[key] || []) { const d = document.getElementById(id); if (d && !d.dataset.secOpen) { d.dataset.secOpen = '1'; if (!d.open) { d.open = true; mine.push(d); } } }
    const tell = () => { for (const d of mine) if (d.open) d.dispatchEvent(new Event('toggle')); };
    if (mine.length && document.readyState !== 'complete') addEventListener('load', tell, { once: true });
  };
  let head = document.getElementById('sec-head'), shown = null, first = true;      // (the head the build stamped into a page that is a view by its path)
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // the pill under the current tab: put there at once, or slid there when the tabs were already on screen
  const place = (slide) => {
    const nav = head?.querySelector('.sh-t'), on = nav?.querySelector('a[aria-current="page"]'), ind = nav?.querySelector('.sh-i');
    if (!on || !ind || !on.offsetWidth) return;
    if (!slide) ind.style.transition = 'none';
    ind.style.width = on.offsetWidth + 'px'; ind.style.transform = `translateX(${on.offsetLeft}px)`;
    nav.classList.add('pill');
    // a row that scrolls (Bridge's, on a phone) keeps the current tab in sight
    if (nav.scrollWidth > nav.clientWidth) { const l = on.offsetLeft, r = l + on.offsetWidth; if (l < nav.scrollLeft || r > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = Math.max(0, l - 16); }
    if (!slide) { ind.offsetWidth; ind.style.transition = ''; }
  };
  addEventListener('resize', () => place(false));
  let pressed = false;      // a tab of the head was just pressed (so focus stays on the tabs through the change of view)
  document.addEventListener('click', (e) => { if (e.target.closest?.('#sec-head .sh-t a')) { pressed = true; setTimeout(() => { pressed = false; }, 400); } }, true);
  document.fonts?.ready.then(() => place(false));
  const sync = (nav = false) => {
    if (front() && ELSE[location.hash]) { location.replace(ELSE[location.hash]); return; }
    const a = at();
    if (!home(a, nav)) return;
    const key = a ? a.join('/') : '';
    if (key === shown) return;
    shown = key;
    if (!first && a && scrollY > 0) scrollTo(0, 0);      // another view starts at its head
    const root = document.documentElement;
    if (a) root.dataset.sec = key; else delete root.dataset.sec;
    document.dispatchEvent(new CustomEvent('tacit:sec', { detail: key }));
    folds(key);
    // the section's entry, in the header and in the bar; a page that is not a view of one keeps what the build marked
    if (a || document.querySelector('.sn > a[data-sec-on], .bn a[data-sec-on]')) for (const l of document.querySelectorAll('.sn > a, .bn a')) {
      const on = !!a && l.getAttribute('href') === HREF[a[0] === 'menu' ? 'menu' : a[0]];
      if (on) { l.setAttribute('aria-current', 'page'); l.dataset.secOn = '1'; } else if (l.dataset.secOn) { l.removeAttribute('aria-current'); delete l.dataset.secOn; }
    }
    if (!a) { head?.remove(); head = null; return; }
    if (!head) { head = document.createElement('div'); head.className = 'sh'; head.id = 'sec-head'; }
    head.classList.toggle('sh-l', a[0] === 'menu');
    let slid = false;
    if (a[0] === 'menu') {
      const glyph = (href) => document.querySelector(`.sm-p a[href="${href}"] svg`)?.outerHTML || '<svg viewBox="0 0 24 24" aria-hidden="true"></svg>';
      const row = (href, name, line) => `<li><a href="${esc(href)}">${glyph(href)}<b>${esc(name)}</b>${line ? `<small>${esc(line)}</small>` : ''}<i aria-hidden="true">→</i></a></li>`;
      const rest = [...document.querySelectorAll('.sm-p a:not(.pr)')].map((l) => row(l.getAttribute('href'), [...l.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim(), ABOUT[l.getAttribute('href')] || ''));      // the name, not a count appended to it
      head.innerHTML = `<h1 tabindex="-1">More</h1><ul class="sh-more">${row('/vault/', 'Borrow', 'against BTC or TAC')}${row('/rewards/', 'Rewards', 'airdrop, points, leaderboard')}${rest.join('')}</ul>`;
      head.dataset.of = 'menu';
    } else {
      // a view with a fifth entry has no tab of its own (/fast/ is a way of the bridge): it lights the tab it names
      const [name, line, views] = SEC[a[0]], note = views.find((v) => v[0] === a[1])?.[3] || '', lit = views.find((v) => v[0] === a[1])?.[4] || a[1], tabs = views.filter((v) => !v[4]);
      if (head.dataset.of === a[0] && head.isConnected) {
        // another view of the same section, in the same document (or the head the build stamped): the head stays, so the tab pressed keeps focus
        // and nothing under it moves; only what differs changes
        for (const l of head.querySelectorAll('.sh-t a')) { if (l.dataset.v === lit) l.setAttribute('aria-current', 'page'); else l.removeAttribute('aria-current'); }
        place(!first); slid = true;
        if (pressed && !head.contains(document.activeElement)) head.querySelector('.sh-t a[aria-current="page"]')?.focus({ preventScroll: true });      // the page it opened took focus for its own heading: the tab pressed keeps it
        const n = head.querySelector('.sh-n');
        if (n && n.textContent !== note) { n.textContent = note; if (!first && !calm()) n.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease' }); }
      } else {
        // (the vault's two views are its two sides: a tab marked data-side is turned by the page's own switch, vault/app.js, with no reload)
        head.innerHTML = `<h1 tabindex="-1">${esc(name)}</h1><p>${esc(line)}</p>${tabs.length > 1 ? `<nav class="sh-t" aria-label="${esc(name)}"><i class="sh-i" aria-hidden="true"></i>${tabs.map(([k, label, href]) => `<a href="${esc(href)}" data-v="${k}"${a[0] === 'borrow' ? ` data-side="${k}"` : ''}${k === lit ? ' aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</nav>` : ''}${views.length ? `<p class="sh-n">${esc(note)}</p>` : ''}`;
        head.dataset.of = a[0];
      }
    }
    if (head.parentNode !== main || main.firstElementChild !== head) main.prepend(head);
    if (!slid) place(false);
  };
  sync(true); first = false;
  addEventListener('hashchange', () => sync(true)); addEventListener('popstate', () => sync(true));
  // the front page and TAC's page change the address without leaving the document
  for (const k of ['pushState', 'replaceState']) { const was = history[k]; history[k] = function (...args) { const r = was.apply(this, args); queueMicrotask(sync); return r; }; }
})();

// The glyph layer (glyphs.js), drawn once the page is idle. A page works the same without it, and a failure to load it is ignored.
(() => {
  (window.requestIdleCallback || setTimeout)(() => import('/glyphs.js').then((g) => g.start(), () => {}));
})();
