// JS mirror of the cxfer-core generic-CDP + cBTC-mint derivations (ops/DESIGN-confidential-defi-v1.md
// §§3,4). Byte-identical to cxfer-core (lib.rs `cdp_*` / `commitment_hash`) AND to ConfidentialPool's
// on-chain checks (`keccak256(abi.encodePacked("tacit-cdp-debt-v1", controller))` etc.), so the dapp can
// build OP_CDP_MINT/CLOSE/LIQUIDATE/TOPUP + OP_CBTC_MINT witnesses, and a CollateralEngine is addressed by its
// derived cUSD asset id. Inject `keccak256` (Uint8Array → 32-byte Uint8Array), e.g. @noble/hashes keccak_256.
//
// Byte layouts (all big-endian, raw concat — no length prefixes), matching cxfer-core `kn`:
//   debt asset   = keccak( "tacit-cdp-debt-v1"      ‖ controller[20] )
//   basket leg   = keccak( asset[32]                ‖ value_be[32] )
//   basket root  = keccak Merkle root over the leg hashes, depth 32, zero-padded (keccak_merkle_root)
//   position leaf= keccak( "tacit-cdp-position-v1"  ‖ controller[20] ‖ debtAsset[32] ‖ basketRoot[32]
//                          ‖ debtValue_be[32] ‖ rateSnapshot[32] ‖ owner[32] ‖ nonce[32] )
//     rateSnapshot = the controller's RAY-scaled debt accumulator at mint (32B BE); 0 for fee-free controllers.
//   position ν   = keccak( "tacit-cdp-position-v1"  ‖ positionLeaf[32] ‖ "spent" )
//   cBTC commit  = keccak( Cx[32] ‖ Cy[32] )                          (== cxfer-core commitment_hash)

const TREE_DEPTH = 32;

export function makeConfidentialCdp({ keccak256, pool, signSchnorr }) {
  const enc = new TextEncoder();
  const CDP_POSITION_DOMAIN = enc.encode('tacit-cdp-position-v1');
  const CDP_DEBT_DOMAIN = enc.encode('tacit-cdp-debt-v1');
  // Voluntary-close authorization (mirrors cxfer-core CDP_CLOSE_DOMAIN). The position owner BIP-340-signs the
  // close so only they can reclaim the collateral — `owner` is a ONE-TIME x-only pubkey the wallet derives
  // fresh per position (HD from the seed); reusing a key across positions would make them linkable.
  const CDP_CLOSE_DOMAIN = enc.encode('tacit-cdp-close-auth-v1');
  const SPENT = enc.encode('spent');

  const hx = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const concat = (arrs) => {
    const n = arrs.reduce((s, a) => s + a.length, 0);
    const o = new Uint8Array(n);
    let p = 0;
    for (const a of arrs) { o.set(a, p); p += a.length; }
    return o;
  };
  const bN = (h, n) => {
    const s = String(h).replace(/^0x/, '').padStart(n * 2, '0');
    if (s.length !== n * 2) throw new Error(`expected ${n}-byte value, got ${s.length / 2}`);
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return o;
  };
  const b32 = (h) => bN(h, 32);
  const addr20 = (a) => bN(a, 20); // an Ethereum address (the controller), 20 bytes raw
  const be = (v, n) => {
    let x = BigInt(v);
    const o = new Uint8Array(n);
    for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; }
    return o;
  };
  const k = (...parts) => keccak256(concat(parts));

  // The controller-derived debt asset id — the controller is its SOLE minter (no registry/admin).
  const debtAssetId = (controller) => hx(k(CDP_DEBT_DOMAIN, addr20(controller)));

  // One basket leg (asset, public value) → its 32-byte hash (hex).
  const basketLeg = (asset, value) => hx(k(b32(asset), be(value, 32)));

  // The basket root over the leg hashes — the depth-32 zero-padded keccak Merkle root (mirrors
  // cxfer-core keccak_merkle_root, the from-scratch form the incremental tree also produces).
  const basketRoot = (legsHex) => {
    const zeros = [];
    { let z = new Uint8Array(32); for (let i = 0; i < TREE_DEPTH; i++) { zeros.push(z); z = keccak256(concat([z, z])); } }
    if (legsHex.length === 0) {
      let h = new Uint8Array(32);
      for (let i = 0; i < TREE_DEPTH; i++) h = keccak256(concat([h, h]));
      return hx(h);
    }
    let level = legsHex.map(b32);
    for (let i = 0; i < TREE_DEPTH; i++) {
      const next = [];
      for (let j = 0; j * 2 < level.length; j++) {
        const l = level[2 * j];
        const r = 2 * j + 1 < level.length ? level[2 * j + 1] : zeros[i];
        next.push(keccak256(concat([l, r])));
      }
      level = next;
    }
    return hx(level[0]);
  };

  // The domain-separated CDP position leaf — CLOSE/LIQUIDATE/TOPUP reproduce it to prove membership.
  // `rateSnapshot` (32-byte hex) is the controller's debt accumulator at mint, committed so the controller
  // can price accrued debt; pass the 0 word for a fee-free controller (a farm).
  const positionLeaf = (controller, debtAsset, basketRootHex, debtValue, rateSnapshot, owner, nonce) =>
    hx(k(CDP_POSITION_DOMAIN, addr20(controller), b32(debtAsset), b32(basketRootHex), be(debtValue, 32),
      b32(rateSnapshot), b32(owner), b32(nonce)));

  // The position nullifier — the contract dedups it (close XOR liquidate, once).
  const positionNullifier = (leafHex) => hx(k(CDP_POSITION_DOMAIN, b32(leafHex), SPENT));

  // The cBTC mint commitment binding (== cxfer-core commitment_hash) — the OP_CBTC_MINT anti-griefing bind.
  const cbtcMintCommitment = (cx, cy) => hx(k(b32(cx), b32(cy)));

  // Opening-sigma builders for the CDP/cBTC op serializers. They deliberately return no blinding: the
  // untrusted proving box receives only (R,z), while each context binds the complete public intent that
  // the settle guest checks. `pool` is makeConfidentialPool(...), injected by the caller.
  const sigma = (domain, chainBinding, asset, bind, note, amounts, label, extraNotes = []) => {
    if (!pool) throw new Error('opening sigma requires the confidential-pool helper');
    const notes = [[note.cx, note.cy, note.owner], ...extraNotes];
    const ctx = pool.intentContext(domain, chainBinding, asset, bind, notes, amounts.map(BigInt));
    const nonce = pool.deriveOpeningNonce(note.blinding, ctx, label);
    const sig = pool.openingSigma(BigInt(note.value), note.blinding, ctx, nonce);
    return { sigR: sig.R, sigZ: sig.z };
  };
  const controllerWord = (controller) => hx(concat([new Uint8Array(12), addr20(controller)]));
  const cdpMintCollateralSigma = ({ chainBinding, controller, nonce, owner, asset, note, debtValue, index, rateSnapshot }) =>
    sigma('tacit-cdp-mint-collateral-v1', chainBinding, asset, nonce, note,
      [note.value, debtValue, index], 'cdp-mint-collateral',
      [[controllerWord(controller), nonce, owner], [rateSnapshot, nonce, owner]]);
  // The debt note opens to the NET (debtValue − fee); the gross debtValue + the relay fee are bound in the
  // context (mirroring the guest's OP_CDP_MINT). The caller MUST build `note` committing to debtValue − fee
  // and pass the gross `debtValue` + `fee` (fee = 0 ⇒ the note opens to the full debtValue). The settler is
  // paid `fee` in the debt asset; the position still records the gross debtValue, so the controller's health
  // check is on the gross debt.
  const cdpMintDebtSigma = ({ chainBinding, controller, nonce, owner, note, debtValue, fee = 0n, rateSnapshot }) =>
    sigma('tacit-cdp-mint-debt-v1', chainBinding, debtAssetId(controller), nonce, note,
      [debtValue != null ? BigInt(debtValue) : BigInt(note.value), BigInt(fee)], 'cdp-mint-debt',
      [[controllerWord(controller), nonce, owner], [rateSnapshot, nonce, owner]]);
  // The released leg note opens to the NET (value − fee) for the FIRST (fee-carrying) leg; the gross value +
  // the relay fee are bound in the context (mirroring OP_CDP_CLOSE). Other legs pass fee = 0 (note opens to
  // the full value). The caller MUST commit the first released note to value − fee.
  const cdpCloseReleaseSigma = ({ chainBinding, positionLeaf: position, asset, note, value, fee = 0n }) =>
    sigma('tacit-cdp-close-release-v1', chainBinding, asset, position, note,
      [value != null ? BigInt(value) : BigInt(note.value), BigInt(fee)], 'cdp-close-release');
  const cdpCloseDebtSigma = ({ chainBinding, positionLeaf: position, debtAsset, debtValue, index, note }) =>
    sigma('tacit-cdp-close-debt-v1', chainBinding, debtAsset, position, note,
      [note.value, debtValue, index], 'cdp-close-debt');
  const cdpLiquidateDebtSigma = ({ chainBinding, positionLeaf: position, debtAsset, debtValue, index, note }) =>
    sigma('tacit-cdp-liquidate-debt-v1', chainBinding, debtAsset, position, note,
      [note.value, debtValue, index], 'cdp-liquidate-debt');
  const cdpTopupCollateralSigma = ({ chainBinding, oldPositionLeaf, controller, newNonce, owner, asset, note, debtValue, index }) =>
    sigma('tacit-cdp-topup-collateral-v1', chainBinding, asset, oldPositionLeaf, note,
      [note.value, debtValue, index], 'cdp-topup-collateral', [[controllerWord(controller), newNonce, owner]]);
  // The bearer note opens to the NET (vBtc − fee); the gross vBtc + the relay fee are both bound in the context
  // (mirror the guest OP_CBTC_MINT, which always binds [v_btc, fee] and verifies the opening to v_btc − fee —
  // so even a fee-less mint must bind [vBtc, 0], not [vBtc]). Caller commits the note to net = vBtc − fee.
  const cbtcMintSigma = ({ chainBinding, cbtcAssetId, outpoint, note, vBtc, fee = 0n }) => {
    const bearer = { ...note, owner: '0x' + '00'.repeat(32) };
    return sigma('tacit-cbtc-mint-intent-v1', chainBinding, cbtcAssetId, outpoint, bearer,
      [BigInt(vBtc != null ? vBtc : note.value), BigInt(fee)], 'cbtc-mint');
  };

  // OP_CDP_MINT op-assembler — open a CDP (lock a collateral basket → mint a debt note net of an optional relay
  // fee), in the guest's io::read order (main.rs OP_CDP_MINT) + the exec-cdpmint.rs witness field names. The
  // basket is canonicalized strictly asset-sorted (the guest rejects unsorted / duplicate-asset baskets). A
  // bond (debtValue = 0) locks the basket with no debt note (fee must be 0); a payout (no collateral) mints the
  // controller token. Requires the injected `pool` (commit + opening sigma). The caller supplies each collateral
  // note's live merkle witness (leafIndex + path) and blindings; `debtBlinding` is the new debt note's blinding.
  const buildCdpMintOp = ({ chainBinding, controller, owner, debtValue, nonce, rateSnapshot, fee = 0n, collateral = [], spendRoot, debtBlinding }) => {
    if (!pool) throw new Error('buildCdpMintOp requires the confidential-pool helper');
    const legsSorted = [...collateral].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : (BigInt(a.asset) > BigInt(b.asset) ? 1 : 0)));
    const legs = legsSorted.map((leg) => {
      const note = { cx: leg.cx, cy: leg.cy, value: leg.value, owner, blinding: leg.blinding };
      const sig = cdpMintCollateralSigma({ chainBinding, controller, nonce, owner, asset: leg.asset, note, debtValue, index: leg.leafIndex, rateSnapshot });
      return { asset: leg.asset, cx: leg.cx, cy: leg.cy, value: String(BigInt(leg.value)), index: Number(leg.leafIndex), path: leg.path, sigR: sig.sigR, sigZ: sig.sigZ };
    });
    const op = { chainBinding, spendRoot, controller, owner, debtValue: String(BigInt(debtValue)), nonce, rateSnapshot, legs, fee: String(BigInt(fee)) };
    if (BigInt(debtValue) > 0n) {
      // the debt note opens to the NET (debtValue − fee); the position records the GROSS (the health check)
      const net = BigInt(debtValue) - BigInt(fee);
      const { cx, cy } = pool.commitXY(net, debtBlinding);
      const note = { cx, cy, value: net, owner, blinding: debtBlinding };
      const sig = cdpMintDebtSigma({ chainBinding, controller, nonce, owner, note, debtValue, fee, rateSnapshot });
      op.debt = { cx, cy, sigR: sig.sigR, sigZ: sig.sigZ };
    }
    return op;
  };

  // OP_CDP_CLOSE op-assembler — close a CDP: burn the exact debt notes and re-mint the collateral basket to the
  // owner, carving an OPTIONAL relay fee from the FIRST released leg (it opens to value − fee; the basket
  // membership + the controller use the GROSS value). The released legs reproduce the position's canonical
  // (asset-sorted) basket so the reconstructed `basketRoot` → `positionLeaf` matches membership. `Σ debtNotes =
  // debtValue` (the gross debt repaid). Requires the injected `pool`. The caller supplies the position's
  // merkle witness (positionIndex/Path), the basket it locked, fresh `releaseBlindings`, and the debt notes
  // (cUSD) being repaid with their live merkle witnesses.
  const buildCdpCloseOp = ({ chainBinding, controller, owner, ownerPriv, debtValue, nonce, rateSnapshot, basket = [], positionIndex, positionPath, spendRoot, cdpPositionRoot, fee = 0n, releaseBlindings = [], debtNotes = [] }) => {
    if (!pool) throw new Error('buildCdpCloseOp requires the confidential-pool helper');
    if (!signSchnorr || !ownerPriv) throw new Error('buildCdpCloseOp requires ownerPriv + signSchnorr (owner-authorized close)');
    const debtAsset = debtAssetId(controller);
    const sortedBasket = [...basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : (BigInt(a.asset) > BigInt(b.asset) ? 1 : 0)));
    const basketRootHex = basketRoot(sortedBasket.map((leg) => basketLeg(leg.asset, leg.value)));
    const position = positionLeaf(controller, debtAsset, basketRootHex, debtValue, rateSnapshot, owner, nonce);
    const legs = sortedBasket.map((leg, i) => {
      const legFee = i === 0 ? BigInt(fee) : 0n; // only the first released leg carries the relay fee
      const net = BigInt(leg.value) - legFee;
      const { cx, cy } = pool.commitXY(net, releaseBlindings[i]);
      const note = { cx, cy, value: net, owner, blinding: releaseBlindings[i] };
      const sig = cdpCloseReleaseSigma({ chainBinding, positionLeaf: position, asset: leg.asset, note, value: leg.value, fee: legFee });
      return { asset: leg.asset, value: String(BigInt(leg.value)), cx, cy, sigR: sig.sigR, sigZ: sig.sigZ };
    });
    const debts = debtNotes.map((d) => {
      const dOwner = d.owner ?? owner;
      const note = { cx: d.cx, cy: d.cy, value: d.value, owner: dOwner, blinding: d.blinding };
      const sig = cdpCloseDebtSigma({ chainBinding, positionLeaf: position, debtAsset, debtValue, index: d.leafIndex, note });
      return { cx: d.cx, cy: d.cy, owner: dOwner, value: String(BigInt(d.value)), index: Number(d.leafIndex), path: d.path, sigR: sig.sigR, sigZ: sig.sigZ };
    });
    // Owner authorization: BIP-340 sig over keccak(CDP_CLOSE_DOMAIN ‖ chainBinding ‖ positionLeaf ‖ releasedBytes),
    // releasedBytes = per leg (asset ‖ value_be8 ‖ Cx ‖ Cy) in the SAME sorted order the guest reads them, then fee_be8.
    // Binds the exact released commitments so a relayer can't redirect the reclaimed collateral.
    const releasedBytes = concat([
      ...legs.map((l) => concat([b32(l.asset), be(l.value, 8), b32(l.cx), b32(l.cy)])),
      be(fee, 8),
    ]);
    const ownerSig = hx(signSchnorr(k(CDP_CLOSE_DOMAIN, b32(chainBinding), b32(position), releasedBytes), b32(ownerPriv)));
    return { chainBinding, spendRoot, cdpPositionRoot, controller, owner, debtValue: String(BigInt(debtValue)), nonce, rateSnapshot, positionIndex: Number(positionIndex), positionPath, legs, fee: String(BigInt(fee)), debts, ownerSig };
  };

  // OP_CDP_LIQUIDATE op-assembler — a KEEPER seizes an undercollateralized position. Reproduces the position
  // leaf from its PUBLIC preimage (controller, debtAsset=derive(controller), basketRoot from the public legs,
  // debtValue, rateSnapshot, owner, nonce=0 — all published at mint), proves membership, and burns the
  // keeper's cUSD debt notes summing ≥ debtValue (each opening-sigma-bound under the liquidate-debt context).
  // The basket is seized to `liquidator` as PUBLIC withdrawals (value bound by the basket root) — no minted
  // note leaves. The contract still calls controller.onCdpLiquidate, which reverts if the position is healthy.
  const buildCdpLiquidateOp = ({ chainBinding, controller, owner, debtValue, nonce, rateSnapshot, basket = [], positionIndex, positionPath, spendRoot, cdpPositionRoot, liquidator, debtNotes = [], fee = 0n }) => {
    if (!pool) throw new Error('buildCdpLiquidateOp requires the confidential-pool helper');
    const debtAsset = debtAssetId(controller);
    const sortedBasket = [...basket].sort((a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : (BigInt(a.asset) > BigInt(b.asset) ? 1 : 0)));
    const basketRootHex = basketRoot(sortedBasket.map((leg) => basketLeg(leg.asset, leg.value)));
    const position = positionLeaf(controller, debtAsset, basketRootHex, debtValue, rateSnapshot, owner, nonce);
    const debts = debtNotes.map((d) => {
      const dOwner = d.owner ?? owner;
      const note = { cx: d.cx, cy: d.cy, value: d.value, owner: dOwner, blinding: d.blinding };
      const sig = cdpLiquidateDebtSigma({ chainBinding, positionLeaf: position, debtAsset, debtValue, index: d.leafIndex, note });
      return { cx: d.cx, cy: d.cy, owner: dOwner, value: String(BigInt(d.value)), index: Number(d.leafIndex), path: d.path, sigR: sig.sigR, sigZ: sig.sigZ };
    });
    return {
      chainBinding, spendRoot, cdpPositionRoot, controller, owner, debtValue: String(BigInt(debtValue)), nonce,
      rateSnapshot, liquidator, positionIndex: Number(positionIndex), positionPath, fee: String(BigInt(fee)),
      legs: sortedBasket.map((leg) => ({ asset: leg.asset, value: String(BigInt(leg.value)) })), debts,
    };
  };

  // OP_CBTC_MINT op-assembler — mint a cBTC.zk bearer note against a reflection-recorded self-custody Bitcoin
  // lock (the contract gates cbtcLock[outpoint].vBtc == vBtc + escrow sufficiency). FEE-LESS by necessity: the
  // note is pinned to the lock's value (1:1 peg), owner-free (control is the blinding `r`). Requires `pool`
  // (commit + opening sigma + the pinned CBTC_ZK_ASSET_ID). The caller supplies the lock `outpoint`, `vBtc`,
  // and the note `blinding` (its own secret).
  const buildCbtcMintOp = ({ chainBinding, outpoint, vBtc, blinding, fee = 0n }) => {
    if (!pool) throw new Error('buildCbtcMintOp requires the confidential-pool helper');
    if (BigInt(fee) >= BigInt(vBtc)) throw new Error('buildCbtcMintOp: fee must be < vBtc');
    const net = BigInt(vBtc) - BigInt(fee); // the bearer note commits to the NET; the settler is paid `fee` in cBTC
    const { cx, cy } = pool.commitXY(net, blinding);
    const sig = cbtcMintSigma({ chainBinding, cbtcAssetId: pool.CBTC_ZK_ASSET_ID, outpoint, note: { cx, cy, value: net, blinding }, vBtc, fee });
    return { chainBinding, outpoint, vBtc: String(BigInt(vBtc)), fee: String(BigInt(fee)), cx, cy, sigR: sig.sigR, sigZ: sig.sigZ };
  };

  // OP_CDP_TOPUP op-assembler — add collateral to a CDP without changing its debt. FEE-LESS (adds value, no
  // spendable output; the relay is recouped on a later spend). Re-derives the OLD position leaf from the old
  // basket (asset + value only) for membership, spends the ADDED collateral notes, and appends a new position
  // (combined basket, `newNonce`). Requires `pool`. The caller supplies the old basket, the added collateral
  // notes with their live merkle witnesses, and the old position's merkle witness.
  const byAsset = (a, b) => (BigInt(a.asset) < BigInt(b.asset) ? -1 : (BigInt(a.asset) > BigInt(b.asset) ? 1 : 0));
  const buildCdpTopupOp = ({ chainBinding, controller, owner, debtValue, oldNonce, newNonce, rateSnapshot, oldBasket = [], addedCollateral = [], positionIndex, positionPath, spendRoot, cdpPositionRoot }) => {
    if (!pool) throw new Error('buildCdpTopupOp requires the confidential-pool helper');
    const debtAsset = debtAssetId(controller);
    const sortedOld = [...oldBasket].sort(byAsset);
    const oldBasketRootHex = basketRoot(sortedOld.map((leg) => basketLeg(leg.asset, leg.value)));
    const oldPosition = positionLeaf(controller, debtAsset, oldBasketRootHex, debtValue, rateSnapshot, owner, oldNonce);
    const addedLegs = [...addedCollateral].sort(byAsset).map((leg) => {
      const note = { cx: leg.cx, cy: leg.cy, value: leg.value, owner, blinding: leg.blinding };
      const sig = cdpTopupCollateralSigma({ chainBinding, oldPositionLeaf: oldPosition, controller, newNonce, owner, asset: leg.asset, note, debtValue, index: leg.leafIndex });
      return { asset: leg.asset, cx: leg.cx, cy: leg.cy, value: String(BigInt(leg.value)), index: Number(leg.leafIndex), path: leg.path, sigR: sig.sigR, sigZ: sig.sigZ };
    });
    return { chainBinding, spendRoot, cdpPositionRoot, controller, owner, debtValue: String(BigInt(debtValue)), oldNonce, newNonce, rateSnapshot, positionIndex: Number(positionIndex), positionPath, oldLegs: sortedOld.map((leg) => ({ asset: leg.asset, value: String(BigInt(leg.value)) })), addedLegs };
  };

  return {
    debtAssetId, basketLeg, basketRoot, positionLeaf, positionNullifier, cbtcMintCommitment,
    cdpMintCollateralSigma, cdpMintDebtSigma, cdpCloseReleaseSigma, cdpCloseDebtSigma,
    cdpLiquidateDebtSigma, cdpTopupCollateralSigma, cbtcMintSigma,
    buildCdpMintOp, buildCdpCloseOp, buildCdpLiquidateOp, buildCbtcMintOp, buildCdpTopupOp,
  };
}
