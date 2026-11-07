// Whether someone is waiting on the next Bitcoin attest. The lane's stages run in one process: the header feeder notes the bonded
// cBTC locks it reads (lib/reflection-demand.js), the eth-state stage notes the counts the last landed batch carried, and the attest
// gate asks here whether matured blocks should go now rather than wait for company. A note older than MAX_AGE_MS no longer counts.
import { countsBehind } from './attest-counts.js';

const MAX_AGE_MS = 15 * 60_000;
let locks = null, folded = null;

// `ripe`: a bonded lock has waited long enough to have its confirmations, so folding it now is what mints it.
export function noteLockDemand({ waiting, ripe }, now = Date.now()) { locks = { waiting, ripe: !!ripe, at: now }; }
// The cross-out and consume counts of the eth-state candidate the last landed batch folded (null when there is none yet).
export function noteFoldedCounts(counts, now = Date.now()) { folded = counts ? { counts, at: now } : null; }

// `live`: the pool's counts now. -> a reason to attest at once, or null.
export function attestDemand({ live, now = Date.now() } = {}) {
  if (locks?.ripe && now - locks.at < MAX_AGE_MS) return `${locks.waiting} bonded cBTC lock(s) wait on these blocks`;
  const behind = folded && now - folded.at < MAX_AGE_MS ? countsBehind(folded.counts, live) : null;
  return behind ? `Ethereum has moved past the last batch (it carried ${behind}), and only an attest takes it to Bitcoin` : null;
}

export function resetAttestDemand() { locks = null; folded = null; }
