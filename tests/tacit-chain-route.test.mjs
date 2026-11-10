// Which leader a spend goes to: the slot's leader and its announced endpoint, the handover near a slot's end, and the house leader for anything
// that cannot be read, against a stubbed Ethereum node (no network).
//   node tests/tacit-chain-route.test.mjs
import assert from 'node:assert';
import { keccak_256 } from '../dapp/vendor/tacit-deps.min.js';
import { makeLeaderRoute, endpointBase, endpointOf, SLOT_SECONDS, HANDOVER_SECONDS } from '../dapp/tacit-chain-route.js';

const te = new TextEncoder();
const hx = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sel = (sig) => hx(keccak_256(te.encode(sig)).slice(0, 4));
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const SEATS = '0x00000000001f703eae70de3b528213e4802790fb', HOUSE = 'https://house.example.com';
const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), ZERO = '0x' + '00'.repeat(20);
const abiString = (s) => { const b = hx(te.encode(s)); return '0x' + pad(32) + pad(s.length) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };

// the pure parts
assert.equal(endpointBase('https://leader.example.com/'), 'https://leader.example.com');
assert.equal(endpointBase('https://leader.example.com/some/path?x=1'), 'https://leader.example.com');
assert.equal(endpointBase('https://leader.example.com:8443'), 'https://leader.example.com:8443');
for (const bad of ['http://leader.example.com', 'https://u:p@leader.example.com', 'https://localhost', 'https://127.0.0.1x', 'https://127.0.0.1', 'https://[::1]', 'https://10.0.0.5:8080', 'javascript:alert(1)', 'ftp://a.b', 'https://a b.c', '', 'https://' + 'a'.repeat(200) + '.com', 42, null])
  assert.equal(endpointBase(bad), null, String(bad));
assert.equal(endpointOf(abiString('https://leader.example.com')), 'https://leader.example.com');
assert.equal(endpointOf('0x'), null);
assert.equal(endpointOf('0x' + pad(64) + pad(3) + '616263'.padEnd(64, '0')), null, 'a string that does not start where the data says');
assert.equal(endpointOf('0x' + pad(32) + pad(5000) + '00'), null, 'a length past the data');

// a stubbed chain: one block at `n`, made `age` seconds ago; leaders by slot; announcements by holder
const SLOT = 50;
function chain({ n = 1000, age = 0, leaders = {}, logs = {}, logsFail = false, now0 = 1_800_000_000_000 } = {}) {
  const st = { calls: [], logCalls: 0, now: now0, n, age, leaders, logs, logsFail };
  st.rpc = async (m, ps) => {
    st.calls.push(m);
    if (m === 'eth_getBlockByNumber') return { number: '0x' + st.n.toString(16), timestamp: '0x' + Math.floor((st.now - st.age * 1000) / 1000).toString(16) };
    if (m === 'eth_getLogs') {
      st.logCalls++;
      if (st.logsFail) throw new Error('range too large');
      assert.equal(ps[0].address, SEATS);
      return st.logs[ps[0].topics[1].slice(26)] || [];
    }
    if (m === 'eth_call') {
      const d = ps[0].data.slice(2);
      if (d.startsWith(sel('SLOT_BLOCKS()'))) return '0x' + pad(SLOT);
      if (d.startsWith(sel('leaderAt(uint256)'))) {
        const b = Number(BigInt('0x' + d.slice(8)));
        return '0x' + pad(BigInt(st.leaders[Math.floor(b / SLOT)] ?? ZERO));
      }
    }
    throw new Error('unexpected ' + m);
  };
  return st;
}
const log = (url, block = 1, idx = 0) => ({ blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16), data: abiString(url) });
const mk = (st, o = {}) => makeLeaderRoute({ seats: SEATS, house: HOUSE, rpcCall: st.rpc, now: () => st.now, ...o });

// the slot's leader with an announced endpoint: mid-slot, the spend goes to it, and its proof is good until the handover
{
  const st = chain({ n: 1010, leaders: { 20: A }, logs: { [A.slice(2)]: [log('https://a.example.com')] } });   // slot 20 = blocks 1000..1049: 40 blocks (480 s) left
  const t = await mk(st).target();
  assert.deepEqual([t.base, t.leader, t.slot, t.routed], ['https://a.example.com', A, 20, true]);
  assert.equal(t.until, st.now + (40 * SLOT_SECONDS - HANDOVER_SECONDS) * 1000);
}
// near the slot's end it is the next slot's leader, good until that slot's end less the handover
{
  const st = chain({ n: 1045, leaders: { 20: A, 21: B }, logs: { [A.slice(2)]: [log('https://a.example.com')], [B.slice(2)]: [log('https://b.example.com')] } });   // 5 blocks (60 s) left
  const t = await mk(st).target();
  assert.deepEqual([t.base, t.leader, t.slot], ['https://b.example.com', B, 21]);
  assert.equal(t.until, st.now + (5 * SLOT_SECONDS + SLOT * SLOT_SECONDS - HANDOVER_SECONDS) * 1000);
}
// the latest block's age counts: a block seen 90 s ago leaves 90 s less
{
  const st = chain({ n: 1035, age: 90, leaders: { 20: A, 21: B }, logs: { [A.slice(2)]: [log('https://a.example.com')], [B.slice(2)]: [log('https://b.example.com')] } });   // 15 blocks = 180 s, less 90 = 90 s
  assert.equal((await mk(st).target()).leader, B);
}
// a leader that never announced (or the house leader itself), a slot with no leader, and a bad announcement: the house, no end to the proof
{
  for (const [leaders, logs] of [[{ 20: A }, {}], [{}, {}], [{ 20: A }, { [A.slice(2)]: [log('http://a.example.com')] }], [{ 20: A }, { [A.slice(2)]: [{ blockNumber: '0x1', logIndex: '0x0', data: '0x' }] }]]) {
    const t = await mk(chain({ n: 1010, leaders, logs })).target();
    assert.deepEqual([t.base, t.routed, t.until], [HOUSE, false, Infinity]);
  }
}
// the latest announcement stands, whatever order the node lists them in
{
  const st = chain({ n: 1010, leaders: { 20: A }, logs: { [A.slice(2)]: [log('https://new.example.com', 9, 0), log('https://old.example.com', 3, 5), log('https://mid.example.com', 9, -0)] } });
  st.logs[A.slice(2)] = [log('https://old.example.com', 3, 5), log('https://new.example.com', 9, 2), log('https://mid.example.com', 9, 1)];
  assert.equal((await mk(st).target()).base, 'https://new.example.com');
}
// nodes that fail: the house, and an answer already had is kept
{
  const st = chain({ n: 1010, leaders: { 20: A }, logs: { [A.slice(2)]: [log('https://a.example.com')] } });
  const r = mk(st);
  assert.equal((await r.target()).base, 'https://a.example.com');
  st.rpc = async () => { throw new Error('down'); };
  assert.equal((await mk(st).target()).base, HOUSE, 'a node that answers nothing: the house');
  const st2 = chain({ n: 1010, leaders: { 20: A }, logsFail: true });
  assert.equal((await mk(st2).target()).base, HOUSE, 'logs refused: the house');
}
// reads are held: the same target within a minute asks nothing again, a new one when the handover begins, and endpoints are looked up once
{
  const st = chain({ n: 1010, leaders: { 20: A, 21: B }, logs: { [A.slice(2)]: [log('https://a.example.com')], [B.slice(2)]: [log('https://b.example.com')] } });
  const r = mk(st);
  await r.target(); const c1 = st.calls.length;
  st.now += 30e3; await r.target();
  assert.equal(st.calls.length, c1, 'held');
  st.now += 31e3; st.n = 1013; await r.target();
  assert.ok(st.calls.length > c1, 'read again after a minute');
  assert.equal(st.logCalls, 1, 'the endpoint is looked up once');
  // into the handover: the held answer ends where the target changes
  st.n = 1041; st.now += 12 * 25 * 1000; st.age = 0;
  const t = await r.target();
  assert.equal(t.leader, B);
}
console.log('tacit chain route ok');
