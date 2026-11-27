// The pages whose code is one inline <script type="module"> (the front page, pay, pay/eth): every name the module uses is declared in it,
// imported, or the browser's. A name deleted or misspelled in a refactor is a ReferenceError only when that line runs, which a syntax check
// does not see; TypeScript's checker does (TS2304 "Cannot find name", TS2552 the same with a suggestion). Nothing else it says is read.
//   node tests/inline-names.test.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frontPage } from './lib/front-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), DAPP = join(ROOT, 'dapp');
const PAGES = ['index.html', 'pay/index.html', 'pay/eth/index.html'];
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

const dir = mkdtempSync(join(tmpdir(), 'inline-names-'));
let fails = 0;
try {
  const files = PAGES.map((rel) => {
    const m = frontPage(join(DAPP, rel)).match(/<script type="module">([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`${rel}: no inline module`);
    const f = join(dir, rel.replace(/\//g, '_').replace(/\.html$/, '.js'));
    writeFileSync(f, m[1]);
    return [rel, f];
  });
  for (const [rel, f] of files) {
    let out = '';
    try { execFileSync(TSC, ['--allowJs', '--checkJs', '--noEmit', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2023,dom,dom.iterable', '--skipLibCheck', f], { encoding: 'utf8', maxBuffer: 1 << 28 }); }
    catch (e) { out = String(e.stdout || ''); }                       // it exits non-zero for the type errors this test does not read
    const missing = out.split('\n').filter((l) => /error TS(2304|2552)/.test(l));
    if (missing.length) { fails++; console.log(`FAIL ${rel}: ${missing.length} name(s) not declared\n  ` + missing.slice(0, 10).map((l) => l.replace(/^.*?\((\d+),\d+\)/, 'module line $1')).join('\n  ')); }
    else console.log(`ok   ${rel}: every name is declared, imported or the browser's`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
if (fails) process.exit(1);
