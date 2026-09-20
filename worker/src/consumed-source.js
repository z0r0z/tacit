// Validate a fast-lane consumed-source registration before it is stored.
//
// A Mode-B reflection batch that folds a fast-lane-consumed ν needs that note's own
// {cx, cy, srcTxid, srcVout}. The settle proof cannot supply it — it proves membership against the Bitcoin
// pool root, never the underlying outpoint — so the value has to be handed to the worker. That makes the
// submission load-bearing for the liveness of the whole reflection lane, not just for the spender:
// `buildModeBBatch` resolves ν by FIRST MATCH and throws when it finds none, and the guest's `fold_consumed`
// is `.expect(...)`, so a wrong source panics the proof rather than being skipped. An unvalidated store would
// therefore let one bad entry wedge every later Mode-B proof.
//
// The fix is to validate at WRITE time instead of trusting the writer. Everything `fold_consumed` checks is
// checkable here against the reflection's own live UTXO set, so only the genuine source for a given ν can
// ever be stored — which makes the first-match resolution safe and removes the poisoning surface entirely
// (a wrong submission is rejected, not recorded). It also means the endpoint no longer has to be trusted to
// the same degree as the box: a hostile caller can only fail.
//
// Mirrors cxfer-core `fold_consumed` step for step:
//   1. the outpoint must be a LIVE UTXO in the reflected set
//   2. keccak(Cx‖Cy) must equal that outpoint's recorded commitment hash
//   3. the source leaf is btc_note_leaf_bound(...) for a generation-bound note (bound tag 1) and
//      btc_note_leaf(...) otherwise — reconstructed from the LIVE entry's own asset and auth key, never
//      from anything the caller supplied
//   4. nullifier(source leaf) must equal the submitted ν
//
// Note what is deliberately NOT re-derived from the caller: the asset and the Bitcoin auth key come from the
// live set. The caller only names an outpoint and a commitment; everything that gives the note its identity
// is read from state. That is what makes step 4 a real check rather than a restatement of the input.

const HEX32 = /^(0x)?[0-9a-f]{64}$/i;
const norm = (h) => '0x' + String(h).replace(/^0x/, '').toLowerCase();
const eqHex = (a, b) => norm(a) === norm(b);

/**
 * @param {object} sub          {nu, cx, cy, srcTxid, srcVout} as submitted
 * @param {Array}  liveTriples  the reflected live set: [outpointKey, commitmentHash, asset, authKey, bound][]
 * @param {object} pool         makeConfidentialPool(...) — outpointKey/commitmentHash/btcNoteLeaf/
 *                              btcNoteLeafBound/nullifier
 * @param {string|null} chainBinding  this deployment's chain binding; required only for a bound note
 * @returns {{ok: true, record: object} | {ok: false, reason: string}}
 */
export function validateConsumedSource(sub, liveTriples, pool, chainBinding) {
  const { nu, cx, cy, srcTxid, srcVout } = sub || {};
  if (!HEX32.test(String(nu || ''))) return { ok: false, reason: 'nu must be 32-byte hex' };
  if (!HEX32.test(String(cx || ''))) return { ok: false, reason: 'cx must be 32-byte hex' };
  if (!HEX32.test(String(cy || ''))) return { ok: false, reason: 'cy must be 32-byte hex' };
  if (!HEX32.test(String(srcTxid || ''))) return { ok: false, reason: 'srcTxid must be 32-byte hex' };
  if (!Number.isInteger(srcVout) || srcVout < 0 || srcVout > 0xffffffff) {
    return { ok: false, reason: 'srcVout must be a uint32' };
  }
  if (!Array.isArray(liveTriples) || !liveTriples.length) {
    return { ok: false, reason: 'no reflected live set available to validate against' };
  }

  // (1) The outpoint must be live. This also catches a txid supplied in the wrong byte order: the key is
  // keccak(txid ‖ vout_le32) over the internal-order txid the reflection records, so a display-order txid
  // simply hashes to a key that is not in the set.
  const key = pool.outpointKey(norm(srcTxid), srcVout);
  const row = liveTriples.find((t) => eqHex(t[0], key));
  if (!row) return { ok: false, reason: 'outpoint is not a live UTXO in the reflected set' };

  const [, liveCh, liveAsset, liveAuth, boundRaw] = row;
  const bound = boundRaw ? 1 : 0;

  // (2) The commitment must open to the one recorded at that outpoint.
  if (!eqHex(pool.commitmentHash(norm(cx), norm(cy)), liveCh)) {
    return { ok: false, reason: 'commitment does not match the live UTXO' };
  }

  // (3) Reconstruct the source leaf over the note's OWN generation domain, from live state.
  if (bound === 1 && !HEX32.test(String(chainBinding || ''))) {
    return { ok: false, reason: 'bound note needs this deployment chain binding to reconstruct its leaf' };
  }
  const leaf = bound === 1
    ? pool.btcNoteLeafBound(liveAsset, norm(cx), norm(cy), liveAuth, norm(chainBinding))
    : pool.btcNoteLeaf(liveAsset, norm(cx), norm(cy), liveAuth);

  // (4) The whole point: ν must be this leaf's nullifier. Only the genuine source passes.
  if (!eqHex(pool.nullifier(leaf), nu)) {
    return { ok: false, reason: 'nu is not the nullifier of this source note' };
  }

  return {
    ok: true,
    record: { nu: norm(nu), cx: norm(cx), cy: norm(cy), srcTxid: String(srcTxid).replace(/^0x/, '').toLowerCase(), srcVout },
  };
}

/**
 * Derive a fast-lane-consumed ν's Bitcoin source from the reflection's OWN state — no submission.
 *
 * This is the form that removes the trust question rather than managing it. Both halves of the answer are
 * already public and already held:
 *   - Ethereum's settle carries `bitcoinConsumedSources[i]`, the full source leaf, and the pool folds it
 *     into `bitcoinConsumed[ν]`;
 *   - Bitcoin carries each note's commitment in its own creation envelope, which the reflection scanner
 *     parses and keeps in `coords` (outpointKey → {cx, cy, txid, vout}) — off-chain bookkeeping the scanner
 *     derives itself, persisted in the snapshot and deliberately outside `digest()`.
 * So the source never needed to be told to us. Walk the live set, rebuild each note's leaf over its own
 * generation domain from state, and take the one whose nullifier is the ν we are resolving.
 *
 * With this there is no write path to poison: nothing outside the worker contributes, and the worker's own
 * inputs are chain data it re-derives. `validateConsumedSource` remains as the check on any legacy stored
 * record, so the two together mean a source is either derived from chain state or proven against it.
 *
 * @returns {{ok:true, record:object} | {ok:false, reason:string}}
 */
export function deriveConsumedSource(nu, liveTriples, coords, pool, chainBinding) {
  if (!HEX32.test(String(nu || ''))) return { ok: false, reason: 'nu must be 32-byte hex' };
  if (!Array.isArray(liveTriples) || !liveTriples.length) {
    return { ok: false, reason: 'no reflected live set to derive from' };
  }
  const get = coords instanceof Map ? (k) => coords.get(k) : (k) => (coords || {})[k];
  let missingPreimage = 0;
  for (const row of liveTriples) {
    const [key, , liveAsset, liveAuth, boundRaw] = row;
    const co = get(norm(key)) || get(String(key).replace(/^0x/, '').toLowerCase());
    if (!co || co.cx == null || co.cy == null) continue;
    const bound = boundRaw ? 1 : 0;
    if (bound === 1 && !HEX32.test(String(chainBinding || ''))) continue;
    const leaf = bound === 1
      ? pool.btcNoteLeafBound(liveAsset, norm(co.cx), norm(co.cy), liveAuth, norm(chainBinding))
      : pool.btcNoteLeaf(liveAsset, norm(co.cx), norm(co.cy), liveAuth);
    if (!eqHex(pool.nullifier(leaf), nu)) continue;
    // Found it. The outpoint preimage is what the guest re-hashes as outpoint_key(txid, vout); a coords
    // entry written before the preimage was recorded cannot serve a fast-lane consume, so say so plainly
    // rather than emitting a half record the assembler would throw on later.
    if (co.txid == null || co.vout == null) { missingPreimage++; continue; }
    return {
      ok: true,
      record: {
        nu: norm(nu),
        cx: norm(co.cx),
        cy: norm(co.cy),
        srcTxid: String(co.txid).replace(/^0x/, '').toLowerCase(),
        srcVout: Number(co.vout),
      },
    };
  }
  return {
    ok: false,
    reason: missingPreimage
      ? `matched a live note but its coords entry predates the outpoint preimage (${missingPreimage}) — rescan to backfill`
      : 'no live note reproduces this nullifier',
  };
}
