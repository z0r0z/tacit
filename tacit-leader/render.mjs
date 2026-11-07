#!/usr/bin/env node
// The tacit chain's leader on Render: one Docker web service (tacit-leader/Dockerfile) with a 1 GB disk for the block archive and the
// address directory. Shows what it would send unless --send is given. The Render key and the leader's secrets are read from the macOS
// keychain as they are needed and never printed: tacit-render-api-key, tacit-chain-leader-key (LEADER_KEY), tacit-chain-leader-seed
// (LEADER_CHAIN_SEED), tacit-chain-node-admin (TACIT_NODE_ADMIN).
//
//   node tacit-leader/render.mjs create --blocks 0x… --from-block N [--branch tacit-blocks] [--prover board] [--send]
//   node tacit-leader/render.mjs secrets --service srv-… [--send]
//   node tacit-leader/render.mjs deploy --service srv-… [--send]
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
    console.log(JSON.stringify({ wouldSend: { method, path, body } }, (k, v) => (k === 'value' && typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) ? '<from keychain>' : v), 1));
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
  const blocks = arg('blocks'), from = arg('from-block');
  if (!/^0x[0-9a-fA-F]{40}$/.test(blocks || '')) fail('--blocks: the TacitBlocks address');
  if (!/^\d+$/.test(from || '')) fail('--from-block: the block it was deployed in');
  const env = {
    BLOCKS: blocks,
    FROM_BLOCK: from,
    RPC_URL: arg('rpc', 'https://rpc.mevblocker.io'),
    PROVER: arg('prover', 'board'),
    ARCHIVE_DIR: '/data/archive',
    TACIT_NODE_DIRECTORY: '/data/directory.txt',
    TACIT_NODE_TRUST_PROXY: '1',
  };
  const r = await api('POST', '/services', {
    type: 'web_service', name: 'tacit-chain-leader', ownerId: OWNER, repo: REPO, branch: arg('branch', 'tacit-blocks'), autoDeploy: 'no',
    serviceDetails: {
      runtime: 'docker', plan: arg('plan', 'starter'), region: 'oregon', healthCheckPath: '/state', numInstances: 1,
      envSpecificDetails: { dockerfilePath: './tacit-leader/Dockerfile', dockerContext: '.' },
      disk: { name: 'tacit-chain-data', mountPath: '/data', sizeGB: 1 },
    },
    envVars: Object.entries(env).map(([key, value]) => ({ key, value })),
  });
  if (r) console.log(JSON.stringify({ service: r.service?.id ?? r.id, url: r.service?.serviceDetails?.url ?? r.serviceDetails?.url }));
} else if (cmd === 'secrets') {
  const id = arg('service');
  if (!/^srv-/.test(id || '')) fail('--service srv-…');
  // BOARD_TOKEN is tacit-api's CONFIDENTIAL_BOX_TOKEN (the relay's own), set by hand on the service: it is not kept in this keychain
  for (const [key, name] of [['LEADER_KEY', 'tacit-chain-leader-key'], ['LEADER_CHAIN_SEED', 'tacit-chain-leader-seed'], ['TACIT_NODE_ADMIN', 'tacit-chain-node-admin']]) {
    await api('PUT', `/services/${id}/env-vars/${key}`, { value: send ? keychain(name) : '0x' + '0'.repeat(64) });
    if (send) console.log(`${key} set from ${name}`);
  }
} else if (cmd === 'deploy') {
  const id = arg('service');
  if (!/^srv-/.test(id || '')) fail('--service srv-…');
  const r = await api('POST', `/services/${id}/deploys`, { clearCache: 'do_not_clear' });
  if (r) console.log(JSON.stringify({ deploy: r.id, status: r.status }));
} else {
  fail('create | secrets | deploy (see the header)');
}
