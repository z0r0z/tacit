// CAS overshoot resolution for variable-fill bid claims.
//
// SPEC §5.7.7 acknowledges Cloudflare KV is not linearizable: two
// concurrent seller POSTs against the same variable-fill bid can both
// pass the pre-write `fill_amount ≤ remaining_amount` bound check and
// both write their partial-claim records, over-committing the bid by
// their combined fill_amount. PR3's re-credit cron eventually self-heals
// any abandoned overshoot, but in-flight the bid's accounting can be
// wrong for the cron's polling window.
//
// `_resolveBidPartialOvershoot` is the deterministic resolution rule
// the handler runs after writing its own claim: filter to non-expired
// claims, sort by `axintent_id` ascending, greedily keep claims while
// `sum(fill_amount) ≤ bid.amount`, evict the rest. Both racers compute
// the same survivors + evicted sets without coordinating, so the loser
// converges on a 409 regardless of which racer's POST landed first in
// the KV namespace. This file pins that the rule:
//   (a) is a no-op when the active claims set already fits,
//   (b) deterministically evicts the lexicographically-largest
//       axintent_id when the set overshoots,
//   (c) ignores expired claims (they belong to the cron's domain),
//   (d) handles edge cases — empty set, single claim that itself
//       overshoots, exactly-at-limit, multi-evict.

import { _resolveBidPartialOvershoot } from '../worker/src/index.js';

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => {
      console.log(`  THROW ${label}: ${e.message}`); fail++;
    });
}

const NOW = 1_700_000_000;
const FUTURE = NOW + 1800;
const PAST = NOW - 10;

// Helper: synthesize a partial-claim record with the fields the resolver reads.
function rec(axId, fillAmount, expiresAt = FUTURE) {
  return { axintent_id: axId, fill_amount: String(fillAmount), expires_at: expiresAt };
}

console.log('\nVariable-fill bid CAS overshoot resolution:');

await test('no claims → kept=0, no survivors, no evictions', () => {
  const r = _resolveBidPartialOvershoot([], 1000n, NOW);
  return r.kept === 0n && r.survivors.length === 0 && r.evicted.length === 0;
});

await test('single claim under budget → fully kept', () => {
  const r = _resolveBidPartialOvershoot([rec('aa', 400)], 1000n, NOW);
  return r.kept === 400n
      && r.survivors.length === 1 && r.survivors[0].axintent_id === 'aa'
      && r.evicted.length === 0;
});

await test('two claims fitting exactly → both kept', () => {
  // axintent_ids chosen out of lex order to exercise the sort.
  const r = _resolveBidPartialOvershoot([rec('ff', 400), rec('aa', 600)], 1000n, NOW);
  return r.kept === 1000n
      && r.survivors.length === 2
      && r.survivors[0].axintent_id === 'aa'
      && r.survivors[1].axintent_id === 'ff'
      && r.evicted.length === 0;
});

await test('two claims overshooting by 100 → larger axintent_id evicted', () => {
  // 'aa' < 'ff' lexicographically; greedy-keep accepts 'aa' (600),
  // then rejects 'ff' (500) since 600+500=1100 > 1000.
  const r = _resolveBidPartialOvershoot([rec('ff', 500), rec('aa', 600)], 1000n, NOW);
  return r.kept === 600n
      && r.survivors.length === 1 && r.survivors[0].axintent_id === 'aa'
      && r.evicted.length === 1 && r.evicted[0].axintent_id === 'ff';
});

await test('two racers in lex-collision order → smaller id always wins', () => {
  // Same overshoot scenario but feed the records in the OTHER order to
  // confirm the resolver doesn't depend on input order. Both racers'
  // POST handlers see the records in arbitrary list() order; the sort
  // must produce the same answer either way.
  const a = _resolveBidPartialOvershoot([rec('aa', 600), rec('ff', 500)], 1000n, NOW);
  const b = _resolveBidPartialOvershoot([rec('ff', 500), rec('aa', 600)], 1000n, NOW);
  return a.kept === b.kept
      && a.survivors.length === b.survivors.length
      && a.survivors[0].axintent_id === b.survivors[0].axintent_id
      && a.evicted.length === b.evicted.length
      && a.evicted[0].axintent_id === b.evicted[0].axintent_id
      && a.survivors[0].axintent_id === 'aa'
      && a.evicted[0].axintent_id === 'ff';
});

await test('three-way race: smallest two fit, largest evicted', () => {
  // bid.amount=1000, three claims of 400 + 400 + 400. Two fit (800),
  // the third (lex-largest) is evicted.
  const r = _resolveBidPartialOvershoot([
    rec('cc', 400), rec('aa', 400), rec('bb', 400),
  ], 1000n, NOW);
  return r.kept === 800n
      && r.survivors.length === 2
      && r.survivors.map(p => p.axintent_id).join(',') === 'aa,bb'
      && r.evicted.length === 1 && r.evicted[0].axintent_id === 'cc';
});

await test('single claim that itself overshoots → evicted', () => {
  // Pathological: somehow a fill_amount > intent.amount made it past
  // the pre-write check (e.g., race after cron re-credit raised the
  // floor briefly). Resolver must evict rather than keep.
  const r = _resolveBidPartialOvershoot([rec('aa', 2000)], 1000n, NOW);
  return r.kept === 0n
      && r.survivors.length === 0
      && r.evicted.length === 1 && r.evicted[0].axintent_id === 'aa';
});

await test('expired claims excluded before resolution', () => {
  // An expired claim is the cron's domain (PR3 re-credits + GC's it).
  // The CAS resolver MUST ignore it so its fill_amount isn't double-
  // counted against the budget. Without the filter, a stale claim
  // could phantom-evict a fresh live claim.
  const r = _resolveBidPartialOvershoot([
    rec('aa', 600, PAST),       // expired — ignore
    rec('bb', 600, FUTURE),     // active — keep
  ], 1000n, NOW);
  return r.kept === 600n
      && r.survivors.length === 1 && r.survivors[0].axintent_id === 'bb'
      && r.evicted.length === 0;
});

await test('null records (KV.get returned null) filtered safely', () => {
  // list() can race with a delete() — keys may exist but get() returns
  // null. Resolver treats those as absent rather than crashing.
  const r = _resolveBidPartialOvershoot([
    null, rec('aa', 400), undefined, rec('bb', 400),
  ], 1000n, NOW);
  return r.kept === 800n
      && r.survivors.length === 2
      && r.evicted.length === 0;
});

await test('many claims with mixed fits → greedy by axintent_id order', () => {
  // 100/400 budget = 500. Sorted: aa(100), bb(100), cc(300 → would
  // exceed: 200+300=500 OK, kept=500), dd(100 → 500+100=600 NO, evict).
  const r = _resolveBidPartialOvershoot([
    rec('dd', 100), rec('cc', 300), rec('aa', 100), rec('bb', 100),
  ], 500n, NOW);
  return r.kept === 500n
      && r.survivors.map(p => p.axintent_id).join(',') === 'aa,bb,cc'
      && r.evicted.length === 1 && r.evicted[0].axintent_id === 'dd';
});

await test('greedy reservation can skip a too-large claim mid-iteration', () => {
  // Budget 1000. Sorted: aa(400 OK kept=400), bb(700 → 400+700=1100
  // NO, evict — even though smaller claims follow), cc(500 → 400+500=
  // 900 OK kept=900). The resolver must KEEP iterating after an
  // eviction, not break — otherwise depth-fill suffers when a single
  // oversized claim sits in the middle of the sorted list.
  const r = _resolveBidPartialOvershoot([
    rec('cc', 500), rec('bb', 700), rec('aa', 400),
  ], 1000n, NOW);
  return r.kept === 900n
      && r.survivors.map(p => p.axintent_id).join(',') === 'aa,cc'
      && r.evicted.length === 1 && r.evicted[0].axintent_id === 'bb';
});

await test('protected claim is never evicted even when it overshoots', () => {
  // A claim whose linked axintent is already settling on-chain is flagged
  // `_protected`. Evicting it would drop the settle scanner's durable
  // settled_amount bump (it keys off the live bidpclaim + pledge index),
  // re-opening consumed capacity. The resolver must keep it unconditionally.
  const recs = [
    { axintent_id: 'aa', fill_amount: '800', expires_at: FUTURE, _protected: true },
    { axintent_id: 'bb', fill_amount: '800', expires_at: FUTURE },
  ];
  const r = _resolveBidPartialOvershoot(recs, 1000n, NOW);
  // aa (protected) kept; bb evicted (800+800 > 1000).
  return r.survivors.some(p => p.axintent_id === 'aa')
      && r.evicted.length === 1 && r.evicted[0].axintent_id === 'bb';
});

await test('protected claims alone over budget all survive (no eviction)', () => {
  const recs = [
    { axintent_id: 'aa', fill_amount: '700', expires_at: FUTURE, _protected: true },
    { axintent_id: 'bb', fill_amount: '700', expires_at: FUTURE, _protected: true },
  ];
  const r = _resolveBidPartialOvershoot(recs, 1000n, NOW);
  return r.kept === 1400n && r.survivors.length === 2 && r.evicted.length === 0;
});

await test('protected kept regardless of lex order vs smaller unprotected', () => {
  // 'zz' is lex-largest (would normally be evicted first) but protected;
  // the unprotected 'aa' loses instead.
  const recs = [
    { axintent_id: 'zz', fill_amount: '600', expires_at: FUTURE, _protected: true },
    { axintent_id: 'aa', fill_amount: '600', expires_at: FUTURE },
  ];
  const r = _resolveBidPartialOvershoot(recs, 1000n, NOW);
  return r.survivors.length === 1 && r.survivors[0].axintent_id === 'zz'
      && r.evicted.length === 1 && r.evicted[0].axintent_id === 'aa';
});

console.log(`\n${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
