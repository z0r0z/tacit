// Module worker: tries note memos against a key off the page's thread. A pool's memos are thousands of point multiplications
// (a few milliseconds each), the most of what opening a wallet costs the first time on a device.
//   { id, key, memos: [hex, …] } → { id, said: Int8Array }   1 where the memo may be the key's own, 0 where it is not
// It only runs the probe (confidential-memo-probe.js, the half of openMemo that decrypts and checks the owner); a memo that
// passes is opened in full by the page, which checks it against the leaf. So this can only save work, never change what is found.
// The key is held for the length of a request and no longer; the page ends this worker when the scan is done.

import { secp, sha256, keccak_256 } from './vendor/tacit-deps.min.js';
import { makeMemoProbe } from './confidential-memo-probe.js';

const probe = makeMemoProbe({ secp, sha256, keccak256: keccak_256 });

self.onmessage = ({ data }) => {
  const { id, key, memos } = data || {};
  try {
    const said = new Int8Array(memos.length);
    for (let i = 0; i < memos.length; i++) said[i] = probe.maybeMine(key, memos[i]) ? 1 : 0;
    self.postMessage({ id, said }, [said.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
