// node faq-check.mjs [corpus.json] [faq.json]
// Every FAQ entry names a source doc and the facts its answer relies on. Each fact must appear verbatim (whitespace and case
// ignored) in that doc's text in the corpus, so the FAQ cannot say something the docs don't. Exit 1 on any miss.
import { readFileSync } from 'node:fs';
const [, , cf = 'corpus.json', ff = 'faq.json'] = process.argv;
const corpus = JSON.parse(readFileSync(cf, 'utf8')).chunks, faq = JSON.parse(readFileSync(ff, 'utf8'));
const norm = (s) => s.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ');
const docText = {}; for (const c of corpus) { const f = c.title.split(' > ')[0]; docText[f] = (docText[f] || '') + ' ' + norm(c.text); }
let bad = 0;
for (const e of faq) {
  const srcs = [].concat(e.src); const t = srcs.map((s) => docText[s] || '').join(' '); if (!t.trim()) { console.log(`NO DOC ${srcs} for "${e.q}"`); bad++; continue; }
  for (const f of e.facts) if (!t.includes(norm(f))) { console.log(`MISSING in ${srcs}: "${f}"  (${e.q})`); bad++; }
}
console.log(bad ? `${bad} problem(s)` : `faq ok: ${faq.length} entries, ${faq.reduce((a, e) => a + e.facts.length, 0)} facts all found in their cited docs`);
process.exit(bad ? 1 : 0);
