// The pool's refusals that mean its state moved past a bought reflection proof, so the proof can never land (ReflectionLib attest):
//   ConsumedCountStale     a consume or a cross-out recorded after the batch's eth-state candidate (the counts the proof carries are behind)
//   StaleReflectionDigest  the pool no longer sits on the batch's prior digest (this batch, or another, landed from elsewhere)
//   StaleRelayProof        an attest at a later Bitcoin height landed first
// The attest is estimated just before it is sent, minutes after the proof was bought, so a cross-out in between makes the estimate
// revert. That is the chain's answer, not a fault: the lane lets the proof go and asks for a fresh batch, rather than throwing (which
// backs the whole lane off, 60 s doubling to 30 min) and sending the same dead proof again next cycle. Any other revert is not
// known to be final and is left to the caller's usual handling.

import { toFunctionSelector } from 'viem';
import { selectorIn } from './revert-data.js';

export const STALE_ATTEST_ERRORS = ['ConsumedCountStale', 'StaleReflectionDigest', 'StaleRelayProof'];
const BY_SELECTOR = Object.fromEntries(STALE_ATTEST_ERRORS.map((n) => [toFunctionSelector(`${n}()`), n]));

// The stale-state error a failed estimate or send reverted with, or null. `selector` is one already had another way (a public node's
// eth_call, lib/revert-data.js revertSelector); otherwise the error chain's own revert data, a decoded error name, or "Name()" in its text.
export function staleAttestRevert(e, selector = null) {
  const sel = String(selector || selectorIn(e) || '').toLowerCase();
  if (BY_SELECTOR[sel]) return BY_SELECTOR[sel];
  for (let x = e, d = 0; x && d < 8; x = x.cause, d++) {
    const name = x.data?.errorName;
    if (STALE_ATTEST_ERRORS.includes(name)) return name;
    const m = String(x.shortMessage || x.message || '').match(/\b(ConsumedCountStale|StaleReflectionDigest|StaleRelayProof)\b/);
    if (m) return m[1];
  }
  return null;
}
