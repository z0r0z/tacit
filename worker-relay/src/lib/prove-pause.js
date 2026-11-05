// Where the settle relay stands, and when it stops proving. These decide what the loop takes and what its heartbeat says,
// and are kept apart so they can be tested without the relay's wallets (tests/prove-pause.test.mjs).

// The standing notes the settle loop beats while it is not taking every job. They are public (/prover-health returns a
// note as sent), so they say what the relay is doing and never why: no balances, nothing about gas or credit. The API
// reads them into the one state the pages ask for (worker/src/index.js relayState): "a page settles itself" is held,
// "on the open board" is held with the board on, "not proving" is paused.
export const NOTE_HELD_BOARD = 'settle: proving jobs a page settles itself, and putting relayed ones on the open board for any sender';
export const NOTE_HELD = 'settle: proving only jobs a page settles itself; the rest are held for now';
export const NOTE_PAUSED = 'settle: not proving for now; jobs keep their place';

// Whether relayed jobs are proved for the open board while the settle wallet is short: only with SETTLE_PROVE_WHILE_SHORT
// on, and then either with Tacit's own prover board making the proofs (`ownProver`, PROVER_BOARD=1: they cost no credit) or
// with the last credit reading at or over its floor, since a bought proof is paid for before anyone sends it. `credit` is
// replenish.js lastProverCredit(): { wei, at }, or null before anything was read.
export function boardProving({ enabled, credit, minWei, ownProver = false }) {
  if (!enabled) return false;
  if (ownProver) return true;
  return !!credit && credit.wei != null && BigInt(credit.wei) >= BigInt(minWei);
}

// The note for where the relay stands, or null while it takes every job (each job's own beat then says what it is doing).
// A pause outranks a short wallet: nothing is proved at all.
export function standingNote({ paused, short, board }) {
  if (paused) return NOTE_PAUSED;
  if (short) return board ? NOTE_HELD_BOARD : NOTE_HELD;
  return null;
}

// A proof request the prover account could not pay for. An exec binary panics with the network's refusal on stderr
// (tonic's `status: ResourceExhausted, message: …`); lib/prover.js marks that error `creditShort` without copying the
// refusal into its message, which reaches the job's public status. The pattern is the one the pages use for the same refusal.
export const CREDIT_SHORT = /Resource_?Exhausted|insufficient (balance|funds|credits?)|out of credits?/i;
export const creditShort = (e) => !!e && (e.creditShort === true || CREDIT_SHORT.test(String(e.message || e)));

// The two figures in the network's refusal, `insufficient balance 17.8126 PROVE for request cost 19.6030 PROVE`: what the account holds
// and what the request reserves (its gas limit at the price cap, plus the base fee), as PROVE wei. The need is rounded up past the
// four decimals the network prints. -> { haveWei, needWei } or null when the text is not that refusal.
export function creditRefusal(text) {
  const m = /insufficient balance ([\d.]+) PROVE for request cost ([\d.]+) PROVE/.exec(String(text || ''));
  if (!m) return null;
  const units = (x, up) => BigInt(up ? Math.ceil(Number(x) * 1e4) + 1 : Math.round(Number(x) * 1e4)) * 10n ** 14n;
  return { haveWei: units(m[1], false), needWei: units(m[2], true) };
}

// Whether a credit reading (PROVE wei) covers a request. An unread one (null) covers nothing.
export const creditCovers = (wei, minWei) => wei != null && BigInt(wei) >= BigInt(minWei);

// The pause. A proof request refused for want of credit starts it, and nothing else does: an unreadable credit never
// pauses the relay. While paused the loop claims no job, so each keeps its place in the queue, and the credit is read
// again at most every `everyMs`; the pause ends once a reading covers a request. A reading that cannot be read leaves
// it as it is. `readCredit` -> PROVE wei or null.
export function makeProvePause({ readCredit, minWei, everyMs = 120_000, now = Date.now, log = () => {} }) {
  let since = 0, readAt = 0;
  return {
    paused: () => since > 0,
    // A request was refused for want of credit. -> true when this starts the pause.
    enter(why = '') {
      if (since) return false;
      since = readAt = now();
      log(`proving paused: a proof request could not be paid for${why ? ` (${why})` : ''}; no job is claimed until the credit covers a request`);
      return true;
    },
    // Read the credit when it is due and resume once it covers a request. -> true while still paused.
    async check() {
      if (!since) return false;
      if (now() - readAt < everyMs) return true;
      readAt = now();
      let wei = null;
      try { wei = await readCredit(); } catch { wei = null; }
      if (!creditCovers(wei, minWei)) return true;
      log(`proving resumed after ${Math.round((now() - since) / 1000)}s: the credit (${(Number(wei) / 1e18).toFixed(2)} PROVE) covers a request again`);
      since = 0;
      return false;
    },
  };
}
