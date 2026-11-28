import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATION_RULES } from '../tools/site-isolation-rules.mjs';

const dapp = fileURLToPath(new URL('../dapp/', import.meta.url));
const pages = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name === 'index.html') pages.push(path);
  }
}
await walk(dapp);

const secondary = /\/(?:[^"']*400i|ibm-plex-mono-500|orbitron|space-mono)[^"']*\.woff2/i;
let low = 0;
for (const file of pages) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/<link\b[^>]*\brel="preload"[^>]*\bas="font"[^>]*>/gi)) {
    if (!secondary.test(match[0])) continue;
    low++;
    assert.match(match[0], /\bfetchpriority="low"/i, `${file}: secondary font competes with the first paint`);
  }
}
assert.ok(low >= 10, 'expected secondary font preloads to inspect');

const headers = await readFile(join(dapp, '_headers'), 'utf8');
assert.match(headers, /\/fonts\/\*[\s\S]*?Cache-Control: public, max-age=31536000, immutable/, 'fonts need a shared immutable cache policy');
assert.ok(ISOLATION_RULES.some(([path, name, value]) => path === '/fonts/*' && name === 'Cache-Control' && /immutable/.test(value)), 'the live Render header set needs the font cache policy');

const chrome = await readFile(join(dapp, 'chrome.js'), 'utf8');
assert.match(chrome, /requestIdleCallback\(start, \{ timeout: 2000 \}\)/, 'activity code should wait for idle time');
assert.match(chrome, /requestIdleCallback\(start, \{ timeout: 2500 \}\)/, 'help code should wait for idle time');

console.log(`ok - ${low} secondary font preloads yield to critical page assets`);
console.log('ok - optional shared chrome work waits until the first load is idle');
console.log('ok - fonts persist across modern page navigation');
