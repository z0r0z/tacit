// dapp/bridge-all.js: what the Bridge tab's Merge and Bridge all presses do with the notes it lists.
//   node --test tests/bridge-all.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { packNotes, planMerge, planAll, planPick, countAll, opsCompared, MAX_MERGE_INPUTS } from '../dapp/bridge-all.js';

const CAP = 100_000_000_000n;                       // 1,000 TAC in raw units (8 decimals)
const NOTE_MAX = 10n ** 18n;                        // what one note holds: there is no per-bridge cap
const tac = (v) => BigInt(Math.round(v * 1e8));
let seq = 0;
const note = (v, o = {}) => ({ txid: String(++seq).padStart(64, '0'), vout: 0, amount: String(tac(v)), eligible: true, reason: null, tracking: 'tracked', form: 'ready', stealthTweakedSk: null, ...o });
const sum = (ns) => ns.reduce((s, n) => s + BigInt(n.amount), 0n);
const ids = (ns) => ns.map((n) => `${n.txid}:${n.vout}`).sort();

// The list a holder reported: thirteen notes, 1,500 TAC, three of them in the older form, two holding nothing.
const reported = () => [331.3021, 285.1284, 265, 214.8716, 100, 90, 89.2732, 79.4179, 35.0068, 7, 3, 0, 0]
  .map((v) => note(v, [265, 90, 7].includes(v) ? { form: 'old' } : {}));

test('packNotes: each pack is within the cap and the input limit, nothing is lost or repeated', () => {
  const ns = reported().filter((n) => BigInt(n.amount) > 0n), packs = packNotes(ns, CAP);
  assert.ok(packs.every((p) => p.total <= CAP && p.notes.length <= MAX_MERGE_INPUTS && sum(p.notes) === p.total));
  assert.deepEqual(ids(packs.flatMap((p) => p.notes)), ids(ns));
  assert.equal(packs.length, 2, '1,500 TAC needs two notes');
  assert.equal(packs[0].total, tac(981.4305) + tac(10));
  const many = Array.from({ length: 30 }, () => note(1));
  assert.deepEqual(packNotes(many, CAP).map((p) => p.notes.length), [10, 10, 10], 'thirty small notes go in packs of at most ten');
  assert.deepEqual(packNotes([note(600), note(500), note(400)], CAP).map((p) => p.total), [tac(1000), tac(500)]);
  assert.deepEqual(packNotes([], CAP), []);
});

test('packNotes: an exact fill, and the same packs whatever order the notes come in', () => {
  const ns = [note(500), note(300), note(200), note(400), note(600)];
  const a = packNotes(ns, CAP), b = packNotes([...ns].reverse(), CAP);
  assert.deepEqual(a.map((p) => ids(p.notes)), b.map((p) => ids(p.notes)));
  assert.ok(a.every((p) => p.total <= CAP));
});

test('planMerge: tracked notes in the reported list make two merges, and the empty notes are left', () => {
  const list = reported(), plan = planMerge(list, { capRaw: CAP });
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.groups.reduce((n, g) => n + g.notes.length, 0), 11);
  assert.equal(plan.groups.reduce((s, g) => s + g.total, 0n), tac(1500));
  assert.ok(plan.groups.every((g) => g.total <= CAP && g.notes.length > 1));
  assert.deepEqual(plan.skipped.map((s) => s.why), ['empty', 'empty']);
  assert.deepEqual(plan.left, []);
});

test('planMerge: an untracked, a new and a private note are never in a merge', () => {
  const ok1 = note(100), ok2 = note(200), unt = note(50, { tracking: 'untracked', form: null }), fresh = note(40, { tracking: 'new', form: null });
  const priv = note(30, { form: 'private', stealthTweakedSk: 'aa'.repeat(32) }), unk = note(20, { tracking: undefined }), bound = note(10, { tracking: 'bound' });
  const plan = planMerge([ok1, ok2, unt, fresh, priv, unk, bound], { capRaw: CAP });
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(ids(plan.groups[0].notes), ids([ok1, ok2]));
  assert.deepEqual(ids(plan.left), ids([unt, priv]));
  assert.deepEqual(plan.skipped.map((s) => [s.note.txid === fresh.txid ? 'fresh' : s.note.txid === unk.txid ? 'unk' : '?', s.why]).sort(), [['?', 'bound'], ['fresh', 'recent'], ['unk', 'unknown']]);
});

test('planMerge: nothing to merge with one tracked note, or when the cap leaves each alone', () => {
  assert.equal(planMerge([note(500)], { capRaw: CAP }).groups.length, 0);
  assert.equal(planMerge([note(900), note(900)], { capRaw: CAP }).groups.length, 0, 'two notes that cannot share a pack stay as they are');
  assert.deepEqual(planMerge([note(900), note(900)], { capRaw: CAP }).left.length, 2);
  assert.equal(planMerge([note(5, { eligible: false, reason: 'unconfirmed' }), note(6)], { capRaw: CAP }).groups.length, 0, 'an unavailable note is not merged');
  assert.equal(planMerge([note(2000, { eligible: false, reason: 'over the 1,000 TAC beta limit' }), note(1), note(2)], { capRaw: CAP }).groups.length, 1);
});

test('planAll: ready notes burn now, older-form notes go in one send, untracked and private notes are kept apart', () => {
  const plan = planAll(reported(), { capRaw: CAP });
  assert.equal(plan.burns.length, 8, 'the eight notes in the burn\'s form burn as they are');
  assert.equal(plan.sends.length, 1, 'the three older-form notes share one send');
  assert.equal(plan.sends[0].total, tac(362));
  assert.deepEqual(plan.sends[0].notes.map((n) => n.form), ['old', 'old', 'old']);
  assert.deepEqual([plan.privates.length, plan.checks.length, plan.skipped.length], [0, 0, 2]);
  assert.ok(plan.burns.every((n) => n.form !== 'old'));
  assert.deepEqual(plan.burns.map((n) => BigInt(n.amount)), [...plan.burns.map((n) => BigInt(n.amount))].sort((a, b) => (a > b ? -1 : 1)), 'biggest first');
});

test('planAll: sends are packed within the cap, a lone older note is still sent, and the other kinds are listed', () => {
  const olds = [note(700, { form: 'old' }), note(600, { form: 'old' }), note(5, { form: 'old' })];
  const priv = note(30, { form: 'private', stealthTweakedSk: 'aa'.repeat(32) }), unt = note(60, { tracking: 'untracked', form: null }), fresh = note(9, { tracking: 'new', form: null });
  const plan = planAll([...olds, priv, unt, fresh, note(15)], { capRaw: CAP });
  assert.deepEqual(plan.sends.map((s) => s.total), [tac(705), tac(600)]);
  assert.deepEqual([plan.privates[0]?.txid, plan.checks[0]?.txid], [priv.txid, unt.txid]);
  assert.equal(plan.burns.length, 1);
  assert.deepEqual(plan.skipped.map((s) => s.why), ['recent']);
  assert.equal(planAll([note(40, { form: 'old' })], { capRaw: CAP }).sends.length, 1);
});

test('countAll: every note Bridge all takes on, none of those it skips', () => {
  assert.equal(countAll(planAll(reported(), { capRaw: CAP })), 11);
  assert.equal(countAll(planAll([note(5, { tracking: 'new' }), note(5, { tracking: undefined })], { capRaw: CAP })), 0, 'notes not yet tracked, or of unknown tracking, are not counted');
  const mixed = planAll([note(10), note(20, { form: 'old' }), note(30, { form: 'private', stealthTweakedSk: 'bb'.repeat(32) }), note(40, { tracking: 'untracked', form: null })], { capRaw: CAP });
  assert.equal(countAll(mixed), 4);
});

test('planAll and planMerge leave their input alone', () => {
  const list = reported(), before = JSON.stringify(list);
  planMerge(list, { capRaw: CAP }); planAll(list, { capRaw: CAP });
  assert.equal(JSON.stringify(list), before);
});

test('opsCompared: merging first takes fewer Bitcoin transactions for the reported list, and the same count when nothing can merge', () => {
  const list = reported(), c = opsCompared(planMerge(list, { capRaw: CAP }), planAll(list, { capRaw: CAP }));
  assert.deepEqual(c, { all: 8 + 2, merge: 4 }, 'eight burns and one two-step send, against two packs of a transfer and a burn');
  const two = [note(900), note(900)], c2 = opsCompared(planMerge(two, { capRaw: CAP }), planAll(two, { capRaw: CAP }));
  assert.deepEqual(c2, { all: 2, merge: 2 }, 'two notes that cannot share a pack cost the same either way');
  const old = [note(900, { form: 'old' }), note(900, { form: 'old' })], c3 = opsCompared(planMerge(old, { capRaw: CAP }), planAll(old, { capRaw: CAP }));
  assert.deepEqual(c3, { all: 4, merge: 4 }, 'older-form notes alone count a send and a burn each');
  const mixed = [note(10), note(20), note(5, { tracking: 'untracked', form: null }), note(7, { form: 'private', stealthTweakedSk: 'cc'.repeat(32) })];
  const c4 = opsCompared(planMerge(mixed, { capRaw: CAP }), planAll(mixed, { capRaw: CAP }));
  assert.deepEqual(c4, { all: 2, merge: 2 }, 'untracked and private notes are left out of the comparison');
});

test('planPick: ticked notes merge into one note of their whole', () => {
  const id = (n) => `${n.txid}:${n.vout}`;
  const a = note(410.5), b = note(275.25), c = note(120.125), d = note(64.0625), e = note(500);
  const one = planPick([a, b, c, d, e], [a, b, c].map(id), { capRaw: CAP });
  assert.equal(one.ok, true);
  assert.equal(one.kind, 'tracked');
  assert.equal(one.total, tac(805.875));
  assert.deepEqual(one.notes.map((n) => n.txid), [a, b, c].map((n) => n.txid), 'biggest first, only the ticked ones');
  const all = planPick([a, b, c, d, e], [a, b, c, d, e].map(id), { capRaw: NOTE_MAX });
  assert.deepEqual([all.ok, all.total], [true, tac(1369.9375)], 'with no per-bridge cap, everything ticked becomes one note');
  assert.equal(planPick([a, b], [], { capRaw: CAP }).why, 'few', 'nothing ticked');
  assert.equal(planPick([a, b], [id(a), 'f'.repeat(64) + ':0'], { capRaw: CAP }).why, 'few', 'a ticked note no longer listed does not count');
});

test('planPick: notes of the other kind, a private, empty, recent or unavailable note, too many, or more than a note holds are refused', () => {
  const id = (n) => `${n.txid}:${n.vout}`, pick = (ns, opts = {}) => planPick(ns, ns.map(id), { capRaw: NOTE_MAX, ...opts });
  assert.equal(pick([note(10)]).why, 'few');
  assert.equal(pick([note(10), note(20, { tracking: 'untracked', form: null })]).why, 'mixed');
  const unt = pick([note(10, { tracking: 'untracked', form: null }), note(20, { tracking: 'untracked', form: null })]);
  assert.deepEqual([unt.ok, unt.kind, unt.total], [true, 'untracked', tac(30)]);
  for (const bad of [note(5, { form: 'private', stealthTweakedSk: 'aa'.repeat(32) }), note(0), note(5, { tracking: 'new' }), note(5, { tracking: 'bound' }), note(5, { eligible: false, reason: 'proof' })]) {
    const r = pick([note(10), bad]);
    assert.deepEqual([r.ok, r.why, r.bad?.txid], [false, 'unmergeable', bad.txid]);
  }
  assert.equal(pick(Array.from({ length: MAX_MERGE_INPUTS + 1 }, () => note(1))).why, 'inputs');
  assert.equal(pick(Array.from({ length: MAX_MERGE_INPUTS }, () => note(1))).ok, true);
  const over = pick([note(900), note(900)], { capRaw: CAP });
  assert.deepEqual([over.ok, over.why, over.total], [false, 'over', tac(1800)], 'more than one note holds');
});
