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
// no op can ship an unrecoverable output. Dep: { memo } — a makeConfidentialMemo() instance; optional
// { openKeyFor } — ownerPub hex -> the wallet private key that opens memos sealed to it (or null when the pubkey is
// not this wallet's), so the submit-time check can open each sealed memo instead of only measuring its length.

export function makeRecoveryGuard({ memo, openKeyFor = null }) {
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

  // Submit-time tripwire. `outputs[i]` describes leaf i; `memos[i]` is what settle will emit. A leaf that is neither
  // seed-derived nor carries a decodable memo throws — catching a forgotten seal BEFORE it reaches the chain (= permanent
  // fund loss). Where the memo is sealed to a key this wallet holds (`openPriv`, or the key `openKeyFor` returns for the
  // output's `ownerPub`) it is also OPENED with that key and must authenticate against leaf i and match the descriptor's
  // owner and value; a memo sealed to someone else's key (a recipient output) cannot be opened here and is checked for
  // length only.
  function assertOutputsRecoverable({ leaves, outputs, memos, openPriv = null }) {
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
      const priv = openPriv || (openKeyFor && outputs[i] && outputs[i].ownerPub != null ? openKeyFor(outputs[i].ownerPub) : null);
      if (!priv) continue;
      const opened = memo.openMemo(priv, leaves[i], memos[i]);
      if (!opened) {
        throw new Error(`recovery-guard: leaf ${i} memo does not open to its leaf with the wallet key — the note would not be recoverable`);
      }
      const o = outputs[i];
      if ((o.owner != null && BigInt(opened.owner) !== BigInt(o.owner)) || (o.value != null && BigInt(opened.value) !== BigInt(o.value))) {
        throw new Error(`recovery-guard: leaf ${i} memo opens to a different owner or value than the output it describes`);
      }
    }
  }

  return { sealMemosForOutputs, assertOutputsRecoverable };
}
