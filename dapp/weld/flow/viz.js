// Tacit flow: a picture of Bitcoin and Ethereum being kept in step, drawn from what really happened.
//
// One self-contained module for the stats page and the front page. It imports nothing and touches the document only inside
// mountFlow(), so the planning below (what to draw, and when) can be tested with plain data.
//
// What it draws, and from what (all from the API's /flow feed, which is built from public data):
//   proofs      Bitcoin's state landing on Ethereum: a bright pulse along the line, at the time each attestation happened
//   bridge      burns recorded on the way in (orange, they wait at the proof gate, then cross) and the mints that land
//   cross-outs  tETH going back to Bitcoin (blue, the other lane)
//   TAC         made public and made private, a loop between two small marks at Ethereum
//   deposits    ETH made private; settles, faintly, as private activity
//   blocks      Bitcoin's blocks and the headers the relay takes, as the heartbeat
// An event with a real time is drawn at that time. A counter with no time of its own (burns, mints, cross-outs) is drawn when the
// counter moved, to the nearest reading. Nothing is invented to fill space, and nothing private is carried: counts and times only.

const DAY = 86400;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const finite = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const int = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

export const REPLAY_SPAN = 36;                 // seconds a day is played in
const MAX_PER_POINT = 10;                      // the most counter-driven marks one change draws
const STAGGER = { burn: 0.4, mint: 0.4, cross: 0.5, block: 0.25, header: 0.3 };   // seconds between marks of one change
const EVENT_KINDS = { attests: 'proof', settles: 'settle', deposits: 'deposit', tacOut: 'out', tacIn: 'in' };

// ── what to draw ──────────────────────────────────────────────────────────────────────────────────────────────────

// How far each counter moved from one reading to the next (never negative, and nothing where either reading is missing).
function deltas(a, b) {
  const d = (k) => { const x = finite(a && a[k]), y = finite(b && b[k]); return x != null && y != null && y > x ? y - x : 0; };
  return { burn: d('burns'), mint: d('minted'), cross: d('out'), block: d('btc'), header: d('relay') };
}
const counters = (now) => ({ burns: now && now.burns, minted: now && now.minted, out: now && now.crossOuts, btc: now && now.btc, relay: now && now.relay });
const cap = (kind, n) => Math.min(n, kind === 'block' ? 12 : MAX_PER_POINT);

// The whole window as a timeline of marks, each at a second inside `span`, oldest first.
export function planReplay(feed, { span = REPLAY_SPAN } = {}) {
  if (!feed) return [];
  const win = feed.windowSec || DAY, end = feed.asOf, start = end - win;
  const at = (t) => clamp(((t - start) / win) * span, 0, span);
  const out = [];
  const ev = feed.events || {};
  for (const [k, kind] of Object.entries(EVENT_KINDS)) for (const t of ev[k] || []) out.push({ at: at(t), kind, t });
  const s = Array.isArray(feed.series) ? feed.series : [];
  for (let i = 1; i < s.length; i++) {
    if (!(s[i].t > start)) continue;                                  // a change before the window began is not part of it
    for (const [kind, n] of Object.entries(deltas(s[i - 1], s[i]))) {
      for (let j = 0; j < cap(kind, n); j++) out.push({ at: clamp(at(s[i].t) + j * STAGGER[kind], 0, span), kind, t: s[i].t });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// What is new between two feeds, as marks to draw now (`at` is a delay in seconds). The first feed has no before, so nothing is new.
export function diffFeed(prev, next, { maxEach = 12 } = {}) {
  if (!prev || !next) return [];
  const out = [];
  const list = (f, k) => (f.events && f.events[k]) || [];
  for (const [k, kind] of Object.entries(EVENT_KINDS)) {
    const seen = list(prev, k), last = seen.length ? seen[seen.length - 1] : prev.asOf - 900;
    list(next, k).filter((t) => t > last).slice(-maxEach).forEach((t, i) => out.push({ at: i * 0.25, kind, t }));
  }
  for (const [kind, n] of Object.entries(deltas(counters(prev.now), counters(next.now)))) {
    for (let j = 0; j < cap(kind, n); j++) out.push({ at: j * STAGGER[kind], kind, t: next.asOf });
  }
  return out.sort((a, b) => a.at - b.at);
}

// The window in numbers, for the counters under the picture and for the words a screen reader gets.
export function summarize(feed) {
  if (!feed) return null;
  const win = feed.windowSec || DAY, start = feed.asOf - win;
  const ev = feed.events || {}, n = (k) => (ev[k] || []).length;
  const s = (Array.isArray(feed.series) ? feed.series : []).filter((p) => p && finite(p.t) != null);
  const base = [...s].reverse().find((p) => p.t <= start) || s[0], last = s[s.length - 1];
  const moved = (k) => (base && last && finite(base[k]) != null && finite(last[k]) != null && last[k] >= base[k] ? last[k] - base[k] : null);
  const now = feed.now || {};
  const behind = finite(now.btc) != null && finite(now.attested) != null ? Math.max(0, now.btc - now.attested) : null;
  return {
    proofs: n('attests'), settles: n('settles'), deposits: n('deposits'), made_public: n('tacOut'), made_private: n('tacIn'),
    burns: moved('burns'), minted: moved('minted'), crossOuts: moved('out'),
    attested: finite(now.attested), btc: finite(now.btc), behind, recorded: finite(now.burns), mintedTotal: finite(now.minted),
  };
}

export function describe(sum) {
  if (!sum) return 'Bitcoin and Ethereum: reading.';
  const of = (n, one, many) => `${int(n)} ${Number(n) === 1 ? one : many}`;
  const bits = [`${of(sum.proofs, 'proof', 'proofs')} of Bitcoin landed on Ethereum`];
  if (sum.burns != null) bits.push(`${of(sum.burns, 'bridge burn', 'bridge burns')} recorded`);
  if (sum.minted != null) bits.push(`${int(sum.minted)} minted`);
  if (sum.crossOuts) bits.push(`${of(sum.crossOuts, 'cross-out', 'cross-outs')} to Bitcoin`);
  bits.push(`${int(sum.made_public)} TAC made public, ${int(sum.made_private)} made private`);
  return `Bitcoin and Ethereum in the last 24 hours: ${bits.join(', ')}.`;
}

// ── where things are ──────────────────────────────────────────────────────────────────────────────────────────────

export function layout(w, h, compact) {
  const y = h * 0.5, pad = compact ? Math.max(0.075, 40 / w) : 0.09, bow = h * (compact ? 0.2 : 0.17);
  // The lines start beyond the names under each chain, so no label sits on a line. `up` and `dn` are the tops of the two arcs.
  const L = { w, h, compact, btc: { x: w * pad, y }, eth: { x: w * (1 - pad), y }, gateX: w * 0.5, up: y - bow, dn: y + bow, mid: y, bow, inset: compact ? 30 : 46 };
  // Ethereum is a column: the private pool above it, the public token below it, so TAC made public and private moves through it
  // and never crosses the arcs between the chains.
  L.priv = { x: L.eth.x, y: h * (compact ? 0.15 : 0.13) };
  L.pub = { x: L.eth.x, y: h * (compact ? 0.85 : 0.87) };
  return L;
}

// Progress along the whole way when a mark has to wait at the proof gate: it runs to the gate, waits there, then crosses.
export function gated(t) {
  const wait = 0.08, to = 0.46, base = 0.5 + wait * 0.02;
  if (t < to) return 0.5 * ease(t / to);
  if (t < to + wait) return 0.5 + (t - to) * 0.02;
  return base + (1 - base) * ease((t - to - wait) / (1 - to - wait));
}

export function alpha(color, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return color;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${clamp(a, 0, 1)})`;
}

// ── marks in flight ───────────────────────────────────────────────────────────────────────────────────────────────

const DUR = { burn: 3300, cross: 3200, mint: 1500, proof: 3200, block: 1600, header: 2600, settle: 900, deposit: 1300, out: 1700, in: 1700 };
const MAX_LIVE = 160;

function spawn(kind, L, born, jitter) {
  const j = (jitter - 0.5) * 6;
  return { kind, born, dur: DUR[kind] || 1500, j };
}

// A mark's position and look at progress t (0..1). A mark with a `trail` is drawn with that many fading copies of itself behind it.
function look(p, t, L, C) {
  // An arc between the chains: over the top for a burn, underneath for a cross-out, the same height at the gate.
  const arcAt = (sign, from, to, prog) => ({ x: lerp(from, to, prog), y: L.mid + sign * (4 * L.bow * prog * (1 - prog) + p.j * Math.sin(Math.PI * prog)) });
  const x0 = L.btc.x + L.inset, x1 = L.eth.x - L.inset, edge = (t0) => (t < 0.06 ? t / 0.06 : 1 - clamp((t - 0.94) / 0.06, 0, 1)) * t0;
  switch (p.kind) {
    case 'burn': return { ...arcAt(-1, x0, x1, gated(t)), r: 1.9, c: C.orange, glow: 0, trail: 9, a: edge(0.9) };
    case 'cross': return { ...arcAt(1, x1, x0, gated(t)), r: 1.9, c: C.eth, glow: 0, trail: 9, a: edge(0.9) };
    case 'block': return { x: L.btc.x + 12 + ease(t) * 28, y: L.mid + p.j, r: 1.2, c: C.orange, glow: 0, sq: true, a: 0.5 * (1 - t) };
    case 'header': return { x: lerp(x0, x1, ease(t)), y: L.mid, r: 1.2, c: C.orange, glow: 0, a: 0.3 * Math.sin(Math.PI * t) };
    case 'proof': return { x: lerp(x0, x1, ease(t)), y: L.mid, pulse: true, a: Math.sin(Math.PI * Math.min(1, t * 1.05)) };
    case 'mint': return { x: L.eth.x, y: L.eth.y, ring: lerp(7, compactRing(L), ease(t)), c: C.orange, a: 0.4 * (1 - t) };
    case 'settle': return { x: L.eth.x, y: L.eth.y, ring: lerp(5, 11, t), c: C.ink, a: 0.2 * (1 - t) };
    case 'deposit': { const ty = L.priv.y; return { x: L.priv.x, y: lerp(0, ty, ease(t)), r: 1.9, c: C.eth, glow: 0, trail: 6, a: 0.9 * (1 - clamp((t - 0.85) / 0.15, 0, 1)) }; }
    case 'out': return arc(L.priv, L.pub, t, C.orange, L);
    case 'in': return arc(L.pub, L.priv, t, C.orange, L);
    default: return null;
  }
}
const compactRing = (L) => (L.compact ? 16 : 26);
function arc(a, b, t, c, L) {
  // Bowed to the right of the column, by no more than the room there is.
  const e = ease(t), room = Math.max(0, L.w - L.eth.x - 8), bow = Math.min(L.compact ? 10 : 22, room) * Math.sin(Math.PI * e);
  return { x: lerp(a.x, b.x, e) + bow, y: lerp(a.y, b.y, e), r: 2.1, c, glow: 0, trail: 7, a: (Math.sin(Math.PI * clamp(t, 0, 1)) * 0.95 + 0.05) * 0.85 };
}

function drawScene(ctx, L, C) {
  const x0 = L.btc.x + L.inset, x1 = L.eth.x - L.inset;
  ctx.setLineDash([]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.hair;
  // The line between them, which Bitcoin's blocks and their proofs travel, and the two arcs over and under it.
  ctx.beginPath();
  ctx.moveTo(x0, L.mid); ctx.lineTo(x1, L.mid);
  ctx.moveTo(x0, L.mid); ctx.quadraticCurveTo(L.gateX, L.mid - 2 * L.bow, x1, L.mid);
  ctx.moveTo(x0, L.mid); ctx.quadraticCurveTo(L.gateX, L.mid + 2 * L.bow, x1, L.mid);
  ctx.stroke();
  // The proof gate: where a burn waits until Bitcoin's state has landed on Ethereum.
  ctx.beginPath(); ctx.moveTo(L.gateX, L.up - 3); ctx.lineTo(L.gateX, L.dn + 3); ctx.stroke();
  ctx.fillStyle = C.mute; ctx.globalAlpha = 0.75;
  ctx.textAlign = 'center';
  if (C.q) ctx.font = `italic 400 13px ${C.serif}`; else ctx.font = `400 ${L.compact ? 10 : 9}px ${C.mono}`;
  if (!C.q && 'letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
  ctx.fillText(C.q ? 'proof' : 'PROOF', L.gateX, L.up - (L.compact ? 7 : 9));
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.globalAlpha = 1;
  // The column the TAC moves along, broken where Ethereum's own mark and name sit.
  const gap = L.compact ? [10, 20] : [18, 36], pad = L.compact ? 4 : 10;
  ctx.beginPath();
  ctx.moveTo(L.priv.x, L.priv.y + pad); ctx.lineTo(L.priv.x, L.eth.y - gap[0]);
  ctx.moveTo(L.priv.x, L.eth.y + gap[1]); ctx.lineTo(L.priv.x, L.pub.y - pad);
  ctx.stroke();
}

function drawMark(ctx, m, L, C) {
  if (m.pulse) {
    // The proof: a short capsule, orange at its Bitcoin end and blue at its Ethereum end, travelling along the line.
    const len = L.compact ? 32 : 56, x0 = m.x - len, g = ctx.createLinearGradient(x0, 0, m.x, 0);
    g.addColorStop(0, alpha(C.orange, 0)); g.addColorStop(0.6, alpha(C.orange, 0.28 * m.a)); g.addColorStop(1, alpha(C.eth, 0.55 * m.a));
    ctx.strokeStyle = g; ctx.lineWidth = L.compact ? 1.2 : 1.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(Math.max(L.btc.x + L.inset, x0), m.y); ctx.lineTo(Math.min(L.eth.x - L.inset, m.x), m.y); ctx.stroke();
    ctx.lineCap = 'butt'; ctx.lineWidth = 1;
    return;
  }
  if (m.ring != null) {
    ctx.strokeStyle = alpha(m.c, C.q ? m.a * 0.7 : m.a); ctx.lineWidth = C.q ? 0.75 : 1;
    ctx.beginPath(); ctx.arc(m.x, m.y, m.ring, 0, Math.PI * 2); ctx.stroke();
    return;
  }
  ctx.fillStyle = alpha(m.c, m.a);
  if (m.sq) ctx.fillRect(m.x - m.r, m.y - m.r, m.r * 2, m.r * 2);
  else { ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill(); }
}

// A mark and, behind it, the fading copies of where it just was.
function drawMarkTrail(ctx, p, t, L, C) {
  const m = look(p, t, L, C);
  if (!m) return;
  if (C.q && m.trail) {
    // one fine line that thins away behind a small, crisp head
    let prev = m;
    ctx.lineWidth = 1; ctx.lineCap = 'round';
    for (let k = 1; k <= m.trail; k++) {
      const tt = t - k * 0.013;
      if (tt < 0) break;
      const q = look(p, tt, L, C);
      if (!q) break;
      ctx.strokeStyle = alpha(m.c, m.a * 0.6 * (1 - k / (m.trail + 1)));
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      prev = q;
    }
    ctx.lineCap = 'butt';
    drawMark(ctx, { ...m, r: m.r * 0.8 }, L, C);
    return;
  }
  drawMark(ctx, m, L, C);
  for (let k = 1; k <= (m.trail || 0); k++) {
    const tt = t - k * 0.013;
    if (tt < 0) break;
    const q = look(p, tt, L, C), f = 1 - k / (m.trail + 1);
    if (!q) break;
    drawMark(ctx, { ...q, r: q.r * (0.3 + 0.7 * f), a: q.a * 0.5 * f }, L, C);
  }
}

// ── the widget ────────────────────────────────────────────────────────────────────────────────────────────────────

const STYLE = `
.fl { position: relative; font-family: var(--mono, ui-monospace, Menlo, monospace); color: var(--ink, #1a1a1a); }
@media (prefers-reduced-motion: no-preference) { .fl { transition: opacity 1s ease; } .fl:not(.fl-in) { opacity: 0; } }
.fl-top { display: flex; justify-content: space-between; align-items: baseline; gap: 4px 14px; flex-wrap: wrap; margin-bottom: 2px; min-height: 17px; }
.fl-mode { display: inline-flex; gap: 14px; }
.fl-mode button { appearance: none; font: 400 10px var(--mono, monospace); letter-spacing: .06em; border: 0; border-radius: 0; border-bottom: 1px solid transparent; background: none; color: var(--mute, #625c4f); padding: 1px 0; margin: 0; cursor: pointer; transition: color .2s, border-color .2s; }
.fl-mode button:hover { color: var(--ink, #1a1a1a); }
.fl-mode button[aria-selected="true"] { color: var(--ink, #1a1a1a); border-bottom-color: var(--hair-2, rgba(26,26,26,.28)); }
.fl-mode button:focus-visible { outline: 2px solid var(--ink, #1a1a1a); outline-offset: 3px; }
.fl-clock { font: 400 10px var(--mono, monospace); letter-spacing: .02em; color: var(--mute, #625c4f); }
.fl-stage { position: relative; width: 100%; }
.fl-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.fl-n { position: absolute; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 3px; font: 400 11px var(--mono, monospace); pointer-events: none; text-align: center; }
.fl-n small { color: var(--mute, #625c4f); font: 400 10px var(--mono, monospace); white-space: nowrap; }
.fl-n .fl-ic { width: 30px; height: 30px; display: block; }
.fl.fl-c .fl-n { gap: 4px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--mute, #625c4f); }
.fl.fl-c .fl-n .fl-ic { width: 16px; height: 16px; opacity: .92; }
.fl.fl-c .fl-n small { display: none; }
.fl-n .fl-disc { width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font: 500 15px var(--mono, monospace); }
.fl.fl-c .fl-n .fl-disc { width: 16px; height: 16px; font-size: 9px; }
.fl-s { position: absolute; transform: translate(-50%, -50%); font: 400 10px var(--mono, monospace); letter-spacing: .04em; color: var(--mute, #625c4f); pointer-events: none; white-space: nowrap; }
.fl.fl-c .fl-s { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; }
.fl.fl-q .fl-foot, .fl.fl-q .fl-clock, .fl.fl-q .fl-mode button { font-size: 11px; }
.fl.fl-c.fl-q .fl-n { gap: 5px; font: italic 400 14px/1 var(--serif, Georgia, serif); letter-spacing: 0; text-transform: none; }
.fl.fl-c.fl-q .fl-s { font: italic 400 13px var(--serif, Georgia, serif); letter-spacing: 0; text-transform: none; }
.fl-foot { display: flex; flex-wrap: wrap; gap: 3px 16px; margin-top: 4px; font: 400 10px var(--mono, monospace); letter-spacing: .01em; color: var(--mute, #625c4f); }
.fl-foot b { color: var(--ink, #1a1a1a); font-weight: 400; }
.fl-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 520px) { .fl-n small { display: none; } .fl-foot { gap: 3px 12px; } }
`;

export function mountFlow(host, { api = 'https://api.tacit.finance', compact = false, quiet = false, fetchImpl, tipUrl = 'https://mempool.space/api/blocks/tip/height', pollMs = 15000, tipMs = 30000 } = {}) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const doFetch = fetchImpl || ((...a) => win.fetch(...a));
  const reduce = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!doc.getElementById('fl-style')) { const st = doc.createElement('style'); st.id = 'fl-style'; st.textContent = STYLE; doc.head.appendChild(st); }

  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const root = el('div', `fl${compact ? ' fl-c' : ''}${quiet ? ' fl-q' : ''}`);
  root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Bitcoin and Ethereum, kept in step');
  const top = el('div', 'fl-top'), modes = el('div', 'fl-mode'), clock = el('span', 'fl-clock', 'loading…');
  modes.setAttribute('role', 'tablist'); modes.setAttribute('aria-label', 'View');
  const modeBtn = (m, label) => { const b = el('button', '', label); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.flm = m; return b; };
  const bLive = modeBtn('live', 'Live'), bReplay = modeBtn('replay', 'Last 24 h');
  modes.append(bLive, bReplay);
  if (!reduce) top.append(modes);
  top.append(clock);
  const stage = el('div', 'fl-stage'); stage.style.height = compact ? '104px' : '280px';
  const canvas = doc.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true'); stage.append(canvas);
  const node = (cls, name, sub, sprite, color, letter) => {
    const n = el('div', `fl-n ${cls}`), ic = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (doc.getElementById(sprite)) { ic.setAttribute('class', 'fl-ic'); ic.setAttribute('aria-hidden', 'true'); const u = doc.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#${sprite}`); ic.append(u); n.append(ic); }
    else { const d = el('span', 'fl-disc', letter); d.style.background = color; n.append(d); }
    const label = el('span', '', name), small = el('small', '', sub); n.append(label, small);
    return { n, small };
  };
  const btcN = node('btc', 'Bitcoin', '', 'tk-btc', '#f7931a', '₿'), ethN = node('eth', 'Ethereum', '', 'tk-eth', '#627eea', 'Ξ');
  const priv = el('span', 'fl-s', 'private'), pub = el('span', 'fl-s', compact ? 'public' : 'public TAC');
  stage.append(btcN.n, ethN.n, priv, pub);
  const foot = el('div', 'fl-foot'), sr = el('p', 'fl-sr');
  sr.setAttribute('aria-live', 'polite');
  root.append(top, stage, foot, sr);
  host.replaceChildren(root);
  win.setTimeout(() => root.classList.add('fl-in'), 30);

  const css = () => win.getComputedStyle(root);
  let C = null;
  const colors = () => {
    const s = css(), v = (n, fb) => (s.getPropertyValue(n) || '').trim() || fb;
    C = { orange: v('--orange', '#f7931a'), eth: v('--eth', '#627eea'), ink: v('--ink', '#1a1a1a'), q: quiet, serif: v('--serif', 'Georgia, serif'), mute: v('--mute', '#625c4f'), hair: v('--hair', 'rgba(26,26,26,.12)'), hair2: v('--hair-2', 'rgba(26,26,26,.28)'), mono: v('--mono', 'ui-monospace, Menlo, monospace') };
  };
  const ctx = canvas.getContext && canvas.getContext('2d');
  let L = layout(600, compact ? 104 : 280, compact), dpr = 1;

  const place = () => {
    const w = stage.clientWidth || 600, h = stage.clientHeight || (compact ? 104 : 280);
    dpr = Math.min(2, win.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    L = layout(w, h, compact);
    const at = (e, p, dx = 0, dy = 0) => { e.style.left = `${p.x + dx}px`; e.style.top = `${p.y + dy}px`; };
    at(btcN.n, L.btc); at(ethN.n, L.eth); at(priv, L.priv); at(pub, L.pub);
    colors();
  };

  const st = { feed: null, mode: reduce ? 'live' : 'replay', userChose: false, playhead: 0, plan: [], idx: 0, marks: [], queue: [], lastTs: 0, running: false, visible: true, raf: 0, tipSeen: null, fails: 0, timers: {}, at: 0 };
  const setMode = (m, byUser) => {
    st.mode = m; if (byUser) st.userChose = true;
    bLive.setAttribute('aria-selected', String(m === 'live')); bReplay.setAttribute('aria-selected', String(m === 'replay'));
    st.marks = []; st.queue = []; st.playhead = 0; st.idx = 0;
    if (m === 'replay' && st.feed) st.plan = planReplay(st.feed);
    paintClock(); kick();
  };
  bLive.addEventListener('click', () => setMode('live', true));
  bReplay.addEventListener('click', () => setMode('replay', true));

  const paintCounters = () => {
    const s = summarize(st.feed);
    if (!s) return;
    const piece = (label, v, strong = true) => `${label} ${strong ? '<b>' : ''}${v}${strong ? '</b>' : ''}`;
    const items = [piece('proven to block', int(s.attested))];
    if (s.behind != null) items.push(`${int(s.behind)} blocks behind Bitcoin`);
    if (!compact) {
      if (s.recorded != null) items.push(piece('bridged in', `${int(s.mintedTotal ?? s.recorded)}`));
      items.push(piece('24 h', `${int(s.proofs)} proofs · ${int(s.settles)} private transactions`));
      if (s.made_public || s.made_private) items.push(piece('TAC', `${int(s.made_public)} public · ${int(s.made_private)} private`));
    } else {
      items.push(piece('24 h', `${int(s.proofs)} proofs · ${int(s.settles)} private transactions`));
    }
    foot.innerHTML = items.map((x) => `<span>${x}</span>`).join('');
    btcN.small.textContent = s.btc != null ? `block ${int(s.btc)}` : '';
    ethN.small.textContent = s.attested != null ? `proven ${int(s.attested)}` : '';
    sr.textContent = describe(s);
  };
  const paintClock = () => {
    if (!st.feed) return;
    if (st.mode === 'replay') {
      const t = st.feed.asOf - (st.feed.windowSec || DAY) + clamp(st.playhead / REPLAY_SPAN, 0, 1) * (st.feed.windowSec || DAY);
      const d = new Date(t * 1000), hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
      const ago = Math.max(0, Math.round((st.feed.asOf - t) / 3600));
      clock.textContent = `${hh}:${mm} UTC · ${ago ? `${ago} h ago` : 'now'}`;
    } else {
      clock.textContent = st.fails >= 3 ? 'reconnecting…' : '';   // live says so in the choice above; it only speaks when it cannot read
    }
  };

  const push = (entries) => { for (const e of entries) st.queue.push({ due: Date.now() + e.at * 1000, kind: e.kind }); };
  const addMark = (kind, now) => {
    if (st.marks.length >= MAX_LIVE) return;
    st.marks.push(spawn(kind, L, now, Math.random()));
  };

  const frame = (ts) => {
    st.raf = 0;
    if (!st.running) return;
    const dt = Math.min(0.1, st.lastTs ? (ts - st.lastTs) / 1000 : 0.016); st.lastTs = ts;
    const wall = Date.now();
    if (st.mode === 'replay') {
      st.playhead += dt;
      while (st.idx < st.plan.length && st.plan[st.idx].at <= st.playhead) addMark(st.plan[st.idx++].kind, ts);
      // The day has been played: on to live, or round again when it was asked for. The frame goes on either way.
      if (st.playhead > REPLAY_SPAN + 2.5) setMode(st.userChose ? 'replay' : 'live', st.userChose);
    }
    for (let i = st.queue.length - 1; i >= 0; i--) if (st.queue[i].due <= wall) { addMark(st.queue[i].kind, ts); st.queue.splice(i, 1); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    drawScene(ctx, L, C);
    st.marks = st.marks.filter((p) => ts - p.born < p.dur);
    for (const p of st.marks) drawMarkTrail(ctx, p, clamp((ts - p.born) / p.dur, 0, 1), L, C);
    if (((ts | 0) % 1000) < 17) paintClock();
    st.raf = win.requestAnimationFrame(frame);
  };
  const still = () => { if (!ctx) return; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, L.w, L.h); drawScene(ctx, L, C); };
  function kick() {
    const want = !reduce && st.visible && !doc.hidden && !!ctx && !!st.feed;
    if (want && !st.running) { st.running = true; st.lastTs = 0; st.raf = win.requestAnimationFrame(frame); }
    else if (!want && st.running) { st.running = false; if (st.raf) win.cancelAnimationFrame(st.raf); st.raf = 0; still(); }
    else if (!want) still();
  }

  // One timer for each job, replaced when it is set again, so a long-open page holds two and not a growing list. A job that
  // comes due while the page is hidden or the diagram is out of view waits, and runs as soon as it is seen again.
  const asleep = new Map();
  const later = (name, fn, ms) => {
    win.clearTimeout(st.timers[name]);
    st.timers[name] = win.setTimeout(() => { if (doc.hidden || !st.visible) asleep.set(name, fn); else fn(); }, ms);
  };
  const wake = () => { if (doc.hidden || !st.visible) return; for (const [name, fn] of asleep) { asleep.delete(name); fn(); } };
  const poll = async () => {
    try {
      const r = await doFetch(`${api}/flow`, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`flow ${r.status}`);
      const next = await r.json();
      if (st.tipSeen != null && finite(next.now && next.now.btc) != null && st.tipSeen > next.now.btc) next.now.btc = st.tipSeen;
      const fresh = st.feed ? diffFeed(st.feed, next) : [];
      st.feed = next; st.at = Date.now(); st.fails = 0;
      if (st.mode === 'live') push(fresh);
      if (st.mode === 'replay' && !st.plan.length) st.plan = planReplay(next);
      paintCounters(); paintClock(); kick();
    } catch { st.fails++; paintClock(); }
    later('poll', poll, st.fails >= 3 ? 60000 : pollMs);
  };
  const tip = async () => {
    try {
      const r = await doFetch(tipUrl);
      const h = parseInt((await r.text()).trim(), 10);
      if (Number.isInteger(h)) {
        if (st.tipSeen != null && h > st.tipSeen && st.mode === 'live') push(Array.from({ length: Math.min(h - st.tipSeen, 3) }, (_, i) => ({ at: i * 0.4, kind: 'block' })));
        if (st.tipSeen == null || h > st.tipSeen) { st.tipSeen = h; if (st.feed && st.feed.now && (finite(st.feed.now.btc) == null || h > st.feed.now.btc)) { st.feed.now.btc = h; paintCounters(); } }
      }
    } catch { /* the feed's own height stands */ }
    later('tip', tip, tipMs);
  };

  const ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => { place(); kick(); }) : null;
  if (ro) ro.observe(stage);
  const io = typeof win.IntersectionObserver === 'function' ? new win.IntersectionObserver((es) => { st.visible = es.some((e) => e.isIntersecting); kick(); wake(); }) : null;
  if (io) io.observe(stage);
  const vis = () => { kick(); wake(); };
  doc.addEventListener('visibilitychange', vis);
  // The page's tokens change with its theme: read them again, so the marks stay legible on either ground.
  const mq = win.matchMedia ? win.matchMedia('(prefers-color-scheme: dark)') : null;
  const recolor = () => { colors(); if (!st.running) still(); };
  if (mq && mq.addEventListener) mq.addEventListener('change', recolor);
  place(); setMode(st.mode); still();
  poll(); later('tip', tip, 4000);

  return {
    destroy() {
      st.running = false; if (st.raf) win.cancelAnimationFrame(st.raf);
      Object.values(st.timers).forEach((id) => win.clearTimeout(id)); if (ro) ro.disconnect(); if (io) io.disconnect();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', recolor);
      doc.removeEventListener('visibilitychange', vis); host.replaceChildren();
    },
    state: st,
  };
}
