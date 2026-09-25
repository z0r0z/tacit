// Recoverable blinding for an OP_BRIDGE_MINT destination note (the Ethereum-side re-mint of a Bitcoin-side
// burn-deposit — see contracts/sp1/confidential/harnesses/exec-bridgemint.rs). The destination note is
// PRE-COMMITTED at burn time on Bitcoin (the guest pins dest_leaf into the bridge-burn set; the Ethereum mint
// must reproduce that exact (cx, cy, owner), opening to the burned value net of any relay fee), and Bitcoin
// envelopes carry no memo channel the way an Ethereum-side settle() does — so whatever blinding the burn envelope commits to is the
// ONLY chance to make this note recoverable. As cbtc-note-recovery.js does for cBTC locks and
// confidential-pool-ux.js's crossOut() does for fast-lane cross-outs, the blinding is derived from the
// identity key + the burned note's own nullifier (unique per spend, already computed by whatever builds the
// burn envelope) instead of a fresh random scalar.
//
// Deps: { hmac, sha256, curveOrder } — @noble hmac/sha256 + the secp order N (so the result is a valid scalar).
// Whoever builds a burn-deposit / bridge-mint destination commitment (dapp code or an external integrator's
// own client) should call this for the destination blinding rather than inventing a fresh one, exactly the
// way confidential-pool-ux.js's crossOut() does for the fast-lane path.

export function makeBridgeMintRecovery({ hmac, sha256, curveOrder }) {
  const N = BigInt(curveOrder);
  const DOMAIN = new TextEncoder().encode('tacit-bridgemint-blinding-v1');
  const toBytes = (v) => v instanceof Uint8Array
    ? v
    : Uint8Array.from((String(v).replace(/^0x/, '').match(/../g) || []).map((h) => parseInt(h, 16)));
  const toBig = (b) => { let x = 0n; for (const y of b) x = (x << 8n) | BigInt(y); return x; };

  // The recoverable Pedersen blinding (a scalar in (0, N)) for the destination note of a bridge-mint that
  // completes the burn identified by `nullifier` (the burned note's own nullifier — unique per spend, so this
  // blinding is unique per burn without needing any extra counter or state).
  function deriveBridgeMintBlinding({ privkey, nullifier }) {
    const priv = toBytes(privkey);
    if (!(priv instanceof Uint8Array) || priv.length !== 32) throw new Error('privkey must be 32 bytes');
    const nBytes = toBytes(nullifier);
    if (nBytes.length !== 32) throw new Error('nullifier must be 32 bytes');
    const msg = new Uint8Array(DOMAIN.length + nBytes.length);
    msg.set(DOMAIN); msg.set(nBytes, DOMAIN.length);
    const raw = hmac(sha256, priv, msg);
    const b = toBig(raw) % N;
    return b === 0n ? 1n : b;
  }

  return { deriveBridgeMintBlinding };
}
