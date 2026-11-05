// The header feeder's reader of Bitcoin explorers (Esplora): a list of bases, a pass over the ones that are not resting, the last good one first.
//
// An explorer that answers 429 is asked to be left alone, and the feeder is one client among thousands on a shared address: the public
// explorers rate-limit it for hours at a stretch (2026-11-05: 52 "the Bitcoin explorers did not answer (429)" between 02:41 and 14:29, the relay
// tip 17 blocks behind Bitcoin, attests three hours apart). The reader it replaces asked each of three explorers three times in about twenty
// seconds on every cycle, which is the pattern that keeps a limit in place, and it forgot at once what it had learned. This one:
//  - rests a source that answered 429 or 503 for what it asked (Retry-After, up to maxRestMs) or for restMs, doubling for each answer in a row
//    up to maxRestMs, and a source that failed another way (a timeout, a 5xx, a network error) for errorRestMs;
//  - starts the next read at the source that last answered, so a healthy explorer is not left for a resting one;
//  - treats a 404 as "this source does not have it (yet)": the next is asked, nothing rests (a source one block behind is not a rate limit);
//  - when every source is resting, waits for the soonest only if that is within maxWaitMs, else fails at once with no request made.
// A failure reads `esplora <path>: <what the last source said>`, the shape the feeder recognises as a wait and not a fault.

export function makeEsploraReader(bases, {
  fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = 15_000, restMs = 60_000, maxRestMs = 600_000, errorRestMs = 15_000, maxWaitMs = 20_000, log = () => {},
} = {}) {
  const list = bases.map((b) => String(b).trim().replace(/\/$/, '')).filter(Boolean);
  if (!list.length) throw new Error('no explorer bases');
  const host = (b) => b.replace(/^https?:\/\//, '').split('/')[0];
  const state = list.map(() => ({ until: 0, streak: 0 }));
  let last = 0;

  async function get(path, waited = false) {
    let err = null, asked = 0;
    for (let k = 0; k < list.length; k++) {
      const i = (last + k) % list.length;
      if (state[i].until > now()) continue;
      asked++;
      try {
        const r = await fetchImpl(list[i] + path, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) { state[i].streak = 0; last = i; return (await r.text()).trim(); }
        err = new Error(String(r.status));
        if (r.status === 429 || r.status === 503) {
          const said = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : NaN);
          state[i].streak++;
          const rest = Number.isFinite(said) && said > 0 ? Math.min(said * 1000, maxRestMs) : Math.min(restMs * 2 ** (state[i].streak - 1), maxRestMs);
          state[i].until = now() + rest;
          log(`${host(list[i])} answered ${r.status}: resting it ${Math.round(rest / 1000)} s`);
        } else if (r.status >= 500) {
          state[i].until = now() + errorRestMs;
        }
        // a 404 or another 4xx: not rate-limited, just not there; the next source may have it
      } catch (e) {
        err = e;
        state[i].until = now() + errorRestMs;
      }
    }
    if (!asked) {
      // every source is resting
      const wait = Math.min(...state.map((s) => s.until)) - now();
      if (!waited && wait <= maxWaitMs) { await sleep(Math.max(0, wait)); return get(path, true); }
      err = new Error('429 (every explorer is resting)');
    }
    throw new Error(`esplora ${path}: ${err && err.message}`);
  }

  return { get, state: () => state.map((s, i) => ({ base: list[i], restingFor: Math.max(0, s.until - now()), streak: s.streak })) };
}
