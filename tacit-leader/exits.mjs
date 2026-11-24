// Exits the leader pays out. A block that lands an exit only credits the address (TacitBlocks.owed); the TAC reaches it when anyone calls
// withdraw(address). The leader does, right after the landing, and keeps each address until the contract owes it nothing, so a send that failed,
// a node a block behind that read 0 owed, a restart, or a block another leader landed does not leave a holder waiting for good (one holder's
// 151.9 TAC waited two days when the single pass after a landing skipped it). Every call is bounded and a pass has a time budget, so a slow node
// cannot hold the block loop. Pure but for the calls it is given, so tested: tests/tacit-leader-exits.test.mjs.
import { bytesOf, hexOf } from './abi.mjs';

const EXIT_LEN = 96;                                       // an exit in a block's list: asset ‖ amount ‖ address
const ZERO_FIRST = 10_000, ZERO_MAX = 60_000;              // a zero read from a block just landed is read again after 10 s, doubling to a minute
const FAIL_FIRST = 30_000, FAIL_MAX = 10 * 60_000;         // a payout that failed is tried again after 30 s, doubling to 10 minutes
const MAX_TRIES = 12;                                      // and let go after this many failures (a restart lists it again if it is still owed)

/// The addresses a block's exit list credits, each once, as 0x + 40 hex.
export function exitsIn(list) {
  const b = bytesOf(list || '0x'), out = [];
  for (let i = 0; i + EXIT_LEN <= b.length; i += EXIT_LEN) {
    const to = hexOf(b.subarray(i + 76, i + 96));
    if (!out.includes(to)) out.push(to);
  }
  return out;
}

/// What is to be paid, in memory (a restart reads the archive's blocks again). An item: { at, next, fresh, zeros, tries, attempted }.
///   fresh: the exit is from a block that has just landed, so a node a block behind may still read 0 owed: a zero read is believed only `rest` ms after
///   it was listed (or at once if a payout was already tried). An exit read back from the archive at a start is not fresh: a zero read is believed.
export function makeExitLedger({ rest = 300_000 } = {}) {
  const items = new Map(), busy = new Set();
  return {
    size: () => items.size,
    has: (to) => items.has(to),
    /// Lists the addresses; one already listed is made due at once (and fresh again if this is). → how many were new.
    owe(tos, { now = Date.now(), fresh = true } = {}) {
      let n = 0;
      for (const to of tos) {
        const it = items.get(to);
        if (!it) { items.set(to, { at: now, next: now, fresh, zeros: 0, tries: 0, attempted: false }); n++; } else { it.next = now; if (fresh) { it.at = now; it.fresh = true; it.zeros = 0; } }
      }
      return n;
    },
    /// The addresses whose turn has come, soonest first, at most `max`.
    due(now = Date.now(), max = 12) {
      return [...items].filter(([to, it]) => it.next <= now && !busy.has(to)).sort((a, b) => a[1].next - b[1].next).slice(0, max).map(([to]) => to);
    },
    /// The contract owes it nothing. → true if it is let go (paid out, by anyone), false if it is read again later.
    zero(to, now = Date.now()) {
      const it = items.get(to);
      if (!it) return true;
      if (!it.fresh || it.attempted || now - it.at >= rest) { items.delete(to); return true; }
      it.zeros++;
      it.next = now + Math.min(ZERO_MAX, ZERO_FIRST * 2 ** (it.zeros - 1));
      return false;
    },
    paid(to) { items.delete(to); },
    /// A payout begun and not yet settled: its address is not due again (and so not paid twice) while the call is still out, even after the pass gave up waiting for it.
    hold(to, promise) { busy.add(to); const free = () => busy.delete(to); Promise.resolve(promise).then(free, free); },
    /// A payout that failed. → { tries, dropped }.
    failed(to, now = Date.now()) {
      const it = items.get(to);
      if (!it) return { tries: 0, dropped: true };
      it.tries++;
      it.attempted = true;
      if (it.tries >= MAX_TRIES) { items.delete(to); return { tries: it.tries, dropped: true }; }
      it.next = now + Math.min(FAIL_MAX, FAIL_FIRST * 2 ** (it.tries - 1));
      return { tries: it.tries, dropped: false };
    },
  };
}

const said = (e) => String(e?.message || e).slice(0, 200);
/// `p`, or a rejection after `ms`: the call is not cancelled, but the pass moves on.
const within = (ms, p, what) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`${what} took over ${Math.round(ms / 1000)} s`)), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

/// One pass over what is due. `owed(to)`: what the contract owes the address (a bigint or a number string). `pay(to)`: sends withdraw(to) and gives the
/// transaction hash once it is mined; it throws if it could not. A read or a payout that throws or runs long is tried again after a rest that doubles each
/// time; the pass stops starting new ones after `budgetMs`, reads at most `reads` addresses and sends at most `sends` (the rest stay due for the next).
export async function payExits({ ledger, owed, pay, now = () => Date.now(), log = () => {}, budgetMs = 60_000, readMs = 30_000, payMs = 150_000, reads = 12, sends = 3 }) {
  const t0 = now();
  let paid = 0, sent = 0;
  for (const to of ledger.due(t0, reads)) {
    if (now() - t0 >= budgetMs) break;
    try {
      const o = BigInt(await within(readMs, owed(to), 'reading what is owed'));
      if (!(o > 0n)) { ledger.zero(to, now()); continue; }
      if (sent >= sends) continue;
      sent++;
      const call = pay(to);
      ledger.hold(to, call);
      const tx = await within(payMs, call, 'the payout');
      ledger.paid(to);
      paid++;
      log({ paidOut: to, tx });
    } catch (e) {
      const r = ledger.failed(to, now());
      log({ payOutFailed: to, tries: r.tries, ...(r.dropped ? { gaveUp: true } : {}), error: said(e) });
    }
  }
  return { paid, left: ledger.size() };
}
