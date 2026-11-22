// The settle relay's loop, run `count` times side by side. One loop proves a job and settles it before it takes the next, so with one prover
// box that was the right shape and with two the second box sat idle while swaps (whose proofs bind the pool's reserves and go stale by the minute)
// waited in the queue. Each loop claims its own job (the API hands a job to one claimer), proves it, then takes its turn on the settle
// wallet (lib/serial.js), so proofs overlap and settles do not.
//
//   await runLoops({ count, step, stopping, stopped })
//     step(i)      one pass of loop i (a cycle and, for loop 0, the upkeep that only one loop should do); a throw is the caller's to catch inside step
//     stopping()   true once the process has been asked to stop: each loop finishes the pass it is in, then leaves
//     stopped()    called once, after every loop has left (the process exits here: no job in hand is cut off)
export async function runLoops({ count = 1, step, stopping, stopped }) {
  const n = Math.max(1, Math.floor(Number(count)) || 1);
  let left = n;
  const one = async (i) => {
    for (;;) {
      if (stopping()) break;
      await step(i);
    }
    left--;
    if (left === 0) await stopped();
  };
  await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
}
