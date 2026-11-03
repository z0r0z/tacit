// The relay's first lane for a settle proof: Tacit's prover board (the API's /prover/* routes, worker/src/prover-board.js),
// where a worker holding a token proves the input on its own machine. A proof that comes back is checked against the pool
// (a simulated settle with the memos the proof must commit to) before the relay uses it; a board that has no worker, a
// worker that fails or a proof the pool refuses hands the job on to the prover network, so the board can only add a lane,
// never lose a job. `post`, `status`, `cancel` and `verify` are injected (lib/worker-client.js and the chain), so this is
// tested without either.

// `race(jobId, worker, ok)`: the relay's verdict on a community machine's candidate (a public job's racers, worker/src/prover-board.js); each
// candidate is checked as the board's own proof is, and the first that passes is the job's proof while Tacit's worker goes on with it.
export function makeBoardProver({ post, status, cancel, verify, race = null, alive = null, waitMs = 240_000, pollMs = 1000, now = Date.now, sleep, log = () => {} } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const miss = (reason, extra = {}) => Object.assign(new Error(`prover board: ${reason}`), { code: 'board_miss', reason, ...extra });

  // `stdin`: bincode SP1Stdin bytes, or `sealed`: { worker, epk, iv, ct } (the input encrypted to that worker; the board
  // offers it to no one else). `cls`: 'private' for a user's witness. `memos`: what the settle will carry, so the proof's
  // memo root is checked. `program` and `mode`: what the board proves ('confidential', groth16, by default; 'eth-state' is
  // proved compressed), with `check` in place of the lane's `verify` for a program the pool does not settle. A check answers
  // true (use it), 'stale' (sound, but behind the pool), 'unchecked' (it could not be checked here: no mark against the
  // worker) or false (refused: it counts against the worker). → { publicValues, proof, worker, jobId }, or an error with code
  // 'board_miss'.
  async function prove({ stdin = null, sealed = null, cycleLimit, gasLimit, cls = 'private', label = null, memos = [], timeoutMs = waitMs, program = 'confidential', mode = null, check = null } = {}) {
    if (sealed == null && (!(stdin instanceof Uint8Array) || !stdin.length)) throw new Error('prover board: stdin must be the input bytes');
    if (sealed != null && (typeof sealed !== 'object' || typeof sealed.worker !== 'string' || typeof sealed.ct !== 'string')) throw new Error('prover board: sealed must be { worker, epk, iv, ct }');
    // No worker has polled lately: the job would only sit out the wait, so it goes straight to the next lane.
    if (alive && !(await Promise.resolve(alive()).catch(() => true))) throw miss('no worker has been seen lately');
    const budget = Math.min(waitMs, timeoutMs);
    const t0 = now();
    // The job's deadline sits a minute past this wait: a worker that answers just late is not paid for by the network too.
    const input = sealed != null ? { sealed } : { stdin: Buffer.from(stdin).toString('base64') };
    const posted = await post({ class: cls, program, ...(mode ? { mode } : {}), ...input, cycleLimit: Number(cycleLimit), gasLimit: Number(gasLimit),
      deadline: Math.floor(now() / 1000) + Math.ceil(budget / 1000) + 60, label }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    if (!posted || !posted.ok || !posted.jobId) throw miss(`not posted: ${(posted && posted.error) || 'no answer from the API'}`);
    const { jobId } = posted;
    let lastSeen = null;
    const judged = new Set();
    for (;;) {
      const st = await status(jobId).catch(() => null);
      const s = st && st.status;
      for (const c of (race && st && Array.isArray(st.race) ? st.race : [])) {
        const key = `${c.worker}|${c.proof}`;
        if (judged.has(key)) continue;
        judged.add(key);
        const ok = await Promise.resolve((check || verify)({ publicValues: c.publicValues, proof: c.proof, memos })).catch(() => (check ? 'unchecked' : false));
        log(`prover board: job ${jobId.slice(0, 10)} candidate from ${c.worker}: ${ok === true ? 'taken' : ok}`);
        await Promise.resolve(race(jobId, c.worker, ok === true ? true : ok === false ? false : null)).catch(() => {});
        if (ok === true) return { publicValues: c.publicValues, proof: c.proof, worker: c.worker, jobId };
      }
      if (s && s !== lastSeen) { lastSeen = s; log(`prover board: job ${jobId.slice(0, 10)} ${s}${st.worker ? ` (${st.worker})` : ''}`); }
      if (s === 'proved') {
        const ok = await Promise.resolve((check || verify)({ publicValues: st.publicValues, proof: st.proof, memos })).catch(() => (check ? 'unchecked' : false));
        if (ok !== true) {
          // 'stale': the op's roots are behind the pool, so the proof cannot land whoever made it; 'unchecked': the check itself could
          // not run here. Either way the job is cancelled without a mark against the worker. Anything else is a proof that was
          // refused, which counts against the worker that made it.
          const why = ok === 'stale' ? 'stale' : ok === 'unchecked' ? 'unchecked' : 'bad';
          await cancel(jobId, why).catch(() => {});
          const who = st.worker || 'a worker';
          throw miss(why === 'stale' ? `the proof from ${who} is for roots the pool has moved past` : why === 'unchecked' ? `the proof from ${who} could not be checked here`
            : `the proof from ${who} did not pass the ${check ? 'check' : 'settle check'}`, { jobId, worker: st.worker, stale: why === 'stale' });
        }
        return { publicValues: st.publicValues, proof: st.proof, worker: st.worker, jobId };
      }
      if (s === 'failed') throw miss(`${st.worker || 'the worker'} could not prove it: ${st.error || 'no reason given'}`, { jobId, worker: st.worker });
      if (s === 'expired' || s === 'cancelled') throw miss(`the job is ${s}`, { jobId });
      if (now() - t0 >= budget) {
        await cancel(jobId, 'timeout').catch(() => {});
        throw miss(`nobody proved it within ${Math.round(budget / 1000)} s${s === 'claimed' ? ` (${st.worker} had claimed it)` : ''}`, { jobId });
      }
      await wait(pollMs);
    }
  }
  return { prove };
}
