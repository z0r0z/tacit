// The keeper's work loop: for each pending box, read its balance; once funded, complete it (a deposit is proven
// against the pool's current leaves, a wrap needs no proof) if the reward covers the gas; past the deadline,
// optionally reclaim to the refund address, then stop watching. A receive box is swept whenever the fee its cap
// allows on the whole balance covers the gas, and stays watched.
//
// A deposit proof inserts at the pool's current root, so any transaction that lands first makes it stale. The
// pool reverts StaleRoot / WrongInsertionIndex; the keeper resyncs and re-proves, a bounded number of times.

import { completionWitness, sweepWitness, receiveRho } from '../../../dapp/evm-pool-gateway.js';
import { PipelineError } from './evm-pool-keeper-pipeline.js';
import { depositIntentArgs, wrapIntentArgs, hintArgs } from './evm-pool-keeper-intake.js';
import { revertName as defaultRevertName } from './evm-pool-keeper-chain.js';
import { ETH } from './evm-pool-keeper-config.js';
import { safeErr } from './safe-err.js';

const STALE = new Set(['StaleRoot', 'WrongInsertionIndex', 'UnknownMembershipRoot']);
const E18 = 10n ** 18n;

// Whether `reward` (in `token` base units) pays for `gas` at `gasPrice`, with the margin on top, and meets the
// token's minimum unless `floor` is false. A token with neither a minimum nor a price configured is never completed.
export function coverCheck({ reward, token, gas, gasPrice, cfg, floor = true }) {
  const t = token.toLowerCase();
  const min = cfg.minFees.get(t);
  const rate = cfg.rates.get(t);
  if (min === undefined && rate === undefined) return { ok: false, reason: `no minimum fee or price configured for ${t}` };
  if (BigInt(gas) > cfg.gasCap) return { ok: false, reason: `needs ${gas} gas, over the ${cfg.gasCap} cap` };
  if (floor && min !== undefined && BigInt(reward) < min) return { ok: false, reason: `reward ${reward} is below the ${min} minimum` };
  if (rate !== undefined) {
    const cost = BigInt(gas) * BigInt(gasPrice);
    const need = cost + (cost * cfg.marginBps) / 10000n;
    const value = (BigInt(reward) * rate) / E18;
    if (value < need) return { ok: false, reason: `reward worth ${value} wei is below the ${need} wei cost` };
  }
  const limit = (BigInt(gas) * 13n) / 10n;
  return { ok: true, gas: limit > cfg.gasCap ? cfg.gasCap : limit };
}

// The smallest fee, in `token` base units, that coverCheck accepts for `gas` at `gasPrice` (with the same `floor`).
export function quoteFee({ token, gas, gasPrice, cfg, floor = true }) {
  const t = token.toLowerCase();
  const min = (floor && cfg.minFees.get(t)) || 0n;
  const rate = cfg.rates.get(t);
  if (rate === undefined) return min;
  const cost = BigInt(gas) * BigInt(gasPrice);
  const need = cost + (cost * cfg.marginBps) / 10000n;
  const fee = (need * E18 + rate - 1n) / rate;
  return fee > min ? fee : min;
}

// What a keeper's signer has taken on itself of sweeps in the last day, in wei: one budget per signer (chain and address), shared
// by every pool it serves, since it is the signer's ETH that pays.
const ABSORBED = new Map();
const nowSecs = () => Math.floor(Date.now() / 1000);
export const signerKey = (chain) => `${chain.chainId}:${String(chain.address).toLowerCase()}`;
const absorbedSince = (key, at) => (ABSORBED.get(key) || []).filter((x) => at - x.at < 86_400).reduce((a, x) => a + x.wei, 0n);

// How much of its own ETH (wei) the signer may still take on: what is left of its day's budget (SWEEP_SUBSIDY_DAILY_WEI) and what
// it holds over its reserve (SUBSIDY_RESERVE_WEI), whichever is less; null when neither is set. A balance that cannot be read
// counts as none, so the subsidy stops rather than spends blind.
const HELD = new Map();   // signer → { at (ms), wei }: its ETH, read at most every maxAgeMs
export async function subsidyRoom({ chain, cfg, at = nowSecs(), maxAgeMs = 10_000 }) {
  let room = null;
  if (cfg.sweepSubsidyDaily) { const left = cfg.sweepSubsidyDaily - absorbedSince(signerKey(chain), at); room = left > 0n ? left : 0n; }
  if (cfg.subsidyReserve) {
    const key = signerKey(chain), c = HELD.get(key), ms = Date.now();
    let held;
    if (c && ms - c.at < maxAgeMs) held = c.wei;
    else { held = BigInt(await chain.balanceOf(ETH, chain.address).catch(() => 0n)); HELD.set(key, { at: ms, wei: held }); }
    const spare = held > cfg.subsidyReserve ? held - cfg.subsidyReserve : 0n;
    if (room === null || spare < room) room = spare;
  }
  return room;
}

// What the keeper takes on itself of a sweep that costs `cost` (in `token` base units, as quoteFee gives it): the share
// SWEEP_SUBSIDY_BPS of it, never more than SWEEP_SUBSIDY_WEI (that alone when no share is set) nor `room` (wei, from subsidyRoom;
// null for no bound). Nothing for a token with no price, or with no subsidy set.
export function subsidyOf({ token, cost, cfg, room = null }) {
  const rate = cfg.rates.get(token.toLowerCase());
  if (rate === undefined || !cfg.sweepSubsidy) return 0n;
  let s = (cfg.sweepSubsidy * E18 + rate - 1n) / rate;
  if (cfg.sweepSubsidyBps) { const share = (cost * BigInt(cfg.sweepSubsidyBps)) / 10_000n; if (share < s) s = share; }
  if (s > cost) s = cost;
  if (room !== null) { const cap = room > 0n ? (room * E18) / rate : 0n; if (cap < s) s = cap; }
  return s;
}
// Records what a sweep took from the signer's own pocket (token units), against its day's budget.
export function absorbed({ token, tokens, cfg, chain, at = nowSecs() }) {
  const rate = cfg.rates.get(token.toLowerCase());
  if (rate === undefined || tokens <= 0n) return;
  const key = signerKey(chain), list = (ABSORBED.get(key) || []).filter((x) => at - x.at < 86_400);
  list.push({ at, wei: (tokens * rate) / E18 });
  ABSORBED.set(key, list);
}

// The floor under the smallest balance a sweep of cost `cost` is done for: RECEIVE_MIN_MULT times the cost, and the token's own.
export function receiveFloorOf({ token, cost, cfg }) {
  const byCost = cost * BigInt(cfg.receiveMinMult || 0), own = cfg.minReceive?.get(token.toLowerCase()) ?? 0n;
  return byCost > own ? byCost : own;
}

// The smallest balance a sweep of cost `sweepFee` is done for: the 25 bps cap pays what the subsidy does not (a deposit of
// less leaves the box for its owner to take in), and never less than the floor.
export function receiveMinOf({ token, sweepFee, cfg, room = null }) {
  const sub = subsidyOf({ token, cost: sweepFee, cfg, room }), net = sweepFee > sub ? sweepFee - sub : 0n;
  const byCap = (net * 10_000n + 24n) / 25n, floor = receiveFloorOf({ token, cost: sweepFee, cfg });
  return byCap > floor ? byCap : floor;
}

// What a sweep of this pool really costs in gas: the SWEEP_GAS setting, or the highest estimate the chain gave for one in the last day if
// that is more (a first sweep that makes the box costs more than a setting taken from a later one). The quote, the subsidy and the
// minimum are sized on it, so they do not promise a sweep the estimate then shows the reward does not cover.
const SEEN_GAS = new Map();   // chainId:pool → [{ at, gas }]
const gasKey = (chain) => `${chain.chainId}:${String(chain.pool).toLowerCase()}`;
export function noteSweepGas({ chain, gas, at = nowSecs() }) {
  const key = gasKey(chain), list = (SEEN_GAS.get(key) || []).filter((x) => at - x.at < 86_400);
  list.push({ at, gas: BigInt(gas) });
  SEEN_GAS.set(key, list);
}
export const forgetSweepGas = () => SEEN_GAS.clear();
export function sweepGasOf({ chain, cfg, at = nowSecs() }) {
  const seen = (SEEN_GAS.get(gasKey(chain)) || []).filter((x) => at - x.at < 86_400).reduce((a, x) => (x.gas > a ? x.gas : a), 0n);
  return seen > cfg.sweepGas ? seen : cfg.sweepGas;
}

const hexOf = (m) => (typeof m === 'string' ? m : '0x' + Buffer.from(m).toString('hex'));

export function createKeeper({
  store, chain, prover, zk, assetField, leafSync, pipeline = null, cfg,
  now = () => Math.floor(Date.now() / 1000), log = () => {}, revertName = defaultRevertName,
}) {
  const backoff = (r, t, note, limit = Infinity) => {
    const checks = (r.checks || 0) + 1;
    const cap = Math.min(limit, r.kind !== 'receive' ? cfg.maxBackoffSecs : t > Number(r.deadline) ? cfg.receiveSlowSecs : cfg.receiveMaxBackoffSecs);
    // A box registered just now is waiting for a payment that is usually seconds away (a swap's output, a transfer from an exchange):
    // for its first minutes it is looked at again after 3, 6, 12 … seconds, not after the poll interval doubled.
    // (counted from its last registration or sweep, which set its deadline, so a box asked about again is fresh again)
    const fresh = r.kind === 'receive' && t - (Number(r.deadline) - (cfg.receiveWatchSecs ?? 0)) < (cfg.receiveFreshSecs ?? 300);
    const wait = Math.min((fresh ? Math.min(cfg.receiveFastSecs ?? 3, cfg.pollSecs) : cfg.pollSecs) * 2 ** Math.min(checks - (fresh ? 1 : 0), 16), cap);
    store.update(r.box, { checks, next_check: t + wait, updated: t, ...(note !== undefined ? { note } : {}) });
  };
  // A stale proof means the pool moved while it was made. Looking again at once only makes another, so the wait doubles from pollSecs
  // to staleMaxBackoffSecs (`checks` counts them; a success resets it): a pool in heavy use cannot keep the keeper proving.
  const staleLater = (r, t) => {
    const n = r.checks || 0, wait = Math.min(cfg.pollSecs * 2 ** Math.min(n, 12), cfg.staleMaxBackoffSecs ?? 120);
    store.update(r.box, { checks: n + 1, next_check: t + wait, updated: t, note: 'stale' });
  };
  const soon = (r, t, fields = {}) => store.update(r.box, { next_check: t + cfg.pollSecs, updated: t, ...fields });
  const finish = (r, t, status, fields = {}) => {
    store.update(r.box, { status, updated: t, ...fields });
    log(`${r.kind} ${r.box}: ${status}${fields.tx_hash ? ` in ${fields.tx_hash}` : ''}`);
  };
  const failed = (r, t, why) => {
    const attempts = (r.attempts || 0) + 1;
    r.attempts = attempts;
    if (attempts >= cfg.maxAttempts) return finish(r, t, 'failed', { attempts, note: why });
    log(`${r.kind} ${r.box}: attempt ${attempts}/${cfg.maxAttempts} failed: ${why}`);
    store.update(r.box, { attempts });
    backoff(r, t, why);
  };

  // A slot for the keeper's own insertion of `outLeaf`, and the tree to prove it against: the pool's, plus the
  // leaves queued ahead of the slot. Without a pipeline, the pool's own. → { tree, root (the proof's oldRoot),
  // slot, queued (other transactions ahead, so it cannot be simulated) }
  async function slotTree(outLeaf) {
    if (!pipeline) { const s = await leafSync.sync(); return { tree: s.tree, root: s.root, slot: null, queued: false }; }
    const slot = await pipeline.reserve({ outLeaf, nfs: [], owner: 'keeper' });
    for (let i = 0; i < 3; i++) {
      const s = await leafSync.sync().catch(() => null);
      if (s && s.tree.root === BigInt(slot.root)) {
        s.tree.append(slot.pending.flatMap((x) => [BigInt(x.outLeaf0), BigInt(x.outLeaf1)]));
        if (s.tree.root === BigInt(slot.oldRoot)) return { tree: s.tree, root: s.tree.root, slot, queued: slot.pending.length > 0 };
      }
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    await pipeline.cancel(slot.id);
    throw new PipelineError(409, 'the pool moved while reserving', { stale: true });
  }

  // Sends and waits. Returns 'completed' | 'reverted' | 'inflight' | 'dry'. With a slot, the transaction goes
  // through the pipeline in its turn.
  async function submit(r, functionName, args, gas, t, slot = null, tx = null) {
    if (cfg.dryRun) { if (slot) await pipeline.cancel(slot.id); log(`${r.kind} ${r.box}: dry run, would send ${functionName} (gas ${gas})`); return 'dry'; }
    const hash = slot
      ? await pipeline.fulfil(slot.id, tx, ({ simulate }) => chain.send(functionName, args, { gas, simulate }), { chainId: chain.chainId, pool: chain.pool, own: true })
      : await chain.send(functionName, args, { gas });    store.update(r.box, { tx_hash: hash, tx_sent_at: t, updated: t });
    log(`${r.kind} ${r.box}: sent ${functionName} ${hash}`);
    const rc = await chain.waitReceipt(hash, cfg.receiptWaitSecs * 1000);
    if (!rc) return 'inflight';
    if (rc.status === 'success') return 'completed';
    store.update(r.box, { tx_hash: null, tx_sent_at: null });
    return 'reverted';
  }

  async function completeDeposit(r, intent, t) {
    const pre = coverCheck({ reward: r.reward, token: r.token, gas: cfg.depositGas, gasPrice: await chain.gasPrice(), cfg });
    if (!pre.ok) return { skipped: pre.reason };
    const hint = hintArgs(r.hint);
    for (let round = 0; round <= cfg.staleRetries; round++) {
      let slotted;
      try { slotted = await slotTree([intent.outLeaf0, intent.outLeaf1]); }
      catch (e) { if (e instanceof PipelineError) { log(`deposit ${r.box}: ${e.message}, next tick`); return { stale: true }; } throw e; }
      const { tree, root, slot, queued } = slotted;
      const release = () => (slot ? pipeline.cancel(slot.id) : null);
      const w = completionWitness(zk, { intent, hint, asset: assetField, tree, chainId: chain.chainId, pool: chain.pool, relayer: chain.address });
      if (BigInt(w.publicSignals[1]) !== root) {
        await release();
        leafSync.invalidate();
        throw new Error('rebuilt leaves do not reach the pool root; resyncing');
      }
      const proofAt = Date.now();
      const p = await prover.prove(w.input, { priority: cfg.proofPriority ?? 0 }).catch(async (e) => { await release(); throw e; });
      log(`${r.kind} ${r.box}: proved in ${((Date.now() - proofAt) / 1000).toFixed(1)} s${p.via ? ` (${p.via})` : ''}`);
      if (p.publicInputs.length !== 11 || p.publicInputs.some((x, i) => BigInt(x) !== BigInt(w.publicSignals[i]))) { await release(); throw new Error('prover returned different public inputs'); }
      const tx = {
        pA: p.pA, pB: p.pB, pC: p.pC, publicInputs: p.publicInputs.map(BigInt),
        recipient: ETH, extAmount: intent.amount, relayer: chain.address, fee: hint.fee,
        memo0: hexOf(r.hint.memo0), memo1: hexOf(r.hint.memo1),
      };
      let est = cfg.depositGas;
      if (!queued) {
        try { est = await chain.estimate('completeDeposit', [intent, tx]); }
        catch (e) {
          await release();
          if (STALE.has(revertName(e))) { log(`deposit ${r.box}: proof went stale (${revertName(e)}), re-proving`); continue; }
          return { failed: revertName(e) || safeErr(e) };
        }
      }
      const cov = coverCheck({ reward: r.reward, token: r.token, gas: est, gasPrice: await chain.gasPrice(), cfg });
      if (!cov.ok) { await release(); return { skipped: cov.reason }; }
      let out;
      try { out = await submit(r, 'completeDeposit', [intent, tx], cov.gas, t, slot, tx); }
      catch (e) {
        if ((e instanceof PipelineError && e.stale) || STALE.has(revertName(e))) { log(`deposit ${r.box}: lost the race at submission, re-proving`); continue; }
        throw e;
      }
      if (out === 'reverted') { log(`deposit ${r.box}: completion reverted on chain, re-proving`); continue; }
      return { out };
    }
    return { stale: true };
  }

  async function completeWrap(r, intent, t) {
    let est;
    try { est = await chain.estimate('completeWrap', [intent]); }
    catch (e) { return { failed: revertName(e) || safeErr(e) }; }
    const cov = coverCheck({ reward: r.reward, token: r.token, gas: est, gasPrice: await chain.gasPrice(), cfg });
    if (!cov.ok) return { skipped: cov.reason };
    const out = await submit(r, 'completeWrap', [intent], cov.gas, t);
    return out === 'reverted' ? { failed: 'completion reverted on chain' } : { out };
  }

  async function reclaim(r, intent, t) {
    const fnName = r.kind === 'deposit' ? 'reclaimDeposit' : 'reclaimWrap';
    let est;
    const args = [intent, r.token];
    try { est = await chain.estimate(fnName, args); }
    catch (e) { return failed(r, t, `reclaim: ${revertName(e) || safeErr(e)}`); }
    const limit = (BigInt(est) * 13n) / 10n;
    const out = await submit(r, fnName, args, limit > cfg.gasCap ? cfg.gasCap : limit, t);
    if (out === 'completed') return finish(r, t, 'reclaimed', { tx_hash: store.get(r.box).tx_hash });
    if (out === 'reverted') return failed(r, t, 'reclaim reverted on chain');
    return soon(r, t);
  }

  // What a completed deposit box still holds (what its funding paid above the intent's amount) is nobody's after the box's deadline but its refund address's, and the router
  // lets anyone send it there. With reclaim on, the keeper does, once, when the leftover is worth the gas: three times what the send costs for ETH, and for a token
  // what coverCheck accepts (at least its minimum fee, and its price against the gas). A box with nothing left, or too little, is marked and not looked at again.
  async function sweepSurplus(r, t) {
    const intent = depositIntentArgs(r.intent), bal = BigInt(await chain.balanceOf(r.token, r.box));
    if (bal === 0n) return store.update(r.box, { note: 'swept', updated: t });
    let est;
    try { est = await chain.estimate('reclaimDeposit', [intent, r.token]); }
    catch (e) { const name = revertName(e); if (name === 'NothingToReclaim') return store.update(r.box, { note: 'swept', updated: t }); return log(`deposit ${r.box}: surplus not sent yet (${name || safeErr(e)})`); }
    const price = await chain.gasPrice(), asEth = String(r.token).toLowerCase() === '0x0000000000000000000000000000000000000000';
    const worth = asEth ? bal >= BigInt(est) * BigInt(price) * 3n : coverCheck({ reward: bal, token: r.token, gas: est, gasPrice: price, cfg }).ok;
    if (!worth) return store.update(r.box, { note: 'dust', updated: t });
    if (cfg.dryRun) return log(`deposit ${r.box}: dry run, would send ${bal} back to its refund`);
    const limit = (BigInt(est) * 13n) / 10n, hash = await chain.send('reclaimDeposit', [intent, r.token], { gas: limit > cfg.gasCap ? cfg.gasCap : limit });
    const rc = await chain.waitReceipt(hash, cfg.receiptWaitSecs * 1000);
    if (!rc) return log(`deposit ${r.box}: surplus sent in ${hash}, not seen mined yet`);
    if (rc.status !== 'success') return log(`deposit ${r.box}: surplus send ${hash} reverted`);
    log(`deposit ${r.box}: surplus ${bal} sent back to its refund in ${hash}`);
    return store.update(r.box, { note: 'swept', updated: t });
  }
  let surplusAt = 0;
  async function sweepSurplusBoxes(t) {
    if (!cfg.reclaim || t - surplusAt < (cfg.sweepSurplusSecs ?? 600)) return 0;
    surplusAt = t;
    const rows = store.surplusDue(t, cfg.sweepSurplusBatch ?? 10);
    for (const r of rows) { try { await sweepSurplus(r, t); } catch (e) { log(`deposit ${r.box}: surplus: ${safeErr(e)}`); } }
    return rows.length;
  }

  // Sweep the whole balance for what the sweep costs (gas with the margin), never more than the box's cap. The
  // relay minimum does not apply: the box's owner set its cap, and a priced token's cost check still holds. Another sweep landing first changes the box's counter (BadIntent) or balance: re-read and re-prove.
  async function sweep(r, t) {
    const { npk, feeBps } = r.intent;
    const bal = BigInt(await chain.balanceOf(r.token, r.box));
    if (bal === 0n) return { idle: true };
    const gasPrice = await chain.gasPrice();
    const floor = !cfg.rates.has(r.token.toLowerCase());
    const assumed = sweepGasOf({ chain, cfg, at: t });
    const cost = quoteFee({ token: r.token, gas: assumed, gasPrice, cfg, floor });
    const feeFor = (amount) => { const cap = (amount * BigInt(feeBps)) / 10_000n; return cost < cap ? cost : cap; };
    // What the keeper takes on itself of the cost counts toward the reward; a balance under the floor is left alone.
    const room = await subsidyRoom({ chain, cfg, at: t });
    const sub = subsidyOf({ token: r.token, cost, cfg, room }), floorMin = receiveFloorOf({ token: r.token, cost, cfg });
    if (sub > 0n && bal < floorMin) return { skipped: `balance ${bal} is below the ${floorMin} the keeper sweeps at a loss` };
    const pre = coverCheck({ reward: feeFor(bal) + sub, token: r.token, gas: assumed, gasPrice, cfg, floor });
    if (!pre.ok) return { skipped: pre.reason };
    for (let round = 0; round <= cfg.staleRetries; round++) {
      const n = await chain.receiveCount(r.box);
      const amount = round === 0 ? bal : BigInt(await chain.balanceOf(r.token, r.box));
      if (amount === 0n) return { idle: true };
      const f = feeFor(amount);
      let slotted;
      try { slotted = await slotTree([zk.leafOf(assetField, amount - f, BigInt(npk), receiveRho(r.box, n)), 0n]); }
      catch (e) { if (e instanceof PipelineError) { log(`receive ${r.box}: ${e.message}, next tick`); return { stale: true }; } throw e; }
      const { tree, root, slot, queued } = slotted;
      const release = () => (slot ? pipeline.cancel(slot.id) : null);
      const w = sweepWitness(zk, { asset: assetField, tree, npk: BigInt(npk), feeBps: Number(feeBps), box: r.box, n, amount, fee: f, relayer: chain.address, chainId: chain.chainId, pool: chain.pool });
      if (BigInt(w.publicSignals[1]) !== root) {
        await release();
        leafSync.invalidate();
        throw new Error('rebuilt leaves do not reach the pool root; resyncing');
      }
      const proofAt = Date.now();
      const p = await prover.prove(w.input, { priority: cfg.proofPriority ?? 0 }).catch(async (e) => { await release(); throw e; });
      log(`${r.kind} ${r.box}: proved in ${((Date.now() - proofAt) / 1000).toFixed(1)} s${p.via ? ` (${p.via})` : ''}`);
      if (p.publicInputs.length !== 11 || p.publicInputs.some((x, i) => BigInt(x) !== BigInt(w.publicSignals[i]))) { await release(); throw new Error('prover returned different public inputs'); }
      const tx = { pA: p.pA, pB: p.pB, pC: p.pC, publicInputs: p.publicInputs.map(BigInt), recipient: ETH, extAmount: amount, relayer: chain.address, fee: f, memo0: '0x', memo1: '0x' };
      const args = [BigInt(npk), Number(feeBps), tx];
      let est = assumed;
      if (!queued) {
        try { est = await chain.estimate('sweepReceive', args); noteSweepGas({ chain, gas: est, at: t }); }
        catch (e) {
          await release();
          const name = revertName(e);
          if (STALE.has(name) || name === 'BadIntent') { log(`receive ${r.box}: raced (${name}), re-proving`); continue; }
          return { failed: name || safeErr(e) };
        }
      }
      // The fee is in the proof; what the keeper takes on is not, so the subsidy is sized on the estimate, not on the gas assumed.
      const gp = await chain.gasPrice();
      const costNow = quoteFee({ token: r.token, gas: est, gasPrice: gp, cfg, floor }), subNow = subsidyOf({ token: r.token, cost: costNow, cfg, room });
      const cov = coverCheck({ reward: f + subNow, token: r.token, gas: est, gasPrice: gp, cfg, floor });
      if (!cov.ok) { await release(); return { skipped: cov.reason }; }
      let out;
      try { out = await submit(r, 'sweepReceive', args, cov.gas, t, slot, tx); }
      catch (e) {
        const name = revertName(e);
        if ((e instanceof PipelineError && e.stale) || STALE.has(name) || name === 'BadIntent') { log(`receive ${r.box}: lost the race at submission, re-proving`); continue; }
        throw e;
      }
      if (out === 'reverted') { log(`receive ${r.box}: sweep reverted on chain, re-proving`); continue; }
      return { out, amount, fee: f, took: subNow > 0n && costNow > f ? (costNow - f < subNow ? costNow - f : subNow) : 0n };
    }
    return { stale: true };
  }

  async function processReceive(r) {
    const t = now();
    if (r.tx_hash) {
      const rc = await chain.receipt(r.tx_hash);
      if (!rc && t - (r.tx_sent_at || 0) < cfg.receiptWaitSecs * 3) return soon(r, t);
      store.update(r.box, { tx_hash: null, tx_sent_at: null });
      if (rc?.status === 'success') return soon(r, t, { checks: 0, attempts: 0, note: 'swept' });
    }
    const res = await sweep(r, t);
    if (res.out === 'completed') {
      absorbed({ token: r.token, tokens: res.took ?? 0n, cfg, chain, at: t });
      log(`receive ${r.box}: swept ${res.amount} (fee ${res.fee}${res.took ? `, the keeper took on ${res.took}` : ''})`);
      return soon(r, t, { tx_hash: null, tx_sent_at: null, checks: 0, attempts: 0, note: 'swept', deadline: t + cfg.receiveWatchSecs });
    }
    if (res.out === 'inflight') return soon(r, t);
    if (res.out === 'dry') return backoff(r, t, 'dry run');
    if (res.stale) return staleLater(r, t);
    if (res.failed) {
      // A receive box is never given up on: a failure only slows the next look.
      log(`receive ${r.box}: ${res.failed}`);
      return backoff(r, t, res.failed);
    }
    if (res.skipped && res.skipped !== r.note) log(`receive ${r.box}: skipped, ${res.skipped}`);
    return backoff(r, t, res.skipped ?? null, res.skipped ? cfg.receiveSkipMaxBackoffSecs ?? 120 : undefined);
  }

  async function processIntent(r) {
    if (r.kind === 'receive') return processReceive(r);
    const t = now();
    if (r.tx_hash) {
      const rc = await chain.receipt(r.tx_hash);
      if (rc?.status === 'success') return finish(r, t, r.note === 'reclaiming' ? 'reclaimed' : 'completed', { tx_hash: r.tx_hash });
      if (!rc && t - (r.tx_sent_at || 0) < cfg.receiptWaitSecs * 3) return soon(r, t);
      store.update(r.box, { tx_hash: null, tx_sent_at: null });
    }
    const intent = r.kind === 'deposit' ? depositIntentArgs(r.intent) : wrapIntentArgs(r.intent);
    const need = r.kind === 'deposit' ? intent.amount : intent.amount + intent.tip;
    const bal = BigInt(await chain.balanceOf(r.token, r.box));
    const pastDeadline = t > Number(intent.deadline);
    const pastGrace = t > Number(intent.deadline) + cfg.expireGraceSecs;

    if (bal >= need && !(pastGrace && cfg.reclaim)) {
      if (!r.funded_at) store.update(r.box, { funded_at: t });
      const res = r.kind === 'deposit' ? await completeDeposit(r, intent, t) : await completeWrap(r, intent, t);
      if (res.out === 'completed') return finish(r, t, 'completed', { tx_hash: store.get(r.box).tx_hash, note: null });
      if (res.out === 'inflight') return soon(r, t);
      if (res.out === 'dry') return backoff(r, t, 'dry run');
      if (res.failed) return failed(r, t, res.failed);
      if (res.stale) { log(`deposit ${r.box}: still stale after ${cfg.staleRetries + 1} proofs; next tick`); return staleLater(r, t); }
      if (pastGrace) return finish(r, t, 'expired', { note: res.skipped });
      log(`${r.kind} ${r.box}: skipped, ${res.skipped}`);
      return backoff(r, t, res.skipped);
    }
    if (bal < need && r.funded_at) return finish(r, t, 'closed-elsewhere');
    if (pastDeadline && cfg.reclaim && bal > 0n) { store.update(r.box, { note: 'reclaiming' }); r.note = 'reclaiming'; return reclaim(r, intent, t); }
    if (pastGrace) return finish(r, t, 'expired');
    return backoff(r, t);
  }

  async function tick() {
    const rows = [...store.due(now(), cfg.maxChecksPerTick), ...store.dueReceive(now(), cfg.maxReceiveChecksPerTick)];
    for (const r of rows) {
      try { await processIntent(r); }
      catch (e) {
        log(`${r.kind} ${r.box}: ${safeErr(e)}`);
        backoff(r, now(), safeErr(e));
      }
    }
    await sweepSurplusBoxes(now()).catch((e) => log(`surplus: ${safeErr(e)}`));
    return rows.length;
  }

  // When the next pending row falls due (unix seconds), or null: the loop sleeps until then, not for a whole poll interval.
  const nextDue = () => store.nextDue();

  const woken = store.wakeNoted?.(now());
  if (woken) log(`${woken} receive box${woken === 1 ? '' : 'es'} left with a note before this start ${woken === 1 ? 'is' : 'are'} looked at again now`);

  return { tick, processIntent, nextDue };
}
