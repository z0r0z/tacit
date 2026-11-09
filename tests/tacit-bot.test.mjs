// The chain bot's decisions with no network: settings, the wait, keys, the day's budget, the health guard, which action comes next, and
// the failure count that stops it.   node tests/tacit-bot.test.mjs
import assert from 'node:assert';
import { settings, nextWait, randomUnits, identities, identityKey, exitAccount, idName, ethAddress, makeBudget, health, decide, pickPair, pickSource, watchOwed, makeFailures, tac, fmt, T, UNIT } from '../tacit-bot/lib.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBot } from '../tacit-bot/bot.mjs';
import { signPermit } from '../tacit-bot/bot.mjs';
import { secp, keccak_256 } from '../dapp/vendor/tacit-deps.min.js';

const s = settings({});
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

// amounts
assert.equal(tac('1.5'), 150_000_000n); assert.equal(fmt(150_000_000n), '1.5'); assert.equal(fmt(tac('0.00000001')), '0.00000001');
assert.throws(() => tac('1e3'));
// the wait: within the bounds, both ends reachable
assert.equal(nextWait(s, () => 0), 20 * 60e3); assert.equal(nextWait(s, () => 1), 40 * 60e3);
for (let i = 0; i < 200; i++) { const w = nextWait(s); assert.ok(w >= 20 * 60e3 && w <= 40 * 60e3); }
assert.throws(() => settings({ BOT_MIN_WAIT_MIN: '30', BOT_MAX_WAIT_MIN: '10' }));
for (let i = 0; i < 200; i++) { const u = randomUnits(tac('0.5'), tac('15')); assert.ok(u >= tac('0.5') && u <= tac('15') && u % (T / 100n) === 0n); }

// keys: deterministic, distinct, the account A's own
const seed = 'ab'.repeat(32), ids = identities(seed);
assert.deepEqual(identities(seed).a, ids.a);
assert.notDeepEqual(ids.a, ids.b);
assert.equal(ids.eoa.address, ethAddress(ids.a));
assert.equal(ethAddress(Buffer.from('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', 'hex')), '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'anvil account 0');
assert.throws(() => identities('ab'));
// backward compatible: A, B and account 0 are the keys the deployed bot had (fixed test seed, public addresses pinned)
assert.equal(ethAddress(ids.a), '0xa479295d09ae2bfb0d588c937f56b1d577c65540');
assert.equal(ethAddress(ids.b), '0x759c067730b2704e7c6e67e80139b5b59360e0f1');
assert.equal(ids.eoa.address, '0xa479295d09ae2bfb0d588c937f56b1d577c65540');
{
  const many = identities(seed, 12);
  assert.equal(many.keys.length, 12);
  assert.deepEqual(many.keys[0], ids.a); assert.deepEqual(many.keys[1], ids.b); assert.equal(many.eoa.address, ids.eoa.address);
  assert.deepEqual(identityKey(seed, 5), many.keys[5]);
  const hexes = new Set(many.keys.map((k) => Buffer.from(k).toString('hex')));
  // exit accounts: 0 is A's, the rest a path of their own, none an identity key
  assert.equal(exitAccount(seed, 0).address, ids.eoa.address);
  const ex = [1, 2, 3, 50].map((i) => exitAccount(seed, i));
  for (const e of ex) assert.ok(!hexes.has(Buffer.from(e.priv).toString('hex')));
  assert.equal(new Set(ex.map((e) => e.address)).size, 4);
  assert.equal(exitAccount(seed, 2).address, many.exit(2).address);
  assert.equal(idName(0), 'a'); assert.equal(idName(1), 'b'); assert.equal(idName(7), 'i7');
}
assert.equal(settings({}).identities, 12);
assert.throws(() => settings({ BOT_IDENTITIES: '1' }));

// a permit recovers to its signer
{
  const priv = ids.eoa.priv, dom = '11'.repeat(32), sig = await signPermit({ priv, domainSeparator: dom, owner: ids.eoa.address, spender: '0x' + '22'.repeat(20), value: 5n, nonce: 0n, deadline: 9n });
  assert.ok(sig.v === 27 || sig.v === 28);
  assert.ok(/^0x[0-9a-f]{64}$/.test(sig.r) && /^0x[0-9a-f]{64}$/.test(sig.s));
}

// the budget: per UTC day
{
  let t = Date.parse('2026-11-09T23:00:00Z');
  const b = makeBudget(tac('1'), () => t);
  assert.ok(b.fits(tac('1'))); b.add(tac('0.8')); assert.ok(!b.fits(tac('0.3'))); assert.equal(b.left(), tac('0.2'));
  const j = JSON.parse(JSON.stringify(b)); const b2 = makeBudget(tac('1'), () => t); b2.restore(j); assert.equal(b2.spent(), tac('0.8'), 'kept across a restart');
  t += 2 * 3600e3; assert.ok(b.fits(tac('1')), 'a new day'); assert.equal(b.spent(), 0n);
}

// health
{
  const now = 1_800_000_000_000, st = { height: 10, lastLanded: now / 1000 - 60, leader: { fee: tac('0.25') } };
  assert.ok(health(s, { status: st, leaderState: { height: 10 }, now }).ok);
  assert.ok(!health(s, { status: null, leaderState: { height: 10 }, now }).ok);
  assert.ok(!health(s, { status: { ...st, leader: null }, leaderState: null, now }).ok);
  assert.match(health(s, { status: st, leaderState: { height: 9 }, now }).why, /behind/);
  assert.match(health(s, { status: { ...st, lastLanded: now / 1000 - 3 * 3600 }, leaderState: { height: 10 }, mempool: 2, now }).why, /no block landed/);
  assert.ok(health(s, { status: { ...st, lastLanded: now / 1000 - 3 * 3600 }, leaderState: { height: 10 }, mempool: 0, now }).ok, 'a quiet chain with nothing waiting is fine');
  assert.match(health(s, { status: { ...st, leader: { fee: tac('2') } }, leaderState: { height: 10 }, now }).why, /fee/);
}

// decide
const side = (worth, o = {}) => ({ worth: tac(worth), most: tac(o.most ?? worth), outMost: tac(o.out ?? o.most ?? worth), settling: !!o.settling, holders: 200_000n });
const view = (sides, eoas, o = {}) => ({ ids: sides, eoas: (Array.isArray(eoas) ? eoas : [eoas]).map((u, i) => ({ index: i, units: tac(u) })), fee: tac('0.25'), shieldCap: o.cap === undefined ? tac('1000') : o.cap, sweepFee: o.sweep ?? 454_358_580_000_000_000n });
const zeros = (n) => Array.from({ length: n }, () => side('0'));
{
  // empty chain, funded account: a shield of the set size, from account 0, into one of the identities
  let d = decide(s, view(zeros(12), '500'), () => 0.9);
  assert.equal(d.kind, 'shield'); assert.equal(d.units, tac('150')); assert.equal(d.eoa, 0); assert.ok(d.to >= 0 && d.to < 12);
  // never over the leader's cap, the in-play cap, nor what the account holds less the sweep fee
  assert.equal(decide({ ...s, shieldSize: tac('5000'), maxInPlay: tac('9000') }, view(zeros(4), '6000'), () => 0.9).units, tac('1000'));
  assert.equal(decide({ ...s, shieldSize: tac('5000') }, view([side('10'), side('10')], '6000'), () => 0.9).units, tac('280'));
  assert.equal(decide(s, view(zeros(3), '50'), () => 0.9).units, tac('49.54'));
  // low on the chain: the richest account, one permit, never summed across accounts
  d = decide(s, view(zeros(3), ['0', '30', '80']), () => 0.9);
  assert.equal(d.eoa, 2); assert.equal(d.units, tac('79.54'));
  // the sweep fee over its limit: no shield
  assert.equal(decide(s, view(zeros(2), '500', { sweep: tac('3') * UNIT }), () => 0.9).kind, 'idle');
  // nothing anywhere
  assert.equal(decide(s, view(zeros(12), '0'), () => 0.9).kind, 'idle');
  // a shield leans to the poorer identity
  const into = new Map();
  for (let i = 0; i < 400; i++) { const x = decide(s, view([side('30'), side('0'), side('5')], '500')); into.set(x.to, (into.get(x.to) || 0) + 1); }
  assert.ok((into.get(1) || 0) > (into.get(0) || 0), JSON.stringify([...into]));
  // payments: sender able to pay, receiver another identity, amounts within bounds; every identity gets a turn on both ends
  const sides = [side('100', { most: '8' }), side('20'), side('3'), side('0'), side('40', { settling: true }), side('60')];
  const sent = new Set(), got = new Set();
  for (let i = 0; i < 600; i++) {
    const x = decide({ ...s, withdrawProb: 0, reshieldProb: 0 }, view(sides, '0'));
    assert.ok(x.kind === 'pay' || x.kind === 'merge', x.kind);
    if (x.kind !== 'pay') continue;
    assert.notEqual(x.from, x.to); assert.notEqual(x.from, 4, 'a settling wallet never pays'); assert.notEqual(x.from, 3, 'an empty wallet never pays');
    assert.ok(x.units >= s.payMin && x.units <= (sides[x.from].most < s.payMax ? sides[x.from].most : s.payMax));
    sent.add(x.from); got.add(x.to);
  }
  assert.deepEqual([...sent].sort(), [0, 1, 2, 5]); assert.equal(got.size, 6);
  // pickPair: the sender leans richer, the receiver poorer
  { const c = [0, 0, 0]; for (let i = 0; i < 600; i++) c[pickPair([side('90'), side('10'), side('1')], s.payMin).from]++; assert.ok(c[0] > c[1] && c[1] > c[2], String(c)); }
  { const c = [0, 0, 0]; for (let i = 0; i < 600; i++) { const p = pickPair([side('90'), side('10', { settling: true }), side('1', { settling: true })], s.payMin); assert.equal(p.from, 0); c[p.to]++; } assert.ok(c[2] > c[1], String(c)); }
  assert.equal(pickPair([side('0'), side('0')], s.payMin), null);
  assert.deepEqual(pickPair([side('5'), side('5', { settling: true })], s.payMin, () => 0.9), { from: 0, to: 1 }, 'a settling wallet may still receive');
  // a settling payer waits; a wallet that cannot pay but holds enough merges (pays itself)
  assert.equal(decide({ ...s, withdrawProb: 0 }, view([side('100', { settling: true }), side('20', { settling: true })], '0'), () => 0.1).kind, 'idle');
  assert.deepEqual(decide({ ...s, withdrawProb: 0 }, view([side('100', { most: '0.1' }), side('20', { settling: true })], '0'), () => 0.1), { kind: 'merge', from: 0 });
  assert.deepEqual(decide({ ...s, withdrawProb: 0 }, view([side('0'), side('0'), side('100', { most: '0.1' })], '0'), () => 0.1), { kind: 'merge', from: 2 });
  // a withdrawal now and then, from the richest, within its bounds
  d = decide(s, view([side('20'), side('100'), side('30')], '0'), () => 0.01);
  assert.equal(d.kind, 'withdraw'); assert.equal(d.from, 1); assert.ok(d.units >= s.withdrawMin && d.units <= s.withdrawMax);
  // TAC back in an exit account goes in again, from that one account
  d = decide(s, view([side('100'), side('20')], ['0', '30']), () => 0.1);
  assert.equal(d.kind, 'shield'); assert.equal(d.units, tac('29.54')); assert.equal(d.eoa, 1);
  // the original account's TAC still gets shielded on a reshield too
  d = decide(s, view([side('100'), side('20')], ['489', '0', '0']), () => 0.1);
  assert.equal(d.kind, 'shield'); assert.equal(d.eoa, 0); assert.equal(d.units, tac('180'), 'up to the in-play cap');
  // the in-play cap holds back a reshield
  assert.notEqual(decide(s, view([side('250'), side('50')], '30'), () => 0.1).kind, 'shield');
}
// pickSource: a random account holding enough, or the richest; null when none
{
  const e = [{ index: 0, units: tac('3') }, { index: 4, units: tac('25') }, { index: 7, units: tac('40') }];
  const seen = new Set(); for (let i = 0; i < 200; i++) seen.add(pickSource(e, { min: tac('20') }).index);
  assert.deepEqual([...seen].sort(), [4, 7]);
  assert.equal(pickSource(e, { min: 0n, richest: true }).index, 7);
  assert.equal(pickSource(e, { min: tac('50') }), null);
}
// watchOwed: paid out (owed 0) leaves the list; owed past the timeout alerts once; unread stays
{
  const t = 1_800_000_000_000, A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40);
  const p = [{ index: 1, address: A, units: '5', since: t - 10 * 60e3 }, { index: 2, address: B, units: '6', since: t - 200 * 60e3 }, { index: 3, address: C, units: '7', since: t - 300 * 60e3 }];
  let w = watchOwed(p, { [A]: 0n, [B]: 6n * T * UNIT }, t, 120);
  assert.deepEqual(w.paid.map((x) => x.index), [1]);
  assert.deepEqual(w.alerts.map((x) => x.index), [2]);
  assert.deepEqual(w.pending.map((x) => x.index), [2, 3], 'unread stays');
  w = watchOwed(w.pending, { [B]: 6n * T * UNIT, [C]: 7n * T * UNIT }, t + 60e3, 120);
  assert.deepEqual(w.alerts.map((x) => x.index), [3], 'each alerts once');
  assert.equal(watchOwed([{ index: 4, address: A, units: '1', since: t }], { [A]: 5n }, t + 60e3, 120).alerts.length, 0, 'within the timeout: quiet');
}
// the bot: exit accounts rotate and are kept on disk; a withdrawal goes to a fresh one; an unpaid one is logged once; reshield from it
{
  const dir = mkdtempSync(join(tmpdir(), 'tacit-bot-unit-'));
  const owed = new Map(), bal = new Map(), lines = [];
  const pad = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const rpcCall = async (m, [{ to, data }]) => {
    const d = data.slice(2, 10), a = '0x' + data.slice(34, 74);
    if (d === '70a08231') return pad(bal.get(a) || 0n);
    if (d === Buffer.from(keccak_256(new TextEncoder().encode('owed(address)')).slice(0, 4)).toString('hex')) return pad(owed.get(a) || 0n);
    if (d === Buffer.from(keccak_256(new TextEncoder().encode('TAC()')).slice(0, 4)).toString('hex')) return pad(0xabcn);
    throw new Error('unexpected ' + d);
  };
  let t = 1_800_000_000_000;
  const mk = () => makeBot({ seed, cfg: { blocks: '0x' + 'b'.repeat(40), leader: 'http://127.0.0.1:9' }, rpcCall, system: () => null, stateDir: dir, env: { BOT_IDENTITIES: '5' }, now: () => t, log: (o) => lines.push(o) });
  let bot = await mk();
  assert.equal(bot.clients.length, 5);
  assert.deepEqual(bot.exitAccounts(), [ids.eoa.address]);
  // two withdrawals: each to a fresh exit account (1, then 2), never account 0 nor an earlier one
  const dest = [];
  for (const i of [2, 3]) bot.clients[i].withdraw = async (to) => { dest.push(to); return { height: i }; };
  assert.equal((await bot.withdraw(2, tac('5'))).account, exitAccount(seed, 1).address);
  t += 60e3;
  await bot.withdraw(3, tac('6'));
  assert.deepEqual(dest, [exitAccount(seed, 1).address, exitAccount(seed, 2).address]);
  assert.equal(bot.snapshot().waitingPayout.length, 2);
  // kept on disk: a restart goes on from index 3 and still reads both
  bot = await mk();
  assert.equal(bot.exitIndex(), 2);
  assert.deepEqual(bot.exitAccounts(), [0, 1, 2].map((i) => exitAccount(seed, i).address));
  assert.equal(JSON.parse(readFileSync(join(dir, 'bot.json'), 'utf8')).exitIndex, 2);
  // the leader paid account 1 and not account 2: past the timeout, account 2 is logged once and /health is not ok; nothing is retried
  const e1 = exitAccount(seed, 1).address, e2 = exitAccount(seed, 2).address;
  owed.set(e2, 6n * T * UNIT);
  t += 121 * 60e3;
  await bot.checkExits(null);
  await bot.checkExits(null);
  const unpaid = lines.filter((l) => l.action === 'unpaid');
  assert.equal(unpaid.length, 1); assert.equal(unpaid[0].account, e2); assert.equal(unpaid[0].owed, '6');
  assert.equal(bot.snapshot().ok, false); assert.equal(bot.snapshot().unpaid.length, 1);
  owed.set(e2, 0n);
  await bot.checkExits(null);
  assert.equal(bot.snapshot().waitingPayout.length, 0); assert.equal(bot.snapshot().unpaid.length, 0);
  assert.deepEqual(bot.exitAccounts(), [ids.eoa.address, e1, e2], 'paid out: still read, for the reshield');
  // the reshield takes from whichever account holds TAC, one permit each
  bal.set(e2, 30n * T * UNIT);
  const v = { ids: [side('100'), side('20'), side('0'), side('0'), side('0')], eoas: bot.exitAccounts().map((a, i) => ({ index: i, address: a, units: (bal.get(a) || 0n) / UNIT })), fee: tac('0.25'), shieldCap: tac('1000'), sweepFee: 454_358_580_000_000_000n };
  const d = decide(s, v, () => 0.1);
  assert.equal(d.kind, 'shield'); assert.equal(d.eoa, 2); assert.equal(d.units, tac('29.54'));
  // the health answer: per-identity worth and per-account TAC, no secret
  const hb = bot.balances(v);
  assert.equal(hb.ids.a, '100'); assert.equal(hb.eoas[e2], '30');
  const js = JSON.stringify({ ...bot.snapshot(), hb });
  for (const k of [...identities(seed, 5).keys, exitAccount(seed, 1).priv, exitAccount(seed, 2).priv]) assert.ok(!js.includes(Buffer.from(k).toString('hex')));
  assert.ok(!js.includes(seed));
  // an account holding only dust stops being read a day after it was paid out (account 0 never does)
  t += 25 * 3600e3;
  await bot.checkExits({ eoas: v.eoas.map((e) => ({ ...e, units: e.index === 2 ? e.units : 0n })) });
  assert.deepEqual(bot.exitAccounts(), [ids.eoa.address, e2]);
}
// failures in a row stop it; a success resets the count
{
  const f = makeFailures(3);
  f.fail(); f.fail(); f.ok(); assert.equal(f.count(), 0);
  assert.ok(!f.fail()); assert.ok(!f.fail()); assert.ok(f.fail()); assert.ok(f.stopped());
}
console.log(JSON.stringify({ ok: true }));
