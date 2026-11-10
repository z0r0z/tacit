// The chain client with a route: a spend is quoted, handed over and followed at the leader the route names (a seat holder's announced endpoint),
// and goes the house leader's way when that one does not answer, asks too much or the route says nothing. Stubbed network, no proofs.
//   node tests/tacit-chain-client-route.test.mjs
import assert from 'node:assert';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeChainClient, chainSeed, FEE_CEILING } from '../dapp/tacit-chain-client.js';
import { makeChainWallet } from '../dapp/tacit-chain-wallet.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';

const sel = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)).slice(0, 4)).toString('hex');
const BLOCKS = '0x00000000000000000000000000000000000b10c5', HOUSE = 'http://house.test', SEAT = 'https://seat.example.com';
const w32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const rpcCall = async (m, [{ data }]) => {
  if (data.startsWith('0x' + sel('CHAIN()'))) return w32(7);
  if (data.startsWith('0x' + sel('TAC_ASSET()'))) return w32(9);
  if (data.startsWith('0x' + sel('pool()'))) return w32(0);
  if (data.startsWith('0x' + sel('shares()'))) return w32(0);
  throw new Error('unexpected ' + data);
};
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const res = (status, body) => ({ ok: status < 400, status, json: async () => body });
const PO = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const priv = new Uint8Array(32).fill(0x11);
const gen = makeChainWallet({ poseidon: (x) => PO[x.length](x), prover: null, chain: w32(7), asset: 9n });
const leaderAddr = gen.encodeAddress(gen.address(gen.keys(chainSeed(new Uint8Array(32).fill(0x22)))));
const pub = (n) => '0x' + (n.toString(16).padStart(2, '0')).repeat(32).repeat(12);
const spent = (n) => ({ submission: { publics: pub(n), proof: '0x', data: '0x' + '00'.repeat(96), memos: [], opMemos: [] }, nullifiers: ['0x' + n.toString(16).padStart(2, '0').repeat(32)] });

// a network of two leaders: what each was asked
function net({ seatFee = { fee: '5000', address: leaderAddr }, seatDown = false } = {}) {
  const asked = [];
  const f = async (url, o = {}) => {
    asked.push(`${o.method || 'GET'} ${url}`);
    const seat = url.startsWith(SEAT);
    if (seat && seatDown) throw new Error('unreachable');
    if (url.endsWith('/fee')) return res(200, seat ? seatFee : { fee: '0' });
    if (o.method === 'POST') return res(200, { id: 'rid', status: 'queued' });
    if (url.includes('/receipt/')) return res(200, { id: 'rid', status: 'landed', height: 3 });
    if (url.includes('/pending-notes')) return res(200, { leaves: [], memos: [] });
    if (url.includes('/notes')) return res(200, { leaves: [], memos: [], next: 0, total: 0 });
    return res(404, { error: 'x' });
  };
  return { f, asked };
}
const mk = async (f, route, st = store(), routeMs = 4000) => {
  const c = makeChainClient({ cfg: { blocks: BLOCKS, leader: HOUSE }, rpcCall, priv, system: () => null, route, routeMs, storage: st, fetchImpl: f });
  await c.ready();
  return { c, st };
};
const toSeat = { target: async () => ({ base: SEAT, until: Date.now() + 60e3 }) };

// 1. the quote is the slot's leader's, and the next spend is for it
{
  const { f, asked } = net();
  const { c } = await mk(f, toSeat);
  assert.deepEqual(await c.leaderNow(), { base: SEAT, routed: true });
  const q = await c.quote('shield', 100n * 10n ** 8n);
  assert.equal(q.fee, 5000n, 'the fee is the seat holder\'s');
  assert.ok(asked.some((a) => a === `GET ${SEAT}/fee`) && !asked.some((a) => a === `GET ${HOUSE}/fee`), 'asked the seat holder, not the house');
}
// 2. a spend is handed over and followed at that leader, and kept with it
{
  const { f, asked } = net();
  const { c, st } = await mk(f, toSeat);
  const out = await c.send({ kind: 'pay', units: 7n, spent: spent(1), base: SEAT, at: Date.now() }, { onStatus: () => {} });
  assert.equal(out.height, 3);
  assert.ok(asked.includes(`POST ${SEAT}/spend`) && asked.includes(`GET ${SEAT}/receipt/rid`), 'posted and followed at the seat holder');
  assert.ok(!asked.some((a) => a.startsWith(`POST ${HOUSE}`)), 'nothing posted to the house');
}
// 3. a kept spend is handed over again to the leader it was made for
{
  const { f, asked } = net();
  const { c, st } = await mk(f, toSeat);
  // (kept, and no answer to the first hand-over: the receipt wait never begins)
  const bad = net();
  const f2 = async (url, o = {}) => (o.method === 'POST' && url.startsWith(SEAT) ? (() => { throw new Error('down'); })() : bad.f(url, o));
  const m = await mk(f2, toSeat);
  await m.c.send({ kind: 'pay', units: 7n, spent: spent(2), base: SEAT, at: Date.now() }).catch(() => {});
  const e = (await m.c.pending())[0] || JSON.parse([...m.st.m.values()][0])[0];
  assert.equal(e.lead, SEAT, 'the kept spend names its leader');
  const g = net();
  const r = await mk(g.f, null, m.st);
  await r.c.resubmit(e);
  assert.ok(g.asked.includes(`POST ${SEAT}/spend`) && !g.asked.some((a) => a.startsWith(`POST ${HOUSE}`)), 'handed over again at the seat holder, even with no route');
}
// 4. a leader that is down, asks over the ceiling, or says nothing: the house
{
  for (const [label, n, route] of [
    ['down', net({ seatDown: true }), toSeat],
    ['over the ceiling', net({ seatFee: { fee: String(FEE_CEILING + 1n), address: leaderAddr } }), toSeat],
    ['no address for a fee', net({ seatFee: { fee: '5000' } }), toSeat],
    ['no route', net(), null],
    ['a route that throws', net(), { target: async () => { throw new Error('rpc'); } }],
    ['the house itself', net(), { target: async () => ({ base: HOUSE, until: Infinity }) }],
  ]) {
    const { c } = await mk(n.f, route);
    assert.deepEqual(await c.leaderNow(), { base: HOUSE, routed: false }, label);
    await c.send({ kind: 'pay', units: 7n, spent: spent(3), base: (await c.leaderNow()).base, at: Date.now() });
    assert.ok(n.asked.includes(`POST ${HOUSE}/spend`) && !n.asked.some((a) => a.startsWith(`POST ${SEAT}/spend`)), label + ': posted to the house');
  }
  // a fee exactly at the ceiling is taken
  const n = net({ seatFee: { fee: String(FEE_CEILING), address: leaderAddr } });
  assert.equal((await (await mk(n.f, toSeat)).c.leaderNow()).routed, true);
}
// 5. a proof made for a leader is good until the end it was given, and not after
{
  const { c } = await mk(net().f, toSeat);
  const p = (until) => ({ kind: 'pay', units: 1n, at: Date.now(), until, spent: { nullifiers: [] } });
  assert.equal(c.fresh(p(Date.now() + 5e3)), true);
  assert.equal(c.fresh(p(Date.now() - 1)), false, 'past its leader\'s slot');
  assert.equal(c.fresh(p(undefined)), true, 'a house proof has no end but its age');
}
// 6. a payment waiting for this wallet is looked for at the house and at the slot's leader
{
  const { f, asked } = net();
  const { c } = await mk(f, toSeat);
  await c.incoming();
  assert.ok(asked.includes(`GET ${HOUSE}/pending-notes`) && asked.includes(`GET ${SEAT}/pending-notes`), 'both asked');
}
// 7. an announced endpoint is not asked for its fee more than once in a few seconds
{
  const { f, asked } = net();
  const { c } = await mk(f, toSeat);
  await c.quote('shield', 10n ** 8n); await c.quote('shield', 2n * 10n ** 8n); await c.leaderNow();
  assert.equal(asked.filter((a) => a === `GET ${SEAT}/fee`).length, 1);
}
// 8. a route whose Ethereum nodes hang does not hold the quote up: the house answers after the route's allowance
{
  const n = net();
  const { c } = await mk(n.f, { target: () => new Promise(() => {}) }, store(), 150);
  const t0 = Date.now();
  assert.deepEqual(await c.leaderNow(), { base: HOUSE, routed: false });
  assert.ok(Date.now() - t0 < 2000, 'answered without waiting on the route');
}
console.log('chain client route: all passed');
