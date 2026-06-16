// Seed-only recovery guardrail for the EVM confidential pool.
//
// A note appended by settle is INVISIBLE to recover() after a localStorage wipe unless it is
// reachable by exactly one of two channels:
//   (a) a recovery memo sealed to the note's owner pubkey — the settler knows the opening
//       (own outputs, and counterparty outputs whose opening the sender handed over), or
//   (b) a seed-derived blinding the owner re-derives on rescan — for outputs the settler
//       CANNOT open (e.g. the OP_BID buyer's filled notes; the seller settles but never learns
//       the buyer's deriveBidSecret blindings, so it can seal no memo for them).
//
// Every leaf MUST use one channel or the funds strand. Only the WRAP path seals a memo today;
// transfer / LP / swap / route / OTC / the BID seller leg create leaves and must seal a memo for
// each output they can open. This module is the shared seal helper + the submit-time tripwire, so
// no op can ship an unrecoverable output. Dep: { memo } — a makeConfidentialMemo() instance.

export function makeRecoveryGuard({ memo }) {
  const EMPTY_MEMO = '0x';

  // Seal one aligned memo per output (SAME order as the op's `leaves`). Each descriptor is either:
  //   memo-sealable: { ownerPub, value, blinding, secret?, asset, owner }  → sealed to ownerPub
  //   seed-derived : { seedDerived: true }                                 → empty memo placeholder
  // `ephRand` → a fresh scalar per memo (or a deterministic closure, as buildWrap uses). Returns
  // the encoded memo hex[] to pass to settle alongside `leaves`.
  function sealMemosForOutputs({ outputs, ephRand }) {
    return outputs.map((o, i) => {
      if (o && o.seedDerived) return EMPTY_MEMO;
      if (!o || o.ownerPub == null) {
        throw new Error(`recovery-guard: output ${i} has no ownerPub and is not seedDerived — it would be unrecoverable`);
      }
      const sealed = memo.sealMemo(o.ownerPub, {
        value: o.value, blinding: o.blinding, secret: o.secret == null ? 0 : o.secret, asset: o.asset, owner: o.owner,
      }, ephRand);
      return memo.encodeMemo(sealed);
    });
  }

  // Submit-time tripwire. `outputs[i]` describes leaf i (only its `seedDerived` flag is read here);
  // `memos[i]` is what settle will emit. A leaf that is neither seed-derived nor carries a decodable
  // memo throws — catching a forgotten seal BEFORE it reaches the chain (= permanent fund loss).
  function assertOutputsRecoverable({ leaves, outputs, memos }) {
    const n = leaves.length;
    if (!Array.isArray(outputs) || outputs.length !== n) {
      throw new Error(`recovery-guard: ${Array.isArray(outputs) ? outputs.length : 0} output descriptors for ${n} leaves`);
    }
    if (!Array.isArray(memos) || memos.length !== n) {
      throw new Error(`recovery-guard: ${Array.isArray(memos) ? memos.length : 0} memos for ${n} leaves — settle requires exactly one per leaf`);
    }
    for (let i = 0; i < n; i++) {
      if (outputs[i] && outputs[i].seedDerived) continue; // owner re-derives the blinding from its seed
      if (memo.decodeMemo(memos[i]) == null) {
        throw new Error(`recovery-guard: leaf ${i} has no recovery channel — not seed-derived and its memo is absent/garbled (unrecoverable output)`);
      }
    }
  }

  return { sealMemosForOutputs, assertOutputsRecoverable };
}
