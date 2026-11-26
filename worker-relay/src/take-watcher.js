// A watcher that finishes the take of an ETH-for-Bitcoin swap for a user who is not there (dapp/take-presig.js).
//
// The user posted a pre-signature of the take of the provider's Bitcoin lock (worker/src/take-presig.js). When the provider claims the user's ETH on the pool, its
// claim carries z, and z minus the user's own pre-signature of that claim is t, the one number the take was waiting for. This reads the claim, completes the
// signature, and sends the take to the USER's address (the signature commits that output and its amount: this cannot pay anyone else, and refuses to send a
// transaction whose first output is not exactly the committed one or whose signature does not verify). The watcher holds no key of the user's and no claim on its
// funds; a fee input of its own is optional and it pays only what policy.maxFundSats allows.
//
// The core is pure: it is handed everything it touches (`source`, `pool`, `chain`, `store`, `funder`, `now`), so it runs against no chain in the tests.
//
//   source.list()                         -> the pre-signatures posted so far (take-watcher-main.js reads them from the API)
//   pool.findClaim(lockNu, opts)          -> null while the lock is unspent, [] if it was refunded, else the claim kernels z (dapp/fastbridge-evm.js findClaim)
//   chain.outspend(txid, vout)            -> the txid that spends the output, or null
//   chain.outputSpk(txid, vout)           -> the output script (hex) the chain shows there, or null while it does not (optional; given, a pre-signature for another script is let go)
//   chain.status(txid)                    -> { confirmations }
//   chain.feeRate()                       -> sat/vB for the next block or two
//   chain.broadcast(hex, tx)              -> sends it (throws with the node's reason); `tx` is the same transaction decoded, for a chain that is a simulation
//   funder (optional)                     -> { coins() -> [{ txid, vout, value }], changeSpk, sign(tx, inputs) -> witnesses }, adds a fee input and change when the committed fee is short
//   store.get(k) / store.put(k, v) / store.list() / store.delete(k)
import * as TP from '../../dapp/take-presig.js';

const strip = (h) => String(h ?? '').replace(/^0x/, '').toLowerCase();
const hx = (n) => '0x' + n.toString(16).padStart(64, '0');
export const WATCHER_DEFAULTS = { bumpSecs: 900, maxBumps: 8, claimLookbackSecs: 12 * 3600, maxFundSats: 20000, rateSlack: 1, maxList: 500, doneKeepSecs: 3 * 86400 };

// The inputs and outputs a funder adds so that the take pays `feeRate`: one coin in, the change out. Null when the committed fee already pays it, or the coin
// cannot cover the rest (or the rest is more than `maxFund`).
export function fundPlan({ baseFee, baseVsize, feeRate, coin, changeSpk, maxFund, inputVsize = 68, changeVsize = 31, dust = 294 }) {
  const need = Math.ceil((baseVsize + inputVsize + changeVsize) * feeRate) - baseFee;
  if (!(need > 0) || need > maxFund || !coin || coin.value < need + dust) return null;
  return { extraFee: need, inputs: [{ txid: coin.txid, vout: coin.vout, value: coin.value, script: changeSpk, sequence: TP.TAKE_SEQUENCE }], outputs: [{ value: coin.value - need, script: changeSpk }] };
}

export function makeTakeWatcher({ source, pool, chain, store, funder = null, now = () => Math.floor(Date.now() / 1000), log = () => {}, policy: policyIn = {} }) {
  const policy = { ...WATCHER_DEFAULTS, ...policyIn };
  const idOf = (p) => `${strip(p.lock.txid)}:${p.lock.vout}:${strip(p.R)}`;
  const save = async (st, patch) => { Object.assign(st, patch, { updated: now() }); await store.put(st.id, st); return st; };

  // The pre-signatures not seen yet are verified in full (not what the source says of them) and kept as entries of their own
  async function take(list) {
    let added = 0;
    for (const p of (list || []).slice(0, policy.maxList)) {
      let id; try { id = idOf(p); } catch { continue; }
      if (await store.get(id)) continue;
      const v = TP.verifyPresig(p, { nowSecs: now() });
      if (!v.ok) { log({ msg: 'take-watcher: a pre-signature was refused', why: v.reasons[0] }); continue; }
      await store.put(id, { id, presig: p, phase: 'watching', since: now(), updated: now(), bumps: 0 });
      added++;
    }
    return added;
  }

  const claimOf = async (st) => {
    const p = st.presig;
    const zs = await pool.findClaim('0x' + strip(p.lockNu), {
      sinceSecs: Math.max(0, p.deadline - policy.claimLookbackSecs), check: (z) => TP.extractT(p, z) != null, proves: true,
    });
    if (zs == null) return null;
    if (!zs.length) return { refunded: true };
    for (const z of zs) { const t = TP.extractT(p, z); if (t != null) return { t }; }
    return null;                                   // a claim that does not give t (the user's own page says 'lost' for it): nothing to finish
  };

  // The take for the current fee rate: alone when its committed fee pays it, else with the funder's input and change. Never a transaction that is not the committed take.
  async function build(st, t, rate) {
    const p = st.presig;
    const alone = TP.buildTake(p, t);
    const target = Math.ceil(rate * policy.rateSlack);
    if (!funder || TP.committedRate(p) >= target) return { ...alone, effectiveFee: p.fee };
    const coins = await funder.coins();
    // the biggest coin that pays the rest: a watcher's coins are for this
    const plan = [...coins].sort((a, b) => a.value - b.value).map((coin) => fundPlan({ baseFee: p.fee, baseVsize: alone.vsize, feeRate: target, coin, changeSpk: funder.changeSpk, maxFund: policy.maxFundSats })).find(Boolean);
    if (!plan) return { ...alone, effectiveFee: p.fee, short: true };
    const funded = TP.buildTake(p, t, { inputs: plan.inputs, outputs: plan.outputs, sign: (tx, prevouts) => funder.sign(tx, plan.inputs, prevouts) });
    return { ...funded, effectiveFee: p.fee + plan.extraFee, funded: true };
  }

  async function send(st, t) {
    const rate = await chain.feeRate();
    const built = await build(st, t, rate);
    // (the last look before a broadcast: the first output is exactly the committed one and the lock's signature verifies for this very transaction)
    if (!TP.sameCommitted(built.tx, st.presig)) throw new Error('the take does not pay the committed output');
    try { await chain.broadcast(built.hex, built.tx); } catch (e) { if (!/already|known|duplicate|exists/i.test(String((e && e.message) || e))) throw e; }
    return { built, rate };
  }

  async function step(st) {
    const p = st.presig, t0 = now();
    if (['done', 'refunded', 'gone', 'expired'].includes(st.phase)) return st;
    // What spends the lock decides what is left to do: our own take confirmed is the end; a spend that is none of ours and is confirmed (the user's own take, or the
    // provider's refund) is the end too; one that is none of ours and still waits is left alone (the user's page may be taking, and a take is not fought over).
    const spent = await chain.outspend(p.lock.txid, p.lock.vout).catch(() => null);
    if (spent) {
      const ours = (st.txids || []).includes(spent);
      const conf = ((await chain.status(spent).catch(() => null)) || {}).confirmations > 0;
      if (conf) return save(st, { phase: ours ? 'done' : 'gone', spentBy: spent });
      if (!ours) return st;
    }
    if (t0 > p.expiresAt) return save(st, { phase: 'expired' });
    // The output the pre-signature names must be, on the chain, the script its own terms make: a pre-signature for an output that is not that (anyone can post one
    // for any outpoint) is let go. An output the chain does not show yet is asked again.
    if (chain.outputSpk && !st.spkOk) {
      const spk = await chain.outputSpk(p.lock.txid, p.lock.vout).catch(() => null);
      if (spk == null) return st;
      if (strip(spk) !== TP.verifyPresig(p).spk) return save(st, { phase: 'gone', why: 'the output is not the lock these terms make' });
      st = await save(st, { spkOk: true });
    }
    if (st.phase === 'watching') {
      const r = await claimOf(st);
      if (!r) return st;
      if (r.refunded) return save(st, { phase: 'refunded' });
      st = await save(st, { phase: 'claimed', t: hx(r.t), claimedSeen: t0 });
    }
    if (st.phase === 'claimed') {
      const t = BigInt(st.t);
      if (!st.txid) {
        const { built } = await send(st, t);
        log({ msg: 'take-watcher: the provider claimed; the take is sent', lock: `${p.lock.txid}:${p.lock.vout}`, txid: built.txid, funded: !!built.funded });
        return save(st, { txid: built.txid, hex: built.hex, txids: [built.txid], sentAt: t0, fee: built.effectiveFee, vsize: built.vsize, bumps: 0 });
      }
      // sent and not confirmed: sent again as it is (a node that dropped it), and replaced by one that pays more when the rate has moved past it and the funder can
      const rate = await chain.feeRate();
      const behind = st.fee / st.vsize < rate * policy.rateSlack;
      if (behind && st.bumps < policy.maxBumps && t0 - st.sentAt >= policy.bumpSecs && funder) {
        const { built } = await send(st, BigInt(st.t));
        if (built.effectiveFee > st.fee) return save(st, { txid: built.txid, hex: built.hex, txids: [...(st.txids || []), built.txid], sentAt: t0, fee: built.effectiveFee, vsize: built.vsize, bumps: st.bumps + 1 });
        return save(st, { bumps: policy.maxBumps });
      }
      // (what was sent last, as it was: the same bytes, so a node that has it says so and one that dropped it takes it again)
      if (st.hex) { try { await chain.broadcast(st.hex, st.tx || null); } catch (e) { if (!/already|known|duplicate|exists|spent|missing|conflict/i.test(String((e && e.message) || e))) throw e; } }
    }
    return st;
  }

  // One pass: read the posted pre-signatures, then step every one that is still open. A failure on one is kept on it and does not stop the others.
  async function pass() {
    let posted = [];
    try { posted = await source.list(); } catch (e) { log({ msg: 'take-watcher: the pre-signatures could not be read', why: String((e && e.message) || e).slice(0, 120) }); }
    const added = await take(posted);
    const out = { added, watching: 0, claimed: 0, done: 0 };
    for (const st of await store.list()) {
      try { await step(st); } catch (e) { await save(st, { lastError: String((e && e.message) || e).slice(0, 160), errorAt: now() }); }
      if (st.phase === 'watching') out.watching++; else if (st.phase === 'claimed') out.claimed++; else out.done++;
      if (['done', 'refunded', 'gone', 'expired'].includes(st.phase) && now() - (st.updated || 0) > policy.doneKeepSecs) await store.delete(st.id);
    }
    return out;
  }
  return { pass, step, take, build, idOf };
}

// A store in memory (the tests'), and one in a JSON file (the process's): the entries are the watcher's only state, and losing them only means asking the API again.
export function memoryStore() {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, list: async () => [...m.values()] };
}
