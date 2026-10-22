// The pool module (confidential-pool-ux.js), loaded the first time a trade page needs it: the notes, the deposits and the cBTC reads of a Tacit
// key. It is large (about a megabyte with what it imports), so nothing reads it until a key is open or an amount is being typed.
import { secp, sha256, keccak_256 } from '/vendor/tacit-deps.min.js';

let uxP = null;
export function getUx() {
  return (uxP ||= (async () => {
    const [{ makeConfidentialPoolUx }, dep] = await Promise.all([import('/confidential-pool-ux.js?cb=df0eb74d'), import('/confidential-deployments.js')]);
    dep.setActiveNetwork('mainnet');
    return makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet' });
  })().catch((e) => { uxP = null; throw e; }));
}
// Dropped when the key is locked, with the copies of it the pool module keeps.
export async function forgetUx() {
  try { (await import('/confidential-pool-ux.js?cb=df0eb74d')).forgetKeys(); } catch { /* the module was never loaded */ }
}
