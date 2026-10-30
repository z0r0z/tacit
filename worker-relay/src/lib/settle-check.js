// How a failed simulation of a board proof's settle is read (lib/prover.js verifySettle).
//
// The check asks the pool, from the settle wallet, whether it would settle the proof now. A refusal from the pool means the proof is not for the
// pool as it stands: 'stale' when its roots are behind (the op's fault, nothing against the worker), otherwise bad. But the simulation also fails
// for want of gas money, when a node will not run a call for an account that cannot pay for it ('gas required exceeds allowance (47755)',
// 'insufficient funds'): that says nothing about the proof. Read as a bad proof it marked a good worker (its refused count went from 76 to 77 and the
// monitor warned of it on every run) and sent the job to the prover network, which costs PROVE and minutes, at exactly the moment the wallet was low.
// So a failure for want of gas money is 'unchecked', which cancels the job with no mark against the worker.

const text = (e) => {
  const parts = [e && e.shortMessage, e && e.details, e && e.message];
  try { parts.push(JSON.stringify((e && e.cause) || '', (_k, v) => (typeof v === 'bigint' ? v.toString() : v))); } catch { /* a cause that cannot be written down adds nothing */ }
  return parts.filter(Boolean).join(' ');
};

// A node's refusal to run a call the account cannot pay for.
export const fundsRefusal = (e) => /exceeds allowance|insufficient funds/i.test(text(e));

// → { verdict: 'stale' | 'unchecked' | 'bad', said }
export function readSettleCheck(e, staleSelectors = []) {
  const said = String((e && e.shortMessage) || (e && e.message) || e);
  const hay = text(e).toLowerCase();
  if (staleSelectors.some((sel) => hay.includes(String(sel).toLowerCase()))) return { verdict: 'stale', said };
  if (fundsRefusal(e)) return { verdict: 'unchecked', said };
  return { verdict: 'bad', said };
}
