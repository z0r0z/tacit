// Module worker: opens Tacit chain memos with a key off the page's thread. Each memo is one secp256k1 multiplication and one ML-KEM-768 decapsulation
// (several milliseconds), and a wallet that has not read the chain on this device opens every memo it has.
//   { id, secret: { scan, kem }, memos: [Uint8Array, …] } → { id, opened: [{ value, s } | null | undefined, …] }
// It runs tacit-chain-memo.js openMemo, the function the page runs; the page checks each memo that opens against its leaf. undefined: this worker could
// not open that one, and the page does. The key is held for a request and then dropped; the page ends this worker a few seconds after its last job.
import { openMemo } from './tacit-chain-memo.js';

self.onmessage = ({ data }) => {
  const { id, secret, memos } = data || {};
  try {
    const opened = memos.map((m) => { try { return openMemo(m, secret); } catch { return undefined; } });
    self.postMessage({ id, opened });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
