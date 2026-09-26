// The keeper's work loop: for each pending box, read its balance; once funded, complete it (a deposit is proven
// against the pool's current leaves, a wrap needs no proof) if the reward covers the gas; past the deadline,
// optionally reclaim to the refund address, then stop watching.
//
// A deposit proof inserts at the pool's current root, so any transaction that lands first makes it stale. The
// pool reverts StaleRoot / WrongInsertionIndex; the keeper resyncs and re-proves, a bounded number of times.

import { completionWitness } from '../../../dapp/evm-pool-gateway.js';
import { depositIntentArgs, wrapIntentArgs, hintArgs } from './evm-pool-keeper-intake.js';
import { revertName as defaultRevertName } from './evm-pool-keeper-chain.js';
import { ETH } from './evm-pool-keeper-config.js';
import { safeErr } from './safe-err.js';

const STALE = new Set(['StaleRoot', 'WrongInsertionIndex', 'UnknownMembershipRoot']);
const E18 = 10n ** 18n;

// Whether `reward` (in `token` base units) pays for `gas` at `gasPrice`, with the margin on top. A token with
// neither a minimum nor a price configured is never completed.
export function coverCheck({ reward, token, gas, gasPrice, cfg }) {
  const t = token.toLowerCase();
  const min = cfg.minFees.get(t);
  const rate = cfg.rates.get(t);
  if (min === undefined && rate === undefined) return { ok: false, reason: `no minimum fee or price configured for ${t}` };
  if (BigInt(gas) > cfg.gasCap) return { ok: false, reason: `needs ${gas} gas, over the ${cfg.gasCap} cap` };
  if (min !== undefined && BigInt(reward) < min) return { ok: false, reason: `reward ${reward} is below the ${min} minimum` };
  if (rate !== undefined) {
    const cost = BigInt(gas) * BigInt(gasPrice);
    const need = cost + (cost * cfg.marginBps) / 10000n;
    const value = (BigInt(reward) * rate) / E18;
    if (value < need) return { ok: false, reason: `reward worth ${value} wei is below the ${need} wei cost` };
  }
  const limit = (BigInt(gas) * 13n) / 10n;
  return { ok: true, gas: limit > cfg.gasCap ? cfg.gasCap : limit };
}

const hexOf = (m) => (typeof m === 'string' ? m : '0x' + Buffer.from(m).toString('hex'));

export function createKeeper({
  store, chain, prover, zk, assetField, leafSync, cfg,
  now = () => Math.floor(Date.now() / 1000), log = () => {}, revertName = defaultRevertName,
}) {
  const backoff = (r, t, note) => {
    const checks = (r.checks || 0) + 1;
    const wait = Math.min(cfg.pollSecs * 2 ** Math.min(checks, 16), cfg.maxBackoffSecs);
    store.update(r.box, { checks, next_check: t + wait, updated: t, ...(note !== undefined ? { note } : {}) });
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

  // Sends and waits. Returns 'completed' | 'reverted' | 'inflight' | 'dry'.
  async function submit(r, functionName, args, gas, t) {
    if (cfg.dryRun) { log(`${r.kind} ${r.box}: dry run, would send ${functionName} (gas ${gas})`); return 'dry'; }
    const hash = await chain.send(functionName, args, { gas });
    store.update(r.box, { tx_hash: hash, tx_sent_at: t, updated: t });
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
      const { leaves, root } = await leafSync.sync();
      const w = completionWitness(zk, { intent, hint, asset: assetField, leaves, chainId: chain.chainId, pool: chain.pool, relayer: chain.address });
      if (BigInt(w.publicSignals[1]) !== root) {
        leafSync.invalidate();
        throw new Error('rebuilt leaves do not reach the pool root; resyncing');
      }
      const p = await prover.prove(w.input);
      if (p.publicInputs.length !== 11 || p.publicInputs.some((x, i) => BigInt(x) !== BigInt(w.publicSignals[i]))) throw new Error('prover returned different public inputs');
      const tx = {
        pA: p.pA, pB: p.pB, pC: p.pC, publicInputs: p.publicInputs.map(BigInt),
        recipient: ETH, extAmount: intent.amount, relayer: chain.address, fee: hint.fee,
        memo0: hexOf(r.hint.memo0), memo1: hexOf(r.hint.memo1),
      };
      let est;
      try { est = await chain.estimate('completeDeposit', [intent, tx]); }
      catch (e) {
        if (STALE.has(revertName(e))) { log(`deposit ${r.box}: proof went stale (${revertName(e)}), re-proving`); continue; }
        return { failed: revertName(e) || safeErr(e) };
      }
      const cov = coverCheck({ reward: r.reward, token: r.token, gas: est, gasPrice: await chain.gasPrice(), cfg });
      if (!cov.ok) return { skipped: cov.reason };
      let out;
      try { out = await submit(r, 'completeDeposit', [intent, tx], cov.gas, t); }
      catch (e) {
        if (STALE.has(revertName(e))) { log(`deposit ${r.box}: lost the race at submission, re-proving`); continue; }
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

  async function processIntent(r) {
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
      if (res.stale) { log(`deposit ${r.box}: still stale after ${cfg.staleRetries + 1} proofs; next tick`); return soon(r, t, { note: 'stale' }); }
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
    const rows = store.due(now(), cfg.maxChecksPerTick);
    for (const r of rows) {
      try { await processIntent(r); }
      catch (e) {
        log(`${r.kind} ${r.box}: ${safeErr(e)}`);
        backoff(r, now(), safeErr(e));
      }
    }
    return rows.length;
  }

  return { tick, processIntent };
}
