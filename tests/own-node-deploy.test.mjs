// own-nodes deploy files, read as text (no Docker here): what they must keep true. No node RPC port is published beyond loopback; every image
// is pinned by digest; reth's snapshot download asks for exactly what reth.toml keeps; bitcoind is unpruned with txindex and its RPC allows only
// the compose network that docker-compose.yml pins; the gateway is wired to the index and the keyed trace path; Caddy keeps no access log.
//
// Run: node --test tests/own-node-deploy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../own-nodes/' + p, import.meta.url), 'utf8');
const compose = read('docker-compose.yml'), reth = read('reth.toml'), conf = read('bitcoin.conf'), caddy = read('Caddyfile'), electrs = read('electrs/config.toml');

test('only peer-to-peer, web and loopback ports are published', () => {
  const published = [...compose.matchAll(/^\s+- "([^"]+)"\s*(#.*)?$/gm)].map((m) => m[1]).filter((p) => /^[\d.:]+(\/(tcp|udp))?$/.test(p));
  assert.ok(published.length >= 8);
  for (const p of published) {
    const [hostPart] = p.split(/:(?=\d+(\/\w+)?$)/);
    const ok = /^(30303|9000|9001|8333|80|443):\1(\/(tcp|udp))?$/.test(p) || /^127\.0\.0\.1:8332:8332$/.test(p);
    assert.ok(ok, 'published: ' + p + ' ' + hostPart);
  }
  for (const rpc of ['8545', '8551', '5052', '50001', '4224', '8080']) assert.ok(!published.some((p) => p.includes(rpc)), rpc + ' is never published');
});

test('every image is pinned by digest; built images pin their base by digest', () => {
  const images = [...compose.matchAll(/^\s+image:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(images.length >= 4);
  for (const i of images) assert.match(i, /:[\w.-]+@sha256:[0-9a-f]{64}$/, i);
  for (const f of ['Dockerfile', 'electrs/Dockerfile']) for (const m of read(f).matchAll(/^FROM\s+(\S+)/gm)) assert.match(m[1], /@sha256:[0-9a-f]{64}$/, f + ': ' + m[1]);
  assert.match(read('electrs/Dockerfile'), /test "\$\(git rev-parse HEAD\)" = "\$ELECTRS_COMMIT"/);
});

test('the snapshot download asks for what reth.toml keeps', () => {
  const before = (seg) => Number(new RegExp(`^${seg} = \\{ before = ([\\d_]+) \\}`, 'm').exec(reth)[1].replace(/_/g, ''));
  const distance = (seg) => Number(new RegExp(`^${seg} = \\{ distance = ([\\d_]+) \\}`, 'm').exec(reth)[1].replace(/_/g, ''));
  const flag = (f) => Number(new RegExp(`--${f}=(\\d+)`).exec(compose)[1]);
  assert.equal(flag('with-txs-since'), before('bodies_history'));
  assert.equal(flag('with-receipts-since'), before('receipts'));
  assert.equal(before('transaction_lookup'), before('bodies_history'), 'tx lookup where the bodies are');
  assert.equal(flag('with-state-history-distance'), distance('account_history'));
  assert.equal(distance('storage_history'), distance('account_history'));
  assert.ok(distance('account_history') >= 2 * 7200 * 3, 'state history covers claims read days after landing');
  assert.ok(before('receipts') <= 25_998_736, 'receipts reach the pool\'s deploy block');
  assert.ok(flag('rpc.eth-proof-window') <= distance('account_history'));
  assert.match(compose, /--http\.api=eth,net,web3,debug,trace/);
});

test('bitcoind: unpruned with txindex; RPC open only to the pinned compose network; electrs keeps no per-request log', () => {
  assert.match(conf, /^txindex=1$/m); assert.match(conf, /^prune=0$/m); assert.match(conf, /^disablewallet=1$/m);
  const subnet = /subnet: ([\d./]+)/.exec(compose)[1];
  const allowed = [...conf.matchAll(/^rpcallowip=(.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(allowed.sort(), ['127.0.0.1', subnet].sort());
  assert.match(electrs, /^log_filters = ".*electrs::electrum=error"/m);
  assert.doesNotMatch(electrs, /auth\s*=/, 'the password comes from the environment');
});

test('the gateway is wired to bitcoind + electrs and the keyed trace path; Caddy writes no access log', () => {
  for (const k of ['ETH_UPSTREAM', 'BTC_RPC_URL', 'ELECTRUM_URL', 'INTERNAL_TRACE', 'TRACE_POOLS', 'INTERNAL_KEYS']) assert.match(compose, new RegExp(`^\\s+${k}:`, 'm'), k);
  assert.match(compose, /BTC_ESPLORA_UPSTREAM: ""/);
  assert.match(read('env.example'), /^ELECTRUM_URL=tcp:\/\/electrs:50001$/m);
  assert.match(caddy, /output discard/);
  assert.doesNotMatch(caddy, /^\s*log\s*\{[^}]*output (file|stdout|stderr)/m);
});
