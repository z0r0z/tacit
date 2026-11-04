// What the page says when it waits for the relay to run a deposit order: a read that failed must never be taken for "the order did not run". Run: node --test tests/gas-relay-signer.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as gr from '../dapp/gas-relay.js';

const ACCOUNT = '0x' + '11'.repeat(20), ROUTER = '0x' + '22'.repeat(20), USED = '0xad04dc3f';

// A signer whose chain answers by `chain`: `used` is what the relay contract's used-nonce read gives (a function, so it can fail), `block` the head read.
function signerOver(chain) {
  const rpc = async (method, params = []) => {
    const call = params[0] || {};
    if (method === 'eth_call' && call.from) return '0x';                                  // the order run here first: it would go through
    if (method === 'eth_call' && String(call.data).startsWith(USED)) return chain.used();
    if (method === 'eth_call') return '0x' + '00'.repeat(32);                             // the token's permit nonce
    if (method === 'eth_blockNumber') return chain.block();
    if (method === 'eth_getLogs') return [];
    throw new Error('unexpected ' + method);
  };
  const sign = { permit: async () => ({ v: 27, r: '0x' + '33'.repeat(32), s: '0x' + '44'.repeat(32) }), order: async () => '0x' + '55'.repeat(65) };
  return gr.relaySigner({ address: ACCOUNT, token: gr.TAC, router: ROUTER, symbol: 'TAC', amount: 10n ** 18n, plan: { fee: 10n ** 17n }, rpc, step: () => {}, sign, now: () => 1_800_000_000 });
}

// The wait is 10 minutes of three-second looks: run it on a clock that is stepped, not waited for (timers mocked, Date.now moved by hand with them).
async function run(chain) {
  const realFetch = globalThis.fetch, realNow = Date.now;
  let t = 1_800_000_000_000;
  globalThis.fetch = async () => ({ json: async () => ({ ok: true }) });
  Date.now = () => t;
  mock.timers.enable(['setTimeout']);
  try {
    const p = signerOver(chain).send({ to: ROUTER, data: '0x' + '66'.repeat(40) });
    let over = false, out;
    p.then((v) => { over = true; out = { v }; }, (e) => { over = true; out = { e }; });
    for (let i = 0; i < 400 && !over; i++) { await new Promise((r) => setImmediate(r)); t += 3000; mock.timers.tick(3000); }
    await new Promise((r) => setImmediate(r));
    assert.ok(over, 'the wait ended');
    return out;
  } finally { mock.timers.reset(); Date.now = realNow; globalThis.fetch = realFetch; }
}

test('every look at the relay failing is not "nothing was spent": the order may have run', async () => {
  const out = await run({ used: () => { throw new Error('all nodes failed'); }, block: () => '0x10' });
  assert.match(out.e?.message || '', /could not be read, so it may have sent the order/);
  assert.doesNotMatch(out.e?.message || '', /nothing was spent/i);
});

test('a last look that failed after earlier good ones is not "nothing was spent" either', async () => {
  let looks = 0;
  const out = await run({ used: () => { if (++looks < 5) return '0x' + '00'.repeat(32); throw new Error('rate limited'); }, block: () => '0x10' });
  assert.match(out.e?.message || '', /could not be read, so it may have sent the order/);
});

test('an order the relay never ran, read to the end, says it lapsed and nothing was spent', async () => {
  const out = await run({ used: () => '0x' + '00'.repeat(32), block: () => '0x10' });
  assert.match(out.e?.message || '', /order has now lapsed, so nothing was spent/);
});

test('an order that ran is not failed by the head read that finds its transaction', async () => {
  const out = await run({ used: () => '0x' + '00'.repeat(31) + '01', block: () => { throw new Error('all nodes failed'); } });
  assert.match(out.e?.message || '', /relay sent it, but its transaction could not be found/);
  assert.doesNotMatch(out.e?.message || '', /all nodes failed/);
});
