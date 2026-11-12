const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CARET = '<svg class="np-c" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHECK = '<svg class="np-k" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const mark = (m) => (/^[\w-]+$/.test(m || '') ? `<svg class="tk" aria-hidden="true"><use href="#${m}"/></svg>` : '');

export function netPicker(sel) {
  if (!sel || sel.dataset.np || sel.options.length < 2) return;
  sel.dataset.np = '1';
  const opts = [...sel.options].map((o) => ({ v: o.value, name: o.textContent.trim(), mark: o.dataset.mark || '' }));
  const label = sel.getAttribute('aria-label') || 'Network', cur = () => opts.find((o) => o.v === sel.value) || opts[0];
  const wrap = document.createElement('span');
  wrap.className = 'np';
  wrap.innerHTML = '<button type="button" class="np-b" aria-haspopup="listbox" aria-expanded="false"></button><div class="np-m" role="listbox" hidden></div>';
  const b = wrap.firstElementChild, m = wrap.lastElementChild;
  m.setAttribute('aria-label', label);
  const paint = () => {
    const c = cur();
    b.innerHTML = `${mark(c.mark)}<span>${esc(c.name)}</span>${CARET}`;
    b.setAttribute('aria-label', `${label}: ${c.name}. Choose another`);
    m.innerHTML = opts.map((o) => `<button type="button" class="np-o" role="option" data-v="${esc(o.v)}" aria-selected="${o.v === c.v}" tabindex="-1">${mark(o.mark)}<span>${esc(o.name)}</span>${CHECK}</button>`).join('');
  };
  const items = () => [...m.querySelectorAll('.np-o')];
  const away = (e) => { if (!wrap.isConnected) { document.removeEventListener('pointerdown', away, true); return; } if (!wrap.contains(e.target)) close(false); };
  function close(back = true) {
    if (m.hidden) return;
    m.hidden = true; b.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', away, true);
    if (back) b.focus();
  }
  function open() {
    paint();
    m.hidden = false; b.setAttribute('aria-expanded', 'true');
    m.toggleAttribute('data-up', b.getBoundingClientRect().bottom + m.offsetHeight + 12 > innerHeight && b.getBoundingClientRect().top > m.offsetHeight + 12);
    document.addEventListener('pointerdown', away, true);
    (items().find((x) => x.getAttribute('aria-selected') === 'true') || items()[0])?.focus();
  }
  function choose(v) {
    close();
    if (v === sel.value) return;
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    paint();
  }
  b.addEventListener('click', () => (m.hidden ? open() : close()));
  b.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (m.hidden) open(); } });
  m.addEventListener('click', (e) => { const o = e.target.closest('.np-o'); if (o) choose(o.dataset.v); });
  m.addEventListener('keydown', (e) => {
    const l = items(), i = l.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); l[(i + (e.key === 'ArrowDown' ? 1 : -1) + l.length) % l.length]?.focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); l[e.key === 'Home' ? 0 : l.length - 1]?.focus(); }
    else if (e.key === 'Tab') close(false);
  });
  sel.addEventListener('change', paint);
  sel.classList.add('np-sel'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
  paint();
  sel.before(wrap);
}
