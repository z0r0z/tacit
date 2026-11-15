// dapp/bridge-out.js, what a bridge to Bitcoin is held to wherever it is started: the relay's published floor taken when it is
// the higher, the limits in words, and the words for a proof that is behind and a Bitcoin address with no coin for the last step.
//   node tests/bridge-out.test.mjs
import assert from 'node:assert/strict';
import { OUT_ASSETS, makeOutFee, limitText, proofWarn, proofProblem, fundingText, onTheWay } from '../dapp/bridge-out.js';

assert.equal(OUT_ASSETS.tac.pool, 'cTAC'); assert.equal(OUT_ASSETS.teth.id.length, 66); assert.equal(OUT_ASSETS.tac.min, 2_000_000_000n);

// the fee: the pool's own quote, or the published floor when that is higher, kept five minutes
{
  let asks = 0, floor = '300';
  const t = { quoteOpFee: async (tk, op) => { assert.equal(op, 'bridgeburn'); return tk === 'cETH' ? 120n : 200n; } };
  const outFee = makeOutFee({ api: 'https://api.x', fetchImpl: async (url) => { asks++; assert.equal(url, 'https://api.x/confidential/quote?asset=cTAC'); return { ok: true, json: async () => ({ staticFloorUnits: floor }) }; } });
  assert.equal(await outFee(t, OUT_ASSETS.teth), 120n, 'an asset with no published floor: its own quote');
  assert.equal(asks, 0);
  assert.equal(await outFee(t, OUT_ASSETS.tac), 300n, 'the floor, when it is higher');
  floor = '100'; assert.equal(await outFee(t, OUT_ASSETS.tac), 300n); assert.equal(asks, 1, 'kept, not asked again');
  const down = makeOutFee({ api: 'x', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await down(t, OUT_ASSETS.tac), 200n, 'a floor that cannot be read: its own quote');
}
// the limits
const fmt = (v, max = 8) => `${Number(v) / 1e8}`;
const L = (o) => limitText({ units: 500n, fee: 10n, min: 100n, cap: 1000n, ticker: 'TAC', fmt, ...o });
assert.equal(L({}), null);
assert.match(L({ units: 50n }), /^Bridge at least .* TAC: below that the fees take too much of it\.$/);
assert.match(L({ units: 1001n }), /^One bridge carries at most .* TAC, what one note holds\. Bridge less, then again\.$/);
assert.match(L({ units: 10n, min: 0n }), /^Bridge more than .* TAC: the relay fee comes out of it\.$/);
assert.match(L({ units: 10n, min: 100n }), /at least/, 'the least is named before the fee');
// the proof
assert.match(proofWarn({ name: 'reflection-behind', detail: '300 Bitcoin blocks' }, 300), /300 Bitcoin blocks behind \(about 50 hours\)/);
assert.match(proofWarn({ name: 'coverage-behind' }, 0), /further behind than usual/); assert.equal(proofWarn({ name: 'funding' }, 0), '');
assert.match(proofProblem, /nothing was started/);
// the coin for the Bitcoin step
const btc = (s) => (s / 1e8).toFixed(8);
assert.match(fundingText({ pending: 0, haveSats: 0, needSats: 1882 }, btc), /has no free coin yet.*one coin of 1,882 sats/);
assert.match(fundingText({ pending: 0, haveSats: 1000, needSats: 1882 }, btc), /largest free coin .* holds 0\.00001000 BTC/);
assert.match(fundingText({ pending: 1, haveSats: 0, needSats: 1882 }, btc), /^A bridge under way takes a coin .* No other coin is free/);
assert.match(fundingText({ pending: 3, haveSats: 2000, needSats: 1882 }, btc), /^3 bridges under way take a coin each .* The next free coin holds 0\.00002000 BTC/);
// a bridge whose Bitcoin step is on Bitcoin is the note it made: counted there, not also on the way
{
  const rec = (claim, amount) => ({ source: { amount }, settle: claim ? { claimId: claim } : undefined });
  const A = '0x' + 'aa'.repeat(32), B = '0x' + 'bb'.repeat(32);
  const records = [rec(A, 100n), rec(B, 200n), rec(null, 50n)];
  assert.deepEqual(onTheWay(records, null).map((r) => r.source.amount), [100n, 200n, 50n], 'notes not read yet: every bridge is on the way');
  assert.deepEqual(onTheWay(records, []).map((r) => r.source.amount), [100n, 200n, 50n]);
  assert.deepEqual(onTheWay(records, [{ claimId: '0x' + 'AA'.repeat(32), amount: 100n }]).map((r) => r.source.amount), [200n, 50n], 'a bridge whose note is on Bitcoin leaves the way (any case)');
  assert.equal(onTheWay(records, [{ claimId: '' , amount: 1n }, {}]).length, 3, 'a note without a claim matches nothing, and neither does a record without one');
  assert.equal(onTheWay(records, [{ claimId: A, amount: null }, { claimId: B }]).length, 3, 'an output whose amount the key could not open is not the bridge’s note: the bridge stays on the way');
}
console.log('bridge-out: all checks passed');
