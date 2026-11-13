// Planted bugs. One small, realistic mistake of a lens's kind is put into a line of real code (a boundary moved, an await dropped, a BigInt turned into a
// Number), and the result must still parse. The gateway knows exactly what it broke, so a reviewer's answer to it can be marked right or wrong with nobody reading:
// this is how scouts and skeptics are measured, per lens and per size of machine. Strings and comments are masked out first, so only code is changed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const POW = { 6: '8', 8: '18', 18: '8' };
// Each mutation: the lens it belongs to ('any' for the generic ones), a pattern over the masked line, the replacement for one match, and how a reviewer would
// put the problem (the words a real finding of that kind would use).
export const MUTATIONS = [
  { kind: 'ge-to-gt', lens: 'bounds', re: /(?<![=!<>])>=(?!=)/g, to: () => '>', say: 'the boundary is off by one: the value equal to the limit is wrongly rejected' },
  { kind: 'le-to-lt', lens: 'bounds', re: /(?<![=!<>])<=(?!=)/g, to: () => '<', say: 'the boundary is off by one: the value equal to the limit is wrongly rejected' },
  { kind: 'gt-to-ge', lens: 'bounds', re: /(?<![=<>\-])>(?![=>])/g, to: () => '>=', say: 'the comparison lets the value equal to the limit through when it should not' },
  { kind: 'lt-to-le', lens: 'bounds', re: /(?<![=<>!])<(?![=<\/!])/g, to: () => '<=', say: 'the comparison lets the value equal to the limit through when it should not' },
  { kind: 'slice-bound', lens: 'bounds', re: /(\.(?:slice|substring)\(\s*)(\d+)/g, to: (m, a, n) => `${a}${Number(n) + 1}`, say: 'the slice starts one element too late and drops the first one' },
  { kind: 'index-shift', lens: 'bounds', re: /\[(\d+)\]/g, to: (m, n) => `[${Number(n) + 1}]`, say: 'the index is off by one and reads the neighbouring element' },
  { kind: 'drop-await', lens: 'async', re: /\bawait\s+/g, to: () => '', say: 'the call is not awaited, so the next step runs before it finishes and its failure is lost' },
  { kind: 'bigint-literal', lens: 'bigint', re: /\b(\d+)n\b/g, to: (m, n) => n, say: 'a BigInt literal became a Number, which throws when mixed with BigInt values' },
  { kind: 'bigint-call', lens: 'bigint', re: /\bBigInt\(/g, to: () => 'Number(', say: 'the amount goes through Number, which loses precision above 2^53' },
  { kind: 'scale', lens: 'units', re: /\b1e(6|8|18)\b/g, to: (m, p) => `1e${POW[p]}`, say: 'the scale is wrong for this unit: sats and wei differ by ten orders of magnitude' },
  { kind: 'pow-scale', lens: 'units', re: /\b10n\s*\*\*\s*(6|8|18)n\b/g, to: (m, p) => `10n ** ${POW[p]}n`, say: 'the power of ten does not match the unit of the value' },
  { kind: 'hex-offset', lens: 'encoding', re: /\.slice\(\s*2\b/g, to: () => '.slice(1', say: 'the 0x prefix is cut at the wrong offset, so a stray character stays in the value' },
  { kind: 'pad-width', lens: 'encoding', re: /\.padStart\(\s*(64|32)\b/g, to: (m, n) => `.padStart(${n === '64' ? 32 : 64}`, say: 'the zero pad has the wrong width for a 32-byte value' },
  { kind: 'drop-reverse', lens: 'encoding', re: /\.reverse\(\)/g, to: () => '', say: 'the bytes are not reversed, so the id is read in the wrong byte order' },
  { kind: 'text-to-html', lens: 'untrusted', re: /\.textContent\s*=(?!=)/g, to: () => '.innerHTML =', say: 'text that may come from a server is put in the page as HTML without escaping' },
  { kind: 'swap-network', lens: 'network', re: /(['"])(mainnet|signet)\1/g, to: (m, q, n) => `${q}${n === 'mainnet' ? 'signet' : 'mainnet'}${q}`, say: 'the network name is the wrong one, so a main-network value is used on a test network' },
  { kind: 'eq-to-ne', lens: 'any', re: /===/g, to: () => '!==', say: 'the check is inverted' },
  { kind: 'ne-to-eq', lens: 'any', re: /!==/g, to: () => '===', say: 'the check is inverted' },
  { kind: 'and-to-or', lens: 'any', re: /&&/g, to: () => '||', say: 'both conditions are needed here, not either' },
  { kind: 'or-to-and', lens: 'any', re: /(?<!\|)\|\|(?!\|)/g, to: () => '&&', say: 'either condition is enough here, not both' },
  { kind: 'drop-not', lens: 'any', re: /\(!(?=[\w(])/g, to: () => '(', say: 'the condition is the wrong way round' },
];

// the line with the insides of strings, template literals, regex-free comments blanked (same length), so a pattern cannot match inside them
export function mask(line) {
  let out = '', q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\') { out += '\0\0'; i++; continue; } if (c === q) { q = null; out += c; } else out += '\0'; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
    if (c === '/' && line[i + 1] === '/') { out += '\0'.repeat(line.length - i); break; }
    out += c;
  }
  return out;
}
// swap-network works on the quoted word itself, so it reads the unmasked line
const candidatesIn = (line, lens) => {
  const masked = mask(line), out = [];
  for (const m of MUTATIONS) {
    if (m.lens !== 'any' && lens && m.lens !== lens) continue;
    const text = m.kind === 'swap-network' ? line : masked;
    for (const hit of text.matchAll(m.re)) {
      const repl = m.to(...hit);
      const next = line.slice(0, hit.index) + repl + line.slice(hit.index + hit[0].length);
      if (next !== line && next.trim()) out.push({ m, line: next });
    }
  }
  return out;
};

export function parses(src) {
  const d = mkdtempSync(path.join(tmpdir(), 'plant-')), f = path.join(d, 'x.mjs');
  try { writeFileSync(f, src); return spawnSync('node', ['--check', f], { timeout: 20000 }).status === 0; } finally { rmSync(d, { recursive: true, force: true }); }
}

// Put one mistake into a line between start and end (1-based, inclusive). With a lens, that lens's own mutations are tried first and the generic ones only
// if it has none there (never, with strict). -> { src (the changed file), line, orig, mut, kind, lens, say } or null.
export function plant(src, { start = 1, end = Infinity, lens = null, strict = false, rand = Math.random, tries = 8 } = {}) {
  const lines = src.split('\n'), cands = [];
  for (let i = Math.max(1, start) - 1; i < Math.min(lines.length, end); i++) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(lines[i])) continue;
    for (const c of candidatesIn(lines[i], lens)) cands.push({ i, ...c });
  }
  const own = lens ? cands.filter((c) => c.m.lens === lens) : [];
  const pool = own.length || strict ? own : cands;   // strict: only that lens's own mistakes, so the question a scout is asked is the one the bug answers
  for (let t = 0; t < tries && pool.length; t++) {
    const c = pool.splice(Math.floor(rand() * pool.length), 1)[0];
    const next = lines.slice(); next[c.i] = c.line; const out = next.join('\n');
    if (parses(out)) return { src: out, line: c.i + 1, orig: lines[c.i], mut: c.line, kind: c.m.kind, lens: c.m.lens === 'any' ? (lens || 'bounds') : c.m.lens, say: c.m.say };
  }
  return null;
}

// Planted bugs made ahead of time. Making one runs the parser in a separate process, which is too slow to do for every exam a busy gateway hands out, so exams draw
// from this store at random and it is topped up in the background (fill), a few at a time, keeping the newest `size`. An entry names the file, commit and line it
// was made at and the line's two versions, not the whole file: the code is read again (from git's cache) when the exam is made.
export function makePlantPool({ sample, source, size = 300, rand = Math.random }) {
  const pool = [];
  function fill(n = 1) {
    let made = 0;
    for (let t = 0; t < n * 4 && made < n; t++) {
      const s = sample(); if (!s) break;
      let src; try { src = source(s.commit, s.file); } catch { continue; }
      const p = plant(src, { start: s.start, end: s.end, lens: s.lens, strict: true, rand }); if (!p) continue;
      pool.push({ file: s.file, commit: s.commit, start: s.start, end: s.end, lens: s.lens, line: p.line, orig: p.orig, mut: p.mut, kind: p.kind, say: p.say });
      if (pool.length > size) pool.shift();
      made++;
    }
    return made;
  }
  const take = () => (pool.length ? pool[Math.floor(rand() * pool.length)] : null);
  return { fill, take, size: () => pool.length, full: () => pool.length >= size };
}
