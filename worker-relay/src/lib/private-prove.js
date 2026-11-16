// A settle proof's witness can go to the Succinct network as a private input (PRIVATE_STDIN=1), which only provers that
// fetch it with the signed GetStdinUri call can read; PROVER_WHITELIST names those. These decide how lib/prover.js tries
// it, and are kept apart so they can be tested without the relay's wallets (tests/private-prove.test.mjs).

// How a prove is attempted: with PRIVATE_STDIN=1 and PRIVATE_FALLBACK_PUBLIC not '0', a private attempt gets at most
// PRIVATE_ATTEMPT_MS (default 6 minutes) or 60% of the job's time, and the rest is left for one public attempt.
export function privateProvePlan(env, timeoutMs) {
  const priv = env.PRIVATE_STDIN === '1';
  if (!priv || env.PRIVATE_FALLBACK_PUBLIC === '0') return { fallback: false };
  const cap = Number(env.PRIVATE_ATTEMPT_MS) > 0 ? Number(env.PRIVATE_ATTEMPT_MS) : 6 * 60_000;
  return { fallback: true, privateMs: Math.max(60_000, Math.min(cap, Math.floor(timeoutMs * 0.6))) };
}
// The network's refusal of every private input (PERMISSION_DENIED "private stdin is not enabled on this network"; nothing
// is created or charged). It is remembered for ten minutes, so the jobs after it go public at once instead of each
// spending a binary start and a refused request first (about half a minute per job).
export const PRIVATE_OFF_MS = 10 * 60_000;
// The refusal is on the binary's stderr (lib/prover.js attaches it as `e.stderr`); the message itself says only that no proof came.
export const privateRefused = (e) => /private stdin is not enabled/i.test(`${String(e && e.message || e)}\n${String(e && e.stderr || '')}`);
let privateOffAt = 0;
export const rememberRefusal = (now = Date.now()) => { privateOffAt = now; };
export const privateOff = (now = Date.now()) => now - privateOffAt < PRIVATE_OFF_MS;

// A private attempt is worth repeating in public only when no prover proved it (none bid, the one that won never
// delivered, it timed out here); one the network could not execute fails the same way in public, and so does one the
// prover account could not pay for (marked `creditShort` by lib/prover.js).
export function retryPublic(e) {
  if (e && e.creditShort === true) return false;
  if (unexecutable(e)) return false;
  const m = String(e && e.message || e);
  return !/unexecutable|execution failed|failed to execute|exceeded cycle limit|VKEY DRIFT|EXPECT_VKEY mismatch/i.test(m);
}
// The network's answer that it cannot run the request at all ("Proof request 0x… is unexecutable"): the binary panics with it on stderr, which the
// error's message leaves out, so it is read from `e.stderr` as the refusal of private inputs is. (A request nobody fulfilled, 'is unfulfillable',
// is another matter: a public input can still find a prover.) Only the message was read here before, so a private request that came back unexecutable
// was sent again in public to be refused the same way.
export const unexecutable = (e) => !!e && (e.unexecutable === true || /\bis unexecutable\b/i.test(String(e.stderr || '')));
