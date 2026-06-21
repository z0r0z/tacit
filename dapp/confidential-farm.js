// JS builder for the fair-farm SETTLE ops (SPEC-CONTROLLER-VAULT-AMENDMENT §4): the dapp assembles the
// OP_FARM_BOND / OP_FARM_HARVEST / OP_FARM_UNBOND witnesses the EVM settle guest reads. Byte-identical to the
// guest's farm_receipt_leaf / farm_receipt_nullifier / farm_harvest_new_entry (cxfer-core) and to the
// opening-sigma contexts main.rs binds: `tacit-farm-bond-leg-v1`, `tacit-farm-harvest-reward-v1`,
// `tacit-farm-unbond-release-v1`. The receipt note rides pv.leaves; the op emits a CdpMint(positionLeaf == 1)
// (bond/harvest) or a CdpClose (unbond) so FarmController applies the rps policy. Mirrors confidential-cdp.js:
// the sigma builders deliberately return no blinding — the untrusted proving box gets only (R, z), while each
// context binds the complete public intent the settle guest checks. Inject `keccak256` + `pool`
// (makeConfidentialPool, the single source of truth for the leaf/sigma primitives).

export function makeConfidentialFarm({ keccak256, pool }) {
  const enc = new TextEncoder();
  const CDP_DEBT_DOMAIN = enc.encode('tacit-cdp-debt-v1');

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
  const addr20 = (a) => bN(a, 20); // the controller (FarmController) address, 20 bytes raw
  const k = (...parts) => keccak256(concat(parts));

  // The controller-derived debt asset id (== cxfer-core cdp_debt_asset_id) — the reward note's asset on harvest,
  // and the CdpMint.debtAsset the FarmController checks. The controller is its sole minter.
  const debtAssetId = (controller) => hx(k(CDP_DEBT_DOMAIN, addr20(controller)));
  // The 32-byte left-padded controller word the guest binds in the bond-leg sigma (controller32 in main.rs).
  const controllerWord = (controller) => hx(concat([new Uint8Array(12), addr20(controller)]));

  // The opening-sigma primitive (identical to confidential-cdp.js): pool.intentContext binds (domain,
  // chainBinding, assetA, assetB, notes, amounts); the box proves the opening without learning `r`.
  const sigma = (domain, chainBinding, asset, bind, note, amounts, label, extraNotes = []) => {
    if (!pool) throw new Error('opening sigma requires the confidential-pool helper');
    const notes = [[note.cx, note.cy, note.owner], ...extraNotes];
    const ctx = pool.intentContext(domain, chainBinding, asset, bind, notes, amounts.map(BigInt));
    const nonce = pool.deriveOpeningNonce(note.blinding, ctx, label);
    const sig = pool.openingSigma(BigInt(note.value), note.blinding, ctx, nonce);
    return { sigR: sig.R, sigZ: sig.z };
  };

  // OP_FARM_BOND leg sigma — main.rs `tacit-farm-bond-leg-v1`: assetA = lp_asset, assetB = nonce,
  // notes = [(cx, cy, owner), (controller32, nonce, owner)], amounts = [value, index]. `note.value` is the
  // leg's bonded LP-share value; `index` is the leg note's tree index (the membership leaf the guest re-proves).
  const farmBondLegSigma = ({ chainBinding, controller, nonce, owner, lpAsset, note, index }) =>
    sigma('tacit-farm-bond-leg-v1', chainBinding, lpAsset, nonce, note, [note.value, index],
      'farm-bond-leg', [[controllerWord(controller), nonce, owner]]);

  // OP_FARM_HARVEST reward sigma — main.rs `tacit-farm-harvest-reward-v1`: assetA = reward_asset (the witnessed
  // reward asset — an escrow-backed asset in ESCROW mode, or debtAssetId(controller) in MINT mode), assetB =
  // new_nonce, notes = [(r_cx, r_cy, owner)], amounts = [reward]. `note.value` is the reward.
  const farmHarvestRewardSigma = ({ chainBinding, rewardAsset, newNonce, note }) =>
    sigma('tacit-farm-harvest-reward-v1', chainBinding, rewardAsset, newNonce, note,
      [note.value], 'farm-harvest-reward');

  // OP_FARM_UNBOND release sigma — main.rs `tacit-farm-unbond-release-v1`: assetA = lp_asset,
  // assetB = nonce, notes = [(cx, cy, owner)], amounts = [shares]. `note.value` is the released share count.
  const farmUnbondReleaseSigma = ({ chainBinding, lpAsset, nonce, note }) =>
    sigma('tacit-farm-unbond-release-v1', chainBinding, lpAsset, nonce, note, [note.value], 'farm-unbond-release');

  // ── Full op-witness assembly (shared by the dapp's relay submit + the execute fixtures) ──
  // Each takes the spend notes (cx, cy, value, index, path, blinding from balance().notes) + the farm params,
  // and returns the op JSON the box serializes into the settle guest's io::read order (main.rs OP_FARM_*).

  // OP_FARM_BOND: lock LP-share notes (each `legs[i]` = {cx, cy, value, index, path, blinding}) into a receipt
  // committing (shares = Σ value, rps_entry). The controller binds rps_entry == the live rps at settle.
  const buildBondOp = ({ chainBinding, spendRoot, controller, owner, rpsEntry, nonce, lpAsset, legs }) => ({
    chainBinding, spendRoot, controller, owner, rpsEntry: String(rpsEntry), nonce, lpAsset,
    legs: legs.map((leg) => {
      const note = { cx: leg.cx, cy: leg.cy, owner, value: leg.value, blinding: leg.blinding };
      const sig = farmBondLegSigma({ chainBinding, controller, nonce, owner, lpAsset, note, index: leg.index });
      return { cx: leg.cx, cy: leg.cy, value: leg.value, index: leg.index, path: leg.path, sigR: sig.sigR, sigZ: sig.sigZ };
    }),
  });

  // OP_FARM_HARVEST: prove the old receipt, mint the reward note (`rewardNote` = {cx, cy, blinding}) under
  // `rewardAsset`, and advance the receipt to new_nonce. `reward` is the claimed amount.
  const buildHarvestOp = ({ chainBinding, spendRoot, controller, owner, shares, rpsEntry, oldNonce, newNonce, reward, oldIndex, oldPath, rewardAsset, rewardNote }) => {
    const note = { cx: rewardNote.cx, cy: rewardNote.cy, owner, value: reward, blinding: rewardNote.blinding };
    const sig = farmHarvestRewardSigma({ chainBinding, rewardAsset, newNonce, note });
    return {
      chainBinding, spendRoot, controller, owner, shares, rpsEntry: String(rpsEntry),
      oldNonce, newNonce, reward, oldIndex, oldPath, rewardAsset,
      rewardCx: rewardNote.cx, rewardCy: rewardNote.cy, sigR: sig.sigR, sigZ: sig.sigZ,
    };
  };

  // OP_FARM_UNBOND: prove the receipt, re-mint the released LP-share note (`releaseNote` = {cx, cy, blinding})
  // opening to `shares`. The controller drops total_shares + enforces lockUntil.
  const buildUnbondOp = ({ chainBinding, spendRoot, controller, owner, shares, rpsEntry, nonce, lpAsset, oldIndex, oldPath, releaseNote }) => {
    const note = { cx: releaseNote.cx, cy: releaseNote.cy, owner, value: shares, blinding: releaseNote.blinding };
    const sig = farmUnbondReleaseSigma({ chainBinding, lpAsset, nonce, note });
    return {
      chainBinding, spendRoot, controller, owner, shares, rpsEntry: String(rpsEntry), nonce, lpAsset,
      oldIndex, oldPath, releaseCx: releaseNote.cx, releaseCy: releaseNote.cy, sigR: sig.sigR, sigZ: sig.sigZ,
    };
  };

  return {
    debtAssetId,
    // farm leaf/checkpoint primitives (single source of truth in confidential-pool.js)
    farmReceiptLeaf: pool.farmReceiptLeaf,
    farmReceiptNullifier: pool.farmReceiptNullifier,
    farmHarvestNewEntry: pool.farmHarvestNewEntry,
    // opening-sigma builders, one per farm settle op
    farmBondLegSigma, farmHarvestRewardSigma, farmUnbondReleaseSigma,
    // full op-witness assembly (relay submit + execute fixtures)
    buildBondOp, buildHarvestOp, buildUnbondOp,
  };
}
