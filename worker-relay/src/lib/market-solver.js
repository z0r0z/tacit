// The settle relay's pass over the proof market's order board (worker/src/proof-market-queue.js): take an open order, claim it, prove its
// input and fulfil it, so the holder's op is settled and the relay is paid in TAC from the holder's permit. We are first in line: the
// claim is made at the order's current price, which excludes every other prover for the claim window; a prover that is quicker or cheaper
// than us gets there first only by claiming before we do, and a holder who wants it faster raises what they sign.
//
// The claim and the proof run at the same time, so the proof is ready by the time the claim is mined; the fulfil goes out only if the
// claim is still live. A claim that lapses before the proof comes back costs only the bond (none to start). Nothing here is paid for until
// the market's pool accepts the proof, so a failed order costs gas for the claim and the proving it took, no more.
//
// Dependencies are injected so the loop is tested without a chain: listOrders(), done(opId), claim(order) -> tx, prove(order) ->
// { publicValues, proof }, fulfil(order, proof) -> tx, clear(opId), claimOf(opId) -> { solver, until }.
// The price the market charges `at` (unix seconds) for an order's intent (mirrors ProofMarket.priceAt).
function priceAt(intent, at) {
  const floor = BigInt(intent.floorFee), max = BigInt(intent.maxFee), ramp = BigInt(intent.rampSecs), t = BigInt(at) - BigInt(intent.start);
  if (ramp === 0n || t >= ramp) return max;
  if (t <= 0n) return floor;
  return floor + ((max - floor) * t) / ramp;
}

// The ETH the market may spend is what the settle wallet holds above what the relay's own settles need at today's gas (`need`, its floor): the market's claim and fulfil (with
// half again for the base fee moving) must fit in that. Market orders pay in TAC but cost ETH, and the relay's main job, sending users' ops, comes first.
export const marketHasRoom = ({ held, need, orderGas, gasPrice }) => BigInt(held) >= BigInt(need) + (BigInt(orderGas) * BigInt(gasPrice) * 15n) / 10n;

// The deposit a wrap's public values consume (word 36 of the fixed 55-word layout, dapp/proof-market.js wrapPublicValues).
export const depositOf = (publicValues) => '0x' + String(publicValues).replace(/^0x/, '').slice(36 * 64, 37 * 64);

export function makeMarketSolver({ listOrders, done, claim, prove, fulfil, clear, claimOf, depositStatus, deliver = null, me, minPrice = 0n, retryMs = 120_000, maxClaims = 2, perPayerHour = 6, perHour = 60, canStart = () => true, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const tried = new Map();   // opId -> when it last failed here, so one bad order is not tried every pass
  const proofs = new Map();  // opId -> the proof being made (or made) for it: proving starts when an order is seen, the claim waits for its deposit
  let busy = false;          // one prover: one proof at a time
  const claiming = new Set();   // orders with a claim being sent: never a second claim for one while the first may still land
  const claimsMade = new Map(); // opId -> claims sent for it: an order that two claims did not settle is left (a claim costs gas)
  const started = [];        // [{ at, payer }] proofs started in the last hour: a payer, and the board as a whole, can only make so much work for the prover
  return {
    // Whether an order is being proved or waits for its deposit: the relay then looks again in seconds, not on its long idle wait.
    hasOpen: () => proofs.size > 0,
    // One order at most is claimed per pass (one key). → true when an order was claimed and worked on.
    async pass() {
      const t = Math.floor(now() / 1000);
      let orders;
      try { orders = await listOrders(); } catch (e) { log(`market: could not read the board: ${e.message}`); return false; }
      // The least price worth taking: a number, or a function (the relay prices its gas and proving in TAC each pass). A claim lands about half a minute on.
      let minP;
      try { minP = typeof minPrice === 'function' ? await minPrice() : minPrice; } catch (e) { log(`market: could not price the work: ${e.message}`); return false; }
      const open = new Set(orders.map((o) => o.intent.opId));
      // A proof is kept for 15 minutes after its order drops off the list (a board that briefly lost it, a read that raced a post): proving it again costs 30 s.
      for (const [id, st] of proofs) { if (open.has(id)) st.seenAt = now(); else if (now() - (st.seenAt || 0) > 15 * 60_000) proofs.delete(id); }
      // Orders whose deposit has landed come first (their holder is waiting on them), then the newest of the rest: a holder who has just posted is
      // waiting, an old order that never got its deposit is probably abandoned. One prover, so the order it works in matters.
      const status = new Map(await Promise.all(orders.map(async (o) => [o.intent.opId, Number(await depositStatus(depositOf(o.publicValues)).catch(() => 0))])));
      orders = orders.slice().sort((a, b) => ((status.get(b.intent.opId) === 1) - (status.get(a.intent.opId) === 1)) || (Number(b.intent.deadline) - Number(a.intent.deadline)));
      for (const o of orders) {
        const id = o.intent.opId;
        if (now() - (tried.get(id) || 0) < retryMs) continue;
        if (Number(o.intent.deadline) <= t + 30) continue;
        if (priceAt(o.intent, t + 30) < minP) continue;
        let soon = false;
        try {
          if (await done(id)) { await clear(id).catch(() => {}); continue; }
          const held = await claimOf(id);
          if (held && held.until > t && held.solver.toLowerCase() !== me.toLowerCase()) continue; // another prover has it
          if ((claimsMade.get(id) || 0) >= maxClaims) continue;                                   // claimed twice and still not settled: left to expire
          // The proof is started as soon as the order is seen, so it is ready when the holder's deposit lands.
          // The proof is made in the background (the relay's loop goes on serving its other work); each pass looks at where it has got to.
          let st = proofs.get(id);
          if (!st) {
            if (busy || !canStart()) continue;   // one proof at a time, and none begun while the relay is busy with its own queue
            const hourAgo = now() - 3_600_000;
            while (started.length && started[0].at < hourAgo) started.shift();
            if (started.length >= perHour || started.filter((x) => x.payer === o.intent.payer.toLowerCase()).length >= perPayerHour) { tried.set(id, now()); continue; }
            started.push({ at: now(), payer: o.intent.payer.toLowerCase() });
            busy = true;
            log(`market: proving order ${id.slice(0, 10)}`);
            st = { done: false, value: null, failed: null, seenAt: now() };
            proofs.set(id, st);
            // a finished proof is handed back for the holder too (best effort): if the deposit never comes, the page keeps it as a voucher
            prove(o).then(async (p) => { if (deliver) await deliver(o, p).catch(() => {}); st.value = p; st.done = true; })
              .catch((e) => { st.failed = e; })
              .finally(() => { busy = false; });
          }
          if (st.failed) { log(`market: order ${id.slice(0, 10)}: the proof failed: ${String(st.failed.message || st.failed).slice(0, 160)}`); proofs.delete(id); tried.set(id, now()); continue; }
          // An order whose holder never sent the deposit (an abandoned zap) is never claimed: a claim costs gas.
          if (status.get(id) !== 1) continue;
          // Proof first, then the claim: the claim window (a minute) starts when the claim lands, so it is made when the proof is in hand and the fulfil
          // follows in the next block, rather than racing a proof that may take most of the window.
          if (!st.done) continue;
          const proof = st.value;
          log(`market: order ${id.slice(0, 10)}: deposit pending and proof ready, claiming`);
          if (claiming.has(id)) continue;
          claimsMade.set(id, (claimsMade.get(id) || 0) + 1);
          claiming.add(id);
          let claimTx;
          try { claimTx = await claim(o); }
          catch (e) {
            // The send can fail on one endpoint while another carries the transaction: read the chain before calling the claim failed.
            await sleep(3000);
            const mine = await claimOf(id).catch(() => null);
            if (!mine || mine.solver.toLowerCase() !== me.toLowerCase() || mine.until <= Math.floor(now() / 1000)) throw e;
            log(`market: order ${id.slice(0, 10)}: the claim send reported an error but the claim is on chain; going on`);
            claimTx = 'on chain';
          } finally { claiming.delete(id); }
          // The claim is in a block: its window runs from there. It is not read back (a node a block behind says there is no claim); the fulfil is simulated
          // before it is sent and says NoClaim if there is none.
          const live = { until: Math.floor(now() / 1000) + 52 };
          let tx, last;
          for (;;) {
            try { tx = await fulfil(o, proof); break; } catch (e) { last = e; }
            if (Math.floor(now() / 1000) + 6 >= live.until) { soon = true; throw last; }
            await sleep(4000);
          }
          log(`market: order ${id.slice(0, 10)} settled: claim ${claimTx} fulfil ${tx}`);
          proofs.delete(id); claimsMade.delete(id);
          await clear(id).catch(() => {});
          return true;
        } catch (e) {
          log(`market: order ${id.slice(0, 10)} failed: ${String(e.message || e).slice(0, 200)}`);
          tried.set(id, soon ? now() - retryMs + 10_000 : now());
          return true;
        }
      }
      return false;
    },
  };
}
