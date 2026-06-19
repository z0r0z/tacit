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
//                          ‖ debtValue_be[32] ‖ owner[32] ‖ nonce[32] )
//   position ν   = keccak( "tacit-cdp-position-v1"  ‖ positionLeaf[32] ‖ "spent" )
//   cBTC commit  = keccak( Cx[32] ‖ Cy[32] )                          (== cxfer-core commitment_hash)

const TREE_DEPTH = 32;

export function makeConfidentialCdp({ keccak256, pool }) {
  const enc = new TextEncoder();
  const CDP_POSITION_DOMAIN = enc.encode('tacit-cdp-position-v1');
  const CDP_DEBT_DOMAIN = enc.encode('tacit-cdp-debt-v1');
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

  // The domain-separated CDP position leaf — CLOSE/LIQUIDATE reproduce it to prove membership.
  const positionLeaf = (controller, debtAsset, basketRootHex, debtValue, owner, nonce) =>
    hx(k(CDP_POSITION_DOMAIN, addr20(controller), b32(debtAsset), b32(basketRootHex), be(debtValue, 32), b32(owner), b32(nonce)));

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
  const cdpMintCollateralSigma = ({ chainBinding, controller, nonce, owner, asset, note, debtValue, index }) =>
    sigma('tacit-cdp-mint-collateral-v1', chainBinding, asset, nonce, note,
      [note.value, debtValue, index], 'cdp-mint-collateral', [[controllerWord(controller), nonce, owner]]);
  const cdpMintDebtSigma = ({ chainBinding, controller, nonce, owner, note }) =>
    sigma('tacit-cdp-mint-debt-v1', chainBinding, debtAssetId(controller), nonce, note,
      [note.value], 'cdp-mint-debt', [[controllerWord(controller), nonce, owner]]);
  const cdpCloseReleaseSigma = ({ chainBinding, positionLeaf: position, asset, note }) =>
    sigma('tacit-cdp-close-release-v1', chainBinding, asset, position, note, [note.value], 'cdp-close-release');
  const cdpCloseDebtSigma = ({ chainBinding, positionLeaf: position, debtAsset, debtValue, index, note }) =>
    sigma('tacit-cdp-close-debt-v1', chainBinding, debtAsset, position, note,
      [note.value, debtValue, index], 'cdp-close-debt');
  const cdpTopupCollateralSigma = ({ chainBinding, oldPositionLeaf, controller, newNonce, owner, asset, note, debtValue, index }) =>
    sigma('tacit-cdp-topup-collateral-v1', chainBinding, asset, oldPositionLeaf, note,
      [note.value, debtValue, index], 'cdp-topup-collateral', [[controllerWord(controller), newNonce, owner]]);
  const cbtcMintSigma = ({ chainBinding, cbtcAssetId, outpoint, note }) => {
    const bearer = { ...note, owner: '0x' + '00'.repeat(32) };
    return sigma('tacit-cbtc-mint-intent-v1', chainBinding, cbtcAssetId, outpoint, bearer,
      [note.value], 'cbtc-mint');
  };

  return {
    debtAssetId, basketLeg, basketRoot, positionLeaf, positionNullifier, cbtcMintCommitment,
    cdpMintCollateralSigma, cdpMintDebtSigma, cdpCloseReleaseSigma, cdpCloseDebtSigma,
    cdpTopupCollateralSigma, cbtcMintSigma,
  };
}
