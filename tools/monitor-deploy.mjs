// Redeploys the monitor job (crn-d9eb08bbc2fs73fkm8h0) from the head of its branch (Render takes no commit for a cron job), which calls a leader behind
// the chain critical.
//   node /Users/z/tacit-chain-merge/tools/monitor-deploy.mjs
// (the Render key is read from the keychain entry tacit-render-api-key and is never printed)
import { execFileSync } from 'node:child_process';

const MONITOR = 'crn-d9eb08bbc2fs73fkm8h0';
const key = execFileSync('security', ['find-generic-password', '-s', 'tacit-render-api-key', '-w'], { encoding: 'utf8' }).trim();
const api = async (method, path, body) => {
  const r = await fetch('https://api.render.com/v1' + path, { method, headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const r = await api('POST', `/services/${MONITOR}/deploys`, { clearCache: 'do_not_clear' });
const d = r.json.deploy || r.json;
console.log('monitor deploy', r.status, d.id || JSON.stringify(r.json).slice(0, 200));
for (let i = 0; i < 40 && d.id; i++) {
  const s = (await api('GET', `/services/${MONITOR}/deploys/${d.id}`)).json;
  const st = (s.deploy || s).status;
  console.log(st);
  if (st === 'live' || ['build_failed', 'update_failed', 'canceled', 'deactivated'].includes(st)) break;
  await new Promise((ok) => setTimeout(ok, 15000));
}
