// dapp/bridge-tick.js, a pass over the bridges under way as any page makes it: what is signed under the key and what is only read again, a
// burn sent only on the holder's plan, a failing Bitcoin step left to rest, and nothing signed for another key.
//   node tests/bridge-tick.test.mjs
import assert from 'node:assert/strict';
import { stepIn, stepOut, advanceOut, outPubs, waitRanOut, discoverIn, unsearched, discoverEvery, FOUND_KEY, DEEP_KEY } from '../dapp/bridge-tick.js';

const PUB = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32);
const withKey = async (fn, pub) => { if (pub !== PUB) throw new Error('other key'); return fn(); };
const priv = () => 'PRIV';

// ── in ──
function inUx(recs, next) {
  const calls = [];
  return {
    calls,
    list: () => recs,
    armMint: async (pub, id, o) => { calls.push(['arm', id, o.walletPriv]); },
    mintRetryDue: (rec, { ranOut }) => rec.due === true || (ranOut && rec.due === 'ranOut'),
    advance: async (pub, id, o) => { calls.push(['advance', id, o?.walletPriv ?? null, o?.maxFeeRate ?? null]); return next(id, o); },
    verify: async (pub, id) => { calls.push(['verify', id]); return recs.find((r) => r.id === id); },
  };
}
{
  const recs = [
    { id: 'done', stage: 'minted' }, { id: 'held', stage: 'stopped' },
    { id: 'wait', stage: 'burn-mined' },
    { id: 'tr', stage: 'traced' },
    { id: 'plan', stage: 'traced' },
    { id: 'ready', stage: 'folded', due: true },
    { id: 'early', stage: 'rfolded', due: false },
    { id: 'arm', stage: 'rburn-mined', path: 'reflected', mint: {}, arm: { tries: 1 } },
  ];
  const ux = inUx(recs, (id) => ({ wait: { id, stage: 'registered' }, plan: { id, stage: 'burn-submitted' }, ready: { id, stage: 'minted' }, arm: { id, stage: 'rburn-mined' } })[id]);
  const told = [];
  const { moved } = await stepIn({ ux, pub: PUB, withKey, priv, planOf: (r) => (r.id === 'plan' ? { burn: { maxRate: 9 } } : null),
    on: { burnSent: (r) => told.push(['burn', r.id]), minted: (r) => told.push(['minted', r.id]), traced: (r) => told.push(['traced', r.id]) } });
  assert.equal(moved, true);
  assert.deepEqual(ux.calls, [
    ['advance', 'wait', null, null],
    ['verify', 'tr'],
    ['advance', 'plan', 'PRIV', 9],
    ['advance', 'ready', 'PRIV', null],
    ['verify', 'early'],
    ['arm', 'arm', 'PRIV'], ['advance', 'arm', null, null],
  ], 'done and held bridges are left alone; a traced bridge burns only on its plan; a ready mint is sent only when due; the rest is read again');
  assert.deepEqual(told, [['burn', 'plan'], ['minted', 'ready']]);
}
{
  const ux = inUx([{ id: 'a', stage: 'burn-mined' }, { id: 'b', stage: 'burn-mined' }], (id) => ({ id, stage: 'burn-mined' }));
  let n = 0;
  const { moved } = await stepIn({ ux, pub: PUB, withKey, priv, alive: () => n++ < 1 });
  assert.equal(moved, false, 'nothing moved: nothing to redraw');
  assert.equal(ux.calls.length, 1, 'the pass stops once the key changes');
}
{
  const ux = inUx([{ id: 'x', stage: 'burn-mined' }], () => { throw new Error('read'); });
  assert.equal((await stepIn({ ux, pub: PUB, withKey, priv })).moved, true, 'a failure is redrawn (its row says so)');
}
assert.equal(waitRanOut(new Error('settle timed out after 900s')), true); assert.equal(waitRanOut(new Error('relay 429')), false);

// ── out ──
function outUx(steps) {
  const calls = [];
  return {
    calls,
    advance: async (pub, id, o) => { calls.push(['advance', pub.slice(0, 2), id, o?.walletPriv ?? null, o?.allowHighFee ?? null]); const s = steps[id]; return typeof s === 'function' ? s() : s.shift(); },
    recoverFromEthTx: async (h, p, o) => { calls.push(['recover', h, p, String(o.amount)]); return { id: 'unv', stage: 'settled', settle: { claimIdVerified: true }, source: { amount: '5' } }; },
  };
}
{
  const ux = outUx({ c: [{ id: 'c', stage: 'covered' }, { id: 'c', stage: 'mint-signed' }, { id: 'c', stage: 'mint-submitted' }] });
  const after = await advanceOut(ux, PUB, { id: 'c', stage: 'settled' }, { withKey, priv, keyPub: () => PUB });
  assert.equal(after.stage, 'mint-submitted');
  assert.deepEqual(ux.calls.map((c) => c[3]), [null, 'PRIV', null], 'only the Bitcoin step (from covered) is signed');
  const u2 = outUx({ c: [{ id: 'c', stage: 'covered' }] });
  assert.equal((await advanceOut(u2, OTHER, { id: 'c', stage: 'settled' }, { withKey, priv, keyPub: () => PUB })).stage, 'covered', 'another key\'s bridge stops before its Bitcoin step');
}
{
  const now = Date.now();
  const recs = {
    [PUB]: [
      { id: 'unv', stage: 'settled', settle: { claimIdVerified: false, txHash: 'ab' }, source: { amount: '5' } },
      { id: 'rest', stage: 'covered', lastError: { at: now - 60e3 }, errorCount: 1 },
      { id: 'tired', stage: 'mint-signed', lastError: { at: now - 3600e3 }, errorCount: 6 },
      { id: 'fund', stage: 'covered', lastError: { at: now - 3 * 60e3, fundWait: true }, errorCount: 9 },
      { id: 'fund2', stage: 'covered', lastError: { at: now - 11 * 60e3 }, errorCount: 1 },
      { id: 'go', stage: 'mint-confirmed' },
    ],
    [OTHER]: [{ id: 'theirs', stage: 'mint-confirmed' }],
  };
  const ux = outUx({ unv: () => ({ id: 'unv', stage: 'settled' }), fund: () => { throw Object.assign(new Error('fund'), { fundWait: true, needSats: 900 }); }, fund2: () => { throw Object.assign(new Error('fund'), { fundWait: true, needSats: 900 }); }, go: () => ({ id: 'go', stage: 'minted' }), theirs: () => ({ id: 'theirs', stage: 'minted' }) });
  const told = [], rechecked = {};
  const moved = await stepOut({ ux, pubs: [PUB, OTHER], records: (p) => recs[p], keyPub: () => PUB, withKey, priv, rechecked, on: { arrived: (r) => told.push(['arrived', r.id]), fundWait: (r) => told.push(['fund', r.id]) } });
  assert.deepEqual(ux.calls.map((c) => c[0] === 'recover' ? `recover:${c[1]}:${c[3]}` : `adv:${c[2]}`), ['recover:0xab:5', 'adv:unv', 'adv:fund', 'adv:fund2', 'adv:go', 'adv:theirs'],
    'an unmatched claim is rebuilt from its transaction; a step that failed a minute ago, or six times, rests; one waiting for bitcoin is tried after two minutes');
  assert.ok(rechecked.unv > 0);
  assert.deepEqual(moved.map((r) => r.id), ['unv', 'fund', 'fund2', 'go', 'theirs']);
  assert.deepEqual(told, [['fund', 'fund2'], ['arrived', 'go']], 'arrivals are told for the open key only; a wait for bitcoin is told when it is new, not again');
}
{
  const m = new Map([['tacit-crossout-bridge-v1:mainnet:' + PUB, '[]'], ['tacit-crossout-bridge-v1:mainnet:xyz', '[]'], ['other', '']]);
  const st = { length: m.size, key: (i) => [...m.keys()][i] };
  assert.deepEqual(outPubs(st), [PUB], 'keys are read from the journals\' names, and only well-formed ones');
}
// ── bridges with no record ──
{
  const m = new Map(), memory = { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
  const pages = (n) => Array.from({ length: n }, (_, i) => ({ txid: String(i).padStart(64, '0') }));
  const asked = [], esplora = async (path) => { asked.push(path); return path.includes('/chain/') ? pages(25) : pages(25); };
  const calls = [];
  const T = { wallet: { address: () => 'bc1qkey' }, bridgeUx: () => ({ discover: async (o) => { calls.push(o); return { found: [{ id: 'f' }], tried: ['t1', 't2'], left: 0 }; } }) };
  const withKey = async (fn, p) => { if (p !== PUB) throw new Error('other key'); return fn(T); };
  assert.equal(unsearched(PUB, [], memory), true); assert.equal(unsearched(PUB, [{}], memory), false, 'a key with a bridge listed has been seen'); assert.equal(unsearched(null, [], memory), false);
  assert.equal(discoverEvery(true), 2 * 60e3); assert.equal(discoverEvery(false, true), 10 * 60e3); assert.equal(discoverEvery(false), 60 * 60e3);
  const r = await discoverIn({ pub: PUB, listed: [], esplora, withKey, priv: () => 'PRIV', memory });
  assert.equal(r.deep, true); assert.equal(r.found.length, 1);
  assert.equal(asked.length, 8, 'a key never searched is read eight pages deep (the first and seven more)');
  assert.equal(asked[0], '/address/bc1qkey/txs'); assert.ok(asked[1].startsWith('/address/bc1qkey/txs/chain/'));
  assert.equal(calls[0].txs.length, 200); assert.equal(calls[0].limit, 80); assert.deepEqual(calls[0].skip, []);
  assert.deepEqual(memory.get(FOUND_KEY)[PUB], ['t1', 't2'], 'what was tried is not tried again'); assert.ok(memory.get(DEEP_KEY)[PUB] > 0, 'and the long search is done once');
  asked.length = 0; calls.length = 0;
  const r2 = await discoverIn({ pub: PUB, listed: [{ id: 'x' }], esplora, withKey, priv: () => 'PRIV', memory });
  assert.equal(r2.deep, false); assert.equal(asked.length, 2, 'the others look one page back'); assert.equal(calls[0].limit, 20); assert.deepEqual(calls[0].skip, ['t1', 't2']);
  // a long search that did not finish is done again
  m.clear(); T.bridgeUx = () => ({ discover: async () => ({ found: [], tried: ['a'], left: 3 }) });
  await discoverIn({ pub: PUB, listed: [], esplora, withKey, priv: () => 'PRIV', memory });
  assert.equal(memory.get(DEEP_KEY), null, 'with more left to try, the long search is not marked done');
  // an explorer that fails on a later page still searches what it read
  const flaky = async (path) => { if (path.includes('/chain/')) throw new Error('down'); return pages(25); };
  const r3 = await discoverIn({ pub: PUB, listed: [{}], esplora: flaky, withKey, priv: () => 'PRIV', memory });
  assert.equal(r3.found.length, 0);
}
// ── out: a bridge that arrived ready is bound under the open key, rests after a failure, and is told once ──
{
  const recs = [
    { id: 'r1', stage: 'minted', ready: true },
    { id: 'r2', stage: 'minted', ready: true, bindError: { at: Date.now(), fundWait: true } },
    { id: 'r3', stage: 'minted' },
  ];
  const calls = [], readied = [];
  const ux = {
    list: () => recs, advance: async () => { throw new Error('nothing to advance'); },
    bindDue: (r) => r.stage === 'minted' && !!r.ready && !(r.bind && r.bind.sent),
    bindNow: async (pub, id, o) => { calls.push([pub, id, o.walletPriv]); const r = recs.find((x) => x.id === id); r.bind = { sent: true }; return r; },
  };
  const moved = await stepOut({ ux, pubs: [PUB], records: () => [], keyPub: () => PUB, withKey, priv, on: { readied: (r) => readied.push(r.id) } });
  assert.deepEqual(calls, [[PUB, 'r1', 'PRIV']], 'the due one is bound under the key; one that just failed for want of sats rests; one not ready is left');
  assert.deepEqual(readied, ['r1']);
  assert.equal(moved.length, 1);
  await stepOut({ ux, pubs: [PUB], records: () => [], keyPub: () => PUB, withKey, priv, on: { readied: (r) => readied.push(r.id) } });
  assert.deepEqual(readied, ['r1'], 'a bound one is not bound or told again');
  calls.length = 0;
  await stepOut({ ux, pubs: [PUB], records: () => [], keyPub: () => null, withKey, priv });
  assert.deepEqual(calls, [], 'with no key open nothing is signed');
}
console.log('bridge-tick: all checks passed');
