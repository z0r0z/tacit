// The glyph layer of the look. Everything it draws is small monospace punctuation on a 2D canvas, light to dense (`.` is dim,
// `@` is bright), so from reading distance the marks fuse into a shaded picture and up close it is ciphertext that keeps
// quietly changing. Its uses, each standing for something the page says in words elsewhere:
//
//   on every page that wears the shared header
//   1. the field    a quiet field of glyphs behind the whole page, wherever it is scrolled to, kept off the header and
//                   whatever the page holds, off on a phone;
//   2. the menu     Tacit's own mark struck across the foot of the menu's panel;
//
//   on the front page
//   3. the stamp    in the card, the mark of whatever a move goes INTO, struck across its "To" side, see-through, with the
//                   light behind each side taken from its asset's own mark (--tone);
//   4. the cipher   a tile of glyphs the stylesheet lays under whatever side of a move is private (--cipher);
//   5. the way in   in the wallet sheet, Tacit's mark struck across the ways to sign in, and the mark of whichever way is
//                   pointed at struck across that way's row alone.
//
// chrome.js imports it once the page is idle and calls start(); what start() returns takes it all away again (every canvas, timer,
// observer and listener).
// A page works the same without this file, and chrome.js ignores a failure to load it. It reads no
// key, balance or network, only the page's own markup (which asset a side names, which way in a row is) and its --ink. It
// adds canvases and two custom properties and changes nothing else. Under prefers-reduced-motion each piece is drawn once and
// left still; a hidden tab draws nothing, and a field nobody is touching is redrawn six times a second, not forty-five.

const RAMP = ".,:;'-+/\\|!*=%#&$@";   // light to dense. Punctuation only: letters and digits read as text
const LIGHT = RAMP.slice(0, 10);      // the field and the cipher use the light half, so they stay quiet
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const pick = (s) => s[(Math.random() * s.length) | 0];
// the page's ink as "r,g,b", so the glyphs are the colour of its text in either scheme
function ink() {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(getComputedStyle(document.documentElement).getPropertyValue('--ink').trim());
  return m ? m.slice(1).map((h) => parseInt(h, 16)).join(',') : '228,228,225';
}
// A canvas carries its own place, as the stylesheets also give it (the field fixed to the window, a stamp over the whole of what holds it), so a page
// whose styles lack those rules (an older copy of chrome.css, a test harness) never has it in its flow or wider than the window.
const PLACE = { 'gx-field': 'position:fixed;top:0;left:0;z-index:-1;max-width:100%;pointer-events:none', 'gx-stamp': 'position:absolute;inset:0;z-index:-1;width:100%;height:100%;pointer-events:none' };
const canvasOf = (cls) => { const c = Object.assign(document.createElement('canvas'), { className: cls }); c.setAttribute('aria-hidden', 'true'); c.style.cssText = PLACE[cls.split(' ')[0]] || ''; return c; };

// ── the field ──
// Every glyph is a particle on a spring. The pointer pushes glyphs out of its way and sweeps them along with it, and they
// spring back; while one moves it is drawn as a stroke along its motion. A press sends out a ring. At rest one glyph in a
// hundred is re-rolled each frame. The canvas is fixed behind the page, so the field is there wherever the page is scrolled
// to. `ground.at(x, y)` says how much of the field a point of the window may have (0 where the page has something, 1 well
// clear of it), and each glyph eases towards that as the page moves under it.
const FIELD = { w: 11, h: 18, font: `13px ${MONO}`, reach: 110, fps: 45, rest: 6 };
function strokeOf(dx, dy) {
  const a = ((Math.atan2(dy, dx) * 180) / Math.PI + 180) % 180;
  return a < 22.5 || a >= 157.5 ? '-' : a < 67.5 ? '\\' : a < 112.5 ? '|' : '/';
}
function field(canvas, ground) {
  const ctx = canvas.getContext('2d'), rgb = ink(), calm = still();
  const ptr = { x: -9999, y: -9999, vx: 0, vy: 0, px: -9999, py: -9999, on: false }, rings = [];
  let cells = [], raf = 0, last = 0, awake = 0, moved = true, later = 0, idle = 0;

  function resize() {
    // the page's own width, not the window's: the canvas must never be the thing that makes the page scroll sideways
    const dpr = Math.min(devicePixelRatio || 1, 2), w = document.documentElement.clientWidth, h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    cells = [];
    if (w >= 700) for (let r = 0; r < Math.ceil(h / FIELD.h); r++) for (let c = 0; c < Math.ceil(w / FIELD.w); c++)   // under 700 px a page has no margin for it
      cells.push({ hx: c * FIELD.w + FIELD.w / 2, hy: r * FIELD.h + FIELD.h / 2, ox: 0, oy: 0, vx: 0, vy: 0, ch: pick(LIGHT), fade: 0, to: 0 });
    ground.read(); aim(true); draw();
  }
  // where each glyph may be, for where the page now is
  function aim(now) {
    ground.move();
    for (const c of cells) { c.to = ground.at(c.hx, c.hy); if (now || calm) c.fade = c.to; }
    moved = false;
  }
  function physics() {
    if (ptr.px > -9000) { ptr.vx = ptr.vx * 0.5 + (ptr.x - ptr.px) * 0.5; ptr.vy = ptr.vy * 0.5 + (ptr.y - ptr.py) * 0.5; }   // the pointer's speed, for the sweep
    ptr.px = ptr.x; ptr.py = ptr.y;
    for (const g of rings) { g.r += 14; g.life -= 1; }
    for (let i = rings.length - 1; i >= 0; i--) if (rings[i].life <= 0) rings.splice(i, 1);
    const R = FIELD.reach, R2 = R * R;
    let moving = rings.length > 0;
    for (const c of cells) {
      if (c.fade !== c.to) { c.fade += (c.to - c.fade) * 0.22; if (Math.abs(c.to - c.fade) < 0.01) c.fade = c.to; else moving = true; }
      if (c.fade <= 0 && !c.ox && !c.oy) continue;
      const x = c.hx + c.ox, y = c.hy + c.oy;
      if (ptr.on) {
        const dx = x - ptr.x, dy = y - ptr.y, d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 0.01) { const d = Math.sqrt(d2), f = (1 - d / R) ** 2; c.vx += (dx / d) * f * 3.2 + ptr.vx * f * 0.12; c.vy += (dy / d) * f * 3.2 + ptr.vy * f * 0.12; }
      }
      for (const g of rings) {
        const dx = x - g.x, dy = y - g.y, d = Math.hypot(dx, dy) || 1, band = Math.abs(d - g.r);
        if (band < 26) { const f = (1 - band / 26) * (g.life / 40) * 4; c.vx += (dx / d) * f; c.vy += (dy / d) * f; }
      }
      c.vx = (c.vx - c.ox * 0.07) * 0.84; c.vy = (c.vy - c.oy * 0.07) * 0.84;   // the spring home, then the damping
      c.ox += c.vx; c.oy += c.vy;
      if (Math.abs(c.vx) + Math.abs(c.vy) + Math.abs(c.ox) + Math.abs(c.oy) > 0.05) moving = true;
      else c.ox = c.oy = c.vx = c.vy = 0;
    }
    return moving;
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = FIELD.font;
    for (const c of cells) {
      if (c.fade < 0.02) continue;
      const off = Math.hypot(c.ox, c.oy), speed = Math.hypot(c.vx, c.vy);
      const ch = speed > 0.9 ? strokeOf(c.vx, c.vy) : off > 3 ? strokeOf(c.ox, c.oy) : c.ch;
      ctx.fillStyle = `rgba(${rgb},${Math.min(0.5, 0.06 + off * 0.006 + speed * 0.02) * c.fade})`;   // barely there at rest, brighter as it moves
      ctx.fillText(ch, c.hx + c.ox, c.hy + c.oy);
    }
  }
  function tick(now) {
    raf = requestAnimationFrame(tick);
    const resting = now > awake;   // nothing has moved for a while: only the re-rolls are left to draw, and they need few frames
    if (now - last < 1000 / (resting ? FIELD.rest : FIELD.fps) - 2) return;
    last = now;
    if (moved) aim(false);
    if (physics()) awake = now + 600;
    for (let i = 0; i < cells.length * (resting ? 0.04 : 0.01); i++) { const c = cells[(Math.random() * cells.length) | 0]; if (c && Math.abs(c.ox) + Math.abs(c.oy) < 1) c.ch = pick(LIGHT); }   // only glyphs at rest
    draw();
  }
  const wake = () => { awake = performance.now() + 600; };
  const onMove = (e) => { if (ptr.px < -9000) { ptr.px = e.clientX; ptr.py = e.clientY; } ptr.x = e.clientX; ptr.y = e.clientY; ptr.on = true; wake(); };
  const onLeave = () => { ptr.on = false; ptr.vx = ptr.vy = 0; };
  const onDown = (e) => { rings.push({ x: e.clientX, y: e.clientY, r: 0, life: 40 }); wake(); };
  const onHide = () => { cancelAnimationFrame(raf); if (!document.hidden && !calm) raf = requestAnimationFrame(tick); };
  // the page has moved under the field. With motion reduced there is no loop: the field is laid again where it may now be, and left.
  const onScroll = () => { moved = true; wake(); if (calm) { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { aim(true); draw(); }); } };
  // a page's content can come after the field is laid (its own script puts it in, a font arrives): what the page holds is read again a moment after its size changes
  // (measured when the browser is idle, so reading the page never takes a turn from the page's own work: a form answering what was typed comes first)
  const whenIdle = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 1000 }) : (f) => setTimeout(f, 0), cancelIdle = window.cancelIdleCallback || clearTimeout;
  const reread = () => { clearTimeout(later); cancelIdle(idle); later = setTimeout(() => { idle = whenIdle(() => { ground.read(); onScroll(); }); }, 250); };
  const grown = new ResizeObserver(reread);
  resize();
  addEventListener('resize', resize); addEventListener('scroll', onScroll, { passive: true }); addEventListener('load', reread);
  grown.observe(document.body);
  if (!calm) {
    addEventListener('pointermove', onMove, { passive: true }); addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('pointerleave', onLeave); addEventListener('blur', onLeave); document.addEventListener('visibilitychange', onHide);
    raf = requestAnimationFrame(tick);
  }
  return () => {
    grown.disconnect(); clearTimeout(later); cancelIdle(idle);
    cancelAnimationFrame(raf); removeEventListener('resize', resize); removeEventListener('scroll', onScroll); removeEventListener('load', reread);
    removeEventListener('pointermove', onMove); removeEventListener('pointerdown', onDown);
    document.removeEventListener('pointerleave', onLeave); removeEventListener('blur', onLeave); document.removeEventListener('visibilitychange', onHide);
  };
}

// ── a picture in glyphs ──
// `paint(ctx, w, h)` is ordinary canvas paint on black. It is drawn at one pixel for each glyph cell, so the browser averages
// each cell, and each cell becomes a glyph as dense as its paint is bright. Grey paint (an off-white too) takes the page's ink; coloured paint
// keeps its hue at full strength, with its brightness carried by the glyph and its alpha. A few cells move one step along the
// ramp every 150 ms, never more, so the shading holds. Returns { again(), stop() }.
const ART = { w: 4, h: 7, font: `7px ${MONO}`, levels: 8, floor: 0.22, cutoff: 0.07, grey: 12 };
function picture(canvas, paint) {
  const ctx = canvas.getContext('2d'), rgb = ink(), inks = new Map();
  const inkOf = (c) => inks.get(c) || inks.set(c, Array.from({ length: ART.levels }, (_, i) => `rgba(${c},${(ART.floor + ((1 - ART.floor) * (i + 1)) / ART.levels).toFixed(2)})`)).get(c);
  let cells = [], grid = null, seen = false;
  function draw() {
    if (!grid) return;
    ctx.setTransform(grid.dpr, 0, 0, grid.dpr, 0, 0); ctx.clearRect(0, 0, grid.w, grid.h);
    ctx.font = ART.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of cells) { ctx.fillStyle = c.style; ctx.fillText(RAMP[c.at], c.x, c.y); }
  }
  function build() {
    const box = canvas.getBoundingClientRect(), w = Math.round(box.width), h = Math.round(box.height);
    if (!w || !h) { grid = null; return; }
    const dpr = Math.min(2, devicePixelRatio || 1), cols = Math.floor(w / ART.w), rows = Math.floor(h / ART.h);
    canvas.width = w * dpr; canvas.height = h * dpr;
    grid = { w, h, dpr };
    const small = Object.assign(document.createElement('canvas'), { width: cols, height: rows }), s = small.getContext('2d', { willReadFrequently: true });
    s.fillStyle = '#000'; s.fillRect(0, 0, cols, rows);
    s.scale(cols / w, rows / h);
    paint(s, w, h);
    const px = s.getImageData(0, 0, cols, rows).data, padX = (w - cols * ART.w) / 2, padY = (h - rows * ART.h) / 2;
    cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4, R = px[i], G = px[i + 1], B = px[i + 2], peak = Math.max(R, G, B), light = peak / 255;
      if (light < ART.cutoff) continue;
      const base = Math.min(RAMP.length - 1, Math.floor(light * RAMP.length));
      const hue = peak - Math.min(R, G, B) < Math.max(ART.grey, peak * 0.12) ? rgb : [R, G, B].map((v) => Math.round((v / peak) * 255)).join(',');
      cells.push({ x: padX + c * ART.w + ART.w / 2, y: padY + r * ART.h + ART.h / 2, style: inkOf(hue)[Math.min(ART.levels - 1, Math.floor(light * ART.levels))], base, at: base });
    }
    draw();
  }
  build();
  const sized = new ResizeObserver(build), shown = new IntersectionObserver(([e]) => { seen = !!e?.isIntersecting; });
  sized.observe(canvas); shown.observe(canvas);
  const timer = still() ? 0 : setInterval(() => {
    if (!seen || document.hidden || !cells.length) return;
    for (let n = Math.ceil(cells.length * 0.025); n > 0; n--) { const c = cells[(Math.random() * cells.length) | 0]; c.at = Math.max(0, Math.min(RAMP.length - 1, c.base + ((Math.random() * 3) | 0) - 1)); }
    draw();
  }, 150);
  return { again: build, stop() { sized.disconnect(); shown.disconnect(); clearInterval(timer); } };
}

// ── the uses ──
const root = document.documentElement;
export function start() {
  const page = root.dataset.page;
  // a page with a ground of its own (the SPX page, FACE) is left alone, as the shared palette leaves it
  const own = page === 'spx' || !!document.querySelector('.sm-p a[href="/face/"][aria-current="page"]');
  const front = !own && (!page || page === 'tac') && !!document.querySelector('#hx');
  const pieces = [];   // each piece is made again when the colour scheme changes, since its ink is the page's
  const ends = [];     // and taken away when the skin changes
  const piece = (make) => { let stop = make(); pieces.push(() => { stop?.(); stop = make(); }); ends.push(() => stop?.()); };
  const scheme = matchMedia('(prefers-color-scheme: dark)'), again = () => pieces.forEach((a) => a());
  if (!own) { scheme.addEventListener('change', again); ends.push(() => scheme.removeEventListener('change', again)); }
  let over = false;   // set once stopped, so a mark still being read does not put a canvas back

  // a mark's pixels at 192 px, read once for each mark: one of the page's own symbols (#tk-…, #i-…), or the image a token outside that set has
  const marks = new Map();
  const read = (key) => marks.get(key) || marks.set(key, new Promise((done) => {
    const img = new Image(), n = 192;
    img.onload = () => { const c = Object.assign(document.createElement('canvas'), { width: n, height: n }), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, n, n); done({ c, x, n }); };
    img.onerror = () => done(null);
    const sym = key.startsWith('#') ? document.querySelector(key) : null;
    if (key.startsWith('#') && !sym) return done(null);
    img.src = sym ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${sym.getAttribute('viewBox') || '0 0 32 32'}" width="${n}" height="${n}">${sym.innerHTML}</svg>`) : key;
  })).get(key);
  const span = (d, i) => { const hi = Math.max(d[i], d[i + 1], d[i + 2]), lo = Math.min(d[i], d[i + 1], d[i + 2]); return { hi, lo, sat: hi ? (hi - lo) / hi : 0 }; };
  // the mark as paint for the glyphs, so its figure is what reads. Three kinds of mark, told by how much of it is strong colour
  // and how much is white: a coloured disc with a pale figure (Bitcoin, Ethereum, USDC) has the disc dimmed by how saturated
  // each point is; a white disc with a coloured figure (cbBTC) keeps the disc at a middling weight and pushes each coloured
  // point to its pure hue; a coloured figure on a dark disc (TAC, tETH, the key) is left as it is.
  const paints = new Map();
  const paintOf = (key) => paints.get(key) || paints.set(key, read(key).then((m) => {
    if (!m) return null;
    const c = Object.assign(document.createElement('canvas'), { width: m.n, height: m.n }), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(m.c, 0, 0);
    const px = x.getImageData(0, 0, m.n, m.n), d = px.data;
    let strong = 0, pale = 0, all = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 128) continue; all++; const p = span(d, i); if (p.hi > 90 && p.sat > 0.45) strong++; else if (p.hi > 200) pale++; }
    const whiteDisc = pale / Math.max(1, all) > 0.45, colourDisc = !whiteDisc && strong / Math.max(1, all) > 0.3;
    if (whiteDisc || colourDisc) for (let i = 0; i < d.length; i += 4) {
      const p = span(d, i);
      if (whiteDisc) { const s = Math.min(1, p.sat * 1.25), pure = p.lo * 0.85 * s, top = p.hi - pure, k = top > 0 ? ((0.52 + 0.48 * s) * 255) / top : 0; d[i] = (d[i] - pure) * k; d[i + 1] = (d[i + 1] - pure) * k; d[i + 2] = (d[i + 2] - pure) * k; }
      else { const k = Math.max(0.36, 1 - 0.78 * p.sat); d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; }
    }
    x.putImageData(px, 0, 0);
    return c;
  })).get(key);

  // 1. the field, behind the whole page. It keeps off whatever the page holds: the header and the footer across the full
  // width, and every box of content, with a soft edge so it thins out towards them. What a page holds is read from the page
  // itself, in the page's own coordinates, and only moved by the scroll after that: a thing with a ground or an edge of its
  // own (a card, a button, an image) is one box; words are measured as they are set, not as the block that holds them; and
  // anything else is looked into. Under 700 px there is no margin for a field, and it is off.
  if (!own) {
    const SOFT = [10, 160], SKIP = 'header.top, canvas, dialog, script, style, template, noscript, [hidden], [popover]', WHOLE = /^(IMG|SVG|VIDEO|BUTTON|INPUT|SELECT|TEXTAREA|IFRAME|TABLE|HR)$/i;
    const head = document.querySelector('header.top'), words = document.createRange();
    let boxes = [], near = [], top = 0, w = 0;
    const ground = {
      read() {
        w = root.clientWidth; boxes = [];
        const sx = scrollX, sy = scrollY; let n = 0;
        const box = (r) => boxes.push([r.left + sx, r.top + sy, r.right + sx, r.bottom + sy]);
        const walk = (el, depth) => {
          for (const c of el.children) {
            if (c.matches(SKIP)) continue;
            const r = c.getBoundingClientRect();
            if (!r.width || !r.height || r.right <= 0 || r.left >= w || r.bottom + sy <= 0) continue;
            const cs = getComputedStyle(c);
            if (cs.position === 'fixed' || cs.visibility === 'hidden' || (depth === 0 && cs.position === 'absolute')) continue;
            if (c.matches('footer')) { boxes.push([0, r.top + sy, w, r.bottom + sy]); continue; }
            const solid = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none' || (parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderLeftWidth) > 0) || WHOLE.test(c.tagName);
            if (solid || depth >= 8 || ++n > 1500) { box(r); continue; }
            if ([...c.childNodes].some((t) => t.nodeType === 3 && t.nodeValue.trim())) { words.selectNodeContents(c); const t = words.getBoundingClientRect(); if (t.width && t.height) box(t); continue; }
            walk(c, depth + 1);
          }
        };
        walk(document.body, 0);
      },
      // the boxes on screen now, in the window's coordinates, and how far down the header reaches
      move() {
        const sx = scrollX, sy = scrollY, reach = SOFT[0] + SOFT[1], h = innerHeight;
        near = [];
        for (const b of boxes) if (b[3] - sy > -reach && b[1] - sy < h + reach) near.push([b[0] - sx, b[1] - sy, b[2] - sx, b[3] - sy]);
        top = head ? Math.max(0, head.getBoundingClientRect().bottom + 8) : 0;
      },
      at(x, y) {
        if (y < top) return 0;
        let f = 1;
        for (const b of near) {
          const dx = x < b[0] ? b[0] - x : x > b[2] ? x - b[2] : 0, dy = y < b[1] ? b[1] - y : y > b[3] ? y - b[3] : 0;
          const v = ((dx && dy ? Math.hypot(dx, dy) : dx + dy) - SOFT[0]) / SOFT[1];
          if (v < f) { if (v <= 0) return 0; f = v; }
        }
        return f;
      },
    };
    const under = canvasOf('gx-field');
    document.body.prepend(under);
    piece(() => field(under, ground));
    ends.push(() => under.remove());
  }

  // 2. the menu: Tacit's own mark, struck across the foot of the panel and running off its corner
  const panel = own ? null : document.querySelector('header.top .sm-p');
  if (panel && document.querySelector('#tk-tac')) {
    const stamp = canvasOf('gx-stamp');
    panel.append(stamp);
    ends.push(() => stamp.remove());
    paintOf('#tk-tac').then((paint) => {
      if (!paint || over) return stamp.remove();
      const strike = (ctx, w, h) => { const d = Math.min(w * 0.7, 152); ctx.translate(w - d * 0.34, h - d * 0.36); ctx.rotate(-0.3); ctx.drawImage(paint, -d / 2, -d / 2, d, d); };
      piece(() => picture(stamp, strike).stop);
    });
  }

  if (front) {
    // 4. the cipher: a seamless tile, 20 glyphs by 7, handed to the stylesheet as --cipher. A few of its glyphs move one step
    // every 700 ms while a private side is on screen; the new tile is put in place only once the browser has decoded it.
    piece(() => {
      const T = { w: 11, h: 18, cols: 20, rows: 7 }, c = Object.assign(document.createElement('canvas'), { width: T.w * T.cols * 2, height: T.h * T.rows * 2 }), ctx = c.getContext('2d');
      const at = Array.from({ length: T.cols * T.rows }, () => (Math.random() * LIGHT.length) | 0), rgb = ink(), strong = matchMedia('(prefers-color-scheme: dark)').matches ? 0.11 : 0.14;
      const draw = () => {
        ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
        ctx.font = `11px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = `rgba(${rgb},${strong})`;
        at.forEach((g, i) => ctx.fillText(LIGHT[g], (i % T.cols) * T.w + T.w / 2, Math.floor(i / T.cols) * T.h + T.h / 2));
        const url = c.toDataURL(), img = new Image();
        img.onload = () => { if (!over) document.documentElement.style.setProperty('--cipher', `url(${url})`); };      // (not once stopped: the tile can decode after)
        img.src = url;
      };
      draw();
      const timer = still() ? 0 : setInterval(() => {
        if (document.hidden || !document.querySelector('.swc .f.priv, .swc .f .where.priv')) return;
        for (let n = 4; n > 0; n--) { const i = (Math.random() * at.length) | 0; at[i] = Math.max(0, Math.min(LIGHT.length - 1, at[i] + (Math.random() < 0.5 ? -1 : 1))); }
        draw();
      }, 700);
      return () => clearInterval(timer);
    });
    ends.push(() => root.style.removeProperty('--cipher'));

    // 3. the stamp, and the light behind each side. Both are read from the asset's own mark (the page's #tk-… symbol, or the
    // image a token outside that set has), so every asset the card can name is covered and none is listed or redrawn by hand.
    // The card redraws itself, so the one canvas is put back into the current "To" side whenever the card changes.
    const card = document.querySelector('#hx');
    if (card) {
      const stamp = canvasOf('gx-stamp');
      let art = null, shown = '', paint = null;
      // the side a move goes into is the one after the arrow between the two ("To", "You earn"); it is stamped when it names an asset
      const toSide = () => [...card.querySelectorAll('.swc .mid + .f')].find((f) => f.offsetParent && f.querySelector('.coin')) || null;
      const markOf = (f) => { const c = f?.querySelector('.coin'); return c?.querySelector('svg.tk use')?.getAttribute('href') || c?.querySelector('img.tk')?.getAttribute('src') || ''; };
      // the asset's colour: the average of its mark's strongly coloured points. A mark with no colour in it gives none.
      const tones = new Map();
      const toneOf = (key) => tones.get(key) || tones.set(key, read(key).then((m) => {
        if (!m) return '';
        const d = m.x.getImageData(0, 0, m.n, m.n).data;
        let r = 0, g = 0, b = 0, k = 0;
        for (let i = 0; i < d.length; i += 4) { const p = span(d, i); if (d[i + 3] >= 128 && p.hi > 90 && p.sat > 0.45) { r += d[i]; g += d[i + 1]; b += d[i + 2]; k++; } }
        return k > 40 ? `rgb(${Math.round(r / k)},${Math.round(g / k)},${Math.round(b / k)})` : '';
      })).get(key);
      // right of centre, turned about 22° clockwise, and a quarter taller than the side, so its disc runs off the edge like a stamp that missed the paper;
      // never wider than six tenths of the side, so on a narrow phone it stays clear of the amount
      const strike = (ctx, w, h) => { if (!paint) return; const d = Math.min(Math.max(h * 1.275, 133), w * 0.6); ctx.translate(w * 0.66, h * 0.5); ctx.rotate(0.38); ctx.drawImage(paint, -d / 2, -d / 2, d, d); };
      const place = () => {
        for (const f of card.querySelectorAll('.swc .f')) {   // the light behind each side
          const key = markOf(f);
          if (key && f.dataset.gxTone !== key) { f.dataset.gxTone = key; toneOf(key).then((t) => { if (t && f.dataset.gxTone === key) f.style.setProperty('--tone', t); }); }
        }
        const f = toSide(), key = markOf(f);
        if (!f || !key) { stamp.remove(); return; }
        if (stamp.parentNode !== f) f.append(stamp);
        if (key === shown) return;
        shown = key;
        paintOf(key).then((p) => { if (shown !== key || over) return; paint = p; if (art) art.again(); else art = picture(stamp, strike); });
      };
      const watch = new MutationObserver(place);
      watch.observe(card, { childList: true, subtree: true });
      place();
      pieces.push(() => { art?.stop(); art = paint ? picture(stamp, strike) : null; });
      ends.push(() => { watch.disconnect(); art?.stop(); stamp.remove(); for (const f of card.querySelectorAll('.swc .f[data-gx-tone]')) { delete f.dataset.gxTone; f.style.removeProperty('--tone'); } });
    }

    // 5. the way in. Tacit's own mark is struck across the wallet sheet's ways to sign in, seen through the rows. A way that is pointed at or
    // focused takes its own mark (Ethereum's, Bitcoin's, a key) struck across that row alone, as the card's "To" side takes its asset's; the
    // row is solid while it does, so the sheet's mark does not show through it. The stylesheet shows the sheet's canvas only while the ways in
    // are on the sheet.
    const sheet = document.querySelector('#sheet-wallet .sheet-in');
    if (sheet) {
      const stamp = canvasOf('gx-stamp'), way = canvasOf('gx-stamp gx-way');
      let art = null, paint = null, wart = null, wpaint = null, row = null, want = null, timer = 0;
      sheet.append(stamp);
      // the sheet's: lower right, turned as the card's stamp is, running off the sheet's edge
      const strike = (ctx, w, h) => { if (!paint) return; const d = Math.min(w * 0.66, h * 0.7, 340); ctx.translate(w - d * 0.36, h * 0.6); ctx.rotate(0.38); ctx.drawImage(paint, -d / 2, -d / 2, d, d); };
      paintOf(document.querySelector('#tk-tac') ? '#tk-tac' : '#i-key').then((p) => { if (!p || over) return; paint = p; art = picture(stamp, strike); });
      // a row's: right of centre, a quarter taller than the row so its disc runs off the row's edges, never wider than half the row
      const wstrike = (ctx, w, h) => { if (!wpaint) return; const d = Math.min(Math.max(h * 1.275, 96), w * 0.5); ctx.translate(w * 0.8, h * 0.5); ctx.rotate(0.38); ctx.drawImage(wpaint, -d / 2, -d / 2, d, d); };
      const rowOf = (el) => el?.closest?.('#ws-in .opt') || null;
      const markOf = (r) => r?.querySelector('svg.tk use, svg use')?.getAttribute('href') || '';
      // a short wait before a change, so a pointer crossing the rows does not flick through every mark
      const show = (el) => {
        const r = rowOf(el), key = markOf(r);
        want = key ? r : null; clearTimeout(timer);
        timer = setTimeout(() => {
          if (!want) { way.remove(); row = null; return; }
          if (want === row && way.parentNode === row) return;
          paintOf(key).then((p) => {
            if (!p || over || want !== r) return;
            row = r; wpaint = p; r.append(way);
            if (wart) wart.again(); else wart = picture(way, wstrike);
          });
        }, row ? 60 : 0);
      };
      const onOver = (e) => show(e.target), onLeave = () => show(document.activeElement);
      sheet.addEventListener('pointerover', onOver);
      sheet.addEventListener('pointerleave', onLeave);
      sheet.addEventListener('focusin', onOver);
      pieces.push(() => { art?.stop(); art = paint ? picture(stamp, strike) : null; wart?.stop(); wart = wpaint && way.parentNode ? picture(way, wstrike) : null; });
      ends.push(() => { clearTimeout(timer); art?.stop(); wart?.stop(); stamp.remove(); way.remove(); sheet.removeEventListener('pointerover', onOver); sheet.removeEventListener('pointerleave', onLeave); sheet.removeEventListener('focusin', onOver); });
    }
  }
  return () => { over = true; ends.splice(0).forEach((end) => end()); };
}
