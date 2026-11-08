// What the monitor says about the tacit chain from one read of its leader, its landing contract and the prover board (beside the leader
// wallet's runway and the stalled-spends check in balance-monitor.js). Pure, so tested: worker-relay/tests/tacit-chain-health.test.mjs.
//   leader  { height, pending } from GET /state, or null when it did not answer
//   chain   { height, queued, queueDone, oldestQueuedAt (s) or null, forceDelay (s), window (s) } read from TacitBlocks, or null when unread
//   board   { workers: [{ name, programs, lastSeenSeconds }] } from GET /prover/board, or null when unread
//   now     seconds
// → [{ level: 'warning' | 'critical', msg, extra }]
export const PROVER_SEEN_S = 600;

export function tacitChainVerdict({ leader, chain, board, now }) {
  const out = [];
  const min = (s) => Math.max(0, Math.round(s / 60));

  // the leader's node behind the contract: it lands nothing until it has read every block (a block landed moments ago is read on its next step)
  if (leader && chain && Number(leader.height) < Number(chain.height)) {
    out.push({ level: 'warning', msg: `tacit chain: the leader's node is at block ${leader.height}, the contract at ${chain.height}: it is not following the chain (read the tacit-chain-leader log)`, extra: { leader: leader.height, chain: chain.height } });
  }

  // a forced entry (TacitBlocks.force) every block must take in within FORCE_DELAY of posting; past FORCE_DELAY + WINDOW anyone may land, so a
  // leader that leaves one out loses its turn: a spend the leader refused, or a leader that is stuck
  if (chain && Number(chain.queued) > Number(chain.queueDone) && chain.oldestQueuedAt != null) {
    const n = Number(chain.queued) - Number(chain.queueDone), age = now - Number(chain.oldestQueuedAt), fd = Number(chain.forceDelay), open = fd + Number(chain.window || 0);
    const what = `${n} forced entr${n === 1 ? 'y' : 'ies'} waiting, the oldest ${min(age)} min`;
    const extra = { queued: Number(chain.queued), queueDone: Number(chain.queueDone), ageSeconds: age };
    if (age >= open) out.push({ level: 'critical', msg: `tacit chain: ${what}: past ${min(open)} min anyone may land, so the leader has lost its turn (a spend it refused, or it is stuck)`, extra });
    else if (age >= fd * 0.75) out.push({ level: 'critical', msg: `tacit chain: ${what}: every block must take it in within ${min(fd)} min of posting, ${min(fd - age)} min left`, extra });
    else if (age >= 10 * 60) out.push({ level: 'warning', msg: `tacit chain: ${what}: the leader should take it in at its next block`, extra });
  }

  // a GPU to prove blocks: the board's machines that take tacit-block jobs and were seen lately
  if (board) {
    const provers = (board.workers || []).filter((w) => (w.programs || []).includes('tacit-block') && Number(w.lastSeenSeconds) < PROVER_SEEN_S);
    const waiting = leader && Number(leader.pending) > 0;
    if (!provers.length) out.push({ level: waiting ? 'critical' : 'warning', msg: `tacit chain: no prover on the board takes tacit-block jobs (none seen in ${min(PROVER_SEEN_S)} min)${waiting ? `, and ${leader.pending} spend(s) wait` : ''}: start the house GPU's worker`, extra: { pending: leader?.pending ?? null } });
  }
  return out;
}
