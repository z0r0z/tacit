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

// The pool's DepositNotPending(): the proof consumes a deposit that is not waiting in the pool. A proof made before its deposit (a wrap proved
// first, sent with its deposit through the router) is refused this way by any settle simulation however sound it is, so it is 'nodeposit',
// for the caller to judge the proof another way, never a mark against the worker that made it.
export const DEPOSIT_NOT_PENDING = '0x070d817c';

// Refusals that say the OP has moved on since it was proved, not that the proof is wrong: the pool's NullifierAlreadySpent() (the op's note was
// spent by another transaction first) and the farm's OverClaim() (the farm's accounting is no longer what the op claims, as when a harvest
// was proved and then another changed the pool). A sound proof of such an op cannot land whoever made it, so these read as 'stale': no mark
// against the worker. Read as 'bad' they marked a good worker six times between 2026-11-02 and 11-04 (its refused count went from 83 to 89)
// and the monitor warned of it on every run. They are NOT in the lane's list of selectors that send an op back to be proved again from its
// witness (open-board.js STALE_PROOF_SELECTORS): proving a spent note again would only fail again.
export const OP_MOVED = [{ selector: '0xb115d857', name: 'nullifieralreadyspent' }, { selector: '0x508ece93', name: 'overclaim' }];

// A node's refusal to run a call the account cannot pay for.
export const fundsRefusal = (e) => /exceeds allowance|insufficient funds/i.test(text(e));

// → { verdict: 'stale' | 'nodeposit' | 'unchecked' | 'bad', said }
export function readSettleCheck(e, staleSelectors = []) {
  const said = String((e && e.shortMessage) || (e && e.message) || e);
  const hay = text(e).toLowerCase();
  if (staleSelectors.some((sel) => hay.includes(String(sel).toLowerCase()))) return { verdict: 'stale', said };
  if (hay.includes(DEPOSIT_NOT_PENDING) || hay.includes('depositnotpending')) return { verdict: 'nodeposit', said };
  if (OP_MOVED.some((x) => hay.includes(x.selector) || hay.includes(x.name))) return { verdict: 'stale', said };
  if (fundsRefusal(e)) return { verdict: 'unchecked', said };
  return { verdict: 'bad', said };
}
