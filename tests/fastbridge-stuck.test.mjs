// No swap is left stuck: the watchdog that reads a swap afresh when its step has not moved for longer than it takes (dapp/fastbridge-pair.js, the providers'
// dapp/fastbridge-watch.js), 'Check again', a reload that resumes every phase, the reads a lock is found by while the nodes' agreed head lags, and the way out
// every phase of both directions has when the other side, the relay or the nodes go away (the table in the report: a test per row, here or named there).
// Needs Node 22.
import assert from 'node:assert/strict';
import { makeWatchdog } from '../dapp/fastbridge-watch.js';
import { makeFastBridgeEvm } from '../dapp/fastbridge-evm.js';
import { WATCH } from '../dapp/fastbridge-pair.js';
import { secp, sha256, keccak_256, hmac } from '../dapp/vendor/tacit-deps.min.js';
import { fetched } from './lib/btc-sim.mjs';
import { pairWorld, UNITS } from './lib/pair-world.mjs';
import { memStore } from './lib/fastbridge-world.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// steps every `stepSecs`, a block every `blockSecs` (none while `w.noBlocks`); returns when `until()` holds
async function drive(w, pair, until, { stepSecs = 30, blockSecs = 600, max = 20000 } = {}) {
  let next = w.clock.now() + blockSecs;
  for (let i = 0; i < max; i++) {
    if (await until()) return;
    await w.providerFeed.refresh().catch(() => {}); await w.clientFeed.refresh().catch(() => {});
    if (w.up.lp) { await w.fwd.tick(); await w.rev.tick(); }
    await pair.pump(); w.evm.process();
    w.clock.advance(stepSecs);
    if (w.clock.now() >= next) { if (!w.noBlocks) w.btc.mine(1, { advance: false }); next += blockSecs; }
  }
  throw new Error('did not finish: ' + JSON.stringify((await pair.records()).map((r) => [r.dir, r.state, r.title])));
}
const revRec = async (w) => (await w.mems.get('swaps:lp1')?.list() || [])[0];
const fwdRec = async (w) => (await w.mems.get('fwd')?.list() || [])[0];
const recOf = async (pair, dir) => (await pair.records()).find((r) => r.dir === dir);

// A pool reader with the old bug: a lock it did not find is kept as not there until forget() (what the live swap of 11-25 met). `forgets` counts the forgets.
// `lagFirst`: the first look at a leaf misses it even when it is there (a head that lags behind the lock), and the miss is kept the same way.
function stickyMisses(ctx, { lagFirst = false } = {}) {
  const miss = new Set(), looked = new Set();
  const out = { forgets: 0 };
  out.ctx = {
    ...ctx,
    lockPosition: async (leaf) => {
      if (miss.has(leaf)) return null;
      const p = lagFirst && !looked.has(leaf) ? null : await ctx.lockPosition(leaf);
      looked.add(leaf);
      if (!p) miss.add(leaf);
      return p;
    },
    forget: () => { out.forgets++; miss.clear(); },
  };
  out.noForget = () => { const { forget, ...rest } = out.ctx; return rest; };
  return out;
}
// a relay that takes jobs and never sends them (gone), over a party's pool context; `types` only those types
const relayGone = (ctx, types = ['adaptorlock', 'adaptorclaim', 'adaptorrefund']) => ({ ...ctx, submit: async (type, op) => (types.includes(type) ? { jobId: `gone-${type}-${Math.random()}` } : ctx.submit(type, op)), jobStatus: async (id) => (String(id).startsWith('gone-') ? 'pending' : ctx.jobStatus(id)), claimStatus: async (id) => (String(id).startsWith('gone-') ? 'pending' : ctx.jobStatus(id)) });

// ── the watchdog ──

test('the watchdog: a step that has not moved past its time is read afresh once a minute, said after five minutes more, and a move starts the count again', async () => {
  let t = 0;
  const logs = [], alerts = [], kicks = [];
  let forgets = 0;
  const w = makeWatchdog({ now: () => t, budget: (r) => (r.phase === 'locking' ? 600 : null), keyOf: (r) => r.phase, forget: () => { forgets++; }, kick: async (r) => { kicks.push(r.id); }, log: (o) => logs.push(o), alert: (o) => alerts.push(o) });
  const rec = { id: 'a', phase: 'locking' };
  assert.equal(await w.look(rec), null);
  t = 600; assert.equal(await w.look(rec), null, 'within its time');
  t = 601; assert.ok(await w.look(rec)); assert.equal(kicks.length, 1); assert.equal(forgets, 1, 'past it: read afresh');
  t = 630; await w.look(rec); assert.equal(kicks.length, 1, 'not again within the minute');
  t = 662; await w.look(rec); assert.equal(kicks.length, 2, 'again a minute on');
  assert.equal(alerts.length, 0);
  t = 902; await w.look(rec); assert.equal(alerts.length, 1, 'said once it is five minutes past its time');
  t = 1000; await w.look(rec); assert.equal(alerts.length, 1, 'said once');
  t = 1001; assert.equal(await w.look({ id: 'a', phase: 'locked' }), null, 'a move starts the count again');
  assert.equal(await w.look({ id: 'b', phase: 'accepted' }), null);
  t = 99999; assert.equal(await w.look({ id: 'b', phase: 'accepted' }), null, 'a step with no time of its own (a block, a counterparty that may never come) is never stuck');
  const q = makeWatchdog({ now: () => t, budget: () => 10, keyOf: (r) => r.phase, alert: (o) => alerts.push(o), quiet: (r) => !r.lastError });
  await q.look({ id: 'c', phase: 'offered' }); t += 400; await q.look({ id: 'c', phase: 'offered' });
  assert.equal(alerts.length, 1, 'a quiet step (a claim that may rightly never come) is read afresh, not alerted on');
});

test('ETH for BTC: a page whose pool reader keeps a lock it did not find as missing is unstuck by the watchdog within its step\'s time, and the swap ends done', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const s = stickyMisses(w.uEvmCtx);
  const pair = w.makePair({ evm: s.ctx });
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  let lockedAt = null, landedAt = null;
  await drive(w, pair, async () => {
    const r = await revRec(w);
    if (landedAt == null && r && r.lock && (await w.evm.lockPosition(r.lock.lockLeaf))) landedAt = w.clock.now();
    if (lockedAt == null && r && ['locked', 'offered', 'taking', 'done'].includes(r.phase)) lockedAt = w.clock.now();
    return r && r.phase === 'done';
  });
  assert.ok(s.forgets >= 1, 'the watchdog let the reads go');
  assert.ok(lockedAt - landedAt <= WATCH.e2b.locking + 120, `the lock was seen ${lockedAt - landedAt} s after it landed: within the step's time and a minute`);
});

test('a page with no way to let its reads go says so after the step\'s time and five minutes, plainly, with what happens to the funds; Check again then ends it', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const s = stickyMisses(w.uEvmCtx);
  const ctx = s.noForget();
  const pair = w.makePair({ evm: ctx });
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await drive(w, pair, async () => { const r = await revRec(w); return r && r.phase === 'locking' && r.lock && !!(await w.evm.lockPosition(r.lock.lockLeaf)); });
  const at = w.clock.now();
  await drive(w, pair, async () => w.clock.now() - at > WATCH.e2b.locking + 330);
  const shown = await recOf(pair, 'e2b');
  assert.equal(shown.stuck, true);
  assert.match(shown.slow, /^Taking longer than usual\. Your funds are safe: if the provider has not claimed by the deadline, in about \d+ h( \d+ min)?, your ETH comes back to your private balance by itself\.$/);
  ctx.forget = s.ctx.forget;                                                  // (the page that can: Check again lets every read go and steps the swap now)
  const after = await pair.checkAgain(shown.id);
  assert.notEqual((await revRec(w)).phase, 'locking', 'Check again moved it on at once, no reload');
  assert.ok(!after.find((r) => r.id === shown.id).stuck);
  await drive(w, pair, async () => (await revRec(w)).phase === 'done');
});

test('BTC for ETH: a page whose pool reader keeps the provider\'s lock as missing is unstuck by the watchdog, and the swap ends done', async () => {
  const w = pairWorld();
  await w.ready();
  const s = stickyMisses(w.uEvmCtx, { lagFirst: true });
  const pair = w.makePair({ evm: s.ctx });
  w.lEvm.fund(7_120_000n, 'inv0');
  const q = await pair.quote({ dir: 'b2e', amount: 100_000n });
  w.lEvm.fund(q.get, 'exact');
  await pair.start(q);
  await drive(w, pair, async () => ['done', 'counter-took'].includes((await fwdRec(w))?.phase));
  assert.ok(s.forgets >= 1);
});

// ── reloads ──

test('a reload resumes every phase: ETH for BTC from the early record (lock built and proving), from the lock in the pool, and BTC for ETH from a lock still unconfirmed', async () => {
  for (const until of ['pre', 'locked', 'offered']) {
    const w = pairWorld();
    await w.ready();
    w.uEvm.fund(UNITS, 'inv0');
    const first = w.makePair();
    await first.start(await first.quote({ dir: 'e2b', amount: UNITS }));
    await drive(w, first, async () => { const r = await revRec(w); return !!r && (until === 'pre' ? !!r.pre : r.phase === until); });
    const again = w.makePair();                                              // the same stores: a new page
    await drive(w, again, async () => (await revRec(w)).phase === 'done');
  }
  const w = pairWorld();
  await w.ready();
  const first = w.makePair();
  w.lEvm.fund(7_120_000n, 'inv0');
  const q = await first.quote({ dir: 'b2e', amount: 100_000n });
  w.lEvm.fund(q.get, 'exact');
  await first.start(q);
  assert.equal((await fwdRec(w)).phase, 'broadcast', 'the lock is sent and waits for its block');
  const again = w.makePair();
  await drive(w, again, async () => ['done', 'counter-took'].includes((await fwdRec(w))?.phase));
});

test('ETH for BTC, the page closes after its lock lands and before the provider is told (live 11-25): a fresh page finds the swap from the key, tells the provider, and it ends done', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const first = w.makePair();
  await first.start(await first.quote({ dir: 'e2b', amount: UNITS }));
  await drive(w, first, async () => (await revRec(w))?.phase === 'locked');
  const sm = new Map(), mem = (k) => { if (!sm.has(k)) sm.set(k, memStore()); return sm.get(k); };
  const fresh = w.makePair({ stores: { fwd: mem('fwd'), index: mem('index'), swaps: (id) => mem('swaps:' + id), quotes: (id) => mem('quotes:' + id) } });
  assert.equal(await fresh.recover(), 1, 'found from the key');
  await drive(w, fresh, async () => (await mem('swaps:recovered').list())[0]?.phase === 'done');
  const r = (await mem('swaps:recovered').list())[0];
  assert.equal(r.toldBy, 'lp1', 'the provider was told of the lock by the page that found it');
  assert.ok(w.evm.submitted.some((j) => j.type === 'adaptorclaim'), 'and claimed');
});

// ── the lock read while the nodes' agreed head lags (the live swap of 11-25), 0, 1 and 2 blocks ──

test('a lock that lands while the agreed head lags 0, 1 or 2 blocks is found as soon as the head reaches it, with no other lock landing', async () => {
  for (const lag of [0, 1, 2]) {
    const LEAF = '0x' + 'de'.repeat(32);
    let latest = 100;
    const landed = 101, countAt = (b) => (b >= landed ? 393 : 392), rootAt = (b) => '0x' + (b >= landed ? '02' : '01').repeat(32);
    const tagOf = (t) => (t === 'latest' ? latest : parseInt(t, 16));
    const ux = {
      rpc: async (m, p) => { if (m === 'eth_getStorageAt' && p[1] === '0x54') return '0x' + countAt(tagOf(p[2])).toString(16); if (m === 'eth_getStorageAt' && p[1] === '0x55') return rootAt(tagOf(p[2])); throw new Error('not read: ' + m); },
      stealthLockPosition: async ({ lockLeaf, opts }) => (String(lockLeaf) === LEAF && (opts?.toBlock ?? latest) >= landed ? { lIndex: 392, lPath: [], lockSetRoot: rootAt(opts?.toBlock ?? latest) } : null),
    };
    const quorum = { head: async () => Math.max(0, latest - lag), agree: async (m, p, norm) => norm(await ux.rpc(m, p)) };
    const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(7), seed: new Uint8Array(32).fill(9), asset: '0x' + 'f0'.repeat(32), poolAddress: '0x' + '00'.repeat(20), quorum });
    assert.equal(await evm.lockPosition(LEAF), null, `lag ${lag}: before it lands`);
    let foundAt = null;
    for (latest = landed; latest <= landed + 4 && foundAt == null; latest++) if (await evm.lockPosition(LEAF)) foundAt = latest;
    assert.equal(foundAt, landed + lag, `lag ${lag}: found at the first block the agreed head reaches it`);
  }
});

test('forget(): a lock the pool reader missed is read again at once, though no other lock landed since', async () => {
  const LEAF = '0x' + 'ab'.repeat(32);
  let scanSees = false;
  const ux = { rpc: async (m, p) => { if (m === 'eth_getStorageAt') return '0x5'; throw new Error(m); }, stealthLockPosition: async () => (scanSees ? { lIndex: 4, lPath: [], lockSetRoot: '0x' } : null) };
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(7), seed: new Uint8Array(32).fill(9), asset: '0x' + 'f0'.repeat(32), poolAddress: '0x' + '00'.repeat(20) });
  assert.equal(await evm.lockPosition(LEAF), null);
  scanSees = true;                                                            // (a read that came back short: an event index behind, a node behind)
  assert.equal(await evm.lockPosition(LEAF), null, 'kept under the same count');
  evm.forget();
  assert.ok(await evm.lockPosition(LEAF), 'let go: read again');
});

// ── the way out of every phase when the other side, the relay or the nodes go away ──

test('ETH for BTC, the provider never sends its lock: the ask is given up after its wait, nothing of the user\'s locked', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  w.rBtc.broadcast = async () => { throw new Error('refused'); };
  const pair = w.makePair();
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await drive(w, pair, async () => (await recOf(pair, 'e2b'))?.state === 'stopped', { stepSecs: 120 });
  assert.equal(await revRec(w), undefined, 'no lock of the user\'s, and no record that could make one');
  assert.equal(w.evm.submitted.filter((j) => j.type === 'adaptorlock').length, 0);
});

test('ETH for BTC, the provider\'s lock never confirms: the early record waits for it and is given up after its wait, the lock built ahead let go, nothing sent', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const pair = w.makePair();
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await w.rev.tick(); await pair.pump();
  const lockTxid = (await w.stores.rv.swaps.list())[0].lock.txid;
  w.btc.holdBack = (id) => id === lockTxid || [...w.btc.txs.values()].some((e) => e.height == null && e.esplora.vin.some((i) => i.txid === lockTxid));
  await drive(w, pair, async () => ['aborted'].includes((await revRec(w))?.phase), { stepSecs: 600 });
  const r = await revRec(w);
  assert.match(r.why, /did not reach its confirmations/);
  assert.equal(r.pre, null, 'the lock built ahead was let go (its note given back)');
  assert.equal(w.evm.submitted.filter((j) => j.type === 'adaptorlock').length, 0, 'nothing was locked');
});

test('ETH for BTC, the relay takes the lock and never sends it: past the deadline the swap stops by itself, nothing of the user\'s spent', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const pair = w.makePair({ evm: relayGone(w.uEvmCtx) });
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await drive(w, pair, async () => ['aborted', 'refunded'].includes((await revRec(w))?.phase), { stepSecs: 300 });
  const r = await revRec(w);
  assert.equal(r.phase, 'aborted');
  assert.match(r.why, /never reached the pool/);
  assert.equal(await w.evm.lockPosition(r.lock.lockLeaf), null, 'the lock never landed: the note is the user\'s');
});

test('ETH for BTC, the provider claims and goes away: the user takes the BTC on Bitcoin alone', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const pair = w.makePair();
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await drive(w, pair, async () => ['taking', 'done'].includes((await revRec(w))?.phase));
  w.up.lp = false;
  await drive(w, pair, async () => (await revRec(w)).phase === 'done');
});

test('BTC for ETH, the provider takes the lock\'s quote and goes away before locking ETH: the BTC comes back on its timelock, on Bitcoin alone', async () => {
  const w = pairWorld();
  await w.ready();
  const pair = w.makePair();
  w.lEvm.fund(7_120_000n, 'inv0');
  const q = await pair.quote({ dir: 'b2e', amount: 100_000n });
  w.lEvm.fund(q.get, 'exact');
  await pair.start(q);
  w.up.lp = false;
  await drive(w, pair, async () => ['refunded', 'counter-took', 'done'].includes((await fwdRec(w))?.phase), { stepSecs: 300 });
  assert.equal((await fwdRec(w)).phase, 'refunded');
});

test('BTC for ETH, the relay never sends the user\'s claim: past the pool deadline the BTC comes back on its timelock; the provider takes its ETH back', async () => {
  const w = pairWorld();
  await w.ready();
  const pair = w.makePair({ evm: relayGone(w.uEvmCtx, ['adaptorclaim']) });
  w.lEvm.fund(7_120_000n, 'inv0');
  const q = await pair.quote({ dir: 'b2e', amount: 100_000n });
  w.lEvm.fund(q.get, 'exact');
  await pair.start(q);
  await drive(w, pair, async () => ['refunded', 'counter-took', 'done'].includes((await fwdRec(w))?.phase) && ['refunded', 'done'].includes((await w.stores.lp.list())[0]?.phase), { stepSecs: 300 });
  assert.equal((await fwdRec(w)).phase, 'refunded', 'the user\'s BTC is back');
  assert.equal((await w.stores.lp.list())[0].phase, 'refunded', 'and the provider\'s ETH');
});

test('ETH for BTC, the user never locks ETH: the provider takes its BTC back on the timelock', async () => {
  const w = pairWorld();
  await w.ready();
  w.uEvm.fund(UNITS, 'inv0');
  const pair = w.makePair({ evm: relayGone(w.uEvmCtx) });             // the user's lock never lands
  await pair.start(await pair.quote({ dir: 'e2b', amount: UNITS }));
  await drive(w, pair, async () => ['refunded', 'counter-took'].includes((await w.stores.rv.swaps.list())[0]?.phase), { stepSecs: 300 });
  assert.equal((await w.stores.rv.swaps.list())[0].phase, 'refunded');
});

let passed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} stuck-swap checks passed`);
process.exit(process.exitCode || 0);
