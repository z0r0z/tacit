// Notes waiting on the reflection: the page that finds a note of its own "not ready yet" (a bought Bitcoin note on its way home)
// tells the API which block it waits on (POST /reflection/wait), and the lane reads the heights back here. Beside a bonded cBTC lock
// (lib/reflection-demand.js) it is the other sign that someone waits on Bitcoin state right now, so the header feeder does not hold
// headers for cheap gas and the attest gate does not gather blocks for company while it does.
//
//   const read = makeNoteWaitsReader({ workerBase, network, boxToken });
//   const waits = await read();                      // [{ height, at }] lowest first, or null when the API cannot be read
//   noteWaitNeed({ waits, attested, relayTip, confirmations })
//     → { headers, attest, waiting, lowest }  headers: a wait needs the relay's tip moved on (its block is not yet `confirmations` deep
//       there); attest: a wait's block is matured on the relay and not yet attested; waiting: the waits above the attested height.

export function makeNoteWaitsReader({ workerBase, network, boxToken, fetchImpl = fetch, cacheMs = 60_000, now = Date.now } = {}) {
  let hit = null;
  return async function read() {
    if (hit && now() - hit.at < cacheMs) return hit.waits;
    try {
      const v = (x) => (typeof x === 'function' ? x() : x);   // the lane's CFG reads its env lazily, so these may be getters
      const r = await fetchImpl(`${v(workerBase)}/reflection/wait?network=${v(network)}`, { headers: { authorization: `Bearer ${v(boxToken)}` }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      const j = await r.json();
      const waits = Array.isArray(j?.waits) ? j.waits.filter((w) => Number.isInteger(w?.height)).sort((a, b) => a.height - b.height) : [];
      hit = { at: now(), waits };
      return waits;
    } catch { return null; }
  };
}

export function noteWaitNeed({ waits, attested, relayTip, confirmations }) {
  const none = { headers: false, attest: false, waiting: 0, lowest: null };
  if (!Array.isArray(waits) || !waits.length || !Number.isFinite(attested) || !Number.isFinite(relayTip)) return none;
  const open = waits.filter((w) => w.height > attested);
  if (!open.length) return none;
  const lowest = open[0].height;
  return {
    headers: open.some((w) => relayTip < w.height + confirmations),
    attest: open.some((w) => w.height + confirmations <= relayTip),
    waiting: open.length,
    lowest,
  };
}
