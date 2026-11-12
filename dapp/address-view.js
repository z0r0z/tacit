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
  } catch { }
}

function view(value, n, head, flat) {
  const v = String(value ?? '');
  if (!v) return '';
  if (head + n + 1 >= v.length) return esc(v);
  style();
  const mid = v.slice(head, v.length - n), cut = mid.length >> 1;
  return `<span class="${flat ? 'tv tv-f" title="' + esc(v) : 'tv" tabindex="0'}"><span>${esc(v.slice(0, head))}</span><span class="tv-m"><span class="tv-t">${esc(mid.slice(0, cut))}</span><span class="tv-e" aria-hidden="true"></span><span class="tv-t">${esc(mid.slice(cut))}</span></span><span>${esc(v.slice(v.length - n))}</span></span>`;
}
export const addrView = (value, n = 4, head = n + 2) => view(value, n, head, false);
export const addrFlat = (value, n = 4, head = n + 2) => view(value, n, head, true);
