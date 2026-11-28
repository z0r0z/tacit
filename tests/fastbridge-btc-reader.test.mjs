// How the Bitcoin side of a fast bridge party reads the explorers (dapp/fastbridge-btc.js, makeEsploraBtcChain): the explorers are shared and rate
// limited, so an explorer that is failing is left alone for a while and asked last, the load is spread over the ones that answer, reads for the same
// path that are under way together are one read, and only so many are out at once. The 404 rule stays: a 404 from one explorer is not an answer
// while another may have the transaction.
//   node tests/fastbridge-btc-reader.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';

const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const tid = (n) => n.toString(16).padStart(64, '0');
const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const gone = () => json('not found', 404);
const chainOf = (hosts, handler, opts = {}) => {
  let t = 1_000_000; const seen = [];
  const fetchImpl = async (url) => { const u = new URL(url); seen.push(u.hostname); return handler(u, seen.length); };
  const btc = makeEsploraBtcChain({ bases: hosts.map((h) => `https://${h}/api`), prims, builder: null, fetchImpl, nowMs: () => t, ...opts });
  return { btc, seen, later: (ms) => { t += ms; } };
};
const read = (btc, n) => btc.outspend(tid(n), 0);          // a different path for each n: GET /tx/<id>/outspend/0

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('an explorer that rate limits is passed over for the next, and left alone on the reads after it', async () => {
  const { btc, seen } = chainOf(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' ? json('slow down', 429) : json({ spent: false })));
  await read(btc, 1);
  assert.deepEqual(seen, ['limited.test', 'calm.test'], 'the first read tried the limited one and went on');
  await read(btc, 2); await read(btc, 3);
  assert.deepEqual(seen.slice(2), ['calm.test', 'calm.test'], 'the limited one is not asked again while it cools');
});

test('an explorer being left alone is logged once, with its name and why, so a log shows which explorer limited or failed', async () => {
  const lines = [];
  const { btc } = chainOf(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' ? json('slow down', 429) : json({ spent: false })), { log: (o) => lines.push(o) });
  for (let n = 1; n <= 5; n++) await read(btc, n);
  const said = lines.filter((l) => l.msg === 'an explorer is left alone for a while');
  assert.equal(said.length, 1, 'once, not for every read');
  assert.equal(said[0].explorer, 'limited.test');
  assert.equal(said[0].why, 'HTTP 429');
  assert.equal(said[0].forSecs, 20);
});

test('it is asked again when its time has passed, and an answer puts it back among the others', async () => {
  let limited = true;
  const { btc, seen, later } = chainOf(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' && limited ? json('slow down', 429) : json({ spent: false })));
  await read(btc, 1); later(21_000);
  limited = false;
  const before = seen.length;
  await read(btc, 2);
  assert.ok(seen.slice(before).includes('limited.test') || (await read(btc, 3), seen.slice(before).includes('limited.test')), 'asked again after the cool-down');
  const mark = seen.length;
  for (let n = 10; n < 18; n++) await read(btc, n);
  const asked = seen.slice(mark);
  assert.ok(asked.includes('limited.test') && asked.includes('calm.test'), 'and the load is spread over both again');
});

test('a Retry-After longer than the usual wait is kept to', async () => {
  const { btc, seen, later } = chainOf(['limited.test', 'calm.test'], (u) => (u.hostname === 'limited.test' ? json('slow down', 429, { 'retry-after': '120' }) : json({ spent: false })));
  await read(btc, 1);
  later(100_000);
  const a = seen.length; await read(btc, 2); await read(btc, 3);
  assert.ok(!seen.slice(a).includes('limited.test'), 'still cooling 100 s in, as it asked for 120');
  later(21_000);
  const b = seen.length; for (let n = 20; n < 26; n++) await read(btc, n);
  assert.ok(seen.slice(b).includes('limited.test'), 'asked again after the 120 s');
});

test('an explorer that keeps failing waits longer each time', async () => {
  const { btc, seen, later } = chainOf(['down.test', 'calm.test'], (u) => (u.hostname === 'down.test' ? json('bad gateway', 502) : json({ spent: false })));
  await read(btc, 1);                         // fails: 20 s
  later(21_000); const a = seen.length; await read(btc, 2);   // asked again (first in its turn or after calm), fails again: 40 s
  while (!seen.slice(a).includes('down.test')) await read(btc, 100 + seen.length);
  later(25_000); const b = seen.length; await read(btc, 3); await read(btc, 4);
  assert.ok(!seen.slice(b).includes('down.test'), '25 s after the second failure it is still cooling (40 s)');
  later(16_000); const c = seen.length; for (let n = 30; n < 36; n++) await read(btc, n);
  assert.ok(seen.slice(c).includes('down.test'), 'and asked again after the 40 s');
});

test('the explorers are all failing: each is still asked (the cooling ones last), and the error is the last one that answered, not a give-up', async () => {
  const { btc, seen } = chainOf(['a.test', 'b.test'], () => json('slow down', 429));
  await assert.rejects(read(btc, 1), /429/);
  await assert.rejects(read(btc, 2), /429/);
  assert.equal(seen.length, 4, 'both explorers asked on both reads, though both are cooling');
});

test('a recovery shows at once: when the explorers that were cooling answer, reads go on', async () => {
  let up = false;
  const { btc } = chainOf(['a.test', 'b.test'], () => (up ? json({ spent: false }) : json('slow down', 429)));
  await assert.rejects(read(btc, 1), /429/);
  up = true;
  assert.equal(await read(btc, 2), null, 'asked although cooling, since nobody else answers');
});

test('the load is spread: with two explorers that both answer, each is asked first in turn', async () => {
  const { btc, seen } = chainOf(['a.test', 'b.test'], () => json({ spent: false }));
  for (let n = 1; n <= 6; n++) await read(btc, n);
  assert.equal(seen.filter((h) => h === 'a.test').length, 3);
  assert.equal(seen.filter((h) => h === 'b.test').length, 3);
});

test('reads of one path that are under way together are one read', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const { btc, seen } = chainOf(['a.test'], async () => { await gate; return json({ spent: false }); });
  const all = Promise.all([read(btc, 7), read(btc, 7), read(btc, 7), read(btc, 7)]);
  await new Promise((r) => setTimeout(r, 5)); release();
  await all;
  assert.equal(seen.length, 1, 'one request for four askers');
  await read(btc, 7);
  assert.equal(seen.length, 2, 'and not kept after: a later read asks again');
});

test('no more reads are out at once than maxReads, however many are asked, and every one is answered', async () => {
  let out = 0, most = 0; const open = [];
  const { btc } = chainOf(['a.test'], async () => { out++; most = Math.max(most, out); await new Promise((r) => open.push(r)); out--; return json({ spent: false }); }, { maxReads: 3 });
  const all = Promise.all(Array.from({ length: 12 }, (_, i) => read(btc, 200 + i)));
  for (let i = 0; i < 40 && open.length < 12; i++) { await new Promise((r) => setTimeout(r, 2)); while (open.length) open.shift()(); }
  while (open.length) open.shift()();
  const done = await Promise.race([all, new Promise((r) => setTimeout(() => r('STUCK'), 3000))]);
  assert.notEqual(done, 'STUCK');
  assert.equal(most, 3, 'three at most at once');
});

test('a slot is given back when a read fails, so one failure does not stop the reads behind it', async () => {
  const { btc } = chainOf(['a.test'], (u) => (u.pathname.includes(tid(300)) ? json('boom', 500) : json({ spent: false })), { maxReads: 1 });
  await assert.rejects(read(btc, 300), /500/);
  assert.equal(await read(btc, 301), null);
  assert.equal(await read(btc, 302), null);
});

test('a 404 from one explorer is not the answer while another has it, and a 404 does not make an explorer cool', async () => {
  const { btc, seen } = chainOf(['lags.test', 'has.test'], (u) => (u.hostname === 'lags.test' ? gone() : json({ spent: true, txid: tid(9) })));
  assert.equal(await read(btc, 1), tid(9));
  const first = seen.length;
  for (let n = 2; n <= 5; n++) await read(btc, n);
  assert.ok(seen.slice(first).includes('lags.test'), 'the explorer that answered 404 is still among those asked first');
});

test('every explorer says 404: the answer is a 404 (a transaction nobody has), and two that agree beside one that failed are still the 404', async () => {
  const none = chainOf(['a.test', 'b.test'], () => gone());
  assert.equal(await none.btc.fetchTx(tid(5)), null);
  const agree = chainOf(['down.test', 'a.test', 'b.test'], (u) => (u.hostname === 'down.test' ? json('bad gateway', 502) : gone()));
  assert.equal(await agree.btc.fetchTx(tid(6)), null);
  const one = chainOf(['only.test'], () => gone());
  assert.equal(await one.btc.fetchTx(tid(7)), null, 'a single explorer that says 404 is the answer');
});

test('one explorer\'s 404 beside others that failed is not "not found": it is an error, to ask again (the one that said 404 may be the one that lags)', async () => {
  const { btc } = chainOf(['down.test', 'lags.test'], (u) => (u.hostname === 'down.test' ? json('slow down', 429) : gone()));
  await assert.rejects(btc.fetchTx(tid(8)), (e) => e.status === 429 || /429/.test(String(e.message)), 'a read that could not be made is thrown, not taken for a transaction that is not there');
});

test('a 400 (a request of ours that is wrong) does not cool an explorer', async () => {
  const { btc, seen } = chainOf(['a.test', 'b.test'], (u) => (u.hostname === 'a.test' ? json('bad request', 400) : json({ spent: false })));
  for (let n = 1; n <= 4; n++) await read(btc, n);
  assert.ok(seen.filter((h) => h === 'a.test').length >= 2, 'still asked in its turn');
});

// coinsIn: the plain coins a confirmed transaction paid to this wallet that are still unspent, read from that transaction and its outspends alone
const pathOf = (u) => u.pathname.replace(/^\/api/, '');
const mineHex = Buffer.from(prims.p2wpkhScript(prims.wallet.pub)).toString('hex'), otherHex = '0014' + 'ab'.repeat(20);
const lockTx = (vouts, confirmed = true) => ({ txid: tid(50), status: confirmed ? { confirmed: true, block_height: 800_000 } : { confirmed: false }, vout: vouts.map(([scriptpubkey, value]) => ({ scriptpubkey, value })) });
const coinsOf = (tx, spentVouts = [], extra = {}) => chainOf(['a.test'], (u) => {
  if (pathOf(u) === `/tx/${tid(50)}`) return json(tx);
  const m = /^\/tx\/[0-9a-f]{64}\/outspend\/(\d+)$/.exec(pathOf(u));
  if (m) return spentVouts.includes(Number(m[1])) ? json({ spent: true, txid: tid(77) }) : json({ spent: false });
  return json('unexpected ' + pathOf(u), 500);
}, extra);

test('coinsIn: the unspent plain coins paid to this wallet, largest first; dust, other addresses and spent coins are left out', async () => {
  const tx = lockTx([[otherHex, 546], [mineHex, 546], [mineHex, 0], [mineHex, 2046], [mineHex, 5000], [otherHex, 9000], [mineHex, 3000]]);
  const { btc, seen } = coinsOf(tx, [6]);
  assert.deepEqual(await btc.coinsIn(tid(50)), [{ txid: tid(50), vout: 4, value: 5000 }, { txid: tid(50), vout: 3, value: 2046 }], 'the coin of 3000 is spent, the rest of ours is dust');
  assert.ok(seen.length >= 1);
});

test('coinsIn: never lists the address', async () => {
  const paths = [];
  const { btc } = chainOf(['a.test'], (u) => { paths.push(pathOf(u)); return /outspend/.test(pathOf(u)) ? json({ spent: false }) : json(lockTx([[mineHex, 2046]])); });
  await btc.coinsIn(tid(50));
  assert.ok(paths.length >= 2 && paths.every((p) => p.startsWith('/tx/')), `only reads by transaction id: ${paths}`);
});

test('coinsIn: a transaction that is not confirmed, or not found, gives no coins', async () => {
  assert.deepEqual(await coinsOf(lockTx([[mineHex, 2046]], false)).btc.coinsIn(tid(50)), [], 'a coin of a transaction that may be dropped is not spent on');
  const { btc } = chainOf(['a.test'], () => gone());
  assert.deepEqual(await btc.coinsIn(tid(50)), []);
  await assert.rejects(() => btc.coinsIn('not a txid'), /not a transaction id/);
});

test('coinsIn: a coin whose spend cannot be read is left out, not guessed to be unspent', async () => {
  const tx = lockTx([[mineHex, 2046], [mineHex, 4000]]);
  const { btc } = chainOf(['a.test'], (u) => (pathOf(u) === `/tx/${tid(50)}` ? json(tx) : /outspend\/1$/.test(pathOf(u)) ? json('down', 503) : json({ spent: false })));
  assert.deepEqual(await btc.coinsIn(tid(50)), [{ txid: tid(50), vout: 0, value: 2046 }], 'the coin whose outspend failed is not offered');
});

// lockAgreed: the read a provider makes before it locks pool TAC against a lock
const agreeTx = (txid, over = {}) => ({ txid, vin: [{ txid: tid(1), vout: 0 }], vout: [{ value: 546, scriptpubkey: '5120' + 'aa'.repeat(32) }], status: { confirmed: true, block_height: 900000, block_hash: 'bb'.repeat(32) }, ...over });
const explorer = (view) => (u) => {
  const p = pathOf(u);
  if (p === '/blocks/tip/height') return json(String(view.tip ?? 900002));
  if (/outspend\/0$/.test(p)) return json({ spent: !!view.spent });
  if (p === `/tx/${tid(60)}`) return view.tx ? json(view.tx) : gone();
  return gone();
};
test('lockAgreed: two explorers that show the same lock in the same block agree, and the confirmations count from the lower tip', async () => {
  const views = { 'a.test': { tx: agreeTx(tid(60)), tip: 900002 }, 'b.test': { tx: agreeTx(tid(60)), tip: 900001 }, 'c.test': { tx: null } };
  const { btc } = chainOf(Object.keys(views), (u) => explorer(views[u.hostname])(u));
  const a = await btc.lockAgreed(tid(60), 0);
  assert.deepEqual([a.confirmations, a.height, a.value, a.spent, a.agreed], [2, 900000, 546, false, 2]);
});
test('lockAgreed: a lock that only one explorer shows is not agreed (it is asked again), and neither is one two explorers show differently', async () => {
  const one = { 'a.test': { tx: agreeTx(tid(60)) }, 'b.test': { tx: null }, 'c.test': { tx: null } };
  const { btc } = chainOf(Object.keys(one), (u) => explorer(one[u.hostname])(u));
  await assert.rejects(() => btc.lockAgreed(tid(60), 0), (e) => e.transient === true && /not yet seen alike by 2 explorers/.test(e.message));
  const split = { 'a.test': { tx: agreeTx(tid(60)) }, 'b.test': { tx: agreeTx(tid(60), { vout: [{ value: 999, scriptpubkey: '5120' + 'aa'.repeat(32) }] }) } };
  const two = chainOf(Object.keys(split), (u) => explorer(split[u.hostname])(u));
  await assert.rejects(() => two.btc.lockAgreed(tid(60), 0), /not yet seen alike/);
  const unconfirmed = { 'a.test': { tx: agreeTx(tid(60), { status: { confirmed: false } }) }, 'b.test': { tx: agreeTx(tid(60), { status: { confirmed: false } }) } };
  const three = chainOf(Object.keys(unconfirmed), (u) => explorer(unconfirmed[u.hostname])(u));
  await assert.rejects(() => three.btc.lockAgreed(tid(60), 0), /not yet seen alike/, 'a lock in no block is not one to pay against');
});
test('lockAgreed: one explorer that answers alone, with the rest refusing or silent, is thin, not refused; one that says the lock is not there, or none, is', async () => {
  const busy = () => json('slow down', 429);
  const lone = { 'a.test': { tx: agreeTx(tid(60)) } };
  const silent = chainOf(['a.test', 'b.test', 'c.test'], (u) => (u.hostname === 'a.test' ? explorer(lone['a.test'])(u) : busy()));
  const t = await silent.btc.lockAgreed(tid(60), 0);
  assert.deepEqual([t.thin, t.agreed, t.confirmations], [true, 1, 3], 'it is the one answer there is');
  const denied = chainOf(['a.test', 'b.test', 'c.test'], (u) => (u.hostname === 'a.test' ? explorer(lone['a.test'])(u) : u.hostname === 'b.test' ? gone() : busy()));
  await assert.rejects(() => denied.btc.lockAgreed(tid(60), 0), /not yet seen alike/, 'one that says it is not there is a contradiction');
  const none = chainOf(['a.test', 'b.test'], () => busy());
  await assert.rejects(() => none.btc.lockAgreed(tid(60), 0), /not yet seen alike by 2 explorers \(0 answered/, 'no answer at all is asked again');
  const two = chainOf(['a.test', 'b.test', 'c.test'], (u) => explorer({ tx: agreeTx(tid(60)) })(u));
  assert.equal((await two.btc.lockAgreed(tid(60), 0)).thin, undefined, 'two that agree are not thin');
});
test('lockAgreed: with one explorer configured, that one is the source', async () => {
  const { btc } = chainOf(['own.test'], (u) => explorer({ tx: agreeTx(tid(60)), spent: true })(u));
  const a = await btc.lockAgreed(tid(60), 0);
  assert.deepEqual([a.agreed, a.spent], [1, true]);
});

test('a note made by a bind is never kept as proved: the next walk reads it again, while an ordinary note is kept', async () => {
  const BOUND = 0x39, XFER = 0x31;
  const txOf = (n, opcode) => ({ txid: tid(n), opcode, vin: [], vout: [{ value: 546, scriptpubkey: '5120' + 'aa'.repeat(32) }], status: { confirmed: true } });
  const txs = new Map([[tid(70), txOf(70, BOUND)], [tid(71), txOf(71, XFER)], [tid(72), txOf(72, XFER)]]);
  const walks = [];
  const tacit = {
    txOutputEnvelope: (tx) => ({ opcode: tx.opcode }),
    getParentEnvelopeData: async () => null,
    // the walk of 72 reads its two parents, 70 (bound) and 71, and finds all three valid; what it was handed as known is recorded
    validateOutpoint: async (txid, vout, c, f) => {
      walks.push({ root: txid, known: [...c.keys()] });
      for (const t of [tid(70), tid(71), txid]) { await f(t); c.set(`${t}:0`, true); }
      return true;
    },
  };
  const { btc } = chainOf(['a.test'], (u) => { const m = /^\/tx\/([0-9a-f]{64})$/.exec(pathOf(u)); return m && txs.has(m[1]) ? json(txs.get(m[1])) : gone(); }, { tacit });
  await btc.resolveNote(tid(72), 0);
  await btc.resolveNote(tid(72), 1);
  const known = walks[1].known;
  assert.ok(known.includes(`${tid(71)}:0`), 'the ordinary parent is kept from the first walk');
  assert.ok(!known.includes(`${tid(70)}:0`), 'the bound parent is not: its standing on Ethereum can change');
});

test('a broadcast stops at the first explorer that takes it: a second copy would only be refused as known (an error in the page)', async () => {
  const posts = [];
  const { btc } = chainOf(['refuses.test', 'takes.test', 'third.test'], (u) => { posts.push(u.hostname); return u.hostname === 'refuses.test' ? json('bad-txns-inputs-missingorspent', 400) : json(tid(9)); });
  await btc.broadcast({ commitHex: null, revealHex: 'ab' });
  assert.deepEqual(posts, ['refuses.test', 'takes.test'], 'tried the next after a refusal, and none after the one that took it');
});

test('a status look at a transaction not out yet stops at two explorers that agree, and a lone 404 beside a failure is still not an answer', async () => {
  const { btc, seen } = chainOf(['a.test', 'b.test', 'c.test', 'd.test'], () => gone());
  assert.deepEqual(await btc.status(tid(5)), { confirmations: 0, height: 0 });
  assert.equal(seen.length, 2, 'two asked, not every explorer');
  const two = chainOf(['down.test', 'a.test', 'b.test'], (u) => (u.hostname === 'down.test' ? json('oops', 502) : gone()));
  assert.deepEqual(await two.btc.status(tid(6)), { confirmations: 0, height: 0 });
  assert.equal(two.seen.length, 3, 'after a failure every explorer is asked');
  const has = chainOf(['a.test', 'b.test', 'c.test'], (u) => (u.hostname === 'c.test' ? json({ confirmed: false }) : gone()));
  await has.btc.fetchTx(tid(7)).catch(() => {});
  assert.equal(has.seen.length, 3, 'a read of the transaction itself still asks every explorer (a note is never denied on two lagging ones)');
});

test('the next block\'s rate is read from the explorers\' target 1, apart from the rate a party sends at', async () => {
  const { btc } = chainOf(['a.test', 'b.test', 'c.test'], (u) => (u.pathname.endsWith('/fee-estimates') ? json({ 1: 9.2, 3: 2.1, 6: 1.5 }) : gone()), { feeTarget: '3' });
  assert.equal(await btc.feeRate(), 3, 'the party\'s own target (3 blocks), rounded up');
  assert.equal(await btc.nextFeeRate(), 10, 'the next block (target 1), rounded up');
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} reader checks passed`);
process.exit(process.exitCode || 0);
