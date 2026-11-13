// dapp/farm/zap.js, the farm page's ETH deposit into a private farm, over a stand-in pool module and wallet and the real pool math
// (dapp/lp-zap.js): what a deposit is priced at (the swap's own impact, and what a pool priced away from the market takes), and the
// order and the refusals of its steps. Nothing is asked of the wallet unless a proof for exactly the quoted share count is in hand and
// the transaction, run as a call, mints exactly that count; an index taken for a proof that did not come is given back; a proof whose
// transaction was not sent is kept for the next press; and a failure after the transaction landed says the share is the key's.
//   node tests/farm-zap.test.mjs
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));
import assert from 'node:assert/strict';

const { readReserves, marketOf, otherOf, zapMath, zapQuote, zapProve, zapSend, zapRun, shareNote, bondShare, looseOf, declined, ZAP_GAS, PUBLIC_AMM } = await import('../dapp/farm/zap.js');
const { zapPlan, zapPlanFor } = await import('../dapp/lp-zap.js');

const W = (v) => BigInt(v).toString(16).padStart(64, '0'), E18 = 10n ** 18n;
const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', A_TAC = '0x' + 'f0'.repeat(32), A_USD = '0x' + '8f'.repeat(32);
const TAC = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279', ROUTER = '0x000000005dA3E3B73726af3c774Deeb9472D4992', POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const FROM = '0x' + 'f1'.repeat(20), WEI = E18 / 10n;
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
const fails = async (p, check, m) => { let e = null; try { await p; } catch (x) { e = x; } assert.ok(e, `${m}: it should have stopped`); check(e); n++; return e; };

// ── what a deposit is priced at ──
const RES = { assetA: CETH, assetB: A_TAC, reserveA: 10n ** 9n, reserveB: 10n ** 13n, feeBps: 30, totalShares: 10n ** 11n };        // 10 tETH and 100,000 TAC: 0.0001 ETH a TAC
{
  eq(otherOf('TAC/cETH'), 'TAC'); eq(otherOf('cETH/cUSD'), 'cUSD');
  eq(marketOf('TAC/cETH', { tacEth: 0.0001 }), 0.0001, 'TAC at the Precision pool’s price');
  eq(marketOf('cETH/cUSD', { ethUsd: 2400 }), 1 / 2400, 'cUSD at a dollar');
  eq(marketOf('cETH/cBTC', { ethUsd: 2400, btcUsd: 60000 }), 25, 'cBTC at bitcoin’s price');
  eq(marketOf('cETH/cUSD', {}), null, 'no price: no market');
  eq(marketOf('cETH/cNEW', { ethUsd: 2400 }), null, 'a coin with no price here');

  const m = zapMath({ res: RES, wei: WEI, market: 0.0001 }), plan = zapPlan({ eth: WEI, ra: RES.reserveA, rb: RES.reserveB, total: RES.totalShares, feeBps: 30n });
  eq(m.plan.shares, plan.shares, 'the plan is lp-zap.js’s');
  ok(m.impact > 0.45 && m.impact < 0.55, `0.1 ETH into 10 tETH a side moves the price half a percent (${m.impact.toFixed(3)}%)`);
  ok(m.against < 0.5, `a pool at the market’s price takes little more than its fee from the half swapped (${m.against.toFixed(3)}% of the deposit)`);
  eq(m.cost, Math.max(m.impact, m.against));
  // the same pool with TAC worth a third less at the market: the half of the deposit that buys TAC here overpays by a third
  const dear = zapMath({ res: RES, wei: WEI, market: 0.0001 * 2 / 3 });
  ok(dear.against > 16 && dear.against < 17.5 && dear.cost === dear.against, `a pool that prices the other coin half again over the market takes a sixth of the deposit (${dear.against.toFixed(2)}%)`);
  eq(zapMath({ res: RES, wei: WEI, market: 0.0002 }).against, 0, 'a pool that prices it under the market takes nothing more');
  eq(zapMath({ res: RES, wei: WEI }).against, 0, 'with no market known only the swap’s own impact is said');
  eq(zapMath({ res: RES, wei: 10n ** 10n }), null, 'too little to make a share');
}
{
  const word = '0x' + W(1) + CETH.slice(2) + A_TAC.slice(2) + W(RES.reserveA) + W(RES.reserveB) + W(30) + W(RES.totalShares), asked = [];
  const r = await readReserves(async (c) => { asked.push(c); return word; }, POOL, '0x' + '01'.repeat(32));
  eq(r, RES, 'the pool’s reserves, read from the pool contract');
  eq(asked, [{ to: POOL, data: '0xb5217bb4' + '01'.repeat(32) }], 'with one call, pools(bytes32)');
  eq(await readReserves(async () => '0x' + W(0).repeat(7), POOL, '0x' + '02'.repeat(32)), null, 'a pool that was never opened');
}
const pool = { pid: 0, pair: 'TAC/cETH', poolId: '0x' + '01'.repeat(32), lpAsset: '0x' + 'a1'.repeat(32), totalShares: '90000000000', tacPerDayForPool: '500', lockSeconds: 0, feeBps: 30 };
{
  const q = await zapQuote({ pool, wei: WEI, reserves: async () => RES, gasPrice: async () => 10n ** 9n, balance: async () => 5n * E18, market: 0.0001, tacEth: 0.0001 });
  const day = 500 * Number(q.plan.shares) / (90000000000 + Number(q.plan.shares));
  ok(Math.abs(q.day - day) < 1e-9 && q.fee === ZAP_GAS * 10n ** 9n * 3n / 2n && !q.over, `a deposit earns its shares’ part of the day’s TAC (${q.day.toFixed(3)} a day) and the fee is the transaction’s gas, half again`);
  ok(Math.abs(q.apr - day * 365 * 0.0001 / (Number(q.plan.value) / 1e18) * 100) < 1e-6, `and its APR is that against the ETH put in (${q.apr.toFixed(1)}%)`);
  eq((await zapQuote({ pool, wei: WEI, reserves: async () => RES, balance: async () => q.plan.value + q.fee - 1n, gasPrice: async () => 10n ** 9n })).over, true, 'a wallet a wei short of the deposit and its fee is over');
  eq((await zapQuote({ pool, wei: WEI, reserves: async () => RES, live: false, tacEth: 0.0001 })).day, 0, 'between reward periods nothing streams');
  eq((await zapQuote({ pool, wei: 10n ** 10n, reserves: async () => RES })).plan, null, 'too small for a share: no plan');
  await fails(zapQuote({ pool, wei: WEI, reserves: async () => null }), (e) => ok(/not open for liquidity/.test(e.message) && e.said), 'a pool not opened');
  await fails(zapQuote({ pool, wei: WEI, reserves: async () => ({ ...RES, assetA: A_TAC }) }), (e) => ok(/reads differently/.test(e.message)), 'a pool whose first coin is not tETH');
}

// ── the steps ──
const quote = () => zapQuote({ pool, wei: WEI, reserves: async () => RES, gasPrice: async () => 10n ** 9n, balance: async () => 5n * E18, market: 0.0001, tacEth: 0.0001 });
function world(over = {}) {
  const log = [], st = { res: RES, proving: true, bal: 5n * E18, time: 1_800_000_000, receipt: { status: '0x1' }, notes: [], ...over };
  const built = { leaf: '0x' + 'ee'.repeat(32), depositId: '0x' + 'dd'.repeat(32), commit: '0x' + 'cc'.repeat(32), wrapOp: { v: 1 }, outputs: ['o'], memos: ['0x01'], ephRand: '0x02' };
  const t = {
    cfg: { router: ROUTER, pool: POOL, assets: [{ assetId: A_TAC, underlying: TAC }, { assetId: A_USD, underlying: null }] },
    poolReserves: async () => st.res,
    relay: {
      state: async () => (st.noState ? null : { state: st.proving ? 'ok' : 'paused', proving: st.proving }),
      prove: async (spec, w) => { log.push(['prove', spec.type, w.viaRelay, w.timeoutMs]); if (st.proveErr) throw st.proveErr; return st.proven ?? { status: 'proven', jobId: 'job1', publicValues: '0x' + '11'.repeat(40), proof: '0x' + '0b'.repeat(8) }; },
      landed: async (id, hash) => { log.push(['landed', id, hash]); },
    },
    nextShareIndex: (a) => { log.push(['index', a.owned.length, a.used.join()]); return 4; },
    releaseShareIndex: (a) => { log.push(['release', a.index]); },
    buildShareWrap: (a) => { log.push(['build', a.shares, a.index]); return { ...built, index: a.index }; },
    wrapProofFits: () => st.fits !== false,
    balance: async () => { log.push(['balance']); return { notes: st.notes, spentNotes: [{ asset: 'x', owner: 'y' }] }; },
    farmBond: async (a) => { log.push(['bond', a.lpNote.leaf, a.waitOpts.timeoutMs]); if (st.bondErr) throw st.bondErr; return { jobId: 'job2', txHash: '0x' + '22'.repeat(32) }; },
  };
  const rpc = async (method, params) => {
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_getBalance') return '0x' + st.bal.toString(16);
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + st.time.toString(16) };
    if (method === 'eth_call') {
      const c = params[0];
      if (c.to === POOL) return '0x' + W(st.status ?? 0);
      log.push(['call', c.to, c.from, BigInt(c.value)]);
      if (st.simErr) throw st.simErr;
      return '0x' + W(st.simShares ?? BigInt('0x' + c.data.slice(10 + 4 * 64, 10 + 5 * 64)));
    }
    throw new Error(method);
  };
  const wallet = {
    sendTx: async (tx) => { log.push(['send', tx.to, tx.from, tx.value, tx.data]); if (st.sendErr) throw st.sendErr; return '0x' + 'ab'.repeat(32); },
    receipt: async (h) => { log.push(['receipt', h]); if (st.receiptErr) throw st.receiptErr; return st.receipt; },
  };
  const priv = () => new Uint8Array(32).fill(7), said = [];
  return { t, rpc, wallet, priv, log, st, built, said, say: (k, d) => said.push(d === undefined ? k : `${k}:${typeof d === 'bigint' ? d : String(d).slice(0, 10)}`), names: () => log.map((x) => x[0]) };
}

// step 1: the proof, with nothing sent
{
  const q = await quote(), w = world();
  const ready = await zapProve({ t: w.t, priv: w.priv, pool, q, used: [2], say: w.say });
  eq(w.names(), ['balance', 'index', 'build', 'prove'], 'the key’s notes are read, an index taken, the note built, the proof asked for');
  eq(w.log[1], ['index', 1, '2'], 'the index is chosen against the notes held and spent, and the ones named as used');
  eq(w.log[3], ['prove', 'wrap', true, 5 * 60e3], 'the proof is the relay’s, waited on for five minutes at most');
  eq([ready.pid, ready.poolId, ready.wei, ready.shares, ready.index, ready.proven.memos], [0, pool.poolId, WEI, q.plan.shares, 4, ['0x01']], 'what the next step takes: the pool, the amount, the share count, the proof with the note’s memos');
  eq(w.said, ['prepare', 'proving']);
  const own = world(), seen = [];
  await zapProve({ t: own.t, priv: own.priv, pool, q, owned: async () => [1, 2, 3], wait: (k) => { seen.push(k); return { timeoutMs: 123, onJob: () => {} }; } });
  eq([own.names(), own.log[0], own.log[2].slice(0, 4), seen], [['index', 'build', 'prove'], ['index', 3, ''], ['prove', 'wrap', true, 123], ['prove']], 'a page’s own read of the notes and its own wait are used');
}
{
  const q = await quote();
  const moved = world({ res: { ...RES, reserveA: RES.reserveA + 10n ** 7n } });
  await fails(zapProve({ t: moved.t, priv: moved.priv, pool, q }), (e) => ok(e.moved && e.said && /pool moved/.test(e.message)), 'a pool that moved since the quote');
  eq(moved.names(), [], 'is said before an index is taken or anything proved');
  const off = world({ proving: false });
  await fails(zapProve({ t: off.t, priv: off.priv, pool, q }), (e) => ok(e.code === 'relay_paused' && e.front && /Nothing was sent/.test(e.message)), 'a prover that is not proving');
  eq(off.names(), [], 'asks nothing');
  const blind = world({ noState: true });
  await zapProve({ t: blind.t, priv: blind.priv, pool, q });
  ok(blind.names().includes('prove'), 'a relay whose state could not be read is still asked');
  const bad = world({ proveErr: new Error('prove failed: the guest rejects this input') });
  await fails(zapProve({ t: bad.t, priv: bad.priv, pool, q }), (e) => ok(/prove failed/.test(e.message)), 'a proof that fails');
  eq(bad.names().slice(-2), ['prove', 'release'], 'gives its index back');
  const empty = world({ proven: { status: 'failed' } });
  await fails(zapProve({ t: empty.t, priv: empty.priv, pool, q }), (e) => ok(/no proof/.test(e.message)), 'an answer with no proof in it');
  eq(empty.log.at(-1), ['release', 4]);
  const wrong = world({ fits: false });
  await fails(zapProve({ t: wrong.t, priv: wrong.priv, pool, q }), (e) => ok(e.said && /not for this share/.test(e.message)), 'a proof for another note');
  eq(wrong.log.at(-1), ['release', 4], 'is not used, and its index goes back');
}

// step 2: the one transaction
const readyOf = async (w) => zapProve({ t: w.t, priv: w.priv, pool, q: await quote() });
{
  const w = world(), ready = await readyOf(w); w.log.length = 0;
  const out = await zapSend({ t: w.t, rpc: w.rpc, wallet: w.wallet, from: FROM, pool, ready, say: w.say });
  const plan = zapPlanFor({ shares: ready.shares, ra: RES.reserveA, rb: RES.reserveB, total: RES.totalShares, feeBps: 30n, maxEth: WEI + WEI / 50n });
  eq(w.names(), ['call', 'send', 'receipt', 'landed'], 'the transaction is run as a call, sent, waited for, and the relay told its proof was used');
  const [, to, from, value, data] = w.log[1], arg = (i) => data.slice(10 + i * 64, 74 + i * 64);
  eq([to, from, value, w.log[0][3]], [ROUTER, FROM, plan.value, plan.value], 'to the router, from the wallet, for the legs sized at the reserves now');
  ok(data.startsWith('0xc4294fac') && arg(0).endsWith(TAC.slice(2).toLowerCase()) && BigInt('0x' + arg(4)) === ready.shares && BigInt('0x' + arg(5)) === BigInt(w.st.time + 1200) && arg(6) === 'cc'.repeat(32), 'it names the pool’s token, exactly the shares proved, a deadline twenty minutes off by the chain’s clock, and the note’s commitment');
  ok(data.includes('11'.repeat(40)) && data.includes('0b'.repeat(8)) && data.toLowerCase().includes(PUBLIC_AMM.slice(2).toLowerCase()), 'and carries the proof and the swap through the public AMM');
  eq([out.hash, out.value, w.log[3]], ['0x' + 'ab'.repeat(32), plan.value, ['landed', 'job1', '0x' + 'ab'.repeat(32)]]);
  eq(w.said, ['check', `confirm:${plan.value}`, 'sent:0xabababab']);
}
{
  const dear = world(), r1 = await readyOf(dear); dear.log.length = 0;
  dear.st.res = { ...RES, reserveA: RES.reserveA * 11n / 10n };                    // the same shares now cost a tenth more ETH than was entered
  await fails(zapSend({ t: dear.t, rpc: dear.rpc, wallet: dear.wallet, from: FROM, pool, ready: r1 }), (e) => ok(e.moved && e.stale && !e.ready && /costs more than you entered/.test(e.message)), 'a pool that moved past what was entered');
  eq(dear.names(), [], 'asks nothing of the chain or the wallet');
  const near = world(), r2 = await readyOf(near); near.log.length = 0;
  near.st.res = { ...RES, reserveA: RES.reserveA + 10n ** 6n };                    // a move inside the two percent allowed
  const out = await zapSend({ t: near.t, rpc: near.rpc, wallet: near.wallet, from: FROM, pool, ready: r2 });
  ok(out.value > 0n && out.value <= WEI + WEI / 50n && BigInt('0x' + near.log[1][4].slice(10 + 4 * 64, 10 + 5 * 64)) === r2.shares, `a small move is sent for the same shares at the new cost (${Number(out.value) / 1e18} ETH for 0.1 entered)`);

  const poor = world({ bal: WEI }), r3 = await readyOf(poor); poor.log.length = 0;
  await fails(zapSend({ t: poor.t, rpc: poor.rpc, wallet: poor.wallet, from: FROM, pool, ready: r3 }), (e) => ok(e.ready === r3 && /too little ETH/.test(e.message)), 'a wallet short of the deposit and its fee');
  eq(poor.names(), [], 'is said before the wallet is asked, and the proof is kept');

  const rev = world({ simErr: Object.assign(new Error('execution reverted'), { revert: true }) }), r4 = await readyOf(rev); rev.log.length = 0;
  await fails(zapSend({ t: rev.t, rpc: rev.rpc, wallet: rev.wallet, from: FROM, pool, ready: r4 }), (e) => ok(e.stale && /would not go through/.test(e.message)), 'a call the router refuses');
  eq(rev.names(), ['call'], 'is not sent');
  const down = world({ simErr: new Error('fetch failed') }), r5 = await readyOf(down);
  await fails(zapSend({ t: down.t, rpc: down.rpc, wallet: down.wallet, from: FROM, pool, ready: r5 }), (e) => ok(!e.stale && e.ready === r5 && /could not be checked/.test(e.message)), 'a call that could not be made keeps the proof');
  const used = world({ simErr: Object.assign(new Error('execution reverted'), { revert: true }), status: 2 }), r6 = await readyOf(used);
  await fails(zapSend({ t: used.t, rpc: used.rpc, wallet: used.wallet, from: FROM, pool, ready: r6 }), (e) => ok(e.already && /already made private/.test(e.message)), 'a share an earlier press already made');
  const off = world({ simShares: 5n }), r7 = await readyOf(off); off.log.length = 0;
  await fails(zapSend({ t: off.t, rpc: off.rpc, wallet: off.wallet, from: FROM, pool, ready: r7 }), (e) => ok(e.stale && /exactly the share proved/.test(e.message)), 'a call that would mint another share count');
  eq(off.names(), ['call'], 'is not sent');
  const nocoin = world(), r8 = await readyOf(nocoin); nocoin.st.res = { ...RES, assetB: A_USD };
  await fails(zapSend({ t: nocoin.t, rpc: nocoin.rpc, wallet: nocoin.wallet, from: FROM, pool, ready: r8 }), (e) => ok(/no token on Ethereum/.test(e.message)), 'a pool whose coin has no token here');

  const no = world({ sendErr: Object.assign(new Error('User rejected the request.'), { code: 4001 }) }), r9 = await readyOf(no); no.log.length = 0;
  const e9 = await fails(zapSend({ t: no.t, rpc: no.rpc, wallet: no.wallet, from: FROM, pool, ready: r9 }), (e) => ok(declined(e) && e.ready === r9), 'a no in the wallet carries the proof for the next press');
  ok(!e9.sent && !no.names().includes('receipt'));
  const lost = world({ receiptErr: new Error('Sent, not confirmed yet.') }), r10 = await readyOf(lost);
  await fails(zapSend({ t: lost.t, rpc: lost.rpc, wallet: lost.wallet, from: FROM, pool, ready: r10 }), (e) => ok(e.sent === '0x' + 'ab'.repeat(32) && !e.ready), 'a transaction sent and not seen to land says so');
  const bad = world({ receipt: { status: '0x0' } }), r11 = await readyOf(bad);
  await fails(zapSend({ t: bad.t, rpc: bad.rpc, wallet: bad.wallet, from: FROM, pool, ready: r11 }), (e) => ok(e.reverted && /Nothing was lost but its network fee/.test(e.message)), 'a transaction that reverted');
  ok(!bad.names().includes('landed'));
}

// the whole of it
{
  const w = world(), q = await quote();
  w.t.balance = async () => { w.log.push(['balance']); return { notes: w.names().includes('receipt') ? [{ leaf: w.built.leaf.toUpperCase().replace('0X', '0x'), asset: pool.lpAsset, value: '1' }] : [], spentNotes: [] }; };
  const out = await zapRun({ t: w.t, rpc: w.rpc, wallet: w.wallet, from: FROM, priv: w.priv, pool, q, say: w.say, noteEvery: 1 });
  eq(w.names(), ['balance', 'index', 'build', 'prove', 'call', 'send', 'receipt', 'landed', 'balance', 'bond'], 'the proof, the transaction, the share read back, the farm entry');
  eq([out.shares, out.bond.jobId, w.log.at(-1).slice(0, 3)], [q.plan.shares, 'job2', ['bond', w.built.leaf.toUpperCase().replace('0X', '0x'), 20 * 60e3]], 'the note bonded is the one this deposit made, found by its leaf');
  eq(w.said.map((s) => s.split(':')[0]), ['prepare', 'proving', 'check', 'confirm', 'sent', 'landed', 'bonding', 'done']);

  const again = world(); again.st.notes = [{ leaf: again.built.leaf, asset: pool.lpAsset, value: '1' }];
  const kept = { pid: 0, poolId: pool.poolId, wei: WEI, shares: q.plan.shares, index: 9, built: again.built, proven: { publicValues: '0x' + '11'.repeat(40), proof: '0x0b', memos: [] } };
  await zapRun({ t: again.t, rpc: again.rpc, wallet: again.wallet, from: FROM, priv: again.priv, pool, q, ready: kept, noteEvery: 1 });
  ok(!again.names().includes('prove') && !again.names().includes('index') && again.names().includes('send'), 'a proof kept from a press that was not sent is sent without another');
  const other = world(); other.st.notes = [{ leaf: other.built.leaf, asset: pool.lpAsset, value: '1' }];
  await zapRun({ t: other.t, rpc: other.rpc, wallet: other.wallet, from: FROM, priv: other.priv, pool, q, ready: { ...kept, wei: WEI * 2n }, noteEvery: 1 });
  ok(other.names().includes('prove'), 'one kept for another amount is not');

  const held = world({ bondErr: Object.assign(new Error('relay 503'), { code: 'relay_held' }) }); held.st.notes = [{ leaf: held.built.leaf, asset: pool.lpAsset, value: '1' }];
  await fails(zapRun({ t: held.t, rpc: held.rpc, wallet: held.wallet, from: FROM, priv: held.priv, pool, q, noteEvery: 1 }), (e) => ok(e.share === true && e.note?.leaf === held.built.leaf && e.hash === '0x' + 'ab'.repeat(32) && e.code === 'relay_held'), 'a farm entry that fails after the transaction says the share is the key’s, and which note it is');
  const unseen = world();
  await fails(zapRun({ t: unseen.t, rpc: unseen.rpc, wallet: unseen.wallet, from: FROM, priv: unseen.priv, pool, q, noteTries: 2, noteEvery: 1 }), (e) => ok(e.share === true && e.note === null && /does not see it in your balance yet/.test(e.message)), 'a share the balance does not show yet is still said to be there');
  ok(!unseen.names().includes('bond'));
  const early = world({ sendErr: Object.assign(new Error('User rejected the request.'), { code: 4001 }) });
  await fails(zapRun({ t: early.t, rpc: early.rpc, wallet: early.wallet, from: FROM, priv: early.priv, pool, q }), (e) => ok(!e.share && e.ready), 'a failure before the transaction lands claims no share');
}
{
  const w = world(); w.st.notes = [{ leaf: '0xAA', asset: 'x' }];
  eq(await shareNote({ t: w.t, priv: w.priv, built: { leaf: '0xaa' }, tries: 1 }), { leaf: '0xAA', asset: 'x' });
  eq(await shareNote({ t: w.t, priv: w.priv, built: { leaf: '0xbb' }, tries: 2, every: 1 }), null);
  await bondShare({ t: w.t, priv: w.priv, note: { leaf: 'L' }, wait: (k) => ({ timeoutMs: 7, kind: k }) });
  eq(w.log.at(-1), ['bond', 'L', 7], 'a page’s own wait is the farm entry’s');
  const pools = [pool, { pid: 1, lpAsset: '0x' + 'A2'.repeat(32) }, { pid: 2 }];
  const notes = [{ asset: pool.lpAsset.toUpperCase().replace('0X', '0x'), leaf: 1 }, { asset: '0x' + 'a2'.repeat(32), leaf: 2 }, { asset: CETH, leaf: 3 }];
  eq(looseOf(notes, pools).map((x) => [x.pool.pid, x.note.leaf]), [[0, 1], [1, 2]], 'the share notes of the program’s pools, whatever the case of their ids');
  eq(looseOf(null, pools), []); eq(looseOf(notes, null), []);
}
console.log(`farm-zap: ${n} checks passed`);
