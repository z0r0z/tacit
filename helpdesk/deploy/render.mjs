#!/usr/bin/env node
// The help desk on Render: one Docker web service built from this folder (rootDir helpdesk, deploy/Dockerfile) with a 1 GB disk at /data, and the
// /help redirect on the tacit.finance static site. Shows what it would send unless --send is given. The Render key is read from the macOS keychain
// (tacit-render-api-key) when needed and never printed.
//
//   node helpdesk/deploy/render.mjs setup [--plan starter] [--send]   create the service if it is missing, add the /help redirect if it is missing
//   node helpdesk/deploy/render.mjs deploy [--send]                   build and deploy the latest commit of main
//   node helpdesk/deploy/render.mjs status                            the service, its latest deploys, and what /health says (reads only)
//
// Like the other services it deploys by hand (autoDeploy off): `deploy` after a push to main. The first build starts when the service is created.
import { execFileSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const send = process.argv.includes('--send');
const cmd = process.argv[2];
const OWNER = 'tea-d6v0ghf5gffc73d1n4k0';
const SITE = 'srv-d7tt961j2pic7399utag';   // the tacit.finance static site
const NAME = 'tacit-helpdesk';
const REPO = 'https://github.com/z0r0z/tacit';
const keychain = (name) => execFileSync('security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8' }).trim();
const fail = (m) => { console.error(`render.mjs: ${m}`); process.exit(1); };

// reads always go out; a write goes out only with --send
async function api(method, path, body) {
  if (method !== 'GET' && !send) { console.log(JSON.stringify({ wouldSend: { method, path, body } }, null, 1)); return null; }
  const r = await fetch(`https://api.render.com/v1${path}`, {
    method, headers: { authorization: `Bearer ${keychain('tacit-render-api-key')}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) fail(`${method} ${path}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const find = async () => ((await api('GET', `/services?name=${NAME}&limit=20`)) || []).map((x) => x.service ?? x).find((s) => s.name === NAME);

if (cmd === 'setup') {
  let svc = await find();
  if (svc) console.log(`the service is already there: ${svc.id}`);
  else {
    const r = await api('POST', '/services', {
      type: 'web_service', name: NAME, ownerId: OWNER, repo: REPO, branch: 'main', rootDir: 'helpdesk', autoDeploy: 'no',
      serviceDetails: {
        runtime: 'docker', plan: arg('plan', 'starter'), region: 'oregon', healthCheckPath: '/health', numInstances: 1,
        envSpecificDetails: { dockerfilePath: './deploy/Dockerfile', dockerContext: '.' },
        disk: { name: 'helpdesk-data', mountPath: '/data', sizeGB: 1 },
      },
      // what the image does not already default: the repository the docs come from and the code the community reviews
      envVars: [{ key: 'SCAN_REPO_URL', value: REPO }],
    });
    if (r) { svc = r.service ?? r; console.log(JSON.stringify({ created: svc.id, url: svc.serviceDetails?.url })); }
  }
  const routes = ((await api('GET', `/services/${SITE}/routes`)) || []).map((x) => x.route ?? x);
  if (routes.some((r) => r.source === '/help')) console.log('/help is already redirected');
  else if (routes.some((r) => r.source === '/*')) console.log('the static site has a catch-all rewrite: add /help -> /help/ above it in the dashboard');
  else {
    const priority = Math.max(0, ...routes.map((r) => r.priority)) + 1;
    const r = await api('POST', `/services/${SITE}/routes`, { type: 'redirect', source: '/help', destination: '/help/', priority });
    if (r) console.log(`added the /help redirect (priority ${priority})`);
  }
  if (!send) console.log('\nNothing was sent. Add --send to do it.');
} else if (cmd === 'deploy') {
  const svc = await find(); if (!svc) fail(`no service named ${NAME}: run setup first`);
  const r = await api('POST', `/services/${svc.id}/deploys`, { clearCache: 'do_not_clear' });
  if (r) console.log(JSON.stringify({ deploy: r.id, status: r.status }));
} else if (cmd === 'status') {
  const svc = await find(); if (!svc) fail(`no service named ${NAME} yet`);
  const url = svc.serviceDetails?.url;
  const ds = ((await api('GET', `/services/${svc.id}/deploys?limit=3`)) || []).map((x) => x.deploy ?? x);
  console.log(JSON.stringify({ service: svc.id, url, suspended: svc.suspended, deploys: ds.map((d) => ({ id: d.id, status: d.status, commit: d.commit?.id?.slice(0, 8), at: d.createdAt })) }, null, 1));
  try { const h = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15000) }); console.log(`${url}/health -> ${h.status} ${(await h.text()).slice(0, 200)}`); } catch (e) { console.log(`${url}/health -> not answering (${e.name})`); }
} else {
  fail('setup | deploy | status (see the header)');
}
