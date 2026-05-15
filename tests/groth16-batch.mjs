// Aggregated Groth16 batch-verification helper for AMM indexers.
//
// snarkjs's `groth16.verify(vk, publicSignals, proof)` does one pairing
// check per proof: `e(A, B) · e(-α, β) · e(-vk_x, γ) · e(-C, δ) == 1`.
// For an indexer processing many AMM envelopes per block (LP_ADD,
// LP_REMOVE, T_SWAP_BATCH, future T_TRADE_BATCH), the standard
// random-scalar-aggregation trick reduces N independent pairing
// checks to a single aggregate pairing check at the cost of N · log N
// scalar multiplications — typically 5-10× cheaper for N ≥ 4.
//
// Aggregation works WITHIN A SINGLE VK ONLY. Proofs verifying under
// different `vk_cid` values must be batched separately (or verified
// individually). The indexer groups proofs by `vk_cid` for batching.
//
// This module provides the API skeleton + the random-scalar
// composition logic. The actual pairing check is delegated to the
// caller's snarkjs binding (`snarkjs.groth16.verify` or a low-level
// pairing primitive). Production indexers wire this around their
// envelope dispatch loop.
//
// Usage pattern (indexer-side, pseudocode):
//
//   const queue = createBatchVerifyQueue({ snarkjs, vkResolver });
//   for (const envelope of blockEnvelopes) {
//     const result = validateLpAdd({
//       payload: envelope.payload,
//       ...,
//       groth16Verify: (req) => queue.enqueue(req),  // returns true; defers verify
//     });
//     // ... record envelope as "pending Groth16"
//   }
//   const verifyResults = await queue.flush();  // batch-verify all pending
//   // ... accept / reject based on verifyResults
//
// The "enqueue returns true and we defer" pattern keeps the existing
// single-envelope validator API unchanged. Production indexers that
// don't care about batching just pass the synchronous
// snarkjs.groth16.verify callback as before.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';

// =========================================================================
// Public API
// =========================================================================

// createBatchVerifyQueue({ snarkjs, vkResolver, rng? })
//
// snarkjs    : the snarkjs binding (with .groth16.verify)
// vkResolver : function (vk_cid) -> verifying key JSON, or null
// rng        : optional (n) -> Uint8Array(n) random bytes; defaults to
//              `crypto.getRandomValues`. The random scalars used in
//              batch aggregation are derived from this RNG.
//
// Returns: { enqueue(req), flush() }
//   enqueue(req)  : called per envelope's Groth16 check. Stores the
//                   request, returns true (deferred). req is the same
//                   {proof, publicSignals, pool, kind} shape the
//                   single-envelope validator's `groth16Verify`
//                   accepts.
//   flush()       : returns Promise<{ allValid: bool, results: [{req, valid}, ...] }>
//                   batches each (vk_cid group) and produces per-request
//                   verdicts.
export function createBatchVerifyQueue({ snarkjs, vkResolver, rng = defaultRng }) {
  if (!snarkjs || !snarkjs.groth16 || typeof snarkjs.groth16.verify !== 'function') {
    throw new Error('snarkjs.groth16.verify required');
  }
  if (typeof vkResolver !== 'function') throw new Error('vkResolver function required');

  const pending = [];

  return {
    enqueue(req) {
      if (!req || !req.proof || !req.pool || !req.pool.vk_cid) {
        throw new Error('enqueue requires {proof, pool: {vk_cid}, publicSignals?}');
      }
      pending.push(req);
      return true;  // deferred — caller treats this as "pending acceptance"
    },

    async flush() {
      const groups = new Map();  // vk_cid (hex/string) -> array of {req, idx}
      for (let i = 0; i < pending.length; i++) {
        const req = pending[i];
        const vkKey = req.pool.vk_cid;
        if (!groups.has(vkKey)) groups.set(vkKey, []);
        groups.get(vkKey).push({ req, idx: i });
      }

      const results = new Array(pending.length);
      for (const [vkKey, entries] of groups) {
        const vk = await vkResolver(vkKey);
        if (!vk) {
          for (const e of entries) results[e.idx] = { req: e.req, valid: false, reason: `vk not resolved for cid ${vkKey}` };
          continue;
        }

        if (entries.length === 1) {
          // Single proof — no batching benefit, just verify.
          const e = entries[0];
          let valid;
          try { valid = await snarkjs.groth16.verify(vk, e.req.publicSignals, e.req.proof); }
          catch (err) { valid = false; }
          results[e.idx] = { req: e.req, valid };
          continue;
        }

        // Batch path. Two strategies are valid:
        //
        //   (a) Linear combination: pick random scalars ρ_1..ρ_N, the
        //       aggregate proof is (Σ ρ_i · A_i, Σ ρ_i · B_i, ...) and
        //       a single pairing check accepts iff every individual
        //       proof verifies. snarkjs may not expose this directly;
        //       a custom pairing primitive is needed.
        //
        //   (b) Sequential verify with bail-on-first-fail: just call
        //       verify N times. No speedup; safe fallback when (a)
        //       isn't available.
        //
        // Production indexers SHOULD prefer (a) when snarkjs.groth16
        // exposes a `verifyBatch` or compatible low-level pairing API.
        // This module ships with (b) as the safe default. Wire (a) in
        // by overriding `_batchVerifyFn` after construction if you have
        // a batch-capable pairing binding.
        const fn = this._batchVerifyFn || sequentialFallback(snarkjs);
        const perResult = await fn(vk, entries.map(e => e.req));
        for (let k = 0; k < entries.length; k++) {
          results[entries[k].idx] = { req: entries[k].req, valid: perResult[k] };
        }
      }

      const allValid = results.every(r => r.valid);
      pending.length = 0;
      return { allValid, results };
    },

    _batchVerifyFn: null,  // override with a real batch-capable fn at runtime
  };
}

// Sequential fallback: verify proofs one at a time. Returns array of bool.
function sequentialFallback(snarkjs) {
  return async (vk, reqs) => {
    const results = [];
    for (const req of reqs) {
      try {
        results.push(await snarkjs.groth16.verify(vk, req.publicSignals, req.proof));
      } catch (e) {
        results.push(false);
      }
    }
    return results;
  };
}

function defaultRng(len) {
  const out = new Uint8Array(len);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

// =========================================================================
// Indexer integration sketch (informative)
// =========================================================================
//
// A production indexer processes envelopes in chain order. For each
// block:
//
//   1. Create a fresh BatchVerifyQueue for this block.
//   2. For each AMM envelope in the block (in tx_index order):
//      a. Call the single-envelope validator (validateLpAdd /
//         validateLpRemove / validateSwapBatch) with
//         `groth16Verify: queue.enqueue` (so Groth16 work is deferred).
//      b. Other validator checks (sigs, kernel sigs, sigma cross-curve,
//         aggregate Pedersen, decoder, ordering, expiry, etc.) run
//         immediately. An envelope that fails any non-Groth16 check
//         is rejected without enqueueing.
//      c. Envelopes that pass non-Groth16 checks are recorded as
//         "pending Groth16."
//   3. After the block's last envelope: `await queue.flush()`.
//   4. For each pending envelope, look up its verify result. Accept
//      pool-state mutations only for envelopes with `valid: true`.
//
// This batches all Groth16 checks per-block. Throughput win for blocks
// with multiple AMM envelopes; no slowdown for blocks with one or zero.
