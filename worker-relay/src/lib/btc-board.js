// The Bitcoin-state proof (the reflection guest's groth16 proof that attestBitcoinStateProven takes) made on Tacit's prover board
// before the prover network. bitcoin_prove builds the input and stops (SP1_PROVER=stdin: out/bitcoin_stdin.bin, the inner Ethereum
// proof included), the board offers it as public work (its input is Bitcoin's blocks and a public proof), a worker that proves the
// 'btc-state' program proves it groth16, and the proof is used as the network's would be once it passes the check here: its public
// values carry the batch's prior and new digests in their places, and the SP1 verifier takes it under the pool's BITCOIN_RELAY_VKEY. The attest's
// own gas estimate still runs before anything is sent. Anything short of that (no such worker seen lately, an input that was not
// built, a post the API refuses, a proof refused or not back within the wait) leaves the batch to the network, as before, having
// cost at most the wait. Every dependency is injected (lib/prover.js wires them), so this is tested without the binary, the API or
// the chain.
//
//   capable()          → whether a worker that proves 'btc-state' has polled the board lately
//   buildInput()       → Uint8Array, the bincode SP1Stdin (bitcoin_prove SP1_PROVER=stdin)
//   lane               the board lane (lib/board-prover.js makeBoardProver)
//   verify({ publicValues, proof }) → true (the verifier takes it), false (it refuses it) or 'unchecked'

const say = (e) => String(e && e.message || e).split('\n')[0].slice(0, 300);
const bare = (h) => String(h || '').toLowerCase().replace(/^0x/, '');

// The public values are abi.encode(BitcoinRelayPublicValues), a tuple with dynamic arrays: word 0 is its offset (0x20), then
// priorDigest is word 1 and newDigest word 6 (ReflectionLib; test/ConfidentialReflectionBurnDepositProofReal.t.sol).
export const PV_WORD = Object.freeze({ priorDigest: 1, newDigest: 6 });
const word = (pv, i) => pv.slice(i * 64, i * 64 + 64);

// A board proof of this batch: hex public values whose digests are the batch's, hex proof bytes, and then the verifier's word.
export function btcCheck({ priorDigest, newDigest, verify }) {
  return async ({ publicValues, proof }) => {
    const pv = bare(publicValues);
    if (!/^[0-9a-f]+$/.test(pv) || pv.length < 7 * 64 || !/^0x[0-9a-fA-F]+$/.test(String(proof || ''))) return false;
    if (priorDigest && word(pv, PV_WORD.priorDigest) !== bare(priorDigest).padStart(64, '0')) return false;
    if (newDigest && word(pv, PV_WORD.newDigest) !== bare(newDigest).padStart(64, '0')) return false;
    return verify({ publicValues, proof });
  };
}

export function makeBtcBoard({ capable, buildInput, lane, verify, cycleLimit, gasLimit, waitMs, now = Date.now, log = () => {} } = {}) {
  // → { ok: true, publicValues, proofBytes, worker, jobId, ms }, or { ok: false, reason, ms } for the network to take over.
  async function prove({ priorDigest = null, newDigest = null } = {}) {
    const t0 = now();
    const out = (reason) => ({ ok: false, reason, ms: now() - t0 });
    if (!(await Promise.resolve().then(capable).catch(() => false))) return out('no worker that proves the Bitcoin-state input has been seen lately');
    let stdin;
    try { stdin = await buildInput(); } catch (e) { return out(`the input was not built: ${say(e)}`); }
    if (!(stdin instanceof Uint8Array) || !stdin.length) return out('the input was not built');
    log(`btc-state: input built (${stdin.length} bytes); asking the board`);
    try {
      const r = await lane.prove({ stdin, cycleLimit, gasLimit, cls: 'public', program: 'btc-state', mode: 'groth16', label: 'btc-state', timeoutMs: waitMs,
        check: btcCheck({ priorDigest, newDigest, verify }) });
      return { ok: true, publicValues: r.publicValues, proofBytes: r.proof, worker: r.worker, jobId: r.jobId, ms: now() - t0 };
    } catch (e) {
      return out(e && e.code === 'board_miss' ? e.reason : say(e));
    }
  }
  return { prove };
}
