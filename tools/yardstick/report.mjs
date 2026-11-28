#!/usr/bin/env node
// Summarises agent.mjs results.
//
//   node tools/yardstick/report.mjs RESULTS_DIR SPLIT_DIR [--exclude ids.txt] [--mode symptom]
//
// Reads every RESULTS_DIR/*.jsonl except the oracle's, groups by tag, and prints per tag:
//   solved/n and pass@1 (an item counts as solved if ANY of its attempts is: pass@k with k = attempts run),
//   how attempts ended, turns, wall time, decode and prompt speed, and edit size.
// DEV items are listed one by one. SEALED items are only ever shown as totals (see split.mjs).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const [dir, splitDir] = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const exclude = new Set(flag('--exclude') && existsSync(flag('--exclude')) ? readFileSync(flag('--exclude'), 'utf8').split('\n').filter(Boolean) : []);
const MODE = flag('--mode', 'symptom');
const rd = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const dev = new Set(rd(join(splitDir, 'dev.jsonl')).map((r) => r.id));
const sealed = new Set(rd(join(splitDir, 'sealed.jsonl')).map((r) => r.id));

const byTag = new Map();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !/oracle|rejected/.test(x))) {
  for (const r of rd(join(dir, f))) {
    if (r.oracle || r.mode !== MODE || exclude.has(r.id)) continue;
    if (!byTag.has(r.tag)) byTag.set(r.tag, []);
    byTag.get(r.tag).push(r);
  }
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sum = (a) => a.reduce((x, y) => x + y, 0);
function block(name, rows) {
  const ids = [...new Set(rows.map((r) => r.id))];
  const solved = ids.filter((id) => rows.some((r) => r.id === id && r.solved));
  const first = ids.filter((id) => rows.find((r) => r.id === id && r.attempt === 0)?.solved);
  const fin = {}; for (const r of rows) fin[r.finish] = (fin[r.finish] || 0) + 1;
  const dec = sum(rows.map((r) => r.genTokens)) / (sum(rows.map((r) => r.genMs)) / 1000 || 1);
  const pre = sum(rows.map((r) => r.promptTokens)) / (sum(rows.map((r) => r.promptMs)) / 1000 || 1);
  return `  ${name}: ${ids.length} items, ${rows.length} attempts | pass@1 ${first.length}/${ids.length} | any attempt ${solved.length}/${ids.length} | ended ${JSON.stringify(fin)} | turns ${mean(rows.map((r) => r.turns)).toFixed(1)} | wall ${(mean(rows.map((r) => r.wallMs)) / 1000).toFixed(0)} s | decode ${dec.toFixed(1)} tok/s | prompt ${pre.toFixed(0)} tok/s | max prompt ${Math.max(...rows.map((r) => r.maxPrompt))} tok | edit ${mean(rows.map((r) => r.diffLines)).toFixed(0)} lines | tool errors ${sum(rows.map((r) => r.toolErrors))}, malformed ${sum(rows.map((r) => r.malformed))}`;
}
for (const [tag, rows] of byTag) {
  console.log(`\n${tag} (${MODE} mode)`);
  console.log(block('dev   ', rows.filter((r) => dev.has(r.id))) || '');
  const s = rows.filter((r) => sealed.has(r.id));
  if (s.length) console.log(block('sealed', s));
  for (const id of [...new Set(rows.filter((r) => dev.has(r.id)).map((r) => r.id))]) {
    const rs = rows.filter((r) => r.id === id);
    console.log(`     ${id} ${rs.some((r) => r.solved) ? 'SOLVED' : 'no    '} ${rs.map((r) => `${r.finish}/${r.turns}t/${r.diffLines}l`).join(' ')}`);
  }
}
