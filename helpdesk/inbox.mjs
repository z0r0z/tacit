#!/usr/bin/env node
// Review the code-check suggestions the community nodes filed (suggestions.jsonl). Nothing here applies a patch.
//   node inbox.mjs                  new suggestions that apply and still parse (10 at a time)
//   node inbox.mjs all              everything, any status
//   node inbox.mjs mark N accepted|rejected|applied     N is the number shown (a rejection is remembered: it is not filed again)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const F = process.env.INBOX || path.join(path.dirname(new URL(import.meta.url).pathname), 'suggestions.jsonl');
const rows = existsSync(F) ? readFileSync(F, 'utf8').split('\n').filter(Boolean).map((l, i) => ({ n: i + 1, ...JSON.parse(l) })) : [];
const [, , cmd = 'list', a, b] = process.argv;
if (cmd === 'mark') {
  const r = rows.find((x) => x.n === Number(a)); if (!r || !['accepted', 'rejected', 'applied'].includes(b)) { console.error('usage: inbox.mjs mark N accepted|rejected|applied'); process.exit(2); }
  const lines = readFileSync(F, 'utf8').split('\n').filter(Boolean); lines[r.n - 1] = JSON.stringify({ ...JSON.parse(lines[r.n - 1]), review: b }); writeFileSync(F, lines.join('\n') + '\n'); console.log(`#${r.n} marked ${b}`);
} else {
  const show = rows.filter((x) => cmd === 'all' || (x.review === 'new' && x.status === 'syntax-ok')).slice(-10).reverse();
  const by = rows.reduce((o, x) => ((o[x.status] = (o[x.status] || 0) + 1), o), {});
  console.log(`${rows.length} filed (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}); showing ${show.length}\n`);
  for (const x of show) console.log(`#${x.n}  ${x.file}:${x.line ?? '?'}  (window ${x.window}, commit ${x.commit}, ${x.status}, ${x.review}, node ${String(x.miner).slice(0, 8)})\n   ${x.why}\n   - ${String(x.old).split('\n').join('\n   - ')}\n   + ${String(x.new).split('\n').join('\n   + ')}\n`);
}
