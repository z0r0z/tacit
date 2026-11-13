// A sheet over a page: a title with a close button over a body, closed by its button, by Escape or by a press outside it. The Bitcoin market
// module's own confirmations are fixed layers at z-index 1005, so a wide sheet sits below them and the small dialogs (sign-in, wallet picker,
// pairing, confirm) above them.
//
// The look of a sheet is written once, here, and worn by every page that opens one: it is the front page's (`dialog.sheet`, `.opt`, `.way` in
// index.html), so the wallet sheet reads the same wherever it opens. A page keeps its own tokens (--ink --mute --card --field --hair --hair-2
// --scrim --serif --mono --err --ok) and what is only its own (the market's wide sheet); it does not restyle the sheet.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
.bsheet { position: fixed; inset: 0; z-index: 900; display: grid; grid-template-columns: minmax(0, 1fr); place-items: start center; padding: 16px; overflow: auto; overflow-x: hidden; overscroll-behavior: contain; background: var(--scrim); backdrop-filter: blur(2px); }
.bsheet.top { z-index: 1100; place-items: center; }
.bsheet [hidden] { display: none !important; }
.bsheet-in { --sx: 24px; --st: 24px; min-width: 0; width: min(560px, 100%); padding: var(--st) var(--sx) 28px; color: var(--ink); background: var(--card); border: 1px solid var(--hair-2); border-radius: 18px; box-shadow: var(--float, var(--sheet-shadow)); text-align: left; animation: bsheet-rise .22s cubic-bezier(.2, .8, .2, 1); }
@keyframes bsheet-rise { from { opacity: 0; transform: translateY(14px); } }
.bsheet-head { display: flex; align-items: center; gap: 14px; position: sticky; top: 0; z-index: 4; margin: calc(-1 * var(--st)) calc(-1 * var(--sx)) 8px; padding: var(--st) var(--sx) 14px; border-radius: 17px 17px 0 0; background: var(--card); }
@supports (animation-timeline: scroll()) {
  .bsheet-head { animation: bsheet-line linear both; animation-timeline: scroll(nearest); animation-range: 0 16px; }
  @keyframes bsheet-line { to { box-shadow: 0 1px 0 var(--hair); } }
}
.bsheet-head h2 { font: 400 32px/1 var(--serif); letter-spacing: -.01em; margin: 0; text-transform: none; color: var(--ink); }
.bsheet-head h2:focus { outline: none; }
.bsheet .x { margin-left: auto; width: var(--tap, 44px); height: var(--tap, 44px); display: grid; place-items: center; padding: 0; font: inherit; font-size: 22px; line-height: 1; background: none; border: 0; border-radius: 12px; cursor: pointer; color: var(--mute); transition: color .15s, background-color .15s; }
@media (hover: hover) { .bsheet .x:hover { color: var(--ink); background: var(--hair); } }
.bsheet.wide .bsheet-head h2 { font-size: 28px; }
@media (max-width: 640px) {
  .bsheet { padding: 0; place-items: end center; }
  .bsheet-in { --sx: 16px; --st: 20px; width: 100%; padding-bottom: calc(24px + env(safe-area-inset-bottom)); border-width: 1px 0 0; border-radius: 18px 18px 0 0; }
}
@media (prefers-reduced-motion: reduce) { .bsheet-in { animation: none; } .bsheet-head { animation: none; } }

.bsheet .kv { display: flex; grid-template-columns: none; justify-content: space-between; gap: 12px; margin: 0; font-size: 12.5px; color: var(--mute); padding: 5px 0; }
.bsheet .kv b { font-weight: 400; color: var(--ink); text-align: right; overflow-wrap: anywhere; }
.bsheet .note, .bsheet .lede-s { font-size: 12.5px; color: var(--mute); margin: 0 0 12px; }
.bsheet .note.err { color: var(--err); }
.bsheet .opts .note.wait { text-align: center; color: var(--ink); }
.bsheet .linkbtn { padding: 0; font: 12px var(--mono); color: var(--mute); background: none; border: 0; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.bsheet .linkbtn:hover { color: var(--ink); }
.bsheet-actions { display: grid; grid-auto-flow: column; gap: 10px; }
.bsheet-actions .btn { margin-top: 0; }
.bsheet .btn { border-radius: 14px; }
.wc-qr { margin: 0 auto 14px; width: 224px; padding: 10px; background: #fff; border-radius: 8px; }
.wc-qr svg { display: block; width: 100%; height: auto; }
.addr-s { font-size: 11.5px; overflow-wrap: anywhere; }

/* Which wallet signs: the front page's list, an icon and a name on each row */
.bsheet .picker { display: grid; gap: 8px; }
.bsheet .picker .way { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 8px 14px; font: inherit; color: var(--ink); text-align: left; background: var(--field); border: 1px solid var(--hair-2); border-radius: 14px; cursor: pointer; transition: border-color .15s; }
@media (hover: hover) { .bsheet .picker .way:hover { border-color: var(--ink); } }
.bsheet .picker .way-t { display: flex; align-items: center; gap: 12px; }
.bsheet .picker img { width: 28px; height: 28px; }

/* The ways in: a row for each Tacit wallet this browser has opened, the others as tiles, then the links */
.bsheet .tk { display: block; flex: none; width: 22px; height: 22px; border-radius: 50%; }
.bsheet .lede-s { font-size: 13px; margin: 0 0 14px; }
.bsheet .lbl { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--mute); margin: 14px 0 6px; }
.bsheet .link { padding: 0; font: inherit; font-size: 13px; color: var(--mute); background: none; border: 0; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
@media (hover: hover) { .bsheet .link:hover { color: var(--ink); } }
.bsheet .opts { display: grid; gap: 8px; margin-top: 4px; }
.bsheet .opts > .lbl { margin: 10px 0 -2px; }
.bsheet .opts > .lbl:first-child { margin-top: 0; }
.bsheet .opts .note { font-size: 13px; margin: 12px 0 0; }
.bsheet .opts .lbl + .note { margin: 0 0 10px; }
.bsheet .opt { display: grid; gap: 3px; width: 100%; padding: 12px 14px; font: inherit; color: var(--ink); text-align: left; cursor: pointer; background: var(--field); border: 1px solid var(--hair-2); border-radius: 16px; transition: border-color .15s, opacity .2s; }
@media (hover: hover) { .bsheet .opt:hover:not(:disabled) { border-color: var(--ink); } }
.bsheet .opt:disabled { opacity: .5; cursor: progress; }
.bsheet .opt.main { border-color: var(--ink); background: var(--card); }
.bsheet .opt-t { display: flex; align-items: center; gap: 10px; font-weight: 500; }
.bsheet .opt-t b { font-weight: 500; }
.bsheet .opt-m { font-size: 12px; color: var(--mute); padding-left: 32px; }
.bsheet .opt.mine .opt-t .num { font: 500 14px var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -.01em; overflow-wrap: anywhere; }
.bsheet .opt.mine .opt-t::after { content: '→'; margin-left: auto; padding-left: 8px; color: var(--mute); transition: transform .15s cubic-bezier(.2, .8, .2, 1); }
@media (hover: hover) { .bsheet .opt.mine:hover:not(:disabled) .opt-t::after { color: var(--ink); transform: translateX(3px); } }
.bsheet .opt.mine .opt-m { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; }
.bsheet .opt.mine .opt-m .tk { width: 14px; height: 14px; }
.bsheet .nw { white-space: nowrap; }
.bsheet .wl-on { display: inline-flex; align-items: center; gap: 5px; color: var(--ok); }
.bsheet .wl-on::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.bsheet .ways { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 8px; }
.bsheet .ways .way { display: flex; flex-direction: column; align-items: center; gap: 7px; min-height: 76px; padding: 13px 6px 11px; font: inherit; font-size: 13px; color: var(--ink); background: var(--field); border: 1px solid var(--hair-2); border-radius: 14px; cursor: pointer; transition: border-color .15s, opacity .2s; }
.bsheet .ways .way .tk { width: 24px; height: 24px; }
@media (hover: hover) { .bsheet .ways .way:hover:not(:disabled) { border-color: var(--ink); } }
.bsheet .ways .way:disabled { opacity: .5; cursor: progress; }
.bsheet .opt[aria-busy="true"], .bsheet .ways .way[aria-busy="true"] { opacity: 1; border-color: var(--ink); }
.bsheet .opt[aria-busy="true"] .opt-t::after, .bsheet .opt.mine[aria-busy="true"] .opt-t::after { content: ''; box-sizing: border-box; flex: none; width: 14px; height: 14px; margin-left: auto; padding: 0; border: 1.5px solid var(--hair-2); border-top-color: var(--ink); border-radius: 50%; transform: none; transition: none; animation: bsheet-spin .7s linear infinite; }
.bsheet .ways .way[aria-busy="true"] .tk { animation: bsheet-pulse 1.1s ease-in-out infinite; }
@keyframes bsheet-spin { to { transform: rotate(360deg); } }
@keyframes bsheet-pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .bsheet .opt[aria-busy="true"] .opt-t::after { animation-duration: 1.8s; } .bsheet .ways .way[aria-busy="true"] .tk { animation: none; } }
.bsheet .more { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 18px; margin: 6px 0 0; }
.bsheet .amt { display: flex; align-items: center; margin-top: 8px; background: var(--field); border: 1px solid var(--hair); border-radius: 14px; transition: border-color .15s; }
.bsheet .amt:focus-within { border-color: var(--ink); }
.bsheet .amt input { flex: 1; min-width: 0; font: 400 14px/1.4 var(--mono); letter-spacing: -.02em; color: var(--ink); background: none; border: 0; padding: 14px; outline: none; }
.bsheet .amt .link { flex: none; padding: 0 14px; align-self: stretch; }
`;

// The wallet's marks, as the front page draws them: the Tacit wallet, Ethereum, Bitcoin and a key (a passkey or a saved key). Under ids of their own, so a page
// that has a mark of the same name keeps it.
const MARKS = {
  tac: '<circle cx="16" cy="16" r="16" fill="#0a0a0a"/><circle cx="16" cy="16" r="13" fill="none" stroke="#f4efe6" stroke-width="2.5"/><path d="M17.5 7L13 22.5Q13 25 18 24" fill="none" stroke="#f7931a" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 11L21 11" stroke="#f7931a" stroke-width="2.4" stroke-linecap="round"/>',
  eth: '<circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="#FFF"><path fill-opacity=".602" d="M16.498 4v8.87l7.497 3.35z"/><path d="M16.498 4L9 16.22l7.498-3.35z"/><path fill-opacity=".602" d="M16.498 21.968v6.027L24 17.616z"/><path d="M16.498 27.995v-6.028L9 17.616z"/><path fill-opacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z"/><path fill-opacity=".602" d="M9 16.22l7.498 4.353v-7.701z"/></g>',
  btc: '<circle cx="16" cy="16" r="16" fill="#F7931A"/><path fill="#FFF" d="M23.189 14.02c.314-2.096-1.283-3.223-3.465-3.975l.708-2.84-1.728-.43-.69 2.765c-.454-.114-.92-.22-1.385-.326l.695-2.783L15.596 6l-.708 2.839c-.376-.086-.746-.17-1.104-.26l.002-.009-2.384-.595-.46 1.846s1.283.294 1.256.312c.7.175.826.638.805 1.006l-.806 3.235c.048.012.11.03.18.057l-.183-.045-1.13 4.532c-.086.212-.303.531-.793.41.018.025-1.256-.313-1.256-.313l-.858 1.978 2.25.561c.418.105.828.215 1.231.318l-.715 2.872 1.727.43.708-2.84c.472.127.93.245 1.378.357l-.706 2.828 1.728.43.715-2.866c2.948.558 5.164.333 6.097-2.333.752-2.146-.037-3.385-1.588-4.192 1.13-.26 1.98-1.003 2.207-2.538zm-3.95 5.538c-.533 2.147-4.148.986-5.32.695l.95-3.805c1.172.293 4.929.872 4.37 3.11zm.535-5.569c-.487 1.953-3.495.96-4.47.717l.86-3.45c.975.243 4.118.696 3.61 2.733z"/>',
  key: '<circle cx="16" cy="16" r="16" fill="#0a0a0a"/><circle cx="12" cy="16" r="4.3" fill="none" stroke="#f4efe6" stroke-width="2.3"/><path d="M16.3 16H25.5M22.4 16v3.4M25.5 16v2.6" fill="none" stroke="#f7931a" stroke-width="2.3" stroke-linecap="round"/>',
};
// `<svg class="tk">` for one of them: `mark('eth')`. The styles and the marks are put in the page the first time a sheet or a mark is asked for.
export function mark(name) {
  wear();
  return `<svg class="tk" aria-hidden="true"><use href="#bsheet-${name}"/></svg>`;
}

function wear() {
  if (document.getElementById('bsheet-css')) return;
  const css = document.createElement('style');
  css.id = 'bsheet-css';
  css.textContent = CSS;
  document.head.append(css);
  const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sprite.id = 'bsheet-marks';
  sprite.setAttribute('width', '0'); sprite.setAttribute('height', '0'); sprite.setAttribute('aria-hidden', 'true'); sprite.setAttribute('focusable', 'false');
  sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  sprite.innerHTML = Object.entries(MARKS).map(([k, v]) => `<symbol id="bsheet-${k}" viewBox="0 0 32 32">${v}</symbol>`).join('');
  document.body.append(sprite);
}

export function overlay({ title, wide = false, top = false, onClose = null }) {
  wear();
  const root = document.createElement('div');
  root.className = `bsheet${wide ? ' wide' : ''}${top ? ' top' : ''}`;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', title);
  root.innerHTML = `<div class="bsheet-in"><div class="bsheet-head"><h2 tabindex="-1">${esc(title)}</h2><button class="x" type="button" aria-label="Close">×</button></div><div class="bsheet-body"></div></div>`;
  document.body.append(root);
  const prev = document.activeElement, body = root.querySelector('.bsheet-body');
  let closed = false;
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.bm-modal') && !root.nextElementSibling?.classList.contains('bsheet')) { e.stopPropagation(); close(); } };
  const close = () => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey, true); root.remove(); try { prev?.focus?.(); } catch { /* the opener may be gone */ } onClose?.(); };
  document.addEventListener('keydown', onKey, true);
  root.querySelector('.x').onclick = close;
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  setTimeout(() => root.querySelector('h2')?.focus(), 0);
  return { root, body, close, get closed() { return closed; } };
}
