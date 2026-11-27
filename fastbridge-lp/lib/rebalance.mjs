// Keeps the provider's two sides in step without a hand on it: when most of what it holds is ETH (or BTC), the surplus is swapped to the other side on the venue that gives
// the best rate (THORChain or MAYAChain, both native-to-native, no wrapped tokens), and the proceeds land at the provider's own addresses. Off unless FB_LP_REBALANCE=on or dry.
//
//   FB_LP_REBALANCE=dry       look and say what it would do, send nothing (the way to start)
//   FB_LP_REBALANCE=on        do it
//   FB_LP_REBALANCE_BAND_BPS  how far a side's share may stray from half before anything is done (1500: acts outside 35 to 65 percent)
//   FB_LP_REBALANCE_MIN_ETH   the least it swaps (0.15): a swap pays a fixed outbound fee, so a small one costs a large share
//   FB_LP_REBALANCE_MAX_ETH   the most in one swap (0.3), FB_LP_REBALANCE_MAX_DAY_ETH the most in a UTC day (0.6)
//   FB_LP_REBALANCE_MAX_COST_BPS  the worst all-in cost against the market it accepts (120): a quote above it is not taken
//   FB_LP_REBALANCE_CONFIRM_LOOKS  how many looks in a row must call for the same swap before it is made (2): one odd reading of a balance is not acted on
//   FB_LP_REBALANCE_FRESH=on  ETH sold goes out of a fresh address of its own for each swap (unshielded to it, sent from it), so the venue never sees the pool account; FB_LP_REBALANCE_FRESH_GAS_ETH (0.0015) is what each keeps for gas
//   FB_LP_REBALANCE_VENUES    thorchain,mayachain (the quotes are compared; the best is taken)
//   FB_LP_REBALANCE_NODES_THORCHAIN / _MAYACHAIN   comma lists of the venue's public API bases; the vault address a swap pays is taken only when two or more of them agree on it
//
// What it touches: the provider's own ETH (public, unshielded first from its own private notes) and the destination is always one of its own addresses (the reverse Bitcoin
// address for ETH sold, the pool account for BTC sold). The venue's address is never taken from one source: it must be the same at two nodes, the chain not halted, and the
// quote's memo must carry the provider's own destination and nothing else. One swap at a time, each step kept before it is done, so a restart never repeats a send.
//
//   const r = makeRebalancer({ cfg, ...deps });  await r.step() -> { did }   r.info()   r.holding() (true while it holds public ETH for a swap: the shield leaves it be)

const UNIT = 10n ** 10n;                                       // wei in one pool unit
const DAY = 86400;
const VENUES = {
  thorchain: { prefix: 'thorchain', router: '0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146', nodes: ['https://gateway.liquify.com/chain/thorchain_api', 'https://thornode.ninerealms.com', 'https://thornode.thorchain.info'] },
  mayachain: { prefix: 'mayachain', router: '0xe3985E6b61b814F7Cdb188766562ba71b446B46d', nodes: ['https://mayanode.mayachain.info', 'https://mayanode.ninerealms.com'] },
};
const err = (e) => String((e && e.message) || e).slice(0, 200);
const ethText = (wei) => (Number(BigInt(wei) / UNIT) / 1e8).toFixed(4);

export function rebalanceConfig(env = process.env) {
  const sw = env.FB_LP_REBALANCE != null ? String(env.FB_LP_REBALANCE).trim().toLowerCase() : '';
  if (sw && !['on', 'off', 'dry'].includes(sw)) throw new Error(`FB_LP_REBALANCE must be on, dry or off (got "${env.FB_LP_REBALANCE}")`);
  const eth = (k, d) => {
    const t = String(env[k] ?? d).trim();
    if (!/^\d{1,4}(\.\d{1,8})?$/.test(t)) throw new Error(`${k} must be an amount of ETH (got "${env[k]}")`);
    const [w, f = ''] = t.split('.');
    return (BigInt(w) * 10n ** 8n + BigInt(f.padEnd(8, '0'))) * UNIT;
  };
  const int = (k, d, lo, hi) => { const n = Number(env[k] ?? d); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${k} must be a whole number from ${lo} to ${hi} (got "${env[k]}")`); return n; };
  const fr = env.FB_LP_REBALANCE_FRESH != null ? String(env.FB_LP_REBALANCE_FRESH).trim().toLowerCase() : '';
  if (fr && fr !== 'on' && fr !== 'off') throw new Error(`FB_LP_REBALANCE_FRESH must be on or off (got "${env.FB_LP_REBALANCE_FRESH}")`);
  const freshOn = fr === 'on';
  const venues = String(env.FB_LP_REBALANCE_VENUES ?? 'thorchain,mayachain').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const v of venues) if (!VENUES[v]) throw new Error(`FB_LP_REBALANCE_VENUES names an unknown venue "${v}"`);
  if (!venues.length) throw new Error('FB_LP_REBALANCE_VENUES names no venue');
  const nodes = {};
  for (const v of venues) {
    const l = String(env[`FB_LP_REBALANCE_NODES_${v.toUpperCase()}`] ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
    for (const u of l) if (!/^https:\/\//.test(u)) throw new Error(`FB_LP_REBALANCE_NODES_${v.toUpperCase()} takes https URLs (got "${u}")`);
    nodes[v] = l.length ? l : VENUES[v].nodes;
  }
  const c = {
    mode: sw || 'off', bandBps: int('FB_LP_REBALANCE_BAND_BPS', 1500, 200, 4000), targetBps: 5000,
    minSwapWei: eth('FB_LP_REBALANCE_MIN_ETH', '0.15'), maxSwapWei: eth('FB_LP_REBALANCE_MAX_ETH', '0.3'), maxPerDayWei: eth('FB_LP_REBALANCE_MAX_DAY_ETH', '0.6'),
    maxCostBps: int('FB_LP_REBALANCE_MAX_COST_BPS', 120, 10, 1000), slipBps: int('FB_LP_REBALANCE_SLIP_BPS', 100, 10, 1000), everySecs: int('FB_LP_REBALANCE_EVERY_SECS', 900, 60, 86400),
    confirmLooks: int('FB_LP_REBALANCE_CONFIRM_LOOKS', 2, 1, 5), fresh: freshOn, freshGasWei: eth('FB_LP_REBALANCE_FRESH_GAS_ETH', '0.0015'), venues, nodes,
  };
  if (c.minSwapWei > c.maxSwapWei) throw new Error('FB_LP_REBALANCE_MIN_ETH must not be over FB_LP_REBALANCE_MAX_ETH');
  if (c.maxSwapWei > c.maxPerDayWei) throw new Error('FB_LP_REBALANCE_MAX_ETH must not be over FB_LP_REBALANCE_MAX_DAY_ETH');
  return c;
}

// What to do from what is held. `ethWei`: the ETH it can sell (private notes and public ETH above its gas reserve); `sats`: all its Bitcoin; `ethPerBtc`: the market.
// -> null when the sides are in band, { dir, amountWei | amountSats, ... } for a swap, or { skip } when there is an imbalance that is not yet worth a swap
export function planRebalance({ ethWei, sats, ethPerBtc, cfg, movedTodayWei = 0n }) {
  if (!(ethPerBtc > 0)) return { skip: 'no market price' };
  const e = BigInt(ethWei), btcWei = BigInt(Math.round(Number(sats) * ethPerBtc * 1e10)), total = e + btcWei;
  if (total <= 0n) return null;
  const ethBps = Number((e * 10000n) / total);
  if (Math.abs(ethBps - cfg.targetBps) <= cfg.bandBps) return null;
  const left = cfg.maxPerDayWei > BigInt(movedTodayWei) ? cfg.maxPerDayWei - BigInt(movedTodayWei) : 0n;
  if (ethBps > cfg.targetBps) {
    const excess = e - (total * BigInt(cfg.targetBps)) / 10000n;
    let amountWei = [excess, cfg.maxSwapWei, left].reduce((a, b) => (a < b ? a : b));
    amountWei -= amountWei % UNIT;
    if (amountWei < cfg.minSwapWei) return { skip: left < cfg.minSwapWei ? 'the day\'s limit is used' : 'the surplus is under the least worth swapping', ethBps };
    return { dir: 'eth2btc', amountWei, ethBps };
  }
  const excessWei = btcWei - (total * BigInt(10000 - cfg.targetBps)) / 10000n;
  let valueWei = [excessWei, cfg.maxSwapWei, left].reduce((a, b) => (a < b ? a : b));
  if (valueWei < cfg.minSwapWei) return { skip: left < cfg.minSwapWei ? 'the day\'s limit is used' : 'the surplus is under the least worth swapping', ethBps };
  return { dir: 'btc2eth', amountSats: BigInt(Math.floor(Number(valueWei) / 1e10 / ethPerBtc)), valueWei, ethBps };
}

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const getJson = async (fetchImpl, url, ms = 15000) => {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(ms) });
  const j = await r.json().catch(() => null);
  if (!r.ok || j == null) throw Object.assign(new Error(`${new URL(url).host} ${r.status}`), { body: j });
  return j;
};
const memoOk = (memo, dest) => {
  const m = String(memo || '');
  const d = dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^=:(b|e|BTC\\.BTC|ETH\\.ETH|BTC/BTC|ETH/ETH):${d}(:[0-9]+(/[0-9]+){0,2})?$`).test(m);
};

// One venue's quote, with its vault address checked. `from`/`to`: 'ETH' or 'BTC'; `amount`: 1e8 units; `destination`: the provider's own address on the `to` chain.
export async function venueQuote({ venue, nodes, fetchImpl, from, to, amount, destination, slipBps, vaultHistory = null, now = () => Math.floor(Date.now() / 1000) }) {
  const p = VENUES[venue].prefix, asset = (c) => `${c}.${c}`;
  const failed = [];
  const books = (await Promise.all(nodes.map((n) => getJson(fetchImpl, `${n}/${p}/inbound_addresses`).then((l) => ({ n, l }), (e) => { failed.push(`${new URL(n).host}: ${err(e)}`); return null; })))).filter(Boolean);
  const seen = books.map(({ n, l }) => ({ n, ib: l.find((x) => x.chain === from), out: l.find((x) => x.chain === to) })).filter((x) => x.ib && x.out);
  // one node is enough only when Ethereum itself vouches for the vault (below); with none to do that, two must agree
  if (seen.length < (vaultHistory ? 1 : 2)) throw new Error(`${venue}: only ${seen.length} node(s) answered; two must agree on the vault address${failed.length ? ` (not answering: ${failed.join('; ')})` : ''}`);
  const ib = seen[0].ib;
  for (const s of seen) if (!same(s.ib.address, ib.address)) throw new Error(`${venue}: the nodes disagree on the ${from} vault address; nothing sent`);
  for (const s of seen) {
    for (const x of [s.ib, s.out]) if (x.halted || x.global_trading_paused || x.chain_trading_paused) throw new Error(`${venue}: trading on ${x.chain} is halted`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(ib.address) && from === 'ETH') throw new Error(`${venue}: the ETH vault address is malformed`);
  if (from === 'BTC' && !/^bc1q[02-9ac-hj-np-z]{38,58}$/.test(ib.address)) throw new Error(`${venue}: the BTC vault address is not a plain bech32 address; nothing sent`);
  if (vaultHistory) {
    // an address a node names is a vault only if the venue's own router (pinned here, not taken from the node) has paid out of it lately: a made-up or retired address has no such history
    if (from === 'ETH' && !same(ib.router, VENUES[venue].router)) throw new Error(`${venue}: the router the nodes name is not the one this provider knows; nothing sent`);
    const n = await vaultHistory({ chain: from, router: from === 'ETH' ? VENUES[venue].router : null, vault: ib.address });
    if (!(n >= 3)) throw new Error(`${venue}: the chain shows no recent outbound payments from that vault (${n}); nothing sent`);
  }
  const q = await getJson(fetchImpl, `${seen[0].n}/${p}/quote/swap?from_asset=${asset(from)}&to_asset=${asset(to)}&amount=${amount}&destination=${destination}&tolerance_bps=${slipBps}`);
  if (!same(q.inbound_address, ib.address)) throw new Error(`${venue}: the quote names a vault address the nodes do not agree on; nothing sent`);
  if (!memoOk(q.memo, destination)) throw new Error(`${venue}: the quote's memo is not a plain swap to the provider's own address; nothing sent`);
  const out = BigInt(q.expected_amount_out || 0);
  if (out <= 0n) throw new Error(`${venue}: the quote gives nothing out`);
  if (Number(q.expiry) < now() + 90) throw new Error(`${venue}: the quote is about to expire`);
  if (q.recommended_min_amount_in && BigInt(q.recommended_min_amount_in) > BigInt(amount)) throw new Error(`${venue}: under the least the venue takes`);
  return { venue, vault: ib.address, memo: q.memo, out, expiry: Number(q.expiry), node: seen[0].n, nodes: seen.length };
}

// the all-in cost of a quote against the market, in basis points (what is sold, valued in ETH, against what comes back)
export function costBps({ dir, amountWei, amountSats, out, ethPerBtc }) {
  if (dir === 'eth2btc') { const got = Number(out) * 1e10 * ethPerBtc; return Math.round((1 - got / Number(amountWei)) * 10000); }
  const gave = Number(amountSats) * 1e10 * ethPerBtc; return Math.round((1 - (Number(out) * 1e10) / gave) * 10000);
}

export async function bestQuote({ cfg, fetchImpl, dir, amount1e8, destination, ethPerBtc, amountWei, amountSats, vaultHistory = null, log = () => {} }) {
  const [from, to] = dir === 'eth2btc' ? ['ETH', 'BTC'] : ['BTC', 'ETH'];
  const got = [], why = [];
  for (const v of cfg.venues) {
    try {
      const q = await venueQuote({ venue: v, nodes: cfg.nodes[v], fetchImpl, from, to, amount: amount1e8, destination, slipBps: cfg.slipBps, vaultHistory });
      got.push({ ...q, costBps: costBps({ dir, amountWei, amountSats, out: q.out, ethPerBtc }) });
    } catch (e) { why.push(err(e)); log({ level: 'info', msg: 'rebalance: a venue gave no usable quote', venue: v, error: err(e) }); }
  }
  got.sort((a, b) => a.costBps - b.costBps);
  return { best: got[0] || null, all: got, why };
}

export function makeRebalancer({ cfg, rate, inventory, quiet = async () => true, gate = (fn) => fn(), turn = (fn) => fn(), unshield, ethBalance, ethNonce, ethReceipt, sendEth, freshAddress = null, vaultHistory = null, btcBuild = null, btcBroadcast = null, btcStatus = null, address, btcDestination, gasReserveWei, fetchImpl = (...a) => fetch(...a), load, save, now = () => Math.floor(Date.now() / 1000), log = () => {}, alert = () => {} }) {
  let st = null, busy = false, nextAt = -Infinity, halted = null, last = null, calls = { dir: null, n: 0 };
  const said = new Map();
  const sayOnce = (k, a, secs = 6 * 3600) => { if (now() - (said.get(k) ?? -Infinity) >= secs) { said.set(k, now()); alert(a); } };
  const keep = () => save({ id: 'rebalance', ...st });
  const day = () => Math.floor(now() / DAY);
  async function state() {
    if (st) return st;
    const kept = await load().catch(() => null);
    st = { moved: '0', day: day(), pending: null, done: 0, fresh: { next: 0 }, lastTx: null, lastAt: null, ...(kept && kept.v === 1 ? kept : {}), v: 1 };
    if (st.day !== day()) { st.day = day(); st.moved = '0'; }
    st.fresh ||= { next: 0 };
    return st;
  }
  const stop = (why, o = {}) => { halted = why; alert({ level: 'error', msg: `rebalance: stopped: ${why}`, ...o }); return { did: 'halted' }; };
  const mk = (a) => ethText(a);

  async function advance() {
    const p = st.pending;
    if (p.stage === 'unshield') {
      const have = await ethBalance(p.from);
      if (have >= BigInt(p.targetPublic)) { p.stage = 'send'; await keep(); return advance(); }
      if (now() - p.at > 3600) return stop('the unshielded ETH has not arrived after an hour', { want: mk(p.targetPublic), have: mk(have) });
      return { did: 'waiting for the unshield' };
    }
    if (p.dir === 'btc2eth') {
      if (p.stage === 'sending') {
        // sent again with the same bytes after a restart: the same transaction, so never a second payment
        try { await btcBroadcast(p.hex); } catch (e) { if (!/already|known|exists|duplicate|conflict/i.test(err(e))) { sayOnce('btc-send', { level: 'warn', msg: 'rebalance: the Bitcoin send could not be broadcast yet; tried again next look', error: err(e), txid: p.txid }, 3600); return { did: 'failed' }; } }
        p.stage = 'sent'; p.sentAt = now(); st.moved = String(BigInt(st.moved) + BigInt(p.valueWei)); await keep();
        alert({ level: 'info', msg: 'rebalance: BTC sold for ETH', venue: p.venue, sats: p.amountSats, expectEth: mk(BigInt(p.expectOut) * UNIT), costBps: p.costBps, txid: p.txid });
        return { did: 'sent', tx: p.txid };
      }
      if (p.stage === 'sent') {
        const s2 = await btcStatus(p.txid).catch(() => null);
        if (!s2 || !(s2.confirmations > 0)) { if (now() - p.sentAt > 6 * 3600) sayOnce('btc-unconf', { level: 'warn', msg: 'rebalance: the Bitcoin send has not confirmed for six hours', txid: p.txid }); return { did: 'pending' }; }
        st.pending = null; st.done += 1; st.lastTx = p.txid; st.lastAt = now(); nextAt = now() + cfg.everySecs * 2; await keep();
        return { did: 'swapped', tx: p.txid };
      }
      return stop(`an unknown stage "${p.stage}"`);
    }
    if (p.stage === 'send') {
      const amountWei = BigInt(p.amountWei), cheap = await bestQuote({ cfg, fetchImpl, dir: 'eth2btc', amount1e8: String(amountWei / UNIT), destination: btcDestination, ethPerBtc: await rateNow(), amountWei, vaultHistory, log });
      if (!cheap.best || cheap.best.costBps > cfg.maxCostBps) {
        // nothing is lost by waiting: the ETH is public at the provider's own address, held from the shield, and tried again
        sayOnce('send-wait', { level: 'warn', msg: 'rebalance: ETH is ready to swap but no venue quotes within the cost limit; trying again', cost: cheap.best ? cheap.best.costBps : null, limit: cfg.maxCostBps, why: cheap.why });
        if (now() - p.at > 6 * 3600) { st.pending = null; await keep(); return stop('no venue quoted within the cost limit for six hours; the ETH stays public at the provider\'s address (it is shielded again when the rebalance is switched off)'); }
        return { did: 'waiting for a quote' };
      }
      const q = cheap.best, nonce = Number(BigInt(await ethNonce(p.from)));
      // kept before it is sent: a restart finds it and checks the account's nonce, never sends a second time
      p.stage = 'sending'; p.nonce = nonce; p.venue = q.venue; p.vault = q.vault; p.memo = q.memo; p.expectOut = String(q.out); p.costBps = q.costBps; await keep();
      let tx;
      try { tx = await turn(() => sendEth({ to: q.vault, value: amountWei, memo: q.memo, fi: p.fi ?? null })); } catch (e) { alert({ level: 'warn', msg: 'rebalance: the swap could not be sent; the next look checks whether it went out before trying again', error: err(e) }); return { did: 'failed' }; }
      p.tx = tx; p.stage = 'sent'; p.sentAt = now(); st.moved = String(BigInt(st.moved) + amountWei); if (p.fi != null) st.fresh.next = Math.max(st.fresh.next, p.fi + 1); await keep();
      alert({ level: 'info', msg: 'rebalance: ETH sold for BTC', venue: q.venue, eth: mk(amountWei), expectSats: String(q.out), costBps: q.costBps, tx });
      return { did: 'sent', tx };
    }
    if (p.stage === 'sending') {
      const n = Number(BigInt(await ethNonce(p.from)));
      if (n > p.nonce) return stop('a swap may have been sent without its transaction being kept; check the address\'s transactions before setting FB_LP_REBALANCE again', { nonce: p.nonce });
      p.stage = 'send'; await keep(); return { did: 'cleared' };
    }
    if (p.stage === 'sent') {
      const r = await ethReceipt(p.tx);
      if (!r) { if (now() - p.sentAt > 3600) sayOnce('unmined', { level: 'warn', msg: 'rebalance: the swap transaction has not been mined for over an hour', tx: p.tx }); return { did: 'pending' }; }
      if (r.status !== '0x1') { st.moved = String(BigInt(st.moved) - BigInt(p.amountWei)); st.pending = null; await keep(); return stop('the swap transaction reverted', { tx: p.tx }); }
      // mined: the venue pays the other side to the provider's own address; one swap per look, and the next waits for the balances to show it
      st.pending = null; st.done += 1; st.lastTx = p.tx; st.lastAt = now(); nextAt = now() + cfg.everySecs * 2; await keep();
      return { did: 'swapped', tx: p.tx };
    }
    return stop(`an unknown stage "${p.stage}"`);
  }
  // A dry run also asks, every six hours, what a swap of the least size would cost now in each direction, vault checks and all: so the live checks are seen working before anything is sent
  let probeAt = -Infinity;
  async function probe(mkt) {
    if (now() - probeAt < 6 * 3600) return;
    probeAt = now();
    const out = {};
    for (const dir of ['eth2btc', 'btc2eth']) {
      const amountWei = cfg.minSwapWei, amountSats = BigInt(Math.floor(Number(amountWei) / 1e10 / mkt));
      const { best, why } = await bestQuote({ cfg, fetchImpl, dir, amount1e8: dir === 'eth2btc' ? String(amountWei / UNIT) : String(amountSats), destination: dir === 'eth2btc' ? btcDestination : address, ethPerBtc: mkt, amountWei: dir === 'eth2btc' ? amountWei : undefined, amountSats: dir === 'btc2eth' ? amountSats : undefined, vaultHistory, log });
      out[dir] = best ? { venue: best.venue, costBps: best.costBps, vault: best.vault, nodes: best.nodes } : { refused: why };
    }
    if (last) last.probe = out;
    alert({ level: 'info', msg: 'rebalance (dry run): what a swap of the least size would cost now', eth: mk(cfg.minSwapWei), ...out });
  }
  let rateAt = 0, rateV = null;
  const rateNow = async () => { if (rateV && now() - rateAt < 60) return rateV; const r = await rate(); rateV = typeof r === 'number' ? r : (r && (r.ethPerBtc ?? r.rate)) || null; rateAt = now(); return rateV; };

  async function step() {
    if (cfg.mode === 'off') return { did: 'off' };
    if (halted) return { did: 'halted' };
    if (busy) return { did: 'busy' };
    busy = true;
    try {
      await state();
      if (st.day !== day()) { st.day = day(); st.moved = '0'; await keep(); }
      if (st.pending) return await advance();
      if (now() < nextAt) return { did: 'wait' };
      const mkt = await rateNow();
      const inv = await inventory();
      if (!inv || inv.sats == null || inv.ethWei == null || !(mkt > 0)) { nextAt = now() + cfg.everySecs; last = { at: now(), plan: `unread: ${!(mkt > 0) ? 'no market price' : 'holdings not read'}` }; return { did: 'unread' }; }
      const plan = planRebalance({ ethWei: inv.ethWei, sats: inv.sats, ethPerBtc: mkt, cfg, movedTodayWei: BigInt(st.moved) });
      last = { at: now(), ethBps: plan && plan.ethBps != null ? plan.ethBps : null, plan: plan && plan.dir ? plan.dir : plan && plan.skip ? `skip: ${plan.skip}` : 'in band' };
      nextAt = now() + cfg.everySecs;
      if (!plan || plan.skip) { calls = { dir: null, n: 0 }; if (cfg.mode === 'dry') await probe(mkt).catch(() => {}); return plan ? { did: 'skip', why: plan.skip } : { did: 'in band' }; }
      const dest = plan.dir === 'eth2btc' ? btcDestination : address;
      const amount1e8 = plan.dir === 'eth2btc' ? String(plan.amountWei / UNIT) : String(plan.amountSats);
      const { best, all, why } = await bestQuote({ cfg, fetchImpl, dir: plan.dir, amount1e8, destination: dest, ethPerBtc: mkt, amountWei: plan.amountWei, amountSats: plan.amountSats, vaultHistory, log });
      last.quotes = all.map((x) => ({ venue: x.venue, costBps: x.costBps, out: String(x.out) }));
      if (!best) { sayOnce('noquote', { level: 'warn', msg: 'rebalance: a swap is due but no venue gave a usable quote', why }); return { did: 'no quote' }; }
      if (best.costBps > cfg.maxCostBps) { sayOnce('dear', { level: 'info', msg: 'rebalance: a swap is due but the best quote costs more than the limit', best: best.venue, costBps: best.costBps, limit: cfg.maxCostBps }); return { did: 'dear', costBps: best.costBps }; }
      const what = plan.dir === 'eth2btc' ? `${mk(plan.amountWei)} ETH` : `${plan.amountSats} sats`;
      // never while a swap is open or promised: the ETH it has promised is already out of what it holds and the BTC that pays for it is not yet in, so the sides read lopsided for a while
      if (cfg.mode !== 'dry' && !(await quiet())) { calls = { dir: null, n: 0 }; last.plan = `${plan.dir} (waiting: a swap is open)`; return { did: 'quiet' }; }
      calls = calls.dir === plan.dir ? { dir: plan.dir, n: calls.n + 1 } : { dir: plan.dir, n: 1 };
      if (cfg.mode === 'dry') { sayOnce(`dry-${plan.dir}`, { level: 'info', msg: `rebalance (dry run): would swap ${what} (${plan.dir}) on ${best.venue}`, costBps: best.costBps, ethSharePct: plan.ethBps / 100, vault: best.vault, quotes: last.quotes }, 3600); return { did: 'dry', plan: plan.dir }; }
      if (calls.n < cfg.confirmLooks) { last.plan = `${plan.dir} (look ${calls.n} of ${cfg.confirmLooks})`; return { did: 'confirming' }; }
      if (plan.dir === 'btc2eth') {
        if (!btcBuild || !btcBroadcast || !btcStatus) { sayOnce('btc-heavy', { level: 'warn', msg: `rebalance: the provider is BTC-heavy: ${what} should be swapped to ETH on ${best.venue} (costs ${best.costBps} bps); the Bitcoin send is not wired`, vault: best.vault, memo: best.memo }, 12 * 3600); return { did: 'btc not automated' }; }
        // the Bitcoin is spent from the reverse address only, so the ETH-for-BTC side keeps what it needs (btcBuild says no when it would not); the signed transaction is kept before it is sent
        let built;
        try { built = await btcBuild({ to: best.vault, sats: plan.amountSats, memo: best.memo }); } catch (e) { sayOnce('btc-build', { level: 'warn', msg: 'rebalance: the Bitcoin send could not be built; nothing sent', error: err(e) }, 3 * 3600); return { did: 'failed' }; }
        st.pending = { id: `${now()}`, dir: 'btc2eth', stage: 'sending', amountSats: String(plan.amountSats), valueWei: String(plan.valueWei), txid: built.txid, hex: built.hex, fee: built.fee, venue: best.venue, vault: best.vault, memo: best.memo, expectOut: String(best.out), costBps: best.costBps, at: now() };
        await keep();
        return await advance();
      }
      if (!(await quiet())) return { did: 'quiet' };
      // the ETH to sell must be public: what is short is unshielded from the provider's own notes (the shield leaves public ETH alone while this is under way)
      // with fresh addresses on, the ETH goes out of an address used for this swap only (derived from the provider's key, counted in `fresh`), which holds just the swap and its gas
      const useFresh = !!(cfg.fresh && freshAddress), fi = useFresh ? st.fresh.next : null, from = useFresh ? freshAddress(fi) : address;
      const have = await ethBalance(from), targetPublic = plan.amountWei + (useFresh ? cfg.freshGasWei : gasReserveWei), short = targetPublic > have ? targetPublic - have : 0n;
      st.pending = { id: `${now()}`, dir: 'eth2btc', stage: short > 0n ? 'unshield' : 'send', amountWei: String(plan.amountWei), targetPublic: String(targetPublic), from, fi, at: now() };
      await keep();
      if (short > 0n) {
        const units = (short + UNIT - 1n) / UNIT + 50000n;                         // + the relay's fee, about 0.0005 ETH
        try { await gate(() => unshield({ units, to: from })); } catch (e) { st.pending = null; await keep(); alert({ level: 'warn', msg: 'rebalance: the unshield could not be made; nothing was swapped', error: err(e) }); return { did: 'failed' }; }
        st.pending.at = now(); await keep();
        return { did: 'unshielding' };
      }
      return await advance();
    } catch (e) {
      alert({ level: 'warn', msg: 'rebalance: a step failed', error: err(e) });
      return { did: 'failed' };
    } finally { busy = false; }
  }
  const info = () => ({ mode: cfg.mode, halted, pending: st && st.pending ? { dir: st.pending.dir, stage: st.pending.stage, ...(st.pending.amountWei ? { eth: mk(st.pending.amountWei) } : { sats: st.pending.amountSats }) } : null, movedTodayEth: st ? mk(BigInt(st.moved)) : '0.0000', swaps: st ? st.done : 0, last });
  return { step, info, holding: () => !!(st && st.pending && st.pending.dir === 'eth2btc' && st.pending.fi == null), halted: () => halted };
}
