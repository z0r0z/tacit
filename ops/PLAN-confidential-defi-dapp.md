# Plan — wire the confidential DeFi dapp (CDP / cBTC Model-B / farms / TSR)

The contract/guest/proof layers are complete + real-proof tested; the op-assemblers + envelope builders are
built + test-backed (`tests/confidential-cdp-op.mjs`, `tests/cbtc-envelope.mjs`, `tests/confidential-stealth*`).
What remains is the **dapp layer**, which must be built against the **running dapp + recovery guard + signet**
because two of its steps are lost-funds-critical and not unit-testable in a node harness:
- **Recovery descriptors** — every leaf-creating op must pass `outputs` (one recovery descriptor per minted
  leaf) through the recovery guard (`confidential-relay.js` `submitOp` chokepoint). A wrong/missing descriptor
  ships a seed-only-unrecoverable note → the user loses it on a localStorage wipe.
- **cBTC note blinding derivation** — the Model-B lock-tx must derive the note `(secret, blinding)` from
  `priv + funding anchor` (like the slot secret, `tacit.js _deriveSlotSecret`), so the cBTC note is recoverable
  from the key + chain alone, AND its `commitXY(vBtc, blinding)` must equal what the lock envelope records and
  `buildCbtcMintOp` later opens. Get this wrong → the lock and mint don't link, or the note is unrecoverable.

Validate every round-trip on **signet** before mainnet, exactly as every existing Bitcoin op was.

## Phase 0 — foundation (imports + instantiation)
In `dapp/tacit.js` (where `makeConfidentialPool` is already wired), import + instantiate, sharing the one
pool/keccak instance:
- `makeConfidentialCdp({ keccak256, pool })` → `cdp` (has `buildCdpMintOp/CloseOp/TopupOp`, `buildCbtcMintOp`).
- `makeConfidentialFarm({ keccak256, pool })` → `farm` (bond/harvest/unbond assemblers).
- `makeConfidentialRelay({ base: WORKER, guard: recoveryGuard })` → `relay` (the submit/poll client).
- `makeCbtcRedemption({ orderbook, cbtcAsset: CBTC_ZK_ASSET_ID, btcAsset })` → `cbtcRedeem`.
- `buildCbtcLockEnvelope / buildCbtcRedeemEnvelope` from `cbtc-envelope.js`.
Wire `relay`'s `guard` to the SAME recovery guard the transfer/swap/lp paths use (so CDP/cBTC/farm notes are
recovery-checked identically). Confirm `recoveryGuard.sealMemosForOutputs` + `assertOutputsRecoverable` exist.

## Phase 1 — action layer (`dapp/confidential-defi-actions.js`, mirror `amm-farm-actions.js`)
Each action = build the op (assembler) → `relay.settle({ type, op, leaves, outputs, ephRand })`. The
**`outputs` recovery descriptors** are the load-bearing part — one per minted leaf, same order as the op's leaves:
- **CDP open** (`type:'cdpmint'`): `op = cdp.buildCdpMintOp(...)`; if `debtValue>0`, `leaves=[debt note leaf]`,
  `outputs=[{owner, blinding: debtBlinding, value: debtValue−fee, asset: debtAsset}]`. A bond (debtValue=0)
  mints no note → `outputs=[]`.
- **CDP close** (`type:'cdpclose'`): `leaves` = the released-leg leaves; `outputs` = one descriptor per released
  note (`{owner, blinding: releaseBlindings[i], value: legValue − (i==0?fee:0), asset}`). The burned debt notes
  are SPENT (nullifiers), not minted — no descriptor.
- **CDP top-up** (`type:'cdptopup'`): appends a position (no spendable note) + spends added collateral →
  `outputs=[]` (verify: the guest mints no note leaf here).
- **cBTC mint** (`type:'cbtcmint'`): `op = cdp.buildCbtcMintOp({ outpoint, vBtc, blinding })`;
  `leaves=[cBTC note leaf]`, `outputs=[{owner: ZERO (bearer), blinding, value: vBtc, asset: CBTC_ZK_ASSET_ID}]`.
- **Farm bond/harvest/unbond** (`farmbond/farmharvest/farmunbond`): use `confidential-farm.js` assemblers;
  `outputs` = the receipt + reward (harvest) / re-minted LP-share (unbond) descriptors.
- **TSR save/harvest/withdraw**: the SAME farm ops, controller = the CollateralEngine, asset = cUSD.
- **CDP liquidate**: NOT relayed (intentional — the liquidator self-broadcasts for profit).

## Phase 2 — cBTC Model-B lock-tx (`buildAndBroadcastCbtcLock`, mirror `buildAndBroadcastSlotMint`)
1. Pick sats UTXOs (fund `vBtc` + reveal fee); `fundingAnchor = picked[0]`.
2. `blinding = deriveCbtcNoteBlinding(priv, fundingAnchorOutpoint)` (HMAC, mirror `_deriveSlotSecret`) — so the
   note is recoverable from key+chain; `{cx,cy} = commitXY(vBtc, blinding)` (browser Pedersen == `pool.commitXY`).
3. `env = buildCbtcLockEnvelope({ asset: CBTC_ZK_ASSET_ID, lockVout: 1, cx, cy })`; commit-reveal as the
   slot-mint: `vout0 = OP_RETURN(sha256(payload))`, `vout1 = { vBtc, p2wpkhScript(wallet.pub) }` (self-custody).
4. Post-confirm + reflection records `cbtcLock[outpoint]` → submit `cbtcmint` (Phase 1) with the SAME blinding.
5. Add the lock to the recoverable-slot scan so `scanHoldings` finds it.
Redeem reuses `cbtc-redemption.js` (atomic adaptor swap with an exiting locker) — already complete, just import.

## Phase 3 — UI (index.html tabs + handlers)
- **Borrow** tab: open (pick cBTC/collateral + cUSD amount, show ratio/health from the engine view), close,
  top-up; position list (recovered via a CDP position scan — NEW, mirror the AMM position recovery).
- **Earn** tab: farm bond/harvest/unbond + the TSR save/withdraw (gated on a non-zero savings rate).
- **cBTC**: Model-B lock (mint arbitrary-amount tacBTC) + redeem + the backer's `postEscrow`/`claimEscrow`.
- Gate everything behind the existing launch/ceremony flags. All actions go through the relay (gasless).

## Phase 4 — signet validation (the gate before mainnet)
- cBTC: lock → reflection records → `cbtcmint` settle → spend → redeem (whole round-trip).
- CDP: open (cBTC → cUSD) → top-up → close, via the relay; confirm recovery after a localStorage wipe.
- Farm + TSR: bond → harvest → unbond; saver bond → harvest → withdraw.
- Recovery drill: wipe localStorage, `scanHoldings` must recover every CDP/cBTC/farm note from the key alone.

## Dependencies / order
Phase 0 → 1 → (2 ‖ 3) → 4. The box re-prove + pool/engine redeploy at the committed vkeys must land first (the
EVM lane verifies against the new PROGRAM_VKEY). The cUSD fee / TSR stay governance-dormant until flipped.
