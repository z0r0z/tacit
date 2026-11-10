// An address, hash or id shown short with every character still in the page. The middle is collapsed by CSS, not cut: find-in-page matches
// the whole value, a selection copies it whole (the ellipsis is drawn by CSS, so it is never in what is copied), and a tap or focus
// opens it so each character can be read before it is trusted.
// The markup and the collapse follow umplabs/truncated-value (MIT, Copyright (c) 2025 UMP Labs), without its Lit runtime: it is the same
// light-DOM structure, so a page's own rules reach it, and it comes back as a string for the pages' html`` templates.
//
//   addrView(a, n, head)  the first `head` (n + 2) and the last n characters, as short(a, n) shows them
//   addrFlat(a, n, head)  the same for inside a link, which cannot take focus: it stays short (the title and the page's find and copy have all of it)
//
// Not for inside a button, nor for a plain-text label (it is markup).
const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => MAP[c]);

const CSS = `
.tv { --tv: 1; cursor: zoom-in; overflow-wrap: anywhere; }
.tv:is(:focus, :focus-within, :active) { --tv: 0; cursor: text; white-space: normal; }
.tv:focus-visible { outline: 2px solid var(--orange, currentColor); outline-offset: 2px; border-radius: 3px; }
.tv.tv-f { cursor: inherit; }
.tv > .tv-m > .tv-t { font-size: calc((1 - var(--tv)) * 1em); }
.tv > .tv-m > .tv-e { font-size: calc(var(--tv) * 1em); }
.tv > .tv-m > .tv-e::after { content: "…"; }
`;

let styled = false;
function style() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  try {
    const s = document.createElement('style');
    s.id = 'tv-css';
    s.textContent = CSS;
    document.head.append(s);
  } catch { /* a page that forbids it shows the whole value, never less of it */ }
}

function view(value, n, head, flat) {
  const v = String(value ?? '');
  if (!v) return '';
  if (head + n + 1 >= v.length) return esc(v);       // nothing to hide: the ellipsis would stand for one character or none
  style();
  const mid = v.slice(head, v.length - n), cut = mid.length >> 1;
  return `<span class="${flat ? 'tv tv-f" title="' + esc(v) : 'tv" tabindex="0'}"><span>${esc(v.slice(0, head))}</span><span class="tv-m"><span class="tv-t">${esc(mid.slice(0, cut))}</span><span class="tv-e" aria-hidden="true"></span><span class="tv-t">${esc(mid.slice(cut))}</span></span><span>${esc(v.slice(v.length - n))}</span></span>`;
}
export const addrView = (value, n = 4, head = n + 2) => view(value, n, head, false);
export const addrFlat = (value, n = 4, head = n + 2) => view(value, n, head, true);
