// dapp/fixed-pool-pay.js, the parts that need no page: the address checksum, how a provider is put together from the
// page's own node and the wallet, and what is kept of a note.
//
// Run: node tests/fixed-pool-pay.test.mjs

import { register } from 'node:module';
// the page's modules import each other by site path ("/x.js?cb="); this maps those to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

const { checksumOk, composeProvider, readNotes, writeNotes, metaOf, planExit, poolSize, sizeWords, findDeposit, noteSeen, seenInfo, ageWords, newestSeen, exitWarning, LOW_SINCE, LOOKBACK_BLOCKS } = await import('../dapp/fixed-pool-pay.js');
const { keccak_256 } = await import('../dapp/vendor/tacit-deps.min.js');
const { FIXED_POOLS } = await import('../dapp/fixed-pool-notes.js');

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };

console.log('checksum');
await test('the EIP-55 examples pass, in any capitalization that is all one case', () => {
  for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
    eq(checksumOk(a), true, a); eq(checksumOk(a.toLowerCase()), true, 'lower'); eq(checksumOk('0x' + a.slice(2).toUpperCase()), true, 'upper');
  }
});
await test('a mixed-case address with one letter flipped fails', () => {
  const a = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  for (let i = 2; i < a.length; i++) {
    if (!/[a-f]/i.test(a[i])) continue;
    const flipped = a.slice(0, i) + (a[i] === a[i].toUpperCase() ? a[i].toLowerCase() : a[i].toUpperCase()) + a.slice(i + 1);
    eq(checksumOk(flipped), false, `flip at ${i}`);
  }
});

console.log('provider');
const calls = [];
const read = async () => async (method, params) => { calls.push(['read', method]); return `read:${method}`; };
await test('reads go to the page\'s node, never to the wallet', async () => {
  const p = composeProvider({ read, wallet: () => { throw new Error('the wallet was asked'); } });
  for (const m of ['eth_call', 'eth_getLogs', 'eth_blockNumber', 'eth_getCode', 'eth_feeHistory', 'eth_getTransactionReceipt', 'eth_getBalance']) eq(await p.request({ method: m, params: [] }), `read:${m}`);
});
await test('signing, sending and batches go to the wallet, never to the node', async () => {
  const seen = [];
  const wallet = () => ({ request: async ({ method }) => { seen.push(method); return `wallet:${method}`; } });
  const p = composeProvider({ read: async () => { throw new Error('the node was asked'); }, wallet });
  for (const m of ['eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus', 'wallet_getCapabilities']) eq(await p.request({ method: m, params: [] }), `wallet:${m}`);
  eq(seen.length, 5);
});
await test('a wallet method with no wallet connected is an error, not a silent read', async () => {
  const p = composeProvider({ read, wallet: () => null });
  let msg = null; try { await p.request({ method: 'eth_sendTransaction', params: [] }); } catch (e) { msg = e.message; }
  eq(msg, 'Connect your wallet first.');
});

console.log('kept notes');
const mem = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), m }; };
const pool = FIXED_POOLS[1][1];
const secrets = { commitment: 123n, nullifierHash: 456n };
await test('what is kept names the note and opens nothing: nonce, pool, commitment, nullifier hash', () => {
  const m = metaOf({ nonce: 4, pool, secrets: { ...secrets, nullifier: new Uint8Array(31), secret: new Uint8Array(31), preimage: new Uint8Array(62) } });
  eq(Object.keys(m).sort().join(), 'c,nh,nonce,pool'); eq(m.pool, pool.address); eq(m.c, '0x' + (123n).toString(16).padStart(64, '0')); eq(m.nh, '0x' + (456n).toString(16).padStart(64, '0'));
});
await test('notes are kept per chain and account, without duplicates, and survive nothing worse than empty', () => {
  const s = mem();
  const a = { nonce: 0, pool: pool.address, c: '0x1', nh: '0x2' };
  writeNotes(s, 1, '0xAbC', [a, a, { ...a, nonce: 1 }]);
  eq(readNotes(s, 1, '0xabc').length, 2, 'the account is read in any case');
  eq(readNotes(s, 8453, '0xabc').length, 0, 'another chain has none');
  s.set('tacit-fixed-notes:1:0xdef', '{not json'); eq(readNotes(s, 1, '0xdef').length, 0, 'bad data');
  s.set('tacit-fixed-notes:1:0x123', '{"a":1}'); eq(readNotes(s, 1, '0x123').length, 0, 'not a list');
});
await test('a store that throws does not break writing', () => {
  const s = { get: () => null, set: () => { throw new Error('quota'); } };
  eq(writeNotes(s, 1, '0xabc', [{ nonce: 0, pool: pool.address }]).length, 1);
});

console.log('whole notes for a withdrawal');
const E = 10n ** 18n, T = E / 10n;
const sum = (dens, picks) => picks.reduce((t, i) => t + dens[i], 0n);
await test('the notes pay up to the amount and never past it: largest first, each only if it still fits', () => {
  eq(planExit(5n * E / 2n, [E, E, E]).total, 2n * E, '2.5 with three 1 ETH notes');
  eq(planExit(E / 2n, [E, E]).total, 0n, 'less than a note takes none');
  eq(planExit(E, [E, E]).total, E, 'exactly one');
  eq(planExit(3n * E, [E, E]).total, 2n * E, 'more than the notes hold takes them all');
  eq(planExit(12n * E + E / 2n, [10n * E, E, E, E]).total, 12n * E, 'a 10 ETH note first, then 1 ETH notes');
  eq(planExit(9n * E + E / 2n, [10n * E, E, E, E]).total, 3n * E, 'a note that does not fit is skipped, the smaller ones are used');
});
await test('mixed sizes: the picks are indices into the list, the larger sizes first, and the total is their sum', () => {
  const dens = [T, E, T, 10n * E, E];
  const r = planExit(11n * E + 3n * T, dens);
  eq(r.total, sum(dens, r.picks), 'the total is what the picks add up to');
  eq(r.total, 11n * E + 2n * T, '10 + 1 + 1 + 0.1 + 0.1 fits, a third 0.1 would not exist');
  eq(new Set(r.picks).size, r.picks.length, 'no note twice');
  eq(dens[r.picks[0]], 10n * E, 'largest first');
});
await test('nothing to pay, nothing held, a zero-size note: no picks', () => {
  eq(planExit(0n, [E]).picks.length, 0); eq(planExit(E, []).picks.length, 0); eq(planExit(E, [0n]).picks.length, 0);
});
await test('the same sizes give the same picks, whatever order the notes are listed in', () => {
  const a = planExit(2n * E + T, [E, T, E, T, E]), b = planExit(2n * E + T, [T, E, E, E, T]);
  eq(a.total, b.total); eq(a.picks.length, b.picks.length);
});

console.log('pool size (the crowd a note blends in with)');
const fakeRead = (idx, bal, calls = []) => async () => async (method, params) => { calls.push([method, params[0]?.data ?? params[0]]); return method === 'eth_call' ? idx : bal; };
const pool1 = { address: '0x00000000000000000000000000000000000000a1', denomination: E };
await test('deposits so far come from nextIndex(), notes in the pool now from its balance over its size', async () => {
  const calls = [];
  const s = await poolSize(fakeRead('0x' + (97860).toString(16), '0x' + (4221n * E).toString(16), calls), pool1, 1000);
  eq(s.deposits, 97860, 'deposits'); eq(s.held, 4221, 'held');
  eq(calls.find((c) => c[0] === 'eth_call')[1], '0xfc7e9c6f', 'nextIndex()');
});
await test('the answer is kept for five minutes, then read again', async () => {
  const p = { address: '0x00000000000000000000000000000000000000a2', denomination: E };
  const calls = [];
  await poolSize(fakeRead('0x10', '0x' + (3n * E).toString(16), calls), p, 0);
  await poolSize(fakeRead('0x10', '0x' + (3n * E).toString(16), calls), p, 299_000);
  eq(calls.length, 2, 'one read of two calls, the second answered from what was kept');
  await poolSize(fakeRead('0x11', '0x' + (3n * E).toString(16), calls), p, 301_000);
  eq(calls.length, 4, 'read again after five minutes');
});
await test('an unreadable answer, or notes held beyond the deposits made, is an error, and is not kept', async () => {
  const p = { address: '0x00000000000000000000000000000000000000a3', denomination: E };
  for (const [idx, bal] of [['0x', '0x0'], ['0x5', 'nope'], [undefined, '0x0'], ['0x5', '0x' + (9n * E).toString(16)]]) {
    let err = null; try { await poolSize(fakeRead(idx, bal), p, 0); } catch (e) { err = e; }
    if (!err) throw new Error(`no error for ${idx} ${bal}`);
  }
  eq((await poolSize(fakeRead('0x5', '0x' + (2n * E).toString(16)), p, 0)).held, 2, 'the failures left nothing behind');
});
await test('the line says it in plain words, with thousands separators', () => {
  eq(sizeWords(E, { deposits: 97860, held: 4221 }), '1 ETH pool: 97,860 deposits so far, 4,221 notes in it now.');
  eq(sizeWords(E / 10n, { deposits: 3, held: 1 }), '0.1 ETH pool: 3 deposits so far, 1 note in it now.');
});

console.log('when a note went in (the deposit log, looked for in pieces a free node answers)');
const TOPIC0 = '0x' + Buffer.from(keccak_256(new TextEncoder().encode('Deposit(bytes32,uint32,uint256)'))).toString('hex');
const C1 = '0x' + '11'.repeat(32), C2 = '0x' + '22'.repeat(32);
const logOf = (c, block, index, time) => ({ topics: [TOPIC0, c], blockNumber: '0x' + block.toString(16), data: '0x' + index.toString(16).padStart(64, '0') + time.toString(16).padStart(64, '0') });
// a node holding `logs`; `maxRange` makes it refuse a longer range as a free plan does; `calls` records each log query's [from, to] that it answered,
// `refused` those it did not
const logNode = ({ logs = [], tip = 20_000_000, maxRange = Infinity, calls = [], refused = [] } = {}) => async () => async (method, params) => {
  if (method === 'eth_blockNumber') return '0x' + tip.toString(16);
  if (method !== 'eth_getLogs') throw new Error('unexpected ' + method);
  const q = params[0], a = parseInt(q.fromBlock, 16), b = parseInt(q.toBlock, 16);
  if (b - a + 1 > maxRange) { refused.push([a, b]); throw new Error('ranges over ' + maxRange + ' blocks are not supported on free plan'); }
  calls.push([a, b]);
  return logs.filter((l) => l.topics[1] === q.topics[1] && parseInt(l.blockNumber, 16) >= a && parseInt(l.blockNumber, 16) <= b);
};
const P = { address: '0x00000000000000000000000000000000000000b1', denomination: E, deployBlock: 9_000_000 };
const memStore = () => { const m = new Map(); return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), m }; };
await test('a deposit in the newest piece is found with one query for its topic and commitment, giving its leaf number and time', async () => {
  const calls = [];
  const f = await findDeposit({ read: logNode({ logs: [logOf(C1, 19_999_000, 4321, 1_700_000_000)], calls }), pool: P, commitment: C1, tip: 20_000_000 });
  eq(f.i, 4321, 'leaf'); eq(f.t, 1_700_000_000, 'time'); eq(calls.length, 1, 'one query');
});
await test('an older deposit is found a piece or two back, newest first, with its own commitment and not a neighbour\'s', async () => {
  const calls = [];
  const f = await findDeposit({ read: logNode({ logs: [logOf(C1, 19_980_000, 7, 1_699_000_000), logOf(C2, 19_999_999, 8, 1)], maxRange: 10_000, calls }), pool: P, commitment: C1, tip: 20_000_000 });
  eq(f.i, 7, 'the one with its own commitment'); eq(calls.length, 3, 'three pieces of just under ten thousand, none refused by a node that takes ten thousand');
  if (calls[0][1] !== 20_000_000 || calls[1][1] >= calls[0][0]) throw new Error('newest first, no overlap');
});
await test('a node that takes only a short range is asked in halves, the newer first, and the older half is not asked once the newer has it', async () => {
  const calls = [], refused = [];
  const f = await findDeposit({ read: logNode({ logs: [logOf(C1, 19_999_000, 7, 1_699_000_000)], maxRange: 3000, calls, refused }), pool: P, commitment: C1, tip: 20_000_000 });
  eq(f.i, 7);
  if (calls.some(([a, b]) => b - a + 1 > 3000)) throw new Error('an answered query was longer than the node takes');
  eq(refused.length, 2, 'the whole piece, then its newer half, were refused');
  eq(calls.length, 1, 'then the newest quarter had it, and nothing older was asked');
});
await test('nothing in a month is null, after reading back no further than the lookback, in 22 pieces', async () => {
  const calls = [];
  eq(await findDeposit({ read: logNode({ calls }), pool: P, commitment: C1, tip: 20_000_000 }), null);
  eq(Math.min(...calls.map((c) => c[0])), 20_000_000 - LOOKBACK_BLOCKS, 'back to the lookback and no further');
  eq(calls.length, 22, 'twenty-two pieces');
  if (calls.some(([a, b]) => b - a + 1 > 9_999)) throw new Error('a piece was longer than 9,999 blocks');
});
await test('a node that refuses even a piece is asked in halves; one that refuses everything is an error, not a miss', async () => {
  const f = await findDeposit({ read: logNode({ logs: [logOf(C1, 19_995_500, 9, 5)], maxRange: 3000 }), pool: P, commitment: C1, tip: 20_000_000 });
  eq(f.i, 9, 'found through halves');
  let err = null; try { await findDeposit({ read: logNode({ maxRange: 10 }), pool: P, commitment: C1, tip: 20_000_000 }); } catch (e) { err = e; }
  if (!err) throw new Error('a refusing node must not read as "not there"');
});
await test('the pool\'s own deploy block bounds the search', async () => {
  const calls = [];
  await findDeposit({ read: logNode({ calls }), pool: { ...P, deployBlock: 19_990_000 }, commitment: C1, tip: 20_000_000 });
  eq(Math.min(...calls.map((c) => c[0])), 19_990_000);
});
await test('what is found is kept for good, per commitment, and read from the store the next time with no query', async () => {
  const store = memStore(), calls = [];
  const args = { read: logNode({ logs: [logOf(C1, 19_999_500, 55, 1_700_000_100)], calls }), store, chainId: 1, pool: P, commitment: C1.toUpperCase().replace('0X', '0x') };
  const a = await noteSeen(args);
  eq(a.i, 55); const n = calls.length;
  const b = await noteSeen(args);
  eq(b.t, 1_700_000_100); eq(calls.length, n, 'no second query');
  eq(JSON.parse(store.get('tacit-fixed-seen:1'))[C1].i, 55, 'kept under the lowercase commitment');
  eq(store.get('tacit-fixed-seen:8453'), null, 'another chain has nothing');
});
await test('a first miss is not believed: nothing is said for ten minutes, then a second scan decides (old if it misses again, found if the node has caught up)', async () => {
  const store = memStore(), calls = [], logs = [];
  let clock = 1_700_000_000;
  const args = { read: logNode({ logs, calls }), store, chainId: 1, pool: P, commitment: C1, now: () => clock };
  eq(await noteSeen(args), null, 'first miss: not known');
  const n = calls.length;
  eq(n, 22, 'the whole month was read the first time');
  eq(JSON.parse(store.get('tacit-fixed-seen:1'))[C1].tip, 20_000_000, 'the block of the first look is kept');
  clock += 599; eq(await noteSeen(args), null, 'still not known inside ten minutes');
  eq(calls.length, n, 'and not looked for again inside them');
  clock += 2;
  eq((await noteSeen(args))?.old, true, 'a second miss ten minutes on is believed');
  eq(calls.length - n, 1, 'and it read only the blocks around the first look: one query');
  const m = calls.length; eq((await noteSeen(args)).old, true); eq(calls.length, m, 'and kept');
  // the other road: the node was behind at the first look and has the deposit at the second
  const store2 = memStore(); let clock2 = 1_700_000_000; const logs2 = [];
  const args2 = { read: logNode({ logs: logs2 }), store: store2, chainId: 1, pool: P, commitment: C2, now: () => clock2 };
  eq(await noteSeen(args2), null);
  logs2.push(logOf(C2, 19_999_990, 3, 1_700_000_001)); clock2 += 700;
  eq((await noteSeen(args2)).i, 3, 'found, not called old');
  // a deposit well outside the blocks around the first look is not what a lagging node misses: it is not searched for again
  const store3 = memStore(); let clock3 = 1_700_000_000; const logs3 = [];
  const args3 = { read: logNode({ logs: logs3 }), store: store3, chainId: 1, pool: P, commitment: C1, now: () => clock3 };
  eq(await noteSeen(args3), null);
  logs3.push(logOf(C1, 19_990_000, 4, 1)); clock3 += 700;
  eq((await noteSeen(args3)).old, true, 'ten thousand blocks back is not a lagging node, and the second look does not go there');
});
await test('two lookups for one note at once make one scan; an error leaves nothing kept and the next call tries again', async () => {
  const store = memStore(), calls = [];
  const slow = logNode({ logs: [logOf(C1, 19_999_000, 1, 2)], calls });
  const [x, y] = await Promise.all([noteSeen({ read: slow, store, chainId: 1, pool: P, commitment: C1 }), noteSeen({ read: slow, store, chainId: 1, pool: P, commitment: C1 })]);
  eq(x.i, 1); eq(y.i, 1); eq(calls.length, 1, 'one scan for both');
  const store2 = memStore(); let err = null;
  try { await noteSeen({ read: logNode({ maxRange: 5 }), store: store2, chainId: 1, pool: P, commitment: C2 }); } catch (e) { err = e; }
  if (!err) throw new Error('should have thrown'); eq(store2.get('tacit-fixed-seen:1'), null, 'nothing kept');
  eq((await noteSeen({ read: logNode({ logs: [logOf(C2, 19_999_000, 6, 7)] }), store: store2, chainId: 1, pool: P, commitment: C2 })).i, 6, 'tried again');
});
await test('a store that throws or holds rubbish does not stop the lookup', async () => {
  const bad = { get: () => '{not json', set: () => { throw new Error('quota'); } };
  eq((await noteSeen({ read: logNode({ logs: [logOf(C1, 19_999_000, 2, 3)] }), store: bad, chainId: 1, pool: P, commitment: C1 })).i, 2);
});
console.log('the words under a note');
await test('age in plain words', () => {
  eq(ageWords(30), 'just now'); eq(ageWords(600), '10 minutes ago'); eq(ageWords(3600), '60 minutes ago');
  eq(ageWords(2 * 3600), '2 hours ago'); eq(ageWords(3600 * 20), '20 hours ago'); eq(ageWords(86400 * 3), '3 days ago'); eq(ageWords(86400 * 36), '36 days ago');
});
await test('deposits since = the pool\'s count less the note\'s leaf and itself; early when fewer than the limit', () => {
  const now = 1_700_010_000;
  const s = seenInfo({ i: 100, t: now - 3 * 3600 }, { deposits: 112 }, now);
  eq(s.text, 'Deposited 3 hours ago · 11 deposits since'); eq(s.low, true, '11 is early'); eq(s.since, 11);
  const o = seenInfo({ i: 100, t: now - 3 * 3600 }, { deposits: 100 + 1 + LOW_SINCE }, now);
  eq(o.low, false, 'exactly the limit is not early'); eq(o.since, LOW_SINCE);
  eq(seenInfo({ i: 100, t: now - 60 }, { deposits: 101 }, now).text, 'Deposited just now · 0 deposits since');
  eq(seenInfo({ i: 100, t: now }, { deposits: 50 }, now).since, 0, 'a count behind the leaf (a lagging node) is zero, not negative');
  eq(seenInfo({ i: 1, t: now }, { deposits: 3 }, now).text.endsWith('1 deposit since'), true, 'singular');
});
await test('with the pool\'s count unread: no count, early only under an hour; an old note says so and is never early; nothing known says nothing', () => {
  const now = 1_700_010_000;
  const a = seenInfo({ i: 1, t: now - 1800 }, null, now); eq(a.text, 'Deposited 30 minutes ago'); eq(a.low, true);
  eq(seenInfo({ i: 1, t: now - 7200 }, null, now).low, false);
  const o = seenInfo({ old: true }, { deposits: 5 }, now); eq(o.text, 'Deposited over a month ago'); eq(o.low, false);
  eq(seenInfo(null, null, now), null); eq(seenInfo({ i: NaN, t: 1 }, null, now), null);
});
await test('the withdrawal\'s warning names the newest early note, and says nothing when none is early', () => {
  const now = 1_700_010_000;
  const e = (i, t, deposits) => ({ seen: seenInfo({ i, t }, { deposits }, now) });
  eq(exitWarning([e(10, now - 86400 * 9, 5000), e(4990, now - 600, 5000)]).startsWith('Part of this went in recently: the newest note has only 9 deposits after it.'), true);
  eq(exitWarning([e(10, now - 86400 * 9, 5000)]), '', 'a note with many after it');
  eq(exitWarning([{}, { seen: null }, { seen: seenInfo({ old: true }, null, now) }]), '');
  eq(exitWarning([{ seen: seenInfo({ i: 1, t: now - 60 }, null, now) }]), 'Part of this went in less than an hour ago. Waiting longer hides it better.');
  eq(exitWarning([e(4990, now - 600, 5000), e(4999, now - 60, 5000)]).startsWith('Part of this went in recently: the newest note has no deposits after it.'), true, 'the fewest of the early ones, and none is said as none');
  eq(exitWarning([e(4998, now - 60, 5000)]).includes('only 1 deposit after it'), true, 'one, singular');
});
await test('the Withdraw tab\'s line is for the newest note', () => {
  const now = 1_700_010_000;
  const l = [{ seen: seenInfo({ i: 10, t: now - 86400 * 3 }, { deposits: 5000 }, now) }, { seen: seenInfo({ i: 4995, t: now - 7200 }, { deposits: 5000 }, now) }, {}];
  const n = newestSeen(l);
  eq(n.text.startsWith('Newest note: deposited 2 hours ago · 4 deposits since.'), true, n.text); eq(n.low, true);
  eq(newestSeen([{}, { seen: seenInfo({ old: true }, null, now) }]), null, 'an old note has no time to compare');
  eq(newestSeen([]), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
