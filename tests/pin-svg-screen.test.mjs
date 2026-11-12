// An SVG is pinned as an image only. The screen refuses markup that runs code or loads a page, however it is written, and passes the
// repository's own SVG files (art with gradients, filters, text and animation) as before.
//   node tests/pin-svg-screen.test.mjs
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { magicMatches } from '../worker/src/index.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pass = (svg) => magicMatches(new TextEncoder().encode(svg), 'image/svg+xml');
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">${inner}</svg>`;
let n = 0; const ok = (c, m) => { assert.ok(c, m); console.log('ok  -', m); n++; };

const refused = {
  'a script element': '<script>alert(1)</script>',
  'a script element with a namespace prefix': '<x:script>alert(1)</x:script>',
  'a prefixed element with spaces': '< svg:script >alert(1)</svg:script>',
  'foreignObject': '<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>',
  'an event attribute': '<rect width="1" height="1" onload="alert(1)"/>',
  'javascript: in a link': '<a href="javascript:alert(1)"><rect/></a>',
  'javascript: written with a character reference': '<a xlink:href="&#106;avascript:alert(1)"><rect/></a>',
  'javascript: written with a hex reference': '<a href="&#x6A;avascript:alert(1)"><rect/></a>',
  'javascript: split by a tab reference': '<a href="java&#x09;script:alert(1)"><rect/></a>',
  'javascript: split by a line break': '<a href="java\nscript:alert(1)"><rect/></a>',
  'javascript: with the colon as an entity': '<a href="javascript&colon;alert(1)"><rect/></a>',
  'a data page': '<a href="data:text/html,<script>alert(1)</script>"><rect/></a>',
  'a nested svg document': '<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>',
  'a link set by animation': '<a href="#x"><set attributeName="href" to="https://x"/><rect/></a>',
  'a link set by animation with a prefix': '<a><animate attributeName="xlink:href" values="#a;#b"/></a>',
  'a stylesheet instruction': '<?xml-stylesheet href="http://x/s.css"?><rect/>',
  'a doctype with an entity': '<!DOCTYPE svg [<!ENTITY x "y">]><rect/>',
};
for (const [label, inner] of Object.entries(refused)) ok(pass(inner.startsWith('<?') || inner.startsWith('<!') ? `<?xml version="1.0"?>${inner}<svg xmlns="http://www.w3.org/2000/svg"/>` : wrap(inner)) === false, `refused: ${label}`);

// ordinary art still goes in
ok(pass(wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs><rect fill="url(#g)" filter="url(#f)" width="5" height="5"/>')) === true, 'passed: a gradient and a blur filter');
ok(pass(wrap('<text x="1" y="9" font-size="2">Java script: a note, and javascript: as words</text>')) === true, 'passed: the words "javascript:" in text between elements, which is not an address');
ok(pass(wrap('<style>.a{fill:url(&#106;avascript:x)}</style><rect class="a"/>')) === false, 'refused: a scheme in a stylesheet, written with a reference');
ok(pass(wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect fill="url(#g)" width="5" height="5"/><animate attributeName="opacity" from="0" to="1" dur="1s"/><use href="#g"/>')) === true, 'passed: gradient, animation of opacity, a local link');
ok(pass(wrap('<image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/>')) === true, 'passed: an embedded png');

// the repository's own SVG art
const found = [];
const walk = (dir, depth = 0) => { if (depth > 4) return; for (const e of readdirSync(dir)) { if (e === 'node_modules' || e === '.git' || e === 'target') continue; const p = join(dir, e); const st = statSync(p); if (st.isDirectory()) walk(p, depth + 1); else if (e.endsWith('.svg') && st.size < 400_000) found.push(p); } };
for (const d of ['dapp', 'assets', 'contracts', 'docs', 'whitepaper']) { try { walk(join(ROOT, d)); } catch { /* absent */ } }
const failed = found.filter((f) => { const t = readFileSync(f, 'utf8'); const head = t.slice(0, 256).trim(); return (head.startsWith('<svg') || head.startsWith('<?xml')) && !pass(t); });
ok(found.length > 20, `${found.length} SVG files from the repository were read`);
ok(failed.length === 0, `none of them is refused (${failed.slice(0, 3).map((f) => f.replace(ROOT, '')).join(', ') || 'none'})`);
console.log(`${n} ok`);
process.exit(0);
