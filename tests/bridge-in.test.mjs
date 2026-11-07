// dapp/bridge-in.js, what starting a bridge from Bitcoin is made of wherever it is started: the words for a check that failed, the notes that
// can go and why the others cannot, the cost against the coins a key has free, the one transaction (or the move) that starts it, and the send
// to one's own address that an older note needs first.
//   node tests/bridge-in.test.mjs
import assert from 'node:assert/strict';
import { TAC_BTC_ID, noteId, bridgeError, checkText, needsSend, firstStep, overCap, marked, longReason, listNotes, review, checkNote, priceNote, planSet, burnMaxRate, PLAN_KEY, begin, toSelf, NO_SATS, isShort, halts, haltText, PREP_KEY, preps, prepAdd, mergeSend, startNote, tryAgain, bulkFee, sendCost, prepsAfterPass, runMerge, runAll } from '../dapp/bridge-in.js';

const say = (e) => `said: ${e?.message || e}`;

// a failure is put in the page's words, with the bridge's own about funds held for other bridges
assert.match(bridgeError(new Error('burndep-ux: held for your other bridges'), say), /free bitcoin is held for your other bridges’ burns/);
assert.match(bridgeError(new Error('no safe funding utxo'), say), /has no free bitcoin to pay this step’s fee/);
assert.match(bridgeError(new Error('this bridge is leased by another tab'), say), /being moved on in another tab/);
assert.equal(bridgeError(new Error('burndep-ux: over the beta cap'), say), 'said: Over the beta cap', 'the engine’s prefix goes, the first letter is a capital');
assert.equal(bridgeError(new Error('plain'), say), 'said: plain');

// the words for the step of a check that failed
const T = (s) => checkText(s, say);
assert.match(T({ name: 'not-tracked' }), /arrived recently/);
assert.match(T({ name: 'reflected' }), /One Bitcoin transaction sends it to your own address/);
assert.match(T({ name: 'old-leaf' }), /older note form/);
assert.match(T({ name: 'source-confirmed' }), /waiting for its Bitcoin confirmation/);
assert.match(T({ name: 'trace', tooLong: true, hops: 2500, atLeast: true, max: 1000 }), /more than 2,500 transfers in its history, and the bridge proves up to 1000/);
assert.match(T({ name: 'trace', tooLong: true, max: 1000 }), /far more than 1,000 transfers/);
assert.match(T({ name: 'trace', unprovable: true, through: 'pool' }), /includes a pool or farm trade on Bitcoin, which the bridge’s proof does not follow, so it goes to Ethereum by the fast bridge instead\./);
assert.match(T({ name: 'trace', unprovable: true, through: 'shielded' }), /includes a move through Bitcoin’s shielded pool, which the bridge’s proof does not follow, so it goes to Ethereum by the fast bridge/);
assert.match(T({ name: 'trace', unprovable: true, through: 'other', at: 'ab'.repeat(32) }), /includes a transaction the bridge’s proof does not follow \(abababab…ababab\)/);
assert.match(T({ name: 'trace', reading: true, read: 1234 }), /1,234 transfers so far/);
assert.match(T({ name: 'trace', detail: 'busy, retry in ~40s' }), /Pick it again in about 40 seconds/);
assert.match(T({ name: 'trace', detail: 'boom' }), /Could not read this TAC’s history from Bitcoin \(said: boom\)/);
assert.match(T({ name: 'cap', detail: 'x' }), /^Could not check this TAC: said: x$/);

// the notes: which need a send first, which are over the limit, which a check or an empty amount takes off the list
assert.ok(needsSend({ form: 'old' }) && needsSend({ form: 'private' }) && !needsSend({ form: 'tacit' }) && !needsSend({}));
assert.match(firstStep({ form: 'old' }), /^Older note form/); assert.match(firstStep({ form: 'private' }), /^Received privately/); assert.equal(firstStep({ form: 'tacit' }), '');
assert.ok(overCap({ eligible: false, reason: 'over the 1,000 TAC beta limit — send part' }) && !overCap({ eligible: true, reason: null }) && !overCap({ eligible: false, reason: 'unconfirmed' }));
const n1 = { txid: 'aa', vout: 0, amount: '500', eligible: true };
assert.equal(noteId(n1), 'aa:0');
assert.equal(marked(n1, new Map()), n1);
const deep = new Map([['aa:0', { tooLong: true, hops: 5000, max: 1000 }]]);
assert.equal(marked(n1, deep).eligible, false);
assert.equal(marked(n1, deep).reason, '5,000 transfers in its history; the bridge proves up to 1000.');
assert.equal(marked({ ...n1, amount: '0' }, new Map()).reason, 'Holds no TAC');
assert.equal(marked({ ...n1, eligible: false, reason: 'unconfirmed' }, new Map([['aa:0', { tooLong: true }]])).reason, 'unconfirmed', 'a note already off the list keeps its own reason');
assert.match(longReason({ unprovable: true, through: 'shielded' }), /^Its history includes a move through Bitcoin’s shielded pool, which the bridge does not follow\.$/);

// the listing: the key's TAC with each note's form, tracking and eligibility, the eligible first and the larger first among them
{
  const utxo = (txid, vout, amount, extra = {}) => ({ utxo: { txid, vout, value: 546, status: extra.confirmed === false ? {} : { confirmed: true, block_height: 900000 } }, amount, blinding: 'bb' });
  const holdings = new Map([[TAC_BTC_ID, { assetIdHex: TAC_BTC_ID, utxos: [utxo('a1', 0, 100n), utxo('b2', 1, 900n), utxo('c3', 0, 500n, { confirmed: false }), utxo('d4', 0, 700n)] }], ['other', { utxos: [utxo('e5', 0, 1n)] }]]);
  const asked = [];
  const t = { scanHoldings: async (force) => { asked.push(force); return holdings; },
    bridgeUx: () => ({
      noteForms: async (ns) => new Map(ns.map((n) => [noteId(n), n.txid === 'a1' ? 'old' : 'tacit'])),
      noteTracking: async (ns) => new Map(ns.map((n) => [noteId(n), 'tracked'])),
      eligibleNotes: (ns) => ns.map((n) => ({ ...n, eligible: n.confirmed && n.txid !== 'd4', reason: !n.confirmed ? 'unconfirmed' : n.txid === 'd4' ? 'already bridging' : null })),
    }) };
  const seen = [];
  const notes = await listNotes(t, { force: true, esplora: async (p) => { seen.push(p); return { confirmed: false }; } });
  assert.deepEqual(asked, [true]);
  assert.deepEqual(notes.map(noteId), ['b2:1', 'a1:0', 'd4:0', 'c3:0'], 'eligible first, the larger first among each');
  assert.deepEqual(seen, ['/tx/c3/status'], 'only a note not yet known confirmed is asked of the explorer');
  assert.equal(notes.find((n) => n.txid === 'a1').form, 'old'); assert.equal(notes.find((n) => n.txid === 'a1').tracking, 'tracked');
  assert.equal((await listNotes({ ...t, scanHoldings: async () => new Map() }, { esplora: async () => null })).length, 0, 'no TAC, no notes');
  // forms or tracking that cannot be read leave the notes as they are
  const bare = await listNotes({ ...t, bridgeUx: () => ({ noteForms: async () => { throw new Error('x'); }, noteTracking: async () => { throw new Error('y'); }, eligibleNotes: (ns) => ns.map((n) => ({ ...n, eligible: true })) }) }, { esplora: async () => ({ confirmed: true }) });
  assert.ok(bare.every((n) => n.form === undefined && n.tracking === undefined));
}

// the cost: a check that fails is returned as it is, one that passes is priced against the coins free for fees
{
  const note = { txid: 'a1', vout: 0, sats: 546, amount: '100' };
  const ux = (pf) => ({ preflight: async ({ onProgress }) => { onProgress?.(7); return pf; }, bridgeCost: ({ path, coins }) => ({ fee: 700, need: 900, ok: coins.some((c) => c.value >= 900), have: coins[0]?.value || 0, path }) });
  const bad = await review({ bridgeUx: () => ux({ ok: false, steps: [{ name: 'reflected', ok: false }] }) }, { note, walletPub: new Uint8Array(33) });
  assert.equal(bad.ok, false); assert.equal(bad.pf.steps[0].name, 'reflected');
  const progress = [];
  const t = (pf, coins) => ({ bridgeUx: () => ux(pf), pickSafeCommitSats: async (u) => u, getUtxos: async () => coins, wallet: { address: () => 'bc1q' } });
  const good = await review(t({ ok: true, path: 'reflected', burnFeeRate: 5 }, [{ value: 5000 }]), { note, walletPub: new Uint8Array(33), onProgress: (n) => progress.push(n) });
  assert.deepEqual([good.ok, good.one, good.short, good.cost.path], [true, true, false, 'reflected']); assert.deepEqual(progress, [7]);
  const poor = await review(t({ ok: true, path: 'migrate', migrateFeeRate: 5 }, [{ value: 100 }]), { note, walletPub: new Uint8Array(33) });
  assert.deepEqual([poor.one, poor.short], [false, true], 'coins read and short of the need');
  const unread = await review({ ...t({ ok: true, path: 'reflected', burnFeeRate: 5 }, []), getUtxos: async () => { throw new Error('down'); } }, { note, walletPub: new Uint8Array(33) });
  assert.equal(unread.short, false, 'coins that could not be read are not called short');
  const given = await review(t({ ok: true, path: 'reflected', burnFeeRate: 5 }, []), { note, walletPub: new Uint8Array(33), coins: [{ value: 9000 }] });
  assert.equal(given.short, false, 'coins read already are used as they are');
}

// the check and the price are two steps: the check can take minutes, the coins are read after it each time
{
  const note = { txid: 'a1', vout: 0, sats: 546, amount: '100' };
  const ux = { preflight: async ({ onProgress }) => { onProgress?.(3); return { ok: true, path: 'reflected', burnFeeRate: 5 }; },
    bridgeCost: ({ coins }) => ({ fee: 700, need: 900, ok: coins.some((c) => c.value >= 900), have: coins[0]?.value || 0 }) };
  const t = { bridgeUx: () => ux };
  const seen = [], c = await checkNote(t, { note, walletPub: new Uint8Array(33), onProgress: (n) => seen.push(n) });
  assert.deepEqual([c.ok, c.pf.path, seen], [true, 'reflected', [3]]);
  assert.equal(priceNote(t, { note, pf: c.pf, coins: [{ value: 100 }] }).short, true, 'coins read and short');
  assert.equal(priceNote(t, { note, pf: c.pf, coins: [{ value: 5000 }] }).short, false);
  assert.equal(priceNote(t, { note, pf: c.pf, coins: null }).short, false, 'coins not read are not called short');
  assert.equal((await checkNote({ bridgeUx: () => ({ preflight: async () => ({ ok: false, steps: [] }) }) }, { note, walletPub: new Uint8Array(33) })).ok, false);
}
// the plans kept beside the journal, newest fifty per key, and the rate a move's burn may go out at on its own
{
  const m = new Map(), mem = { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) };
  planSet(mem, 'pubA', 'id1', { at: 2, burn: { maxRate: 20 } }); planSet(mem, 'pubA', 'id2', { at: 3 }); planSet(mem, 'pubB', 'idx', { at: 1 });
  assert.deepEqual(Object.keys(m.get(PLAN_KEY).pubA), ['id2', 'id1'], 'newest first'); assert.deepEqual(m.get(PLAN_KEY).pubB, { idx: { at: 1 } });
  planSet(mem, 'pubA', 'id1', null); assert.deepEqual(Object.keys(m.get(PLAN_KEY).pubA), ['id2'], 'a plan is dropped by naming none');
  for (let i = 0; i < 60; i++) planSet(mem, 'pubC', `n${i}`, { at: 100 + i });
  assert.equal(Object.keys(m.get(PLAN_KEY).pubC).length, 50); assert.ok(m.get(PLAN_KEY).pubC.n59 && !m.get(PLAN_KEY).pubC.n0);
  assert.equal(burnMaxRate({}), 20, 'no miner rates read: twice the 10 floor');
  assert.equal(burnMaxRate({ slipstreamRates: { effective_rate: 12, submit_fee_rate: 9 } }), 27, 'twice a tenth over the miner’s rate');
  assert.equal(burnMaxRate({ slipstreamRates: { effective_rate: 1, submit_fee_rate: 1 } }), 10, 'never under 10');
}
// starting: one transaction for a tracked note (and the relay asked to finish the mint), a move for the rest, a fee paid from a coin that is free
{
  const calls = [];
  const rec = { id: 'br1', walletPub: 'wp' };
  const ux = (over = {}) => ({
    startReflected: async (o) => { calls.push(['startReflected', o]); return rec; },
    start: async (o) => { calls.push(['start', o]); return rec; },
    advance: async (pub, id) => { calls.push(['advance', pub, id]); return { ...rec, stage: 'burn-submitted' }; },
    armMint: async (pub, id, o) => { calls.push(['armMint', pub, id, o]); },
    list: () => [{ ...rec, stage: 'burn-signed' }],
    pickFunding: (coins, need) => { calls.push(['pick', need]); return coins.find((c) => c.value >= need) || null; },
    ...over,
  });
  const t = (u) => ({ bridgeUx: () => u, pickSafeCommitSats: async (c) => c, getUtxos: async () => [{ txid: 'f', vout: 1, value: 5000 }], wallet: { address: () => 'bc1q' } });
  const note = { txid: 'a1', vout: 0, sats: 546, amount: '100' };
  const one = await begin(t(ux()), { review: { note, pf: { path: 'reflected', burnFeeRate: 6 }, cost: { need: 800 } }, priv: 'PRIV', recipient: 'RCPT' });
  assert.equal(one.stage, 'burn-submitted');
  assert.deepEqual(calls.map((c) => c[0]), ['startReflected', 'advance', 'armMint']);
  assert.deepEqual(calls[0][1], { note, walletPriv: 'PRIV', feeRate: 6, recipient: 'RCPT' });
  assert.deepEqual(calls[2].slice(1, 3), ['wp', 'br1']); assert.equal(calls[2][3].walletPriv, 'PRIV');
  calls.length = 0;
  await begin(t(ux()), { review: { note, pf: { path: 'reflected', burnFeeRate: 6 }, cost: { need: 800 } }, priv: 'PRIV' });
  assert.ok(!('recipient' in calls[0][1]), 'no recipient: the key’s own');
  calls.length = 0;
  await begin(t(ux()), { review: { note, pf: { path: 'migrate', migrateFeeRate: 4 }, cost: { need: 1000 } }, priv: 'PRIV' });
  assert.deepEqual(calls.map((c) => c[0]), ['pick', 'start', 'advance'], 'a move is not armed for a mint: its burn comes later');
  assert.equal(calls[0][1], 1100, 'the funding coin covers the need and a tenth over');
  assert.deepEqual(calls[1][1].fundingUtxo, { txid: 'f', vout: 1, value: 5000 });
  await assert.rejects(begin({ ...t(ux()), getUtxos: async () => [{ txid: 'f', vout: 1, value: 100 }] }, { review: { note, pf: { path: 'migrate', migrateFeeRate: 4 }, cost: { need: 1000 } }, priv: 'PRIV' }), /no sats free to pay the fee/);
  // a record that could not be advanced is read back from the journal
  calls.length = 0;
  const back = await begin(t(ux({ advance: async () => { throw new Error('down'); } })), { review: { note, pf: { path: 'reflected', burnFeeRate: 6 }, cost: { need: 800 } }, priv: 'PRIV' });
  assert.equal(back.stage, 'burn-signed');
  // an arming that fails does not undo a burn that was sent
  const armed = await begin(t(ux({ armMint: async () => { throw new Error('relay down'); } })), { review: { note, pf: { path: 'reflected', burnFeeRate: 6 }, cost: { need: 800 } }, priv: 'PRIV' });
  assert.equal(armed.stage, 'burn-submitted');
}

// the send to one's own address: the notes by output, the amount whole or split, the coin cache dropped
{
  const sent = [];
  const holdings = new Map([['id1', { utxos: [{ utxo: { txid: 'a1', vout: 0 }, amount: 100n }, { utxo: { txid: 'b2', vout: 1 }, amount: 250n }] }]]);
  let dropped = 0;
  const t = { scanHoldings: async (force) => { assert.equal(force, true); return holdings; }, wallet: { pub: new Uint8Array([1, 2, 255]) }, invalidateHoldingsCache: () => { dropped++; },
    buildAndBroadcastCXfer: async (o) => { sent.push(o); return { revealTxid: 'tx9' }; } };
  const r = await toSelf(t, 'id1', [{ txid: 'a1', vout: 0 }, { txid: 'b2', vout: 1 }]);
  assert.deepEqual(r, { txid: 'tx9', amount: 350n }); assert.equal(sent[0].amount, 350n); assert.equal(sent[0].recipientPubHex, '0102ff'); assert.equal(dropped, 1);
  assert.deepEqual(sent[0].forceUtxos.map((u) => u.amount), [100n, 250n]);
  assert.equal((await toSelf(t, 'id1', [{ txid: 'b2', vout: 1 }], 60n)).amount, 60n, 'a part of one note');
  await assert.rejects(toSelf(t, 'id1', [{ txid: 'zz', vout: 0 }], null, 'TAC note'), /^Error: That TAC note is no longer at this address\. Refresh, then try again\.$/);
  assert.equal(sent.length, 2, 'nothing is sent for a note that is gone');
}

// ── several notes at once ──────────────────────────────────────────────────────────────────────────────────────────────────
const memOf = () => { const m = new Map(); return Object.assign({ get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) }, { m }); };
// what stops a run for good, and in what words
assert.ok(isShort(new Error('insufficient plain sats')) && isShort(new Error('no plain-sats utxo')) && !isShort(new Error('boom')));
assert.ok(halts(new Error('too-long-mempool-chain')) && halts(new Error('could not read your locked coins')) && !halts(new Error('relay down')));
assert.equal(haltText(new Error('insufficient sats'), say), NO_SATS);
assert.match(haltText(new Error('ancestor-chain limit'), say), /only so many unconfirmed transactions/);
assert.equal(haltText(new Error('burndep-ux: nope'), say), 'said: Nope');
// the sends waiting for Bitcoin's proof: kept by txid, fourteen days
{
  const mem = memOf(), now = Date.now();
  prepAdd(mem, 'p', { txid: 't1', amount: '5', at: now });
  prepAdd(mem, 'p', { txid: 't2', amount: '6', at: now, plan: { auto: { maxFee: 3000 } } });
  prepAdd(mem, 'p', { txid: 't1', amount: '7', at: now });
  assert.deepEqual(preps(mem, 'p', now).map((x) => [x.txid, x.amount]), [['t2', '6'], ['t1', '7']], 'a send is kept once, the latest record of it');
  assert.equal(preps(mem, 'p', now + 15 * 86400e3).length, 0, 'older than fourteen days: gone'); assert.deepEqual(preps(mem, null, now), []);
  assert.equal(mem.m.get(PREP_KEY).p.length, 2);
}
// a pass that read the preps once and writes them back after minutes of work: a send added meanwhile stays, a swept or started one goes, the pass's own notes are kept
{
  const t1 = { txid: 't1', amount: '5', at: 1 }, t2 = { txid: 't2', amount: '6', at: 2 }, t3 = { txid: 't3', amount: '7', at: 3 };
  const mine = [{ ...t1 }, { ...t2 }, { ...t3 }];                 // the pass's copies, read at the start
  mine[0].height = 970000; mine[2].told = true;                   // what the pass learned
  const added = { txid: 't4', amount: '8', at: 4 };               // a send made by Bridge all while the pass ran
  const current = [t1, t2, added];                                // read again at the end: t3 was swept, t4 is new
  const out = prepsAfterPass(current, mine, new Set([mine[1]]));  // the pass bridged t2
  assert.deepEqual(out.map((p) => p.txid), ['t1', 't4'], 'the new send stays, the started one and the swept one go');
  assert.equal(out[0].height, 970000, 'a send that stays is the pass’s copy, with what it learned');
  assert.equal(out[1], added, 'and the new one is untouched');
  assert.deepEqual(prepsAfterPass([], mine, new Set()), [], 'all swept: none written back');
  assert.deepEqual(prepsAfterPass(current, [], new Set()).map((p) => p.txid), ['t1', 't2', 't4'], 'no pass copies: the list as it is');
}
// a shortage is looked at again only when something has gone in this run
{
  let calls = 0, fresh = 0, slept = [];
  const run = (results, sent) => { calls = 0; const q = [...results]; return tryAgain({ fn: async () => { calls++; const r = q.shift(); if (r instanceof Error) throw r; return r; }, sentBefore: () => sent, fresh: async () => { fresh++; }, sleep: async (ms) => { slept.push(ms); } }); };
  assert.deepEqual(await run([{ rec: 1 }], false), { rec: 1 }); assert.equal(calls, 1);
  assert.deepEqual(await run([{ why: NO_SATS }], false), { why: NO_SATS }, 'nothing sent yet: a shortage is a shortage'); assert.equal(calls, 1);
  assert.deepEqual(await run([{ why: NO_SATS }, { rec: 2 }], true), { rec: 2 }); assert.equal(calls, 2); assert.equal(fresh, 2); assert.deepEqual(slept, [5000]);
  assert.deepEqual(await run([new Error('insufficient sats'), { rec: 3 }], true), { rec: 3 });
  await assert.rejects(run([new Error('insufficient sats')], false), /insufficient sats/);
  await assert.rejects(run([new Error('relay down')], true), /relay down/, 'only a shortage is tried again');
}
// a send to one's own address keeps its record, and the plan only when it asks for something
{
  const mem = memOf(), sentArgs = [];
  const withKey = async (fn) => fn({ scanHoldings: async () => new Map([[TAC_BTC_ID, { utxos: [{ utxo: { txid: 'a1', vout: 0 }, amount: 7n }, { utxo: { txid: 'b2', vout: 0 }, amount: 8n }] }]]), wallet: { pub: new Uint8Array([9, 9]) },
    buildAndBroadcastCXfer: async (o) => { sentArgs.push(o); return { revealTxid: 'tx1' }; } });
  const r = await mergeSend({ withKey, mem, pub: 'p', notes: [{ txid: 'a1', vout: 0 }, { txid: 'b2', vout: 0 }], now: () => 42 });
  assert.deepEqual(r, { txid: 'tx1', amount: 15n, n: 2 }); assert.equal(sentArgs[0].amount, 15n);
  assert.deepEqual(preps(mem, 'p', 42).map((x) => ({ ...x })), [{ txid: 'tx1', amount: '15', at: 42 }], 'no plan stored when none asked for anything');
  await mergeSend({ withKey, mem, pub: 'p', notes: [{ txid: 'a1', vout: 0 }], plan: { auto: { maxFee: 3000 } }, now: () => 43 });
  assert.deepEqual(preps(mem, 'p', 43).find((x) => x.at === 43).plan, { auto: { maxFee: 3000 } });
}
// one note started: its check, its price, its burn; the plan for a move's burn; a note that fails its check or has no coins is not started
{
  const mem = memOf(), calls = [];
  const note = { txid: 'a1', vout: 0, sats: 546, amount: '100' };
  const mk = (pf, coins) => {
    const ux = { preflight: async () => pf, bridgeCost: ({ coins: c }) => ({ fee: 700, need: 900, later: 300, ok: c.some((x) => x.value >= 900), have: c[0]?.value || 0 }), pickFunding: (c, need) => c.find((x) => x.value >= need) || null,
      startReflected: async () => { calls.push('startReflected'); return { id: 'a1:0', walletPub: 'wp' }; }, start: async () => { calls.push('start'); return { id: 'a1:0', walletPub: 'wp' }; }, advance: async () => ({ id: 'a1:0', stage: 'burn-submitted' }), armMint: async () => {}, list: () => [] };
    const t = { bridgeUx: () => ux, pickSafeCommitSats: async (c) => c, getUtxos: async () => coins, wallet: { address: () => 'bc1q' }, invalidateHoldingsCache: () => calls.push('fresh') };
    return { t, withKey: async (fn) => fn(t) };
  };
  const go = (pf, coins, o = {}) => { const { t, withKey } = mk(pf, coins); return startNote(t, { withKey, mem, pub: 'p', walletPub: new Uint8Array(33), priv: () => 'PRIV', note, errText: say, ...o }); };
  let r = await go({ ok: true, path: 'reflected', burnFeeRate: 5 }, [{ value: 5000 }]);
  assert.equal(r.rec.id, 'a1:0'); assert.deepEqual(calls, ['startReflected', 'fresh']); assert.equal(mem.m.get(PLAN_KEY), undefined, 'a one-step burn needs no plan');
  calls.length = 0; r = await go({ ok: true, path: 'migrate', migrateFeeRate: 4 }, [{ value: 5000 }], { publicTo: '0xabc' });
  assert.equal(r.rec.id, 'a1:0'); assert.deepEqual(calls, ['start', 'fresh']);
  assert.deepEqual(mem.m.get(PLAN_KEY).p['a1:0'].burn, { maxRate: 20 }); assert.equal(mem.m.get(PLAN_KEY).p['a1:0'].publicTo, '0xabc');
  calls.length = 0; r = await go({ ok: true, path: 'reflected', burnFeeRate: 5 }, [{ value: 100 }]);
  assert.deepEqual(r, { why: NO_SATS }); assert.deepEqual(calls, [], 'no coins for the fee: nothing signed');
  r = await go({ ok: false, steps: [{ name: 'source-confirmed', ok: false }] }, [{ value: 5000 }]);
  assert.match(r.why, /waiting for its Bitcoin confirmation/); assert.deepEqual(calls, []);
}
// the cost of a press, at today's rate, against the coins free for fees
{
  const ux = { quoteRate: async () => 5, bridgeCost: ({ path, feeRate, coins, noteSats }) => (path === 'deposit' ? { fee: 2000, need: 2500, later: 600, ok: true } : { fee: 1000 + noteSats, need: 900, ok: (coins[0]?.value || 0) >= 900 }) };
  // the wallet's own estimates (tacit.js estCXferRevealVb with m 2 and a sats change, estCommitVb, feeFor, DUST; read off the real ones: reveal 492 vB for one note,
  // 562 for two, 1122 for ten; a commit 153 vB for one coin, 221 for two)
  const wallet = { DUST: 546, feeFor: (vb, r) => Math.max(500, Math.ceil(vb * r)), estCommitVb: (c) => 85 + 68 * c, estCXferRevealVb: ({ numAssetIn: k }) => 422 + 70 * k };
  const t = { bridgeUx: () => ux, ...wallet };
  const n = (sats) => ({ sats });
  const bulk = { merge: { groups: [{ notes: [n(546), n(546), n(546)] }] }, all: { burns: [n(546)], sends: [{ notes: [n(546), n(546)] }], privates: [n(546)], checks: [n(546)] } };
  const m = await bulkFee(t, { bulk, kind: 'merge', coins: [{ value: 5000 }] });
  // three notes: a 632 vB reveal at 5 sat/vB is 3,160; the commit holds 2 x 546 + 3,160 less the notes' 1,638 sats, and its own fee on 153 vB is 765
  assert.deepEqual([m.fee, m.need, m.short, m.later], [765 + 3160, (1092 + 3160 - 1638) + 765, false, 1546], 'a merge is a transfer, priced by the wallet’s estimate, and the burn that follows');
  // two notes at 10 sat/vB: the wallet's 562 vB reveal, not a burn's 228 (the quote was 4,490 sats for what costs 7,150)
  const two = sendCost(t, { rate: 10, coins: [{ value: 50000 }], noteSats: 1092, k: 2 });
  assert.deepEqual([two.fee, two.need], [1530 + 5620, 5620 + 1530], 'a two-note send costs its commit and a 562 vB reveal');
  const ten = sendCost(t, { rate: 10, coins: [{ value: 50000 }], noteSats: 5460, k: 10 });
  assert.equal(ten.fee, 1530 + 11220, 'ten notes weigh 1,122 vB');
  assert.equal(sendCost(t, { rate: 10, coins: [{ value: 4000 }, { value: 4000 }], noteSats: 1092, k: 2 }).fee, 2210 + 5620, 'coins too small for the commit are joined, and the commit grows with them');
  const a = await bulkFee(t, { bulk, kind: 'all', coins: [{ value: 12000 }] });
  // a burn (900), a two-note send (2,810 + 765), a private note's send (3,006 + 765), each needing its commit, and the move of the note still being checked (2,500)
  assert.equal(a.need, 900 + (2810 + 765) + (3006 + 765) + 2500, 'a burn, a send, a private note’s send, each needing its commit, and the checked note’s move'); assert.equal(a.short, false, 'free coins of 12000 cover 10746');
  assert.equal((await bulkFee(t, { bulk, kind: 'all', coins: [{ value: 5000 }] })).short, true, 'the same press is short of 5000, which a burn’s estimate alone would have passed');
  assert.equal(a.later, 2 * 1546 + 600, 'the burns after the two sends, and the burn after a checked note’s move');
  assert.equal((await bulkFee(t, { bulk, kind: 'merge', coins: [{ value: 100 }] })).short, true, 'coins read and short');
  assert.equal((await bulkFee(t, { bulk, kind: 'merge', coins: null })).short, false, 'coins not read are not called short');
  assert.equal(await bulkFee({ bridgeUx: () => ({ quoteRate: async () => { throw new Error('x'); } }) }, { bulk, kind: 'merge', coins: [] }), null, 'no rate: no quote');
  assert.ok(m.autoMaxFee >= 3000);
}
// Merge notes: each pack in turn; a shortage stops the rest; the others are said and the run goes on
{
  const said = [], groups = [{ notes: [1, 2] }, { notes: [3, 4, 5] }, { notes: [6, 7] }];
  const again = (fn, sent) => fn();
  const sendFrom = (outs) => async (ns) => { const o = outs.shift(); if (o instanceof Error) throw o; return { txid: 't' + ns[0], amount: BigInt(ns.length), n: ns.length }; };
  let r = await runMerge({ groups, merge: sendFrom([1, 1, 1]), tryAgain: again, say: (m) => said.push(m), errText: say });
  assert.deepEqual(r.did.map((d) => d.n), [2, 3, 2]); assert.deepEqual(r.left, []); assert.equal(said[1], 'Merging 3 notes (2 of 3)…');
  r = await runMerge({ groups, merge: sendFrom([1, new Error('relay down'), 1]), tryAgain: again, errText: say });
  assert.deepEqual(r.did.map((d) => d.n), [2, 2]); assert.deepEqual(r.left, ['said: relay down'], 'a failure that is not a shortage leaves that pack and goes on');
  r = await runMerge({ groups, merge: sendFrom([1, new Error('insufficient sats'), 1]), tryAgain: again, errText: say });
  assert.deepEqual(r.did.map((d) => d.n), [2]); assert.deepEqual(r.left, [NO_SATS], 'a shortage stops the run: nothing later could do better');
}
// Bridge all: the sends first, then the burns and the checks; what is left is named with its amount
{
  const calls = [], again = (fn) => fn();
  const note = (a) => ({ amount: a });
  const all = { burns: [note(10), note(20)], sends: [{ notes: [note(1), note(2)] }], privates: [note(3)], checks: [note(30)] };
  const merge = async (ns) => { calls.push('send' + ns.length); return { txid: 'x', amount: 1n, n: ns.length }; };
  let r = await runAll({ all, merge, start: async (n) => { calls.push('start' + n.amount); return n.amount === 30 ? { why: 'did not pass its check' } : { rec: {} }; }, tryAgain: again, errText: say, amountText: (n) => `${n.amount} TAC` });
  assert.deepEqual(calls, ['send2', 'send1', 'start10', 'start20', 'start30']);
  assert.deepEqual(r.did, { burns: 2, sends: 2, sent: 3 }); assert.deepEqual(r.left, ['30 TAC: did not pass its check']);
  calls.length = 0;
  r = await runAll({ all, merge: async () => { throw new Error('too-long-mempool-chain'); }, start: async () => ({ rec: {} }), tryAgain: again, errText: say });
  assert.deepEqual(r.did, { burns: 0, sends: 0, sent: 0 }); assert.equal(r.left.length, 1); assert.match(r.left[0], /only so many unconfirmed transactions/, 'a full chain stops the run before any burn');
  r = await runAll({ all, merge, start: async (n) => { if (n.amount === 10) throw new Error('insufficient sats'); return { rec: {} }; }, tryAgain: again, errText: say, amountText: (n) => `${n.amount} TAC` });
  assert.deepEqual(r.did, { burns: 0, sends: 2, sent: 3 }); assert.deepEqual(r.left, [`10 TAC: ${NO_SATS}`], 'a shortage at a burn stops the burns after it');
}
console.log('bridge-in: all checks passed');
