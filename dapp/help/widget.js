// The help desk's launcher: a round button at the bottom right of a page, and the help page (/help/) opened in a panel above it (a sheet on a phone).
// chrome.js loads this only where the launcher is switched on, and the panel's page is fetched only when someone first opens it, so a page that
// never opens it never contacts the help desk. The panel is the same page as /help/, framed: one place for the logic, and a page's own security policy
// needs nothing beyond framing its own origin.
//
//   window.tacitHelp.open() / .close()      for a link or a button that wants to show it
//
// The panel is not modal: the page behind it stays usable. Escape closes it (also from inside the frame, which asks by message), and the
// launcher gets the focus back.

const CSS = `
.hw { position: fixed; z-index: 800; right: max(16px, env(safe-area-inset-right)); bottom: max(16px, env(safe-area-inset-bottom)); font: 13px/1.5 var(--mono, ui-monospace, monospace); letter-spacing: -.01em; }
.hw[hidden], .hw [hidden] { display: none !important; }
.hw-b { display: grid; place-items: center; width: 48px; height: 48px; padding: 0; cursor: pointer; border-radius: 50%; border: 1px solid var(--ink, #1a1a1a); color: var(--card, #f2ebd4); background: var(--ink, #1a1a1a);
  box-shadow: 0 10px 24px -12px rgba(0, 0, 0, .55); -webkit-tap-highlight-color: transparent; transition: transform .2s var(--spring, ease); }
.hw-b svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
@media (hover: hover) { .hw-b:hover { transform: scale(1.06); } }
.hw-b:focus-visible, .hw-x:focus-visible { outline: 2px solid var(--ink, #1a1a1a); outline-offset: 3px; }
.hw-p { position: absolute; z-index: 2; right: 0; bottom: 60px; display: flex; flex-direction: column; box-sizing: border-box; width: min(390px, calc(100vw - 32px)); height: min(580px, calc(100vh - 110px)); overflow: hidden;
  color: var(--ink, #1a1a1a); background: var(--card, #f2ebd4); border: 1px solid var(--ink, #1a1a1a); box-shadow: 0 30px 70px -30px rgba(0, 0, 0, .6); }
@supports (height: 100dvh) { .hw-p { height: min(580px, calc(100dvh - 110px)); } }
.hw-h { display: flex; align-items: center; justify-content: space-between; flex: none; padding: 6px 6px 6px 16px; border-bottom: 1px solid var(--hair-2, rgba(26, 26, 26, .28)); }
.hw-t { font: 400 22px/1 var(--serif, Georgia, serif); letter-spacing: -.01em; }
.hw-t em { font-style: italic; }
.hw-x { display: grid; place-items: center; width: 40px; height: 40px; padding: 0; cursor: pointer; font: 400 26px/1 var(--mono, monospace); color: var(--mute, #625c4f); background: none; border: 0; }
.hw-x:hover { color: var(--ink, #1a1a1a); }
.hw-f { margin: 0; padding: 18px 16px; font-size: 12.5px; color: var(--mute, #625c4f); }
.hw-f a { color: var(--ink, #1a1a1a); }
.hw-p iframe { flex: 1; width: 100%; min-height: 0; border: 0; background: transparent; color-scheme: normal; }
@media (max-width: 560px) {
  .hw-p { position: fixed; left: 0; right: 0; bottom: 0; width: auto; height: min(84vh, 680px); border-width: 1px 0 0; }
  @supports (height: 100dvh) { .hw-p { height: min(84dvh, 680px); } }
}
@media print { .hw { display: none; } }
`;

const BUBBLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.7 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/></svg>';

const doc = document;
if (!doc.getElementById('hw')) {
  const el = (tag, cls, attrs = {}) => { const e = doc.createElement(tag); if (cls) e.className = cls; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const style = el('style'); style.textContent = CSS; doc.head.append(style);

  const root = el('div', 'hw', { id: 'hw' });
  const panel = el('section', 'hw-p', { id: 'hw-p', role: 'dialog', 'aria-label': 'Help' }); panel.hidden = true;
  const head = el('header', 'hw-h');
  const title = el('span', 'hw-t'); title.append('tacit ', Object.assign(doc.createElement('em'), { textContent: 'help' }));
  const x = el('button', 'hw-x', { type: 'button', 'aria-label': 'Close help' }); x.textContent = '×';
  head.append(title, x); panel.append(head);
  const btn = el('button', 'hw-b', { type: 'button', 'aria-label': 'Help', 'aria-expanded': 'false', 'aria-controls': 'hw-p' }); btn.innerHTML = BUBBLE;
  root.append(panel, btn);

  let frame = null, broken = false;
  const input = () => { try { return frame?.contentDocument?.getElementById('q') || null; } catch { return null; } };   // the frame is this origin
  const isOpen = () => !panel.hidden;
  // A page that cannot be framed (a header or a security policy refuses it) leaves a dead box: say so, and offer the page on its own.
  function fallback() {
    if (broken) return;
    broken = true; frame?.remove(); frame = null;
    const a = el('a', '', { href: '/help/', target: '_blank', rel: 'noopener' }); a.textContent = 'Open the help page';
    const p = el('p', 'hw-f'); p.append('The help desk could not be shown here. ', a, '.'); panel.append(p);
  }
  function open() {
    if (isOpen()) return;
    if (!frame && !broken) {
      frame = el('iframe', '', { title: 'Help desk', src: '/help/' });
      const mine = frame;
      // the frame is ours to read only if it loaded the help page: a refused frame shows an error page we cannot see into
      const check = () => { if (frame === mine && !input()) fallback(); };
      frame.addEventListener('load', () => { if (frame !== mine) return; if (!input()) return fallback(); if (isOpen()) input()?.focus(); });
      setTimeout(check, 8000);
      panel.append(frame);
    }
    panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
    input()?.focus();   // already loaded when it was opened before; a first open focuses it on load
  }
  function close() {
    if (!isOpen()) return;
    const had = panel.contains(doc.activeElement);
    panel.hidden = true; btn.setAttribute('aria-expanded', 'false');
    if (had || doc.activeElement === doc.body) btn.focus();
  }
  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  x.addEventListener('click', close);
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  addEventListener('message', (e) => { if (e.origin === location.origin && e.source === frame?.contentWindow && e.data === 'tacit-help-close') close(); });

  (doc.body || doc.documentElement).append(root);
  window.tacitHelp = { open, close };
}
