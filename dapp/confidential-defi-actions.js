// Action layer for the confidential CDP + cBTC ops — builds the op (via the confidential-cdp.js assemblers) +
// its RECOVERY DESCRIPTORS, then relay-settles it (gasless). Mirrors the wrap reference in
// confidential-pool-ux.js: one descriptor per MINTED spendable note, sealed through the relay's recovery guard,
// trip-wired before submit. This is lost-funds-critical — a missing/wrong descriptor ships an unrecoverable
// note. Rules used below:
//   • collateral legs are SPENT (nullifiers), positions live in a separate tree → NEITHER is a note leaf, no
//     descriptor.
//   • a debt note / released collateral note is OWNED (the user holds the opening) → memo-sealed descriptor.
//   • the cBTC.zk note is BEARER (owner = 0, no pubkey to seal to) → SEED-DERIVED: the recovery scan re-derives
//     its blinding from priv + the lock anchor (the same derivation the Model-B lock-tx uses).
//
// Deps: { pool, cdp (makeConfidentialCdp), relay (makeConfidentialRelay, guard-wired), id, chainBindingHex, secp }.
//   id: { owner (32B leaf owner), pubHex (owner pubkey the memo seals to), secret }.

export function makeConfidentialDefiActions({ pool, cdp, farm, relay, id, chainBindingHex, secp }) {
  const ZERO = '0x' + '00'.repeat(32);
  const ephFromSecret = () => (BigInt(id.secret) % secp.CURVE.n) || 1n; // deterministic eph (memo carries the full opening)
  // An OWNED note the user can re-open via a memo sealed to their pubkey (channel a).
  const owned = ({ value, blinding, asset, cx, cy }) =>
    ({ value: value.toString(), blinding, secret: id.secret, asset, owner: id.owner, cx, cy, ownerPub: id.pubHex });

  // CDP open — lock a collateral basket → mint a cUSD debt note (net of the relay fee). The debt note is the
  // only minted spendable note (the basket is spent into the position). `positionOwner` is a FRESH per-position
  // value (the leaf owner the guest publishes for keeper liquidation) — distinct from the borrower's account
  // owner, so it's unlinkable; the debt note's memo still seals to id.pubHex so the borrower recovers it.
  // `nonce` is fixed to 0 (the guest enforces it on real positions; the fresh owner gives leaf uniqueness).
  // `debtNk` is a FRESH secret for the minted debt note (required whenever debtValue > 0): the note's leaf
  // owner is H(debtNk), matching cxfer-core's bearer-note-by-nk convention — reusing positionOwner here would
  // bind the debt note's leaf to the position's auth key, which is a DIFFERENT commitment than what the guest
  // actually publishes (debt_owner), so the assembler's own `leaves` entry would silently diverge from the
  // real on-chain leaf. The caller must retain debtNk to spend the note later (it is NOT derivable from
  // anything else recorded on-chain).
  const ZERO32 = '0x' + '00'.repeat(32);
  async function openCdp({ controller, debtValue, rateSnapshot, fee = 0n, collateral, spendRoot, debtBlinding, positionOwner, debtNk, waitOpts }) {
    // nonce is pinned to 0, so the fresh per-position owner is the sole source of leaf uniqueness: reusing the
    // account owner here would link every position and risk two same-parameter positions colliding to one leaf
    // (the second becomes un-closeable). Require an explicit fresh owner — never fall back to id.owner.
    if (!positionOwner) throw new Error('openCdp: positionOwner (fresh per-position owner) is required');
    if (BigInt(debtValue) > 0n && !debtNk) throw new Error('openCdp: debtNk (fresh secret for the minted debt note) is required when debtValue > 0');
    const pOwner = positionOwner;
    const debtOwner = BigInt(debtValue) > 0n ? pool.nkToOwner(debtNk) : null;
    const op = cdp.buildCdpMintOp({ chainBinding: chainBindingHex(), controller, owner: pOwner, debtOwner, debtValue, nonce: ZERO32, rateSnapshot, fee, collateral, spendRoot, debtBlinding });
    let leaves = [], outputs = [];
    if (BigInt(debtValue) > 0n) {
      const debtAsset = cdp.debtAssetId(controller);
      leaves = [pool.leaf(debtAsset, op.debt.cx, op.debt.cy, debtOwner)];
      // leaf owner = H(debtNk) (matches the guest's debt_owner); the memo still seals to the borrower's
      // pubkey (recovery), and carries debtNk as `secret` so the borrower can later spend the note.
      outputs = [{ ...owned({ value: BigInt(debtValue) - BigInt(fee), blinding: debtBlinding, asset: debtAsset, cx: op.debt.cx, cy: op.debt.cy }), owner: debtOwner, secret: debtNk }];
    }
    return relay.settle({ type: 'cdpmint', op, leaves, outputs, ephRand: ephFromSecret }, waitOpts);
  }

  // CDP close — burn the debt notes + release the basket (first leg net of fee). Each released leg is a minted
  // owned note; the burned debt notes are spent (no descriptor). nonce is 0 (matches open).
  // `releaseNks` is one FRESH secret per released leg (basket order, asset-sorted — the SAME order
  // buildCdpCloseOp emits `legs` in): each released leg's leaf owner is H(nk), which is what the guest
  // publishes. Reusing positionOwner here would bind the released notes to the position's BIP-340 auth key —
  // a key with no nk preimage — minting collateral back as permanently unspendable notes.
  async function closeCdp({ controller, debtValue, rateSnapshot, basket, positionIndex, positionPath, spendRoot, cdpPositionRoot, fee = 0n, releaseBlindings, releaseNks, debtNotes, positionOwner, positionOwnerPriv, waitOpts }) {
    // The close is owner-authorized (BIP-340) by the position's FRESH per-position key — the same key whose
    // x-only pubkey is `positionOwner` (open's `positionOwner`). Require it; never fall back to id.owner (the
    // account key would link positions, and only the position key can sign the close the guest now verifies).
    if (!positionOwner || !positionOwnerPriv) throw new Error('closeCdp: positionOwner + positionOwnerPriv (the fresh per-position key) are required to authorize the close');
    const legCount = (basket || []).length;
    if (!Array.isArray(releaseNks) || releaseNks.length !== legCount) {
      throw new Error(`closeCdp: releaseNks (one fresh secret per released leg) is required — got ${Array.isArray(releaseNks) ? releaseNks.length : 0} for ${legCount} leg(s)`);
    }
    const pOwner = positionOwner;
    // Sort to the SAME canonical (asset-ascending) order buildCdpCloseOp uses, so releaseNks[i] lines up with
    // op.legs[i] — the caller supplies them in basket order and the assembler re-sorts internally.
    const order = basket.map((leg, i) => i).sort((a, b) => (BigInt(basket[a].asset) < BigInt(basket[b].asset) ? -1 : (BigInt(basket[a].asset) > BigInt(basket[b].asset) ? 1 : 0)));
    const sortedNks = order.map((i) => releaseNks[i]);
    const sortedBlindings = order.map((i) => releaseBlindings[i]);
    const releaseOwners = sortedNks.map((nk) => pool.nkToOwner(nk));
    const op = cdp.buildCdpCloseOp({ chainBinding: chainBindingHex(), controller, owner: pOwner, ownerPriv: positionOwnerPriv, debtValue, nonce: ZERO32, rateSnapshot, basket, positionIndex, positionPath, spendRoot, cdpPositionRoot, fee, releaseBlindings: sortedBlindings, releaseOwners, debtNotes });
    const leaves = op.legs.map((leg, i) => pool.leaf(leg.asset, leg.cx, leg.cy, releaseOwners[i]));
    const outputs = op.legs.map((leg, i) => ({ ...owned({ value: BigInt(leg.value) - (i === 0 ? BigInt(fee) : 0n), blinding: sortedBlindings[i], asset: leg.asset, cx: leg.cx, cy: leg.cy }), owner: releaseOwners[i], secret: sortedNks[i] }));
    return relay.settle({ type: 'cdpclose', op, leaves, outputs, ephRand: ephFromSecret }, waitOpts);
  }

  // CDP liquidate — a KEEPER seizes an undercollateralized position: burn the keeper's cUSD notes (≥ the
  // debt), seize the basket to the keeper as public withdrawals. The position owner+nonce(0)+legs are public
  // (from the mint), so any keeper can build this. No minted note leaves (seizure rides withdrawals), so no
  // recovery descriptors. The controller's onCdpLiquidate reverts if the position is healthy.
  //
  // RELAYED by default (gasless): a liquidation carves a relay `fee` from the first seized leg to the box
  // (settler), so a keeper needs NO ETH — the box settles and is paid the fee, the keeper receives the rest
  // of the seized basket (still profiting the over-collateralization spread). With `fee == 0` it falls back
  // to SELF-SETTLE (box prove-only, the keeper submits ConfidentialPool.settle itself via ux.submitSettle).
  // Returns the relay settle result when relayed, or { publicValues, proof } when self-settling.
  async function liquidateCdp({ controller, owner, debtValue, rateSnapshot, basket, positionIndex, positionPath, spendRoot, cdpPositionRoot, liquidator, debtNotes, fee = 0n, waitOpts }) {
    const op = cdp.buildCdpLiquidateOp({ chainBinding: chainBindingHex(), controller, owner, debtValue, nonce: ZERO32, rateSnapshot, basket, positionIndex, positionPath, spendRoot, cdpPositionRoot, liquidator, debtNotes, fee });
    const spec = { type: 'cdpliquidate', op, leaves: [], outputs: [], ephRand: ephFromSecret };
    return BigInt(fee) > 0n ? relay.settle(spec, waitOpts) : relay.prove(spec, waitOpts);
  }

  // CDP top-up — add collateral. Appends a new position (separate tree) + spends the added legs ⇒ NO minted note.
  // A top-up REPLACES a live position, so (like close) it is BIP-340 owner-authorized: proving authority over
  // the ADDED collateral is not authority over someone else's position. `positionOwnerPriv` is the matching
  // private key for `positionOwner` — without it buildCdpTopupOp cannot sign and throws.
  async function topupCdp({ controller, debtValue, rateSnapshot, oldBasket, addedCollateral, positionIndex, positionPath, spendRoot, cdpPositionRoot, positionOwner, positionOwnerPriv, waitOpts }) {
    // Same model as open/close: the position's FRESH owner (carried forward) is the sole leaf-uniqueness
    // source and both nonces are pinned to 0, so the replacement stays keeper-reconstructable/liquidatable.
    if (!positionOwner || !positionOwnerPriv) throw new Error('topupCdp: positionOwner + positionOwnerPriv (the position\'s fresh key) are required to authorize the top-up');
    const op = cdp.buildCdpTopupOp({ chainBinding: chainBindingHex(), controller, owner: positionOwner, ownerPriv: positionOwnerPriv, debtValue, oldNonce: ZERO32, newNonce: ZERO32, rateSnapshot, oldBasket, addedCollateral, positionIndex, positionPath, spendRoot, cdpPositionRoot });
    return relay.settle({ type: 'cdptopup', op, leaves: [], outputs: [], ephRand: ephFromSecret }, waitOpts);
  }

  // cBTC mint — mint the bearer cBTC.zk note against a reflection-recorded self-custody lock. The note is
  // SEED-DERIVED (owner = 0): the recovery scan re-derives `blinding` from priv + the lock's funding anchor
  // (the SAME derivation the Model-B lock-tx must use), so the holder recovers it from the key + chain alone.
  async function mintCbtc({ outpoint, vBtc, blinding, waitOpts }) {
    const op = cdp.buildCbtcMintOp({ chainBinding: chainBindingHex(), outpoint, vBtc, blinding });
    const leaf = pool.leaf(pool.CBTC_ZK_ASSET_ID, op.cx, op.cy, ZERO);
    return relay.settle({ type: 'cbtcmint', op, leaves: [leaf], outputs: [{ seedDerived: true }], ephRand: ephFromSecret }, waitOpts);
  }

  // ── farms + TSR ── the receipt note is owner-blinded + recovered by the receipt scan ⇒ SEED-DERIVED (no
  // memo); reward / released LP-share notes are OWNED ⇒ memo-sealed. Leaf order matches the guest (main.rs):
  // bond [receipt]; harvest [advanced receipt, reward note]; unbond [released LP-share].
  const controller32 = (c) => '0x' + '00'.repeat(12) + String(c).replace(/^0x/, '').slice(-40);

  // OP_FARM_BOND — lock LP-share notes into a receipt committing (Σshares, rps_entry). Legs are spent.
  async function bondFarm({ controller, rpsEntry, nonce, lpAsset, legs, spendRoot, waitOpts }) {
    const op = farm.buildBondOp({ chainBinding: chainBindingHex(), spendRoot, controller, owner: id.owner, rpsEntry, nonce, lpAsset, legs });
    const shares = legs.reduce((s, l) => s + BigInt(l.value), 0n);
    const receipt = pool.farmReceiptLeaf(controller32(controller), shares, rpsEntry, id.owner, nonce);
    return relay.settle({ type: 'farmbond', op, leaves: [receipt], outputs: [{ seedDerived: true }], ephRand: ephFromSecret }, waitOpts);
  }

  // OP_FARM_HARVEST — claim yield, keep staked: [advanced receipt (seed-derived), reward note (owned, net of fee)].
  async function harvestFarm({ controller, shares, rpsEntry, oldNonce, newNonce, reward, oldIndex, oldPath, rewardAsset, rewardNote, fee = 0n, spendRoot, waitOpts }) {
    const op = farm.buildHarvestOp({ chainBinding: chainBindingHex(), spendRoot, controller, owner: id.owner, ownerPriv: id.priv, shares, rpsEntry, oldNonce, newNonce, reward, oldIndex, oldPath, rewardAsset, rewardNote, fee });
    const newEntry = pool.farmHarvestNewEntry(shares, rpsEntry, reward);
    const advanced = pool.farmReceiptLeaf(controller32(controller), shares, newEntry, id.owner, newNonce);
    const rewardLeaf = pool.leaf(rewardAsset, op.rewardCx, op.rewardCy, id.owner);
    const outputs = [{ seedDerived: true }, owned({ value: BigInt(reward) - BigInt(fee), blinding: rewardNote.blinding, asset: rewardAsset, cx: op.rewardCx, cy: op.rewardCy })];
    return relay.settle({ type: 'farmharvest', op, leaves: [advanced, rewardLeaf], outputs, ephRand: ephFromSecret }, waitOpts);
  }

  // OP_FARM_UNBOND — exit: re-mint the released LP-share note (owned, net of fee); the receipt is spent.
  async function unbondFarm({ controller, shares, rpsEntry, nonce, lpAsset, oldIndex, oldPath, releaseNote, fee = 0n, spendRoot, waitOpts }) {
    const op = farm.buildUnbondOp({ chainBinding: chainBindingHex(), spendRoot, controller, owner: id.owner, ownerPriv: id.priv, shares, rpsEntry, nonce, lpAsset, oldIndex, oldPath, releaseNote, fee });
    const releaseLeaf = pool.leaf(lpAsset, releaseNote.cx, releaseNote.cy, id.owner);
    const outputs = [owned({ value: BigInt(shares) - BigInt(fee), blinding: releaseNote.blinding, asset: lpAsset, cx: releaseNote.cx, cy: releaseNote.cy })];
    return relay.settle({ type: 'farmunbond', op, leaves: [releaseLeaf], outputs, ephRand: ephFromSecret }, waitOpts);
  }

  // TSR (Tacit Savings Rate) = the SAME ops with the CollateralEngine as the controller + cUSD as the asset.
  const save = (p) => bondFarm(p);
  const harvestSavings = (p) => harvestFarm(p);
  const withdrawSavings = (p) => unbondFarm(p);

  return { openCdp, closeCdp, liquidateCdp, topupCdp, mintCbtc, bondFarm, harvestFarm, unbondFarm, save, harvestSavings, withdrawSavings };
}
