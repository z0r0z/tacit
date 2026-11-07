// Builds dapp/vendor/tacit-pq.min.js from entry.mjs as one ES module with no imports: ML-KEM-768 (FIPS 203) from the pinned
// @noble/post-quantum, which the tacit chain's hybrid memos encapsulate to. Prints the output's SHA-384. With --verify it writes
// nothing: it rebuilds from the pinned package and fails unless the result is byte for byte the committed bundle.
//   cd build/pq && npm install && node build-pq.mjs [--verify]

import { build } from 'esbuild';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(resolve(HERE, '../..'), 'dapp/vendor/tacit-pq.min.js');
const verify = process.argv.includes('--verify');
const OUT = verify ? join(mkdtempSync(join(tmpdir(), 'tacit-pq-')), 'tacit-pq.min.js') : BUNDLE;
const PINNED = { '@noble/post-quantum': '0.7.1' };
for (const [name, want] of Object.entries(PINNED)) {
  const got = JSON.parse(readFileSync(join(HERE, 'node_modules', name, 'package.json'), 'utf8')).version;
  if (got !== want) throw new Error(`${name} ${got}, expected ${want}`);
}

await build({
  entryPoints: [join(HERE, 'entry.mjs')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  minify: true,
  legalComments: 'inline',
  outfile: OUT,
  logLevel: 'error',
});

const sha = (p) => createHash('sha384').update(readFileSync(p)).digest('base64');
if (verify) {
  if (sha(OUT) !== sha(BUNDLE)) throw new Error('dapp/vendor/tacit-pq.min.js is not what the pinned package builds');
  console.log('tacit-pq.min.js: verified');
} else {
  console.log(`dapp/vendor/tacit-pq.min.js sha384-${sha(OUT)} (${readFileSync(OUT).length} bytes)`);
}
