// A node's avatar: the zOrgz invader its address picks (zOrgz, 0x00000000008835cef3e0d2333695f288ee6b63a6, a 10K onchain collection),
// drawn here the way the contract draws it. Each trait is keccak256(abi.encodePacked(uint256 id, uint256 trait)) % options, as the
// contract's _getTrait, and each shape is the contract's rects, kept as data: [x, y, w, h, colour, opacity?], where the colour is a key
// (p primary, s secondary, a accent, e eye, b background) or a literal. An address draws the picture of the design numbered
// (address mod 10000): only the picture, which says nothing about who holds that token. Tacit's own GPU gets an invader of its own.
import { keccak_256 } from '/vendor/tacit-deps.min.js';

const BG1 = ['000000', '0a0a0a', '1a0a1a', '0a1a0a', '1a0f0a', 'f0f0f0', 'e8e8ff', '1a1a00'];
const BG2 = ['000000', '111111', '0a0a1a', '0a0f0a', '0f0a0a', 'e8e8e8', 'fff8f0', '0f0f00'];
const PRI = ['e8e8e0', 'a0f0a0', 'ffffff', '808080', 'ff6060', '00ffff', 'ffffff', 'ffc0cb'];
const SEC = ['c0c0b0', '60a060', 'f0f0ff', '404040', 'a04040', '008080', '000000', 'ff69b4'];
const ACC = ['ff0000', 'ff00ff', 'ffd700', '00ff00', 'ffff00', 'ff0080', 'ff0000', 'ffffff'];

const ANTENNA = [[16, 8, 4, 4, 'p'], [20, 12, 4, 4, 'p'], [40, 12, 4, 4, 'p'], [44, 8, 4, 4, 'p']];
const BODY = [[16, 16, 32, 4, 'p'], [12, 20, 8, 4, 'p'], [24, 20, 16, 4, 'p'], [44, 20, 8, 4, 'p'], [8, 24, 48, 4, 'p'], [8, 28, 48, 4, 'p'],
  [8, 32, 48, 4, 'p'], [12, 36, 40, 4, 'p'], [16, 40, 32, 4, 'p']];
const LEGS = [[20, 44, 8, 4, 'p'], [36, 44, 8, 4, 'p'], [12, 48, 8, 4, 'p'], [28, 48, 8, 4, 'p'], [44, 48, 8, 4, 'p'], [8, 52, 8, 4, 'p'], [48, 52, 8, 4, 'p']];

// Trait 2: the eyes (neutral, manic, hollow, weeping, third-eye, crossed, void, blessed, cursed, ascended).
const EYES = [
  [[14, 28, 10, 6, 'e'], [40, 28, 10, 6, 'e']],
  [[12, 24, 14, 12, 'e'], [38, 24, 14, 12, 'e'], [16, 26, 4, 4, 'p'], [44, 26, 4, 4, 'p'], [14, 20, 4, 4, 'e'], [46, 20, 4, 4, 'e']],
  [[10, 22, 18, 16, 'e'], [36, 22, 18, 16, 'e']],
  [[14, 26, 10, 8, 'e'], [40, 26, 10, 8, 'e'], [16, 34, 4, 12, 'a'], [16, 46, 4, 6, 'a', '0.6'], [44, 34, 4, 16, 'a'], [44, 50, 4, 4, 'a', '0.4']],
  [[14, 28, 10, 6, 'e'], [40, 28, 10, 6, 'e'], [28, 10, 8, 8, 'a'], [30, 12, 4, 4, 'e']],
  [[14, 26, 4, 4, 'e'], [18, 30, 4, 4, 'e'], [22, 26, 4, 4, 'e'], [18, 22, 4, 4, 'e'], [40, 26, 4, 4, 'e'], [44, 30, 4, 4, 'e'], [48, 26, 4, 4, 'e'], [44, 22, 4, 4, 'e']],
  [[8, 20, 22, 20, '#000'], [34, 20, 22, 20, '#000']],
  [[14, 26, 10, 8, '#fff'], [40, 26, 10, 8, '#fff'], [16, 28, 6, 4, 'a'], [42, 28, 6, 4, 'a']],
  [[12, 24, 14, 10, 'a'], [38, 24, 14, 10, 'a'], [16, 26, 6, 6, '#000'], [42, 26, 6, 6, '#000'], [10, 22, 4, 4, 'a'], [50, 22, 4, 4, 'a']],
  [[8, 20, 20, 16, '#fff', '0.9'], [36, 20, 20, 16, '#fff', '0.9'], [12, 24, 12, 8, 'a'], [40, 24, 12, 8, 'a']],
];
// Trait 3: the mouth (none, flatline, agape, teeth, drool, sewn, smile, grimace, tongue).
const MOUTH = [
  [],
  [[24, 44, 16, 2, 'e']],
  [[22, 42, 20, 10, 'e'], [26, 46, 12, 4, '#200000']],
  [[22, 42, 20, 8, 'e'], [24, 42, 2, 4, 'p'], [28, 42, 2, 4, 'p'], [32, 42, 2, 4, 'p'], [36, 42, 2, 4, 'p']],
  [[26, 44, 12, 4, 'e'], [30, 48, 4, 8, 's'], [30, 56, 4, 4, 's', '0.5']],
  [[22, 44, 20, 2, 'e'], [24, 42, 2, 6, 's'], [28, 42, 2, 6, 's'], [32, 42, 2, 6, 's'], [36, 42, 2, 6, 's']],
  [[22, 44, 20, 4, 'e'], [20, 42, 4, 4, 'e'], [40, 42, 4, 4, 'e']],
  [[20, 42, 24, 6, 'e'], [18, 44, 4, 4, 'e'], [42, 44, 4, 4, 'e'], [24, 42, 3, 3, 'p'], [30, 42, 3, 3, 'p']],
  [[26, 44, 12, 4, 'e'], [30, 46, 8, 10, '#ff6b6b'], [32, 54, 4, 4, '#ff6b6b']],
];
// Trait 4: the aura (none, halo, static, sigil, crown, horns, glitch, tears).
const AURA = [
  [],
  [[20, 2, 24, 4, 'a', '0.8'], [16, 4, 4, 2, 'a', '0.5'], [44, 4, 4, 2, 'a', '0.5'], [24, 0, 16, 2, 'a', '0.6']],
  [[4, 8, 2, 2, 'p', '0.4'], [58, 16, 2, 2, 'p', '0.3'], [2, 44, 2, 2, 'p', '0.5'], [56, 52, 2, 2, 'p', '0.4'], [12, 58, 2, 2, 'p', '0.3'], [50, 6, 2, 2, 'p', '0.5']],
  [[2, 2, 8, 2, 'a', '0.6'], [2, 2, 2, 8, 'a', '0.6'], [54, 2, 8, 2, 'a', '0.6'], [60, 2, 2, 8, 'a', '0.6'], [2, 54, 8, 2, 'a', '0.6'], [2, 54, 2, 8, 'a', '0.6'],
    [54, 60, 8, 2, 'a', '0.6'], [60, 54, 2, 8, 'a', '0.6']],
  [[18, 4, 28, 4, 'a'], [20, 0, 4, 4, 'a'], [30, -2, 4, 6, 'a'], [40, 0, 4, 4, 'a']],
  [[8, 8, 4, 8, 'a'], [4, 4, 4, 8, 'a'], [0, 0, 4, 6, 'a'], [52, 8, 4, 8, 'a'], [56, 4, 4, 8, 'a'], [60, 0, 4, 6, 'a']],
  [[0, 20, 64, 2, 'a', '0.3'], [0, 36, 64, 1, 'p', '0.4'], [4, 24, 20, 2, 'p', '0.2'], [40, 40, 20, 2, 'p', '0.2']],
  [[18, 36, 2, 20, 'a', '0.7'], [18, 56, 2, 6, 'a', '0.4'], [44, 36, 2, 16, 'a', '0.7'], [44, 52, 2, 8, 'a', '0.3']],
];
// Trait 5: the corruption (none, melt, split, scatter, invert, duplicate).
const CORRUPT = [
  [],
  [[10, 52, 4, 8, 'p'], [10, 60, 4, 4, 'p', '0.5'], [24, 52, 6, 10, 'p'], [26, 62, 4, 2, 'p', '0.3'], [46, 52, 4, 12, 'p']],
  [[30, 0, 4, 64, 'b'], [32, 16, 2, 40, 's', '0.5']],
  [[2, 14, 4, 4, 'p'], [58, 22, 4, 4, 'p'], [4, 50, 4, 4, 's'], [56, 46, 4, 4, 's']],
  [[0, 0, 64, 64, 'p', '0.1'], [16, 16, 32, 32, 'b', '0.3']],
  [[4, 20, 6, 4, 'p', '0.4'], [4, 24, 6, 4, 'p', '0.4'], [4, 28, 6, 4, 'p', '0.4'], [54, 20, 6, 4, 'p', '0.4'], [54, 24, 6, 4, 'p', '0.4'], [54, 28, 6, 4, 'p', '0.4']],
];
// Trait 6: the sigil (none, cross, star, eye, spiral, rune).
const SIGIL = [
  [],
  [[30, 54, 4, 8, 'a'], [26, 58, 12, 2, 'a']],
  [[30, 54, 4, 2, 'a'], [28, 56, 8, 2, 'a'], [30, 58, 4, 2, 'a']],
  [[26, 56, 12, 6, 'a'], [30, 58, 4, 2, 'b']],
  [[28, 56, 8, 2, 'a'], [34, 56, 2, 6, 'a'], [28, 60, 6, 2, 'a'], [28, 58, 2, 2, 'a']],
  [[28, 54, 2, 10, 'a'], [34, 54, 2, 10, 'a'], [28, 58, 8, 2, 'a']],
];

const word = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
// zOrgz _getTrait: keccak256(abi.encodePacked(tokenId, traitIndex)) % optionCount.
export function trait(id, index, options) {
  const buf = new Uint8Array(64);
  buf.set(word(id), 0);
  buf.set(word(index), 32);
  const h = keccak_256(buf);
  let x = 0n;
  for (const v of h) x = (x << 8n) | BigInt(v);
  return Number(x % BigInt(options));
}

// The design an address draws: its number mod 10000.
export const idOf = (address) => Number(BigInt(address) % 10000n);

export function traitsOf(id) {
  return { bg: trait(id, 0, 8), pal: trait(id, 1, 8), eyes: trait(id, 2, 10), mouth: trait(id, 3, 9), aura: trait(id, 4, 8), corrupt: trait(id, 5, 6), sigil: trait(id, 6, 6) };
}

function draw(t, c, size) {
  const col = { p: c.p, s: c.s, a: c.a, e: c.e, b: c.b };
  const rects = (list) => list.map(([x, y, w, h, k, op]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${k.startsWith('#') ? k : `#${col[k]}`}"${op ? ` opacity="${op}"` : ''}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" shape-rendering="crispEdges" style="image-rendering:pixelated">`
    + `<defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#${c.b}"/><stop offset="100%" stop-color="#${c.b2}"/></linearGradient></defs>`
    + '<rect width="64" height="64" fill="url(#bg)"/>'
    + rects(CORRUPT[t.corrupt]) + rects(AURA[t.aura]) + rects(ANTENNA) + rects(BODY) + rects(EYES[t.eyes]) + rects(MOUTH[t.mouth]) + rects(LEGS) + rects(SIGIL[t.sigil])
    + '</svg>';
}

// Design #id's picture, as the contract's generateSVG draws it.
export function zorgzSvg(id, size = 512) {
  const t = traitsOf(id), light = t.bg === 5 || t.bg === 6;
  return draw(t, { b: BG1[t.bg], b2: BG2[t.bg], p: PRI[t.pal], s: SEC[t.pal], a: ACC[t.pal], e: light ? '000000' : BG1[t.bg] }, size);
}

// A node's avatar, from its address.
export const invaderSvg = (address, size = 32) => zorgzSvg(idOf(address), size);

// Tacit's own GPU: an orange invader with a third eye and a crown, on black.
export const gpuSvg = (size = 32) => draw({ corrupt: 0, aura: 4, eyes: 4, mouth: 1, sigil: 0 },
  { b: '000000', b2: '111111', p: 'f7931a', s: 'a05a00', a: 'ffffff', e: '000000' }, size);
