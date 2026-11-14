// The watchtower engine on a bridged token's bid (fulfiller/watchtower-core.mjs, kind 'bound'): candidates are the worker's bound
// offers for THIS bid and key (not atomic intents), each gated by the same unit-price ceiling and fill cap, taken with the dapp's
// takeBoundOffer (which checks the note, the offer and the final pair before broadcasting), counted, and never retried once its
// checks fail; the return to the owner sweeps only sats (the bought note sits at the bid key's Taproot address). Mocked dapp/fetch.
//   node tests/watchtower-bound.test.mjs
import { runTick, returnToOwner, fetchCandidateBoundOffers } from '../fulfiller/watchtower-core.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok - ${m}`); } else { fail++; console.log(`  FAIL - ${m}`); } };
const BID = 'cd'.repeat(16), KEY = '02' + '11'.repeat(32), XONLY = '11'.repeat(32);
const offer = (id, amount, priceSats, over = {}) => ({ id, bid_id: BID, buyerXonly: XONLY, status: 'open', expiry: 2_000_000_000, amount: String(amount), priceSats, ...over });
const realFetch = globalThis.fetch;
const serve = (offers) => { globalThis.fetch = async (url) => { if (/\/bound-offers\?/.test(String(url))) return { ok: true, json: async () => ({ offers }) }; throw new Error('unexpected fetch ' + url); }; };
function mockDapp(take = (o) => ({ revealTxid: 'ee'.repeat(32), buyerNote: { txid: 'ee'.repeat(32), amount: BigInt(o.amount) } })) {
  const calls = { takes: [], sweeps: [], claims: 0 };
  return { calls, dapp: {
    wallet: { priv: null, pub: null },
    async getUtxos() { return [{ value: 1_000_000, status: { confirmed: true } }]; },
    async takeBoundOffer({ offer: o, bidPriv }) { calls.takes.push({ id: o.id, bidPriv }); return take(o); },
    async claimAxferIntent() { calls.claims++; },
    async sweepWatchtowerBidWallet(priv, assets) { calls.sweeps.push(assets); return { swept: 1 }; },
    invalidateHoldingsCache() {},
  } };
}
const ctxOf = (dapp, over = {}) => ({ dapp, kind: 'bound', bidId: BID, workerBase: 'https://w', network: 'signet', assetId: 'ab'.repeat(32), decimals: 0, priv: new Uint8Array(32).fill(1),
  pub: new Uint8Array(33).fill(2), pubHex: KEY, h160: 'cd'.repeat(20), maxUnitPriceSats: 50, maxTotalFillBase: 1000n, claimFulfilTimeoutSec: 1, minBidWalletSats: 1000, dryRun: false, log: () => {}, ...over });

// discovery: only this bid's open, unexpired offers to this key
{
  serve([offer('o1', 100, 5000), offer('o2', 100, 5000, { bid_id: 'ff'.repeat(16) }), offer('o3', 100, 5000, { buyerXonly: '22'.repeat(32) }), offer('o4', 100, 5000, { expiry: 1 }), offer('o5', 100, 5000, { status: 'filled' })]);
  const got = await fetchCandidateBoundOffers(ctxOf(mockDapp().dapp));
  ok(got.length === 1 && got[0].id === 'o1', `only this bid's open offers to this bid key are candidates (${got.map((o) => o.id)})`);
}
// a fill: taken with the bid key, counted, recorded with its note; no claim of an atomic intent
{
  const { dapp, calls } = mockDapp();
  serve([offer('o1', 100, 5000)]);
  const state = { filledBase: 0n, processed: {} }, persisted = [];
  const r = await runTick(ctxOf(dapp), state, { persist: (s) => persisted.push(JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) });
  ok(r.fills === 1 && calls.takes.length === 1 && calls.takes[0].id === 'o1' && calls.claims === 0, 'one offer within the ceiling is taken with the bid key, nothing claimed');
  ok(state.filledBase === 100n && state.processed.o1 && state.processed.o1.note && state.processed.o1.note.amount === '100' && persisted.length === 1, 'the fill is counted and recorded with the bought note');
  const again = await runTick(ctxOf(dapp), state);
  ok(again.fills === 0 && calls.takes.length === 1, 'a processed offer is not taken twice');
}
// the policy: above the unit-price ceiling, or past the cap, an offer is skipped
{
  const { dapp, calls } = mockDapp();
  serve([offer('hi', 100, 5001), offer('big', 2000, 50000)]);
  const r = await runTick(ctxOf(dapp), { filledBase: 0n, processed: {} });
  ok(r.fills === 0 && calls.takes.length === 0, 'an offer above the ceiling (50.01 sats a unit) or past the fill cap is not taken');
}
// a take whose checks fail is refused for good; one whose broadcast failed is tried again
{
  const { dapp, calls } = mockDapp((o) => { throw new Error(o.id === 'bad' ? 'bound-swap: the offer does not check: kernel' : 'broadcast failed: 503'); });
  serve([offer('bad', 100, 5000), offer('net', 100, 5000)]);
  const state = { filledBase: 0n, processed: {} };
  await runTick(ctxOf(dapp), state);
  ok(state.processed.bad && state.processed.bad.refused === true && !state.processed.net, 'an offer that does not check is refused and remembered; a failed broadcast is left to try again');
  await runTick(ctxOf(dapp), state);
  ok(calls.takes.filter((t) => t.id === 'bad').length === 1 && calls.takes.filter((t) => t.id === 'net').length === 2, 'the refused offer is not taken again, the other is retried');
}
// dry run takes nothing
{
  const { dapp, calls } = mockDapp();
  serve([offer('o1', 100, 5000)]);
  await runTick(ctxOf(dapp, { dryRun: true }), { filledBase: 0n, processed: {} });
  ok(calls.takes.length === 0, 'a dry run takes nothing');
}
// the return: sats only for a bound bid (its note is at the bid key's Taproot address); the asset too for an atomic-intent bid
{
  const a = mockDapp();
  a.dapp.getUtxos = async () => [];
  await returnToOwner(ctxOf(a.dapp, { ownerPub: new Uint8Array(33).fill(3), address: 'x' }));
  const b = mockDapp(), c = mockDapp();
  let n = 0; b.dapp.getUtxos = async () => (n++ ? [] : [{ value: 5000, status: { confirmed: true } }]);
  let m = 0; c.dapp.getUtxos = async () => (m++ ? [] : [{ value: 5000, status: { confirmed: true } }]);
  await returnToOwner(ctxOf(b.dapp, { ownerPub: new Uint8Array(33).fill(3), address: 'x' }));
  await returnToOwner(ctxOf(c.dapp, { kind: 'axfer', ownerPub: new Uint8Array(33).fill(3), address: 'x' }));
  ok(b.calls.sweeps.length === 1 && b.calls.sweeps[0].length === 0 && c.calls.sweeps[0].length === 1, 'a bound bid\'s return sweeps sats only; an atomic-intent bid\'s sweeps its asset too');
}
globalThis.fetch = realFetch;
console.log(`\n${pass} watchtower-bound checks passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
