// Module worker: works out, off the page's thread, whether a transfer holds anything for a key (stealth-scan-core.js recipientScanTxForStealth: the shared secret with
// the wallet key and every output tried against it, about ten milliseconds a transfer and more with more outputs).
//   { id, walletPriv, walletPub, networkTag, jobs: [{ classifiedInputs, outputs, domain, txAnchorHead }] } → { id, nothing: [true | false | undefined, …] }
// true: it holds nothing for this key; false: it holds at least one credit; undefined: this worker could not work it out, and the page does. It runs the function the page
// runs, so a transfer it says holds nothing is one the page would say holds nothing. The key is held for a request and dropped; the page ends this worker a few seconds after its last job.
import { recipientScanTxForStealth } from './stealth-scan-core.js';

self.onmessage = ({ data }) => {
  const { id, walletPriv, walletPub, networkTag, jobs } = data || {};
  try {
    const nothing = jobs.map((j) => {
      try { return recipientScanTxForStealth({ classifiedInputs: j.classifiedInputs, outputs: j.outputs, walletPriv, walletPub, networkTag, domain: j.domain, txAnchorHead: j.txAnchorHead }).length === 0; }
      catch { return undefined; }
    });
    self.postMessage({ id, nothing });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
