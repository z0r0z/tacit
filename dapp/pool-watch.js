// Watches a pool while a proof made against its exact reserves is being made, so a proof a trade has already ended is not waited for to the end.
//
// An add to a pool is proved against the reserves it had when it was built and is taken only while it still has them: a trade that lands first ends the proof for good, and
// the proof is minutes of the relay's work. `read()` answers the pool's state as a string (reserves and shares); the first answer is the baseline and a different one is a move.
// A read that fails, or finds no pool, says nothing: it is never taken for a move, the nodes behind it are asked more slowly while they fail (`every`, doubling to `slowest`),
// and the page's own check when the proof arrives is what answers then. One answer from a node a block behind is not a move either: a state other than the baseline has to be
// seen on `confirm` reads in a row, and the same one each time. Reads never overlap, and one that has not answered in `readMs` is given up on (and the next one asked).
// The watch ends by itself after `lifeMs`.
//
//   const w = watchPool({ read, onMove });   w.moved   w.stop()   await w.done
export function watchPool({ read, every = 15e3, slowest = 60e3, confirm = 2, readMs = 20e3, lifeMs = 30 * 60e3, wait = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), onMove = () => {} } = {}) {
  const w = { moved: false, stopped: false, reads: 0, failed: 0, base: null, done: null, stop() { w.stopped = true; } };
  const ask = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('a read took too long')), readMs);
    Promise.resolve().then(read).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  w.done = (async () => {
    const end = now() + lifeMs;
    let seen = null, run = 0, fails = 0;
    while (!w.stopped && now() < end) {
      let state = null;
      try { state = await ask(); w.reads++; } catch { w.failed++; }
      if (w.stopped) break;
      if (state == null) fails++;
      else {
        fails = 0;
        if (w.base == null) w.base = state;
        else if (state === w.base) { seen = null; run = 0; }
        else {
          if (state === seen) run++; else { seen = state; run = 1; }
          if (run >= confirm) { w.moved = true; try { onMove(); } catch { } break; }
        }
      }
      await wait(fails ? Math.min(slowest, every * 2 ** Math.min(fails, 4)) : every);
    }
  })();
  return w;
}

// One proof of an add, made again when a trade ends it. `go(hook)` makes the proof: it passes the wait options it hands the relay through `hook`, which names the pool to the
// watch once the job is sent for and makes the relay's next pause throw (`moved: true, early: true`) when the watch has seen a trade, so the wait ends then and not at the end of a
// proof nothing can send. An error that says the pool moved (`moved`, which the page's own send of a proof that arrives too late also says) is tried again, `tries` in all, calling
// `again(n, tries, e, jobId)` first (to say so, and to end the job that was given up on, named by `jobId` when the try had sent one); the last one is `giveUp()`. Any other error, and any while the person has gone (`away()`), is
// thrown as it is. The watch ends with each try, however it ends.
export async function proveAgain({ go, read, tries = 3, away = () => false, again = () => {}, giveUp = (e) => e, watch = watchPool }) {
  for (let n = 1; ; n++) {
    let w = null, jobId = null;
    const hook = (opts) => {
      const pause = opts.sleep, sent = opts.onJob;
      return {
        ...opts,
        onJob: (id, type) => { jobId = id; if (sent) sent(id, type); w ||= watch({ read }); },
        sleep: async (ms) => {
          if (pause) await pause(ms); else await new Promise((r) => setTimeout(r, ms));
          if (w?.moved && !away()) throw Object.assign(new Error('The pool traded while this was being proved.'), { moved: true, early: true });
        },
      };
    };
    try { return await go(hook); }
    catch (e) {
      if (!e?.moved || away()) throw e;
      if (n >= tries) throw giveUp(e);
      again(n + 1, tries, e, jobId);
    } finally { w?.stop(); }
  }
}
