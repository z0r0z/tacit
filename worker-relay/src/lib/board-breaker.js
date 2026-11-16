// A circuit breaker for the prover board, per op type (lib/prover.js viaBoard).
//
// A worker that claims a settle proof and sends nothing holds the job for the whole claim-stall wait (100 s) before the relay hands it to the prover
// network, and the next job of that type would be held the same way. After `stalls` such misses in a row for one op type the board is skipped for
// that type for `restMs`: the job goes straight to the network, and the board is tried again once the rest is over (one more stall rests it again at
// once, and a proof from the board clears the count; any other miss leaves it where it was). Only a worker that claimed and went silent counts: a board with no worker is already skipped without
// a wait (lib/board-prover.js `alive`), a proof the pool refused is another matter, and a board that proves in time is the board working.
// Pure but for the clock, so tested: worker-relay/tests/board-breaker.test.mjs.
export const typeOf = (label) => String(label || '').replace(/\(\d+\)$/, '').trim() || 'op';

export function makeBoardBreaker({ stalls = 3, restMs = 600_000, now = Date.now } = {}) {
  const on = stalls > 0 && restMs > 0;
  const state = new Map();   // type -> { n, until }
  const get = (t) => { let s = state.get(t); if (!s) { s = { n: 0, until: 0 }; state.set(t, s); } return s; };
  return {
    // → null when the board may be tried for this label, else the seconds left of its rest
    resting(label) {
      if (!on) return null;
      const s = state.get(typeOf(label));
      if (!s || s.until <= now()) return null;
      return Math.ceil((s.until - now()) / 1000);
    },
    // A claimed job that said nothing; → true when this one started (or restarted) the rest
    stalled(label) {
      if (!on) return false;
      const s = get(typeOf(label));
      s.n += 1;
      if (s.n >= stalls) { s.until = now() + restMs; return true; }
      return false;
    },
    // A proof from the board: the count starts again
    proved(label) {
      const s = state.get(typeOf(label));
      if (s) { s.n = 0; s.until = 0; }
    },
    snapshot() { return [...state.entries()].map(([type, s]) => ({ type, stalls: s.n, restingSecs: s.until > now() ? Math.ceil((s.until - now()) / 1000) : 0 })); },
  };
}
