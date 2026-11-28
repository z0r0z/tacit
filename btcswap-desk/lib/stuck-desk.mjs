// A desk for stuck TAC (stuck TAC bounty, entry A): the pure quoting and pledge bookkeeping core.
//
// The Bitcoin-to-Bitcoin desk in btcswap-desk/server.mjs and dapp/btcswap-desk.js already swaps a note
// the bridge's proof does not follow for TAC it does, at one flat fee (30 bps plus a flat part), out of
// the desk's own wallet. That leaves three things open, which is what this module adds, as a pure rule
// in front of that desk's quoter:
//
//   - classes. A long-history note (more than 255 transfers behind it) and a pool-exit note (opcode
//     0x6d, its history cannot be followed at all) are not the same risk and should not swap at the
//     same discount. Intake classifies a note exactly as entry C's pricing rule does, from the same
//     reads the screens already make (the reflection trace, as in lineageScreen in dapp/fast/wire.js),
//     so a provider running both sees one set of classes.
//   - a bounded discount per class, funded by pledged tracked TAC. The discount is read from the
//     desk's own config but clamped in code to a hard band per class, and a quote is never made at an
//     effective price below the floor the config states for that class. The defaults are entry C's
//     fees for the two stuck classes (3,680 and 4,255 bps), so the desk and the pricing rule quote
//     one schedule: a holder pays the same haircut whichever door they take.
//   - pledge accounting. The tracked TAC a desk can lock does not have to sit in the desk's one
//     wallet. Providers pledge tracked TAC to the desk; this module keeps the book — who pledged
//     what, what is reserved against open quotes, what has settled — per pledger.
//
// What this module is not: it holds no key, signs nothing, locks nothing and settles nothing. It is
// bookkeeping and quoting only. In the model implemented here the desk never takes custody of pledged
// funds under one key: a pledger's tracked TAC stays in the pledger's own wallet until the pledger
// itself locks it into a swap the desk has quoted (the two-lock swap of dapp/btcswap.js, where the
// desk's half can equally be a pledger's half), and the book below is how the desk knows whose TAC a
// quote may promise. Wiring that lock step to a pledger's own daemon is the pledger's, and is not
// done here; see the write-up (docs/STUCK-TAC-ENTRY-A.md) for what was not tested.
//
// Safe by default:
//   - a note whose history could not be read is refused (retry), never classified by a guess — the
//     same answer lineageScreen gives today;
//   - a clean note is refused: it bridges over the regular bridge, and the desk would only charge it
//     for nothing;
//   - every limit is stated in config and enforced here: a per-note cap, a per-day cap on what the
//     desk pays out, a largest share of pledged inventory one quote may take, and a reserve of
//     pledged inventory that is never quoted away;
//   - a config cannot talk the desk out of its bounds: discounts outside the hard band are clamped,
//     and a floor no allowed discount can honour disables the class instead of breaking the floor.
// Amounts are base units (1 TAC = 1e8), as everywhere in the repo; money is BigInt, rates are bps.

export const HISTORY_LIMIT = 255; // transfers; the burn proof folds at most this many (ncx > 256 refuses)

export const CLASS = Object.freeze({
  CLEAN: 'clean',               // the proof follows the note home: it bridges like any other
  LONG_HISTORY: 'long-history', // more than HISTORY_LIMIT transfers behind it
  POOL_EXIT: 'pool-exit',       // left the Bitcoin shielded pool (opcode 0x6d)
  UNKNOWN: 'unknown',           // the trace could not be read, or read as none of the above
});

// The classes in the order a lock takes the worst of (same order as entry C).
const WORST_FIRST = [CLASS.POOL_EXIT, CLASS.LONG_HISTORY, CLASS.CLEAN];

// The hard band a class's discount may sit in, whatever the config says. The top of the band is the
// most of a note's face the desk may ever keep: past it a "swap" is a confiscation with extra steps.
// The bottom is the least it may keep: below it the desk is paying out tracked TAC at a loss against
// a note it can only realise at a discount, and its pledged inventory drains.
export const DISCOUNT_BAND_BPS = Object.freeze({
  [CLASS.LONG_HISTORY]: Object.freeze({ min: 500, max: 6000 }),
  [CLASS.POOL_EXIT]: Object.freeze({ min: 1000, max: 7500 }),
});

// Safe defaults. The discounts are entry C's fees for the same classes (base 30 + haircut + lockup),
// so the two entries quote one schedule. Floors are the least share of face, in bps, a holder is ever
// offered for a note of the class: the desk's promise that it never buys cheaper than this, readable
// in its own config, as the brief requires of a floor. Caps are in base units; shares and the reserve
// are in bps of total pledged inventory.
export const DEFAULT_DESK_CONFIG = Object.freeze({
  enabled: true,
  validSecs: 600,
  quote: Object.freeze({
    minAmount: '100000000',      // 1 TAC: below this the two locks cost more than the swap is worth
    maxAmount: '100000000000',   // 1,000 TAC per note (the per-note cap)
    maxDayOut: '500000000000',   // 5,000 TAC paid out per day, across all quotes
    maxShareBps: 2000,           // one quote takes at most 20% of pledged inventory
    reserveBps: 1000,            // the last 10% of pledged inventory is never quoted away
  }),
  discountBps: Object.freeze({ [CLASS.LONG_HISTORY]: 3680, [CLASS.POOL_EXIT]: 4255 }),
  floorBps: Object.freeze({ [CLASS.LONG_HISTORY]: 4000, [CLASS.POOL_EXIT]: 2500 }),
});

// A note as the screens read it: { trace: 'tracked' | 'unprovable' | 'unread', poolExit, transfers }.
// Same reading, and the same answers, as entry C's classifyNote, so the two entries never disagree
// about what a note is.
export function classifyNote(note) {
  if (!note || typeof note !== 'object') return CLASS.UNKNOWN;
  if (note.poolExit) return CLASS.POOL_EXIT;
  if (note.trace === 'unread' || note.trace == null) return CLASS.UNKNOWN;
  const transfers = Number(note.transfers);
  if (!Number.isFinite(transfers) || transfers < 0) return CLASS.UNKNOWN;
  if (transfers > HISTORY_LIMIT) return CLASS.LONG_HISTORY;
  // a history the proof cannot follow, that is no pool exit and within the count, is stuck all the
  // same: the proof cannot carry it home, so the desk treats it as long history, the cheaper class
  // only because its transfers can still be counted.
  if (note.trace === 'unprovable') return CLASS.LONG_HISTORY;
  if (note.trace === 'tracked') return CLASS.CLEAN;
  return CLASS.UNKNOWN;
}

// The class of a lock is the worst class of the notes it spends; any unknown note makes the lock
// unknown, and unknown is refused downstream, never averaged away.
export function classifyLock(notes) {
  if (!Array.isArray(notes) || !notes.length) return CLASS.UNKNOWN;
  const classes = notes.map(classifyNote);
  if (classes.includes(CLASS.UNKNOWN)) return CLASS.UNKNOWN;
  return WORST_FIRST.find((c) => classes.includes(c)) || CLASS.UNKNOWN;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const bpsOr = (v, dflt) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : dflt);
const unitsOr = (v, dflt) => {
  try { const b = BigInt(v); return b >= 0n ? b : dflt; } catch { return dflt; }
};

// The desk's policy, read from its config and made safe: discounts clamped into the hard band, the
// floor applied on top (a quote's effective price, 10,000 - discount, never drops below the floor,
// so the discount never exceeds 10,000 - floor), and a class whose floor even the band's smallest
// discount cannot honour is disabled outright — the desk refuses the class rather than break either
// bound. Amounts come back as BigInt, rates as bps numbers, as in the rest of the repo.
export function deskPolicy(raw = {}) {
  const q = (raw && raw.quote) || {};
  const quote = {
    minAmount: unitsOr(q.minAmount, BigInt(DEFAULT_DESK_CONFIG.quote.minAmount)),
    maxAmount: unitsOr(q.maxAmount, BigInt(DEFAULT_DESK_CONFIG.quote.maxAmount)),
    maxDayOut: unitsOr(q.maxDayOut, BigInt(DEFAULT_DESK_CONFIG.quote.maxDayOut)),
    maxShareBps: clamp(bpsOr(q.maxShareBps, DEFAULT_DESK_CONFIG.quote.maxShareBps), 1, 10000),
    reserveBps: clamp(bpsOr(q.reserveBps, DEFAULT_DESK_CONFIG.quote.reserveBps), 0, 10000),
  };
  const classes = {};
  for (const cls of [CLASS.LONG_HISTORY, CLASS.POOL_EXIT]) {
    const band = DISCOUNT_BAND_BPS[cls];
    const wanted = bpsOr(raw?.discountBps?.[cls], DEFAULT_DESK_CONFIG.discountBps[cls]);
    const floorBps = clamp(bpsOr(raw?.floorBps?.[cls], DEFAULT_DESK_CONFIG.floorBps[cls]), 0, 10000);
    // the floor caps the discount: the holder is always offered at least floorBps of face
    const discountBps = clamp(wanted, band.min, Math.min(band.max, 10000 - floorBps));
    classes[cls] = { discountBps, floorBps, enabled: band.min <= 10000 - floorBps && discountBps >= band.min };
  }
  return {
    enabled: raw?.enabled !== false,
    validSecs: Number.isFinite(Number(raw?.validSecs)) && Number(raw.validSecs) > 0 ? Math.trunc(Number(raw.validSecs)) : DEFAULT_DESK_CONFIG.validSecs,
    quote, classes,
  };
}

// The pledge book: per-pledger accounting of tracked TAC pledged to the desk. Pure bookkeeping — it
// moves nothing and holds no key (see the header). A quote reserves against pledges in the order
// they were made; settling a quote charges its reservations to the pledgers, releasing one frees
// them. A pledger can withdraw only what is neither reserved nor settled.
export function makePledgeBook() {
  const pledgers = new Map(); // id -> { pledged, reserved, settled } (BigInt base units)
  const reservations = new Map(); // quoteId -> [{ pledger, amount }]
  const row = (id) => {
    if (!pledgers.has(id)) pledgers.set(id, { pledged: 0n, reserved: 0n, settled: 0n });
    return pledgers.get(id);
  };
  const total = (k) => [...pledgers.values()].reduce((s, r) => s + r[k], 0n);
  return {
    pledge(id, amount) {
      const a = BigInt(amount);
      if (a <= 0n) throw new Error('a pledge must be a positive amount');
      row(String(id)).pledged += a;
      return this.pledger(id);
    },
    // what a pledger may still take back: pledged, less what open quotes hold and what has settled
    withdrawable(id) { const r = row(String(id)); return r.pledged - r.reserved - r.settled; },
    withdraw(id, amount) {
      const a = BigInt(amount), r = row(String(id));
      if (a <= 0n || a > r.pledged - r.reserved - r.settled) return false;
      r.pledged -= a;
      return true;
    },
    pledger(id) { const r = row(String(id)); return { pledged: r.pledged, reserved: r.reserved, settled: r.settled, available: r.pledged - r.reserved - r.settled }; },
    pledgers() { return [...pledgers.keys()]; },
    totalPledged() { return total('pledged'); },
    totalReserved() { return total('reserved'); },
    totalSettled() { return total('settled'); },
    available() { return total('pledged') - total('reserved') - total('settled'); },
    // Reserve `amount` for a quote, oldest pledge first. All or nothing: a short book reserves none.
    reserve(quoteId, amount) {
      const a = BigInt(amount);
      if (reservations.has(quoteId) || a <= 0n) return false;
      if (this.available() < a) return false;
      const parts = [];
      let left = a;
      for (const [id, r] of pledgers) {
        if (!left) break;
        const free = r.pledged - r.reserved - r.settled;
        if (free <= 0n) continue;
        const take = free < left ? free : left;
        r.reserved += take; left -= take;
        parts.push({ pledger: id, amount: take });
      }
      reservations.set(quoteId, parts);
      return true;
    },
    // The swap happened: the reserved tracked TAC has left the pledgers for the holder.
    settle(quoteId) {
      const parts = reservations.get(quoteId);
      if (!parts) return false;
      for (const p of parts) { const r = row(p.pledger); r.reserved -= p.amount; r.settled += p.amount; }
      reservations.delete(quoteId);
      return true;
    },
    // The swap did not happen (expired, refused, refunded): the reservation is freed whole.
    release(quoteId) {
      const parts = reservations.get(quoteId);
      if (!parts) return false;
      for (const p of parts) row(p.pledger).reserved -= p.amount;
      reservations.delete(quoteId);
      return true;
    },
    reservation(quoteId) { const p = reservations.get(quoteId); return p ? p.map((x) => ({ ...x })) : null; },
  };
}

// The desk itself: quotes against a pledge book, under a policy, with the day counted from the
// injected clock (now() in seconds, as the desk server injects). Quote ids are a desk-local
// sequence here; a running desk names its swaps by the holder's lock, as dapp/btcswap-desk.js does,
// and would key its quotes the same way.
export function makeStuckDesk({ policy = deskPolicy(), pledges = makePledgeBook(), now = () => Math.floor(Date.now() / 1000) } = {}) {
  const P = policy;
  const open = new Map(); // quoteId -> quote
  let seq = 0, dayKey = null, outToday = 0n;
  const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const rollDay = (t) => { const d = dayOf(t); if (d !== dayKey) { dayKey = d; outToday = 0n; } };

  // req = { notes: [note, ...] } or { note }, and amount in base units (BigInt or its string).
  function quote(req = {}) {
    const no = (why, retry = false) => ({ ok: false, retry, why });
    if (!P.enabled) return no('this desk is not quoting');
    const notes = req.notes || (req.note ? [req.note] : []);
    const cls = classifyLock(notes);
    if (cls === CLASS.UNKNOWN) return no('the history of a note could not be read just now', true);
    if (cls === CLASS.CLEAN) return no('this note bridges over the regular bridge; the desk adds nothing');
    const c = P.classes[cls];
    if (!c || !c.enabled) return no(`this desk does not take ${cls} notes at its stated floor`);
    let amount;
    try { amount = BigInt(req.amount); } catch { return no('amount must be a whole number of base units'); }
    if (amount < P.quote.minAmount) return no('amount below this desk\'s minimum');
    if (amount > P.quote.maxAmount) return no('amount above this desk\'s per-note cap');
    const out = (amount * BigInt(10000 - c.discountBps)) / 10000n;
    if (out <= 0n) return no('the amount does not cover the discount');
    // the floor, checked on the quote itself, not just on the policy: rounding never breaks it
    if (out * 10000n < amount * BigInt(c.floorBps)) return no('the quote would price below this desk\'s floor for the class');
    const t = now(); rollDay(t);
    if (outToday + out > P.quote.maxDayOut) return no('this desk has paid out its limit for today');
    const pledged = pledges.totalPledged();
    if (pledged <= 0n) return no('this desk holds no pledged tracked TAC just now', true);
    if (out * 10000n > pledged * BigInt(P.quote.maxShareBps)) return no('the quote would take too large a share of pledged inventory');
    const reserveFloor = (pledged * BigInt(P.quote.reserveBps)) / 10000n;
    if (pledges.available() - out < reserveFloor) return no('the quote would spend the desk\'s reserve of pledged inventory');
    const id = `q${++seq}`;
    if (!pledges.reserve(id, out)) return no('this desk does not hold that much pledged tracked TAC just now', true);
    const q = {
      id, class: cls, amountIn: amount, amountOut: out, discountBps: c.discountBps,
      priceBps: 10000 - c.discountBps, validUntil: t + P.validSecs, day: dayKey,
    };
    open.set(id, q); outToday += out;
    return { ok: true, quote: { ...q } };
  }

  // The holder took the quote and the swap settled: the reservation is charged to the pledgers.
  function accept(id) {
    const q = open.get(String(id));
    if (!q) return { ok: false, why: 'unknown quote' };
    if (now() > q.validUntil) { pledges.release(q.id); open.delete(q.id); return { ok: false, why: 'quote expired' }; }
    pledges.settle(q.id); open.delete(q.id);
    return { ok: true, quote: { ...q } };
  }

  // A quote the holder let lapse, or the desk calls back: its reservation is freed whole.
  function release(id) {
    const q = open.get(String(id));
    if (!q) return false;
    pledges.release(q.id); open.delete(q.id);
    return true;
  }

  // Free every quote whose time has run out; a running desk calls this on its tick.
  function sweep() {
    const t = now(); let freed = 0;
    for (const q of [...open.values()]) if (t > q.validUntil) { pledges.release(q.id); open.delete(q.id); freed++; }
    return freed;
  }

  return {
    quote, accept, release, sweep,
    openQuotes: () => [...open.values()].map((q) => ({ ...q })),
    outToday: () => { rollDay(now()); return outToday; },
    pledges, policy: P,
  };
}
