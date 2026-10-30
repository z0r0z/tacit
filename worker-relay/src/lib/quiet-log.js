// A stage that is waiting on purpose says so once, then again every few minutes, instead of every poll: a lane that waits a few hours
// for a cheaper block or a top-up wrote the same line (with figures that moved in the fourth decimal) several hundred times a day,
// which buried the lines that matter and read as a fault. A line is written when the reason changes (`key`), and again after
// `everyMs` while it stays the same. One logger per stage.
export function makeQuietLog(log, { everyMs = 10 * 60_000, now = () => Date.now() } = {}) {
  let lastKey = null, lastAt = 0;
  const say = (key, text) => {
    const t = now();
    if (key === lastKey && t - lastAt < everyMs) return false;
    lastKey = key; lastAt = t;
    log(text);
    return true;
  };
  // Whether `say(key, ...)` would write now, for a caller that has to do some work to make the line.
  say.due = (key) => key !== lastKey || now() - lastAt >= everyMs;
  // Waiting is over (or the work went ahead): the next wait is announced again, whatever it is.
  say.reset = () => { lastKey = null; };
  return say;
}
