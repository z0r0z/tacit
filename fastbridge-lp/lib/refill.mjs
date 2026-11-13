// Keeps the provider's private TAC from running out. TAC that has reached its own address, whoever sent it and whatever the provider holds free,
// is shielded: it is the provider's to lend and does nothing where it is (40,000 TAC sat at the address for twelve hours on 2026-11-13 because
// nobody was there to shield it). And when what it holds free (its pool balance less what is promised) falls under a low-water mark with nothing at
// the address, a chunk is pulled from a treasury that has approved this key for a limited amount (an ERC-20 allowance, which the treasury can take
// back at any time with an approval of 0), and shielded. It never pulls more than the allowance, the treasury's balance, a chunk, or what is left
// of the day's limit.
//
// Everything it touches goes through the calls it is given, so the rules are tried without a chain (tests/fastbridge-refill.test.mjs).
//
//   free()          the private TAC not promised, in the pool's units (8 places), or null while it cannot be read
//   publicTac()     the TAC at the provider's own address, in the token's units (18 places)
//   allowance()     what the treasury lets this key pull, in token units; treasuryTac() what the treasury holds
//   ethOk()         whether the address holds the ETH for a pull, a deposit and a settle sent from it
//   quiet()         whether nothing else is sending from the address (a swap locking or refunding does)
//   pull(wei)       sends the pull and returns when it is mined; throws if it fails
//   shield(wei)     deposits and settles it into private notes; throws, with `deposited` set to the transaction if the deposit was made
//   load(), save()  the day's pulled total, { day, pulled }, kept across restarts
//   config          { lowWater, chunk, minShield, maxPerDay } in token units; minIntervalSecs (default 30 min) before another attempt after one
//                   that failed or found nothing to bring in, afterShieldSecs (default 1 min) after one that shielded, so what is left goes on at once

const P = 10n ** 10n;                                           // token units in one pool unit
const min = (...v) => v.reduce((a, b) => (b < a ? b : a));
const whole = (v) => v - (v % P);                               // the pool takes whole pool units

export function makeRefill({ free, publicTac, allowance, treasuryTac, ethOk, quiet = async () => true, pull, shield, load = async () => ({}), save = async () => {}, now = () => Math.floor(Date.now() / 1000), config, log = () => {}, alert = () => {} }) {
  const c = { minIntervalSecs: 1800, afterShieldSecs: 60, ...config };
  if (!(c.lowWater > 0n) || !(c.chunk > 0n) || !(c.minShield > 0n) || !(c.maxPerDay >= 0n)) throw new Error('refill: lowWater, chunk and minShield must be more than 0 and maxPerDay not below 0');
  let busy = false, nextAt = -Infinity, halted = null;
  const said = new Map();
  const sayOnce = (key, o, secs = 21600) => { if (now() - (said.has(key) ? said.get(key) : -Infinity) >= secs) { said.set(key, now()); alert(o); } };
  const dayOf = () => new Date(now() * 1000).toISOString().slice(0, 10);
  const noEth = () => { sayOnce('eth', { level: 'warn', msg: 'refill: the provider\'s own account is low on ETH, so it cannot bring in more TAC' }); return { did: 'eth' }; };

  async function step() {
    if (halted) return { did: 'halted' };
    if (busy) return { did: 'busy' };
    if (now() < nextAt) return { did: 'wait' };
    busy = true;
    try {
      let amount, pulled = 0n;
      const pub = whole(await publicTac());
      if (pub >= c.minShield) {
        // TAC at the address: shielded at any level of what is free, a chunk at a time
        if (!(await quiet())) return { did: 'quiet' };
        if (!(await ethOk())) return noEth();
        nextAt = now() + c.minIntervalSecs;
        amount = min(pub, c.chunk);
      } else {
        const f = await free();
        if (f == null) return { did: 'unread' };
        if (f * P >= c.lowWater) return { did: 'enough' };
        if (!(await quiet())) return { did: 'quiet' };
        if (!(await ethOk())) return noEth();
        nextAt = now() + c.minIntervalSecs;
        const st = await load(), day = dayOf(), today = st && st.day === day ? BigInt(st.pulled || '0') : 0n;
        const room = c.maxPerDay > today ? c.maxPerDay - today : 0n;
        const [allowed, held] = [await allowance(), await treasuryTac()];
        const want = whole(min(c.chunk, allowed, held, room));
        if (want < c.minShield) {
          sayOnce('none', { level: 'warn', msg: 'refill: private TAC is low and none can be pulled', allowance: String(allowed), treasury: String(held), pulledToday: String(today), maxPerDay: String(c.maxPerDay) });
          return { did: 'none' };
        }
        await pull(want);
        pulled = amount = want;
        await save({ day, pulled: String(today + pulled) });
        log({ level: 'info', msg: 'refill: pulled from the treasury', amount: String(amount) });
      }
      try { await shield(amount); } catch (e) {
        const why = String((e && e.message) || e).slice(0, 200);
        if (e && e.deposited) {
          // a deposit that is not settled is not repeated: the TAC is in the pool's hands until it is settled, and a second would be a second one stuck
          halted = { deposited: e.deposited, why };
          alert({ level: 'error', msg: 'refill: a deposit was made and its settle did not go through; refilling is stopped until this is looked at', deposit: e.deposited, amount: String(amount), error: why });
          return { did: 'stuck', amount };
        }
        // the deposit was not made: TAC that was pulled is at the address now, and the next attempt shields it
        alert({ level: 'warn', msg: 'refill: the TAC could not be shielded', amount: String(amount), pulled: pulled > 0n, error: why });
        return { did: 'failed', amount };
      }
      log({ level: 'info', msg: 'refill: shielded', amount: String(amount), pulled: pulled > 0n });
      nextAt = now() + c.afterShieldSecs;                       // it went well: what is left goes on after a short pause, not the long one
      return { did: 'refilled', amount, pulled };
    } catch (e) {
      alert({ level: 'warn', msg: 'refill: an attempt failed', error: String((e && e.message) || e).slice(0, 200) });
      return { did: 'failed' };
    } finally { busy = false; }
  }
  return { step, halted: () => halted };
}
