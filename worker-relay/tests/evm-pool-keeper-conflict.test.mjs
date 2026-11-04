// The keeper's intake: a request line that is no URL is answered (it used to end the process, and every pool's keeper with it), and a relay that waits
// says why: the same notes already being relayed (the wallet waits for them to show spent), or another wallet's send holding the slot it was proved for
// (the wallet proves again against the root now).
//   node --test tests/evm-pool-keeper-conflict.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import net from 'node:net';
import { createIntakeHandler, parseCallIntent } from '../src/lib/evm-pool-keeper-intake.js';
import { callIntent, callIntentJson } from '../../dapp/evm-pool-gateway.js';
import { loadKeeperConfig as loadCfg } from '../src/lib/evm-pool-keeper-config.js';
import { loadKeeperConfig } from '../src/lib/evm-pool-keeper-config.js';
import { openKeeperStore } from '../src/lib/evm-pool-keeper-store.js';
import { makeForwarder } from '../src/lib/evm-pool-forwarder.js';

const POOL = '0x1111111111111111111111111111111111111111', ROUTER = '0x2222222222222222222222222222222222222222', KEEPER = '0x4444444444444444444444444444444444444444', REFUND = '0x5555555555555555555555555555555555555555';
const ZERO = '0x0000000000000000000000000000000000000000';

async function serve() {
  const cfg = { ...loadKeeperConfig({ EVM_POOL_ADDR: POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: 'http://127.0.0.1:1' }), ratePerMin: 1000 };
  const sent = [];
  const chain = { address: KEEPER, chainId: 1, pool: POOL, router: ROUTER, asset: ZERO, v1: ZERO, gasPrice: async () => 100_000_000n, estimate: async () => 350000n, canFront: async () => ({ ok: true }),
    send: async (fn) => { sent.push(fn); return '0x' + String(sent.length).padStart(64, '0'); }, waitReceipt: async () => null };
  const store = openKeeperStore(':memory:');
  const server = createServer(createIntakeHandler({ store, chain, zk: null, assetField: 0n, cfg, now: () => 1_800_000_000 }));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port, base = `http://127.0.0.1:${port}/evm-pool/keeper`;
  return { port, base, sent, close: () => { server.close(); store.close?.(); } };
}
// the request line as written, so the client does not tidy it
const raw = (port, target) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
  let b = ''; s.on('data', (d) => { b += d; }); s.on('close', () => resolve(b)); s.on('error', () => resolve(b));
});
// two different wallets' withdrawals proved against the same head: the same oldRoot (public input 1) and start (3), other nullifiers (7) and leaves (9)
const body = (nf, leaf) => ({ tx: { pA: ['1', '2'], pB: [['3', '4'], ['5', '6']], pC: ['7', '8'],
  publicInputs: ['11', '22', '33', '1000', '0', '0', '5', String(nf), '0', String(leaf), '0'], recipient: REFUND, extAmount: '-5000', relayer: KEEPER, fee: '100000000000000', memo0: '0x', memo1: '0x' } });
const post = async (base, b) => { const r = await fetch(base + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

test('a request line that is no URL is answered 400, and the keeper answers the next request', async () => {
  const s = await serve();
  try {
    for (const target of ['//', '///', '//[', '//:', '//a:b', '//a b', '/\\']) {
      const got = await raw(s.port, target);
      assert.match(got, /^HTTP\/1\.1 400 /, `${JSON.stringify(target)}: answered 400, got ${JSON.stringify(got.slice(0, 40))}`);
    }
    assert.match(await raw(s.port, '/evm-pool/keeper/info'), /^HTTP\/1\.1 200 /, 'and it still serves');
  } finally { s.close(); }
});

test('the forwarder answers a request line that is no URL', async () => {
  const forward = makeForwarder({ gateways: {} });
  let code = null;
  await forward({ url: '//', method: 'GET', headers: {} }, { writeHead: (c) => { code = c; }, end: () => {} });
  assert.equal(code, 400);
});

test('the same notes already being relayed say so; another wallet holding the slot says the root is stale', async () => {
  const s = await serve();
  try {
    const a = await post(s.base, body(901, 7001));
    assert.equal(a.status, 200);
    const dup = await post(s.base, body(901, 7001));
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already being relayed/, 'the same spend');
    assert.equal(dup.body.stale, true);
    const other = await post(s.base, body(902, 7002));
    assert.equal(other.status, 409);
    assert.match(other.body.error, /StaleRoot/, 'other funds, the same head: prove again');
    assert.doesNotMatch(other.body.error, /already being relayed/, 'the wallet must not wait for notes that are not on their way');
    assert.equal(other.body.stale, true);
    assert.equal(s.sent.length, 1, 'one send');
  } finally { s.close(); }
});

test('a call the keeper is to send must outlast the send: a deadline a few seconds away is refused, one with room is taken', () => {
  const now = 1_800_000_000, T = '0x' + '77'.repeat(20);
  const json = (deadline) => callIntentJson(callIntent({ calls: [{ target: T, value: 1n, data: '0x' }], outputs: [], to: REFUND, refund: REFUND, deadline: BigInt(deadline), nonce: 1n }));
  const cfg = loadCfg({ EVM_POOL_ADDR: POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: 'http://127.0.0.1:1' });
  assert.equal(cfg.minCallDeadlineSecs, 120, 'two minutes by default');
  assert.throws(() => parseCallIntent(json(now - 5), { now, cfg }), /has passed/);
  assert.throws(() => parseCallIntent(json(now + 30), { now, cfg }), /at least 120s away/);
  assert.throws(() => parseCallIntent(json(now + 119), { now, cfg }), /at least 120s away/);
  assert.ok(parseCallIntent(json(now + 300), { now, cfg }), 'five minutes is taken');
  assert.ok(parseCallIntent(json(now + 1200), { now, cfg }), 'and the dapp\'s twenty');
  assert.ok(parseCallIntent(json(now + 30), { now, cfg: { ...cfg, minCallDeadlineSecs: 10 } }), 'the floor is the operator\'s to lower');
});

test('how long a wallet holds its queue slot while it proves is the operator\'s to set, 90 s unless said, and both entrypoints pass it to the pipeline', async () => {
  const { readFileSync } = await import('node:fs');
  const env = { EVM_POOL_ADDR: POOL, EVM_POOL_ROUTER_ADDR: ROUTER, EVM_POOL_RPC_URL: 'http://127.0.0.1:1' };
  assert.equal(loadCfg(env).reserveSecs, 90);
  assert.equal(loadCfg({ ...env, EVM_POOL_KEEPER_RESERVE_SECS: '240' }).reserveSecs, 240);
  for (const f of ['evm-pool-keeper.js', 'evm-pool-keepers.js']) {
    assert.match(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /makePipeline\(\{[^\n]*reserveMs: cfg\.reserveSecs \* 1000/, `${f} gives the pipeline the setting`);
  }
});
