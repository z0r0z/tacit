// QR codes for the pay pages (/pay/ and /pay/eth/): a payment link or an address, drawn as an SVG. Byte mode, error
// correction level M (versions 1–40), after Project Nayuki's reference construction.

// qrModules(text) → rows of booleans (true = dark), without the quiet zone.
function qrModules(text) {
  const ECC = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  const raw = (v) => { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; };
  const dataCw = (v) => Math.floor(raw(v) / 8) - ECC[v] * BLOCKS[v];
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  while (4 + (ver <= 9 ? 8 : 16) + 8 * bytes.length > dataCw(ver) * 8) if (++ver > 40) throw new Error('too long for a QR code');
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16); for (const b of bytes) put(b, 8);
  const cap = dataCw(ver) * 8;
  put(0, Math.min(4, cap - bits.length)); put(0, (8 - (bits.length % 8)) % 8);
  for (let p = 0xec; bits.length < cap; p ^= 0xec ^ 0x11) put(p, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const mul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
  const div = Array(ECC[ver]).fill(0); div[div.length - 1] = 1;
  for (let i = 0, root = 1; i < div.length; i++, root = mul(root, 2)) for (let j = 0; j < div.length; j++) { div[j] = mul(div[j], root); if (j + 1 < div.length) div[j] ^= div[j + 1]; }
  const rem = (d) => { const r = div.map(() => 0); for (const b of d) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= mul(c, f); }); } return r; };
  const nb = BLOCKS[ver], rawCw = Math.floor(raw(ver) / 8), nShort = nb - (rawCw % nb), shortLen = Math.floor(rawCw / nb);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - ECC[ver] + (i < nShort ? 0 : 1));
    k += d.length;
    const e = rem(d);
    if (i < nShort) d.push(0);
    blocks.push(d.concat(e));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ECC[ver] || j >= nShort) cw.push(b[i]); });

  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => Array(size).fill(false));
  const fn = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
    if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
  }
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    pos.forEach((x, i) => pos.forEach((y, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
  }
  const format = (mask) => {
    const d = mask;                                           // level M is 00
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, d); set(c, a, d); }
  }
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && i < cw.length * 8) { m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const flip = (k) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASK[k](x, y)) m[y][x] = !m[y][x]; };
  const penalty = () => {
    let p = 0, dark = 0;
    const lines = [];
    for (let y = 0; y < size; y++) { lines.push(m[y].map((d) => (d ? 1 : 0)).join('')); lines.push(m.map((r) => (r[y] ? 1 : 0)).join('')); }
    for (const l of lines) {
      for (const run of l.match(/0{5,}|1{5,}/g) || []) p += run.length - 2;
      p += 40 * ((l.match(/(?=00001011101)/g) || []).length + (l.match(/(?=10111010000)/g) || []).length);
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x < size - 1 && y < size - 1 && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    }
    return p + 10 * Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size));
  };
  let best = 0, low = Infinity;
  for (let k = 0; k < 8; k++) { flip(k); format(k); const s = penalty(); if (s < low) { low = s; best = k; } flip(k); }
  flip(best); format(best);
  return m;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// The code at a whole number of pixels per module, so every module is the same size on screen and a camera or a
// desktop decoder reads it; drawn at the width it is given, or at the box's width when that leaves under 3 px a module.
// → the SVG's markup.
export function qrSvg(text, width = 0, label = 'QR code of the payment link') {
  const m = qrModules(text), n = m.length, Q = 4, W = n + 2 * Q, px = Math.floor(Math.min(width, 360) / W);
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + Q} ${y + Q}h1v1h-1z`;
  const size = px >= 3 ? `width:${W * px}px;height:${W * px}px` : 'width:100%;height:auto';
  return `<svg class="qr" style="${size}" viewBox="0 0 ${W} ${W}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect width="${W}" height="${W}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}
