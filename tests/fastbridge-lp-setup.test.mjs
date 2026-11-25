// The one-command provider setup (fastbridge-lp/lib/setup.mjs): the key and its file mode, the config, the sums, the watch for deposits against a
// mocked chain, the shield that is stopped and run again (including a settle that reverts or races the relay's), and the self-test's reports.
//   node tests/fastbridge-lp-setup.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as S from '../fastbridge-lp/lib/setup.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tmp = () => mkdtempSync(join(tmpdir(), 'lp-setup-'));
const base = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.btc-eth.example.json', import.meta.url), 'utf8'));
const rate = { num: 31n, den: 1n };                          // 31 pool units per sat (about 31 ETH to the Bitcoin)
const mode = (p) => (statSync(p).mode & 0o777);

test('the key is made once, mode 600, and read back as it was on every later run', () => {
  const d = tmp(), a = S.ensureKey({ dataDir: join(d, 'x'), env: {} });
  assert.ok(a.created && /^[0-9a-f]{64}$/.test(a.keyHex)); assert.equal(mode(a.path), 0o600);
  const b = S.ensureKey({ dataDir: join(d, 'x'), env: {} });
  assert.equal(b.created, false); assert.equal(b.keyHex, a.keyHex);
  rmSync(d, { recursive: true });
});

test('a key file with loose mode is tightened; one that is not a key is never overwritten', () => {
  const d = tmp(), a = S.ensureKey({ dataDir: d, env: {} });
  chmodSync(a.path, 0o644);
  const b = S.ensureKey({ dataDir: d, env: {} }); assert.ok(b.tightened); assert.equal(mode(a.path), 0o600);
  writeFileSync(a.path, 'not a key\n');
  assert.throws(() => S.ensureKey({ dataDir: d, env: {} }), /not a key/);
  assert.equal(readFileSync(a.path, 'utf8'), 'not a key\n', 'left as it was');
});

test('FB_LP_KEY wins, writes nothing, and a bad one is refused', () => {
  const d = tmp(), k = 'ab'.repeat(32);
  const r = S.ensureKey({ dataDir: d, env: { FB_LP_KEY: '0x' + k } });
  assert.deepEqual([r.keyHex, r.source, r.created], [k, 'env', false]); assert.equal(existsSync(join(d, 'provider.key')), false);
  assert.throws(() => S.ensureKey({ dataDir: d, env: { FB_LP_KEY: 'zz' } }), /64 hex/);
});

test('the backup notice shows the key; nothing else in setup\'s texts contains it', () => {
  const k = 'cd'.repeat(32);
  assert.match(S.backupNotice(k, '/data/provider.key'), new RegExp(k));
  for (const t of [S.explainFee(S.DEFAULT_TERMS), S.earnRiskText(), S.statusHelp({ port: 8788 })]) assert.ok(!t.includes(k));
});

test('terms: validated in words, and the fee explained with a sum', () => {
  assert.throws(() => S.validateTerms({ feeBps: 900, flatFee: '1' }), /0 to 500/);
  assert.throws(() => S.validateTerms({ feeBps: 30, flatFee: '1.5' }), /whole number of sats/);
  const t = S.explainFee({ feeBps: 30, flatFee: '1000' }, 500000n);
  assert.match(t, /0\.30% of the amount, plus a flat 1,000 sats/); assert.match(t, /2,500 sats \(0\.50%\)/); assert.match(t, /lowest fees first/);
});

test('amounts for each size: ETH for two swaps at the most plus gas, from the price', () => {
  const small = S.planAmounts('small', rate), large = S.planAmounts('large', rate);
  assert.equal(small.shieldWei, 100000n * 2n * 31n * 10n ** 10n); assert.equal(small.ethWei, small.shieldWei + S.GAS_RESERVE_WEI);
  assert.ok(large.ethWei > small.ethWei && large.maxSats === 2500000n);
  assert.throws(() => S.planAmounts('huge', rate), /small, medium or large/);
});

test('limits follow what is funded: half the private ETH, capped; the reverse side only with confirmed coins', () => {
  const funded = S.planAmounts('small', rate).shieldWei / 10n ** 10n;
  const a = S.deriveLimits({ privUnits: funded, btcSats: 0n, rate, cap: 100000n });
  assert.equal(a.maxSats, 100000n); assert.equal(a.forward, true); assert.equal(a.reverse, null);
  const b = S.deriveLimits({ privUnits: funded * 100n, btcSats: 0n, rate, cap: 100000n }); assert.equal(b.maxSats, 100000n, 'never above the size chosen');
  const c = S.deriveLimits({ privUnits: funded / 4n, btcSats: 0n, rate, cap: 100000n }); assert.equal(c.maxSats, 25000n); assert.equal(c.forward, false, 'under the minimum swap');
  const d = S.deriveLimits({ privUnits: funded, btcSats: 140000n, rate, cap: 100000n });
  assert.ok(d.reverse && d.reverse.maxSats === 100000n); assert.equal(S.deriveLimits({ privUnits: funded, btcSats: 50000n, rate, cap: 100000n }).reverse, null, 'coins under a swap and its fees do not turn it on');
});

test('config: the terms and limits in, checked by the daemon\'s own validator, marked as setup\'s; a hand-made config is left alone', () => {
  const limits = S.deriveLimits({ privUnits: 3100000n * 2n, btcSats: 200000n, rate, cap: 100000n });
  const C = S.buildConfig({ base, name: 'Mine', terms: { feeBps: 25, flatFee: '900' }, limits, dataDir: '/d', port: 9000 });
  assert.deepEqual([C.name, C.port, C.dataDir, C.managedBy], ['Mine', 9000, '/d', 'fastbridge-lp/setup.mjs']);
  assert.deepEqual([C.quote.feeBps, C.quote.flatFee, C.quote.minAmount, C.quote.maxAmount], [25, '900', '50000', '100000']);
  assert.equal(C.reverse.enabled, true); assert.equal(C.reverse.flatFee, String(900n * 31n));
  const off = S.buildConfig({ base, name: 'x', terms: S.DEFAULT_TERMS, limits: S.deriveLimits({ privUnits: 3100000n * 2n, btcSats: 0n, rate, cap: 100000n }), dataDir: '/d' });
  assert.equal(off.reverse.enabled, false);
  assert.throws(() => S.buildConfig({ base, name: 'x', terms: S.DEFAULT_TERMS, limits: { ...limits, minSats: 100n }, dataDir: '/d' }), /at least/);
  const d = tmp(), p = join(d, 'config.json');
  assert.ok(S.writeConfigIfOwned(p, C).written && mode(p) === 0o600);
  assert.ok(S.writeConfigIfOwned(p, { ...C, name: 'Again' }).written, 'its own config is rewritten');
  writeFileSync(p, JSON.stringify({ name: 'by hand' }));
  assert.equal(S.writeConfigIfOwned(p, C).written, false); assert.equal(JSON.parse(readFileSync(p, 'utf8')).name, 'by hand');
});

// ---- a mocked chain for the shield and the watch ----
function chain({ eth = 0n, settleFails = 0, racedByRelay = false, receiptOk = true, noReceipt = false } = {}) {
  const c = { eth, priv: 0n, deposits: new Map(), sent: 0, settles: 0, said: [], nextIdx: 0, settleFails, now: 0, btc: 0n };
  c.io = {
    say: (t) => c.said.push(t), sleep: async (ms) => { c.now += ms; }, now: () => c.now,
    publicEth: async () => c.eth, privateUnits: async () => c.priv, nextIndex: async () => c.nextIdx++,
    deposit: async ({ index, amountWei }) => { c.sent++; c.eth -= amountWei; const h = '0x' + String(index).padStart(64, 'a'); c.deposits.set(h, { index: String(index), amountWei, settled: false }); c.last = h; return { txHash: h }; },
    depositRegistered: async (p) => [...c.deposits.values()].some((d) => d.index === String(p.index)),
    receipt: async (h) => (noReceipt ? null : c.deposits.has(h) ? { ok: receiptOk } : null),
    settle: async (p) => {
      c.settles++;
      if (racedByRelay) { c.priv += BigInt(p.amountWei) / 10n ** 10n; c.deposits.get(p.depositTx).settled = true; throw new Error('execution reverted: already settled'); }   // the relay's settle won
      if (c.settleFails > 0) { c.settleFails--; throw new Error('execution reverted'); }
      c.priv += BigInt(p.amountWei) / 10n ** 10n; c.deposits.get(p.depositTx).settled = true;
    },
    notesLanded: async (p) => c.priv >= BigInt(p.privBefore) + BigInt(p.amountWei) / 10n ** 10n,
    btcConfirmed: async () => c.btc,
  };
  return c;
}
const memState = () => { const s = { v: {} , saves: 0 }; s.save = (x) => { s.v = JSON.parse(JSON.stringify(x)); s.saves++; }; return s; };
const ETH_01 = 10n ** 17n;

test('the watch waits for ETH, shields it once it has held steady, and leaves the gas reserve', async () => {
  const c = chain({ eth: 0n }), st = memState(), state = {};
  let polls = 0; const sleep0 = c.io.sleep; c.io.sleep = async (ms) => { await sleep0(ms); if (++polls === 2) c.eth = ETH_01; };
  const r = await S.watchDeposits({ io: c.io, state, save: st.save, rate, minPrivUnits: 3100000n, minDepositWei: 10n ** 16n, pollMs: 15000 });
  assert.equal(r.eth, 'shielded'); assert.equal(c.sent, 1);
  assert.equal(c.eth, S.GAS_RESERVE_WEI, 'the reserve stays for gas'); assert.equal(c.priv, (ETH_01 - S.GAS_RESERVE_WEI) / 10n ** 10n);
  assert.equal(state.shields.length, 1); assert.equal(state.pending, undefined);
  assert.ok(c.said.some((t) => /waiting for ETH/.test(t)));
});

test('the watch times out plainly when nothing comes, and reads the Bitcoin side when it is done', async () => {
  const c = chain({ eth: 0n }), st = memState();
  const r = await S.watchDeposits({ io: c.io, state: {}, save: st.save, rate, minPrivUnits: 1n, minDepositWei: 10n ** 16n, timeoutMs: 60000, pollMs: 15000 });
  assert.equal(r.eth, 'timeout'); assert.equal(c.sent, 0);
  const c2 = chain({ eth: ETH_01 }); c2.btc = 123456n;
  const r2 = await S.watchDeposits({ io: c2.io, state: {}, save: st.save, rate, minPrivUnits: 1000n, minDepositWei: 10n ** 16n, pollMs: 1000 });
  assert.equal(r2.btcConfirmed, 123456n);
});

test('already shielded: a second run sends nothing', async () => {
  const c = chain({ eth: 10n ** 15n }); c.priv = 9999999n;
  const r = await S.watchDeposits({ io: c.io, state: {}, save: () => {}, rate, minPrivUnits: 1000n, minDepositWei: 10n ** 16n });
  assert.equal(r.eth, 'shielded'); assert.equal(c.sent, 0);
});

test('a settle that reverts is tried again and the notes arrive; the deposit is sent once', async () => {
  const c = chain({ eth: ETH_01, settleFails: 2 }), st = memState(), state = {};
  const r = await S.watchDeposits({ io: c.io, state, save: st.save, rate, minPrivUnits: 3100000n, minDepositWei: 10n ** 16n, pollMs: 1 });
  assert.equal(r.eth, 'shielded'); assert.equal(c.sent, 1); assert.equal(c.settles, 3);
  assert.ok(c.said.some((t) => /did not go through/.test(t)));
});

test('the race: the relay settles first and ours reverts; the notes are found and it counts as done', async () => {
  const c = chain({ eth: ETH_01, racedByRelay: true }), state = {};
  const r = await S.watchDeposits({ io: c.io, state, save: () => {}, rate, minPrivUnits: 3100000n, minDepositWei: 10n ** 16n, pollMs: 1 });
  assert.equal(r.eth, 'shielded'); assert.equal(c.sent, 1); assert.equal(c.settles, 1, 'no second try once the notes are there');
  assert.ok(c.said.some((t) => /relay settled it first/.test(t)));
});

test('a settle that never goes through says the deposit is safe and leaves it pending; the next run finishes it without a second deposit', async () => {
  const c = chain({ eth: ETH_01, settleFails: 99 }), st = memState(), state = {};
  const r = await S.watchDeposits({ io: c.io, state, save: st.save, rate, minPrivUnits: 3100000n, minDepositWei: 10n ** 16n, pollMs: 1 });
  assert.equal(r.eth, 'settle-open'); assert.ok(state.pending && state.pending.depositTx);
  assert.ok(c.said.some((t) => /Nothing is lost: run setup again/.test(t)));
  c.settleFails = 0;                                            // a later run, from the saved state, with the relay well again
  const again = await S.watchDeposits({ io: c.io, state: st.v, save: st.save, rate, minPrivUnits: 3100000n, minDepositWei: 10n ** 16n, pollMs: 1 });
  assert.equal(again.eth, 'shielded'); assert.equal(c.sent, 1, 'the deposit was not made twice'); assert.equal(st.v.pending, undefined);
});

test('stopped between writing the intent and sending: a run finds nothing registered and starts it again; one that was sent is settled, not re-sent', async () => {
  const c = chain({ eth: ETH_01 }), st = memState();
  const state = { pending: { index: '0', amountWei: String(ETH_01 - S.GAS_RESERVE_WEI), privBefore: '0', depositTx: null } };
  let r = await S.shieldStep({ io: c.io, state, save: st.save });
  assert.equal(r.status, 'idle'); assert.equal(state.pending, undefined, 'nothing was sent, so the intent is dropped');
  const c2 = chain({ eth: ETH_01 }); c2.deposits.set('0xh', { index: '0' });          // it was sent, the hash was lost
  const state2 = { pending: { index: '0', amountWei: String(ETH_01 - S.GAS_RESERVE_WEI), privBefore: '0', depositTx: null } };
  c2.io.settle = async (p) => { c2.priv += BigInt(p.amountWei) / 10n ** 10n; };
  r = await S.shieldStep({ io: c2.io, state: state2, save: st.save });
  assert.equal(r.status, 'shielded'); assert.equal(c2.sent, 0);
});

test('a deposit that reverted or has no receipt is reported, not retried blindly', async () => {
  const c = chain({ eth: ETH_01, receiptOk: false }), st = memState();
  const p = await S.startDeposit({ io: c.io, state: {}, save: st.save, amountWei: ETH_01 - S.GAS_RESERVE_WEI });
  const state = { pending: p };
  let r = await S.shieldStep({ io: c.io, state, save: st.save, waitMinedMs: 0 });
  assert.equal(r.status, 'idle'); assert.equal(state.pending, undefined); assert.ok(c.said.some((t) => /reverted: nothing was moved/.test(t)));
  const c2 = chain({ eth: ETH_01, noReceipt: true });
  const p2 = await S.startDeposit({ io: c2.io, state: {}, save: st.save, amountWei: 10n ** 16n });
  r = await S.shieldStep({ io: c2.io, state: { pending: p2 }, save: st.save, waitMinedMs: 0 });
  assert.equal(r.status, 'waiting'); assert.ok(c2.said.some((t) => /no receipt yet/.test(t)));
});

test('the self-test says each failure plainly with what to do; only required ones stop the start', async () => {
  const out = [];
  const checks = [
    { name: 'a', run: async () => ({ ok: true, detail: 'fine' }) },
    { name: 'b', required: false, fix: 'do b', run: async () => ({ ok: false, detail: 'meh' }) },
    { name: 'c', fix: 'do c', run: async () => { throw new Error('boom'); } },
  ];
  const r = await S.runChecks(checks, (t) => out.push(t));
  assert.equal(r.ok, false); assert.deepEqual(r.results.map((x) => x.ok), [true, false, false]);
  assert.ok(/FAIL  c: boom\n\s+-> do c/.test(out.join('\n'))); assert.ok(/warn  b: meh/.test(out[1]));
  assert.equal((await S.runChecks(checks.slice(0, 2), () => {})).ok, true, 'a failed optional check does not stop it');
});

test('checks: nodes that agree, explorers, CORS and quote read off mocked answers', async () => {
  const rpc = (heads) => async (u) => ({ json: async () => (heads[u] == null ? Promise.reject(new Error('down')) : { result: '0x' + heads[u].toString(16) }) });
  const nodes = ['a', 'b', 'c'];
  assert.equal((await S.rpcQuorumCheck({ nodes, fetchImpl: rpc({ a: 100, b: 101, c: 100 }) }).run()).ok, true);
  assert.equal((await S.rpcQuorumCheck({ nodes, fetchImpl: rpc({ a: 100 }) }).run()).ok, false, 'one node is not a quorum');
  assert.equal((await S.rpcQuorumCheck({ nodes, fetchImpl: rpc({ a: 100, b: 500, c: 900 }) }).run()).ok, false, 'nodes far apart do not agree');
  const ex = (ok) => async () => ({ ok, text: async () => '900000' });
  assert.equal((await S.explorerCheck({ bases: ['x'], fetchImpl: ex(true) }).run()).ok, true); assert.equal((await S.explorerCheck({ bases: ['x'], fetchImpl: ex(false) }).run()).ok, false);
  const http = (cors, status = 200) => async () => ({ ok: status === 200, status, headers: { get: () => cors }, json: async () => ({ id: 'q1' }) });
  assert.equal((await S.corsCheck({ base: 'b', origin: 'https://tacit.finance', fetchImpl: http('https://tacit.finance') }).run()).ok, true);
  const bad = await S.corsCheck({ base: 'b', origin: 'https://tacit.finance', fetchImpl: http(null) }).run();
  assert.equal(bad.ok, false); assert.match(bad.detail, /allows "nothing"/);
  assert.equal((await S.quoteCheck({ base: 'b', minSats: 1, fetchImpl: http('x') }).run()).ok, true); assert.equal((await S.quoteCheck({ base: 'b', minSats: 1, fetchImpl: http('x', 500) }).run()).ok, false);
});

test('the status text says where to look and what the numbers mean', () => {
  const t = S.statusHelp({ port: 8788 });
  for (const w of ['/health', '/info', 'available', 'full right now', 'stats', 'Providers online', 'status']) assert.ok(t.includes(w), w);
  assert.match(S.earnRiskText(), /Tacit never holds your funds/); assert.match(S.earnRiskText(), /16 hours/);
});

test('a probe that times out is retried once and then warns (not FAIL, not stopping); a real error still fails', async () => {
  let calls = 0;
  const slow = async () => { calls++; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  const out = [];
  const r = await S.runChecks([S.corsCheck({ base: 'b', origin: 'https://tacit.finance', fetchImpl: slow }), S.quoteCheck({ base: 'b', minSats: 1, fetchImpl: slow })], (t) => out.push(t));
  assert.equal(calls, 4, 'each probe tried twice'); assert.equal(r.ok, true, 'a timeout does not stop the start');
  assert.ok(out.every((l) => /warn/.test(l.split('\n')[0])) && /run setup again/.test(out.join('')), out.join('\n'));
  const http = async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: 'no price' }) });
  const bad = await S.runChecks([S.quoteCheck({ base: 'b', minSats: 1, fetchImpl: http })], () => {});
  assert.equal(bad.ok, false); assert.match(bad.results[0].detail, /500: no price/);
  const refused = await S.runChecks([S.corsCheck({ base: 'b', origin: 'o', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })], () => {});
  assert.equal(refused.ok, false, 'a refused connection is a real failure');
});

test('the explorer check names each explorer it tried', async () => {
  const f = async (u) => (u.startsWith('https://a') ? { ok: true, text: async () => '1' } : Promise.reject(new Error('x')));
  const r = await S.explorerCheck({ bases: ['https://a.example/api', 'https://b.example/api'], fetchImpl: f }).run();
  assert.equal(r.ok, true); assert.match(r.detail, /1 of 2 answer/); assert.match(r.detail, /a\.example\/api answered/); assert.match(r.detail, /b\.example\/api did not/);
});

test('--help and -h print the usage and touch nothing', async () => {
  const { spawnSync } = await import('node:child_process');
  const d = tmp(), script = new URL('../fastbridge-lp/setup.mjs', import.meta.url).pathname;
  for (const a of ['--help', '-h']) {
    const r = spawnSync(process.execPath, [script, a, '--data', join(d, 'made')], { cwd: d, encoding: 'utf8' });
    assert.equal(r.status, 0); assert.match(r.stdout, /node fastbridge-lp\/setup\.mjs +set up/); assert.match(r.stdout, /--no-start/);
    assert.equal(existsSync(join(d, 'made')), false, 'no directory or key was made');
  }
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} provider setup checks passed`);
process.exit(process.exitCode || 0);
