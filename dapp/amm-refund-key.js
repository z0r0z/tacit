// Refund-key safety for the Bitcoin-lane AMM ops (T_SWAP_VAR, T_SWAP_ROUTE, the swap-batch fold).
//
// WHY THIS EXISTS — the failure it prevents destroys the trader's principal, silently.
//
// When one of those ops cannot execute (expired, below min_out, stale reserves, a malformed proof) the guest
// does not skip it — the vin scan has already nullified the input, so skipping would destroy it. Instead it
// REFUNDS, minting a note that commits the input commitment VERBATIM under the refund output's x-only Taproot
// key: `btc_note_leaf(asset, C_in, refund_auth)` (cxfer-core `onboard_btc_refund` / `onboard_batch_refunds`).
//
// A Bitcoin-homed note's nullifier is `keccak(leaf ‖ "spent")`, and that leaf contains NO outpoint — it is a
// pure function of (asset, commitment, auth_key). The crate's own round-trip test asserts exactly that, because
// it is what lets the reflection and the settle guest agree on one nullifier per note.
//
// Put those two facts together: if the refund output pays the SAME x-only key the spent input note was homed
// at, the refund's leaf — and therefore its nullifier — is byte-identical to the note the scan just spent. The
// refund appends to the note tree and shows up as live, but its nullifier is already in the spent set, so it
// can never be spent. The input is gone and the refund is unspendable. The value is destroyed.
//
// This is not an exotic case. Refunding to the address the input came from is the most natural thing to build,
// and a third party can force the refund branch cheaply (move the pool's reserves so the proof goes stale, add
// an input, or just wait out the expiry). So the refund key must be FRESH — never an input's key, and never
// another intent's refund key in the same transaction (two refunds under one key collide with each other the
// same way, for the same reason).
//
// The guest cannot check this for you: it only ever sees the key the transaction pays to. Which is also why
// this is fixable here rather than in an immutable program.

const strip = (h) => String(h == null ? '' : h).replace(/^0x/, '').toLowerCase();
/// Accept either a P2TR scriptPubKey or a bare 32-byte x-only key, and NOTHING else. The `?? strip(v)`
/// fallback has to be length-checked: without it a P2WPKH script (or any other non-P2TR program) falls
/// through as if it were a key, and the "must be P2TR" guard below can never fire on the one input shape it
/// exists to reject.
const asXonly = (v) => {
  const viaScript = p2trXonlyOf(v);
  if (viaScript) return viaScript;
  const bare = strip(typeof v === 'string' ? v : '');
  return /^[0-9a-f]{64}$/.test(bare) ? bare : null;
};

/// The x-only key a P2TR scriptPubKey pays to, as bare lowercase hex — or null if `spk` is not a 34-byte
/// P2TR program (`0x51 0x20 ‖ 32 bytes`). Mirrors cxfer-core `bitcoin::p2tr_xonly`, which is how the guest
/// derives `refund_auth` from the confirmed output.
export function p2trXonlyOf(spk) {
  const b = typeof spk === 'string'
    ? Uint8Array.from((strip(spk).match(/../g) || []).map((x) => parseInt(x, 16)))
    : spk;
  if (!b || b.length !== 34 || b[0] !== 0x51 || b[1] !== 0x20) return null;
  return [...b.slice(2)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/// True when this refund destination would collide with one of the notes being spent, or with another refund
/// in the same transaction. `inputAuthKeys` / `otherRefundSpks` accept x-only hex or full P2TR scripts.
export function refundKeyCollides({ refundSpk, inputAuthKeys = [], otherRefundSpks = [] } = {}) {
  const key = asXonly(refundSpk);
  if (!key) return false;
  return [...inputAuthKeys, ...otherRefundSpks].some((v) => { const k = asXonly(v); return k && k === key; });
}

/// Throw unless the refund destination is fresh. Call this before signing anything: once the transaction
/// confirms, the refund branch is the guest's to take and there is no recovery.
export function assertFreshRefundKey({ refundSpk, inputAuthKeys = [], otherRefundSpks = [], label = 'refund' } = {}) {
  const key = asXonly(refundSpk);
  if (!key) throw new Error(`${label}: refund destination must be a P2TR output, or a bare 32-byte x-only key (the guest reads that key as the refund note's owner)`);
  const norm = asXonly;
  if (inputAuthKeys.some((v) => norm(v) === key)) {
    throw new Error(`${label}: the refund destination is one of the input notes' own keys. `
      + 'A refund commits the input commitment verbatim, and a Bitcoin-homed note’s nullifier is derived '
      + 'from (asset, commitment, key) with no outpoint — so this refund would be born already-spent and the '
      + 'input would be destroyed. Derive a fresh key for the refund output.');
  }
  if (otherRefundSpks.some((v) => norm(v) === key)) {
    throw new Error(`${label}: two refund destinations in this transaction share a key. `
      + 'Both refunds would hash to the same leaf and nullifier, so only one could ever be spent. '
      + 'Derive a fresh key per intent.');
  }
  return key;
}
