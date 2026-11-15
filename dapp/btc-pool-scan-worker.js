// Module worker: reads leaves of the Bitcoin shielded pool's note feed for a wallet off the page's thread. For each leaf it returns what the pool's own receive makes of it
// (btc-shielded-pool.js tryReceive, the function the page runs: a point multiplication or two to see whether the sealed value opens under the wallet's view keys, and for a note that
// does, its keys, its leaf and its nullifier, about forty milliseconds a note).
//   { id, wallet: { v, vInt?, A, N, n?, a? }, leaves: [{ leafIndex, leaf, asset, pkEph, ctNote }, …] } → { id, notes: [note | null | undefined, …] }
// note: the leaf is a note of the wallet (the object tryReceive gives); null: it is not; undefined: this worker could not read it, and the page does. The wallet's keys are held for a
// request and dropped; the page ends this worker a few seconds after its last job.
import { secp, keccak_256, sha256, ripemd160 } from './vendor/tacit-deps.min.js';
import { makeBtcShieldedPool } from './btc-shielded-pool.js';

const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256, ripemd160 });

self.onmessage = ({ data }) => {
  const { id, wallet, leaves } = data || {};
  try {
    const notes = leaves.map((f) => { try { return pool.tryReceive(wallet, f); } catch { return undefined; } });
    self.postMessage({ id, notes });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
