// Runs the points service's loop stages so that one that hangs cannot freeze the rest. The service runs its scanners, the daily settlement and the
// campaigns' payouts in one loop; a call that never answers in any one of them held every payout back (twice, 2026-11-14 and before). A stage still
// running after `budgetMs` is left to finish in the background and the loop goes on; while its last run is still going its next turn is skipped,
// because two runs of one scanner at once would read the same blocks twice. A stage that finishes in time returns what it returned or throws what
// it threw, so the loop's own handling of a failed stage is unchanged.
//   run(name, fn) -> { value } | { late: true } | { skipped: true }
const LATE = Symbol('late');

export function makeStageRunner({ budgetMs, log = () => {}, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const running = new Map();   // stage name -> { startedAt, said }
  return async function run(name, fn) {
    const prior = running.get(name);
    if (prior) {
      if (!prior.said) { prior.said = true; log(`stage "${name}" is still running from ${Math.max(1, Math.round((now() - prior.startedAt) / 60000))} min ago: this cycle skips it`); }
      return { skipped: true };
    }
    const entry = { startedAt: now(), said: false };
    running.set(name, entry);
    const work = Promise.resolve().then(fn).finally(() => { if (running.get(name) === entry) running.delete(name); });
    if (!(budgetMs > 0)) { return { value: await work }; }
    let timer;
    const late = new Promise((resolve) => { timer = setTimeoutFn(() => resolve(LATE), budgetMs); });
    try {
      const r = await Promise.race([work, late]);
      if (r === LATE) {
        log(`stage "${name}" has run past ${Math.max(1, Math.round(budgetMs / 60000))} min: the loop goes on without it, and it keeps running`);
        work.catch((err) => log(`stage "${name}" failed after the loop went on:`, err?.message || err));
        return { late: true };
      }
      return { value: r };
    } finally {
      clearTimeoutFn(timer);
    }
  };
}
