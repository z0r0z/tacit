// tools/relay-check.mjs: the four checks an operator runs on a Pay relay (quote, signed private route key, registry listing, sealed quote through a forwarder), with a real
// gateway, forwarder and key behind them and the relay's host and the registry stood in for.
//   node worker-relay/tests/relay-check.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { makeServiceGateway } from '../src/lib/evm-pool-keeper-sealed.js';
import { makeForwarder } from '../src/lib/evm-pool-forwarder.js';
import { newGatewayKey } from '../../dapp/sealed-request.js';
import { checkRelay, main } from '../../tools/relay-check.mjs';
import { encodeList } from '../../tests/helpers/relay-registry-list.mjs';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', r));
const jsonTo = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); };
const account = privateKeyToAccount('0x' + '6d'.repeat(32));
const URL_ = 'https://relay.example/1/evm-pool/keeper';
const E18 = 10n ** 18n;

async function world({ accounts = [account], listed = [{ relayer: account.address, stake: 1000n * E18, url: URL_ }], forwarderCarries = true } = {}) {
  const serve = (req, res) => (req.url.split('?')[0] === '/1/evm-pool/keeper/quote' ? jsonTo(res, 200, { chainId: 1, relayer: account.address, fee: '123' }) : jsonTo(res, 404, { error: 'not found' }));
  const take = makeServiceGateway({ secret: newGatewayKey(), serve, json: jsonTo, accounts, ratePerMin: 100_000 });
  const relay = createServer((req, res) => (take(req, res) ? undefined : serve(req, res)));
  await listen(relay);
  const base = `http://127.0.0.1:${relay.address().port}`;
  const community = forwarderCarries ? {
    find: async (chain, who) => listed.find((e) => chain === 1 && e.relayer.toLowerCase() === who.toLowerCase()) ?? null,
    request: async (url, o) => { const r = await fetch(url.replace('https://relay.example', base), { method: o.method, headers: o.headers, body: o.body }); return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }; },
  } : null;
  const fwd = createServer(makeForwarder({ gateways: {}, community, ratePerMin: 100_000 }));
  await listen(fwd);
  const fwdUrl = `http://127.0.0.1:${fwd.address().port}`;
  const fetchImpl = (u, init) => fetch(String(u).replace('https://relay.example', base), init);
  const call = async () => encodeList(listed, listed.length);
  return { run: () => checkRelay({ url: URL_, fetchImpl, call, forwarders: [fwdUrl] }), close: () => { relay.close(); fwd.close(); } };
}
const marks = (steps) => steps.map((s) => (s.ok ? 'ok' : 'FAIL')).join(' ');

await check('a relay that quotes, shows its signed key, is listed and is carried passes all four steps', async () => {
  const w = await world();
  try {
    const steps = await w.run();
    assert.equal(marks(steps), 'ok ok ok ok', steps.map((s) => s.detail).join(' | '));
    assert.match(steps[0].detail, new RegExp(account.address)); assert.match(steps[2].detail, /listed with 1000 TAC/); assert.match(steps[3].detail, /answered 200 through a forwarder/);
  } finally { w.close(); }
});
await check('a relay with no key signed for by its address fails the key step, and the sealed step says it needs it', async () => {
  const w = await world({ accounts: [] });
  try {
    const steps = await w.run();
    assert.equal(marks(steps), 'ok FAIL ok FAIL');
    assert.match(steps[1].detail, /EVM_POOL_KEEPER_GATEWAY_KEY/); assert.match(steps[3].detail, /needs the key and the listing/);
  } finally { w.close(); }
});
await check('a relay that is not listed fails the registry step with how to list it; one listed at another address says where', async () => {
  const none = await world({ listed: [] });
  const other = await world({ listed: [{ relayer: account.address, stake: 1000n * E18, url: 'https://elsewhere.example/1/evm-pool/keeper' }], forwarderCarries: false });
  try {
    const a = await none.run();
    assert.equal(marks(a), 'ok ok FAIL FAIL'); assert.match(a[2].detail, /register-relay\.mjs/);
    const b = await other.run();
    assert.equal(marks(b), 'ok ok FAIL FAIL'); assert.match(b[2].detail, /listed at https:\/\/elsewhere\.example\/1\/evm-pool\/keeper, not here/);
  } finally { none.close(); other.close(); }
});
await check('a forwarder that does not carry registry relays fails the last step alone', async () => {
  const w = await world({ forwarderCarries: false });
  try { assert.equal(marks(await w.run()), 'ok ok ok FAIL'); } finally { w.close(); }
});
await check('a relay that is not there fails the first step and every step after it names what it needs; no url is a usage error', async () => {
  const steps = await checkRelay({ url: 'https://gone.example/1/evm-pool/keeper', fetchImpl: async () => { throw new Error('connection refused'); }, call: async () => '0x', forwarders: [] });
  assert.equal(marks(steps), 'FAIL FAIL FAIL FAIL'); assert.match(steps[0].detail, /connection refused/);
  const log = console.error; let said = ''; console.error = (m) => { said = m; };
  try { assert.equal(await main([]), 2); } finally { console.error = log; }
  assert.match(said, /usage/);
});
console.log(`\n${n} passed`);
