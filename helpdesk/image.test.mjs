// node image.test.mjs -- every file the gateway (and the scripts the entrypoint runs) imports is copied into the Docker image
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const here = path.dirname(new URL(import.meta.url).pathname);
const docker = readFileSync(path.join(here, 'deploy/Dockerfile'), 'utf8');

// the sources COPY puts in the image, relative to this folder (the build context)
const copied = new Set();
for (const line of docker.replace(/\\\n/g, ' ').split('\n')) {
  const m = line.match(/^COPY\s+(.+)$/); if (!m) continue;
  const parts = m[1].trim().split(/\s+/); parts.pop();   // the last word is where they land
  for (const p of parts) copied.add(path.normalize(p));
}
// the entry points: what the entrypoint runs
const entrypoint = readFileSync(path.join(here, 'deploy/entrypoint.sh'), 'utf8');
const entries = [...new Set([...entrypoint.matchAll(/\bnode\s+([\w./-]+\.mjs)/g)].map((m) => m[1]))];
check('the entrypoint runs the gateway', entries.includes('server.mjs'));

// every relative import, followed through the files that are read
const need = new Set(), seen = new Set();
function walk(rel) {
  if (seen.has(rel)) return; seen.add(rel); need.add(rel);
  const file = path.join(here, rel); if (!existsSync(file)) return;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) walk(path.normalize(path.join(path.dirname(rel), m[1])));
}
for (const e of entries) walk(path.normalize(e));
check('the walk reaches the review digest through the gateway', need.has('reviewdigest.mjs') && need.has('scanfeed.mjs') && need.has(path.normalize('codecheck/scan.mjs')));
const missing = [...need].filter((f) => !copied.has(f));
check(`every imported file is copied into the image${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`, missing.length === 0);

console.log(fails ? `${fails} image test(s) failed` : 'image: all tests passed'); process.exit(fails ? 1 : 0);
