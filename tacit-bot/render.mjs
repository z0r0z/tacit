#!/usr/bin/env node
// The Tacit chain bot on Render: one Docker background worker (tacit-bot/Dockerfile) with a 1 GB disk for its wallets' state. Shows what it
// would send unless --send is given. The Render key and the bot's seed are read from the macOS keychain as they are needed and never
// printed: tacit-render-api-key, tacit-chain-bot-seed (BOT_SEED; put it there with
// `security add-generic-password -s tacit-chain-bot-seed -a tacit -w "$(cat <seed file>)"`).
//
//   node tacit-bot/render.mjs create [--branch main] [--plan starter] [--send]
//   node tacit-bot/render.mjs secrets --service srv-… [--send]
//   node tacit-bot/render.mjs deploy --service srv-… [--send]
//
// A background worker has no public URL: GET /health answers on its private address (tacit-chain-bot:8080) to other services in the
// same region. Its log lines are JSON, one per action.
import { execFileSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const send = process.argv.includes('--send');
const cmd = process.argv[2];
const OWNER = 'tea-d6v0ghf5gffc73d1n4k0';
const REPO = 'https://github.com/z0r0z/tacit';
const keychain = (name) => execFileSync('security', ['find-generic-password', '-s', name, '-w'], { encoding: 'utf8' }).trim();
const fail = (m) => { console.error(`render.mjs: ${m}`); process.exit(1); };

async function api(method, path, body) {
  if (!send) {
    console.log(JSON.stringify({ wouldSend: { method, path, body } }, (k, v) => (k === 'value' && typeof v === 'string' && /^(0x)?[0-9a-f]{64}$/i.test(v) ? '<from keychain>' : v), 1));
    return null;
  }
  const r = await fetch(`https://api.render.com/v1${path}`, {
    method, headers: { authorization: `Bearer ${keychain('tacit-render-api-key')}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) fail(`${method} ${path}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

if (cmd === 'create') {
  const env = { BOT_STATE_DIR: '/data', PORT: '8080' };
  const r = await api('POST', '/services', {
    type: 'background_worker', name: 'tacit-chain-bot', ownerId: OWNER, repo: REPO, branch: arg('branch', 'main'), autoDeploy: 'no',
    serviceDetails: {
      runtime: 'docker', plan: arg('plan', 'starter'), region: 'oregon', numInstances: 1,
      envSpecificDetails: { dockerfilePath: './tacit-bot/Dockerfile', dockerContext: '.' },
      disk: { name: 'tacit-chain-bot-data', mountPath: '/data', sizeGB: 1 },
    },
    envVars: Object.entries(env).map(([key, value]) => ({ key, value })),
  });
  if (r) console.log(JSON.stringify({ service: r.service?.id ?? r.id }));
} else if (cmd === 'secrets') {
  const id = arg('service');
  if (!/^srv-/.test(id || '')) fail('--service srv-…');
  await api('PUT', `/services/${id}/env-vars/BOT_SEED`, { value: send ? keychain('tacit-chain-bot-seed') : '0'.repeat(64) });
  if (send) console.log('BOT_SEED set from tacit-chain-bot-seed');
} else if (cmd === 'deploy') {
  const id = arg('service');
  if (!/^srv-/.test(id || '')) fail('--service srv-…');
  const r = await api('POST', `/services/${id}/deploys`, { clearCache: 'do_not_clear' });
  if (r) console.log(JSON.stringify({ deploy: r.id, status: r.status }));
} else {
  fail('create | secrets | deploy (see the header)');
}
