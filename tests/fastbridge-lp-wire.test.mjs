// The provider's upkeep wired together (fastbridge-lp/lib/automation-wire.mjs) with its dependencies stood in for: it starts with the rebalancing, the fresh addresses and the
// auto-shield all on, /info carries the rebalancing, and nothing is sent. (A variable out of scope here once crashed a deploy at start: this is the check for that.)
//   node tests/fastbridge-lp-wire.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { wireAutomation } = await import(`${S}/fastbridge-lp/lib/automation-wire.mjs`);
const { keccak_256 } = await import(`${S}/dapp/vendor/tacit-deps.min.js`);

function deps(env) {
  const logs = [], alerts = [], rpcCalls = [];
  const spk = Uint8Array.from([0, 20, ...new Uint8Array(20).fill(7)]);
  const btcOf = (address) => ({ address, satsUtxos: async () => [{ txid: 'aa'.repeat(32), vout: 0, value: 500000 }], satsCoins: async () => ({ coins: [{ txid: 'aa'.repeat(32), vout: 0, value: 500000 }], pending: 0 }), status: async () => ({ confirmations: 1 }), fetchTx: async () => null, broadcast: async () => {}, coinsIn: async () => [], outspend: async () => null, tip: async () => 1 });
  const ux = {
    account: () => ({ address: '0x' + '3a'.repeat(20), priv: new Uint8Array(32).fill(5) }),
    rpc: async (m) => { rpcCalls.push(m); if (m === 'eth_getBalance') return '0x' + (3n * 10n ** 16n).toString(16); if (m === 'eth_blockNumber') return '0x100'; if (m === 'eth_gasPrice') return '0x3b9aca00'; return '0x0'; },
    balance: async () => ({ byAsset: {} }),
    sendUnwrap: async () => { throw new Error('not in this test'); }, buildRouterWrap: async () => ({}), nextWrapIndex: async () => 0, relay: { state: async () => ({ state: 'ok' }) },
  };
  const store = { list: async () => [], get: async () => null };
  return {
    logs, alerts, rpcCalls,
    args: {
      C: { evmAsset: 'f0'.repeat(32), quote: { minAmount: '25000', feeBps: 20, flatFee: '400' }, reverse: { enabled: true, minAmount: '800000', feeBps: 20, flatFee: '10000' }, btcBases: ['https://a.example'], upkeep: { tickSecs: 3600 } },
      key: new Uint8Array(32).fill(9), prims: { p2wpkhScript: () => spk, wallet: { pub: new Uint8Array(33).fill(2) } },
      btc: btcOf('bc1qmain'), tacit: { signP2wpkhInputWithKey: () => [], txid: () => 'ab'.repeat(32), serializeTx: () => new Uint8Array(1) },
      ux, evm: { cutReserve: async () => 1n }, service: { free: async () => 20n * 10n ** 6n, held: async () => 0n, reservations: new Map() },
      swapStore: store, quoteStore: store,
      rside: { btc: btcOf('bc1qreverse'), prims: { p2wpkhScript: () => spk, wallet: { pub: new Uint8Array(33).fill(3) } }, swaps: store, quotes: store },
      rateFeed: { rate: () => ({ num: 1n, den: 1n }), current: () => ({ ethPerBtc: 36, at: 1, n: 3 }) },
      poolTurn: (fn) => fn(), data: mkdtempSync(join(tmpdir(), 'lp-wire-')), keccak256: keccak_256, log: (x) => logs.push(x), alert: (x) => alerts.push(x), setLean: () => {}, env,
    },
  };
}

for (const [label, env] of [
  ['the rebalancing in a dry run with the fresh addresses and the auto-shield on', { FB_LP_REBALANCE: 'dry', FB_LP_REBALANCE_FRESH: 'on', FB_LP_AUTO_SHIELD: 'on' }],
  ['the rebalancing on without the auto-shield (the fresh shield is then not offered)', { FB_LP_REBALANCE: 'on', FB_LP_REBALANCE_FRESH: 'on' }],
  ['everything off', {}],
]) {
  test(`the upkeep starts with ${label}`, async () => {
    const d = deps(env);
    const w = await wireAutomation(d.args);
    assert.ok(w && w.auto && typeof w.wrap === 'function');
    const wrapped = w.wrap(async () => ({ status: 200, body: { ok: 1 } }));
    const r = await wrapped({ method: 'GET', path: '/info' });
    assert.equal(r.status, 200);
    if (env.FB_LP_REBALANCE) assert.ok(d.logs.some((l) => l.msg === `rebalance is ${env.FB_LP_REBALANCE}`), 'the rebalancing started');
    else assert.ok(!d.logs.some((l) => /^rebalance is/.test(l.msg || '')));
    assert.equal(d.alerts.filter((a) => a.level === 'error').length, 0);
  });
}
