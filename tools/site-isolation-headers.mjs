// Cross-origin isolation for the site's pages that prove (the front page and TAC's) and the prover's own files: the threaded prover
// (dapp/btc-pool/threads/, rayon over Web Workers) needs shared memory, which a browser gives only to a cross-origin isolated page.
// Adds the header rules to the `tacit` static site on Render; prints Render's answer for each. Run once:
//   node tools/site-isolation-headers.mjs
// Each rule can be removed later in the static site's Settings → Headers (or DELETE /v1/services/<id>/headers/<rule id>).
import { execFileSync } from 'node:child_process';

const SITE = 'srv-d7tt961j2pic7399utag';
const key = execFileSync('security', ['find-generic-password', '-s', 'tacit-render-api-key', '-w'], { encoding: 'utf8' }).trim();
const rules = [
  ['/btc-pool/*', 'Cross-Origin-Embedder-Policy', 'credentialless'],
  ['/', 'Cross-Origin-Opener-Policy', 'same-origin'], ['/', 'Cross-Origin-Embedder-Policy', 'credentialless'],
  ['/index.html', 'Cross-Origin-Opener-Policy', 'same-origin'], ['/index.html', 'Cross-Origin-Embedder-Policy', 'credentialless'],
  ['/tac/*', 'Cross-Origin-Opener-Policy', 'same-origin'], ['/tac/*', 'Cross-Origin-Embedder-Policy', 'credentialless'],
];
for (const [path, name, value] of rules) {
  const r = await fetch(`https://api.render.com/v1/services/${SITE}/headers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ path, name, value }),
  });
  const j = await r.json().catch(() => ({}));
  console.log(r.status, path, name, j.id || j.header?.id || JSON.stringify(j).slice(0, 160));
}
