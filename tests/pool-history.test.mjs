// worker-relay/src/lib/pool-history.js, what a pool's state did over old blocks, found with few reads: the changes between two blocks against a stand-in chain whose changes are at known
// blocks, what a read costs, what is not seen, and every way the search can fail. Offline: node tests/pool-history.test.mjs
import assert from 'node:assert/strict';
import { changesBetween, stateReader, makeGate, makeArchiveRpc, ARCHIVE_RPCS_MAINNET, REST_LIMITED_MS, REST_FAILED_MS, STEP_BLOCKS, RES_BLOCKS } from '../worker-relay/src/lib/pool-history.js';

// a pool whose state is `before` until the first change, then each [block, state] from that block on
const chain = (changes, before = null) => {
  const calls = [];
  let active = 0, peak = 0;
  const stateAt = async (b) => {
    calls.push(b); active++; peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    active--;
    let s = before;
    for (const [cb, st] of changes) if (b >= cb) s = st;
    return s;
  };
  return { stateAt, calls, peak: () => peak };
};
const S = (a, b = 20, sh = 5) => `${a}:${b}:${sh}`;
const FROM = 1_000_000, TO = FROM + 7200;

// a quiet pool: the coarse reads and nothing else (the two ends given cost none)
{
  const c = chain([], S(1));
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(1) });
  assert.deepEqual(r.events, []); assert.equal(r.from, FROM); assert.equal(r.fromState, S(1));
  assert.equal(r.calls, 7200 / STEP_BLOCKS - 1, 'a day at an hour a read is 23 reads between the two ends it was given');
  assert.equal(c.calls.length, r.calls);
}
// the ends not given are read
{
  const c = chain([], S(1));
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO });
  assert.equal(r.calls, 25, 'twenty-five reads for a day: both ends too'); assert.ok(c.calls.includes(FROM) && c.calls.includes(TO));
}
// one change: found to within a span of RES_BLOCKS, for a handful of reads more
{
  const c = chain([[FROM + 4000, S(2)]], S(1));
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(2) });
  assert.equal(r.events.length, 1); const e = r.events[0];
  assert.ok(e.block >= FROM + 4000 && e.block < FROM + 4000 + RES_BLOCKS, `the change at ${FROM + 4000} is found in its span (${e.block})`);
  assert.equal(e.kind, 'trade', 'reserves moved, shares did not');
  assert.ok(r.calls <= 23 + 5, `a change costs a few reads (${r.calls})`);
}
// shares moved: an add or a remove; and a change at the very first and very last block of a span
{
  const c = chain([[FROM + 1, S(2, 20, 9)]], S(1));
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(2, 20, 9) });
  assert.equal(r.events.length, 1); assert.equal(r.events[0].kind, 'liquidity'); assert.ok(r.events[0].block <= FROM + RES_BLOCKS);
  const last = chain([[TO, S(2)]], S(1));
  const r2 = await changesBetween({ stateAt: last.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(2) });
  assert.equal(r2.events.length, 1); assert.equal(r2.events[0].block, TO, 'a change in the last block is told at it');
}
// several changes: two in one span are one (as in the log), two in one coarse step are two, and they come out in order
{
  const c = chain([[FROM + 2001, S(2)], [FROM + 2003, S(3)], [FROM + 5000, S(4)], [FROM + 5100, S(5)], [FROM + 6000, S(5, 20, 8)]], S(1));
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(5, 20, 8) });
  const blocks = r.events.map((e) => e.block - FROM);
  assert.equal(r.events.length, 4, `2001 and 2003 are in one search span and merge; 5000, 5100 and the liquidity at 6000 stand (${blocks})`);
  assert.deepEqual(blocks, [...blocks].sort((x, y) => x - y), 'in order');
  assert.ok(blocks[0] >= 2001 && blocks[0] < 2026); assert.ok(blocks[1] >= 5000 && blocks[1] < 5025); assert.ok(blocks[2] >= 5100 && blocks[2] < 5125);
  assert.deepEqual(r.events.map((e) => e.kind), ['trade', 'trade', 'trade', 'liquidity']);
}
// what it cannot see: a state that goes and comes back inside a coarse step
{
  const c = chain([[FROM + 4010, S(2)], [FROM + 4090, S(1)]], S(1));
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(1) });
  assert.deepEqual(r.events, [], 'a round trip between two hourly reads is not seen (the count is a floor)');
}
// a busy day stays cheap: fifty changes cost a few hundred reads, not a read a block
{
  const ch = Array.from({ length: 50 }, (_, i) => [FROM + 100 + i * 140, S(i + 2)]);
  const c = chain(ch, S(1));
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(51) });
  assert.ok(r.events.length >= 40 && r.events.length <= 50, `about fifty (${r.events.length})`);
  assert.ok(r.calls < 300, `${r.calls} reads for a day with fifty changes`);
  assert.equal(new Set(c.calls).size, c.calls.length, 'no block read twice');
}
// a pool that did not exist at the start: the start moves up to the first read that found it, and the pool's creation is not a change
{
  const c = chain([[FROM + 3000, S(1)], [FROM + 5000, S(2)]], null);
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, toState: S(2) });
  assert.equal(r.from, FROM + 3000, 'the first coarse block the pool was there (it was made at block 3000, a coarse block)');
  assert.equal(r.fromState, S(1)); assert.equal(r.events.length, 1); assert.ok(r.events[0].block >= FROM + 5000 && r.events[0].block < FROM + 5025);
  const none = chain([], null);
  const nobody = await changesBetween({ stateAt: none.stateAt, from: FROM, to: TO, toState: null });
  assert.deepEqual({ from: nobody.from, events: nobody.events, fromState: nobody.fromState }, { from: TO, events: [], fromState: null }, 'a pool that is not there has no history');
}
// the pool there and then not: a chain that cannot be, so no answer
{
  const c = chain([[FROM + 1000, S(1)], [FROM + 4000, null]], null);
  await assert.rejects(changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, toState: null }), /was there and then was not/);
  const odd = { stateAt: async (b) => (b >= FROM + 2400 && b < FROM + 2700 ? null : b < FROM + 1200 ? S(0) : S(b - FROM > 3000 ? 2 : 1)) };
  await assert.rejects(changesBetween({ stateAt: odd.stateAt, from: FROM, to: TO, fromState: S(0), toState: S(2) }), /was there and then was not/, 'a hole in the middle of the coarse reads');
}
// a span that is not a multiple of the step, and a span shorter than one
{
  const c = chain([[FROM + 130, S(2)]], S(1));
  const r = await changesBetween({ stateAt: c.stateAt, from: FROM, to: FROM + 175, fromState: S(1), toState: S(2) });
  assert.equal(r.events.length, 1); assert.ok(r.events[0].block >= FROM + 130 && r.events[0].block < FROM + 130 + RES_BLOCKS + 1);
  const short = await changesBetween({ stateAt: c.stateAt, from: FROM, to: FROM + 10, fromState: S(1), toState: S(2) });
  assert.deepEqual(short.events, [{ block: FROM + 10, kind: 'trade' }], 'inside one span it is one change at the end');
  const same = await changesBetween({ stateAt: c.stateAt, from: FROM + 10, to: FROM + 10, fromState: S(1), toState: S(1) });
  assert.deepEqual(same, { from: FROM + 10, fromState: S(1), events: [], calls: 0 }, 'no blocks, nothing');
}
// failing: a read that throws, a search over its budget, a search past its time
{
  const bad = async (b) => { if (b === FROM + 2100) throw new Error('rpc down'); return S(1); };
  await assert.rejects(changesBetween({ stateAt: bad, from: FROM, to: TO, fromState: S(1), toState: S(1) }), /rpc down/, 'one failed read fails the search: no partial answer');
  const c = chain([[FROM + 4000, S(2)]], S(1));
  await assert.rejects(changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(2), budget: 24 }), /budget/);
  const ok = await changesBetween({ stateAt: chain([[FROM + 4000, S(2)]], S(1)).stateAt, from: FROM, to: TO, fromState: S(1), toState: S(2), budget: 40 });
  assert.equal(ok.events.length, 1, 'with room it goes through');
  let clock = 0;
  const slow = async () => { clock += 40_000; return S(1); };
  await assert.rejects(changesBetween({ stateAt: slow, from: FROM, to: TO, fromState: S(1), toState: S(1), deadline: 100_000, now: () => clock, gate: makeGate(1) }), /ran out of time/);
}
// a failed search stops asking: the reads still waiting are not made
{
  const calls = [];
  const flaky = async (b) => { calls.push(b); if (calls.length === 3) throw new Error('rpc down'); return S(1); };
  await assert.rejects(changesBetween({ stateAt: flaky, from: FROM, to: TO, fromState: S(1), toState: S(1), gate: makeGate(1) }), /rpc down/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 3, 'three reads, the third failed, and none of the twenty waiting was made (' + calls.length + ')');
  const c2 = [];
  await assert.rejects(changesBetween({ stateAt: async (b) => { c2.push(b); return S(1); }, from: FROM, to: TO, fromState: S(1), toState: S(1), budget: 5, gate: makeGate(1) }), /budget/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c2.length, 5, 'over budget it stops at the budget');
}
// reads are held to the gate's width, and a gate shared by searches holds them together
{
  const c = chain([[FROM + 4000, S(2)]], S(1));
  await changesBetween({ stateAt: c.stateAt, from: FROM, to: TO, fromState: S(1), toState: S(2), gate: makeGate(3) });
  assert.ok(c.peak() <= 3, `at most three at once (${c.peak()})`);
  const shared = chain([], S(1)), gate = makeGate(2);
  await Promise.all([1, 2, 3].map(() => changesBetween({ stateAt: shared.stateAt, from: FROM, to: FROM + 1500, fromState: S(1), toState: S(1), gate })));
  assert.ok(shared.peak() <= 2, `a shared gate holds three searches to two reads (${shared.peak()})`);
}
// stateReader: pools(poolId) on the pool at a block, read into reserveA:reserveB:shares
{
  const w = (v) => BigInt(v).toString(16).padStart(64, '0');
  const asked = [];
  const rpc = { call: async (to, data, block) => { asked.push({ to, data, block }); return '0x' + w(1) + w(0xaa) + w(0xbb) + w(876327165) + w(7507742249974n) + w(30) + w(78220343071n); } };
  const id = '0x248497bf6f943cd2b39a04bf5841056c58dfd7ef196188cb4f0ac1fd11dc7c00';
  assert.equal(await stateReader(rpc, '0xPOOL', id)(26_000_000), '876327165:7507742249974:78220343071');
  assert.deepEqual(asked[0], { to: '0xPOOL', data: '0xb5217bb4' + id.slice(2), block: '0x' + (26_000_000).toString(16) });
  assert.equal(await stateReader({ call: async () => '0x' }, '0xP', id)(1), null, 'a short answer is no pool');
  assert.equal(await stateReader({ call: async () => '0x' + w(0).repeat(7) }, '0xP', id)(1), null, 'an uninitialised pool is none');
  await assert.rejects(stateReader({ call: async () => { throw new Error('nodes down'); } }, '0xP', id)(1), /nodes down/);
}
// makeGate: in order, and a throwing job does not stop the line
{
  const order = [], gate = makeGate(1);
  const rs = await Promise.allSettled([gate(async () => { order.push(1); return 'a'; }), gate(async () => { order.push(2); throw new Error('x'); }), gate(async () => { order.push(3); return 'c'; })]);
  assert.deepEqual(order, [1, 2, 3]); assert.deepEqual(rs.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
}

// ── makeArchiveRpc: a read through nodes that limit ──
{
  const ok = (result = '0xabc') => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
  const http = (status) => ({ ok: false, status, json: async () => ({}) });
  const rpcErr = (message) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32005, message } }) });
  const notJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  const A = 'https://a.test', B = 'https://b.test/v2/SECRETKEY123', C = 'https://c.test:8545/path';
  const rig = (script, urls = [A, B, C], rounds = 3) => {
    const calls = [], sleeps = [], clock = { t: 0 };
    const fetchFn = async (url) => { calls.push(url); const r = script(url, calls.filter((x) => x === url).length, calls.length); if (r instanceof Error) throw r; return r; };
    const rpc = makeArchiveRpc(urls, { fetchFn, now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, rounds });
    return { rpc, calls, sleeps, clock };
  };
  const CALL = ['0xpool', '0xdata', '0x1'];
  // the first node that answers, and nothing asked of the rest
  { const r = rig(() => ok('0x01')); assert.equal(await r.rpc.call(...CALL), '0x01'); assert.deepEqual(r.calls, [A]); }
  // a node that limits: the next answers, and the one that limited is not walked into again until its rest is over
  {
    const r = rig((u) => (u === A ? http(429) : ok()));
    await r.rpc.call(...CALL); await r.rpc.call(...CALL);
    assert.deepEqual(r.calls, [A, B, B], 'the second read goes straight to the node that answered');
    assert.deepEqual(r.rpc.resting(), ['a.test']);
    r.clock.t += REST_LIMITED_MS - 1; await r.rpc.call(...CALL); assert.equal(r.calls.at(-1), B, 'still resting a moment before its time');
    r.clock.t += 2; await r.rpc.call(...CALL); assert.equal(r.calls.at(-2), A, 'asked again once the rest is over');
  }
  // a node that fails some other way rests for less
  { const r = rig((u) => (u === A ? http(500) : ok())); await r.rpc.call(...CALL); r.clock.t += REST_FAILED_MS + 1; await r.rpc.call(...CALL); assert.equal(r.calls.at(-2), A, 'a failed node is back after REST_FAILED_MS'); assert.ok(REST_FAILED_MS < REST_LIMITED_MS); }
  // every node fails and none was limiting: one round, and the message says each one's reason, by host and never by address
  {
    const r = rig((u) => (u === A ? http(500) : u === B ? notJson : new TypeError('fetch failed')));
    await assert.rejects(r.rpc.call(...CALL), (e) => {
      assert.equal(e.message, 'rpc eth_call failed: a.test HTTP 500; b.test not JSON; c.test:8545 no answer');
      assert.ok(!/SECRETKEY|\/v2|path/.test(e.message), 'no address and no key in it'); return true;
    });
    assert.deepEqual(r.sleeps, [], 'nothing was limiting, so no pause'); assert.equal(r.calls.length, 3);
  }
  // a timeout is said as one
  { const r = rig((u) => Object.assign(new Error('x'), { name: 'TimeoutError' }), [A]); await assert.rejects(r.rpc.call(...CALL), /a\.test timed out/); }
  // limited: the round is made again after a pause, up to the rounds given, and the last round's reasons are the message
  {
    const r = rig(() => http(429));
    await assert.rejects(r.rpc.call(...CALL), (e) => { assert.equal(e.message, 'rpc eth_call failed: a.test HTTP 429; b.test HTTP 429; c.test:8545 HTTP 429'); return true; });
    assert.deepEqual(r.sleeps, [1500, 3000], 'two pauses between three rounds'); assert.equal(r.calls.length, 9);
  }
  // and a limit that lifts between rounds is read through
  { const r = rig((u, n) => (n < 2 ? rpcErr('Rate limit exceeded') : ok('0x77'))); assert.equal(await r.rpc.call(...CALL), '0x77'); assert.deepEqual(r.sleeps, [1500]); }
  // what a node says in an error is kept short and without addresses; JSON-RPC errors count as limits when they say so
  {
    const r = rig(() => rpcErr('Too Many Requests, see https://secret.example/key/abcdef for plans and more words that go on and on and on and on'), [A], 1);
    await assert.rejects(r.rpc.call(...CALL), (e) => { assert.ok(!/secret\.example|abcdef/.test(e.message), e.message); assert.ok(e.message.length < 200); return true; });
  }
  // an empty result ('0x') is an answer; a missing one is not
  { const r = rig(() => ok('0x')); assert.equal(await r.rpc.call(...CALL), '0x'); }
  { const r = rig(() => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1 }) }), [A], 1); await assert.rejects(r.rpc.call(...CALL), /a\.test empty result/); }
  // every node resting: they are still asked, in order, rather than refusing the read
  {
    let fail = true;
    const r = rig((u) => (fail ? http(500) : ok('0x02')), [A, B]);
    await assert.rejects(r.rpc.call(...CALL)); fail = false;
    assert.equal(await r.rpc.call(...CALL), '0x02', 'both resting, and the read still goes through'); assert.equal(r.calls.at(-1), A);
  }
  // the default list: archive nodes only (not the present-only ones), no repeats, a public key last
  assert.ok(ARCHIVE_RPCS_MAINNET.length >= 4 && new Set(ARCHIVE_RPCS_MAINNET).size === ARCHIVE_RPCS_MAINNET.length); assert.ok(!ARCHIVE_RPCS_MAINNET.some((u) => /publicnode/.test(u)));
  assert.match(ARCHIVE_RPCS_MAINNET.at(-1), /nodereal/, 'the node that limits readily is last');
}
console.log('pool-history: all checks passed');
