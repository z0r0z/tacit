// A loop that stops making progress (a call that never answers) stalls everything behind it: the points service runs its scanners, the daily
// settlement and the campaigns' payouts in one loop, one after another, so one hung call holds back every payout. The loop says which stage it
// is starting, and a timer that finds the same stage running for longer than `limitMs` says it has stalled, and the service restarts.
//   stage(name)  progress: a stage is starting
//   a stage still running after `warnMs` is reported once through `onSlow` (so a stall names its stage long before the limit restarts anything)
//   start()      begin watching (a limit of 0 or less watches nothing)
//   stop()       end it
export function makeLoopWatchdog({ limitMs, onStall, warnMs = 0, onSlow, now = Date.now, everyMs = 60_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let stage = 'start', at = now(), timer = null, warned = false;
  return {
    stage(name) { stage = String(name); at = now(); warned = false; },
    start() {
      if (!(limitMs > 0) || typeof onStall !== 'function' || timer) return;
      at = now();
      timer = setIntervalFn(() => {
        const idleMs = now() - at;
        if (idleMs > limitMs) onStall({ stage, idleMs });
        else if (warnMs > 0 && idleMs > warnMs && !warned && typeof onSlow === 'function') { warned = true; onSlow({ stage, idleMs }); }
      }, everyMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() { if (timer) { clearIntervalFn(timer); timer = null; } },
    current() { return { stage, idleMs: now() - at }; },
  };
}
