// Governance oversight view (worker/src/governance-oversight.js): route, formatting, role-holder flags,
// the farm queue filter and the cache, against stubbed chain reads.
//   node --test tests/governance-oversight.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak_256 } from '@noble/hashes/sha3';
import { buildOversight } from '../worker/src/governance-oversight.js';

const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sel = (sig) => '0x' + hex(keccak_256(enc(sig))).slice(0, 8);
const w = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const aw = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const OTHER = '0x1111111111111111111111111111111111111111';
const RAY = 10n ** 27n;

function setup({ engineOwner = OPS, queued = [] } = {}) {
  const calls = { eth: 0 };
  const byTarget = (to, data) => {
    const s = data.slice(0, 10);
    const m = {
      [sel('owner()')]: aw(engineOwner), [sel('escrowRatioBps()')]: w(15000), [sel('cdpRatioBps()')]: w(15000),
      [sel('liqRatioBps()')]: w(13000), [sel('stabilityFeePerSecond()')]: w(RAY + 1547125956n * 10n ** 9n), // ~5% a year
      [sel('outstandingCusd()')]: w(49000000n), [sel('gov()')]: aw(OPS), [sel('pendingGov()')]: aw('0x0'),
      [sel('rate()')]: w(1282150n), [sel('UNIT_SCALE()')]: w(10n ** 10n), [sel('poolLength()')]: w(3),
      [sel('GUARDIAN()')]: aw(OPS), [sel('paused()')]: w(0), [sel('successor()')]: aw('0x0'),
      [sel('balanceOf(address)')]: w(1_000_000n * 10n ** 18n),
      [sel('queuedAt(bytes32)')]: queued.includes(data.slice(10).replace(/^0+/, '')) ? w(1800000000) : w(0),
    };
    return m[s] ?? w(0);
  };
  const logs = queued.map((id, i) => ({ block_number: 26030000 + i, transaction_hash: '0x' + String(i).repeat(64).slice(0, 64),
    decoded: { method_call: 'ConfigQueued(bytes32 id, uint256 eta)', parameters: [{ name: 'id', value: '0x' + id.padStart(64, '0') }] } }));
  logs.push({ block_number: 26030009, decoded: { method_call: 'ConfigQueued(bytes32 id, uint256 eta)', parameters: [{ name: 'id', value: '0x' + 'dead'.padStart(64, '0') }] } }); // executed/cancelled
  const o = buildOversight({
    ethCall: async (_n, to, data) => { calls.eth++; return byTarget(to, data); },
    ethGetBalance: async () => 85n * 10n ** 16n,
    keccak256: keccak_256,
    jsonResponse: (body, status = 200, headers = {}) => ({ body, status, headers }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ items: logs }) }),
  });
  return { o, calls };
}
const req = { method: 'GET' };
const url = (p) => new URL('https://w' + p);

test('serves the oversight view on mainnet only, and ignores other routes', async () => {
  const { o } = setup();
  assert.equal(await o.handle(req, {}, url('/governance/proposals'), 'mainnet', {}), null);
  assert.equal((await o.handle(req, {}, url('/governance/oversight'), 'signet', {})).status, 404);
  const r = await o.handle(req, {}, url('/governance/oversight'), 'mainnet', {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sections.map((s) => s.id), ['flows', 'treasury', 'engine', 'farms', 'airdrop', 'lineage']);
});

test('values are formatted, and every role reports whether the ops multisig holds it', async () => {
  const { o } = setup({ engineOwner: OTHER });
  const { body } = await o.handle(req, {}, url('/governance/oversight'), 'mainnet', {});
  const s = Object.fromEntries(body.sections.map((x) => [x.id, x]));
  const v = (sec, label) => s[sec].items.find((i) => i.label === label).value;
  assert.equal(v('treasury', 'TAC held'), '1,000,000 TAC');
  assert.equal(v('treasury', 'ETH held'), '0.8500 ETH');
  assert.equal(v('engine', 'cUSD liquidation ratio'), '130.00%');
  assert.equal(v('engine', 'cUSD outstanding'), '0.49 cUSD');
  assert.match(v('engine', 'Stability fee'), /^5\.0\d% a year$/);
  assert.equal(v('farms', 'Rewards'), '1,107 TAC a day');
  assert.equal(v('lineage', 'Successor'), 'none (this pool is current)');
  assert.equal(s.engine.controllerIsOps, false, 'a role moved off the multisig shows as such');
  assert.equal(s.farms.controllerIsOps, true);
});

test('the farm queue lists only entries still queued on-chain', async () => {
  const { o } = setup({ queued: ['abc1'] });
  const { body } = await o.handle(req, {}, url('/governance/oversight'), 'mainnet', {});
  const farms = body.sections.find((x) => x.id === 'farms');
  assert.equal(farms.pending.length, 1);
  assert.match(farms.pending[0].value, /executable from 2027-01-15/);
});

test('responses are cached for a minute', async () => {
  const { o, calls } = setup();
  await o.handle(req, {}, url('/governance/oversight'), 'mainnet', {});
  const after = calls.eth;
  await o.handle(req, {}, url('/governance/oversight'), 'mainnet', {});
  assert.equal(calls.eth, after);
});

test('flows: buybacks and relay TAC to the reserve, all time and the last 7 days', async () => {
  const RELAY = '0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7';
  const recent = new Date(Date.now() - 86400e3).toISOString(), old = new Date(Date.now() - 30 * 86400e3).toISOString();
  const TAC = (n) => (BigInt(n) * 10n ** 18n).toString();
  const byUrl = (url) => {
    if (url.includes('/addresses/0x6919cbEf0e70AFFA02Ae02c86c532A137154f250/logs')) return { items: [
      { block_timestamp: recent, decoded: { method_call: 'Bought(uint8 indexed venue, uint256 ethIn, uint256 tacOut)', parameters: [{ name: 'tacOut', value: TAC(40) }] } },
      { block_timestamp: old, decoded: { method_call: 'Bought(uint8 indexed venue, uint256 ethIn, uint256 tacOut)', parameters: [{ name: 'tacOut', value: TAC(60) }] } },
    ] };
    if (url.includes('/token-transfers')) return { items: [
      { from: { hash: RELAY }, to: { hash: OPS }, total: { value: TAC(527) }, timestamp: recent },
      { from: { hash: RELAY }, to: { hash: OTHER }, total: { value: TAC(999) }, timestamp: recent }, // not to the reserve
      { from: { hash: OTHER }, to: { hash: RELAY }, total: { value: TAC(5) }, timestamp: recent },   // incoming fee
    ] };
    return { items: [] };
  };
  const o = buildOversight({
    ethCall: async () => '0x' + '0'.repeat(64), ethGetBalance: async () => 0n, keccak256: keccak_256,
    jsonResponse: (body, status = 200) => ({ body, status }),
    fetchImpl: async (url) => ({ ok: true, json: async () => byUrl(url) }),
  });
  const { body } = await o.handle(req, {}, url('/governance/oversight'), 'mainnet', {});
  const flows = body.sections.find((x) => x.id === 'flows');
  const v = (label) => flows.items.find((i) => i.label === label).value;
  assert.equal(v('Bought back, all time'), '100 TAC (2 buys)');
  assert.equal(v('Relay fees paid in TAC, to the reserve'), '527 TAC');
  assert.equal(v('Back to the reserve, last 7 days'), '567 TAC');
  assert.equal(flows.informational, true);
});
