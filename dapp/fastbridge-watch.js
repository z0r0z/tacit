// A watchdog over a side's swaps: a swap whose step has not moved for longer than that step should take is read afresh, once a minute while it stays so (every
// read the side keeps that could stand in its way let go, and the swap stepped at once), and said (a log, then an alert) so an operator sees it.
//
//   const w = makeWatchdog({ now, budget(rec) -> secs | null, keyOf(rec), forget(), kick(rec), log, alert, sayAfterSecs, quiet(rec) })
//   quiet(rec): a step that may rightly wait long (a counterparty's claim) is read afresh but not alerted on, unless the swap says it is failing
//   await w.look(rec)   -> null, or { still, budget } while the swap is stuck
//
// `budget` gives a step's own time, or null for a step that waits on something with no time of its own (a Bitcoin block, a counterparty that may never come:
// those end by their own timelock or deadline). `keyOf` names what the step waits on: any change to it is a move.

export function makeWatchdog({ now, budget, keyOf, forget = () => {}, kick = async () => {}, log = () => {}, alert = () => {}, sayAfterSecs = 300, everySecs = 60, quiet = () => false }) {
  const moved = new Map(), forced = new Map(), said = new Map();
  async function look(rec) {
    const key = keyOf(rec), m = moved.get(rec.id), t = now();
    if (!m || m.key !== key) { moved.set(rec.id, { key, at: t }); forced.delete(rec.id); said.delete(rec.id); return null; }
    const b = budget(rec), still = t - m.at;
    if (b == null || still <= b) return null;
    if (t - (forced.get(rec.id) ?? -Infinity) >= everySecs) {
      forced.set(rec.id, t);
      log({ level: 'warn', msg: 'a swap has not moved for longer than its step takes: read afresh', id: rec.id, phase: rec.phase, still });
      try { await forget(); await kick(rec); } catch (e) { log({ level: 'warn', msg: 'a fresh read of a stuck swap failed', id: rec.id, error: String((e && e.message) || e).slice(0, 160) }); }
    }
    if (still > b + sayAfterSecs && !said.has(rec.id) && !quiet(rec)) { said.set(rec.id, t); alert({ level: 'alert', msg: 'a swap is stuck: it has not moved for longer than its step takes, though read afresh', id: rec.id, phase: rec.phase, still, error: rec.lastError || null }); }
    return { still, budget: b };
  }
  return { look, forget: (id) => { moved.delete(id); forced.delete(id); said.delete(id); } };
}
