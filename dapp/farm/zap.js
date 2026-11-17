// ETH into a private farm, as the farm page does it (dapp/farm/): the share note is proved first, while nothing has left the wallet; one
// transaction from the wallet then adds the ETH to the pool, shields the share it mints and settles that proof (the router's
// zapETHIntoFarm); the relay then bonds the note to the farm. The legs are sized to mint exactly the share count the proof names
// (lp-zap.js), and the transaction is run as a call before the wallet is asked: exactly those shares, or nothing is sent.
// Whatever stops it after the transaction leaves a private share note in the key's balance, which `bondShare` farms later.
// The front page's Earn card has more ways in (a proof kept ready, a swap split with the Precision pool, your own prover, LP only);
// this is the one path a page with a wallet and a key needs. Everything it calls is the pool module's (confidential-pool-ux.js).
import { zapPlan, zapPlanFor, zapPlanExt, zapPlanExtFor, zapSettleCalldata } from '/lp-zap.js?cb=28b3b478';
import { relayedOrOwn } from '/farm-ops.js?cb=e70f2612';

export const PUBLIC_AMM = '0x00000000E36C7EC997CC59DCda9E03673B448119';
export const CETH = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
export const ZQUOTER = '0x000000bd2DB80567c23E353ca95a251c573cBf9B';
// What the one transaction takes at most (it swaps, adds, shields and verifies a proof), half again for the fee line and the balance check.
export const ZAP_GAS = 850000n;
const SLACK = 50n;                                    // the ETH legs may cost up to 1/50 more than quoted by the time the proof is made
const lc = (s) => String(s || '').toLowerCase(), strip = (h) => String(h).replace(/^0x/, '');
const wordAt = (hex, i) => BigInt('0x' + (strip(hex).slice(i * 64, (i + 1) * 64) || '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (m, extra = {}) => Object.assign(new Error(m), { said: true, ...extra });
export const declined = (e) => e?.code === 4001 || !!e?.userStopped || /user (rejected|denied)|rejected the request|denied transaction/i.test(String(e?.shortMessage || e?.message || e || ''));

// The pool's reserves, read from the pool contract with one call (pools(bytes32)): what a quote needs before the pool module is loaded.
export async function readReserves(call, pool, poolId) {
  const h = strip(await call({ to: pool, data: '0xb5217bb4' + strip(poolId).padStart(64, '0') }));
  if (h.length < 64 * 7 || wordAt(h, 0) === 0n) return null;
  return { assetA: '0x' + h.slice(64, 128), assetB: '0x' + h.slice(128, 192), reserveA: wordAt(h, 3), reserveB: wordAt(h, 4), feeBps: Number(wordAt(h, 5)), totalShares: wordAt(h, 6) };
}

// How the pool holds a coin: the token behind it, its decimals, and how many of the token's own units one pool unit is (assets(bytes32) on
// the pool). TAC and tETH are 18-decimal coins with a pool unit of 1e10; SPX has 8 decimals and a pool unit of 1. A registered row does not change.
const ROWS = new Map();
export async function assetRow(call, pool, assetId) {
  const id = lc(assetId);
  if (ROWS.has(id)) return ROWS.get(id);
  const h = strip(await call({ to: pool, data: '0x9fda5b66' + strip(id).padStart(64, '0') }));
  if (h.length < 64 * 6 || wordAt(h, 0) !== 1n || !(wordAt(h, 2) > 0n)) return null;
  const row = { underlying: '0x' + h.slice(88, 128), unitScale: wordAt(h, 2), poolMinted: wordAt(h, 4) === 1n, decimals: Number(wordAt(h, 5)) };
  ROWS.set(id, row);
  return row;
}

// What one of a token is worth in ETH on the open market, from the public pools' own reserves: zQuoter's best route (Uniswap, Sushi, zAMM)
// for a hundredth of an ETH, too small to move any of them. null when no route answers, or the answer is not for what was asked.
export async function publicRate({ rpc, token, decimals, probe = 10n ** 16n, now = Date.now() }) {
  const w = (x) => BigInt(x).toString(16).padStart(64, '0'), a = (x) => strip(x).toLowerCase().padStart(64, '0');
  const data = '0xe7798987' + a('0x1') + w(0) + a('0x0') + a(token) + w(probe) + w(100) + w(Math.floor(now / 1000) + 3600);
  let raw;
  try { raw = strip(await rpc('eth_call', [{ to: ZQUOTER, data, gas: '0x5F5E100' }, 'latest'])); } catch { return null; }
  if (raw.length < 7 * 64) return null;
  const out = wordAt(raw, 3);
  if (!(out > 0n) || wordAt(raw, 2) !== BigInt(probe) || wordAt(raw, 6) !== BigInt(probe) || !Number.isInteger(decimals)) return null;
  const rate = Number(probe) / 1e18 / (Number(out) / 10 ** decimals);
  return rate > 0 && Number.isFinite(rate) ? rate : null;
}

// The other coin of a tETH pool, and what one of it is worth in ETH at the market: TAC at the Precision pool's price, cUSD at a dollar,
// cBTC at bitcoin's price (Chainlink's, as the farms' APRs use them). null when the market is not known here: a token with a public
// market of its own (SPX) is priced by `publicRate`, which the page reads for it.
export const otherOf = (pair) => String(pair).split('/').find((k) => k !== 'cETH');
export function marketOf(pair, { tacEth = 0, ethUsd = 0, btcUsd = 0 } = {}) {
  const other = otherOf(pair), m = other === 'TAC' ? tacEth : other === 'cUSD' ? (ethUsd > 0 ? 1 / ethUsd : 0) : other === 'cBTC' ? (ethUsd > 0 && btcUsd > 0 ? btcUsd / ethUsd : 0) : 0;
  return m > 0 ? m : null;
}

// What `wei` of ETH becomes in this pool as its reserves stand: the plan (the swap, the legs, the shares), the swap's own price impact
// (of the half swapped), and what the deposit gives up against the market when the pool's price sits away from it (of the deposit). `cost`
// is what the deposit gives up, as a share of the deposit, the figure it is held to: the larger of the swap's impact over the part of the
// deposit it is taken on, and the price against the market. `checked` is false when no market price is known to check the pool's against.
// `res` is { reserveA, reserveB, totalShares, feeBps } with tETH as A. `unitB` and `decimals` are the other coin's pool unit and decimals
// (assetRow): the legs are in the token's own units, so a coin with a pool unit of 1 (SPX) is not sized as one with 1e10 (TAC).
export function zapMath({ res, wei, market = null, unitB = 10n ** 10n, decimals = 18 }) {
  const plan = zapPlan({ eth: wei, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, feeBps: BigInt(res.feeBps ?? 30), unitB });
  if (!plan) return null;
  const impact = plan.impact * 100, y = Number(plan.swapIn) / 1e18, got = Number(plan.out) / 10 ** decimals, dep = Number(wei) / 1e18;
  const against = market && y > 0 ? Math.max(0, (y - got * market) / dep * 100) : 0;
  return { plan, impact, against, cost: Math.max(dep > 0 ? impact * y / dep : 0, against), checked: market != null };
}

// A deposit priced for the form: the plan and its costs, what it earns a day (its shares against the shares bonded) and a year, the
// network fee, and whether the wallet covers both. `pool` is the farm program's entry; `reserves` reads the pool now; `asset(res)` reads the
// other coin as the pool holds it (assetRow): a page that passes it sizes the legs in that coin's own units and names its token, and one
// that cannot read it says so rather than guess. Without it the coin is taken as an 18-decimal one with a pool unit of 1e10, as TAC is.
// A thin pool moves a lot under the deposit's own swap, so where the coin trades outside (`outside(token)` gives a quote for that swap) the swap half is also priced there:
// that plan leaves the pool's price alone and the deposit goes in at its ratio (lp-zap.js zapPlanExt). It is the plan when it gives more shares per ETH by more than its extra gas.
const EXT_GAS = 140000n;
async function outsidePlan({ res, wei, m, unitB, decimals, market, gp, token, outside }) {
  const quote = token && outside ? outside(token) : null;
  const ext = quote ? await zapPlanExt({ eth: wei, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, unitB, quote }).catch(() => null) : null;
  if (!ext) return null;
  const per = (p) => Number(p.shares) / Number(p.value);
  if (m && !((per(ext) - per(m.plan)) / per(m.plan) * Number(wei) > Number(EXT_GAS * gp) * 1.5)) return null;
  const dep = Number(wei) / 1e18, against = market ? Math.max(0, (Number(ext.ethLeg) / 1e18 - (Number(ext.bLeg) / 10 ** decimals) * market) / dep * 100) : 0;
  return { plan: ext, impact: 0, against, cost: against, checked: market != null, outside: quote };
}
export async function zapQuote({ pool, wei, reserves, gasPrice = async () => 0n, balance = async () => null, market = null, tacEth = 0, live = true, asset = null, outside = null }) {
  const [res, gp, bal] = await Promise.all([reserves(), gasPrice().catch(() => 0n), balance().catch(() => null)]);
  if (!res || !(res.totalShares > 0n)) throw said('This pool is not open for liquidity yet.');
  if (lc(res.assetA) !== CETH) throw said('This pool reads differently from the farm program. Try again in a minute.');
  const row = asset ? await asset(res).catch(() => null) : null;
  if (asset && !row) throw said('This pool’s other coin could not be read. Try again in a minute.');
  const unitB = row ? row.unitScale : 10n ** 10n, decimals = row ? row.decimals : 18;
  const m0 = zapMath({ res, wei, market, unitB, decimals });
  const m = (await outsidePlan({ res, wei, m: m0, unitB, decimals, market, gp, token: row?.underlying || null, outside })) || m0;
  if (!m) return { pid: pool.pid, wei, plan: null, at: Date.now() };
  const bonded = BigInt(pool.totalShares || 0), day = live ? Number(pool.tacPerDayForPool) * Number(m.plan.shares) / Number(bonded + m.plan.shares) : 0;
  const eth = Number(m.plan.value) / 1e18, fee = ZAP_GAS * gp * 3n / 2n;
  return { pid: pool.pid, wei, ...m, res, gp, fee, bal, day, apr: day > 0 && tacEth > 0 && eth > 0 ? day * 365 * tacEth / eth * 100 : null,
    over: bal != null && m.plan.value + fee > bal, unitB, decimals, token: row?.underlying || null, at: Date.now() };
}

// The token behind a pool coin: the deployment's own list first, else what the pool itself says (a token registered since, as SPX was).
const tokenOf = (t, assetId, fallback = null) => {
  const a = (t.cfg?.assets || []).find((x) => lc(x.assetId) === lc(assetId)), u = a?.underlying || fallback;
  if (!u || /^0x0{40}$/.test(lc(u))) throw said('This pool’s coin has no token on Ethereum here, so nothing was sent.');
  return u;
};
const routerOf = (t) => { if (!t.cfg?.router || !t.cfg?.pool) throw said('The pool is not set up on this network.'); return t.cfg.router; };
// The key's notes, held and spent (the whole read, not the quick one). An index one of them used is not taken for a new share; a
// share among the held ones that is in no farm is `looseOf`'s.
const SCAN = { spent: true, bridge: false, cbtc: false };
export const readNotes = async (t, priv) => { const s = await t.balance(priv(), SCAN); return { notes: s?.notes || [], spentNotes: s?.spentNotes || [] }; };
export const ownedNotes = async (t, priv) => { const s = await readNotes(t, priv); return [...s.notes, ...s.spentNotes]; };
const chainTime = async (rpc) => Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));

// Step 1, with nothing sent: the share note for exactly `q.plan.shares`, and the relay's proof of it. `q` is a zapQuote; a pool that has
// moved since it was made is said, not proved. `owned()` is the key's notes (a page that has read them passes its own read), and
// `wait(kind)` what a wait on the relay carries ('prove' here, 'bond' for the farm entry): a page's own time limit and its record of
// the job. Returns what `zapSend` takes; an index taken for a proof that did not come is given back.
export async function zapProve({ t, priv, pool, q, wait = () => ({}), used = [], owned = () => ownedNotes(t, priv), say = () => {} }) {
  say('prepare');
  const res = await t.poolReserves(pool.poolId), now = res && !q.plan.ext && zapMath({ res, wei: q.wei, unitB: q.unitB, decimals: q.decimals });
  if (!q.plan.ext && (!now || now.plan.shares !== q.plan.shares || now.plan.value !== q.plan.value)) throw said('The pool moved since this was quoted. Check the new figures and press again; nothing was sent.', { moved: true });
  const rs = await t.relay.state().catch(() => null);
  if (rs && !rs.proving) throw said('Tacit’s prover is not taking proofs right now. Nothing was sent.', { code: 'relay_paused', front: true });
  const index = t.nextShareIndex({ walletPriv: priv(), poolId: pool.poolId, owned: await owned(), used });
  const built = t.buildShareWrap({ walletPriv: priv(), poolId: pool.poolId, shares: q.plan.shares, index });
  say('proving');
  try {
    const proven = await t.relay.prove({ type: 'wrap', op: built.wrapOp, leaves: [built.leaf], outputs: built.outputs, memos: built.memos, ephRand: built.ephRand },
      { viaRelay: true, timeoutMs: 5 * 60e3, ...wait('prove') });
    if (!proven?.publicValues || !proven.proof) throw new Error(`prove failed: the prover returned no proof (${proven?.status || 'no status'})`);
    if (!t.wrapProofFits(built, proven)) throw said('The proof that came back is not for this share, so nothing was sent. Press again.');
    return { pid: pool.pid, poolId: pool.poolId, wei: q.wei, shares: q.plan.shares, index, built, unitB: q.unitB, token: q.token, ext: q.plan.ext ? q.plan : null, outside: q.outside || null, proven: { ...proven, memos: proven.memos || built.memos } };
  } catch (e) {
    try { t.releaseShareIndex({ walletPriv: priv(), poolId: pool.poolId, index }); } catch { /* the index is skipped, which costs nothing */ }
    throw e;
  }
}

// Step 2, the one transaction: the legs sized again for the proved share count at the reserves now, the call run first (it must mint
// exactly those shares), then sent from the wallet and waited for. Errors before the wallet is asked carry `ready` (the proof, good for
// another press); one after it was sent carries `sent`.
export async function zapSend({ t, rpc, wallet, from, pool, ready, say = () => {} }) {
  const router = routerOf(t), max = ready.wei + ready.wei / SLACK;
  say('check');
  const res = await t.poolReserves(pool.poolId);
  let plan = null, swapData = null;
  if (ready.ext) {
    // the outside swap is asked for again at its size: its floor must still bring the token leg the proof's legs need
    const fresh = res && ready.outside ? await ready.outside(ready.ext.swapIn).catch(() => null) : null;
    plan = fresh ? zapPlanExtFor({ shares: ready.shares, prev: ready.ext, q: fresh, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, unitB: ready.unitB, maxEth: max }) : null;
    swapData = plan?.callData || null;
  } else plan = res && zapPlanFor({ shares: ready.shares, ra: res.reserveA, rb: res.reserveB, total: res.totalShares, feeBps: BigInt(res.feeBps ?? 30), unitB: ready.unitB, maxEth: max, settles: true });      // sent with its proof in the same transaction: a mint of any other count reverts it (lp-zap.js)
  if (!plan && await consumed(rpc, t, ready.built)) throw said('This share was already made private by an earlier press. It is in your private balance.', { already: true });
  if (!plan) throw said('The pool moved while your share was proved: this many shares now costs more than you entered. Nothing was sent; press again for a new quote.', { moved: true, stale: true });
  const [gp, bal, time] = await Promise.all([rpc('eth_gasPrice', []).then(BigInt).catch(() => 0n), rpc('eth_getBalance', [from, 'latest']).then(BigInt).catch(() => null), chainTime(rpc)]);
  if (bal != null && plan.value + ZAP_GAS * gp > bal) throw said('This wallet holds too little ETH for the deposit and its network fee. Nothing was sent.', { ready });
  const data = zapSettleCalldata({ plan, router, amm: PUBLIC_AMM, tokenB: tokenOf(t, res.assetB, ready.token), assetA: res.assetA, assetB: res.assetB, feeBps: Number(res.feeBps ?? 30),
    deadline: BigInt(time + 1200), commit: ready.built.commit, swapData, publicValues: ready.proven.publicValues, proof: ready.proven.proof, memos: ready.proven.memos });
  const value = '0x' + plan.value.toString(16);
  let sim;
  try { sim = await rpc('eth_call', [{ from, to: router, data, value }, 'latest']); }
  catch (e) {
    if (await consumed(rpc, t, ready.built)) throw said('This share was already made private by an earlier press. It is in your private balance.', { already: true });
    throw said(e?.revert ? 'The deposit would not go through as the pool stands, so nothing was sent. Press again for a new quote.' : 'The deposit could not be checked, so nothing was sent. Try again in a moment.', { ready, stale: !!e?.revert });
  }
  if (wordAt(sim, 0) !== ready.shares) throw said('The deposit would not mint exactly the share proved, so nothing was sent. Press again for a new quote.', { stale: true });
  say('confirm', plan.value);
  let hash;
  try { hash = await wallet.sendTx({ to: router, data, value: plan.value, from }); }
  catch (e) { throw Object.assign(e, { ready }); }
  say('sent', hash);
  let rc;
  try { rc = await wallet.receipt(hash); } catch (e) { throw Object.assign(e, { sent: hash }); }
  if (rc.status !== '0x1') throw said(`The transaction failed (${hash.slice(0, 10)}…). Nothing was lost but its network fee. Your share’s proof is kept: press again to send it.`, { reverted: true, ready });
  const mined = rc.transactionHash || hash;                                       // a sped-up deposit went in under another hash: that one goes to the relay
  if (ready.proven.jobId) Promise.resolve(t.relay.landed?.(ready.proven.jobId, mined)).catch(() => {});
  return { hash, value: plan.value };                                             // (the page keeps its journal entry under the hash it sent)
}
const consumed = async (rpc, t, built) => { try { return wordAt(await rpc('eth_call', [{ to: t.cfg.pool, data: '0x7da9874f' + strip(built.depositId).padStart(64, '0') }, 'latest']), 0) === 2n; } catch { return false; } };

// The share note a zap made, once the key's balance shows it (a node a block behind takes a few reads).
export async function shareNote({ t, priv, built, tries = 10, every = 4000 }) {
  const leaf = lc(built.leaf);
  for (let i = 0; i < tries; i++) {
    const n = ((await t.balance(priv(), SCAN).catch(() => null))?.notes || []).find((x) => lc(x.leaf) === leaf);
    if (n) return n;
    if (i < tries - 1) await sleep(every);
  }
  return null;
}

// Step 3: a share note bonded to its farm by the relay (one proof, about a minute). The note stays the key's until it lands.
// The relay can prove the entry and send it a little later (it answers "open": proved, waiting to be sent), or still hold it in its
// queue when the wait runs out. Neither is a failure: the job is followed until it lands (`say('waiting', jobId)` once), and only a job
// that fails, or one followed for half an hour, ends it.
// When the relay will prove the entry but not send it for free just now, `own` (farm-ops.js walletSettle) sends it from the wallet:
// `say('own', error)` first. So does an entry the relay proved and has not sent `ownAfterMs` later (its sending wallet may be short):
// the wallet sends that same proof.
export const inLine = (e) => e?.code === 'open' || !!e?.open || /settle timed out|status polling for job/i.test(String(e?.message || ''));
const sendable = (o) => (o && o.publicValues && o.proof && Array.isArray(o.memos) ? o : null);
export async function bondShare({ t, priv, note, wait = () => ({}), say = () => {}, own = null, ownAfterMs = 120e3 }) {
  const w = wait('bond');
  let job = null;
  const go = (selfSettle) => t.farmBond({ walletPriv: priv(), lpNote: note, ...(selfSettle ? { selfSettle } : {}), waitOpts: { timeoutMs: 20 * 60e3, ...w, onJob: (id, type) => { job = id; w.onJob?.(id, type); } } });
  try { return await relayedOrOwn(go, own, (e) => say('own', e)); }
  catch (e) {
    const id = e?.open?.jobId || job;
    if (!id || !inLine(e)) throw e;
    say('waiting', id);
    const follow = (timeoutMs) => t.relay.waitForSettle(id, { openGraceMs: Infinity, timeoutMs, intervalMs: 5000, onUpdate: w.onUpdate });
    if (!own) return follow(30 * 60e3);
    try { return await follow(ownAfterMs); }
    catch (e2) {
      const o = sendable(e2?.open) || sendable(e?.open);
      if (!o || !inLine(e2)) throw e2;
      say('own', { code: 'open' });
      return { jobId: id, ...(await own({ jobId: id, publicValues: o.publicValues, proof: o.proof, memos: o.memos })) };
    }
  }
}

// The whole of it. `say(step, detail)` names each step as it starts: prepare, proving, check, confirm, sent, landed, bonding, done.
// `ready` is a proof made by an earlier press that was not sent (the same pool and amount): it is sent without proving again, for the
// share count it names. A failure once the transaction has landed carries `share` (true: the ETH is in the pool as a private share
// note; with `note` when the balance already shows it), so the page offers to farm it and says nothing was lost.
export async function zapRun({ t, rpc, wallet, from, priv, pool, q, ready = null, wait, used, owned, say = () => {}, noteTries, noteEvery, own = null }) {
  const r = ready && ready.pid === pool.pid && ready.wei === q.wei ? ready : await zapProve({ t, priv, pool, q, wait, used, owned, say });
  const { hash } = await zapSend({ t, rpc, wallet, from, pool, ready: r, say });
  say('landed', hash);
  let note = null;
  try {
    note = await shareNote({ t, priv, built: r.built, tries: noteTries, every: noteEvery });
    if (!note) throw said('Your share is private, and this page does not see it in your balance yet. Press Farm it in a minute.');
    say('bonding', hash);
    const bond = await bondShare({ t, priv, note, wait, say, own });
    say('done', bond?.txHash || hash);
    return { hash, shares: r.shares, bond };
  } catch (e) { throw Object.assign(e, { share: true, note, hash }); }
}

// The key's share notes that are in no farm: a zap whose bond did not finish, or liquidity added without a farm.
export const looseOf = (notes, pools) => (pools || []).flatMap((pool) => (notes || []).filter((n) => pool.lpAsset && lc(n.asset) === lc(pool.lpAsset)).map((note) => ({ pool, note })));
export const looseShares = async ({ t, priv, pools }) => looseOf((await readNotes(t, priv)).notes, pools);
