// Recovering a bridge that did not complete: what its holder signs, and how a claim is checked against chain data.
//
// A claim names the burn, the amount it carried, and the opening of the note it spent (its blinding), signed by the
// wallet key that made the bridge. It is checked in three steps, each against public data only:
//   1. the burn: a confirmed 0x2B burn of TAC that the attested reflection state has passed without recording it for a
//      mint (neither its destination in the recorded burns nor a pending record for its note);
//   2. the amount: the opening (amount, blinding) reproduces the commitment of the note the burn spent, as the
//      confidential transfer that created that note published it (the burned note is the burn's first input for a
//      burn-deposit, and the input after the envelope commit for a burn of a tracked note);
//   3. the holder: the signing key's P2WPKH address paid into the burn or into the move that made the burned note.
// The same check runs where a claim is taken in (the API) and again where it is paid (the recovery service), and the
// payment goes back to that same key.
//
// Deps: { secp, sha256, ripemd160, pool, classifyConfidentialTx, signSchnorr?, verifySchnorr, tacAssetId, maxUnits?, fromHeight? }.

export const RECOVER_DOMAIN = 'tacit-bridge-recover-v1';
export const RECOVER_MAX_UNITS = 10n ** 18n;    // what one note holds: a bridge has no cap below it
export const RECOVER_FROM_HEIGHT = 968700; // the first block the in-app bridge could have made a burn

const strip = (h) => String(h || '').replace(/^0x/, '');
const lc = (h) => String(h || '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
const toBytes = (h) => Uint8Array.from((strip(h).match(/../g) || []).map((x) => parseInt(x, 16)));
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// What a holder signs: domain ‖ burn txid (display order) ‖ amount (u64 big-endian) ‖ compressed public key.
export function recoverClaimDigest(sha256, { burnTxid, amount, pubkey }) {
  const dom = new TextEncoder().encode(RECOVER_DOMAIN);
  const amt = new Uint8Array(8);
  let v = BigInt(amount);
  for (let i = 7; i >= 0; i--) { amt[i] = Number(v & 0xffn); v >>= 8n; }
  const parts = [dom, toBytes(burnTxid), amt, toBytes(pubkey)];
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return sha256(buf);
}

// The claim a holder submits, signed with their wallet key. `blinding` opens the burned note.
export function buildRecoverClaim({ secp, sha256, signSchnorr }, { burnTxid, amount, blinding, walletPriv }) {
  const pubkey = toHex(secp.getPublicKey(walletPriv, true));
  const sig = toHex(signSchnorr(recoverClaimDigest(sha256, { burnTxid, amount, pubkey }), walletPriv));
  return { burnTxid: lc(strip(burnTxid)), amount: BigInt(amount).toString(), blinding: BigInt(blinding).toString(), pubkey, sig };
}

export function makeBridgeRecover({ secp, sha256, ripemd160, pool, classifyConfidentialTx, signSchnorr = null, verifySchnorr, tacAssetId, maxUnits = RECOVER_MAX_UNITS, fromHeight = RECOVER_FROM_HEIGHT }) {
  for (const [k, v] of Object.entries({ secp, sha256, ripemd160, pool, classifyConfidentialTx, verifySchnorr, tacAssetId })) {
    if (!v) throw new Error(`bridge-recover: ${k} required`);
  }
  const TAC = lc(strip(tacAssetId));

  const claimDigest = (c) => recoverClaimDigest(sha256, c);
  function buildClaim(c) {
    if (!signSchnorr) throw new Error('bridge-recover: signSchnorr required to build a claim');
    return buildRecoverClaim({ secp, sha256, signSchnorr }, c);
  }

  const ownerScript = (pubHex) => '0014' + toHex(ripemd160(sha256(toBytes(pubHex))));

  // claim: { burnTxid, amount, blinding, pubkey, sig }. chain: { getTx(txid) → esplora tx JSON, getTxHex(txid) → hex }.
  // state: the attested reflection state as { height, dests: Set(destination leaves), pending: Set(outpoint keys),
  // leaves: Set(every note leaf in its tree), spent: Set(every nullifier it has spent) }, all lowercase 0x hex.
  // Returns { ok: true, burnTxid, amount, pubkey, address, burnHeight } or { ok: false, reason }.
  async function verifyClaim(claim, { getTx, getTxHex, state }) {
    // transient: a reason that can clear on its own (not confirmed yet, not reached yet, state unavailable), so it is retried, not held.
    const no = (reason, transient = false) => (transient ? { ok: false, reason, transient: true } : { ok: false, reason });
    const burnTxid = lc(strip(claim && claim.burnTxid));
    if (!/^[0-9a-f]{64}$/.test(burnTxid)) return no('burn transaction id must be 64 hex characters');
    let amount, blinding;
    try { amount = BigInt(claim.amount); blinding = BigInt(claim.blinding); } catch { return no('amount and blinding must be integers'); }
    if (amount <= 0n || amount > BigInt(maxUnits)) return no('amount out of range');
    const pubkey = lc(strip(claim.pubkey));
    if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) return no('pubkey must be a compressed public key');
    const sig = lc(strip(claim.sig));
    if (!/^[0-9a-f]{128}$/.test(sig)) return no('signature must be 64 bytes');
    if (!verifySchnorr(toBytes(sig), claimDigest({ burnTxid, amount, pubkey }), toBytes(pubkey).slice(1))) return no('signature does not match');

    const burn = await getTx(burnTxid);
    if (!burn || !burn.status || !burn.status.confirmed) return no('burn not confirmed', true);
    if (burn.status.block_height < fromHeight) return no('this burn predates the in-app bridge');
    const env = classifyConfidentialTx('0x' + strip(await getTxHex(burnTxid)));
    if (!env || env.type !== 'burn') return no('not a bridge burn');
    if (lc(strip(env.assetId)) !== TAC) return no('not a TAC bridge');
    if (!state || !Number.isInteger(state.height) || burn.status.block_height > state.height) return no('not yet passed by the reflection', true);
    if (state.dests.has(lc(env.dest))) return no('this bridge completed: mint it instead');
    if (!(state.leaves instanceof Set) || !(state.spent instanceof Set)) return no('the reflection state is not available', true);
    if (!burn.vin || !burn.vin.length) return no('burn has no inputs');
    // The burned note: the first of the burn's first two inputs that a confidential transfer made.
    let note = null, made = null;
    for (const vin of burn.vin.slice(0, 2)) {
      const m = classifyConfidentialTx('0x' + strip(await getTxHex(vin.txid)));
      if (m && m.type === 'cxfer' && (m.vouts || []).includes(vin.vout)) { note = vin; made = m; break; }
    }
    if (!note) return no('the burned note was not made by a confidential transfer');
    if (lc(strip(made.assetId)) !== TAC) return no('the burned note is not TAC');
    // A burn the reflection holds pending is keyed by the burn's first input, which is the note or the envelope's commit.
    const keyOf = (v) => lc(pool.outpointKey('0x' + rev(v.txid), v.vout));
    if (state.pending.has(keyOf(note)) || state.pending.has(keyOf(burn.vin[0]))) return no('this bridge is still pending');
    // A note already moved to Ethereum another way (its outpoint retired there) is not refunded on Bitcoin as well.
    if (state.consumed instanceof Set && (state.consumed.has(keyOf(note)) || state.consumed.has(keyOf(burn.vin[0])))) return no('this note was already moved to Ethereum');
    const at = made.vouts.indexOf(note.vout);
    if (!made.commitments[at]) return no('the burned note has no published commitment');
    let onChain, opened;
    try {
      onChain = secp.ProjectivePoint.fromHex(strip(made.commitments[at])).toAffine();
      opened = pool.commitXY(amount, '0x' + blinding.toString(16).padStart(64, '0'));
    } catch { return no('commitment could not be read'); }
    if (BigInt(opened.cx) !== onChain.x || BigInt(opened.cy) !== onChain.y) return no('amount and blinding do not open the burned note');

    // A real note, one the attested state holds and this burn left spent: its leaf is built from the commitment on chain and
    // the key its output is locked to (a P2WPKH note has none; a P2TR note carries its output key).
    const home = lc((note.prevout && note.prevout.scriptpubkey) || '');
    const auth = /^0014[0-9a-f]{40}$/.test(home) ? '0x' + '00'.repeat(32) : /^5120[0-9a-f]{64}$/.test(home) ? '0x' + home.slice(4) : null;
    if (!auth) return no('the burned note is at an address this check cannot read');
    const leaf = lc(pool.btcNoteLeaf('0x' + TAC, '0x' + onChain.x.toString(16).padStart(64, '0'), '0x' + onChain.y.toString(16).padStart(64, '0'), auth));
    if (!state.leaves.has(leaf)) return no('the burned note is not one the reflection tracks');
    if (!state.spent.has(lc(pool.nullifier(leaf)))) return no('the burned note was not spent by this burn');

    // The holder is whoever paid into this burn itself: a transaction that only made the note earlier says nothing about who burned it.
    const spk = ownerScript(pubkey);
    const paid = (burn.vin || []).find((v) => v.prevout && lc(v.prevout.scriptpubkey) === spk);
    if (!paid) return no('this key did not make this bridge');
    return { ok: true, burnTxid, amount, pubkey, address: paid.prevout.scriptpubkey_address || null, burnHeight: burn.status.block_height };
  }

  // The attested state in the shape verifyClaim reads, from /reflection/dump's snapshot.
  function stateFromSnapshot(snap) {
    if (!snap || !Array.isArray(snap.burnNodes)) return null;
    return {
      height: Number(snap.height),
      dests: new Set(snap.burnNodes.map((n) => lc((n && n[2]) || ''))),
      pending: new Set((snap.pendingDepositRecords || []).map((r) => lc(r && r.key))),
      leaves: new Set((snap.noteLeaves || []).map((x) => lc(x))),
      spent: new Set((snap.spentLinks || []).map((l) => lc(l && l[0]))),
      consumed: new Set((snap.consumedOutpointsLinks || []).map((l) => lc(l && l[0]))),
    };
  }

  return { claimDigest, buildClaim, verifyClaim, stateFromSnapshot, ownerScript };
}
