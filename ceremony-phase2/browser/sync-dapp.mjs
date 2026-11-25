// Copies the browser contribution code into dapp/praxis/browser/ for the page: the same files, with site-path imports carrying
// cache-bust tokens (the build fills them in) and the wasm named by its own hash, so a changed module never meets a stale one.
//   node sync-dapp.mjs          (after ./build.sh)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../dapp/praxis/browser');
mkdirSync(out, { recursive: true });
const wasm = readFileSync(join(here, 'g.wasm'));
const name = `g-${createHash('sha256').update(wasm).digest('hex').slice(0, 8)}.wasm`;
for (const f of readdirSync(out)) if (/^g-[0-9a-f]{8}\.wasm$/.test(f) && f !== name) rmSync(join(out, f));
writeFileSync(join(out, name), wasm);
const src = (f) => readFileSync(join(here, f), 'utf8');
const site = (s) => s.replace(/from '\.\/(core|pool)\.js'/g, (_, m) => `from '/praxis/browser/${m}.js?cb=00000000'`);
writeFileSync(join(out, 'core.js'), src('core.js'));
writeFileSync(join(out, 'pool.js'), src('pool.js'));
writeFileSync(join(out, 'flow.js'), site(src('flow.js')));
writeFileSync(join(out, 'worker.js'), src('worker.js').replaceAll("'./g.wasm'", `'./${name}'`));
writeFileSync(join(out, 'wasm_exec.js'), src('wasm_exec.js'));
console.log('synced', name);
