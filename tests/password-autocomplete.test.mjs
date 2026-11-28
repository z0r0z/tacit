import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dapp/', import.meta.url));
const skipped = new Set(['classic.html', 'tacit.js']);

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(path));
    else if (/\.(?:html|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

let checked = 0;
for (const file of await sourceFiles(root)) {
  const name = relative(root, file);
  if (skipped.has(name)) continue;
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/<input\b[^>]*\btype=(?:"password"|'password')[^>]*>/gi)) {
    checked++;
    assert.match(
      match[0],
      /\bautocomplete=(?:"new-password"|'new-password')/i,
      `${name} contains a wallet-secret input that Chrome may treat as a saved website password:\n${match[0]}`,
    );
  }
}

assert.ok(checked > 0, 'expected to inspect wallet-secret inputs');
console.log(`ok - ${checked} wallet-secret inputs opt out of saved-password autofill`);
