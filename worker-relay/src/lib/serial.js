// One thing at a time, in the order asked. The settle relay can run several loops at once (SETTLE_CONCURRENCY), so the places that must not
// overlap each take a turn here: every send from the settle wallet (each reads the account's pending nonce when it goes out, so two at once
// would use the same one and the second would replace the first), and the fallback prover's files (one fixed input and output path per
// process, so two proofs at once would read each other's).
//
//   const wallet = makeSerial();
//   const hash = await wallet.run(() => sendIt());       // waits for every earlier turn; a throw passes to the caller and frees the turn
//   const done = await wallet.acquire();  try { … } finally { done(); }   // the same, when the work cannot be one function
export function makeSerial() {
  let tail = Promise.resolve();
  let waiting = 0;
  function acquire() {
    let release;
    const mine = new Promise((r) => { release = r; });
    const turn = tail.then(() => undefined);
    tail = tail.then(() => mine);
    waiting++;
    return turn.then(() => { waiting--; let freed = false; return () => { if (!freed) { freed = true; release(); } }; });
  }
  async function run(fn) {
    const done = await acquire();
    try { return await fn(); } finally { done(); }
  }
  return { run, acquire, waiting: () => waiting };
}
