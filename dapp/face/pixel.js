// 8-bit drawing for the FACE RACE page, the same 3 x 5 font and alien ghost the sale contract draws on-chain.

const CHARS = '0123456789.,%#XABCDEFGHIKLMNORSTUWYZ/';
const GLYPHS = '7b6f2c9773e772cf5bc979cf79ef72927bef7bcf0002001452a55f7d0aa82bed6bae39236b6e79a779a4396b5bed74975bad49275fed6b6d2b6a6bad388e74925b6f5bfd5a9272a72494';
const glyph = (c) => {
  const i = CHARS.indexOf(c);
  return i < 0 ? 0 : parseInt(GLYPHS.slice(i * 4, i * 4 + 4), 16);
};
// The few lower-case-free letters the page needs beyond the contract's set.
const EXTRA = { J: 0b001001001101111, P: 0b110101110100100, Q: 0b010101101111011, V: 0b101101101101010, '-': 0b000000111000000, '+': 0b000010111010000, ':': 0b000010000010000, '!': 0b010010010000010, '?': 0b111001010000010 };

/** `text` (upper-cased) as an inline SVG of tiles, each font pixel `px` CSS pixels. */
export function pixelText(text, px = 4, cls = '') {
  const t = String(text).toUpperCase();
  let rects = '';
  for (let i = 0; i < t.length; i++) {
    const g = EXTRA[t[i]] ?? glyph(t[i]);
    for (let k = 0; k < 15; k++) if (g & (1 << (14 - k))) rects += `<rect x="${i * 4 + (k % 3)}" y="${(k / 3) | 0}" width=".8" height=".8"/>`;
  }
  const w = Math.max(1, t.length * 4 - 1);
  return `<svg class="px ${cls}" viewBox="0 0 ${w} 5" width="${w * px}" height="${5 * px}" role="img" aria-label="${t.replace(/"/g, '')}" shape-rendering="crispEdges">${rects}</svg>`;
}

const BODY = 0x10104101f03fe3ff99cdfffffffffffffb5bn;
const EYES = 0x6300000000000000000n;
const SHADES = ['#ffffff', '#f0f0f0', '#e2e2e2', '#d4d4d4'];

/** The alien ghost as a tile mosaic, shaded from `seed` (a string), at `cell` CSS pixels a tile. */
export function ghost(seed = 'face', cell = 14) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const next = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; };
  let rects = '';
  for (let r = 0; r < 11; r++) {
    for (let c = 0; c < 13; c++) {
      const bit = 1n << BigInt((10 - r) * 13 + 12 - c);
      const n = next();
      let fill = null;
      if (EYES & bit) fill = n & 1 ? '#ffa940' : '#f7931a';
      else if (BODY & bit) fill = SHADES[n & 3];
      if (fill) rects += `<rect x="${c * 14}" y="${r * 14}" width="12" height="12" fill="${fill}"/>`;
    }
  }
  return `<svg class="ghost" viewBox="0 0 180 152" width="${13 * cell}" height="${11 * cell}" aria-hidden="true" shape-rendering="crispEdges">${rects}</svg>`;
}

/** A row of `n` blocks, `k` of them lit. */
export function blocks(k, n = 24) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<i class="${i < k ? 'on' : ''}"></i>`;
  return `<span class="blocks" aria-hidden="true">${s}</span>`;
}
