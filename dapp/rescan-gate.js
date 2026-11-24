// When opening the Bitcoin sheet may look again for shielded TAC sent to the open key. The first look at a key is the page's one deep look (a key that has
// not had it gets that); after it, a look on open finds a payment that came later without a press, at most once in `every`, a short `retry` after one that could
// not read every transfer, and never two at once.
export function makeRescanGate({ every = 10 * 60e3, retry = 2 * 60e3, now = () => Date.now() } = {}) {
  let pub = null, at = 0, on = false;
  return {
    // 'deep' (the key has not had its first look: that look is made instead), 'rescan', or null (not now). `looking`: a look is already running elsewhere.
    next(p, { searched = true, looking = false } = {}) {
      if (!p || on || looking) return null;
      if (!searched) return 'deep';
      return pub === p && now() - at < every ? null : 'rescan';
    },
    begin(p) { pub = p; at = now(); on = true; },
    end(failed = false) { on = false; if (failed) at = now() - (every - retry); },
    get running() { return on; },
  };
}
