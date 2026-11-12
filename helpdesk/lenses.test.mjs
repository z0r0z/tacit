// node lenses.test.mjs -- Tacit's review lenses (where each has something to look at) and the planted bugs (one realistic mistake per kind, still valid code)
import { LENSES, LENS, PRIMER, sites, snippet } from './codecheck/lenses.mjs';
import { MUTATIONS, mask, plant, parses } from './codecheck/mutate.mjs';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

// --- lenses
check('every lens has an id, a title, a question and patterns', LENSES.length >= 8 && LENSES.every((l) => l.id && l.title && l.ask.endsWith('?') && l.sites.length && l.sites.every((r) => r instanceof RegExp)));
check('the primer names the units and the byte order Tacit has been bitten by', /sats/.test(PRIMER) && /wei/.test(PRIMER) && /decimals/.test(PRIMER) && /little-endian/.test(PRIMER) && LENS.units.id === 'units');
const SRC = [
  '// the amount is in wei: Number(x) here would lose precision',   // 1: a comment, never a site
  'const a = Number(wei) / 1e18;',                                   // 2: bigint + units
  'let ok = true;',
  'for (let i = 0; i < 40; i++) { ok = ok && true; }',
  'el.innerHTML = text;',                                             // 5: untrusted
  ...Array.from({ length: 30 }, (_, i) => `const filler${i} = ${i};`),
  'const r = await fetch(url);',                                      // 36: async
  'if (net === "signet") use(chainId);',                              // 37: network
].join('\n');
{
  const s = sites(SRC);
  const by = (lens) => s.filter((x) => x.lens === lens);
  check('a line a lens knows about gets a snippet of that lens', by('bigint').length === 1 && by('units').length === 1 && by('untrusted').length === 1 && by('async').length === 1 && by('network').length === 1);
  check('a comment is not a site', !s.some((x) => x.lens === 'bigint' && x.line === 1) && by('bigint')[0].line === 2);
  check('a snippet is the line and eight either side, numbered from the file', by('untrusted')[0].start === 1 && by('untrusted')[0].end === 13 && by('untrusted')[0].text.split('\n')[4] === '5: el.innerHTML = text;');
  check('snippets of one lens that touch are one snippet', sites('a\nNumber(1)\nNumber(2)\nb\nc\n'.repeat(1)).filter((x) => x.lens === 'bigint').length === 1);
  check('code that several lenses meet comes first', s[0].weight >= s[s.length - 1].weight && s[0].weight > 1);
  const lopsided = ['x = Number(1);', ...Array.from({ length: 60 }, (_, i) => `const pad${i} = ${i};`), 'const wei = Number(v) / 1e18; el.innerHTML = t;'].join('\n');
  const ls = sites(lopsided);
  check('a heavy snippet later in the file comes before a light one at the top', ls[0].start > 40 && ls[0].weight > ls[ls.length - 1].weight && ls[ls.length - 1].start === 1);
  check('a lens with no match has no site', !sites('const a = 1;\nconst b = 2;').length);
  const many = Array.from({ length: 400 }, (_, i) => `x${i} = Number(${i});` + '\n'.repeat(30)).join('');
  check('one lens in one file is capped', sites(many, { perLens: 5 }).filter((x) => x.lens === 'bigint').length === 5);
  const dense = Array.from({ length: 300 }, (_, i) => `x${i} = Number(${i});`).join('\n');
  const ds = sites(dense).filter((x) => x.lens === 'bigint');
  check('dense code is cut into snippets of at most 40 lines, none left out', ds.length > 5 && ds.every((x) => x.end - x.start + 1 <= 40) && ds[0].start === 1 && ds.slice(1).every((x, i) => x.start <= ds[i].end + 1));
  check('the span is a setting', sites(dense, { maxSpan: 20 }).filter((x) => x.lens === 'bigint').every((x) => x.end - x.start + 1 <= 20));
  check('snippet() numbers lines and clamps to the file', snippet('a\nb\nc', 0, 99) === '1: a\n2: b\n3: c');
}

// --- masking
check('mask blanks strings and a trailing comment, nothing else', mask('a >= "b >= c" // d >= e') === 'a >= "' + '\0'.repeat(6) + '" ' + '\0'.repeat(9) && mask('x = 1 > 2') === 'x = 1 > 2');
check('the masked line is the same length', [`a >= "b >= c" // d`, "x = 'it\\'s'; y", 'z = `t${a}`'].every((l) => mask(l).length === l.length));
check('an operator inside a string is not matched', plant('const s = "a >= b";\nconst t = 1;', { lens: 'bounds' }) === null);

// --- planting: every mutation kind, once, against a line made for it
const CASES = {
  'ge-to-gt': ['if (a >= b) go();', 'bounds'], 'le-to-lt': ['if (a <= b) go();', 'bounds'], 'gt-to-ge': ['if (a > b) go();', 'bounds'], 'lt-to-le': ['if (a < b) go();', 'bounds'],
  'slice-bound': ['const s = h.slice(2, 10);', 'bounds'], 'index-shift': ['const x = parts[1];', 'bounds'], 'drop-await': ['const r = await get(u);', 'async'],
  'bigint-literal': ['const z = 10n;', 'bigint'], 'bigint-call': ['const z = BigInt(v);', 'bigint'], 'scale': ['const z = v / 1e8;', 'units'], 'pow-scale': ['const z = 10n ** 18n;', 'units'],
  'hex-offset': ['const h = s.slice(2);', 'encoding'], 'pad-width': ['const h = s.padStart(64, "0");', 'encoding'], 'drop-reverse': ['const b = bytes.reverse();', 'encoding'],
  'text-to-html': ['el.textContent = t;', 'untrusted'], 'swap-network': ['const n = "mainnet";', 'network'],
  'eq-to-ne': ['if (a === b) go();', 'any'], 'ne-to-eq': ['if (a !== b) go();', 'any'], 'and-to-or': ['if (a && b) go();', 'any'], 'or-to-and': ['if (a || b) go();', 'any'], 'drop-not': ['if (!a) go();', 'any'],
};
check('every mutation kind has a case here', MUTATIONS.every((m) => CASES[m.kind]) && Object.keys(CASES).length === MUTATIONS.length);
for (const [kind, [line, lens]] of Object.entries(CASES)) {
  const src = `// header\nasync function f() {\n  ${line}\n  return 1;\n}\n`;
  // slice-bound and hex-offset share a line shape: pick the kind by trying until it comes up (the pool is small)
  let got = null; for (let k = 0; k < 12 && !(got && got.kind === kind); k++) got = plant(src, { lens: lens === 'any' ? null : lens, rand: seq(k / 12) });
  check(`plants ${kind}`, !!got && got.kind === kind && got.line === 3 && got.orig.trim() === line && got.mut !== got.orig && got.src.split('\n')[2] === got.mut && parses(got.src) && got.say.length > 10);
}
{
  const src = 'function f(a, b) {\n  if (a >= b) return await_(a);\n  return b;\n}\n';
  const p = plant(src, { lens: 'bounds', rand: () => 0 });
  check('the changed file differs from the original in that one line only', p && src.split('\n').filter((l, i) => l !== p.src.split('\n')[i]).length === 1);
  check('a lens with its own mutations uses them, not the generic ones', plant('function f(a, b) {\n  if (a >= b && b) return 1;\n  return 0;\n}\n', { lens: 'bounds', rand: seq(0.99, 0.5, 0.1) }).lens === 'bounds');
  check('strict plants only the lens\'s own mistakes; otherwise a generic one will do', plant('const x = a && b;\n', { lens: 'bounds', strict: true }) === null && plant('const x = a && b;\n', { lens: 'bounds' })?.kind === 'and-to-or');
  check('a plant never returns code that does not parse', plant('const a = (;\nif (a >= b) go();\n', { lens: 'bounds' }) === null);
  check('a line inside a block comment is not changed', plant('/**\n * true when a >= b\n */\nconst x = 1;\n', { lens: 'bounds' }) === null);
  check('the range is honoured at its end as at its start', plant('const a = x >= 1;\nconst b = y >= 2;\nconst c = z >= 3;\n', { start: 1, end: 1, rand: () => 0.99 }).line === 1 && plant('const a = x >= 1;\nconst b = y >= 2;\nconst c = z >= 3;\n', { start: 3, end: 3, rand: () => 0 }).line === 3);
  check('a range with no line to change gives nothing', plant(src, { start: 3, end: 3, lens: 'bounds' }) === null);
  check('only lines inside the range are changed', plant('const a = x >= 1;\nconst b = y >= 2;\nconst c = z >= 3;\n', { start: 2, end: 2, rand: () => 0 }).line === 2);
  check('a mutation that no longer parses is skipped for another', (() => { const p2 = plant('const a = 1;\nconst b = x > y;\n', { rand: () => 0 }); return !p2 || parses(p2.src); })());
  check('parses says no to broken code and yes to valid code', parses('const a = 1;') && !parses('const a = ;'));
}
console.log(fails ? `${fails} lens/plant test(s) failed` : 'lenses: all tests passed'); process.exit(fails ? 1 : 0);
