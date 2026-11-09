// Cross-origin isolation for the site's pages that prove (the front page and TAC's) and the files those pages start as workers: the threaded prover
// (dapp/btc-pool/threads/, rayon over Web Workers) needs shared memory, which a browser gives only to a cross-origin isolated page, and such a page
// loads a worker only when the worker's script carries the embedder policy too. The rules are in tools/site-isolation-rules.mjs.
// Adds the header rules the `tacit` static site on Render does not have yet; prints Render's answer for each. Safe to run again:
//   node tools/site-isolation-headers.mjs
// Each rule can be removed later in the static site's Settings → Headers (or DELETE /v1/services/<id>/headers/<rule id>).
import { execFileSync } from 'node:child_process';
import { ISOLATION_RULES } from './site-isolation-rules.mjs';

const SITE = 'srv-d7tt961j2pic7399utag';
const key = execFileSync('security', ['find-generic-password', '-s', 'tacit-render-api-key', '-w'], { encoding: 'utf8' }).trim();
const api = (method, body) => fetch(`https://api.render.com/v1/services/${SITE}/headers`, {
  method,
  headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' },
  body: body && JSON.stringify(body),
});
const listed = await (await api('GET')).json().catch(() => []);
const existing = (Array.isArray(listed) ? listed : []).map((x) => x.header ?? x.headerRule ?? x);
const has = (path, name, value) => existing.some((h) => h.path === path && String(h.name).toLowerCase() === name.toLowerCase() && h.value === value);
for (const [path, name, value] of ISOLATION_RULES) {
  if (has(path, name, value)) { console.log('have', path, name); continue; }
  const r = await api('POST', { path, name, value });
  const j = await r.json().catch(() => ({}));
  console.log(r.status, path, name, j.id || j.header?.id || JSON.stringify(j).slice(0, 160));
}
