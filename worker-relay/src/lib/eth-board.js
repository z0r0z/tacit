// The Ethereum-state proof (eth_prove's compressed proof of the eth-reflection guest, which the Bitcoin reflection guest
// verifies inside itself) made on Tacit's prover board before the prover network. eth_prove builds the input and stops
// (SP1_PROVER=stdin: out/eth_stdin.bin, and out/eth_candidate.json with the public values the guest commits for it), a board
// worker that proves the 'eth-state' program proves it compressed, and eth_prove finishes with that proof (SP1_PROVER=finish),
// which writes what a network run writes and refuses a proof whose public values are not the candidate's, whose guest key is
// not the one the Bitcoin guest pins, or that does not verify. Anything short of that (no such worker seen lately, an input
// that was not built, a post the API refuses, a proof refused or not back within the wait) leaves the candidate to the
// network, as before, having cost at most the wait. Every dependency is injected (lib/prover.js wires them), so this is tested
// without the binary, the API or the chain.
//
//   capable()          → whether a worker that proves 'eth-state' has polled the board lately (lib/prover.js: within two minutes)
//   buildInput()       → { stdin: Uint8Array, expectPv: hex without 0x } (eth_prove SP1_PROVER=stdin)
//   lane               the board lane (lib/board-prover.js makeBoardProver)
//   finish(proofB64)   → true (accepted and written), false (refused: counts against the worker) or 'unchecked'

// A build whose error is marked `retry` (eth_prove exited on an error of its own: an RPC that failed it, a beacon node behind)
// is run once more after `retryMs` before the network is paid; one that timed out, ran over its memory or printed no input is not.
export function makeEthBoard({ capable, buildInput, lane, finish, cycleLimit, gasLimit, waitMs, buildTries = 2, retryMs = 20_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {} } = {}) {
  const say = (e) => String(e && e.message || e).split('\n')[0].slice(0, 300);
  // → { ok: true, worker, jobId, ms } once the outputs are written; { ok: false, reason, ms } for the network to take over.
  async function prove() {
    const t0 = now();
    const out = (reason) => ({ ok: false, reason, ms: now() - t0 });
    if (!(await Promise.resolve().then(capable).catch(() => false))) return out('no worker that proves the Ethereum-state input has been seen lately');
    let built;
    for (let n = 1; ; n++) {
      try { built = await buildInput(); break; } catch (e) {
        if (n >= buildTries || !(e && e.retry)) return out(`the input was not built${n > 1 ? ` (${n} tries)` : ''}: ${say(e)}`);
        log(`eth-state: the input was not built (${say(e)}); trying again in ${Math.round(retryMs / 1000)} s`);
        await sleep(retryMs);
      }
    }
    if (!built || !(built.stdin instanceof Uint8Array) || !built.stdin.length || !/^[0-9a-f]+$/.test(String(built.expectPv || ''))) return out('the input was not built');
    log(`eth-state: input built (${built.stdin.length} bytes); asking the board`);
    // The proof's public values are compared before the finish run is spent on it: a proof of another input is refused at once.
    const check = async ({ publicValues, proof }) => {
      if (String(publicValues || '').toLowerCase() !== `0x${built.expectPv}`) return false;
      return finish(proof);
    };
    try {
      const r = await lane.prove({ stdin: built.stdin, cycleLimit, gasLimit, cls: 'eth-state', program: 'eth-state', mode: 'compressed', label: 'eth-state', timeoutMs: waitMs, check });
      return { ok: true, worker: r.worker, jobId: r.jobId, ms: now() - t0 };
    } catch (e) {
      return out(e && e.code === 'board_miss' ? (e.reason || say(e)) : `the board lane failed: ${say(e)}`);
    }
  }
  return { prove };
}

// Whether the board summary shows a worker that proves `program` and polled within `withinSecs`.
export function boardProves(summary, program, withinSecs = 30) {
  return !!summary && Array.isArray(summary.workers)
    && summary.workers.some((w) => Array.isArray(w.programs) && w.programs.includes(program) && w.lastSeenSeconds != null && Number(w.lastSeenSeconds) <= withinSecs);
}

// What eth_prove SP1_PROVER=finish's exit means for the board: 0 with FINISH_OK accepted, 3 with FINISH_REFUSED refused (the
// proof's fault), anything else (a crash, a memory cap, a timeout) unchecked (not the worker's fault).
export function finishVerdict({ code, out = '' } = {}) {
  if (code === 0 && /^FINISH_OK$/m.test(out)) return true;
  if (code === 3 && /^FINISH_REFUSED /m.test(out)) return false;
  return 'unchecked';
}
