#!/usr/bin/env node
// The environment a prover binary is spawned with (worker-relay/src/lib/prover-env.js): the service's own, without its keys, tokens and database
// URL, with the network key, routing settings and input mode the binary reads.
//   node tests/prover-env.test.mjs
import assert from 'node:assert';
import { proverEnvFrom } from '../worker-relay/src/lib/prover-env.js';

const service = {
  PATH: '/usr/bin', HOME: '/root', TMPDIR: '/tmp', LANG: 'C.UTF-8', SSL_CERT_FILE: '/etc/ssl/cert.pem', RUST_LOG: 'info', NODE_OPTIONS: '--max-old-space-size=1280',
  PRIVATE_STDIN: '1', PRIVATE_ATTEMPT_MS: '180000', PROVER_WHITELIST: '0xd4fc', EXPECT_VKEY: '0x1f', SP1_PROVER: 'network', RPC_URL: 'https://rpc.example', POOL_ADDR: '0xpool',
  SETTLE_KEY: '0x01', RELAY_KEY: '0x02', NETWORK_PRIVATE_KEY: '0x02', BOX_TOKEN: 'b', CONFIDENTIAL_BOX_TOKEN: 'c', PROVER_HEARTBEAT_TOKEN: 'h', PROVER_WORKER_TOKENS: 't', DATABASE_URL: 'postgres://u:p@h/db',
  POINTS_ROOT_SETTER_KEY: '0x03', BUYBACK_KEEPER_KEY: '0x04', RECOVER_KEY: '0x05', RECOVER_FEE_KEY: '0x06', BTC_POOL_RELAYER_BTC_KEY: '0x07', BTC_POOL_RELAYER_POOL_SEED: '0x08',
  EVM_POOL_KEEPER_PRIV: '0x09', EVM_POOL_KEEPER_PRIV_8453: '0x0a', WATCHTOWER_SERVICE_SK: '0x0b', PINATA_JWT: 'j', FILEBASE_SECRET: 's', FILEBASE_KEY: 'k', DEBUG_TOKEN: 'd', PROXY_TRUST_KEY: 'p', RUNPOD_API_KEY: 'r', VAST_API_KEY: 'v',
};
const cfg = { sp1Prover: 'network', networkRpcUrl: 'https://rpc.mainnet.succinct.xyz', proverOut: '/var/out', networkPrivateKey: '0xnetwork' };
let n = 0; const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };

const env = proverEnvFrom(service, cfg, { MODE: 'groth16', OP_TYPE: 'wrap' });
for (const k of ['SETTLE_KEY', 'RELAY_KEY', 'BOX_TOKEN', 'CONFIDENTIAL_BOX_TOKEN', 'PROVER_HEARTBEAT_TOKEN', 'PROVER_WORKER_TOKENS', 'DATABASE_URL', 'POINTS_ROOT_SETTER_KEY', 'BUYBACK_KEEPER_KEY',
  'RECOVER_KEY', 'RECOVER_FEE_KEY', 'BTC_POOL_RELAYER_BTC_KEY', 'BTC_POOL_RELAYER_POOL_SEED', 'EVM_POOL_KEEPER_PRIV', 'EVM_POOL_KEEPER_PRIV_8453', 'WATCHTOWER_SERVICE_SK', 'PINATA_JWT',
  'FILEBASE_SECRET', 'FILEBASE_KEY', 'DEBUG_TOKEN', 'PROXY_TRUST_KEY', 'RUNPOD_API_KEY', 'VAST_API_KEY']) ok(!(k in env), `${k} is not passed on`);
for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'RUST_LOG', 'NODE_OPTIONS', 'PRIVATE_STDIN', 'PRIVATE_ATTEMPT_MS', 'PROVER_WHITELIST', 'EXPECT_VKEY', 'RPC_URL', 'POOL_ADDR']) ok(env[k] === service[k], `${k} is passed on`);
ok(env.NETWORK_PRIVATE_KEY === '0xnetwork', 'the network key comes from the configuration');
ok(env.SP1_PROVER === 'network' && env.NETWORK_RPC_URL === cfg.networkRpcUrl && env.PROVER_OUT === '/var/out' && env.MODE === 'groth16' && env.OP_TYPE === 'wrap', 'the routing settings and the caller\'s extras are set');
ok(proverEnvFrom(service, cfg, { PRIVATE_STDIN: '0', PROVER_WHITELIST: '' }).PRIVATE_STDIN === '0', 'an extra overrides the service\'s own value');
ok(!('NETWORK_PRIVATE_KEY' in proverEnvFrom(service, { ...cfg, networkPrivateKey: '' })), 'with no network key configured none is passed');
ok(service.SETTLE_KEY === '0x01', 'the service\'s own environment is not changed');
console.log(`${n} checks`);
