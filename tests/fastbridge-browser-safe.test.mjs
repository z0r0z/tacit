// The modules the /fast/ page loads run in a browser, where Node's globals do not exist: a provider in a tab that reached `Buffer`
// answered every offer with a 500 (the check of a lock's notes, dapp/fastbridge-btc.js crossLaneBlocked), which no test run in Node can see.
// This reads the page's own list of modules and refuses any that name Node's globals or modules.
//   node tests/fastbridge-browser-safe.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const DAPP = new URL('../dapp/', import.meta.url).pathname;
const NODE_ONLY = /\bBuffer\b|\bprocess\.(env|argv|exit|nextTick|cwd|platform|stdout)|\brequire\(|from 'node:|import\('node:|\b__dirname\b|\b__filename\b/;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

for (const page of ['fast/index.html']) {
  test(`${page}: no module it loads uses a Node global or module`, () => {
    const html = readFileSync(DAPP + page, 'utf8');
    const mods = [...new Set([...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1].replace(/\?cb=.*$/, '')))].filter((m) => !m.startsWith('/vendor/'));
    assert.ok(mods.length > 30, `the page lists its modules (${mods.length})`);
    const bad = [];
    for (const m of mods) {
      const file = DAPP + m.replace(/^\//, '');
      if (!existsSync(file)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => { if (!/^\s*(\/\/|\*|\/\*)/.test(line) && NODE_ONLY.test(line)) bad.push(`${m}:${i + 1}: ${line.trim().slice(0, 120)}`); });
    }
    assert.deepEqual(bad, [], 'a module the page loads reaches for something a browser does not have');
  });
}

test('the check of a lock\'s notes turns a note\'s commitment into hex with the browser-safe helper', () => {
  const src = readFileSync(DAPP + 'fastbridge-btc.js', 'utf8');
  assert.match(src, /import \{ bytesToHex \} from '\.\/vendor\/tacit-deps\.min\.js'/);
  assert.doesNotMatch(src, /Buffer/);
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} browser-safety checks passed`);
process.exit(process.exitCode || 0);
