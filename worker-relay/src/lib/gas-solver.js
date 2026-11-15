// The settle relay's pass over TacitGasRelay's order board (worker/src/gas-relay-queue.js): send a posted order and keep the fee. The contract
// pays the fee only if the whole swap lands, so an order that would revert costs the relay only the gas of finding out: it is simulated first and
// sent only if (a) the simulation passes and (b) the fee is worth more than the gas it will cost, with a margin.
//
// Dependencies are injected so the loop is tested without a chain: listOrders(), used(payer, nonce), simulate(order) -> gas (throws if it would
// revert), feeWei(order) -> what the fee is worth in wei (null when it cannot be valued), gasPrice() -> wei, send(order, gas) -> tx, clear(order).
export function makeGasSolver({ listOrders, used, simulate, feeWei, gasPrice, send, clear, marginBps = 12000, retryMs = 60_000, now = () => Date.now(), log = () => {} }) {
  const tried = new Map(); // order id -> when it last failed here, so one bad order is not tried every pass
  // Orders whose own fields cannot be read into a call (a number that is not one, a value that is not hex). Trying again changes nothing,
  // so each is said once and left alone until it leaves the board.
  const unreadable = new Set();
  const unreadableError = (e) => /cannot be converted to a BigInt|cannot convert .* to a BigInt|invalid (address|hex|bytes)|is not a valid (address|hex)/i.test(String((e && e.message) || e));
  return {
    // One order at most per pass (one key). → true when an order was worked on.
    async pass() {
      const t = Math.floor(now() / 1000);
      let orders;
      try { orders = await listOrders(); } catch (e) { log(`gas relay: could not read the board: ${e.message}`); return false; }
      for (const k of unreadable) if (!orders.some((o) => o.id === k)) unreadable.delete(k);
      for (const x of orders) {
        const id = x.id;
        if (unreadable.has(id)) continue;
        if (now() - (tried.get(id) || 0) < retryMs) continue;
        if (Number(x.order.deadline) <= t + 20) continue;
        try {
          if (await used(x.order.payer, x.order.nonce)) { await clear(x).catch(() => {}); continue; }
          const gas = await simulate(x);                       // throws when the contract would refuse it
          const [value, price] = [await feeWei(x), await gasPrice()];
          if (value == null) { log(`gas relay: order ${id.slice(0, 10)}: the fee cannot be valued; leaving it`); tried.set(id, now()); continue; }
          const cost = (BigInt(gas) * BigInt(price) * BigInt(marginBps)) / 10000n;
          if (value < cost) { log(`gas relay: order ${id.slice(0, 10)}: the fee (${value} wei) is under the gas (${cost} wei); leaving it`); tried.set(id, now()); continue; }
          const tx = await send(x, gas);
          log(`gas relay: order ${id.slice(0, 10)} sent ${tx}`);
          await clear(x).catch(() => {});
          return true;
        } catch (e) {
          if (unreadableError(e)) {
            unreadable.add(id);
            log(`gas relay: order ${id.slice(0, 10)} cannot be read into a call (${String(e.message || e).slice(0, 140)}); leaving it for good`);
            return true;
          }
          log(`gas relay: order ${id.slice(0, 10)} failed: ${String(e.message || e).slice(0, 200)}`);
          tried.set(id, now());
          return true;
        }
      }
      return false;
    },
  };
}
