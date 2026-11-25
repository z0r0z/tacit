// The new price source for TACD and TACE becomes executable at this moment (the vaults' pendingOracleEta, 3-day delay).
// Until then the TAC side of the page shows a countdown instead of the borrow panel.
const ETA = 1795660379;   // Thu 2026-11-26 02:32:59 UTC
const root = document.documentElement, left = () => ETA - Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(2, '0');
const el = () => document.getElementById('lock-t');
function tick() {
  const s = left();
  if (s <= 0) { root.removeAttribute('data-locked'); document.getElementById('lock')?.remove(); return; }
  const t = el(); if (t) t.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
  setTimeout(tick, 1000 - (Date.now() % 1000));
}
if (left() > 0) { root.setAttribute('data-locked', ''); tick(); }
