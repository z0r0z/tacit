// Power-sum decoding for the Mix panel (DESIGN-secret-sats-join.md §4.1), off the page's main thread.
// Message in: { id, S: [decimal strings] }; out: { id, keys: [decimal strings] | null, err }.
import { decodePowerSums } from '/secret-sats-join.js?cb=7e817f1c';

self.onmessage = ({ data: { id, S } }) => {
  let keys = null, err = null;
  try { keys = decodePowerSums(S.map(BigInt)); } catch (e) { err = String(e?.message || e); }
  self.postMessage({ id, keys: keys && keys.map(String), err });
};
